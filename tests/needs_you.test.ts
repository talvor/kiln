// The Needs you list: open Escalations grouped by Project, oldest first; stale ones apart.
import { assertEquals } from "@std/assert";
import { needsYou } from "../src/needs_you.ts";
import type { EscalationView } from "../src/escalations.ts";

let next = 1;
const esc = (over: Partial<EscalationView>): EscalationView => ({
  id: next++,
  raisedBy: "overseer",
  requestId: null,
  summary: "s",
  detail: null,
  status: "open",
  reason: null,
  stepId: null,
  gate: null,
  gateMessageId: null,
  questionId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  decidedAt: null,
  ...over,
});

Deno.test("groups open Escalations by Project, oldest first, and counts only the open ones", () => {
  const list = [
    esc({ id: 1, requestId: 10, createdAt: "2026-01-02T00:00:00Z", gate: "qa-passed" }),
    esc({ id: 2, requestId: 20, createdAt: "2026-01-01T00:00:00Z" }),
    esc({ id: 3, requestId: 10, createdAt: "2026-01-01T12:00:00Z" }),
    esc({ id: 4, requestId: 10, createdAt: "2026-01-01T00:00:00Z", status: "stale" }),
    esc({ id: 5, requestId: 10, status: "approved" }),
    esc({ id: 6, requestId: 10, status: "rejected" }),
  ];
  const view = needsYou(list, [{ id: 10, project: "alpha" }, { id: 20, project: "beta" }]);
  assertEquals(view.count, 3);
  assertEquals(
    view.groups.map((g) => [g.project, g.items.map((i) => i.id)]),
    [["beta", [2]], ["alpha", [3, 1]]], // the group holding the oldest Escalation comes first
  );
  assertEquals(view.groups[1].items[1].gate, "qa-passed");
  assertEquals(view.groups[1].items[1].requestId, 10);
  assertEquals(view.stale.map((i) => i.id), [4]);
  assertEquals(view.stale[0].project, "alpha");
});

Deno.test("an Escalation with no Request, or an unknown one, has no Project", () => {
  const view = needsYou([esc({ id: 1 }), esc({ id: 2, requestId: 99 })], []);
  assertEquals(view.groups.map((g) => [g.project, g.items.length]), [[null, 2]]);
});

Deno.test("nothing waiting gives an empty list", () => {
  assertEquals(needsYou([], []), { count: 0, groups: [], stale: [] });
});
