// Fake `gh`. Two commands are scripted, each from its own queue under $KILN_FAKE_DIR:
//  - `gh pr view <branch> --json ...` consumes the next status from pr-status/script.json and
//    prints it as JSON.
//  - `gh api ...` (branch protection) consumes the next reply from api/script.json and replays
//    its stdout, stderr and exit code.
// Every call is recorded. Once a queue is exhausted its command fails loudly (exit 99).
import { join } from "node:path";

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
