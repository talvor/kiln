// The Needs you list: what waits on the user. Open Escalations grouped by Project, oldest first;
// stale ones (their Request ended) kept apart because they cannot be acted on.
import type { EscalationView } from "./escalations.ts";

export interface NeedsYouItem {
  id: number;
  gate: string | null;
  requestId: number | null;
  project: string | null;
  summary: string;
  detail: string | null;
  createdAt: string;
}
export interface NeedsYou {
  /** How many open Escalations wait: what the tab title carries. Stale ones do not count. */
  count: number;
  /** Groups ordered by their oldest Escalation; a null project holds those with no Request. */
  groups: { project: string | null; items: NeedsYouItem[] }[];
  stale: NeedsYouItem[];
}

const oldestFirst = (a: NeedsYouItem, b: NeedsYouItem) =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id;

export function needsYou(
  escalations: EscalationView[],
  requests: { id: number; project: string }[],
): NeedsYou {
  const projectOf = new Map(requests.map((r) => [r.id, r.project]));
  const item = (e: EscalationView): NeedsYouItem => ({
    id: e.id,
    gate: e.gate,
    requestId: e.requestId,
    project: e.requestId === null ? null : projectOf.get(e.requestId) ?? null,
    summary: e.summary,
    detail: e.detail,
    createdAt: e.createdAt,
  });
  const open = escalations.filter((e) => e.status === "open").map(item).sort(oldestFirst);
  const stale = escalations.filter((e) => e.status === "stale").map(item).sort(oldestFirst);
  const groups = new Map<string | null, NeedsYouItem[]>();
  for (const i of open) groups.set(i.project, [...(groups.get(i.project) ?? []), i]);
  return {
    count: open.length,
    // Map keeps insertion order, and `open` is sorted, so the oldest group is first.
    groups: [...groups].map(([project, items]) => ({ project, items })),
    stale,
  };
}
