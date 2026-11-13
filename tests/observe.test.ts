// Looking at a Request: `kiln request list`, `watch`, `transcript` and `report`, driven the way
// they are used: the CLI, the agents' tool servers (the test plays the leader), the fake remote
// and the fake launcher.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { withWorld, type World } from "./world.ts";
import { asAgent } from "./router_helpers.ts";

const MAIN = fromFileUrl(new URL("../src/main.ts", import.meta.url));

async function register(world: World) {
  await Deno.writeTextFile(join(world.project.path, "AGENTS.md"), "# How to work here\n");
  await world.git(world.project.path, "add", ".");
  await world.git(world.project.path, "commit", "-m", "Add agent docs");
  await world.git(world.project.path, "push", "origin", "main");
  await world.githubApi.script([{ stdout: "{}\n" }]);
  await world.launcher.script([{
    result: JSON.stringify({ setup: null, test: null, lint: null, build: null }),
  }]);
  const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(r.code, 0, r.stderr);
}

async function waitFor<T>(read: () => Promise<T>, ready: (v: T) => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for public evidence");
}

/** A Request whose leader has delegated to a worker, which has been woken and has reported. */
async function workedRequest(world: World) {
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
  await world.launcher.script([{
    result: "Found it: the session expires at midnight",
    costUsd: 0.3,
  }]);
  await asAgent(world, "engineering-leader", (a) =>
    a.send("diagnostician-1", "assignment", {
      title: "Find the cause",
      instructions: "Look at the session code",
    }));
  await waitFor(() => world.launcher.prompts(), (p) => p.some((x) => x.includes("diagnostician")));
  await waitFor(
    async () => (await world.kiln("request", "status", "1", "--json")).stdout,
    (out) => JSON.parse(out).costUsd > 0,
  );
}

withWorld("kiln watch follows a request live until it ends", async (w) => {
  await workedRequest(w);

  const watching = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, "watch", "1"],
    env: w.env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let stdout = "";
  const reading = (async () => {
    for await (const chunk of watching.stdout) stdout += new TextDecoder().decode(chunk);
  })();
  await waitFor(() => Promise.resolve(stdout), (text) => text.includes("The request started"));
  const cancelled = await w.kiln("request", "cancel", "1");
  assertEquals(cancelled.code, 0, cancelled.stderr);

  await reading;
  const code = (await watching.status).code;
  const stderr = await new Response(watching.stderr).text();
  assertEquals(code, 1, stderr);
  for (
    const text of ["The request started", "engineering-leader", "was cancelled", "Request 1 failed"]
  ) {
    assertStringIncludes(stdout, text);
  }

  // Watching a request that has already ended replays its life and returns at once.
  const again = await w.kiln("watch", "1");
  assertEquals(again.code, 1);
  assertStringIncludes(again.stdout, "The request started");
});

withWorld("kiln transcript shows what the agents said to each other, in order", async (w) => {
  await workedRequest(w);

  const r = await w.kiln("transcript", "1");
  assertEquals(r.code, 0, r.stderr);
  const text = r.stdout;
  for (
    const part of [
      "overseer -> engineering-leader",
      "engineering-leader -> diagnostician-1",
      "Look at the session code",
    ]
  ) assertStringIncludes(text, part);
  assert(text.indexOf("overseer -> engineering-leader") < text.indexOf("-> diagnostician-1"));

  const messages = JSON.parse((await w.kiln("transcript", "1", "--json")).stdout);
  assertEquals(messages[0].from, "overseer");
  assertEquals(
    messages.map((m: { id: number }) => m.id),
    messages.map((m: { id: number }) => m.id).toSorted((a: number, b: number) => a - b),
  );

  const missing = await w.kiln("transcript", "99");
  assertEquals(missing.code, 1);
  assertStringIncludes(missing.stderr, "No request 99 exists");
});

withWorld("kiln report says how a request went", async (w) => {
  await workedRequest(w);
  await w.kiln("request", "cancel", "1");

  const r = await w.kiln("report", "1");
  assertEquals(r.code, 0, r.stderr);
  for (
    const part of [
      "request 1 (remote): failed",
      "Logins fail after midnight",
      "$0.30",
      "Steps:",
      "Cancelled by the user",
    ]
  ) assertStringIncludes(r.stdout, part);

  const report = JSON.parse((await w.kiln("report", "1", "--json")).stdout);
  assertEquals([report.status, report.costUsd, report.project], ["failed", 0.3, "remote"]);
  assert(report.startedAt && report.endedAt);
});

withWorld("kiln request list shows running requests, and finished ones with --all", async (w) => {
  await register(w);
  assertStringIncludes((await w.kiln("request", "list")).stdout, "No requests are running.");
  await w.kiln(
    "request",
    "start",
    "remote",
    "--playbook",
    "diagnose-a-bug",
    "--description",
    "Slow page",
  );

  const running = await w.kiln("request", "list");
  assertStringIncludes(running.stdout, "Request 1  remote  active  diagnose-a-bug");
  assertStringIncludes(running.stdout, "Slow page");

  await w.kiln("request", "cancel", "1");
  assertStringIncludes((await w.kiln("request", "list")).stdout, "No requests are running.");
  const all = JSON.parse((await w.kiln("request", "list", "--all", "--json")).stdout);
  assertEquals(all.map((r: { id: number; status: string }) => [r.id, r.status]), [[1, "failed"]]);
});

withWorld("the observing commands refuse what they cannot make sense of", async (w) => {
  for (
    const args of [["watch"], ["watch", "x"], ["watch", "1", "--json"], ["report", "1", "--x"], [
      "transcript",
    ]]
  ) {
    const r = await w.kiln(...args);
    assertEquals(r.code, 2, args.join(" "));
    assertStringIncludes(r.stderr, "Usage: kiln");
  }
  const none = await w.kiln("watch", "7");
  assertEquals(none.code, 1);
  assertStringIncludes(none.stderr, "No request 7 exists");
});
