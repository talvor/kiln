# Message router and Inbox

Agents talk to each other only through Messages. Each agent works under a **session**, an address
with a role, and Kiln gives it a tool server for that address.

## Sessions and routes

```
kiln session open <address> --role overseer|leader|worker [--department <name>] [--cwd <dir>]
```

There is one overseer, one leader per department, and any number of workers per department. A
Message may only take these routes; anything else is refused with the reason:

| Kind | Goes | Body |
| --- | --- | --- |
| `assignment` | down, to a direct report | `{title, instructions}` |
| `answer` | down, to a direct report | `{answer}`, `inReplyTo` the question |
| `result` | up, to your direct superior | `{status: done\|failed, summary}`, `inReplyTo` the assignment |
| `question` | up, to your direct superior | `{question, context?}`, optional `assignmentId` of the assignment it concerns |

Bodies are validated against the kind's schema (unknown fields are refused). A result or answer
must reply to a Message the recipient sent you, and each assignment or question takes one.

## The agent's tools

`kiln tool-server --address <address>` is an MCP server on stdio configured for one address.
Kiln hands it to every agent it wakes. Tools: `read_inbox` (each unread
Message is handed over once, then marked read), `send`, and `raise_question` (asks your direct
superior). Same-user local processes are trusted for now; session isolation is deferred to the
worker-confinement ticket (#12).

## Nudges, re-nudges and dead letters

Kiln runs a delivery pass every two seconds. A pass wakes each agent with unread Messages by
launching Claude with a short prompt telling it to read its inbox. Each launch has a 30-second
timeout. A failed or timed-out launch does not count as a delivery. An unread Message is nudged
again 60 seconds after the last successful Nudge. After three deliveries,
the next pass dead-letters it: it
is no longer delivered, and a dead-lettered **assignment** is answered with a failed result
(marked synthesised) from the recipient to the sender.

## Stop hook

Nudged agents run `kiln hook stop --address <address>` as a Claude Code Stop hook. It blocks the
stop when the agent has unread Messages, or an assignment it has neither reported on nor asked a
live question about using `assignmentId`. When Claude retries after being blocked
(`stop_hook_active`), the stop is allowed;
an unreported assignment is then reported as a synthesised failed result. If Kiln cannot check
the pending work, the hook blocks the stop until it can.

## Not covered here

Nudges start a fresh Claude each time rather than resuming one, and a dead-lettered Message other
than an assignment is only recorded. Both are left to later tickets.
