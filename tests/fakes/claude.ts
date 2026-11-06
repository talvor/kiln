// Fake `claude` launcher. Each invocation consumes the next scripted run from
// $KILN_FAKE_DIR/launcher/script.json, records the call, and replays the run:
// write files into the working directory, print output, exit with the scripted code.
// Once the script is exhausted every further call fails loudly (exit 99).
//
// Launched the way the Claude Agent SDK launches `claude` (`--input-format stream-json`), it
// speaks the SDK's line protocol instead: acknowledge its control requests, wait for the
// user's prompt, then answer with a scripted result message.
import { dirname, join } from "node:path";

export interface LauncherRun {
  stdout?: string;
  stderr?: string;
  exit?: number;
  /** Files to create (relative to the working directory) before exiting. */
  writeFiles?: Record<string, string>;
  /** SDK mode: the final answer, and what the run cost. */
  result?: string;
  costUsd?: number;
  /** SDK mode: how the run ended; default "success". */
  outcome?: "success" | "error_max_budget_usd" | "error_during_execution";
  hang?: boolean;
}

const dir = join(Deno.env.get("KILN_FAKE_DIR") ?? "", "launcher");
const scriptFile = join(dir, "script.json");
const script: { runs: LauncherRun[]; next: number } = JSON.parse(Deno.readTextFileSync(scriptFile));

Deno.writeTextFileSync(
  join(dir, "calls.jsonl"),
  JSON.stringify({ args: Deno.args, cwd: Deno.cwd() }) + "\n",
  { append: true },
);

const run = script.runs[script.next];
if (!run) {
  console.error("fake claude: no scripted run left");
  Deno.exit(99);
}
script.next++;
Deno.writeTextFileSync(scriptFile, JSON.stringify(script));

for (const [path, content] of Object.entries(run.writeFiles ?? {})) {
  Deno.mkdirSync(dirname(path), { recursive: true });
  Deno.writeTextFileSync(path, content);
}
if (Deno.args.includes("--input-format") && Deno.args.includes("stream-json")) {
  await speakSdkProtocol(run);
}
if (run.stdout) await Deno.stdout.write(new TextEncoder().encode(run.stdout));
if (run.stderr) await Deno.stderr.write(new TextEncoder().encode(run.stderr));
Deno.exit(run.exit ?? 0);

async function speakSdkProtocol(run: LauncherRun): Promise<void> {
  const send = (msg: unknown) =>
    Deno.stdout.write(new TextEncoder().encode(JSON.stringify(msg) + "\n"));
  const sessionId = "fake-session";
  const outcome = run.outcome ?? "success";
  let buf = "";
  for await (const chunk of Deno.stdin.readable) {
    buf += new TextDecoder().decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.type === "control_request") {
        await send({
          type: "control_response",
          response: { subtype: "success", request_id: msg.request_id, response: {} },
        });
      } else if (msg.type === "user") {
        Deno.writeTextFileSync(
          join(dir, "prompts.jsonl"),
          JSON.stringify(msg) + "\n",
          { append: true },
        );
        if (run.hang) await new Promise((resolve) => setTimeout(resolve, 60_000));
        const base = {
          type: "result",
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          stop_reason: null,
          total_cost_usd: run.costUsd ?? 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
          uuid: crypto.randomUUID(),
          session_id: sessionId,
        };
        await send(
          outcome === "success"
            ? { ...base, subtype: "success", is_error: false, result: run.result ?? "" }
            : { ...base, subtype: outcome, is_error: true, errors: [run.result ?? outcome] },
        );
        return;
      }
    }
  }
}
