// Designing a feature, driven the way Kiln is used: `kiln request start|status`, the spec-approval
// and out-of-scope Gates the user passes with `kiln escalations|approve|reject`, the agents' tool
// servers (the test plays the leader and the workers), the fake remote and the fake launcher.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withWorld, type World } from "./world.ts";
import { asAgent, waitFor } from "./router_helpers.ts";

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

interface Status {
  status: string;
  failure: string | null;
  ticketUrl: string | null;
  steps: {
    name: string;
    status: string;
    retries: number;
    failure: string | null;
    assignments: { id: number; worktree: string; merged: boolean }[];
  }[];
}
const statusOf = async (world: World): Promise<Status> => {
  const r = await world.kiln("request", "status", "1", "--json");
  assertEquals(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};

interface Escalation {
  id: number;
  status: string;
  summary: string;
  detail: string | null;
  reason: string | null;
}
const escalations = async (world: World, ...flags: string[]): Promise<Escalation[]> => {
  const r = await world.kiln("escalations", "--json", ...flags);
  assertEquals(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};

/** The leader hands the open step to `worker`, who commits `files` and reports; the leader too. */
async function deliver(
  world: World,
  opts: { worker: string; stepMessage: number; files: Record<string, string> },
) {
  const job = await asAgent(
    world,
    "engineering-leader",
    (agent) => agent.send(opts.worker, "assignment", { title: "Do it", instructions: "Do it" }),
  );
  const open = (await statusOf(world)).steps.flatMap((s) => s.assignments).find((a) =>
    a.id === job.id
  )!;
  for (const [file, content] of Object.entries(opts.files)) {
    await Deno.writeTextFile(join(open.worktree, file), content);
  }
  await world.git(open.worktree, "add", ".");
  await world.git(open.worktree, "commit", "-m", "Write the artifact");
  await asAgent(world, opts.worker, async (agent) => {
    await agent.inbox();
    await agent.send("engineering-leader", "result", { status: "done", summary: "Done" }, job.id);
  });
  await asAgent(world, "engineering-leader", async (agent) => {
    await agent.inbox();
    await agent.send(
      "overseer",
      "result",
      { status: "done", summary: "Verified" },
      opts.stepMessage,
    );
  });
}

const leaderInbox = (world: World) => asAgent(world, "engineering-leader", (a) => a.inbox());

async function startDesign(world: World) {
  await register(world);
  const started = await world.kiln(
    "request",
    "start",
    "remote",
    "--playbook",
    "design-a-feature",
    "--description",
    "Let users export their data as CSV",
  );
  assertEquals(started.code, 0, started.stderr);
}

/** Run the spec writer's step; return the seam designer's step message. */
async function writeSpec(world: World) {
  const [specStep] = await leaderInbox(world);
  assertStringIncludes(String(specStep.body.instructions), "spec-writer-1");
  await deliver(world, {
    worker: "spec-writer-1",
    stepMessage: specStep.id,
    files: { "spec.md": "# Export as CSV\nUsers can download their data.\n" },
  });
  const [seamStep] = await leaderInbox(world);
  assertStringIncludes(String(seamStep.body.instructions), "seam-designer-2");
  return seamStep;
}

withWorld(
  "a design-a-feature request ends at the approved spec, with no tickets",
  async (world) => {
    await startDesign(world);
    const seamStep = await writeSpec(world);
    assertEquals((await statusOf(world)).steps.map((s) => s.status), ["done", "active"]);

    // Nothing waits for the user until the seams are verified.
    assertEquals(await escalations(world), []);
    await deliver(world, {
      worker: "seam-designer-2",
      stepMessage: seamStep.id,
      files: { "seams.md": "# Seams\nAn exporter module behind `exportCsv(userId)`.\n" },
    });

    // The Overseer brings the user the spec and seams; the request waits.
    const [gate] = await escalations(world);
    assertEquals(gate.status, "open");
    assertStringIncludes(gate.summary, "Approve the spec for request 1");
    assertStringIncludes(gate.detail!, "Users can download their data.");
    assertStringIncludes(gate.detail!, "exportCsv(userId)");
    let status = await statusOf(world);
    assertEquals([status.status, status.steps[1].status], ["active", "active"]);

    const approved = await world.kiln("approve", String(gate.id));
    assertEquals(approved.code, 0, approved.stderr);
    status = await waitFor(() => statusOf(world), (s) => s.status === "done");
    assertEquals(status.steps.map((s) => s.status), ["done", "done"]);

    // The approved spec is on the request branch, and Kiln planned and published no tickets.
    const spec = await world.exec(world.remote.path, "git", "show", "kiln/request-1:spec.md");
    assertStringIncludes(spec.stdout, "Export as CSV");
    assertEquals(status.ticketUrl, null);
    assertEquals(await world.tracker.issues(), []);
    assertEquals((await escalations(world, "--all")).map((e) => e.status), ["approved"]);
  },
);

withWorld(
  "a rejected spec goes back to the leader with the user's reason, then is approved",
  async (world) => {
    await startDesign(world);
    const seamStep = await writeSpec(world);
    await deliver(world, {
      worker: "seam-designer-2",
      stepMessage: seamStep.id,
      files: { "seams.md": "# Seams\nv1\n" },
    });
    const [first] = await escalations(world);
    const rejected = await world.kiln("reject", String(first.id), "--reason", "Cover Excel too");
    assertEquals(rejected.code, 0, rejected.stderr);

    // The step goes back to the leader, without the retry limit, carrying the reason.
    const [again] = await waitFor(() => leaderInbox(world), (m) => m.length > 0);
    assertEquals(again.from, "overseer");
    assertStringIncludes(String(again.body.instructions), "Cover Excel too");
    assertStringIncludes(String(again.body.instructions), "seam-designer-2-retry-1");
    assertEquals((await statusOf(world)).status, "active");

    await deliver(world, {
      worker: "seam-designer-2-retry-1",
      stepMessage: again.id,
      files: { "seams.md": "# Seams\nv2 with Excel\n" },
    });
    const all = await escalations(world, "--all");
    assertEquals(all.map((e) => e.status), ["rejected", "open"]);
    assertStringIncludes(all[1].detail!, "v2 with Excel");
    await world.kiln("approve", String(all[1].id));
    const done = await waitFor(() => statusOf(world), (s) => s.status === "done");
    assertEquals(done.steps[1].retries, 1);
  },
);

withWorld("an out-of-scope report is a Gate the user can decline", async (world) => {
  await startDesign(world);
  const [specStep] = await leaderInbox(world);
  await asAgent(
    world,
    "engineering-leader",
    (agent) =>
      agent.send("overseer", "result", {
        status: "out-of-scope",
        summary: "This is a billing feature; this project has no billing.",
      }, specStep.id),
  );
  const [gate] = await waitFor(() => escalations(world), (e) => e.length > 0);
  assertStringIncludes(gate.summary, "out of scope");
  assertStringIncludes(gate.detail!, "no billing");
  assertEquals((await statusOf(world)).status, "active");

  const declined = await world.kiln("reject", String(gate.id), "--reason", "Not for this project");
  assertEquals(declined.code, 0, declined.stderr);
  const status = await waitFor(() => statusOf(world), (s) => s.status === "failed");
  assertStringIncludes(status.failure!, "Not for this project");
  assertEquals(status.steps.map((s) => s.status), ["failed", "planned"]);
});

withWorld("an out-of-scope request the user approves carries on", async (world) => {
  await startDesign(world);
  const [specStep] = await leaderInbox(world);
  await asAgent(
    world,
    "engineering-leader",
    (agent) =>
      agent.send(
        "overseer",
        "result",
        { status: "out-of-scope", summary: "Not our area" },
        specStep.id,
      ),
  );
  const [gate] = await waitFor(() => escalations(world), (e) => e.length > 0);
  await world.kiln("approve", String(gate.id));
  const [again] = await waitFor(() => leaderInbox(world), (m) => m.length > 0);
  assertStringIncludes(String(again.body.instructions), "approved");
  await deliver(world, {
    worker: "spec-writer-1-retry-1",
    stepMessage: again.id,
    files: { "spec.md": "# Spec\nok\n" },
  });
  const [seamStep] = await leaderInbox(world);
  assertStringIncludes(String(seamStep.body.instructions), "design-seams");
  assert((await statusOf(world)).steps[0].status === "done");
});
