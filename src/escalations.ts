// Escalations: decisions the Overseer brings to the user. The Overseer raises one; only the user
// decides it, through the CLI, and only the daemon writes the decision down. An Escalation waits
// for as long as it takes: nothing times it out or decides it on the user's behalf.
import type { EscalationRecord, SessionRecord, Store } from "./store.ts";

/** A refusal the caller can act on. */
export class EscalationError extends Error {}

/** An Escalation as people see it: an open one whose Request has ended is stale. */
export type EscalationView = Omit<EscalationRecord, "status"> & {
  status: EscalationRecord["status"] | "stale";
};

const text = (value: unknown, name: string, required: boolean): string | undefined => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new EscalationError(`"${name}" must be a non-empty piece of text.`);
  }
  return value;
};

/** Why an open Escalation can no longer be decided: its Request has already ended. */
function staleReason(store: Store, e: EscalationRecord): string | undefined {
  if (e.status !== "open" || e.requestId === null) return undefined;
  const request = store.getRequest(e.requestId);
  return request.status === "done" || request.status === "failed"
    ? `request ${request.id} is already ${request.status}, so there is nothing left to decide`
    : undefined;
}

export function viewOf(store: Store, e: EscalationRecord): EscalationView {
  return staleReason(store, e) ? { ...e, status: "stale" } : e;
}

export function createEscalations(store: Store) {
  return {
    /** The Overseer brings a decision to the user. */
    raise(
      from: string,
      params: { summary?: unknown; detail?: unknown; requestId?: unknown },
    ): EscalationRecord {
      const sender: SessionRecord = store.getSession(from);
      if (sender.role !== "overseer") {
        throw new EscalationError(
          `Only the overseer brings decisions to the user; raise a question to ${
            sender.role === "worker" ? "your leader" : "the overseer"
          } instead.`,
        );
      }
      const summary = text(params.summary, "summary", true)!;
      const detail = text(params.detail, "detail", false);
      let requestId: number | null = null;
      if (params.requestId !== undefined) {
        if (!Number.isSafeInteger(params.requestId) || (params.requestId as number) <= 0) {
          throw new EscalationError('"requestId" must be a positive integer.');
        }
        const request = store.getRequest(params.requestId as number);
        if (request.status === "done" || request.status === "failed") {
          throw new EscalationError(`Request ${request.id} is already ${request.status}.`);
        }
        requestId = request.id;
      }
      const e = store.addEscalation({ raisedBy: from, requestId, summary, detail });
      store.appendEvent("escalation.raised", { id: e.id, request: requestId });
      return e;
    },

    list(openOnly: boolean): EscalationView[] {
      return store.listEscalations({ openOnly }).map((e) => viewOf(store, e))
        .filter((e) => !openOnly || e.status === "open");
    },

    /** The Escalations the Overseer raised, with what the user decided. */
    raisedBy(address: string): (EscalationView & { notes: { text: string; sentAt: string }[] })[] {
      return store.listEscalations().filter((e) => e.raisedBy === address)
        .map((e) => ({
          ...viewOf(store, e),
          // What the user typed on the Escalation's page: for the Overseer to read, never a decision.
          notes: store.listEscalationNotes(e.id).map((n) => ({ text: n.body, sentAt: n.sentAt })),
        }));
    },

    /**
     * Record the user's decision. `agent` names the session the CLI was run from, if it was run
     * by an agent: agents never decide.
     */
    decide(
      params: { id: unknown; approved: boolean; reason?: unknown; agent?: unknown },
    ): EscalationRecord {
      if (params.agent !== undefined && params.agent !== null && params.agent !== "") {
        throw new EscalationError(
          `Only the user decides an escalation; "${params.agent}" is an agent and may not.`,
        );
      }
      if (!Number.isSafeInteger(params.id) || (params.id as number) <= 0) {
        throw new EscalationError("An escalation id is a positive number.");
      }
      const id = params.id as number;
      const reason = params.approved ? undefined : text(params.reason, "reason", true);
      const current = store.getEscalation(id);
      const stale = staleReason(store, current);
      if (stale) throw new EscalationError(`Escalation ${id} is stale: ${stale}.`);
      const decided = store.decideEscalation(id, { approved: params.approved, reason });
      store.appendEvent("escalation.decided", {
        id,
        decision: decided.status,
        reason: decided.reason,
      });
      return decided;
    },
  };
}
export type Escalations = ReturnType<typeof createEscalations>;
