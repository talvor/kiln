// Worktrees, request branches and Assignment merge-back. Work happens in checkouts outside the
// Project's clone: one Worktree per Request (on the request branch, where finished Assignments are
// merged) and one per Assignment (on its own branch). Each Worktree has its own ports, temporary
// directory and caches, so concurrent work does not collide.
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "@std/path";
import { firstLine, REMOTE_TIMEOUT_MS, run } from "./checks.ts";
import type { ProjectRecord, Store, WorktreeRecord } from "./store.ts";
import { WORKTREE_PORTS } from "./store.ts";

/** The request or assignment cannot go ahead; the message says why. */
export class WorktreeBlocked extends Error {}

/** The Assignment's work conflicts with what is already on the request branch. */
export class MergeConflict extends WorktreeBlocked {}

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

/**
 * The longest `TMPDIR` a worker may have. Claude's command sandbox listens on sockets named
 * `$TMPDIR/claude-socks-<16 hex>.sock` (35 characters); a unix socket path holds at most 107
 * usable bytes, and a longer one makes the sandbox fail to start.
 */
export const MAX_TMPDIR_LENGTH = 72;

/**
 * The private, short temporary directory of a Worktree: `$XDG_RUNTIME_DIR/kiln/<key>/tmp`, or
 * `/tmp/kiln-<uid>/<key>/tmp` where there is no usable runtime directory (macOS). It is not
 * beside the Worktree, whose path can be long. The key is the Worktree's id plus a hash of
 * its path, so two Kiln homes of one user never share a directory.
 */
export function tmpdirOf(
  wt: WorktreeRecord,
  runtimeDir: string | null = usableRuntimeDir(),
  uid: number | null = Deno.uid(),
): string {
  const key = `${wt.id}-${createHash("sha256").update(wt.path).digest("hex").slice(0, 16)}`;
  const root = runtimeDir ? join(runtimeDir, "kiln") : join("/tmp", `kiln-${uid ?? "user"}`);
  return join(root, key, "tmp");
}

function usableRuntimeDir(): string | null {
  const dir = Deno.env.get("XDG_RUNTIME_DIR");
  if (!dir || !isAbsolute(dir)) return null;
  try {
    const root = join(dir, "kiln");
    let probeParent = dir;
    try {
      const info = Deno.statSync(root);
      if (!info.isDirectory || (Deno.uid() !== null && info.uid !== Deno.uid())) return null;
      probeParent = root;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) return null;
    }
    const probe = Deno.makeTempDirSync({ dir: probeParent, prefix: ".kiln-" });
    Deno.removeSync(probe);
    return dir;
  } catch {
    return null;
  }
}

/** The possible directories holding a Worktree's `TMPDIR`; removed with it. */
function tmpHomes(wt: WorktreeRecord): string[] {
  const runtime = Deno.env.get("XDG_RUNTIME_DIR");
  return [...new Set([
    ...(runtime && isAbsolute(runtime) ? [dirname(tmpdirOf(wt, runtime))] : []),
    dirname(tmpdirOf(wt, null)),
  ])];
}

/** Refuse a `TMPDIR` the worker sandbox could not use, saying why. */
function checkTmpdirLength(tmpdir: string): void {
  const bytes = new TextEncoder().encode(tmpdir).length;
  if (bytes > MAX_TMPDIR_LENGTH) {
    throw new WorktreeBlocked(
      `Cannot use ${tmpdir} as a worktree's TMPDIR: it is ${bytes} bytes, over the ` +
        `limit of ${MAX_TMPDIR_LENGTH} (the worker sandbox's sockets must fit in a 107 byte ` +
        `unix socket path). Point XDG_RUNTIME_DIR at a shorter directory.`,
    );
  }
}

/** Make a Worktree's `TMPDIR`, and its parent directories, private to the user. */
export async function makeTmpdir(wt: WorktreeRecord): Promise<void> {
  const tmpdir = infoOf(wt).env.TMPDIR;
  checkTmpdirLength(tmpdir);
  const home = dirname(tmpdir);
  const root = dirname(home);
  await Deno.mkdir(tmpdir, { recursive: true, mode: 0o700 });
  for (const dir of [root, home, tmpdir]) {
    const info = await Deno.stat(dir);
    if (Deno.uid() !== null && info.uid !== Deno.uid()) {
      throw new WorktreeBlocked(`Cannot use ${dir} as a temporary directory: it is not yours.`);
    }
    await Deno.chmod(dir, 0o700);
  }
}

/** Make a Worktree's support directories (caches and `TMPDIR`) if they are missing. */
export async function makeSupport(wt: WorktreeRecord): Promise<void> {
  const env = infoOf(wt).env;
  for (const dir of [env.XDG_CACHE_HOME, env.npm_config_cache]) {
    await Deno.mkdir(dir, { recursive: true });
  }
  await makeTmpdir(wt);
}

async function removeSupport(wt: WorktreeRecord): Promise<void> {
  await removeIfPresent(`${wt.path}.kiln`);
  for (const home of tmpHomes(wt)) await removeIfPresent(home);
}

export function infoOf(wt: WorktreeRecord): WorktreeInfo {
  const support = `${wt.path}.kiln`;
  return {
    path: wt.path,
    branch: wt.branch,
    env: {
      KILN_PORT_BASE: String(wt.portBase),
      KILN_PORT_COUNT: String(WORKTREE_PORTS),
      TMPDIR: tmpdirOf(wt),
      XDG_CACHE_HOME: join(support, "cache"),
      npm_config_cache: join(support, "cache", "npm"),
    },
  };
}

async function git(cwd: string, ...args: string[]) {
  return await run("git", args, cwd, REMOTE_TIMEOUT_MS);
}

async function removeIfPresent(path: string): Promise<void> {
  await Deno.remove(path, { recursive: true }).catch((failure) => {
    if (!(failure instanceof Deno.errors.NotFound)) throw failure;
  });
}

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, (failure) => {
    if (failure instanceof Deno.errors.NotFound) return false;
    throw failure;
  });
}

async function createWorktree(
  store: Store,
  project: ProjectRecord,
  requestedPath: string,
  branch: string,
  base: string,
): Promise<WorktreeRecord> {
  // Keep the real path (e.g. /private/tmp on macOS), as Git and a launch's cwd report it.
  await Deno.mkdir(dirname(requestedPath), { recursive: true });
  const path = join(await Deno.realPath(dirname(requestedPath)), basename(requestedPath));
  const wt = store.addWorktree({ path, branch });
  let supportCreated = false;
  let tmpTouched = false;
  let branchCreated = false;
  try {
    if (await exists(path)) {
      throw new WorktreeBlocked(`Cannot create worktree ${path}: the path already exists.`);
    }
    await Deno.mkdir(`${path}.kiln`);
    supportCreated = true;
    checkTmpdirLength(infoOf(wt).env.TMPDIR);
    tmpTouched = true;
    await makeSupport(wt);
    const created = await run("git", ["branch", branch, base], project.clonePath);
    if (created.code !== 0) {
      throw new WorktreeBlocked(`Cannot create branch ${branch}: ${firstLine(created.stderr)}`);
    }
    branchCreated = true;
    const added = await git(
      project.clonePath,
      "worktree",
      "add",
      path,
      branch,
    );
    if (added.code !== 0) {
      throw new WorktreeBlocked(`Cannot create worktree ${path}: ${firstLine(added.stderr)}`);
    }
    return wt;
  } catch (err) {
    try {
      if (branchCreated) {
        const listed = await git(project.clonePath, "worktree", "list", "--porcelain", "-z");
        if (listed.code !== 0) throw new Error(firstLine(listed.stderr));
        const registered = listed.stdout.split("\0\0").some((record) => {
          const fields = record.split("\0");
          return fields.includes(`worktree ${path}`) &&
            fields.includes(`branch refs/heads/${branch}`);
        });
        if (registered) {
          await git(project.clonePath, "worktree", "remove", "--force", path);
          await removeIfPresent(path);
        } else if (await exists(path)) {
          throw new Error(`ownership of ${path} cannot be confirmed`);
        }
        const pruned = await git(project.clonePath, "worktree", "prune");
        if (pruned.code !== 0) throw new Error(firstLine(pruned.stderr));
      }
      if (branchCreated) {
        const deleted = await git(project.clonePath, "branch", "-D", branch);
        if (deleted.code !== 0) throw new Error(firstLine(deleted.stderr));
      }
      if (supportCreated) await removeIfPresent(`${path}.kiln`);
      if (tmpTouched) {
        for (const home of tmpHomes(wt)) await removeIfPresent(home);
      }
      store.releaseWorktree(wt.id);
    } catch (failure) {
      throw new WorktreeCleanupFailed(
        `Cannot clean up failed worktree ${path}: ${(failure as Error).message}`,
      );
    }
    throw err;
  }
}

class WorktreeCleanupFailed extends WorktreeBlocked {}

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
    if (!(err instanceof WorktreeCleanupFailed)) store.discardRequest(request.id);
    throw err;
  }
}

/**
 * Start an Assignment: its own branch in its own Worktree, off the request branch or, for a
 * retry, off `fromBranch`, the branch of the work that was rejected.
 */
export async function startAssignment(
  store: Store,
  project: ProjectRecord,
  requestId: number,
  assignmentId: number,
  worktreesDir: string,
  fromBranch?: string,
): Promise<StartedAssignment> {
  const request = store.getRequest(requestId);
  if (request.status !== "active" || !request.branch) {
    throw new WorktreeBlocked(`Request ${requestId} is not active.`);
  }
  const assignment = store.addAssignment(requestId, assignmentId);
  const branch = `kiln/request-${requestId}-assignment-${assignment.id}`;
  try {
    const wt = await createWorktree(
      store,
      project,
      join(worktreesDir, project.name, `request-${requestId}-assignment-${assignment.id}`),
      branch,
      fromBranch ?? request.branch,
    );
    store.attachAssignment(assignment.id, branch, wt.id);
    return { assignmentId: assignment.id, requestId, ...infoOf(wt) };
  } catch (err) {
    if (!(err instanceof WorktreeCleanupFailed)) store.discardAssignment(assignment.id);
    throw err;
  }
}

/** Remove `files` from the request branch, so the next round has to write them afresh. */
export async function clearFromRequestBranch(
  store: Store,
  requestId: number,
  files: string[],
): Promise<void> {
  const requestWt = store.getWorktree(store.getRequest(requestId).worktreeId!);
  const removed = await git(requestWt.path, "rm", "-q", "--ignore-unmatch", "--", ...files);
  if (removed.code !== 0) throw new WorktreeBlocked(firstLine(removed.stderr));
  const staged = await git(requestWt.path, "diff", "--cached", "--quiet");
  if (staged.code === 0) return;
  const committed = await git(
    requestWt.path,
    "commit",
    "-q",
    "-m",
    "Clear the artifacts of the QA steps being run again",
  );
  if (committed.code !== 0) throw new WorktreeBlocked(firstLine(committed.stderr));
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
  if (assignment.mergedAt && assignment.pushed && assignmentWt.releasedAt) {
    throw new WorktreeBlocked(`Assignment ${assignmentId} is already merged and pushed.`);
  }

  if (!assignment.mergedAt) {
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
      `Merge assignment ${assignment.id} of request ${request.id}`,
      assignment.branch!,
    );
    if (merged.code !== 0) {
      await git(requestWt.path, "merge", "--abort");
      throw new MergeConflict(
        `Assignment ${assignmentId} does not merge cleanly into ${request.branch}: ` +
          `${firstLine(merged.stdout || merged.stderr)}. The request branch is unchanged.`,
      );
    }
    store.markMerged(assignmentId);
  }

  if (!assignment.pushed) {
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
  }
  const pathExists = await exists(assignmentWt.path);
  if (pathExists) {
    const removed = await git(
      project.clonePath,
      "worktree",
      "remove",
      "--force",
      assignmentWt.path,
    );
    if (removed.code !== 0) {
      throw new WorktreeBlocked(
        `Assignment ${assignmentId} was pushed but its worktree could not be removed: ${
          firstLine(removed.stderr)
        }. Run the merge again to retry cleanup.`,
      );
    }
  } else {
    const pruned = await git(project.clonePath, "worktree", "prune");
    if (pruned.code !== 0) {
      throw new WorktreeBlocked(`Cannot finish worktree cleanup: ${firstLine(pruned.stderr)}`);
    }
  }
  const listed = await git(project.clonePath, "worktree", "list", "--porcelain", "-z");
  if (listed.code !== 0 || listed.stdout.split("\0").includes(`worktree ${assignmentWt.path}`)) {
    throw new WorktreeBlocked(`Assignment ${assignmentId} is still registered as a worktree.`);
  }
  await removeSupport(assignmentWt);
  store.releaseWorktree(assignmentWt.id);
  return result;
}

/**
 * Clean up after a Request whose pull request was merged: every Worktree it still holds, its
 * local branches and the request branch on the remote. Returns what could not be removed; a
 * failure leaves that part behind rather than failing a Request that has shipped.
 */
export async function cleanUpRequest(
  store: Store,
  project: ProjectRecord,
  requestId: number,
): Promise<string[]> {
  const request = store.getRequest(requestId);
  const problems: string[] = [];
  const attempt = async (what: string, work: () => Promise<{ code: number; stderr: string }>) => {
    try {
      const done = await work();
      if (done.code !== 0) problems.push(`${what}: ${firstLine(done.stderr)}`);
    } catch (err) {
      problems.push(`${what}: ${(err as Error).message}`);
    }
  };
  const assignments = store.listAssignments(requestId);
  const worktreeIds = [...assignments.map((a) => a.worktreeId), request.worktreeId];
  for (const id of worktreeIds) {
    if (id === null) continue;
    const wt = store.getWorktree(id);
    if (wt.releasedAt) continue;
    if (await exists(wt.path)) {
      await attempt(
        `remove worktree ${wt.path}`,
        () => git(project.clonePath, "worktree", "remove", "--force", wt.path),
      );
    }
    if (!(await exists(wt.path))) {
      await removeSupport(wt);
      store.releaseWorktree(wt.id);
    }
  }
  await attempt("prune worktrees", () => git(project.clonePath, "worktree", "prune"));
  const branches = [...assignments.map((a) => a.branch), request.branch];
  for (const branch of branches) {
    if (!branch) continue;
    const known = await git(project.clonePath, "rev-parse", "--verify", "--quiet", branch);
    if (known.code !== 0) continue;
    await attempt(`delete branch ${branch}`, () => git(project.clonePath, "branch", "-D", branch));
  }
  if (request.branch) {
    const gone = async () => {
      const listed = await git(
        project.clonePath,
        "ls-remote",
        "--heads",
        "origin",
        request.branch!,
      );
      return listed.code === 0 && !listed.stdout.trim();
    };
    // The forge may have deleted the branch when the pull request merged.
    if (!(await gone())) {
      await attempt(
        `delete ${request.branch} on the remote`,
        () => git(project.clonePath, "push", "origin", "--delete", request.branch!),
      );
    }
  }
  return problems;
}
