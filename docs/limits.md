# Limits, concurrency caps and parallel Assignments

Kiln bounds what each Assignment may use, and how many run at once. Everything is read from
`limits.json` in the config directory each time Kiln needs it; every field is optional.

```json
{
  "defaults": { "turns": 50, "spendUsd": 1, "seconds": 1800, "idleSeconds": 600 },
  "concurrency": { "global": 4, "perProject": 2 },
  "projects": {
    "my-project": { "ceiling": { "turns": 80, "spendUsd": 2, "seconds": 3600 }, "maxActive": 3 }
  }
}
```

A file that is not valid is refused when a Request starts, naming the field.

## Limits

An Assignment runs under a **budget**: the defaults, or what its leader asked for with `maxTurns`,
`maxSpendUsd` and `maxSeconds` in the assignment Message, never above the Project's `ceiling`.

- **Turns** and **spend** are summed over every launch of the worker for the Assignment. Each launch
  is told how much is left, so the Claude run itself stops at the limit.
- **Wall-clock** (`seconds`) counts from the Assignment starting, not from it being planned.
- **Inactivity** (`idleSeconds`): a worker with no sign of life (activity during a launch, or a
  launch that ran) for that long is stopped. Waiting for the next Nudge counts as inactive.

Kiln checks the wall-clock and inactivity limits every half second, apart from message delivery,
so a worker that hangs cannot hide from them.

Money across many Assignments (a budget per Request, a daily cap) is covered by the
[budgets guide](budgets.md).

## Limit reached

Kiln stops the worker, marks the Assignment `failed` with the limit that tripped
(`kiln request status` shows `stopped at its turns limit`, and `--json` has `limitReached`,
`turnsUsed`, `spendUsd` and `budget`), and sends the leader a failed result written by Kiln. The
result names the limit and the leader's options:

1. **Continue**: send the worker a new assignment. It starts from the stopped Assignment's branch
   (committed work carries over), and may ask for more with `maxTurns`, `maxSpendUsd` or
   `maxSeconds`, up to the ceiling.
2. **Split**: send smaller assignments, each saying which paths it owns.
3. **Give up**: report the step `failed` to the overseer.

## Caps and Planned queuing

At most `concurrency.global` Assignments are active in all of Kiln and `concurrency.perProject`
(or the Project's `maxActive`) in one Project. A new Assignment over a cap is `planned`: it has no
branch or worktree, its worker is not woken, and it starts, oldest first, as soon as a slot frees.

## File ownership

An assignment may declare `owns`: the paths it will change, comma separated. A path owns everything
beneath it. Within a Request, an Assignment whose paths overlap an earlier one that is still
planned or active waits as `planned`. When it starts, its branch begins from the finished
Assignment's branch, so the later change sits on top of the earlier one.

## Conflicts

Work whose Assignments were not kept apart can still conflict when merged. A merge conflict does
not fail the Step: the conflicting Assignment fails, and Kiln sends the leader a new assignment from
the overseer to resolve it. It goes to a fresh worker whose worktree starts from the conflicting
branch, and counts as one of the Step's two retries (see the [playbooks guide](playbooks.md)).
