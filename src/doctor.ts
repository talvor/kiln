// `kiln doctor`: is this machine ready for Kiln to do work? Checks what Kiln cannot work
// without (git, Claude installed and logged in, its store, the remotes of its Projects) and what it
// merely does better with (the tools it publishes through), and says how to fix what is wrong.
import { call, DaemonNotRunning, ensureDaemon } from "./client.ts";
import { findClaude } from "./launcher.ts";
import { loadLimits } from "./limits.ts";
import type { DaemonStatus } from "./daemon.ts";
import type { KilnPaths } from "./paths.ts";
import type { ProjectRecord } from "./store.ts";

export interface Check {
  name: string;
  /** `warn`: Kiln works, but the user should know. */
  status: "ok" | "warn" | "fail";
  detail: string;
}

const COMMAND_TIMEOUT_MS = 20_000;

/** Run a command and say how it went; never throws. */
async function run(cmd: string, args: string[], cwd?: string) {
  try {
    const out = await new Deno.Command(cmd, {
      args,
      cwd,
      env: { GIT_TERMINAL_PROMPT: "0" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
    }).output();
    const dec = new TextDecoder();
    return {
      ran: true,
      code: out.code,
      stdout: dec.decode(out.stdout),
      stderr: dec.decode(out.stderr),
    };
  } catch (err) {
    return { ran: false, code: -1, stdout: "", stderr: (err as Error).message };
  }
}

const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

export async function runDoctor(
  paths: KilnPaths,
  options: { startDaemon?: boolean } = {},
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: Check["status"], detail: string) =>
    checks.push({ name, status, detail });

  const git = await run("git", ["--version"]);
  if (git.ran && git.code === 0) add("git", "ok", firstLine(git.stdout));
  else add("git", "fail", "git was not found on PATH; install git");

  let claude: string | undefined;
  try {
    claude = findClaude();
  } catch (err) {
    add("claude", "fail", `${(err as Error).message}`);
  }
  if (claude) {
    const version = await run(claude, ["--version"]);
    if (version.code === 0) add("claude version", "ok", firstLine(version.stdout));
    else add("claude version", "fail", `\`claude --version\` failed: ${firstLine(version.stderr)}`);
    const login = await run(claude, ["auth", "status"]);
    let loggedIn = login.code === 0;
    try {
      const parsed = JSON.parse(login.stdout);
      if (parsed && typeof parsed.loggedIn === "boolean") loggedIn = parsed.loggedIn;
    } catch { /* plain text: the exit code decides */ }
    if (loggedIn) add("claude login", "ok", "logged in");
    else add("claude login", "fail", "Claude is not logged in; run `claude auth login`");
  }

  let projects: ProjectRecord[] = [];
  try {
    if (options.startDaemon !== false) await ensureDaemon(paths);
    const s = await call<DaemonStatus>(paths, "status");
    projects = await call<ProjectRecord[]>(paths, "projects.list");
    add(
      "sqlite",
      "ok",
      `SQLite ${s.store.sqliteVersion}, store schema ${s.store.schemaVersion} (${s.store.journalMode}) at ${s.paths.store}`,
    );
  } catch (err) {
    add(
      "sqlite",
      "fail",
      options.startDaemon === false && err instanceof DaemonNotRunning
        ? "Kiln is not running"
        : `Kiln's daemon and store could not be started: ${(err as Error).message}`,
    );
  }

  for (const p of projects) {
    const remote = await run("git", ["ls-remote", "--exit-code", "origin", "HEAD"], p.clonePath);
    if (remote.code === 0) add(`remote ${p.name}`, "ok", `origin of ${p.name} is reachable`);
    else {
      add(
        `remote ${p.name}`,
        "fail",
        `origin of ${p.name} cannot be reached (${firstLine(remote.stderr) || "no answer"})`,
      );
    }
  }

  const gh = await run("gh", ["--version"]);
  if (gh.ran && gh.code === 0) {
    add("gh", "ok", `${firstLine(gh.stdout)} (pull requests and tickets)`);
  } else add("gh", "warn", "`gh` was not found: Kiln cannot open pull requests or publish tickets");
  const lavish = await run("lavish-axi", ["--version"]);
  if (lavish.ran && lavish.code === 0) add("lavish-axi", "ok", "escalation pages can be opened");
  else {add(
      "lavish-axi",
      "warn",
      "`lavish-axi` was not found: escalations have no page, only `kiln escalations`",
    );}

  try {
    const limits = await loadLimits(paths.config);
    if (limits.budgets.requestUsd === undefined && limits.budgets.dailyUsd === undefined) {
      add("spend limits", "warn", "no spend limits are set; run `kiln setup` to set them");
    } else {
      add(
        "spend limits",
        "ok",
        `per request ${limits.budgets.requestUsd ?? "unlimited"}, per day ${
          limits.budgets.dailyUsd ?? "unlimited"
        } (USD)`,
      );
    }
  } catch (err) {
    add("spend limits", "fail", (err as Error).message);
  }
  return checks;
}

export function describeChecks(checks: Check[]): string {
  const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" };
  const width = Math.max(...checks.map((c) => c.name.length));
  const lines = checks.map((c) => `${mark[c.status]}  ${c.name.padEnd(width)}  ${c.detail}`);
  const failed = checks.filter((c) => c.status === "fail").length;
  lines.push(
    failed
      ? `${failed} check(s) failed: Kiln cannot do its work until they are fixed.`
      : "Kiln is ready.",
  );
  return lines.join("\n");
}
