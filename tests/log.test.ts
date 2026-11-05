// The daemon log is only reachable through a running daemon for a few events, so the
// redaction and rotation rules are tested at the logger's own interface.
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { createLogger } from "../src/log.ts";

function lines(file: string): Record<string, unknown>[] {
  return Deno.readTextFileSync(file).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

Deno.test("log lines are JSON objects with level, time and message", async () => {
  const dir = await Deno.makeTempDir();
  const file = join(dir, "daemon.log");
  const log = createLogger({ file });
  log.info("hello", { project: "kiln" });
  log.error("boom", { err: new Error("bad") });
  const [a, b] = lines(file);
  assertEquals([a.level, a.msg, a.project], ["info", "hello", "kiln"]);
  assert(!Number.isNaN(Date.parse(a.ts as string)));
  assertEquals(b.level, "error");
  assertEquals((b.err as { message: string }).message, "bad");
});

Deno.test("secrets never reach the log", async () => {
  const dir = await Deno.makeTempDir();
  const file = join(dir, "daemon.log");
  const log = createLogger({ file });
  log.info("run", {
    token: "plain-token-value",
    nested: { apiKey: "k-123456", Authorization: "Bearer abc.def.ghi" },
    cmd: "git clone https://user:hunter2@example.com/r.git",
    out: "key sk-ant-api03-AAAAAAAAAAAAAAAA and ghp_abcdefghijklmnopqrstuvwxyz0123456789 end",
    list: [{ password: "p4ss" }],
  });
  const text = Deno.readTextFileSync(file);
  for (
    const s of [
      "plain-token-value",
      "k-123456",
      "abc.def.ghi",
      "hunter2",
      "sk-ant-api03",
      "ghp_abc",
      "p4ss",
    ]
  ) {
    assertFalse(text.includes(s), `leaked ${s}`);
  }
  assert(text.includes("[REDACTED]"));
  assert(text.includes("example.com"), "non-secret parts survive");
});

Deno.test("the log rotates by size and keeps a bounded number of files", async () => {
  const dir = await Deno.makeTempDir();
  const file = join(dir, "daemon.log");
  const log = createLogger({ file, maxBytes: 500, keep: 2 });
  for (let i = 0; i < 40; i++) log.info(`entry ${i} ${"x".repeat(40)}`);
  const names = [...Deno.readDirSync(dir)].map((e) => e.name).sort();
  assertEquals(names, ["daemon.log", "daemon.log.1", "daemon.log.2"]);
  assert(Deno.statSync(file).size <= 500 + 200, "active file stays near the limit");
  const last = lines(file).at(-1)!;
  assertEquals(last.msg, `entry 39 ${"x".repeat(40)}`, "newest entry is in the active file");
});

Deno.test("the log rotates by age and drops rotated files past the retention period", async () => {
  const dir = await Deno.makeTempDir();
  const file = join(dir, "daemon.log");
  const day = 86_400_000;
  let now = Date.parse("2026-01-01T00:00:00Z");
  const opts = { file, maxAgeMs: day, retainMs: 3 * day, now: () => now };
  createLogger(opts).info("day 0");
  now += 2 * day;
  createLogger(opts).info("day 2");
  assertEquals(lines(file).map((l) => l.msg), ["day 2"]);
  assertEquals(lines(file + ".1").map((l) => l.msg), ["day 0"]);

  now += 2 * day; // day 4: the day-0 file is 4 days old, past retention
  createLogger(opts).info("day 4");
  assertEquals(lines(file).map((l) => l.msg), ["day 4"]);
  assertEquals(lines(file + ".1").map((l) => l.msg), ["day 2"]);
  assertFalse(await Deno.stat(file + ".2").then(() => true, () => false), "oldest was dropped");
});
