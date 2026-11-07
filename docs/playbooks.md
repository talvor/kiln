# Playbooks and the Request lifecycle

A **Playbook** is the ordered list of department **Steps** Kiln follows for one type of Request.
Kiln ships one, `diagnose-a-bug`.

```
kiln request start <project> --playbook <name> --description <text> [--tracker-item <ref>]
kiln request status <request-id> [--json]
```

`--tracker-item` is the ticket in the Project's tracker the Request came from (for example `#12`).
It is optional; when given, the leader is told about it and the published ticket refers to it.
`request start` without `--playbook` still just creates the request branch and worktree (see the
[worktrees guide](worktrees.md)).

## The lifecycle

A Request, each of its Steps and each Assignment share four states: `planned`, `active`, `done`
and `failed`. Kiln plays the overseer and walks the Steps one at a time:

1. **Step begins.** Kiln opens the sessions it needs (the overseer, the department's leader, and a
   worker named `<worker-role>-<step-id>`, for example `diagnostician-1`) and sends the leader an
   assignment from the overseer. The Step is `active`.
2. **Delegation.** The leader sends an assignment to that worker. Kiln starts it as an
   **Assignment**, with its own branch and worktree off the request branch (the assignment
   Message's ID is the Assignment's ID), and wakes the worker there. The worker commits the Step's
   artifact and reports a result; the Assignment becomes `done` or `failed`.
3. **Verification.** The leader checks the work and sends its result for the Step to the overseer.
   `failed` fails the Step. On `done`, Kiln first checks that a worker reported done and committed
   the Step's artifact, then merges the Assignment into the request branch and pushes it. Anything
   that goes wrong fails the Step.
4. **Publishing.** A Step that publishes (`"publish": "ticket"`) has Kiln open a ticket in the
   Project's tracker with `gh issue create`: the first line of the artifact is the title, the rest
   is the body. The URL is recorded on the Request.
5. The Step is `done` and the next one begins. When the last Step is `done`, so is the Request. A
   failed Step fails the Request; later Steps stay `planned`.

In `diagnose-a-bug` the Diagnostician writes `diagnosis.md`; once the engineering leader has
verified it and it is on the request branch, the Ticket Planner (whose Assignment starts from that
branch) writes `ticket.md`, and Kiln publishes it as the fix ticket.

## Roles and Playbooks are config files

Kiln reads `roles/<name>.json` and `playbooks/<name>.json` in its config directory each time a
Request starts. A file replaces the built-in role or Playbook of the same name; the file name is
the name.

```json
// roles/diagnostician.json
{ "kind": "worker", "department": "engineering", "prompt": "You are a diagnostician. ...",
  "tools": ["Read", "Glob", "Grep", "Write", "Bash"] }
```

`kind` is `overseer`, `leader` or `worker`; leaders and workers need a `department`. There must be
one overseer and at most one leader per department. The `prompt` is added to the Nudge whenever
Kiln wakes an agent playing the role. `tools` is optional and lists the built-in tools the role may
use (`Read`, `Glob`, `Grep`, `Write`, `Edit`, `NotebookEdit`, `Bash`); see
[worker confinement](router.md#worker-confinement) for the defaults.

```json
// playbooks/diagnose-a-bug.json
{
  "description": "Find the root cause of a bug and publish a ticket to fix it.",
  "steps": [{
    "name": "diagnose",
    "department": "engineering",
    "worker": "diagnostician",
    "instructions": "Find the root cause of the bug in the request. ...",
    "artifact": "diagnosis.md",
    "publish": "ticket"
  }]
}
```

Each Step names a department with a leader and a worker role in that department. `publish` is
optional. A file that is not valid is refused when a Request starts, naming the file and the
problem. A Request keeps the Steps it started with if the file changes later.

## Verification and retries

When the leader reports a Step done, Kiln verifies each worker's Assignment before merging it, in
the Assignment's worktree: the Step's artifact is committed (and starts with a title when it is
published as a ticket), and the Project's setup, lint, build and test commands pass. A test failure
counts against the work when the registered baseline passed; when the baseline was already failing
the test run cannot tell, and is not held against it.

A rejected Step goes back to its leader as a new assignment from the overseer, carrying the
rejection feedback. The leader delegates it to a fresh worker (`<role>-<step>-retry-<n>`) whose
worktree starts from the rejected branch, and reports on the Step again. Nothing rejected is
merged. After two retries a third rejection fails the Step and the Request, with the last feedback,
for the Overseer. `kiln request status` shows each try's Assignment and the Step's retries.

## Not covered here

Following a diagnosis with a fix Request is left to a later ticket.
Escalations to the user are in the [escalation guide](escalations.md). Limits and concurrency caps are in the [limits guide](limits.md). A Step that fails stays failed.
