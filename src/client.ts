import { fromFileUrl } from "@std/path";
import { lastError } from "./log.ts";
import type { KilnPaths } from "./paths.ts";
import { readLines, type Response, writeJson } from "./protocol.ts";

export function closeQuietly(conn: Deno.Conn): void {
  try {
    conn.close();
  } catch { /* already closed */ }
}

export class DaemonNotRunning extends Error {
  constructor() {
    super("The Kiln daemon is not running. Start it with `kiln daemon start`.");
  }
}

/** Call a daemon method. Throws DaemonNotRunning if nothing is listening. */
export async function call<T = unknown>(
  paths: KilnPaths,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<T> {
  let conn: Deno.Conn;
  try {
    conn = await Deno.connect({ transport: "unix", path: paths.socket });
  } catch {
    throw new DaemonNotRunning();
  }
  const timer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => closeQuietly(conn), timeoutMs);
  try {
    await writeJson(conn, { id: 1, method, params });
    for await (const line of readLines(conn)) {
      const res: Response = JSON.parse(line);
      if (!res.ok) throw new Error(res.error);
      return res.result as T;
    }
    throw new Error(
      timeoutMs === undefined
        ? "The daemon closed the connection without answering."
        : "The daemon did not answer in time.",
    );
  } finally {
    clearTimeout(timer);
    closeQuietly(conn);
  }
}

/** True while something accepts connections on the socket (even one that is shutting down). */
export async function canConnect(socket: string): Promise<boolean> {
  try {
    (await Deno.connect({ transport: "unix", path: socket })).close();
    return true;
  } catch {
    return false;
  }
}

export async function isRunning(paths: KilnPaths): Promise<boolean> {
  try {
    await call(paths, "ping", {}, 3000);
    return true;
  } catch (err) {
    if (err instanceof DaemonNotRunning) return false;
    // Something is listening but not answering (starting up, migrating, or shutting down).
    return false;
  }
}

/** How to run `kiln <args>` again as a separate process: works from source and when compiled. */
export function selfCommand(args: string[]): { cmd: string; args: string[] } {
  const exe = Deno.execPath();
  const isDeno = /(^|[\\/])deno(\.exe)?$/.test(exe);
  return isDeno
    ? { cmd: exe, args: ["run", "-A", fromFileUrl(Deno.mainModule), ...args] }
    : { cmd: exe, args };
}
const daemonCommand = () => selfCommand(["daemon", "run"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STOP_TIMEOUT_MS = 60_000;

/** Make sure a daemon is running, starting one if needed. Returns whether it was started now. */
export async function ensureDaemon(paths: KilnPaths, timeoutMs = 15_000): Promise<boolean> {
  if (await isRunning(paths)) return false;

  const { cmd, args } = daemonCommand();
  const child = new Deno.Command(cmd, { args, stdin: "null", stdout: "null", stderr: "null" })
    .spawn();
  let exited = false;
  child.status.then(() => (exited = true));
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isRunning(paths)) return true;
    if (exited) {
      // It may have lost a race to another starter that is now up.
      await sleep(100);
      if (await isRunning(paths)) return true;
      const why = lastError(paths.log) ?? "it exited immediately";
      throw new Error(`The daemon failed to start: ${why}\nSee the log: ${paths.log}`);
    }
    await sleep(50);
  }
  throw new Error(
    `The daemon did not become ready within ${timeoutMs / 1000}s. See the log: ${paths.log}`,
  );
}

/** Ask the daemon to stop and wait until it has gone. Returns false if it was not running. */
export async function stopDaemon(paths: KilnPaths): Promise<boolean> {
  let stopped: { pid: number; startedAt: string };
  try {
    stopped = await call(paths, "stop");
  } catch (err) {
    if (err instanceof DaemonNotRunning) return false;
    throw err;
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const running = await call<{ pid: number; startedAt: string }>(
        paths,
        "ping",
        {},
        Math.min(3000, deadline - Date.now()),
      );
      if (running.pid !== stopped.pid || running.startedAt !== stopped.startedAt) return true;
    } catch (err) {
      if (err instanceof DaemonNotRunning) return true;
    }
    await sleep(50);
  }
  throw new Error("The daemon did not stop within 60 seconds; it may still be finishing work.");
}
