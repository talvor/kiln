# Budgets, the daily cap, the digest and notifications

A [limit](limits.md) bounds one Assignment. A **budget** bounds money across many: what all the
work of one Request may cost, and what all of Kiln may spend in a day. Both are optional and come
from `limits.json` in the config directory, which Kiln reads again about every second.

```json
{
  "budgets": { "requestUsd": 5, "dailyUsd": 20 },
  "projects": { "my-project": { "requestUsd": 3 } },
  "notify": { "command": "notify-send Kiln", "digestAt": "08:00" }
}
```

A Project's `requestUsd` replaces `budgets.requestUsd` for Requests on that Project.

## What counts

Every launch's cost is kept. It is charged to the Request the agent was working for: a worker's
Assignments, or the Steps its department's leader holds. Spend no Request claims (the Overseer's
own launches) counts towards the day but towards no Request. What you spend in an interactive
`kiln chat` is not Kiln's to see and is not counted.

## A Request's budget

- At **80%** you are notified, once per Request and budget.
- At **100%** the Request is **blocked on you**: an Escalation (see the
  [escalation guide](escalations.md)) says so, you are notified, its workers are stopped and
  nobody is woken for it. Its Assignments' clocks stop while it waits.
  - `kiln approve <id>` gives it another budget's worth (the Request's budget becomes what it
    has spent plus `requestUsd`) and the work carries on.
  - `kiln reject <id> --reason <text>` fails the Request with your reason.

## The daily cap

The day is your local day. At **80%** of `dailyUsd` you are notified, once a day. At **100%** you
are notified and Kiln stops all work as a halt does: running agents are stopped and nobody is
woken, for any Request. It carries on by itself when the day ends or when you raise `dailyUsd`;
the wait does not count against the Assignments' clocks. `kiln halt` and `kiln resume` are
separate and unaffected.

## `kiln cost`

```
kiln cost [--json]
```

Shows today's spend against the daily cap, by Project and by Request (with each Request's budget).
`kiln request status` shows a Request's cost, finished or not, and the budget it runs under.

## Notifications

`notify.command` is run with `sh -c` for each notification, with the text on its standard input and
`KILN_NOTIFICATION_KIND` (`budget-warning`, `budget-blocked`, `daily-warning`, `daily-cap` or
`digest`) and `KILN_NOTIFICATION_TITLE` in its environment. A command that fails or hangs (it is
stopped after 30 seconds) is logged and never stops the work. With no command nothing is sent
outside the chat; the news is still waiting when you attach.

## The daily digest

Once a day, at `notify.digestAt` (local time, default `08:00`) or the first moment after, Kiln
sends the digest as a notification: what finished (with its cost), what failed, budget news,
agents Kiln gave up on, and the decisions still waiting for you, with today's spend. **When
nothing happened there is no digest**, and the day's digest is then not sent at all.

When you attach with `kiln chat` the Overseer is given the same news (and today's spend) and tells
you what is yours to act on, as the [chat guide](chat.md) describes. News you were told there is
not repeated in the digest.
