// `kiln chat`: the user's side of the Overseer chat. It runs the installed `claude` interactively,
// as the Overseer, with Kiln's tools, status line and hooks; and it replaces the session with a
// fresh one, seeded with a digest, when the daemon says its context has grown too large. The hooks
// Claude runs (`kiln hook chat ...`) live here too: they only relay to the daemon.
import { call, ensureDaemon, selfCommand } from "./client.ts";
import { confine } from "./confinement.ts";
import { findClaude } from "./launcher.ts";
import type { KilnPaths } from "./paths.ts";
import { shellQuote } from "./router.ts";
import type { ChatBegun } from "./chat.ts";

const HEARTBEAT_MS = 1_000;

/** The command line Claude runs for a hook of ours. */
const hookCommand = (args: string[]): string => {
  const { cmd, args: rest } = selfCommand(["hook", "chat", ...args]);
  return [cmd, ...rest].map(shellQuote).join(" ");
};

/** The arguments that make an interactive `claude` the Overseer of chat session `begun`. */
export function chatArguments(begun: ChatBegun): string[] {
  const id = String(begun.chatId);
  const server = selfCommand(["tool-server", "--address", "overseer"]);
  const police = selfCommand(["hook", "police", "--address", "overseer"]);
  const confinement = confine(["Read", "Glob", "Grep"], begun.cwd);
  const hook = (command: string) => [{ hooks: [{ type: "command", command }] }];
  const settings = {
    statusLine: { type: "command", command: hookCommand(["status-line", "--chat", id]) },
    hooks: {
      PreToolUse: hook([police.cmd, ...police.args].map(shellQuote).join(" ")),
      UserPromptSubmit: hook(hookCommand(["prompt", "--chat", id])),
      Stop: hook(hookCommand(["stop", "--chat", id])),
    },
  };
  return [
    // Said to the Overseer at the start only when the user has something to hear.
    ...(begun.initialPrompt ? [begun.initialPrompt] : []),
    "--append-system-prompt",
    begun.system,
    "--mcp-config",
    JSON.stringify({ mcpServers: { kiln: { command: server.cmd, args: server.args } } }),
    "--strict-mcp-config",
    "--settings",
    JSON.stringify(settings),
    "--permission-mode",
    "dontAsk",
    "--tools",
    confinement.tools.join(","),
    "--allowedTools",
    [...confinement.allowedTools, "mcp__kiln"].join(","),
    "--disallowedTools",
    confinement.disallowedTools.join(","),
    ...begun.readDirs.flatMap((dir) => ["--add-dir", dir]),
  ];
}

/** Run the chat until the user leaves; returns Claude's exit code. */
export async function runChat(paths: KilnPaths): Promise<number> {
  const claude = findClaude();
  await ensureDaemon(paths);
  // Ctrl-C belongs to Claude, which shares our terminal.
  const ignore = () => {};
  Deno.addSignalListener("SIGINT", ignore);
  try {
    while (true) {
      const begun = await call<ChatBegun>(paths, "chat.begin");
      const child = new Deno.Command(claude, {
        args: chatArguments(begun),
        cwd: begun.cwd,
        // Marks everything the Overseer runs as an agent's: only the user decides escalations.
        env: { KILN_AGENT: "overseer", KILN_CHAT_ID: String(begun.chatId) },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).spawn();
      let rollover = false;
      let woken = false;
      let exited = false;
      const done = child.status.finally(() => exited = true);
      while (!exited) {
        await Promise.race([done, new Promise((r) => setTimeout(r, HEARTBEAT_MS))]);
        if (exited) break;
        try {
          const beat = await call<{ rollover: boolean; wake: boolean }>(
            paths,
            "chat.heartbeat",
            { id: begun.chatId },
          );
          if (beat.rollover || beat.wake) {
            rollover = true;
            woken = !beat.rollover;
            child.kill("SIGTERM");
            await done.catch(() => {});
          }
        } catch { /* the daemon is busy; the next beat will do */ }
      }
      const status = await done;
      await call(paths, "chat.end", { id: begun.chatId, reason: rollover ? "rollover" : "exit" })
        .catch(() => {});
      if (!rollover) return status.code;
      console.error(
        woken
          ? "\nkiln: news for the Overseer arrived while the chat was idle; continuing in a " +
            "fresh session seeded with a digest."
          : "\nkiln: the conversation outgrew its context; continuing in a fresh session " +
            "seeded with a digest.",
      );
    }
  } finally {
    Deno.removeSignalListener("SIGINT", ignore);
  }
}

interface HookInput {
  prompt?: string;
  stop_hook_active?: boolean;
  transcript_path?: string;
  last_assistant_message?: string;
}

/** What the end of a turn left in Claude's transcript: the Overseer's words and context size. */
export function readTranscript(path: string | undefined): { text?: string; tokens?: number } {
  if (!path) return {};
  let lines: string[];
  try {
    lines = Deno.readTextFileSync(path).split("\n").filter(Boolean);
  } catch {
    return {};
  }
  let text: string | undefined;
  let tokens: number | undefined;
  for (let i = lines.length - 1; i >= 0 && (text === undefined || tokens === undefined); i--) {
    let entry: {
      type?: string;
      message?: {
        content?: unknown;
        usage?: {
          input_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };
    };
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== "assistant") continue;
    const u = entry.message?.usage;
    if (tokens === undefined && u) {
      tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0);
    }
    const content = entry.message?.content;
    if (text === undefined && Array.isArray(content)) {
      const said = content.filter((b: { type?: string; text?: string }) => b.type === "text")
        .map((b: { text?: string }) => b.text ?? "").join("\n").trim();
      if (said) text = said;
    }
  }
  return { text, tokens };
}

/** A hook of the chat session: speaks Claude Code's hook protocol. Returns the exit code. */
export async function chatHook(
  paths: KilnPaths,
  event: string | undefined,
  chatId: number,
): Promise<number> {
  let input: HookInput = {};
  try {
    input = JSON.parse(await new Response(Deno.stdin.readable).text() || "{}");
  } catch { /* an unreadable payload counts as an empty one */ }
  try {
    await ensureDaemon(paths);
    if (event === "status-line") {
      console.log((await call<{ text: string }>(paths, "chat.statusLine")).text);
    } else if (event === "prompt") {
      const r = await call<{ reply?: string; context?: string }>(paths, "chat.prompt", {
        id: chatId,
        prompt: input.prompt ?? "",
      });
      if (r.reply !== undefined) {
        // Blocking the prompt keeps it from the model; the reason is shown to the user.
        console.log(JSON.stringify({ decision: "block", reason: r.reply }));
      } else if (r.context) {
        console.log(JSON.stringify({
          hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: r.context },
        }));
      }
    } else if (event === "stop") {
      const seen = readTranscript(input.transcript_path);
      const limit = Number(Deno.env.get("KILN_CHAT_ROLLOVER_TOKENS"));
      const verdict = await call<{ block: boolean; reason?: string }>(paths, "chat.stop", {
        id: chatId,
        text: input.last_assistant_message || seen.text,
        tokens: seen.tokens,
        limit: limit > 0 ? limit : undefined,
        alreadyBlocked: input.stop_hook_active === true,
      });
      if (verdict.block) {
        console.log(JSON.stringify({ decision: "block", reason: verdict.reason }));
      }
    }
  } catch (err) {
    // Never let a hook failure wedge the chat: the status line shows it, a stop is let through.
    if (event === "status-line") console.log(`kiln · unavailable (${(err as Error).message})`);
    else console.error(`kiln: ${(err as Error).message}`);
  }
  return 0;
}
