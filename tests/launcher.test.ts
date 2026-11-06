// The launcher, driven the way a person drives it: `kiln launch` against the fake world,
// where `claude` is the scripted fake that speaks the Claude Agent SDK's protocol.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runKiln } from "./helpers.ts";
import { join, relative } from "@std/path";
import { withWorld } from "./world.ts";

withWorld("kiln launch runs Claude in the Project and reports the answer", async (world) => {
  await world.launcher.script([{
    result: "added the greeting",
    costUsd: 0.01,
    writeFiles: { "hello.txt": "hello\n" },
  }]);
  const out = await world.kiln("launch", "add a greeting", "--cwd", world.project.path);
  assertEquals(out.code, 0, out.stderr);
  assertEquals(out.stdout, "added the greeting\n");
  assertEquals(await Deno.readTextFile(join(world.project.path, "hello.txt")), "hello\n");

  const [call, ...more] = await world.launcher.calls();
  assertEquals(more, []);
  assertEquals(call.cwd, await Deno.realPath(world.project.path));
});

withWorld("kiln launch uses a cheap model under a spend cap", async (world) => {
  await world.launcher.script([{ result: "ok", costUsd: 0.02 }]);
  const out = await world.kiln("launch", "say ok", "--json");
  assertEquals(out.code, 0, out.stderr);
  assertEquals(JSON.parse(out.stdout), {
    ok: true,
    text: "ok",
    outcome: "success",
    costUsd: 0.02,
    model: "haiku",
    maxBudgetUsd: 0.25,
  });
  const [call] = await world.launcher.calls();
  assert(call.args.includes("--model=haiku"), call.args.join(" "));
  assert(call.args.includes("--max-budget-usd=0.25"), call.args.join(" "));
  assert(call.args.includes("--setting-sources="), call.args.join(" "));
});

withWorld("a cap lower than the default is honoured, a higher one is not", async (world) => {
  await world.launcher.script([{ result: "a" }, { result: "b" }]);
  await world.kiln("launch", "x", "--max-budget-usd", "0.05");
  await world.kiln("launch", "x", "--max-budget-usd", "50");
  const [low, high] = await world.launcher.calls();
  assert(low.args.includes("--max-budget-usd=0.05"), low.args.join(" "));
  assert(high.args.includes("--max-budget-usd=0.25"), high.args.join(" "));
});

withWorld("kiln launch fails when the spend cap is hit", async (world) => {
  await world.launcher.script([{ outcome: "error_max_budget_usd", result: "budget exceeded" }]);
  const out = await world.kiln("launch", "do a lot");
  assertEquals(out.code, 1);
  assertEquals(out.stdout, "");
  assertStringIncludes(out.stderr, "error_max_budget_usd");
});

withWorld("kiln launch fails clearly when Claude is not installed", async (world) => {
  const env = { ...world.env, PATH: "/nonexistent" };
  const out = await runKiln(env, ["launch", "hi"]);
  assertEquals(out.code, 1);
  assertStringIncludes(out.stderr, "`claude` command was not found");
});

withWorld("kiln launch needs a prompt", async (world) => {
  const out = await world.kiln("launch");
  assertEquals(out.code, 2);
  assertStringIncludes(out.stderr, "Usage: kiln launch");
});

withWorld("kiln launch rejects missing flag values before starting Claude", async (world) => {
  for (const flag of ["--cwd", "--max-budget-usd"]) {
    for (const args of [["launch", "hi", flag], ["launch", "hi", flag, "--json"]]) {
      const out = await world.kiln(...args);
      assertEquals(out.code, 2, out.stderr);
      assertStringIncludes(out.stderr, "Usage: kiln launch");
    }
  }
  assertEquals(await world.launcher.calls(), []);
});

withWorld("kiln launch finds an executable from relative PATH", async (world) => {
  await world.launcher.script([{ result: "ok" }]);
  const bin = join(world.root, "fake", "bin");
  const env = { ...world.env, PATH: relative(Deno.cwd(), bin) };
  const out = await runKiln(env, ["launch", "hi", "--cwd", world.project.path]);
  assertEquals(out.code, 0, out.stderr);
  assertEquals((await world.launcher.calls()).length, 1);
});

withWorld("kiln launch skips a non-executable PATH match", async (world) => {
  await world.launcher.script([{ result: "ok" }]);
  const shadow = join(world.root, "shadow");
  await Deno.mkdir(shadow);
  await Deno.writeTextFile(join(shadow, "claude"), "not executable");
  const env = { ...world.env, PATH: `${shadow}:${join(world.root, "fake", "bin")}` };
  const out = await runKiln(env, ["launch", "hi"]);
  assertEquals(out.code, 0, out.stderr);
  assertEquals((await world.launcher.calls()).length, 1);
});
