// The build recipe and its guards, driven the way a person drives them: `deno task build`
// produces the executable, the executable runs, and the guards fail a bad one.
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import denoJson from "../deno.json" with { type: "json" };
import { makeHome } from "./helpers.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const dec = new TextDecoder();

async function deno(args: string[]) {
  const out = await new Deno.Command(Deno.execPath(), {
    args,
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  })
    .output();
  return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
}

const build = (out: string, extra: string[] = []) =>
  deno(["run", "-A", "scripts/build.ts", "--out", out, ...extra]);

async function scratch<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "kiln-build-test-" });
  try {
    return await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("the Claude Agent SDK is pinned to an exact version", () => {
  const spec = denoJson.imports["@anthropic-ai/claude-agent-sdk"];
  assertMatch(spec, /^npm:@anthropic-ai\/claude-agent-sdk@\d+\.\d+\.\d+$/);
});

Deno.test("the build produces one executable that runs as Kiln", async () => {
  await scratch(async (dir) => {
    const exe = join(dir, "kiln");
    const built = await build(exe);
    assertEquals(built.code, 0, built.stderr);

    const home = await makeHome();
    try {
      const run = async (...args: string[]) => {
        const out = await new Deno.Command(exe, {
          args,
          env: home.env,
          clearEnv: true,
          stdout: "piped",
          stderr: "piped",
        })
          .output();
        return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
      };
      assertEquals((await run("--version")).stdout.trim(), denoJson.version);
      const started = await run("daemon", "start");
      assertEquals(started.code, 0, started.stderr);
      assertStringIncludes(started.stdout, "started");
      assertEquals((await run("daemon", "status")).code, 0);

      // The Dashboard's page is inside the executable.
      const dashboard = new Deno.Command(exe, {
        args: ["dashboard", "--no-open"],
        env: home.env,
        clearEnv: true,
        stdout: "piped",
        stderr: "null",
      }).spawn();
      try {
        const reader = dashboard.stdout.pipeThrough(new TextDecoderStream()).getReader();
        const url = new URL(((await reader.read()).value ?? "").split("\n")[0]);
        const signedIn = await fetch(url, { redirect: "manual" });
        await signedIn.body?.cancel();
        const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0];
        const page = await fetch(url.origin + "/", { headers: { cookie } });
        assertEquals(page.status, 200);
        assertStringIncludes(await page.text(), "<title>Kiln</title>");
      } finally {
        dashboard.kill("SIGINT");
        await dashboard.status;
      }
    } finally {
      await new Deno.Command(exe, { args: ["daemon", "stop"], env: home.env, clearEnv: true })
        .output();
      await Deno.remove(home.root, { recursive: true });
    }
  });
});

Deno.test("an executable built against the pinned SDK stays lean and runs", async () => {
  await scratch(async (dir) => {
    const exe = join(dir, "kiln-sdk");
    const built = await build(exe, ["--entry", "tests/fixtures/uses-sdk.ts"]);
    assertEquals(built.code, 0, built.stderr);
    const out = await new Deno.Command(exe, { stdout: "piped" }).output();
    assertEquals(dec.decode(out.stdout).trim(), "uses-sdk ok");
    const guard = await deno(["run", "-A", "scripts/guard.ts", exe]);
    assertEquals(guard.code, 0, guard.stderr);
  });
});

Deno.test("the guard fails an executable over the fixed size limit", async () => {
  await scratch(async (dir) => {
    const exe = join(dir, "kiln");
    await Deno.writeFile(exe, new Uint8Array());
    await Deno.truncate(exe, 150_000_001);
    const guard = await deno(["run", "-A", "scripts/guard.ts", exe]);
    assertEquals(guard.code, 1);
    assertStringIncludes(guard.stderr, "guard size");
    assert(!guard.stderr.includes("guard native-claude-binary"));
  });
});

Deno.test("the guard fails an executable that embeds a native Claude binary", async () => {
  await scratch(async (dir) => {
    // Compiling the sources directly, without bundling, embeds the SDK's native binaries.
    const fat = join(dir, "kiln-fat");
    const compiled = await deno([
      "compile",
      "-A",
      "--no-check",
      "-o",
      fat,
      "tests/fixtures/uses-sdk.ts",
    ]);
    assertEquals(compiled.code, 0, compiled.stderr);
    const guard = await deno(["run", "-A", "scripts/guard.ts", fat]);
    assertEquals(guard.code, 1);
    assertStringIncludes(guard.stderr, "guard native-claude-binary");
    assertStringIncludes(guard.stderr, "guard size");
  });
});

Deno.test("the guard names a native Claude binary even when the file is small", async () => {
  await scratch(async (dir) => {
    const exe = join(dir, "kiln");
    await Deno.writeFile(
      exe,
      new TextEncoder().encode("..@anthropic-ai/claude-agent-sdk-darwin-arm64/claude.."),
    );
    const guard = await deno(["run", "-A", "scripts/guard.ts", exe]);
    assertEquals(guard.code, 1);
    assertStringIncludes(guard.stderr, "guard native-claude-binary");
    assert(!guard.stderr.includes("guard size"));
  });
});
