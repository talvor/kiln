# Smoke suite

The normal test run uses a fake `claude` and never spends money. The smoke suite checks the
Claude-facing assumptions that only the real, installed `claude` can confirm:

- `claude` is on `PATH` and reports a version.
- `kiln launch` starts the installed `claude` through the pinned Claude Agent SDK, which edits files
  in the working directory and reports its cost.
- The spend cap stops a launch that exceeds it (`error_max_budget_usd`).

## Running it

```sh
KILN_SMOKE=1 deno task smoke
```

Without `KILN_SMOKE=1` every smoke test is ignored and makes no Claude call. The suite lives in
`tests/smoke/claude_smoke.ts`, which `deno task test` does not discover.

## What it costs

Launches use the `haiku` model with an SDK budget of $0.25 per launch. The suite makes two live
launches; the second has a $0.0001 budget. The SDK stops when the budget is exceeded, but a completed
API call can slightly exceed it. A normal run costs a cent or two.

## The launcher

`kiln launch <prompt> [--cwd <dir>] [--max-budget-usd <n>] [--json]` runs Claude once in a directory.
`--max-budget-usd` can lower the cap but never raise it. Claude may edit files freely
(`acceptEdits`); anything requiring approval is refused, because nobody is there to approve it.
SDK setting sources are disabled, so project settings, hooks, MCP servers, allow rules, and
`CLAUDE.md` guidance are not loaded. Deliberate project guidance is planned for a later ticket.
