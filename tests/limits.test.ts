// Limits, concurrency caps and parallel Assignments, driven the way Kiln is used: the CLI, the
// agents' tool servers (the test plays the leader and the workers), the fake remote and the fake
// launcher that wakes the workers. Limits come from `limits.json` in the config directory.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withWorld, type World } from "./world.ts";
import type { LauncherRun } from "./fakes/claude.ts";
import { asAgent, type Message } from "./router_helpers.ts";

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

async function setLimits(world: World, limits: unknown) {
  await Deno.mkdir(world.dirs.config, { recursive: true });
  await Deno.writeTextFile(join(world.dirs.config, "limits.json"), JSON.stringify(limits));
}

interface Status {
  status: string;
  failure: string | null;
  steps: {
    status: string;
    retries: number;
    assignments: {
      id: number;
      worker: string;
      status: string;
      branch: string | null;
      worktree: string | null;
      merged: boolean;
      owns: string[];
      budget: { turns: number; spendUsd: number; seconds: number; idleSeconds: number } | null;
      turnsUsed: number;
      spendUsd: number;
      limitReached: string | null;
    }[];
  }[];
}
type Assignment = Status["steps"][0]["assignments"][0];

async function statusOf(world: World, id = 1): Promise<Status> {
  const r = await world.kiln("request", "status", String(id), "--json");
  assertEquals(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const assignmentOf = async (world: World, id: number, request = 1): Promise<Assignment> =>
  (await statusOf(world, request)).steps.flatMap((s) => s.assignments).find((a) => a.id === id)!;

async function start(world: World, description = "Logins fail after midnight") {
  const r = await world.kiln(
    "request",
    "start",
    "remote",
    "--playbook",
    "diagnose-a-bug",
    "--description",
    description,
  );
  assertEquals(r.code, 0, r.stderr);
}

/** The leader's inbox: the steps the overseer handed it, in order. */
const leaderInbox = (world: World) => asAgent(world, "engineering-leader", (a) => a.inbox());

const delegate = (world: World, worker: string, body: Record<string, unknown>) =>
  asAgent(
    world,
    "engineering-leader",
    (a) => a.send(worker, "assignment", { title: "Do part", instructions: "Do it", ...body }),
  );

async function commit(world: World, worktree: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    await Deno.mkdir(join(worktree, file, ".."), { recursive: true });
    await Deno.writeTextFile(join(worktree, file), content);
  }
  await world.git(worktree, "add", ".");
  await world.git(worktree, "commit", "-m", "Work");
}

const report = (world: World, worker: string, assignment: number, status = "done") =>
  asAgent(world, worker, async (agent) => {
    await agent.inbox();
    await agent.send("engineering-leader", "result", { status, summary: "Done" }, assignment);
  });

async function waitFor<T>(read: () => Promise<T>, ready: (v: T) => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for public evidence");
}

const workerWakeups = async (world: World) =>
  (await world.launcher.prompts()).filter((p) => p.includes("You are a diagnostician")).length;

/** Two Requests on one Project; the leader delegates each Request's first Step to its worker. */
async function twoRequests(world: World, runs: LauncherRun[] = []) {
  await register(world);
  await world.launcher.script(runs);
  await start(world, "First bug");
  await start(world, "Second bug");
  const inbox = await leaderInbox(world);
  assertEquals(inbox.length, 2);
  const first = await delegate(world, "diagnostician-1", {});
  const second = await delegate(world, "diagnostician-3", {});
  return { first, second };
}

withWorld(
  "a per-Project cap queues the next Assignment as planned until a slot frees",
  async (w) => {
    await setLimits(w, { concurrency: { perProject: 1 } });
    const { first, second } = await twoRequests(w, Array(6).fill({ result: "ok" }));

    const a = await assignmentOf(w, first.id, 1);
    const b = await assignmentOf(w, second.id, 2);
    assertEquals([a.status, b.status], ["active", "planned"]);
    assertEquals([b.branch, b.worktree], [null, null]);
    assertStringIncludes((await w.kiln("request", "status", "2")).stdout, "waiting to start");

    // The queued Assignment's worker is not woken while it waits, the running one's is.
    await waitFor(() => workerWakeups(w), (n) => n >= 1);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assertEquals(await workerWakeups(w), 1);

    // The first finishes; the freed slot starts the second, and its worker is woken.
    await report(w, "diagnostician-1", first.id);
    assertEquals((await assignmentOf(w, second.id, 2)).status, "active");
    assert((await assignmentOf(w, second.id, 2)).worktree);
    await waitFor(() => workerWakeups(w), (n) => n >= 2);
  },
);

withWorld("a global cap queues Assignments across Requests", async (w) => {
  await setLimits(w, { concurrency: { global: 1, perProject: 5 } });
  const { first, second } = await twoRequests(w);
  assertEquals((await assignmentOf(w, first.id, 1)).status, "active");
  assertEquals((await assignmentOf(w, second.id, 2)).status, "planned");

  await report(w, "diagnostician-1", first.id, "failed");
  assertEquals((await assignmentOf(w, second.id, 2)).status, "active");
});

withWorld("declared file ownership serialises overlapping Assignments", async (w) => {
  await setLimits(w, { concurrency: { perProject: 5 } });
  await register(w);
  await start(w);
  const [step] = await leaderInbox(w);
  const doc = { "diagnosis.md": "# Diagnosis\nThe cache is stale.\n" };

  const a = await delegate(w, "diagnostician-1", { owns: "src/cache.ts" });
  const b = await delegate(w, "diagnostician-1", { owns: "src/" });
  const c = await delegate(w, "diagnostician-1", { owns: "docs/" });
  const states = async () =>
    (await Promise.all([a, b, c].map((m) => assignmentOf(w, m.id))))
      .map((x) => x.status);
  assertEquals(await states(), ["active", "planned", "active"]);
  assertEquals((await assignmentOf(w, b.id)).owns, ["src/"]);

  await commit(w, (await assignmentOf(w, a.id)).worktree!, {
    ...doc,
    "src/cache.ts": "export const ttl = 1;\n",
  });
  await commit(w, (await assignmentOf(w, c.id)).worktree!, doc);
  await report(w, "diagnostician-1", a.id);
  await report(w, "diagnostician-1", c.id);

  // The overlapping Assignment started once the first was done, on top of the first one's work.
  assertEquals(await states(), ["done", "active", "done"]);
  const second = (await assignmentOf(w, b.id)).worktree!;
  assertEquals(await Deno.readTextFile(join(second, "src/cache.ts")), "export const ttl = 1;\n");
  await commit(w, second, { "src/cache.ts": "export const ttl = 60;\n" });
  await report(w, "diagnostician-1", b.id);

  // So the three merge without a conflict, the later change on top of the earlier one.
  await asAgent(
    w,
    "engineering-leader",
    (agent) => agent.send("overseer", "result", { status: "done", summary: "Verified" }, step.id),
  );
  const status = await statusOf(w);
  assertEquals([status.steps[0].status, status.steps[0].retries], ["done", 0]);
  const merged = await w.exec(w.remote.path, "git", "show", "kiln/request-1:src/cache.ts");
  assertEquals(merged.stdout, "export const ttl = 60;\n");
});

withWorld("work that conflicts at merge becomes a new Assignment", async (w) => {
  await register(w);
  await start(w);
  const [step] = await leaderInbox(w);
  const doc = { "diagnosis.md": "# Diagnosis\nThe cache is stale.\n" };

  // Two workers change the same file without declaring it, so nothing keeps them apart.
  const a = await delegate(w, "diagnostician-1", {});
  const b = await delegate(w, "diagnostician-1", {});
  assertEquals((await assignmentOf(w, b.id)).status, "active");
  await commit(w, (await assignmentOf(w, a.id)).worktree!, { ...doc, "ttl.txt": "1\n" });
  await commit(w, (await assignmentOf(w, b.id)).worktree!, { ...doc, "ttl.txt": "60\n" });
  await report(w, "diagnostician-1", a.id);
  await report(w, "diagnostician-1", b.id);
  await asAgent(
    w,
    "engineering-leader",
    (agent) => agent.send("overseer", "result", { status: "done", summary: "Verified" }, step.id),
  );

  // The first merged; the second did not. Instead of failing the step, Kiln sends the leader a
  // new Assignment for a fresh worker that starts from the conflicting work.
  let status = await statusOf(w);
  assertEquals([status.status, status.steps[0].status, status.steps[0].retries], [
    "active",
    "active",
    1,
  ]);
  const conflict = (await leaderInbox(w)).find((m) => m.from === "overseer")!;
  assertEquals([conflict.from, conflict.kind], ["overseer", "assignment"]);
  assertStringIncludes(String(conflict.body.instructions), "does not merge cleanly");
  assertStringIncludes(String(conflict.body.instructions), "diagnostician-1-retry-1");
  assertEquals((await assignmentOf(w, a.id)).merged, true);
  assertEquals((await assignmentOf(w, b.id)).status, "failed");

  const fix = await delegate(w, "diagnostician-1-retry-1", {});
  const worktree = (await assignmentOf(w, fix.id)).worktree!;
  assertEquals(await Deno.readTextFile(join(worktree, "ttl.txt")), "60\n");
  const merging = await w.exec(worktree, "git", "merge", "kiln/request-1");
  assertEquals(merging.code, 1);
  await commit(w, worktree, { "ttl.txt": "60\n" });
  await report(w, "diagnostician-1-retry-1", fix.id);
  await asAgent(
    w,
    "engineering-leader",
    (agent) =>
      agent.send("overseer", "result", { status: "done", summary: "Verified" }, conflict.id),
  );

  status = await statusOf(w);
  assertEquals(status.steps.map((s) => s.status), ["done", "active"]);
  const merged = await w.exec(w.remote.path, "git", "show", "kiln/request-1:ttl.txt");
  assertEquals(merged.stdout, "60\n");
});

/** Start a Request whose first Step has one Assignment, under `limits`. */
async function oneAssignment(
  world: World,
  limits: unknown,
  body: Record<string, unknown> = {},
  runs?: LauncherRun[],
) {
  await setLimits(world, limits);
  await register(world);
  await start(world);
  await leaderInbox(world);
  // Scripted before the worker is delegated to, so no wake of it can come first.
  if (runs) await world.launcher.script(runs);
  const job = await delegate(world, "diagnostician-1", body);
  return job;
}

/** What the leader is told once the limit stopped the worker. */
async function limitReport(world: World, job: Message): Promise<Message> {
  const inbox = await asAgent(world, "engineering-leader", (a) => a.inbox());
  const result = inbox.find((m) => m.kind === "result" && m.inReplyTo === job.id)!;
  assert(result, "the leader got a result for the assignment");
  return result;
}

function assertLeaderOptions(result: Message, limit: string) {
  assertEquals([result.from, result.to, result.body.status, result.synthesised], [
    "diagnostician-1",
    "engineering-leader",
    "failed",
    true,
  ]);
  const summary = String(result.body.summary);
  assertStringIncludes(summary, "Limit reached");
  assertStringIncludes(summary, limit);
  for (const option of ["continue", "split", "give up"]) assertStringIncludes(summary, option);
}

withWorld("an Assignment that uses its turns is stopped and the leader gets options", async (w) => {
  const job = await oneAssignment(
    w,
    { defaults: { turns: 5 } },
    {},
    Array(4).fill({ result: "ok", turns: 6 }),
  );
  await commit(w, (await assignmentOf(w, job.id)).worktree!, { "notes.md": "half way\n" });

  const stopped = await waitFor(() => assignmentOf(w, job.id), (a) => a.status === "failed");
  assertEquals([stopped.limitReached, stopped.turnsUsed], ["turns", 6]);
  const call = (await w.launcher.calls()).find((c) => c.args.some((x) => x.includes("max-turns")))!;
  assertStringIncludes(call.args.join(" "), "--max-turns=5");
  assertLeaderOptions(await limitReport(w, job), "turn limit");
  assertStringIncludes(
    (await w.kiln("request", "status", "1")).stdout,
    "stopped at its turns limit",
  );
});

withWorld("an Assignment that spends its budget is stopped", async (w) => {
  const job = await oneAssignment(w, { defaults: { spendUsd: 0.2 } });
  await w.launcher.script(Array(4).fill({ result: "ok", costUsd: 0.25 }));

  const stopped = await waitFor(() => assignmentOf(w, job.id), (a) => a.status === "failed");
  assertEquals([stopped.limitReached, stopped.spendUsd], ["spend", 0.25]);
  const call = (await w.launcher.calls()).find((c) =>
    c.args.some((x) => x.includes("max-budget"))
  )!;
  assertStringIncludes(call.args.join(" "), "--max-budget-usd=0.2");
  assertLeaderOptions(await limitReport(w, job), "spend limit");
});

withWorld("the wall-clock watch stops a worker that is still running", async (w) => {
  const job = await oneAssignment(w, { defaults: { seconds: 3 } });
  await w.launcher.script(Array(3).fill({ result: "ok", hang: true }));

  const stopped = await waitFor(() => assignmentOf(w, job.id), (a) => a.status === "failed");
  assertEquals(stopped.limitReached, "time");
  assertLeaderOptions(await limitReport(w, job), "time limit");
});

withWorld("the inactivity watch stops a worker that shows no sign of life", async (w) => {
  const job = await oneAssignment(w, { defaults: { idleSeconds: 1 } });
  const stopped = await waitFor(() => assignmentOf(w, job.id), (a) => a.status === "failed");
  assertEquals(stopped.limitReached, "inactivity");
  assertLeaderOptions(await limitReport(w, job), "without a sign of life");
});

withWorld("the leader can continue after a limit, up to the Project ceiling", async (w) => {
  const job = await oneAssignment(
    w,
    {
      defaults: { turns: 5 },
      projects: { remote: { ceiling: { turns: 8 } } },
    },
    {},
    Array(4).fill({ result: "ok", turns: 6 }),
  );
  await commit(w, (await assignmentOf(w, job.id)).worktree!, { "notes.md": "half way\n" });
  await waitFor(() => assignmentOf(w, job.id), (a) => a.status === "failed");
  await limitReport(w, job);

  // Asking for more than the ceiling gets the ceiling; the work so far carries over.
  const next = await delegate(w, "diagnostician-1", { maxTurns: 500 });
  const continued = await assignmentOf(w, next.id);
  assertEquals([continued.status, continued.budget?.turns], ["active", 8]);
  assertEquals(await Deno.readTextFile(join(continued.worktree!, "notes.md")), "half way\n");
});

withWorld("a limits file that is not valid is refused when a Request starts", async (w) => {
  await register(w);
  await setLimits(w, { concurrency: { global: 0 } });
  const r = await w.kiln(
    "request",
    "start",
    "remote",
    "--playbook",
    "diagnose-a-bug",
    "--description",
    "x",
  );
  assertEquals(r.code, 1);
  assertStringIncludes(r.stderr, "limits.json");
  assertStringIncludes(r.stderr, "concurrency.global");
});
