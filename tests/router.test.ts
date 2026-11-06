// The message router, driven through its public interface: sessions opened with `kiln session`,
// agents acting through their Kiln tool server (MCP over stdio), the Stop hook, `kiln messages`
// and `kiln router tick`, against the fake world where `claude` is the scripted launcher.
import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { withWorld } from "./world.ts";
import { asAgent, assignment, messages, openTeam, stopHook, tick } from "./router_helpers.ts";

// Delivery passes are run by hand in these tests; re-nudging is immediate unless a test says so.
const MANUAL = { KILN_ROUTER_TICK_MS: "0", KILN_RENUDGE_AFTER_MS: "0" };
const PATIENT = { KILN_ROUTER_TICK_MS: "0", KILN_RENUDGE_AFTER_MS: "3600000" };

withWorld("an agent's tool server offers inbox, send and raise-question tools", async (world) => {
  await openTeam(world);
  await asAgent(world, "dev-1", async (agent) => {
    assertEquals((await agent.tools()).sort(), ["raise_question", "read_inbox", "send"]);
  });
}, MANUAL);

withWorld("a sent message reaches the recipient's inbox once, and is then read", async (world) => {
  await openTeam(world);
  const sent = await asAgent(world, "dev-lead", (a) => a.send("dev-1", "assignment", assignment));
  assertEquals([sent.from, sent.to, sent.kind], ["dev-lead", "dev-1", "assignment"]);

  await asAgent(world, "dev-1", async (agent) => {
    const [first, ...rest] = await agent.inbox();
    assertEquals(rest, []);
    assertEquals(first.id, sent.id);
    assertEquals(first.body, assignment);
    assertEquals(await agent.inbox(), []); // read tracking: nothing is handed over twice
  });

  const [stored] = await messages(world);
  assertEquals(stored.id, sent.id);
  assertNotEquals(stored.readAt, null);
  assertEquals(await asAgent(world, "dev-2", (a) => a.inbox()), []); // only the addressee reads it
}, MANUAL);

withWorld("an unread message is shown unread", async (world) => {
  await openTeam(world);
  await asAgent(world, "dev-lead", (a) => a.send("dev-1", "assignment", assignment));
  const out = await world.kiln("messages", "--to", "dev-1");
  assertStringIncludes(out.stdout, "dev-lead -> dev-1  assignment  unread, nudged 0x");
}, MANUAL);

withWorld(
  "routes: results and questions go up one level, assignments and answers go down",
  async (world) => {
    await openTeam(world);
    const refused = async (from: string, to: string, kind: string, body: unknown) => {
      const out = await asAgent(world, from, (a) => a.call("send", { to, kind, body }));
      assert(out.isError, `${from} -> ${to} ${kind} should be refused`);
      assertStringIncludes(out.text, "route refused");
    };
    await refused("dev-1", "overseer", "result", { status: "done", summary: "x" }); // skips the leader
    await refused("dev-1", "dev-2", "question", { question: "x" }); // sideways
    await refused("overseer", "dev-1", "assignment", assignment); // skips the leader
    await refused("dev-lead", "dev-1", "question", { question: "x" }); // wrong direction
    await refused("dev-1", "dev-lead", "assignment", assignment); // wrong direction
    assertEquals(await messages(world), []);

    await asAgent(world, "overseer", (a) => a.send("dev-lead", "assignment", assignment));
    await asAgent(world, "dev-lead", (a) => a.send("dev-1", "assignment", assignment));
    await asAgent(
      world,
      "dev-1",
      (a) => a.send("dev-lead", "question", { question: "which file?" }),
    );
    assertEquals((await messages(world)).length, 3);
  },
  MANUAL,
);

withWorld("sending to an unknown address is refused", async (world) => {
  await openTeam(world);
  const out = await asAgent(
    world,
    "dev-lead",
    (a) => a.call("send", { to: "ghost", kind: "assignment", body: assignment }),
  );
  assert(out.isError);
  assertStringIncludes(out.text, 'No session is open at "ghost"');
}, MANUAL);

withWorld("a message that breaks its kind's schema is refused with the reasons", async (world) => {
  await openTeam(world);
  await asAgent(world, "dev-lead", async (lead) => {
    const bad = async (kind: string, body: unknown, ...reasons: string[]) => {
      const out = await lead.call("send", { to: "dev-1", kind, body });
      assert(out.isError, `${JSON.stringify(body)} should be refused`);
      for (const reason of reasons) assertStringIncludes(out.text, reason);
    };
    await bad("assignment", { title: "No instructions" }, 'missing required field "instructions"');
    await bad("assignment", { ...assignment, extra: 1 }, 'unknown field "extra"');
    await bad("assignment", { title: "", instructions: "x" }, 'field "title" must be a non-empty');
    await bad("assignment", "just text", "body must be a JSON object");
    await bad("poem", { title: "x" }, 'unknown message kind "poem"');
  });
  assertEquals(await messages(world), []);
}, MANUAL);

withWorld(
  "a result must say done or failed, and reply to the assignment it reports on",
  async (world) => {
    await openTeam(world);
    const job = await asAgent(world, "dev-lead", (a) => a.send("dev-1", "assignment", assignment));
    await asAgent(world, "dev-1", async (worker) => {
      const refuse = async (body: unknown, inReplyTo: number | undefined, reason: string) => {
        const out = await worker.call("send", { to: "dev-lead", kind: "result", body, inReplyTo });
        assert(out.isError);
        assertStringIncludes(out.text, reason);
      };
      await refuse({ status: "done", summary: "ok" }, undefined, "must reply to an assignment");
      await refuse({ status: "done", summary: "ok" }, 999, "must reply to an assignment");
      await refuse({ status: "maybe", summary: "ok" }, job.id, "must be one of: done, failed");

      const sent = await worker.send(
        "dev-lead",
        "result",
        { status: "done", summary: "ok" },
        job.id,
      );
      assertEquals(sent.inReplyTo, job.id);
      await refuse({ status: "done", summary: "again" }, job.id, "already has a result");
    });
  },
  MANUAL,
);

withWorld(
  "raise_question goes to the sender's superior and the answer comes back",
  async (world) => {
    await openTeam(world);
    const asked = await asAgent(world, "dev-1", async (worker) => {
      const out = await worker.call("raise_question", {
        question: "Which file?",
        context: "hello",
      });
      assertEquals(out.isError, false, out.text);
      return out.data.sent;
    });
    assertEquals([asked.to, asked.kind], ["dev-lead", "question"]);
    assertEquals(asked.body, { question: "Which file?", context: "hello" });

    await asAgent(world, "dev-lead", async (lead) => {
      assertEquals((await lead.inbox()).map((m) => m.id), [asked.id]);
      const wrongAsker = await lead.call("send", {
        to: "dev-2",
        kind: "answer",
        body: { answer: "x" },
        inReplyTo: asked.id,
      });
      assert(wrongAsker.isError); // the question was not dev-2's
      await lead.send("dev-1", "answer", { answer: "hello.txt" }, asked.id);

      const up = await lead.call("raise_question", { question: "May I use a library?" });
      assertEquals(up.data.sent.to, "overseer");
    });
    const [answer] = await asAgent(world, "dev-1", (w) => w.inbox());
    assertEquals([answer.kind, answer.inReplyTo], ["answer", asked.id]);
  },
  MANUAL,
);

withWorld(
  "the overseer has no one above to raise a question to; a leaderless worker neither",
  async (world) => {
    await world.kiln("session", "open", "overseer", "--role", "overseer");
    await world.kiln("session", "open", "lone-1", "--role", "worker", "--department", "ops");
    const up = await asAgent(world, "overseer", (a) => a.call("raise_question", { question: "?" }));
    assert(up.isError);
    assertStringIncludes(up.text, "no one above");
    const lone = await asAgent(world, "lone-1", (a) => a.call("raise_question", { question: "?" }));
    assert(lone.isError);
    assertStringIncludes(lone.text, 'Department "ops" has no leader');
  },
  MANUAL,
);

withWorld("messages are append-only and reading them does not change them", async (world) => {
  await openTeam(world);
  const sent = await asAgent(world, "dev-lead", (a) => a.send("dev-1", "assignment", assignment));
  await asAgent(world, "dev-1", (a) => a.inbox());
  const [after] = await messages(world);
  assertEquals([after.from, after.to, after.kind, after.body], [
    sent.from,
    sent.to,
    sent.kind,
    sent.body,
  ]);

  const db = new DatabaseSync(join(world.dirs.data, "kiln.db"));
  try {
    for (const sql of ["update messages set body = '{}'", "delete from messages"]) {
      let failure = "";
      try {
        db.exec(sql);
      } catch (err) {
        failure = (err as Error).message;
      }
      assertMatch(failure, /messages are append-only/);
    }
  } finally {
    db.close();
  }
}, MANUAL);

withWorld("sessions: one overseer, one leader per department, valid seats only", async (world) => {
  const open = (...args: string[]) => world.kiln("session", "open", ...args);
  assertEquals((await open("overseer", "--role", "overseer")).code, 0);
  assertEquals((await open("dev-lead", "--role", "leader", "--department", "dev")).code, 0);

  const refused = async (reason: string, ...args: string[]) => {
    const out = await open(...args);
    assertEquals(out.code, 1, out.stdout);
    assertStringIncludes(out.stderr, reason);
  };
  await refused("already an overseer", "boss", "--role", "overseer");
  await refused("already has a leader", "dev-lead-2", "--role", "leader", "--department", "dev");
  await refused("already open", "dev-lead", "--role", "worker", "--department", "dev");
  await refused("needs a department", "dev-1", "--role", "worker");
  await refused("no department", "boss", "--role", "overseer", "--department", "dev");
  await refused("not a valid address", "Dev One", "--role", "worker", "--department", "dev");
  await refused("unknown role", "dev-1", "--role", "janitor", "--department", "dev");

  const list = JSON.parse((await world.kiln("session", "list", "--json")).stdout);
  assertEquals(list.map((s: { address: string }) => s.address), ["overseer", "dev-lead"]);
  assertEquals((await world.kiln("session", "open")).code, 2);
}, MANUAL);

withWorld("an agent cannot connect as a session that is not open", async (world) => {
  await openTeam(world);
  const out = await asAgent(world, "nobody", (a) => a.call("read_inbox"));
  assert(out.isError);
  assertStringIncludes(out.text, 'No session is open at "nobody"');
}, MANUAL);

withWorld("a nudge wakes the recipient with its Kiln tools and a Stop hook", async (world) => {
  await openTeam(world);
  await world.launcher.script([{ result: "ok" }]);
  await asAgent(world, "dev-lead", (a) => a.send("dev-1", "assignment", assignment));

  assertEquals(await tick(world), {
    nudged: [{ to: "dev-1", messages: 1 }],
    deadLettered: [],
  });
  const [prompt] = await world.launcher.prompts();
  assertStringIncludes(prompt, "1 unread message");
  assertStringIncludes(prompt, "read_inbox");

  const [call] = await world.launcher.calls();
  assertEquals(call.cwd, await Deno.realPath(world.project.path));
  const args = call.args.join(" ");
  assertStringIncludes(args, "tool-server");
  assertStringIncludes(args, "dev-1");
  assertStringIncludes(args, "mcp__kiln__read_inbox");
  assertStringIncludes(args, "hook");
  assertStringIncludes(args, "Stop");
}, MANUAL);

withWorld("one nudge covers all of an agent's unread messages", async (world) => {
  await openTeam(world);
  await asAgent(world, "dev-lead", async (lead) => {
    await lead.send("dev-1", "assignment", assignment);
    await lead.send("dev-1", "assignment", { ...assignment, title: "Another" });
    await lead.send("dev-2", "assignment", assignment);
  });
  await world.launcher.script([{ result: "ok" }, { result: "ok" }]);
  const result = await tick(world);
  assertEquals(result.nudged, [{ to: "dev-1", messages: 2 }, { to: "dev-2", messages: 1 }]);
  assertStringIncludes((await world.launcher.prompts())[0], "2 unread message");
}, MANUAL);

withWorld("a message that has been read is not nudged", async (world) => {
  await openTeam(world);
  await asAgent(world, "dev-lead", (a) => a.send("dev-1", "assignment", assignment));
  await asAgent(world, "dev-1", (a) => a.inbox());
  assertEquals(await tick(world), { nudged: [], deadLettered: [] });
  assertEquals(await world.launcher.calls(), []);
  assertStringIncludes((await world.kiln("router", "tick")).stdout, "Nothing to deliver");
}, MANUAL);

withWorld("an unread message is nudged again only after the re-nudge interval", async (world) => {
  await openTeam(world);
  await world.launcher.script([{ result: "ok" }, { result: "ok" }]);
  await asAgent(world, "dev-lead", (a) => a.send("dev-1", "assignment", assignment));
  assertEquals((await tick(world)).nudged.length, 1);
  assertEquals((await tick(world)).nudged, []); // too soon
  assertEquals((await world.launcher.calls()).length, 1);
}, PATIENT);

withWorld("an unread message is re-nudged until it is read", async (world) => {
  await openTeam(world);
  await world.launcher.script([{ result: "ok" }, { result: "ok" }, { result: "ok" }]);
  await asAgent(world, "dev-lead", (a) => a.send("dev-1", "assignment", assignment));
  await tick(world);
  await tick(world);
  assertStringIncludes((await world.kiln("messages")).stdout, "unread, nudged 2x");
  await asAgent(world, "dev-1", (a) => a.inbox());
  assertEquals(await tick(world), { nudged: [], deadLettered: [] });
  assertEquals((await world.launcher.prompts()).length, 2);
}, MANUAL);

withWorld("a nudge that cannot launch still counts as a delivery", async (world) => {
  await openTeam(world);
  await asAgent(world, "dev-lead", (a) => a.send("dev-1", "assignment", assignment));
  // No scripted runs: the launcher fails every time.
  await tick(world);
  assertStringIncludes((await world.kiln("messages")).stdout, "unread, nudged 1x");
}, MANUAL);

withWorld(
  "an assignment unread after three nudges is dead-lettered and reported failed",
  async (world) => {
    await openTeam(world);
    await world.launcher.script([{ result: "ok" }, { result: "ok" }, { result: "ok" }]);
    const job = await asAgent(world, "dev-lead", (a) => a.send("dev-1", "assignment", assignment));
    for (let i = 0; i < 3; i++) assertEquals((await tick(world)).nudged.length, 1);
    assertEquals((await world.launcher.prompts()).length, 3);

    assertEquals(await tick(world), { nudged: [], deadLettered: [job.id] }); // no fourth nudge
    assertEquals((await world.launcher.prompts()).length, 3);

    const all = await messages(world);
    assertEquals(all.length, 2);
    const [dead, failure] = all;
    assertNotEquals(dead.deadLetteredAt, null);
    assertEquals(dead.deliveries, 3);
    assertEquals([failure.from, failure.to, failure.kind, failure.inReplyTo], [
      "dev-1",
      "dev-lead",
      "result",
      job.id,
    ]);
    assertEquals(failure.synthesised, true);
    assertEquals(failure.body.status, "failed");
    assertStringIncludes(String(failure.body.summary), "dead-lettered");

    // The leader sees the failure; the dead assignment is gone from the worker's inbox.
    assertEquals((await asAgent(world, "dev-lead", (a) => a.inbox())).map((m) => m.id), [
      failure.id,
    ]);
    assertEquals(await asAgent(world, "dev-1", (a) => a.inbox()), []);
    assertStringIncludes((await world.kiln("messages")).stdout, "(synthesised)");
  },
  MANUAL,
);

withWorld("other kinds of message are dead-lettered quietly", async (world) => {
  await openTeam(world);
  await world.launcher.script([{ result: "ok" }, { result: "ok" }, { result: "ok" }]);
  const q = await asAgent(world, "dev-1", (a) => a.call("raise_question", { question: "?" }));
  for (let i = 0; i < 3; i++) await tick(world);
  assertEquals((await tick(world)).deadLettered, [q.data.sent.id]);
  assertEquals((await messages(world)).length, 1); // no synthesised message
}, MANUAL);

withWorld("a read stops the dead-letter countdown", async (world) => {
  await openTeam(world);
  await world.launcher.script([{ result: "ok" }, { result: "ok" }, { result: "ok" }]);
  await asAgent(world, "dev-lead", (a) => a.send("dev-1", "assignment", assignment));
  await tick(world);
  await tick(world);
  await tick(world);
  await asAgent(world, "dev-1", (a) => a.inbox());
  assertEquals(await tick(world), { nudged: [], deadLettered: [] });
  assertEquals((await messages(world)).length, 1);
}, MANUAL);

withWorld("the Stop hook sends an agent back to its unread inbox", async (world) => {
  await openTeam(world);
  await asAgent(world, "dev-lead", (a) => a.send("dev-1", "assignment", assignment));
  const block = await stopHook(world, "dev-1");
  assertEquals(block?.decision, "block");
  assertStringIncludes(block!.reason, "unread message");
  assertStringIncludes(block!.reason, "read_inbox");
  assertEquals(await stopHook(world, "dev-lead"), null); // nothing waiting for the leader
}, MANUAL);

withWorld("the Stop hook insists on a report for an open assignment", async (world) => {
  await openTeam(world);
  const job = await asAgent(world, "dev-lead", (a) => a.send("dev-1", "assignment", assignment));
  await asAgent(world, "dev-1", async (worker) => {
    await worker.inbox();
    const block = await stopHook(world, "dev-1");
    assertEquals(block?.decision, "block");
    assertStringIncludes(block!.reason, `assignment ${job.id}`);
    assertStringIncludes(block!.reason, "result");

    await worker.send("dev-lead", "result", { status: "done", summary: "done" }, job.id);
  });
  assertEquals(await stopHook(world, "dev-1"), null); // reported: free to stop
  assertEquals((await messages(world)).filter((m) => m.synthesised), []);
}, MANUAL);

withWorld("the Stop hook lets an agent stop while it waits for an answer", async (world) => {
  await openTeam(world);
  await asAgent(world, "dev-lead", (a) => a.send("dev-1", "assignment", assignment));
  await asAgent(world, "dev-1", async (worker) => {
    await worker.inbox();
    await worker.call("raise_question", { question: "Which file?" });
  });
  assertEquals(await stopHook(world, "dev-1"), null);
}, MANUAL);

withWorld("an agent that stops anyway is reported failed on its behalf", async (world) => {
  await openTeam(world);
  const job = await asAgent(world, "dev-lead", (a) => a.send("dev-1", "assignment", assignment));
  await asAgent(world, "dev-1", (a) => a.inbox());
  assertEquals((await stopHook(world, "dev-1"))?.decision, "block");
  assertEquals(await stopHook(world, "dev-1", true), null); // second attempt: allowed through

  const failure = (await messages(world)).find((m) => m.synthesised)!;
  assertEquals([failure.from, failure.to, failure.inReplyTo], ["dev-1", "dev-lead", job.id]);
  assertEquals(failure.body.status, "failed");
  assertStringIncludes(String(failure.body.summary), "stopped without reporting");

  assertEquals(await stopHook(world, "dev-1", true), null); // reported now: nothing more to add
  assertEquals((await messages(world)).filter((m) => m.synthesised).length, 1);
}, MANUAL);

withWorld("the Stop hook rejects an unknown address without blocking anything", async (world) => {
  const out = await world.kilnWithInput("{}", "hook", "stop", "--address", "ghost");
  assertEquals(out.code, 1);
  assertStringIncludes(out.stderr, 'No session is open at "ghost"');
  assertEquals(out.stdout, "");
}, MANUAL);

withWorld("the daemon delivers on its own timer", async (world) => {
  await openTeam(world);
  await world.launcher.script([{ result: "ok" }]);
  await asAgent(world, "dev-lead", (a) => a.send("dev-1", "assignment", assignment));
  for (let i = 0; i < 100 && !(await world.launcher.prompts()).length; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assertStringIncludes((await world.launcher.prompts())[0] ?? "", "1 unread message");
}, { KILN_ROUTER_TICK_MS: "100", KILN_RENUDGE_AFTER_MS: "3600000" });
