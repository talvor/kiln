// `kiln doctor` and first-run setup, driven through the CLI against the fake tools and remote.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { withWorld, type World } from "./world.ts";
import { runKiln } from "./helpers.ts";

async function register(world: World) {
  await Deno.writeTextFile(join(world.project.path, "AGENTS.md"), "# How to work here\n");
  await world.git(world.project.path, "add", ".");
  await world.git(world.project.path, "commit", "-m", "Add agent docs");
  await world.git(world.project.path, "push", "origin", "main");
  await world.githubApi.script([{ stdout: "{}\n" }]);
  await world.launcher.script([{
    result: JSON.stringify({ setup: null, test: null, lint: null, build: null }),
  }]);
  const r = await world.kilnWithInput("y\n", "project", "register", world.project.path);
  assertEquals(r.code, 0, r.stderr);
}

interface Check {
  name: string;
  status: string;
  detail: string;
}
const checks = async (w: World, env = w.env): Promise<{ code: number; checks: Check[] }> => {
  const r = await runKiln(env, ["doctor", "--json"]);
  return { code: r.code, checks: JSON.parse(r.stdout) };
};
const statusOf = (list: Check[], name: string) => list.find((c) => c.name === name)?.status;

withWorld("a ready machine passes kiln doctor", async (w) => {
  await register(w);
  await w.kilnWithInput("5\n20\n", "setup");

  const r = await w.kiln("doctor");
  assertEquals(r.code, 0, r.stdout + r.stderr);
  for (
    const part of [
      "git",
      "claude version",
      "9.9.9",
      "claude login",
      "sqlite",
      "remote remote",
      "Kiln is ready.",
    ]
  ) assertStringIncludes(r.stdout, part);
  assert(!r.stdout.includes("FAIL"));
});

withWorld("kiln doctor fails when Claude is not logged in, and says how to fix it", async (w) => {
  await w.launcher.logOut();
  const r = await w.kiln("doctor");
  assertEquals(r.code, 1);
  assertStringIncludes(r.stdout, "claude auth login");
  assertEquals(statusOf((await checks(w)).checks, "claude login"), "fail");
});

withWorld("kiln doctor fails for a remote that cannot be reached", async (w) => {
  await register(w);
  await Deno.rename(w.remote.path, w.remote.path + ".gone");

  const { code, checks: list } = await checks(w);
  assertEquals(code, 1);
  assertEquals(statusOf(list, "remote remote"), "fail");
  assertEquals(statusOf(list, "sqlite"), "ok");
});

withWorld(
  "kiln doctor fails without Claude, and only warns without the optional tools",
  async (w) => {
    const git = new TextDecoder().decode(
      (await new Deno.Command("sh", { args: ["-c", "command -v git"], stdout: "piped" }).output())
        .stdout,
    ).trim();
    const slim = join(w.root, "slim-bin");
    await Deno.mkdir(slim);
    await Deno.symlink(git, join(slim, "git"));
    const env = { ...w.env, PATH: slim };

    const without = await checks(w, env);
    assertEquals(without.code, 1);
    assertEquals(statusOf(without.checks, "claude"), "fail");
    assertEquals(statusOf(without.checks, "gh"), "warn");
    assertEquals(statusOf(without.checks, "lavish-axi"), "warn");

    await Deno.symlink(join(w.root, "fake", "bin", "claude"), join(slim, "claude"));
    const withClaude = await checks(w, env);
    assertEquals(withClaude.code, 0);
    assertEquals(statusOf(withClaude.checks, "gh"), "warn");
  },
);

withWorld("first-run setup asks for the spend limits and keeps them", async (w) => {
  assertEquals(statusOf((await checks(w)).checks, "spend limits"), "warn");

  const r = await w.kilnWithInput("lots\n5\n$20\n", "setup");
  assertEquals(r.code, 0, r.stderr);
  assertStringIncludes(r.stdout, "Enter a positive amount");
  const limits = JSON.parse(await Deno.readTextFile(join(w.dirs.config, "limits.json")));
  assertEquals(limits.budgets, { requestUsd: 5, dailyUsd: 20 });
  assertEquals(statusOf((await checks(w)).checks, "spend limits"), "ok");
  // Kiln keeps to what was set.
  assertStringIncludes((await w.kiln("cost")).stdout, "$20.00 daily cap");
});

withWorld(
  "setup leaves what is already in limits.json, and no answer means no limit",
  async (w) => {
    await Deno.mkdir(w.dirs.config, { recursive: true });
    const file = join(w.dirs.config, "limits.json");
    await Deno.writeTextFile(
      file,
      JSON.stringify({ concurrency: { global: 2 }, budgets: { requestUsd: 3 } }),
    );

    await w.kilnWithInput("\n8\n", "setup");
    assertEquals(JSON.parse(await Deno.readTextFile(file)), {
      concurrency: { global: 2 },
      budgets: { requestUsd: 3, dailyUsd: 8 },
    });

    const fresh = await (await import("./world.ts")).makeWorld();
    try {
      const r = await fresh.kilnWithInput("\n\n", "setup");
      assertEquals(r.code, 0, r.stderr);
      assertStringIncludes(r.stdout, "No limits set");
      assertEquals(statusOf((await checks(fresh)).checks, "spend limits"), "warn");
    } finally {
      await fresh.kiln("daemon", "stop");
      await Deno.remove(fresh.root, { recursive: true });
    }
  },
);
