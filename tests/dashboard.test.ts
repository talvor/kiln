// `kiln dashboard`: the real process against the real daemon in the test world, over HTTP.
// Browser-visible behavior only: what an HTTP client sees, plus the Kiln home and the process
// table for the token's secrecy.
import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { withWorld, type World } from "./world.ts";

const text = async (res: Response) => await res.text();

withWorld(
  "the dashboard prints a tokenised URL first, serves it once, and stops on Ctrl-C",
  async (w) => {
    const d = await w.dashboard();
    assertMatch(d.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}$/);
    const cookie = await d.signIn();
    const page = await d.fetch("/", { cookie });
    assertEquals(page.status, 200);
    assertStringIncludes(await text(page), "<title>Kiln</title>");
    assertEquals(await d.interrupt(), 0);
    await assertRejects(() => d.fetch("/"));
  },
);

withWorld("--port picks the port", async (w) => {
  const free = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = (free.addr as Deno.NetAddr).port;
  free.close();
  const d = await w.dashboard("--port", String(port));
  assertEquals(d.port, port);
});

withWorld("two launches are independent: own port, own token", async (w) => {
  const [a, b] = [await w.dashboard(), await w.dashboard()];
  assertNotEquals(a.port, b.port);
  assertNotEquals(a.token, b.token);
  const cookieA = await a.signIn();
  assertEquals((await b.fetch("/", { cookie: cookieA })).status, 403); // A's cookie means nothing to B
  assertEquals((await b.fetch("/", { cookie: await b.signIn() })).status, 200);
});

withWorld("a request without the cookie is refused", async (w) => {
  const d = await w.dashboard();
  for (const path of ["/", "/api/status", "/anything"]) {
    const res = await d.fetch(path);
    assertEquals(res.status, 403, path);
    await res.body?.cancel();
  }
  const wrong = await d.fetch("/", { cookie: "kiln_dashboard=nope" });
  assertEquals(wrong.status, 403);
  await wrong.body?.cancel();
});

withWorld(
  "the URL token works once, then the cookie is HttpOnly and SameSite=Strict",
  async (w) => {
    const d = await w.dashboard();
    const first = await d.fetch(`/?token=${d.token}`);
    assertEquals(first.status, 303);
    assertEquals(first.headers.get("location"), "/");
    const setCookie = first.headers.get("set-cookie") ?? "";
    assertMatch(setCookie, /HttpOnly/i);
    assertMatch(setCookie, /SameSite=Strict/i);
    assert(!setCookie.includes(d.token), "the cookie is not the token");
    const again = await d.fetch(`/?token=${d.token}`);
    assertEquals(again.status, 403);
    await again.body?.cancel();
    // The cookie from the first exchange still works.
    const page = await d.fetch("/", { cookie: setCookie.split(";")[0] });
    assertEquals(page.status, 200);
    await page.body?.cancel();
  },
);

withWorld("a wrong token is refused and does not spend the real one", async (w) => {
  const d = await w.dashboard();
  const bad = await d.fetch(`/?token=${"0".repeat(64)}`);
  assertEquals(bad.status, 403);
  await bad.body?.cancel();
  assert((await d.signIn()).startsWith("kiln_dashboard="));
});

withWorld("a wrong Host or, on a mutating request, a wrong Origin is refused", async (w) => {
  const d = await w.dashboard();
  const cookie = await d.signIn();
  const refused = async (init: Parameters<typeof d.fetch>[1], why: string) => {
    const res = await d.fetch("/", { cookie, ...init });
    assertEquals(res.status, 403, why);
    await res.body?.cancel();
  };
  await refused({ host: "evil.example" }, "rebound host");
  await refused({ host: `evil.example:${d.port}` }, "rebound host with port");
  await refused({ method: "POST", origin: "http://evil.example" }, "foreign origin");
  await refused({ method: "POST" }, "no origin");
  // A right Host and Origin get past the checks (there is no such action to take yet).
  const ok = await d.fetch("/", { cookie, method: "POST", origin: d.origin });
  assertEquals(ok.status, 405);
  await ok.body?.cancel();
});

withWorld("a wrong Host cannot spend the token", async (w) => {
  const d = await w.dashboard();
  const exchange = await d.fetch(`/?token=${d.token}`, { host: "evil.example" });
  assertEquals(exchange.status, 403);
  await exchange.body?.cancel();
  assert((await d.signIn()).startsWith("kiln_dashboard="), "the refused exchange kept the token");
});

withWorld("a refused request never reaches the daemon", async (w) => {
  // Stand in for the daemon: count who connects to its socket.
  await Deno.mkdir(w.dirs.runtime, { recursive: true });
  const listener = Deno.listen({ transport: "unix", path: join(w.dirs.runtime, "kiln.sock") });
  let connections = 0;
  (async () => {
    for await (const conn of listener) {
      connections++;
      await conn.read(new Uint8Array(4096));
      const reply = { id: 1, ok: true, result: { pid: 1, version: "x", startedAt: "now" } };
      await conn.write(new TextEncoder().encode(JSON.stringify(reply) + "\n"));
      conn.close();
    }
  })().catch(() => {});
  try {
    const d = await w.dashboard();
    const cookie = await d.signIn();
    const settle = () => new Promise((r) => setTimeout(r, 300));
    for (
      const init of [
        {},
        { host: "evil.example", cookie },
        { cookie: "kiln_dashboard=nope" },
        { cookie, method: "POST", origin: "http://evil.example" },
      ]
    ) {
      const res = await d.fetch("/api/status", init);
      assertEquals(res.status, init.cookie === cookie && !init.host && !init.method ? 200 : 403);
      await res.body?.cancel();
    }
    await settle();
    assertEquals(connections, 0);
    const allowed = await d.fetch("/api/status", { cookie });
    assertEquals(allowed.status, 200);
    await allowed.body?.cancel();
    await settle();
    assertEquals(connections, 1, "an allowed request does reach the daemon");
  } finally {
    listener.close();
  }
});

/** Everything in the store: every row of every table, to see that a GET changed none of it. */
async function storeSnapshot(w: World): Promise<string> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(w.dirs.data, "kiln.db"), { readOnly: true });
  try {
    const tables = db.prepare("select name from sqlite_master where type = 'table' order by name")
      .all().map((t) => String(t.name));
    return JSON.stringify(
      tables.map((t) => [t, db.prepare(`select * from "${t}"`).all()]),
    );
  } finally {
    db.close();
  }
}

withWorld("every GET route leaves the store and the event log unchanged", async (w) => {
  assertEquals((await w.kiln("daemon", "start")).code, 0);
  const d = await w.dashboard();
  const cookie = await d.signIn();
  const before = await storeSnapshot(w);
  for (const path of ["/", "/api/status", "/missing"]) {
    const res = await d.fetch(path, { cookie });
    await res.body?.cancel();
  }
  const status = await d.fetch("/api/status", { cookie });
  const body = await status.json();
  assertEquals(body.running, true);
  assertEquals(await storeSnapshot(w), before);
});

withWorld("with no daemon the page loads and says so, and the daemon is not started", async (w) => {
  const d = await w.dashboard();
  const cookie = await d.signIn();
  assertEquals((await d.fetch("/", { cookie })).status, 200);
  const status = await d.fetch("/api/status", { cookie });
  assertEquals(await status.json(), { running: false });
  assertEquals((await w.kiln("daemon", "status")).code, 3, "still not running");
});

withWorld("the token is in no argv, environment or file of the Kiln home", async (w) => {
  assertEquals((await w.kiln("daemon", "start")).code, 0);
  const d = await w.dashboard();
  const cookie = await d.signIn();
  await (await d.fetch("/", { cookie })).body?.cancel();
  for (const proc of ["cmdline", "environ"]) {
    try {
      const raw = await Deno.readTextFile(`/proc/${d.pid}/${proc}`);
      assert(!raw.includes(d.token), `the token is in the process's ${proc}`);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err; // no /proc on this OS
    }
  }
  const found = await new Deno.Command("grep", {
    args: ["-rlF", "--", d.token, w.root],
    stdout: "piped",
    stderr: "null",
  }).output();
  assertEquals(new TextDecoder().decode(found.stdout), "");
});

withWorld("the browser is opened on a launch link that is not the token", async (w) => {
  const d = await w.dashboard("--open");
  const [opened] = await waitFor(() => w.openedUrls(), (urls) => urls.length > 0);
  assert(!opened.includes(d.token), "the token is in the opener's argv");
  assertStringIncludes(opened, `127.0.0.1:${d.port}`);
  const path = new URL(opened).pathname;
  const launched = await d.fetch(path);
  assertEquals(launched.status, 303);
  assertEquals(launched.headers.get("location"), "/");
  const cookie = (launched.headers.get("set-cookie") ?? "").split(";")[0];
  assertMatch(launched.headers.get("set-cookie") ?? "", /HttpOnly.*SameSite=Strict/i);
  assertEquals((await d.fetch("/", { cookie })).status, 200);
  // Using the launch link killed both it and the token, for anyone without the cookie.
  for (const dead of [path, `/?token=${d.token}`]) {
    const res = await d.fetch(dead);
    assertEquals(res.status, 403, dead);
    await res.body?.cancel();
  }
  // A reload of the original URL, with the cookie, just goes home.
  const reload = await d.fetch(`/?token=${d.token}`, { cookie });
  assertEquals(reload.status, 303);
  assertEquals(reload.headers.get("set-cookie"), null);
});

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await read();
    if (done(v)) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
}
