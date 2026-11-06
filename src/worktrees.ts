// Worktrees, request branches and Assignment merge-back. Work happens in checkouts outside the
// Project's clone: one Worktree per Request (on the request branch, where finished Assignments are
// merged) and one per Assignment (on its own branch). Each Worktree has its own ports, temporary
// directory and caches, so concurrent work does not collide.
import { join } from "@std/path";
import { firstLine, REMOTE_TIMEOUT_MS, run } from "./checks.ts";
import type { ProjectRecord, Store, WorktreeRecord } from "./store.ts";
import { WORKTREE_PORTS } from "./store.ts";

/** The request or assignment cannot go ahead; the message says why. */
export class WorktreeBlocked extends Error {}

/** What a Worktree is, and the environment work inside it should run with. */
export interface WorktreeInfo {
  path: string;
  branch: string;
  /** Environment variables that keep this Worktree's ports, temp files and caches its own. */
  env: Record<string, string>;
}

export interface StartedRequest extends WorktreeInfo {
  requestId: number;
}
export interface StartedAssignment extends WorktreeInfo {
  assignmentId: number;
  requestId: number;
}
export interface MergedAssignment {
  assignmentId: number;
  branch: string;
  requestBranch: string;
}

function infoOf(wt: WorktreeRecord): WorktreeInfo {
  const support = `${wt.path}.kiln`;
  return {
    path: wt.path,
    branch: wt.branch,
    env: {
      KILN_PORT_BASE: String(wt.portBase),
      KILN_PORT_COUNT: String(WORKTREE_PORTS),
      TMPDIR: join(support, "tmp"),
      XDG_CACHE_HOME: join(support, "cache"),
      npm_config_cache: join(support, "cache", "npm"),
    },
  };
}

async function git(cwd: string, ...args: string[]) {
  return await run("git", args, cwd, REMOTE_TIMEOUT_MS);
}

async function createWorktree(
  store: Store,
  project: ProjectRecord,
  path: string,
  branch: string,
  base: string,
): Promise<WorktreeRecord> {
  const wt = store.addWorktree({ path, branch });
  try {
    const info = infoOf(wt);
    for (const dir of [info.env.TMPDIR, info.env.XDG_CACHE_HOME, info.env.npm_config_cache]) {
      await Deno.mkdir(dir, { recursive: true });
    }
    const added = await git(
      project.clonePath,
      "worktree",
      "add",
      "--no-track",
      "-b",
      branch,
      path,
      base,
    );
    if (added.code !== 0) {
      throw new WorktreeBlocked(`Cannot create worktree ${path}: ${firstLine(added.stderr)}`);
    }
    return wt;
  } catch (err) {
    store.releaseWorktree(wt.id);
    await Deno.remove(`${path}.kiln`, { recursive: true }).catch(() => {});
    await git(project.clonePath, "worktree", "prune");
    throw err;
  }
}

/** Start a Request: a request branch off the Project's default branch, in its own Worktree. */
export async function startRequest(
  store: Store,
  project: ProjectRecord,
  worktreesDir: string,
): Promise<StartedRequest> {
  if (project.paused) {
    throw new WorktreeBlocked(`${project.name} is paused and takes no new requests.`);
  }
  const fetched = await git(project.clonePath, "fetch", "origin");
  if (fetched.code !== 0) {
    throw new WorktreeBlocked(`Cannot fetch ${project.remoteUrl}: ${firstLine(fetched.stderr)}`);
  }
  const request = store.addRequest(project.id);
  const branch = `kiln/request-${request.id}`;
  try {
    const wt = await createWorktree(
      store,
      project,
      join(worktreesDir, project.name, `request-${request.id}`),
      branch,
      `origin/${project.defaultBranch}`,
    );
    store.attachRequest(request.id, branch, wt.id);
    return { requestId: request.id, ...infoOf(wt) };
  } catch (err) {
    store.discardRequest(request.id);
    throw err;
  }
}

/** Start an Assignment: its own branch off the request branch, in its own Worktree. */
export async function startAssignment(
  store: Store,
  project: ProjectRecord,
  requestId: number,
  worktreesDir: string,
): Promise<StartedAssignment> {
  const request = store.getRequest(requestId);
  if (request.status !== "active" || !request.branch) {
    throw new WorktreeBlocked(`Request ${requestId} is not active.`);
  }
  const assignment = store.addAssignment(requestId);
  const branch = `kiln/request-${requestId}-assignment-${assignment.number}`;
  try {
    const wt = await createWorktree(
      store,
      project,
      join(worktreesDir, project.name, `request-${requestId}-assignment-${assignment.number}`),
      branch,
      request.branch,
    );
    store.attachAssignment(assignment.id, branch, wt.id);
    return { assignmentId: assignment.id, requestId, ...infoOf(wt) };
  } catch (err) {
    store.discardAssignment(assignment.id);
    throw err;
  }
}

/**
 * Merge a verified Assignment into its request branch and push that branch. A merge that was
 * made but not pushed is pushed again on retry.
 */
export async function mergeAssignment(
  store: Store,
  project: ProjectRecord,
  assignmentId: number,
): Promise<MergedAssignment> {
  const assignment = store.getAssignment(assignmentId);
  const request = store.getRequest(assignment.requestId);
  const requestWt = store.getWorktree(request.worktreeId!);
  const assignmentWt = store.getWorktree(assignment.worktreeId!);
  const result = {
    assignmentId,
    branch: assignment.branch!,
    requestBranch: request.branch!,
  };
  if (assignment.status === "merged" && assignment.pushed) {
    throw new WorktreeBlocked(`Assignment ${assignmentId} is already merged and pushed.`);
  }

  if (assignment.status === "active") {
    const dirty = await git(assignmentWt.path, "status", "--porcelain");
    if (dirty.stdout.trim()) {
      throw new WorktreeBlocked(
        `Assignment ${assignmentId} has uncommitted changes in ${assignmentWt.path}; commit them first.`,
      );
    }
    const merged = await git(
      requestWt.path,
      "merge",
      "--no-ff",
      "-m",
      `Merge assignment ${assignment.number} of request ${request.id}`,
      assignment.branch!,
    );
    if (merged.code !== 0) {
      await git(requestWt.path, "merge", "--abort");
      throw new WorktreeBlocked(
        `Assignment ${assignmentId} does not merge cleanly into ${request.branch}: ` +
          `${firstLine(merged.stdout || merged.stderr)}. The request branch is unchanged.`,
      );
    }
    store.markMerged(assignmentId);
  }

  const pushed = await git(
    requestWt.path,
    "push",
    "origin",
    `${request.branch!}:${request.branch!}`,
  );
  if (pushed.code !== 0) {
    throw new WorktreeBlocked(
      `Assignment ${assignmentId} is merged into ${request.branch} but pushing it to ` +
        `${project.remoteUrl} failed: ${
          firstLine(pushed.stderr)
        }. Run the merge again to retry the push.`,
    );
  }
  store.markPushed(assignmentId);
  store.appendEvent("assignment.merged", { id: assignmentId, request: request.id });

  // The Assignment's work is on the request branch now; give its Worktree and ports back.
  await git(project.clonePath, "worktree", "remove", "--force", assignmentWt.path);
  await Deno.remove(`${assignmentWt.path}.kiln`, { recursive: true }).catch(() => {});
  store.releaseWorktree(assignmentWt.id);
  return result;
}
