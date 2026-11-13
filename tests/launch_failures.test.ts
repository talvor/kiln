// Agents Kiln cannot wake: a worker whose worktree was removed after its work was merged is never
// woken (the launch could only fail, and the launcher blames the binary's libc), and what is sent
// to it is answered at once instead of retried until the agent is declared stuck.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { eventsOf } from "./helpers.ts";
import { withWorld, type World } from "./world.ts";
import { asAgent, type Message, waitFor } from "./router_helpers.ts";

const COMMANDS = { setup: null, test: null, lint: null, build: null };

async function startTicket(world: World) {
  await Deno.writeTextFile(join(world.project.path, "AGENTS.md"), "# How to work here\n");
  await world.git(world.project.path, "add", ".");
  await world.git(world.project.path, "commit", "-m", "Add agent docs");
  await world.git(world.project.path, "push", "origin", "main");
  await world.githubApi.script([{ stdout: "{}\n" }]);
  await world.launcher.script([{ result: JSON.stringify(COMMANDS) }]);
  const reg = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(reg.code, 0, reg.stderr);
  const started = await world.kiln(
    "request",
    "start",
    "remote",
    "--playbook",
    "implement-a-ticket",
    "--description",
    "Implement the CSV export ticket",
    "--tracker-item",
    "#18",
  );
  assertEquals(started.code, 0, started.stderr);
}

interface Status {
  steps: { assignments: { id: number; worktree: string; merged: boolean }[] }[];
}
const statusOf = async (world: World): Promise<Status> => {
  const r = await world.kiln("request", "status", "1", "--json");
  assertEquals(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};

const leaderInbox = (world: World) => asAgent(world, "engineering-leader", (a) => a.inbox());
const workerCalls = async (world: World, address: string) =>
  (await world.launcher.calls()).filter((c) => c.env?.KILN_AGENT === address).length;

/** The ticket checker does its step: it reports done, and the step is merged and its worktree gone. */
async function finishFirstStep(world: World): Promise<Message> {
  const step = (await waitFor(() => leaderInbox(world), (m) => m.length > 0))[0];
  const job = await asAgent(
    world,
    "engineering-leader",
    (a) => a.send("ticket-checker-1", "assignment", { title: "Check", instructions: "Check it" }),
  );
  const open = (await statusOf(world)).steps.flatMap((s) => s.assignments).find((a) =>
    a.id === job.id
  )!;
  await Deno.writeTextFile(join(open.worktree, "readiness.md"), "# Ready\n");
  await world.git(open.worktree, "add", ".");
  await world.git(open.worktree, "commit", "-m", "Do the work");
  await asAgent(world, "ticket-checker-1", async (a) => {
    await a.inbox();
    await a.send("engineering-leader", "result", { status: "done", summary: "Ready" }, job.id);
  });
  await asAgent(world, "engineering-leader", async (a) => {
    await a.inbox();
    await a.send("overseer", "result", { status: "done", summary: "Verified" }, step.id);
  });
  await waitFor(
    () => statusOf(world),
    (s) => s.steps.flatMap((x) => x.assignments).find((a) => a.id === job.id)!.merged,
  );
  await waitFor(
    () => Deno.stat(open.worktree).then(() => false, () => true),
    (gone) => gone,
  );
  return job;
}

withWorld(
  "an assignment for a worker whose worktree is gone fails at once, saying why",
  async (w) => {
    await startTicket(w);
    await finishFirstStep(w);
    const before = await workerCalls(w, "ticket-checker-1");

    const again = await asAgent(
      w,
      "engineering-leader",
      (a) =>
        a.send("ticket-checker-1", "assignment", { title: "Once more", instructions: "Again" }),
    );
    const failed = await waitFor(
      () => leaderInbox(w),
      (m) => m.some((x) => x.kind === "result" && x.inReplyTo === again.id),
    );
    const result = failed.find((x) => x.kind === "result" && x.inReplyTo === again.id)!;
    assertEquals([result.body.status, result.synthesised], ["failed", true]);
    assertStringIncludes(String(result.body.summary), "ticket-checker-1 has no worktree any more");
    assertStringIncludes(String(result.body.summary), "Give this work to a new worker");
    assert(!/libc|failed to launch/.test(String(result.body.summary)));

    // Nothing was launched for it, so it is not retried, and not declared stuck.
    assertEquals(await workerCalls(w, "ticket-checker-1"), before);
    const health = await w.kiln("daemon", "status", "--json");
    assertEquals(health.code, 0, health.stderr);
  },
);

withWorld("an answer for a worker that already reported is not delivered", async (w) => {
  await startTicket(w);
  await finishFirstStep(w);
  const before = await workerCalls(w, "ticket-checker-1");
  const sent = await asAgent(w, "engineering-leader", async (a) => {
    // The leader's answer arrives after the worker is done: it asked its question earlier.
    const question = await asAgent(
      w,
      "ticket-checker-1",
      (c) => c.send("engineering-leader", "question", { question: "Is this fine?" }),
    );
    return await a.send("ticket-checker-1", "answer", { answer: "Yes." }, question.id);
  });

  const dropped = await waitFor(
    () => eventsOf(w, "message.dead_lettered"),
    (events) => events.some((e) => e.id === sent.id),
  );
  assertEquals(dropped.find((e) => e.id === sent.id)!.why, "worktree removed");
  assertEquals(await workerCalls(w, "ticket-checker-1"), before);
});
