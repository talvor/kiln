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
  `kiln/request-<id>-assignment-<message-id>` from the request branch, in its own worktree.
  A Request can have several Assignments at once.
- **Merge back.** `assignment merge` is run once the leader has verified the Assignment. The
  Assignment must have no uncommitted changes. Kiln merges its branch into the request branch
  (`--no-ff`) and pushes the request branch to the remote, then removes the Assignment's worktree
  and gives its ports back. A conflict aborts the merge and leaves the request branch as it was. If
  the push fails the merge is kept; run `assignment merge` again to retry the push.

## Per-worktree resources

Each start command prints the worktree path and its environment. `kiln launch --cwd <worktree>`
applies that environment when it starts work there, as do router launches for sessions in the
worktree.

| Variable | Meaning |
| --- | --- |
| `KILN_PORT_BASE`, `KILN_PORT_COUNT` | A block of ports (from 20000) reserved for this worktree |
| `TMPDIR` | Private temporary directory |
| `XDG_CACHE_HOME`, `npm_config_cache` | Private caches |

The temp and cache directories sit beside the worktree (`<worktree>.kiln/`), so they never show up
in its git status. Port blocks are handed out lowest-free-first and returned when a worktree is
released.

## Not covered here

Finishing a Request, removing the worktrees of a Request or of a force-removed Project, and
launching workers automatically when an Assignment is created are left to later tickets.
