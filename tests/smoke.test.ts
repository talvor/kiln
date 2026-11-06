// The smoke suite is opt-in: without KILN_SMOKE=1 it is ignored and never starts Claude, and the
// normal test run does not pick it up.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { withWorld } from "./world.ts";

const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));
const SMOKE = fromFileUrl(new URL("./smoke/claude_smoke.ts", import.meta.url));

withWorld(
  "the smoke suite is ignored without the opt-in and makes no Claude call",
  async (world) => {
    const run = await world.exec(
      world.project.path,
      Deno.execPath(),
      "test",
      "-A",
      "--config",
      CONFIG,
      SMOKE,
    );
    assertEquals(run.code, 0, run.stderr);
    assertStringIncludes(run.stdout + run.stderr, "3 ignored");
    assertEquals(await world.launcher.calls(), []);
  },
);

withWorld("the normal test run does not discover the smoke suite", async (world) => {
  const root = fromFileUrl(new URL("..", import.meta.url));
  const run = await world.exec(
    world.project.path,
    Deno.execPath(),
    "test",
    "-A",
    "--config",
    CONFIG,
    "--filter",
    "smoke: ",
    root,
  );
  assertEquals(run.code, 0, run.stderr);
  assertEquals((run.stdout + run.stderr).includes("smoke: "), false);
  assertEquals(await world.launcher.calls(), []);
});
