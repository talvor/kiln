// The message router: sessions, Messages between them, and the rules that keep work from
// falling on the floor. Messages are validated and routed on the way in, read tracked, and
// when nobody picks one up Kiln Nudges the recipient, then gives up and dead-letters it.
import type { Logger } from "./log.ts";
import type { LaunchRequest, LaunchResult } from "./launcher.ts";
import { KINDS, refuseRoute, superiorOf, validateBody } from "./messages.ts";
import {
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
export const TOOL_NAMES = ["read_inbox", "send", "raise_question"] as const;
const LAUNCH_TIMEOUT_MS = 30_000;
const RENUDGE_AFTER_MS = 60_000;

/** A refusal the sender can act on. */
export class RouterError extends Error {}

export interface RouterOptions {
  store: Store;
  log: Logger;
  launch: (req: LaunchRequest) => Promise<LaunchResult>;
  /** How to start `kiln <args>` again: used to give a nudged agent its tool server and hook. */
  selfCommand: (args: string[]) => { cmd: string; args: string[] };
}

export interface StopVerdict {
  block: boolean;
  reason?: string;
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function createRouter(opts: RouterOptions) {
  const { store, log } = opts;

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
    store.listMessages({ to: address, kind: "assignment" }).filter((a) =>
      !hasResult(a.id)
    );
  /** Questions from `address` still waiting for an answer. */
  const openQuestions = (address: string, assignmentId: number): MessageRecord[] =>
    store.listMessages({ from: address, kind: "question" }).filter((q) =>
      q.assignmentId === assignmentId && q.deadLetteredAt === null &&
      !store.listMessages({ kind: "answer", inReplyTo: q.id }).length
    );

  const append = (m: Parameters<Store["appendMessage"]>[0]): MessageRecord => {
    if (m.kind === "result" && m.inReplyTo !== undefined && m.inReplyTo !== null &&
      hasResult(m.inReplyTo)) {
      throw new RouterError(`assignment ${m.inReplyTo} already has a result`);
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

  function send(
    from: string,
    to: string,
    kind: MessageKind,
    body: unknown,
    inReplyTo?: number,
    assignmentId?: number,
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
    if (assignmentId !== undefined &&
      (!Number.isSafeInteger(assignmentId) || assignmentId <= 0)) {
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
          } ${target} that ${to} sent you (set inReplyTo to its id)`,
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
      if (!original || original.kind !== "assignment" || original.to !== from ||
        original.from !== to || original.deadLetteredAt !== null ||
        hasResult(assignmentId)) {
        throw new RouterError(`question must concern an open assignment ${to} sent you`);
      }
    } else if (kind !== "question" && assignmentId !== undefined) {
      throw new RouterError(`a ${kind} cannot name an assignmentId`);
    }
    return append({ from, to, kind, body: body as Record<string, unknown>, inReplyTo, assignmentId });
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

    /** Ask the sender's direct superior; the answer comes back as an answer Message. */
    raiseQuestion(from: string, question: unknown, context?: unknown, assignmentId?: number): MessageRecord {
      const sender = sessionAt(from);
      const body = context === undefined ? { question } : { question, context };
      return send(from, superiorOrThrow(sender).address, "question", body, undefined, assignmentId);
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
      const unreported = open.filter((a) => !openQuestions(address, a.id).length);
      if (!alreadyBlocked) {
        const reasons: string[] = [];
        if (unread.length) {
          reasons.push(
            `You have ${unread.length} unread message(s) in your Kiln inbox. Call read_inbox.`,
          );
        }
        if (unreported.length) {
          reasons.push(
            `You have not reported on assignment ${unreported.map((a) => a.id).join(", ")}. ` +
              `Call send with a result (status done or failed), or raise_question with assignmentId if you are stuck.`,
          );
        }
        if (reasons.length) return { block: true, reason: reasons.join(" ") };
      }
      for (const a of unreported) {
        synthesiseFailure(a, "The agent stopped without reporting a result.");
      }
      return { block: false };
    },

    /**
     * One delivery pass. Wakes each agent with unread mail that was never nudged, or whose last
     * Nudge has gone unanswered for long enough, and dead-letters Messages nudged
     * MAX_DELIVERIES times without being read.
     */
    async tick(): Promise<void> {
      const now = Date.now();
      const due = store.listMessages({ waiting: true }).filter((m) =>
        m.lastDeliveryAt === null || now - Date.parse(m.lastDeliveryAt) >= RENUDGE_AFTER_MS
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
      for (const [address, messages] of byRecipient) {
        const waiting = new Set(store.listMessages({ to: address, waiting: true }).map((m) => m.id));
        const current = messages.filter((m) => waiting.has(m.id));
        if (!current.length) continue;
        if (await nudge(sessionAt(address), current.length)) {
          store.recordDelivery(current.map((m) => m.id));
          store.appendEvent("message.nudged", { to: address, ids: current.map((m) => m.id) });
        }
      }
    },
  };

  async function nudge(session: SessionRecord, count: number): Promise<boolean> {
    const server = opts.selfCommand(["tool-server", "--address", session.address]);
    const stop = opts.selfCommand(["hook", "stop", "--address", session.address]);
    const abortController = new AbortController();
    let timeout: number | undefined;
    try {
      const launched = await Promise.race([opts.launch({
        prompt: `You have ${count} unread message(s) in your Kiln inbox. ` +
          `Call the read_inbox tool now and act on what it returns.`,
        cwd: session.cwd,
        mcpServers: { kiln: { command: server.cmd, args: server.args } },
        allowedTools: TOOL_NAMES.map((t) => `mcp__kiln__${t}`),
        settings: {
          hooks: {
            Stop: [{
              hooks: [{
                type: "command",
                command: [stop.cmd, ...stop.args].map(shellQuote).join(" "),
              }],
            }],
          },
        },
        abortController,
      }), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          abortController.abort();
          reject(new Error("launch timed out"));
        }, LAUNCH_TIMEOUT_MS);
      })]);
      if (!launched.ok) log.warn("could not nudge", { address: session.address, outcome: launched.outcome });
      return launched.ok;
    } catch (err) {
      log.warn("could not nudge", { address: session.address, err });
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export type Router = ReturnType<typeof createRouter>;
