// Planning a spec into tickets, driven the way Kiln is used: `kiln request start|status`, the
// agents' tool servers (the test plays the leader and the Ticket Planner), the fake tracker and
// remote, and the fake launcher. The Leader's checks are seen as rejections that go back to the
// leader; the Overseer's approval is seen as tickets in the tracker and news in `kiln chat`.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withWorld, type World } from "./world.ts";
import { asAgent } from "./router_helpers.ts";

const URL_BASE = "https://github.com/acme/remote/issues/";

async function register(world: World) {
  await Deno.writeTextFile(join(world.project.path, "AGENTS.md"), "# How to work here\n");
  await world.git(world.project.path, "add", ".");
  await world.git(world.project.path, "commit", "-m", "Add agent docs");
  await world.git(world.project.path, "push", "origin", "main");
  await world.githubApi.script([{ stdout: "{}\n" }]);
  await world.launcher.script([{
    result: JSON.stringify({ setup: null, test: null, lint: null, build: null }),
  }]);
  const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(r.code, 0, r.stderr);
}

interface Status {
  status: string;
  failure: string | null;
  ticketUrls: string[];
  steps: {
    status: string;
    retries: number;
    failure: string | null;
    assignments: { id: number; worker: string; worktree: string }[];
  }[];
}
const statusOf = async (world: World): Promise<Status> => {
  const r = await world.kiln("request", "status", "1", "--json");
  assertEquals(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};

const criteria = { c1: "Users can export CSV", c2: "Exports are logged" };
const ticket = (key: string, covers: string[], blockedBy: string[] = []) => ({
  key,
  title: `Ticket ${key}`,
  body: `Build ${key}.\n\n- [ ] it works`,
  covers,
  blockedBy,
});
const breakdown = (tickets: unknown[]) => JSON.stringify({ criteria, tickets });

/** Start the request, and return the leader's assignment for the planning step. */
async function startPlan(world: World) {
  await register(world);
  // The user has already talked to the Overseer once, so what follows is news to them.
  await world.launcher.script([{}]);
  assertEquals((await world.kiln("chat")).code, 0);
  const started = await world.kiln(
    "request",
    "start",
    "remote",
    "--playbook",
    "plan-a-spec-into-tickets",
    "--description",
    "Plan the CSV export spec",
    "--tracker-item",
    "#5",
  );
  assertEquals(started.code, 0, started.stderr);
  const [step] = await asAgent(world, "engineering-leader", (a) => a.inbox());
  assertStringIncludes(String(step.body.instructions), "ticket-planner-1");
  return step;
}

/** The planner commits `tickets.json` (under `worker`) and the leader reports the step verified. */
async function plan(world: World, worker: string, stepMessage: number, content: string) {
  const job = await asAgent(
    world,
    "engineering-leader",
    (a) => a.send(worker, "assignment", { title: "Plan", instructions: "Plan it" }),
  );
  const mine = (await statusOf(world)).steps[0].assignments.find((a) => a.id === job.id)!;
  await Deno.writeTextFile(join(mine.worktree, "tickets.json"), content);
  await world.git(mine.worktree, "add", ".");
  await world.git(mine.worktree, "commit", "-m", "Plan the tickets");
  await asAgent(world, worker, async (a) => {
    await a.inbox();
    await a.send("engineering-leader", "result", { status: "done", summary: "Planned" }, job.id);
  });
  await asAgent(world, "engineering-leader", async (a) => {
    await a.inbox();
    await a.send("overseer", "result", { status: "done", summary: "Verified" }, stepMessage);
  });
}

withWorld(
  "a breakdown is published in dependency order, approved by the Overseer, and the user is told",
  async (world) => {
    const step = await startPlan(world);
    await world.tracker.script([
      { stdout: `${URL_BASE}10\n` },
      { stdout: `${URL_BASE}11\n` },
      { stdout: `${URL_BASE}12\n` },
    ]);
    // "c" depends on "b", which depends on "a"; they are listed out of order.
    await plan(
      world,
      "ticket-planner-1",
      step.id,
      breakdown([ticket("c", ["c2"], ["b"]), ticket("b", ["c1"], ["a"]), ticket("a", ["c1"])]),
    );

    const issues = await world.tracker.issues();
    assertEquals(issues.map((i) => i.title), ["Ticket a", "Ticket b", "Ticket c"]);
    assertStringIncludes(issues[1].body, "Blocked by");
    assertStringIncludes(issues[1].body, "- #10");
    assertStringIncludes(issues[2].body, "- #11");
    assertStringIncludes(issues[2].body, "Tracker item: #5");

    // Nothing waits for the user: the Overseer approved it, and the request is done.
    const status = await statusOf(world);
    assertEquals([status.status, status.steps[0].status], ["done", "done"]);
    assertEquals(status.ticketUrls, [10, 11, 12].map((n) => `${URL_BASE}${n}`));
    assertEquals(JSON.parse((await world.kiln("escalations", "--json")).stdout), []);
    const human = await world.kiln("request", "status", "1");
    assertStringIncludes(human.stdout, `${URL_BASE}12`);

    // The user is told afterwards, when they next talk to the Overseer.
    await world.launcher.script([{}]);
    const chat = await world.kiln("chat");
    assertEquals(chat.code, 0, chat.stderr);
    const calls = await world.launcher.calls();
    const args = calls.at(-1)!.args;
    const system = args[args.indexOf("--append-system-prompt") + 1];
    assertStringIncludes(system, "Request 1: the Overseer approved the breakdown");
    assertStringIncludes(system, `${URL_BASE}10`);
  },
);

withWorld(
  "a breakdown that leaves a criterion uncovered is rejected, and nothing is opened",
  async (world) => {
    const step = await startPlan(world);
    await plan(world, "ticket-planner-1", step.id, breakdown([ticket("a", ["c1"])]));

    assertEquals(await world.tracker.issues(), []);
    assertEquals(await world.remote.branches(), ["main"]);
    const [retry] = await asAgent(world, "engineering-leader", (a) => a.inbox());
    assertStringIncludes(String(retry.body.instructions), 'no ticket covers criterion "c2"');
    assertStringIncludes(String(retry.body.instructions), "ticket-planner-1-retry-1");
    const status = await statusOf(world);
    assertEquals([status.status, status.steps[0].status], ["active", "active"]);

    // The fresh planner fixes it and the tickets are opened.
    await world.tracker.script([{ stdout: `${URL_BASE}20\n` }, { stdout: `${URL_BASE}21\n` }]);
    await plan(
      world,
      "ticket-planner-1-retry-1",
      retry.id,
      breakdown([ticket("a", ["c1"]), ticket("b", ["c2"])]),
    );
    assertEquals((await statusOf(world)).status, "done");
    assertEquals((await world.tracker.issues()).length, 2);
  },
);

withWorld("a breakdown whose dependencies form a cycle is rejected", async (world) => {
  const step = await startPlan(world);
  await plan(
    world,
    "ticket-planner-1",
    step.id,
    breakdown([ticket("a", ["c1"], ["b"]), ticket("b", ["c2"], ["a"])]),
  );
  assertEquals(await world.tracker.issues(), []);
  const [retry] = await asAgent(world, "engineering-leader", (a) => a.inbox());
  assertStringIncludes(String(retry.body.instructions), "form a cycle");
  assertStringIncludes(String(retry.body.instructions), "a -> b -> a");
});

withWorld("a breakdown that is not JSON is rejected", async (world) => {
  const step = await startPlan(world);
  await plan(world, "ticket-planner-1", step.id, "# Some tickets\n");
  assertEquals(await world.tracker.issues(), []);
  const [retry] = await asAgent(world, "engineering-leader", (a) => a.inbox());
  assertStringIncludes(String(retry.body.instructions), "not valid JSON");
});

withWorld("a ticket missing from the tracker fails the request, unapproved", async (world) => {
  const step = await startPlan(world);
  await world.tracker.script([{ stdout: `${URL_BASE}30\n` }, { stdout: `${URL_BASE}31\n` }]);
  await world.tracker.scriptViews([{ stdout: '{"state":"OPEN"}\n' }, {
    stderr: "not found",
    exit: 1,
  }]);
  await plan(
    world,
    "ticket-planner-1",
    step.id,
    breakdown([ticket("a", ["c1"]), ticket("b", ["c2"])]),
  );
  const status = await statusOf(world);
  assertEquals(status.status, "failed");
  assertStringIncludes(status.failure!, `${URL_BASE}31 is not in the tracker`);

  await world.launcher.script([{}]);
  const chat = await world.kiln("chat");
  assertEquals(chat.code, 0, chat.stderr);
  const args = (await world.launcher.calls()).at(-1)!.args;
  const system = args[args.indexOf("--append-system-prompt") + 1];
  assertEquals(system.includes("approved the breakdown"), false);
});
