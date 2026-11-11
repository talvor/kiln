# The Dashboard

```
kiln dashboard [--port <n>] [--no-open]
```

The Dashboard is a browser window onto Kiln. It runs as its own foreground process, a client of
the daemon's unix socket like the CLI (see `docs/adr/0001-dashboard-is-a-separate-client-process.md`);
the daemon gains no network surface. It never starts the daemon: with Kiln not running the page
still loads and says so.

The page is a split pane. The left rail holds **Needs you**: the open Escalations, grouped by
Project, oldest first, each row showing its Gate kind, Request, summary and age. Escalations whose
Request has ended are stale: they sit in a dimmed group and cannot be acted on. Selecting a row
expands it to the full detail as plain text (whitespace kept; nothing an agent wrote is read as
Markdown or HTML). The tab title and favicon carry the open count, e.g. `(2) Kiln`.

Views have their own addresses (`/` and `/escalations/<id>`), so reload, back and forward work, and
moving between them swaps the main area without reloading the page.

One Server-Sent Events stream per tab tells the page that something happened in Kiln, and the page
re-fetches its snapshot, debounced. The dashboard asks the daemon for events (`events.since`) only
while at least one tab is connected. Actions and the other views come later.

## Starting it

- The first line on standard output is the URL, with a per-launch token:
  `http://127.0.0.1:<port>/?token=<token>`. Anything else the command says goes to standard error.
- It listens on 127.0.0.1 only, on a free port; `--port` picks one.
- Unless `--no-open`, it opens the URL in your default browser.
- Ctrl-C stops it. Two launches are independent, each with its own port and token; nothing is shared
  or locked.

## What protects it

The Dashboard will be able to approve spend, so anything else on the machine that can reach a
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
