// Implementing a ticket, driven the way Kiln is used: `kiln request start|status`, the Gates the
// user passes with `kiln escalations|approve|reject`, the agents' tool servers (the test plays the
// leader and the workers), the fake remote and the fake launcher and `gh`.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
import { rawCall } from "./helpers.ts";
import { withWorld, type World } from "./world.ts";
import { asAgent, waitFor } from "./router_helpers.ts";

const PR_URL = "https://github.com/acme/app/pull/7";

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
  await world.pullRequests.script([{ stdout: `${PR_URL}\n` }]);
}

interface Status {
  status: string;
  failure: string | null;
  prUrl: string | null;
  steps: {
    name: string;
    status: string;
    retries: number;
    assignments: { id: number; worker: string; worktree: string; merged: boolean }[];
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
}
const escalations = async (world: World, ...flags: string[]): Promise<Escalation[]> => {
  const r = await world.kiln("escalations", "--json", ...flags);
  assertEquals(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};

const leaderInbox = (world: World) => asAgent(world, "engineering-leader", (a) => a.inbox());
const nextForLeader = async (world: World) =>
  (await waitFor(() => leaderInbox(world), (m) => m.length > 0))[0];

/**
 * The leader hands the open step to `worker`, who commits `files` and reports done; the leader
 * then reports on the step to the overseer with `status` (done unless QA found something).
 */
async function deliver(
  world: World,
  opts: {
    worker: string;
    stepMessage: number;
    files: Record<string, string>;
    status?: string;
    summary?: string;
  },
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
  await world.git(open.worktree, "commit", "-m", "Do the work");
  await asAgent(world, opts.worker, async (agent) => {
    await agent.inbox();
    await agent.send("engineering-leader", "result", { status: "done", summary: "Done" }, job.id);
  });
  await asAgent(world, "engineering-leader", async (agent) => {
    await agent.inbox();
    await agent.send("overseer", "result", {
      status: opts.status ?? "done",
      summary: opts.summary ?? "Verified",
    }, opts.stepMessage);
  });
}

async function startTicket(world: World) {
  await register(world);
  const started = await world.kiln(
    "request",
    "start",
    "remote",
    "--playbook",
    "implement-a-ticket",
    "--description",
    "Implement the CSV export ticket",
    "--tracker-item",
    "#18",
  );
  assertEquals(started.code, 0, started.stderr);
}

const READY = { "readiness.md": "# Ready\nThe ticket is clear.\n" };
const PR_FILES = {
  "feature.txt": "export v1\n",
  "pull-request.md": "# Export data as CSV\nAdds `exportCsv`.\n",
};

/** Run the ticket check; return the implementer's step message. */
async function passReadiness(world: World) {
  const check = await nextForLeader(world);
  assertStringIncludes(String(check.body.instructions), "ticket-checker-1");
  await deliver(world, { worker: "ticket-checker-1", stepMessage: check.id, files: READY });
  const implement = await nextForLeader(world);
  assertStringIncludes(String(implement.body.instructions), "implementer-2");
  return implement;
}

/** Run the implementer's step; return the reviewer's step message. */
async function implement(world: World) {
  const step = await passReadiness(world);
  await deliver(world, { worker: "implementer-2", stepMessage: step.id, files: PR_FILES });
  const review = await nextForLeader(world);
  assertStringIncludes(String(review.body.instructions), "reviewer-3");
  return review;
}

const show = (world: World, file: string) =>
  world.exec(world.remote.path, "git", "show", `kiln/request-1:${file}`);

const OPEN = { state: "OPEN", checks: "SUCCESS" } as const;
const MERGED = { state: "MERGED", checks: "SUCCESS" } as const;
const CLOSED = { state: "CLOSED", checks: "SUCCESS" } as const;
const SHIPPED = "Shipped the CSV export in pull request 7.\n";

/** The wrap-up step: the leader hands it to the closer, who writes up what shipped. */
async function wrapUp(world: World) {
  const wrap = await nextForLeader(world);
  assertStringIncludes(String(wrap.body.instructions), "closer-5");
  await deliver(world, {
    worker: "closer-5",
    stepMessage: wrap.id,
    files: { "wrap-up.md": SHIPPED },
  });
}

/** Run the QA steps; return the Gate the Overseer raised for the user. */
async function passQa(world: World): Promise<Escalation> {
  const review = await implement(world);
  await deliver(world, {
    worker: "reviewer-3",
    stepMessage: review.id,
    files: { "review.md": "No defects found.\n" },
  });
  const gatekeep = await nextForLeader(world);
  await deliver(world, {
    worker: "gatekeeper-4",
    stepMessage: gatekeep.id,
    files: { "gatekeeper.md": "All acceptance criteria met.\n" },
  });
  return (await waitFor(() => escalations(world), (e) => e.length > 0))[0];
}

/** Kiln's own clone of the Project, found through the request's worktree (while it exists). */
async function kilnClone(world: World) {
  const assignment = (await statusOf(world)).steps[0].assignments[0];
  const requestWorktree = join(dirname(assignment.worktree), "request-1");
  const common = await world.git(
    requestWorktree,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  return { requestWorktree, gitDir: common.stdout.trim() };
}
const branchesOf = async (world: World, gitDir: string) =>
  (await world.git(world.root, "--git-dir", gitDir, "branch", "--format=%(refname:short)"))
    .stdout.split("\n").filter(Boolean);

withWorld(
  "a ticket goes through readiness, a draft PR, review and the gatekeeper, and only then the user hears",
  async (world) => {
    await startTicket(world);
    const review = await implement(world);

    // The implementer's work is on the request branch, and Kiln opened a draft PR for it.
    assertEquals(await world.pullRequests.created(), [{
      title: "Export data as CSV",
      body: "Adds `exportCsv`.\n\nCloses #18",
      head: "kiln/request-1",
      base: "main",
      draft: true,
    }]);
    assertStringIncludes((await show(world, "feature.txt")).stdout, "export v1");
    assertEquals((await statusOf(world)).prUrl, PR_URL);

    // The user has heard nothing, and nothing has been said on the PR, until QA passes.
    assertEquals(await escalations(world), []);
    await deliver(world, {
      worker: "reviewer-3",
      stepMessage: review.id,
      files: { "review.md": "No defects found.\n" },
    });
    const gatekeep = await nextForLeader(world);
    assertStringIncludes(String(gatekeep.body.instructions), "gatekeeper-4");
    assertEquals(await escalations(world), []);
    assertEquals(await world.pullRequests.comments(), []);

    await deliver(world, {
      worker: "gatekeeper-4",
      stepMessage: gatekeep.id,
      files: { "gatekeeper.md": "All acceptance criteria met.\n" },
    });

    // QA passed: Kiln comments the QA summary on the PR and the Overseer tells the user.
    const comments = await world.pullRequests.comments();
    assertEquals(comments.length, 1);
    assertEquals(comments[0].pr, PR_URL);
    assertStringIncludes(comments[0].body, "QA summary");
    assertStringIncludes(comments[0].body, "No defects found.");
    assertStringIncludes(comments[0].body, "All acceptance criteria met.");
    const [told] = await escalations(world);
    assertStringIncludes(told.summary, "passed QA");
    assertStringIncludes(told.summary, PR_URL);
    assertStringIncludes(told.detail!, "No defects found.");
    assertEquals((await statusOf(world)).status, "active");

    // Kiln never merges. The user merges the pull request, and that is the go-ahead.
    await world.prStatus.script([OPEN, MERGED]);
    await wrapUp(world);
    const done = await waitFor(() => statusOf(world), (s) => s.status === "done");
    assertEquals(done.steps.map((s) => s.status), ["done", "done", "done", "done", "done"]);
    assertEquals((await world.pullRequests.created()).length, 1);
    assertEquals(await world.tracker.closed(), [{ item: "#18", comment: SHIPPED.trim() }]);
    // The Gate was never decided by anyone, and is now moot.
    assertEquals(await escalations(world), []);
  },
);

withWorld("a ticket that is not ready blocks the request on the user", async (world) => {
  await startTicket(world);
  const check = await nextForLeader(world);
  await asAgent(
    world,
    "engineering-leader",
    (agent) =>
      agent.send("overseer", "result", {
        status: "unready",
        summary: "The ticket does not say which columns to export.",
      }, check.id),
  );
  const [blocked] = await waitFor(() => escalations(world), (e) => e.length > 0);
  assertStringIncludes(blocked.summary, "blocked on you");
  assertStringIncludes(blocked.detail!, "which columns");
  assertEquals((await statusOf(world)).status, "active");
  assertEquals(await world.pullRequests.created(), []);

  const declined = await world.kiln("reject", String(blocked.id), "--reason", "Drop this ticket");
  assertEquals(declined.code, 0, declined.stderr);
  const status = await waitFor(() => statusOf(world), (s) => s.status === "failed");
  assertStringIncludes(status.failure!, "Drop this ticket");
  assertEquals(status.steps.map((s) => s.status), [
    "failed",
    "planned",
    "planned",
    "planned",
    "planned",
  ]);
  assertEquals(await world.pullRequests.created(), []);
});

withWorld("a ticket the user unblocks is checked again and carries on", async (world) => {
  await startTicket(world);
  const check = await nextForLeader(world);
  await asAgent(
    world,
    "engineering-leader",
    (agent) =>
      agent.send(
        "overseer",
        "result",
        { status: "unready", summary: "No acceptance criteria" },
        check.id,
      ),
  );
  const [blocked] = await waitFor(() => escalations(world), (e) => e.length > 0);
  assertEquals((await world.kiln("approve", String(blocked.id))).code, 0);

  const again = await nextForLeader(world);
  assertStringIncludes(String(again.body.instructions), "ticket is ready now");
  assertStringIncludes(String(again.body.instructions), "ticket-checker-1-retry-1");
  await deliver(world, { worker: "ticket-checker-1-retry-1", stepMessage: again.id, files: READY });
  const step = await nextForLeader(world);
  assertStringIncludes(String(step.body.instructions), "implementer-2");
  assertEquals((await statusOf(world)).steps[0].retries, 0);
});

withWorld("review findings return as a new assignment that updates the same PR", async (world) => {
  await startTicket(world);
  const review = await implement(world);
  await deliver(world, {
    worker: "reviewer-3",
    stepMessage: review.id,
    files: { "review.md": "Export ignores quoting.\n" },
    status: "findings",
    summary: "Fields containing commas are not quoted.",
  });

  // The findings go to the leader as a new assignment for a fresh implementer; the user is not told.
  const fix = await nextForLeader(world);
  assertEquals(fix.from, "overseer");
  assertStringIncludes(String(fix.body.instructions), "Fields containing commas are not quoted.");
  assertStringIncludes(String(fix.body.instructions), "implementer-2-retry-1");
  assertEquals(await escalations(world), []);
  let status = await statusOf(world);
  assertEquals(status.steps.map((s) => s.status), [
    "done",
    "active",
    "planned",
    "planned",
    "planned",
  ]);

  await deliver(world, {
    worker: "implementer-2-retry-1",
    stepMessage: fix.id,
    files: { "feature.txt": "export v2 with quoting\n" },
  });

  // The fix is on the same branch, and no second PR was opened.
  assertStringIncludes((await show(world, "feature.txt")).stdout, "export v2 with quoting");
  assertEquals((await world.pullRequests.created()).length, 1);

  // QA runs again on the fixed work.
  const again = await nextForLeader(world);
  assertStringIncludes(String(again.body.instructions), "reviewer-3-round-1");
  await deliver(world, {
    worker: "reviewer-3-round-1",
    stepMessage: again.id,
    files: { "review.md": "Quoting fixed.\n" },
  });
  const gatekeep = await nextForLeader(world);
  assertStringIncludes(String(gatekeep.body.instructions), "gatekeeper-4");
  assertEquals(await escalations(world), []);
  await deliver(world, {
    worker: "gatekeeper-4",
    stepMessage: gatekeep.id,
    files: { "gatekeeper.md": "Passes.\n" },
  });

  const [told] = await escalations(world);
  assertStringIncludes(told.summary, "passed QA");
  const comments = await world.pullRequests.comments();
  assertEquals(comments.length, 1);
  assertStringIncludes(comments[0].body, "Quoting fixed.");
  await world.prStatus.script([MERGED]);
  await wrapUp(world);
  status = await waitFor(() => statusOf(world), (s) => s.status === "done");
  assertEquals(status.steps.map((s) => s.status), ["done", "done", "done", "done", "done"]);
});

withWorld(
  "gatekeeper findings and a rejection by the user both go back to the implementer",
  async (world) => {
    await startTicket(world);
    const review = await implement(world);
    await deliver(world, {
      worker: "reviewer-3",
      stepMessage: review.id,
      files: { "review.md": "Fine.\n" },
    });
    const gatekeep = await nextForLeader(world);
    await deliver(world, {
      worker: "gatekeeper-4",
      stepMessage: gatekeep.id,
      files: { "gatekeeper.md": "Criterion 2 is not met.\n" },
      status: "findings",
      summary: "Criterion 2 (header row) is not met.",
    });
    const fix = await nextForLeader(world);
    assertStringIncludes(String(fix.body.instructions), "Criterion 2 (header row) is not met.");
    assertEquals(await escalations(world), []);
    assertEquals(await world.pullRequests.comments(), []);

    await deliver(world, {
      worker: "implementer-2-retry-1",
      stepMessage: fix.id,
      files: { "feature.txt": "export v2 with header\n" },
    });
    for (
      const [step, worker, file] of [
        ["review", "reviewer-3-round-1", "review.md"],
        ["gatekeep", "gatekeeper-4-round-1", "gatekeeper.md"],
      ]
    ) {
      const m = await nextForLeader(world);
      assertStringIncludes(String(m.body.instructions), worker, step);
      await deliver(world, { worker, stepMessage: m.id, files: { [file]: "Ok.\n" } });
    }

    // The user can still turn the PR down; the reason goes back to a fresh implementer.
    const [told] = await escalations(world);
    const rejected = await world.kiln("reject", String(told.id), "--reason", "Use semicolons");
    assertEquals(rejected.code, 0, rejected.stderr);
    const rework = await nextForLeader(world);
    assertStringIncludes(String(rework.body.instructions), "Use semicolons");
    assertStringIncludes(String(rework.body.instructions), "implementer-2-retry-2");
    assertEquals((await statusOf(world)).status, "active");
    await deliver(world, {
      worker: "implementer-2-retry-2",
      stepMessage: rework.id,
      files: { "feature.txt": "export v3 with semicolons\n" },
    });
    for (
      const [worker, file] of [["reviewer-3-round-2", "review.md"], [
        "gatekeeper-4-round-2",
        "gatekeeper.md",
      ]]
    ) {
      const m = await nextForLeader(world);
      await deliver(world, { worker, stepMessage: m.id, files: { [file]: "Ok again.\n" } });
    }
    const all = await escalations(world, "--all");
    assertEquals(all.map((e) => e.status), ["rejected", "open"]);
    assertEquals((await world.pullRequests.created()).length, 1);
    assertEquals((await world.pullRequests.comments()).length, 2);
    assertEquals((await world.kiln("approve", String(all[1].id), "--confirm")).code, 0);
    await world.prStatus.script([MERGED]);
    await wrapUp(world);
    const status = await waitFor(() => statusOf(world), (s) => s.status === "done");
    assert(status.prUrl);
  },
);

withWorld(
  "a restarted QA round that writes nothing does not pass on the last round's review",
  async (world) => {
    await startTicket(world);
    const review = await implement(world);
    await deliver(world, {
      worker: "reviewer-3",
      stepMessage: review.id,
      files: { "review.md": "Fine.\n" },
    });
    const gatekeep = await nextForLeader(world);
    await deliver(world, {
      worker: "gatekeeper-4",
      stepMessage: gatekeep.id,
      files: { "gatekeeper.md": "Criterion 2 is not met.\n" },
      status: "findings",
      summary: "Criterion 2 (header row) is not met.",
    });
    const fix = await nextForLeader(world);
    await deliver(world, {
      worker: "implementer-2-retry-1",
      stepMessage: fix.id,
      files: { "feature.txt": "export v2 with header\n" },
    });

    // The fresh reviewer commits something else but not its review.
    const again = await nextForLeader(world);
    assertStringIncludes(String(again.body.instructions), "reviewer-3-round-1");
    await deliver(world, {
      worker: "reviewer-3-round-1",
      stepMessage: again.id,
      files: { "notes.txt": "looked at it\n" },
    });

    const retry = await nextForLeader(world);
    assertStringIncludes(String(retry.body.instructions), "review.md was not committed");
    assertEquals((await statusOf(world)).steps.map((s) => s.status), [
      "done",
      "done",
      "active",
      "planned",
      "planned",
    ]);
    assertEquals(await escalations(world), []);
    assertEquals(await world.pullRequests.comments(), []);
  },
);

withWorld("approving while the pull request is open asks to confirm first", async (world) => {
  await startTicket(world);
  const told = await passQa(world);
  await world.prStatus.script([OPEN]);

  const asked = await world.kiln("approve", String(told.id));
  assertEquals(asked.code, 1);
  assertStringIncludes(asked.stderr, "still open");
  assertStringIncludes(asked.stderr, "--confirm");
  assertEquals((await escalations(world)).map((e) => e.status), ["open"]);
  // A client that is not the CLI gets the reason as a code; the text is the same.
  const raw = await rawCall(world, "escalations.decide", { id: told.id, approved: true });
  assertEquals([raw.ok, raw.code, raw.error], [false, "needs-confirm", asked.stderr.trim()]);

  // Confirmed, the approval stands, but Kiln still waits for the merge and keeps the branches.
  const approved = await world.kiln("approve", String(told.id), "--confirm");
  assertEquals(approved.code, 0, approved.stderr);
  const waiting = await waitFor(() => statusOf(world), (s) => s.steps[3].status === "done");
  assertEquals(waiting.status, "active");
  assertEquals(waiting.steps.map((s) => s.status), ["done", "done", "done", "done", "planned"]);
  assert((await world.remote.branches()).includes("kiln/request-1"));
  assertEquals(await world.tracker.closed(), []);

  await world.prStatus.script([MERGED]);
  await wrapUp(world);
  await waitFor(() => statusOf(world), (s) => s.status === "done");
});

withWorld(
  "a merged pull request is wrapped up, then everything it left behind is cleaned up",
  async (world) => {
    await startTicket(world);
    await passQa(world);
    const { requestWorktree, gitDir } = await kilnClone(world);
    assert((await world.remote.branches()).includes("kiln/request-1"));
    assert((await branchesOf(world, gitDir)).includes("kiln/request-1"));
    await Deno.stat(requestWorktree);

    await world.prStatus.script([MERGED]);
    // Merged, the ticket is wrapped up before anything is removed.
    const wrap = await nextForLeader(world);
    assertStringIncludes(String(wrap.body.instructions), "closer-5");
    assert((await world.remote.branches()).includes("kiln/request-1"));
    await deliver(world, {
      worker: "closer-5",
      stepMessage: wrap.id,
      files: { "wrap-up.md": SHIPPED },
    });
    await waitFor(() => statusOf(world), (s) => s.status === "done");

    assertEquals((await world.remote.branches()).filter((b) => b.startsWith("kiln/")), []);
    assertEquals((await branchesOf(world, gitDir)).filter((b) => b.startsWith("kiln/")), []);
    await Deno.stat(requestWorktree).then(
      () => assert(false, "the request's worktree is still there"),
      (err) => assert(err instanceof Deno.errors.NotFound),
    );
    assertEquals((await world.tracker.closed()).length, 1);
  },
);

withWorld(
  "a closed pull request blocks the request on the user and keeps the branches",
  async (world) => {
    await startTicket(world);
    await passQa(world);
    const { gitDir } = await kilnClone(world);
    await world.prStatus.script([CLOSED]);

    const blocked = await waitFor(
      () => escalations(world),
      (e) => e.some((x) => x.summary.includes("closed")),
    );
    const gate = blocked.find((e) => e.summary.includes("closed"))!;
    assertStringIncludes(gate.summary, "blocked on you");
    assertStringIncludes(gate.detail!, PR_URL);
    assertEquals((await statusOf(world)).status, "active");
    assert((await world.remote.branches()).includes("kiln/request-1"));
    assertEquals(await world.tracker.closed(), []);

    const declined = await world.kiln("reject", String(gate.id), "--reason", "Dropping this work");
    assertEquals(declined.code, 0, declined.stderr);
    const failed = await waitFor(() => statusOf(world), (s) => s.status === "failed");
    assertStringIncludes(failed.failure!, "Dropping this work");
    assert((await world.remote.branches()).includes("kiln/request-1"));
    assert((await branchesOf(world, gitDir)).includes("kiln/request-1"));
    assertEquals(await world.tracker.closed(), []);
  },
);

withWorld("a pull request the user reopens is watched again until it merges", async (world) => {
  await startTicket(world);
  await passQa(world);
  await world.prStatus.script([CLOSED]);
  const gate = (await waitFor(
    () => escalations(world),
    (e) => e.some((x) => x.summary.includes("closed")),
  )).find((e) => e.summary.includes("closed"))!;

  // "Approve" says the pull request is open again; Kiln looks at it again.
  await world.prStatus.script([OPEN, MERGED]);
  assertEquals((await world.kiln("approve", String(gate.id))).code, 0);
  await wrapUp(world);
  await waitFor(() => statusOf(world), (s) => s.status === "done");
  assertEquals((await world.tracker.closed()).length, 1);
});
