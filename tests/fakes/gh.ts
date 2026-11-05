// Fake PR-status command (`gh pr view <branch> --json ...`). Each call consumes the next
// scripted status from $KILN_FAKE_DIR/pr-status/script.json (the last one repeats), records
// the call, and prints the status as JSON.
import { join } from "jsr:@std/path@1";

const dir = join(Deno.env.get("KILN_FAKE_DIR") ?? "", "pr-status");
const scriptFile = join(dir, "script.json");
const script: { statuses: unknown[]; next: number } = JSON.parse(
  Deno.readTextFileSync(scriptFile),
);

Deno.writeTextFileSync(join(dir, "calls.jsonl"), JSON.stringify({ args: Deno.args }) + "\n", {
  append: true,
});

if (Deno.args[0] !== "pr" || Deno.args[1] !== "view") {
  console.error(`fake gh: only 'pr view' is scripted, got: ${Deno.args.join(" ")}`);
  Deno.exit(98);
}
const status = script.statuses[Math.min(script.next, script.statuses.length - 1)];
if (status === undefined) {
  console.error("fake gh: no PR status scripted");
  Deno.exit(99);
}
script.next++;
Deno.writeTextFileSync(scriptFile, JSON.stringify(script));
console.log(JSON.stringify(status));
