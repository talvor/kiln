// First-run setup: the spend limits are the one thing Kiln asks the user before it works, since
// agents spend real money. The answers are written to `limits.json` (see limits.ts) beside
// whatever the user has put there; an empty answer means no limit.
import { join } from "@std/path";
import { ConfigError } from "./config_error.ts";
import type { KilnPaths } from "./paths.ts";

const limitsFile = (paths: KilnPaths) => join(paths.config, "limits.json");
const doneFile = (paths: KilnPaths) => join(paths.config, ".setup-done");

const exists = async (path: string) => {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
};

/** Whether this is the first run: the user has neither set up Kiln nor written limits themselves. */
export async function needsSetup(paths: KilnPaths): Promise<boolean> {
  return !(await exists(doneFile(paths))) && !(await exists(limitsFile(paths)));
}

export interface SetupIo {
  /** Ask a question; null at the end of the input. */
  ask(question: string): Promise<string | null>;
  say(text: string): void;
}

/** Ask for the spend limits, write them, and remember that Kiln has been set up. */
export async function runSetup(paths: KilnPaths, io: SetupIo): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await Deno.readTextFile(limitsFile(paths)));
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      throw new Error("not a JSON object");
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw new ConfigError(
        `${limitsFile(paths)}: cannot be changed by setup (${
          (err as Error).message
        }); fix or remove it first`,
      );
    }
  }
  io.say(
    "Kiln's agents spend real money. Set the limits Kiln keeps them to; press Enter for none.",
  );
  const request = await askAmount(io, "Most one request may cost, in dollars");
  const daily = await askAmount(io, "Most Kiln may spend in a day, in dollars");

  const budgets = {
    ...(existing.budgets as Record<string, number> | undefined),
    ...(request === undefined ? {} : { requestUsd: request }),
    ...(daily === undefined ? {} : { dailyUsd: daily }),
  };
  const next = Object.keys(budgets).length ? { ...existing, budgets } : existing;
  await Deno.mkdir(paths.config, { recursive: true, mode: 0o700 });
  if (next === existing && !(await exists(limitsFile(paths)))) {
    io.say("No limits set: nothing holds spending back. Run `kiln setup` to set them later.");
  } else {
    await Deno.writeTextFile(limitsFile(paths), JSON.stringify(next, null, 2) + "\n");
    io.say(`Saved ${limitsFile(paths)}.`);
  }
  await Deno.writeTextFile(doneFile(paths), "");
  io.say("Run `kiln doctor` to check that this machine is ready.");
}

async function askAmount(io: SetupIo, question: string): Promise<number | undefined> {
  while (true) {
    const answer = (await io.ask(`${question} [no limit]: `))?.trim().replace(/^\$/, "");
    if (!answer) return undefined;
    const usd = Number(answer);
    if (Number.isFinite(usd) && usd > 0) return usd;
    io.say("Enter a positive amount such as 5 or 12.50, or nothing for no limit.");
  }
}
