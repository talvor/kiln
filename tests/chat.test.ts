// `kiln chat`, driven the way it is used: the real command runs the (fake) `claude` interactively
// as the Overseer, the fake plays the hooks and status line Kiln configured, and the user's side
// is the CLI and the files in the Kiln home. Nothing here looks inside Kiln.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { withWorld, type World } from "./world.ts";
import { asAgent, openTeam, waitFor } from "./router_helpers.ts";
import type { LauncherRun } from "./fakes/claude.ts";

const MAIN = fromFileUrl(new URL("../src/main.ts", import.meta.url));

/** Register the world's project, as the Overseer's read-only access and requests need one. */
async function registerProject(world: World) {
  await Deno.writeTextFile(join(world.project.path, "AGENTS.md"), "# How to work here\n");
  await world.git(world.project.path, "add", ".");
  await world.git(world.project.path, "commit", "-m", "Add agent docs");
  await world.git(world.project.path, "push", "origin", "main");
  await world.githubApi.script([{ stdout: "{}\n" }]);
  await world.launcher.script([{
    result: JSON.stringify({ setup: null, test: null, lint: null, build: null }),
  }]);
  const reg = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(reg.code, 0, reg.stderr);
}

/** Run `kiln chat` against a scripted claude; returns what the user saw. */
async function chat(world: World, runs: LauncherRun[]) {
  await world.launcher.script(runs);
  const r = await world.kiln("chat");
  assertEquals(r.code, 0, r.stderr);
  return r;
}

/** The value following `flag` in the arguments of the n-th claude invocation. */
async function claudeArg(world: World, n: number, flag: string): Promise<string | undefined> {
  const { args } = (await world.launcher.calls())[n];
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** The chat history, read from a backup of the store. */
async function history(world: World): Promise<{ speaker: string; text: string }[]> {
  const copy = new DatabaseSync((await world.kiln("backup")).stdout.trim(), { readOnly: true });
  try {
    return copy.prepare("select speaker, text from chat_turns order by id").all() as {
      speaker: string;
      text: string;
    }[];
  } finally {
    copy.close();
  }
}

const hook = async (world: World, event: string, input: unknown, chatId = 1) => {
  const r = await world.kilnWithInput(
    JSON.stringify(input),
    "hook",
    "chat",
    event,
    "--chat",
    String(chatId),
  );
  assertEquals(r.code, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
};

withWorld("kiln chat runs claude interactively as the Overseer", async (world) => {
  await registerProject(world);
  await chat(world, [{ session: [{ statusLine: true }] }]);

  const [, call] = await world.launcher.calls(); // the first call was the registration
  assert(!call.args.includes("--print") && !call.args.includes("--input-format"), "interactive");
  assertEquals(call.env?.KILN_AGENT, "overseer");
  assertEquals(
    await Deno.realPath(call.cwd!),
    await Deno.realPath(join(world.dirs.data, "overseer")),
  );

  // Kiln's tools, over MCP, and nobody else's.
  const mcp = JSON.parse((await claudeArg(world, 1, "--mcp-config"))!);
  assertEquals(mcp.mcpServers.kiln.args.slice(-2), ["--address", "overseer"]);
  assert(call.args.includes("--strict-mcp-config"));
  // Deny by default; it may look and nothing more.
  assertEquals(await claudeArg(world, 1, "--permission-mode"), "dontAsk");
  assertEquals(await claudeArg(world, 1, "--tools"), "Read,Glob,Grep");
  // The project is readable, through its clone.
  assert(
    call.args.includes(
      (await world.kiln("project", "list")).stdout.includes("remote")
        ? call.args[call.args.indexOf("--add-dir") + 1]
        : "?",
    ),
  );
  assertStringIncludes(call.args[call.args.indexOf("--add-dir") + 1], join("data", "projects"));
});

withWorld(
  "the Overseer's session has Kiln's status line, which shows what waits",
  async (world) => {
    await openTeam(world);
    await asAgent(
      world,
      "overseer",
      (agent) => agent.call("raise_escalation", { summary: "Ship it?" }),
    );
    const r = await chat(world, [{ session: [{ statusLine: true }] }]);
    assertStringIncludes(r.stdout, "status-line: kiln · 1 decision waiting");
    const settings = JSON.parse((await claudeArg(world, 0, "--settings"))!);
    assertEquals(settings.statusLine.type, "command");

    await world.kiln("reject", "1", "--reason", "not now");
    const quiet = await chat(world, [{ session: [{ statusLine: true }] }]);
    assertStringIncludes(quiet.stdout, "status-line: kiln · all quiet");
  },
);

withWorld("the Overseer has tools to survey and start work", async (world) => {
  await registerProject(world);
  await chat(world, [{}]); // opens the Overseer's seat
  await asAgent(world, "overseer", async (agent) => {
    const tools = await agent.tools();
    for (const t of ["list_projects", "list_playbooks", "start_request", "request_status"]) {
      assert(tools.includes(t), t);
    }
    const projects = JSON.parse((await agent.call("list_projects")).text).projects;
    assertEquals(projects.map((p: { name: string }) => p.name), ["remote"]);

    // Start now: a project, a playbook and a description is all it takes.
    const started = await agent.call("start_request", {
      project: "remote",
      playbook: "diagnose-a-bug",
      description: "Login is flaky",
    });
    assertEquals(started.isError, false, started.text);
    const { requestId } = JSON.parse(started.text).started;
    const status = await agent.call("request_status", { id: requestId });
    assertStringIncludes(status.text, "diagnose-a-bug");

    // Ask first: what cannot be started says why, so the Overseer can ask the user.
    const unknown = await agent.call("start_request", {
      project: "nowhere",
      playbook: "diagnose-a-bug",
      description: "x",
    });
    assertEquals(unknown.isError, true);
    const unfit = await agent.call("start_request", {
      project: "remote",
      playbook: "no-such-playbook",
      description: "x",
    });
    assertEquals(unfit.isError, true);
    assertStringIncludes(unfit.text, "Available");
  });
  assertEquals((await world.kiln("project", "pause", "remote")).code, 0);
  await asAgent(world, "overseer", async (agent) => {
    const paused = await agent.call("start_request", {
      project: "remote",
      playbook: "diagnose-a-bug",
      description: "More",
    });
    assertEquals(paused.isError, true);
    assertStringIncludes(paused.text, "paused");
  });
});

withWorld("only the Overseer may use the Overseer's tools", async (world) => {
  await openTeam(world);
  await asAgent(world, "dev-lead", async (agent) => {
    for (
      const [tool, args] of [["list_projects", {}], ["start_request", {
        project: "p",
        playbook: "diagnose-a-bug",
        description: "d",
      }]] as const
    ) {
      const out = await agent.call(tool, args);
      assertEquals(out.isError, true, tool);
      assertStringIncludes(out.text, "Only the overseer");
    }
  });
});

withWorld("the Overseer is told when to start now and when to ask first", async (world) => {
  await chat(world, [{}]);
  const system = (await claudeArg(world, 0, "--append-system-prompt"))!;
  assertStringIncludes(system, "Start now");
  assertStringIncludes(system, "call start_request at once");
  assertStringIncludes(system, "Ask first");
  assertStringIncludes(system, "Never guess a project");
  assertStringIncludes(system, "You are the overseer"); // its configured role comes first
});

withWorld("the Overseer speaks first only when the user has something to act on", async (world) => {
  await openTeam(world);
  // Nothing is waiting: the session opens silent, with nothing for the Overseer to say.
  await chat(world, [{}]);
  const silent = (await world.launcher.calls())[0].args;
  assertEquals(silent[0], "--append-system-prompt");
  const system = (await claudeArg(world, 0, "--append-system-prompt"))!;
  assertStringIncludes(system, "Speaking unprompted");
  assertStringIncludes(system, "stay quiet");

  // A decision is waiting: the Overseer is asked to say so, once.
  await asAgent(
    world,
    "overseer",
    (agent) => agent.call("raise_escalation", { summary: "Ship the migration?" }),
  );
  await chat(world, [{}]);
  const loud = (await world.launcher.calls())[1].args;
  assertStringIncludes(loud[0], "has just opened the chat");
  assertStringIncludes(
    (await claudeArg(world, 1, "--append-system-prompt"))!,
    "Decision waiting for the user: Escalation 1 [open]: Ship the migration?",
  );
});

withWorld("news already told is not repeated in the next session", async (world) => {
  await openTeam(world);
  await world.launcher.script([{ session: [{ wait: 4_000 }] }]);
  const chatting = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, "chat"],
    env: world.env,
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  await waitFor(() => world.launcher.calls(), (calls) => calls.length === 1);
  // Mid-turn, so the news is not announced to the chat itself.
  await hook(world, "prompt", { prompt: "hello" });
  const db = new DatabaseSync(join(world.dirs.data, "kiln.db"), { timeout: 5_000 });
  try {
    db.prepare("insert into events (ts, kind, data) values ('now', 'request.done', '{\"id\":7}')")
      .run();
  } finally {
    db.close();
  }
  await chatting.output();

  await chat(world, [{}]);
  const seed = (await claudeArg(world, 1, "--append-system-prompt"))!;
  assert(!seed.includes("Request 7 finished."), seed);
  assert(!(await world.launcher.calls())[1].args[0].includes("has just opened the chat"));
});

withWorld("news after a crashed chat is told in the next session", async (world) => {
  await openTeam(world);
  await world.launcher.script([{ session: [{ wait: 4_000 }] }]);
  const chatting = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, "chat"],
    env: world.env,
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  await waitFor(() => world.launcher.calls(), (calls) => calls.length === 1);
  chatting.kill("SIGKILL");
  await chatting.output();
  const db = new DatabaseSync(join(world.dirs.data, "kiln.db"), { timeout: 5_000 });
  try {
    db.prepare("insert into events (ts, kind, data) values ('now', 'request.done', '{\"id\":7}')")
      .run();
  } finally {
    db.close();
  }

  await chat(world, [{}]);
  assertStringIncludes(
    (await claudeArg(world, 1, "--append-system-prompt"))!,
    "Request 7 finished.",
  );
  assertStringIncludes((await world.launcher.calls())[1].args[0], "has just opened the chat");
});

withWorld("the chat is kept in the store and seeds the next session", async (world) => {
  await chat(world, [{
    session: [
      { prompt: "Please look into the login bug" },
      { said: "I will start a diagnosis." },
      { prompt: "kiln help" }, // a command: not part of the conversation
    ],
  }]);
  assertEquals(await history(world), [
    { speaker: "user", text: "Please look into the login bug" },
    { speaker: "overseer", text: "I will start a diagnosis." },
  ]);

  await chat(world, [{}]);
  const seed = (await claudeArg(world, 1, "--append-system-prompt"))!;
  assertStringIncludes(seed, "User: Please look into the login bug");
  assertStringIncludes(seed, "You: I will start a diagnosis.");
});

withWorld(
  "a chat whose context grows too large rolls over into a seeded session",
  async (world) => {
    world.env.KILN_CHAT_ROLLOVER_TOKENS = "1000";
    const r = await chat(world, [
      {
        session: [{ prompt: "Remember the blue door" }, {
          said: "Noted: the blue door.",
          tokens: 5000,
        }, {
          wait: 4_000,
        }],
      },
      { session: [{ statusLine: true }] },
    ]);
    assertStringIncludes(r.stderr, "fresh session");
    assertStringIncludes(r.stdout, "status-line:"); // the second session ran
    const calls = await world.launcher.calls();
    assertEquals(calls.length, 2);
    // Nothing was lost: the digest carries the conversation into the new context.
    const seed = (await claudeArg(world, 1, "--append-system-prompt"))!;
    assertStringIncludes(seed, "User: Remember the blue door");
    assertStringIncludes(seed, "You: Noted: the blue door.");
    // Under the limit, a session carries on.
    assertEquals(
      (await chat(world, [{ session: [{ said: "short", tokens: 10 }] }])).stderr.includes("fresh"),
      false,
    );
  },
);

withWorld("user commands are answered without a model", async (world) => {
  await openTeam(world);
  await chat(world, [{}]);
  await asAgent(world, "overseer", async (agent) => {
    await agent.call("raise_escalation", { summary: "Ship the migration?" });
    await agent.call("raise_escalation", { summary: "Drop the old table?" });
  });
  const calls = (await world.launcher.calls()).length;

  const help = await hook(world, "prompt", { prompt: "kiln help" });
  assertEquals(help.decision, "block"); // never reaches the model
  assertStringIncludes(help.reason, "without asking the Overseer");

  const list = await hook(world, "prompt", { prompt: "kiln escalations" });
  assertStringIncludes(list.reason, "Escalation 1 [open]: Ship the migration?");
  assertStringIncludes(
    (await hook(world, "prompt", { prompt: "kiln status" })).reason,
    "2 decision",
  );
  assertStringIncludes(
    (await hook(world, "prompt", { prompt: "kiln projects" })).reason,
    "No projects",
  );

  assertEquals(
    (await hook(world, "prompt", { prompt: "kiln approve 1" })).reason,
    "Approved escalation 1.",
  );
  const unexplained = await hook(world, "prompt", { prompt: "kiln reject 2" });
  assertStringIncludes(unexplained.reason, "Say why");
  assertStringIncludes(
    (await hook(world, "prompt", { prompt: "kiln reject 2 too risky" })).reason,
    "Rejected escalation 2",
  );
  const decided = JSON.parse((await world.kiln("escalations", "--all", "--json")).stdout);
  assertEquals(decided.map((e: { status: string }) => e.status), ["approved", "rejected"]);
  assertEquals(decided[1].reason, "too risky");
  // A decision is final, and says so.
  assertStringIncludes((await hook(world, "prompt", { prompt: "kiln approve 1" })).reason, "final");

  // Anything else goes to the model, untouched.
  assertEquals(await hook(world, "prompt", { prompt: "kiln is a nice tool" }), null);
  assertEquals((await world.launcher.calls()).length, calls); // no model was launched
});

withWorld("the Overseer has read-only access to the registered projects", async (world) => {
  await registerProject(world);
  await chat(world, [{}]);
  const police = async (tool: string, input: Record<string, unknown>) => {
    const r = await world.kilnWithInput(
      JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input }),
      "hook",
      "police",
      "--address",
      "overseer",
    );
    assertEquals(r.code, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : null;
  };
  const clone = (await world.kiln("project", "list")).stdout; // proves it is registered
  assertStringIncludes(clone, "remote");
  const projects = join(world.dirs.data, "projects");
  const cloneDir = join(projects, (await Array.fromAsync(Deno.readDir(projects)))[0].name);

  assertEquals(await police("Read", { file_path: join(cloneDir, "AGENTS.md") }), null);
  assertEquals(await police("Grep", { pattern: "work", path: cloneDir }), null);
  // It cannot change anything, in a project or anywhere else.
  for (const tool of ["Write", "Edit", "Bash", "NotebookEdit"]) {
    assertEquals(
      await police(tool, { file_path: join(cloneDir, "AGENTS.md"), command: "ls" }),
      "deny",
      tool,
    );
  }
  // Nor read beyond the projects, nor their secrets.
  assertEquals(await police("Read", { file_path: "/etc/hostname" }), "deny");
  assertEquals(await police("Read", { file_path: join(cloneDir, ".env") }), "deny");
  // Kiln's own tools are always allowed.
  assertEquals(await police("mcp__kiln__start_request", {}), null);
  // The session is launched with the same limits.
  assertEquals(await claudeArg(world, 1, "--tools"), "Read,Glob,Grep");
});

withWorld("the Overseer's mail waits for the chat instead of being nudged", async (world) => {
  const tickSeconds = 0.5;
  world.env.KILN_TICK_SECONDS = String(tickSeconds);
  await openTeam(world);
  await world.launcher.script([
    { session: [{ wait: 6_000 }] }, // the chat, open for a while
    { result: "read it" }, // a nudge, once the chat is over
  ]);
  const chatting = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, "chat"],
    env: world.env,
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  await waitFor(() => world.launcher.calls(), (calls) => calls.length === 1);
  // The user has a prompt in flight, so the Overseer is mid-turn.
  await hook(world, "prompt", { prompt: "hello" });
  await asAgent(
    world,
    "dev-lead",
    (agent) =>
      agent.send("overseer", "question", { question: "Which branch should the fix target?" }),
  );

  // While the Overseer is mid-turn the question waits: it is shown, not delivered by a nudge.
  await new Promise((resolve) => setTimeout(resolve, tickSeconds * 3_000));
  assertEquals((await world.launcher.calls()).length, 1);
  const status = await world.kilnWithInput("{}", "hook", "chat", "status-line", "--chat", "1");
  assertStringIncludes(status.stdout, "1 unread");
  const prompt = await hook(world, "prompt", { prompt: "any news?" });
  assertStringIncludes(prompt.hookSpecificOutput.additionalContext, "read_inbox");
  // The Overseer may not end its turn with the mail unread.
  assertStringIncludes((await hook(world, "stop", {})).reason, "unread message");

  // Once the user has left, the mail is delivered the usual way.
  await chatting.output();
  await waitFor(() => world.launcher.calls(), (calls) => calls.length === 2, 15_000);
});

/** Open `kiln chat` against a first session that idles, as an idle user's chat does. */
async function idleChat(world: World, openFor = 30_000, beforeStart?: () => Promise<void>) {
  await openTeam(world);
  await beforeStart?.();
  await world.launcher.script([
    { session: [{ wait: openFor }] }, // the chat, idle
    { session: [] }, // its replacement, which ends at once
  ]);
  const chatting = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, "chat"],
    env: world.env,
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  await waitFor(() => world.launcher.calls(), (calls) => calls.length === 1);
  return chatting;
}

withWorld("mail for an idle chat is surfaced without a user prompt", async (world) => {
  const chatting = await idleChat(world);
  await asAgent(
    world,
    "dev-lead",
    (agent) => agent.send("overseer", "question", { question: "Which id should I use?" }),
  );

  // Nobody types anything: the chat is replaced by a session that tells the user.
  await waitFor(() => world.launcher.calls(), (calls) => calls.length === 2, 10_000);
  await chatting.output();
  const calls = await world.launcher.calls();
  assertStringIncludes(calls[1].args[0], "has just opened the chat");
  assertStringIncludes((await claudeArg(world, 1, "--append-system-prompt"))!, "unread message");
  // Surfaced once, not on every heartbeat.
  assertEquals(calls.length, 2);
});

withWorld("a result for an idle Overseer chat is surfaced without a user prompt", async (world) => {
  let assignmentId = 0;
  const chatting = await idleChat(world, 30_000, async () => {
    assertEquals((await world.kiln("halt")).code, 0);
    const assignment = await asAgent(
      world,
      "overseer",
      (agent) =>
        agent.send("dev-lead", "assignment", {
          title: "Diagnose the stall",
          instructions: "Report the cause",
        }),
    );
    assignmentId = assignment.id;
    await asAgent(world, "dev-lead", (agent) => agent.inbox());
    assertEquals((await world.kiln("resume")).code, 0);
  });
  await asAgent(
    world,
    "dev-lead",
    (agent) =>
      agent.send(
        "overseer",
        "result",
        { status: "done", summary: "Found the cause" },
        assignmentId,
      ),
  );

  await waitFor(() => world.launcher.calls(), (calls) => calls.length === 2, 10_000);
  await chatting.output();
  assertStringIncludes((await claudeArg(world, 1, "--append-system-prompt"))!, "unread message");
  const messages = await asAgent(world, "overseer", (agent) => agent.inbox());
  assertEquals(messages.map((m) => [m.kind, m.inReplyTo]), [["result", assignmentId]]);
});

withWorld("unread mail still wakes a replacement chat after its turn", async (world) => {
  await openTeam(world);
  await world.launcher.script([
    { session: [{ wait: 30_000 }] },
    { session: [{ wait: 30_000 }] },
    { session: [{ wait: 5_000 }] },
  ]);
  const chatting = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, "chat"],
    env: world.env,
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  await waitFor(() => world.launcher.calls(), (calls) => calls.length === 1);
  await asAgent(
    world,
    "dev-lead",
    (agent) => agent.send("overseer", "question", { question: "Which id should I use?" }),
  );
  await waitFor(() => world.launcher.calls(), (calls) => calls.length === 2, 10_000);

  assertStringIncludes((await hook(world, "stop", {}, 2)).reason, "unread message");
  assertEquals(await hook(world, "stop", { stop_hook_active: true }, 2), null);
  await waitFor(() => world.launcher.calls(), (calls) => calls.length === 3, 15_000);
  assertStringIncludes((await claudeArg(world, 2, "--append-system-prompt"))!, "unread message");
  assertEquals((await asAgent(world, "overseer", (agent) => agent.inbox())).length, 1);
  assertEquals(await hook(world, "stop", {}, 3), null);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assertEquals((await world.launcher.calls()).length, 3);
  await chatting.output();
});

withWorld("mail sent during a daemon restart wakes the attached chat", async (world) => {
  const chatting = await idleChat(world);
  assertEquals((await world.kiln("daemon", "stop")).code, 0);
  const db = new DatabaseSync(join(world.dirs.data, "kiln.db"), { timeout: 5_000 });
  try {
    const sent = db.prepare(
      "insert into messages (sender, recipient, kind, body, sent_at) values (?, ?, ?, ?, ?)",
    ).run("dev-lead", "overseer", "question", '{"question":"Which id?"}', new Date().toISOString());
    const id = Number(sent.lastInsertRowid);
    db.prepare("insert into message_status (message_id) values (?)").run(id);
    db.prepare("insert into events (ts, kind, data) values (?, ?, ?)")
      .run(new Date().toISOString(), "message.sent", JSON.stringify({ id, to: "overseer" }));
  } finally {
    db.close();
  }
  assertEquals((await world.kiln("daemon", "start")).code, 0);

  await waitFor(() => world.launcher.calls(), (calls) => calls.length === 2, 10_000);
  await chatting.output();
  assertStringIncludes((await claudeArg(world, 1, "--append-system-prompt"))!, "unread message");
});

withWorld("a finished request is announced to an idle chat", async (world) => {
  const chatting = await idleChat(world);
  const db = new DatabaseSync(join(world.dirs.data, "kiln.db"), { timeout: 5_000 });
  try {
    db.prepare("insert into events (ts, kind, data) values ('now', 'request.done', '{\"id\":7}')")
      .run();
  } finally {
    db.close();
  }

  await waitFor(() => world.launcher.calls(), (calls) => calls.length === 2, 10_000);
  await chatting.output();
  assertStringIncludes(
    (await claudeArg(world, 1, "--append-system-prompt"))!,
    "Request 7 finished.",
  );
  assertStringIncludes((await world.launcher.calls())[1].args[0], "has just opened the chat");
});

for (const hold of ["halt", "daily cap"] as const) {
  withWorld(`an idle chat waits through ${hold} before waking`, async (world) => {
    if (hold === "daily cap") {
      await Deno.mkdir(world.dirs.config, { recursive: true });
      await Deno.writeTextFile(
        join(world.dirs.config, "limits.json"),
        JSON.stringify({ budgets: { dailyUsd: 1 } }),
      );
    }
    const chatting = await idleChat(world);
    if (hold === "halt") {
      assertEquals((await world.kiln("halt")).code, 0);
      await asAgent(
        world,
        "dev-lead",
        (agent) => agent.send("overseer", "question", { question: "Which id should I use?" }),
      );
    } else {
      const db = new DatabaseSync(join(world.dirs.data, "kiln.db"));
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        db.prepare("insert into spend (at, address, request_id, usd) values (?, ?, ?, ?)")
          .run(new Date().toISOString(), "overseer", null, 1);
        db.prepare("insert into events (ts, kind, data) values (?, ?, ?)")
          .run(new Date().toISOString(), "request.done", '{"id":7}');
      } finally {
        db.close();
      }
      const cost = JSON.parse((await world.kiln("cost", "--json")).stdout);
      assertEquals(cost.capReached, true);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assertEquals((await world.launcher.calls()).length, 1);

    if (hold === "halt") {
      assertEquals((await world.kiln("resume")).code, 0);
    } else {
      await Deno.writeTextFile(
        join(world.dirs.config, "limits.json"),
        JSON.stringify({ budgets: { dailyUsd: 10 } }),
      );
    }
    await waitFor(() => world.launcher.calls(), (calls) => calls.length === 2, 10_000);
    await chatting.output();
    assertStringIncludes(
      (await claudeArg(world, 1, "--append-system-prompt"))!,
      hold === "halt" ? "unread message" : "Request 7 finished.",
    );
  });
}

withWorld("mail waits for the end of the turn when the Overseer is mid-turn", async (world) => {
  const chatting = await idleChat(world, 10_000);
  await hook(world, "prompt", { prompt: "hello" });
  await asAgent(
    world,
    "dev-lead",
    (agent) => agent.send("overseer", "question", { question: "Which id should I use?" }),
  );
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  assertEquals((await world.launcher.calls()).length, 1);

  const prompt = await hook(world, "prompt", { prompt: "any news?" });
  assertStringIncludes(prompt.hookSpecificOutput.additionalContext, "read_inbox");
  assertStringIncludes((await hook(world, "stop", {})).reason, "unread message");
  assertEquals(await hook(world, "stop", { stop_hook_active: true }), null);
  await waitFor(() => world.launcher.calls(), (calls) => calls.length === 2, 10_000);
  await chatting.output();
  assertStringIncludes((await claudeArg(world, 1, "--append-system-prompt"))!, "unread message");
});
