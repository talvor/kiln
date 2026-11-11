// Test harness: runs the real `kiln` CLI against a throwaway Kiln home.
// Tests observe only what a user could: CLI output, exit codes, and files in the home.
import { fromFileUrl, join } from "@std/path";

const MAIN = fromFileUrl(new URL("../src/main.ts", import.meta.url));

export interface Home {
  root: string;
  env: Record<string, string>;
  dirs: { config: string; data: string; state: string; runtime: string };
  kiln(...args: string[]): Promise<Result>;
  /** Like kiln(), with text on the command's standard input (default: no input). */
  kilnWithInput(input: string, ...args: string[]): Promise<Result>;
}
export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

export async function makeHome(extraEnv: Record<string, string> = {}): Promise<Home> {
  const root = await Deno.makeTempDir({ dir: "/tmp", prefix: "kiln-" }); // short: unix socket paths are length-limited;
  const dirs = {
    config: join(root, "config"),
    data: join(root, "data"),
    state: join(root, "state"),
    runtime: join(root, "run"),
  };
  await Deno.mkdir(join(root, "xdg"));
  const env: Record<string, string> = {
    PATH: Deno.env.get("PATH") ?? "",
    HOME: root,
    XDG_RUNTIME_DIR: join(root, "xdg"), // where Worktrees get their short TMPDIR
    DENO_DIR: Deno.env.get("DENO_DIR") ?? join(Deno.env.get("HOME") ?? root, ".cache", "deno"),
    KILN_CONFIG_DIR: dirs.config,
    KILN_DATA_DIR: dirs.data,
    KILN_STATE_DIR: dirs.state,
    KILN_RUNTIME_DIR: dirs.runtime,
    ...extraEnv,
  };
  return {
    root,
    env,
    dirs,
    kiln: (...args) => runKiln(env, args),
    kilnWithInput: (input, ...args) => runKiln(env, args, input),
  };
}

export async function runKiln(
  env: Record<string, string>,
  args: string[],
  input = "",
  cwd?: string,
): Promise<Result> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, ...args],
    cwd,
    env,
    clearEnv: true,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stdin = child.stdin.getWriter();
  await stdin.write(new TextEncoder().encode(input)).catch(() => {});
  await stdin.close().catch(() => {});
  const out = await child.output();
  const dec = new TextDecoder();
  return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
}

/** Run a test body against a fresh home; always stops the daemon and removes the home. */
export function withHome(
  name: string,
  body: (home: Home) => Promise<void>,
  extraEnv: Record<string, string> = {},
): void {
  Deno.test(name, async () => {
    const home = await makeHome(extraEnv);
    try {
      await body(home);
    } finally {
      await home.kiln("daemon", "stop");
      await Deno.remove(home.root, { recursive: true });
    }
  });
}

export async function status(home: Home) {
  const r = await home.kiln("daemon", "status", "--json");
  return { ...r, info: r.code === 0 ? JSON.parse(r.stdout) : null };
}

/** One raw call to a running daemon over its socket, as a client other than the CLI would make it. */
export async function rawCall(
  home: Home,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ ok: boolean; result?: unknown; error?: string; code?: string }> {
  const conn = await Deno.connect({
    transport: "unix",
    path: join(home.dirs.runtime, "kiln.sock"),
  });
  try {
    await conn.write(new TextEncoder().encode(JSON.stringify({ id: 1, method, params }) + "\n"));
    const buf = new Uint8Array(65536);
    let text = "";
    while (!text.includes("\n")) {
      const n = await conn.read(buf);
      if (n === null) break;
      text += new TextDecoder().decode(buf.subarray(0, n));
    }
    return JSON.parse(text);
  } finally {
    conn.close();
  }
}

/** The data of every event of a kind the daemon recorded, oldest first. */
export async function eventsOf(home: Home, kind: string): Promise<Record<string, unknown>[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(home.dirs.data, "kiln.db"), { readOnly: true });
  try {
    return db.prepare("select data from events where kind = ? order by id").all(kind)
      .map((r) => JSON.parse(String(r.data)));
  } finally {
    db.close();
  }
}
