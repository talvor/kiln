// The Dashboard's Needs you list, live: the real `kiln dashboard --no-open` against the real
// daemon, over HTTP.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withWorld, type World } from "./world.ts";
import { asAgent, openTeam } from "./router_helpers.ts";

const raise = (world: World, args: Record<string, unknown>) =>
  asAgent(world, "overseer", (agent) => agent.call("raise_escalation", args));

interface Item {
  id: number;
  summary: string;
  detail: string | null;
  gate: string | null;
  project: string | null;
  createdAt: string;
}
interface NeedsYou {
  running: boolean;
  count: number;
  groups: { project: string | null; items: Item[] }[];
  stale: Item[];
}

withWorld("Needs you lists the open Escalations, oldest first, detail kept verbatim", async (w) => {
  await openTeam(w);
  assertEquals(
    (await raise(w, { summary: "First", detail: "<b>bold</b>\n  # not a heading" })).isError,
    false,
  );
  assertEquals((await raise(w, { summary: "Second" })).isError, false);
  const d = await w.dashboard();
  const cookie = await d.signIn();
  const res = await d.fetch("/api/needs-you", { cookie });
  assertEquals(res.status, 200);
  const view: NeedsYou = await res.json();
  assertEquals(view.running, true);
  assertEquals(view.count, 2);
  assertEquals(view.groups.length, 1);
  assertEquals(view.groups[0].items.map((i) => i.summary), ["First", "Second"]);
  // The detail travels as plain data: the whitespace is kept, and nothing is rendered.
  assertEquals(view.groups[0].items[0].detail, "<b>bold</b>\n  # not a heading");
  assertEquals(view.stale, []);
});

withWorld(
  "each view has its own URL that serves the page; the script is behind the cookie",
  async (w) => {
    const d = await w.dashboard();
    const cookie = await d.signIn();
    for (const path of ["/", "/escalations/12"]) {
      const res = await d.fetch(path, { cookie });
      assertEquals(res.status, 200, path);
      assertStringIncludes(await res.text(), "<title>Kiln</title>");
    }
    const bad = await d.fetch("/escalations/abc", { cookie });
    assertEquals(bad.status, 404);
    await bad.body?.cancel();
    const anon = await d.fetch("/app.js");
    assertEquals(anon.status, 403);
    await anon.body?.cancel();
  },
);

withWorld("with no daemon Needs you is empty and says Kiln is not running", async (w) => {
  const d = await w.dashboard();
  const cookie = await d.signIn();
  const view: NeedsYou = await (await d.fetch("/api/needs-you", { cookie })).json();
  assertEquals([view.running, view.count, view.groups, view.stale], [false, 0, [], []]);
});

/** Read an event stream until `done` accepts what has arrived. */
async function readUntil(res: Response, done: (text: string) => boolean): Promise<string> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  const timer = setTimeout(() => reader.cancel(), 15_000);
  try {
    while (!done(text)) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      text += value;
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  return text;
}

withWorld("the event stream announces a change when something happens in Kiln", async (w) => {
  await openTeam(w);
  const d = await w.dashboard();
  const cookie = await d.signIn();
  const stream = await d.fetch("/events", { cookie });
  assertEquals(stream.status, 200);
  assertStringIncludes(stream.headers.get("content-type") ?? "", "text/event-stream");
  const reading = readUntil(stream, (t) => t.includes("event: changed"));
  await new Promise((r) => setTimeout(r, 1000)); // the long-poll is waiting on the daemon
  assertEquals((await raise(w, { summary: "Ship it?" })).isError, false);
  assertStringIncludes(await reading, "event: changed");
  const view: NeedsYou = await (await d.fetch("/api/needs-you", { cookie })).json();
  assertEquals(view.count, 1);
});

withWorld("the first events.since response also announces a change", async (w) => {
  await Deno.mkdir(w.dirs.runtime, { recursive: true });
  const listener = Deno.listen({ transport: "unix", path: join(w.dirs.runtime, "kiln.sock") });
  const serving = (async () => {
    for await (const conn of listener) {
      const buf = new Uint8Array(65536);
      await conn.read(buf);
      await conn.write(new TextEncoder().encode(JSON.stringify({
        id: 1,
        ok: true,
        result: { events: [{ id: 1 }], last: 1 },
      }) + "\n"));
      conn.close();
    }
  })();
  try {
    const d = await w.dashboard();
    const cookie = await d.signIn();
    const stream = await d.fetch("/events", { cookie });
    assertStringIncludes(await readUntil(stream, (text) => text.includes("event: changed")),
      "event: changed\ndata: 1");
  } finally {
    listener.close();
    await serving.catch(() => {});
  }
});

withWorld("events.since runs only while an event stream is connected", async (w) => {
  // Stand in for the daemon and write down every method it is asked.
  await Deno.mkdir(w.dirs.runtime, { recursive: true });
  const listener = Deno.listen({ transport: "unix", path: join(w.dirs.runtime, "kiln.sock") });
  const asked: string[] = [];
  (async () => {
    for await (const conn of listener) {
      (async () => {
        const buf = new Uint8Array(65536);
        const n = await conn.read(buf);
        const req = JSON.parse(new TextDecoder().decode(buf.subarray(0, n ?? 0)));
        asked.push(req.method);
        if (req.method === "events.since") await new Promise((r) => setTimeout(r, 300));
        const result = req.method === "events.since" ? { events: [], last: 0 } : [];
        await conn.write(
          new TextEncoder().encode(JSON.stringify({ id: 1, ok: true, result }) + "\n"),
        );
        conn.close();
      })().catch(() => {});
    }
  })().catch(() => {});
  const polls = () => asked.filter((m) => m === "events.since").length;
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const d = await w.dashboard();
    const cookie = await d.signIn();
    await settle(1000);
    assertEquals(polls(), 0, "no client, no long-poll");
    const a = await d.fetch("/events", { cookie });
    const b = await d.fetch("/events", { cookie });
    await settle(1500);
    assert(polls() > 0, "a connected client starts the long-poll");
    await a.body?.cancel();
    const withOne = polls();
    await settle(1500);
    assert(polls() > withOne, "one client left, still polling");
    await b.body?.cancel();
    await settle(1000); // let an in-flight poll finish
    const stopped = polls();
    await settle(1500);
    assertEquals(polls(), stopped, "the last client left, the long-poll stopped");
  } finally {
    listener.close();
  }
});
