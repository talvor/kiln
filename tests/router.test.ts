import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { eventsOf } from "./helpers.ts";
import { withWorld } from "./world.ts";
import { asAgent, assignment, openTeam, stopHook, waitFor } from "./router_helpers.ts";

withWorld("tools, inbox reads, and message history", async (world) => {
  await openTeam(world);
  await asAgent(world, "dev-1", async (agent) => {
    assertEquals((await agent.tools()).sort(), [
      "gh",
      "list_playbooks",
      "list_projects",
      "raise_escalation",
      "raise_question",
      "read_escalations",
      "read_inbox",
      "request_status",
      "send",
      "start_request",
    ]);
  });
  const sent = await asAgent(
    world,
    "dev-lead",
    (agent) => agent.send("dev-1", "assignment", assignment),
  );
  await asAgent(world, "dev-1", async (agent) => {
    const [read] = await agent.inbox();
    assertEquals([read.id, read.from, read.to, read.kind, read.body], [
      sent.id,
      sent.from,
      sent.to,
      sent.kind,
      sent.body,
    ]);
    assertNotEquals(read.readAt, null);
    assertEquals(await agent.inbox(), []);
    await agent.send("dev-lead", "result", { status: "done", summary: "complete" }, sent.id);
  });
  const [result] = await asAgent(world, "dev-lead", (agent) => agent.inbox());
  assertEquals([result.kind, result.inReplyTo], ["result", sent.id]);
  assertEquals(result.body, { status: "done", summary: "complete" });
  assertEquals(await asAgent(world, "dev-2", (agent) => agent.inbox()), []);
});

withWorld("routes and message schemas are enforced", async (world) => {
  await openTeam(world);
  const wrongRoute = await asAgent(
    world,
    "dev-1",
    (agent) => agent.call("send", { to: "dev-2", kind: "question", body: { question: "x" } }),
  );
  assert(wrongRoute.isError);
  assertStringIncludes(wrongRoute.text, "route refused");

  const badBody = await asAgent(
    world,
    "dev-lead",
    (agent) =>
      agent.call("send", { to: "dev-1", kind: "assignment", body: { ...assignment, extra: 1 } }),
  );
  assert(badBody.isError);
  assertStringIncludes(badBody.text, 'unknown field "extra"');
  const inheritedName = await asAgent(world, "dev-lead", (agent) =>
    agent.call("send", {
      to: "dev-1",
      kind: "assignment",
      body: { ...assignment, constructor: "unexpected" },
    }));
  assert(inheritedName.isError);
  assertStringIncludes(inheritedName.text, 'unknown field "constructor"');

  const job = await asAgent(
    world,
    "dev-lead",
    (agent) => agent.send("dev-1", "assignment", assignment),
  );
  await asAgent(world, "dev-1", async (agent) => {
    const badReply = await agent.call("send", {
      to: "dev-lead",
      kind: "result",
      body: { status: "done", summary: "x" },
      inReplyTo: 999,
    });
    assert(badReply.isError);
    assertStringIncludes(badReply.text, "must reply to an assignment");
    await agent.send("dev-lead", "result", { status: "done", summary: "x" }, job.id);
    const duplicate = await agent.call("send", {
      to: "dev-lead",
      kind: "result",
      body: { status: "done", summary: "again" },
      inReplyTo: job.id,
    });
    assert(duplicate.isError);
    assertStringIncludes(duplicate.text, "already has a result");
    assertEquals(await agent.inbox(), []);
  });
  assertEquals(await stopHook(world, "dev-1"), null);
});

withWorld("MCP rejects malformed and extra tool arguments", async (world) => {
  await openTeam(world);
  const job = await asAgent(
    world,
    "dev-lead",
    (agent) => agent.send("dev-1", "assignment", assignment),
  );
  await asAgent(world, "dev-1", async (agent) => {
    for (
      const [name, args] of [
        ["read_inbox", { extra: true }],
        ["read_inbox", { constructor: "unexpected" }],
        ["send", {
          to: "dev-lead",
          kind: "result",
          body: { status: "done", summary: "x" },
          inReplyTo: String(job.id),
        }],
        ["send", {
          to: "dev-lead",
          kind: "result",
          body: { status: "done", summary: "x" },
          inReplyTo: true,
        }],
        ["send", {
          to: "dev-lead",
          kind: "result",
          body: { status: "done", summary: "x" },
          inReplyTo: job.id,
          extra: true,
        }],
        ["send", {
          to: "dev-lead",
          kind: "result",
          body: { status: "done", summary: "x" },
          inReplyTo: job.id,
          constructor: "unexpected",
        }],
        ["raise_question", { question: "x", extra: true }],
        ["raise_question", { question: "x", constructor: "unexpected" }],
      ] as const
    ) {
      const out = await agent.call(name, args);
      assert(out.isError, name);
    }
    await agent.send("dev-lead", "result", { status: "done", summary: "valid" }, job.id);
  });
});

withWorld("a question exempts only its live assignment", async (world) => {
  await openTeam(world);
  const [a, b] = await asAgent(world, "dev-lead", async (agent) => [
    await agent.send("dev-1", "assignment", assignment),
    await agent.send("dev-1", "assignment", { ...assignment, title: "Second" }),
  ]);
  await asAgent(world, "dev-1", async (agent) => {
    await agent.inbox();
    const question = await agent.call("raise_question", {
      question: "Which file?",
      assignmentId: a.id,
    });
    assertEquals(question.isError, false, question.text);
    assertEquals(question.data.sent.assignmentId, a.id);
    const wrong = await agent.call("raise_question", { question: "Wrong", assignmentId: 999 });
    assert(wrong.isError);
  });
  const verdict = await stopHook(world, "dev-1");
  assertEquals(verdict?.decision, "block");
  assertStringIncludes(verdict!.reason, `assignment ${b.id}`);
  assert(!verdict!.reason.includes(`assignment ${a.id},`));
  assertEquals(await stopHook(world, "dev-1", true), null);
  const lead = await asAgent(world, "dev-lead", (agent) => agent.inbox());
  assertEquals(lead.filter((m) => m.kind === "result").map((m) => m.inReplyTo), [b.id]);
  await asAgent(
    world,
    "dev-1",
    (agent) => agent.send("dev-lead", "result", { status: "done", summary: "done" }, a.id),
  );
  assertEquals(await stopHook(world, "dev-1"), null);
});

withWorld("an answered question no longer exempts its assignment", async (world) => {
  await openTeam(world);
  const job = await asAgent(
    world,
    "dev-lead",
    (agent) => agent.send("dev-1", "assignment", assignment),
  );
  const question = await asAgent(world, "dev-1", async (agent) => {
    await agent.inbox();
    return (await agent.call("raise_question", { question: "Which file?", assignmentId: job.id }))
      .data.sent;
  });
  await asAgent(world, "dev-lead", async (agent) => {
    await agent.inbox();
    await agent.send("dev-1", "answer", { answer: "hello.txt" }, question.id);
  });
  const verdict = await stopHook(world, "dev-1");
  assertEquals(verdict?.decision, "block");
  assertStringIncludes(verdict!.reason, `assignment ${job.id}`);
});

withWorld(
  "repeated Stop cannot duplicate a synthesised result or redeliver work",
  async (world) => {
    await openTeam(world);
    const job = await asAgent(
      world,
      "dev-lead",
      (agent) => agent.send("dev-1", "assignment", assignment),
    );
    assertEquals((await stopHook(world, "dev-1"))?.decision, "block");
    assertEquals(await stopHook(world, "dev-1", true), null);
    assertEquals(await stopHook(world, "dev-1", true), null);
    const [failure] = await asAgent(world, "dev-lead", (agent) => agent.inbox());
    assertEquals([failure.kind, failure.inReplyTo, failure.synthesised], ["result", job.id, true]);
    assertEquals(
      await asAgent(world, "dev-1", (agent) => agent.inbox()),
      [],
    );
    assertEquals(await stopHook(world, "dev-1"), null);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assertEquals(await world.launcher.calls(), []);
    assertEquals(await asAgent(world, "dev-lead", (agent) => agent.inbox()), []);
  },
);

withWorld("Stop hook blocks when Kiln cannot check pending work", async (world) => {
  await openTeam(world);
  await asAgent(world, "dev-lead", (agent) => agent.send("dev-1", "assignment", assignment));
  await asAgent(world, "dev-1", (agent) => agent.inbox());

  const rpc = await world.kilnWithInput("{}", "hook", "stop", "--address", "missing");
  assertEquals(rpc.code, 0, rpc.stderr);
  assertEquals(JSON.parse(rpc.stdout).decision, "block");
  assertStringIncludes(JSON.parse(rpc.stdout).reason, "No session is open");

  await world.kiln("daemon", "stop");
  const blockedRuntime = join(world.root, "blocked-runtime");
  await Deno.writeTextFile(blockedRuntime, "occupied");
  world.env.KILN_RUNTIME_DIR = blockedRuntime;
  const startup = await world.kilnWithInput("{}", "hook", "stop", "--address", "dev-1");
  assertEquals(startup.code, 0, startup.stderr);
  assertEquals(JSON.parse(startup.stdout).decision, "block");
  assertStringIncludes(JSON.parse(startup.stdout).reason, "could not check pending work");
});

withWorld("automatic delivery nudges each recipient with its tools and hook", async (world) => {
  await openTeam(world);
  await world.launcher.script([{ result: "ok" }, { result: "ok" }]);
  await asAgent(world, "dev-lead", async (agent) => {
    await agent.send("dev-1", "assignment", assignment);
    await agent.send("dev-1", "assignment", { ...assignment, title: "Second" });
    await agent.send("dev-2", "assignment", assignment);
  });
  const prompts = await waitFor(() => world.launcher.prompts(), (items) => items.length >= 2);
  // The delivery clock may wake dev-1 between its two sends, so its count is one or two.
  for (const prompt of prompts.slice(0, 2)) assertMatch(prompt, /^You have [12] unread message/);
  const calls = await world.launcher.calls();
  assertEquals(calls.length >= 2, true);
  for (const call of calls) {
    const args = call.args.join(" ");
    assertStringIncludes(args, "tool-server");
    assertStringIncludes(args, "mcp__kiln__read_inbox");
    assertStringIncludes(args, "hook");
  }
});

withWorld("failed launches do not count toward dead letters", async (world) => {
  await openTeam(world);
  await Deno.mkdir(world.dirs.config, { recursive: true });
  await Deno.writeTextFile(
    join(world.dirs.config, "limits.json"),
    JSON.stringify({ infrastructure: { retries: 10, backoffSeconds: 1 } }),
  );
  await world.launcher.script(
    Array.from({ length: 4 }, () => ({ outcome: "error_during_execution" as const })),
  );
  const job = await asAgent(
    world,
    "dev-lead",
    (agent) => agent.send("dev-1", "assignment", assignment),
  );
  await waitFor(() => world.launcher.prompts(), (items) => items.length >= 4, 15_000);
  const [waiting] = await asAgent(world, "dev-1", (agent) => agent.inbox());
  assertEquals([waiting.id, waiting.deliveries, waiting.deadLetteredAt], [job.id, 0, null]);
  assertEquals(await asAgent(world, "dev-lead", (agent) => agent.inbox()), []);
});

withWorld("three automatic nudges dead-letter unread work and questions", async (world) => {
  await openTeam(world);
  await world.launcher.script(Array.from({ length: 6 }, () => ({ result: "ok" })));
  const readJob = await asAgent(
    world,
    "dev-lead",
    (agent) => agent.send("dev-1", "assignment", { ...assignment, title: "Read job" }),
  );
  // The delivery clock may nudge the Read job before dev-1 reads it; that wake is not one of the three.
  let earlyNudges = 0;
  await asAgent(world, "dev-1", async (agent) => {
    await agent.inbox();
    // A nudge still in flight has started its launch but not yet recorded a delivery.
    earlyNudges = (await world.launcher.prompts()).length;
    const asked = await agent.call("raise_question", {
      question: "Which file?",
      assignmentId: readJob.id,
    });
    assertEquals(asked.isError, false, asked.text);
  });
  const job = await asAgent(
    world,
    "dev-lead",
    (agent) => agent.send("dev-1", "assignment", assignment),
  );
  await waitFor(
    () => world.launcher.prompts(),
    (items) => items.length >= 6 + earlyNudges,
    130_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 65_000));
  const leader = await waitFor(
    () => asAgent(world, "dev-lead", (agent) => agent.inbox()),
    (messages) => messages.some((m) => m.kind === "result" && m.inReplyTo === job.id),
    70_000,
  );
  const [failure] = leader;
  assertEquals([failure.synthesised, failure.body.status, failure.inReplyTo], [
    true,
    "failed",
    job.id,
  ]);
  // One more early nudge may have been launched right after the count above was taken.
  const nudges = (await world.launcher.prompts()).length;
  assertEquals(nudges >= 6 + earlyNudges && nudges <= 7 + earlyNudges, true, `${nudges} nudges`);
  assertEquals(await asAgent(world, "dev-1", (agent) => agent.inbox()), []);
  const verdict = await stopHook(world, "dev-1");
  assertEquals(verdict?.decision, "block");
  assertStringIncludes(verdict!.reason, `assignment ${readJob.id}`);
});

withWorld("a timed out launch does not hold another recipient's nudge", async (world) => {
  await openTeam(world);
  await world.launcher.script([{ hang: true }, { result: "ok" }]);
  await asAgent(world, "dev-lead", (agent) => agent.send("dev-1", "assignment", assignment));
  await waitFor(() => world.launcher.prompts(), (items) => items.length === 1, 40_000);
  await asAgent(world, "dev-lead", (agent) => agent.send("dev-2", "assignment", assignment));
  const prompts = await waitFor(
    () => world.launcher.prompts(),
    (items) => items.length >= 2,
    40_000,
  );
  assertEquals(prompts.length, 2);
  await waitFor(
    () => eventsOf(world, "message.nudged"),
    (events) => events.some((event) => event.to === "dev-2"),
    40_000,
  );
  // Reading an inbox consumes its messages, so first wait for the recorded delivery.
  const [hung] = await asAgent(world, "dev-1", (agent) => agent.inbox());
  const [nudged] = await asAgent(world, "dev-2", (agent) => agent.inbox());
  assertEquals([hung.deliveries, nudged.deliveries], [0, 1]);
});
