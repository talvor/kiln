// A spec's breakdown into tickets, as the Ticket Planner writes it to `tickets.json`:
//   { "criteria": { "c1": "<an acceptance criterion of the spec>", ... },
//     "tickets": [{ "key": "a", "title": "...", "body": "...", "covers": ["c1"],
//                   "blockedBy": ["b"] }, ...] }
// The Leader's checks on a breakdown are made here: it parses, every criterion of the spec is
// covered by some ticket, and the tickets' dependencies lead nowhere in a circle.

export interface PlannedTicket {
  key: string;
  title: string;
  body: string;
  covers: string[];
  blockedBy: string[];
}
export interface Breakdown {
  criteria: Record<string, string>;
  tickets: PlannedTicket[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isTexts = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);

/** The breakdown in `text`, or why it cannot be used. */
export function parseBreakdown(text: string): Breakdown | { problems: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { problems: [`not valid JSON (${(err as Error).message})`] };
  }
  if (!isObject(raw) || !isObject(raw.criteria) || !Array.isArray(raw.tickets)) {
    return { problems: ['must be an object with "criteria" (an object) and "tickets" (a list)'] };
  }
  const problems: string[] = [];
  const criteria: Record<string, string> = {};
  for (const [id, criterion] of Object.entries(raw.criteria)) {
    if (isText(criterion)) criteria[id] = criterion;
    else problems.push(`criterion "${id}" must be some text`);
  }
  const tickets: PlannedTicket[] = [];
  raw.tickets.forEach((t, i) => {
    const at = `ticket ${i + 1}`;
    if (!isObject(t)) return void problems.push(`${at} must be an object`);
    if (!isText(t.key)) return void problems.push(`${at} needs a "key" as some text`);
    if (!isText(t.title)) problems.push(`${at} ("${t.key}") needs a "title" as some text`);
    if (!isText(t.body)) problems.push(`${at} ("${t.key}") needs a "body" as some text`);
    if (!isTexts(t.covers ?? [])) problems.push(`${at} ("${t.key}"): "covers" must list criteria`);
    if (!isTexts(t.blockedBy ?? [])) {
      problems.push(`${at} ("${t.key}"): "blockedBy" must list ticket keys`);
    }
    tickets.push({
      key: t.key,
      title: String(t.title ?? ""),
      body: String(t.body ?? ""),
      covers: isTexts(t.covers ?? []) ? (t.covers as string[] | undefined) ?? [] : [],
      blockedBy: isTexts(t.blockedBy ?? []) ? (t.blockedBy as string[] | undefined) ?? [] : [],
    });
  });
  return problems.length ? { problems } : { criteria, tickets };
}

/** Why the breakdown cannot be accepted: the Leader's checks. Empty when it can. */
export function checkBreakdown(b: Breakdown): string[] {
  const problems: string[] = [];
  if (!Object.keys(b.criteria).length) {
    problems.push("Coverage: no acceptance criteria are listed.");
  }
  if (!b.tickets.length) problems.push("Coverage: no tickets are planned.");
  const keys = new Set<string>();
  for (const t of b.tickets) {
    if (keys.has(t.key)) problems.push(`Ticket key "${t.key}" is used twice.`);
    keys.add(t.key);
  }
  const covered = new Set<string>();
  for (const t of b.tickets) {
    for (const c of t.covers) {
      if (b.criteria[c] === undefined) {
        problems.push(`Ticket "${t.key}" covers unknown criterion "${c}".`);
      }
      covered.add(c);
    }
    for (const d of t.blockedBy) {
      if (!keys.has(d)) problems.push(`Ticket "${t.key}" is blocked by unknown ticket "${d}".`);
      if (d === t.key) problems.push(`Ticket "${t.key}" is blocked by itself.`);
    }
  }
  for (const [id, text] of Object.entries(b.criteria)) {
    if (!covered.has(id)) problems.push(`Coverage: no ticket covers criterion "${id}": ${text}`);
  }
  if (!problems.length) {
    const cycle = order(b.tickets).cycle;
    if (cycle) problems.push(`Dependencies form a cycle: ${cycle.join(" -> ")}.`);
  }
  return problems;
}

/**
 * The tickets with the ones they are blocked by first (so each can name them when it is opened),
 * or, if the dependencies go in a circle, the keys along the cycle.
 */
export function order(tickets: PlannedTicket[]): { sorted: PlannedTicket[]; cycle?: string[] } {
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const sorted: PlannedTicket[] = [];
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  let cycle: string[] | undefined;
  const visit = (key: string) => {
    if (cycle || state.get(key) === "done") return;
    if (state.get(key) === "visiting") {
      cycle = [...path.slice(path.indexOf(key)), key];
      return;
    }
    state.set(key, "visiting");
    path.push(key);
    for (const d of byKey.get(key)?.blockedBy ?? []) if (byKey.has(d)) visit(d);
    path.pop();
    state.set(key, "done");
    sorted.push(byKey.get(key)!);
  };
  for (const t of tickets) visit(t.key);
  return { sorted, cycle };
}
