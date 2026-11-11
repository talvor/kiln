import { assertEquals } from "@std/assert";
import appJs from "../src/web/app.js" with { type: "text" };

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
  private listeners = new Map<string, (event: { preventDefault: () => void }) => void>();

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
  querySelectorAll(_selector: string): PageElement[] {
    const descendants = this.children.flatMap((
      child,
    ) => [child, ...child.querySelectorAll(_selector)]);
    return descendants.filter((node) =>
      node.tag === "button" && node.className.split(" ").includes("row")
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
  addEventListener(event: string, listener: (event: { preventDefault: () => void }) => void) {
    this.listeners.set(event, listener);
  }
  setSelectionRange(start: number, end: number, direction = "none") {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }
  focus(_options?: { preventScroll: boolean }) {
    this.page.activeElement = this;
  }
  click() {
    this.focus();
    this.listeners.get("click")?.({ preventDefault: () => {} });
  }
  input() {
    this.listeners.get("input")?.({ preventDefault: () => {} });
  }
}

class Page {
  title = "Kiln";
  activeElement: PageElement | null = null;
  private elements = new Map<string, PageElement>();

  constructor() {
    for (const id of ["rail", "main", "banner", "favicon"]) {
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
  private listeners = new Map<string, () => void>();
  constructor(_url: string) {}
  addEventListener(event: string, listener: () => void) {
    this.listeners.set(event, listener);
  }
  emit(event: string) {
    this.listeners.get(event)?.();
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
      "document", "location", "history", "fetch", "EventSource", "addEventListener",
      "setInterval", "setTimeout", "clearTimeout", appJs,
    )(
      page, location,
      { pushState: (_state: null, _title: string, path: string) => location.pathname = path },
      fetch, EventSource, () => {}, (callback: () => void) => ageTimer = callback,
      () => 1, () => {},
    );
    stream!.emit("open");
    pending[0].resolve(Response.json(snapshot(1)));
    await tick();
    const rail = page.getElementById("rail");
    const main = page.getElementById("main");
    assertEquals(rail.querySelector("details")?.open, false);
    rail.querySelector("details")!.open = true;
    ageTimer();
    assertEquals(rail.querySelector("details")?.open, true);
    rail.querySelectorAll("button.row")[0].click();
    const buttons = main.children.flatMap((child) => child.children).flatMap((child) => child.children);
    const rejectButton = buttons.find((button) => button.textContent === "Reject")!;
    rejectButton.click();
    const reason = main.querySelector("textarea")!;
    reason.value = "A reason in progress";
    reason.input();
    reason.setSelectionRange(2, 8, "backward");
    reason.focus();
    ageTimer();
    const restored = main.querySelector("textarea")!;
    assertEquals(page.activeElement, restored);
    assertEquals([restored.value, restored.selectionStart, restored.selectionEnd, restored.selectionDirection],
      ["A reason in progress", 2, 8, "backward"]);
    const approve = main.querySelector("button")!;
    approve.click();
    const post = pending.find((p) => p.url.endsWith("/decide"))!;
    post.resolve(Response.json({ ok: false, error: `Daemon says ${outcome}`, code: outcome }, {
      status: 409,
    }));
    await tick();
    pending.at(-1)!.resolve(Response.json(outcome === "final"
      ? snapshot(0)
      : { ...snapshot(0), stale: [item(1)] }));
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
  assertEquals(main.textContent, "This dashboard was restarted, open the new URL.");

  stream!.emit("open");
  pending[9].resolve(Response.json(snapshot(5)));
  await tick();
  stream!.emit("open");
  pending[10].resolve(Response.json(snapshot(1)));
  await tick();
  assertEquals(page.activeElement?.dataset.escalationId, "1");
  stream!.emit("open");
  pending[11].resolve(Response.json(snapshot(0)));
  await tick();
  assertEquals(page.activeElement, main.firstElementChild);
  assertEquals(main.firstElementChild?.textContent, "Escalation 2 is not waiting on you.");
  ageTimer();
  assertEquals(page.activeElement, main.firstElementChild);
});
