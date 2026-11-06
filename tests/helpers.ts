// Test harness: runs the real `kiln` CLI against a throwaway Kiln home.
// Tests observe only what a user could: CLI output, exit codes, and files in the home.
import { fromFileUrl, join } from "@std/path";

const MAIN = fromFileUrl(new URL("../src/main.ts", import.meta.url));

export interface Home {
  root: string;
  env: Record<string, string>;
  dirs: { config: string; data: string; state: string; runtime: string };
  kiln(...args: string[]): Promise<Result>;
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
  const env: Record<string, string> = {
    PATH: Deno.env.get("PATH") ?? "",
    HOME: root,
    DENO_DIR: Deno.env.get("DENO_DIR") ?? join(Deno.env.get("HOME") ?? root, ".cache", "deno"),
    KILN_CONFIG_DIR: dirs.config,
    KILN_DATA_DIR: dirs.data,
    KILN_STATE_DIR: dirs.state,
    KILN_RUNTIME_DIR: dirs.runtime,
    ...extraEnv,
  };
  return { root, env, dirs, kiln: (...args) => runKiln(env, args) };
}

export async function runKiln(env: Record<string, string>, args: string[]): Promise<Result> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, ...args],
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
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
