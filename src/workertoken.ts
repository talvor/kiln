// Optionally hand the user's own GitHub token to workers, so their `gh` works. This is the blunt
// option: the worker can read the token from its environment and it carries everything the user
// can do on GitHub. It is therefore off unless `<config>/worker-gh-token.json` asks for it, and it
// is only a fallback: when a GitHub App is configured (`github.json`), the App's scoped token is
// used instead, and this file is ignored.
//   { "source": "gh" }                                     the token `gh auth token` prints
//   { "source": "env", "variable": "KILN_WORKER_GH_TOKEN" } a token in the daemon's environment
//   { "source": "gh", "projects": ["kiln"] }               only those Projects' workers get it
// Prefer a fine-grained token limited to the repositories and permissions a worker needs, in the
// `env` source, over the `gh` source, which is everything you can do.
import { join } from "@std/path";
import { REMOTE_TIMEOUT_MS, run } from "./checks.ts";
import { ConfigError } from "./config_error.ts";

export interface WorkerTokenConfig {
  source: "gh" | "env";
  /** For the `env` source: the daemon's environment variable that holds the token. */
  variable?: string;
  /** Only these Projects' workers get the token; every Project's when unset. */
  projects?: string[];
}

/** How long a token read from `gh auth token` is reused. */
export const GH_TOKEN_TTL_MS = 60_000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Read `worker-gh-token.json` from the config directory; null when there is none. */
export async function loadWorkerToken(configDir: string): Promise<WorkerTokenConfig | null> {
  const file = join(configDir, "worker-gh-token.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await Deno.readTextFile(file));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw new ConfigError(`${file}: not valid JSON (${(err as Error).message})`);
  }
  const fail = (why: string) => new ConfigError(`Worker GitHub token (${file}): ${why}`);
  if (!isObject(raw)) throw fail("must be a JSON object");
  for (const key of Object.keys(raw)) {
    if (!["source", "variable", "projects"].includes(key)) throw fail(`unknown field "${key}"`);
  }
  if (raw.source !== "gh" && raw.source !== "env") {
    throw fail('"source" must be "gh" (your gh login) or "env" (an environment variable)');
  }
  if (raw.source === "env") {
    if (typeof raw.variable !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.variable)) {
      throw fail('"variable" must name the environment variable that holds the token');
    }
  } else if (raw.variable !== undefined) {
    throw fail('"variable" only applies to the "env" source');
  }
  if (
    raw.projects !== undefined &&
    (!Array.isArray(raw.projects) || !raw.projects.length ||
      raw.projects.some((p) => typeof p !== "string" || !p))
  ) {
    throw fail('"projects" must list Project names');
  }
  return {
    source: raw.source,
    variable: raw.variable as string | undefined,
    projects: raw.projects as string[] | undefined,
  };
}

export interface WorkerTokensOptions {
  configDir: string;
  /** The daemon's environment; replaceable for tests. */
  getEnv?: (name: string) => string | undefined;
  /** Print what `gh auth token` says; replaceable for tests. */
  ghAuthToken?: () => Promise<string | null>;
  now?: () => number;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
}

async function readGhToken(): Promise<string | null> {
  try {
    const r = await run("gh", ["auth", "token"], undefined, REMOTE_TIMEOUT_MS);
    return r.code === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

/**
 * The user's own token for a Project's workers, when they asked for that; null otherwise, or
 * when it cannot be had (the worker then carries on without one).
 */
export function createWorkerTokens(opts: WorkerTokensOptions) {
  const getEnv = opts.getEnv ?? ((name: string) => Deno.env.get(name));
  const ghAuthToken = opts.ghAuthToken ?? readGhToken;
  const now = opts.now ?? Date.now;
  let cached: { token: string; at: number } | undefined;

  return {
    async tokenFor(project: string): Promise<{ token: string; source: "gh" | "env" } | null> {
      let config: WorkerTokenConfig | null;
      try {
        config = await loadWorkerToken(opts.configDir);
      } catch (err) {
        opts.warn?.("worker-gh-token.json is unusable; workers get no token", { err: String(err) });
        return null;
      }
      if (!config || (config.projects && !config.projects.includes(project))) return null;
      let token: string | null | undefined;
      if (config.source === "env") {
        token = getEnv(config.variable!);
      } else if (cached && now() - cached.at < GH_TOKEN_TTL_MS) {
        token = cached.token;
      } else {
        token = await ghAuthToken();
        if (token?.trim()) cached = { token: token.trim(), at: now() };
      }
      token = token?.trim();
      if (!token || /\s/.test(token)) {
        opts.warn?.("no usable GitHub token for workers", { project, source: config.source });
        return null;
      }
      return { token, source: config.source };
    },
  };
}
