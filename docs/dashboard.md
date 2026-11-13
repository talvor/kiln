# The Dashboard

```
kiln dashboard [--port <n>] [--no-open]
```

The Dashboard is a browser window onto Kiln. It runs as its own foreground process, a client of the
daemon's unix socket like the CLI (see `docs/adr/0001-dashboard-is-a-separate-client-process.md`);
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
Source `dashboard`. The collapsed **Recently decided** list holds the last 20 decisions, newest
first, with their outcome, time, Source and any reason.

The **header strip** shows what needs attention at a glance: **Halted** (with how long ago), **Daily
cap reached**, and the number of **Stuck agents**, plus today's spend against the daily cap (or just
today's spend when no cap is set). A **Health** link stays visible while Kiln runs, and the spend
chip links to the Cost view below. **Halt** shows while Kiln is running and **Resume** while it is
halted or has Stuck agents; each is one click, with no confirmation, and records Source `dashboard`.
A held key or double click counts once, and the buttons ignore clicks while one is in flight. The
strip's facts come from `health.report`, in the same snapshot as Needs you.

Under Needs you, the **Requests** rail lists the Requests that are running or waiting, and those
that failed in the last 24 hours. An unfinished one with an open Escalation is marked **waiting on
you**. **Show finished** adds the Requests that finished or failed longer ago. A failure without an
end event uses its last recorded event for the 24-hour check; without any timestamp it appears only
under **Show finished**. Selecting one opens its Request page at `/requests/<id>`. The **Overview**
shows the step timeline with each step's assignments, the Budget bar (cost against the Request's
Budget) and a live event feed that updates as events arrive. A running or waiting Request has
**Cancel**: it asks "Cancel Request N?" first; only the confirmation cancels. As with **Approve
anyway**, a double click or a held key cannot confirm. The Request then shows as failed, and the
cancel records Source `dashboard`.

The **Transcript** tab (`/requests/<id>/transcript`) loads the Request's Messages, oldest first, and
appends new ones live while the Request is active. Each shows sender → recipient and kind, with
badges for Messages written by Kiln and for dead-lettered ones. Text is plain (never interpreted as
HTML) and cut at about 600 characters with **Show more**.

The **Report** tab (`/requests/<id>/report`) shows how the Request went, as `kiln report` does: the
outcome, timings, cost against Budget, each step's report, the Escalations raised (with the Source
of each decision) and the branch, tickets and pull request. A running or waiting Request opens on
Overview; a finished or failed one opens on Report. The Overview tab has its own address
(`/requests/<id>/overview`) once the Request has finished.

The **Cost view** (`/cost`, opened from the spend chip) shows today's spend against the daily cap
(or today's spend alone when no cap is set), a table per Project (today) and per Request (today,
total, and total against its Budget), and the unclaimed spend no Request claims, such as the
Overseer's. It comes from `cost.report` and refreshes with the rest of the page. Only Requests that
spent something today are listed.

The strip's conditions (**Halted**, **Daily cap reached**, **Stuck agents**) and its persistent
**Health** link open the Health view at `/health`. It shows the daemon's version, pid and uptime,
with **Halt** or **Resume** as in the strip, then the Stuck agents, the faults and the paused
Projects, all read-only. **Run checks** runs the same checks as `kiln doctor` when you click it, one
run at a time, and lists each result; nothing runs until you ask. Dashboard checks never start the
daemon. When Kiln is down, the SQLite check reports **Kiln is not running**.

Views have their own addresses (`/`, `/cost`, `/health`, `/escalations/<id>`, `/requests/<id>`,
`/requests/<id>/overview`, `/requests/<id>/transcript` and `/requests/<id>/report`), so reload, back
and forward work, and moving between them swaps the main area without reloading the page.

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
refused; after a few retries, its page says the dashboard was restarted or stopped and asks you to
open the new URL printed by `kiln dashboard`. The same message appears if the old server is
unreachable after a restart on another port.

## Starting it

- The first line on standard output is the URL, with a per-launch token:
  `http://127.0.0.1:<port>/?token=<token>`. Anything else the command says goes to standard error.
- It listens on 127.0.0.1 only, on a free port; `--port` picks one.
- Unless `--no-open`, it opens the URL in your default browser.
- Ctrl-C stops it. Two launches are independent, each with its own port and token; nothing is shared
  or locked.

## What protects it

The Dashboard can approve spend, so anything else on the machine that can reach a loopback port must
not be able to drive it.

- The token exists only in the dashboard's memory. It is printed in the URL and never put in the
  process's arguments, its environment or any file. The command that opens your browser is given a
  different one-time launch link, which dies when either it or the token is used.
- Opening the URL exchanges the token, once, for a session cookie (`HttpOnly`, `SameSite=Strict`)
  and redirects to a clean URL. The token is then dead. An HTTP request without the cookie is
  refused, and so is every request after a restart, since the cookie belongs to the old process.
- `Host` is checked on every HTTP request and `Origin` on every one that changes something; a
  refused request never reaches the daemon.
- GET requests have no side effects.

The risk that remains: a process running as you can read the dashboard's memory. Agents are kept
away by the policing hook, which refuses a shell command (`Bash`) aimed at the port of a running
Dashboard: one that names the port and either a loopback address (`localhost`, `127.x.x.x`, `::1`,
`0.0.0.0`, `/dev/tcp/...`) or a network client (`curl`, `nc`, `python`, ...). The port is not secret;
each Dashboard records it as a file named for the port in the `dashboards` folder of the daemon's
runtime directory while it runs, and removes it when it stops. The refusal is raised like any other:
a question to the agent's direct superior.

That is a guard against an agent wandering onto the Dashboard, not a boundary. It is a pattern match
on the command text, so a determined same-user process gets past it (a port built up at run time, a
hostname that resolves to loopback, a script written to a file and run, reading the dashboard's
memory through `/proc` or a debugger), and a Dashboard that was killed rather than stopped leaves a
stale port file, which keeps refusing that port until the file is deleted. Agents run sandboxed and
without the user's secrets, which is the real limit on what they can reach. Anything running as you,
outside Kiln's agents, is trusted as much as you are. Reaching the Dashboard from another device
means tunnelling to the loopback port yourself.
