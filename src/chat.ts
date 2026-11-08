// The Overseer's chat: what the daemon keeps for `kiln chat`. The user talks to the Overseer in an
// interactive Claude Code session; this module is the other side of that session's hooks and
// status line. It records the conversation in the store, builds the digest that seeds each fresh
// session, decides when a session's context has grown too large and should roll over, holds the
// Overseer's mail while the user is in the chat, and answers the user's model-free commands
// without a model.
import type { Escalations, EscalationView } from "./escalations.ts";
import type { Config } from "./playbooks.ts";
import { overseerRole } from "./playbooks.ts";
import type { Router, StopVerdict } from "./router.ts";
import type { ChatRecord, MessageRecord, SessionRecord, Store } from "./store.ts";

/** A session is replaced once its context holds this many tokens. */
export const ROLLOVER_TOKENS = 150_000;
/** `kiln chat` is attached while it has shown a sign of life this recently. */
const ATTACHED_MS = 15_000;
/** How much of the conversation seeds a fresh session. */
const HISTORY_TURNS = 20;
const TURN_CHARS = 600;
/** Events that tell the user something happened to their work. */
const NEWS_EVENTS = ["request.done", "step.failed", "step.escalated"];

/** The words the user types that Kiln answers itself, without a model. */
export const COMMANDS = ["status", "escalations", "projects", "approve", "reject", "help"] as const;
const COMMAND = new RegExp(`^kiln\\s+(${COMMANDS.join("|")})\\b\\s*(.*)$`, "is");

export const CHAT_HELP = [
  "Kiln answers these itself, without asking the Overseer:",
  "  kiln status               what is open, active and waiting for you",
  "  kiln escalations          the decisions waiting for you",
  "  kiln projects             the registered projects",
  "  kiln approve <id>         approve an escalation",
  "  kiln reject <id> <why>    reject an escalation, saying why",
  "Anything else goes to the Overseer.",
].join("\n");

const RULES =
  `You are talking with the user in an interactive chat. They ask you for software work on \
the projects registered with Kiln. Your tools: list_projects, list_playbooks, start_request, \
request_status, read_inbox, raise_escalation and read_escalations; and Read, Glob and Grep on the \
registered projects' files. You change no file yourself: work happens through requests.

## Starting work
- Start now. When the user asks for work and you know the project, a playbook that fits, and what \
is wanted, call start_request at once and tell them the request id and what happens next. Do not \
ask permission for what they have already asked for.
- Ask first, with one short question, and then wait, when: the project is unclear or not registered \
or paused; no playbook fits; or the request is so vague that two engineers would build different \
things. Never guess a project.
- A question about the code is not a request. Answer it from the project's files.

## Speaking unprompted
- Say something the user did not ask about only when it is theirs to act on: a decision waiting for \
them (an open escalation), a request that finished or failed, or a message in your inbox that needs \
them. Say it once, briefly, with the id they need.
- Otherwise stay quiet: no greetings, no progress chatter, no repeating what you already said. When \
the user asks for the state of things, answer from request_status; do not volunteer it.
- Only the user approves or rejects an escalation. Tell them to type "kiln approve <id>" or \
"kiln reject <id> <reason>" in this chat.

## Commands
The user can type "kiln status", "kiln escalations", "kiln projects", "kiln approve <id>", \
"kiln reject <id> <why>" and "kiln help" in this chat. Kiln answers them itself and they never \
reach you.`;

export interface ChatOptions {
  store: Store;
  router: Router;
  escalations: Escalations;
  loadConfig: () => Promise<Config>;
  /** The directory the Overseer's Claude session works in. */
  chatDir: string;
  /** Record the user's decision on an escalation, as the CLI would. */
  decide: (params: { id: number; approved: boolean; reason?: string }) => unknown;
}

export interface ChatBegun {
  chatId: number;
  /** Added to the session's system prompt: the Overseer's role, the rules and the digest. */
  system: string;
  /** Said to the Overseer at the start, only when the user has something to hear. */
  initialPrompt?: string;
  /** Registered Projects' clones, which the session may read. */
  readDirs: string[];
  cwd: string;
}

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;

export function createChat(opts: ChatOptions) {
  const { store, router, escalations } = opts;

  const overseer = (): SessionRecord | undefined =>
    store.listSessions().find((s) => s.role === "overseer");
  const unread = (): MessageRecord[] => {
    const seat = overseer();
    return seat ? store.listMessages({ to: seat.address, waiting: true }) : [];
  };
  const waitingOnUser = (): EscalationView[] => escalations.list(true);
  const projectName = (id: number) =>
    store.listProjects({ includeRemoved: true }).find((p) => p.id === id)?.name ?? "?";

  /** What is going on in Kiln, one line per thing. */
  function describeWork(): string[] {
    const lines: string[] = [];
    for (const state of ["active", "planned"] as const) {
      for (const r of store.listRequests(state)) {
        const steps = store.listSteps(r.id);
        const current = steps.find((s) => s.status === "active") ??
          steps.find((s) => s.status === "planned");
        lines.push(
          `Request ${r.id} on ${projectName(r.projectId)} (${
            r.playbook ?? "no playbook"
          }, ${state})` +
            (r.description ? `: ${clip(r.description, 120)}` : "") +
            (current ? `; step ${current.position} of ${steps.length}, ${current.spec.name}` : ""),
        );
      }
    }
    return lines;
  }

  function describeEscalation(e: EscalationView): string {
    return `Escalation ${e.id} [${e.status}]${
      e.requestId === null ? "" : ` (request ${e.requestId})`
    }` +
      `: ${e.summary}${e.detail ? `\n  ${e.detail}` : ""}${
        e.reason ? `\n  Reason: ${e.reason}` : ""
      }`;
  }

  /** Where things stand and what was said lately: the seed of a fresh session. */
  function digest(sinceEvent: number): { text: string; news: string[] } {
    const news: string[] = [];
    const open = waitingOnUser();
    for (const e of open) news.push(`Decision waiting for the user: ${describeEscalation(e)}`);
    for (const e of store.listEvents(sinceEvent, NEWS_EVENTS)) {
      const d = e.data as { id?: number; request?: number; why?: string };
      news.push(
        e.kind === "request.done"
          ? `Request ${d.id} finished.`
          : e.kind === "step.failed"
          ? `Request ${d.request} failed: ${d.why ?? "a step failed"}.`
          : `Request ${d.request} needs the user's attention (a step was escalated).`,
      );
    }
    const mail = unread();
    if (mail.length) news.push(`${mail.length} unread message(s) in your inbox.`);

    const projects = store.listProjects();
    const work = describeWork();
    const turns = store.listChatTurns(HISTORY_TURNS);
    const text = [
      "## Where things stand",
      projects.length
        ? "Projects: " + projects.map((p) => `${p.name}${p.paused ? " (paused)" : ""}`).join(", ")
        : "No projects are registered yet.",
      work.length ? work.join("\n") : "No requests are running.",
      news.length ? `\n## News for the user\n${news.join("\n")}` : "",
      turns.length
        ? "\n## The conversation so far (oldest first)\n" +
          turns.map((t) => `${t.speaker === "user" ? "User" : "You"}: ${clip(t.text, TURN_CHARS)}`)
            .join("\n")
        : "",
    ].filter(Boolean).join("\n");
    return { text, news };
  }

  /** Reply to a command the user typed that needs no model; undefined if it is not one. */
  function command(prompt: string): string | undefined {
    const m = COMMAND.exec(prompt.trim());
    if (!m) return undefined;
    const verb = m[1].toLowerCase();
    const rest = m[2].trim();
    try {
      switch (verb) {
        case "help":
          return CHAT_HELP;
        case "projects": {
          const projects = store.listProjects();
          return projects.length
            ? projects.map((p) =>
              `${p.name}  ${p.paused ? "paused" : "active"}  ${p.defaultBranch}`
            )
              .join("\n")
            : "No projects registered.";
        }
        case "escalations": {
          const list = escalations.list(!/^--all$/.test(rest));
          return list.length
            ? list.map(describeEscalation).join("\n")
            : "No escalations are waiting for you.";
        }
        case "status":
          return statusText();
        default: {
          const [id, ...why] = rest.split(/\s+/);
          if (!/^\d+$/.test(id ?? "")) {
            return `Usage: kiln ${verb} <escalation-id>${verb === "reject" ? " <reason>" : ""}`;
          }
          const reason = why.join(" ");
          if (verb === "reject" && !reason) {
            return "Say why: kiln reject <escalation-id> <reason>.";
          }
          opts.decide({ id: Number(id), approved: verb === "approve", reason });
          return `${verb === "approve" ? "Approved" : "Rejected"} escalation ${id}.`;
        }
      }
    } catch (err) {
      return (err as Error).message;
    }
  }

  function statusText(): string {
    const open = waitingOnUser();
    const lines = [
      open.length
        ? `${open.length} decision(s) waiting for you:\n` + open.map(describeEscalation).join("\n")
        : "No decisions are waiting for you.",
      ...describeWork(),
    ];
    if (!lines.length) lines.push("Nothing is running.");
    return lines.join("\n");
  }

  const attached = (chat: ChatRecord | undefined): boolean =>
    !!chat && chat.endedAt === null && Date.now() - Date.parse(chat.seenAt) < ATTACHED_MS;

  return {
    /** Start a chat session: the Overseer's seat, the digest, and what the session may read. */
    async begin(): Promise<ChatBegun> {
      const config = await opts.loadConfig();
      const previous = store.latestChat();
      // A session that never said goodbye (a crash) is over.
      if (previous && previous.endedAt === null) store.endChat(previous.id, "exit");
      const since = previous
        ? store.getChat(previous.id).eventsThrough
        : (store.listEvents(0).at(-1)?.id ?? 0);
      const role = overseerRole(config);
      if (!overseer()) {
        router.openSession({
          address: "overseer",
          role: "overseer",
          department: null,
          cwd: opts.chatDir,
          roleName: role.name,
        });
      }
      const { text, news } = digest(since);
      const chat = store.startChat();
      store.appendEvent("chat.started", { id: chat.id });
      return {
        chatId: chat.id,
        system: `${role.prompt}\n\n${RULES}\n\n${text}`,
        // The Overseer speaks first only when there is something the user must hear.
        initialPrompt: news.length
          ? "The user has just opened the chat. Tell them, briefly, what is theirs to act on: " +
            "see News for the user. Say nothing else."
          : undefined,
        readDirs: store.listProjects().map((p) => p.clonePath),
        cwd: opts.chatDir,
      };
    },

    /** A sign of life from `kiln chat`; says whether the session should be replaced. */
    heartbeat(chatId: number): { rollover: boolean } {
      store.touchChat(chatId);
      return { rollover: store.getChat(chatId).rolloverRequestedAt !== null };
    },

    end(chatId: number, reason: "exit" | "rollover"): void {
      store.endChat(chatId, reason);
      store.appendEvent("chat.ended", { id: chatId, reason });
    },

    /**
     * The user sent a prompt. A command is answered here and never reaches the model; anything
     * else is recorded, with a note of what is waiting in the Overseer's inbox.
     */
    prompt(chatId: number, text: string): { reply?: string; context?: string } {
      const reply = command(text);
      if (reply !== undefined) return { reply };
      store.addChatTurn(chatId, "user", text);
      const notes: string[] = [];
      const mail = unread().length;
      if (mail) {
        notes.push(`You have ${mail} unread message(s) in your Kiln inbox: call read_inbox.`);
      }
      const open = waitingOnUser().length;
      if (open) notes.push(`${open} escalation(s) are waiting for the user's decision.`);
      return { context: notes.length ? notes.join(" ") : undefined };
    },

    /**
     * The Overseer finished a turn. Its words are recorded. It may not stop with unread mail; once
     * it may, a session whose context has grown past `limit` tokens is marked for rollover.
     */
    stop(
      chatId: number,
      turn: { text?: string; tokens?: number; limit?: number; alreadyBlocked?: boolean },
    ): StopVerdict {
      if (turn.text?.trim()) store.addChatTurn(chatId, "overseer", turn.text);
      const seat = overseer();
      const verdict: StopVerdict = seat
        ? router.checkStop(seat.address, turn.alreadyBlocked === true)
        : { block: false };
      if (verdict.block) {
        return {
          block: true,
          reason: `${verdict.reason} Tell the user only what is theirs to act on, once.`,
        };
      }
      if ((turn.tokens ?? 0) >= (turn.limit ?? ROLLOVER_TOKENS)) {
        store.requestRollover(chatId);
        store.appendEvent("chat.rollover_requested", { id: chatId, tokens: turn.tokens });
      }
      return verdict;
    },

    /** The status line: what is waiting for the user, at a glance. */
    statusLine(): string {
      const parts: string[] = [];
      const open = waitingOnUser().length;
      if (open) parts.push(`${open} decision${open === 1 ? "" : "s"} waiting`);
      const active = store.listRequests("active").length;
      if (active) parts.push(`${active} request${active === 1 ? "" : "s"} active`);
      const mail = unread().length;
      if (mail) parts.push(`${mail} unread`);
      return `kiln · ${parts.length ? parts.join(" · ") : "all quiet"}`;
    },

    /** The Overseer's mail waits for the chat while the user is in it, rather than being nudged. */
    holds: (m: MessageRecord): boolean => {
      const seat = overseer();
      return !!seat && m.to === seat.address && attached(store.latestChat());
    },
  };
}
export type Chat = ReturnType<typeof createChat>;
