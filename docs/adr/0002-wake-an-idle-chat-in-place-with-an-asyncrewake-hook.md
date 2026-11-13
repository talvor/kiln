# An idle chat is woken in place by an asyncRewake hook, not restarted

Mail and finished-request news for the Overseer must reach an idle `kiln chat` without a user prompt
(#98). #104 did it by ending the session and starting a fresh one seeded with a digest, which closes
and reopens the chat the user is typing in. Instead, a **Wake** is a command hook registered with
`asyncRewake: true` that waits on the daemon and exits 2 with a short pointer when there is news;
Claude Code wakes the idle session in place and keeps its history. Replacement stays only for crash
recovery and context rollover.

Considered and rejected: channels (an MCP server pushing into the live session) are the
purpose-built mechanism but are a research preview that needs an unlisted flag and a confirmation
dialog on every `kiln chat` start, so they wait for a later spike; a bell or desktop notification
alone only alerts the user, so the #98 stall would remain; injecting into a pty is undocumented and
races with typing and dialogs; `--input-format stream-json` and Remote Control cannot drive an
interactive session.

Consequences, from tests on Claude Code 2.1.323 (`docs/research/waking-an-idle-chat.md`):

- A hook is silently killed at its `timeout` and nothing re-arms it, so the daemon notices a chat
  with pending news and no live waiter and the `kiln chat` parent rings the terminal bell.
- Every turn end, `/clear` and `/compact` starts another hook. The daemon keeps one waiter per chat;
  a newer one supersedes the older, and news is handed to exactly one waiter.
- News counts as told when handed to the waiter. Mail stays unread until the Overseer reads its
  inbox, so a wake into a vanished session loses nothing.
- A wake during a turn is injected into that turn after the tool result. It is allowed.
- The model sees the wake as a "Stop hook feedback" system reminder labelled a blocking error, so
  the text must say plainly that it is news for the Overseer.
