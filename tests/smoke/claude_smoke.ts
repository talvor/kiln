// Smoke suite for the Claude-facing assumptions: the things Kiln relies on that only the real
// `claude` can confirm. It makes live calls that cost money, so it is not part of the normal
// test run: the file name does not match `*.test.ts`, and nothing runs without an explicit
// opt-in. Run it with `KILN_SMOKE=1 deno task smoke` (see docs/smoke.md).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { makeHome, runKiln } from "../helpers.ts";

const enabled = Deno.env.get("KILN_SMOKE") === "1";

function smoke(
  name: string,
  body: (dir: string, kiln: (...a: string[]) => Promise<Out>) => Promise<void>,
) {
  Deno.test({
    name: `smoke: ${name}`,
    ignore: !enabled,
    fn: async () => {
      const home = await makeHome();
      try {
        const dir = join(home.root, "work");
        await Deno.mkdir(dir);
        const env = { ...Deno.env.toObject(), ...home.env, HOME: Deno.env.get("HOME") ?? home.root };
        await body(dir, (...args) => runKiln(env, args));
      } finally {
        await Deno.remove(home.root, { recursive: true });
      }
    },
  });
}
type Out = { code: number; stdout: string; stderr: string };

smoke("the installed claude is found and reports a version", async () => {
  const out = await new Deno.Command("claude", { args: ["--version"] }).output();
  assertEquals(out.code, 0);
  assert(/\d+\.\d+\.\d+/.test(new TextDecoder().decode(out.stdout)));
});

smoke("a launch edits files in the working directory", async (dir, kiln) => {
  const out = await kiln(
    "launch",
    "Create a file named hello.txt containing exactly the word hello. Then reply 'done'.",
    "--cwd",
    dir,
    "--json",
  );
  assertEquals(out.code, 0, out.stderr);
  const result = JSON.parse(out.stdout);
  assertEquals(result.ok, true);
  assertEquals(result.model, "haiku");
  assert(result.costUsd > 0, `cost ${result.costUsd}`);
  assertStringIncludes((await Deno.readTextFile(join(dir, "hello.txt"))).toLowerCase(), "hello");
});

smoke("the spend cap stops a launch that exceeds it", async (dir, kiln) => {
  const out = await kiln(
    "launch",
    "Reply with the word ok.",
    "--cwd",
    dir,
    "--max-budget-usd",
    "0.0001",
  );
  assertEquals(out.code, 1);
  assertStringIncludes(out.stderr, "error_max_budget_usd");
});
