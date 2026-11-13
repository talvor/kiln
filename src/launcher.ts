// The launcher: how Kiln starts Claude on a piece of work. It drives the installed `claude`
// through the Claude Agent SDK, on a cheap model and under a spend cap.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "@std/path";
import { delimiter } from "node:path";

/** Workers run on the cheapest model: cost matters more than depth for launcher-level work. */
export const LAUNCHER_MODEL = "haiku";
/** SDK budget per launch, in USD; a completed call can exceed it slightly. */
export const MAX_LAUNCH_USD = 0.25;

export interface LaunchRequest {
  prompt: string;
  /** Directory Claude works in: a Project checkout. */
  cwd: string;
  env?: Record<string, string>;
  readOnly?: boolean;
  /** Override the spend cap for this launch (USD); never raises it above MAX_LAUNCH_USD. */
  maxBudgetUsd?: number;
  /** Stop after this many agent turns. */
  maxTurns?: number;
  /** Called whenever Claude shows a sign of life, e.g. a message on the stream. */
  onActivity?: () => void;
  /** MCP servers (stdio) to give Claude, by name. */
  mcpServers?: Record<string, { command: string; args?: string[] }>;
  /** Tools Claude may use without asking, e.g. the tools of an MCP server above. */
  allowedTools?: string[];
  /** Extra settings for this launch, e.g. hooks. */
  settings?: Record<string, unknown>;
  /** Built-in tools Claude has at all; others are not offered. Overrides `readOnly`. */
  tools?: string[];
  /** Permission rules that refuse a call outright, e.g. `Bash(sudo *)`. */
  disallowedTools?: string[];
  /** Deny anything not allowed, instead of accepting edits. */
  denyByDefault?: boolean;
  /** Claude's sandbox for commands, e.g. where they may write. */
  sandbox?: Record<string, unknown>;
  /** Keep the Claude session so a later launch can resume it. */
  persist?: boolean;
  /** Resume this earlier Claude session instead of starting a new one. */
  resume?: string;
  abortController?: AbortController;
}

export interface LaunchResult {
  ok: boolean;
  /** Claude's final answer, or the reason it stopped. */
  text: string;
  /** How the run ended: "success", or an SDK error subtype such as "error_max_budget_usd". */
  outcome: string;
  /** Estimated cost of the launch in USD. */
  costUsd: number;
  /** Agent turns the launch took. */
  turns: number;
  model: string;
  maxBudgetUsd: number;
  /** The Claude session the launch ran in; pass it as `resume` to carry on in it. */
  sessionId?: string;
}

export class ClaudeNotInstalled extends Error {
  constructor() {
    super("the `claude` command was not found on PATH; install Claude Code to launch work");
  }
}

/**
 * A launch that failed, with what is known about why. The Claude Agent SDK words every failure to
 * spawn the binary as a libc mismatch, whatever its cause; this says what was actually found.
 */
export class LaunchError extends Error {}

/** Whether `cwd` is missing: Claude cannot be started in a directory that does not exist. */
export function workdirMissing(cwd: string): boolean {
  try {
    return !Deno.statSync(cwd).isDirectory;
  } catch {
    return true;
  }
}

/** How much of the child's stderr a failure keeps. */
const STDERR_KEEP = 2000;

/**
 * The error to report for a launch that failed. The SDK blames the binary's libc when spawning it
 * fails with ENOENT, but Node reports a missing working directory the same way, so a directory
 * that is gone is named first. Otherwise the SDK's message is kept, with the spawn error's code
 * and what the child wrote to stderr added to it.
 */
export function explainLaunchError(err: unknown, cwd: string, stderr: string): Error {
  if (workdirMissing(cwd)) {
    return new LaunchError(
      `cannot start Claude: its working directory ${cwd} does not exist` +
        ` (the launcher's "failed to launch" text for this is misleading)`,
      { cause: err },
    );
  }
  const base = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  const tail = stderr.trim().slice(-STDERR_KEEP);
  const parts = [base];
  if (typeof code === "string" || typeof code === "number") parts.push(`code: ${code}`);
  if (tail && !base.includes(tail)) parts.push(`stderr: ${tail}`);
  return new LaunchError(parts.length > 1 ? `${parts[0]} (${parts.slice(1).join("; ")})` : base, {
    cause: err,
  });
}

/** Find the installed `claude` executable on PATH. */
export function findClaude(): string {
  for (const dir of (Deno.env.get("PATH") ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(dir, "claude");
    try {
      const info = Deno.statSync(candidate);
      if (info.isFile && info.mode !== null && (info.mode & 0o111) !== 0) {
        return Deno.realPathSync(candidate);
      }
    } catch { /* not here */ }
  }
  throw new ClaudeNotInstalled();
}

/** Launch Claude on a request with the installed `claude` and wait for it to finish. */
export async function launch(req: LaunchRequest): Promise<LaunchResult> {
  const maxBudgetUsd = Math.min(req.maxBudgetUsd ?? MAX_LAUNCH_USD, MAX_LAUNCH_USD);
  if (workdirMissing(req.cwd)) throw explainLaunchError(undefined, req.cwd, "");
  let stderr = "";
  const run = query({
    prompt: req.prompt,
    options: {
      cwd: req.cwd,
      env: req.env ? { ...Deno.env.toObject(), ...req.env } : undefined,
      model: LAUNCHER_MODEL,
      maxBudgetUsd,
      maxTurns: req.maxTurns,
      pathToClaudeCodeExecutable: findClaude(),
      permissionMode: req.denyByDefault ? "dontAsk" : "acceptEdits",
      tools: req.tools ?? (req.readOnly ? ["Read", "Glob", "Grep"] : undefined),
      disallowedTools: req.disallowedTools,
      sandbox: req.sandbox,
      persistSession: req.persist === true || req.resume !== undefined,
      resume: req.resume,
      settingSources: [],
      mcpServers: req.mcpServers,
      allowedTools: req.allowedTools,
      settings: req.settings,
      abortController: req.abortController,
      stderr: (data) => {
        stderr = (stderr + data).slice(-STDERR_KEEP * 2);
      },
    },
  });
  try {
    for await (const msg of run) {
      req.onActivity?.();
      if (msg.type !== "result") continue;
      const base = {
        costUsd: msg.total_cost_usd,
        turns: msg.num_turns,
        model: LAUNCHER_MODEL,
        maxBudgetUsd,
        sessionId: msg.session_id,
      };
      return msg.subtype === "success"
        ? { ...base, ok: !msg.is_error, text: msg.result, outcome: msg.subtype }
        : { ...base, ok: false, text: msg.errors.join("; ") || msg.subtype, outcome: msg.subtype };
    }
  } catch (err) {
    throw explainLaunchError(err, req.cwd, stderr);
  } finally {
    run.close();
  }
  throw explainLaunchError(new Error("claude exited without producing a result"), req.cwd, stderr);
}
