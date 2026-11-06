// The coordinator: it plays the overseer for Requests that follow a Playbook. It starts the
// Request's Steps one at a time, hands each to its department's leader as an assignment from the
// overseer, starts a worker's Assignment when the leader delegates, and, once the leader reports
// the step verified, merges the work back, publishes what the step publishes, and moves on.
//
// The conductor holds no state of its own. `react` reads the store and does whatever the
// Messages and records say is due, so it can be run after any change, or again after a crash.
import { join } from "node:path";
import type { Logger } from "./log.ts";
import {
  type Config,
  ConfigError,
  isStepWorker,
  leaderRoleOf,
  overseerRole,
  type PlaybookConfig,
  stepWorkerAddress,
} from "./playbooks.ts";
import type { Router } from "./router.ts";
import type {
  AssignmentRecord,
  ProjectRecord,
  RequestRecord,
  SessionRecord,
  StepRecord,
  Store,
} from "./store.ts";
import { parseTicket, publishTicket } from "./tracker.ts";
import { verifyWork } from "./verify.ts";
import {
  mergeAssignment,
  startAssignment,
  type StartedRequest,
  startRequest,
  WorktreeBlocked,
} from "./worktrees.ts";

/** The Request cannot be started; the message says why. */
export class RequestRefused extends Error {}

export interface ConductorOptions {
  store: Store;
  log: Logger;
  router: Router;
  loadConfig: () => Promise<Config>;
  worktreesDir: string;
  /** Run Git work on a Project one piece at a time. */
  withProject: <T>(name: string, work: () => Promise<T>) => Promise<T>;
}

export interface StartPlaybookRequest {
  project: string;
  playbook: string;
  description: string;
  trackerItem: string | null;
}

/** How many times a rejected Step goes back to its leader before it goes up to the Overseer. */
export const MAX_RETRIES = 2;

/** Why a Step cannot go on: it, and the Request, fail with this. */
class StepFailed extends Error {}

export function createConductor(opts: ConductorOptions) {
  const { store, log, router } = opts;

  const projectOf = (request: RequestRecord): ProjectRecord => {
    const project = store.listProjects().find((p) => p.id === request.projectId);
    if (!project) throw new StepFailed("The request's project has been removed.");
    return project;
  };

  /** The Assignments the leader gave this Step's worker. */
  const assignmentsOf = (request: RequestRecord, step: StepRecord): AssignmentRecord[] =>
    store.listAssignments(request.id).filter((a) => isStepWorker(step, store.getMessage(a.id)?.to));

  /** The session at the seat, opened if nobody sits there yet. */
  const seat = (
    find: (s: SessionRecord) => boolean,
    open: { address: string; role: SessionRecord["role"]; department: string | null },
    roleName: string,
    cwd: string,
  ): SessionRecord =>
    store.listSessions().find(find) ??
      router.openSession({ ...open, cwd, roleName });

  function describeStep(
    request: RequestRecord,
    step: StepRecord,
    steps: StepRecord[],
    worker: string,
    rejection?: { feedback: string; branch: string | null },
  ) {
    const { spec } = step;
    const lines = [
      `Request ${request.id}, playbook "${request.playbook}", step ${step.position} of ${steps.length}: ${spec.name}.`,
      "",
      spec.instructions,
      "",
      `The request: ${request.description}`,
    ];
    if (request.trackerItem) lines.push(`Tracker item: ${request.trackerItem}`);
    if (rejection) {
      lines.push(
        "",
        `Retry ${step.retries + 1} of ${MAX_RETRIES}: the earlier work was rejected when Kiln ` +
          `verified it, and nothing from it was merged. The rejection feedback:`,
        "",
        rejection.feedback,
      );
    }
    lines.push(
      "",
      `Delegate this to ${rejection ? "a fresh worker" : "your worker"} "${worker}" ` +
        `(the ${spec.worker} role): send it an assignment with your instructions` +
        (rejection
          ? ", including the rejection feedback above. Its worktree starts from the rejected " +
            `work${rejection.branch ? ` on branch ${rejection.branch}` : ""}, so it fixes that ` +
            "work rather than starting over. "
          : ". ") +
        `It works on its own branch and must commit ${spec.artifact}.`,
      `When it reports done, verify ${spec.artifact} against what this step asks. Then send ` +
        `your result to the overseer with status done, or failed if the step cannot be done. ` +
        `Reply to this message: inReplyTo is its id.`,
    );
    return lines.join("\n");
  }

  async function activate(request: RequestRecord, step: StepRecord, steps: StepRecord[]) {
    const config = await opts.loadConfig();
    const project = projectOf(request);
    const overseerName = overseerRole(config).name;
    const leaderName = leaderRoleOf(config, step.spec.department).name;
    const overseer = seat(
      (s) => s.role === "overseer",
      {
        address: "overseer",
        role: "overseer",
        department: null,
      },
      overseerName,
      project.clonePath,
    );
    const leader = seat(
      (s) => s.role === "leader" && s.department === step.spec.department,
      { address: leaderName, role: "leader", department: step.spec.department },
      leaderName,
      project.clonePath,
    );
    const worker = stepWorkerAddress(step.spec, step.id);
    seat(
      (s) => s.address === worker,
      {
        address: worker,
        role: "worker",
        department: step.spec.department,
      },
      step.spec.worker,
      project.clonePath,
    );
    const sent = router.send(overseer.address, leader.address, "assignment", {
      title: `${step.spec.name} (request ${request.id})`,
      instructions: describeStep(request, step, steps, worker),
    });
    store.beginStep(step.id, sent.id, worker);
    store.appendEvent("step.started", { request: request.id, step: step.id, message: sent.id });
  }

  /** Start the Assignments the leader delegated, and record how the workers' ended. */
  async function collect(request: RequestRecord, step: StepRecord): Promise<AssignmentRecord[]> {
    const project = projectOf(request);
    const known = new Set(store.listAssignments(request.id).map((a) => a.id));
    // A retry's worker starts from the branch of the work that was rejected.
    const rejected = step.retries
      ? assignmentsOf(request, step).filter((a) => a.branch && !sameWorker(step, a)).at(-1)
        ?.branch
      : undefined;
    const leader = store.listSessions().find((s) =>
      s.role === "leader" && s.department === step.spec.department
    )!;
    for (
      const message of store.listMessages({ from: leader.address, kind: "assignment" })
        .filter((m) => m.to === step.worker && !known.has(m.id))
    ) {
      try {
        const started = await opts.withProject(
          project.name,
          () =>
            startAssignment(
              store,
              project,
              request.id,
              message.id,
              opts.worktreesDir,
              rejected ?? undefined,
            ),
        );
        store.setSessionCwd(step.worker!, started.path);
        store.appendEvent("assignment.started", { id: message.id, step: step.id });
      } catch (err) {
        if (err instanceof WorktreeBlocked) throw new StepFailed(err.message);
        throw err;
      }
    }
    const mine = assignmentsOf(request, step);
    for (const a of mine.filter((a) => a.status === "active")) {
      const result = store.listMessages({ kind: "result", inReplyTo: a.id })[0];
      if (!result) continue;
      store.setAssignmentState(a.id, result.body.status === "done" ? "done" : "failed");
    }
    return assignmentsOf(request, step);
  }

  const sameWorker = (step: StepRecord, a: AssignmentRecord) =>
    store.getMessage(a.id)?.to === step.worker;

  /**
   * Verification rejected the work. Within the retry limit the Step goes back to its leader as a
   * new assignment from the overseer, carrying the feedback, for a fresh worker that starts from
   * the rejected branch; past it, the Step fails and the rejection goes up to the Overseer.
   */
  function reject(
    request: RequestRecord,
    step: StepRecord,
    project: ProjectRecord,
    rejected: AssignmentRecord[],
    feedback: string,
  ) {
    store.appendEvent("step.rejected", { request: request.id, step: step.id, feedback });
    if (step.retries >= MAX_RETRIES) {
      store.appendEvent("step.escalated", { request: request.id, step: step.id });
      throw new StepFailed(
        `Verification rejected the ${step.spec.name} step ${step.retries + 1} times, ` +
          `${MAX_RETRIES} of them retries; it goes up to the Overseer. The last rejection:\n${feedback}`,
      );
    }
    for (const a of rejected) store.setAssignmentState(a.id, "failed");
    const worker = stepWorkerAddress(step.spec, step.id, step.retries + 1);
    seat(
      (s) => s.address === worker,
      {
        address: worker,
        role: "worker",
        department: step.spec.department,
      },
      step.spec.worker,
      project.clonePath,
    );
    const overseer = store.listSessions().find((s) => s.role === "overseer")!;
    const leader = store.listSessions().find((s) =>
      s.role === "leader" && s.department === step.spec.department
    )!;
    const steps = store.listSteps(request.id);
    const sent = router.send(overseer.address, leader.address, "assignment", {
      title: `${step.spec.name} (request ${request.id}), retry ${step.retries + 1}`,
      instructions: describeStep(request, step, steps, worker, {
        feedback,
        branch: rejected.at(-1)?.branch ?? null,
      }),
    });
    store.retryStep(step.id, sent.id, worker);
    store.appendEvent("step.retried", {
      request: request.id,
      step: step.id,
      message: sent.id,
      worker,
    });
  }

  /** The leader says the step is verified: merge the work back, publish, and finish the step. */
  async function close(request: RequestRecord, step: StepRecord, assignments: AssignmentRecord[]) {
    const report = store.listMessages({ kind: "result", inReplyTo: step.messageId! })[0];
    if (!report) return false;
    store.markRead([report.id]);
    if (report.body.status !== "done") {
      throw new StepFailed(
        `The ${step.spec.department} leader reported the step failed: ${report.body.summary}`,
      );
    }
    const project = projectOf(request);
    const done = assignments.filter((a) => a.status === "done" && sameWorker(step, a));
    if (!done.length) {
      throw new StepFailed("The leader reported the step done, but no worker reported done.");
    }
    // Verify before anything is merged: the checks and the acceptance criteria, on the work as
    // the worker left it. A rejected Step goes back for a fresh worker, or up to the Overseer.
    const problems: string[] = [];
    for (const a of done.filter((a) => !a.mergedAt)) {
      const wt = store.getWorktree(a.worktreeId!);
      for (const problem of await verifyWork(project, step.spec, wt.path)) {
        problems.push(`Assignment ${a.id}: ${problem}`);
      }
    }
    if (problems.length) {
      await reject(request, step, project, done, problems.join("\n\n"));
      return false;
    }
    for (const a of done) {
      const wt = store.getWorktree(a.worktreeId!);
      if (a.mergedAt && a.pushed && wt.releasedAt) continue;
      try {
        await opts.withProject(project.name, () => mergeAssignment(store, project, a.id));
      } catch (err) {
        if (err instanceof WorktreeBlocked) throw new StepFailed(err.message);
        throw err;
      }
    }
    if (step.spec.publish === "ticket" && !request.ticketUrl) {
      const requestWt = store.getWorktree(request.worktreeId!);
      const text = await Deno.readTextFile(join(requestWt.path, step.spec.artifact)).catch(() =>
        ""
      );
      if (!text.trim()) {
        throw new StepFailed(
          `Verification failed: ${step.spec.artifact} is not on the request branch.`,
        );
      }
      const ticket = parseTicket(text);
      if (request.trackerItem) {
        ticket.body = `${ticket.body}\n\nTracker item: ${request.trackerItem}`.trim();
      }
      try {
        const url = await publishTicket(project.clonePath, ticket);
        store.setTicketUrl(request.id, url);
        store.appendEvent("ticket.published", { request: request.id, url });
      } catch (err) {
        throw new StepFailed((err as Error).message);
      }
    }
    store.setStepState(step.id, "done");
    store.appendEvent("step.done", { request: request.id, step: step.id });
    return true;
  }

  async function advance(request: RequestRecord) {
    for (let guard = 0; guard < 100; guard++) {
      const steps = store.listSteps(request.id);
      const step = steps.find((s) => s.status === "planned" || s.status === "active");
      if (!step) {
        store.setRequestState(request.id, "done");
        store.appendEvent("request.done", { id: request.id });
        return;
      }
      try {
        if (step.status === "planned") {
          await activate(request, step, steps);
          continue;
        }
        const assignments = await collect(request, step);
        if (await close(request, step, assignments)) {
          request = store.getRequest(request.id);
          continue;
        }
      } catch (err) {
        if (!(err instanceof StepFailed)) throw err;
        store.setStepState(step.id, "failed", err.message);
        store.setRequestState(request.id, "failed", err.message);
        store.appendEvent("step.failed", { request: request.id, step: step.id, why: err.message });
        log.warn("step failed", { request: request.id, step: step.id, why: err.message });
      }
      return;
    }
  }

  let queue: Promise<void> = Promise.resolve();
  /** Do whatever is due for active Requests that follow a Playbook. Passes never overlap. */
  function react(): Promise<void> {
    const pass = queue.then(async () => {
      for (const request of store.listRequests("active")) {
        if (!request.playbook) continue;
        try {
          await advance(request);
        } catch (err) {
          log.error("could not advance request", { request: request.id, err });
        }
      }
    });
    queue = pass.catch(() => {});
    return pass;
  }

  return {
    react,
    /** Resolves once the pass in flight, if any, has finished. */
    idle: () => queue,

    /** Start a Request on a Project that follows a Playbook. */
    async startRequest(req: StartPlaybookRequest): Promise<StartedRequest> {
      if (!req.description.trim()) throw new RequestRefused("A request needs a description.");
      let playbook: PlaybookConfig | undefined;
      try {
        const config = await opts.loadConfig();
        const broken = config.broken.get(req.playbook);
        if (broken) throw broken;
        playbook = config.playbooks.get(req.playbook);
        if (!playbook) {
          const names = [...config.playbooks.keys()].join(", ");
          throw new RequestRefused(`No playbook named "${req.playbook}". Available: ${names}.`);
        }
      } catch (err) {
        if (err instanceof ConfigError) throw new RequestRefused(err.message);
        throw err;
      }
      const project = store.getProject(req.project);
      const started = await opts.withProject(
        project.name,
        () => startRequest(store, project, opts.worktreesDir),
      );
      store.setPlaybook(started.requestId, {
        playbook: playbook.name,
        description: req.description,
        trackerItem: req.trackerItem,
        steps: playbook.steps,
      });
      store.appendEvent("request.started", { id: started.requestId, playbook: playbook.name });
      await react();
      return started;
    },
  };
}
