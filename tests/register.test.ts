// Registering a Project, driven the way a person drives it: `kiln project register` against the
// fake world, where `claude` is the scripted onboarding agent, the remote is a bare repository
// and `gh api` answers the branch-protection question.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { type ApiReply, withWorld, type World } from "./world.ts";

const PROTECTED: ApiReply = { stdout: "{}\n" };
const INCONCLUSIVE: ApiReply = { exit: 1, stderr: "gh: Branch not protected (HTTP 404)\n" };

const FULL = {
  setup: "echo prepared > prepared.txt",
  test: "echo all tests pass",
  lint: "echo lint clean",
  build: "echo built",
};

/** The Project as a registrable one: it has agent docs, pushed to the remote. */
async function addAgentDocs(world: World) {
  await Deno.writeTextFile(join(world.project.path, "AGENTS.md"), "# How to work here\n");
  await world.git(world.project.path, "add", ".");
  await world.git(world.project.path, "commit", "-m", "Add agent docs");
  await world.git(world.project.path, "push", "origin", "main");
}

/** The onboarding agent's reply to the request for commands. */
const proposal = (commands: Record<string, string | null>) => ({
  result: `Here is what I found:\n${JSON.stringify(commands)}`,
});

/** Registered Projects, read from a backup of the store. */
async function registeredProjects(world: World): Promise<Record<string, unknown>[]> {
  const backup = await world.kiln("backup");
  assertEquals(backup.code, 0, backup.stderr);
  const db = new DatabaseSync(backup.stdout.trim(), { readOnly: true });
  try {
    return db.prepare("select * from projects order by id").all();
  } finally {
    db.close();
  }
}

const cloneOf = (world: World, name: string) => join(world.dirs.data, "projects", name);

async function assertNothingRegistered(world: World, name = "remote") {
  assertEquals(await registeredProjects(world), []);
  await assertNotExists(cloneOf(world, name));
}
async function assertNotExists(path: string) {
  assert(await Deno.stat(path).then(() => false, () => true), `${path} should not exist`);
}

withWorld(
  "registering by path gives Kiln its own clone and records the commands",
  async (world) => {
    await addAgentDocs(world);
    await world.githubApi.script([PROTECTED]);
    await world.launcher.script([proposal(FULL)]);

    const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
    assertEquals(r.code, 0, r.stderr);
    assertStringIncludes(r.stdout, "echo prepared > prepared.txt");
    assertStringIncludes(r.stdout, "Registered remote");
    assert(!r.stdout.includes("warning:"), r.stdout);

    // The onboarding agent worked in Kiln's clone, not in the user's checkout.
    const clone = cloneOf(world, "remote");
    assertEquals((await world.launcher.calls()).map((c) => c.cwd), [await Deno.realPath(clone)]);

    // Kiln's clone tracks the remote, and the confirmed setup ran in it.
    assertEquals(
      (await world.git(clone, "remote", "get-url", "origin")).stdout.trim(),
      world.remote.path,
    );
    assertEquals(await Deno.readTextFile(join(clone, "prepared.txt")), "prepared\n");
    await assertNotExists(join(world.project.path, "prepared.txt"));

    const [row] = await registeredProjects(world);
    assertEquals(row.name, "remote");
    assertEquals(row.source, world.project.path);
    assertEquals(row.clone_path, clone);
    assertEquals(row.default_branch, "main");
    assertEquals(row.setup_command, FULL.setup);
    assertEquals(row.test_command, FULL.test);
    assertEquals(row.lint_command, FULL.lint);
    assertEquals(row.build_command, FULL.build);
    assertEquals(row.warnings, "[]");
    assertEquals(JSON.parse(row.baseline as string).passed, true);
  },
);

withWorld("registering by URL clones from that URL", async (world) => {
  await addAgentDocs(world);
  await world.githubApi.script([PROTECTED]);
  await world.launcher.script([proposal(FULL)]);

  const url = `file://${world.remote.path}`;
  const r = await world.kilnWithInput("y\n", "project", "register", url);
  assertEquals(r.code, 0, r.stderr);

  const [row] = await registeredProjects(world);
  assertEquals(row.name, "remote");
  assertEquals(row.source, url);
  assertEquals(row.remote_url, url);
  assertEquals(
    (await world.git(cloneOf(world, "remote"), "remote", "get-url", "origin")).stdout.trim(),
    url,
  );
});

withWorld("the user confirms the proposed commands before anything is run", async (world) => {
  await addAgentDocs(world);
  await world.githubApi.script([PROTECTED]);
  await world.launcher.script([proposal(FULL)]);

  // Declined: the commands are shown, nothing runs, and nothing is left behind.
  const declined = await world.kilnWithInput("n\n", "project", "register", world.project.path);
  assertEquals(declined.code, 1);
  assertStringIncludes(declined.stdout, "Use these commands? [y/N]");
  assertStringIncludes(declined.stdout, FULL.setup);
  assertStringIncludes(declined.stderr, "cancelled");
  await assertNothingRegistered(world);

  // No answer at all is also a no.
  await world.launcher.script([proposal(FULL)]);
  assertEquals((await world.kiln("project", "register", world.project.path)).code, 1);
  await assertNothingRegistered(world);

  // Confirmed.
  await world.launcher.script([proposal(FULL)]);
  const confirmed = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(confirmed.code, 0, confirmed.stderr);
  assertEquals((await registeredProjects(world)).length, 1);
});

withWorld("registration blocks on a project with no remote", async (world) => {
  await addAgentDocs(world);
  const lonely = join(world.root, "lonely");
  await world.git(world.root, "init", "--initial-branch=main", lonely);

  const r = await world.kilnWithInput("y\n", "project", "register", lonely);
  assertEquals(r.code, 1);
  assertStringIncludes(r.stderr, "Registration blocked");
  assertStringIncludes(r.stderr, "no remote");
  assertEquals(await world.launcher.calls(), []);
  await assertNothingRegistered(world, "lonely");
});

withWorld("registration blocks on a project with no agent docs", async (world) => {
  const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(r.code, 1);
  assertStringIncludes(r.stderr, "Registration blocked");
  assertStringIncludes(r.stderr, "AGENTS.md or CLAUDE.md");
  assertEquals(await world.launcher.calls(), [], "no agent was spent on it");
  await assertNothingRegistered(world);

  // CLAUDE.md counts too.
  await Deno.writeTextFile(join(world.project.path, "CLAUDE.md"), "# Notes for Claude\n");
  await world.git(world.project.path, "add", ".");
  await world.git(world.project.path, "commit", "-m", "Add CLAUDE.md");
  await world.git(world.project.path, "push", "origin", "main");
  await world.githubApi.script([PROTECTED]);
  await world.launcher.script([proposal(FULL)]);
  const again = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(again.code, 0, again.stderr);
});

withWorld("agent docs symlinked outside the clone block registration", async (world) => {
  const privateFile = join(world.root, "private-notes.md");
  await Deno.writeTextFile(privateFile, "private notes\n");
  await Deno.symlink(privateFile, join(world.project.path, "AGENTS.md"));
  await world.git(world.project.path, "add", ".");
  await world.git(world.project.path, "commit", "-m", "Add linked agent docs");
  await world.git(world.project.path, "push", "origin", "main");

  const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(r.code, 1);
  assertStringIncludes(r.stderr, "AGENTS.md or CLAUDE.md");
  assertEquals(await world.launcher.calls(), []);
  await assertNothingRegistered(world);
});

withWorld("a directory named AGENTS.md is not agent docs", async (world) => {
  const docs = join(world.project.path, "AGENTS.md");
  await Deno.mkdir(docs);
  await Deno.writeTextFile(join(docs, "note"), "directory content\n");
  await world.git(world.project.path, "add", ".");
  await world.git(world.project.path, "commit", "-m", "Add agent docs directory");
  await world.git(world.project.path, "push", "origin", "main");

  const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(r.code, 1);
  assertStringIncludes(r.stderr, "AGENTS.md or CLAUDE.md");
  assertEquals(await world.launcher.calls(), []);
  await assertNothingRegistered(world);
});

withWorld("registration blocks when setup fails", async (world) => {
  await addAgentDocs(world);
  await world.githubApi.script([PROTECTED]);
  await world.launcher.script([proposal({ ...FULL, setup: "echo no network >&2; exit 3" })]);

  const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(r.code, 1);
  assertStringIncludes(r.stderr, "Registration blocked: Setup failed (exit 3)");
  assertStringIncludes(r.stderr, "no network");
  await assertNothingRegistered(world);
});

withWorld("registration blocks when a push dry-run to the remote fails", async (world) => {
  await addAgentDocs(world);
  await world.remote.refusePushes();

  const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(r.code, 1);
  assertStringIncludes(r.stderr, "Registration blocked");
  assertStringIncludes(r.stderr, "push dry-run");
  assertEquals(await world.launcher.calls(), []);
  await assertNothingRegistered(world);
  assertEquals(await world.remote.branches(), ["main"], "a dry-run pushes nothing");
});

withWorld(
  "registration blocks when the onboarding agent proposes nothing usable",
  async (world) => {
    await addAgentDocs(world);
    await world.githubApi.script([PROTECTED]);
    await world.launcher.script([{ result: "I could not work out how to build this." }]);

    const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
    assertEquals(r.code, 1);
    assertStringIncludes(r.stderr, "did not propose commands");
    await assertNothingRegistered(world);
  },
);

withWorld("an incomplete command proposal blocks registration", async (world) => {
  await addAgentDocs(world);
  await world.githubApi.script([PROTECTED]);
  await world.launcher.script([proposal({})]);

  const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(r.code, 1);
  assertStringIncludes(r.stderr, "did not propose commands");
  await assertNothingRegistered(world);
});

withWorld("onboarding names only readable project files", async (world) => {
  await addAgentDocs(world);
  await Deno.writeTextFile(join(world.project.path, "package.json"), "{}\n");
  const privateFile = join(world.root, "private-notes.md");
  await Deno.writeTextFile(privateFile, "private notes\n");
  await Deno.symlink(privateFile, join(world.project.path, "pyproject.toml"));
  const workflows = join(world.project.path, ".github", "workflows");
  await Deno.mkdir(workflows, { recursive: true });
  await Deno.symlink(privateFile, join(workflows, "build.yml"));
  await Deno.writeTextFile(join(workflows, "safe.yml"), "name: Safe\n");
  await Deno.mkdir(join(world.project.path, "Makefile"));
  await Deno.writeTextFile(join(world.project.path, "Makefile", "note"), "directory\n");
  await world.git(world.project.path, "add", ".");
  await world.git(world.project.path, "commit", "-m", "Add onboarding files");
  await world.git(world.project.path, "push", "origin", "main");
  await world.githubApi.script([PROTECTED]);
  await world.launcher.script([proposal(FULL)]);

  const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(r.code, 0, r.stderr);
  const prompt = await Deno.readTextFile(join(world.root, "fake", "launcher", "prompts.jsonl"));
  for (const name of ["AGENTS.md", "package.json", "safe.yml"]) {
    assertStringIncludes(prompt, name);
  }
  for (const name of ["pyproject.toml", "build.yml", "Makefile"]) {
    assert(!prompt.includes(name), `${name} must not be offered to onboarding`);
  }
});

withWorld("a 404 protection lookup and missing lint or build warn", async (world) => {
  await addAgentDocs(world);
  await world.githubApi.script([INCONCLUSIVE]);
  await world.launcher.script([
    proposal({ setup: null, test: "echo ok", lint: null, build: null }),
  ]);

  const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(r.code, 0, r.stderr);
  assertStringIncludes(r.stdout, `warning: Could not confirm branch protection for "main"`);
  assert(!r.stdout.includes("is not protected"), r.stdout);
  assertStringIncludes(r.stdout, "warning: No lint command");
  assertStringIncludes(r.stdout, "warning: No build command");

  const [row] = await registeredProjects(world);
  assertEquals(JSON.parse(row.warnings as string).length, 3);
  const [call] = await world.githubApi.calls();
  assertEquals(call.args, ["api", "repos/{owner}/{repo}/branches/main/protection"]);
});

withWorld("a default branch whose protection cannot be checked is a warning", async (world) => {
  await addAgentDocs(world);
  // No scripted reply: the fake `gh api` fails the way an unreachable GitHub would.
  await world.launcher.script([proposal(FULL)]);

  const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(r.code, 0, r.stderr);
  assertStringIncludes(r.stdout, `warning: Could not confirm branch protection for "main"`);
});

withWorld("branch protection checks encode a slash in the branch name", async (world) => {
  await addAgentDocs(world);
  await world.git(world.project.path, "checkout", "-b", "release/2026");
  await world.git(world.project.path, "push", "origin", "release/2026");
  await world.git(world.remote.path, "symbolic-ref", "HEAD", "refs/heads/release/2026");
  await world.githubApi.script([PROTECTED]);
  await world.launcher.script([proposal(FULL)]);

  const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(r.code, 0, r.stderr);
  const [call] = await world.githubApi.calls();
  assertEquals(call.args, ["api", "repos/{owner}/{repo}/branches/release%2F2026/protection"]);
});

withWorld("registration records the test baseline, even a failing one", async (world) => {
  await addAgentDocs(world);
  await world.githubApi.script([PROTECTED]);
  await world.launcher.script([
    proposal({ ...FULL, test: "echo 3 passed; echo 1 failed >&2; exit 1" }),
  ]);

  const failing = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(failing.code, 0, failing.stderr);
  assertStringIncludes(failing.stdout, "Test baseline: FAILING (exit 1)");
  const [row] = await registeredProjects(world);
  const failed = JSON.parse(row.baseline as string);
  assertEquals(failed.passed, false);
  assertEquals(failed.exitCode, 1);
  assertStringIncludes(failed.outputTail, "3 passed");
  assertStringIncludes(failed.outputTail, "1 failed");
  assertEquals(
    failed.commit,
    (await world.git(world.project.path, "rev-parse", "HEAD")).stdout.trim(),
  );
});

withWorld("the test baseline retains the ordered, bounded end of output", async (world) => {
  await addAgentDocs(world);
  await world.githubApi.script([PROTECTED]);
  await world.launcher.script([proposal({
    ...FULL,
    test: "printf early >&2; i=0; while [ $i -lt 5000 ]; do printf x; i=$((i+1)); done; printf END",
  })]);

  const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(r.code, 0, r.stderr);
  const [row] = await registeredProjects(world);
  const baseline = JSON.parse(row.baseline as string);
  assertEquals(baseline.outputTail.length, 4000);
  assert(baseline.outputTail.endsWith("END"));
  assert(!baseline.outputTail.includes("early"));
});

withWorld("a project without tests is registered with a warning and no baseline", async (world) => {
  await addAgentDocs(world);
  await world.githubApi.script([PROTECTED]);
  await world.launcher.script([proposal({ ...FULL, test: null })]);

  const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(r.code, 0, r.stderr);
  assertStringIncludes(r.stdout, "warning: No test command");
  assertStringIncludes(r.stdout, "Test baseline: not recorded (no test command).");
  const [row] = await registeredProjects(world);
  assertEquals(row.baseline, null);
});

withWorld("a project cannot be registered twice under one name", async (world) => {
  await addAgentDocs(world);
  await world.githubApi.script([PROTECTED]);
  await world.launcher.script([proposal(FULL)]);
  assertEquals(
    (await world.kilnWithInput("y\n", "project", "register", world.project.path)).code,
    0,
  );

  const again = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(again.code, 1);
  assertStringIncludes(again.stderr, "already registered");
  assertEquals((await registeredProjects(world)).length, 1);
  assertEquals((await world.launcher.calls()).length, 1);
});

withWorld("the source must be a directory or a git URL", async (world) => {
  const r = await world.kilnWithInput("y\n", "project", "register", join(world.root, "nowhere"));
  assertEquals(r.code, 1);
  assertStringIncludes(r.stderr, "neither a directory nor a git URL");
  assertEquals((await world.kiln("project", "register")).code, 2);
  for (const flag of ["--yes", "-y", "--json", "--name"]) {
    const option = await world.kiln("project", "register", world.project.path, flag);
    assertEquals(option.code, 2);
  }
});
