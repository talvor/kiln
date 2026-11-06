// The launcher: how Kiln starts Claude on a piece of work. It drives the installed `claude`
// through the Claude Agent SDK, on a cheap model and under a spend cap.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { join } from "@std/path";
import { delimiter } from "node:path";

/** Workers run on the cheapest model: cost matters more than depth for launcher-level work. */
export const LAUNCHER_MODEL = "haiku";
/** Most a single launch may spend, in USD. The SDK stops the run once it is exceeded. */
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
export function findClaude(pathVar = Deno.env.get("PATH") ?? ""): string {
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "claude");
    try {
      if (Deno.statSync(candidate).isFile) return candidate;
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
