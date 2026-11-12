// Spend budgets, the daily cap, the cost report, the daily digest and notifications, driven the
// way Kiln is used: the CLI, the agents' tool servers (the test plays the leader and the workers),
// the fake remote and the fake launcher, whose runs say what each launch cost. Budgets and the
// notification command come from `limits.json` in the config directory.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withWorld, type World } from "./world.ts";
import type { LauncherRun } from "./fakes/claude.ts";
import { asAgent } from "./router_helpers.ts";

const COMMANDS = { setup: null, test: null, lint: null, build: null };
/** Enough room that only the budgets under test hold anything back. */
const ROOMY = { defaults: { spendUsd: 10 }, concurrency: { perProject: 5 } };
const END = "<<end of notification>>";

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

/** Write `limits.json`, with a notification command that appends what it is told to a file. */
async function configure(world: World, limits: Record<string, unknown>, digestAt?: string) {
  await Deno.mkdir(world.dirs.config, { recursive: true });
  const file = join(world.root, "notifications.txt");
  const command = `{ cat; echo '${END}'; } >> '${file}'`;
  await Deno.writeTextFile(
    join(world.dirs.config, "limits.json"),
    JSON.stringify({ ...limits, notify: { command, ...(digestAt ? { digestAt } : {}) } }),
  );
}

/** What the notification command was told, in order. */
async function notifications(world: World): Promise<string[]> {
  try {
    return (await Deno.readTextFile(join(world.root, "notifications.txt")))
      .split(`${END}\n`).filter((n) => n.trim());
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
}

interface Status {
  status: string;
  failure: string | null;
  costUsd: number;
  budgetUsd: number | null;
}
async function statusOf(world: World, id = 1): Promise<Status> {
  const r = await world.kiln("request", "status", String(id), "--json");
  assertEquals(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

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

const delegate = (world: World, worker: string, body: Record<string, unknown> = {}) =>
  asAgent(
    world,
    "engineering-leader",
    (a) => a.send(worker, "assignment", { title: "Do part", instructions: "Do it", ...body }),
  );

async function waitFor<T>(read: () => Promise<T>, ready: (v: T) => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for public evidence");
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const workerWakeups = async (world: World) =>
  (await world.launcher.prompts()).filter((p) => p.includes("You are a diagnostician")).length;

/** A Request whose first Step has one Assignment; the next launches are scripted by `runs`. */
async function oneAssignment(
  world: World,
  limits: Record<string, unknown>,
  runs: LauncherRun[],
  digestAt?: string,
) {
  await configure(world, limits, digestAt);
  await register(world);
  await start(world);
  await asAgent(world, "engineering-leader", (a) => a.inbox());
  const job = await delegate(world, "diagnostician-1");
  await world.launcher.script(runs);
  return job;
}

const escalations = async (world: World) => (await world.kiln("escalations")).stdout;

withWorld(
  "a Request nearing its budget warns once, and its cost shows in `kiln cost`",
  async (w) => {
    await oneAssignment(w, { defaults: { spendUsd: 10 }, budgets: { requestUsd: 1 } }, [
      { result: "ok", costUsd: 0.85 },
      { result: "ok", costUsd: 0.01 },
    ]);

    const [warning] = await waitFor(() => notifications(w), (n) => n.length >= 1);
    for (const text of ["Request 1", "80%", "$0.85", "$1.00"]) assertStringIncludes(warning, text);
    // Under the budget: nothing is held back.
    assert(!(await escalations(w)).includes("blocked on you"));
    const status = await statusOf(w);
    assertEquals([status.costUsd, status.budgetUsd], [0.85, 1]);

    const cost = await w.kiln("cost");
    assertEquals(cost.code, 0, cost.stderr);
    for (const text of ["$0.85", "remote", "Request 1"]) assertStringIncludes(cost.stdout, text);
    const json = JSON.parse((await w.kiln("cost", "--json")).stdout);
    assertEquals(json.todayUsd, 0.85);
    assertEquals(json.projects, [{ name: "remote", usd: 0.85 }]);
    assertEquals(json.requests.map((r: { id: number }) => r.id), [1]);

    // One warning per Request and budget, however many launches follow.
    await delegate(w, "diagnostician-1");
    await waitFor(() => workerWakeups(w), (n) => n >= 2);
    await pause(2_500);
    assertEquals((await notifications(w)).length, 1);
  },
);

withWorld("a Request over its budget is blocked on the user until they decide", async (w) => {
  const job = await oneAssignment(w, { defaults: { spendUsd: 10 }, budgets: { requestUsd: 1 } }, [
    { result: "ok", costUsd: 1.2 },
    { result: "ok", costUsd: 0.1 },
  ]);
  assert(job.id);

  await waitFor(() => escalations(w), (text) => text.includes("blocked on you"));
  const open = await escalations(w);
  assertStringIncludes(open, "Request 1 is blocked on you");
  assertStringIncludes(open, "budget");
  assertStringIncludes(open, "$1.20");
  const told = (await notifications(w)).join("\n");
  assertStringIncludes(told, "blocked");

  // Nobody is woken for the Request while it waits for the user.
  await delegate(w, "diagnostician-1");
  await pause(3_000);
  assertEquals(await workerWakeups(w), 1);

  // Approving gives it another budget's worth, and the work carries on.
  assertEquals((await w.kiln("approve", "1")).code, 0);
  await waitFor(() => workerWakeups(w), (n) => n >= 2);
  const status = await statusOf(w);
  assertEquals([status.status, status.budgetUsd], ["active", 2.2]);
});

withWorld("a user who rejects the budget ends the Request with their reason", async (w) => {
  await oneAssignment(w, { defaults: { spendUsd: 10 }, budgets: { requestUsd: 1 } }, [
    { result: "ok", costUsd: 1.2 },
  ]);
  await waitFor(() => escalations(w), (text) => text.includes("blocked on you"));

  const r = await w.kiln("reject", "1", "--reason", "too expensive for a flaky test");
  assertEquals(r.code, 0, r.stderr);
  const status = await waitFor(() => statusOf(w), (s) => s.status === "failed");
  assertStringIncludes(status.failure!, "too expensive for a flaky test");
  assertStringIncludes(status.failure!, "budget");
});

withWorld("a Project's own budget overrides the one for every Request", async (w) => {
  await oneAssignment(w, {
    defaults: { spendUsd: 10 },
    budgets: { requestUsd: 100 },
    projects: { remote: { requestUsd: 0.5 } },
  }, [{ result: "ok", costUsd: 0.6 }]);
  await waitFor(() => escalations(w), (text) => text.includes("blocked on you"));
  assertEquals((await statusOf(w)).budgetUsd, 0.5);
});

withWorld("the daily cap warns at 80% and stops all work at 100% until it is lifted", async (w) => {
  await oneAssignment(w, { ...ROOMY, budgets: { dailyUsd: 1 } }, [
    { result: "ok", costUsd: 0.85 },
    { result: "ok", costUsd: 0.3 },
    { result: "ok", costUsd: 0.1 },
  ]);

  const warned = await waitFor(() => notifications(w), (n) => n.length >= 1);
  for (const text of ["80%", "daily", "$0.85", "$1.00"]) assertStringIncludes(warned[0], text);
  assertStringIncludes((await w.kiln("cost")).stdout, "$1.00");

  // Still under the cap: the next worker is woken, and its launch takes the day over the cap.
  await delegate(w, "diagnostician-1");
  await waitFor(() => workerWakeups(w), (n) => n >= 2);
  const reached = await waitFor(() => notifications(w), (n) => n.length >= 2);
  assertStringIncludes(reached[1], "daily cap");
  assertStringIncludes(reached[1], "reached");
  const cost = JSON.parse((await w.kiln("cost", "--json")).stdout);
  assertEquals([cost.todayUsd, cost.capUsd, cost.capReached], [1.15, 1, true]);
  assertStringIncludes((await w.kiln("cost")).stdout, "cap reached");

  // Over the cap nobody is woken, however much work waits.
  await delegate(w, "diagnostician-1");
  await pause(3_000);
  assertEquals(await workerWakeups(w), 2);

  // Raising the cap lifts it: Kiln reads the limits again and the waiting work carries on.
  await configure(w, { ...ROOMY, budgets: { dailyUsd: 10 } });
  await waitFor(() => workerWakeups(w), (n) => n >= 3);
  assertEquals(JSON.parse((await w.kiln("cost", "--json")).stdout).capReached, false);
});

withWorld("`kiln cost` with no spend says so", async (w) => {
  await configure(w, { budgets: { dailyUsd: 5 } });
  const r = await w.kiln("cost");
  assertEquals(r.code, 0, r.stderr);
  assertStringIncludes(r.stdout, "$0.00");
  const json = JSON.parse((await w.kiln("cost", "--json")).stdout);
  assertEquals([json.todayUsd, json.capUsd, json.projects, json.requests], [0, 5, [], []]);
});

/** Run one Step of Request 1: the leader delegates, the worker commits a file, both report. */
async function runStep(world: World, worker: string, file: string, text: string) {
  const [step] = await asAgent(world, "engineering-leader", (a) => a.inbox());
  const launched = (await world.launcher.calls()).length;
  const job = await delegate(world, worker);
  // The worker is woken (and charged) before it reads its inbox.
  await waitFor(() => world.launcher.calls(), (c) => c.length > launched);
  const mine = JSON.parse((await world.kiln("request", "status", "1", "--json")).stdout)
    .steps.flatMap((s: { assignments: { id: number; worktree: string }[] }) => s.assignments)
    .find((a: { id: number }) => a.id === job.id);
  await Deno.writeTextFile(join(mine.worktree, file), text);
  await world.git(mine.worktree, "add", ".");
  await world.git(mine.worktree, "commit", "-m", `Write ${file}`);
  await asAgent(world, worker, async (a) => {
    await a.inbox();
    await a.send("engineering-leader", "result", { status: "done", summary: "Done" }, job.id);
  });
  await asAgent(world, "engineering-leader", async (a) => {
    await a.inbox();
    await a.send("overseer", "result", { status: "done", summary: "Verified" }, step.id);
  });
}

/** A diagnosis that runs to the end, every launch costing something. */
async function finishedRequest(world: World, digestAt?: string) {
  await configure(world, { defaults: { spendUsd: 10 } }, digestAt);
  await register(world);
  await world.tracker.script([{ stdout: "https://github.com/acme/remote/issues/7\n" }]);
  await start(world);
  await world.launcher.script(Array(30).fill({ result: "ok", costUsd: 0.1 }));
  await runStep(world, "diagnostician-1", "diagnosis.md", "# Diagnosis\nMidnight UTC.\n");
  await runStep(world, "ticket-planner-2", "ticket.md", "# Fix midnight expiry\n\n- [ ] Works\n");
  return await waitFor(() => statusOf(world), (s) => s.status === "done");
}

withWorld("a finished Request shows what it cost", async (w) => {
  const done = await finishedRequest(w);
  assert(done.costUsd > 0, "the launches were charged to the Request");
  const text = (await w.kiln("request", "status", "1")).stdout;
  assertStringIncludes(text, `Cost: $${done.costUsd.toFixed(2)}`);
  const cost = JSON.parse((await w.kiln("cost", "--json")).stdout);
  const reportedUsd = Math.round(done.costUsd * 1e6) / 1e6;
  assertEquals(cost.requests[0].usd, reportedUsd);
  assertEquals(cost.todayUsd, reportedUsd);
});

withWorld("the daily digest is sent once a day, and only when there is news", async (w) => {
  // Nothing has happened: the digest is due and nothing is said.
  await configure(w, {}, "00:00");
  assertEquals((await w.kiln("cost")).code, 0); // starts the daemon
  await pause(3_000);
  assertEquals(await notifications(w), []);
});

withWorld("the daily digest tells what happened since the last one, once", async (w) => {
  const done = await finishedRequest(w, "23:59");
  // Not due yet: a Request finished, and nobody is told.
  await pause(2_500);
  assertEquals(await notifications(w), []);

  await configure(w, { defaults: { spendUsd: 10 } }, "00:00");
  const [digest] = await waitFor(() => notifications(w), (n) => n.length >= 1);
  assertStringIncludes(digest, "digest");
  assertStringIncludes(digest, "Request 1 finished");
  assertStringIncludes(digest, `$${done.costUsd.toFixed(2)}`);
  // A Notification never links to the Dashboard: its token is the dashboard process's alone.
  assert(!/https?:\/\/|127\.0\.0\.1|dashboard/i.test(digest), `a link in: ${digest}`);
  await pause(3_000);
  assertEquals((await notifications(w)).length, 1);
});

withWorld(
  "attaching tells the Overseer the budget news, once, and is silent otherwise",
  async (w) => {
    await configure(w, { defaults: { spendUsd: 10 }, budgets: { requestUsd: 1 } });
    await register(w);
    await w.launcher.script([{}]);
    assertEquals((await w.kiln("chat")).code, 0); // the user has attached before
    await start(w);
    await asAgent(w, "engineering-leader", (a) => a.inbox());
    await w.launcher.script([{ result: "ok", costUsd: 0.85 }]); // before the worker can be woken
    await delegate(w, "diagnostician-1");
    await waitFor(() => notifications(w), (n) => n.length >= 1);

    await w.launcher.script([{}]);
    assertEquals((await w.kiln("chat")).code, 0);
    const calls = await w.launcher.calls();
    const first = calls.at(-1)!.args;
    assertStringIncludes(first[0], "has just opened the chat");
    const system = first[first.indexOf("--append-system-prompt") + 1];
    assertStringIncludes(system, "Request 1 has used 80%");
    assertStringIncludes(system, "$0.85");

    // Told once: the next time the user attaches there is nothing new to say.
    await w.launcher.script([{}]);
    assertEquals((await w.kiln("chat")).code, 0);
    const second = (await w.launcher.calls()).at(-1)!.args;
    assert(!second[0].includes("has just opened the chat"));
    assert(!second[second.indexOf("--append-system-prompt") + 1].includes("used 80%"));
  },
);

withWorld("a notification command that fails does not stop the work", async (w) => {
  await Deno.mkdir(w.dirs.config, { recursive: true });
  await Deno.writeTextFile(
    join(w.dirs.config, "limits.json"),
    JSON.stringify({
      defaults: { spendUsd: 10 },
      budgets: { requestUsd: 1 },
      notify: { command: "exit 3" },
    }),
  );
  await register(w);
  await start(w);
  await asAgent(w, "engineering-leader", (a) => a.inbox());
  await delegate(w, "diagnostician-1");
  await w.launcher.script([{ result: "ok", costUsd: 1.5 }]);
  // The Request is blocked all the same.
  await waitFor(() => escalations(w), (text) => text.includes("blocked on you"));
});

withWorld("a limits file with an invalid budget is refused, naming the field", async (w) => {
  await register(w);
  await Deno.mkdir(w.dirs.config, { recursive: true });
  await Deno.writeTextFile(
    join(w.dirs.config, "limits.json"),
    JSON.stringify({ budgets: { dailyUsd: -1 } }),
  );
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
  assertStringIncludes(r.stderr, "budgets.dailyUsd");
});
