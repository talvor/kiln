import {
  healthReport,
  listRequests,
  requestEvents,
  requestIdOfEvent,
  requestReport,
  requestTranscript,
} from "./observe.ts";
import denoJson from "../deno.json" with { type: "json" };
import { canConnect, closeQuietly, selfCommand } from "./client.ts";
import { run } from "./checks.ts";
import { launch } from "./launcher.ts";
import { createConductor } from "./conductor.ts";
import { isStepWorker, loadConfig } from "./playbooks.ts";
import { createEscalations } from "./escalations.ts";
import { createFaults } from "./faults.ts";
import { createPages } from "./pages.ts";
import { createRouter } from "./router.ts";
import { createChat } from "./chat.ts";
import { createBudgets } from "./budgets.ts";
import { createLogger, type Logger } from "./log.ts";
import { ensureDirs, type KilnPaths } from "./paths.ts";
import {
  errorCodeOf,
  readLines,
  type Request,
  type Response,
  sourceOf,
  writeJson,
} from "./protocol.ts";
import {
  infoOf,
  makeTmpdir,
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
  type RequestRecord,
  type Store,
  type WorktreeRecord,
} from "./store.ts";

/**
 * The sandbox for a launch in a Worktree: writes only to the Worktree, its support directory
 * (caches), its own temp directory and the Git directory its commits go to.
 */
export async function sandboxFor(
  sandbox: Record<string, unknown> | undefined,
  wt: WorktreeRecord,
): Promise<Record<string, unknown> | undefined> {
  if (!sandbox) return sandbox;
  const common = await run(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    wt.path,
  );
  const fs = (sandbox.filesystem ?? {}) as { allowWrite?: string[] };
  const extra = [
    `${wt.path}.kiln`,
    infoOf(wt).env.TMPDIR,
    ...(common.code === 0 ? [common.stdout.trim()] : []),
  ];
  return { ...sandbox, filesystem: { ...fs, allowWrite: [...(fs.allowWrite ?? []), ...extra] } };
}

export const VERSION: string = denoJson.version;

export interface DaemonStatus {
  pid: number;
  version: string;
  startedAt: string;
  paths: KilnPaths;
  store: ReturnType<Store["info"]>;
  /** The startup steps that have run, in order. */
  startup: string[];
  /** When Kiln was halted, if it is. */
  haltedSince: string | null;
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
  const started: string[] = ["store"]; // opened and migrated above, before anything else
  const status = (): DaemonStatus => ({
    pid: Deno.pid,
    version: VERSION,
    startedAt,
    paths,
    store: store.info(),
    startup: [...started],
    haltedSince: store.haltedSince(),
  });
  const halted = () => store.haltedSince() !== null;
  /** Nobody is woken while Kiln is halted, or while the day's spend has used up the daily cap. */
  const holding = () => halted() || budgets.capped();

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
    hold: (m) => conductor.holds(m) || chat.holds(m),
    readRoots: (session) =>
      session.role === "overseer"
        ? [paths.chat, ...store.listProjects().map((p) => p.clonePath)]
        : undefined,
    halted: holding,
    infrastructure: async () => (await loadConfig(paths.config)).limits.infrastructure,
    launchLimits: (session) => conductor.launchLimits(session),
    observe: (session, used) => {
      conductor.observe(session, used);
      // What it cost may take the day over the cap: look at once, not on the next tick.
      if (used.costUsd > 0) {
        budgets.check().catch((err) => log.error("budget check failed", { err }));
      }
    },
    activity: (session) => conductor.activity(session),
    watched: (session) => conductor.watched(session),
    launch: async (req) => {
      const wt = store.findLiveWorktree(resolve(req.cwd));
      // The runtime directory is cleared on logout and reboot; make the temp directory again.
      if (wt) await makeTmpdir(wt);
      return launch({
        ...req,
        env: { ...(wt ? infoOf(wt).env : {}), ...req.env },
        sandbox: wt ? await sandboxFor(req.sandbox, wt) : req.sandbox,
      });
    },
    roleTools: async (name) => (await loadConfig(paths.config)).roles.get(name)?.tools,
    rolePrompt: async (name) => (await loadConfig(paths.config)).roles.get(name)?.prompt,
    selfCommand,
  });
  const budgets = createBudgets({
    store,
    log,
    loadLimits: async () => (await loadConfig(paths.config)).limits,
    stopAll: () => router.abortAll("halt"),
    resumed: () => {
      deliver().catch((err) => log.error("delivery pass failed", { err }));
      conductor.react().catch((err) => log.error("conductor pass failed", { err }));
    },
  });
  const escalations = createEscalations(store);
  /** Record a decision, from a command or from a page, and let whatever waits on it carry on. */
  const decideEscalation = (params: Parameters<typeof escalations.decide>[0]) => {
    const decided = escalations.decide(params);
    if (store.getEscalationPage(decided.id)) store.spendEscalationPage(decided.id);
    try {
      pages.refresh(decided.id);
    } catch (err) {
      log.error("page rewrite failed", { err });
    }
    // A question that went all the way to the user is answered by their decision.
    try {
      router.answerFromDecision(decided);
    } catch (err) {
      log.error("could not answer the question behind an escalation", { err });
    }
    // A Gate waits on this decision: let the conductor carry on at once.
    if (decided.gate) {
      conductor.react().catch((err) => log.error("conductor pass failed", { err }));
    }
    return decided;
  };
  const faults = createFaults({
    store,
    log,
    failAssignment: (id, why) => void router.failAssignment(id, why),
    reportStuck: (address, why) => router.reportStuck(store.getSession(address), why),
    withProject: withProjectQueue,
    close: (id, reason) => {
      try {
        decideEscalation({ id, approved: true, reason });
      } catch (err) {
        log.error("could not close a fault's escalation", { err });
      }
    },
  });
  const pages = createPages({
    store,
    log,
    dir: paths.pages,
    decide: (p) => decideEscalation(p),
  });
  const pageServer = pages.start();
  const chat = createChat({
    store,
    router,
    escalations,
    loadConfig: () => loadConfig(paths.config),
    chatDir: paths.chat,
    decide: (params) => decideEscalation(params),
    spendLine: () => budgets.spendLine(),
    told: () => budgets.told(),
    control: {
      halt: () =>
        (handlers["kiln.halt"]({}, {}) as { changed: boolean }).changed
          ? "Kiln is halted: running agents were stopped and nobody will be woken. " +
            "Type `kiln resume` to carry on."
          : "Kiln is already halted.",
      resume: () => {
        const r = handlers["kiln.resume"]({}, {}) as { wasHalted: boolean; stuck: number };
        return r.wasHalted || r.stuck ? "Kiln is resumed." : "Kiln is not halted.";
      },
    },
  });
  /** The Overseer's own tools: the caller must be the overseer. */
  const asOverseer = (params: Record<string, unknown>): void => {
    if (store.getSession(String(params.from)).role !== "overseer") {
      throw new Error("Only the overseer may use this tool.");
    }
  };
  // The router and the conductor lean on each other; the router only calls back once running.
  const conductor = createConductor({
    store,
    log,
    router,
    loadConfig: () => loadConfig(paths.config),
    worktreesDir: paths.worktrees,
    withProject: withProjectQueue,
    halted: holding,
    notify: (n) => budgets.notify(n),
  });
  // Delivery passes never overlap: a pass in flight is joined, not repeated. The conductor reacts
  // on its own clock, so a worker that takes long to wake does not hold up the other Assignments,
  // and the limit watch runs apart from both, so a hung worker cannot hide from it. The clocks are
  // the last thing to start (see the startup steps below).
  let pass: Promise<void> | undefined;
  const deliver = (): Promise<void> => pass ??= router.tick().finally(() => pass = undefined);
  const clocks: ReturnType<typeof setInterval>[] = [];
  // Pull requests waiting to be merged are looked at on their own, slower clock: one `gh pr view`
  // each, no model involved. A look that is still running is not started again.
  const prSeconds = Number(Deno.env.get("KILN_PR_POLL_SECONDS"));
  const faultSeconds = Number(Deno.env.get("KILN_FAULT_CHECK_SECONDS"));
  const digestSeconds = Number(Deno.env.get("KILN_DIGEST_CHECK_SECONDS"));
  let polling: Promise<void> | undefined;
  const startClocks = () => {
    clocks.push(
      setInterval(
        () => {
          deliver().catch((err) => log.error("delivery pass failed", { err }));
          conductor.react().catch((err) => log.error("conductor pass failed", { err }));
          try {
            pages.sync();
          } catch (err) {
            log.error("page pass failed", { err });
          }
        },
        2_000,
      ),
      setInterval(
        () => faults.check().catch((err) => log.error("fault check failed", { err })),
        (faultSeconds > 0 ? faultSeconds : 30) * 1000,
      ),
      setInterval(
        () => budgets.check().catch((err) => log.error("budget check failed", { err })),
        1_000,
      ),
      setInterval(
        () => budgets.digestCheck().catch((err) => log.error("digest check failed", { err })),
        (digestSeconds > 0 ? digestSeconds : 30) * 1000,
      ),
      setInterval(() => {
        try {
          conductor.watch();
        } catch (err) {
          log.error("limit watch failed", { err });
        }
      }, 500),
      setInterval(
        () => {
          polling ??= conductor.pollPrs()
            .catch((err) => log.error("pull request poll failed", { err }))
            .finally(() => polling = undefined);
        },
        (prSeconds > 0 ? prSeconds : 60) * 1000,
      ),
    );
  };

  let stopping = false;
  let shutdownTask: Promise<void> | undefined;
  const shutdown = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    log.info("daemon stopping", { reason });
    for (const clock of clocks) clearInterval(clock);
    await polling;
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
    await pageServer.shutdown().catch(() => {});
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
    "events.since": async (params) => {
      const { after, kinds, waitMs } = eventsSinceParams(params);
      const read = () =>
        store.listEvents(after, kinds).map((e) => ({
          ...e,
          requestId: requestIdOfEvent(store, e),
        }));
      let events = read();
      if (!events.length && waitMs > 0) {
        let wake: () => void = () => {};
        const woken = new Promise<void>((resolve) => wake = resolve);
        const stop = store.onEvent(() => {
          if (store.listEvents(after, kinds).length) wake();
        });
        const timer = setTimeout(wake, waitMs);
        try {
          await woken;
        } finally {
          clearTimeout(timer);
          stop();
        }
        events = read();
      }
      return { events, last: events.at(-1)?.id ?? after };
    },
    "kiln.halt": (params) => {
      const via = sourceOf(params.via);
      if (halted()) return { changed: false, since: store.haltedSince() };
      store.setHalted(true);
      store.appendEvent("kiln.halted", via ? { via } : {});
      log.warn("Kiln halted");
      router.abortAll("halt");
      return { changed: true, since: store.haltedSince() };
    },
    "kiln.resume": (params) => {
      const via = sourceOf(params.via);
      const since = store.haltedSince();
      if (since) {
        store.delayActiveAssignments(Date.now() - Date.parse(since));
        store.setHalted(false);
      }
      const stuck = router.clearStuck();
      if (since || stuck) {
        store.appendEvent("kiln.resumed", { wasHalted: !!since, stuck, ...(via ? { via } : {}) });
        log.info("Kiln resumed", { wasHalted: !!since, stuck });
        deliver().catch((err) => log.error("delivery pass failed", { err }));
        conductor.react().catch((err) => log.error("conductor pass failed", { err }));
      }
      return { wasHalted: !!since, stuck };
    },
    "requests.cancel": (params) => conductor.cancel(Number(params.id), sourceOf(params.via)),
    "requests.start": (params) =>
      halted()
        ? Promise.reject(
          Object.assign(
            new Error("Kiln is halted: it takes no new requests until `kiln resume`."),
            { code: "halted" as const },
          ),
        )
        : params.playbook === undefined
        ? withProjectQueue(
          String(params.project),
          () => startRequest(store, store.getProject(String(params.project)), paths.worktrees),
        )
        : conductor.startRequest({
          project: String(params.project),
          playbook: String(params.playbook),
          description: String(params.description),
          trackerItem: typeof params.trackerItem === "string" ? params.trackerItem : null,
          andFix: params.andFix === true,
        }),
    "requests.status": async (params) => {
      await budgets.refresh();
      return requestStatus(store, Number(params.id), budgets.requestBudget);
    },
    "requests.list": async (params) => {
      await budgets.refresh();
      return listRequests(store, params.all === true, budgets.requestBudget);
    },
    "requests.events": (params) =>
      requestEvents(store, Number(params.id), Number(params.after ?? 0)),
    "requests.transcript": (params) => requestTranscript(store, Number(params.id)),
    "requests.report": async (params) => {
      await budgets.refresh();
      return requestReport(
        store,
        requestStatus(store, Number(params.id), budgets.requestBudget),
      );
    },
    "cost.report": () => budgets.cost(),
    "health.report": async () => healthReport(store, await budgets.cost()),
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
        params.relaysQuestion as number | undefined,
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
        params.relaysQuestion as number | undefined,
      ),
    "escalations.raise": (params) => {
      const raised = escalations.raise(String(params.from), params);
      pages.sync();
      return raised;
    },
    "escalations.raised": (params) => escalations.raisedBy(String(params.from)),
    "escalations.list": (params) =>
      escalations.list(params.all !== true).map((e) => ({
        ...e,
        page: pages.pathOf(e.id) ?? null,
      })),
    "escalations.decide": (params) =>
      decideEscalation({
        id: params.id,
        approved: params.approved === true,
        reason: params.reason,
        agent: params.agent,
        confirm: params.confirm,
        via: sourceOf(params.via),
      }),
    "overseer.projects": (params) => {
      asOverseer(params);
      return store.listProjects().map((p) => ({
        name: p.name,
        paused: p.paused,
        defaultBranch: p.defaultBranch,
        baseline: p.baseline ? (p.baseline.passed ? "passing" : "failing") : "none",
      }));
    },
    "overseer.playbooks": async (params) => {
      asOverseer(params);
      const config = await loadConfig(paths.config);
      return [...config.playbooks.values()].map((p) => ({
        name: p.name,
        description: p.description,
        steps: p.steps.map((s) => s.name),
      }));
    },
    "overseer.startRequest": (params) => {
      asOverseer(params);
      const project = store.getProject(String(params.project));
      if (project.paused) {
        throw new Error(`"${project.name}" is paused: it takes no new requests until resumed.`);
      }
      return handlers["requests.start"]({
        project: params.project,
        playbook: params.playbook,
        description: params.description,
        trackerItem: params.trackerItem,
      }, {});
    },
    "overseer.requestStatus": async (params) => {
      asOverseer(params);
      await budgets.refresh();
      return requestStatus(store, Number(params.id), budgets.requestBudget);
    },
    "chat.begin": () => chat.begin(),
    "chat.heartbeat": (params) => chat.heartbeat(Number(params.id)),
    "chat.end": (params) =>
      chat.end(Number(params.id), params.reason === "rollover" ? "rollover" : "exit"),
    "chat.prompt": (params) => chat.prompt(Number(params.id), String(params.prompt ?? "")),
    "chat.stop": (params) =>
      chat.stop(Number(params.id), {
        text: typeof params.text === "string" ? params.text : undefined,
        tokens: typeof params.tokens === "number" ? params.tokens : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
        alreadyBlocked: params.alreadyBlocked === true,
      }),
    "chat.statusLine": () => ({ text: chat.statusLine() }),
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
  await runStartup(
    [
      // Whether Kiln was halted comes first: while it is, nothing below wakes anyone.
      ["halt", () => {
        const since = store.haltedSince();
        if (since) log.warn("Kiln is halted; run `kiln resume` to carry on", { since });
      }],
      // The daily cap, read from the limits and the day's spend, holds from the first moment.
      ["budgets", () => budgets.check()],
      // Launches the crash cut short: resume their work once, or fail it the second time.
      ["interrupted-launches", () => {
        const recovered = router.recoverInterrupted();
        if (recovered.resumed || recovered.failed) {
          store.appendEvent("startup.recovered", recovered);
          log.warn("recovered launches a crash interrupted", recovered);
        }
      }],
      // The clones and checkouts work stands on must be whole: put right what is not.
      ["worktrees", () => faults.check()],
      // What is due, now that the store is true to what is running.
      ["conductor", () => {
        conductor.react().catch((err) => log.error("startup pass failed", { err }));
      }],
      ["pages", () => pages.sync({ rewrite: true })],
      ["clocks", startClocks],
    ],
    started,
    log,
  );
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

/** Run the startup steps in order. One that fails is logged, and the daemon starts regardless. */
async function runStartup(
  steps: [string, () => unknown][],
  done: string[],
  log: Logger,
): Promise<void> {
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      log.error(`startup step "${name}" failed`, { err });
    }
    done.push(name);
  }
}

/** A Request with its Steps and their Assignments, as `kiln request status` shows it. */
function requestStatus(
  store: Store,
  id: number,
  budgetOf: (request: RequestRecord) => number | null,
) {
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
    ticketUrls: request.ticketUrls,
    andFix: request.andFix,
    fixRequestId: request.fixRequestId,
    prUrl: request.prUrl,
    failure: request.failure,
    costUsd: store.requestSpend(id),
    budgetUsd: budgetOf(request),
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

/** The longest `events.since` holds a call open. */
const MAX_EVENTS_WAIT_MS = 25_000;

function eventsSinceParams(params: Record<string, unknown>) {
  const invalid = (why: string) => Object.assign(new Error(why), { code: "invalid" as const });
  const { after, kinds, waitMs } = params;
  if (typeof after !== "number" || !Number.isInteger(after) || after < 0) {
    throw invalid('"after" must be a whole number, 0 or more: the id of the last event seen.');
  }
  if (kinds !== undefined && (!Array.isArray(kinds) || kinds.some((k) => typeof k !== "string"))) {
    throw invalid('"kinds" must be a list of event kinds.');
  }
  if (waitMs !== undefined && (typeof waitMs !== "number" || !(waitMs >= 0))) {
    throw invalid('"waitMs" must be a number of milliseconds, 0 or more.');
  }
  return {
    after,
    kinds: kinds as string[] | undefined,
    waitMs: Math.min(waitMs ?? 0, MAX_EVENTS_WAIT_MS),
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
          const code = errorCodeOf(err);
          res = { id: req.id, ok: false, error: (err as Error).message, ...(code ? { code } : {}) };
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
