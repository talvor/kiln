import { join } from "@std/path";

export interface KilnPaths {
  /** Configuration: roles, playbooks, config file. Safe to keep in git. */
  config: string;
  /** Durable data: the store, Project clones, worktrees, backups. */
  data: string;
  /** Logs and other state that can be lost without harm. */
  state: string;
  /** Directory holding the daemon socket; private to the user. */
  runtime: string;
  socket: string;
  store: string;
  backups: string;
  /** Kiln's own clones of registered Projects, one directory per Project. */
  projects: string;
  /** Worktrees for Requests and Assignments; outside every Project's clone. */
  worktrees: string;
  /** Lavish pages for Escalations; local files, never published. */
  pages: string;
  log: string;
  /** Where the Overseer's chat session works; empty, so there is nothing in it to change. */
  chat: string;
}

type Env = Record<string, string | undefined>;

/**
 * Resolve Kiln's per-purpose locations. `KILN_*_DIR` variables win (used by tests and
 * unusual setups); then the XDG variables on Linux; then each OS's conventional default.
 */
export function resolvePaths(
  env: Env = Deno.env.toObject(),
  os: string = Deno.build.os,
): KilnPaths {
  const home = env.HOME;
  if (!home) throw new Error("HOME is not set; cannot locate Kiln's files");

  let config: string, data: string, state: string, runtime: string;
  if (os === "darwin") {
    const support = join(home, "Library", "Application Support", "kiln");
    config = env.KILN_CONFIG_DIR ?? join(support, "config");
    data = env.KILN_DATA_DIR ?? join(support, "data");
    state = env.KILN_STATE_DIR ?? join(home, "Library", "Logs", "kiln");
    runtime = env.KILN_RUNTIME_DIR ?? join(state, "run");
  } else {
    const xdgState = env.XDG_STATE_HOME || join(home, ".local", "state");
    config = env.KILN_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME || join(home, ".config"), "kiln");
    data = env.KILN_DATA_DIR ?? join(env.XDG_DATA_HOME || join(home, ".local", "share"), "kiln");
    state = env.KILN_STATE_DIR ?? join(xdgState, "kiln");
    runtime = env.KILN_RUNTIME_DIR ??
      (env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "kiln") : join(state, "run"));
  }
  const socket = join(runtime, "kiln.sock");
  // sun_path is ~104 bytes on macOS and 108 on Linux; fail early with a fix, not at bind time.
  if (new TextEncoder().encode(socket).length > 100) {
    throw new Error(
      `The daemon socket path is too long for a unix socket (${socket}). ` +
        `Set KILN_RUNTIME_DIR to a shorter directory.`,
    );
  }
  return {
    config,
    data,
    state,
    runtime,
    socket,
    store: join(data, "kiln.db"),
    backups: join(data, "backups"),
    projects: join(data, "projects"),
    worktrees: join(data, "worktrees"),
    pages: join(data, "pages"),
    log: join(state, "daemon.log"),
    chat: join(data, "overseer"),
  };
}

/** Create every directory Kiln writes to, private to the user. */
export function ensureDirs(p: KilnPaths): void {
  for (
    const dir of [
      p.config,
      p.data,
      p.backups,
      p.projects,
      p.worktrees,
      p.pages,
      p.chat,
      p.state,
      p.runtime,
    ]
  ) {
    Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // The socket directory must be private even if it already existed.
  Deno.chmodSync(p.runtime, 0o700);
}
