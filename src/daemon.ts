import denoJson from "../deno.json" with { type: "json" };
import { canConnect, closeQuietly, selfCommand } from "./client.ts";
import { launch } from "./launcher.ts";
import { createRouter, type TickResult } from "./router.ts";
import { createLogger, type Logger } from "./log.ts";
import { ensureDirs, type KilnPaths } from "./paths.ts";
import { readLines, type Request, type Response, writeJson } from "./protocol.ts";
import { type Change, RecheckBlocked, recheckProject, removeClone } from "./manage.ts";
import {
  type MessageKind,
  type NewProject,
  type NewSession,
  openStore,
  type Store,
} from "./store.ts";

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

  const projectQueues = new Map<string, Promise<void>>();
  const projectReplies = new Set<Promise<void>>();
  const withProjectQueue = async <T>(name: string, work: () => Promise<T> | T): Promise<T> => {
    const previous = projectQueues.get(name);
    let release!: () => void;
    const current = new Promise<void>((resolve) => release = resolve);
    projectQueues.set(name, current);
    if (previous) await previous;
    try {
      return await work();
    } finally {
      release();
      if (projectQueues.get(name) === current) projectQueues.delete(name);
    }
  };

  const router = createRouter({
    store,
    log,
    launch,
    selfCommand,
    renudgeAfterMs: envMs("KILN_RENUDGE_AFTER_MS", 60_000),
  });
  // Delivery passes never overlap: a pass in flight is joined, not repeated.
  let pass: Promise<TickResult> | undefined;
  const deliver = (): Promise<TickResult> => pass ??= router.tick().finally(() => pass = undefined);
  const tickMs = envMs("KILN_ROUTER_TICK_MS", 2_000);
  const ticker = tickMs > 0
    ? setInterval(
      () => deliver().catch((err) => log.error("delivery pass failed", { err })),
      tickMs,
    )
    : undefined;

  let stopping = false;
  let shutdownTask: Promise<void> | undefined;
  const shutdown = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    log.info("daemon stopping", { reason });
    clearInterval(ticker);
    await pass?.catch(() => {});
    while (projectQueues.size || projectReplies.size) {
      await Promise.all([...projectQueues.values(), ...projectReplies]);
    }
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
  const beginShutdown = (reason: string) => {
    shutdownTask ??= shutdown(reason);
  };
  Deno.addSignalListener("SIGTERM", () => beginShutdown("SIGTERM"));
  // The daemon outlives the terminal that started it: ignore its interrupts and hangups.
  for (const sig of ["SIGINT", "SIGHUP"] as const) Deno.addSignalListener(sig, () => {});

  const handlers: Record<string, Handler> = {
    ping: () => ({ pid: Deno.pid, startedAt }),
    status,
    backup: async () => ({ path: await store.backup() }),
    "projects.list": (params) =>
      store.listProjects({ includeRemoved: params.includeRemoved === true }),
    "projects.pause": (params) =>
      withProjectQueue(String(params.name), () => {
        const name = String(params.name);
        const project = store.getProject(name);
        const paused = params.paused === true;
        if (project.paused === paused) return { changed: false };
        store.updateProject(name, { paused });
        store.appendEvent("project.updated", { id: project.id, name, fields: ["paused"] });
        return { changed: true };
      }),
    "projects.recheck": (params) =>
      withProjectQueue(String(params.name), async () => {
        const name = String(params.name);
        const progress: string[] = [];
        try {
          const patch = await recheckProject(
            store.getProject(name),
            params.change as Change,
            (message) => progress.push(message),
            params.baselineOnly === true,
          );
          const project = store.updateProject(name, patch);
          store.appendEvent("project.updated", {
            id: project.id,
            name,
            fields: Object.keys(patch),
          });
          return { project, progress };
        } catch (err) {
          if (err instanceof RecheckBlocked) return { blocked: err.message, progress };
          throw err;
        }
      }),
    "projects.remove": (params) =>
      withProjectQueue(String(params.name), async () => {
        const project = store.removeProject(String(params.name), { force: params.force === true });
        await removeClone(project.clonePath, paths.projects);
        return project;
      }),
    "projects.add": (params) =>
      withProjectQueue(String(params.name), () => {
        const project = store.addProject(params as unknown as NewProject);
        store.appendEvent("project.registered", { id: project.id, name: project.name });
        return project;
      }),
    "sessions.open": (params) => router.openSession(params as unknown as NewSession),
    "sessions.list": () => store.listSessions(),
    "messages.send": (params) =>
      router.send(
        String(params.from),
        String(params.to),
        params.kind as MessageKind,
        params.body,
        params.inReplyTo === undefined || params.inReplyTo === null
          ? undefined
          : Number(params.inReplyTo),
      ),
    "messages.raise": (params) =>
      router.raiseQuestion(String(params.from), params.question, params.context ?? undefined),
    "messages.read": (params) => router.readInbox(String(params.address)),
    "messages.list": (params) =>
      store.listMessages({
        to: params.to === undefined ? undefined : String(params.to),
        from: params.from === undefined ? undefined : String(params.from),
      }),
    "router.stopCheck": (params) =>
      router.checkStop(String(params.address), params.alreadyBlocked === true),
    "router.tick": () => deliver(),
    stop: (_params, ctx) => {
      ctx.afterReply = () => beginShutdown("stop command");
      return { stopping: true, pid: Deno.pid, startedAt };
    },
  };

  store.appendEvent("daemon.started", { pid: Deno.pid, version: VERSION });
  log.info("daemon started", { pid: Deno.pid, version: VERSION, socket: paths.socket });

  while (!stopping) {
    let conn: Deno.Conn;
    try {
      conn = await listener.accept();
    } catch (err) {
      if (stopping || err instanceof Deno.errors.BadResource) break;
      // macOS reports EINVAL when a client (e.g. a liveness probe) hangs up before we accept it.
      log.debug("accept failed; continuing", { err });
      await sleep(10);
      continue;
    }
    serve(conn, handlers, log, projectReplies);
  }
  if (shutdownTask) await shutdownTask;
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
  projectReplies: Set<Promise<void>>,
): Promise<void> {
  const pendingProjectReplies: Array<{ reply: Promise<void>; release: () => void }> = [];
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
      let replyWritten: (() => void) | undefined;
      let reply: Promise<void> | undefined;
      if (req.method.startsWith("projects.")) {
        reply = new Promise<void>((resolve) => replyWritten = resolve);
        projectReplies.add(reply);
        pendingProjectReplies.push({ reply, release: replyWritten! });
      }
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
    for (const pending of pendingProjectReplies) {
      pending.release();
      projectReplies.delete(pending.reply);
    }
  }
}

/** A socket file younger than this may belong to a daemon that has bound but not yet listened. */
const FRESH_SOCKET_MS = 2000;

/** A duration in milliseconds from the environment; falls back when unset or malformed. */
function envMs(name: string, fallback: number): number {
  const n = Number(Deno.env.get(name));
  return Deno.env.get(name) !== undefined && Number.isFinite(n) && n >= 0 ? n : fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  // Another daemon may be between bind and listen. Give a fresh socket a moment to come alive.
  const deadline = Date.now() + FRESH_SOCKET_MS;
  while (true) {
    if (await canConnect(path)) {
      log.info("daemon already running; exiting");
      return undefined;
    }
    let ageMs = Infinity;
    try {
      ageMs = Date.now() - (Deno.statSync(path).mtime?.getTime() ?? 0);
    } catch { /* socket vanished: nothing to wait for */ }
    if (ageMs > FRESH_SOCKET_MS || Date.now() > deadline) break;
    await sleep(50);
  }
  log.info("removing stale socket", { path });
  removeQuietly(path);
  return listen();
}

function removeQuietly(path: string): void {
  try {
    Deno.removeSync(path);
  } catch { /* already gone */ }
}
