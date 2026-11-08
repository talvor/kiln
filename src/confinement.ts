// Worker confinement: what an agent's Claude session may do. Pure rules, no I/O.
//   - Permissions are deny-by-default: a session may use only the built-in tools its role lists,
//     plus Kiln's own tools. Everything else is refused, never asked about.
//   - The sandbox lets a session write only inside its Worktree.
//   - Deny rules keep secrets unread and destructive commands unrun.
//   - The policing hook checks each tool call against the same rules (a file tool is not covered
//     by the sandbox, which only confines commands) and a refusal goes up as a question.
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Role } from "./store.ts";

/** Built-in Claude tools a role can be given. */
export const BUILTIN_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "NotebookEdit",
  "Bash",
] as const;
export type BuiltinTool = typeof BUILTIN_TOOLS[number];

/** What a role may use when its configuration does not say. */
export const DEFAULT_TOOLS: Record<Role, BuiltinTool[]> = {
  // The Overseer looks at the Projects it is asked about and changes nothing.
  overseer: ["Read", "Glob", "Grep"],
  leader: ["Read", "Glob", "Grep"],
  worker: ["Read", "Glob", "Grep", "Write", "Edit", "Bash"],
};

const FILE_WRITERS = ["Write", "Edit", "NotebookEdit"];
const FILE_READERS = ["Read", "Glob", "Grep", "NotebookEdit", ...FILE_WRITERS];

/** Files and folders that hold secrets: never read, never written. */
const SECRET_PATH = [
  /(^|\/)\.env(\.(?!example$|sample$|template$).*)?$/,
  /(^|\/)\.(ssh|aws|gnupg|kube|docker|npmrc|netrc|pypirc)(\/|$)/,
  /(^|\/)\.config\/(gh|gcloud)(\/|$)/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /\.(pem|key|p12|pfx)$/,
  /(^|\/)(credentials|secrets?)(\.[a-z]+)?$/,
];
export const isSecretPath = (path: string): boolean => SECRET_PATH.some((re) => re.test(path));

/** Shell commands a worker must never run, by what they would do. */
const AT = String
  .raw`(?:^|[;&|(\n"'\x60{]|\b(?:then|do|else|env|xargs|nohup|time|exec|command|nice|eval))\s*(?:\w+=\S*\s+)*`;
const GIT = String.raw`git\s+(?:-\S+\s+(?:[^-\s]\S*\s+)?)*`;
const DESTRUCTIVE: [RegExp, string][] = [
  [
    new RegExp(
      AT +
        String
          .raw`rm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+(-[a-z]*\s+)*(\/|~|\$HOME|\*|\.{1,2}\/?)(\s|$)`,
    ),
    "recursive delete of a root, home, parent or wildcard",
  ],
  [new RegExp(AT + String.raw`sudo\b`), "privilege escalation"],
  [
    new RegExp(AT + String.raw`(?:\S*\/)?kiln\s+(?:approve|reject)\b`),
    "only the user approves or rejects an escalation",
  ],
  [new RegExp(AT + GIT + String.raw`push\b`), "pushing is Kiln's job, not a worker's"],
  [
    new RegExp(AT + GIT + String.raw`(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.)`),
    "discarding work in the tree",
  ],
  [
    new RegExp(AT + GIT + String.raw`(branch\s+-D|worktree\s+(remove|prune))`),
    "removing branches or worktrees",
  ],
  [
    new RegExp(AT + String.raw`(curl|wget)\b[^|;]*\|\s*(sudo\s+)?(sh|bash|zsh)\b`),
    "piping a download into a shell",
  ],
  [
    new RegExp(AT + String.raw`(mkfs\S*|dd\s+if=|shutdown|reboot)\b`),
    "destroying or halting the machine",
  ],
  [/>\s*\/dev\/(sd|nvme)/, "writing to a disk device"],
  [
    new RegExp(AT + String.raw`chmod\s+(-R\s+)?[0-7]*7[0-7]*\s+\/`),
    "opening up system permissions",
  ],
];
/** Reading a secret through a command is as bad as through a tool. */
const SECRET_IN_COMMAND =
  /(^|[\s"'=:<>/])(\.env(\.[\w.-]+)?|\.ssh|\.aws|\.gnupg|\.netrc|id_(rsa|dsa|ecdsa|ed25519)|[\w.-]+\.(pem|key))(["'\s;|&)]|\/|$)/;

export interface Verdict {
  allowed: boolean;
  /** Why the call was refused; a sentence the agent can pass up. */
  reason?: string;
}
const allow: Verdict = { allowed: true };
const deny = (reason: string): Verdict => ({ allowed: false, reason });

export interface CallContext {
  /** Built-in tools the session's role may use. */
  tools: readonly string[];
  /** The Worktree: the only place the session may write. */
  worktree: string;
  /** When set, the only places the session may read: it has read-only access to these. */
  readRoots?: readonly string[];
}

/** `path` with symlinks resolved, as far as it exists: a link cannot lead out of the Worktree. */
function realpath(path: string): string {
  const missing: string[] = [];
  for (let at = resolve(path);; at = dirname(at)) {
    try {
      return resolve(Deno.realPathSync(at), ...missing.reverse());
    } catch {
      if (dirname(at) === at) return resolve(path);
      missing.push(at.slice(dirname(at).length + 1));
    }
  }
}

/** Whether `path` (absolute, or relative to the Worktree) lies inside the Worktree. */
export function insideWorktree(worktree: string, path: string): boolean {
  const rel = relative(realpath(worktree), realpath(resolve(worktree, path)));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Judge one tool call. Kiln's own tools (mcp__kiln__*) are always allowed. */
export function judgeCall(ctx: CallContext, tool: string, input: Record<string, unknown>): Verdict {
  if (tool.startsWith("mcp__kiln__")) return allow;
  if (!ctx.tools.includes(tool)) {
    return deny(`${tool} is not one of the tools your role may use`);
  }
  const target = [input.file_path, input.notebook_path, input.path]
    .find((p): p is string => typeof p === "string");
  if (FILE_READERS.includes(tool)) {
    const where = target ? realpath(resolve(ctx.worktree, target)) : undefined;
    if (where && isSecretPath(where)) return deny(`${tool} on ${target}: that file holds secrets`);
    if (ctx.readRoots) {
      const outside = [input.file_path, input.notebook_path, input.path]
        .filter((p): p is string => typeof p === "string")
        .find((p) =>
          !ctx.readRoots!.some((root) => insideWorktree(root, resolve(ctx.worktree, p)))
        );
      const reaching = [tool === "Glob" ? input.pattern : tool === "Grep" ? input.glob : undefined]
        .find((p): p is string =>
          typeof p === "string" && (isAbsolute(p) || p.split("/").includes(".."))
        );
      if (!outside && reaching) {
        return deny(`${tool} for ${reaching}: you may read only the registered projects`);
      }
      if (outside) {
        return deny(`${tool} on ${outside}: you may read only the registered projects`);
      }
    }
    const patterns = tool === "Glob" ? [input.pattern] : tool === "Grep" ? [input.glob] : [];
    for (const pattern of patterns) {
      if (typeof pattern === "string" && isSecretPath(pattern.replaceAll("*", "x"))) {
        return deny(`${tool} for ${pattern}: that would reach secrets`);
      }
    }
    if (FILE_WRITERS.includes(tool)) {
      if (!target) return deny(`${tool} without a file path`);
      if (!insideWorktree(ctx.worktree, target)) {
        return deny(`${tool} on ${target}: writes are limited to your worktree ${ctx.worktree}`);
      }
    }
    return allow;
  }
  if (tool === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    for (const [re, why] of DESTRUCTIVE) {
      if (re.test(command)) return deny(`Bash \`${command}\`: ${why}`);
    }
    if (SECRET_IN_COMMAND.test(command)) return deny(`Bash \`${command}\`: it touches secrets`);
    return allow;
  }
  return deny(`${tool} is not one of the tools your role may use`);
}

/** The launch options that confine a session working in `worktree` with `tools`. */
export function confine(tools: readonly string[], worktree: string) {
  return {
    permissionMode: "dontAsk" as const,
    /** Built-in tools that exist for the session at all. */
    tools: [...tools],
    allowedTools: [...tools],
    disallowedTools: [
      ...["Read", "Edit", "Write", "NotebookEdit"].flatMap((t) =>
        [".env", ".env.*", "**/.env", "**/.env.*", "~/.ssh/**", "~/.aws/**", "**/*.pem", "**/*.key"]
          .map((p) => `${t}(${p})`)
      ),
      "Bash(sudo *)",
      "Bash(rm -rf *)",
      "Bash(git push *)",
      "Bash(git reset --hard*)",
      "Bash(curl * | *)",
      "Bash(wget * | *)",
    ],
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [worktree],
        denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", "~/.netrc", "~/.config/gh"],
      },
    },
  };
}
