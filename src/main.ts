import { call, DaemonNotRunning, ensureDaemon, isRunning, stopDaemon } from "./client.ts";
import { ClaudeNotInstalled, launch } from "./launcher.ts";
import { type DaemonStatus, runDaemon, VERSION } from "./daemon.ts";
import { resolvePaths } from "./paths.ts";
import { resolve } from "@std/path";
import {
  type Commands,
  registerProject,
  RegistrationBlocked,
  RegistrationDeclined,
} from "./register.ts";
import type { Change } from "./manage.ts";
import { runToolServer } from "./toolserver.ts";
import { chatHook, runChat } from "./chat_cli.ts";
import type { ProjectRecord } from "./store.ts";
import type { StopVerdict } from "./router.ts";
import type { CostReport } from "./budgets.ts";
import { money } from "./news.ts";
import {
  describeReport,
  describeTranscript,
  type RequestEvent,
  type RequestListing,
  type RequestReport,
  type TranscriptMessage,
} from "./observe.ts";
import { describeChecks, runDoctor } from "./doctor.ts";
import { needsSetup, runSetup } from "./setup.ts";
import { type Dashboard, openBrowser, startDashboard } from "./dashboard.ts";

const DAEMON_USAGE = "Usage: kiln daemon start|stop|restart|status [--json]";
const LAUNCH_USAGE = "Usage: kiln launch <prompt> [--cwd <dir>] [--max-budget-usd <n>] [--json]";
const REGISTER_USAGE = "Usage: kiln project register <path-or-url>";
const PROJECT_USAGE = `Usage:
  kiln project register <path-or-url>
  kiln project list [--all]
  kiln project pause <name>
  kiln project resume <name>
  kiln project edit <name> [--setup <cmd>] [--test <cmd>] [--lint <cmd>] [--build <cmd>]
  kiln project baseline <name>
  kiln project default-branch <name> <branch>
  kiln project remove <name> [--force]`;
const REQUEST_USAGE = `Usage:
  kiln request list [--all] [--json]
  kiln request start <project> [--playbook <name> --description <text> [--tracker-item <ref>] [--and-fix]]
  kiln request status <request-id> [--json]
  kiln request cancel <request-id>`;
const WATCH_USAGE = "Usage: kiln watch <request-id>";
const TRANSCRIPT_USAGE = "Usage: kiln transcript <request-id> [--json]";
const REPORT_USAGE = "Usage: kiln report <request-id> [--json]";
const ASSIGNMENT_USAGE = `Usage:
  kiln assignment start <request-id> <assignment-message-id>
  kiln assignment merge <assignment-id>`;
const SESSION_USAGE =
  "Usage: kiln session open <address> --role overseer|leader|worker [--department <name>] [--cwd <dir>]";
const ESCALATION_USAGE = `Usage:
  kiln escalations [--all] [--json]
  kiln approve <escalation-id> [--confirm]
  kiln reject <escalation-id> --reason <text>`;
const DASHBOARD_USAGE = "Usage: kiln dashboard [--port <n>] [--no-open]";
const USAGE = `kiln ${VERSION}

Usage:
  ${DAEMON_USAGE.slice("Usage: ".length)}
  kiln backup            Write a safe copy of the store and print its path
  kiln launch <prompt> [--cwd <dir>] [--max-budget-usd <n>] [--json]
                         Run Claude once on a prompt in a directory (default: here)
  kiln project register <path-or-url>
                         Register a project: Kiln clones it, checks it, and records its commands
  kiln project list|pause|resume|edit|baseline|default-branch|remove ...
                         Manage registered projects (see \`kiln project\`)
  kiln request start <project> [--playbook <name> --description <text> [--tracker-item <ref>] [--and-fix]]
                         Start a request: a request branch in its own worktree, and with a
                         playbook, the steps Kiln walks through for it
  kiln request list [--all] [--json]
                         List the requests that are running or waiting (--all: finished ones too)
  kiln request status <request-id> [--json]
                         Show a request, its steps and their assignments
  kiln request cancel <request-id>
                         Cancel a request: its workers stop and it fails; its branches and
                         worktrees stay
  kiln watch <request-id>
                         Follow a request live until it finishes or fails
  kiln transcript <request-id> [--json]
                         What the request's agents said to each other, in order
  kiln report <request-id> [--json]
                         How a request went: its outcome, cost, steps and decisions
  kiln doctor [--json]   Check that this machine is ready: git, Claude, the store, remotes, tools
  kiln setup             Set the spend limits Kiln keeps to (asked on the first run)
  kiln cost [--json]     What was spent today: by project and by request, against the daily cap
  kiln halt              Stop all work: running agents are stopped and nobody is woken until resumed
  kiln resume            Carry on after a halt, and try again the agents Kiln gave up on
  kiln assignment start <request-id> <assignment-message-id>
                         Start an assignment: its own branch and worktree off the request branch
  kiln assignment merge <assignment-id>
                         Merge a verified assignment into its request branch and push it
  kiln escalations [--all] [--json]
                         Show the decisions waiting for you (--all: decided ones too)
  kiln approve <escalation-id> [--confirm]
                         Approve an escalation; only you can
  kiln reject <escalation-id> --reason <text>
                         Reject an escalation, saying why
  kiln dashboard [--port <n>] [--no-open]
                         Serve the Dashboard, a browser window onto Kiln, on 127.0.0.1 until Ctrl-C
  kiln chat              Talk to the Overseer: interactive Claude, with Kiln's tools and status line
  kiln session open ...
                         Open the address an agent works under (see \`kiln session\`)
  kiln tool-server --address <address>
                         Serve one agent's Kiln tools over MCP on stdio (read_inbox, send, raise_question, raise_escalation, read_escalations)
  kiln hook police --address <address>
                         The PreToolUse hook for an agent: refuses tool calls its role does not
                         allow, writes outside its worktree, secrets and destructive commands,
                         and raises each refusal as a question to its leader
  kiln hook stop --address <address>
                         The Stop hook for an agent: reads the hook's JSON on stdin
  kiln --version

Any command that needs the daemon starts it if it is not running.`;

async function main(args: string[]): Promise<number> {
  const [cmd, sub] = args;
  const json = args.includes("--json");

  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return 0;
  }
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }

  if (cmd === "hook" && sub === "chat") return await chatHookCommand(args.slice(2));
  if (cmd === "hook") return await hookCommand(sub, args.slice(2));

  const paths = resolvePaths();

  // The first time a person uses Kiln at a terminal, ask for the spend limits.
  const asksFirst = !json &&
    !["daemon", "tool-server", "setup", "doctor", "dashboard"].includes(cmd);
  if (asksFirst && Deno.stdin.isTerminal() && Deno.stdout.isTerminal() && await needsSetup(paths)) {
    await setupCommand();
  }

  switch (cmd) {
    case "daemon":
      return await daemonCommand(sub, json);
    case "backup": {
      await ensureDaemon(paths);
      const { path } = await call<{ path: string }>(paths, "backup");
      console.log(path);
      return 0;
    }
    case "dashboard":
      return await dashboardCommand(args.slice(1));
    case "chat":
      if (args.length > 1) {
        console.error("Usage: kiln chat");
        return 2;
      }
      try {
        return await runChat(paths);
      } catch (err) {
        if (err instanceof ClaudeNotInstalled) {
          console.error(err.message);
          return 1;
        }
        throw err;
      }
    case "launch":
      return await launchCommand(args.slice(1));
    case "project":
      return await projectCommand(sub, args.slice(2));
    case "halt":
    case "resume":
      return await haltCommand(cmd, args.slice(1));
    case "cost": {
      if (args.slice(1).some((a) => a !== "--json")) {
        console.error("Usage: kiln cost [--json]");
        return 2;
      }
      await ensureDaemon(paths);
      const report = await call<CostReport>(paths, "cost.report");
      console.log(json ? JSON.stringify(report, null, 2) : describeCost(report));
      return 0;
    }
    case "watch":
    case "transcript":
    case "report":
      return await observeCommand(cmd, args.slice(1));
    case "doctor": {
      if (args.slice(1).some((a) => a !== "--json")) {
        console.error("Usage: kiln doctor [--json]");
        return 2;
      }
      const checks = await runDoctor(paths);
      console.log(json ? JSON.stringify(checks, null, 2) : describeChecks(checks));
      return checks.some((c) => c.status === "fail") ? 1 : 0;
    }
    case "setup":
      if (args.length > 1) {
        console.error("Usage: kiln setup");
        return 2;
      }
      await setupCommand();
      return 0;
    case "request":
      return sub === "list"
        ? await requestListCommand(args.slice(2))
        : sub === "status" || sub === "cancel" ||
            (sub === "start" && args.slice(2).some((a) => a.startsWith("-")))
        ? await requestCommand(sub, args.slice(2))
        : await worktreeCommand(sub === "start" ? "requests.start" : "", args.slice(2));
    case "assignment":
      return await worktreeCommand(
        sub === "start" ? "assignments.start" : sub === "merge" ? "assignments.merge" : "",
        args.slice(2),
      );
    case "session":
      return await sessionCommand(sub, args.slice(2));
    case "escalations":
    case "approve":
    case "reject":
      return await escalationCommand(cmd, args.slice(1));
    case "tool-server": {
      const address = flagValue(args.slice(1), "--address");
      if (!address) {
        console.error("Usage: kiln tool-server --address <address>");
        return 2;
      }
      await runToolServer(paths, address);
      return 0;
    }
    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }

  async function worktreeCommand(method: string, rest: string[]): Promise<number> {
    const usage = cmd === "request" ? REQUEST_USAGE : ASSIGNMENT_USAGE;
    const expected = method === "assignments.start" ? 2 : 1;
    if (!method || rest.length !== expected || rest.some((arg) => arg.startsWith("-"))) {
      console.error(usage);
      return 2;
    }
    const target = method === "requests.start"
      ? { project: rest[0] }
      : method === "assignments.start"
      ? { requestId: Number(rest[0]), assignmentId: Number(rest[1]) }
      : { id: Number(rest[0]) };
    if (method !== "requests.start" && !rest.every((arg) => /^\d+$/.test(arg))) {
      console.error(usage);
      return 2;
    }
    await ensureDaemon(paths);
    try {
      const r = await call<{
        requestId?: number;
        assignmentId?: number;
        path?: string;
        branch: string;
        requestBranch?: string;
        env?: Record<string, string>;
      }>(paths, method, target);
      if (method === "assignments.merge") {
        console.log(
          `Merged ${r.branch} into ${r.requestBranch} and pushed ${r.requestBranch}.`,
        );
        return 0;
      }
      console.log(
        method === "requests.start"
          ? `Started request ${r.requestId} on ${rest[0]}.`
          : `Started assignment ${r.assignmentId} of request ${r.requestId}.`,
      );
      console.log(`Branch: ${r.branch}`);
      console.log(`Worktree: ${r.path}`);
      for (const [key, value] of Object.entries(r.env!)) console.log(`${key}=${value}`);
      return 0;
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
  }

  async function dashboardCommand(rest: string[]): Promise<number> {
    let port: number | undefined;
    let open = true;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--no-open") open = false;
      else if (rest[i] === "--port" && /^\d+$/.test(rest[i + 1] ?? "")) port = Number(rest[++i]);
      else {
        console.error(DASHBOARD_USAGE);
        return 2;
      }
    }
    if (port !== undefined && port > 65535) {
      console.error(DASHBOARD_USAGE);
      return 2;
    }
    let dashboard: Dashboard;
    try {
      dashboard = startDashboard(paths, { port });
    } catch (err) {
      console.error(`Could not start the Dashboard: ${(err as Error).message}`);
      return 1;
    }
    console.log(dashboard.url);
    console.error("Press Ctrl-C to stop the Dashboard.");
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      Deno.addSignalListener(signal, () => void dashboard.stop());
    }
    if (open) openBrowser(dashboard.openUrl);
    await dashboard.finished;
    return 0;
  }

  async function setupCommand(): Promise<void> {
    await runSetup(paths, {
      say: console.log,
      ask: async (question) => {
        Deno.stdout.writeSync(new TextEncoder().encode(question));
        return await readLine();
      },
    });
  }

  async function requestListCommand(rest: string[]): Promise<number> {
    if (rest.some((a) => a !== "--all" && a !== "--json")) {
      console.error(REQUEST_USAGE);
      return 2;
    }
    await ensureDaemon(paths);
    const list = await call<RequestListing[]>(paths, "requests.list", {
      all: rest.includes("--all"),
    });
    if (rest.includes("--json")) console.log(JSON.stringify(list));
    else if (!list.length) console.log("No requests are running.");
    else {
      for (const r of list) {
        console.log(
          `Request ${r.id}  ${r.project}  ${r.status}  ${r.playbook ?? "no playbook"}  ${
            money(r.costUsd)
          }${r.description ? `  ${r.description.split("\n")[0].slice(0, 60)}` : ""}`,
        );
      }
    }
    return 0;
  }

  /** `kiln watch|transcript|report <request-id>`: looking at a request without touching it. */
  async function observeCommand(verb: string, rest: string[]): Promise<number> {
    const usage = verb === "watch"
      ? WATCH_USAGE
      : verb === "report"
      ? REPORT_USAGE
      : TRANSCRIPT_USAGE;
    const [target, ...flags] = rest;
    const jsonOk = verb !== "watch";
    if (
      !target || !/^\d+$/.test(target) || flags.some((f) => !(jsonOk && f === "--json"))
    ) {
      console.error(usage);
      return 2;
    }
    const id = Number(target);
    const asJson = flags.length > 0;
    try {
      await ensureDaemon(paths);
      if (verb === "transcript") {
        const messages = await call<TranscriptMessage[]>(paths, "requests.transcript", { id });
        console.log(asJson ? JSON.stringify(messages, null, 2) : describeTranscript(messages));
        return 0;
      }
      if (verb === "report") {
        const report = await call<RequestReport>(paths, "requests.report", { id });
        console.log(asJson ? JSON.stringify(report, null, 2) : describeReport(report));
        return 0;
      }
      let after = 0;
      while (true) {
        const r = await call<
          { events: RequestEvent[]; last: number; status: string; failure: string | null }
        >(
          paths,
          "requests.events",
          { id, after },
        );
        for (const e of r.events) console.log(`${e.ts}  ${e.text}`);
        after = r.last;
        if (r.status === "done") return 0;
        if (r.status === "failed") {
          console.log(`Request ${id} failed${r.failure ? `: ${r.failure}` : "."}`);
          return 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
  }

  async function haltCommand(verb: "halt" | "resume", rest: string[]): Promise<number> {
    if (rest.length) {
      console.error(`Usage: kiln ${verb}`);
      return 2;
    }
    await ensureDaemon(paths);
    try {
      if (verb === "halt") {
        const r = await call<{ changed: boolean }>(paths, "kiln.halt", { via: "cli" });
        console.log(
          r.changed
            ? "Kiln is halted: running agents were stopped and nobody will be woken. " +
              "Run `kiln resume` to carry on."
            : "Kiln is already halted.",
        );
      } else {
        const r = await call<{ wasHalted: boolean; stuck: number }>(paths, "kiln.resume", {
          via: "cli",
        });
        console.log(
          r.wasHalted || r.stuck
            ? "Kiln is resumed." +
              (r.stuck ? ` ${r.stuck} agent(s) Kiln had given up on will be tried again.` : "")
            : "Kiln is not halted.",
        );
      }
      return 0;
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
  }

  async function requestCommand(sub: string, rest: string[]): Promise<number> {
    const usage = () => {
      console.error(REQUEST_USAGE);
      return 2;
    };
    const [target, ...flags] = rest;
    if (!target || target.startsWith("-")) return usage();
    if (sub === "status") {
      if (!/^\d+$/.test(target) || flags.some((f) => f !== "--json")) return usage();
      await ensureDaemon(paths);
      try {
        const r = await call<RequestStatus>(paths, "requests.status", { id: Number(target) });
        console.log(flags.length ? JSON.stringify(r) : describeRequest(r));
        return 0;
      } catch (err) {
        console.error((err as Error).message);
        return 1;
      }
    }
    if (sub === "cancel") {
      if (!/^\d+$/.test(target) || flags.length) return usage();
      await ensureDaemon(paths);
      try {
        await call(paths, "requests.cancel", { id: Number(target), via: "cli" });
        console.log(
          `Cancelled request ${target}. Its branches and worktrees are kept; nothing was removed.`,
        );
        return 0;
      } catch (err) {
        console.error((err as Error).message);
        return 1;
      }
    }
    // --and-fix takes no value: once the playbook has published a fix ticket, a fix request follows.
    const andFix = flags.includes("--and-fix");
    if (andFix) flags.splice(flags.indexOf("--and-fix"), 1);
    if (flags.includes("--and-fix")) return usage();
    const values: Record<string, string> = {};
    for (let i = 0; i < flags.length; i += 2) {
      if (!["--playbook", "--description", "--tracker-item"].includes(flags[i])) return usage();
      if (flags[i + 1] === undefined || values[flags[i]] !== undefined) return usage();
      values[flags[i]] = flags[i + 1];
    }
    if (!values["--playbook"] || !values["--description"]?.trim()) return usage();
    if ("--tracker-item" in values && !values["--tracker-item"].trim()) return usage();
    await ensureDaemon(paths);
    try {
      const r = await call<{ requestId: number; branch: string; path: string }>(
        paths,
        "requests.start",
        {
          project: target,
          playbook: values["--playbook"],
          description: values["--description"],
          trackerItem: values["--tracker-item"],
          andFix,
        },
      );
      console.log(`Started request ${r.requestId} on ${target}, playbook ${values["--playbook"]}.`);
      console.log(`Branch: ${r.branch}`);
      console.log(`Worktree: ${r.path}`);
      return 0;
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
  }

  async function escalationCommand(verb: string, rest: string[]): Promise<number> {
    const usage = () => {
      console.error(ESCALATION_USAGE);
      return 2;
    };
    if (verb === "escalations") {
      if (rest.some((a) => a !== "--all" && a !== "--json")) return usage();
      await ensureDaemon(paths);
      try {
        const list = await call<EscalationView[]>(paths, "escalations.list", {
          all: rest.includes("--all"),
        });
        if (rest.includes("--json")) console.log(JSON.stringify(list));
        else if (!list.length) console.log("No escalations are waiting for you.");
        else for (const e of list) console.log(describeEscalation(e));
        return 0;
      } catch (err) {
        console.error((err as Error).message);
        return 1;
      }
    }
    const [target, ...flags] = rest;
    if (!target || !/^\d+$/.test(target)) return usage();
    let reason: string | undefined;
    if (verb === "reject") {
      if (flags.length !== 2 || flags[0] !== "--reason") return usage();
      reason = flags[1];
      if (!reason.trim()) {
        console.error("Say why with --reason <text>: a rejection needs a reason.");
        return 2;
      }
    } else if (flags.length > 1 || (flags.length && flags[0] !== "--confirm")) return usage();
    await ensureDaemon(paths);
    try {
      const e = await call<EscalationView>(paths, "escalations.decide", {
        id: Number(target),
        approved: verb === "approve",
        reason,
        confirm: flags[0] === "--confirm",
        via: "cli",
        // Set for anything an agent runs, so that the daemon can tell it from the user.
        agent: Deno.env.get("KILN_AGENT"),
      });
      console.log(`${verb === "approve" ? "Approved" : "Rejected"} escalation ${e.id}.`);
      return 0;
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
  }

  async function sessionCommand(sub: string | undefined, rest: string[]): Promise<number> {
    const usage = () => {
      console.error(SESSION_USAGE);
      return 2;
    };
    if (sub !== "open") return usage();
    const [address, ...flags] = rest;
    if (!address || address.startsWith("-") || flags.length % 2) return usage();
    const values: Record<string, string> = {};
    for (let i = 0; i < flags.length; i += 2) {
      if (!["--role", "--department", "--cwd"].includes(flags[i])) return usage();
      values[flags[i]] = flags[i + 1];
    }
    if (!values["--role"]) return usage();
    await ensureDaemon(paths);
    try {
      await call(paths, "sessions.open", {
        address,
        role: values["--role"],
        department: values["--department"] ?? null,
        cwd: resolve(values["--cwd"] ?? Deno.cwd()),
      });
    } catch (err) {
      console.error(`Cannot open session: ${(err as Error).message}`);
      return 1;
    }
    console.log(`Opened ${values["--role"]} session "${address}".`);
    return 0;
  }

  /** The hooks and status line of the Overseer chat: `kiln hook chat <event> --chat <id>`. */
  async function chatHookCommand(rest: string[]): Promise<number> {
    const [event, ...flags] = rest;
    const id = Number(flagValue(flags, "--chat"));
    if (!["prompt", "stop", "status-line"].includes(event) || !Number.isSafeInteger(id)) {
      console.error("Usage: kiln hook chat prompt|stop|status-line --chat <id>");
      return 2;
    }
    return await chatHook(resolvePaths(), event, id);
  }

  /** Hook commands for an agent's Claude session; they speak Claude Code's hook protocol. */
  async function hookCommand(sub: string | undefined, rest: string[]): Promise<number> {
    const address = flagValue(rest, "--address");
    if ((sub !== "stop" && sub !== "police") || !address) {
      console.error("Usage: kiln hook stop|police --address <address>");
      return 2;
    }
    if (sub === "police") return await policeHook(address);
    let input: { stop_hook_active?: boolean } = {};
    try {
      input = JSON.parse(await new Response(Deno.stdin.readable).text() || "{}");
    } catch { /* an unreadable hook payload counts as a first attempt */ }
    try {
      const hookPaths = resolvePaths();
      await ensureDaemon(hookPaths);
      const verdict = await call<StopVerdict>(hookPaths, "router.stopCheck", {
        address,
        alreadyBlocked: input.stop_hook_active === true,
      });
      if (verdict.block) {
        console.log(JSON.stringify({ decision: "block", reason: verdict.reason }));
      }
      return 0;
    } catch (err) {
      console.log(JSON.stringify({
        decision: "block",
        reason: `Kiln could not check pending work: ${(err as Error).message}`,
      }));
      return 0;
    }
  }

  /** The PreToolUse hook: refuses a tool call outside what the agent's role permits. */
  async function policeHook(address: string): Promise<number> {
    const refuse = (reason: string) =>
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }));
    let input: { tool_name?: string; tool_input?: Record<string, unknown> };
    try {
      input = JSON.parse(await new Response(Deno.stdin.readable).text());
    } catch {
      refuse("Kiln could not read the tool call to check it");
      return 0;
    }
    try {
      const hookPaths = resolvePaths();
      await ensureDaemon(hookPaths);
      const verdict = await call<{ allowed: boolean; reason?: string }>(
        hookPaths,
        "router.police",
        {
          address,
          tool: input.tool_name ?? "",
          input: input.tool_input ?? {},
        },
      );
      if (!verdict.allowed) refuse(verdict.reason ?? "denied by Kiln");
    } catch (err) {
      refuse(`Kiln could not check this call: ${(err as Error).message}`);
    }
    return 0;
  }

  async function projectCommand(sub: string | undefined, rest: string[]): Promise<number> {
    const usage = () => {
      console.error(PROJECT_USAGE);
      return 2;
    };
    const flagsOnly = (allowed: string[]) => rest.slice(1).every((a) => allowed.includes(a));
    switch (sub) {
      case "register":
        return await registerCommand(rest);
      case "list": {
        if (rest.length > 1 || (rest[0] && rest[0] !== "--all")) return usage();
        await ensureDaemon(paths);
        const projects = await call<ProjectRecord[]>(paths, "projects.list", {
          includeRemoved: rest[0] === "--all",
        });
        if (!projects.length) console.log("No projects registered.");
        for (const p of projects) console.log(describeProject(p));
        return 0;
      }
      case "pause":
      case "resume": {
        if (rest.length !== 1 || rest[0].startsWith("-")) return usage();
        const paused = sub === "pause";
        const name = rest[0];
        await ensureDaemon(paths);
        try {
          const { changed } = await call<{ changed: boolean }>(paths, "projects.pause", {
            name,
            paused,
          });
          console.log(
            changed
              ? paused
                ? `Paused ${name}: it takes no new requests until you resume it.`
                : `Resumed ${name}.`
              : `${name} is already ${paused ? "paused" : "active"}.`,
          );
          return 0;
        } catch (err) {
          console.error((err as Error).message);
          return 1;
        }
      }
      case "edit": {
        const change: Change = {};
        const fields: Record<string, keyof Change> = {
          "--setup": "setupCommand",
          "--test": "testCommand",
          "--lint": "lintCommand",
          "--build": "buildCommand",
        };
        const [name, ...flags] = rest;
        if (!name || name.startsWith("-") || !flags.length) return usage();
        for (let i = 0; i < flags.length; i += 2) {
          const field = fields[flags[i]];
          const value = flags[i + 1];
          if (!field || value === undefined) return usage();
          // An empty command clears it.
          (change as Record<string, string | null>)[field] = value.trim() || null;
        }
        return await recheckAndRecord(name, change, "Edited");
      }
      case "baseline": {
        if (rest.length !== 1 || rest[0].startsWith("-")) return usage();
        return await recheckAndRecord(rest[0], {}, "Re-ran the baseline of", true);
      }
      case "default-branch": {
        if (rest.length !== 2 || rest.some((a) => a.startsWith("-"))) return usage();
        return await recheckAndRecord(
          rest[0],
          { defaultBranch: rest[1] },
          "Changed the default branch of",
        );
      }
      case "remove": {
        if (!rest.length || rest[0].startsWith("-") || !flagsOnly(["--force"])) return usage();
        const force = rest.includes("--force");
        await ensureDaemon(paths);
        try {
          await call(paths, "projects.remove", { name: rest[0], force });
        } catch (err) {
          console.error(`Cannot remove: ${(err as Error).message}`);
          return 1;
        }
        console.log(
          `Removed ${rest[0]}. Its clone is deleted; its history is kept.`,
        );
        return 0;
      }
      default:
        return usage();
    }
  }

  async function recheckAndRecord(
    name: string,
    change: Change,
    done: string,
    baselineOnly = false,
  ): Promise<number> {
    try {
      await ensureDaemon(paths);
      const result = await call<{
        project?: ProjectRecord;
        progress: string[];
        blocked?: string;
      }>(paths, "projects.recheck", { name, change, baselineOnly });
      for (const message of result.progress) console.log(message);
      if (result.blocked) {
        console.error(
          `Re-check blocked: ${result.blocked}\nThe project record was not changed. Setup may have left files in Kiln's clone.`,
        );
        return 1;
      }
      const updated = result.project!;
      for (const w of updated.warnings) console.log(`warning: ${w}`);
      console.log(describeBaseline(updated));
      console.log(`${done} ${name}.`);
      return 0;
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
  }

  async function registerCommand(rest: string[]): Promise<number> {
    if (rest.length !== 1 || rest[0].startsWith("-")) {
      console.error(REGISTER_USAGE);
      return 2;
    }
    await ensureDaemon(paths);
    const existing = await call<ProjectRecord[]>(paths, "projects.list");
    try {
      const project = await registerProject(rest[0], {
        projectsDir: paths.projects,
        existingNames: existing.map((p) => p.name),
        launch,
        progress: console.log,
        confirm: async (commands) => {
          console.log(describeCommands(commands));
          Deno.stdout.writeSync(new TextEncoder().encode("Use these commands? [y/N] "));
          return /^y(es)?$/i.test((await readLine())?.trim() ?? "");
        },
        record: async (p) => {
          await call(paths, "projects.add", { ...p });
        },
      });
      for (const w of project.warnings) console.log(`warning: ${w}`);
      console.log(describeBaseline(project, true));
      console.log(`Registered ${project.name} (clone: ${project.clonePath})`);
      return 0;
    } catch (err) {
      if (err instanceof RegistrationBlocked) {
        console.error(`Registration blocked: ${err.message}`);
        return 1;
      }
      if (err instanceof RegistrationDeclined) {
        console.error(`Registration cancelled: ${err.message}`);
        return 1;
      }
      if (err instanceof ClaudeNotInstalled) {
        console.error(`Registration blocked: ${err.message}`);
        return 1;
      }
      throw err;
    }
  }

  async function launchCommand(rest: string[]): Promise<number> {
    let cwd = Deno.cwd();
    let maxBudgetUsd: number | undefined;
    let asJson = false;
    const promptParts: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--json") {
        asJson = true;
      } else if (arg === "--cwd" || arg === "--max-budget-usd") {
        const value = rest[++i];
        if (!value || value.startsWith("--")) {
          console.error(LAUNCH_USAGE);
          return 2;
        }
        if (arg === "--cwd") cwd = resolve(value);
        else maxBudgetUsd = Number(value);
      } else {
        promptParts.push(arg);
      }
    }
    const prompt = promptParts.join(" ");
    if (!prompt || (maxBudgetUsd !== undefined && !(maxBudgetUsd > 0))) {
      console.error(LAUNCH_USAGE);
      return 2;
    }
    try {
      await ensureDaemon(paths);
      const env = await call<Record<string, string>>(paths, "worktrees.environment", { path: cwd });
      const result = await launch({ prompt, cwd, maxBudgetUsd, env });
      if (asJson) console.log(JSON.stringify({ ...result, sessionId: undefined }));
      else if (result.ok) console.log(result.text);
      else console.error(`claude stopped: ${result.outcome}: ${result.text}`);
      return result.ok ? 0 : 1;
    } catch (err) {
      if (err instanceof ClaudeNotInstalled) {
        console.error(err.message);
        return 1;
      }
      throw err;
    }
  }

  async function daemonCommand(
    sub: string | undefined,
    json: boolean,
  ): Promise<number> {
    switch (sub) {
      case "run": // internal: the process the CLI spawns
        await runDaemon(paths);
        return 0;
      case "start": {
        const started = await ensureDaemon(paths);
        const { pid } = await call<{ pid: number }>(paths, "ping");
        console.log(
          started ? `kiln daemon started (pid ${pid})` : `kiln daemon already running (pid ${pid})`,
        );
        return 0;
      }
      case "stop":
        console.log(
          (await stopDaemon(paths)) ? "kiln daemon stopped" : "kiln daemon is not running",
        );
        return 0;
      case "restart": {
        await stopDaemon(paths);
        await ensureDaemon(paths);
        const { pid } = await call<{ pid: number }>(paths, "ping");
        console.log(`kiln daemon restarted (pid ${pid})`);
        return 0;
      }
      case "status": {
        if (!(await isRunning(paths))) {
          console.log(json ? JSON.stringify({ running: false }) : "kiln daemon is not running");
          return 3;
        }
        const s = await call<DaemonStatus>(paths, "status");
        if (json) console.log(JSON.stringify(s, null, 2));
        else {
          console.log(
            `kiln daemon running (pid ${s.pid}, version ${s.version}, since ${s.startedAt})`,
          );
          console.log(
            `  store   ${s.paths.store} (schema ${s.store.schemaVersion}, ${s.store.journalMode})`,
          );
          console.log(`  socket  ${s.paths.socket}`);
          console.log(`  log     ${s.paths.log}`);
          if (s.haltedSince) console.log(`  HALTED  since ${s.haltedSince}; run \`kiln resume\``);
        }
        return 0;
      }
      default:
        console.error(DAEMON_USAGE);
        return 2;
    }
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  const value = i >= 0 ? args[i + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function describeBaseline(p: { baseline: ProjectRecord["baseline"] }, registering = false): string {
  const b = p.baseline;
  if (!b) return "Test baseline: not recorded (no test command).";
  if (b.passed) return "Test baseline: passing.";
  return `Test baseline: FAILING (exit ${b.exitCode}); ${
    registering ? "the project is registered with" : "the project has"
  } its tests already red.`;
}

interface EscalationView {
  id: number;
  raisedBy: string;
  requestId: number | null;
  summary: string;
  detail: string | null;
  status: string;
  reason: string | null;
  page?: string | null;
}

function describeEscalation(e: EscalationView): string {
  const lines = [
    `Escalation ${e.id} [${e.status}]${
      e.requestId === null ? "" : ` (request ${e.requestId})`
    }: ${e.summary}`,
  ];
  if (e.detail) lines.push(`  ${e.detail}`);
  if (e.reason) lines.push(`  Reason: ${e.reason}`);
  if (e.status === "open") {
    if (e.page) lines.push(`  Page: ${e.page}`);
    lines.push(`  Decide: kiln approve ${e.id}  or  kiln reject ${e.id} --reason <text>`);
  }
  return lines.join("\n");
}

interface RequestStatus {
  id: number;
  project: string;
  status: string;
  playbook: string | null;
  description: string | null;
  trackerItem: string | null;
  branch: string | null;
  ticketUrl: string | null;
  ticketUrls: string[];
  andFix?: boolean;
  fixRequestId?: number | null;
  prUrl: string | null;
  failure: string | null;
  costUsd: number;
  budgetUsd: number | null;
  steps: {
    position: number;
    name: string;
    department: string;
    status: string;
    retries: number;
    failure: string | null;
    assignments: {
      id: number;
      worker: string;
      status: string;
      branch: string | null;
      worktree: string | null;
      merged: boolean;
      owns: string[];
      turnsUsed: number;
      spendUsd: number;
      limitReached: string | null;
    }[];
  }[];
}

function describeRequest(r: RequestStatus): string {
  const lines = [`Request ${r.id} on ${r.project}: ${r.status}`];
  if (r.playbook) lines.push(`Playbook: ${r.playbook}`);
  if (r.description) lines.push(`Description: ${r.description}`);
  if (r.trackerItem) lines.push(`Tracker item: ${r.trackerItem}`);
  if (r.branch) lines.push(`Branch: ${r.branch}`);
  for (const s of r.steps) {
    const retried = s.retries ? `, retried ${s.retries} time${s.retries === 1 ? "" : "s"}` : "";
    lines.push(`Step ${s.position} ${s.name} (${s.department}): ${s.status}${retried}`);
    for (const a of s.assignments) {
      const where = a.branch ?? "waiting to start";
      const limit = a.limitReached ? `, stopped at its ${a.limitReached} limit` : "";
      lines.push(
        `  Assignment ${a.id} (${a.worker}): ${a.status}${
          a.merged ? ", merged" : ""
        }, ${where}${limit}`,
      );
    }
  }
  if (r.ticketUrl) lines.push(`Ticket: ${r.ticketUrl}`);
  for (const url of r.ticketUrls ?? []) lines.push(`Ticket: ${url}`);
  if (r.fixRequestId) lines.push(`Fix request: ${r.fixRequestId}`);
  if (r.prUrl) lines.push(`Pull request: ${r.prUrl}`);
  if (r.failure) lines.push(`Failure: ${r.failure}`);
  if (r.costUsd > 0 || r.budgetUsd !== null) {
    lines.push(
      `Cost: ${money(r.costUsd)}${
        r.budgetUsd === null ? "" : ` of a ${money(r.budgetUsd)} budget`
      }`,
    );
  }
  return lines.join("\n");
}

function describeCost(r: CostReport): string {
  const lines = [
    `Today (${r.day}): ${money(r.todayUsd)}` +
    (r.capUsd === null
      ? ""
      : ` of the ${money(r.capUsd)} daily cap${
        r.capReached ? " (cap reached: nobody is woken)" : ""
      }`),
  ];
  if (r.projects.length) {
    lines.push("By project:", ...r.projects.map((p) => `  ${p.name}  ${money(p.usd)}`));
  }
  if (r.requests.length) {
    lines.push(
      "By request:",
      ...r.requests.map((q) =>
        `  Request ${q.id} (${q.project}, ${q.status})  ${money(q.usd)} today` +
        (q.totalUsd > q.usd ? `, ${money(q.totalUsd)} in all` : "") +
        (q.budgetUsd === null ? "" : `, budget ${money(q.budgetUsd)}`)
      ),
    );
  }
  if (r.otherUsd > 0) lines.push(`Not part of a request: ${money(r.otherUsd)}`);
  return lines.join("\n");
}

function describeProject(p: ProjectRecord): string {
  const state = p.removedAt ? "removed" : p.paused ? "paused" : "active";
  const b = p.baseline
    ? (p.baseline.passed ? "baseline passing" : "baseline FAILING")
    : "no baseline";
  return `${p.name}  ${state}  ${p.defaultBranch}@${p.headCommit.slice(0, 7)}  ${b}`;
}

function describeCommands(c: Commands): string {
  const row = (label: string, cmd: string | null) => `  ${label.padEnd(6)} ${cmd ?? "(none)"}`;
  return [
    "The onboarding agent proposes these commands:",
    row("setup", c.setup),
    row("test", c.test),
    row("lint", c.lint),
    row("build", c.build),
  ].join("\n");
}

/** What was read from stdin past the end of the last line returned. */
let pending = "";
/** Read one line from stdin; null at end of input. Input beyond the line is kept for the next. */
async function readLine(): Promise<string | null> {
  const dec = new TextDecoder();
  const buf = new Uint8Array(1024);
  while (true) {
    const i = pending.indexOf("\n");
    if (i >= 0) {
      const line = pending.slice(0, i);
      pending = pending.slice(i + 1);
      return line;
    }
    const n = await Deno.stdin.read(buf);
    if (n === null) {
      const rest = pending;
      pending = "";
      return rest || null;
    }
    pending += dec.decode(buf.subarray(0, n), { stream: true });
  }
}

try {
  Deno.exit(await main(Deno.args));
} catch (err) {
  console.error(err instanceof DaemonNotRunning ? err.message : `kiln: ${(err as Error).message}`);
  Deno.exit(1);
}
