// What happened to the user's work, in words: the news the Overseer opens a chat with and the
// daily digest tells. Pure: events in, sentences out.
import type { EventRecord } from "./store.ts";

/** Events that tell the user something happened to their work. */
export const NEWS_EVENTS = [
  "request.done",
  "step.failed",
  "step.escalated",
  "breakdown.approved",
  "pr.ready",
  "agent.stuck",
  "budget.request_warned",
  "budget.request_blocked",
  "budget.day_warned",
  "budget.day_capped",
];

export const money = (usd: number): string => `$${usd.toFixed(2)}`;

interface NewsData {
  id?: number;
  url?: string;
  request?: number;
  why?: string;
  tickets?: string[];
  address?: string;
  costUsd?: number;
  spendUsd?: number;
  budgetUsd?: number;
  capUsd?: number;
}

/** The sentence for an event in NEWS_EVENTS. */
export function describeNews(e: EventRecord): string {
  const d = e.data as NewsData;
  switch (e.kind) {
    case "agent.stuck":
      return `${d.address} is stuck: ${d.why}. Kiln has stopped waking it; the user can type "kiln resume" to try again.`;
    case "breakdown.approved":
      return `Request ${d.request}: the Overseer approved the breakdown of the spec into ${
        d.tickets?.length ?? 0
      } ticket(s): ${(d.tickets ?? []).join(", ")}.`;
    case "pr.ready":
      return `Request ${d.request}: pull request ${d.url} passed QA and is ready for you to review.`;
    case "request.done":
      return `Request ${d.id} finished.` +
        (d.costUsd === undefined ? "" : ` It cost ${money(d.costUsd)}.`);
    case "step.failed":
      return `Request ${d.request} failed: ${d.why ?? "a step failed"}.`;
    case "budget.request_warned":
      return `${budgetWarning(d.request, d.spendUsd, d.budgetUsd)}`;
    case "budget.request_blocked":
      return `Request ${d.request} is blocked on the user: it used its ${
        money(d.budgetUsd ?? 0)
      } budget (${money(d.spendUsd ?? 0)} spent). Approve to give it another budget's worth.`;
    case "budget.day_warned":
      return dailyWarning(d.spendUsd, d.capUsd);
    case "budget.day_capped":
      return dailyCapReached(d.spendUsd, d.capUsd);
    default:
      return `Request ${d.request} needs the user's attention (a step was escalated).`;
  }
}

export const budgetWarning = (request?: number, spent = 0, budget = 0): string =>
  `Request ${request} has used 80% of its ${money(budget)} budget (${money(spent)} so far).`;
export const dailyWarning = (spent = 0, cap = 0): string =>
  `Today's spend has reached 80% of the ${money(cap)} daily cap (${money(spent)} so far).`;
export const dailyCapReached = (spent = 0, cap = 0): string =>
  `The ${money(cap)} daily cap is reached (${money(spent)} spent today). Kiln has stopped ` +
  `waking agents until the cap is raised or the day ends.`;
