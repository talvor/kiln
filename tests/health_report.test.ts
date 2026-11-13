// `health.report`: Halt since, the daily cap, stuck agents, open faults and paused Projects,
// read from the real daemon over its socket. It changes nothing, and `status` is untouched.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { rawCall } from "./helpers.ts";
import { withWorld, type World } from "./world.ts";
import { asAgent, openTeam, waitFor } from "./router_helpers.ts";
import type { LauncherRun } from "./fakes/claude.ts";

const COMMANDS = { setup: null, test: null, lint: null, build: null };

async function register(world: World) {
  await Deno.writeTextFile(join(world.project.path, "AGENTS.md"), "# How to work here\n");
  await world.git(world.project.path, "add", ".");
  await world.git(world.project.path, "commit", "-m", "Add agent docs");
  await world.git(world.project.path, "push", "origin", "main");
  await world.githubApi.script([{ stdout: "{}\n" }]);
  await world.launcher.script([{ result: JSON.stringify(COMMANDS) }]);
  const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(r.code, 0, r.stderr);
  await openTeam(world);
}

interface Health {
  haltedSince: string | null;
  dailyCap: { capUsd: number | null; todayUsd: number; reached: boolean; since: string | null };
  stuck: { address: string; since: string; requestId: number | null }[];
  faults: { project: string; kind: string; detail: string; since: string }[];
  paused: string[];
}
async function health(world: World): Promise<Health> {
  const r = await rawCall(world, "health.report");
  assert(r.ok, r.error);
  return r.result as Health;
}
const lastEvent = async (world: World) => {
  const r = await rawCall(world, "events.since", { after: 0, waitMs: 0 });
  return (r.result as { last: number }).last;
};

/** A Request whose leader has delegated one Assignment; the worker's launches are `runs`. */
async function delegated(world: World, limits: unknown, runs: LauncherRun[]) {
  await Deno.mkdir(world.dirs.config, { recursive: true });
  await Deno.writeTextFile(join(world.dirs.config, "limits.json"), JSON.stringify(limits));
  await register(world);
  await world.launcher.script([{ result: "ready" }]);
  const started = await world.kiln(
    "request",
    "start",
    "remote",
    "--playbook",
    "diagnose-a-bug",
    "--description",
    "Logins fail after midnight",
  );
  assertEquals(started.code, 0, started.stderr);
  await waitFor(
    () => world.launcher.prompts(),
    (prompts) => prompts.some((prompt) => prompt.includes("You are the engineering leader")),
  );
  await asAgent(world, "engineering-leader", (a) => a.inbox());
  await world.launcher.script(runs);
  await asAgent(
    world,
    "engineering-leader",
    (a) =>
      a.send("diagnostician-1", "assignment", {
        title: "Diagnose",
        instructions: "Find the cause",
      }),
  );
}

withWorld("health.report is empty when all is well, and status is unchanged", async (w) => {
  assertEquals((await w.kiln("daemon", "start")).code, 0);
  assertEquals(await health(w), {
    haltedSince: null,
    dailyCap: { capUsd: null, todayUsd: 0, reached: false, since: null },
    stuck: [],
    faults: [],
    paused: [],
  });
  const status = (await rawCall(w, "status")).result as Record<string, unknown>;
  assertEquals(Object.keys(status).sort(), [
    "haltedSince",
    "paths",
    "pid",
    "startedAt",
    "startup",
    "store",
    "version",
  ]);
});

withWorld(
  "health.report lists Halt, a stuck agent with its Request, and paused Projects",
  async (w) => {
    await delegated(w, { infrastructure: { retries: 1, backoffSeconds: 1 } }, [{ crash: true }, {
      crash: true,
    }]);
    const stuck = await waitFor(() => health(w), (h) => h.stuck.length > 0);
    assertEquals(stuck.stuck.map((s) => [s.address, s.requestId]), [["diagnostician-1", 1]]);
    assert(!Number.isNaN(Date.parse(stuck.stuck[0].since)));

    assertEquals((await w.kiln("project", "pause", "remote")).code, 0);
    assertEquals((await w.kiln("halt")).code, 0);
    const report = await health(w);
    assertEquals(report.paused, ["remote"]);
    assert(report.haltedSince !== null);
    assertEquals(report.haltedSince, ((await rawCall(w, "status")).result as Health).haltedSince);
    assertEquals(report.stuck.length, 1);

    // Reading it twice changes nothing: not the event log, not the report.
    const last = await lastEvent(w);
    assertEquals(await health(w), report);
    assertEquals(await lastEvent(w), last);

    assertEquals((await w.kiln("resume")).code, 0);
    assertEquals((await health(w)).stuck, []);
    assertEquals((await health(w)).haltedSince, null);
  },
);

withWorld("health.report shows the daily cap once it holds", async (w) => {
  await delegated(w, {
    defaults: { spendUsd: 10 },
    concurrency: { perProject: 5 },
    budgets: { dailyUsd: 1 },
  }, [{ result: "ok", costUsd: 1.2 }]);
  const capped = await waitFor(
    () => health(w),
    (h) => h.dailyCap.reached && h.dailyCap.since !== null,
  );
  assertEquals([capped.dailyCap.capUsd, capped.dailyCap.todayUsd], [1, 1.2]);
  assert(capped.dailyCap.since !== null);
});

withWorld("health.report lists an open fault and the Project it paused", async (w) => {
  await register(w);
  assertEquals((await w.kiln("request", "start", "remote")).code, 0);
  await Deno.rename(w.remote.path, `${w.remote.path}.away`);
  await Deno.remove(join(w.dirs.data, "projects", "remote"), { recursive: true });
  const report = await waitFor(() => health(w), (h) => h.faults.length > 0, 20_000);
  assertEquals(report.faults.map((f) => [f.project, f.kind]), [["remote", "clone"]]);
  assert(report.faults[0].detail.length > 0);
  assert(!Number.isNaN(Date.parse(report.faults[0].since)));
  assertEquals(report.paused, ["remote"]);
});
