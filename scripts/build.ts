// Builds the single-file `kiln` executable: `deno task build`.
//
// The entry point is bundled first, then the bundle is compiled. Compiling the sources
// directly can embed the native Claude binaries from the SDK's optional per-platform
// packages. The bundle limits the compile input to the JavaScript the program imports.
// The result goes through the guards.
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { checkExecutable } from "./guard.ts";

const root = resolve(dirname(fromFileUrl(import.meta.url)), "..");

function option(name: string, fallback: string): string {
  const i = Deno.args.indexOf(name);
  return i >= 0 && Deno.args[i + 1] ? Deno.args[i + 1] : fallback;
}

async function run(args: string[]): Promise<void> {
  const out = await new Deno.Command(Deno.execPath(), {
    args,
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!out.success) throw new Error(`deno ${args[0]} failed with exit code ${out.code}`);
}

// --entry and --out are test support, not supported user-facing build options.
const entry = resolve(option("--entry", join(root, "src", "main.ts")));
const outFile = resolve(option("--out", join(root, "dist", "kiln")));
await Deno.mkdir(dirname(outFile), { recursive: true });
const work = await Deno.makeTempDir({ prefix: "kiln-build-" });
try {
  const bundle = join(work, "kiln.js");
  await run(["bundle", "--output", bundle, entry]);
  await run(["compile", "--allow-all", "--no-check", "--output", outFile, bundle]);
} finally {
  await Deno.remove(work, { recursive: true });
}

const violations = checkExecutable(outFile);
if (violations.length) {
  await Deno.remove(outFile);
  for (const v of violations) console.error(`build failed, guard ${v.guard}: ${v.message}`);
  Deno.exit(1);
}
console.log(`built ${outFile}`);
