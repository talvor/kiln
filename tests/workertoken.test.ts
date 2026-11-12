// Handing the user's own GitHub token to workers: off unless asked for, and only for the Projects
// asked for.
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { ConfigError } from "../src/config_error.ts";
import { createWorkerTokens, GH_TOKEN_TTL_MS, loadWorkerToken } from "../src/workertoken.ts";

async function configWith(json?: unknown): Promise<string> {
  const dir = await Deno.makeTempDir();
  if (json !== undefined) {
    await Deno.writeTextFile(join(dir, "worker-gh-token.json"), JSON.stringify(json));
  }
  return dir;
}

Deno.test("nothing is shared unless worker-gh-token.json asks for it", async () => {
  assertEquals(await loadWorkerToken(await configWith()), null);
  let asked = 0;
  const tokens = createWorkerTokens({
    configDir: await configWith(),
    ghAuthToken: () => (asked++, Promise.resolve("gho_x")),
    getEnv: () => "env_x",
  });
  assertEquals(await tokens.tokenFor("kiln"), null);
  assertEquals(asked, 0);
});

Deno.test("worker-gh-token.json says what is wrong with it", async () => {
  for (
    const [json, why] of [
      [[], "must be a JSON object"],
      [{}, '"source" must be'],
      [{ source: "keyring" }, '"source" must be'],
      [{ source: "env" }, '"variable" must name'],
      [{ source: "env", variable: "not a name" }, '"variable" must name'],
      [{ source: "gh", variable: "X" }, "only applies"],
      [{ source: "gh", projects: [] }, '"projects" must list'],
      [{ source: "gh", projects: [1] }, '"projects" must list'],
      [{ source: "gh", token: "ghp_secret" }, 'unknown field "token"'],
    ] as [unknown, string][]
  ) {
    const err = await assertRejects(
      async () => await loadWorkerToken(await configWith(json)),
      ConfigError,
    );
    assertEquals(err.message.includes(why), true, `${JSON.stringify(json)}: ${err.message}`);
  }
});

Deno.test("the gh source uses the user's login, reused for a minute", async () => {
  let asked = 0;
  let clock = 0;
  const tokens = createWorkerTokens({
    configDir: await configWith({ source: "gh" }),
    ghAuthToken: () => (asked++, Promise.resolve(`gho_${asked}\n`)),
    now: () => clock,
  });
  assertEquals(await tokens.tokenFor("kiln"), { token: "gho_1", source: "gh" });
  clock += GH_TOKEN_TTL_MS - 1;
  assertEquals((await tokens.tokenFor("other"))?.token, "gho_1");
  assertEquals(asked, 1);
  clock += 2;
  assertEquals((await tokens.tokenFor("kiln"))?.token, "gho_2");
});

Deno.test("the env source reads the daemon's environment each time", async () => {
  const env: Record<string, string> = { KILN_WORKER_GH_TOKEN: "github_pat_one" };
  const tokens = createWorkerTokens({
    configDir: await configWith({ source: "env", variable: "KILN_WORKER_GH_TOKEN" }),
    getEnv: (name) => env[name],
  });
  assertEquals(await tokens.tokenFor("kiln"), { token: "github_pat_one", source: "env" });
  env.KILN_WORKER_GH_TOKEN = "github_pat_two";
  assertEquals((await tokens.tokenFor("kiln"))?.token, "github_pat_two");
});

Deno.test("only the listed Projects' workers get a token", async () => {
  const tokens = createWorkerTokens({
    configDir: await configWith({ source: "gh", projects: ["kiln"] }),
    ghAuthToken: () => Promise.resolve("gho_x"),
  });
  assertEquals((await tokens.tokenFor("kiln"))?.token, "gho_x");
  assertEquals(await tokens.tokenFor("client-work"), null);
});

Deno.test("a missing or unusable token means no token, with a warning", async () => {
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  const missing = createWorkerTokens({
    configDir: await configWith({ source: "env", variable: "NOPE" }),
    getEnv: () => undefined,
    warn,
  });
  assertEquals(await missing.tokenFor("kiln"), null);
  const loggedOut = createWorkerTokens({
    configDir: await configWith({ source: "gh" }),
    ghAuthToken: () => Promise.resolve(null),
    warn,
  });
  assertEquals(await loggedOut.tokenFor("kiln"), null);
  const spaced = createWorkerTokens({
    configDir: await configWith({ source: "env", variable: "T" }),
    getEnv: () => "two words",
    warn,
  });
  assertEquals(await spaced.tokenFor("kiln"), null);
  const broken = createWorkerTokens({ configDir: await configWith({ source: 3 }), warn });
  assertEquals(await broken.tokenFor("kiln"), null);
  assertEquals(warnings, [
    "no usable GitHub token for workers",
    "no usable GitHub token for workers",
    "no usable GitHub token for workers",
    "worker-gh-token.json is unusable; workers get no token",
  ]);
});
