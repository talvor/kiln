// Fake `claude` launcher. Each invocation consumes the next scripted run from
// $KILN_FAKE_DIR/launcher/script.json, records the call, and replays the run:
// write files into the working directory, print output, exit with the scripted code.
// Once the script is exhausted every further call fails loudly (exit 99).
import { dirname, join } from "node:path";

export interface LauncherRun {
  stdout?: string;
  stderr?: string;
  exit?: number;
  /** Files to create (relative to the working directory) before exiting. */
  writeFiles?: Record<string, string>;
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
if (run.stdout) await Deno.stdout.write(new TextEncoder().encode(run.stdout));
if (run.stderr) await Deno.stderr.write(new TextEncoder().encode(run.stderr));
Deno.exit(run.exit ?? 0);
