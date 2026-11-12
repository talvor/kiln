# The Dashboard

```
kiln dashboard [--port <n>] [--no-open]
```

The Dashboard is a browser window onto Kiln. It runs as its own foreground process, a client of
the daemon's unix socket like the CLI (see `docs/adr/0001-dashboard-is-a-separate-client-process.md`);
the daemon gains no network surface.

The page is a split pane. The left rail holds **Needs you**: the open Escalations, grouped by
Project, oldest first, each row showing its Gate kind (or `No gate`), Request, summary and age.
Escalations whose Request has ended are stale: they sit in a dimmed group and cannot be acted on.
Selecting a row expands it to the full detail as plain text (whitespace kept; nothing an agent wrote
is read as Markdown or HTML). The tab title shows the open count, e.g. `(2) Kiln`. The favicon uses
`9+` above nine.

The selected Escalation has **Approve** (one click) and **Reject** (it needs a reason). The daemon's
refusals are shown as worded, for instance when the Escalation was already decided or went stale.
Approving a `qa-passed` Gate whose pull request is not merged is refused by the daemon; the page
shows that and offers **Approve anyway**, which sends the confirmation. Decisions made here record
Source `dashboard`. Below Needs you, the collapsed **Recently decided** list holds the last 20
decisions, newest first, with their outcome, time, Source and any reason.

The **header strip** shows what needs attention at a glance: **Halted** (with how long ago),
**Daily cap reached**, and the number of **Stuck agents**, plus today's spend against the daily cap
(or just today's spend when no cap is set), which links to `/cost`. The Cost view itself comes in a
later change. **Halt** shows while Kiln is running and **Resume** while it is halted or has Stuck
agents; each is one click, with no confirmation, and records Source `dashboard`. A held key or double
click counts once, and the buttons ignore clicks while one is in flight. The strip's facts come from
`health.report`, in the same snapshot as Needs you.

Views have their own addresses (`/`, `/cost` and `/escalations/<id>`), so reload, back and forward
work, and moving between them swaps the main area without reloading the page.

One Server-Sent Events stream per tab tells the page that something happened in Kiln, and the page
re-fetches its snapshot, debounced. It also re-fetches every 30 seconds so the strip picks up a new
day's spend or a changed daily cap without an event. The dashboard long-polls for changes
(`events.since`) while at least one tab is connected. A poll already in flight may finish after the
last tab leaves; its result is discarded.

## When Kiln is not running

The dashboard keeps serving. The page shows a **Kiln is not running** banner, and the dashboard
retries the daemon's socket with backoff (0.5 s, doubling to 10 s) for as long as a tab is open.
When the daemon is back, every tab is told and does a full refresh of its snapshot. The dashboard
never starts the daemon; run `kiln daemon start` yourself.

Each change the stream announces carries the event id (`id:`), so a tab whose stream drops
reconnects with `Last-Event-ID` and resumes from there: it is told at once only if something
happened while it was away. A dashboard restart gives a new session cookie, so an old tab is
refused; after a few retries, its page says the dashboard was restarted or stopped and asks you
to open the new URL printed by `kiln dashboard`. The same message appears if the old server is
unreachable after a restart on another port.

## Starting it

- The first line on standard output is the URL, with a per-launch token:
  `http://127.0.0.1:<port>/?token=<token>`. Anything else the command says goes to standard error.
- It listens on 127.0.0.1 only, on a free port; `--port` picks one.
- Unless `--no-open`, it opens the URL in your default browser.
- Ctrl-C stops it. Two launches are independent, each with its own port and token; nothing is shared
  or locked.

## What protects it

The Dashboard can approve spend, so anything else on the machine that can reach a
loopback port must not be able to drive it.

- The token exists only in the dashboard's memory. It is printed in the URL and never put in the
  process's arguments, its environment or any file. The command that opens your browser is given
  a different one-time launch link, which dies when either it or the token is used.
- Opening the URL exchanges the token, once, for a session cookie (`HttpOnly`, `SameSite=Strict`)
  and redirects to a clean URL. The token is then dead. An HTTP request without the cookie is refused,
  and so is every request after a restart, since the cookie belongs to the old process.
- `Host` is checked on every HTTP request and `Origin` on every one that changes something; a
  refused request never reaches the daemon.
- GET requests have no side effects.

The risk that remains: a process running as you can read the dashboard's memory. Keeping agents
away (the policing hook refusing their shell commands aimed at the dashboard port) comes in a later
change. Reaching the
Dashboard from another device means tunnelling to the loopback port yourself.
