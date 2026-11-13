// The message router: sessions, Messages between them, and the rules that keep work from
// falling on the floor. Messages are validated and routed on the way in, read tracked, and
// when nobody picks one up Kiln Nudges the recipient, then gives up and dead-letters it.
import { DEFAULT_LIMITS } from "./limits.ts";
import type { Logger } from "./log.ts";
import { errorText, type LaunchRequest, type LaunchResult, workdirMissing } from "./launcher.ts";
import { confine, DEFAULT_TOOLS, judgeCall } from "./confinement.ts";
import { KINDS, refuseRoute, superiorOf, validateBody } from "./messages.ts";
import {
  type EscalationRecord,
  type MessageKind,
  type MessageRecord,
  type NewSession,
  type Role,
  type SessionRecord,
  type Store,
  UnknownSessionError,
} from "./store.ts";

/** A Message is dead-lettered once this many Nudges have gone unanswered. */
export const MAX_DELIVERIES = 3;
export const TOOL_NAMES = [
  "read_inbox",
  "send",
  "raise_question",
  "raise_escalation",
  "read_escalations",
  "list_projects",
  "list_playbooks",
  "start_request",
  "request_status",
] as const;
const LAUNCH_TIMEOUT_MS = 30_000;
const DEFAULT_RENUDGE_AFTER_MS = 60_000;

/** A refusal the sender can act on. */
export class RouterError extends Error {}

export interface RouterOptions {
  store: Store;
  log: Logger;
  /** How long a Nudge may go unanswered before the next one; defaults to 60 seconds. */
  renudgeAfterMs?: number;
  launch: (req: LaunchRequest) => Promise<LaunchResult>;
  /** What a configured role is told about its job when it is woken; undefined if unknown. */
  rolePrompt?: (roleName: string) => Promise<string | undefined>;
  /** Where a session may read besides its own directory: the Overseer reads Project clones. */
  readRoots?: (session: SessionRecord) => string[] | undefined;
  /** Ports of the Dashboards running now; shell commands aimed at them are refused. */
  dashboardPorts?: () => number[];
  /** The built-in tools a configured role may use; undefined if unknown (the kind's default applies). */
  roleTools?: (roleName: string) => Promise<string[] | undefined>;
  /** How to start `kiln <args>` again: used to give a nudged agent its tool server and hook. */
  selfCommand: (args: string[]) => { cmd: string; args: string[] };
  /** Messages that are not delivered yet, e.g. an Assignment still queued behind a cap. */
  hold?: (message: MessageRecord) => boolean;
  /** What a launch for this session may use up; undefined when the router's defaults apply. */
  launchLimits?: (session: SessionRecord) => { maxTurns: number; maxBudgetUsd: number } | undefined;
  /** Called after each launch for a session, whatever its outcome, with what it used. */
  observe?: (
    session: SessionRecord,
    used: { turns: number; costUsd: number; outcome: string },
  ) => void;
  /** Called when a launch for a session shows a sign of life. */
  activity?: (session: SessionRecord) => void;
  /** The caller watches this session's launches, so they are not cut short after a fixed time. */
  watched?: (session: SessionRecord) => boolean;
  /** Kiln is halted: nobody is woken until it is resumed. */
  halted?: () => boolean;
  /** How many times, and how soon, to retry waking an agent whose launch fails. */
  infrastructure?: () => Promise<{ retries: number; backoffSeconds: number }>;
}

/** Why a launch ended without the agent having done its part. */
type Outcome = "ok" | "failed" | "unstarted" | "stopped";
/** How much of the launcher's complaint is kept to explain a failed launch. */
const WHY_KEEP = 500;
/** An Outcome, and what the launcher said went wrong when it did not complete. */
interface Launched {
  outcome: Outcome;
  why?: string;
}

/** A launch that never gets going is retried at most this far apart, however many times it fails. */
const MAX_BACKOFF_SECONDS = 3600;
/** How many times the same work may be interrupted by a crash before Kiln fails it. */
export const MAX_INTERRUPTIONS = 2;

export interface StopVerdict {
  block: boolean;
  reason?: string;
}

export const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function createRouter(opts: RouterOptions) {
  const { store, log } = opts;
  /** Launches in flight, by the address of the session they wake. */
  const inFlight = new Map<string, Set<AbortController>>();

  const sessionAt = (address: string): SessionRecord => {
    try {
      return store.getSession(address);
    } catch (err) {
      if (err instanceof UnknownSessionError) throw new RouterError(err.message);
      throw err;
    }
  };
  const superiorOrThrow = (from: SessionRecord): SessionRecord => {
    const superior = superiorOf(store.listSessions(), from);
    if (!superior) {
      throw new RouterError(
        from.role === "overseer"
          ? "The overseer has no one above it to send this to."
          : `Department "${from.department}" has no leader yet.`,
      );
    }
    return superior;
  };

  const hasResult = (assignmentId: number): boolean =>
    store.listMessages({ kind: "result", inReplyTo: assignmentId }).length > 0;
  /** Assignments to `address` nobody has reported on yet. */
  const openAssignments = (address: string): MessageRecord[] =>
    store.listMessages({ to: address, kind: "assignment" }).filter((a) => !hasResult(a.id));
  /** Questions from `address` still waiting for an answer. */
  const openQuestions = (address: string, assignmentId: number): MessageRecord[] =>
    store.listMessages({ from: address, kind: "question" }).filter((q) =>
      q.assignmentId === assignmentId && q.deadLetteredAt === null &&
      !store.listMessages({ kind: "answer", inReplyTo: q.id }).length
    );

  function openHint(from: string, to: string): string {
    const open = openAssignments(from).filter((a) => a.from === to && a.deadLetteredAt === null);
    if (!open.length) return "";
    return open.length === 1
      ? `; the open assignment ${to} sent you is ${open[0].id}: reply to assignment ${open[0].id}`
      : `; the open assignments ${to} sent you are ${open.map((m) => m.id).join(", ")}`;
  }

  const append = (m: Parameters<Store["appendMessage"]>[0]): MessageRecord => {
    if (
      m.kind === "result" && m.inReplyTo !== undefined && m.inReplyTo !== null &&
      hasResult(m.inReplyTo)
    ) {
      throw new RouterError(
        `assignment ${m.inReplyTo} already has a result` + openHint(m.from, m.to),
      );
    }
    const sent = store.appendMessage(m);
    store.appendEvent("message.sent", {
      id: sent.id,
      from: sent.from,
      to: sent.to,
      kind: sent.kind,
      synthesised: sent.synthesised,
    });
    return sent;
  };

  /** Report on an assignment as failed, on behalf of the agent that never did. */
  const synthesiseFailure = (assignment: MessageRecord, why: string): MessageRecord => {
    const result = append({
      from: assignment.to,
      to: assignment.from,
      kind: "result",
      body: { status: "failed", summary: why },
      inReplyTo: assignment.id,
      synthesised: true,
    });
    log.warn("synthesised a failed result", { assignment: assignment.id, why });
    return result;
  };

  /**
   * A Step that follows the merge, stopped on without a result, goes back into its leader's inbox
   * to be woken again, up to MAX_INTERRUPTIONS times in all. True when it was handed back.
   */
  function retryAfterMerge(assignment: MessageRecord): boolean {
    if (assignment.interruptions + 1 >= MAX_INTERRUPTIONS) return false;
    const step = store.stepOfMessage(assignment.id);
    if (step?.spec.after !== "merge") return false;
    store.requeueMessage(assignment.id, true);
    store.appendEvent("assignment.resumed", { id: assignment.id, to: assignment.to });
    log.warn("woke a leader again after it stopped on a post-merge step", {
      assignment: assignment.id,
      step: step.id,
    });
    return true;
  }

  async function toolsOf(session: SessionRecord): Promise<string[]> {
    const configured = session.roleName
      ? await opts.roleTools?.(session.roleName).catch(() => undefined)
      : undefined;
    // A role whose configuration cannot be read gets no built-in tools, never more than it had.
    if (session.roleName && configured === undefined) return [];
    return configured ?? [...DEFAULT_TOOLS[session.role]];
  }

  function send(
    from: string,
    to: string,
    kind: MessageKind,
    body: unknown,
    inReplyTo?: number,
    assignmentId?: number,
    relaysQuestion?: number,
  ): MessageRecord {
    const sender = sessionAt(from);
    const recipient = sessionAt(to);
    if (!KINDS.includes(kind)) {
      throw new RouterError(`unknown message kind "${kind}"; use one of: ${KINDS.join(", ")}`);
    }
    const problems = validateBody(kind, body);
    if (problems.length) {
      throw new RouterError(`invalid ${kind} message: ${problems.join("; ")}`);
    }
    const refusal = refuseRoute(store.listSessions(), sender, recipient, kind);
    if (refusal) throw new RouterError(refusal);
    if (inReplyTo !== undefined && (!Number.isSafeInteger(inReplyTo) || inReplyTo <= 0)) {
      throw new RouterError("inReplyTo must be a positive integer");
    }
    if (
      assignmentId !== undefined &&
      (!Number.isSafeInteger(assignmentId) || assignmentId <= 0)
    ) {
      throw new RouterError("assignmentId must be a positive integer");
    }

    if (kind === "result" || kind === "answer") {
      const [target, targetKind] = kind === "result"
        ? ["assignment", "assignment"] as const
        : ["question", "question"] as const;
      const original = inReplyTo === undefined ? undefined : store.getMessage(inReplyTo);
      if (
        !original || original.kind !== targetKind || original.to !== from || original.from !== to
      ) {
        throw new RouterError(
          `a ${kind} must reply to ${
            target === "assignment" ? "an" : "a"
          } ${target} that ${to} sent you (set inReplyTo to its id)` +
            (kind === "result" ? openHint(from, to) : ""),
        );
      }
      if (kind === "answer" && store.listMessages({ kind, inReplyTo: original.id }).length) {
        throw new RouterError(`${target} ${original.id} already has a ${kind}`);
      }
    } else if (inReplyTo !== undefined) {
      throw new RouterError(`a ${kind} cannot reply to another message`);
    }
    if (kind === "question" && assignmentId !== undefined) {
      const original = store.getMessage(assignmentId);
      if (
        !original || original.kind !== "assignment" || original.to !== from ||
        original.from !== to || original.deadLetteredAt !== null ||
        hasResult(assignmentId)
      ) {
        throw new RouterError(`question must concern an open assignment ${to} sent you`);
      }
    } else if (kind !== "question" && assignmentId !== undefined) {
      throw new RouterError(`a ${kind} cannot name an assignmentId`);
    }
    if (relaysQuestion !== undefined) {
      if (kind !== "question") throw new RouterError(`a ${kind} cannot relay a question`);
      const original = store.getMessage(relaysQuestion);
      if (
        !original || original.kind !== "question" || original.to !== from ||
        original.deadLetteredAt !== null
      ) {
        throw new RouterError(`relaysQuestion must be a question ${from} was asked`);
      }
      if (store.listMessages({ kind: "answer", inReplyTo: original.id }).length) {
        throw new RouterError(`question ${original.id} is already answered`);
      }
      if (store.listMessages({ kind: "question" }).some((q) => q.relayOf === original.id)) {
        throw new RouterError(`question ${original.id} was already passed up`);
      }
    }
    const sent = append({
      from,
      to,
      kind,
      body: body as Record<string, unknown>,
      inReplyTo,
      assignmentId,
      relayOf: relaysQuestion,
    });
    if (kind === "answer") passDown(sent);
    return sent;
  }

  /**
   * An answer to a question that was passed up goes on down to whoever first asked it, from the
   * agent that passed it up, so the asker is answered without anyone in between waking.
   */
  function passDown(answer: MessageRecord): void {
    const relayed = store.getMessage(answer.inReplyTo!)!;
    if (relayed.relayOf === null) return;
    const asked = store.getMessage(relayed.relayOf)!;
    if (store.listMessages({ kind: "answer", inReplyTo: asked.id }).length) return;
    append({
      from: asked.to,
      to: asked.from,
      kind: "answer",
      body: { answer: answer.body.answer },
      inReplyTo: asked.id,
      relayOf: answer.id,
    });
  }

  /** Tell the Overseer an agent is stuck, as a question from the agent's leader. */
  function reportStuck(session: SessionRecord, why: string, assignmentId?: number): void {
    const sessions = store.listSessions();
    const overseer = sessions.find((s) => s.role === "overseer");
    const sender = session.role === "leader"
      ? session
      : sessions.find((s) => s.role === "leader" && s.department === session.department);
    store.appendEvent("agent.stuck", { address: session.address, why });
    log.warn("agent is stuck", { address: session.address, why });
    if (!overseer || !sender || session.role === "overseer") return;
    const tracked = (id: number): boolean => {
      try {
        store.getAssignment(id);
        return true;
      } catch {
        return false;
      }
    };
    const concerns = [
      ...(assignmentId === undefined ? [] : [assignmentId]),
      ...openAssignments(session.address).filter((a) => a.deadLetteredAt === null).map((a) => a.id),
      ...openAssignments(sender.address).filter((a) => a.deadLetteredAt === null).map((a) => a.id),
    ].find(tracked);
    append({
      from: sender.address,
      to: overseer.address,
      kind: "question",
      assignmentId: concerns,
      body: {
        question: `${session.address} is stuck: ${why}. Kiln has stopped waking it; ` +
          `\`kiln resume\` tries again.`,
      },
      synthesised: true,
    });
  }

  /** A launch failed for infrastructure reasons: retry later, or give up and report it. */
  async function launchFailed(session: SessionRecord, why: string): Promise<void> {
    let policy = DEFAULT_LIMITS.infrastructure;
    try {
      policy = (await opts.infrastructure?.()) ?? policy;
    } catch {
      policy = DEFAULT_LIMITS.infrastructure;
    }
    const failures = session.launchFailures + 1;
    if (failures > policy.retries) {
      store.recordLaunchFailure(session.address, { stuck: true });
      const reason = `${failures} launches in a row failed (${why})`;
      reportStuck(session, reason);
      for (const m of openAssignments(session.address)) {
        if (m.deadLetteredAt === null && !opts.hold?.(m)) {
          synthesiseFailure(
            m,
            `Kiln could not wake ${session.address}: ${reason}. ` +
              (session.claudeSessionId
                ? "The agent had been launched before, but this wake did not complete."
                : "The agent was never launched."),
          );
        }
      }
      return;
    }
    const seconds = Math.min(
      policy.backoffSeconds * 2 ** (failures - 1),
      MAX_BACKOFF_SECONDS,
    );
    store.recordLaunchFailure(session.address, {
      retryAt: new Date(Date.now() + seconds * 1000).toISOString(),
    });
    store.appendEvent("launch.failed", {
      address: session.address,
      failures,
      retryInSeconds: seconds,
      why,
    });
  }

  return {
    openSession(s: NewSession): SessionRecord {
      if (!/^[a-z][a-z0-9-]*$/.test(s.address)) {
        throw new RouterError(
          `"${s.address}" is not a valid address; use lowercase letters, digits and dashes`,
        );
      }
      if (!(["overseer", "leader", "worker"] as Role[]).includes(s.role)) {
        throw new RouterError(`unknown role "${s.role}"; use overseer, leader or worker`);
      }
      if (s.role === "overseer" ? s.department : !s.department) {
        throw new RouterError(
          s.role === "overseer"
            ? "the overseer belongs to no department"
            : `a ${s.role} needs a department`,
        );
      }
      const session = store.addSession(s);
      store.appendEvent("session.opened", { address: s.address, role: s.role });
      return session;
    },

    send,

    /** Stop whatever is running for the session at `address`. */
    abort(address: string, reason = "stopped"): void {
      for (const controller of inFlight.get(address) ?? []) controller.abort(reason);
    },

    /** Stop every launch in flight; the work they were doing is put back for a later wake. */
    abortAll(reason: string): void {
      for (const controllers of inFlight.values()) {
        for (const controller of controllers) controller.abort(reason);
      }
    },

    /**
     * After a crash: launches that began and never ended were interrupted. The work they were on
     * is put back in the agent's inbox to be resumed once; a second interruption of the same work
     * fails it, and the failure is reported to the Overseer. Returns what became of each.
     */
    recoverInterrupted(): { resumed: number; failed: number } {
      const outcome = { resumed: 0, failed: 0 };
      for (const session of store.listLaunching()) {
        store.setLaunching(session.address, false);
        for (const m of openAssignments(session.address)) {
          if (m.deadLetteredAt !== null || opts.hold?.(m)) continue;
          if (m.interruptions + 1 >= MAX_INTERRUPTIONS) {
            const why = `assignment ${m.id} ("${m.body.title}") was interrupted twice`;
            reportStuck(session, why, m.id);
            synthesiseFailure(m, `Kiln stopped under this assignment's worker twice: ${why}.`);
            outcome.failed++;
          } else {
            store.requeueMessage(m.id, true);
            store.appendEvent("assignment.resumed", { id: m.id, to: session.address });
            outcome.resumed++;
          }
        }
      }
      return outcome;
    },

    /** Tell the Overseer an agent is stuck. */
    reportStuck,

    /** Put the agents Kiln gave up on back in play, so they are woken again. */
    clearStuck: () => store.clearStuck(),

    /** Report an open assignment as failed on behalf of its worker, saying why. */
    failAssignment(assignmentId: number, why: string): MessageRecord | undefined {
      const assignment = store.getMessage(assignmentId);
      if (!assignment || assignment.kind !== "assignment" || hasResult(assignmentId)) return;
      return synthesiseFailure(assignment, why);
    },

    /** Ask the sender's direct superior; the answer comes back as an answer Message. */
    raiseQuestion(
      from: string,
      question: unknown,
      context?: unknown,
      assignmentId?: number,
      relaysQuestion?: number,
    ): MessageRecord {
      const sender = sessionAt(from);
      const body = context === undefined ? { question } : { question, context };
      return send(
        from,
        superiorOrThrow(sender).address,
        "question",
        body,
        undefined,
        assignmentId,
        relaysQuestion,
      );
    },

    /**
     * The user decided an Escalation raised over a question: the Overseer's answer to that
     * question is the decision, and it goes on down the chain like any other answer.
     */
    answerFromDecision(escalation: EscalationRecord): MessageRecord | undefined {
      const question = escalation.questionId === null
        ? undefined
        : store.getMessage(escalation.questionId);
      if (!question || store.listMessages({ kind: "answer", inReplyTo: question.id }).length) {
        return;
      }
      const decision = escalation.status === "approved"
        ? "The user approved."
        : `The user rejected this: ${escalation.reason}`;
      return send(
        question.to,
        question.from,
        "answer",
        { answer: `${decision} (escalation ${escalation.id}: ${escalation.summary})` },
        question.id,
      );
    },

    /**
     * The policing hook's verdict on one tool call by `address`. A refused call goes up to the
     * agent's direct superior as a question, about the agent's open assignment if it has one;
     * the agent is told so, and the answer arrives in its inbox.
     */
    async policeCall(
      address: string,
      tool: string,
      input: Record<string, unknown>,
    ): Promise<{ allowed: boolean; reason?: string }> {
      const session = sessionAt(address);
      const verdict = judgeCall(
        {
          tools: await toolsOf(session),
          worktree: session.cwd,
          readRoots: opts.readRoots?.(session),
          dashboardPorts: opts.dashboardPorts?.(),
        },
        tool,
        input,
      );
      if (verdict.allowed) return verdict;
      store.appendEvent("tool.denied", { address, tool, reason: verdict.reason });
      const superior = superiorOf(store.listSessions(), session);
      if (!superior) return verdict;
      const open = openAssignments(address);
      const question =
        `Kiln denied my ${tool} call: ${verdict.reason}. May I proceed another way, ` +
        `or should the work change?`;
      const asked = store.listMessages({ from: address, to: superior.address, kind: "question" })
        .some((q) =>
          q.body.question === question && q.deadLetteredAt === null &&
          !store.listMessages({ kind: "answer", inReplyTo: q.id }).length
        );
      if (!asked) {
        send(
          address,
          superior.address,
          "question",
          {
            question,
            context: JSON.stringify(input).slice(0, 500),
          },
          undefined,
          open.length === 1 ? open[0].id : undefined,
        );
      }
      return {
        allowed: false,
        reason: `${verdict.reason}. Kiln has asked ${superior.address} about it; ` +
          `their answer will arrive in your inbox. Carry on with something else meanwhile.`,
      };
    },

    /** Hand over what is waiting for `address`, marking it read. */
    readInbox(address: string): MessageRecord[] {
      sessionAt(address);
      const waiting = store.listMessages({ to: address, waiting: true });
      if (waiting.length) {
        store.markRead(waiting.map((m) => m.id));
        store.appendEvent("message.read", { address, ids: waiting.map((m) => m.id) });
      }
      return waiting.map((m) => store.getMessage(m.id)!);
    },

    /**
     * The Stop hook's verdict. An agent may not stop with unread mail, nor with an assignment it
     * has neither reported on nor asked a question about. Blocked once; if it tries again
     * regardless, let it go and report the failure on its behalf.
     */
    checkStop(address: string, alreadyBlocked: boolean): StopVerdict {
      sessionAt(address);
      const unread = store.listMessages({ to: address, waiting: true });
      const open = openAssignments(address);
      // A leader that has delegated work still in flight is waiting, not finished: the worker's
      // result will wake it, so it needs neither to report yet nor to raise a question.
      const waitingOnWorker = store.listMessages({ from: address, kind: "assignment" })
        .some((a) => !hasResult(a.id));
      const unreported = waitingOnWorker
        ? []
        : open.filter((a) => !openQuestions(address, a.id).length);
      if (!alreadyBlocked) {
        const reasons: string[] = [];
        if (unread.length) {
          reasons.push(
            `You have ${unread.length} unread message(s) in your Kiln inbox. Call read_inbox.`,
          );
        }
        if (unreported.length) {
          const describe = (a: MessageRecord) =>
            `assignment ${a.id} ("${String(a.body.title ?? "untitled")}", from ${a.from})`;
          reasons.push(
            `You have not reported on ${unreported.map(describe).join("; ")}. ` +
              `Call send with a result (status done or failed) and inReplyTo set to that id. ` +
              `Only if you have a real question or decision for someone else, call raise_question ` +
              `with assignmentId set to that id, so it is held rather than lost; never raise ` +
              `one just to say you are waiting.`,
          );
        }
        if (reasons.length) return { block: true, reason: reasons.join(" ") };
      }
      for (const a of unreported) {
        // Stopping at all means Claude was launched; what failed is that it reported nothing.
        // After the merge the work is already done and only the wrap-up is left, so the step is
        // handed back to the leader once instead of failing the whole request.
        if (retryAfterMerge(a)) continue;
        synthesiseFailure(
          a,
          `The agent was launched but stopped without reporting a result${
            a.interruptions ? ` (it had already been woken again ${a.interruptions} time(s))` : ""
          }.`,
        );
      }
      return { block: false };
    },

    /**
     * One delivery pass. Wakes each agent with unread mail that was never nudged, or whose last
     * Nudge has gone unanswered for long enough, and dead-letters Messages nudged
     * MAX_DELIVERIES times without being read.
     */
    async tick(): Promise<void> {
      if (opts.halted?.()) return;
      const now = Date.now();
      const due = store.listMessages({ waiting: true }).filter((m) =>
        !opts.hold?.(m) &&
        (m.lastDeliveryAt === null ||
          now - Date.parse(m.lastDeliveryAt) >= (opts.renudgeAfterMs ?? DEFAULT_RENUDGE_AFTER_MS))
      );
      const byRecipient = new Map<string, MessageRecord[]>();
      for (const m of due) {
        if (m.deliveries >= MAX_DELIVERIES) {
          store.deadLetter(m.id);
          store.appendEvent("message.dead_lettered", { id: m.id, to: m.to, kind: m.kind });
          if (m.kind === "assignment") {
            synthesiseFailure(
              m,
              `The assignment was never read: it was dead-lettered after ${MAX_DELIVERIES} nudges.`,
            );
          }
        } else {
          byRecipient.set(m.to, [...byRecipient.get(m.to) ?? [], m]);
        }
      }
      // Agents are woken side by side: one that takes long must not hold up the others.
      await Promise.all([...byRecipient].map(async ([address, messages]) => {
        const waiting = new Set(
          store.listMessages({ to: address, waiting: true }).map((m) => m.id),
        );
        const current = messages.filter((m) => waiting.has(m.id));
        // Still being woken: the next pass delivers what has arrived since, in the same session.
        if (!current.length || inFlight.has(address)) return;
        const session = sessionAt(address);
        // Checked first: a worker with no worktree is never woken, however it stands otherwise.
        if (orphaned(session)) return giveUpOn(session, current);
        // Waiting out a backoff, or given up on until the user resumes Kiln.
        if (session.stuckAt !== null) return;
        if (session.retryAt !== null && Date.parse(session.retryAt) > Date.now()) return;
        const { outcome, why } = await nudge(session, current);
        if (outcome === "ok") {
          store.recordLaunchSuccess(address);
          store.recordDelivery(current.map((m) => m.id));
          store.appendEvent("message.nudged", { to: address, ids: current.map((m) => m.id) });
        } else if (outcome !== "stopped") {
          await launchFailed(sessionAt(address), why ?? "the launcher did not complete");
        }
      }));
    },
  };

  /**
   * A worker whose worktree is gone for good: the Assignment it worked in was merged and the
   * worktree removed, so there is nowhere to start Claude. Waking it can never succeed.
   */
  function orphaned(session: SessionRecord): boolean {
    // Only a Worktree Kiln itself released: a directory that vanished some other way (a deleted
    // clone, a deleted Worktree) is put right by the environment checks, and may be retried.
    return session.role === "worker" && workdirMissing(session.cwd) &&
      store.findWorktree(session.cwd)?.releasedAt != null;
  }

  /**
   * Mail for a worker that has no worktree any more. An answer or a result is of no use to a
   * worker that already reported: it is dead-lettered. An Assignment is failed back to its sender
   * at once, saying why, so they can give the work to a new worker; retrying would only fail again.
   */
  function giveUpOn(session: SessionRecord, messages: MessageRecord[]): void {
    const why = `${session.address} has no worktree any more (${session.cwd} was removed when ` +
      `its earlier assignment was merged), so it cannot be woken`;
    for (const m of messages) {
      store.deadLetter(m.id);
      store.appendEvent("message.dead_lettered", {
        id: m.id,
        to: m.to,
        kind: m.kind,
        why: "worktree removed",
      });
      if (m.kind === "assignment" && !hasResult(m.id)) {
        synthesiseFailure(m, `${why}. Give this work to a new worker.`);
      }
    }
    log.warn("not waking a worker without a worktree", {
      address: session.address,
      cwd: session.cwd,
      messages: messages.map((m) => m.id),
    });
  }

  async function nudge(session: SessionRecord, messages: MessageRecord[]): Promise<Launched> {
    // An answer to the agent's own question wakes the same Claude session that asked it; if that
    // session cannot be resumed, a fresh one still reads the answer from the inbox.
    const resume = messages.some((m) => m.kind === "answer")
      ? session.claudeSessionId ?? undefined
      : undefined;
    const first = await launchNudge(session, messages, resume);
    if (first.outcome === "unstarted" && resume) {
      return await launchNudge(session, messages, undefined);
    }
    return first;
  }

  async function launchNudge(
    session: SessionRecord,
    messages: MessageRecord[],
    resume: string | undefined,
  ): Promise<Launched> {
    const count = messages.length;
    const server = opts.selfCommand(["tool-server", "--address", session.address]);
    const stop = opts.selfCommand(["hook", "stop", "--address", session.address]);
    const police = opts.selfCommand(["hook", "police", "--address", session.address]);
    const tools = await toolsOf(session);
    const confinement = confine(tools, session.cwd);
    const abortController = new AbortController();
    const limits = opts.launchLimits?.(session);
    const controllers = inFlight.get(session.address) ?? new Set();
    controllers.add(abortController);
    inFlight.set(session.address, controllers);
    const rolePrompt = session.roleName
      ? await opts.rolePrompt?.(session.roleName).catch(() => undefined)
      : undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    store.setLaunching(session.address, true);
    try {
      // A halt that landed while this launch was being set up found nothing in flight to stop.
      if (opts.halted?.()) {
        abortController.abort("halt");
        throw new Error("Kiln is halted");
      }
      const launched = await Promise.race([
        opts.launch({
          prompt: (rolePrompt ? `${rolePrompt}\n\n` : "") +
            (messages.some((m) => m.interruptions > 0)
              ? "Kiln was interrupted while you were working, and put your unfinished assignment " +
                "back in your inbox. What you had already committed or changed in your " +
                "worktree is still there: carry on from it. "
              : "") +
            `You have ${count} unread message(s) in your Kiln inbox. ` +
            `Call the read_inbox tool now and act on what it returns.`,
          cwd: session.cwd,
          persist: true,
          resume,
          // Marks every command the agent runs as the agent's: `kiln approve` refuses it.
          env: { KILN_AGENT: session.address },
          mcpServers: { kiln: { command: server.cmd, args: server.args } },
          allowedTools: [...confinement.allowedTools, ...TOOL_NAMES.map((t) => `mcp__kiln__${t}`)],
          tools: confinement.tools,
          disallowedTools: confinement.disallowedTools,
          denyByDefault: true,
          sandbox: confinement.sandbox,
          settings: {
            hooks: {
              PreToolUse: [{
                hooks: [{
                  type: "command",
                  command: [police.cmd, ...police.args].map(shellQuote).join(" "),
                }],
              }],
              Stop: [{
                hooks: [{
                  type: "command",
                  command: [stop.cmd, ...stop.args].map(shellQuote).join(" "),
                }],
              }],
            },
          },
          maxTurns: limits?.maxTurns,
          maxBudgetUsd: limits?.maxBudgetUsd,
          onActivity: () => opts.activity?.(session),
          abortController,
        }),
        new Promise<never>((_, reject) => {
          abortController.signal.addEventListener(
            "abort",
            () => reject(new Error("launch aborted")),
          );
          if (opts.watched?.(session)) return;
          timeout = setTimeout(() => {
            abortController.abort("timeout");
            reject(new Error("launch timed out"));
          }, LAUNCH_TIMEOUT_MS);
        }),
      ]);
      if (launched.sessionId) store.setClaudeSession(session.address, launched.sessionId);
      opts.observe?.(session, {
        turns: launched.turns,
        costUsd: launched.costUsd,
        outcome: launched.outcome,
      });
      if (!launched.ok) {
        log.warn("could not nudge", { address: session.address, outcome: launched.outcome });
      }
      // A limit, a cancel or a halt may have stopped it while its usage was being charged.
      if (stoppedByKiln(abortController)) return { outcome: "stopped" };
      if (launched.ok) return { outcome: "ok" };
      return {
        outcome: launched.turns === 0 ? "unstarted" : "failed",
        why: `Claude ended with ${launched.outcome}: ${launched.text}`.slice(0, WHY_KEEP),
      };
    } catch (err) {
      log.warn("could not nudge", { address: session.address, err });
      opts.observe?.(session, { turns: 0, costUsd: 0, outcome: "aborted" });
      if (stoppedByKiln(abortController)) return { outcome: "stopped" };
      return {
        outcome: abortController.signal.aborted ? "failed" : "unstarted",
        why: errorText(err).slice(0, WHY_KEEP),
      };
    } finally {
      // A halt cut the agent off mid-work: what it had been given is put back for after the resume.
      if (abortController.signal.reason === "halt") {
        const open = openAssignments(session.address).filter((m) =>
          m.deadLetteredAt === null && !opts.hold?.(m)
        );
        for (const m of [...messages, ...open]) {
          if (store.getMessage(m.id)?.readAt) store.requeueMessage(m.id, false);
        }
      }
      store.setLaunching(session.address, false);
      clearTimeout(timeout);
      controllers.delete(abortController);
      if (!controllers.size) inFlight.delete(session.address);
    }
  }
}

/** Kiln itself stopped the launch (a limit, a cancel, a halt), not the infrastructure. */
const stoppedByKiln = (c: AbortController) =>
  c.signal.aborted && (c.signal.reason === "stopped" || c.signal.reason === "halt");

export type Router = ReturnType<typeof createRouter>;
