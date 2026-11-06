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
  /** Override the spend cap for this launch (USD); never raises it above MAX_LAUNCH_USD. */
  maxBudgetUsd?: number;
}

export interface LaunchResult {
  ok: boolean;
  /** Claude's final answer, or the reason it stopped. */
  text: string;
  /** How the run ended: "success", or an SDK error subtype such as "error_max_budget_usd". */
  outcome: string;
  /** Estimated cost of the launch in USD. */
  costUsd: number;
  model: string;
  maxBudgetUsd: number;
}

export class ClaudeNotInstalled extends Error {
  constructor() {
    super("the `claude` command was not found on PATH; install Claude Code to launch work");
  }
}

/** Find the installed `claude` executable on PATH. */
function findClaude(): string {
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
  const run = query({
    prompt: req.prompt,
    options: {
      cwd: req.cwd,
      model: LAUNCHER_MODEL,
      maxBudgetUsd,
      pathToClaudeCodeExecutable: findClaude(),
      // Unattended: file edits in the Project are allowed, anything riskier is refused.
      permissionMode: "acceptEdits",
      persistSession: false,
      settingSources: [],
    },
  });
  try {
    for await (const msg of run) {
      if (msg.type !== "result") continue;
      const base = { costUsd: msg.total_cost_usd, model: LAUNCHER_MODEL, maxBudgetUsd };
      return msg.subtype === "success"
        ? { ...base, ok: !msg.is_error, text: msg.result, outcome: msg.subtype }
        : { ...base, ok: false, text: msg.errors.join("; ") || msg.subtype, outcome: msg.subtype };
    }
  } finally {
    run.close();
  }
  throw new Error("claude exited without producing a result");
}
