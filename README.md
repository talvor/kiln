# kiln

## Build

Run `deno task build` to create the single-file executable at `dist/kiln`. See
[the build guide](docs/build.md) for the bundle strategy and executable guards.

## Smoke tests

`KILN_SMOKE=1 deno task smoke` runs the opt-in suite against the real `claude`. It costs money; see
[the smoke guide](docs/smoke.md).
