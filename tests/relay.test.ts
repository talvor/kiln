// The question relay, driven the way Kiln is used: agents' tool servers (MCP), the policing hook,
// the user's `kiln reject`, and the fake launcher that shows which Claude session is woken.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { withWorld, type World } from "./world.ts";
import { asAgent, assignment, openTeam, waitFor } from "./router_helpers.ts";
import type { Message } from "./router_helpers.ts";

const isResume = (arg: string) => arg.startsWith("--resume");

/** dev-1 holds an assignment from dev-lead and asks its leader a question. */
async function workerAsks(world: World, question = "Which greeting?"): Promise<Message> {
  await world.launcher.script(Array.from({ length: 8 }, () => ({ result: "ok" })));
  const job = await asAgent(
    world,
    "dev-lead",
    (agent) => agent.send("dev-1", "assignment", assignment),
  );
  const sent = await asAgent(world, "dev-1", async (agent) => {
    const out = await agent.call("raise_question", { question, assignmentId: job.id });
    assertEquals(out.isError, false, out.text);
    return out.data.sent;
  });
  return sent;
}

const relay = (world: World, asked: Message, question = "Overseer, which greeting?") =>
  asAgent(
    world,
    "dev-lead",
    (agent) => agent.call("raise_question", { question, relaysQuestion: asked.id }),
  );

withWorld(
  "the first level that can answers, and the worker's own session resumes",
  async (world) => {
    await openTeam(world);
    await world.launcher.script(Array.from({ length: 8 }, () => ({ result: "ok" })));
    const job = await asAgent(
      world,
      "dev-lead",
      (agent) => agent.send("dev-1", "assignment", assignment),
    );
    // Kiln wakes the worker, which reads its assignment, asks its question and stops.
    await waitFor(() => world.launcher.calls(), (calls) => calls.length >= 1, 60_000);
    const asked = await asAgent(world, "dev-1", async (agent) => {
      await agent.inbox();
      const out = await agent.call("raise_question", {
        question: "Which greeting?",
        assignmentId: job.id,
      });
      return out.data.sent;
    });
    await asAgent(
      world,
      "dev-lead",
      (agent) => agent.send("dev-1", "answer", { answer: "Say hello." }, asked.id),
    );
    const resumed = await waitFor(
      () => world.launcher.calls(),
      (calls) => calls.some((c) => c.env?.KILN_AGENT === "dev-1" && c.args.some(isResume)),
      60_000,
    );
    const workerCalls = resumed.filter((c) => c.env?.KILN_AGENT === "dev-1");
    const first = workerCalls[0];
    assert(!first.args.some(isResume), "the first launch starts a new session");
    const again = workerCalls.find((c) => c.args.some(isResume))!;
    // The first launch of the whole script is dev-1's, so it ran in fake-session-1.
    assertEquals(again.args.find(isResume), "--resume=fake-session-1");
    const inbox = await asAgent(world, "dev-1", (agent) => agent.inbox());
    assertEquals(inbox.filter((m) => m.kind === "answer").map((m) => m.body.answer), [
      "Say hello.",
    ]);
  },
);

withWorld(
  "a question the leader cannot answer is passed up and the answer comes back down",
  async (world) => {
    await openTeam(world);
    const asked = await workerAsks(world);
    const passed = await relay(world, asked);
    assertEquals(passed.isError, false, passed.text);
    assertEquals(passed.data.sent.relayOf, asked.id);

    const [up] = await asAgent(world, "overseer", (agent) => agent.inbox());
    assertEquals([up.kind, up.from, up.relayOf], ["question", "dev-lead", asked.id]);
    await asAgent(
      world,
      "overseer",
      (agent) => agent.send("dev-lead", "answer", { answer: "Say hello." }, up.id),
    );

    // The leader does nothing more: Kiln passes the answer on to the worker that asked.
    const inbox = await asAgent(world, "dev-1", (agent) => agent.inbox());
    const answer = inbox.find((m) => m.kind === "answer")!;
    assertEquals([answer.from, answer.inReplyTo, answer.body.answer], [
      "dev-lead",
      asked.id,
      "Say hello.",
    ]);
    const overseersAnswer = (await asAgent(world, "dev-lead", (agent) => agent.inbox()))
      .find((m) => m.kind === "answer")!;
    assertEquals(answer.relayOf, overseersAnswer.id);

    // The asker cannot be answered twice, and a question is passed up once.
    const again = await asAgent(
      world,
      "dev-lead",
      (agent) =>
        agent.call("send", {
          to: "dev-1",
          kind: "answer",
          body: { answer: "x" },
          inReplyTo: asked.id,
        }),
    );
    assertEquals(again.isError, true);
    assertStringIncludes(again.text, "already has a answer");
    const twice = await relay(world, asked);
    assertEquals(twice.isError, true);
    assertStringIncludes(twice.text, "already answered");
  },
);

withWorld("only the leader a question was put to may pass it up", async (world) => {
  await openTeam(world);
  const asked = await workerAsks(world);
  const refused = await asAgent(
    world,
    "dev-1",
    (agent) => agent.call("raise_question", { question: "x", relaysQuestion: asked.id }),
  );
  assertEquals(refused.isError, true);
  assertStringIncludes(refused.text, "relaysQuestion must be a question dev-1 was asked");
});

withWorld(
  "a blocked tool reaches the Overseer through the leader and is answered",
  async (world) => {
    await openTeam(world);
    await world.launcher.script(Array.from({ length: 8 }, () => ({ result: "ok" })));
    const job = await asAgent(
      world,
      "dev-lead",
      (agent) => agent.send("dev-1", "assignment", assignment),
    );
    const r = await world.kilnWithInput(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/etc/hosts", content: "x" },
      }),
      "hook",
      "police",
      "--address",
      "dev-1",
    );
    assertEquals(r.code, 0, r.stderr);
    const [asked] = (await asAgent(world, "dev-lead", (agent) => agent.inbox()))
      .filter((m) => m.kind === "question");
    assertEquals(asked.assignmentId, job.id);

    const passed = await relay(world, asked, "A worker needs /etc/hosts. Allow it?");
    assertEquals(passed.isError, false, passed.text);
    const [up] = await asAgent(world, "overseer", (agent) => agent.inbox());
    await asAgent(
      world,
      "overseer",
      (agent) => agent.send("dev-lead", "answer", { answer: "No; use a file in the repo." }, up.id),
    );
    const answer = (await asAgent(world, "dev-1", (agent) => agent.inbox()))
      .find((m) => m.kind === "answer")!;
    assertEquals(answer.body.answer, "No; use a file in the repo.");
  },
);

withWorld(
  "a question only the user can settle goes up as an escalation and back as an answer",
  async (world) => {
    await openTeam(world);
    const asked = await workerAsks(world);
    await relay(world, asked);
    const [up] = await asAgent(world, "overseer", (agent) => agent.inbox());

    const stray = await asAgent(
      world,
      "overseer",
      (agent) => agent.call("raise_escalation", { summary: "x", questionId: asked.id }),
    );
    assertEquals(stray.isError, true);
    assertStringIncludes(stray.text, "questionId");

    const raised = await asAgent(
      world,
      "overseer",
      (agent) =>
        agent.call("raise_escalation", {
          summary: "Which greeting do we ship?",
          questionId: up.id,
        }),
    );
    assertEquals(raised.isError, false, raised.text);
    const listed = JSON.parse((await world.kiln("escalations", "--json")).stdout);
    assertEquals(listed[0].questionId, up.id);

    const rejected = await world.kiln("reject", "1", "--reason", "Say goodbye instead");
    assertEquals(rejected.code, 0, rejected.stderr);

    // The user's decision is the answer, passed down to the worker that first asked.
    const answer = (await asAgent(world, "dev-1", (agent) => agent.inbox()))
      .find((m) => m.kind === "answer")!;
    assertEquals(answer.inReplyTo, asked.id);
    assertStringIncludes(String(answer.body.answer), "Say goodbye instead");
  },
);
