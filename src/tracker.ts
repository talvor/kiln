// The Project's ticket tracker, reached through the `gh` command in Kiln's clone of the Project.
import { firstLine, REMOTE_TIMEOUT_MS, run } from "./checks.ts";

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
