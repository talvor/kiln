// Read-only `gh` for workers. A worker's sandbox cannot see Kiln's GitHub credentials, so it asks
// the daemon to run an allowlisted read of its own Project's repository and gets the output back.
// The token never enters the sandbox, and nothing here can change the forge.
import { REMOTE_TIMEOUT_MS, run } from "./checks.ts";

/** What a worker may run: the first two words of the command. */
const READS = new Set([
  "issue view",
  "issue list",
  "pr view",
  "pr list",
  "pr diff",
  "pr checks",
  "run list",
  "run view",
  "repo view",
  "label list",
]);
/** Flags that reach another repository or host, open a browser or an editor. */
const REFUSED_FLAGS = new Set(["--repo", "--hostname", "--web", "--editor"]);
/** Flags of `gh api` that make it more than a plain GET. */
const API_WRITES = new Set([
  "--field",
  "--raw-field",
  "--input",
  "--header",
  "--preview",
]);
const MAX_ARGS = 40;
const MAX_ARG_LENGTH = 4000;
export const MAX_OUTPUT_BYTES = 64 * 1024;

/** `owner/repo` of a GitHub remote URL; null for anything else. */
export function repoSlug(remoteUrl: string): string | null {
  const m = remoteUrl.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The Project's `owner/repo`: from its remote when that is a GitHub URL, otherwise as `gh` names
 * it (an ssh alias, an Enterprise host); null when neither can say.
 */
export async function projectSlug(clonePath: string, remoteUrl: string): Promise<string | null> {
  const parsed = repoSlug(remoteUrl);
  if (parsed) return parsed;
  try {
    const r = await run(
      "gh",
      ["repo", "view", "--json", "nameWithOwner"],
      clonePath,
      REMOTE_TIMEOUT_MS,
    );
    const name = r.code === 0 ? JSON.parse(r.stdout).nameWithOwner : null;
    return typeof name === "string" && /^[^/\s]+\/[^/\s]+$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** Why `args` may not run, or null when they may. */
export function refuseGhArgs(args: unknown, slug: string): string | null {
  if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== "string")) {
    return 'gh needs a list of string arguments, e.g. ["issue", "view", "12"].';
  }
  const list = args as string[];
  if (list.length > MAX_ARGS || list.some((a) => a.length > MAX_ARG_LENGTH || a.includes("\0"))) {
    return "Those arguments are too long.";
  }
  const own = slug.toLowerCase();
  const isApi = list[0] === "api";
  if (!isApi && !READS.has(`${list[0]} ${list[1] ?? ""}`)) {
    return `Only reads of this Project's repository are allowed: api (GET), ` +
      `${[...READS].join(", ")}. Kiln opens pull requests, comments and closes tickets itself.`;
  }
  let endpoint: string | undefined;
  for (let i = 1; i < list.length; i++) {
    const arg = list[i];
    if (arg.startsWith("--")) {
      const [flag, inline] = arg.split(/=(.*)/s);
      if (REFUSED_FLAGS.has(flag)) return `${flag} is not allowed.`;
      if (isApi && API_WRITES.has(flag)) return `${flag} is not allowed: gh api here is GET only.`;
      if (isApi && flag === "--method") {
        const method = inline ?? list[i + 1];
        if (method?.toUpperCase() !== "GET") return "gh api here is GET only.";
      }
    } else if (/^-[A-Za-z]/.test(arg)) {
      // A cluster of short flags: refuse -R (repo), -w (web), and for api the writing ones.
      if (/^-[A-Za-z]*[Rw]/.test(arg)) return `${arg} is not allowed.`;
      if (isApi && /^-[A-Za-z]*[fFH]/.test(arg)) return `${arg} is not allowed: GET only.`;
      if (isApi && /^-[A-Za-z]*X/.test(arg)) {
        const method = arg.length > 2 && !arg.endsWith("X")
          ? arg.slice(arg.indexOf("X") + 1)
          : list[i + 1];
        if (method?.toUpperCase() !== "GET") return "gh api here is GET only.";
      }
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
      if (!arg.toLowerCase().startsWith(`https://github.com/${own}/`)) {
        return `${arg} is outside this Project's repository (${slug}).`;
      }
    } else if (
      isApi && endpoint === undefined && list[i - 1] !== "-X" && !list[i - 1].startsWith("--")
    ) {
      endpoint = arg;
    } else if (!isApi && list[0] === "repo" && /^[^/\s]+\/[^/\s]+$/.test(arg)) {
      if (arg.toLowerCase() !== own) return `${arg} is not this Project's repository (${slug}).`;
    }
  }
  if (isApi) {
    if (endpoint === undefined) return "gh api needs an endpoint.";
    const path = endpoint.replace(/^\//, "");
    const lower = path.toLowerCase();
    const inRepo = lower === `repos/${own}` || lower.startsWith(`repos/${own}/`) ||
      path === "repos/{owner}/{repo}" || path.startsWith("repos/{owner}/{repo}/");
    if (!inRepo || path.split(/[/?]/).includes("..")) {
      return `gh api here may only read repos/${slug}/... endpoints.`;
    }
  }
  return null;
}

/** Run an allowed read in the Project's clone and return what it printed. */
export async function ghRead(
  clonePath: string,
  slug: string,
  args: unknown,
): Promise<{ code: number; output: string; truncated: boolean }> {
  const refused = refuseGhArgs(args, slug);
  if (refused) return { code: 1, output: refused, truncated: false };
  let result;
  try {
    result = await run("gh", args as string[], clonePath, REMOTE_TIMEOUT_MS);
  } catch {
    return { code: 127, output: "The gh command is not available to Kiln.", truncated: false };
  }
  const text = result.code === 0 ? result.stdout : (result.stderr || result.stdout);
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_OUTPUT_BYTES) {
    return { code: result.code, output: text, truncated: false };
  }
  const cut = new TextDecoder().decode(bytes.slice(0, MAX_OUTPUT_BYTES));
  return { code: result.code, output: cut, truncated: true };
}
