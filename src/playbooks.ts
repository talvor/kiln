// Roles and Playbooks, which Kiln loads from files in its config directory:
//   <config>/roles/<name>.json      { kind, department?, prompt, tools? }
//   <config>/playbooks/<name>.json  { description, steps: [{ name, department, worker, ... }] }
// The file name is the role's or Playbook's name. Kiln ships defaults; a file with the same name
// replaces the default. Files are read when a Request starts, so edits apply to the next one.
import { join } from "@std/path";
import { BUILTIN_TOOLS, DEFAULT_TOOLS } from "./confinement.ts";
import { ConfigError } from "./config_error.ts";
import { type LimitsConfig, loadLimits } from "./limits.ts";
import { DEFAULT_PLAYBOOKS, DEFAULT_ROLES } from "./defaults.ts";
import type { Role, StepSpec } from "./store.ts";

const NAME = /^[a-z][a-z0-9-]*$/;
const PUBLISH = ["ticket", "draft-pr", "qa-summary", "close-ticket"];
const GATES = ["spec-approval", "qa-passed"];

export interface RoleConfig {
  name: string;
  kind: Role;
  /** Set for leaders and workers; the overseer belongs to no department. */
  department: string | null;
  /** What the agent is told about its job whenever Kiln wakes it. */
  prompt: string;
  /** Built-in tools the role may use; everything else is denied. Kiln's own tools always work. */
  tools: string[];
}
export interface PlaybookConfig {
  name: string;
  description: string;
  steps: StepSpec[];
}
export interface Config {
  roles: Map<string, RoleConfig>;
  playbooks: Map<string, PlaybookConfig>;
  /** Playbooks whose files cannot be used. They do not stop other Playbooks from running. */
  broken: Map<string, ConfigError>;
  /** Limits and concurrency caps. */
  limits: LimitsConfig;
}

export { ConfigError };

type Obj = Record<string, unknown>;

function parseRole(name: string, source: string, raw: unknown): RoleConfig {
  const fail = (why: string) => new ConfigError(`Role "${name}" (${source}): ${why}`);
  if (!isObject(raw)) throw fail("must be a JSON object");
  const { kind, department, prompt, tools } = raw;
  if (kind !== "overseer" && kind !== "leader" && kind !== "worker") {
    throw fail('"kind" must be overseer, leader or worker');
  }
  if (kind === "overseer" ? department !== undefined : typeof department !== "string") {
    throw fail(
      kind === "overseer"
        ? "the overseer belongs to no department"
        : `a ${kind} needs a "department"`,
    );
  }
  if (typeof prompt !== "string" || !prompt.trim()) throw fail('"prompt" must be some text');
  if (
    tools !== undefined &&
    (!Array.isArray(tools) || tools.some((t) => !(BUILTIN_TOOLS as readonly string[]).includes(t)))
  ) {
    throw fail(`"tools" must list some of: ${BUILTIN_TOOLS.join(", ")}`);
  }
  return {
    name,
    kind,
    department: (department as string | undefined) ?? null,
    prompt,
    tools: (tools as string[] | undefined) ?? [...DEFAULT_TOOLS[kind]],
  };
}

function parsePlaybook(name: string, source: string, raw: unknown, roles: Map<string, RoleConfig>) {
  const fail = (why: string) => new ConfigError(`Playbook "${name}" (${source}): ${why}`);
  if (!isObject(raw)) throw fail("must be a JSON object");
  const { description, steps } = raw;
  if (typeof description !== "string" || !description.trim()) {
    throw fail('"description" must be some text');
  }
  if (!Array.isArray(steps) || !steps.length) throw fail('"steps" must list at least one step');
  const seen = new Set<string>();
  const parsedSoFar: StepSpec[] = [];
  const parsed = steps.map((step, i): StepSpec => {
    const at = `step ${i + 1}`;
    if (!isObject(step)) throw fail(`${at} must be an object`);
    for (const field of ["name", "department", "worker", "instructions", "artifact"]) {
      if (typeof step[field] !== "string" || !(step[field] as string).trim()) {
        throw fail(`${at} needs "${field}" as some text`);
      }
    }
    const spec = step as unknown as StepSpec;
    if (!NAME.test(spec.name) || seen.has(spec.name)) {
      throw fail(`${at}: "${spec.name}" must be a unique name of lowercase letters and dashes`);
    }
    seen.add(spec.name);
    if (step.publish !== undefined && !PUBLISH.includes(step.publish as string)) {
      throw fail(`${at}: "publish" can only be ${PUBLISH.map((p) => `"${p}"`).join(", ")}`);
    }
    if (step.gate !== undefined && !GATES.includes(step.gate as string)) {
      throw fail(`${at}: "gate" can only be ${GATES.map((g) => `"${g}"`).join(" or ")}`);
    }
    if (step.after !== undefined && step.after !== "merge") {
      throw fail(`${at}: "after" can only be "merge"`);
    }
    if (step.findings !== undefined) {
      const earlier = parsedSoFar.find((s) => s.name === step.findings);
      if (!earlier) throw fail(`${at}: "findings" must name an earlier step`);
    }
    if (/^\/|(^|\/)\.\.(\/|$)/.test(spec.artifact)) {
      throw fail(`${at}: "artifact" must be a path inside the worktree`);
    }
    const worker = roles.get(spec.worker);
    if (!worker || worker.kind !== "worker") {
      throw fail(`${at}: "${spec.worker}" is not a worker role`);
    }
    if (worker.department !== spec.department) {
      throw fail(`${at}: worker "${spec.worker}" is not in department "${spec.department}"`);
    }
    if (![...roles.values()].some((r) => r.kind === "leader" && r.department === spec.department)) {
      throw fail(`${at}: department "${spec.department}" has no leader role`);
    }
    const made: StepSpec = {
      name: spec.name,
      department: spec.department,
      worker: spec.worker,
      instructions: spec.instructions,
      artifact: spec.artifact,
      ...(step.publish ? { publish: step.publish as StepSpec["publish"] } : {}),
      ...(step.gate ? { gate: step.gate as StepSpec["gate"] } : {}),
      ...(step.findings ? { findings: step.findings as string } : {}),
      ...(step.after ? { after: step.after as StepSpec["after"] } : {}),
    };
    parsedSoFar.push(made);
    return made;
  });
  return { name, description, steps: parsed };
}

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

interface ConfigFile {
  name: string;
  file: string;
  raw?: unknown;
  /** Set when the file cannot even be read as JSON. */
  error?: ConfigError;
}

async function readJsonFiles(dir: string): Promise<ConfigFile[]> {
  const found: ConfigFile[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const file = join(dir, entry.name);
      const name = entry.name.slice(0, -".json".length);
      if (!NAME.test(name)) {
        throw new ConfigError(
          `${file}: the file name must be lowercase letters, digits and dashes`,
        );
      }
      let raw: unknown;
      try {
        raw = JSON.parse(await Deno.readTextFile(file));
      } catch (err) {
        throw new ConfigError(`${file}: not valid JSON (${(err as Error).message})`);
      }
      found.push({ name, file, raw });
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Load the defaults, then the files in `configDir` over them. */
export async function loadConfig(configDir: string): Promise<Config> {
  const roles = new Map<string, RoleConfig>();
  for (const [name, raw] of Object.entries(DEFAULT_ROLES)) {
    roles.set(name, parseRole(name, "built in", raw));
  }
  for (const { name, file, raw, error } of await readJsonFiles(join(configDir, "roles"))) {
    if (error) throw error;
    roles.set(name, parseRole(name, file, raw));
  }
  const overseers = [...roles.values()].filter((r) => r.kind === "overseer");
  if (overseers.length !== 1) {
    throw new ConfigError(`There must be exactly one overseer role; found ${overseers.length}.`);
  }
  const leaders = new Map<string, string>();
  for (const r of roles.values()) {
    if (r.kind !== "leader") continue;
    const other = leaders.get(r.department!);
    if (other) {
      throw new ConfigError(
        `Department "${r.department}" has two leader roles: "${other}" and "${r.name}".`,
      );
    }
    leaders.set(r.department!, r.name);
  }

  const playbooks = new Map<string, PlaybookConfig>();
  const broken = new Map<string, ConfigError>();
  const add = (name: string, source: string, raw: unknown, error?: ConfigError) => {
    playbooks.delete(name);
    broken.delete(name);
    try {
      if (error) throw error;
      playbooks.set(name, parsePlaybook(name, source, raw, roles));
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      broken.set(name, err);
    }
  };
  for (const [name, raw] of Object.entries(DEFAULT_PLAYBOOKS)) add(name, "built in", raw);
  for (const { name, file, raw, error } of await readJsonFiles(join(configDir, "playbooks"))) {
    add(name, file, raw, error);
  }
  return { roles, playbooks, broken, limits: await loadLimits(configDir) };
}

/** The leader role of a department. */
export function leaderRoleOf(config: Config, department: string): RoleConfig {
  return [...config.roles.values()].find((r) =>
    r.kind === "leader" && r.department === department
  )!;
}
export function overseerRole(config: Config): RoleConfig {
  return [...config.roles.values()].find((r) => r.kind === "overseer")!;
}

/**
 * The address of the worker session for a Step's first try, or for its `retry`th retry. A Step
 * that began again after QA findings (its `round`) has fresh workers for that round.
 */
export function stepWorkerAddress(
  spec: StepSpec,
  stepId: number,
  retry = 0,
  round = 0,
): string {
  const base = `${spec.worker}-${stepId}${round ? `-round-${round}` : ""}`;
  return retry ? `${base}-retry-${retry}` : base;
}
/** Whether `address` is a worker the Step has had, on any try or in any round. */
export function isStepWorker(step: { id: number; spec: StepSpec }, address: string | undefined) {
  const base = stepWorkerAddress(step.spec, step.id);
  return address === base ||
    (address?.startsWith(`${base}-retry-`) || address?.startsWith(`${base}-round-`)) === true;
}
