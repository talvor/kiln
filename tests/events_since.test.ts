// `events.since`: the event feed a client long-polls, driven over the real daemon's socket.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { rawCall } from "./helpers.ts";
import { withWorld, type World } from "./world.ts";
import { asAgent } from "./router_helpers.ts";

interface Feed {
  events: {
    id: number;
    ts: string;
    kind: string;
    data: Record<string, unknown>;
    requestId: number | null;
  }[];
  last: number;
}

const since = async (world: World, params: Record<string, unknown>): Promise<Feed> => {
  const r = await rawCall(world, "events.since", params);
  assert(r.ok, r.error);
  return r.result as Feed;
};

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

const raise = (world: World, args: Record<string, unknown>) =>
  asAgent(world, "overseer", (agent) => agent.call("raise_escalation", args));

withWorld(
  "events.since returns at once with events, each carrying a resolved requestId",
  async (world) => {
    await startRequest(world);
    const began = Date.now();
    const feed = await since(world, { after: 0, waitMs: 20_000 });
    assert(Date.now() - began < 5_000, "should not wait when events exist");
    assert(feed.events.length > 0);
    assertEquals(
      feed.events.map((e) => e.id),
      [...feed.events.map((e) => e.id)].sort((a, b) => a - b),
    );
    assertEquals(feed.last, feed.events.at(-1)!.id);
    for (const e of feed.events) {
      assert(e.requestId === null || typeof e.requestId === "number", e.kind);
    }
    assertEquals(feed.events.find((e) => e.kind === "daemon.started")!.requestId, null);
    assertEquals(feed.events.find((e) => e.kind === "request.started")!.requestId, 1);

    // A cursor past some events returns only the later ones; kinds narrows them.
    const first = feed.events[0].id;
    const rest = await since(world, { after: first, waitMs: 0 });
    assertEquals(rest.events.map((e) => e.id), feed.events.slice(1).map((e) => e.id));
    const only = await since(world, { after: 0, kinds: ["request.started"], waitMs: 0 });
    assertEquals(only.events.map((e) => e.kind), ["request.started"]);
  },
);

withWorld("events.since returns empty after waitMs, and wakes on a new event", async (world) => {
  await startRequest(world);
  const { last } = await since(world, { after: 0, waitMs: 0 });

  const began = Date.now();
  const idle = await since(world, { after: last, waitMs: 300 });
  assertEquals(idle.events, []);
  assertEquals(idle.last, last);
  assert(Date.now() - began >= 250, "should hold for waitMs");

  const waiting = since(world, { after: last, kinds: ["escalation.raised"], waitMs: 20_000 });
  await new Promise((r) => setTimeout(r, 300));
  const t = Date.now();
  await raise(world, { summary: "Widen the fix?", requestId: 1 });
  const woke = await waiting;
  assert(Date.now() - t < 5_000, "should wake on the event, not at waitMs");
  assertEquals(woke.events.map((e) => [e.kind, e.requestId]), [["escalation.raised", 1]]);
  assertEquals(woke.last, woke.events[0].id);

  // Another client is not held up by a waiting one.
  const hold = since(world, { after: woke.last, waitMs: 1_000 });
  assertEquals((await rawCall(world, "status")).ok, true);
  await hold;
});

withWorld("events.since refuses a malformed cursor", async (world) => {
  assertEquals((await world.kiln("project", "list")).code, 0); // starts the daemon
  for (
    const params of [{ after: -1 }, { after: "x" }, { after: 0, waitMs: -5 }, {
      after: 0,
      kinds: "a",
    }]
  ) {
    const r = await rawCall(world, "events.since", params);
    assertEquals([r.ok, r.code], [false, "invalid"], JSON.stringify(params));
  }
});
