// Fake `lavish-axi`: records every call under $KILN_FAKE_DIR/lavish, and fails when asked to.
import { join } from "node:path";

const dir = join(Deno.env.get("KILN_FAKE_DIR") ?? "", "lavish");
Deno.mkdirSync(dir, { recursive: true });
Deno.writeTextFileSync(join(dir, "calls.jsonl"), JSON.stringify({ args: Deno.args }) + "\n", {
  append: true,
});
try {
  Deno.statSync(join(dir, "broken"));
  console.error("fake lavish-axi: unavailable");
  Deno.exit(1);
} catch { /* working */ }
