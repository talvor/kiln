# Watching work, `kiln doctor` and first-run setup

## Looking at a Request

None of these change anything.

```
kiln request list [--all] [--json]
kiln watch <request-id>
kiln transcript <request-id> [--json]
kiln report <request-id> [--json]
```

- `request list` shows the Requests that are running or waiting; `--all` adds finished ones.
- `watch` prints what happens to a Request as it happens (steps, assignments, messages, gates,
  pull requests, budget news) and returns when it finishes (exit 0) or fails (exit 1). A Request
  that is waiting on you does not end: stop watching with Ctrl-C. For one that already ended it
  prints its history and returns.
- `transcript` shows the Messages its agents sent each other, oldest first: assignments, results,
  questions and answers, and which of them Kiln wrote itself.
- `report` says how it went: the outcome, when it started and ended, what it cost against its
  budget, what each step reported, the decisions it asked of you, and its branch, tickets and
  pull request.

`kiln request status <id>` is still the quick look at one Request and its assignments.

## `kiln doctor`

```
kiln doctor [--json]
```

Checks that this machine is ready and says how to fix what is not. It fails (exit 1) for what
Kiln cannot work without: `git`, `claude` (installed, its version, and logged in), the store
(the daemon starts and opens SQLite) and the `origin` remote of each registered Project. It only
warns for what Kiln does better with: `gh` (pull requests and tickets), `lavish-axi` (Escalation
pages) and spend limits not being set.

## First-run setup

```
kiln setup
```

Agents spend real money, so the first time you use Kiln at a terminal it asks what one Request
may cost and what Kiln may spend in a day (Enter for no limit) and writes them to `budgets` in
`limits.json` (see [budgets](budgets.md)), leaving the rest of the file as it is. Run
`kiln setup` again whenever you want to change them. Commands run by agents or scripts never ask.
