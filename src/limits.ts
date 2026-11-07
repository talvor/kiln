// Limits and concurrency caps, which Kiln reads from `<config>/limits.json`:
//   {
//     "defaults":    { "turns": 50, "spendUsd": 1, "seconds": 1800, "idleSeconds": 600 },
//     "concurrency": { "global": 4, "perProject": 2 },
//     "projects":    { "<name>": { "ceiling": { "turns": 80, "spendUsd": 2, "seconds": 3600 },
//                                  "maxActive": 3 } }
//   }
// Every field is optional. Every Assignment runs under a Budget: the defaults, or what its
// leader asked for, never above the Project's ceiling. Pure rules: no storage, no I/O.
import { join } from "@std/path";
import { ConfigError } from "./config_error.ts";

/** What one Assignment may use before Kiln stops its worker. */
export interface Budget {
  /** Agent turns, summed over every launch of the worker for this Assignment. */
  turns: number;
  /** Spend in USD, summed over the same launches. */
  spendUsd: number;
  /** Wall-clock time from the Assignment starting. */
  seconds: number;
  /** How long the worker may show no sign of life (no launch activity, no message). */
  idleSeconds: number;
}
/** The parts of a Budget a Project can cap. Inactivity is a watch, not a spend. */
export type Ceiling = Partial<Pick<Budget, "turns" | "spendUsd" | "seconds">>;

export interface LimitsConfig {
  defaults: Budget;
  /** Assignments active at once in all of Kiln. */
  global: number;
  /** Assignments active at once in one Project, unless the Project says otherwise. */
  perProject: number;
  projects: Map<string, { ceiling: Ceiling; maxActive?: number }>;
}

export const DEFAULT_LIMITS: LimitsConfig = {
  defaults: { turns: 50, spendUsd: 1, seconds: 30 * 60, idleSeconds: 10 * 60 },
  global: 4,
  perProject: 2,
  projects: new Map(),
};

/** The Budget fields a leader may ask for in an assignment, by the field's name there. */
export const REQUESTABLE = {
  maxTurns: "turns",
  maxSpendUsd: "spendUsd",
  maxSeconds: "seconds",
} as const satisfies Record<string, keyof Budget>;

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Read `limits.json` from the config directory; the defaults when there is none. */
export async function loadLimits(configDir: string): Promise<LimitsConfig> {
  const file = join(configDir, "limits.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await Deno.readTextFile(file));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return DEFAULT_LIMITS;
    throw new ConfigError(`${file}: not valid JSON (${(err as Error).message})`);
  }
  return parseLimits(file, raw);
}

function parseLimits(file: string, raw: unknown): LimitsConfig {
  const fail = (why: string) => new ConfigError(`Limits (${file}): ${why}`);
  if (!isObject(raw)) throw fail("must be a JSON object");
  const number = (at: string, v: unknown, whole = false): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || (whole && !Number.isInteger(v))) {
      throw fail(`${at} must be a positive ${whole ? "whole " : ""}number`);
    }
    return v;
  };
  const only = (at: string, v: unknown, allowed: string[]): Obj => {
    if (!isObject(v)) throw fail(`${at} must be an object`);
    for (const key of Object.keys(v)) {
      if (!allowed.includes(key)) throw fail(`${at} has an unknown field "${key}"`);
    }
    return v;
  };
  only("the file", raw, ["defaults", "concurrency", "projects"]);

  const limits: LimitsConfig = { ...DEFAULT_LIMITS, defaults: { ...DEFAULT_LIMITS.defaults } };
  if (raw.defaults !== undefined) {
    const d = only('"defaults"', raw.defaults, ["turns", "spendUsd", "seconds", "idleSeconds"]);
    for (const key of Object.keys(d) as (keyof Budget)[]) {
      limits.defaults[key] = number(`"defaults.${key}"`, d[key], key === "turns");
    }
  }
  if (raw.concurrency !== undefined) {
    const c = only('"concurrency"', raw.concurrency, ["global", "perProject"]);
    if (c.global !== undefined) limits.global = number('"concurrency.global"', c.global, true);
    if (c.perProject !== undefined) {
      limits.perProject = number('"concurrency.perProject"', c.perProject, true);
    }
  }
  if (raw.projects !== undefined) {
    limits.projects = new Map();
    if (!isObject(raw.projects)) throw fail('"projects" must be an object');
    for (const [name, value] of Object.entries(raw.projects)) {
      const p = only(`"projects.${name}"`, value, ["ceiling", "maxActive"]);
      const ceiling: Ceiling = {};
      if (p.ceiling !== undefined) {
        const c = only(`"projects.${name}.ceiling"`, p.ceiling, ["turns", "spendUsd", "seconds"]);
        for (const key of Object.keys(c) as (keyof Ceiling)[]) {
          ceiling[key] = number(`"projects.${name}.ceiling.${key}"`, c[key], key === "turns");
        }
      }
      limits.projects.set(name, {
        ceiling,
        maxActive: p.maxActive === undefined
          ? undefined
          : number(`"projects.${name}.maxActive"`, p.maxActive, true),
      });
    }
  }
  return limits;
}

/** The Budget an Assignment runs under, and the fields the Project's ceiling cut down. */
export function budgetFor(
  limits: LimitsConfig,
  project: string,
  requested: Partial<Budget>,
): { budget: Budget; capped: (keyof Ceiling)[] } {
  const budget: Budget = { ...limits.defaults, ...requested };
  const ceiling = limits.projects.get(project)?.ceiling ?? {};
  const capped: (keyof Ceiling)[] = [];
  for (const key of Object.keys(ceiling) as (keyof Ceiling)[]) {
    if (budget[key] > ceiling[key]!) {
      budget[key] = ceiling[key]!;
      capped.push(key);
    }
  }
  return { budget, capped };
}

/** How many Assignments may be active in the Project at once. */
export const projectCap = (limits: LimitsConfig, project: string): number =>
  limits.projects.get(project)?.maxActive ?? limits.perProject;

/** Which paths two ownership declarations both claim: a path owns everything beneath it. */
export function overlaps(a: string[], b: string[]): boolean {
  const norm = (p: string) => p.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  return a.some((x) =>
    b.some((y) => {
      const [p, q] = [norm(x), norm(y)];
      return p === q || p === "" || q === "" || q.startsWith(`${p}/`) || p.startsWith(`${q}/`);
    })
  );
}

/** The paths an assignment's `owns` field declares: comma or newline separated. */
export function parseOwns(owns: unknown): string[] {
  return typeof owns === "string" ? owns.split(/[,\n]/).map((p) => p.trim()).filter(Boolean) : [];
}
