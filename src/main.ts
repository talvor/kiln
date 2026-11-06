import { call, DaemonNotRunning, ensureDaemon, isRunning, stopDaemon } from "./client.ts";
import { ClaudeNotInstalled, launch } from "./launcher.ts";
import { type DaemonStatus, runDaemon, VERSION } from "./daemon.ts";
import { resolvePaths } from "./paths.ts";

const DAEMON_USAGE = "Usage: kiln daemon start|stop|restart|status [--json]";
const LAUNCH_USAGE = "Usage: kiln launch <prompt> [--cwd <dir>] [--max-budget-usd <n>] [--json]";
const USAGE = `kiln ${VERSION}

Usage:
  ${DAEMON_USAGE.slice("Usage: ".length)}
  kiln backup            Write a safe copy of the store and print its path
  kiln launch <prompt> [--cwd <dir>] [--max-budget-usd <n>] [--json]
                         Run Claude once on a prompt in a directory (default: here)
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
    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }

  async function launchCommand(rest: string[]): Promise<number> {
    const flag = (name: string) => {
      const i = rest.indexOf(name);
      return i >= 0 ? rest.splice(i, 2)[1] : undefined;
    };
    const cwd = flag("--cwd") ?? Deno.cwd();
    const budget = flag("--max-budget-usd");
    const asJson = rest.includes("--json");
    const prompt = rest.filter((a) => a !== "--json").join(" ");
    const maxBudgetUsd = budget === undefined ? undefined : Number(budget);
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

try {
  Deno.exit(await main(Deno.args));
} catch (err) {
  console.error(err instanceof DaemonNotRunning ? err.message : `kiln: ${(err as Error).message}`);
  Deno.exit(1);
}
