# Playbooks and the Request lifecycle

A **Playbook** is the ordered list of department **Steps** Kiln follows for one type of Request.
Kiln ships `diagnose-a-bug`, `design-a-feature`, `plan-a-spec-into-tickets`, `wayfind` and
`implement-a-ticket`.

```
kiln request start <project> --playbook <name> --description <text> [--tracker-item <ref>] [--and-fix]
kiln request status <request-id> [--json]
```

`--tracker-item` is the ticket in the Project's tracker the Request came from (for example `#12`).
It is optional; when given, the leader is told about it and the published ticket refers to it.
`request start` without `--playbook` still just creates the request branch and worktree (see the
[worktrees guide](worktrees.md)).

## The lifecycle

A Request, each of its Steps and each Assignment share four states: `planned`, `active`, `done` and
`failed`. Kiln plays the overseer and walks the Steps one at a time:

1. **Step begins.** Kiln opens the sessions it needs (the overseer, the department's leader, and a
   worker named `<worker-role>-<step-id>`, for example `diagnostician-1`) and sends the leader an
   assignment from the overseer. The Step is `active`.
2. **Delegation.** The leader sends an assignment to that worker. Kiln starts it as an
   **Assignment**, with its own branch and worktree off the request branch (the assignment Message's
   ID is the Assignment's ID), and wakes the worker there. The worker commits the Step's artifact
   and reports a result; the Assignment becomes `done` or `failed`.
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
Request starts. A file replaces the built-in role or Playbook of the same name; the file name is the
name.

```json
// roles/diagnostician.json
{
  "kind": "worker",
  "department": "engineering",
  "prompt": "You are a diagnostician. ...",
  "tools": ["Read", "Glob", "Grep", "Write", "Bash"]
}
```

`kind` is `overseer`, `leader` or `worker`; leaders and workers need a `department`. There must be
one overseer and at most one leader per department. The `prompt` is added to the Nudge whenever Kiln
wakes an agent playing the role. `tools` is optional and lists the built-in tools the role may use
(`Read`, `Glob`, `Grep`, `Write`, `Edit`, `NotebookEdit`, `Bash`); see
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
optional (`"ticket"`, `"draft-pr"`, `"qa-summary"` or `"close-ticket"`), and so are `after`
(`"merge"`: the step waits for the Request's pull request to be merged), `gate` (`"spec-approval"`,
see below) and `findings` (the earlier step QA findings go back to). A file that is not valid is
refused when a Request starts, naming the file and the problem. A Request keeps the Steps it started
with if the file changes later.

## Verification and retries

When the leader reports a Step done, Kiln verifies each worker's Assignment before merging it, in
the Assignment's worktree: the Step's artifact is committed (and starts with a title when it is
published as a ticket), and the Project's setup, lint, build and test commands pass. A test failure
counts against the work when the registered baseline passed; when the baseline was already failing
the test run cannot tell, and is not held against it.

A rejected Step goes back to its leader as a new assignment from the overseer, carrying the
rejection feedback. The leader delegates it to a fresh worker (`<role>-<step>-retry-<n>`) whose
worktree starts from the rejected branch, and reports on the Step again. Nothing rejected is merged.
After two retries a third rejection fails the Step and the Request, with the last feedback, for the
Overseer. `kiln request status` shows each try's Assignment and the Step's retries.

## Designing a feature

`design-a-feature` ends at an approved spec and plans no tickets. The Spec Writer writes `spec.md`;
the Seam Designer reads it and the code and writes `seams.md`: where the feature meets the existing
system and how each seam is tested. Once the Seam Designer's work is verified and merged, the step
holds a **Gate** (`"gate": "spec-approval"` in the step): the Overseer raises an Escalation with the
spec and the seams, and the Request waits for as long as it takes. `kiln approve` finishes the
Request; `kiln reject --reason` sends the step back to the leader with the reason, for a fresh
worker, and the Gate is raised again for the new work. Rejections by the user do not count against
the retry limit.

The **out-of-scope Gate** works in any Playbook: a leader that finds the Request outside the
Project's scope reports its step with status `out-of-scope` instead of `done`. The Overseer raises
an Escalation with the leader's reason. Approved, the step goes back to the leader to carry on;
rejected, the step and the Request fail with the user's reason.

## Planning a spec into tickets

`plan-a-spec-into-tickets` has one step: the Ticket Planner reads the spec (the request's tracker
item, or `spec.md` on the branch) and writes `tickets.json`:

```json
{
  "criteria": { "c1": "Users can export CSV" },
  "tickets": [{ "key": "a", "title": "...", "body": "...", "covers": ["c1"], "blockedBy": [] }]
}
```

The **Leader's checks** run when the leader reports the step done, as part of verification; a
breakdown that fails any of them is rejected like any other work, with the problems as feedback: the
file is valid, **every criterion** of the spec is covered by some ticket, and the tickets'
dependencies have **no cycle**. Once it is merged, Kiln opens the tickets in the tracker
(`"publish": "tickets"`), the ones a ticket is blocked by first so it can list them under "Blocked
by", and then checks **each ticket is in the tracker** (`gh issue view`); one that is not fails the
Request. The URLs are recorded on the Request (`Ticket:` in `kiln request status`).

The **Overseer approves** the breakdown once that holds, with no Gate: the user is **told
afterwards** in the Overseer's news, as [the chat guide](chat.md) describes.

## Wayfinding a ticket

`wayfind` (`--tracker-item #7`) has one step and one worker session per Request. The Wayfinder takes
the one ticket and either **resolves** it (reading the code settles it: it writes the answer) or
**charts** it (it writes the route: the pieces of work in order and what each depends on) in
`wayfinding.md`. Nothing is published; the note is on the request branch once the leader has
verified it.

A step may name a `researchWorker`. When the Request's tracker item is labelled `research`
(`gh issue view --json labels`), that role takes the step instead, so a **research ticket goes to
the Researcher** (`researcher-1`), who answers its question from primary sources. If the labels
cannot be read, or there is no tracker item, the Wayfinder takes it.

## Implementing a ticket

`implement-a-ticket` takes a ticket (`--tracker-item #18`) through to a pull request that has passed
QA, and, once the user has merged it, wraps the ticket up. Its steps:

1. **check-ticket** (Ticket Checker): is the ticket ready to implement? If not, the leader reports
   status `unready`. The Overseer raises a **blocked-on-user** Gate with what is missing and the
   Request waits. `kiln approve` says the ticket is ready now and the step is checked again;
   `kiln reject --reason` fails the Request.
2. **implement** (Implementer): builds the ticket test-first (the `tdd` skill) and writes
   `pull-request.md` (the `pr` skill). Once verified and merged, Kiln opens a **draft** pull request
   from the request branch (`"publish": "draft-pr"`), which stays a draft until QA passes; the
   tracker item is added as `Closes <ref>`. The pull request is recorded on the Request
   (`Pull request:` in `kiln request status`).
3. **review** (Reviewer) and 4. **gatekeep** (Gatekeeper): both check the work and write their
   verdicts. A leader that finds problems reports status `findings` with them in the summary. The
   findings go back to the step named by `findings` (implement) as a new Assignment, from the
   implementer's branch, for a fresh worker (`implementer-2-retry-1`); once it is merged the same
   pull request is updated, and the QA steps begin again with new workers (`reviewer-3-round-1`);
   their earlier verdict files are removed from the request branch first, so a round that writes
   nothing fails verification. Findings sent back do not count as retries, but after two rounds on
   the same QA step the Request fails for the Overseer.

The user hears nothing until QA passes. Then Kiln comments a QA summary (the QA steps' verdicts) on
the pull request, marks it ready for review (`gh pr ready`), both in the gatekeep step's
`"publish": "qa-summary"`, and records a `pr.ready` event. The Overseer simply tells the user the
pull request is ready, with its URL. There is no Gate: nothing to approve or reject. Feedback on the
pull request goes on the pull request itself, or in a new Request.

Kiln never merges. The user merges the pull request, and Kiln finds out on its own: every
`KILN_PR_POLL_SECONDS` (default 60) it asks `gh pr view` for the state of each pull request that
passed QA (the gatekeep step is done) and is waiting, with no model involved.

- **Merged** is the go-ahead: the 5th step, **wrap-up** (Closer, `"after": "merge"`), begins. The
  Closer writes `wrap-up.md`, a short note of what shipped; once it is verified and merged, Kiln
  posts it on the ticket and closes the ticket (`"publish": "close-ticket"`, only when the Request
  has a tracker item). Then Kiln cleans up: the Request's worktrees, its local branches and the
  request branch on the remote. The Request is `done`. A part that cannot be removed is logged and
  left; the Request still ends `done`.
- **Closed without merging** blocks the Request on the user: a **blocked-on-user** Escalation
  carries the pull request's URL. Nothing is removed. `kiln approve` says the pull request is open
  again and Kiln looks at it afresh; `kiln reject --reason` fails the Request. The branches stay
  either way.

## Diagnosing and fixing

`kiln request start <project> --playbook diagnose-a-bug --description "..." --and-fix` chains "and
fix it" onto a diagnosis. Once the diagnosis Request is done and its fix ticket is published, Kiln
starts a second Request on the same Project that follows `implement-a-ticket` with the published
ticket as its tracker item (`kiln request status` on the diagnosis shows `Fix request:`). The fix
Request is an ordinary one: it goes through QA and waits for the user to merge. `--and-fix` is
refused for a Playbook that publishes no ticket. If the fix Request cannot be started the diagnosis
stays done, the failure is logged, and no fix Request is recorded.

## Not covered here

Escalations to the user are in the [escalation guide](escalations.md). Limits and concurrency caps
are in the [limits guide](limits.md). A Step that fails stays failed.
