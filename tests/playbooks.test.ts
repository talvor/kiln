// Requests that follow a Playbook, driven the way Kiln is used: `kiln request start|status`, the
// agents' tool servers (the test plays the leader and the workers), the fake remote and the fake
// launcher. Kiln itself plays the overseer, the coordinator that walks the Playbook.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withWorld, type World } from "./world.ts";
import { asAgent } from "./router_helpers.ts";

const COMMANDS: Record<string, string | null> = {
  setup: null,
  test: null,
  lint: null,
  build: null,
};
const TICKET_URL = "https://github.com/acme/remote/issues/7";

async function register(world: World, commands = COMMANDS) {
  await Deno.writeTextFile(join(world.project.path, "AGENTS.md"), "# How to work here\n");
  await world.git(world.project.path, "add", ".");
  await world.git(world.project.path, "commit", "-m", "Add agent docs");
  await world.git(world.project.path, "push", "origin", "main");
  await world.githubApi.script([{ stdout: "{}\n" }]);
  await world.launcher.script([{ result: JSON.stringify(commands) }]);
  const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(r.code, 0, r.stderr);
}

interface Status {
  id: number;
  project: string;
  status: string;
  playbook: string;
  description: string;
  trackerItem: string | null;
  branch: string;
  ticketUrl: string | null;
  failure: string | null;
  steps: {
    position: number;
    name: string;
    department: string;
    status: string;
    retries: number;
    failure: string | null;
    assignments: {
      id: number;
      worker: string;
      status: string;
      branch: string;
      worktree: string;
      merged: boolean;
    }[];
  }[];
}

async function statusOf(world: World, id = 1): Promise<Status> {
  const r = await world.kiln("request", "status", String(id), "--json");
  assertEquals(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

async function start(world: World, ...flags: string[]) {
  return await world.kiln("request", "start", "remote", ...flags);
}

/** The worker's job: put a file in its worktree and commit it. */
async function commitFile(world: World, worktree: string, file: string, content: string) {
  await Deno.writeTextFile(join(worktree, file), content);
  await world.git(worktree, "add", ".");
  await world.git(worktree, "commit", "-m", `Write ${file}`);
}

/** Leader hands the open step to its worker, the worker works and reports, the leader reports. */
async function runStep(
  world: World,
  opts: { worker: string; stepMessage: number; file: string; content: string },
) {
  const job = await asAgent(
    world,
    "engineering-leader",
    (agent) =>
      agent.send(opts.worker, "assignment", { title: "Do the step", instructions: "Do it" }),
  );
  const open = (await statusOf(world)).steps.flatMap((s) => s.assignments).find((a) =>
    a.id === job.id
  )!;
  await commitFile(world, open.worktree, opts.file, opts.content);
  await asAgent(world, opts.worker, async (agent) => {
    await agent.inbox();
    await agent.send("engineering-leader", "result", { status: "done", summary: "Done" }, job.id);
  });
  await asAgent(world, "engineering-leader", async (agent) => {
    await agent.inbox();
    await agent.send(
      "overseer",
      "result",
      { status: "done", summary: "Verified" },
      opts.stepMessage,
    );
  });
  return job;
}

const remoteFile = async (world: World, branch: string, file: string) =>
  await world.exec(world.remote.path, "git", "show", `${branch}:${file}`);

withWorld("a diagnose-a-bug request runs through to a published fix ticket", async (world) => {
  await register(world);
  await world.tracker.script([{ stdout: `${TICKET_URL}\n` }]);

  const started = await start(
    world,
    "--playbook",
    "diagnose-a-bug",
    "--description",
    "Logins fail after midnight",
    "--tracker-item",
    "#12",
  );
  assertEquals(started.code, 0, started.stderr);
  assertStringIncludes(started.stdout, "Started request 1 on remote");

  // The overseer hands the first step to the engineering leader.
  let status = await statusOf(world);
  assertEquals([status.status, status.playbook, status.branch], [
    "active",
    "diagnose-a-bug",
    "kiln/request-1",
  ]);
  assertEquals(status.trackerItem, "#12");
  assertEquals(status.steps.map((s) => [s.name, s.department, s.status]), [
    ["diagnose", "engineering", "active"],
    ["plan-fix-ticket", "engineering", "planned"],
  ]);
  const [diagnoseStep] = await asAgent(world, "engineering-leader", (agent) => agent.inbox());
  assertEquals([diagnoseStep.from, diagnoseStep.kind], ["overseer", "assignment"]);
  const instructions = String(diagnoseStep.body.instructions);
  assertStringIncludes(instructions, "Logins fail after midnight");
  assertStringIncludes(instructions, "#12");
  assertStringIncludes(instructions, "diagnostician-1");
  assertStringIncludes(instructions, "diagnosis.md");

  // The leader delegates to the diagnostician: the Assignment gets its own branch and worktree.
  const job = await runStep(world, {
    worker: "diagnostician-1",
    stepMessage: diagnoseStep.id,
    file: "diagnosis.md",
    content: "# Diagnosis\nThe session expires at midnight UTC.\n",
  });
  status = await statusOf(world);
  assertEquals(status.steps.map((s) => s.status), ["done", "active"]);
  const [assignment] = status.steps[0].assignments;
  assertEquals(
    [assignment.id, assignment.worker, assignment.status, assignment.merged],
    [job.id, "diagnostician-1", "done", true],
  );
  assertEquals(assignment.branch, `kiln/request-1-assignment-${job.id}`);

  // The verified diagnosis reached the request branch on the remote, and the next step began.
  assertEquals(
    (await remoteFile(world, "kiln/request-1", "diagnosis.md")).stdout,
    "# Diagnosis\nThe session expires at midnight UTC.\n",
  );
  assertEquals(await world.tracker.issues(), []);
  const [planStep] = await asAgent(world, "engineering-leader", (agent) => agent.inbox());
  assertEquals([planStep.from, planStep.kind], ["overseer", "assignment"]);
  assertStringIncludes(String(planStep.body.instructions), "ticket-planner-2");

  // The ticket planner starts from the request branch, so it can read the diagnosis.
  const planJob = await asAgent(
    world,
    "engineering-leader",
    (agent) =>
      agent.send("ticket-planner-2", "assignment", { title: "Plan", instructions: "Plan it" }),
  );
  const planner = (await statusOf(world)).steps[1].assignments[0];
  assertEquals(planner.id, planJob.id);
  assertStringIncludes(
    await Deno.readTextFile(join(planner.worktree, "diagnosis.md")),
    "midnight UTC",
  );
  await commitFile(
    world,
    planner.worktree,
    "ticket.md",
    "# Expire sessions at local midnight\nUse the user's timezone.\n\n- [ ] Logins work at 00:01\n",
  );
  await asAgent(world, "ticket-planner-2", async (agent) => {
    await agent.inbox();
    await agent.send(
      "engineering-leader",
      "result",
      { status: "done", summary: "Planned" },
      planJob.id,
    );
  });
  await asAgent(world, "engineering-leader", async (agent) => {
    await agent.inbox();
    await agent.send("overseer", "result", { status: "done", summary: "Verified" }, planStep.id);
  });

  // Kiln published the planner's ticket and the request is done.
  const [ticket] = await world.tracker.issues();
  assertEquals(ticket.title, "Expire sessions at local midnight");
  assertStringIncludes(ticket.body, "Logins work at 00:01");
  assertStringIncludes(ticket.body, "#12");
  assertEquals(await world.tracker.issues().then((i) => i.length), 1);
  status = await statusOf(world);
  assertEquals([status.status, status.ticketUrl], ["done", TICKET_URL]);
  assertEquals(status.steps.map((s) => s.status), ["done", "done"]);
  const human = await world.kiln("request", "status", "1");
  assertStringIncludes(human.stdout, "done");
  assertStringIncludes(human.stdout, TICKET_URL);
  assertEquals(await world.remote.branches(), ["kiln/request-1", "main"]);
});

withWorld("a tracker item is optional", async (world) => {
  await register(world);
  await world.tracker.script([{ stdout: `${TICKET_URL}\n` }]);
  const started = await start(
    world,
    "--playbook",
    "diagnose-a-bug",
    "--description",
    "Exports time out on large accounts",
  );
  assertEquals(started.code, 0, started.stderr);
  const status = await statusOf(world);
  assertEquals([status.trackerItem, status.status], [null, "active"]);
  const [step] = await asAgent(world, "engineering-leader", (agent) => agent.inbox());
  assert(!String(step.body.instructions).includes("Tracker item"));
  await runStep(world, {
    worker: "diagnostician-1",
    stepMessage: step.id,
    file: "diagnosis.md",
    content: "slow query\n",
  });
  const [planStep] = await asAgent(world, "engineering-leader", (agent) => agent.inbox());
  await runStep(world, {
    worker: "ticket-planner-2",
    stepMessage: planStep.id,
    file: "ticket.md",
    content: "# Index the exports query\nAdd an index.\n",
  });
  const [ticket] = await world.tracker.issues();
  assertEquals(ticket.title, "Index the exports query");
  assert(!ticket.body.includes("Tracker item"));
  assertEquals((await statusOf(world)).status, "done");
});

withWorld("roles and playbooks load from config files", async (world) => {
  await register(world);
  await Deno.mkdir(join(world.dirs.config, "roles"), { recursive: true });
  await Deno.mkdir(join(world.dirs.config, "playbooks"), { recursive: true });
  await Deno.writeTextFile(
    join(world.dirs.config, "roles", "engineering-leader.json"),
    JSON.stringify({ kind: "leader", department: "engineering", prompt: "You are a strict lead." }),
  );
  await Deno.writeTextFile(
    join(world.dirs.config, "roles", "profiler.json"),
    JSON.stringify({ kind: "worker", department: "engineering", prompt: "You profile code." }),
  );
  await Deno.writeTextFile(
    join(world.dirs.config, "playbooks", "profile-it.json"),
    JSON.stringify({
      description: "Profile a slow path",
      steps: [{
        name: "profile",
        department: "engineering",
        worker: "profiler",
        instructions: "Profile the slow path described in the request.",
        artifact: "profile.md",
      }],
    }),
  );

  const started = await start(world, "--playbook", "profile-it", "--description", "Slow search");
  assertEquals(started.code, 0, started.stderr);
  let status = await statusOf(world);
  assertEquals(status.playbook, "profile-it");
  assertEquals(status.steps.map((s) => [s.name, s.status]), [["profile", "active"]]);
  const [step] = await asAgent(world, "engineering-leader", (agent) => agent.inbox());
  assertStringIncludes(String(step.body.instructions), "Profile the slow path");
  assertStringIncludes(String(step.body.instructions), "profiler-1");

  // The role file's prompt is what wakes the worker.
  await world.launcher.script([{ result: "ok" }]);
  await asAgent(
    world,
    "engineering-leader",
    (agent) => agent.send("profiler-1", "assignment", { title: "Profile", instructions: "Go" }),
  );
  const prompts = await waitFor(
    () => world.launcher.prompts(),
    (items) => items.some((p) => p.includes("You profile code.")),
  );
  assertStringIncludes(prompts.at(-1)!, "unread message");

  // It is woken in its own Assignment's worktree, with that worktree's environment.
  const profiler = (await statusOf(world)).steps[0].assignments[0];
  const woken = (await world.launcher.calls()).at(-1)!;
  assertEquals(woken.cwd, await Deno.realPath(profiler.worktree));
  assert(woken.env?.KILN_PORT_BASE);

  // The last step of this playbook publishes nothing: finishing it finishes the request.
  await commitFile(world, profiler.worktree, "profile.md", "hot loop in search()\n");
  await asAgent(world, "profiler-1", async (agent) => {
    await agent.inbox();
    await agent.send(
      "engineering-leader",
      "result",
      { status: "done", summary: "Profiled" },
      profiler.id,
    );
  });
  await asAgent(
    world,
    "engineering-leader",
    (agent) => agent.send("overseer", "result", { status: "done", summary: "Verified" }, step.id),
  );
  status = await statusOf(world);
  assertEquals([status.status, status.ticketUrl], ["done", null]);
  assertEquals(await world.tracker.issues(), []);
});

withWorld("a request refuses an unknown or broken playbook", async (world) => {
  await register(world);
  const unknown = await start(world, "--playbook", "nope", "--description", "x");
  assertEquals(unknown.code, 1);
  assertStringIncludes(unknown.stderr, 'No playbook named "nope"');
  assertStringIncludes(unknown.stderr, "diagnose-a-bug");

  await Deno.mkdir(join(world.dirs.config, "playbooks"), { recursive: true });
  await Deno.writeTextFile(
    join(world.dirs.config, "playbooks", "broken.json"),
    JSON.stringify({
      description: "Broken",
      steps: [{
        name: "x",
        department: "engineering",
        worker: "ghost",
        instructions: "Go",
        artifact: "x.md",
      }],
    }),
  );
  const broken = await start(world, "--playbook", "broken", "--description", "x");
  assertEquals(broken.code, 1);
  assertStringIncludes(broken.stderr, "broken.json");
  assertStringIncludes(broken.stderr, "ghost");

  const missing = await start(world, "--playbook", "diagnose-a-bug");
  assertEquals(missing.code, 2);
  assertStringIncludes(missing.stderr, "Usage");

  // The refusals started nothing, and a broken file does not stop other playbooks.
  assertEquals((await world.kiln("request", "status", "1")).code, 1);
  const fine = await start(world, "--playbook", "diagnose-a-bug", "--description", "x");
  assertEquals(fine.code, 0, fine.stderr);
  assertEquals((await statusOf(world)).id, 1);
});

withWorld("a leader reporting failure fails the step and the request", async (world) => {
  await register(world);
  await start(world, "--playbook", "diagnose-a-bug", "--description", "Flaky login");
  const [step] = await asAgent(world, "engineering-leader", (agent) => agent.inbox());
  await asAgent(
    world,
    "engineering-leader",
    (agent) =>
      agent.send("overseer", "result", { status: "failed", summary: "Cannot reproduce" }, step.id),
  );
  const status = await statusOf(world);
  assertEquals(status.status, "failed");
  assertEquals(status.steps.map((s) => s.status), ["failed", "planned"]);
  assertStringIncludes(status.failure ?? "", "Cannot reproduce");
  assertEquals(await world.tracker.issues(), []);
});

/** The worker reports done, then the leader reports the step verified. */
async function report(world: World, worker: string, jobId: number, stepMessage: number) {
  await asAgent(world, worker, async (agent) => {
    await agent.inbox();
    await agent.send("engineering-leader", "result", { status: "done", summary: "Done" }, jobId);
  });
  await asAgent(world, "engineering-leader", async (agent) => {
    await agent.inbox();
    await agent.send("overseer", "result", { status: "done", summary: "Verified" }, stepMessage);
  });
}

/** The leader delegates the open step to `worker`; returns the job and its worktree. */
async function delegate(world: World, worker: string) {
  const job = await asAgent(
    world,
    "engineering-leader",
    (agent) => agent.send(worker, "assignment", { title: "Do the step", instructions: "Do it" }),
  );
  const all = (await statusOf(world)).steps.flatMap((s) => s.assignments);
  return { job, worktree: all.find((a) => a.id === job.id)!.worktree };
}

withWorld(
  "work missing its artifact is rejected, and a fresh worker retries from the failed branch",
  async (world) => {
    await register(world);
    await start(world, "--playbook", "diagnose-a-bug", "--description", "Flaky login");
    const [step] = await asAgent(world, "engineering-leader", (agent) => agent.inbox());
    const first = await delegate(world, "diagnostician-1");
    await commitFile(world, first.worktree, "notes.md", "wrong file\n");
    await report(world, "diagnostician-1", first.job.id, step.id);

    // Nothing was merged; the step went back to the leader with the feedback.
    let status = await statusOf(world);
    assertEquals([status.status, status.steps[0].status], ["active", "active"]);
    assertEquals(await world.remote.branches(), ["main"]);
    const [retry] = await asAgent(world, "engineering-leader", (agent) => agent.inbox());
    assertEquals([retry.from, retry.kind], ["overseer", "assignment"]);
    const text = String(retry.body.instructions);
    assertStringIncludes(text, "diagnosis.md");
    assertStringIncludes(text, "diagnostician-1-retry-1");
    assertStringIncludes(text, `kiln/request-1-assignment-${first.job.id}`);

    // The fresh worker's worktree starts from the failed branch.
    const second = await delegate(world, "diagnostician-1-retry-1");
    assertStringIncludes(await Deno.readTextFile(join(second.worktree, "notes.md")), "wrong file");
    await commitFile(world, second.worktree, "diagnosis.md", "the real cause\n");
    await report(world, "diagnostician-1-retry-1", second.job.id, retry.id);

    status = await statusOf(world);
    assertEquals(status.steps.map((s) => s.status), ["done", "active"]);
    assertEquals(status.steps[0].retries, 1);
    assertEquals(status.steps[0].assignments.map((a) => [a.worker, a.status, a.merged]), [
      ["diagnostician-1", "failed", false],
      ["diagnostician-1-retry-1", "done", true],
    ]);
    assertEquals(
      (await remoteFile(world, "kiln/request-1", "diagnosis.md")).stdout,
      "the real cause\n",
    );
  },
);

withWorld(
  "checks are re-run against the baseline and failures go back as feedback",
  async (world) => {
    await register(world, { setup: null, test: "! test -e broken.flag", lint: null, build: null });
    await start(world, "--playbook", "diagnose-a-bug", "--description", "Flaky login");
    const [step] = await asAgent(world, "engineering-leader", (agent) => agent.inbox());
    const first = await delegate(world, "diagnostician-1");
    await Deno.writeTextFile(join(first.worktree, "broken.flag"), "x");
    await commitFile(world, first.worktree, "diagnosis.md", "cause\n");
    await report(world, "diagnostician-1", first.job.id, step.id);

    const [retry] = await asAgent(world, "engineering-leader", (agent) => agent.inbox());
    assertStringIncludes(String(retry.body.instructions), "test check failed");
    assertStringIncludes(String(retry.body.instructions), "baseline passed");
    assertEquals(await world.remote.branches(), ["main"]);

    const second = await delegate(world, "diagnostician-1-retry-1");
    await world.git(second.worktree, "rm", "broken.flag");
    await world.git(second.worktree, "commit", "-m", "Remove the breakage");
    await report(world, "diagnostician-1-retry-1", second.job.id, retry.id);
    const status = await statusOf(world);
    assertEquals([status.status, status.steps[0].status], ["active", "done"]);
  },
);

withWorld("after two retries a rejected step goes up to the Overseer", async (world) => {
  await register(world);
  await start(world, "--playbook", "diagnose-a-bug", "--description", "Flaky login");
  let [step] = await asAgent(world, "engineering-leader", (agent) => agent.inbox());
  for (const worker of ["diagnostician-1", "diagnostician-1-retry-1", "diagnostician-1-retry-2"]) {
    const job = await delegate(world, worker);
    await commitFile(world, job.worktree, `${worker}.md`, "wrong file\n");
    await report(world, worker, job.job.id, step.id);
    if (worker.endsWith("2")) break;
    [step] = await asAgent(world, "engineering-leader", (agent) => agent.inbox());
  }
  const status = await statusOf(world);
  assertEquals([status.status, status.steps[0].status], ["failed", "failed"]);
  assertEquals(status.steps[0].retries, 2);
  assertStringIncludes(status.failure ?? "", "Overseer");
  assertStringIncludes(status.failure ?? "", "diagnosis.md");
  assertEquals(status.steps.map((s) => s.status), ["failed", "planned"]);
  assertEquals(await world.remote.branches(), ["main"]);
});

withWorld("a ticket that cannot be published fails the request", async (world) => {
  await register(world);
  await world.tracker.script([{ exit: 1, stderr: "gh: not logged in\n" }]);
  await start(world, "--playbook", "diagnose-a-bug", "--description", "Flaky login");
  const [diagnose] = await asAgent(world, "engineering-leader", (agent) => agent.inbox());
  await runStep(world, {
    worker: "diagnostician-1",
    stepMessage: diagnose.id,
    file: "diagnosis.md",
    content: "cause\n",
  });
  const [plan] = await asAgent(world, "engineering-leader", (agent) => agent.inbox());
  await runStep(world, {
    worker: "ticket-planner-2",
    stepMessage: plan.id,
    file: "ticket.md",
    content: "# Fix it\nDo.\n",
  });
  const status = await statusOf(world);
  assertEquals([status.status, status.ticketUrl], ["failed", null]);
  assertStringIncludes(status.failure ?? "", "not logged in");
});

async function waitFor<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for public evidence");
}
