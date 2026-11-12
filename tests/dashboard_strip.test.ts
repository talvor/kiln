// The Dashboard's header strip: conditions and spend from `health.report`, and Halt and Resume
// over HTTP against the real daemon.
import { assert, assertEquals } from "@std/assert";
import { rawCall } from "./helpers.ts";
import { withWorld, type World } from "./world.ts";
import { openTeam } from "./router_helpers.ts";

type D = Awaited<ReturnType<World["dashboard"]>>;
interface Strip {
  haltedSince: string | null;
  capUsd: number | null;
  todayUsd: number;
  capReached: boolean;
  stuck: number;
}
const strip = async (d: D, cookie: string) =>
  (await (await d.fetch("/api/needs-you", { cookie })).json()).strip as Strip;
const post = (d: D, cookie: string, path: string) =>
  d.fetch(path, { method: "POST", cookie, origin: d.origin });
const sources = async (w: World, kind: string) => {
  const r = await rawCall(w, "events.since", { after: 0, waitMs: 0, kinds: [kind] });
  return (r.result as { events: { data: { via?: string } }[] }).events.map((e) => e.data.via);
};

withWorld("the strip is quiet when nothing is wrong", async (w) => {
  await openTeam(w);
  const d = await w.dashboard();
  const cookie = await d.signIn();
  const s = await strip(d, cookie);
  assertEquals([s.haltedSince, s.capReached, s.stuck, s.todayUsd], [null, false, 0, 0]);
});

withWorld("Halt and Resume work in one click and record Source dashboard", async (w) => {
  await openTeam(w);
  const d = await w.dashboard();
  const cookie = await d.signIn();
  const halted = await post(d, cookie, "/api/halt");
  assertEquals(halted.status, 200);
  assertEquals((await halted.json()).ok, true);
  assert((await strip(d, cookie)).haltedSince !== null);
  assertEquals(await sources(w, "kiln.halted"), ["dashboard"]);
  const resumed = await post(d, cookie, "/api/resume");
  assertEquals(resumed.status, 200);
  assertEquals((await strip(d, cookie)).haltedSince, null);
  assertEquals(await sources(w, "kiln.resumed"), ["dashboard"]);
});

withWorld(
  "Halt and Resume are refused without the session cookie or the right Origin",
  async (w) => {
    await openTeam(w);
    const d = await w.dashboard();
    const cookie = await d.signIn();
    assertEquals((await d.fetch("/api/halt", { method: "POST", origin: d.origin })).status, 403);
    assertEquals((await d.fetch("/api/halt", { method: "POST", cookie })).status, 403);
    assertEquals((await strip(d, cookie)).haltedSince, null);
  },
);

withWorld("/api/cost passes on the daemon's cost report and needs the session", async (w) => {
  await openTeam(w);
  const d = await w.dashboard();
  assertEquals((await d.fetch("/api/cost")).status, 403);
  const cookie = await d.signIn();
  const out = await (await d.fetch("/api/cost", { cookie })).json();
  assertEquals(out.running, true);
  assertEquals(out.cost, (await rawCall(w, "cost.report", {})).result);
  assertEquals((await d.fetch("/cost", { cookie })).status, 200);
});
