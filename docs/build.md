# Building Kiln

`deno task build` writes the single-file executable to `dist/kiln` (`--out` and `--entry` override
the output and the entry point). It bundles `src/main.ts` and compiles the bundle, then runs the
guards in `scripts/guard.ts` and deletes the executable if one trips.

## Why bundle first

The Claude Agent SDK lists a native Claude binary per platform as optional npm packages
(`@anthropic-ai/claude-agent-sdk-linux-x64`, ...), about 320 MB each. `deno compile` on the sources
embeds every one of them (a 100 MB executable becomes 800 MB) and cannot exclude them. Bundling
first embeds only the JavaScript Kiln imports.

The SDK is pinned to an exact version in `deno.json`. Upgrading it is a deliberate edit; the build
guards tell you whether the new version still builds lean.

## Guards

- **Size**: the executable must be at most 150 MB (`MAX_EXE_BYTES`). A bare Deno runtime is about
  105 MB and grows slowly between releases, so 150 MB leaves room for it and for dependencies while
  staying well under the 320 MB a single native Claude binary adds. `KILN_MAX_EXE_BYTES` overrides it.
- **Native Claude binary**: the executable must not embed an `@anthropic-ai/claude-agent-sdk-<os>-*`
  package. This names the cause when the size guard trips for that reason, and catches a binary
  small enough to slip under the size limit.

`deno run scripts/guard.ts <executable>` runs the guards on any executable.
