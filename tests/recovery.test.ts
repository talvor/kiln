// Startup reconciliation, crash recovery, infrastructure retries, halt/resume and cancel, driven
// the way Kiln is used: the CLI, the agents' tool servers (the test plays the leader), the fake
// launcher that wakes the workers, and the fake remote. A crash is a SIGKILL of the daemon.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withWorld, type World } from "./world.ts";
import type { LauncherRun } from "./fakes/claude.ts";
import { asAgent, type Message, waitFor } from "./router_helpers.ts";

const COMMANDS = { setup: null, test: null, lint: null, build: null };
const TICK_SECONDS = 0.5;

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

interface Status {
  status: string;
  failure: string | null;
  steps: {
    status: string;
    assignments: {
      id: number;
      status: string;
      branch: string | null;
      worktree: string | null;
    }[];
  }[];
}
async function statusOf(world: World, id = 1): Promise<Status> {
  const r = await world.kiln("request", "status", String(id), "--json");
  assertEquals(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const assignmentOf = async (world: World, id: number) =>
  (await statusOf(world)).steps.flatMap((s) => s.assignments).find((a) => a.id === id)!;

async function daemonStatus(world: World) {
  const r = await world.kiln("daemon", "status", "--json");
  assertEquals(r.code, 0, r.stderr);
  return JSON.parse(r.stdout) as { pid: number; startup: string[]; haltedSince: string | null };
}

/** The daemon dies without a chance to clean up; the next command starts a new one. */
async function crash(world: World) {
  Deno.kill((await daemonStatus(world)).pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 300));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const workerPrompts = async (world: World) =>
  (await world.launcher.prompts()).filter((p) => p.includes("You are a diagnostician"));
const workerWakeups = async (world: World) => (await workerPrompts(world)).length;
const launches = async (world: World) => (await world.launcher.calls()).length;

/** A Request whose first Step's leader has delegated one Assignment to a diagnostician. */
async function oneAssignment(world: World, runs: LauncherRun[], limits: unknown = {}) {
  await Deno.mkdir(world.dirs.config, { recursive: true });
  await Deno.writeTextFile(join(world.dirs.config, "limits.json"), JSON.stringify(limits));
  await register(world);
  await world.launcher.script([{ result: "ready" }]);
  const started = await world.kiln(
    "request",
    "start",
    "remote",
    "--playbook",
    "diagnose-a-bug",
    "--description",
    "Logins fail after midnight",
  );
  assertEquals(started.code, 0, started.stderr);
  await waitFor(
    () => world.launcher.prompts(),
    (prompts) => prompts.some((prompt) => prompt.includes("You are the engineering leader")),
    15_000,
  );
  await asAgent(world, "engineering-leader", (a) => a.inbox());
  await world.launcher.script(runs);
  const job = await asAgent(
    world,
    "engineering-leader",
    (a) =>
      a.send("diagnostician-1", "assignment", {
        title: "Diagnose",
        instructions: "Find the cause",
      }),
  );
  await waitFor(() => workerWakeups(world), (n) => n >= 1, 15_000);
  return job;
}

const inboxOf = (world: World, address: string): Promise<Message[]> =>
  asAgent(world, address, (a) => a.inbox());

withWorld("startup runs its steps in order", async (w) => {
  assertEquals((await w.kiln("daemon", "start")).code, 0);
  const status = await daemonStatus(w);
  assertEquals(status.startup, [
    "store",
    "halt",
    "budgets",
    "interrupted-launches",
    "worktrees",
    "conductor",
    "pages",
    "clocks",
  ]);
});

withWorld("work interrupted by a crash is resumed once, then fails the second time", async (w) => {
  w.env.KILN_TICK_SECONDS = String(TICK_SECONDS);
  const job = await oneAssignment(w, [{ hang: true }, { hang: true }]);
  // The worker is woken and hangs; the daemon dies under it.
  await crash(w);

  // The restart resumes the Assignment: the worker is woken again and told what happened.
  await w.kiln("daemon", "start");
  const prompts = await waitFor(() => workerPrompts(w), (p) => p.length >= 2);
  assertStringIncludes(prompts[1], "Kiln was interrupted");
  assertEquals((await assignmentOf(w, job.id)).status, "active");

  // A second interruption of the same work fails it: the leader is told, and so is the Overseer.
  await crash(w);
  await w.kiln("daemon", "start");
  const failed = await waitFor(() => assignmentOf(w, job.id), (a) => a.status === "failed");
  assertEquals(failed.status, "failed");
  const result = (await inboxOf(w, "engineering-leader")).find((m) =>
    m.kind === "result" && m.inReplyTo === job.id
  )!;
  assertEquals([result.body.status, result.synthesised], ["failed", true]);
  assertStringIncludes(String(result.body.summary), "interrupted twice");
  const report = (await inboxOf(w, "overseer")).find((m) => m.kind === "question")!;
  assertEquals([report.from, report.synthesised], ["engineering-leader", true]);
  assertStringIncludes(String(report.body.question), "diagnostician-1 is stuck");
  await sleep(TICK_SECONDS * 3_000);
  assertEquals(await workerWakeups(w), 2, "the worker is not woken a third time");
});

withWorld(
  "a launcher that keeps failing is retried with backoff, then reported stuck",
  async (w) => {
    w.env.KILN_TICK_SECONDS = String(TICK_SECONDS);
    const job = await oneAssignment(
      w,
      [{ crash: true }, { crash: true }, { crash: true }, { crash: true }],
      { infrastructure: { retries: 2, backoffSeconds: 1 } },
    );

    const failed = await waitFor(() => assignmentOf(w, job.id), (a) => a.status === "failed");
    assertEquals(failed.status, "failed");
    // One try and two retries, each later than the last by the doubled backoff, and no more.
    const workerCalls = async () =>
      (await w.launcher.calls()).filter((c) => c.env?.KILN_AGENT === "diagnostician-1");
    const calls = (await workerCalls()).map((c) => c.at!);
    assertEquals(calls.length, 3);
    assert(calls[1] - calls[0] >= 1_000, `first backoff: ${calls[1] - calls[0]}ms`);
    assert(calls[2] - calls[1] >= 2_000, `second backoff: ${calls[2] - calls[1]}ms`);
    await sleep(TICK_SECONDS * 3_000);
    assertEquals((await workerCalls()).length, 3, "one try and two retries, no more");

    const result = (await inboxOf(w, "engineering-leader")).find((m) =>
      m.kind === "result" && m.inReplyTo === job.id
    )!;
    assertStringIncludes(String(result.body.summary), "Kiln could not wake diagnostician-1");
    const report = (await inboxOf(w, "overseer")).find((m) => m.kind === "question")!;
    assertStringIncludes(String(report.body.question), "diagnostician-1 is stuck");
    const resumed = await w.kiln("resume");
    assertEquals(resumed.code, 0, resumed.stderr);
    assertStringIncludes(resumed.stdout, "tried again");
  },
);

withWorld(
  "halt stops agents and wakes nobody; resume carries on, and a crash does not undo it",
  async (w) => {
    w.env.KILN_TICK_SECONDS = String(TICK_SECONDS);
    const job = await oneAssignment(w, [{ hang: true }, { result: "ok" }]);
    const before = await launches(w);

    const halted = await w.kiln("halt");
    assertEquals(halted.code, 0, halted.stderr);
    assertStringIncludes(halted.stdout, "halted");
    assertEquals((await daemonStatus(w)).haltedSince !== null, true);
    assertEquals(await launches(w), before, "halting starts no model");

    // New work is refused, and the worker stays asleep while Kiln is halted.
    const refused = await w.kiln(
      "request",
      "start",
      "remote",
      "--playbook",
      "diagnose-a-bug",
      "--description",
      "Another bug",
    );
    assertEquals(refused.code, 1);
    assertStringIncludes(refused.stderr, "halted");
    await sleep(TICK_SECONDS * 3_000);
    assertEquals(await launches(w), before);

    // The halt survives a crash: nothing is woken after the restart either.
    await crash(w);
    await w.kiln("daemon", "start");
    assertEquals((await daemonStatus(w)).haltedSince !== null, true);
    await sleep(TICK_SECONDS * 3_000);
    assertEquals(await launches(w), before);
    assertEquals((await assignmentOf(w, job.id)).status, "active");

    // Resumed, the worker is woken for the work the halt cut short.
    const resumed = await w.kiln("resume");
    assertEquals(resumed.code, 0, resumed.stderr);
    assertEquals((await daemonStatus(w)).haltedSince, null);
    await waitFor(() => workerWakeups(w), (n) => n >= 2);
    assertEquals((await assignmentOf(w, job.id)).status, "active");
    assertStringIncludes((await w.kiln("resume")).stdout, "not halted");
  },
);

withWorld("cancel stops a request and keeps its branches and worktrees", async (w) => {
  w.env.KILN_TICK_SECONDS = String(TICK_SECONDS);
  const job = await oneAssignment(w, [{ hang: true }, { result: "ok" }]);
  const worktree = (await assignmentOf(w, job.id)).worktree!;
  await Deno.writeTextFile(join(worktree, "notes.md"), "half way\n");
  await w.git(worktree, "add", ".");
  await w.git(worktree, "commit", "-m", "Work");
  const branches = (await w.git(worktree, "branch", "--list")).stdout;
  const remoteBranches = await w.remote.branches();

  const cancelled = await w.kiln("request", "cancel", "1");
  assertEquals(cancelled.code, 0, cancelled.stderr);
  assertStringIncludes(cancelled.stdout, "kept");
  const status = await statusOf(w);
  assertEquals(status.status, "failed");
  assertStringIncludes(String(status.failure), "Cancelled by the user");
  assertEquals(status.steps[0].status, "failed");
  assertEquals((await assignmentOf(w, job.id)).status, "failed");

  // Nothing was removed: the branches, the worktree and what was committed in it.
  assertEquals((await w.git(worktree, "branch", "--list")).stdout, branches);
  assertEquals(await Deno.readTextFile(join(worktree, "notes.md")), "half way\n");
  for (const branch of remoteBranches) assert((await w.remote.branches()).includes(branch));

  // The worker is not woken again for work the user cancelled.
  await asAgent(
    w,
    "engineering-leader",
    (a) => a.send("diagnostician-1", "assignment", { title: "More", instructions: "More" }),
  );
  await sleep(TICK_SECONDS * 3_000);
  assertEquals(await workerWakeups(w), 1);

  const again = await w.kiln("request", "cancel", "1");
  assertEquals(again.code, 1);
  assertStringIncludes(again.stderr, "already");
});
