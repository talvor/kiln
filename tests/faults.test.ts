// Environment faults, seen the way a person sees them: break the clone or a Worktree underneath a
// running Kiln and watch it pause the Project, tell the user once, and put things right.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withWorld, type World } from "./world.ts";
import { asAgent, assignment, openTeam, waitFor } from "./router_helpers.ts";

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

const clonePath = (world: World) => join(world.dirs.data, "projects", "remote");
const exists = (path: string) => Deno.stat(path).then(() => true, () => false);

let lastTmpdir = "";
async function startRequest(world: World): Promise<string> {
  const r = await world.kiln("request", "start", "remote");
  assertEquals(r.code, 0, r.stderr);
  lastTmpdir = r.stdout.match(/^TMPDIR=(.*)$/m)![1];
  return r.stdout.match(/^Worktree: (.*)$/m)![1];
}

interface Listed {
  id: number;
  summary: string;
  status: string;
  reason: string | null;
  detail: string | null;
}
async function escalations(world: World): Promise<Listed[]> {
  const r = await world.kiln("escalations", "--all", "--json");
  assertEquals(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}
async function paused(world: World): Promise<boolean> {
  const r = await world.kiln("project", "list");
  assertEquals(r.code, 0, r.stderr);
  return /remote\s+paused/.test(r.stdout);
}
/** Wait until Kiln has recovered: one closed Escalation about the fault, the Project working. */
async function recovered(world: World): Promise<Listed> {
  await waitFor(
    async () => [await escalations(world), await paused(world)] as const,
    ([list, isPaused]) => list.length === 1 && list[0].status !== "open" && !isPaused,
    20_000,
  );
  const [only] = await escalations(world);
  return only;
}

withWorld("a deleted worktree is recreated, with one escalation that closes itself", async (w) => {
  await register(w);
  const worktree = await startRequest(w);
  await Deno.writeTextFile(join(worktree, "work.txt"), "kept\n");
  await w.git(worktree, "add", ".");
  await w.git(worktree, "commit", "-m", "Work");

  // The runtime directory goes too, as it does on reboot.
  await Deno.remove(worktree, { recursive: true });
  await Deno.remove(join(w.root, "xdg"), { recursive: true });
  await Deno.mkdir(join(w.root, "xdg"));
  const escalation = await recovered(w);
  assert((await Deno.stat(lastTmpdir)).isDirectory, "TMPDIR is made again");

  assertStringIncludes(escalation.summary, "Environment fault on remote");
  assertStringIncludes(escalation.summary, worktree);
  assertEquals(escalation.status, "approved");
  // The Worktree is back on its branch, with what was committed.
  assertEquals((await w.git(worktree, "branch", "--show-current")).stdout.trim(), "kiln/request-1");
  assertEquals(await Deno.readTextFile(join(worktree, "work.txt")), "kept\n");
  // And the Project takes new work again.
  assertEquals((await w.kiln("request", "start", "remote")).code, 0);
});

withWorld("a damaged clone is cloned again and the worktrees made again", async (w) => {
  await register(w);
  const worktree = await startRequest(w);

  await Deno.remove(join(clonePath(w), ".git", "objects"), { recursive: true });
  const escalation = await recovered(w);

  assert(/damaged|no longer a git repository/.test(escalation.summary), escalation.summary);
  assertEquals((await w.git(clonePath(w), "fsck", "--connectivity-only")).code, 0);
  assertEquals((await w.git(worktree, "branch", "--show-current")).stdout.trim(), "kiln/request-1");
  assertEquals((await w.kiln("request", "start", "remote")).code, 0);
});

withWorld(
  "a fault Kiln cannot put right keeps the project paused with one escalation",
  async (w) => {
    await register(w);
    await startRequest(w);
    const away = `${w.remote.path}.away`;
    await Deno.rename(w.remote.path, away);
    await Deno.remove(clonePath(w), { recursive: true });

    const [open] = await waitFor(
      () => escalations(w),
      (list) => list.length > 0,
      20_000,
    );
    assertEquals(open.status, "open");
    assert(/is gone|no longer a git repository/.test(open.summary), open.summary);
    assert(await paused(w));
    const refused = await w.kiln("request", "start", "remote");
    assertEquals(refused.code, 1);
    assertStringIncludes(refused.stderr, "paused");

    // Several more looks raise nothing new.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assertEquals((await escalations(w)).length, 1);
    assertEquals((await escalations(w))[0].status, "open");

    // Once the remote is back, Kiln recovers on its own.
    await Deno.rename(away, w.remote.path);
    const closed = await recovered(w);
    assertEquals(closed.id, open.id);
    assert(await exists(join(clonePath(w), ".git")));
  },
);

withWorld("recovering does not resume a project the user paused", async (w) => {
  await register(w);
  const worktree = await startRequest(w);
  assertEquals((await w.kiln("project", "pause", "remote")).code, 0);

  await Deno.remove(worktree, { recursive: true });
  await waitFor(
    async () => [await escalations(w), await exists(worktree)] as const,
    ([list, back]) => list.length === 1 && list[0].status === "approved" && back,
    20_000,
  );
  assert(await paused(w), "the user's pause stays");
});

withWorld("a worktree made again fails the assignment standing on it", async (w) => {
  await register(w);
  const request = await startRequest(w);
  assert(request);
  const sent = await asAgent(
    w,
    "dev-lead",
    (agent) => agent.send("dev-1", "assignment", assignment),
  );
  await asAgent(w, "dev-1", (agent) => agent.inbox());
  const started = await w.kiln("assignment", "start", "1", String(sent.id));
  assertEquals(started.code, 0, started.stderr);
  const worktree = started.stdout.match(/^Worktree: (.*)$/m)![1];

  await Deno.remove(worktree, { recursive: true });
  const escalation = await recovered(w);
  assertStringIncludes(escalation.detail ?? "", `failed because of it: ${sent.id}`);

  const inbox = await asAgent(w, "dev-lead", (agent) => agent.inbox());
  const result = inbox.find((m) => m.kind === "result" && m.inReplyTo === sent.id);
  assert(result, "the leader is told the assignment failed");
  assertStringIncludes(JSON.stringify(result.body), "unpushed work");
  const overseer = await asAgent(w, "overseer", (agent) => agent.inbox());
  assert(overseer.some((m) => m.kind === "question" && /stuck/.test(JSON.stringify(m.body))));
});
