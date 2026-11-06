import { call, DaemonNotRunning, ensureDaemon, isRunning, stopDaemon } from "./client.ts";
import { ClaudeNotInstalled, launch } from "./launcher.ts";
import { type DaemonStatus, runDaemon, VERSION } from "./daemon.ts";
import { resolvePaths } from "./paths.ts";
import {
  type Commands,
  registerProject,
  RegistrationBlocked,
  RegistrationDeclined,
} from "./register.ts";
import type { Change } from "./manage.ts";
import type { ProjectRecord } from "./store.ts";

const DAEMON_USAGE = "Usage: kiln daemon start|stop|restart|status [--json]";
const LAUNCH_USAGE = "Usage: kiln launch <prompt> [--cwd <dir>] [--max-budget-usd <n>] [--json]";
const REGISTER_USAGE = "Usage: kiln project register <path-or-url>";
const PROJECT_USAGE = `Usage:
  kiln project register <path-or-url>
  kiln project list [--all]
  kiln project pause <name>
  kiln project resume <name>
  kiln project edit <name> [--setup <cmd>] [--test <cmd>] [--lint <cmd>] [--build <cmd>]
  kiln project baseline <name>
  kiln project default-branch <name> <branch>
  kiln project remove <name> [--force]`;
const USAGE = `kiln ${VERSION}

Usage:
  ${DAEMON_USAGE.slice("Usage: ".length)}
  kiln backup            Write a safe copy of the store and print its path
  kiln launch <prompt> [--cwd <dir>] [--max-budget-usd <n>] [--json]
                         Run Claude once on a prompt in a directory (default: here)
  kiln project register <path-or-url>
                         Register a project: Kiln clones it, checks it, and records its commands
  kiln project list|pause|resume|edit|baseline|default-branch|remove ...
                         Manage registered projects (see \`kiln project\`)
  kiln --version

Any command that needs the daemon starts it if it is not running.`;

async function main(args: string[]): Promise<number> {
  const [cmd, sub] = args;
  const json = args.includes("--json");

  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return 0;
  }
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }

  const paths = resolvePaths();

  switch (cmd) {
    case "daemon":
      return await daemonCommand(sub, json);
    case "backup": {
      await ensureDaemon(paths);
      const { path } = await call<{ path: string }>(paths, "backup");
      console.log(path);
      return 0;
    }
    case "launch":
      return await launchCommand(args.slice(1));
    case "project":
      return await projectCommand(sub, args.slice(2));
    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }

  async function projectCommand(sub: string | undefined, rest: string[]): Promise<number> {
    const usage = () => {
      console.error(PROJECT_USAGE);
      return 2;
    };
    const flagsOnly = (allowed: string[]) => rest.slice(1).every((a) => allowed.includes(a));
    switch (sub) {
      case "register":
        return await registerCommand(rest);
      case "list": {
        if (rest.length > 1 || (rest[0] && rest[0] !== "--all")) return usage();
        await ensureDaemon(paths);
        const projects = await call<ProjectRecord[]>(paths, "projects.list", {
          includeRemoved: rest[0] === "--all",
        });
        if (!projects.length) console.log("No projects registered.");
        for (const p of projects) console.log(describeProject(p));
        return 0;
      }
      case "pause":
      case "resume": {
        if (rest.length !== 1 || rest[0].startsWith("-")) return usage();
        const paused = sub === "pause";
        const name = rest[0];
        await ensureDaemon(paths);
        try {
          const { changed } = await call<{ changed: boolean }>(paths, "projects.pause", {
            name,
            paused,
          });
          console.log(
            changed
              ? paused
                ? `Paused ${name}: it takes no new requests until you resume it.`
                : `Resumed ${name}.`
              : `${name} is already ${paused ? "paused" : "active"}.`,
          );
          return 0;
        } catch (err) {
          console.error((err as Error).message);
          return 1;
        }
      }
      case "edit": {
        const change: Change = {};
        const fields: Record<string, keyof Change> = {
          "--setup": "setupCommand",
          "--test": "testCommand",
          "--lint": "lintCommand",
          "--build": "buildCommand",
        };
        const [name, ...flags] = rest;
        if (!name || name.startsWith("-") || !flags.length) return usage();
        for (let i = 0; i < flags.length; i += 2) {
          const field = fields[flags[i]];
          const value = flags[i + 1];
          if (!field || value === undefined) return usage();
          // An empty command clears it.
          (change as Record<string, string | null>)[field] = value.trim() || null;
        }
        return await recheckAndRecord(name, change, "Edited");
      }
      case "baseline": {
        if (rest.length !== 1 || rest[0].startsWith("-")) return usage();
        return await recheckAndRecord(rest[0], {}, "Re-ran the baseline of", true);
      }
      case "default-branch": {
        if (rest.length !== 2 || rest.some((a) => a.startsWith("-"))) return usage();
        return await recheckAndRecord(
          rest[0],
          { defaultBranch: rest[1] },
          "Changed the default branch of",
        );
      }
      case "remove": {
        if (!rest.length || rest[0].startsWith("-") || !flagsOnly(["--force"])) return usage();
        const force = rest.includes("--force");
        await ensureDaemon(paths);
        try {
          await call(paths, "projects.remove", { name: rest[0], force });
        } catch (err) {
          console.error(`Cannot remove: ${(err as Error).message}`);
          return 1;
        }
        console.log(
          `Removed ${rest[0]}. Its clone is deleted; its history is kept.`,
        );
        return 0;
      }
      default:
        return usage();
    }
  }

  async function recheckAndRecord(
    name: string,
    change: Change,
    done: string,
    baselineOnly = false,
  ): Promise<number> {
    try {
      await ensureDaemon(paths);
      const result = await call<{
        project?: ProjectRecord;
        progress: string[];
        blocked?: string;
      }>(paths, "projects.recheck", { name, change, baselineOnly });
      for (const message of result.progress) console.log(message);
      if (result.blocked) {
        console.error(
          `Re-check blocked: ${result.blocked}\nThe project record was not changed. Setup may have left files in Kiln's clone.`,
        );
        return 1;
      }
      const updated = result.project!;
      for (const w of updated.warnings) console.log(`warning: ${w}`);
      console.log(describeBaseline(updated));
      console.log(`${done} ${name}.`);
      return 0;
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
  }

  async function registerCommand(rest: string[]): Promise<number> {
    if (rest.length !== 1 || rest[0].startsWith("-")) {
      console.error(REGISTER_USAGE);
      return 2;
    }
    await ensureDaemon(paths);
    const existing = await call<ProjectRecord[]>(paths, "projects.list");
    try {
      const project = await registerProject(rest[0], {
        projectsDir: paths.projects,
        existingNames: existing.map((p) => p.name),
        launch,
        progress: console.log,
        confirm: async (commands) => {
          console.log(describeCommands(commands));
          Deno.stdout.writeSync(new TextEncoder().encode("Use these commands? [y/N] "));
          return /^y(es)?$/i.test((await readLine())?.trim() ?? "");
        },
        record: async (p) => {
          await call(paths, "projects.add", { ...p });
        },
      });
      for (const w of project.warnings) console.log(`warning: ${w}`);
      console.log(describeBaseline(project, true));
      console.log(`Registered ${project.name} (clone: ${project.clonePath})`);
      return 0;
    } catch (err) {
      if (err instanceof RegistrationBlocked) {
        console.error(`Registration blocked: ${err.message}`);
        return 1;
      }
      if (err instanceof RegistrationDeclined) {
        console.error(`Registration cancelled: ${err.message}`);
        return 1;
      }
      if (err instanceof ClaudeNotInstalled) {
        console.error(`Registration blocked: ${err.message}`);
        return 1;
      }
      throw err;
    }
  }

  async function launchCommand(rest: string[]): Promise<number> {
    let cwd = Deno.cwd();
    let maxBudgetUsd: number | undefined;
    let asJson = false;
    const promptParts: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--json") {
        asJson = true;
      } else if (arg === "--cwd" || arg === "--max-budget-usd") {
        const value = rest[++i];
        if (!value || value.startsWith("--")) {
          console.error(LAUNCH_USAGE);
          return 2;
        }
        if (arg === "--cwd") cwd = value;
        else maxBudgetUsd = Number(value);
      } else {
        promptParts.push(arg);
      }
    }
    const prompt = promptParts.join(" ");
    if (!prompt || (maxBudgetUsd !== undefined && !(maxBudgetUsd > 0))) {
      console.error(LAUNCH_USAGE);
      return 2;
    }
    try {
      const result = await launch({ prompt, cwd, maxBudgetUsd });
      if (asJson) console.log(JSON.stringify(result));
      else if (result.ok) console.log(result.text);
      else console.error(`claude stopped: ${result.outcome}: ${result.text}`);
      return result.ok ? 0 : 1;
    } catch (err) {
      if (err instanceof ClaudeNotInstalled) {
        console.error(err.message);
        return 1;
      }
      throw err;
    }
  }

  async function daemonCommand(
    sub: string | undefined,
    json: boolean,
  ): Promise<number> {
    switch (sub) {
      case "run": // internal: the process the CLI spawns
        await runDaemon(paths);
        return 0;
      case "start": {
        const started = await ensureDaemon(paths);
        const { pid } = await call<{ pid: number }>(paths, "ping");
        console.log(
          started ? `kiln daemon started (pid ${pid})` : `kiln daemon already running (pid ${pid})`,
        );
        return 0;
      }
      case "stop":
        console.log(
          (await stopDaemon(paths)) ? "kiln daemon stopped" : "kiln daemon is not running",
        );
        return 0;
      case "restart": {
        await stopDaemon(paths);
        await ensureDaemon(paths);
        const { pid } = await call<{ pid: number }>(paths, "ping");
        console.log(`kiln daemon restarted (pid ${pid})`);
        return 0;
      }
      case "status": {
        if (!(await isRunning(paths))) {
          console.log(json ? JSON.stringify({ running: false }) : "kiln daemon is not running");
          return 3;
        }
        const s = await call<DaemonStatus>(paths, "status");
        if (json) console.log(JSON.stringify(s, null, 2));
        else {
          console.log(
            `kiln daemon running (pid ${s.pid}, version ${s.version}, since ${s.startedAt})`,
          );
          console.log(
            `  store   ${s.paths.store} (schema ${s.store.schemaVersion}, ${s.store.journalMode})`,
          );
          console.log(`  socket  ${s.paths.socket}`);
          console.log(`  log     ${s.paths.log}`);
        }
        return 0;
      }
      default:
        console.error(DAEMON_USAGE);
        return 2;
    }
  }
}

function describeBaseline(p: { baseline: ProjectRecord["baseline"] }, registering = false): string {
  const b = p.baseline;
  if (!b) return "Test baseline: not recorded (no test command).";
  if (b.passed) return "Test baseline: passing.";
  return `Test baseline: FAILING (exit ${b.exitCode}); ${
    registering ? "the project is registered with" : "the project has"
  } its tests already red.`;
}

function describeProject(p: ProjectRecord): string {
  const state = p.removedAt ? "removed" : p.paused ? "paused" : "active";
  const b = p.baseline
    ? (p.baseline.passed ? "baseline passing" : "baseline FAILING")
    : "no baseline";
  return `${p.name}  ${state}  ${p.defaultBranch}@${p.headCommit.slice(0, 7)}  ${b}`;
}

function describeCommands(c: Commands): string {
  const row = (label: string, cmd: string | null) => `  ${label.padEnd(6)} ${cmd ?? "(none)"}`;
  return [
    "The onboarding agent proposes these commands:",
    row("setup", c.setup),
    row("test", c.test),
    row("lint", c.lint),
    row("build", c.build),
  ].join("\n");
}

/** Read one line from stdin; null at end of input. */
async function readLine(): Promise<string | null> {
  const dec = new TextDecoder();
  const buf = new Uint8Array(1024);
  let text = "";
  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) return text || null;
    text += dec.decode(buf.subarray(0, n), { stream: true });
    const i = text.indexOf("\n");
    if (i >= 0) return text.slice(0, i);
  }
}

try {
  Deno.exit(await main(Deno.args));
} catch (err) {
  console.error(err instanceof DaemonNotRunning ? err.message : `kiln: ${(err as Error).message}`);
  Deno.exit(1);
}
