import { assert, assertEquals } from "@std/assert";
import appJs from "../src/web/app.js" with { type: "text" };
import { withWorld } from "./world.ts";

class PageElement {
  className = "";
  dataset: Record<string, string> = {};
  style = { display: "" };
  scrollTop = 0;
  href = "";
  type = "";
  value = "";
  disabled = false;
  open = false;
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection = "none";
  parent: PageElement | null = null;
  children: PageElement[] = [];
  private content = "";
  private attributes = new Map<string, string>();
  private listeners = new Map<
    string,
    (event: { preventDefault: () => void; detail: number }) => void
  >();

  constructor(readonly tag: string, readonly page: Page) {}

  get textContent(): string {
    return this.content + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.replaceChildren();
    this.content = value;
  }
  get firstElementChild(): PageElement | null {
    return this.children[0] ?? null;
  }
  append(...children: PageElement[]) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children: PageElement[]) {
    if (this.contains(this.page.activeElement)) this.page.activeElement = null;
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.content = "";
    this.append(...children);
  }
  contains(node: PageElement | null): boolean {
    for (let current = node; current; current = current.parent) {
      if (current === this) return true;
    }
    return false;
  }
  querySelectorAll(selector: string): PageElement[] {
    const descendants = this.children.flatMap((
      child,
    ) => [child, ...child.querySelectorAll(selector)]);
    if (selector === "li" || selector === "img" || selector === "a") {
      return descendants.filter((node) => node.tag === selector);
    }
    return descendants.filter((node) =>
      node.tag === "button" &&
      (selector === "button" || node.className.split(" ").includes("row"))
    );
  }
  querySelector(selector: string): PageElement | null {
    for (const child of this.children) {
      if (child.tag === selector) return child;
      const match = child.querySelector(selector);
      if (match) return match;
    }
    return null;
  }
  addEventListener(
    event: string,
    listener: (event: { preventDefault: () => void; detail: number }) => void,
  ) {
    this.listeners.set(event, listener);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setSelectionRange(start: number, end: number, direction = "none") {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
  focus(_options?: { preventScroll: boolean }) {
    this.page.activeElement = this;
  }
  click(detail = 1) {
    this.focus();
    this.listeners.get("click")?.({ preventDefault: () => {}, detail });
  }
  input() {
    this.listeners.get("input")?.({ preventDefault: () => {}, detail: 0 });
  }
}

class Page {
  title = "Kiln";
  activeElement: PageElement | null = null;
  private elements = new Map<string, PageElement>();

  constructor() {
    for (const id of ["rail", "main", "banner", "favicon", "strip"]) {
      this.elements.set(id, new PageElement(id, this));
    }
  }
  getElementById(id: string): PageElement {
    return this.elements.get(id)!;
  }
  createElement(tag: string): PageElement {
    return new PageElement(tag, this);
  }
}

class PageEvents {
  closed = false;
  private listeners = new Map<string, () => void>();
  constructor(_url: string) {}
  addEventListener(event: string, listener: () => void) {
    this.listeners.set(event, listener);
  }
  emit(event: string) {
    if (!this.closed) this.listeners.get(event)?.();
  }
  close() {
    this.closed = true;
  }
}

const item = (id: number) => ({
  id,
  gate: id === 1 ? null : "approval",
  requestId: 7,
  project: "Example",
  summary: `Summary ${id}`,
  detail: id === 2 ? "<b>agent text</b>\n  intact" : null,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
});
const snapshot = (count: number) => ({
  running: true,
  count,
  groups: [{ project: "Example", items: Array.from({ length: count }, (_, i) => item(i + 1)) }],
  stale: [],
  decided: [],
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test("a repeated gesture cannot confirm and an old action cannot replace the current one", async () => {
  const page = new Page();
  const location = { pathname: "/" };
  const pending: Array<{
    url: string;
    body?: string;
    resolve: (response: Response) => void;
  }> = [];
  const fetch = (url: string, init?: { body?: string }) =>
    new Promise<Response>((resolve) => pending.push({ url, body: init?.body, resolve }));
  let now = 1_000_000;
  let stream: EventSource;
  class EventSource extends PageEvents {
    constructor(url: string) {
      super(url);
      stream = this;
    }
  }
  new Function(
    "document",
    "location",
    "history",
    "fetch",
    "EventSource",
    "addEventListener",
    "setInterval",
    "setTimeout",
    "clearTimeout",
    "Date",
    appJs,
  )(
    page,
    location,
    { pushState: (_state: null, _title: string, path: string) => location.pathname = path },
    fetch,
    EventSource,
    () => {},
    () => {},
    () => 1,
    () => {},
    { now: () => now, parse: Date.parse },
  );
  stream!.emit("open");
  pending[0].resolve(Response.json(snapshot(2)));
  await tick();
  const rail = page.getElementById("rail");
  const main = page.getElementById("main");
  rail.querySelectorAll("button.row")[0].click();
  main.querySelector("button")!.click();
  const first = pending.filter((request) => request.url.endsWith("/decide"))[0];
  rail.querySelectorAll("button.row")[1].click();
  rail.querySelectorAll("button.row")[0].click();
  main.querySelector("button")!.click();
  const second = pending.filter((request) => request.url.endsWith("/decide"))[1];
  first.resolve(Response.json({ ok: false, error: "Old refusal", code: "needs-confirm" }, {
    status: 409,
  }));
  await tick();
  pending.at(-1)!.resolve(Response.json(snapshot(2)));
  await tick();
  assertEquals(main.textContent.includes("Old refusal"), false);
  assertEquals(main.querySelector("button")?.textContent, "Approve");
  assertEquals(main.querySelector("button")?.getAttribute("aria-disabled"), "true");

  second.resolve(Response.json({ ok: false, error: "PR is unmerged", code: "needs-confirm" }, {
    status: 409,
  }));
  await tick();
  pending.at(-1)!.resolve(Response.json(snapshot(2)));
  await tick();
  const confirm = main.querySelector("button")!;
  assertEquals(confirm.textContent, "Approve anyway");
  assertEquals(page.activeElement === confirm, false);
  confirm.click(0);
  assertEquals(pending.filter((request) => request.url.endsWith("/decide")).length, 2);
  now += 500;
  confirm.click(2);
  assertEquals(pending.filter((request) => request.url.endsWith("/decide")).length, 2);
  confirm.click();
  const decisions = pending.filter((request) => request.url.endsWith("/decide"));
  assertEquals(decisions.length, 3);
  assertEquals(JSON.parse(decisions[2].body!), { approved: true, confirm: true });
});

for (const outcome of ["final", "stale"]) {
  Deno.test(`dashboard keeps a ${outcome} refusal after refresh`, async () => {
    const page = new Page();
    const location = { pathname: "/" };
    const pending: Array<{ url: string; resolve: (response: Response) => void }> = [];
    const fetch = (url: string) =>
      new Promise<Response>((resolve) => pending.push({ url, resolve }));
    let ageTimer = () => {};
    let stream: EventSource;
    class EventSource extends PageEvents {
      constructor(url: string) {
        super(url);
        stream = this;
      }
    }
    new Function(
      "document",
      "location",
      "history",
      "fetch",
      "EventSource",
      "addEventListener",
      "setInterval",
      "setTimeout",
      "clearTimeout",
      appJs,
    )(
      page,
      location,
      { pushState: (_state: null, _title: string, path: string) => location.pathname = path },
      fetch,
      EventSource,
      () => {},
      (callback: () => void) => ageTimer = callback,
      () => 1,
      () => {},
    );
    stream!.emit("open");
    pending[0].resolve(Response.json(snapshot(1)));
    await tick();
    const rail = page.getElementById("rail");
    const main = page.getElementById("main");
    assertEquals(rail.querySelector("details")?.open, false);
    rail.querySelector("details")!.open = true;
    rail.querySelector("summary")!.focus();
    ageTimer();
    assertEquals(rail.querySelector("details")?.open, true);
    assertEquals(page.activeElement, rail.querySelector("summary"));
    rail.querySelectorAll("button.row")[0].click();
    const rejectButton = main.querySelectorAll("button").find((button) =>
      button.textContent === "Reject"
    )!;
    rejectButton.click();
    ageTimer();
    assertEquals(page.activeElement?.textContent, "Reject");
    const reason = main.querySelector("textarea")!;
    reason.value = "A reason in progress";
    reason.input();
    reason.setSelectionRange(2, 8, "backward");
    reason.focus();
    ageTimer();
    const restored = main.querySelector("textarea")!;
    assertEquals(page.activeElement, restored);
    assertEquals([
      restored.value,
      restored.selectionStart,
      restored.selectionEnd,
      restored.selectionDirection,
    ], ["A reason in progress", 2, 8, "backward"]);
    const approve = main.querySelector("button")!;
    approve.focus();
    ageTimer();
    assertEquals(page.activeElement?.textContent, "Approve");
    main.querySelector("button")!.click();
    assertEquals(page.activeElement?.textContent, "Approve");
    const post = pending.find((p) => p.url.endsWith("/decide"))!;
    post.resolve(Response.json({ ok: false, error: `Daemon says ${outcome}`, code: outcome }, {
      status: 409,
    }));
    await tick();
    pending.at(-1)!.resolve(
      Response.json(outcome === "final" ? snapshot(0) : { ...snapshot(0), stale: [item(1)] }),
    );
    await tick();
    assertEquals(main.textContent.includes(`Daemon says ${outcome}`), true);
    ageTimer();
    assertEquals(main.textContent.includes(`Daemon says ${outcome}`), true);
  });
}

Deno.test("dashboard script keeps labels, text, count, focus and newest snapshot", async () => {
  const page = new Page();
  const location = { pathname: "/" };
  const pending: Array<{
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }> = [];
  const fetch = () => new Promise<Response>((resolve, reject) => pending.push({ resolve, reject }));
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let ageTimer = () => {};
  let stream: PageEvents;
  class EventSource extends PageEvents {
    constructor(url: string) {
      super(url);
      stream = this;
    }
  }
  new Function(
    "document",
    "location",
    "history",
    "fetch",
    "EventSource",
    "addEventListener",
    "setInterval",
    "setTimeout",
    "clearTimeout",
    appJs,
  )(
    page,
    location,
    { pushState: (_state: null, _title: string, path: string) => location.pathname = path },
    fetch,
    EventSource,
    () => {},
    (callback: () => void) => ageTimer = callback,
    (callback: () => void) => {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    (id: number) => timers.delete(id),
  );

  stream!.emit("open");
  pending[0].resolve(Response.json(snapshot(12)));
  await tick();
  assertEquals(page.title, "(12) Kiln");
  assertEquals(decodeURIComponent(page.getElementById("favicon").href).includes("9+"), true);

  const rail = page.getElementById("rail");
  const main = page.getElementById("main");
  assertEquals(
    rail.querySelectorAll("button.row")[0].children[0].textContent.startsWith("No gate"),
    true,
  );
  rail.querySelectorAll("button.row")[0].click();
  assertEquals(main.children[1].textContent.startsWith("No gate"), true);
  rail.querySelectorAll("button.row")[1].click();
  assertEquals(location.pathname, "/escalations/2");
  assertEquals(page.activeElement?.dataset.escalationId, "2");
  const detail = main.children.find((child) => child.tag === "pre")!;
  assertEquals(detail.textContent, "<b>agent text</b>\n  intact");
  assertEquals(detail.children.length, 0);

  ageTimer();
  assertEquals(page.activeElement?.dataset.escalationId, "2");
  stream!.emit("changed");
  for (const callback of timers.values()) callback();
  timers.clear();
  pending[1].resolve(Response.json(snapshot(12)));
  await tick();
  assertEquals(page.activeElement?.dataset.escalationId, "2");

  stream!.emit("open");
  stream!.emit("open");
  pending[3].resolve(Response.json(snapshot(3)));
  await tick();
  pending[2].resolve(Response.json(snapshot(1)));
  await tick();
  assertEquals(page.title, "(3) Kiln");
  assertEquals(page.activeElement?.dataset.escalationId, "2");

  stream!.emit("open");
  stream!.emit("open");
  pending[5].resolve(new Response(null, { status: 503 }));
  await tick();
  pending[4].resolve(Response.json(snapshot(4)));
  await tick();
  assertEquals(page.title, "(4) Kiln");

  stream!.emit("open");
  stream!.emit("open");
  pending[7].reject(new Error("offline"));
  await tick();
  pending[6].resolve(Response.json(snapshot(5)));
  await tick();
  assertEquals(page.title, "(5) Kiln");
  assertEquals(page.activeElement?.dataset.escalationId, "2");

  stream!.emit("error");
  for (const callback of timers.values()) callback();
  timers.clear();
  pending[8].resolve(new Response(null, { status: 403 }));
  await tick();
  assertEquals(stream!.closed, false);
  for (let i = 9; i <= 11; i++) {
    const callbacks = [...timers.values()];
    timers.clear();
    for (const callback of callbacks) callback();
    pending[i].resolve(new Response(null, { status: 403 }));
    await tick();
  }
  assertEquals(stream!.closed, true);
  assertEquals(rail.textContent, "");
  assertEquals(page.getElementById("banner").style.display, "none");
  assertEquals(
    main.textContent,
    "This dashboard was restarted or stopped. Open the new URL printed by kiln dashboard.",
  );
  ageTimer();
  assertEquals(rail.textContent, "");
});

withWorld("an old page reports a restart on another port after retries", async (w) => {
  const old = await w.dashboard();
  const cookie = await old.signIn();
  const page = new Page();
  let stream: PageEvents;
  class EventSource extends PageEvents {
    constructor(url: string) {
      super(url);
      stream = this;
    }
  }
  new Function(
    "document",
    "location",
    "history",
    "fetch",
    "EventSource",
    "addEventListener",
    "setInterval",
    "setTimeout",
    "clearTimeout",
    appJs,
  )(
    page,
    { pathname: "/" },
    { pushState: () => {} },
    (path: string) => old.fetch(path, { cookie }),
    EventSource,
    () => {},
    () => 1,
    setTimeout,
    clearTimeout,
  );
  stream!.emit("open");
  for (let i = 0; page.getElementById("banner").style.display !== "block" && i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assertEquals(page.getElementById("banner").style.display, "block");
  const fresh = await w.dashboard();
  assert(old.port !== fresh.port);
  assertEquals(await old.interrupt(), 0);
  stream!.emit("error");
  for (let i = 0; !stream!.closed && i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assertEquals(stream!.closed, true);
  assertEquals(page.getElementById("rail").textContent, "");
  assertEquals(page.getElementById("banner").style.display, "none");
  assertEquals(
    page.getElementById("main").textContent,
    "This dashboard was restarted or stopped. Open the new URL printed by kiln dashboard.",
  );
});

Deno.test("the header strip shows conditions and spend, and Halt and Resume ignore repeats", async () => {
  const page = new Page();
  const location = { pathname: "/" };
  const pending: Array<{
    url: string;
    method?: string;
    resolve: (r: Response) => void;
    reject: (error: Error) => void;
  }> = [];
  const fetch = (url: string, init?: { method?: string }) =>
    url === "/api/cost"
      ? Promise.resolve(Response.json({ running: true, cost: null })) // not under test here
      : new Promise<Response>((resolve, reject) =>
        pending.push({ url, method: init?.method, resolve, reject })
      );
  let ageTimer = () => {};
  let refreshTimer = () => {};
  let stream: EventSource;
  class EventSource extends PageEvents {
    constructor(url: string) {
      super(url);
      stream = this;
    }
  }
  new Function(
    "document",
    "location",
    "history",
    "fetch",
    "EventSource",
    "addEventListener",
    "setInterval",
    "setTimeout",
    "clearTimeout",
    "Date",
    appJs,
  )(
    page,
    location,
    { pushState: (_s: null, _t: string, path: string) => location.pathname = path },
    fetch,
    EventSource,
    () => {},
    (callback: () => void) => ageTimer = callback,
    (callback: () => void) => {
      refreshTimer = callback;
      return 1;
    },
    () => {},
    { now: () => Date.now(), parse: Date.parse },
  );
  const strip = page.getElementById("strip");
  const quiet = { haltedSince: null, capUsd: 5, todayUsd: 1.5, capReached: false, stuck: 0 };
  const show = async (facts: unknown) => {
    stream.emit("open");
    pending.at(-1)!.resolve(Response.json({ ...snapshot(0), strip: facts }));
    await tick();
  };

  await show(quiet);
  assertEquals(strip.textContent, "$1.50 of $5.00 todayHalt");
  assertEquals(strip.querySelector("a")?.href, "/cost");
  assertEquals(page.activeElement, null);
  strip.querySelector("a")!.focus();

  const previousRequests = pending.length;
  ageTimer();
  assertEquals(page.activeElement, strip.querySelector("a"));
  refreshTimer();
  assertEquals(pending.length, previousRequests + 1);
  assertEquals(pending.at(-1)!.url, "/api/needs-you");
  pending.at(-1)!.resolve(Response.json({
    ...snapshot(0),
    strip: { ...quiet, todayUsd: 0, capUsd: 6 },
  }));
  await tick();
  assertEquals(strip.textContent, "$0.00 of $6.00 todayHalt");
  assertEquals(page.activeElement, strip.querySelector("a"));

  await show({
    ...quiet,
    haltedSince: new Date().toISOString(),
    capReached: true,
    stuck: 2,
  });
  assertEquals(
    strip.textContent,
    "Halted just nowDaily cap reached2 Stuck agents$1.50 of $5.00 todayResume",
  );
  assertEquals(page.activeElement, strip.querySelector("a"));

  await show({ ...quiet, capUsd: null });
  assertEquals(page.activeElement, strip.querySelector("a"));
  strip.querySelector("a")!.click();
  assertEquals(location.pathname, "/cost");
  const halt = strip.querySelector("button")!;
  assertEquals(strip.textContent, "$1.50 todayHalt");
  halt.click(2); // a held key or a double click
  assertEquals(pending.filter((p) => p.url === "/api/halt").length, 0);
  halt.click();
  halt.click(); // the second click while the first is in flight
  const posts = pending.filter((p) => p.url === "/api/halt");
  assertEquals(posts.length, 1);
  assertEquals(posts[0].method, "POST");
  posts[0].resolve(Response.json({ ok: true }));
  await tick();
  pending.findLast((p) => p.url === "/api/needs-you")!.resolve(
    Response.json({ ...snapshot(0), strip: quiet }),
  );
  await tick();
  assertEquals(strip.querySelector("button")?.getAttribute("aria-disabled"), "false");

  strip.querySelector("button")!.click();
  pending.at(-1)!.resolve(Response.json({ ok: false, error: "Cannot halt", code: "blocked" }, {
    status: 409,
  }));
  await tick();
  pending.findLast((p) => p.url === "/api/needs-you")!.resolve(
    Response.json({ ...snapshot(0), strip: quiet }),
  );
  await tick();
  assertEquals(strip.textContent.includes("Cannot halt"), true);

  strip.querySelector("button")!.click();
  pending.at(-1)!.resolve(Response.json({
    ok: false,
    error: "Kiln is not running.",
    code: "down",
  }, { status: 503 }));
  await tick();
  pending.at(-1)!.resolve(
    Response.json({ running: false, count: 0, groups: [], stale: [], decided: [] }),
  );
  await tick();
  assertEquals(strip.textContent, "");
  await show(quiet);
  assertEquals(strip.textContent, "$1.50 of $5.00 todayHalt");

  strip.querySelector("button")!.click();
  pending.at(-1)!.resolve(Response.json({
    ok: false,
    error: "Kiln is not running.",
    code: "down",
  }, { status: 503 }));
  await tick();
  pending.findLast((p) => p.url === "/api/needs-you")!.resolve(
    Response.json({ ...snapshot(0), strip: quiet }),
  );
  await tick();
  assertEquals(strip.textContent, "$1.50 of $5.00 todayHalt");

  strip.querySelector("button")!.click();
  pending.at(-1)!.reject(new Error("offline"));
  await tick();
  pending.findLast((p) => p.url === "/api/needs-you")!.resolve(
    Response.json({ ...snapshot(0), strip: quiet }),
  );
  await tick();
  assertEquals(strip.textContent, "$1.50 of $5.00 todayHalt");
});

const requestRow = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  project: "Example",
  status: "active",
  description: `Request ${id} work`,
  playbook: null,
  costUsd: 1,
  budgetUsd: 4,
  waiting: false,
  recent: true,
  ...over,
});
const overview = (events: { id: number; ts: string; text: string }[], status = "active") => ({
  running: true,
  request: {
    id: 3,
    project: "Example",
    status,
    playbook: "build",
    description: "Build it",
    failure: status === "failed" ? "Cancelled by the user." : null,
    costUsd: 1,
    budgetUsd: 4,
    steps: [{
      position: 1,
      name: "Implement",
      department: "dev",
      status: "active",
      retries: 0,
      failure: null,
      assignments: [{
        id: 9,
        worker: "dev-1",
        status: "active",
        turnsUsed: 3,
        spendUsd: 0.5,
        limitReached: null,
      }],
    }],
  },
  events: events.map((e) => ({ ...e, kind: "x" })),
  last: events.at(-1)?.id ?? 0,
});

Deno.test("the Requests rail filters, marks, and a Request opens its Overview and cancels safely", async () => {
  const page = new Page();
  const location = { pathname: "/" };
  const pending: Array<{ url: string; method?: string; resolve: (response: Response) => void }> =
    [];
  const fetch = (url: string, init?: { method?: string }) =>
    new Promise<Response>((resolve) => pending.push({ url, method: init?.method, resolve }));
  let now = 1_000_000;
  let stream: EventSource;
  class EventSource extends PageEvents {
    constructor(url: string) {
      super(url);
      stream = this;
    }
  }
  const history: string[] = [];
  new Function(
    "document",
    "location",
    "history",
    "fetch",
    "EventSource",
    "addEventListener",
    "setInterval",
    "setTimeout",
    "clearTimeout",
    "Date",
    appJs,
  )(
    page,
    location,
    {
      pushState: (_state: null, _title: string, path: string) => {
        history.push(path);
        location.pathname = path;
      },
    },
    fetch,
    EventSource,
    () => {},
    () => {},
    (callback: () => void) => {
      callback(); // the debounce: re-fetch now
      return 1;
    },
    () => {},
    class extends Date {
      static override now() {
        return now;
      }
    },
  );
  const answer = async (match: (p: { url: string }) => boolean, response: Response) => {
    const found = pending.findLast(match)!;
    pending.splice(pending.indexOf(found), 1);
    found.resolve(response);
    await tick();
  };
  const snap = (extra: Record<string, unknown>) => Response.json({ ...snapshot(0), ...extra });
  stream!.emit("open");
  await answer(
    (p) => p.url === "/api/needs-you",
    snap({
      requests: [
        requestRow(3, { waiting: true }),
        requestRow(2, { status: "failed" }),
        requestRow(1, { status: "done", recent: false }),
      ],
    }),
  );
  const rail = page.getElementById("rail");
  const main = page.getElementById("main");
  const rows = () => rail.querySelectorAll("button.row").map((b) => b.textContent);
  assertEquals(rows().length, 2);
  assertEquals(rows()[0].includes("waiting on you"), true);
  assertEquals(rows()[1].includes("failed"), true);
  const toggleButton = rail.children.find((c) => c.textContent === "Show finished")!;
  toggleButton.click();
  assertEquals(rows().length, 3);
  assertEquals(rail.children.some((c) => c.textContent === "Hide finished"), true);

  rail.querySelectorAll("button.row")[0].click();
  assertEquals(history, ["/requests/3"]);
  await answer((p) => p.url === "/api/requests/3", Response.json(overview([])));
  assertEquals(main.textContent.includes("Budget: $1.00 of $4.00 (25%)"), true);
  assertEquals(main.textContent.includes("1. Implement · dev · active"), true);
  assertEquals(main.textContent.includes("dev-1 · active · 3 turns"), true);
  assertEquals(main.textContent.includes("Nothing has happened yet."), true);

  // A new event arrives: the feed updates without a page load.
  stream!.emit("changed");
  await answer((p) => p.url === "/api/needs-you", snap({ requests: [requestRow(3)] }));
  await answer(
    (p) => p.url === "/api/requests/3",
    Response.json(overview(Array.from({ length: 101 }, (_, i) => ({
      id: i + 1,
      ts: new Date(now).toISOString(),
      text: "Event " + (i + 1),
    })))),
  );
  const feed = main.querySelector("ul")!;
  assertEquals(feed.children.length, 101);
  assertEquals(feed.children[0].textContent.includes("Event 101"), true);
  assertEquals(feed.children[100].textContent.includes("Event 1"), true);

  // Cancel needs a confirm step, and a repeated gesture cannot take it.
  const cancel = main.querySelector("button")!;
  assertEquals(cancel.textContent, "Cancel Request");
  cancel.click();
  assertEquals(pending.some((p) => p.url.endsWith("/cancel")), false);
  const buttons = main.querySelectorAll("button");
  assertEquals(buttons.map((b) => b.textContent), ["Keep it running", "Yes, cancel it"]);
  const yes = buttons[1];
  yes.click(); // too soon after the step appeared
  yes.click(2); // a double click
  assertEquals(pending.some((p) => p.url.endsWith("/cancel")), false);
  now += 500;
  yes.click(2); // a held key
  assertEquals(pending.some((p) => p.url.endsWith("/cancel")), false);
  yes.click();
  assertEquals(pending.filter((p) => p.url.endsWith("/cancel")).length, 1);
  yes.click(); // in flight: ignored
  assertEquals(pending.filter((p) => p.url.endsWith("/cancel")).length, 1);
  assertEquals(pending.find((p) => p.url.endsWith("/cancel"))!.method, "POST");
  await answer((p) => p.url.endsWith("/cancel"), Response.json({ ok: true }));
  await answer(
    (p) => p.url === "/api/needs-you",
    snap({ requests: [requestRow(3, { waiting: true })] }),
  );
  assertEquals(pending.some((p) => p.url === "/api/requests/3?after=101"), true);
  await answer(
    (p) => p.url === "/api/requests/3?after=101",
    Response.json(overview([{
      id: 102,
      ts: new Date(now).toISOString(),
      text: "Cancelled",
    }], "failed")),
  );
  assertEquals(main.textContent.includes("Failed: Cancelled by the user."), true);
  assertEquals(main.children[1].textContent.includes("failed"), true);
  assertEquals(main.children[1].textContent.includes("waiting on you"), false);
  // A failed Request opens on Report, without changing the address the user is on.
  assertEquals(pending.some((p) => p.url === "/api/requests/3/report"), true);
  assertEquals(main.querySelectorAll("button").length, 0); // nothing left to cancel
});

Deno.test("the Report tab is the default for a finished Request and shows how it went as plain text", async () => {
  const page = new Page();
  const location = { pathname: "/requests/3" };
  const pending: Array<{
    url: string;
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }> = [];
  const fetch = (url: string) =>
    new Promise<Response>((resolve, reject) => pending.push({ url, resolve, reject }));
  let stream: EventSource;
  class EventSource extends PageEvents {
    constructor(url: string) {
      super(url);
      stream = this;
    }
  }
  new Function(
    "document",
    "location",
    "history",
    "fetch",
    "EventSource",
    "addEventListener",
    "setInterval",
    "setTimeout",
    "clearTimeout",
    "Date",
    appJs,
  )(
    page,
    location,
    {
      pushState: (_s: null, _t: string, path: string) => {
        location.pathname = path;
      },
    },
    fetch,
    EventSource,
    () => {},
    () => {},
    (callback: () => void) => {
      callback();
      return 1;
    },
    () => {},
    Date,
  );
  const answer = async (match: (p: { url: string }) => boolean, response: Response) => {
    const found = pending.findLast(match)!;
    pending.splice(pending.indexOf(found), 1);
    found.resolve(response);
    await tick();
  };
  stream!.emit("open");
  await answer(
    (p) => p.url === "/api/needs-you",
    Response.json({ ...snapshot(0), requests: [requestRow(3, { status: "done" })] }),
  );
  await answer((p) => p.url === "/api/requests/3", Response.json(overview([], "done")));
  await answer(
    (p) => p.url === "/api/requests/3/report",
    Response.json({
      report: {
        ...overview([], "done").request,
        startedAt: "2026-01-01T10:00:00.000Z",
        endedAt: "2026-01-01T10:30:00.000Z",
        steps: [{
          position: 1,
          name: "Implement",
          status: "done",
          retries: 1,
          failure: null,
          summary: "<img src=x onerror=alert(1)>",
        }],
        escalations: [
          { id: 4, summary: "Ship?", status: "approved", reason: "fine", via: "dashboard" },
        ],
        limitsReached: [],
        branch: "kiln/ship",
        ticketUrl: "https://example.test/t/1",
        ticketUrls: ["https://example.test/t/1"],
        prUrl: "https://example.test/pr/1",
      },
    }),
  );
  const main = page.getElementById("main");
  const text = main.textContent;
  for (
    const part of [
      "Finished",
      "took 30 min",
      "Budget: $1.00 of $4.00",
      "Implement · done · retried 1×",
      "<img src=x onerror=alert(1)>",
      "Source dashboard",
      "kiln/ship",
      "https://example.test/pr/1",
    ]
  ) assertEquals(text.includes(part), true, part);
  assertEquals(main.querySelectorAll("img").length, 0);
  assertEquals(location.pathname, "/requests/3"); // the default tab keeps its address
  const tabs = main.children.find((child) => child.className === "tabs")!.children;
  assertEquals(tabs[2].className.includes("active"), true);
  assertEquals(text.includes("Cancel Request"), false);
});

Deno.test("the Transcript tab loads Messages, appends live, flags and truncates them as plain text", async () => {
  const page = new Page();
  const location = { pathname: "/requests/3/transcript" };
  const pending: Array<{
    url: string;
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }> = [];
  const fetch = (url: string) =>
    new Promise<Response>((resolve, reject) => pending.push({ url, resolve, reject }));
  let stream: EventSource;
  class EventSource extends PageEvents {
    constructor(url: string) {
      super(url);
      stream = this;
    }
  }
  new Function(
    "document",
    "location",
    "history",
    "fetch",
    "EventSource",
    "addEventListener",
    "setInterval",
    "setTimeout",
    "clearTimeout",
    "Date",
    appJs,
  )(
    page,
    location,
    {
      pushState: (_s: null, _t: string, path: string) => {
        location.pathname = path;
      },
    },
    fetch,
    EventSource,
    () => {},
    () => {},
    (callback: () => void) => {
      callback();
      return 1;
    },
    () => {},
    Date,
  );
  const answer = async (match: (p: { url: string }) => boolean, response: Response) => {
    const found = pending.findLast(match)!;
    pending.splice(pending.indexOf(found), 1);
    found.resolve(response);
    await tick();
  };
  const message = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    at: new Date().toISOString(),
    from: "overseer",
    to: "dev-lead",
    kind: "assignment",
    synthesised: false,
    inReplyTo: null,
    body: { text: "short" },
    deadLettered: false,
    ...extra,
  });
  stream!.emit("open");
  await answer(
    (p) => p.url === "/api/needs-you",
    Response.json({ ...snapshot(0), requests: [requestRow(3)] }),
  );
  await answer((p) => p.url === "/api/requests/3", Response.json(overview([])));
  const long = "x".repeat(700);
  await answer(
    (p) => p.url === "/api/requests/3/transcript",
    Response.json({
      messages: [
        message(1, { body: { text: "<img src=x onerror=alert(1)>" } }),
        message(2, { synthesised: true, deadLettered: true, from: "kiln", body: { text: long } }),
      ],
    }),
  );
  const main = page.getElementById("main");
  const items = () => main.querySelectorAll("li");
  assertEquals(items().length, 2);
  assertEquals(items()[0].textContent.includes("overseer → dev-lead · assignment"), true);
  assertEquals(items()[0].textContent.includes("<img src=x onerror=alert(1)>"), true);
  assertEquals(items()[0].querySelectorAll("img").length, 0); // plain text, not markup
  assertEquals(items()[0].textContent.includes("written by Kiln"), false);
  assertEquals(items()[1].textContent.includes("written by Kiln"), true);
  assertEquals(items()[1].textContent.includes("dead-lettered"), true);
  assertEquals(items()[1].textContent.includes(long), false);
  items()[1].querySelectorAll("button")[0].click();
  assertEquals(items()[1].textContent.includes(long), true);
  items()[1].querySelectorAll("button")[0].click();
  assertEquals(items()[1].textContent.includes(long), false);

  // A new Message arrives while the Request is active: it is appended.
  stream!.emit("changed");
  await answer(
    (p) => p.url === "/api/needs-you",
    Response.json({ ...snapshot(0), requests: [requestRow(3)] }),
  );
  await answer(
    (p) => p.url.startsWith("/api/requests/3") && !p.url.endsWith("transcript"),
    Response.json(overview([])),
  );
  await answer(
    (p) => p.url === "/api/requests/3/transcript",
    Response.json({ messages: [message(1), message(2), message(3, { kind: "result" })] }),
  );
  assertEquals(items().length, 3);
  assertEquals(items()[2].textContent.includes("result"), true);

  const transcriptTab = main.children.find((child) => child.className === "tabs")!.children[1];
  transcriptTab.focus();
  stream!.emit("changed");
  await answer(
    (p) => p.url === "/api/needs-you",
    Response.json({ ...snapshot(0), requests: [requestRow(3)] }),
  );
  await answer((p) => p.url === "/api/requests/3", Response.json(overview([])));
  await answer(
    (p) => p.url === "/api/requests/3/transcript",
    Response.json({ messages: [message(1), message(2), message(3)] }),
  );
  assertEquals(
    page.activeElement,
    main.children.find((child) => child.className === "tabs")!.children[1],
  );

  main.querySelectorAll("button").find((button) => button.textContent === "Cancel Request")!
    .focus();
  const fourth = message(4, { body: { text: long } });
  stream!.emit("changed");
  await answer(
    (p) => p.url === "/api/needs-you",
    Response.json({ ...snapshot(0), requests: [requestRow(3)] }),
  );
  await answer((p) => p.url === "/api/requests/3", Response.json(overview([])));
  await answer(
    (p) => p.url === "/api/requests/3/transcript",
    Response.json({ messages: [message(1), message(2), message(3), fourth] }),
  );
  assertEquals(page.activeElement?.textContent, "Cancel Request");
  const fourthMore = items()[3].querySelector("button")!;
  fourthMore.focus();
  stream!.emit("changed");
  await answer(
    (p) => p.url === "/api/needs-you",
    Response.json({ ...snapshot(0), requests: [requestRow(3)] }),
  );
  await answer((p) => p.url === "/api/requests/3", Response.json(overview([])));
  await answer(
    (p) => p.url === "/api/requests/3/transcript",
    Response.json({ messages: [message(1), message(2), message(3), fourth] }),
  );
  assertEquals(page.activeElement, items()[3].querySelector("button"));

  stream!.emit("changed");
  await answer(
    (p) => p.url === "/api/needs-you",
    Response.json({ ...snapshot(0), requests: [requestRow(3)] }),
  );
  await answer((p) => p.url === "/api/requests/3", Response.json(overview([])));
  const failed = pending.find((p) => p.url === "/api/requests/3/transcript")!;
  pending.splice(pending.indexOf(failed), 1);
  failed.reject(new Error("offline"));
  await tick();
  assertEquals(items().length, 4);
  assertEquals(main.textContent.includes("The dashboard could not be reached."), true);
  assertEquals(page.activeElement, items()[3].querySelector("button"));

  main.children.find((child) => child.className === "tabs")!.children[0].click();
  assertEquals(location.pathname, "/requests/3");
  await answer((p) => p.url === "/api/requests/3", Response.json(overview([])));
  stream!.emit("changed");
  await answer(
    (p) => p.url === "/api/needs-you",
    Response.json({ ...snapshot(0), requests: [requestRow(3)] }),
  );
  await answer((p) => p.url === "/api/requests/3", Response.json(overview([])));
  assertEquals(pending.some((p) => p.url === "/api/requests/3/transcript"), false);
  stream!.emit("changed");
  await answer(
    (p) => p.url === "/api/needs-you",
    Response.json({ ...snapshot(0), requests: [requestRow(3, { status: "done" })] }),
  );
  await answer((p) => p.url === "/api/requests/3", Response.json(overview([], "done")));
  assertEquals(pending.some((p) => p.url === "/api/requests/3/transcript"), false);

  main.children.find((child) => child.className === "tabs")!.children[1].click();
  assertEquals(location.pathname, "/requests/3/transcript");
  await answer((p) => p.url === "/api/requests/3", Response.json(overview([], "done")));
  assertEquals(pending.some((p) => p.url === "/api/requests/3/transcript"), true);
  await answer(
    (p) => p.url === "/api/requests/3/transcript",
    Response.json({
      messages: [
        message(1),
        message(2),
        message(3),
        message(4, {
          kind: "answer",
          body: { text: "arrived during Overview" },
        }),
      ],
    }),
  );
  assertEquals(items().length, 4);
  assertEquals(items()[3].textContent.includes("arrived during Overview"), true);
});

Deno.test("the Cost view shows today against the cap, a table per Project and Request, and unclaimed spend", async () => {
  const page = new Page();
  const location = { pathname: "/" };
  const pending: Array<{ url: string; resolve: (response: Response) => void }> = [];
  const fetch = (url: string) => new Promise<Response>((resolve) => pending.push({ url, resolve }));
  let stream: EventSource;
  class EventSource extends PageEvents {
    constructor(url: string) {
      super(url);
      stream = this;
    }
  }
  new Function(
    "document",
    "location",
    "history",
    "fetch",
    "EventSource",
    "addEventListener",
    "setInterval",
    "setTimeout",
    "clearTimeout",
    "Date",
    appJs,
  )(
    page,
    location,
    { pushState: (_s: null, _t: string, path: string) => location.pathname = path },
    fetch,
    EventSource,
    () => {},
    () => {},
    (callback: () => void) => {
      callback();
      return 1;
    },
    () => {},
    Date,
  );
  const answer = async (url: string, response: Response) => {
    const found = pending.findLast((p) => p.url === url)!;
    pending.splice(pending.indexOf(found), 1);
    found.resolve(response);
    await tick();
  };
  stream!.emit("open");
  await answer(
    "/api/needs-you",
    Response.json({
      ...snapshot(0),
      strip: { haltedSince: null, capUsd: 5, todayUsd: 3.5, capReached: false, stuck: 0 },
    }),
  );
  const link = page.getElementById("strip").querySelectorAll("a")[0];
  assertEquals(link.href, "/cost");
  link.click();
  await tick();
  assertEquals(location.pathname, "/cost");
  await answer(
    "/api/cost",
    Response.json({
      running: true,
      cost: {
        day: "2026-01-01",
        todayUsd: 3.5,
        capUsd: 5,
        capReached: false,
        projects: [{ name: "Example", usd: 3 }],
        requests: [
          { id: 7, project: "Example", status: "active", usd: 3, totalUsd: 4, budgetUsd: 8 },
          { id: 8, project: "Example", status: "done", usd: 0, totalUsd: 1, budgetUsd: null },
        ],
        otherUsd: 0.5,
      },
    }),
  );
  const text = page.getElementById("main").textContent;
  for (
    const part of [
      "$3.50 of the $5.00 daily cap",
      "Example",
      "#7",
      "$4.00 of $8.00 (50%)",
      "no Budget set",
      "Unclaimed spend",
      "$0.50 today that no Request claims",
    ]
  ) assertEquals(text.includes(part), true, part);
  const main = page.getElementById("main");
  assertEquals(main.children.some((child) => child.getAttribute("role") === "progressbar"), false);
  const tables = main.children.filter((child) => child.tag === "table");
  assertEquals(tables.length, 2);
  assertEquals(tables[0].children[0].children.map((cell) => cell.textContent), [
    "Project",
    "Today",
  ]);
  assertEquals(tables[1].children[0].children.map((cell) => cell.textContent), [
    "Request",
    "Project",
    "Today",
    "Total",
    "Budget",
  ]);
  assertEquals(tables[1].children[1].children.map((cell) => cell.textContent), [
    "#7",
    "Example",
    "$3.00",
    "$4.00",
    "$4.00 of $8.00 (50%)",
  ]);
});
