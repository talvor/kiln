// Helpers for driving the message router the way agents and people do: an MCP client for an
// agent's Kiln tool server, the Stop hook, and a standard team of sessions.
import { fromFileUrl } from "@std/path";
import { assertEquals } from "@std/assert";
import type { Result } from "./helpers.ts";
import type { World } from "./world.ts";

const MAIN = fromFileUrl(new URL("../src/main.ts", import.meta.url));

export interface Message {
  id: number;
  from: string;
  to: string;
  kind: string;
  body: Record<string, unknown>;
  inReplyTo: number | null;
  assignmentId: number | null;
  synthesised: boolean;
  readAt: string | null;
  deliveries: number;
  deadLetteredAt: string | null;
}

export interface ToolOutcome {
  isError: boolean;
  /** The tool's raw text: its JSON result, or the error message when isError. */
  text: string;
  /** The parsed result of a tool that worked. */
  data: { messages: Message[]; sent: Message };
}

/** An agent's end of its Kiln tool server: speaks MCP over the server's stdio. */
export class Agent {
  private nextId = 1;
  private lines: AsyncGenerator<string>;

  private constructor(private child: Deno.ChildProcess) {
    this.lines = (async function* () {
      let buf = "";
      for await (const chunk of child.stdout) {
        buf += new TextDecoder().decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          yield buf.slice(0, i);
          buf = buf.slice(i + 1);
        }
      }
    })();
  }

  static async connect(world: World, address: string): Promise<Agent> {
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", MAIN, "tool-server", "--address", address],
      env: world.env,
      clearEnv: true,
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const agent = new Agent(child);
    await agent.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-agent", version: "0" },
    });
    await agent.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    return agent;
  }

  private async write(msg: unknown) {
    const w = this.child.stdin.getWriter();
    await w.write(new TextEncoder().encode(JSON.stringify(msg) + "\n"));
    w.releaseLock();
  }

  async request(method: string, params: Record<string, unknown> = {}) {
    const id = this.nextId++;
    await this.write({ jsonrpc: "2.0", id, method, params });
    const next = await this.lines.next();
    if (next.done) throw new Error("tool server closed its output");
    const res = JSON.parse(next.value);
    assertEquals(res.id, id);
    return res;
  }

  async tools(): Promise<string[]> {
    return (await this.request("tools/list")).result.tools.map((t: { name: string }) => t.name);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    const { result } = await this.request("tools/call", { name, arguments: args });
    const text = result.content[0].text as string;
    const failed = result.isError === true;
    return {
      isError: failed,
      text,
      data: failed ? { messages: [], sent: undefined as unknown as Message } : JSON.parse(text),
    };
  }

  /** read_inbox, expecting it to work. */
  async inbox(): Promise<Message[]> {
    const out = await this.call("read_inbox");
    assertEquals(out.isError, false, out.text);
    return out.data.messages;
  }

  /** send, expecting it to work; returns the sent message. */
  async send(to: string, kind: string, body: unknown, inReplyTo?: number, assignmentId?: number): Promise<Message> {
    const out = await this.call("send", { to, kind, body, inReplyTo, assignmentId });
    assertEquals(out.isError, false, out.text);
    return out.data.sent;
  }

  async close() {
    await this.child.stdin.close().catch(() => {});
    await this.child.status;
  }
}

/** Run `fn` with an agent connected at `address`; always disconnects. */
export async function asAgent<T>(
  world: World,
  address: string,
  fn: (agent: Agent) => Promise<T>,
): Promise<T> {
  const agent = await Agent.connect(world, address);
  try {
    return await fn(agent);
  } finally {
    await agent.close();
  }
}

/** The overseer, one leader (`dev-lead`) and two workers (`dev-1`, `dev-2`) in `dev`. */
export async function openTeam(world: World): Promise<void> {
  for (
    const args of [
      ["overseer", "--role", "overseer"],
      ["dev-lead", "--role", "leader", "--department", "dev"],
      ["dev-1", "--role", "worker", "--department", "dev"],
      ["dev-2", "--role", "worker", "--department", "dev"],
    ]
  ) {
    const r = await world.kiln("session", "open", ...args, "--cwd", world.project.path);
    assertEquals(r.code, 0, r.stderr);
  }
}

/** Run the agent's Stop hook the way Claude Code does. Returns the hook's decision, if any. */
export async function stopHook(
  world: World,
  address: string,
  stopHookActive = false,
): Promise<{ decision: string; reason: string } | null> {
  const r: Result = await world.kilnWithInput(
    JSON.stringify({ hook_event_name: "Stop", stop_hook_active: stopHookActive }),
    "hook",
    "stop",
    "--address",
    address,
  );
  assertEquals(r.code, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

export const assignment = { title: "Add greeting", instructions: "Write hello.txt" };
