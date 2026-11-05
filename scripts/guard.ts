// Guards on the compiled Kiln executable. Kiln ships as one lean file: the Claude Agent SDK
// can drag in a native Claude binary per platform (hundreds of MB each), which must never be
// embedded. `deno run scripts/guard.ts <executable>` exits non-zero when a guard trips.

/** Upper bound for the executable. See docs/build.md for why this number. */
export const MAX_EXE_BYTES = 150_000_000;

/**
 * Names the Claude Agent SDK gives the packages that carry a native Claude binary
 * (`@anthropic-ai/claude-agent-sdk-linux-x64`, `...-darwin-arm64`, `...-win32-x64`, ...).
 * They sit in the executable's embedded file listing when the build included them.
 */
const NATIVE_CLAUDE_PACKAGE = /@anthropic-ai\/claude-(?:agent-sdk|code)-(?:linux|darwin|win32)-/;

export interface Violation {
  guard: "size" | "native-claude-binary";
  message: string;
}

export function checkExecutable(
  exe: string,
  { maxBytes = MAX_EXE_BYTES }: { maxBytes?: number } = {},
): Violation[] {
  const violations: Violation[] = [];
  const size = Deno.statSync(exe).size;
  if (size > maxBytes) {
    violations.push({
      guard: "size",
      message: `${exe} is ${mb(size)} MB, over the ${mb(maxBytes)} MB limit`,
    });
  }
  const match = findNativeClaudePackage(exe);
  if (match) {
    violations.push({
      guard: "native-claude-binary",
      message: `${exe} embeds a native Claude binary (found "${match[0]}...")`,
    });
  }
  return violations;
}

/** Searches the file in chunks, as a fat build is far too big to hold as one string. */
function findNativeClaudePackage(exe: string): RegExpExecArray | null {
  const CHUNK = 16 * 1024 * 1024;
  const OVERLAP = 256; // longer than any package name, so a match cannot straddle two chunks unseen
  // Latin-1 keeps one character per byte, so a binary file can be searched as text.
  const latin1 = new TextDecoder("latin1");
  using file = Deno.openSync(exe);
  const buf = new Uint8Array(CHUNK + OVERLAP);
  let carried = 0;
  for (;;) {
    const read = file.readSync(buf.subarray(carried));
    if (read === null) return null;
    const match = NATIVE_CLAUDE_PACKAGE.exec(latin1.decode(buf.subarray(0, carried + read)));
    if (match) return match;
    const total = carried + read;
    carried = Math.min(OVERLAP, total);
    buf.copyWithin(0, total - carried, total);
  }
}

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);

if (import.meta.main) {
  const [exe] = Deno.args;
  if (!exe) {
    console.error("Usage: deno run scripts/guard.ts <executable>");
    Deno.exit(2);
  }
  const limit = Deno.env.get("KILN_MAX_EXE_BYTES");
  const violations = checkExecutable(exe, limit ? { maxBytes: Number(limit) } : {});
  for (const v of violations) console.error(`guard ${v.guard}: ${v.message}`);
  if (violations.length) Deno.exit(1);
  console.log(`${exe}: ${mb(Deno.statSync(exe).size)} MB, no native Claude binary`);
}
