// The leader's verification of a Worker's Assignment: the checks a Project defines, run in the
// Assignment's worktree and judged against the test baseline recorded at registration, and the
// step's acceptance criteria. What comes back is the feedback for a rejection, or nothing.
import { SETUP_TIMEOUT_MS, shell, TEST_TIMEOUT_MS } from "./checks.ts";
import type { ProjectRecord, StepSpec } from "./store.ts";
import { parseTicket } from "./tracker.ts";

const CHECK_TIMEOUT_MS = 15 * 60_000;

/**
 * Why the work in `cwd` must be rejected, one problem per entry; empty when it is accepted.
 * Acceptance criteria: the step's artifact is committed with content, and an artifact that
 * Kiln publishes as a ticket starts with a title. Checks: the Project's lint, build and test
 * commands pass. A test run that fails is accepted only when the baseline failed too: the
 * Project was already red, so the run cannot tell this work from the rest.
 */
export async function verifyWork(
  project: ProjectRecord,
  spec: StepSpec,
  cwd: string,
): Promise<string[]> {
  const problems: string[] = [];
  const artifact = await Deno.readTextFile(`${cwd}/${spec.artifact}`).catch(() => "");
  if (!artifact.trim()) {
    problems.push(`Acceptance criteria: ${spec.artifact} was not committed, or is empty.`);
  } else if (spec.publish === "ticket" && !parseTicket(artifact).title) {
    problems.push(`Acceptance criteria: ${spec.artifact} must start with the ticket's title.`);
  }

  if (project.setupCommand) {
    const setup = await shell(project.setupCommand, cwd, SETUP_TIMEOUT_MS);
    if (setup.code !== 0) {
      problems.push(failure("setup", project.setupCommand, setup.code, setup.output));
      return problems;
    }
  }
  const checks: [string, string | null, number][] = [
    ["lint", project.lintCommand, CHECK_TIMEOUT_MS],
    ["build", project.buildCommand, CHECK_TIMEOUT_MS],
    ["test", project.testCommand, TEST_TIMEOUT_MS],
  ];
  for (const [name, command, timeout] of checks) {
    if (!command) continue;
    const result = await shell(command, cwd, timeout);
    if (result.code === 0) continue;
    if (name === "test" && project.baseline && !project.baseline.passed) continue;
    const against = name === "test" && project.baseline
      ? " The baseline passed, so this work broke it."
      : "";
    problems.push(failure(name, command, result.code, result.output) + against);
  }
  return problems;
}

function failure(name: string, command: string, code: number, output: string): string {
  return `The ${name} check failed (\`${command}\`, exit ${code}):\n${output}`.trimEnd();
}
