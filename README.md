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

## Register a project

Run `deno task kiln project register <path-or-url>` to register a project. See
[the registration guide](docs/register.md) for what Kiln checks, what blocks and what only warns.

## Manage projects

Pause, edit commands, re-run the test baseline, change the default branch or remove a project with
`deno task kiln project ...`. See [the management guide](docs/manage.md).

## Messages between agents

Agents work under sessions (`kiln session open`) and exchange assignments, results, questions and
answers through a per-session tool server; Kiln nudges agents with unread mail. See
[the router guide](docs/router.md).

## Requests that follow a Playbook

`kiln request start <project> --playbook diagnose-a-bug --description "..."` starts a Request that
Kiln walks through step by step, from the overseer to a department's leader and its workers, to a
published fix ticket. See [the playbook guide](docs/playbooks.md).

Each Assignment runs under turn, spend and time limits, and a cap keeps only so many running at
once; the rest wait as planned. See [the limits guide](docs/limits.md).

A Request may cost only so much and so may a day: at 80% you are notified, a Request that uses its
budget is blocked on you, and the daily cap stops all work. `kiln cost` shows the spend, and a
daily digest (only when there is news) and warnings go to a command you configure. See
[the budgets guide](docs/budgets.md).

Decisions that are the user's to make wait in `kiln escalations`. Settle them with `kiln approve <id>`,
`kiln reject <id> --reason <text>`, or the Dashboard. See [the escalation guide](docs/escalations.md).

Talk to the Overseer with `kiln chat`: an interactive Claude session with Kiln's tools, status line
and model-free commands. See [the chat guide](docs/chat.md).

Follow a Request with `kiln request list`, `kiln watch`, `kiln transcript` and `kiln report`, check
the machine with `kiln doctor`, and set spend limits with `kiln setup`. See
[the observability guide](docs/observe.md).

Open the Dashboard, a browser window onto Kiln, with `kiln dashboard`; it listens on 127.0.0.1 only
and needs the URL it prints. See [the dashboard guide](docs/dashboard.md).
