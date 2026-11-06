// Registering a Project: Kiln takes its own clone, checks the Project can be worked on, has an
// onboarding agent propose its commands, and records them with the test baseline once the user
// confirms. Problems that make a Project unworkable block registration; the rest are warnings.
import { isAbsolute, join, resolve } from "@std/path";
import type { LaunchRequest, LaunchResult } from "./launcher.ts";
import type { Baseline, NewProject } from "./store.ts";

/** Registration cannot go ahead; the message says why and what to fix. */
export class RegistrationBlocked extends Error {}
/** The user did not confirm the proposed commands. */
export class RegistrationDeclined extends Error {
  constructor() {
    super("The proposed commands were not confirmed.");
  }
}

export interface Commands {
  setup: string | null;
  test: string | null;
  lint: string | null;
  build: string | null;
}

export interface RegisterDeps {
  /** Directory holding Kiln's clones of Projects. */
  projectsDir: string;
  /** Names already registered. */
  existingNames: string[];
  launch(req: LaunchRequest): Promise<LaunchResult>;
  /** Show the proposed commands to the user; true if they confirm. */
  confirm(commands: Commands): Promise<boolean>;
  /** Persist the Project; throws if it cannot be recorded. */
  record(project: NewProject): Promise<void>;
  progress(message: string): void;
}

export interface RegisterOptions {
  name?: string;
}

const SETUP_TIMEOUT_MS = 15 * 60_000;
const TEST_TIMEOUT_MS = 30 * 60_000;
const OUTPUT_TAIL_BYTES = 4000;
const PUSH_CHECK_REF = "refs/heads/kiln/registration-check";
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function registerProject(
  source: string,
  opts: RegisterOptions,
  deps: RegisterDeps,
): Promise<NewProject> {
  const { remoteUrl, name: derivedName } = await resolveSource(source);
  const name = opts.name ?? derivedName;
  if (!NAME_PATTERN.test(name)) {
    throw new RegistrationBlocked(
      `"${name}" is not a usable project name. Pass one with --name (letters, digits, ".", "_", "-").`,
    );
  }
  if (deps.existingNames.includes(name)) {
    throw new RegistrationBlocked(`A project named "${name}" is already registered.`);
  }
  const clonePath = join(deps.projectsDir, name);
  if (await exists(clonePath)) {
    throw new RegistrationBlocked(
      `${clonePath} already exists; remove it or register under another --name.`,
    );
  }

  try {
    const project = await onboard(source, name, remoteUrl, clonePath, deps);
    await deps.record(project);
    return project;
  } catch (err) {
    // A Project that did not register leaves nothing behind.
    await Deno.remove(clonePath, { recursive: true }).catch(() => {});
    throw err;
  }
}

async function onboard(
  source: string,
  name: string,
  remoteUrl: string,
  clonePath: string,
  deps: RegisterDeps,
): Promise<NewProject> {
  deps.progress(`Cloning ${remoteUrl}`);
  await Deno.mkdir(deps.projectsDir, { recursive: true });
  const clone = await run("git", ["clone", remoteUrl, clonePath]);
  if (clone.code !== 0) {
    throw new RegistrationBlocked(`Cannot clone ${remoteUrl}: ${firstLine(clone.stderr)}`);
  }
  const git = (...args: string[]) => run("git", args, clonePath);

  const head = await git("rev-parse", "HEAD");
  if (head.code !== 0) {
    throw new RegistrationBlocked(`${remoteUrl} has no commits; push something first.`);
  }
  const headCommit = head.stdout.trim();
  const defaultBranch = await defaultBranchOf(clonePath);

  if (!await hasAgentDocs(clonePath)) {
    throw new RegistrationBlocked(
      "The project has no agent docs. Add an AGENTS.md or CLAUDE.md at its root " +
        "(and push it) so agents know how to work in it.",
    );
  }

  deps.progress("Checking that Kiln can push to the remote");
  const push = await git("push", "--dry-run", "origin", `HEAD:${PUSH_CHECK_REF}`);
  if (push.code !== 0) {
    throw new RegistrationBlocked(
      `A push dry-run to ${remoteUrl} failed: ${firstLine(push.stderr)}`,
    );
  }

  const warnings: string[] = [];
  const protection = await branchProtection(clonePath, defaultBranch);
  if (protection) warnings.push(protection);

  deps.progress("Asking the onboarding agent for the project's commands");
  const commands = await proposeCommands(clonePath, deps);
  // The agent only reads; whatever it wrote is not part of the Project.
  await git("reset", "--hard", "--quiet");
  await git("clean", "-fdq");

  if (!await deps.confirm(commands)) throw new RegistrationDeclined();

  if (commands.setup) {
    deps.progress(`Running setup: ${commands.setup}`);
    const setup = await shell(commands.setup, clonePath, SETUP_TIMEOUT_MS);
    if (setup.code !== 0) {
      throw new RegistrationBlocked(
        `Setup failed (exit ${setup.code}): ${commands.setup}\n${tail(setup.output)}`,
      );
    }
  }

  if (!commands.lint) warnings.push("No lint command: nothing will check style before merge.");
  if (!commands.build) {
    warnings.push("No build command: nothing will check that the project builds.");
  }

  let baseline: Baseline | null = null;
  if (commands.test) {
    deps.progress(`Recording the test baseline: ${commands.test}`);
    const started = Date.now();
    const test = await shell(commands.test, clonePath, TEST_TIMEOUT_MS);
    baseline = {
      passed: test.code === 0,
      exitCode: test.code,
      durationMs: Date.now() - started,
      commit: headCommit,
      outputTail: tail(test.output),
      recordedAt: new Date().toISOString(),
    };
  } else {
    warnings.push("No test command: no test baseline was recorded.");
  }

  return {
    name,
    source,
    remoteUrl,
    clonePath,
    defaultBranch,
    headCommit,
    setupCommand: commands.setup,
    testCommand: commands.test,
    lintCommand: commands.lint,
    buildCommand: commands.build,
    baseline,
    warnings,
  };
}

/** Work out the remote to clone from, and a default name, from a path or a URL. */
async function resolveSource(source: string): Promise<{ remoteUrl: string; name: string }> {
  if (isRemoteUrl(source)) return { remoteUrl: source, name: nameFrom(source) };

  const dir = resolve(source);
  if (!await isDirectory(dir)) {
    throw new RegistrationBlocked(`${source} is neither a directory nor a git URL.`);
  }
  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], dir);
  if (inside.code !== 0) throw new RegistrationBlocked(`${dir} is not a git repository.`);
  const origin = await run("git", ["remote", "get-url", "origin"], dir);
  if (origin.code !== 0 || !origin.stdout.trim()) {
    throw new RegistrationBlocked(
      `${dir} has no remote named "origin". Kiln needs a remote to push work to; add one first.`,
    );
  }
  // Kiln clones from the remote, not from the checkout: work that was never pushed is not there.
  const url = origin.stdout.trim();
  const remoteUrl = isRemoteUrl(url) || isAbsolute(url) ? url : resolve(dir, url);
  return { remoteUrl, name: nameFrom(remoteUrl) };
}

const isRemoteUrl = (s: string) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w.-]+@[\w.-]+:/.test(s);

function nameFrom(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/, "");
}

async function defaultBranchOf(clonePath: string): Promise<string> {
  const ref = await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], clonePath);
  if (ref.code === 0) return ref.stdout.trim().replace(/^origin\//, "");
  return (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], clonePath)).stdout.trim();
}

async function hasAgentDocs(clonePath: string): Promise<boolean> {
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      if ((await Deno.stat(join(clonePath, file))).size > 0) return true;
    } catch { /* absent */ }
  }
  return false;
}

/** A warning if the default branch is unprotected or its protection cannot be checked. */
async function branchProtection(clonePath: string, branch: string): Promise<string | null> {
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await run(
      "gh",
      ["api", `repos/{owner}/{repo}/branches/${branch}/protection`],
      clonePath,
    );
  } catch {
    return `Could not check whether "${branch}" is protected: the gh command is not available.`;
  }
  if (result.code === 0) return null;
  if (/404|not protected/i.test(result.stderr)) {
    return `The default branch "${branch}" is not protected: anyone with access can push to it directly.`;
  }
  return `Could not check whether "${branch}" is protected: ${firstLine(result.stderr)}`;
}

const ONBOARDING_PROMPT =
  `You are onboarding a code project into a factory that will do work on it. Read this \
project's agent docs (AGENTS.md or CLAUDE.md), its package or build manifests, and its CI \
configuration. Do not modify, create or delete any file, and do not run any command.

Reply with only a JSON object, no other text, naming the shell commands to run from the project \
root:
{"setup": "...", "test": "...", "lint": "...", "build": "..."}

- setup: install dependencies and prepare a fresh clone, or null if nothing is needed.
- test: run the project's tests.
- lint: check style and static analysis, or null if the project has none.
- build: build the project, or null if it has no build.
Use null for any command the project does not have. Do not invent commands.`;

async function proposeCommands(clonePath: string, deps: RegisterDeps): Promise<Commands> {
  const result = await deps.launch({ prompt: ONBOARDING_PROMPT, cwd: clonePath });
  if (!result.ok) {
    throw new RegistrationBlocked(
      `The onboarding agent did not finish (${result.outcome}): ${result.text}`,
    );
  }
  const commands = parseCommands(result.text);
  if (!commands) {
    throw new RegistrationBlocked(
      `The onboarding agent did not propose commands in the expected form:\n${tail(result.text)}`,
    );
  }
  return commands;
}

function parseCommands(text: string): Commands | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const out: Commands = { setup: null, test: null, lint: null, build: null };
  for (const key of Object.keys(out) as (keyof Commands)[]) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return null;
    out[key] = value.trim() || null;
  }
  return out;
}

interface Output {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(cmd: string, args: string[], cwd?: string, timeoutMs?: number): Promise<Output> {
  const child = new Deno.Command(cmd, {
    args,
    cwd,
    // Never wait for credentials that nobody can type.
    env: { GIT_TERMINAL_PROMPT: "0" },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let timedOut = false;
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }, timeoutMs);
  const out = await child.output();
  clearTimeout(timer);
  const dec = new TextDecoder();
  return {
    code: timedOut ? 124 : out.code,
    stdout: dec.decode(out.stdout),
    stderr: timedOut
      ? `timed out after ${timeoutMs! / 60_000} minutes\n${dec.decode(out.stderr)}`
      : dec.decode(out.stderr),
  };
}

async function shell(command: string, cwd: string, timeoutMs: number) {
  const r = await run("sh", ["-c", command], cwd, timeoutMs);
  return { code: r.code, output: r.stdout + r.stderr };
}

const firstLine = (s: string) => s.trim().split("\n").find(Boolean) ?? "(no message)";
const tail = (s: string) => s.length > OUTPUT_TAIL_BYTES ? s.slice(-OUTPUT_TAIL_BYTES) : s;

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}
