// Managing a registered Project: re-checking it after its commands or default branch change, and
// re-running its test baseline. Commands come only from the user (the flags they pass); files in
// the Project may have suggested commands at registration but never change or run anything here.
import { isAbsolute, relative, resolve } from "@std/path";
import {
  branchProtection,
  commandWarnings,
  firstLine,
  PUSH_CHECK_REF,
  REMOTE_TIMEOUT_MS,
  run,
  SETUP_TIMEOUT_MS,
  shell,
  tail,
  TEST_TIMEOUT_MS,
} from "./checks.ts";
import { readableOnboardingFiles } from "./register.ts";
import type { Baseline, ProjectPatch, ProjectRecord } from "./store.ts";

/** The re-check cannot go ahead or failed; the Project record was not changed. */
export class RecheckBlocked extends Error {}

/** What the user asked to change before the re-check. `null` clears a command. */
export interface Change {
  setupCommand?: string | null;
  testCommand?: string | null;
  lintCommand?: string | null;
  buildCommand?: string | null;
  defaultBranch?: string;
}

/**
 * Re-check a Project with the change applied: bring Kiln's clone to the default branch on the
 * remote, check that Kiln can push and that agent docs exist, run setup and the test baseline.
 * Returns the patch to record; throws RecheckBlocked (recording nothing) if it cannot.
 */
export async function recheckProject(
  project: ProjectRecord,
  change: Change,
  progress: (message: string) => void,
  baselineOnly = false,
): Promise<ProjectPatch> {
  try {
    return await recheck(project, change, progress, baselineOnly);
  } catch (err) {
    const blocked = err instanceof RecheckBlocked
      ? err
      : new RecheckBlocked((err as Error).message);
    let reason: string | undefined;
    try {
      const rollback = await run(
        "git",
        ["checkout", "--force", "-B", project.defaultBranch, project.headCommit],
        project.clonePath,
      );
      if (rollback.code !== 0) reason = firstLine(rollback.stderr);
    } catch (rollbackError) {
      reason = (rollbackError as Error).message;
    }
    if (reason) {
      throw new RecheckBlocked(
        `${blocked.message}\nCould not restore the clone to ${project.defaultBranch}: ${reason}`,
      );
    }
    throw blocked;
  }
}

async function recheck(
  project: ProjectRecord,
  change: Change,
  progress: (message: string) => void,
  baselineOnly: boolean,
): Promise<ProjectPatch> {
  const next = { ...project, ...change };
  const clone = project.clonePath;
  const git = (...args: string[]) => run("git", args, clone);

  progress(`Fetching ${project.remoteUrl}`);
  const fetch = await run("git", ["fetch", "--prune", "origin"], clone, REMOTE_TIMEOUT_MS);
  if (fetch.code !== 0) {
    throw new RecheckBlocked(`Cannot fetch ${project.remoteUrl}: ${firstLine(fetch.stderr)}`);
  }
  const branch = next.defaultBranch;
  const remoteRef = `refs/remotes/origin/${branch}`;
  if ((await git("rev-parse", "--verify", "--quiet", `${remoteRef}^{commit}`)).code !== 0) {
    throw new RecheckBlocked(`The remote has no branch "${branch}".`);
  }
  const checkout = await git("checkout", "--force", "-B", branch, remoteRef);
  if (checkout.code !== 0) {
    throw new RecheckBlocked(`Cannot check out ${branch}: ${firstLine(checkout.stderr)}`);
  }
  const clean = await git("clean", "-ffdx");
  if (clean.code !== 0) {
    throw new RecheckBlocked(`Cannot clean the clone: ${firstLine(clean.stderr)}`);
  }
  const head = await git("rev-parse", "HEAD");
  if (head.code !== 0 || !head.stdout.trim()) {
    throw new RecheckBlocked(`Cannot read the clone's HEAD: ${firstLine(head.stderr)}`);
  }
  const headCommit = head.stdout.trim();

  if (!baselineOnly) {
    const docs = await readableOnboardingFiles(clone);
    if (!docs.some((file) => file === "AGENTS.md" || file === "CLAUDE.md")) {
      throw new RecheckBlocked(
        `"${branch}" has no agent docs. Add an AGENTS.md or CLAUDE.md at its root and push it.`,
      );
    }

    progress("Checking that Kiln can push to the remote");
    const push = await run(
      "git",
      ["push", "--dry-run", "origin", `HEAD:${PUSH_CHECK_REF}`],
      clone,
      REMOTE_TIMEOUT_MS,
    );
    if (push.code !== 0) {
      throw new RecheckBlocked(
        `A push dry-run to ${project.remoteUrl} failed: ${firstLine(push.stderr)}`,
      );
    }
  }

  const warnings: string[] = [];
  if (!baselineOnly) {
    const protection = await branchProtection(clone, branch);
    if (protection) warnings.push(protection);
  }

  if (next.setupCommand) {
    progress(`Running setup: ${next.setupCommand}`);
    const setup = await shell(next.setupCommand, clone, SETUP_TIMEOUT_MS);
    if (setup.code !== 0) {
      throw new RecheckBlocked(
        `Setup failed (exit ${setup.code}): ${next.setupCommand}\n${tail(setup.output)}`,
      );
    }
  }
  warnings.push(...commandWarnings({
    test: next.testCommand,
    lint: next.lintCommand,
    build: next.buildCommand,
  }));

  let baseline: Baseline | null = null;
  if (next.testCommand) {
    progress(`Recording the test baseline: ${next.testCommand}`);
    const started = Date.now();
    const test = await shell(next.testCommand, clone, TEST_TIMEOUT_MS);
    baseline = {
      passed: test.code === 0,
      exitCode: test.code,
      durationMs: Date.now() - started,
      commit: headCommit,
      outputTail: tail(test.output),
      recordedAt: new Date().toISOString(),
    };
  }

  return {
    defaultBranch: branch,
    headCommit,
    setupCommand: next.setupCommand,
    testCommand: next.testCommand,
    lintCommand: next.lintCommand,
    buildCommand: next.buildCommand,
    baseline,
    warnings,
  };
}

/** Removing a Project deletes only Kiln's own clone, and only if it sits under `projectsDir`. */
export async function removeClone(clonePath: string, projectsDir: string): Promise<void> {
  const within = relative(resolve(projectsDir), resolve(clonePath));
  if (!within || within === ".." || within.startsWith("../") || isAbsolute(within)) {
    throw new Error(
      `Project record was removed, but its clone at ${clonePath} is outside ${projectsDir}. Remove that directory to reuse the name.`,
    );
  }
  try {
    await Deno.remove(clonePath, { recursive: true });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      try {
        await Deno.lstat(clonePath);
      } catch (statError) {
        if (statError instanceof Deno.errors.NotFound) return;
      }
    }
    throw new Error(
      `Project record was removed, but its clone at ${clonePath} could not be deleted: ${(err as Error).message}. Remove that directory to reuse the name.`,
    );
  }
}
