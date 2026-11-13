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
launches; the second has a $0.0001 budget. The SDK stops when the budget is exceeded, but a
completed API call can slightly exceed it. Actual charges depend on the calls made.

## The launcher

[`kiln launch`](../README.md#launch) runs Claude once in the current directory, or in the directory
given by `--cwd`. `--max-budget-usd` can lower the SDK budget but never raise it; `--json` prints
the result and cost as JSON. The launcher sets `acceptEdits` so Claude may edit files without
approval. SDK setting sources are disabled, so project settings, hooks, MCP servers, allow rules,
and `CLAUDE.md` guidance are not loaded. See [the registration guide](register.md) for the separate
onboarding process.

## Dashboard browser smoke

One more opt-in test drives a real Chrome against the real `kiln dashboard --no-open` and a real
daemon in the test world. It opens the Health, Cost, Request (Overview, Transcript, Report) and
Escalation views, checks they survive a reload, approves an Escalation with one click, and sees a
live event: an Escalation raised from outside appears in Needs you and the tab title without a
reload. It costs nothing and makes no Claude call.

```sh
deno task smoke:dashboard
```

The task sets `KILN_SMOKE=1`. It finds `google-chrome`, `chromium` or `chrome` on `PATH`; set
`KILN_SMOKE_CHROME` to a command line to use another browser, for example
`KILN_SMOKE_CHROME="flatpak run org.chromium.Chromium"`. Chrome runs headless with a throwaway
profile. `deno task test` does not discover the file.
