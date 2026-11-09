// Fake `gh`. Two commands are scripted, each from its own queue under $KILN_FAKE_DIR:
//  - `gh pr view <branch> --json ...` consumes the next status from pr-status/script.json and
//    prints it as JSON.
//  - `gh api ...` (branch protection) consumes the next reply from api/script.json and replays
//    its stdout, stderr and exit code.
//  - `gh pr create ...` consumes the next reply from pr-create/script.json; `gh pr comment ...`
//    succeeds. Both are recorded (the pull requests Kiln opens and comments on).
//  - `gh issue close ...` succeeds and is recorded.
//  - `gh issue view ...` replies from issue-view/script.json, then finds the ticket open.
//  - `gh issue create ...` consumes the next reply from issue/script.json the same way (the
//    ticket tracker).
// Every call is recorded. Once a queue is exhausted its command fails loudly (exit 99).
import { join } from "node:path";

if (Deno.args[0] === "--version") {
  console.log("gh version 9.9.9");
  Deno.exit(0);
}

if (Deno.args[0] === "api") {
  const apiDir = join(Deno.env.get("KILN_FAKE_DIR") ?? "", "api");
  const apiFile = join(apiDir, "script.json");
  Deno.mkdirSync(apiDir, { recursive: true });
  Deno.writeTextFileSync(
    join(apiDir, "calls.jsonl"),
    JSON.stringify({ args: Deno.args, cwd: Deno.cwd() }) + "\n",
    {
      append: true,
    },
  );
  let apiScript: { replies: { stdout?: string; stderr?: string; exit?: number }[]; next: number };
  try {
    apiScript = JSON.parse(Deno.readTextFileSync(apiFile));
  } catch {
    apiScript = { replies: [], next: 0 };
  }
  const reply = apiScript.replies[apiScript.next];
  if (!reply) {
    console.error("fake gh: no scripted api reply left");
    Deno.exit(99);
  }
  apiScript.next++;
  Deno.writeTextFileSync(apiFile, JSON.stringify(apiScript));
  if (reply.stdout) await Deno.stdout.write(new TextEncoder().encode(reply.stdout));
  if (reply.stderr) await Deno.stderr.write(new TextEncoder().encode(reply.stderr));
  Deno.exit(reply.exit ?? 0);
}

if (Deno.args[0] === "issue" && Deno.args[1] === "close") {
  // `gh issue close` just succeeds; the call is recorded.
  const closeDir = join(Deno.env.get("KILN_FAKE_DIR") ?? "", "issue-close");
  Deno.mkdirSync(closeDir, { recursive: true });
  Deno.writeTextFileSync(
    join(closeDir, "calls.jsonl"),
    JSON.stringify({ args: Deno.args, cwd: Deno.cwd() }) + "\n",
    { append: true },
  );
  Deno.exit(0);
}

if (Deno.args[0] === "issue" && Deno.args[1] === "view") {
  // `gh issue view` replies from issue-view/script.json; once that is used up, the ticket is
  // found (open). Calls are recorded.
  const viewDir = join(Deno.env.get("KILN_FAKE_DIR") ?? "", "issue-view");
  const viewFile = join(viewDir, "script.json");
  Deno.mkdirSync(viewDir, { recursive: true });
  Deno.writeTextFileSync(
    join(viewDir, "calls.jsonl"),
    JSON.stringify({ args: Deno.args, cwd: Deno.cwd() }) + "\n",
    { append: true },
  );
  let viewScript: { replies: { stdout?: string; stderr?: string; exit?: number }[]; next: number };
  try {
    viewScript = JSON.parse(Deno.readTextFileSync(viewFile));
  } catch {
    viewScript = { replies: [], next: 0 };
  }
  const reply = viewScript.replies[viewScript.next] ?? { stdout: '{"state":"OPEN"}\n' };
  viewScript.next++;
  Deno.writeTextFileSync(viewFile, JSON.stringify(viewScript));
  if (reply.stdout) await Deno.stdout.write(new TextEncoder().encode(reply.stdout));
  if (reply.stderr) await Deno.stderr.write(new TextEncoder().encode(reply.stderr));
  Deno.exit(reply.exit ?? 0);
}

if (Deno.args[0] === "issue" && Deno.args[1] === "create") {
  const issueDir = join(Deno.env.get("KILN_FAKE_DIR") ?? "", "issue");
  const issueFile = join(issueDir, "script.json");
  Deno.mkdirSync(issueDir, { recursive: true });
  Deno.writeTextFileSync(
    join(issueDir, "calls.jsonl"),
    JSON.stringify({ args: Deno.args, cwd: Deno.cwd() }) + "\n",
    { append: true },
  );
  let issueScript: { replies: { stdout?: string; stderr?: string; exit?: number }[]; next: number };
  try {
    issueScript = JSON.parse(Deno.readTextFileSync(issueFile));
  } catch {
    issueScript = { replies: [], next: 0 };
  }
  const reply = issueScript.replies[issueScript.next];
  if (!reply) {
    console.error("fake gh: no scripted issue reply left");
    Deno.exit(99);
  }
  issueScript.next++;
  Deno.writeTextFileSync(issueFile, JSON.stringify(issueScript));
  if (reply.stdout) await Deno.stdout.write(new TextEncoder().encode(reply.stdout));
  if (reply.stderr) await Deno.stderr.write(new TextEncoder().encode(reply.stderr));
  Deno.exit(reply.exit ?? 0);
}

if (Deno.args[0] === "pr" && (Deno.args[1] === "create" || Deno.args[1] === "comment")) {
  // `gh pr create` replies from pr-create/script.json; `gh pr comment` just succeeds.
  const tool = Deno.args[1] === "create" ? "pr-create" : "pr-comment";
  const prDir = join(Deno.env.get("KILN_FAKE_DIR") ?? "", tool);
  const prFile = join(prDir, "script.json");
  Deno.mkdirSync(prDir, { recursive: true });
  Deno.writeTextFileSync(
    join(prDir, "calls.jsonl"),
    JSON.stringify({ args: Deno.args, cwd: Deno.cwd() }) + "\n",
    { append: true },
  );
  if (tool === "pr-comment") Deno.exit(0);
  let prScript: { replies: { stdout?: string; stderr?: string; exit?: number }[]; next: number };
  try {
    prScript = JSON.parse(Deno.readTextFileSync(prFile));
  } catch {
    prScript = { replies: [], next: 0 };
  }
  const reply = prScript.replies[prScript.next];
  if (!reply) {
    console.error("fake gh: no scripted pr create reply left");
    Deno.exit(99);
  }
  prScript.next++;
  Deno.writeTextFileSync(prFile, JSON.stringify(prScript));
  if (reply.stdout) await Deno.stdout.write(new TextEncoder().encode(reply.stdout));
  if (reply.stderr) await Deno.stderr.write(new TextEncoder().encode(reply.stderr));
  Deno.exit(reply.exit ?? 0);
}

const dir = join(Deno.env.get("KILN_FAKE_DIR") ?? "", "pr-status");
const scriptFile = join(dir, "script.json");
const script: { statuses: unknown[]; next: number } = JSON.parse(
  Deno.readTextFileSync(scriptFile),
);

Deno.writeTextFileSync(join(dir, "calls.jsonl"), JSON.stringify({ args: Deno.args }) + "\n", {
  append: true,
});

if (Deno.args[0] !== "pr" || Deno.args[1] !== "view") {
  console.error(`fake gh: only 'pr view' and 'api' are scripted, got: ${Deno.args.join(" ")}`);
  Deno.exit(98);
}
const status = script.statuses[script.next];
if (status === undefined) {
  console.error("fake gh: no scripted PR status left");
  Deno.exit(99);
}
script.next++;
Deno.writeTextFileSync(scriptFile, JSON.stringify(script));
console.log(JSON.stringify(status));
