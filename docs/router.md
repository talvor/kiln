# Message router and Inbox

Agents talk to each other only through Messages. Each agent works under a **session**, an address
with a role, and Kiln gives it a tool server for that address.

## Sessions and routes

```
kiln session open <address> --role overseer|leader|worker [--department <name>] [--cwd <dir>]
kiln session list [--json]
```

There is one overseer, one leader per department, and any number of workers per department. A
Message may only take these routes; anything else is refused with the reason:

| Kind | Goes | Body |
| --- | --- | --- |
| `assignment` | down, to a direct report | `{title, instructions}` |
| `answer` | down, to a direct report | `{answer}`, `inReplyTo` the question |
| `result` | up, to your direct superior | `{status: done\|failed, summary}`, `inReplyTo` the assignment |
| `question` | up, to your direct superior | `{question, context?}` |

Bodies are validated against the kind's schema (unknown fields are refused). A result or answer
must reply to a Message the recipient sent you, and each assignment or question takes one.

## The agent's tools

`kiln tool-server --address <address>` is an MCP server on stdio, bound to one address, so an agent
can only act as itself. Kiln hands it to every agent it wakes. Tools: `read_inbox` (each unread
Message is handed over once, then marked read), `send`, and `raise_question` (asks your direct
superior).

## Nudges, re-nudges and dead letters

Kiln runs a delivery pass every few seconds (`KILN_ROUTER_TICK_MS`, default 2000; `0` turns the
timer off). A pass wakes each agent with unread Messages by launching Claude with a short prompt
telling it to read its inbox. An unread Message is nudged again once the last Nudge is
`KILN_RENUDGE_AFTER_MS` old (default 60000). After three Nudges, the next pass dead-letters it: it
is no longer delivered, and a dead-lettered **assignment** is answered with a failed result
(marked synthesised) from the recipient to the sender.

`kiln router tick` runs a delivery pass now. `kiln messages [--to <a>] [--from <a>] [--json]`
shows every Message with its read, Nudge and dead-letter state.

## Stop hook

Nudged agents run `kiln hook stop --address <address>` as a Claude Code Stop hook. It blocks the
stop when the agent has unread Messages, or an assignment it has neither reported on nor asked a
question about. When Claude retries after being blocked (`stop_hook_active`), the stop is allowed;
an unreported assignment is then reported as a synthesised failed result.

## Not covered here

Nudges start a fresh Claude each time rather than resuming one, and a dead-lettered Message other
than an assignment is only recorded. Both are left to later tickets.
