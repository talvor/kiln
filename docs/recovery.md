# Startup, recovery, halt and cancel

None of this involves a model: Kiln does it on its own.

## Startup

When the daemon starts it runs these steps in order, and `kiln daemon status --json` lists them
(`startup`) as they complete:

1. **store**: open the store, back it up and migrate it if its schema is old.
2. **halt**: note whether Kiln was halted. A halt survives a restart; nothing below wakes anyone
   while it holds.
3. **interrupted-launches**: a launch that began and never ended was cut short by the crash. The
   Assignment it was working on is put back in its agent's inbox and the agent is woken again,
   told that Kiln was interrupted. The same work interrupted a second time fails: its leader gets a
   failed result written by Kiln, and the Overseer a stuck report.
4. **worktrees**: an active Assignment whose Worktree is gone fails the same way.
5. **conductor**: whatever is due for active Requests is done.
6. **pages**: Escalation pages are brought up to date.
7. **clocks**: only now do the delivery, limit and pull request clocks start.

A step that fails is logged, and the daemon starts regardless.

## Infrastructure retries

When a launch fails for reasons outside the work (the launcher did not start, died without a
result, or hung past its time), Kiln wakes the agent again after a backoff that doubles each time
(at most an hour). Once the budget is spent the agent is **stuck**: Kiln stops waking it, fails its
open Assignments with a result written by Kiln, and tells the Overseer (a question from the agent's
leader, and the Overseer's chat tells the user). `limits.json` sets the budget:

```json
{ "infrastructure": { "retries": 4, "backoffSeconds": 30 } }
```

`retries` is how many times Kiln tries again after the first failure. A worker's hang is not a
launch failure: the Assignment's inactivity limit stops it (see `limits.md`).

## Halt and resume

`kiln halt` stops all work: running agents are stopped, nobody is woken, no Request advances, no
new Request starts, and the limit clocks of active Assignments are paused. Work an agent was in the
middle of is put back in its inbox. `kiln resume` carries on, and also tries again the agents Kiln
had given up on. Both can be typed in `kiln chat` too, where they never reach the Overseer.

## Cancel

`kiln request cancel <id>` stops a Request's workers and fails it ("Cancelled by the user."). Its
branches, its Worktrees and what was pushed are all kept: nothing is cleaned up. Nobody is woken
for work that belongs to it afterwards.
