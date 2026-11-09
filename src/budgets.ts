// Spend: the daily cap, the cost report, notifications and the daily digest. What one Request may
// cost is enforced by the conductor, which owns Requests and their Gates; this is the part that is
// about the whole of Kiln. Budgets and the notification command come from `limits.json`.
import { dailyCapReached, dailyWarning, describeNews, money, NEWS_EVENTS } from "./news.ts";
import { DEFAULT_LIMITS, type LimitsConfig, requestBudgetUsd } from "./limits.ts";
import type { Logger } from "./log.ts";
import type { RequestRecord, Store } from "./store.ts";

/** Something Kiln tells the user outside the chat. */
export interface Notification {
  kind: "budget-warning" | "budget-blocked" | "daily-warning" | "daily-cap" | "digest";
  title: string;
  text: string;
}

/** A notification command gets this long to take a notification before Kiln stops waiting. */
const NOTIFY_TIMEOUT_MS = 30_000;
/** Money is kept in floating point; this is how close to a limit counts as reaching it. */
const EPSILON = 1e-9;

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;
const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** The start of the user's day, which is when the daily cap starts over. */
export const dayStart = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export interface CostReport {
  day: string;
  todayUsd: number;
  capUsd: number | null;
  capReached: boolean;
  projects: { name: string; usd: number }[];
  /** The Requests that spent something today: what they spent today and in all. */
  requests: {
    id: number;
    project: string;
    status: string;
    usd: number;
    totalUsd: number;
    budgetUsd: number | null;
  }[];
  /** Spend no Request claims, such as the Overseer's. */
  otherUsd: number;
}

export interface BudgetsOptions {
  store: Store;
  log: Logger;
  loadLimits: () => Promise<LimitsConfig>;
  /** Stop every running agent: the daily cap was just reached. */
  stopAll: () => void;
  /** The cap no longer holds: work may carry on at once. */
  resumed: () => void;
}

export function createBudgets(opts: BudgetsOptions) {
  const { store, log } = opts;
  let limits: LimitsConfig = DEFAULT_LIMITS;

  /** Read the limits again; a file that is not valid leaves the last good one in force. */
  async function refresh(): Promise<void> {
    try {
      limits = await opts.loadLimits();
    } catch (err) {
      log.warn("could not read the budgets", { err });
    }
  }

  const spentToday = (now = new Date()): number =>
    round(store.spendSince(dayStart(now).toISOString()).reduce((sum, r) => sum + r.usd, 0));

  /** Whether the day's spend has used up the daily cap. */
  const capped = (): boolean =>
    limits.budgets.dailyUsd !== undefined && spentToday() >= limits.budgets.dailyUsd - EPSILON;

  /** Hand a notification to the user's command; failing to do so never stops the work. */
  function notify(n: Notification): void {
    const command = limits.notify.command;
    if (!command) return;
    send(command, n).catch((err) => log.warn("notification command failed", { err }));
  }

  async function send(command: string, n: Notification): Promise<void> {
    const child = new Deno.Command("sh", {
      args: ["-c", command],
      stdin: "piped",
      stdout: "null",
      stderr: "piped",
      env: { KILN_NOTIFICATION_KIND: n.kind, KILN_NOTIFICATION_TITLE: n.title },
    }).spawn();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* already gone */ }
    }, NOTIFY_TIMEOUT_MS);
    try {
      const stdin = child.stdin.getWriter();
      await stdin.write(new TextEncoder().encode(`${n.text}\n`)).catch(() => {});
      await stdin.close().catch(() => {});
      const out = await child.output();
      if (out.code !== 0) {
        log.warn("notification command exited with an error", {
          code: out.code,
          stderr: new TextDecoder().decode(out.stderr).slice(0, 500),
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** The day's spend against the daily cap: warn at 80%, stop all work at 100%. */
  async function check(): Promise<void> {
    await refresh();
    const cap = limits.budgets.dailyUsd;
    const spent = spentToday();
    const day = dayKey(new Date());
    if (cap !== undefined && capped()) {
      if (!store.getMeta("capped_at")) {
        store.setMeta("capped_at", new Date().toISOString());
        store.appendEvent("budget.day_capped", { spendUsd: spent, capUsd: cap });
        log.warn("daily cap reached", { spendUsd: spent, capUsd: cap });
        notify({
          kind: "daily-cap",
          title: "Kiln: daily cap reached",
          text: dailyCapReached(spent, cap),
        });
        opts.stopAll();
      }
    } else if (cap !== undefined && spent >= 0.8 * cap - EPSILON) {
      const warned = `${day}:${cap}`;
      if (store.getMeta("day_warned") !== warned) {
        store.setMeta("day_warned", warned);
        store.appendEvent("budget.day_warned", { spendUsd: spent, capUsd: cap });
        notify({
          kind: "daily-warning",
          title: "Kiln: 80% of the daily cap",
          text: dailyWarning(spent, cap),
        });
      }
    }
    const since = store.getMeta("capped_at");
    if (since && !capped()) {
      // The wait does not count against what the Assignments that waited were given.
      store.delayActiveAssignments(Date.now() - Date.parse(since));
      store.setMeta("capped_at", null);
      store.appendEvent("budget.day_resumed", {});
      log.info("daily cap no longer holds");
      opts.resumed();
    }
  }

  /** What has been spent today, by Project and by Request. */
  async function cost(): Promise<CostReport> {
    await refresh();
    const now = new Date();
    const rows = store.spendSince(dayStart(now).toISOString());
    const projects = store.listProjects({ includeRemoved: true });
    const byProject = new Map<string, number>();
    const requests: CostReport["requests"] = [];
    let otherUsd = 0;
    for (const row of rows) {
      if (row.requestId === null) {
        otherUsd += row.usd;
        continue;
      }
      const request = store.getRequest(row.requestId);
      const project = projects.find((p) => p.id === request.projectId)?.name ?? "?";
      byProject.set(project, (byProject.get(project) ?? 0) + row.usd);
      requests.push({
        id: request.id,
        project,
        status: request.status,
        usd: round(row.usd),
        totalUsd: round(store.requestSpend(request.id)),
        budgetUsd: requestBudget(request),
      });
    }
    return {
      day: dayKey(now),
      todayUsd: spentToday(now),
      capUsd: limits.budgets.dailyUsd ?? null,
      capReached: capped(),
      projects: [...byProject].map(([name, usd]) => ({ name, usd: round(usd) })),
      requests,
      otherUsd: round(otherUsd),
    };
  }

  /** What the Request may cost in all: the configured budget and what the user added; or null. */
  function requestBudget(request: RequestRecord): number | null {
    const project = store.listProjects({ includeRemoved: true }).find((p) =>
      p.id === request.projectId
    );
    const base = project ? requestBudgetUsd(limits, project.name) : undefined;
    return base === undefined ? null : base + request.budgetExtraUsd;
  }

  /** What has been spent today, in a sentence for the Overseer; undefined when nothing has. */
  function spendLine(): string | undefined {
    const spent = spentToday();
    const cap = limits.budgets.dailyUsd;
    if (spent <= 0 && cap === undefined) return undefined;
    return `Spent today: ${money(spent)}` +
      (cap === undefined ? "" : ` of the ${money(cap)} daily cap`) +
      ".";
  }

  /** What happened since the digest last told the user, or undefined when nothing did. */
  function digestText(through: number): string | undefined {
    const lines = store.listEvents(through, NEWS_EVENTS).map(describeNews);
    for (const e of store.listEscalations().filter((e) => e.status === "open")) {
      lines.push(`Decision waiting for you: escalation ${e.id}: ${e.summary}`);
    }
    if (!lines.length) return undefined; // no news: nothing to say
    const spend = spendLine();
    return [`Kiln digest for ${dayKey(new Date())}`, ...lines.map((l) => `- ${l}`), spend]
      .filter(Boolean).join("\n");
  }

  const throughKey = "digest_through";

  /** The user has been told everything up to now, in the chat: the digest need not repeat it. */
  const told = (): void => store.setMeta(throughKey, String(store.lastEventId()));

  /** Send the daily digest if it is due and today's has not been sent. No news, no digest. */
  function sendDigestIfDue(now = new Date()): boolean {
    const [h, m] = limits.notify.digestAt.split(":").map(Number);
    const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    const day = dayKey(now);
    if (now < due || store.getMeta("digest_day") === day) return false;
    store.setMeta("digest_day", day);
    const text = digestText(Number(store.getMeta(throughKey) ?? 0));
    told();
    if (!text) return false;
    store.appendEvent("digest.sent", { day });
    notify({ kind: "digest", title: "Kiln: daily digest", text });
    return true;
  }

  return {
    refresh,
    capped,
    notify,
    check,
    cost,
    spendLine,
    requestBudget,
    told,
    /** Look at the clock: the daily digest may be due. */
    digestCheck: async () => {
      await refresh();
      sendDigestIfDue();
    },
  };
}
export type Budgets = ReturnType<typeof createBudgets>;
