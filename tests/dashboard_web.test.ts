import { assertEquals } from "@std/assert";
import appJs from "../src/web/app.js" with { type: "text" };

class PageElement {
  className = "";
  dataset: Record<string, string> = {};
  style = { display: "" };
  scrollTop = 0;
  href = "";
  type = "";
  parent: PageElement | null = null;
  children: PageElement[] = [];
  private content = "";
  private listeners = new Map<string, () => void>();

  constructor(readonly tag: string, readonly page: Page) {}

  get textContent(): string {
    return this.content + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.replaceChildren();
    this.content = value;
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
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll(_selector)]);
    return descendants.filter((node) =>
      node.tag === "button" && node.className.split(" ").includes("row")
    );
  }
  addEventListener(event: string, listener: () => void) {
    this.listeners.set(event, listener);
  }
  focus(_options?: { preventScroll: boolean }) {
    this.page.activeElement = this;
  }
  click() {
    this.focus();
    this.listeners.get("click")?.();
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
  gate: "approval",
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
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test("dashboard script keeps text, count, focus and newest snapshot", async () => {
  const page = new Page();
  const location = { pathname: "/" };
  const pending: Array<(response: Response) => void> = [];
  const fetch = () => new Promise<Response>((resolve) => pending.push(resolve));
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
    "document", "location", "history", "fetch", "EventSource", "addEventListener",
    "setInterval", "setTimeout", "clearTimeout", appJs,
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
  pending[0](Response.json(snapshot(12)));
  await tick();
  assertEquals(page.title, "(12) Kiln");
  assertEquals(decodeURIComponent(page.getElementById("favicon").href).includes("9+"), true);

  const rail = page.getElementById("rail");
  const main = page.getElementById("main");
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
  pending[1](Response.json(snapshot(12)));
  await tick();
  assertEquals(page.activeElement?.dataset.escalationId, "2");

  stream!.emit("open");
  stream!.emit("open");
  pending[3](Response.json(snapshot(3)));
  await tick();
  pending[2](Response.json(snapshot(1)));
  await tick();
  assertEquals(page.title, "(3) Kiln");
  assertEquals(page.activeElement?.dataset.escalationId, "2");
});
