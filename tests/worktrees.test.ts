// Worktrees, request branches and Assignment merge-back, driven the way a person drives them:
// `kiln request ...` and `kiln assignment ...` against the fake world (bare remote, scripted
// claude). A "worker" is the scripted launcher run in the Assignment's Worktree plus a commit.
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { join, relative } from "@std/path";
import { withWorld, type World } from "./world.ts";

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
async function startAssignment(world: World, requestId: number) {
  const r = await world.kiln("assignment", "start", String(requestId));
  assertEquals(r.code, 0, r.stderr);
  return fields(r.stdout);
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
        relative(world.dirs.data, wt).startsWith("worktrees"),
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
      // Support directories sit beside the worktree, never inside it.
      assert(relative(w.Worktree, dir).startsWith(".."), `${dir} is inside the worktree`);
    }
  }

  // Finishing an Assignment gives its ports back for the next one.
  await work(world, a.Worktree, { "a.txt": "a\n" });
  assertEquals((await world.kiln("assignment", "merge", "1")).code, 0);
  const c = await startAssignment(world, 1);
  assertEquals(c.KILN_PORT_BASE, a.KILN_PORT_BASE);
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
  assertStringIncludes((await world.kiln("assignment", "start", "9")).stderr, "No request 9");
  assertStringIncludes((await world.kiln("assignment", "merge", "9")).stderr, "No assignment 9");

  await world.kiln("project", "pause", "remote");
  const paused = await world.kiln("request", "start", "remote");
  assertEquals(paused.code, 1);
  assertStringIncludes(paused.stderr, "paused");
});
