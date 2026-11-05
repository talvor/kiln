import denoJson from "../deno.json" with { type: "json" };
import { canConnect, closeQuietly } from "./client.ts";
import { createLogger, type Logger } from "./log.ts";
import { ensureDirs, type KilnPaths } from "./paths.ts";
import { readLines, type Request, type Response, writeJson } from "./protocol.ts";
import { openStore, type Store } from "./store.ts";

export const VERSION: string = denoJson.version;

export interface DaemonStatus {
  pid: number;
  version: string;
  startedAt: string;
  paths: KilnPaths;
  store: ReturnType<Store["info"]>;
}

/** Run the daemon in this process until it is told to stop. */
export async function runDaemon(paths: KilnPaths): Promise<void> {
  Deno.umask(0o077); // everything the daemon creates is private to the user
  ensureDirs(paths);
  const log = createLogger({ file: paths.log });
  try {
    await serveForever(paths, log);
  } catch (err) {
    log.error(`daemon crashed: ${(err as Error).message}`, { err });
    Deno.exit(1);
  }
}

async function serveForever(paths: KilnPaths, log: Logger): Promise<void> {
  // Claim the socket before touching the store: binding is atomic, so of several daemons
  // started at once exactly one proceeds, and clients queue on the socket while it migrates.
  const listener = await claimSocket(paths.socket, log);
  if (!listener) return;

  let store: Store;
  try {
    store = await openStore({ file: paths.store, backupsDir: paths.backups, log });
  } catch (err) {
    log.error((err as Error).message, { err });
    listener.close();
    removeQuietly(paths.socket);
    Deno.exit(1);
  }

  const startedAt = new Date().toISOString();
  const status = (): DaemonStatus => ({
    pid: Deno.pid,
    version: VERSION,
    startedAt,
    paths,
    store: store.info(),
  });

  let stopping = false;
  const shutdown = (reason: string) => {
    if (stopping) return;
    stopping = true;
    log.info("daemon stopping", { reason });
    try {
      store.appendEvent("daemon.stopped", { reason });
    } catch (err) {
      log.error("could not record stop event", { err });
    }
    // Stop accepting first, and close the store before removing the socket: once the socket
    // is gone, a new daemon may start.
    listener.close();
    store.close();
    removeQuietly(paths.socket);
    log.info("daemon stopped");
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
  // The daemon outlives the terminal that started it: ignore its interrupts and hangups.
  for (const sig of ["SIGINT", "SIGHUP"] as const) Deno.addSignalListener(sig, () => {});

  const handlers: Record<string, Handler> = {
    ping: () => ({ pid: Deno.pid }),
    status,
    backup: async () => ({ path: await store.backup() }),
    stop: (_params, ctx) => {
      ctx.afterReply = () => shutdown("stop command");
      return { stopping: true };
    },
  };

  store.appendEvent("daemon.started", { pid: Deno.pid, version: VERSION });
  log.info("daemon started", { pid: Deno.pid, version: VERSION, socket: paths.socket });

  for await (const conn of listener) serve(conn, handlers, log);
}

interface Context {
  /** Runs once the reply has been written, e.g. to shut down without cutting the reply off. */
  afterReply?: () => void;
}
type Handler = (params: Record<string, unknown>, ctx: Context) => unknown;

async function serve(
  conn: Deno.Conn,
  handlers: Record<string, Handler>,
  log: Logger,
): Promise<void> {
  try {
    for await (const line of readLines(conn)) {
      let req: Request;
      let res: Response;
      try {
        req = JSON.parse(line);
      } catch {
        await writeJson(conn, { id: 0, ok: false, error: "malformed request" });
        continue;
      }
      const handler = handlers[req.method];
      const ctx: Context = {};
      if (!handler) {
        res = { id: req.id, ok: false, error: `unknown method: ${req.method}` };
      } else {
        try {
          log.debug("rpc", { method: req.method, params: req.params });
          res = { id: req.id, ok: true, result: await handler(req.params ?? {}, ctx) };
        } catch (err) {
          log.error("rpc failed", { method: req.method, err });
          res = { id: req.id, ok: false, error: (err as Error).message };
        }
      }
      await writeJson(conn, res);
      ctx.afterReply?.();
    }
  } catch (err) {
    log.warn("connection error", { err });
  } finally {
    closeQuietly(conn);
  }
}

/** Bind the daemon socket; returns undefined if a live daemon already owns it. */
async function claimSocket(path: string, log: Logger): Promise<Deno.Listener | undefined> {
  const listen = () => {
    const listener = Deno.listen({ transport: "unix", path });
    Deno.chmodSync(path, 0o600);
    return listener;
  };
  try {
    return listen();
  } catch (err) {
    // Typically AddrInUse, but the error class varies by platform: decide by probing instead.
    log.info("socket already exists", { path, err });
  }
  if (await canConnect(path)) {
    log.info("daemon already running; exiting");
    return undefined;
  }
  log.info("removing stale socket", { path });
  Deno.removeSync(path);
  return listen();
}

function removeQuietly(path: string): void {
  try {
    Deno.removeSync(path);
  } catch { /* already gone */ }
}
