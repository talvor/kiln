import denoJson from "../deno.json" with { type: "json" };
import { canConnect, closeQuietly, selfCommand } from "./client.ts";
import { run } from "./checks.ts";
import { launch } from "./launcher.ts";
import { createConductor } from "./conductor.ts";
import { isStepWorker, loadConfig } from "./playbooks.ts";
import { createRouter } from "./router.ts";
import { createLogger, type Logger } from "./log.ts";
import { ensureDirs, type KilnPaths } from "./paths.ts";
import { readLines, type Request, type Response, writeJson } from "./protocol.ts";
import {
  infoOf,
  mergeAssignment,
  startAssignment,
  startRequest,
  WorktreeBlocked,
} from "./worktrees.ts";
import { resolve } from "@std/path";
import { type Change, RecheckBlocked, recheckProject, removeClone } from "./manage.ts";
import {
  type MessageKind,
  type NewProject,
  type NewSession,
  openStore,
  type Store,
} from "./store.ts";

/**
 * The sandbox for a launch in a Worktree: writes only to the Worktree, its support directory
 * (temp files and caches) and the Git directory its commits go to.
 */
async function sandboxFor(
  sandbox: Record<string, unknown> | undefined,
  worktree: string,
): Promise<Record<string, unknown> | undefined> {
  if (!sandbox) return sandbox;
  const common = await run(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    worktree,
  );
  const fs = (sandbox.filesystem ?? {}) as { allowWrite?: string[] };
  const extra = [`${worktree}.kiln`, ...(common.code === 0 ? [common.stdout.trim()] : [])];
  return { ...sandbox, filesystem: { ...fs, allowWrite: [...(fs.allowWrite ?? []), ...extra] } };
}

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
    hold: (m) => conductor.holds(m),
    launchLimits: (session) => conductor.launchLimits(session),
    observe: (session, used) => conductor.observe(session, used),
    activity: (session) => conductor.activity(session),
    watched: (session) => conductor.watched(session),
    launch: async (req) => {
      const wt = store.findLiveWorktree(resolve(req.cwd));
      return launch({
        ...req,
        env: wt ? infoOf(wt).env : undefined,
        sandbox: wt ? await sandboxFor(req.sandbox, wt.path) : req.sandbox,
      });
    },
    roleTools: async (name) => (await loadConfig(paths.config)).roles.get(name)?.tools,
    rolePrompt: async (name) => (await loadConfig(paths.config)).roles.get(name)?.prompt,
    selfCommand,
  });
  // The router and the conductor lean on each other; the router only calls back once running.
  const conductor = createConductor({
    store,
    log,
    router,
    loadConfig: () => loadConfig(paths.config),
    worktreesDir: paths.worktrees,
    withProject: withProjectQueue,
  });
  // Delivery passes never overlap: a pass in flight is joined, not repeated. The conductor reacts
  // on its own clock, so a worker that takes long to wake does not hold up the other Assignments,
  // and the limit watch runs apart from both, so a hung worker cannot hide from it.
  let pass: Promise<void> | undefined;
  const deliver = (): Promise<void> => pass ??= router.tick().finally(() => pass = undefined);
  const ticker = setInterval(
    () => {
      deliver().catch((err) => log.error("delivery pass failed", { err }));
      conductor.react().catch((err) => log.error("conductor pass failed", { err }));
    },
    2_000,
  );
  const watcher = setInterval(() => {
    try {
      conductor.watch();
    } catch (err) {
      log.error("limit watch failed", { err });
    }
  }, 500);

  let stopping = false;
  let shutdownTask: Promise<void> | undefined;
  const shutdown = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    log.info("daemon stopping", { reason });
    clearInterval(ticker);
    clearInterval(watcher);
    await pass?.catch(() => {});
    await conductor.idle();
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
    "requests.start": (params) =>
      params.playbook === undefined
        ? withProjectQueue(
          String(params.project),
          () => startRequest(store, store.getProject(String(params.project)), paths.worktrees),
        )
        : conductor.startRequest({
          project: String(params.project),
          playbook: String(params.playbook),
          description: String(params.description),
          trackerItem: typeof params.trackerItem === "string" ? params.trackerItem : null,
        }),
    "requests.status": (params) => requestStatus(store, Number(params.id)),
    "assignments.start": (params) => {
      const request = store.getRequest(Number(params.requestId));
      const project = store.listProjects().find((p) => p.id === request.projectId);
      if (!project) throw new WorktreeBlocked("The request's project has been removed.");
      return withProjectQueue(
        project.name,
        () =>
          startAssignment(store, project, request.id, Number(params.assignmentId), paths.worktrees),
      );
    },
    "assignments.merge": (params) => {
      const assignment = store.getAssignment(Number(params.id));
      const request = store.getRequest(assignment.requestId);
      const project = store.listProjects().find((p) => p.id === request.projectId);
      if (!project) throw new WorktreeBlocked("The request's project has been removed.");
      return withProjectQueue(project.name, () => mergeAssignment(store, project, assignment.id));
    },
    "worktrees.environment": (params) => {
      const wt = store.findLiveWorktree(resolve(String(params.path)));
      return wt ? infoOf(wt).env : {};
    },
    "sessions.open": (params) => router.openSession(params as unknown as NewSession),
    "messages.send": async (params) => {
      const sent = router.send(
        String(params.from),
        String(params.to),
        params.kind as MessageKind,
        params.body,
        params.inReplyTo as number | undefined,
        params.assignmentId as number | undefined,
      );
      await conductor.react();
      return sent;
    },
    "messages.raise": (params) =>
      router.raiseQuestion(
        String(params.from),
        params.question,
        params.context,
        params.assignmentId as number | undefined,
      ),
    "messages.read": (params) => router.readInbox(String(params.address)),
    "router.police": async (params) =>
      await router.policeCall(
        String(params.address),
        String(params.tool),
        (params.input ?? {}) as Record<string, unknown>,
      ),
    "router.stopCheck": (params) =>
      router.checkStop(String(params.address), params.alreadyBlocked === true),
    stop: (_params, ctx) => {
      ctx.afterReply = () => beginShutdown("stop command");
      return { stopping: true, pid: Deno.pid, startedAt };
    },
  };

  store.appendEvent("daemon.started", { pid: Deno.pid, version: VERSION });
  conductor.react().catch((err) => log.error("startup pass failed", { err }));
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

/** A Request with its Steps and their Assignments, as `kiln request status` shows it. */
function requestStatus(store: Store, id: number) {
  const request = store.getRequest(id);
  const project = store.listProjects({ includeRemoved: true }).find((p) =>
    p.id === request.projectId
  );
  const assignments = store.listAssignments(id);
  return {
    id,
    project: project?.name,
    status: request.status,
    playbook: request.playbook,
    description: request.description,
    trackerItem: request.trackerItem,
    branch: request.branch,
    ticketUrl: request.ticketUrl,
    failure: request.failure,
    steps: store.listSteps(id).map((step) => ({
      position: step.position,
      name: step.spec.name,
      department: step.spec.department,
      status: step.status,
      failure: step.failure,
      retries: step.retries,
      assignments: assignments
        .filter((a) => isStepWorker(step, store.getMessage(a.id)?.to))
        .map((a) => ({
          id: a.id,
          worker: store.getMessage(a.id)!.to,
          status: a.status,
          branch: a.branch,
          worktree: a.worktreeId === null ? null : store.getWorktree(a.worktreeId).path,
          merged: a.mergedAt !== null,
          owns: a.owns,
          budget: a.budget,
          turnsUsed: a.turnsUsed,
          spendUsd: a.spendUsd,
          limitReached: a.limitReached,
        })),
    })),
  };
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
