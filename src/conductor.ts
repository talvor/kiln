// The coordinator: it plays the overseer for Requests that follow a Playbook. It starts the
// Request's Steps one at a time, hands each to its department's leader as an assignment from the
// overseer, starts a worker's Assignment when the leader delegates, and, once the leader reports
// the step verified, merges the work back, publishes what the step publishes, and moves on.
//
// The conductor holds no state of its own. `react` reads the store and does whatever the
// Messages and records say is due, so it can be run after any change, or again after a crash.
import { join } from "node:path";
import {
  type Budget,
  budgetFor,
  type LimitsConfig,
  overlaps,
  parseOwns,
  projectCap,
  REQUESTABLE,
} from "./limits.ts";
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
  GateKind,
  LimitKind,
  MessageRecord,
  ProjectRecord,
  RequestRecord,
  SessionRecord,
  StepRecord,
  Store,
} from "./store.ts";
import { commentOnPr, openDraftPr, parseTicket, PublishFailed, publishTicket } from "./tracker.ts";
import { verifyWork } from "./verify.ts";
import {
  mergeAssignment,
  MergeConflict,
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
    rejection?: { feedback: string; branch: string | null; heading?: string },
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
        rejection.heading ??
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
        `If what the request asks for is outside the scope of this project, report status ` +
        `out-of-scope with a summary of why: the user decides whether it goes ahead. ` +
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
    const worker = stepWorkerAddress(step.spec, step.id, 0, step.round);
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

  /**
   * Take in the Assignments the leader delegated, as planned with the budget each runs under, and
   * record how the workers' ended. Starting them is `startQueued`'s job.
   */
  async function collect(request: RequestRecord, step: StepRecord): Promise<AssignmentRecord[]> {
    const project = projectOf(request);
    const known = new Set(store.listAssignments(request.id).map((a) => a.id));
    const leader = store.listSessions().find((s) =>
      s.role === "leader" && s.department === step.spec.department
    )!;
    const fresh = store.listMessages({ from: leader.address, kind: "assignment" })
      .filter((m) => m.to === step.worker && !known.has(m.id));
    if (fresh.length) {
      const { limits } = await opts.loadConfig();
      for (const message of fresh) {
        const requested: Partial<Budget> = {};
        for (const [field, key] of Object.entries(REQUESTABLE)) {
          const value = message.body[field];
          if (typeof value === "number") requested[key] = value;
        }
        const { budget, capped } = budgetFor(limits, project.name, requested);
        const owns = parseOwns(message.body.owns);
        store.planAssignment(request.id, message.id, { owns, budget });
        store.appendEvent("assignment.planned", {
          id: message.id,
          step: step.id,
          owns,
          budget,
          cappedByCeiling: capped,
        });
      }
    }
    for (const a of assignmentsOf(request, step).filter((a) => a.status === "active")) {
      const result = store.listMessages({ kind: "result", inReplyTo: a.id })[0];
      if (!result) continue;
      store.setAssignmentState(a.id, result.body.status === "done" ? "done" : "failed");
    }
    return assignmentsOf(request, step);
  }

  /** Why a planned Assignment cannot start yet, or undefined when it can. */
  function blockedBecause(
    limits: LimitsConfig,
    project: ProjectRecord,
    a: AssignmentRecord,
  ): string | undefined {
    if (store.countActiveAssignments() >= limits.global) return "global cap";
    if (store.countActiveAssignments(project.id) >= projectCap(limits, project.name)) {
      return "project cap";
    }
    const ahead = store.listAssignments(a.requestId).find((b) =>
      b.id < a.id && (b.status === "active" || b.status === "planned") &&
      overlaps(a.owns, b.owns)
    );
    return ahead ? `files owned by assignment ${ahead.id}` : undefined;
  }

  /**
   * Start planned Assignments, oldest first, while the caps and file ownership allow. An
   * Assignment that waits for files starts off the work of the overlapping one that finished, so
   * the two do not conflict at merge.
   */
  async function startQueued() {
    const { limits } = await opts.loadConfig();
    for (const request of store.listRequests("active")) {
      if (!request.playbook) continue;
      const step = store.listSteps(request.id).find((s) => s.status === "active");
      if (!step) continue;
      for (const a of assignmentsOf(request, step).filter((a) => a.status === "planned")) {
        let project: ProjectRecord;
        try {
          project = projectOf(request);
        } catch (err) {
          if (err instanceof StepFailed) return failStep(request, step, err);
          throw err;
        }
        const blocked = blockedBecause(limits, project, a);
        if (blocked) continue;
        try {
          const mine = assignmentsOf(request, step);
          const rejected = step.retries || step.sentBack
            ? mine.filter((b) => b.branch && !sameWorker(step, b)).at(-1)?.branch
            : undefined;
          const earlier = mine.filter((b) => b.id < a.id && b.branch);
          const stacked = earlier.filter((b) =>
            b.status === "done" && !b.mergedAt && overlaps(a.owns, b.owns)
          ).at(-1)?.branch;
          const continued = earlier.filter((b) => b.limitReached).at(-1)?.branch;
          const message = store.getMessage(a.id)!;
          const started = await opts.withProject(
            project.name,
            () =>
              startAssignment(
                store,
                project,
                request.id,
                a.id,
                opts.worktreesDir,
                rejected ?? stacked ?? continued ?? undefined,
              ),
          );
          store.setSessionCwd(message.to, started.path);
          store.appendEvent("assignment.started", { id: a.id, step: step.id });
        } catch (err) {
          if (err instanceof WorktreeBlocked) return failStep(request, step, err);
          throw err;
        }
      }
    }
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
    /** Work the user sent back, or a go-ahead: neither counts against the retry limit. */
    user?: { heading: string; branch?: string | null },
  ) {
    store.appendEvent("step.rejected", { request: request.id, step: step.id, feedback });
    if (!user && step.retries >= MAX_RETRIES) {
      store.appendEvent("step.escalated", { request: request.id, step: step.id });
      throw new StepFailed(
        `Verification rejected the ${step.spec.name} step ${step.retries + 1} times, ` +
          `${MAX_RETRIES} of them retries; it goes up to the Overseer. The last rejection:\n${feedback}`,
      );
    }
    if (!user) { for (const a of rejected) store.setAssignmentState(a.id, "failed"); }
    const worker = stepWorkerAddress(
      step.spec,
      step.id,
      step.retries + step.sentBack + 1,
      step.round,
    );
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
      title: `${step.spec.name} (request ${request.id}), ${
        user ? "again" : `retry ${step.retries + 1}`
      }`,
      instructions: describeStep(request, step, steps, worker, {
        feedback,
        branch: user ? user.branch ?? null : rejected.at(-1)?.branch ?? null,
        heading: user?.heading,
      }),
    });
    store.retryStep(step.id, sent.id, worker, !!user);
    store.appendEvent("step.retried", {
      request: request.id,
      step: step.id,
      message: sent.id,
      worker,
    });
  }

  /** The Gate raised for this Step on this report, if any. */
  const gateOf = (step: StepRecord, gate: GateKind) =>
    store.listEscalations().find((e) =>
      e.stepId === step.id && e.gate === gate && e.gateMessageId === step.messageId
    );

  const overseerSeat = () => store.listSessions().find((s) => s.role === "overseer")!;

  /** What the user is asked, and told, when a leader reports a Step it cannot carry on with. */
  const HOLDS = {
    "out-of-scope": {
      summary: (r: RequestRecord) =>
        `Request ${r.id} looks out of scope for this project. Go ahead anyway?`,
      declined: "The user declined to take the request out of scope",
      approved: "The user approved going ahead although the request looked out of scope. " +
        "Carry on with the step.",
      heading:
        "The user has approved this request although you reported it out of scope, so do the step:",
    },
    "blocked-on-user": {
      summary: (r: RequestRecord) =>
        `Request ${r.id} is blocked on you: its ticket is not ready to implement.`,
      declined: "The user declined to unblock the request",
      approved: "The user says the ticket is ready now (they may have updated it). Check it " +
        "again and carry on with the step.",
      heading: "The user has answered your report that the ticket is not ready:",
    },
  } as const;

  /**
   * The leader cannot carry on: the request is outside the Project's scope, or its ticket is not
   * ready. The Overseer brings the user a Gate, and the Step waits for as long as it takes.
   * Approved, the Step goes back to the leader to carry on; rejected, the Step and the Request
   * fail with the user's reason.
   */
  function holdForUser(
    kind: keyof typeof HOLDS,
    request: RequestRecord,
    step: StepRecord,
    report: MessageRecord,
    assignments: AssignmentRecord[],
  ) {
    const hold = HOLDS[kind];
    const gate = gateOf(step, kind);
    if (!gate) {
      const raised = store.addEscalation({
        raisedBy: overseerSeat().address,
        requestId: request.id,
        stepId: step.id,
        gate: kind,
        gateMessageId: step.messageId,
        summary: hold.summary(request),
        detail: `The ${step.spec.department} leader reported, on the ${step.spec.name} step: ` +
          `${report.body.summary}\n\nThe request: ${request.description}`,
      });
      store.appendEvent("gate.raised", {
        request: request.id,
        step: step.id,
        gate: kind,
        escalation: raised.id,
      });
      return false;
    }
    if (gate.status === "open") return false;
    if (gate.status === "rejected") {
      throw new StepFailed(`${hold.declined}: ${gate.reason}`);
    }
    const mine = assignments.filter((a) => sameWorker(step, a) && a.branch);
    reject(request, step, projectOf(request), [], hold.approved, {
      heading: hold.heading,
      branch: mine.at(-1)?.branch,
    });
    return false;
  }

  /**
   * Send the work back to an earlier Step as a new Assignment, for a fresh worker that starts from
   * its branch: QA found problems, or the user did not accept the result. The Steps after it begin
   * again once it is done, so the same pull request is updated and checked afresh.
   */
  function sendBack(
    request: RequestRecord,
    target: StepRecord,
    feedback: string,
    heading: string,
  ) {
    const mine = assignmentsOf(request, target).filter((a) => sameWorker(target, a) && a.branch);
    for (const s of store.listSteps(request.id)) {
      if (s.position > target.position && s.status !== "planned") {
        // What the later Step's workers left unmerged is not carried into its next round.
        for (const a of assignmentsOf(request, s)) {
          if (!a.mergedAt && (a.status === "done" || a.status === "active")) {
            store.setAssignmentState(a.id, "failed");
          }
        }
        store.restartStep(s.id);
      }
    }
    store.setStepState(target.id, "active");
    reject(request, target, projectOf(request), [], feedback, {
      heading,
      branch: mine.at(-1)?.branch,
    });
    store.appendEvent("step.findings_returned", {
      request: request.id,
      step: target.id,
    });
  }

  /** The leader reports findings on the Step: they go back to the Step that must fix them. */
  function returnFindings(request: RequestRecord, step: StepRecord, report: MessageRecord) {
    const target = store.listSteps(request.id).find((s) => s.spec.name === step.spec.findings);
    if (!target) {
      throw new StepFailed(
        `The ${step.spec.department} leader reported findings on the ${step.spec.name} step, ` +
          `which has no step to send them to.`,
      );
    }
    if (step.round >= MAX_RETRIES) {
      store.appendEvent("step.escalated", { request: request.id, step: step.id });
      throw new StepFailed(
        `QA found problems in the ${step.spec.name} step ${step.round + 1} times, ` +
          `${MAX_RETRIES} of them after fixes; it goes up to the Overseer. The last findings:\n` +
          `${report.body.summary}`,
      );
    }
    sendBack(
      request,
      target,
      String(report.body.summary ?? ""),
      `QA (the ${step.spec.name} step) found problems with your work. Fix them on the same ` +
        `branch, so the same pull request is updated. The findings:`,
    );
    return false;
  }

  /** The QA steps' artifacts, as one summary of what checked the work. */
  async function qaSummary(request: RequestRecord): Promise<string> {
    const wt = store.getWorktree(request.worktreeId!);
    const steps = store.listSteps(request.id);
    const parts: string[] = [];
    for (const s of steps.filter((s) => s.spec.findings)) {
      const text = await Deno.readTextFile(join(wt.path, s.spec.artifact)).catch(() => "");
      if (text.trim()) parts.push(`### ${s.spec.name}\n\n${text.trim()}`);
    }
    const rounds = Math.max(0, ...steps.map((s) => s.round));
    const again = rounds
      ? ` after ${rounds} round${rounds === 1 ? "" : "s"} of findings fixed`
      : "";
    return `## QA summary\n\nQA passed${again}.\n\n${parts.join("\n\n")}`.trim();
  }

  /**
   * The Step's work is verified and merged but it holds a Gate: the Overseer brings the user the
   * result to approve, and the Step waits for as long as it takes. Returns whether it passed.
   * A rejection sends the work back with the user's reason.
   */
  async function passGate(
    request: RequestRecord,
    step: StepRecord,
    assignments: AssignmentRecord[],
  ) {
    if (!step.spec.gate) return true;
    const gate = gateOf(step, step.spec.gate);
    if (!gate) {
      let summary: string;
      let detail: string;
      if (step.spec.gate === "qa-passed") {
        summary =
          `Request ${request.id} passed QA: pull request ${request.prUrl} is ready for you.`;
        detail = `${request.description}\n\nPull request: ${request.prUrl}\n\n${await qaSummary(
          request,
        )}`;
      } else {
        const wt = store.getWorktree(request.worktreeId!);
        const files = [...new Set(store.listSteps(request.id).map((s) => s.spec.artifact))];
        const parts: string[] = [];
        for (const file of files) {
          const text = await Deno.readTextFile(join(wt.path, file)).catch(() => "");
          if (text.trim()) parts.push(`## ${file}\n\n${text.trim()}`);
        }
        summary = `Approve the spec for request ${request.id}?`;
        detail = `${request.description}\n\n${parts.join("\n\n")}`;
      }
      const raised = store.addEscalation({
        raisedBy: overseerSeat().address,
        requestId: request.id,
        stepId: step.id,
        gate: step.spec.gate,
        gateMessageId: step.messageId,
        summary,
        detail,
      });
      store.appendEvent("gate.raised", {
        request: request.id,
        step: step.id,
        gate: step.spec.gate,
        escalation: raised.id,
      });
      return false;
    }
    if (gate.status === "open") return false;
    if (gate.status === "approved") return true;
    if (step.spec.gate === "qa-passed") {
      const target = store.listSteps(request.id).find((s) => s.spec.name === step.spec.findings);
      if (!target) throw new StepFailed(`The user rejected the result: ${gate.reason}`);
      sendBack(
        request,
        target,
        gate.reason ?? "",
        "The user rejected the pull request although it passed QA. Fix what they ask for on the " +
          "same branch, so the same pull request is updated. Their reason:",
      );
      return false;
    }
    const mine = assignments.filter((a) => sameWorker(step, a) && a.branch);
    reject(
      request,
      step,
      projectOf(request),
      [],
      gate.reason ?? "",
      {
        heading:
          "The user rejected the spec you delivered, and nothing is final until they approve it. " +
          "Their reason:",
        branch: mine.at(-1)?.branch,
      },
    );
    return false;
  }

  /** The leader says the step is verified: merge the work back, publish, and finish the step. */
  async function close(request: RequestRecord, step: StepRecord, assignments: AssignmentRecord[]) {
    const report = store.listMessages({ kind: "result", inReplyTo: step.messageId! })[0];
    if (!report) return false;
    store.markRead([report.id]);
    if (report.body.status === "out-of-scope") {
      return holdForUser("out-of-scope", request, step, report, assignments);
    }
    if (report.body.status === "unready") {
      return holdForUser("blocked-on-user", request, step, report, assignments);
    }
    if (report.body.status === "findings" && step.spec.findings) {
      return returnFindings(request, step, report);
    }
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
        if (err instanceof MergeConflict) {
          // The work conflicts with what is already on the request branch: it becomes a new
          // Assignment, for a fresh worker that starts from the conflicting work.
          store.appendEvent("assignment.conflicted", {
            id: a.id,
            request: request.id,
            step: step.id,
          });
          reject(
            request,
            step,
            project,
            [a],
            `${err.message}\nMerge ${request.branch} into your branch, resolve the conflicts so ` +
              `both sides' intent survives, and commit.`,
          );
          return false;
        }
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
    if (step.spec.publish === "draft-pr" && !request.prUrl) {
      const requestWt = store.getWorktree(request.worktreeId!);
      const text = await Deno.readTextFile(join(requestWt.path, step.spec.artifact)).catch(() =>
        ""
      );
      if (!text.trim()) {
        throw new StepFailed(
          `Verification failed: ${step.spec.artifact} is not on the request branch.`,
        );
      }
      const pr = parseTicket(text);
      if (request.trackerItem) {
        pr.body = `${pr.body}\n\nCloses ${request.trackerItem}`.trim();
      }
      try {
        const url = await openDraftPr(project.clonePath, {
          head: request.branch!,
          base: project.defaultBranch,
          ...pr,
        });
        store.setPrUrl(request.id, url);
        store.appendEvent("pr.opened", { request: request.id, url });
      } catch (err) {
        if (err instanceof PublishFailed) throw new StepFailed(err.message);
        throw err;
      }
    }
    if (
      step.spec.publish === "qa-summary" && (!step.spec.gate || !gateOf(step, step.spec.gate))
    ) {
      if (!request.prUrl) {
        throw new StepFailed("QA passed, but Kiln has no pull request to report it on.");
      }
      try {
        await commentOnPr(project.clonePath, request.prUrl, await qaSummary(request));
        store.appendEvent("pr.commented", { request: request.id, url: request.prUrl });
      } catch (err) {
        if (err instanceof PublishFailed) throw new StepFailed(err.message);
        throw err;
      }
    }
    if (!(await passGate(request, step, assignments))) return false;
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
        failStep(request, step, err);
      }
      return;
    }
  }

  function failStep(request: RequestRecord, step: StepRecord, err: Error) {
    store.setStepState(step.id, "failed", err.message);
    store.setRequestState(request.id, "failed", err.message);
    store.appendEvent("step.failed", { request: request.id, step: step.id, why: err.message });
    log.warn("step failed", { request: request.id, step: step.id, why: err.message });
  }

  const activeOf = (address: string) =>
    store.listActiveAssignments().filter((a) => store.getMessage(a.id)?.to === address);

  /** What Kiln tells the leader when a worker hit a limit. */
  function limitSummary(a: AssignmentRecord, kind: LimitKind): string {
    const b = a.budget!;
    const spent = `$${a.spendUsd.toFixed(2)}`;
    const reason = {
      turns: `its turn limit (${a.turnsUsed} of ${b.turns} turns)`,
      spend: `its spend limit (${spent} of $${b.spendUsd})`,
      time: `its time limit (${b.seconds} seconds of wall-clock time)`,
      inactivity: `${b.idleSeconds} seconds without a sign of life`,
    }[kind];
    return `Limit reached: Kiln stopped this assignment's worker at ${reason}. Whatever the ` +
      `worker committed is on branch ${a.branch}; uncommitted work is not carried over. ` +
      `Your options: (1) continue: send the worker a new assignment, which starts from that ` +
      `branch, and add maxTurns, maxSpendUsd or maxSeconds to it to allow more (Kiln caps them ` +
      `at the Project's ceiling); (2) split: send smaller assignments, each with the paths it ` +
      `owns in "owns"; (3) give up: send your result for the step to the overseer with status ` +
      `failed.`;
  }

  /** The Assignment ran into a limit: stop its worker and report the failure to its leader. */
  function reachLimit(a: AssignmentRecord, kind: LimitKind) {
    const message = store.getMessage(a.id)!;
    // A worker that already reported is done, whatever the clock says.
    if (!router.failAssignment(a.id, limitSummary(a, kind))) return;
    store.markLimitReached(a.id, kind);
    router.abort(message.to);
    store.appendEvent("assignment.limit_reached", { id: a.id, limit: kind });
    log.warn("assignment reached a limit", { assignment: a.id, limit: kind });
  }

  /** Which limit, if any, the Assignment has run into. */
  function limitOf(a: AssignmentRecord): LimitKind | undefined {
    const b = a.budget;
    if (!b || !a.startedAt) return;
    const now = Date.now();
    if (a.turnsUsed >= b.turns) return "turns";
    if (a.spendUsd >= b.spendUsd - 1e-9) return "spend";
    if (now - Date.parse(a.startedAt) >= b.seconds * 1000) return "time";
    if (now - Date.parse(a.activityAt ?? a.startedAt) >= b.idleSeconds * 1000) return "inactivity";
  }

  /** Stop the workers of Assignments over a limit. Runs on a clock, apart from `react`. */
  function watch() {
    for (const a of store.listActiveAssignments()) {
      const kind = limitOf(a);
      if (kind) reachLimit(a, kind);
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
      try {
        await startQueued();
      } catch (err) {
        log.error("could not start queued assignments", { err });
      }
    });
    queue = pass.catch(() => {});
    return pass;
  }

  return {
    react,
    watch,
    /** Whether an Assignment is still queued, so its worker is not to be woken. */
    holds: (m: MessageRecord): boolean => {
      if (m.kind !== "assignment") return false;
      try {
        return store.getAssignment(m.id).status === "planned";
      } catch {
        return store.listRequests("active").some((r) =>
          store.listSteps(r.id).some((s) => s.status === "active" && s.worker === m.to)
        );
      }
    },
    /** The turns and spend a launch for the worker may still use; none for other agents. */
    launchLimits: (session: SessionRecord) => {
      const active = session.role === "worker" ? activeOf(session.address) : [];
      if (!active.length) return undefined;
      return {
        maxTurns: Math.max(1, Math.min(...active.map((a) => a.budget!.turns - a.turnsUsed))),
        maxBudgetUsd: Math.max(
          0.01,
          Math.min(...active.map((a) => a.budget!.spendUsd - a.spendUsd)),
        ),
      };
    },
    /** A worker's launch ended: charge it to the Assignments the worker has. */
    observe: (session: SessionRecord, used: { turns: number; costUsd: number }) => {
      const active = session.role === "worker" && (used.turns || used.costUsd)
        ? activeOf(session.address)
        : []; // a launch that did not run is no sign of life
      active.forEach((a, i) =>
        store.addUsage(a.id, {
          turns: Math.floor(used.turns / active.length) + (i ? 0 : used.turns % active.length),
          spendUsd: used.costUsd / active.length,
        })
      );
      watch();
    },
    /** A worker's launch shows a sign of life. */
    activity: (session: SessionRecord) => {
      if (session.role === "worker") {
        for (const a of activeOf(session.address)) store.touchAssignment(a.id);
      }
    },
    /** Whether the limit watch, not a fixed timeout, bounds the worker's launches. */
    watched: (session: SessionRecord) =>
      session.role === "worker" && activeOf(session.address).length > 0,
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
