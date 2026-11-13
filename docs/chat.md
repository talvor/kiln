# Talking to the Overseer

```
kiln chat
```

`kiln chat` opens an interactive Claude Code session as the **Overseer**, the one role you talk to.
It runs the installed `claude` in `<data>/overseer`, an empty directory, with Kiln's tools, a Kiln
status line and Kiln's hooks. Ctrl-C and everything else belong to Claude; leaving Claude leaves the
chat.

## What the Overseer has

- **Kiln's tools**, over MCP: `list_projects`, `list_playbooks`, `start_request`, `request_status`,
  `read_inbox`, `raise_escalation` and `read_escalations`. Only the Overseer may use them; Claude's
  own other tools and servers are not offered.
- **Read-only access** to the registered projects: `Read`, `Glob` and `Grep` on their clones and
  nothing else. It cannot write, run commands or read secrets, or read outside the projects; the
  policing hook refuses such calls. Work happens by starting a request.
- **A status line**: `kiln · 1 decision waiting · 2 requests active · 3 unread`, or
  `kiln · all quiet`.

## Start now or ask first

The Overseer starts a request at once when you have named, or it can tell, the project, a playbook
that fits and what you want. It asks one short question first when the project is unclear, not
registered or paused, no playbook fits, or the request is too vague to build one thing from. A
question about the code is answered from the files; it is not a request.

## Speaking unprompted

The Overseer speaks without being asked only for something that is yours to act on: a decision
waiting for you, a request that finished or failed, or mail in its inbox that needs you. Otherwise
it stays quiet. A fresh session opens silent unless there is such news, in which case the Overseer
is asked to tell you, once.

Mail for the Overseer is not delivered by a Nudge while you are in the chat (it would wake a second
Overseer beside yours). When the chat is idle, incoming mail or a finished request starts a fresh
session with a digest, so the Overseer can tell you without waiting for a prompt. During a turn,
unread mail is shown in the status line, noted to the Overseer on your next prompt, and the
Overseer may not end the turn with it unread. Kiln does not wake the chat while work is halted or
the daily cap is reached. When you leave, Nudges resume.

## Commands that need no model

Typed in the chat, these are answered by Kiln and never reach the Overseer:

```
kiln status              what waits for you and what is running
kiln escalations         the decisions waiting for you
kiln projects            the registered projects
kiln approve <id>        approve an escalation (you, not the Overseer, decide)
kiln reject <id> <why>   reject an escalation, saying why
kiln help
```

## History and rollover

What you and the Overseer say is kept in the store (append-only). When a session's context grows
past 150,000 tokens (`KILN_CHAT_ROLLOVER_TOKENS` changes the limit), Kiln ends it after the turn and
starts a fresh one, seeded with a **digest**: the projects, what is running, the news for you, and
the last 20 turns of the conversation. Starting `kiln chat` later is seeded the same way.
