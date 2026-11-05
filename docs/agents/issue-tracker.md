# Issue tracker: otman

Issues and specs for this repo live as Items in an Obsidian Vault managed by [otman](https://github.com/talvor/otman). Use the `otman` CLI for all operations; never edit Item files directly.

This repo is linked to Project `KILN` by `.otman.toml` at the repo root (`otman project link KILN`). The Vault path and your actor name come from `~/.config/otman/config.toml` (`otman config show` prints the effective values). Agents run as the human's configured actor: `@me` means that actor.

## Conventions

- **Refer to Items** as `KILN-<n>` (e.g. `KILN-12`), and in prose by their title. Inside Item bodies, link with a full-filename wikilink: `[[KILN-12 Allocate item numbers]]`. A bare number like `12` or `#12` means `KILN-12`.
- **Output**: piped output is compact AXI-style. Add `--json` whenever you parse a result; it is the stable contract (`{"schema_version":1,"data":…,"warnings":[]}`). On failure, stdout is empty and stderr carries `error.code`/`error.hint`. Exit 3 means not found, and 4 means a conflict (already claimed, an ambiguous ID, or a stale edit).
- **Multi-line text**: pass it with `--body-file -` and a heredoc, never with `--body "…"`.
- **Create an issue**: `otman create --title "..." --body-file - <<'EOF' … EOF`. Add `--kind spec` for a spec and `--kind prd` only when a PRD is asked for by name. Add `--label`, `--parent REF` and `--blocked-by REF` as needed.
- **Read an issue**: `otman view <REF> --full --comments` (or `--json`, which always includes body and comments).
- **List issues**: `otman list --json` with `--label L` (repeatable, AND), `--without-label L`, `--unlabeled`, `--state open|closed|all`, `--kind`, `--assignee @me|NAME`, `--unassigned`, `--parent REF`, `--blocked-by REF` and `--search TEXT`. The default is the 50 oldest open Items; follow `has_more` with `--offset`, or pass `--all`.
- **Comment on an issue**: `otman comment <REF> --body-file - <<'EOF' … EOF`
- **Apply / remove labels**: `otman edit <REF> --add-label "..." --remove-label "..."` in one call. Repeated adds or removes are no-ops.
- **Close**: `otman close <REF> --comment-file - <<'EOF' … EOF`. Reopen with `otman reopen <REF>`.
- **Edit a body safely**: read `rev` from `otman view <REF> --json`, write the new body with `otman edit <REF> --body-file - --if-rev <rev>`. On exit 4 `stale_item`, re-read, re-apply your change and retry.
- **Nothing closes Items automatically.** Commits and PRs should mention `KILN-<n>`, but only `otman close` closes work.

## Pull requests as a triage surface

**PRs as a request surface: not applicable.** otman tracks no pull requests; `/triage` covers Items only.

## When a skill says "publish to the issue tracker"

Create an Item with `otman create`: `--kind spec` for a spec (to-spec), `--kind issue --parent <spec>` for implementation tickets (to-tickets), and `--kind issue` otherwise.

## When a skill says "fetch the relevant ticket"

Run `otman view <REF> --full --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single Item with **child** Items as tickets.

- **Map**: an Item of Kind `issue` labelled `wayfinder:map`, holding the Destination / Notes / Decisions-so-far / Not yet specified / Out of scope body. `otman create --label wayfinder:map --title "..." --body-file -`.
- **Child ticket**: `otman create --parent <map> --label wayfinder:<type> --title "..." --body-file -`, where type is `research`/`prototype`/`grilling`/`task`. List them with `otman list --parent <map> --state all`. Map order is number order.
- **Blocking**: otman's native `blocked_by` relation, which also renders in Obsidian Bases. Add an edge with `otman block <child> --by <blocker>` (or `--blocked-by` at create). Both Items must be in the same Project, and cycles are rejected. A ticket is unblocked when every blocker is closed.
- **Frontier query**: `otman frontier --parent <map> --json` returns the open, unassigned children with no open blocker, in map order. Take the first.
- **Claim**: `otman claim <n>`, the session's first write. Exit 4 means someone else holds it: take the next frontier ticket.
- **Resolve**: `otman close <n> --comment-file - <<'EOF' <answer> EOF`. Then append a context pointer (`- [[KILN-n Title]]: gist`) to the map's Decisions-so-far with a guarded body edit (`--if-rev`, above), because other sessions may be editing the map at the same time.
- **Drop a ticket** that the map no longer needs: close it with a comment saying why. otman has no delete.
