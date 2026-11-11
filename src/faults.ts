// Environment faults: the things Kiln stands on going wrong underneath it, with no model involved.
// A damaged clone is cloned again from the remote; a deleted Worktree is made again on its branch.
// While one is put right the Project is paused and the user is told once, with one Escalation,
// which Kiln closes itself when the environment is whole again. A fault that cannot be put right
// leaves the Project paused and the Escalation open, and is tried again on the next look.
import { dirname } from "@std/path";
import { firstLine, REMOTE_TIMEOUT_MS, run } from "./checks.ts";
import type { Logger } from "./log.ts";
import type { FaultRecord, ProjectRecord, Store, WorktreeRecord } from "./store.ts";
import { makeSupport } from "./worktrees.ts";

export interface FaultDeps {
  store: Store;
  log: Logger;
  /** Close an Escalation with Kiln's own word that the fault is gone. */
  close(escalationId: number, reason: string): void;
  /** Fail an open Assignment on behalf of its worker, with Kiln's own word why. */
  failAssignment(assignmentId: number, why: string): void;
  /** Tell the Overseer the worker of an Assignment is stuck. */
  reportStuck(workerAddress: string, why: string): void;
  /** Run work on a Project alone, so a look never interleaves with a merge or a clean-up. */
  withProject<T>(name: string, work: () => Promise<T>): Promise<T>;
}

const exists = (path: string) => Deno.stat(path).then(() => true, () => false);
const git = (cwd: string, ...args: string[]) => run("git", args, cwd, REMOTE_TIMEOUT_MS);

export function createFaults(deps: FaultDeps) {
  const { store, log } = deps;
  let looking: Promise<void> | undefined;

  /** What is wrong with the Project's clone, if anything. */
  async function cloneProblem(project: ProjectRecord): Promise<string | undefined> {
    if (!await exists(project.clonePath)) return `its clone ${project.clonePath} is gone`;
    const inside = await git(project.clonePath, "rev-parse", "--git-dir");
    if (inside.code !== 0) return `its clone ${project.clonePath} is no longer a git repository`;
    // A clone whose objects are damaged cannot resolve its own HEAD. Ask twice, so a lock held by
    // a git command that is running right now is not taken for damage.
    for (let attempt = 0; attempt < 2; attempt++) {
      const head = await git(
        project.clonePath,
        "rev-parse",
        "--verify",
        "--quiet",
        "HEAD^{commit}",
      );
      if (head.code === 0) return undefined;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return `its clone ${project.clonePath} is damaged: its history cannot be read`;
  }

  /** The Worktrees active Requests stand on, with what each should be on. */
  function liveWorktrees(project: ProjectRecord) {
    const live: { wt: WorktreeRecord; base: string[] }[] = [];
    for (const request of store.listRequests("active")) {
      if (request.projectId !== project.id) continue;
      const fallback = `origin/${project.defaultBranch}`;
      if (request.worktreeId !== null) {
        const wt = store.getWorktree(request.worktreeId);
        if (!wt.releasedAt) live.push({ wt, base: [`origin/${wt.branch}`, fallback] });
      }
      for (const a of store.listAssignments(request.id)) {
        if (a.worktreeId === null) continue;
        const wt = store.getWorktree(a.worktreeId);
        if (wt.releasedAt) continue;
        live.push({
          wt,
          base: [`origin/${wt.branch}`, request.branch ?? fallback, fallback],
        });
      }
    }
    return live;
  }

  async function worktreeProblems(project: ProjectRecord) {
    const listed = await git(project.clonePath, "worktree", "list", "--porcelain", "-z");
    // If git cannot say which Worktrees it knows, only what is missing from disk is certain.
    const registered = listed.code === 0 ? listed.stdout.split("\0") : null;
    const broken: { wt: WorktreeRecord; base: string[] }[] = [];
    for (const item of liveWorktrees(project)) {
      if (
        !await exists(item.wt.path) ||
        (registered && !registered.includes(`worktree ${item.wt.path}`))
      ) {
        broken.push(item);
      }
    }
    return broken;
  }

  async function reclone(project: ProjectRecord): Promise<void> {
    const fresh = `${project.clonePath}.recloning`;
    await Deno.remove(fresh, { recursive: true }).catch(() => {});
    const cloned = await run(
      "git",
      ["clone", project.remoteUrl, fresh],
      undefined,
      REMOTE_TIMEOUT_MS,
    );
    if (cloned.code !== 0) {
      await Deno.remove(fresh, { recursive: true }).catch(() => {});
      throw new Error(`cannot clone ${project.remoteUrl}: ${firstLine(cloned.stderr)}`);
    }
    await Deno.remove(project.clonePath, { recursive: true }).catch(() => {});
    await Deno.rename(fresh, project.clonePath);
  }

  /** Make the Worktree again on its branch, which comes back from the first base that exists. */
  async function recreate(project: ProjectRecord, wt: WorktreeRecord, base: string[]) {
    const clone = project.clonePath;
    if (await exists(wt.path)) {
      // What is left cannot be used by git any more: keep it aside rather than delete it.
      await Deno.rename(wt.path, `${wt.path}.damaged-${Date.now()}`);
    }
    await git(clone, "worktree", "prune");
    const known = await git(clone, "rev-parse", "--verify", "--quiet", `refs/heads/${wt.branch}`);
    if (known.code !== 0) {
      let made = false;
      for (const from of base) {
        const sha = await git(clone, "rev-parse", "--verify", "--quiet", `${from}^{commit}`);
        if (sha.code !== 0) continue;
        made = (await git(clone, "branch", wt.branch, from)).code === 0;
        if (made) break;
      }
      if (!made) throw new Error(`branch ${wt.branch} is gone and cannot be made again`);
    }
    await Deno.mkdir(dirname(wt.path), { recursive: true });
    const added = await git(clone, "worktree", "add", wt.path, wt.branch);
    if (added.code !== 0) {
      throw new Error(`cannot recreate worktree ${wt.path}: ${firstLine(added.stderr)}`);
    }
    await makeSupport(wt);
  }

  /** Pause the Project and tell the user, once; or find that the fault was already raised. */
  function raise(
    project: ProjectRecord,
    kind: FaultRecord["kind"],
    detail: string,
    standing: WorktreeRecord[],
  ): FaultRecord {
    const open = store.getOpenFault(project.id);
    if (open) {
      if (open.kind !== kind || open.detail !== detail) store.updateFault(open.id, kind, detail);
      return open;
    }
    const lost = standingOn(standing).map((a) => a.id);
    const overseer = store.listSessions().find((s) => s.role === "overseer");
    const escalation = overseer
      ? store.addEscalation({
        raisedBy: overseer.address,
        summary: `Environment fault on ${project.name}: ${detail}`,
        detail: `${project.name} is paused while Kiln puts this right. Kiln recovers on its own ` +
          `and resumes the project; this escalation closes itself then. Work that was never ` +
          `pushed from a clone or worktree that had to be made again may be lost.` +
          (lost.length ? ` Assignments failed because of it: ${lost.join(", ")}.` : ""),
      })
      : null;
    const fault = store.openFault({
      projectId: project.id,
      kind,
      detail,
      escalationId: escalation?.id ?? null,
      pausedByFault: !project.paused,
    });
    if (!project.paused) store.updateProject(project.name, { paused: true });
    store.appendEvent("fault.raised", { project: project.name, kind, escalation: escalation?.id });
    log.warn("environment fault", { project: project.name, kind, detail });
    return fault;
  }

  function recovered(project: ProjectRecord, fault: FaultRecord, what: string) {
    store.recoverFault(fault.id);
    if (fault.pausedByFault) store.updateProject(project.name, { paused: false });
    if (fault.escalationId !== null) {
      deps.close(fault.escalationId, `Recovered automatically: ${what}`);
    }
    store.appendEvent("fault.recovered", { project: project.name, kind: fault.kind });
    log.info("environment fault recovered", { project: project.name, what });
  }

  /** The active Assignments standing on these Worktrees. */
  function standingOn(wts: WorktreeRecord[]) {
    const ids = new Set(wts.map((wt) => wt.id));
    return store.listActiveAssignments().filter((a) =>
      a.worktreeId !== null && ids.has(a.worktreeId)
    );
  }

  /** Fail the active Assignments standing on Worktrees that were made again. */
  function failAffected(made: WorktreeRecord[]): void {
    for (const a of standingOn(made)) {
      const wt = store.getWorktree(a.worktreeId!);
      const worker = store.getMessage(a.id)!.to;
      deps.failAssignment(
        a.id,
        `The worktree ${wt.path} was made again after an environment fault, so unpushed work ` +
          `in it may be lost.`,
      );
      deps.reportStuck(worker, `its worktree ${wt.path} was made again and its work may be lost`);
    }
  }

  async function lookAt(project: ProjectRecord): Promise<void> {
    let fault = store.getOpenFault(project.id);
    const damaged = await cloneProblem(project);
    if (damaged) {
      fault = raise(project, "clone", damaged, liveWorktrees(project).map((l) => l.wt));
      try {
        await reclone(project);
      } catch (err) {
        log.error("cannot re-clone", { project: project.name, err });
        return;
      }
      // Worktrees registered in the old clone are not known to the new one: make them again.
    }
    const broken = await worktreeProblems(project);
    if (!broken.length && !damaged && !fault) return;
    if (broken.length) {
      fault = raise(
        project,
        damaged ? "clone" : "worktree",
        damaged ??
          `worktree${broken.length > 1 ? "s" : ""} ${
            broken.map((b) => b.wt.path).join(", ")
          } deleted`,
        broken.map((b) => b.wt),
      );
    }
    try {
      for (const { wt, base } of broken) {
        await recreate(project, wt, base);
        failAffected([wt]);
      }
    } catch (err) {
      log.error("cannot recreate a worktree", { project: project.name, err });
      return;
    }
    if (fault) {
      recovered(
        project,
        fault,
        damaged ? "the clone was cloned again" : "the worktrees were made again",
      );
    }
  }

  /** Look at every Project's environment; one look at a time. */
  function check(): Promise<void> {
    looking ??= (async () => {
      for (const project of store.listProjects()) {
        try {
          await deps.withProject(project.name, () => lookAt(project));
        } catch (err) {
          log.error("fault check failed", { project: project.name, err });
        }
      }
    })().finally(() => looking = undefined);
    return looking;
  }

  return { check };
}
