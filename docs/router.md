# Message router and Inbox

Agents talk to each other only through Messages. Each agent works under a **session**, an address
with a role, and Kiln gives it a tool server for that address.

## Sessions and routes

```
kiln session open <address> --role overseer|leader|worker [--department <name>] [--cwd <dir>]
```

There is one overseer, one leader per department, and any number of workers per department. A
Message may only take these routes; anything else is refused with the reason:

| Kind | Goes | Reply |
| --- | --- | --- |
| `assignment` | down, to a direct report | None |
| `answer` | down, to a direct report | `inReplyTo` the question |
| `result` | up, to your direct superior | `inReplyTo` the assignment |
| `question` | up, to your direct superior | Optional `assignmentId` of the assignment it concerns |

The [message schemas](../src/messages.ts) own the body fields. Required fields must be present,
all supplied fields must be non-empty strings, and unknown fields are refused. A result or answer
must reply to a Message the recipient sent you. Each assignment takes one result; each question
takes one answer.

## The agent's tools

`kiln tool-server --address <address>` is an MCP server on stdio configured for one address.
Kiln hands it to every agent it wakes. Tools: `read_inbox` (each unread
Message is handed over once, then marked read), `send`, `raise_question` (asks your direct
superior), and, for the overseer, `raise_escalation`, `read_escalations` (see
[escalations](escalations.md)), `list_projects`, `list_playbooks`, `start_request` and
`request_status` (see [the chat guide](chat.md)). Same-user local processes are trusted for now.

### Optional: a scoped token so a worker's own `gh` works

A worker's sandbox cannot see Kiln's GitHub credentials (`~/.config/gh` is unreadable), so a bare
`gh` in its shell is unauthenticated. To fix that without handing over your own token, create a
GitHub App, give it read-only repository permissions (Metadata, Issues, Pull requests, Contents,
Actions), install it on the Projects' repositories, download its private key, and write
`<config>/github.json`:

```json
{
  "app": { "id": 123456, "privateKeyFile": "~/.config/kiln/github-app.pem" },
  "permissions": { "issues": "read", "pull_requests": "read", "contents": "read" },
  "apiUrl": "https://api.github.com"
}
```

Only `app` is required; `permissions` defaults to the read-only set above. Before a worker is
launched in a Request's or Assignment's Worktree, Kiln asks GitHub for an installation token
limited to **that Project's repository** and those permissions, and gives it to the worker as
`GH_TOKEN` and `GITHUB_TOKEN`. It lasts about an hour and is cached per repository until ten minutes
remain, so a launch never outlives it. The sandbox's network allowlist gains `api.github.com` and
`github.com` for that launch. Without the file, or if a token cannot be had (the App is not
installed there, GitHub says no), the worker gets none and Kiln logs a warning. Your own
credentials are never passed on. The file is read at each launch.

A worker can read its own environment, so the token is visible to it: keep the permissions minimal,
and do not grant `write` unless you want workers to be able to push or comment. For GitHub
Enterprise, set `apiUrl`; the sandbox allowlist is still `github.com` for now.

#### Fallback: your own token, when no App is set up

If you have not set up a GitHub App (there is no `github.json`) you can instead share your own
token, with `<config>/worker-gh-token.json`. It is **off unless this file exists**, and it is only a
fallback: whenever `github.json` exists, the App's token is used and this file is ignored. If the
App is set up but cannot give a token (for example it is not installed on that repository), the
worker gets none; Kiln does not widen to your own token.

```json
{ "source": "gh", "projects": ["kiln"] }
```

```json
{ "source": "env", "variable": "KILN_WORKER_GH_TOKEN" }
```

- `source: "gh"` uses the token `gh auth token` prints for your login (reused for a minute).
- `source: "env"` uses the token in that environment variable of the daemon. Prefer this with a
  **fine-grained personal access token** limited to the repositories and permissions workers need.
- `projects` (optional) limits it to those Projects' workers; without it, every Project's.

The token reaches a worker the same way as the App's (`GH_TOKEN` and `GITHUB_TOKEN`, and the sandbox
may reach `github.com`). Each launch that gets your own token is recorded as a `worker.token` event
(project and source, never the token). If the token cannot be had, Kiln logs a warning and the
worker gets none. The file is read at each launch.

This is the blunt option. A worker can read its own environment, and a `gh` source carries
everything you can do on GitHub (write, delete, other repositories); a prompt-injected ticket could
try to leak it. Set up the App instead whenever you can.

## Worker confinement

Every agent Kiln wakes runs deny-by-default: it may use only the built-in tools its role lists
(`tools` in the role file; defaults are read-only for the overseer (and only on the registered
projects), read-only for leaders, and read/write/shell for workers) plus Kiln's own tools. A command sandbox limits writes to the
agent's Worktree. A policing hook checks every tool call against the same rules: file writes
outside the Worktree, secrets (`.env`, keys, `.ssh`, `.aws`, ...) and destructive commands (`sudo`,
`git push`, `reset --hard`, `rm -rf /`, piping a download into a shell, ...) are refused. A refusal
is never prompted; Kiln raises it as a question to the agent's direct superior (repeats are
suppressed while one is unanswered) and tells the agent the answer will arrive in its inbox.

## Nudges, re-nudges and dead letters

Kiln runs a delivery pass every two seconds. A pass wakes each agent with due unread Messages by
launching Claude with a short prompt telling it to read its inbox. Each launch has a 30-second
timeout. A failed or timed-out launch does not count as a delivery. An unread Message is nudged
again 60 seconds after the last successful Nudge (`KILN_RENUDGE_SECONDS` changes the wait). If it
remains unread that long after the third delivery, the next pass dead-letters it: it is no longer
delivered, and a dead-lettered **assignment** is answered with a synthesised failed result from the
recipient to the sender.

## Stop hook

Nudged agents run `kiln hook stop --address <address>` as a Claude Code Stop hook. It blocks the
stop when the agent has unread Messages, or an assignment it has neither reported on nor asked a
live question about using `assignmentId`. When Claude retries after being blocked
(`stop_hook_active`), the stop is allowed; an unreported assignment is then reported as a
synthesised failed result. If Kiln cannot check the pending work, the hook blocks the stop until
it can.

## Not covered here

A dead-lettered Message other than an assignment is only recorded; that is left to a later ticket.
A nudge that delivers an answer resumes the asking agent's own Claude session, and how questions
are passed up is in [question relay](questions.md).
