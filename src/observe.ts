// Looking at a Request without changing it: the events of its life (`kiln watch`), the Messages
// its agents sent each other (`kiln transcript`) and a summary of how it went (`kiln report`).
// Reads the store; nothing here writes.
import { money } from "./news.ts";
import type { EventRecord, RequestRecord, State, Store } from "./store.ts";

export interface RequestEvent {
  id: number;
  ts: string;
  kind: string;
  text: string;
}

/** What belongs to one Request: the Messages of its Steps and Assignments, and the Assignments. */
function scopeOf(store: Store, requestId: number) {
  const messages = store.listMessages();
  const events = store.listEvents(0);
  const assignments = new Set(store.listAssignments(requestId).map((a) => a.id));
  const mine = new Set<number>(assignments);
  const workers = new Set<string>();
  for (const step of store.listSteps(requestId)) {
    if (step.messageId !== null) mine.add(step.messageId);
    if (step.worker) workers.add(step.worker);
  }
  for (const e of events) {
    if (e.data.request === requestId && typeof e.data.message === "number") {
      mine.add(e.data.message);
    }
    if (e.data.request === requestId && typeof e.data.worker === "string") {
      workers.add(e.data.worker);
    }
  }
  for (const id of assignments) {
    const m = store.getMessage(id);
    if (m) workers.add(m.to);
  }
  // A worker's address is its own: everything to or from it is about this Request's work.
  for (const m of messages) {
    if (workers.has(m.to) || workers.has(m.from)) mine.add(m.id);
  }
  // Replies, relays and questions about what is already in.
  for (let grew = true; grew;) {
    grew = false;
    for (const m of messages) {
      if (mine.has(m.id)) continue;
      const related = [m.inReplyTo, m.relayOf, m.assignmentId].some((id) =>
        id !== null && mine.has(id)
      );
      if (related) {
        mine.add(m.id);
        grew = true;
      }
    }
  }
  return { messages: messages.filter((m) => mine.has(m.id)), ids: mine, assignments, events };
}

/** The Request an event is about, if it is about one. */
function requestOf(store: Store, e: EventRecord, scoped: ReturnType<typeof scopeOf>, id: number) {
  const d = e.data;
  if (d.request === id) return true;
  if (e.kind.startsWith("request.")) return d.id === id || d.fix === id;
  if (e.kind.startsWith("assignment.")) {
    return typeof d.id === "number" && scoped.assignments.has(d.id);
  }
  if (e.kind === "message.sent" || e.kind === "message.dead_lettered") {
    return typeof d.id === "number" && scoped.ids.has(d.id);
  }
  if (e.kind.startsWith("escalation.") && typeof d.id === "number") {
    try {
      return store.getEscalation(d.id).requestId === id;
    } catch {
      return false;
    }
  }
  return false;
}

const END_KINDS = ["request.done", "request.cancelled", "step.failed"];

/** The events of a Request after `after`, in words, and whether it has ended. */
export function requestEvents(store: Store, requestId: number, after: number) {
  const request = store.getRequest(requestId);
  const scoped = scopeOf(store, requestId);
  const events = scoped.events
    .filter((e) => e.id > after && requestOf(store, e, scoped, requestId))
    .map((e): RequestEvent => ({ id: e.id, ts: e.ts, kind: e.kind, text: describeEvent(e) }));
  return {
    events,
    last: store.lastEventId(),
    status: request.status as State,
    failure: request.failure,
  };
}

export function describeEvent(e: EventRecord): string {
  const d = e.data as Record<string, unknown>;
  const s = (k: string) => String(d[k] ?? "");
  switch (e.kind) {
    case "request.started":
      return `The request started on the ${s("playbook")} playbook.`;
    case "request.done":
      return `The request finished.` +
        (typeof d.costUsd === "number" ? ` It cost ${money(d.costUsd)}.` : "");
    case "request.cancelled":
      return "The request was cancelled.";
    case "request.cleaned_up":
      return "Kiln cleaned up the request's worktrees and branches.";
    case "request.cleanup_incomplete":
      return "Kiln could not clean up everything the request left.";
    case "request.fix-started":
      return `A fix request, ${s("fix")}, started from the ticket.`;
    case "request.fix-failed":
      return `The fix request could not be started: ${s("error")}`;
    case "step.started":
      return `Step ${s("step")} began.`;
    case "step.done":
      return `Step ${s("step")} is done.`;
    case "step.failed":
      return `Step ${s("step")} failed: ${s("why")}`;
    case "step.rejected":
      return `Step ${s("step")} was rejected: ${s("feedback")}`;
    case "step.retried":
      return `Step ${s("step")} went back to its leader for another try.`;
    case "step.escalated":
      return `Step ${s("step")} was escalated to the user.`;
    case "step.findings_returned":
      return `Findings sent step ${s("step")} back for another round.`;
    case "gate.raised":
      return `A ${s("gate")} gate holds step ${s("step")} until you decide (escalation ${
        s("escalation")
      }).`;
    case "assignment.planned":
      return `Assignment ${s("id")} was planned.`;
    case "assignment.started":
      return `Assignment ${s("id")} started.`;
    case "assignment.merged":
      return `Assignment ${s("id")} was merged into the request branch.`;
    case "assignment.conflicted":
      return `Assignment ${s("id")} overlaps another assignment and waits.`;
    case "assignment.resumed":
      return `Assignment ${s("id")} was resumed after an interruption.`;
    case "assignment.limit_reached":
      return `Assignment ${s("id")} reached its ${s("limit")} limit and was stopped.`;
    case "message.sent":
      return `${s("from")} sent ${s("to")} ${
        ["assignment", "answer"].includes(s("kind")) ? "an" : "a"
      } ${s("kind")} (message ${s("id")}).`;
    case "message.dead_lettered":
      return `Message ${s("id")} to ${s("to")} was never read and was given up on.`;
    case "ticket.published":
      return `Ticket published: ${s("url")}`;
    case "ticket.closed":
      return `Ticket ${s("item")} was closed.`;
    case "breakdown.approved":
      return `The breakdown was approved: ${((d.tickets as string[]) ?? []).length} ticket(s).`;
    case "pr.opened":
      return `Pull request opened: ${s("url")}`;
    case "pr.commented":
      return `Kiln commented on the pull request ${s("url")}.`;
    case "pr.state":
      return `The pull request is ${s("state")}.`;
    case "escalation.raised":
      return `Escalation ${s("id")} was raised for you.`;
    case "escalation.decided":
      return `Escalation ${s("id")} was ${s("decision")}.${
        d.reason ? ` Reason: ${s("reason")}` : ""
      }`;
    case "budget.request_warned":
      return `The request used 80% of its ${money(Number(d.budgetUsd ?? 0))} budget.`;
    case "budget.request_blocked":
      return `The request used its ${money(Number(d.budgetUsd ?? 0))} budget and waits for you.`;
    case "budget.request_extended":
      return `The request was given a budget of ${money(Number(d.budgetUsd ?? 0))}.`;
    default:
      return e.kind;
  }
}

/** A Request's Messages, oldest first. */
export function requestTranscript(store: Store, requestId: number) {
  store.getRequest(requestId);
  return scopeOf(store, requestId).messages.map((m) => ({
    id: m.id,
    at: m.sentAt,
    from: m.from,
    to: m.to,
    kind: m.kind,
    synthesised: m.synthesised,
    inReplyTo: m.inReplyTo,
    body: m.body,
    deadLettered: m.deadLetteredAt !== null,
  }));
}
export type TranscriptMessage = ReturnType<typeof requestTranscript>[number];

export function describeTranscript(messages: TranscriptMessage[]): string {
  if (!messages.length) return "No messages were sent for this request.";
  return messages.map((m) => {
    const head = `[${m.at}] ${m.from} -> ${m.to}  ${m.kind} ${m.id}` +
      (m.inReplyTo === null ? "" : ` (in reply to ${m.inReplyTo})`) +
      (m.synthesised ? "  (written by Kiln)" : "") +
      (m.deadLettered ? "  (never read)" : "");
    const body = Object.entries(m.body).map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return `  ${key}: ${text.replaceAll("\n", "\n    ")}`;
    });
    return [head, ...body].join("\n");
  }).join("\n\n");
}

export interface ReportBase {
  id: number;
  project?: string;
  status: string;
  playbook: string | null;
  description: string | null;
  branch: string | null;
  ticketUrl: string | null;
  ticketUrls: string[];
  prUrl: string | null;
  failure: string | null;
  costUsd: number;
  budgetUsd: number | null;
}

/** How a Request went: what it was, how it ended, what it cost and what its steps reported. */
export function requestReport<T extends ReportBase>(store: Store, status: T) {
  const scoped = scopeOf(store, status.id);
  const mine = scoped.events.filter((e) => requestOf(store, e, scoped, status.id));
  const started = mine.find((e) => e.kind === "request.started")?.ts ?? null;
  const ended = status.status === "done" || status.status === "failed"
    ? mine.findLast((e) => END_KINDS.includes(e.kind))?.ts ?? null
    : null;
  const steps = store.listSteps(status.id).map((step) => {
    const result = step.messageId === null
      ? undefined
      : store.listMessages({ kind: "result", inReplyTo: step.messageId }).at(-1);
    const summary = result?.body.summary;
    return {
      position: step.position,
      name: step.spec.name,
      status: step.status,
      retries: step.retries,
      failure: step.failure,
      summary: typeof summary === "string" ? summary : null,
    };
  });
  const decidedVia = new Map<number, string>();
  for (const e of mine) {
    if (e.kind === "escalation.decided" && typeof e.data.via === "string") {
      decidedVia.set(Number(e.data.id), e.data.via);
    }
  }
  const escalations = store.listEscalations().filter((e) => e.requestId === status.id).map((e) => ({
    id: e.id,
    summary: e.summary,
    status: e.status,
    reason: e.reason,
    via: decidedVia.get(e.id) ?? null,
  }));
  return {
    ...status,
    startedAt: started,
    endedAt: ended,
    steps,
    escalations,
    limitsReached: store.listAssignments(status.id).filter((a) => a.limitReached).map((a) => ({
      id: a.id,
      limit: a.limitReached as string,
    })),
    messages: scoped.messages.length,
  };
}
export type RequestReport = ReturnType<typeof requestReport<ReportBase>>;

export function describeReport(r: RequestReport): string {
  const outcome = r.status === "done"
    ? "finished"
    : r.status === "failed"
    ? "failed"
    : `still ${r.status === "planned" ? "waiting to start" : "running"}`;
  const lines = [`Report on request ${r.id} (${r.project ?? "removed project"}): ${outcome}`];
  if (r.description) lines.push(`Description: ${r.description}`);
  if (r.playbook) lines.push(`Playbook: ${r.playbook}`);
  if (r.startedAt) lines.push(`Started: ${r.startedAt}`);
  if (r.endedAt) lines.push(`Ended: ${r.endedAt}`);
  lines.push(
    `Cost: ${money(r.costUsd)}${r.budgetUsd === null ? "" : ` of a ${money(r.budgetUsd)} budget`}`,
  );
  if (r.failure) lines.push(`Failure: ${r.failure}`);
  if (r.steps.length) lines.push("Steps:");
  for (const s of r.steps) {
    lines.push(
      `  ${s.position}. ${s.name}: ${s.status}${
        s.retries ? `, retried ${s.retries} time${s.retries === 1 ? "" : "s"}` : ""
      }`,
    );
    if (s.summary) lines.push(`     ${s.summary.replaceAll("\n", "\n     ")}`);
    if (s.failure) lines.push(`     Failure: ${s.failure}`);
  }
  for (const l of r.limitsReached) {
    lines.push(`Assignment ${l.id} was stopped at its ${l.limit} limit.`);
  }
  if (r.escalations.length) lines.push("Decisions asked of you:");
  for (const e of r.escalations) {
    lines.push(
      `  Escalation ${e.id} [${e.status}]: ${e.summary}${e.reason ? ` (${e.reason})` : ""}${
        e.via ? ` [via ${e.via}]` : ""
      }`,
    );
  }
  if (r.branch) lines.push(`Branch: ${r.branch}`);
  if (r.ticketUrl) lines.push(`Ticket: ${r.ticketUrl}`);
  for (const url of r.ticketUrls) lines.push(`Ticket: ${url}`);
  if (r.prUrl) lines.push(`Pull request: ${r.prUrl}`);
  lines.push(`Messages: ${r.messages} (see \`kiln transcript ${r.id}\`)`);
  return lines.join("\n");
}

/** One line per Request, newest first, for `kiln request list`. */
export function listRequests(
  store: Store,
  all: boolean,
  budgetOf: (request: RequestRecord) => number | null,
) {
  const projects = new Map(store.listProjects({ includeRemoved: true }).map((p) => [p.id, p.name]));
  const states: State[] = all ? ["planned", "active", "done", "failed"] : ["planned", "active"];
  return states.flatMap((s) => store.listRequests(s)).sort((a, b) => b.id - a.id).map((r) => ({
    id: r.id,
    project: projects.get(r.projectId) ?? "",
    status: r.status,
    playbook: r.playbook,
    description: r.description,
    costUsd: store.requestSpend(r.id),
    budgetUsd: budgetOf(r),
  }));
}
export type RequestListing = ReturnType<typeof listRequests>[number];
