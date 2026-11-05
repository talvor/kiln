import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path@1";
import { status } from "./helpers.ts";
import { withWorld } from "./world.ts";

withWorld("a running Kiln can do a piece of work against the fake world", async (world) => {
  const started = await world.kiln("daemon", "start");
  assertEquals(started.code, 0, started.stderr);

  // The fake launcher does the work: it writes a file into the Project checkout.
  await world.launcher.script([{
    stdout: "all done\n",
    writeFiles: { "hello.txt": "hello from the fake launcher\n" },
  }]);
  const run = await world.exec(world.project.path, "claude", "-p", "add a greeting");
  assertEquals(run.code, 0, run.stderr);
  assertEquals(run.stdout, "all done\n");
  assertEquals(await world.launcher.calls(), [{
    args: ["-p", "add a greeting"],
    cwd: await Deno.realPath(world.project.path),
  }]);

  // The work reaches the bare remote.
  await world.git(world.project.path, "checkout", "-b", "kiln/hello");
  await world.git(world.project.path, "add", ".");
  await world.git(world.project.path, "commit", "-m", "Add a greeting");
  await world.git(world.project.path, "push", "origin", "kiln/hello");
  assertEquals(await world.remote.branches(), ["kiln/hello", "main"]);
  assert((await Deno.stat(join(world.project.path, "hello.txt"))).isFile);

  // The scripted PR-status command reports the PR going green.
  await world.prStatus.script([
    { state: "OPEN", checks: "PENDING" },
    { state: "OPEN", checks: "SUCCESS" },
  ]);
  const view = () => world.exec(world.project.path, "gh", "pr", "view", "kiln/hello", "--json");
  assertEquals(JSON.parse((await view()).stdout), { state: "OPEN", checks: "PENDING" });
  assertEquals(JSON.parse((await view()).stdout), { state: "OPEN", checks: "SUCCESS" });
  const exhausted = await view();
  assertEquals(exhausted.code, 99);
  assertEquals(exhausted.stdout, "");
  assertEquals(exhausted.stderr, "fake gh: no scripted PR status left\n");
  assertEquals((await world.prStatus.calls()).length, 3);

  // Kiln itself is unaffected throughout, and stops cleanly.
  assertEquals((await status(world)).code, 0);
  assertEquals((await world.kiln("daemon", "stop")).code, 0);
  assertEquals((await status(world)).code, 3);
});
