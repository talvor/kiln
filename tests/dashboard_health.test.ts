// The Dashboard's Health view over HTTP against the real daemon: the daemon's facts, and the
// doctor run on demand by the dashboard itself.
import { assert, assertEquals } from "@std/assert";
import { withWorld } from "./world.ts";
import { openTeam } from "./router_helpers.ts";

withWorld("the Health view has its own address and reports the daemon", async (w) => {
  await openTeam(w);
  const d = await w.dashboard();
  const cookie = await d.signIn();
  const page = await d.fetch("/health", { cookie });
  assertEquals(page.status, 200);
  assert((await page.text()).includes("<main"));
  const h = await (await d.fetch("/api/health", { cookie })).json();
  assertEquals(h.running, true);
  assert(typeof h.pid === "number" && typeof h.version === "string");
  assert(!Number.isNaN(Date.parse(h.startedAt)));
  assertEquals([h.haltedSince, h.stuck, h.faults, h.paused], [null, [], [], []]);
  await d.fetch("/api/halt", { method: "POST", cookie, origin: d.origin });
  assert((await (await d.fetch("/api/health", { cookie })).json()).haltedSince !== null);
});

withWorld("the dashboard runs the doctor checks on demand, and only when asked", async (w) => {
  await openTeam(w);
  const d = await w.dashboard();
  const cookie = await d.signIn();
  assertEquals((await d.fetch("/api/doctor", { cookie })).status, 404); // a GET runs nothing
  assertEquals((await d.fetch("/api/doctor", { method: "POST", cookie })).status, 403);
  const res = await d.fetch("/api/doctor", { method: "POST", cookie, origin: d.origin });
  assertEquals(res.status, 200);
  const out = await res.json();
  assertEquals(out.ok, true);
  const names = out.checks.map((c: { name: string }) => c.name);
  assert(names.includes("git") && names.includes("sqlite"));
});
