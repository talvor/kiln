// Test world: a Kiln home (see helpers.ts) plus everything Kiln talks to outside itself,
// all fake and local: a scripted `claude` launcher, a bare git remote with a seeded Project
// clone, and a scripted PR-status command (`gh`). The shims sit first on PATH, so the real
// daemon and anything it spawns finds them exactly as it would find the real tools.
import { fromFileUrl, join } from "@std/path";
import { type Home, makeHome, type Result, runKiln } from "./helpers.ts";
import type { LauncherRun } from "./fakes/claude.ts";

const FAKES = fromFileUrl(new URL("./fakes/", import.meta.url));

export interface PrStatus {
  state: "OPEN" | "MERGED" | "CLOSED";
  checks: "PENDING" | "SUCCESS" | "FAILURE";
}
export interface ApiReply {
  stdout?: string;
  stderr?: string;
  exit?: number;
}
interface Call {
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface World extends Home {
  /** Bare git repository standing in for the Project's remote (`origin`). */
  remote: {
    path: string;
    branches(): Promise<string[]>;
    /** From now on the remote can be fetched from but not pushed to. */
    refusePushes(): Promise<void>;
  };
  /** The scripted `gh api`, which Kiln asks about the default branch's protection. */
  githubApi: {
    script(replies: ApiReply[]): Promise<void>;
    calls(): Promise<Call[]>;
  };
  /** The scripted `gh issue create`, which Kiln publishes tickets through. */
  tracker: {
    script(replies: ApiReply[]): Promise<void>;
    /** The tickets Kiln published, in order. */
    issues(): Promise<{ title: string; body: string; cwd?: string }[]>;
  };
  /** The fake `lavish-axi`, which Kiln opens Escalation pages with. */
  lavish: {
    /** The arguments of every call, in order. */
    calls(): Promise<string[][]>;
    /** From now on it fails, as if Lavish could not open anything. */
    breakDown(): Promise<void>;
  };
  /** A clone of the remote, standing in for a registered Project's checkout. */
  project: { path: string };
  /** The scripted `claude`: runs are consumed in order, one per invocation. */
  launcher: {
    script(runs: LauncherRun[]): Promise<void>;
    calls(): Promise<Call[]>;
    /** The prompts Claude was given, in order (SDK launches only). */
    prompts(): Promise<string[]>;
  };
  /** The scripted PR-status command: statuses are consumed in order. */
  prStatus: { script(statuses: PrStatus[]): Promise<void>; calls(): Promise<Call[]> };
  /** Run a command the way the daemon would: in the world's environment. */
  exec(cwd: string, cmd: string, ...args: string[]): Promise<Result>;
  git(cwd: string, ...args: string[]): Promise<Result>;
}

export async function makeWorld(): Promise<World> {
  const base = await makeHome();
  const fakeDir = join(base.root, "fake");
  const bin = join(fakeDir, "bin");
  await Deno.mkdir(bin, { recursive: true });

  // Shims: executable files named after the real tools that hand over to the fakes.
  for (
    const [name, script] of [["claude", "claude.ts"], ["gh", "gh.ts"], ["lavish-axi", "lavish.ts"]]
  ) {
    const file = join(bin, name);
    await Deno.writeTextFile(
      file,
      `#!/bin/sh\nexec "${Deno.execPath()}" run -A "${join(FAKES, script)}" "$@"\n`,
    );
    await Deno.chmod(file, 0o755);
  }

  const gitConfig = join(base.root, "gitconfig");
  await Deno.writeTextFile(gitConfig, "");
  const env: Record<string, string> = {
    ...base.env,
    PATH: `${bin}:${base.env.PATH}`,
    KILN_FAKE_DIR: fakeDir,
    // Hermetic git: no user config (signing, hooks), fixed identity.
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Kiln Test",
    GIT_AUTHOR_EMAIL: "test@kiln.invalid",
    GIT_COMMITTER_NAME: "Kiln Test",
    GIT_COMMITTER_EMAIL: "test@kiln.invalid",
  };

  const exec = async (cwd: string, cmd: string, ...args: string[]): Promise<Result> => {
    const out = await new Deno.Command(cmd, { args, cwd, env, clearEnv: true }).output();
    const dec = new TextDecoder();
    return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
  };
  const git = async (cwd: string, ...args: string[]) => {
    const r = await exec(cwd, "git", ...args);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r;
  };

  const remotePath = join(base.root, "remote.git");
  const projectPath = join(base.root, "project");
  await git(base.root, "init", "--bare", "--initial-branch=main", remotePath);
  await git(base.root, "clone", remotePath, projectPath);
  await git(projectPath, "checkout", "-b", "main");
  await Deno.writeTextFile(join(projectPath, "README.md"), "# fake project\n");
  await git(projectPath, "add", ".");
  await git(projectPath, "commit", "-m", "Initial commit");
  await git(projectPath, "push", "origin", "main");

  const script = async (tool: string, key: string, items: unknown[]) => {
    const dir = join(fakeDir, tool);
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "script.json"), JSON.stringify({ [key]: items, next: 0 }));
  };
  const calls = async (tool: string): Promise<Call[]> => {
    try {
      const text = await Deno.readTextFile(join(fakeDir, tool, "calls.jsonl"));
      return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return [];
      throw err;
    }
  };

  return {
    ...base,
    env,
    kiln: (...args) => runKiln(env, args),
    kilnWithInput: (input, ...args) => runKiln(env, args, input),
    remote: {
      path: remotePath,
      refusePushes: () =>
        Deno.writeTextFile(
          gitConfig,
          `[url "file:///kiln-test-pushes-refused/"]\n\tpushInsteadOf = ${remotePath}\n`,
        ),
      branches: async () =>
        (await git(remotePath, "for-each-ref", "--format=%(refname:short)", "refs/heads"))
          .stdout.split("\n").filter(Boolean),
    },
    project: { path: projectPath },
    lavish: {
      calls: async () => (await calls("lavish")).map((c) => c.args),
      breakDown: async () => {
        await Deno.mkdir(join(fakeDir, "lavish"), { recursive: true });
        await Deno.writeTextFile(join(fakeDir, "lavish", "broken"), "");
      },
    },
    launcher: {
      script: (runs) => script("launcher", "runs", runs),
      calls: () => calls("launcher"),
      prompts: async () => {
        const file = join(fakeDir, "launcher", "prompts.jsonl");
        let text = "";
        try {
          text = await Deno.readTextFile(file);
        } catch (err) {
          if (!(err instanceof Deno.errors.NotFound)) throw err;
        }
        return text.split("\n").filter(Boolean).map((line) => {
          const { content } = JSON.parse(line).message;
          return typeof content === "string"
            ? content
            : content.map((b: { text?: string }) => b.text ?? "").join("");
        });
      },
    },
    githubApi: {
      script: (replies) => script("api", "replies", replies),
      calls: () => calls("api"),
    },
    tracker: {
      script: (replies) => script("issue", "replies", replies),
      issues: async () =>
        (await calls("issue")).map((call) => {
          const flag = (name: string) => call.args[call.args.indexOf(name) + 1];
          return { title: flag("--title"), body: flag("--body"), cwd: call.cwd };
        }),
    },
    prStatus: {
      script: (statuses) => script("pr-status", "statuses", statuses),
      calls: () => calls("pr-status"),
    },
    exec,
    git: (cwd, ...args) => git(cwd, ...args),
  };
}

/** Run a test body against a fresh world; always stops the daemon and removes the world. */
export function withWorld(
  name: string,
  body: (world: World) => Promise<void>,
): void {
  Deno.test(name, async () => {
    const world = await makeWorld();
    try {
      await body(world);
    } finally {
      await world.kiln("daemon", "stop");
      await Deno.remove(world.root, { recursive: true });
    }
  });
}
