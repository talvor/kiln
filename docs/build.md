# Building Kiln

The build task bundles `src/main.ts` and compiles the bundle, then runs the guards in
`scripts/guard.ts` and deletes the executable if one trips. The `--out` and `--entry` options are
test support, not supported user-facing behavior.

## Why bundle first

The Claude Agent SDK lists native Claude binaries for several platforms as optional npm packages
(`@anthropic-ai/claude-agent-sdk-linux-x64`, ...). Compiling the sources directly can embed these
packages and make the executable much larger. Bundling first limits the compile input to the
JavaScript Kiln imports.

The SDK is pinned to an exact version in `deno.json`. Upgrading it is a deliberate edit; the build
guards tell you whether the new version still builds lean.

## Embedded assets

The Dashboard's page (`src/web/`) is imported as text
(`import x from "./web/index.html" with
{ type: "text" }`), so it travels inside the bundle. Raw
imports are unstable in Deno: `deno.json` turns on `unstable: ["raw-imports"]` for running, checking
and testing, and the build passes `--unstable-raw-imports` to `deno bundle`.

## Guards

- **Size**: the executable must be at most 150 MB (`MAX_EXE_BYTES`). The limit leaves room for the
  Deno runtime and dependencies while staying below the size added by a native Claude binary.
- **Native Claude binary**: the executable must not embed an `@anthropic-ai/claude-agent-sdk-<os>-*`
  package. This names the cause when the size guard trips for that reason, and catches a binary
  small enough to slip under the size limit.

`deno run -A scripts/guard.ts <executable>` runs the guards on any executable for tests. The
standalone command is test support, not supported user-facing behavior.
