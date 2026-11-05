import { dirname } from "jsr:@std/path@1";

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

export interface LoggerOptions {
  file: string;
  /** Rotate when the active file would exceed this many bytes. */
  maxBytes?: number;
  /** Rotate when the active file's first entry is older than this. */
  maxAgeMs?: number;
  /** Delete rotated files whose newest entry is older than this. */
  retainMs?: number;
  /** Number of rotated files to keep. */
  keep?: number;
  now?: () => number;
}

const DAY = 86_400_000;
// Matches the end of a key, so `accessToken` is redacted but `maxTokens` is not.
const SECRET_KEY =
  /(token|(secret|password|passwd|credential|cookie)s?|authorization|api[-_]?key)$/i;
const SECRET_VALUES: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]"],
  [/\bglpat-[A-Za-z0-9_-]{10,}/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
  [/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, "Bearer [REDACTED]"],
  [/(\w+:\/\/)[^\s\/@:]+:[^\s\/@]+@/g, "$1[REDACTED]@"],
];

/** Return a copy of `value` that is safe to write to a log or message. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return SECRET_VALUES.reduce((s, [re, to]) => s.replace(re, to), value);
  }
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    return redact({ name: value.name, message: value.message, stack: value.stack }, depth + 1);
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? "[REDACTED]" : redact(v, depth + 1);
  }
  return out;
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Timestamp of the first (or last) entry in a log file, or undefined if it has none. */
function entryTime(file: string, which: "first" | "last"): number | undefined {
  try {
    const lines = Deno.readTextFileSync(file).split("\n").filter(Boolean);
    const line = which === "first" ? lines[0] : lines[lines.length - 1];
    const t = Date.parse(JSON.parse(line).ts);
    return Number.isNaN(t) ? undefined : t;
  } catch {
    return undefined;
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const maxAgeMs = opts.maxAgeMs ?? DAY;
  const retainMs = opts.retainMs ?? 14 * DAY;
  const keep = opts.keep ?? 5;
  const now = opts.now ?? Date.now;
  const { file } = opts;
  Deno.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

  const rotated = (n: number) => `${file}.${n}`;

  function rotate(): void {
    if (exists(rotated(keep))) Deno.removeSync(rotated(keep));
    for (let n = keep - 1; n >= 1; n--) {
      if (exists(rotated(n))) Deno.renameSync(rotated(n), rotated(n + 1));
    }
    if (keep >= 1 && exists(file)) Deno.renameSync(file, rotated(1));
    else if (exists(file)) Deno.removeSync(file);
  }

  function prune(): void {
    for (let n = 1; n <= keep; n++) {
      const f = rotated(n);
      if (!exists(f)) continue;
      const newest = entryTime(f, "last");
      if (newest !== undefined && now() - newest > retainMs) Deno.removeSync(f);
    }
    // Close gaps left by pruning so numbering stays contiguous.
    for (let n = 1; n < keep; n++) {
      if (!exists(rotated(n)) && exists(rotated(n + 1))) {
        Deno.renameSync(rotated(n + 1), rotated(n));
      }
    }
  }

  let activeSince: number | undefined = entryTime(file, "first");

  function write(level: Level, msg: string, fields: Fields = {}): void {
    const t = now();
    const entry = redact({ ...fields, ts: new Date(t).toISOString(), level, msg });
    const line = JSON.stringify(entry) + "\n";
    const size = exists(file) ? Deno.statSync(file).size : 0;
    const tooBig = size > 0 && size + line.length > maxBytes;
    const tooOld = size > 0 && activeSince !== undefined && t - activeSince > maxAgeMs;
    if (tooBig || tooOld) {
      rotate();
      activeSince = undefined;
    }
    prune();
    activeSince ??= t;
    Deno.writeTextFileSync(file, line, { append: true, create: true, mode: 0o600 });
  }

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}

/** The message of the most recent error entry, for showing why a daemon failed to start. */
export function lastError(file: string): string | undefined {
  try {
    const lines = Deno.readTextFileSync(file).split("\n").filter(Boolean).reverse();
    for (const l of lines) {
      const e = JSON.parse(l);
      if (e.level === "error") return e.msg;
    }
  } catch { /* no log yet */ }
  return undefined;
}
