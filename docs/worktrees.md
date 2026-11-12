# Worktrees, request branches and Assignment merge-back

Work happens in git worktrees under Kiln's data directory (`worktrees/<project>/`), never in the
Project's clone or your checkout.

```
kiln request start <project>
kiln assignment start <request-id> <assignment-message-id>
kiln assignment merge <assignment-id>
```

- **Request.** `request start` fetches the remote and creates the branch `kiln/request-<id>` from
  the Project's default branch, in its own worktree. A paused Project takes no new Requests.
- **Assignment.** `assignment start` takes the router's assignment Message ID and creates
  `kiln/request-<id>-assignment-<message-id>` from the request branch, in its own worktree. A
  Request can have several Assignments at once.
- **Merge back.** `assignment merge` is run once the leader has verified the Assignment. The
  Assignment must have no uncommitted changes. Kiln merges its branch into the request branch
  (`--no-ff`) and pushes the request branch to the remote, then removes the Assignment's worktree
  and gives its ports back. A conflict aborts the merge and leaves the request branch as it was. If
  the push fails the merge is kept; run `assignment merge` again to retry the push.

## Per-worktree resources

Each start command prints the worktree path and its environment. `kiln launch --cwd <worktree>`
applies that environment when it starts work there, as do router launches for sessions in the
worktree.

| Variable                             | Meaning                                                   |
| ------------------------------------ | --------------------------------------------------------- |
| `KILN_PORT_BASE`, `KILN_PORT_COUNT`  | A block of ports (from 20000) reserved for this worktree  |
| `TMPDIR`                             | Private temporary directory, at most 72 bytes (see below) |
| `XDG_CACHE_HOME`, `npm_config_cache` | Private caches                                            |

The cache directories sit beside the worktree (`<worktree>.kiln/`), so they never show up in its git
status.

`TMPDIR` is elsewhere, because it must be short: Claude's command sandbox puts two sockets in it (35
bytes of file name) and a unix socket path holds at most 107 bytes, so a worker whose `TMPDIR` is
longer than 72 bytes cannot run any Bash command. It is
`$XDG_RUNTIME_DIR/kiln/<worktree id>-<hash>/tmp`, or `/tmp/kiln-<uid>/<worktree id>-<hash>/tmp`
where `XDG_RUNTIME_DIR` is unset or unusable (macOS). Kiln makes it, and its parents, private (mode
0700), when it creates a worktree, recreates it after a fault, and before each launch there (the
runtime directory is cleared on logout and reboot). It is removed with the worktree's other support
directories. A runtime path that would exceed the limit uses the `/tmp` fallback. If the chosen
`TMPDIR` still exceeds the limit, the start fails with an error that names it. The sandbox of a
launch in the worktree may write to it.

Port blocks are handed out lowest-free-first and returned when a worktree is released.

## Not covered here

Removing the worktrees of a force-removed Project and launching workers automatically when an
Assignment is created are left to later tickets. Cleaning up after a merged pull request is
described in [playbooks.md](playbooks.md#implementing-a-ticket).
