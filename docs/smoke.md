# Smoke suite

The normal test run uses a fake `claude` and never spends money. The smoke suite checks the
Claude-facing assumptions that only the real, installed `claude` can confirm:

- `claude` is on `PATH` and reports a version.
- `kiln launch` starts the installed `claude` through the pinned Claude Agent SDK, which edits files
  in the working directory and reports its cost.
- The spend cap stops a launch that exceeds it (`error_max_budget_usd`).

## Running it

```sh
deno task smoke
```

The task sets `KILN_SMOKE=1`. When running `tests/smoke/claude_smoke.ts` directly, that variable
must be set or every smoke test is ignored. `deno task test` does not discover the smoke file.

## What it costs

Launches use the `haiku` model with an SDK budget of $0.25 per launch. The suite makes two live
launches; the second has a $0.0001 budget. The SDK stops when the budget is exceeded, but a completed
API call can slightly exceed it. Actual charges depend on the calls made.

## The launcher

[`kiln launch`](../README.md#launch) runs Claude once in the current directory, or in the directory
given by `--cwd`. `--max-budget-usd` can lower the SDK budget but never raise it; `--json` prints
the result and cost as JSON. The launcher sets `acceptEdits` so Claude may edit files without
approval. SDK setting sources are disabled, so project settings, hooks, MCP servers, allow rules,
and `CLAUDE.md` guidance are not loaded. See [the registration guide](register.md) for the separate
onboarding process.
