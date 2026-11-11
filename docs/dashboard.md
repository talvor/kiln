# The Dashboard

```
kiln dashboard [--port <n>] [--no-open]
```

The Dashboard is a browser window onto Kiln. It runs as its own foreground process, a client of
the daemon's unix socket like the CLI (see `docs/adr/0001-dashboard-is-a-separate-client-process.md`);
the daemon gains no network surface. It never starts the daemon: with Kiln not running the page
still loads and says so.

This first slice serves the page shell and the security around it. Views and actions come later.

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
