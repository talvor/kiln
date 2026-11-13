# Waking an idle `kiln chat` without restarting it

Research for issue #105 (rework of #104, which fixed #98). Question: how can Kiln's daemon push a
message or wake-up into a RUNNING INTERACTIVE `claude` session, so the user's open chat is not
closed and reopened? Checked against Claude Code 2.1.323 (the installed binary), its `--help`, and
the official docs at code.claude.com (fetched 2026-11-13). No blog posts were used. `docs/research/`
did not exist; `docs/` holds flat topic notes plus `docs/adr/`, so this note starts
`docs/research/`.

## How Kiln launches claude today

`src/chat_cli.ts` runs `claude` interactively with inherited stdio and `--settings` carrying a
`statusLine` command and hooks (`PreToolUse` police, `UserPromptSubmit`, `Stop`), plus
`--mcp-config` with a stdio `kiln` MCP server and `--strict-mcp-config`. The parent process
heartbeats to the daemon; on `wake` it SIGTERMs claude and starts a new session with a digest. That
is the behaviour #105 wants gone.

## Findings

### 1. Hook with `asyncRewake` (recommended). VERIFIED locally on 2.1.323

Doc (https://code.claude.com/docs/en/hooks, command hook fields): "`asyncRewake` ... If `true`, runs
in the background and wakes Claude on exit code 2. The hook's stderr, or stdout if stderr is empty,
is shown to Claude as a system reminder so it can react". Doc ("Run hooks in the background",
Limitations): "Hook output is delivered on the next conversation turn. If the session is idle, the
response waits until the next user interaction. Exception: an `asyncRewake` hook that exits with
code 2 wakes Claude immediately even when the session is idle." Doc: "Once an async hook is running
in the background, Claude Code doesn't enforce `timeout` on it. Claude Code still enforces `timeout`
on a hook you run with `asyncRewake`." The binary contains the `asyncRewake` string.

Experiment (this research): a `SessionStart` hook `{"asyncRewake":true,"timeout":120}` running
`sleep 12; echo "...reply with exactly the word PONGXYZ" >&2; exit 2`, in an interactive `claude`
under a pty with no prompt typed. About 12 s later the idle session started a turn on its own and
answered `PONGXYZ`; the UI labelled it "Stop hook feedback". So an idle interactive session IS
woken.

- Idle session: yes (doc and experiment).
- Special start: no new flag; one more hook entry in the `--settings` Kiln already passes. Works in
  the same session, so history and context are kept.
- Failure modes: (a) `timeout` is enforced, so a long-poll hook dies at the timeout and nothing
  re-arms it until another hook event fires; (b) one hook process is one wake, so it must be
  re-armed after each wake (e.g. also register it on `Stop`); (c) the wake text is a system
  reminder, not a user message, and carries a "hook feedback" label; (d) what exactly happens if the
  hook exits 2 mid-turn is not documented (doc says output lands "on the next conversation turn";
  open question); (e) `--bare` and `disableAllHooks`-style modes skip hooks (not used by Kiln).

### 2. Channels: MCP server pushing `notifications/claude/channel`. Documented, research preview

Docs: https://code.claude.com/docs/en/channels and /channels-reference. "A channel is an MCP server
that pushes events into your running Claude Code session". Contract: declare
`capabilities.experimental['claude/channel']`, emit `notifications/claude/channel` with `content`
and `meta`, connect over stdio. This matches Kiln's existing stdio MCP server. Events "queue into
the session and are processed in order. If several notifications arrive while Claude is busy,
they're delivered together on the next turn". The event is shown as `<channel source="...">`, and
the terminal shows `← source: text`. The binary contains `notifications/claude/channel`.

- Idle session: yes by design (the doc's "fakechat"/webhook examples push into an open idle
  session); not run locally by me (UNVERIFIED here).
- Special start: yes. `--channels` only accepts an Anthropic allowlist; a custom server needs
  `--dangerously-load-development-channels server:kiln`, which "shows a full-screen warning dialog"
  at each launch that the user must confirm. Neither flag appears in `claude --help` ("Neither
  `--channels` nor `--dangerously-load-development-channels` appears in `claude --help`"). Requires
  claude.ai or Console auth; not on Bedrock/Vertex/Foundry; Team/Enterprise admins must enable
  `channelsEnabled`. "the `--channels` flag syntax and protocol contract may change".
- Failure modes: events are dropped silently if the server is not registered as a channel or policy
  blocks it ("Claude Code drops the events silently and returns no error"); no delivery ack; the
  interactive confirmation dialog on every `kiln chat` start; preview instability. The doc also
  notes the dev flag is ignored with `-p`.

### 3. Notification hook / terminal bell / status line (out-of-band, user must act)

Doc: Notification hooks "can't block or modify notifications"; `idle_prompt` fires "about 60 seconds
after Claude finishes responding, and only if you haven't typed since". Hooks can emit a desktop
notification via `terminalSequence`. Kiln's status line already shows "N unread" but is only
refreshed by Claude on its own schedule.

- Idle session: does not wake Claude; only alerts the user. Kiln's parent process owns the terminal,
  so it could also write BEL/OSC 777 itself (reasoning, not a doc claim).
- Failure mode: the Overseer stays silent until the user types, which is the #98 stall. Good as a
  complement, not a fix.

### 4. Stdin injection via a pty wrapper

No documentation; this is terminal mechanics (UNVERIFIED against any Claude doc). Kiln would have to
spawn claude under a pty it owns and write the text plus Enter. Works on an idle prompt, needs no
flags, but is fragile: it races with the user's half-typed input, dialogs (permission, trust, slash
menus), and bracketed paste/keybinding changes; Deno has no built-in pty so it needs a helper
(`script`, python, or an FFI). The experiment above used a pty only to observe, not to inject.

### 5. `--input-format stream-json` / Agent SDK streaming input

`claude --help`: "`--input-format <format>` Input format (only works with --print): "text"
(default), or "stream-json" (realtime streaming input)". It is headless (`-p`) only: it replaces the
interactive TUI, so the user could not use the chat. Not applicable unless Kiln wrote its own UI.

### 6. Remote Control / background sessions

Remote Control (https://code.claude.com/docs/en/remote-control) connects claude.ai/code or the
mobile app to the local session via the Anthropic API; "API keys are not supported", needs a
subscription, and the local process "makes outbound HTTPS requests only and never opens inbound
ports", so there is no local API for a daemon to post into. `claude --bg`, `attach`, `logs`, `stop`,
`respawn` (from `claude --help`) manage background sessions; the help lists no "send message"
subcommand. Not a fit.

### 7. Existing hooks (already in Kiln)

`UserPromptSubmit` `additionalContext` and the `Stop` hook reach the model only at a prompt or a
turn end (hooks doc: Stop "Prevents Claude from stopping, continues the conversation"). That covers
mid-turn mail but not an idle chat, which is the gap.

## Comparison

| Mechanism                                | Wakes IDLE session  | Same session kept | Start change                                                                       | Auth/org limits                                   | Main risk                                                   | Status                             |
| ---------------------------------------- | ------------------- | ----------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------- |
| `asyncRewake` hook (exit 2)              | Yes (doc + tested)  | Yes               | None (extra hook in `--settings`)                                                  | None                                              | `timeout` enforced; re-arm; mid-turn behaviour undocumented | Documented, stable field, verified |
| Channel (`notifications/claude/channel`) | Yes (doc)           | Yes               | `--dangerously-load-development-channels server:kiln` + confirm dialog each launch | claude.ai/Console auth; admin opt-in for Team/Ent | Preview, unlisted flag, silent drop                         | Research preview                   |
| Notification hook / bell / status line   | No (alerts user)    | Yes               | None                                                                               | None                                              | User must prompt (#98 persists)                             | Documented                         |
| pty stdin injection                      | Yes (by mechanics)  | Yes               | pty wrapper                                                                        | None                                              | Races with typing/dialogs                                   | Unverified                         |
| stream-json / SDK input                  | n/a (headless only) | n/a               | no TUI                                                                             | none                                              | not interactive                                             | Documented                         |
| Remote Control / `--bg`                  | No local API        | n/a               | subscription                                                                       | no API keys                                       | cannot be driven by daemon                                  | Documented                         |
| #104 replace session                     | Yes                 | NO                | none                                                                               | none                                              | the bug in #105                                             | Current                            |

## Recommendation

1. Interim: disable the #104 session replacement for a healthy idle chat now (keep its router error
   change), so the chat is usable. Keep replacement only for crash recovery and context rollover.
2. Primary fix: an `asyncRewake` hook. Register `kiln hook chat wait --chat <id>` as a command hook
   with `asyncRewake: true` and a large `timeout`, on `SessionStart` and on `Stop` (so it is
   re-armed after every wake and every turn). The hook long-polls the daemon (new `chat.wait` call);
   when mail or `request.done` news for the Overseer exists it prints the digest line to stderr and
   exits 2, waking the idle session in place. A newer waiter for the same chat id supersedes older
   ones (older exits 0) so waiters do not pile up. Stop holding the router nudge only while a turn
   is active, as the issue suggests.
3. Add the out-of-band signal (BEL/desktop notification from the `kiln chat` parent) as a cheap
   fallback for when the hook has timed out.
4. Revisit channels once they leave research preview; they are the purpose-built mechanism and fit
   Kiln's existing stdio MCP server, but today they need an unlisted flag and an interactive
   confirmation on every launch.

Suggested follow-up tickets: (a) disable replacement for idle chats (small, urgent); (b) `chat.wait`
daemon call plus `kiln hook chat wait` and hook registration with re-arm; (c) tests with a fake
claude/hook runner and a manual pty check; (d) docs/chat.md update; (e) terminal-bell fallback; (f)
spike: channel prototype when the flag stabilises.

## Open questions

- Maximum useful `timeout` for an `asyncRewake` hook, and what happens at expiry on an idle session.
  Re-arming only on `SessionStart`/`Stop` leaves a gap if the hook expires while idle.
- Behaviour of an `asyncRewake` exit 2 that lands mid-turn (queued to the next turn, or
  interrupts?). The doc only says output is delivered "on the next conversation turn".
- Does the wake carry enough for the Overseer to speak to the user unprompted (it did in the test,
  with a "hook feedback" label), and is that label acceptable?
- Do `resume`/`clear`/`compact` re-fire `SessionStart` (re-arm) and does the doc's de-duplication of
  repeated `SessionStart` output suppress a repeated digest?
- The experiment ran once, on Haiku, with the author's own user-level hooks also loaded; repeat it
  in CI-like isolation with the real Kiln settings.
- Channels: confirm idle delivery and whether `--dangerously-load-development-channels` can be
  pre-approved non-interactively (the doc describes a mandatory confirmation dialog).
