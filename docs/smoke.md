# Smoke suite

The normal test run uses a fake `claude` and never spends money. The smoke suite checks the
Claude-facing assumptions that only the real, installed `claude` can confirm:

- `claude` is on `PATH` and reports a version.
- `kiln launch` starts the installed `claude` through the pinned Claude Agent SDK, which edits files
  in the working directory and reports a cost within the cap.
- The spend cap stops a launch that exceeds it (`error_max_budget_usd`).

## Running it

```sh
KILN_SMOKE=1 deno task smoke
```

Without `KILN_SMOKE=1` every smoke test is ignored and makes no Claude call. The suite lives in
`tests/smoke/claude_smoke.ts`, which `deno task test` does not discover.

## What it costs

Launches use the `haiku` model with a spend cap of $0.25 per launch (`MAX_LAUNCH_USD`). The suite
makes two live launches; the second is capped at $0.0001. The worst case is about $0.25; a normal run
costs a cent or two.

## The launcher

`kiln launch <prompt> [--cwd <dir>] [--max-budget-usd <n>] [--json]` runs Claude once in a directory.
`--max-budget-usd` can lower the cap but never raise it. Claude may edit files freely
(`acceptEdits`); anything riskier is refused, because nobody is there to approve it.
