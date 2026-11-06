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
