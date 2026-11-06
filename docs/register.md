# Registering a project

```sh
kiln project register <path-or-url>
```

A **path** is a local checkout; Kiln reads its `origin` remote. A **URL** is cloned directly. Either
way Kiln makes its own clone of the remote under its data directory (`projects/<name>`); it never
works in your checkout, and commits that were never pushed are not in Kiln's clone. The name
comes from the remote's last path segment.

## Steps

1. Clone the remote.
2. Check the project (blocks below), including a `git push --dry-run` to a throwaway branch name.
3. An onboarding agent (the launcher, working in Kiln's clone) reads the available agent docs,
   manifests, and CI files and proposes `setup`, `test`, `lint` and `build` commands. Files linked
   outside the clone, directories, and empty files are omitted from the agent's reading list.
   Kiln shows the commands and asks `Use these commands?`.
   Confirm after reviewing the proposal; with no answer on stdin the answer is no. The commands
   are not editable yet: decline and fix the project's agent docs, or register once the proposal is
   right.
4. Kiln runs `setup`, then `test`, in the clone, and records the project.

## Blocks and warnings

Registration is **blocked**, and nothing is kept, when:

- the project has no remote (`origin` for a path), or the remote cannot be cloned or has no commits;
- the clone has no non-empty, regular `AGENTS.md` or `CLAUDE.md` at its root whose real path stays
  inside the clone;
- the push dry-run fails;
- the onboarding agent fails or does not answer with all four command fields;
- the user does not confirm the commands;
- `setup` fails.

Registration **warns** and goes ahead when:

- branch protection cannot be confirmed
  (`gh api repos/{owner}/{repo}/branches/<branch>/protection`; a 404 is inconclusive and rulesets
  are not consulted);
- there is no lint command, no build command or no test command.

## Test baseline

The `test` command's result on the clean checkout is recorded with the project: pass or fail, exit
code, duration, the commit and the end of the output. A failing baseline does not block
registration; it records which failures already existed. Without a test command no baseline is
recorded, and the registration output says so explicitly.
