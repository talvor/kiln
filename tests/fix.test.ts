// "And fix it": a diagnosis whose fix ticket is published is followed by a fix Request that
// implements that ticket. Driven the way Kiln is used: `kiln request start|status`, the agents'
// tool servers (the test plays the leader and the workers), the fake tracker, remote and launcher.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withWorld, type World } from "./world.ts";
import { asAgent } from "./router_helpers.ts";

const TICKET_URL = "https://github.com/acme/remote/issues/7";

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
  playbook: string;
  description: string;
  trackerItem: string | null;
  fixRequestId: number | null;
  steps: { status: string; assignments: { id: number; worktree: string }[] }[];
}
const statusOf = async (world: World, id: number): Promise<Status> => {
  const r = await world.kiln("request", "status", String(id), "--json");
  assertEquals(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};

/** Run one step of request 1: the leader delegates, the worker commits a file, both report. */
async function runStep(
  world: World,
  worker: string,
  stepIndex: number,
  file: string,
  text: string,
) {
  const [step] = await asAgent(world, "engineering-leader", (a) => a.inbox());
  const job = await asAgent(
    world,
    "engineering-leader",
    (a) => a.send(worker, "assignment", { title: "Step", instructions: "Do it" }),
  );
  const mine = (await statusOf(world, 1)).steps[stepIndex].assignments.find((a) =>
    a.id === job.id
  )!;
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

async function diagnose(world: World) {
  await runStep(world, "diagnostician-1", 0, "diagnosis.md", "# Diagnosis\nMidnight UTC.\n");
  await runStep(
    world,
    "ticket-planner-2",
    1,
    "ticket.md",
    "# Fix midnight expiry\n\n- [ ] Works\n",
  );
}

withWorld(
  "a diagnosis with --and-fix is followed by a fix Request from the fix ticket",
  async (world) => {
    await register(world);
    await world.tracker.script([{ stdout: `${TICKET_URL}\n` }]);
    const started = await world.kiln(
      "request",
      "start",
      "remote",
      "--playbook",
      "diagnose-a-bug",
      "--description",
      "Logins fail after midnight",
      "--and-fix",
    );
    assertEquals(started.code, 0, started.stderr);

    await diagnose(world);

    const diagnosis = await statusOf(world, 1);
    assertEquals([diagnosis.status, diagnosis.fixRequestId], ["done", 2]);
    assertStringIncludes((await world.kiln("request", "status", "1")).stdout, "Fix request: 2");

    // The fix Request implements the published ticket, and its leader is handed the first step.
    const fix = await statusOf(world, 2);
    assertEquals([fix.playbook, fix.trackerItem, fix.status], [
      "implement-a-ticket",
      "#7",
      "active",
    ]);
    assertStringIncludes(fix.description, "Logins fail after midnight");
    const [step] = await asAgent(world, "engineering-leader", (a) => a.inbox());
    assertEquals(step.kind, "assignment");
    assertStringIncludes(String(step.body.instructions), "Tracker item: #7");
    assertStringIncludes(String(step.body.instructions), "ticket-checker");
  },
);

withWorld("a diagnosis without --and-fix starts no fix Request", async (world) => {
  await register(world);
  await world.tracker.script([{ stdout: `${TICKET_URL}\n` }]);
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
  await diagnose(world);
  const diagnosis = await statusOf(world, 1);
  assertEquals([diagnosis.status, diagnosis.fixRequestId], ["done", null]);
  assertEquals((await world.kiln("request", "status", "2")).code, 1);
});

withWorld("--and-fix is refused for a playbook that publishes no fix ticket", async (world) => {
  await register(world);
  const started = await world.kiln(
    "request",
    "start",
    "remote",
    "--playbook",
    "wayfind",
    "--description",
    "x",
    "--and-fix",
  );
  assertEquals(started.code, 1);
  assertStringIncludes(started.stderr, "fix ticket");
  assertEquals((await world.kiln("request", "status", "1")).code, 1);
});
