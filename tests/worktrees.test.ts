// Worktrees, request branches and Assignment merge-back, driven the way a person drives them:
// `kiln request ...` and `kiln assignment ...` against the fake world (bare remote, scripted
// claude). A "worker" is the scripted launcher run in the Assignment's Worktree plus a commit.
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { basename, dirname, join, relative } from "@std/path";
import { runKiln } from "./helpers.ts";
import { withWorld, type World } from "./world.ts";
import { cleanUpRequest, makeTmpdir, MAX_TMPDIR_LENGTH, tmpdirOf } from "../src/worktrees.ts";
import { sandboxFor } from "../src/daemon.ts";
import { createLogger } from "../src/log.ts";
import { openStore } from "../src/store.ts";
import type { WorktreeRecord } from "../src/store.ts";
import { asAgent, assignment, openTeam } from "./router_helpers.ts";

const COMMANDS = { setup: null, test: null, lint: null, build: null };

async function register(world: World) {
  await Deno.writeTextFile(join(world.project.path, "AGENTS.md"), "# How to work here\n");
  await world.git(world.project.path, "add", ".");
  await world.git(world.project.path, "commit", "-m", "Add agent docs");
  await world.git(world.project.path, "push", "origin", "main");
  await world.githubApi.script([{ stdout: "{}\n" }]);
  await world.launcher.script([{ result: JSON.stringify(COMMANDS) }]);
  const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(r.code, 0, r.stderr);
  await openTeam(world);
}

/** The `KEY=value` and `Label: value` lines a start command printed. */
function fields(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const m = line.match(/^(Branch|Worktree|[A-Za-z_]+)[:=] ?(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function startRequest(world: World) {
  const r = await world.kiln("request", "start", "remote");
  assertEquals(r.code, 0, r.stderr);
  return fields(r.stdout);
}
async function startAssignment(world: World, requestId: number): Promise<Record<string, string>> {
  const message = await asAgent(
    world,
    "dev-lead",
    (agent) => agent.send("dev-1", "assignment", assignment),
  );
  await asAgent(world, "dev-1", (agent) => agent.inbox());
  const r = await world.kiln("assignment", "start", String(requestId), String(message.id));
  assertEquals(r.code, 0, r.stderr);
  return { ...fields(r.stdout), assignmentId: String(message.id) };
}

/** The worker: the scripted launcher writes files in the Worktree, then the work is committed. */
async function work(world: World, worktree: string, files: Record<string, string>) {
  await world.launcher.script([{ result: "done", writeFiles: files }]);
  const r = await world.kiln("launch", "do the work", "--cwd", worktree);
  assertEquals(r.code, 0, r.stderr);
  await world.git(worktree, "add", ".");
  await world.git(worktree, "commit", "-m", "Do the work");
}

const remoteFile = async (world: World, branch: string, file: string) =>
  (await world.exec(world.remote.path, "git", "show", `${branch}:${file}`)).stdout;

withWorld(
  "a request gets its own branch and a worktree outside the project's clone",
  async (world) => {
    await register(world);
    const first = await startRequest(world);
    const second = await startRequest(world);

    assertEquals(first.Branch, "kiln/request-1");
    assertEquals(second.Branch, "kiln/request-2");
    for (const wt of [first.Worktree, second.Worktree]) {
      const clone = join(world.dirs.data, "projects", "remote");
      assert(relative(clone, wt).startsWith(".."), `${wt} is inside the clone`);
      assert(
        relative(await Deno.realPath(world.dirs.data), wt).startsWith("worktrees"),
        `${wt} is not under worktrees/`,
      );
      assertEquals(
        (await world.git(wt, "branch", "--show-current")).stdout.trim(),
        first.Worktree === wt ? "kiln/request-1" : "kiln/request-2",
      );
      assertEquals(
        (await world.git(wt, "rev-parse", "HEAD")).stdout,
        (await world.git(world.project.path, "rev-parse", "HEAD")).stdout,
      );
    }
    // Kiln's clone stays on the default branch and clean.
    const clone = join(world.dirs.data, "projects", "remote");
    assertEquals((await world.git(clone, "branch", "--show-current")).stdout.trim(), "main");
    assertEquals((await world.git(clone, "status", "--porcelain")).stdout, "");
  },
);

withWorld(
  "an assignment works on its own branch and is merged back and pushed once verified",
  async (world) => {
    await register(world);
    const request = await startRequest(world);
    const a = await startAssignment(world, 1);
    const b = await startAssignment(world, 1);
    assertEquals(a.Branch, "kiln/request-1-assignment-1");
    assertEquals(b.Branch, "kiln/request-1-assignment-2");
    assertNotEquals(a.Worktree, b.Worktree);

    await work(world, a.Worktree, { "a.txt": "from a\n" });
    await work(world, b.Worktree, { "b.txt": "from b\n" });
    // Nothing reaches the remote until an Assignment is merged.
    assertEquals(await world.remote.branches(), ["main"]);

    const merged = await world.kiln("assignment", "merge", "1");
    assertEquals(merged.code, 0, merged.stderr);
    assertEquals(await world.remote.branches(), ["kiln/request-1", "main"]);
    assertEquals(await remoteFile(world, "kiln/request-1", "a.txt"), "from a\n");
    assertEquals(
      (await world.exec(world.remote.path, "git", "show", "kiln/request-1:b.txt")).code,
      128,
    );

    // The next Assignment is merged on top, and the push follows each merge.
    assertEquals((await world.kiln("assignment", "merge", "2")).code, 0);
    assertEquals(await remoteFile(world, "kiln/request-1", "b.txt"), "from b\n");
    assertEquals((await world.exec(world.remote.path, "git", "show", "main:a.txt")).code, 128);
    assertEquals(
      (await world.git(request.Worktree, "log", "--format=%s", "-n", "2")).stdout.split("\n")[0],
      "Merge assignment 2 of request 1",
    );

    // A merged Assignment's Worktree is gone, and merging it again is refused.
    assertEquals(await Deno.stat(a.Worktree).then(() => true, () => false), false);
    const again = await world.kiln("assignment", "merge", "1");
    assertEquals(again.code, 1);
    assertStringIncludes(again.stderr, "already merged");
  },
);

withWorld("every worktree has its own ports, temp directory and caches", async (world) => {
  await register(world);
  const request = await startRequest(world);
  const a = await startAssignment(world, 1);
  const b = await startAssignment(world, 1);

  const all = [request, a, b];
  for (const key of ["KILN_PORT_BASE", "TMPDIR", "XDG_CACHE_HOME", "npm_config_cache"]) {
    assertEquals(new Set(all.map((w) => w[key])).size, 3, `${key} is shared`);
  }
  const count = Number(request.KILN_PORT_COUNT);
  const bases = all.map((w) => Number(w.KILN_PORT_BASE)).sort((x, y) => x - y);
  assert(bases[1] - bases[0] >= count && bases[2] - bases[1] >= count, "port blocks overlap");
  for (const w of all) {
    for (const dir of [w.TMPDIR, w.XDG_CACHE_HOME, w.npm_config_cache]) {
      assert((await Deno.stat(dir)).isDirectory);
      // Support directories sit outside the worktree, never inside it.
      assert(relative(w.Worktree, dir).startsWith(".."), `${dir} is inside the worktree`);
    }
    // The temp directory is short, private, and under the runtime directory.
    assert(new TextEncoder().encode(w.TMPDIR).length <= MAX_TMPDIR_LENGTH, `${w.TMPDIR} is too long`);
    assert(w.TMPDIR.startsWith(join(world.root, "xdg", "kiln") + "/"), w.TMPDIR);
    for (const dir of [w.TMPDIR, join(w.TMPDIR, ".."), join(w.TMPDIR, "..", "..")]) {
      assertEquals((await Deno.stat(dir)).mode! & 0o777, 0o700, `${dir} is not private`);
    }
  }

  await world.launcher.script([{ result: "environment applied" }]);
  const launched = await world.kiln("launch", "check environment", "--cwd", a.Worktree);
  assertEquals(launched.code, 0, launched.stderr);
  const calls = await world.launcher.calls();
  const call = calls.at(-1)!;
  assertEquals(call.cwd, await Deno.realPath(a.Worktree));
  // The sandbox settings for a launch there may write to the worker's TMPDIR.
  const key = basename(dirname(a.TMPDIR));
  const wt = record(Number(key.split("-")[0]), a.Worktree);
  Deno.env.set("XDG_RUNTIME_DIR", join(world.root, "xdg"));
  try {
    assertEquals(tmpdirOf(wt), a.TMPDIR);
    const sandbox = await sandboxFor({ filesystem: { allowWrite: ["/x"] } }, wt);
    const allowed = (sandbox!.filesystem as { allowWrite: string[] }).allowWrite;
    assert(allowed.includes(a.TMPDIR) && allowed.includes("/x"), allowed.join());
  } finally {
    Deno.env.delete("XDG_RUNTIME_DIR");
  }
  for (
    const key of [
      "KILN_PORT_BASE",
      "KILN_PORT_COUNT",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "npm_config_cache",
    ]
  ) {
    assertEquals(call.env?.[key], a[key], key);
  }

  // Finishing an Assignment gives its ports back for the next one.
  await work(world, a.Worktree, { "a.txt": "a\n" });
  const fallback = tmpdirOf(record(Number(key.split("-")[0]), a.Worktree), null);
  await Deno.mkdir(fallback, { recursive: true });
  assertEquals((await world.kiln("assignment", "merge", "1")).code, 0);
  // ... and removes its support and temp directories.
  assertEquals(await exists(`${a.Worktree}.kiln`), false);
  assertEquals(await exists(a.TMPDIR), false);
  assertEquals(await exists(fallback), false);
  assertEquals(await exists(b.TMPDIR), true);
  const c = await startAssignment(world, 1);
  assertEquals(c.KILN_PORT_BASE, a.KILN_PORT_BASE);
});

const exists = (path: string) => Deno.stat(path).then(() => true, () => false);

const record = (id: number, path: string): WorktreeRecord => ({
  id,
  path,
  branch: "b",
  portBase: 20000,
  releasedAt: null,
});

Deno.test("TMPDIR stays short whatever the data dir, project name or ids", () => {
  const long = `/home/${"u".repeat(40)}/.local/share/kiln/worktrees/${"p".repeat(60)}`;
  const seen = new Set<string>();
  for (const id of [1, 99, 123456789]) {
    for (const path of [`${long}/request-${id}`, `${long}/request-${id}-assignment-${id}${id}`]) {
      for (const runtime of ["/run/user/1000", null]) {
        const tmp = tmpdirOf(record(id, path), runtime, 1000);
        assert(new TextEncoder().encode(tmp).length <= MAX_TMPDIR_LENGTH, `${tmp} is too long`);
        seen.add(tmp);
      }
    }
  }
  assertEquals(seen.size, 12, "every Worktree has its own TMPDIR");
  assertNotEquals(
    tmpdirOf(record(1, "/tmp/kiln-home-5746/worktrees/project/request-1"), null, 1000),
    tmpdirOf(record(1, "/tmp/kiln-home-174803/worktrees/project/request-1"), null, 1000),
  );
});

Deno.test("TMPDIR is under XDG_RUNTIME_DIR, or /tmp/kiln-<uid> without it", () => {
  const wt = record(7, "/data/worktrees/remote/request-7");
  assert(tmpdirOf(wt, "/run/user/1000", 1000).startsWith("/run/user/1000/kiln/7-"));
  assert(tmpdirOf(wt, null, 1000).startsWith("/tmp/kiln-1000/7-"));
});

withWorld(
  "a start whose TMPDIR would be too long fails clearly and leaves nothing",
  async (world) => {
    await register(world);
    const runtime = join(world.root, "x".repeat(80));
    await Deno.mkdir(runtime);
    await world.kiln("daemon", "stop");
    const r = await runKiln({ ...world.env, XDG_RUNTIME_DIR: runtime }, [
      "request",
      "start",
      "remote",
    ]);
    assertEquals(r.code, 1);
    assertStringIncludes(r.stderr, `limit of ${MAX_TMPDIR_LENGTH}`);
    assertEquals(await exists(join(runtime, "kiln")), false);
  },
);

withWorld("an unwritable runtime directory or kiln child uses the fallback", async (world) => {
  await register(world);
  await world.kiln("daemon", "stop");
  const runtime = join(world.root, "xdg");
  await Deno.chmod(runtime, 0o500);
  const first = await runKiln(world.env, ["request", "start", "remote"]);
  await Deno.chmod(runtime, 0o700);
  assertEquals(first.code, 0, first.stderr);
  const firstTmp = fields(first.stdout).TMPDIR;
  assert(firstTmp.startsWith(`/tmp/kiln-${Deno.uid()}/`), firstTmp);
  await world.kiln("daemon", "stop");

  const child = join(runtime, "kiln");
  await Deno.mkdir(child, { mode: 0o500 });
  const second = await runKiln(world.env, ["request", "start", "remote"]);
  await Deno.chmod(child, 0o700);
  assertEquals(second.code, 0, second.stderr);
  const secondTmp = fields(second.stdout).TMPDIR;
  assert(secondTmp.startsWith(`/tmp/kiln-${Deno.uid()}/`), secondTmp);
  for (const tmp of [firstTmp, secondTmp]) await Deno.remove(dirname(tmp), { recursive: true });
});

Deno.test("a denied runtime directory write uses the fallback", async () => {
  const runtime = await Deno.makeTempDir({ dir: "/tmp", prefix: "kiln-runtime-" });
  const wt = record(7, join(runtime, "request-7"));
  const fallback = tmpdirOf(wt, null);
  const originalRuntime = Deno.env.get("XDG_RUNTIME_DIR");
  const originalMakeTemp = Object.getOwnPropertyDescriptor(Deno, "makeTempDirSync")!;
  const makeTempDirSync = Deno.makeTempDirSync;
  Deno.env.set("XDG_RUNTIME_DIR", runtime);
  Object.defineProperty(Deno, "makeTempDirSync", {
    ...originalMakeTemp,
    value: (options?: { dir?: string; prefix?: string }) => {
      if (options?.dir === runtime) throw new Deno.errors.PermissionDenied("write denied");
      return makeTempDirSync(options);
    },
  });
  try {
    await makeTmpdir(wt);
    assertEquals(tmpdirOf(wt), fallback);
    assert((await Deno.stat(fallback)).isDirectory);
  } finally {
    Object.defineProperty(Deno, "makeTempDirSync", originalMakeTemp);
    if (originalRuntime === undefined) Deno.env.delete("XDG_RUNTIME_DIR");
    else Deno.env.set("XDG_RUNTIME_DIR", originalRuntime);
    await Deno.remove(dirname(fallback), { recursive: true }).catch(() => {});
    await Deno.remove(runtime, { recursive: true });
  }
});

withWorld("a multibyte runtime path over the byte limit fails clearly", async (world) => {
  await register(world);
  await world.kiln("daemon", "stop");
  const runtime = join(world.root, "é".repeat(20));
  await Deno.mkdir(runtime);
  const r = await runKiln({ ...world.env, XDG_RUNTIME_DIR: runtime }, [
    "request",
    "start",
    "remote",
  ]);
  assertEquals(r.code, 1);
  assertStringIncludes(r.stderr, `limit of ${MAX_TMPDIR_LENGTH}`);
  assertEquals(await exists(join(runtime, "kiln")), false);
});

withWorld("request cleanup removes runtime and fallback TMPDIRs", async (world) => {
  await register(world);
  const request = await startRequest(world);
  const fallback = tmpdirOf(record(1, request.Worktree), null);
  await Deno.mkdir(fallback, { recursive: true });
  await world.kiln("daemon", "stop");
  const store = await openStore({
    file: join(world.dirs.data, "kiln.db"),
    backupsDir: join(world.dirs.data, "backups"),
    log: createLogger({ file: join(world.root, "cleanup.log") }),
  });
  const originalRuntime = Deno.env.get("XDG_RUNTIME_DIR");
  const runtime = join(world.root, "xdg");
  Deno.env.set("XDG_RUNTIME_DIR", runtime);
  await Deno.chmod(runtime, 0o500);
  try {
    assertEquals(await cleanUpRequest(store, store.getProject("remote"), 1), []);
  } finally {
    await Deno.chmod(runtime, 0o700);
    if (originalRuntime === undefined) Deno.env.delete("XDG_RUNTIME_DIR");
    else Deno.env.set("XDG_RUNTIME_DIR", originalRuntime);
    store.close();
  }
  assertEquals(await exists(request.TMPDIR), false);
  assertEquals(await exists(fallback), false);
});

withWorld("an Assignment uses its router Message ID across start and merge", async (world) => {
  await register(world);
  await startRequest(world);
  const skipped = await asAgent(
    world,
    "dev-lead",
    (agent) => agent.send("dev-1", "assignment", assignment),
  );
  await asAgent(world, "dev-1", (agent) => agent.inbox());
  const started = await startAssignment(world, 1);
  assertEquals(Number(started.assignmentId), skipped.id + 1);
  assertEquals(started.Branch, `kiln/request-1-assignment-${started.assignmentId}`);
  await work(world, started.Worktree, { "identity.txt": "message id\n" });
  const merged = await world.kiln("assignment", "merge", String(started.assignmentId));
  assertEquals(merged.code, 0, merged.stderr);
  assertEquals(await remoteFile(world, "kiln/request-1", "identity.txt"), "message id\n");
});

withWorld("a locked Assignment keeps its ports until cleanup succeeds", async (world) => {
  await register(world);
  await startRequest(world);
  const a = await startAssignment(world, 1);
  await work(world, a.Worktree, { "locked.txt": "done\n" });
  const clone = join(world.dirs.data, "projects", "remote");
  await world.git(clone, "worktree", "lock", a.Worktree);
  const failed = await world.kiln("assignment", "merge", String(a.assignmentId));
  assertEquals(failed.code, 1);
  assertStringIncludes(failed.stderr, "could not be removed");
  assertEquals(await remoteFile(world, "kiln/request-1", "locked.txt"), "done\n");
  const b = await startAssignment(world, 1);
  assertNotEquals(b.KILN_PORT_BASE, a.KILN_PORT_BASE);
  await world.git(clone, "worktree", "unlock", a.Worktree);
  const retried = await world.kiln("assignment", "merge", String(a.assignmentId));
  assertEquals(retried.code, 0, retried.stderr);
  const c = await startAssignment(world, 1);
  assertEquals(c.KILN_PORT_BASE, a.KILN_PORT_BASE);
});

withWorld("a failed worktree add leaves its branch and path reusable", async (world) => {
  await register(world);
  const fallback = tmpdirOf(record(1, join(world.dirs.data, "worktrees", "remote", "request-1")), null);
  await Deno.mkdir(fallback, { recursive: true });
  const runtime = join(world.root, "xdg");
  const realGit = (await world.exec(world.root, "sh", "-c", "command -v git")).stdout.trim();
  const fakeGit = join(world.root, "fake", "bin", "git");
  await Deno.writeTextFile(
    fakeGit,
    `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = add ]; then\n  "${realGit}" "$@" || exit $?\n  chmod 0500 "${runtime}"\n  exit 1\nfi\nexec "${realGit}" "$@"\n`,
  );
  await Deno.chmod(fakeGit, 0o755);
  const failed = await world.kiln("request", "start", "remote");
  await Deno.chmod(runtime, 0o700);
  assertEquals(failed.code, 1);
  // The rollback removed the temp directory too.
  assertEquals([...Deno.readDirSync(join(world.root, "xdg", "kiln"))].length, 0);
  assertEquals(await exists(fallback), false);
  await Deno.remove(fakeGit);
  const retried = await startRequest(world);
  assertEquals(retried.Branch, "kiln/request-1");
  assertEquals(retried.KILN_PORT_BASE, "20000");
});

withWorld("a failed start preserves existing paths and branches", async (world) => {
  await register(world);
  const path = join(world.dirs.data, "worktrees", "remote", "request-1");
  const support = `${path}.kiln`;
  const clone = join(world.dirs.data, "projects", "remote");
  await Deno.mkdir(path, { recursive: true });
  await Deno.writeTextFile(join(path, "sentinel"), "existing path");
  assertEquals((await world.kiln("request", "start", "remote")).code, 1);
  assertEquals(await Deno.readTextFile(join(path, "sentinel")), "existing path");
  await Deno.remove(path, { recursive: true });

  await Deno.mkdir(support);
  await Deno.writeTextFile(join(support, "sentinel"), "existing support");
  assertEquals((await world.kiln("request", "start", "remote")).code, 1);
  assertEquals(await Deno.readTextFile(join(support, "sentinel")), "existing support");
  await Deno.remove(support, { recursive: true });

  await world.git(clone, "branch", "kiln/request-1");
  const tip = (await world.git(clone, "rev-parse", "kiln/request-1")).stdout;
  assertEquals((await world.kiln("request", "start", "remote")).code, 1);
  assertEquals((await world.git(clone, "rev-parse", "kiln/request-1")).stdout, tip);
  await world.git(clone, "branch", "-D", "kiln/request-1");

  const started = await startRequest(world);
  assertEquals(started.Branch, "kiln/request-1");
  assertEquals(started.KILN_PORT_BASE, "20000");
});

withWorld("a relative launch cwd uses its worktree environment", async (world) => {
  await register(world);
  await startRequest(world);
  const a = await startAssignment(world, 1);
  await world.launcher.script([{ result: "done" }]);
  const cwd = relative(await Deno.realPath(world.root), a.Worktree);
  const result = await runKiln(
    world.env,
    ["launch", "check environment", "--cwd", cwd],
    "",
    world.root,
  );
  assertEquals(result.code, 0, result.stderr);
  const call = (await world.launcher.calls()).at(-1)!;
  assertEquals(call.cwd, await Deno.realPath(a.Worktree));
  for (
    const key of [
      "KILN_PORT_BASE",
      "KILN_PORT_COUNT",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "npm_config_cache",
    ]
  ) {
    assertEquals(call.env?.[key], a[key], key);
  }
});

withWorld(
  "a conflicting assignment is refused and leaves the request branch alone",
  async (world) => {
    await register(world);
    await startRequest(world);
    const a = await startAssignment(world, 1);
    const b = await startAssignment(world, 1);
    await work(world, a.Worktree, { "same.txt": "one\n" });
    await work(world, b.Worktree, { "same.txt": "two\n" });
    assertEquals((await world.kiln("assignment", "merge", "1")).code, 0);

    const r = await world.kiln("assignment", "merge", "2");
    assertEquals(r.code, 1);
    assertStringIncludes(r.stderr, "does not merge cleanly");
    assertEquals(await remoteFile(world, "kiln/request-1", "same.txt"), "one\n");
    assertEquals(
      (await world.git(
        join(world.dirs.data, "worktrees", "remote", "request-1"),
        "status",
        "--porcelain",
      )).stdout,
      "",
    );
  },
);

withWorld("an assignment with uncommitted work is not merged", async (world) => {
  await register(world);
  await startRequest(world);
  const a = await startAssignment(world, 1);
  await Deno.writeTextFile(join(a.Worktree, "wip.txt"), "unfinished\n");
  const r = await world.kiln("assignment", "merge", "1");
  assertEquals(r.code, 1);
  assertStringIncludes(r.stderr, "uncommitted changes");
  assertEquals(await world.remote.branches(), ["main"]);
});

withWorld("a failed push is reported and the next merge attempt pushes", async (world) => {
  await register(world);
  await startRequest(world);
  const a = await startAssignment(world, 1);
  await work(world, a.Worktree, { "a.txt": "from a\n" });

  await world.remote.refusePushes();
  const failed = await world.kiln("assignment", "merge", "1");
  assertEquals(failed.code, 1);
  assertStringIncludes(failed.stderr, "pushing it");
  assertEquals(await world.remote.branches(), ["main"]);

  await Deno.writeTextFile(join(world.root, "gitconfig"), "");
  const retried = await world.kiln("assignment", "merge", "1");
  assertEquals(retried.code, 0, retried.stderr);
  assertEquals(await remoteFile(world, "kiln/request-1", "a.txt"), "from a\n");
});

withWorld("requests and assignments are refused when they cannot start", async (world) => {
  await register(world);
  assertStringIncludes(
    (await world.kiln("request", "start", "nope")).stderr,
    'No project named "nope"',
  );
  assertStringIncludes((await world.kiln("assignment", "start", "9", "9")).stderr, "No request 9");
  assertStringIncludes((await world.kiln("assignment", "merge", "9")).stderr, "No assignment 9");

  await world.kiln("project", "pause", "remote");
  const paused = await world.kiln("request", "start", "remote");
  assertEquals(paused.code, 1);
  assertStringIncludes(paused.stderr, "paused");
});
