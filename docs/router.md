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
again 60 seconds after the last successful Nudge. If it remains unread 60 seconds after the third
delivery, the next pass dead-letters it: it is no longer delivered, and a dead-lettered
**assignment** is answered with a synthesised failed result from the recipient to the sender.

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
