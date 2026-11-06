// Shared by registering and managing Projects: running git and shell commands in Kiln's clone,
// and the checks made on a Project's remote.
export const SETUP_TIMEOUT_MS = 15 * 60_000;
export const TEST_TIMEOUT_MS = 30 * 60_000;
export const OUTPUT_TAIL_BYTES = 4000;
export const PUSH_CHECK_REF = "refs/heads/kiln/registration-check";

/** Warnings about commands a Project lacks. */
export function commandWarnings(
  commands: { test: string | null; lint: string | null; build: string | null },
  opts: { includeTest?: boolean } = {},
): string[] {
  const warnings: string[] = [];
  if (!commands.lint) warnings.push("No lint command: nothing will check style before merge.");
  if (!commands.build) {
    warnings.push("No build command: nothing will check that the project builds.");
  }
  if (opts.includeTest !== false && !commands.test) {
    warnings.push("No test command: no test baseline was recorded.");
  }
  return warnings;
}

export async function defaultBranchOf(clonePath: string): Promise<string> {
  const ref = await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], clonePath);
  if (ref.code === 0) return ref.stdout.trim().replace(/^origin\//, "");
  return (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], clonePath)).stdout.trim();
}

export async function branchProtection(clonePath: string, branch: string): Promise<string | null> {
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await run(
      "gh",
      ["api", `repos/{owner}/{repo}/branches/${encodeURIComponent(branch)}/protection`],
      clonePath,
    );
  } catch {
    return `Could not confirm branch protection for "${branch}": the gh command is not available.`;
  }
  if (result.code === 0) return null;
  if (/404/.test(result.stderr)) {
    return `Could not confirm branch protection for "${branch}": API returned 404.`;
  }
  return `Could not confirm branch protection for "${branch}": ${firstLine(result.stderr)}`;
}

export interface Output {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(cmd: string, args: string[], cwd?: string): Promise<Output> {
  const child = new Deno.Command(cmd, {
    args,
    cwd,
    // Never wait for credentials that nobody can type.
    env: { GIT_TERMINAL_PROMPT: "0" },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const out = await child.output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
}

export async function shell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  const child = new Deno.Command("sh", {
    args: ["-c", `exec 2>&1; ${command}`],
    cwd,
    detached: true,
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      Deno.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
    }
  }, timeoutMs);
  let bytes = new Uint8Array();
  const drain = (async () => {
    for await (const chunk of child.stdout) {
      const end = chunk.subarray(Math.max(0, chunk.length - OUTPUT_TAIL_BYTES));
      if (end.length === OUTPUT_TAIL_BYTES) {
        bytes = end.slice();
      } else {
        const next = new Uint8Array(Math.min(OUTPUT_TAIL_BYTES, bytes.length + end.length));
        const previous = bytes.subarray(Math.max(0, bytes.length - (next.length - end.length)));
        next.set(previous);
        next.set(end, previous.length);
        bytes = next;
      }
    }
  })();
  try {
    const [status] = await Promise.all([child.status, drain]);
    const output = new TextDecoder().decode(bytes);
    return {
      code: timedOut ? 124 : status.code,
      output: timedOut ? `timed out after ${timeoutMs / 60_000} minutes\n${output}` : output,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const firstLine = (s: string) => s.trim().split("\n").find(Boolean) ?? "(no message)";
export const tail = (s: string) => s.length > OUTPUT_TAIL_BYTES ? s.slice(-OUTPUT_TAIL_BYTES) : s;
