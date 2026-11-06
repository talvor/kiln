# kiln

## Build

Run `deno task build` to create the single-file executable at `dist/kiln`. See
[the build guide](docs/build.md) for the bundle strategy and executable guards.

## Launch

Run `deno task kiln launch "Describe the work"` to give one prompt to the installed `claude` in the
current directory. See [the launcher guide](docs/smoke.md#the-launcher) for directory, budget, and
unattended permission controls.

## Smoke tests

`deno task smoke` opts into live checks against the real `claude`. It costs money; see
[the smoke guide](docs/smoke.md).
