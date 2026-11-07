// What a Message may say and who may say it to whom. Pure rules: no storage, no I/O.
import type { MessageKind, Role, SessionRecord } from "./store.ts";

export const KINDS: readonly MessageKind[] = ["assignment", "result", "question", "answer"];

interface Field {
  required?: boolean;
  /** The field is a positive number rather than text. */
  number?: boolean;
  /** Allowed values; the field is free text when absent. */
  oneOf?: string[];
}

/** The fields each kind of Message carries. Anything else is refused. */
export const SCHEMAS: Record<MessageKind, Record<string, Field>> = {
  assignment: {
    title: { required: true },
    instructions: { required: true },
    // The paths the worker will change, comma separated: overlapping Assignments run one at a time.
    owns: {},
    // Limits above Kiln's defaults, up to the Project's ceiling.
    maxTurns: { number: true },
    maxSpendUsd: { number: true },
    maxSeconds: { number: true },
  },
  result: {
    status: { required: true, oneOf: ["done", "failed", "out-of-scope", "unready", "findings"] },
    summary: { required: true },
  },
  question: { question: { required: true }, context: {} },
  answer: { answer: { required: true } },
};

/** What is wrong with a Message body; empty when it is valid. */
export function validateBody(kind: MessageKind, body: unknown): string[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return ["body must be a JSON object"];
  }
  const schema = SCHEMAS[kind];
  const fields = body as Record<string, unknown>;
  const problems: string[] = [];
  for (const name of Object.keys(fields)) {
    if (!Object.hasOwn(schema, name)) problems.push(`unknown field "${name}"`);
  }
  for (const [name, field] of Object.entries(schema)) {
    const value = fields[name];
    if (value === undefined) {
      if (field.required) problems.push(`missing required field "${name}"`);
    } else if (field.number) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        problems.push(`field "${name}" must be a positive number`);
      }
    } else if (typeof value !== "string" || !value.trim()) {
      problems.push(`field "${name}" must be a non-empty string`);
    } else if (field.oneOf && !field.oneOf.includes(value)) {
      problems.push(`field "${name}" must be one of: ${field.oneOf.join(", ")}`);
    }
  }
  return problems;
}

/** Assignments and answers travel down the chain of command; results and questions, up. */
const DOWNWARD: MessageKind[] = ["assignment", "answer"];
export const travelsDown = (kind: MessageKind): boolean => DOWNWARD.includes(kind);

/** Who an agent reports to: a worker to its department's leader, a leader to the overseer. */
export function superiorOf(
  sessions: SessionRecord[],
  of: SessionRecord,
): SessionRecord | undefined {
  const above: Record<Role, (s: SessionRecord) => boolean> = {
    worker: (s) => s.role === "leader" && s.department === of.department,
    leader: (s) => s.role === "overseer",
    overseer: () => false,
  };
  return sessions.find(above[of.role]);
}

/** Why this route is closed, or undefined when `from` may send `kind` to `to`. */
export function refuseRoute(
  sessions: SessionRecord[],
  from: SessionRecord,
  to: SessionRecord,
  kind: MessageKind,
): string | undefined {
  const [upper, lower] = travelsDown(kind) ? [from, to] : [to, from];
  if (superiorOf(sessions, lower)?.address === upper.address) return undefined;
  return `route refused: ${from.role} "${from.address}" may not send ${kind} to ` +
    `${to.role} "${to.address}". Assignments and answers go down to a direct report; ` +
    `results and questions go up to your direct superior.`;
}
