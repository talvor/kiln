// The per-session Kiln tool server: an MCP server over stdio that one agent connects to.
// It is bound to the agent's address when it starts, so an agent can only ever act as itself.
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
      "assignment body: {title, instructions}. result body: {status: done|failed, summary}, " +
      "inReplyTo the assignment's id. question body: {question, context?}. " +
      "answer body: {answer}, inReplyTo the question's id.",
    inputSchema: {
      type: "object",
      properties: {
        to: str("Address of the recipient"),
        kind: { type: "string", enum: ["assignment", "result", "question", "answer"] },
        body: { type: "object", description: "The message content for this kind" },
        inReplyTo: { type: "integer", description: "Id of the message this one answers" },
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
      properties: { question: str("The question"), context: str("What they need to know") },
      required: ["question"],
      additionalProperties: false,
    },
  },
];

const view = (m: MessageRecord) => ({
  id: m.id,
  from: m.from,
  to: m.to,
  kind: m.kind,
  body: m.body,
  inReplyTo: m.inReplyTo,
  synthesised: m.synthesised,
  sentAt: m.sentAt,
});

async function callTool(
  paths: KilnPaths,
  address: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
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
          }),
        ),
      };
    default:
      throw new Error(`unknown tool "${name}"`);
  }
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
            (req.params?.arguments ?? {}) as Record<string, unknown>,
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
