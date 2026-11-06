import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { withWorld } from "./world.ts";
import { asAgent, assignment, openTeam, stopHook } from "./router_helpers.ts";

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for public delivery evidence");
}

withWorld("tools, inbox reads, and message history", async (world) => {
  await openTeam(world);
  await asAgent(world, "dev-1", async (agent) => {
    assertEquals((await agent.tools()).sort(), ["raise_question", "read_inbox", "send"]);
  });
  const sent = await asAgent(world, "dev-lead", (agent) =>
    agent.send("dev-1", "assignment", assignment));
  await asAgent(world, "dev-1", async (agent) => {
    const [read] = await agent.inbox();
    assertEquals([read.id, read.from, read.to, read.kind, read.body], [
      sent.id, sent.from, sent.to, sent.kind, sent.body,
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
  const wrongRoute = await asAgent(world, "dev-1", (agent) =>
    agent.call("send", { to: "dev-2", kind: "question", body: { question: "x" } }));
  assert(wrongRoute.isError);
  assertStringIncludes(wrongRoute.text, "route refused");

  const badBody = await asAgent(world, "dev-lead", (agent) =>
    agent.call("send", { to: "dev-1", kind: "assignment", body: { ...assignment, extra: 1 } }));
  assert(badBody.isError);
  assertStringIncludes(badBody.text, 'unknown field "extra"');
  const inheritedName = await asAgent(world, "dev-lead", (agent) =>
    agent.call("send", {
      to: "dev-1", kind: "assignment", body: { ...assignment, constructor: "unexpected" },
    }));
  assert(inheritedName.isError);
  assertStringIncludes(inheritedName.text, 'unknown field "constructor"');

  const job = await asAgent(world, "dev-lead", (agent) =>
    agent.send("dev-1", "assignment", assignment));
  await asAgent(world, "dev-1", async (agent) => {
    const badReply = await agent.call("send", {
      to: "dev-lead", kind: "result", body: { status: "done", summary: "x" }, inReplyTo: 999,
    });
    assert(badReply.isError);
    assertStringIncludes(badReply.text, "must reply to an assignment");
    await agent.send("dev-lead", "result", { status: "done", summary: "x" }, job.id);
    const duplicate = await agent.call("send", {
      to: "dev-lead", kind: "result", body: { status: "done", summary: "again" }, inReplyTo: job.id,
    });
    assert(duplicate.isError);
    assertStringIncludes(duplicate.text, "already has a result");
    assertEquals(await agent.inbox(), []);
  });
  assertEquals(await stopHook(world, "dev-1"), null);
});

withWorld("MCP rejects malformed and extra tool arguments", async (world) => {
  await openTeam(world);
  const job = await asAgent(world, "dev-lead", (agent) =>
    agent.send("dev-1", "assignment", assignment));
  await asAgent(world, "dev-1", async (agent) => {
    for (const [name, args] of [
      ["read_inbox", { extra: true }],
      ["read_inbox", { constructor: "unexpected" }],
      ["send", { to: "dev-lead", kind: "result", body: { status: "done", summary: "x" }, inReplyTo: String(job.id) }],
      ["send", { to: "dev-lead", kind: "result", body: { status: "done", summary: "x" }, inReplyTo: true }],
      ["send", { to: "dev-lead", kind: "result", body: { status: "done", summary: "x" }, inReplyTo: job.id, extra: true }],
      ["send", { to: "dev-lead", kind: "result", body: { status: "done", summary: "x" }, inReplyTo: job.id, constructor: "unexpected" }],
      ["raise_question", { question: "x", extra: true }],
      ["raise_question", { question: "x", constructor: "unexpected" }],
    ] as const) {
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
    const question = await agent.call("raise_question", { question: "Which file?", assignmentId: a.id });
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
  await asAgent(world, "dev-1", (agent) =>
    agent.send("dev-lead", "result", { status: "done", summary: "done" }, a.id));
  assertEquals(await stopHook(world, "dev-1"), null);
});

withWorld("an answered question no longer exempts its assignment", async (world) => {
  await openTeam(world);
  const job = await asAgent(world, "dev-lead", (agent) =>
    agent.send("dev-1", "assignment", assignment));
  const question = await asAgent(world, "dev-1", async (agent) => {
    await agent.inbox();
    return (await agent.call("raise_question", { question: "Which file?", assignmentId: job.id })).data.sent;
  });
  await asAgent(world, "dev-lead", async (agent) => {
    await agent.inbox();
    await agent.send("dev-1", "answer", { answer: "hello.txt" }, question.id);
  });
  const verdict = await stopHook(world, "dev-1");
  assertEquals(verdict?.decision, "block");
  assertStringIncludes(verdict!.reason, `assignment ${job.id}`);
});

withWorld("repeated Stop cannot duplicate a synthesised result or redeliver work", async (world) => {
  await openTeam(world);
  const job = await asAgent(world, "dev-lead", (agent) =>
    agent.send("dev-1", "assignment", assignment));
  assertEquals((await stopHook(world, "dev-1"))?.decision, "block");
  assertEquals(await stopHook(world, "dev-1", true), null);
  assertEquals(await stopHook(world, "dev-1", true), null);
  const [failure] = await asAgent(world, "dev-lead", (agent) => agent.inbox());
  assertEquals([failure.kind, failure.inReplyTo, failure.synthesised], ["result", job.id, true]);
  assertEquals(await asAgent(world, "dev-1", (agent) => agent.inbox()), []);
  assertEquals(await stopHook(world, "dev-1"), null);
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  assertEquals(await world.launcher.calls(), []);
  assertEquals(await asAgent(world, "dev-lead", (agent) => agent.inbox()), []);
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
  assertStringIncludes(prompts[0], "2 unread message");
  assertStringIncludes(prompts[1], "1 unread message");
  const calls = await world.launcher.calls();
  assertEquals(calls.length, 2);
  for (const call of calls) {
    const args = call.args.join(" ");
    assertStringIncludes(args, "tool-server");
    assertStringIncludes(args, "mcp__kiln__read_inbox");
    assertStringIncludes(args, "hook");
  }
});

withWorld("three automatic nudges dead-letter unread work and questions", async (world) => {
  await openTeam(world);
  await world.launcher.script(Array.from({ length: 6 }, () => ({ result: "ok" })));
  const readJob = await asAgent(world, "dev-lead", (agent) =>
    agent.send("dev-1", "assignment", { ...assignment, title: "Read job" }));
  await asAgent(world, "dev-1", async (agent) => {
    await agent.inbox();
    const asked = await agent.call("raise_question", { question: "Which file?", assignmentId: readJob.id });
    assertEquals(asked.isError, false, asked.text);
  });
  const job = await asAgent(world, "dev-lead", (agent) =>
    agent.send("dev-1", "assignment", assignment));
  await waitFor(() => world.launcher.prompts(), (items) => items.length >= 6, 130_000);
  await new Promise((resolve) => setTimeout(resolve, 65_000));
  const leader = await waitFor(
    () => asAgent(world, "dev-lead", (agent) => agent.inbox()),
    (messages) => messages.some((m) => m.kind === "result" && m.inReplyTo === job.id),
    70_000,
  );
  const [failure] = leader;
  assertEquals([failure.synthesised, failure.body.status, failure.inReplyTo], [true, "failed", job.id]);
  assertEquals((await world.launcher.prompts()).length, 6);
  assertEquals(await asAgent(world, "dev-1", (agent) => agent.inbox()), []);
  const verdict = await stopHook(world, "dev-1");
  assertEquals(verdict?.decision, "block");
  assertStringIncludes(verdict!.reason, `assignment ${readJob.id}`);
});

withWorld("a timed out launch does not hold another recipient's nudge", async (world) => {
  await openTeam(world);
  await world.launcher.script([{ hang: true }, { result: "ok" }]);
  await asAgent(world, "dev-lead", async (agent) => {
    await agent.send("dev-1", "assignment", assignment);
    await agent.send("dev-2", "assignment", assignment);
  });
  const prompts = await waitFor(() => world.launcher.prompts(), (items) => items.length >= 2, 40_000);
  assertEquals(prompts.length, 2);
});
