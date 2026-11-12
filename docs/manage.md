# Managing projects

Use `kiln project list` to find the names of projects you can manage.

| Command                                                    | What it does                                                                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `kiln project list [--all]`                                | Show projects, their state and baseline. `--all` includes removed ones.                                                    |
| `kiln project pause <name>` / `resume <name>`              | A paused project takes no new requests.                                                                                    |
| `kiln project edit <name> <flag> <cmd> [<flag> <cmd> ...]` | Change one or more commands using `--setup`, `--test`, `--lint`, or `--build` (an empty string clears one), then re-check. |
| `kiln project baseline <name>`                             | Re-run the test baseline on the latest default branch.                                                                     |
| `kiln project default-branch <name> <branch>`              | Switch to another remote branch, then re-check.                                                                            |
| `kiln project remove <name> [--force]`                     | Remove the project and delete Kiln's clone.                                                                                |

## Re-check

Edit and default-branch run a full re-check in Kiln's clone: fetch the remote, check out the default
branch at the remote's tip, require agent docs (`AGENTS.md` or `CLAUDE.md`), do a push dry-run, look
at branch protection, run `setup`, then run `test` and record a new baseline. Baseline re-run
fetches and checks out the latest default branch, then runs setup and test without the agent-doc or
push gates. If a blocking step fails, the project record is unchanged and Kiln tries to restore the
clone's recorded branch and commit. A failed setup may leave files in the clone. Warnings are
recomputed after a successful re-check.

## Removal

Removal is refused while the project has active requests, unless `--force`. The clone is deleted,
but the project's record, baseline and events stay as history. The name can then be registered
again.

## Commands come only from you

Files in a project may have suggested commands at registration, which you confirmed. They never
change a project's commands afterwards: re-checks run only the stored commands, and nothing re-reads
repository files to update them. Stored commands run repository code with the operator's privileges;
they are not confined like agents (see [confinement](router.md#worker-confinement)).
