// The per-session Kiln tool server: an MCP server over stdio that one agent connects to.
// It uses the agent's address when it starts.
// It holds no state: every call goes to the daemon, which owns the Messages.
import { call, ensureDaemon } from "./client.ts";
import { VERSION } from "./daemon.ts";
import type { KilnPaths } from "./paths.ts";
import { readLines } from "./protocol.ts";
import type { MessageKind, MessageRecord } from "./store.ts";

const str = (description: string) => ({ type: "string", description });

const TOOLS = [
  {
    name: "read_inbox",
    description:
      "Read the messages waiting for you in your Kiln inbox. Returns each unread message once.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "send",
    description: "Send a message to a direct report (assignment, answer) or your direct " +
      "superior (result, question). Kiln refuses any other route. " +
      "assignment body: {title, instructions}. result body: {status: done|failed, summary; a leader may report out-of-scope to the overseer when the work asked for is outside the project's scope}, " +
      "inReplyTo the assignment's id. question body: {question, context?}, " +
      "assignmentId when asking about an assignment. " +
      "answer body: {answer}, inReplyTo the question's id.",
    inputSchema: {
      type: "object",
      properties: {
        to: str("Address of the recipient"),
        kind: { type: "string", enum: ["assignment", "result", "question", "answer"] },
        body: { type: "object", description: "The message content for this kind" },
        inReplyTo: { type: "integer", description: "Id of the message this one answers" },
        assignmentId: { type: "integer", description: "Assignment this question concerns" },
      },
      required: ["to", "kind", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "raise_question",
    description: "Ask your direct superior a question you cannot settle yourself. " +
      "Their answer arrives in your inbox.",
    inputSchema: {
      type: "object",
      properties: {
        question: str("The question"),
        context: str("What they need to know"),
        assignmentId: { type: "integer", description: "Assignment this question concerns" },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "raise_escalation",
    description: "Overseer only: bring the user a decision that is theirs to make. The work " +
      "waits for as long as the user takes; Kiln never decides for them. " +
      "Check the outcome with read_escalations.",
    inputSchema: {
      type: "object",
      properties: {
        summary: str("The decision the user is asked to make"),
        detail: str("What the user needs to know to decide"),
        requestId: { type: "integer", description: "The request this decision concerns" },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "read_escalations",
    description: "Overseer only: the escalations you raised, with whether the user approved " +
      "or rejected each (and why), or whether it is still open.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const view = (m: MessageRecord) => ({
  id: m.id,
  from: m.from,
  to: m.to,
  kind: m.kind,
  body: m.body,
  inReplyTo: m.inReplyTo,
  assignmentId: m.assignmentId,
  synthesised: m.synthesised,
  sentAt: m.sentAt,
});

async function callTool(
  paths: KilnPaths,
  address: string,
  name: string,
  rawArgs: unknown,
): Promise<unknown> {
  const args = validateArgs(name, rawArgs);
  await ensureDaemon(paths);
  switch (name) {
    case "read_inbox":
      return { messages: await call<MessageRecord[]>(paths, "messages.read", { address }) };
    case "send":
      return {
        sent: view(
          await call<MessageRecord>(paths, "messages.send", {
            from: address,
            to: args.to,
            kind: args.kind as MessageKind,
            body: args.body,
            inReplyTo: args.inReplyTo,
            assignmentId: args.assignmentId,
          }),
        ),
      };
    case "raise_question":
      return {
        sent: view(
          await call<MessageRecord>(paths, "messages.raise", {
            from: address,
            question: args.question,
            context: args.context,
            assignmentId: args.assignmentId,
          }),
        ),
      };
    case "raise_escalation":
      return {
        escalation: await call(paths, "escalations.raise", {
          from: address,
          summary: args.summary,
          detail: args.detail,
          requestId: args.requestId,
        }),
      };
    case "read_escalations":
      return { escalations: await call(paths, "escalations.raised", { from: address }) };
    default:
      throw new Error(`unknown tool "${name}"`);
  }
}

function validateArgs(name: string, value: unknown): Record<string, unknown> {
  const fields: Record<string, string> = name === "read_inbox" || name === "read_escalations"
    ? {}
    : name === "send"
    ? { to: "string", kind: "kind", body: "object", inReplyTo: "integer", assignmentId: "integer" }
    : name === "raise_question"
    ? { question: "string", context: "string", assignmentId: "integer" }
    : name === "raise_escalation"
    ? { summary: "string", detail: "string", requestId: "integer" }
    : (() => {
      throw new Error(`unknown tool "${name}"`);
    })();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("tool arguments must be an object");
  }
  const args = value as Record<string, unknown>;
  for (const [field, item] of Object.entries(args)) {
    const type = fields[field];
    if (!Object.hasOwn(fields, field)) throw new Error(`unknown argument "${field}"`);
    if (
      type === "integer"
        ? !Number.isSafeInteger(item) || (item as number) <= 0
        : type === "object"
        ? typeof item !== "object" || item === null || Array.isArray(item)
        : type === "kind"
        ? typeof item !== "string" || !["assignment", "result", "question", "answer"].includes(item)
        : typeof item !== "string"
    ) {
      throw new Error(`invalid argument "${field}"`);
    }
  }
  for (
    const field of name === "send"
      ? ["to", "kind", "body"]
      : name === "raise_question"
      ? ["question"]
      : name === "raise_escalation"
      ? ["summary"]
      : []
  ) {
    if (!Object.hasOwn(args, field)) throw new Error(`missing argument "${field}"`);
  }
  return args;
}

/** Serve the tools to one agent until it closes our standard input. */
export async function runToolServer(paths: KilnPaths, address: string): Promise<void> {
  const out = (msg: unknown) =>
    Deno.stdout.write(new TextEncoder().encode(JSON.stringify(msg) + "\n"));
  const reply = (id: unknown, result: unknown) => out({ jsonrpc: "2.0", id, result });
  const fail = (id: unknown, code: number, message: string) =>
    out({ jsonrpc: "2.0", id, error: { code, message } });

  for await (const line of readLines(Deno.stdin)) {
    let req: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(line);
    } catch {
      await fail(null, -32700, "parse error");
      continue;
    }
    if (req.id === undefined) continue; // notifications need no answer
    switch (req.method) {
      case "initialize":
        await reply(req.id, {
          protocolVersion: (req.params?.protocolVersion as string) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "kiln", version: VERSION },
        });
        break;
      case "ping":
        await reply(req.id, {});
        break;
      case "tools/list":
        await reply(req.id, { tools: TOOLS });
        break;
      case "tools/call": {
        const name = String(req.params?.name);
        try {
          const result = await callTool(
            paths,
            address,
            name,
            req.params?.arguments ?? {},
          );
          await reply(req.id, { content: [{ type: "text", text: JSON.stringify(result) }] });
        } catch (err) {
          await reply(req.id, {
            isError: true,
            content: [{ type: "text", text: (err as Error).message }],
          });
        }
        break;
      }
      default:
        await fail(req.id, -32601, `method not found: ${req.method}`);
    }
  }
}
