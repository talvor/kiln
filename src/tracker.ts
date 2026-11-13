// The Project's ticket tracker, reached through the `gh` command in Kiln's clone of the Project.
import { firstLine, REMOTE_TIMEOUT_MS, run } from "./checks.ts";
import type { PrState } from "./store.ts";

/** The ticket could not be published; the message says why. */
export class PublishFailed extends Error {}

/** A ticket as an agent writes it: a heading line for the title, then the body. */
export function parseTicket(text: string): { title: string; body: string } {
  const lines = text.trim().split("\n");
  const title = lines[0].replace(/^#+\s*/, "").trim();
  return { title, body: lines.slice(1).join("\n").trim() };
}

/** Open a ticket in the Project's tracker; returns its URL. */
export async function publishTicket(
  clonePath: string,
  ticket: { title: string; body: string },
): Promise<string> {
  let result;
  try {
    result = await run(
      "gh",
      ["issue", "create", "--title", ticket.title, "--body", ticket.body],
      clonePath,
      REMOTE_TIMEOUT_MS,
    );
  } catch {
    throw new PublishFailed("Could not publish the ticket: the gh command is not available.");
  }
  const url = result.stdout.trim().split("\n").at(-1)?.trim();
  if (result.code !== 0 || !url) {
    throw new PublishFailed(
      `Could not publish the ticket: ${firstLine(result.stderr || result.stdout) || "gh failed"}`,
    );
  }
  return url;
}

/** Open a draft pull request for `head` against `base`; returns its URL. */
export async function openDraftPr(
  clonePath: string,
  pr: { head: string; base: string; title: string; body: string },
): Promise<string> {
  let result;
  try {
    result = await run(
      "gh",
      [
        "pr",
        "create",
        "--draft",
        "--head",
        pr.head,
        "--base",
        pr.base,
        "--title",
        pr.title,
        "--body",
        pr.body,
      ],
      clonePath,
      REMOTE_TIMEOUT_MS,
    );
  } catch {
    throw new PublishFailed("Could not open the pull request: the gh command is not available.");
  }
  const url = result.stdout.trim().split("\n").at(-1)?.trim();
  if (result.code !== 0 || !url) {
    throw new PublishFailed(
      `Could not open the pull request: ${
        firstLine(result.stderr || result.stdout) || "gh failed"
      }`,
    );
  }
  return url;
}

/** Mark a draft pull request ready for review. */
export async function markPrReady(clonePath: string, prUrl: string): Promise<void> {
  let result;
  try {
    result = await run("gh", ["pr", "ready", prUrl], clonePath, REMOTE_TIMEOUT_MS);
  } catch {
    throw new PublishFailed(
      "Could not mark the pull request ready: the gh command is not available.",
    );
  }
  if (result.code !== 0) {
    throw new PublishFailed(
      `Could not mark the pull request ready: ${firstLine(result.stderr || result.stdout)}`,
    );
  }
}

/** Comment on a pull request. */
export async function commentOnPr(clonePath: string, prUrl: string, body: string): Promise<void> {
  let result;
  try {
    result = await run(
      "gh",
      ["pr", "comment", prUrl, "--body", body],
      clonePath,
      REMOTE_TIMEOUT_MS,
    );
  } catch {
    throw new PublishFailed(
      "Could not comment on the pull request: the gh command is not available.",
    );
  }
  if (result.code !== 0) {
    throw new PublishFailed(
      `Could not comment on the pull request: ${firstLine(result.stderr || result.stdout)}`,
    );
  }
}

/** Close a ticket in the Project's tracker with a closing comment. */
export async function closeTicket(clonePath: string, item: string, comment: string): Promise<void> {
  let result;
  try {
    result = await run(
      "gh",
      ["issue", "close", item, "--comment", comment],
      clonePath,
      REMOTE_TIMEOUT_MS,
    );
  } catch {
    throw new PublishFailed("Could not close the ticket: the gh command is not available.");
  }
  if (result.code !== 0) {
    throw new PublishFailed(
      `Could not close the ticket: ${firstLine(result.stderr || result.stdout)}`,
    );
  }
}

/**
 * The state a pull request is in, as the forge reports it; null when it cannot be told (gh
 * failed, or said something unexpected), so the caller just looks again later.
 */
export async function pullRequestState(
  clonePath: string,
  prUrl: string,
): Promise<PrState | null> {
  try {
    const result = await run(
      "gh",
      ["pr", "view", prUrl, "--json", "state"],
      clonePath,
      REMOTE_TIMEOUT_MS,
    );
    if (result.code !== 0) return null;
    const state = JSON.parse(result.stdout).state;
    return state === "OPEN" || state === "MERGED" || state === "CLOSED" ? state : null;
  } catch {
    return null;
  }
}

/** Whether the ticket at `url` can be found in the Project's tracker. */
export async function ticketInTracker(clonePath: string, url: string): Promise<boolean> {
  try {
    const result = await run(
      "gh",
      ["issue", "view", url, "--json", "state"],
      clonePath,
      REMOTE_TIMEOUT_MS,
    );
    return result.code === 0 && !!JSON.parse(result.stdout).state;
  } catch {
    return false;
  }
}

/** The ticket's number in a tracker URL, as `#12`; the URL itself when it has none. */
export const ticketRef = (url: string): string => {
  const n = url.match(/\/(\d+)\/?$/)?.[1];
  return n ? `#${n}` : url;
};

/** Whether the ticket is labelled `research`; false when its labels cannot be read. */
export async function isResearchTicket(clonePath: string, item: string): Promise<boolean> {
  try {
    const result = await run(
      "gh",
      ["issue", "view", item, "--json", "labels"],
      clonePath,
      REMOTE_TIMEOUT_MS,
    );
    if (result.code !== 0) return false;
    const labels: { name?: unknown }[] = JSON.parse(result.stdout).labels ?? [];
    return labels.some((l) => typeof l.name === "string" && l.name.toLowerCase() === "research");
  } catch {
    return false;
  }
}
