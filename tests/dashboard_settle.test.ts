// Settling Escalations from the Dashboard: the real `kiln dashboard --no-open` against the real
// daemon, over HTTP.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { readLines, writeJson } from "../src/protocol.ts";
import { withWorld, type World } from "./world.ts";
import { asAgent, openTeam } from "./router_helpers.ts";

const raise = (world: World, summary: string) =>
  asAgent(world, "overseer", (agent) => agent.call("raise_escalation", { summary }));

interface Decided {
  id: number;
  decision: string;
  reason: string | null;
  decidedAt: string;
  source: string | null;
}

const decide = (
  d: Awaited<ReturnType<World["dashboard"]>>,
  cookie: string,
  id: number,
  b: unknown,
) =>
  d.fetch(`/api/escalations/${id}/decide`, {
    method: "POST",
    cookie,
    origin: d.origin,
    body: JSON.stringify(b),
  });

const decided = async (d: Awaited<ReturnType<World["dashboard"]>>, cookie: string) =>
  (await (await d.fetch("/api/needs-you", { cookie })).json()).decided as Decided[];

withWorld("approve settles in one click and records Source dashboard", async (w) => {
  await openTeam(w);
  await raise(w, "Ship it?");
  const d = await w.dashboard();
  const cookie = await d.signIn();
  const res = await decide(d, cookie, 1, { approved: true });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
  const [only] = await decided(d, cookie);
  assertEquals([only.id, only.decision, only.source], [1, "approved", "dashboard"]);
  // Decisions are final: the daemon's refusal is shown, not hidden.
  const again = await decide(d, cookie, 1, { approved: true });
  assertEquals(again.status, 409);
  const refusal = await again.json();
  assertEquals(refusal.ok, false);
  assertEquals(typeof refusal.error, "string");
});

withWorld("reject requires a reason and shows it in Recently decided", async (w) => {
  await openTeam(w);
  await raise(w, "Ship it?");
  const d = await w.dashboard();
  const cookie = await d.signIn();
  const bare = await decide(d, cookie, 1, { approved: false, reason: "  " });
  assertEquals(bare.status, 400);
  assertStringIncludes((await bare.json()).error, "reason");
  assertEquals(await decided(d, cookie), []);
  assertEquals((await decide(d, cookie, 1, { approved: false, reason: "Too risky" })).status, 200);
  const [only] = await decided(d, cookie);
  assertEquals([only.decision, only.reason, only.source], ["rejected", "Too risky", "dashboard"]);
});

withWorld("Recently decided keeps the last 20, newest first", async (w) => {
  await openTeam(w);
  for (let i = 1; i <= 21; i++) await raise(w, `Question ${i}`);
  const d = await w.dashboard();
  const cookie = await d.signIn();
  for (let i = 1; i <= 21; i++) {
    await (await decide(d, cookie, i, { approved: true })).body?.cancel();
  }
  const list = await decided(d, cookie);
  assertEquals(list.length, 20);
  assertEquals(list[0].id, 21);
  assertEquals(list.every((entry) => entry.source === "dashboard"), true);
});

withWorld("Recently decided uses decision order when timestamps tie", async (w) => {
  await Deno.mkdir(w.dirs.runtime, { recursive: true });
  const listener = Deno.listen({ transport: "unix", path: join(w.dirs.runtime, "kiln.sock") });
  const at = "2026-01-01T00:00:00.000Z";
  const order = [2, 1, ...Array.from({ length: 19 }, (_, i) => i + 3)];
  const escalations = order.map((id) => ({
    id,
    status: "approved",
    summary: `Question ${id}`,
    reason: null,
    decidedAt: at,
  }));
  const events = order.map((id, index) => ({
    id: index + 1,
    data: { id, via: "cli" },
  }));
  const serving = (async () => {
    for await (const conn of listener) {
      (async () => {
        try {
          for await (const line of readLines(conn)) {
            const request = JSON.parse(line);
            const result = request.method === "escalations.list" ? escalations
              : request.method === "requests.list" ? []
              : { events, last: 21 };
            await writeJson(conn, { id: request.id, ok: true, result });
            break;
          }
        } finally {
          try {
            conn.close();
          } catch {}
        }
      })().catch(() => {});
    }
  })();
  try {
    const d = await w.dashboard();
    const cookie = await d.signIn();
    const list = await decided(d, cookie);
    assertEquals(list.map((entry) => entry.id), [...order].reverse().slice(0, 20));
    assertEquals(list.every((entry) => entry.source === "cli"), true);
  } finally {
    listener.close();
    await serving.catch(() => {});
  }
});

withWorld("a wrong Origin cannot decide", async (w) => {
  await openTeam(w);
  await raise(w, "Ship it?");
  const d = await w.dashboard();
  const cookie = await d.signIn();
  const res = await d.fetch("/api/escalations/1/decide", {
    method: "POST",
    cookie,
    origin: "http://evil.example",
    body: JSON.stringify({ approved: true }),
  });
  assertEquals(res.status, 403);
  await res.body?.cancel();
  assertEquals(await decided(d, cookie), []);
});
