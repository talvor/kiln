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
  /** SDK mode: how many agent turns the run took; default 1. */
  turns?: number;
  /** SDK mode: how the run ended; default "success". */
  outcome?: "success" | "error_max_budget_usd" | "error_max_turns" | "error_during_execution";
  hang?: boolean;
  /** SDK mode: the process dies as soon as it is given the prompt, without a result. */
  crash?: boolean;
  /**
   * Interactive mode: what happens in the session, in order, using the hooks and status line
   * Kiln configured with --settings. Each step prints what the hook said, as the user would see it.
   */
  session?: SessionStep[];
}
export type SessionStep =
  /** The user submits a prompt. */
  | { prompt: string }
  /** The Overseer finishes a turn having said `said`, with a context of `tokens` tokens. */
  | { said: string; tokens?: number }
  /** The status line is drawn. */
  | { statusLine: true }
  /** The session stays open until Kiln ends it. */
  | { wait: number };

const dir = join(Deno.env.get("KILN_FAKE_DIR") ?? "", "launcher");
const scriptFile = join(dir, "script.json");
const script: { runs: LauncherRun[]; next: number } = JSON.parse(Deno.readTextFileSync(scriptFile));

Deno.writeTextFileSync(
  join(dir, "calls.jsonl"),
  JSON.stringify({
    args: Deno.args,
    at: Date.now(),
    cwd: Deno.cwd(),
    env: Object.fromEntries(
      [
        "KILN_AGENT",
        "KILN_PORT_BASE",
        "KILN_PORT_COUNT",
        "TMPDIR",
        "XDG_CACHE_HOME",
        "npm_config_cache",
      ]
        .map((key) => [key, Deno.env.get(key)]),
    ),
  }) + "\n",
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
if (run.session) await playSession(run.session);
if (run.stdout) await Deno.stdout.write(new TextEncoder().encode(run.stdout));
if (run.stderr) await Deno.stderr.write(new TextEncoder().encode(run.stderr));
Deno.exit(run.exit ?? 0);

async function speakSdkProtocol(run: LauncherRun): Promise<void> {
  const send = (msg: unknown) =>
    Deno.stdout.write(new TextEncoder().encode(JSON.stringify(msg) + "\n"));
  // A resumed run keeps its session; a new one gets an id of its own.
  const resumed = Deno.args.find((a) => a.startsWith("--resume="))?.slice("--resume=".length);
  const sessionId = resumed ?? `fake-session-${script.next}`;
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
        if (run.crash) Deno.exit(1);
        if (run.hang) await new Promise((resolve) => setTimeout(resolve, 60_000));
        const base = {
          type: "result",
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: run.turns ?? 1,
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

async function playSession(steps: SessionStep[]): Promise<void> {
  const settings = JSON.parse(Deno.args[Deno.args.indexOf("--settings") + 1] ?? "{}");
  const say = (text: string) => Deno.stdout.write(new TextEncoder().encode(text + "\n"));
  const runHook = async (command: string, input: unknown): Promise<string> => {
    const child = new Deno.Command("sh", {
      args: ["-c", command],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(JSON.stringify(input)));
    await w.close();
    const out = await child.output();
    return new TextDecoder().decode(out.stdout).trim();
  };
  const transcript = join(Deno.cwd(), ".fake-transcript.jsonl");
  for (const step of steps) {
    if ("prompt" in step) {
      const command = settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command;
      await say(`prompt-hook: ${await runHook(command, { prompt: step.prompt })}`);
    } else if ("said" in step) {
      Deno.writeTextFileSync(
        transcript,
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: step.said }],
            usage: { input_tokens: step.tokens ?? 10, cache_read_input_tokens: 0 },
          },
        }) + "\n",
      );
      const command = settings.hooks?.Stop?.[0]?.hooks?.[0]?.command;
      await say(`stop-hook: ${await runHook(command, { transcript_path: transcript })}`);
    } else if ("statusLine" in step) {
      await say(`status-line: ${await runHook(settings.statusLine.command, {})}`);
    } else {
      await new Promise((resolve) => setTimeout(resolve, step.wait));
    }
  }
}
