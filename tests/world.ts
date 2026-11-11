// Test world: a Kiln home (see helpers.ts) plus everything Kiln talks to outside itself,
// all fake and local: a scripted `claude` launcher, a bare git remote with a seeded Project
// clone, and a scripted PR-status command (`gh`). The shims sit first on PATH, so the real
// daemon and anything it spawns finds them exactly as it would find the real tools.
import { fromFileUrl, join } from "@std/path";
import { type Home, makeHome, type Result, runKiln } from "./helpers.ts";
import type { LauncherRun } from "./fakes/claude.ts";

const MAIN = fromFileUrl(new URL("../src/main.ts", import.meta.url));
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
  /** When the call was made, in milliseconds since the epoch (the launcher records it). */
  at?: number;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/** A running `kiln dashboard --no-open`, seen the way a browser would see it. */
export interface DashboardProcess {
  pid: number;
  port: number;
  /** The first line the process printed: the URL with the per-launch token. */
  url: string;
  token: string;
  origin: string;
  /** One HTTP request, never following redirects; `host` and `origin` override the defaults. */
  fetch(
    path: string,
    init?: { method?: string; cookie?: string; host?: string; origin?: string },
  ): Promise<Response>;
  /** Spend the URL's token and return the session cookie ("name=value"). */
  signIn(): Promise<string>;
  /** Stop it with Ctrl-C and return its exit code. */
  interrupt(): Promise<number>;
}

export interface World extends Home {
  /** Start the real `kiln dashboard --no-open` against this world's daemon socket. */
  dashboard(...args: string[]): Promise<DashboardProcess>;
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
    /** What `gh issue view` replies, in order; after that every ticket is found. */
    scriptViews(replies: ApiReply[]): Promise<void>;
    /** The tickets Kiln published, in order. */
    issues(): Promise<{ title: string; body: string; cwd?: string }[]>;
    /** The tickets Kiln closed, in order: the tracker item and the closing comment. */
    closed(): Promise<{ item: string; comment: string }[]>;
  };
  /** The fake `lavish-axi`, which Kiln opens Escalation pages with. */
  lavish: {
    /** The arguments of every call, in order. */
    calls(): Promise<string[][]>;
    /** From now on it fails, as if Lavish could not open anything. */
    breakDown(): Promise<void>;
  };
  /** The scripted `gh pr create` and `gh pr comment`, which Kiln reports its work through. */
  pullRequests: {
    script(replies: ApiReply[]): Promise<void>;
    /** The pull requests Kiln opened, in order. */
    created(): Promise<
      { title: string; body: string; head: string; base: string; draft: boolean }[]
    >;
    /** The comments Kiln made: the pull request and the text. */
    comments(): Promise<{ pr: string; body: string }[]>;
  };
  /** A clone of the remote, standing in for a registered Project's checkout. */
  project: { path: string };
  /** The scripted `claude`: runs are consumed in order, one per invocation. */
  launcher: {
    script(runs: LauncherRun[]): Promise<void>;
    /** From now on `claude auth status` says nobody is logged in. */
    logOut(): Promise<void>;
    calls(): Promise<Call[]>;
    /** The prompts Claude was given, in order (SDK launches only). */
    prompts(): Promise<string[]>;
  };
  /** The scripted PR-status command: statuses are consumed in order. */
  prStatus: { script(statuses: PrStatus[]): Promise<void>; calls(): Promise<Call[]> };
  /** Stop every dashboard this world started (the harness does this at the end of a test). */
  stopDashboards(): Promise<void>;
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
    // Look at pull requests every second rather than every minute.
    KILN_PR_POLL_SECONDS: "1",
    KILN_FAULT_CHECK_SECONDS: "1",
    // Check whether the daily digest is due every second rather than every half minute.
    KILN_DIGEST_CHECK_SECONDS: "1",
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

  const dashboards: { child: Deno.ChildProcess; done: boolean }[] = [];
  const dashboard = async (...args: string[]): Promise<DashboardProcess> => {
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", MAIN, "dashboard", "--no-open", ...args],
      env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const tracked = { child, done: false };
    child.status.then(() => tracked.done = true);
    dashboards.push(tracked);
    const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    while (!text.includes("\n")) {
      const { value, done } = await lines.read();
      if (done) {
        throw new Error(`kiln dashboard printed no URL (exit ${(await child.status).code})`);
      }
      text += value;
    }
    lines.releaseLock();
    const url = text.split("\n")[0];
    const parsed = new URL(url);
    const port = Number(parsed.port);
    const origin = `http://127.0.0.1:${port}`;
    const self: DashboardProcess = {
      pid: child.pid,
      port,
      url,
      token: parsed.searchParams.get("token") ?? "",
      origin,
      fetch: (path, init = {}) => {
        const headers: Record<string, string> = {};
        if (init.cookie) headers.cookie = init.cookie;
        if (init.origin) headers.origin = init.origin;
        // fetch() will not send a Host of our choosing, so that takes a hand-written request.
        if (init.host !== undefined) {
          return rawRequest(port, init.method ?? "GET", path, { ...headers, host: init.host });
        }
        return fetch(origin + path, { method: init.method, headers, redirect: "manual" });
      },
      signIn: async () => {
        const res = await self.fetch(`/?token=${self.token}`);
        await res.body?.cancel();
        return (res.headers.get("set-cookie") ?? "").split(";")[0];
      },
      interrupt: async () => {
        child.kill("SIGINT");
        return (await child.status).code;
      },
    };
    return self;
  };
  const stopDashboards = async () => {
    for (const d of dashboards) {
      if (!d.done) d.child.kill("SIGKILL");
      await d.child.status;
    }
  };

  return {
    ...base,
    env,
    dashboard,
    stopDashboards,
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
      logOut: async () => {
        await Deno.mkdir(join(fakeDir, "launcher"), { recursive: true });
        await Deno.writeTextFile(join(fakeDir, "launcher", "logged-out"), "");
      },
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
      scriptViews: (replies) => script("issue-view", "replies", replies),
      issues: async () =>
        (await calls("issue")).map((call) => {
          const flag = (name: string) => call.args[call.args.indexOf(name) + 1];
          return { title: flag("--title"), body: flag("--body"), cwd: call.cwd };
        }),
      closed: async () =>
        (await calls("issue-close")).map((call) => ({
          item: call.args[2],
          comment: call.args[call.args.indexOf("--comment") + 1],
        })),
    },
    pullRequests: {
      script: (replies) => script("pr-create", "replies", replies),
      created: async () =>
        (await calls("pr-create")).map((call) => {
          const flag = (name: string) => call.args[call.args.indexOf(name) + 1];
          return {
            title: flag("--title"),
            body: flag("--body"),
            head: flag("--head"),
            base: flag("--base"),
            draft: call.args.includes("--draft"),
          };
        }),
      comments: async () =>
        (await calls("pr-comment")).map((call) => ({
          pr: call.args[2],
          body: call.args[call.args.indexOf("--body") + 1],
        })),
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
      await world.stopDashboards();
      await world.kiln("daemon", "stop");
      await removeTree(world.root);
    }
  });
}

/**
 * Remove a directory tree. A worker process stopped by the daemon may still be
 * writing into the tree for a moment (macOS reports "Directory not empty"), so
 * retry until it has fully exited.
 */
async function removeTree(path: string): Promise<void> {
  for (let attempt = 0;; attempt++) {
    try {
      await Deno.remove(path, { recursive: true });
      return;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/** One HTTP/1.1 request over a bare socket, so any Host header can be sent. */
async function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<Response> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
    await conn.write(
      new TextEncoder().encode(`${method} ${path} HTTP/1.1\r\n${head}connection: close\r\n\r\n`),
    );
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(8192);
    for (let n = await conn.read(buf); n !== null; n = await conn.read(buf)) {
      chunks.push(buf.slice(0, n));
    }
    const raw = new TextDecoder().decode(
      chunks.reduce((all, c) => new Uint8Array([...all, ...c]), new Uint8Array()),
    );
    const [top, ...rest] = raw.split("\r\n\r\n");
    const [statusLine, ...headerLines] = top.split("\r\n");
    const res = new Headers();
    for (const line of headerLines) {
      const i = line.indexOf(":");
      res.append(line.slice(0, i), line.slice(i + 1).trim());
    }
    res.delete("transfer-encoding");
    return new Response(rest.join("\r\n\r\n") || null, {
      status: Number(statusLine.split(" ")[1]),
      headers: res,
    });
  } finally {
    conn.close();
  }
}
