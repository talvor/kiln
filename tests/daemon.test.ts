import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import denoJson from "../deno.json" with { type: "json" };
import { makeHome, runKiln, status, withHome } from "./helpers.ts";

withHome("daemon starts, reports status, and stops", async (home) => {
  assertEquals((await status(home)).code, 3, "stopped daemon reports exit code 3");

  const started = await home.kiln("daemon", "start");
  assertEquals(started.code, 0, started.stderr);
  assertStringIncludes(started.stdout, "started");

  const s = await status(home);
  assertEquals(s.code, 0);
  assert(s.info.pid > 0);
  assertEquals(s.info.version, denoJson.version);

  const again = await home.kiln("daemon", "start");
  assertStringIncludes(again.stdout, "already running");
  assertEquals((await status(home)).info.pid, s.info.pid, "no second daemon");

  const stopped = await home.kiln("daemon", "stop");
  assertEquals(stopped.code, 0);
  assertEquals((await status(home)).code, 3);
  assertEquals((await home.kiln("daemon", "stop")).code, 0, "stopping a stopped daemon is fine");
});

withHome("restart replaces the daemon process", async (home) => {
  await home.kiln("daemon", "start");
  const before = (await status(home)).info.pid;
  const r = await home.kiln("daemon", "restart");
  assertEquals(r.code, 0, r.stderr);
  const after = (await status(home)).info.pid;
  assertNotEquals(after, before);
});

Deno.test("stop finishes when a replacement daemon owns the socket", async () => {
  const home = await makeHome();
  await Deno.mkdir(home.dirs.runtime, { recursive: true });
  const listener = Deno.listen({ transport: "unix", path: join(home.dirs.runtime, "kiln.sock") });
  const seen: string[] = [];
  const serving = (async () => {
    while (true) {
      let conn: Deno.Conn;
      try {
        conn = await listener.accept();
      } catch {
        return;
      }
      void (async () => {
        try {
          const bytes = new Uint8Array(1024);
          const decoder = new TextDecoder();
          let input = "";
          while (!input.includes("\n")) {
            const size = await conn.read(bytes);
            if (size === null) return;
            input += decoder.decode(bytes.subarray(0, size), { stream: true });
          }
          const request = JSON.parse(input.slice(0, input.indexOf("\n")));
          seen.push(request.method);
          const identity = request.method === "stop"
            ? { pid: 101, startedAt: "old" }
            : { pid: 102, startedAt: "new" };
          await conn.write(new TextEncoder().encode(
            JSON.stringify({ id: request.id, ok: true, result: identity }) + "\n",
          ));
        } catch {
          // The fake daemon may lose a connection while the CLI probes shutdown.
        } finally {
          conn.close();
        }
      })();
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      home.kiln("daemon", "stop"),
      new Promise<null>((resolve) => timer = setTimeout(() => resolve(null), 3000)),
    ]);
    assert(result, "stop kept waiting for the replacement daemon");
    assertEquals(result.code, 0, result.stderr);
    assertEquals(seen.slice(0, 2), ["stop", "ping"]);
  } finally {
    clearTimeout(timer);
    listener.close();
    await serving;
    await Deno.remove(home.root, { recursive: true });
  }
});

withHome("the first command that needs the daemon starts it", async (home) => {
  assertEquals((await status(home)).code, 3);
  const r = await home.kiln("backup");
  assertEquals(r.code, 0, r.stderr);
  assertEquals((await status(home)).code, 0, "daemon is now running");
});

withHome("daemon is reachable only by the owning user", async (home) => {
  await home.kiln("daemon", "start");
  const info = (await status(home)).info;
  assertEquals((await Deno.stat(info.paths.socket)).mode! & 0o777, 0o600);
  assertEquals((await Deno.stat(home.dirs.runtime)).mode! & 0o777, 0o700);
  assertEquals((await Deno.stat(info.paths.store)).mode! & 0o777, 0o600);
});

withHome("the store is SQLite in WAL mode at the current schema version", async (home) => {
  await home.kiln("daemon", "start");
  const info = (await status(home)).info;
  assertEquals(info.store.journalMode, "wal");
  assertEquals(info.store.schemaVersion, 18);
  assert(/^3\.\d+\.\d+/.test(info.store.sqliteVersion));
});

withHome("kiln backup writes a consistent copy of the store", async (home) => {
  const r = await home.kiln("backup");
  assertEquals(r.code, 0, r.stderr);
  const path = r.stdout.trim();
  assert(path.startsWith(home.dirs.data), "backup lives in the data location");
  const copy = new DatabaseSync(path, { readOnly: true });
  try {
    assertEquals(copy.prepare("pragma user_version").get()!.user_version, 18);
    assertEquals(copy.prepare("pragma integrity_check").get()!.integrity_check, "ok");
  } finally {
    copy.close();
  }
});

withHome("an older store is backed up and then migrated when the daemon starts", async (home) => {
  await Deno.mkdir(home.dirs.data, { recursive: true });
  const file = join(home.dirs.data, "kiln.db");
  const old = new DatabaseSync(file);
  old.exec("create table history(note text); insert into history values ('precious')");
  old.close(); // user_version 0: older than any shipped schema

  const r = await home.kiln("daemon", "start");
  assertEquals(r.code, 0, r.stderr);
  assertEquals((await status(home)).info.store.schemaVersion, 18);

  const backups = [...Deno.readDirSync(join(home.dirs.data, "backups"))].map((e) => e.name);
  assertEquals(backups.length, 1);
  const copy = new DatabaseSync(join(home.dirs.data, "backups", backups[0]), { readOnly: true });
  try {
    assertEquals(copy.prepare("select note from history").get()!.note, "precious");
    assertEquals(
      copy.prepare("pragma user_version").get()!.user_version,
      0,
      "copy predates migration",
    );
  } finally {
    copy.close();
  }
});

withHome("a store from a newer Kiln is refused and left untouched", async (home) => {
  await Deno.mkdir(home.dirs.data, { recursive: true });
  const file = join(home.dirs.data, "kiln.db");
  const future = new DatabaseSync(file);
  future.exec("pragma user_version = 99");
  future.close();

  const r = await home.kiln("daemon", "start");
  assertNotEquals(r.code, 0);
  assertStringIncludes(r.stderr, "newer");
  assertEquals((await status(home)).code, 3);
  const check = new DatabaseSync(file, { readOnly: true });
  assertEquals(check.prepare("pragma user_version").get()!.user_version, 99);
  check.close();
});

withHome("two commands starting the daemon at once end up with one daemon", async (home) => {
  const [a, b] = await Promise.all([home.kiln("daemon", "start"), home.kiln("daemon", "start")]);
  assertEquals([a.code, b.code], [0, 0], a.stderr + b.stderr);
  const pid = (await status(home)).info.pid;
  assertEquals(Number(/pid (\d+)/.exec(a.stdout)![1]), pid);
  assertEquals(Number(/pid (\d+)/.exec(b.stdout)![1]), pid);
});

withHome("a daemon that was killed leaves nothing that blocks the next start", async (home) => {
  await home.kiln("daemon", "start");
  const crashed = (await status(home)).info.pid;
  Deno.kill(crashed, "SIGKILL");
  await new Promise((r) => setTimeout(r, 200));
  assertEquals((await status(home)).code, 3, "a stale socket does not count as running");
  const r = await home.kiln("daemon", "start");
  assertEquals(r.code, 0, r.stderr);
  assertNotEquals((await status(home)).info.pid, crashed);
});

withHome("a terminal interrupt or hangup does not stop the daemon", async (home) => {
  await home.kiln("daemon", "start");
  const pid = (await status(home)).info.pid;
  Deno.kill(pid, "SIGHUP");
  Deno.kill(pid, "SIGINT");
  await new Promise((r) => setTimeout(r, 300));
  assertEquals((await status(home)).info.pid, pid);
});

Deno.test("files go in the standard per-purpose locations", async () => {
  const root = await Deno.makeTempDir({ dir: "/tmp", prefix: "kiln-" });
  const env = {
    PATH: Deno.env.get("PATH") ?? "",
    HOME: root,
    DENO_DIR: Deno.env.get("DENO_DIR") ?? join(Deno.env.get("HOME") ?? root, ".cache", "deno"),
    XDG_CONFIG_HOME: join(root, "xc"),
    XDG_DATA_HOME: join(root, "xd"),
    XDG_STATE_HOME: join(root, "xs"),
    XDG_RUNTIME_DIR: join(root, "xr"),
  };
  await Deno.mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  try {
    await runKiln(env, ["daemon", "start"]);
    const r = await runKiln(env, ["daemon", "status", "--json"]);
    const p = JSON.parse(r.stdout).paths;
    if (Deno.build.os === "darwin") {
      const support = join(root, "Library", "Application Support", "kiln");
      assertEquals(p.config, join(support, "config"));
      assertEquals(p.store, join(support, "data", "kiln.db"));
      assertEquals(p.log, join(root, "Library", "Logs", "kiln", "daemon.log"));
    } else {
      assertEquals(p.config, join(root, "xc", "kiln"));
      assertEquals(p.store, join(root, "xd", "kiln", "kiln.db"));
      assertEquals(p.log, join(root, "xs", "kiln", "daemon.log"));
      assertEquals(p.socket, join(root, "xr", "kiln", "kiln.sock"));
    }
    assert((await Deno.stat(p.config)).isDirectory, "config location is created");
  } finally {
    await runKiln(env, ["daemon", "stop"]);
    await Deno.remove(root, { recursive: true });
  }
});
