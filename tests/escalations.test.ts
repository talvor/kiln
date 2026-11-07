// Escalations and Gates, driven the way Kiln is used: the Overseer's tool server raises a
// decision, the user answers with `kiln escalations|approve|reject`, and the policing hook and
// the launcher show that agents cannot decide for the user.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { runKiln } from "./helpers.ts";
import { withWorld, type World } from "./world.ts";
import { asAgent, openTeam, waitFor } from "./router_helpers.ts";

interface Escalation {
  id: number;
  raisedBy: string;
  requestId: number | null;
  summary: string;
  detail: string | null;
  status: string;
  reason: string | null;
  decidedAt: string | null;
}

const raise = (world: World, args: Record<string, unknown>) =>
  asAgent(world, "overseer", (agent) => agent.call("raise_escalation", args));

const listed = async (world: World, ...flags: string[]): Promise<Escalation[]> => {
  const r = await world.kiln("escalations", "--json", ...flags);
  assertEquals(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};

const mine = (world: World) =>
  asAgent(world, "overseer", async (agent) => {
    const out = await agent.call("read_escalations");
    assertEquals(out.isError, false, out.text);
    return (JSON.parse(out.text) as { escalations: Escalation[] }).escalations;
  });

/** A registered Project and a Request that follows a Playbook, so the Overseer has a Request. */
async function startRequest(world: World) {
  await Deno.writeTextFile(join(world.project.path, "AGENTS.md"), "# How to work here\n");
  await world.git(world.project.path, "add", ".");
  await world.git(world.project.path, "commit", "-m", "Add agent docs");
  await world.git(world.project.path, "push", "origin", "main");
  await world.githubApi.script([{ stdout: "{}\n" }]);
  await world.launcher.script([{
    result: JSON.stringify({ setup: null, test: null, lint: null, build: null }),
  }]);
  const reg = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(reg.code, 0, reg.stderr);
  const started = await world.kiln(
    "request",
    "start",
    "remote",
    "--playbook",
    "diagnose-a-bug",
    "--description",
    "Flaky login",
  );
  assertEquals(started.code, 0, started.stderr);
}

withWorld("an escalation waits for the user and records what they decide", async (world) => {
  await openTeam(world);
  const empty = await world.kiln("escalations");
  assertEquals(empty.code, 0, empty.stderr);
  assertStringIncludes(empty.stdout, "No escalations");

  const raised = await raise(world, {
    summary: "Ship the migration before the freeze?",
    detail: "It locks the users table for a minute.",
  });
  assertEquals(raised.isError, false, raised.text);

  const [open] = await listed(world);
  assertEquals(
    [open.id, open.raisedBy, open.status, open.summary, open.reason],
    [1, "overseer", "open", "Ship the migration before the freeze?", null],
  );
  const text = await world.kiln("escalations");
  assertStringIncludes(text.stdout, "Escalation 1 [open]");
  assertStringIncludes(text.stdout, "locks the users table");

  // Nothing times it out: it is still open, and the Overseer sees it so.
  assertEquals((await mine(world)).map((e) => e.status), ["open"]);

  const approved = await world.kiln("approve", "1");
  assertEquals(approved.code, 0, approved.stderr);
  assertStringIncludes(approved.stdout, "Approved escalation 1");
  assertEquals(await listed(world), []);
  const [done] = await listed(world, "--all");
  assertEquals([done.status, done.reason], ["approved", null]);
  assert(done.decidedAt);
  assertEquals((await mine(world)).map((e) => e.status), ["approved"]);
});

withWorld("a rejection needs a reason, which the Overseer is told", async (world) => {
  await openTeam(world);
  await raise(world, { summary: "Drop the legacy API?" });

  const bare = await world.kiln("reject", "1");
  assertEquals(bare.code, 2);
  assertStringIncludes(bare.stderr, "Usage");
  const blank = await world.kiln("reject", "1", "--reason", "  ");
  assertEquals(blank.code, 2);
  assertEquals((await listed(world))[0].status, "open");

  const rejected = await world.kiln("reject", "1", "--reason", "Customers still use it");
  assertEquals(rejected.code, 0, rejected.stderr);
  const [e] = await mine(world);
  assertEquals([e.status, e.reason], ["rejected", "Customers still use it"]);
  assertStringIncludes((await world.kiln("escalations", "--all")).stdout, "Customers still use it");
});

withWorld("a decision is final: a duplicate or conflicting one is refused", async (world) => {
  await openTeam(world);
  await raise(world, { summary: "Delete the staging data?" });
  assertEquals((await world.kiln("approve", "1")).code, 0);

  for (const args of [["approve", "1"], ["reject", "1", "--reason", "changed my mind"]]) {
    const again = await world.kiln(...args);
    assertEquals(again.code, 1);
    assertStringIncludes(again.stderr, "already approved");
  }
  const [e] = await listed(world, "--all");
  assertEquals([e.status, e.reason], ["approved", null]);

  const unknown = await world.kiln("approve", "99");
  assertEquals(unknown.code, 1);
  assertStringIncludes(unknown.stderr, "No escalation 99");
});

withWorld("an escalation about a request that has ended is stale", async (world) => {
  await startRequest(world);
  const raised = await raise(world, { summary: "Widen the fix?", requestId: 1 });
  assertEquals(raised.isError, false, raised.text);
  assertEquals((await listed(world))[0].requestId, 1);

  // The leader gives up on the step, so the Request fails.
  const [step] = await asAgent(world, "engineering-leader", (agent) => agent.inbox());
  await asAgent(world, "engineering-leader", (agent) =>
    agent.send(
      "overseer",
      "result",
      { status: "failed", summary: "Cannot reproduce" },
      step.id,
    ));

  assertEquals(await listed(world), []);
  assertEquals((await listed(world, "--all"))[0].status, "stale");
  const refused = await world.kiln("approve", "1");
  assertEquals(refused.code, 1);
  assertStringIncludes(refused.stderr, "stale");
  assertStringIncludes(refused.stderr, "failed");
  assertEquals((await mine(world))[0].status, "stale");

  // Nor can a new one be raised about it.
  const late = await raise(world, { summary: "Try again?", requestId: 1 });
  assertEquals(late.isError, true);
  assertStringIncludes(late.text, "already failed");
});

withWorld("only the Overseer raises escalations, and they are checked", async (world) => {
  await openTeam(world);
  for (const address of ["dev-lead", "dev-1"]) {
    const out = await asAgent(
      world,
      address,
      (agent) => agent.call("raise_escalation", { summary: "Let me decide" }),
    );
    assertEquals(out.isError, true, address);
    assertStringIncludes(out.text, "Only the overseer");
  }
  for (
    const bad of [{}, { summary: " " }, { summary: "x", requestId: 42 }, { summary: "x", n: 1 }]
  ) {
    assertEquals((await raise(world, bad)).isError, true, JSON.stringify(bad));
  }
  assertEquals(await listed(world, "--all"), []);
});

withWorld("the Overseer cannot approve or reject, however it tries", async (world) => {
  await openTeam(world);
  await raise(world, { summary: "Ship it?" });

  // No tool decides.
  const tools = await asAgent(world, "overseer", (agent) => agent.tools());
  assert(!tools.some((t) => /approve|reject|decide/.test(t)), tools.join());

  // A shell command that tries is refused by the policing hook, for any role with a shell.
  for (
    const command of [
      "kiln approve 1",
      "/usr/bin/kiln reject 1 --reason no",
      "cd x && kiln approve 1",
    ]
  ) {
    const verdict = await world.kilnWithInput(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      }),
      "hook",
      "police",
      "--address",
      "dev-1",
    );
    assertStringIncludes(verdict.stdout, "deny");
    assertStringIncludes(verdict.stdout, "only the user approves or rejects");
  }

  // Run from inside an agent's session the commands are refused by the daemon itself.
  for (const args of [["approve", "1"], ["reject", "1", "--reason", "no"]]) {
    const r = await runKiln({ ...world.env, KILN_AGENT: "overseer" }, args);
    assertEquals(r.code, 1);
    assertStringIncludes(r.stderr, "Only the user decides");
  }
  assertEquals((await listed(world))[0].status, "open");

  // And Kiln marks every agent launch so that the above holds for what agents run.
  await world.launcher.script([{ result: "ok" }]);
  await asAgent(
    world,
    "dev-lead",
    (agent) =>
      agent.send("dev-1", "assignment", { title: "Add greeting", instructions: "Write hello.txt" }),
  );
  const calls = await waitFor(() => world.launcher.calls(), (items) => items.length >= 1);
  for (const call of calls) assert(call.env?.KILN_AGENT?.startsWith("dev-"), call.env?.KILN_AGENT);
});

withWorld("an escalation survives a daemon restart, still open", async (world) => {
  await openTeam(world);
  await raise(world, { summary: "Cut the release?" });
  assertEquals((await world.kiln("daemon", "restart")).code, 0);
  const [e] = await listed(world);
  assertEquals([e.id, e.status], [1, "open"]);
  assertEquals((await world.kiln("reject", "1", "--reason", "Not yet")).code, 0);
});
