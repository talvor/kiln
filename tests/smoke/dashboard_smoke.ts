// Opt-in browser smoke for the Dashboard: a real Chrome opens the real `kiln dashboard --no-open`
// running against a real daemon in the test world, visits every view, approves an Escalation and
// sees a live event arrive. The file name does not match `*.test.ts`, so `deno task test` never
// picks it up, and nothing runs without the opt-in. Run it with `deno task smoke:dashboard`
// (see docs/smoke.md).
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { asAgent, openTeam } from "../router_helpers.ts";
import { makeWorld } from "../world.ts";

const enabled = Deno.env.get("KILN_SMOKE") === "1";

/** The browser to drive: `KILN_SMOKE_CHROME` (a command line), else the first Chrome on PATH. */
async function chromeCommand(): Promise<string[]> {
  const given = Deno.env.get("KILN_SMOKE_CHROME")?.trim();
  if (given) return given.split(/\s+/);
  for (
    const name of [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "chrome",
    ]
  ) {
    const probe = await new Deno.Command("which", { args: [name], stdout: "piped", stderr: "null" })
      .output().catch(() => undefined);
    if (probe?.code === 0) return [name];
  }
  throw new Error("No Chrome found: put one on PATH or set KILN_SMOKE_CHROME to its command");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort(): Promise<number> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return Promise.resolve(port);
}

/** A page of a headless Chrome, driven over the DevTools protocol. */
class Browser {
  private nextId = 1;
  private pending = new Map<
    number,
    (reply: { result?: unknown; error?: { message: string } }) => void
  >();

  private constructor(private child: Deno.ChildProcess, private socket: WebSocket) {
    socket.onmessage = (message) => {
      const reply = JSON.parse(message.data);
      this.pending.get(reply.id)?.(reply);
      this.pending.delete(reply.id);
    };
  }

  static async launch(profile: string): Promise<Browser> {
    const [bin, ...args] = await chromeCommand();
    const port = await freePort();
    const child = new Deno.Command(bin, {
      args: [
        ...args,
        "--headless=new",
        "--no-sandbox",
        "--no-first-run",
        "--disable-gpu",
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${port}`,
        "about:blank",
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json/list`);
          const pages = (await res.json()).filter((t: { type: string }) => t.type === "page");
          if (pages.length > 0) {
            const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
            await new Promise((resolve, reject) => {
              socket.onopen = resolve;
              socket.onerror = () => reject(new Error("DevTools socket failed"));
            });
            return new Browser(child, socket);
          }
          await res.body?.cancel();
        } catch {
          // Not listening yet.
        }
        await sleep(100);
      }
      throw new Error("Chrome did not start listening for DevTools");
    } catch (error) {
      child.kill("SIGKILL");
      await child.status;
      throw error;
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (reply) => {
        if (reply.error) reject(new Error(`${method}: ${reply.error.message}`));
        else resolve(reply.result);
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async goto(url: string) {
    await this.send("Page.navigate", { url });
  }

  /** Evaluate an expression in the page and return its value. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const out = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as { result: { value: T }; exceptionDetails?: { exception?: { description?: string } } };
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description);
    return out.result.value;
  }

  /** Wait until `expression` is truthy in the page, or fail saying what was being waited for. */
  async waitFor(what: string, expression: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        last = await this.eval(expression);
        if (last) return;
      } catch (error) {
        last = error;
      }
      await sleep(100);
    }
    const body = await this.eval<string>("document.body.innerText").catch(() => "?");
    throw new Error(`Timed out waiting for ${what} (last: ${last}). Page text:\n${body}`);
  }

  /** Click the first element matching `selector` whose text contains `text`. */
  click(selector: string, text = "") {
    return this.eval(
      `(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find((e) => e.textContent.includes(${JSON.stringify(text)}));
        if (!el) throw new Error("nothing to click: " + ${JSON.stringify(selector + " " + text)});
        el.click();
        return true;
      })()`,
    );
  }

  /** Has a document-level load happened since `mark`? In-page navigation must not cause one. */
  markDocument() {
    return this.eval("window.__smokeMark = true");
  }
  sameDocument() {
    return this.eval<boolean>("window.__smokeMark === true");
  }

  async close() {
    this.socket.close();
    this.child.kill("SIGKILL");
    await this.child.status;
  }
}

Deno.test({
  name: "smoke: a browser opens each Dashboard view, approves an Escalation and sees a live event",
  ignore: !enabled,
  fn: async () => {
    const world = await makeWorld();
    const profile = await Deno.makeTempDir({ prefix: "kiln-smoke-chrome-" });
    let browser: Browser | undefined;
    try {
      await openTeam(world);
      // One running Request with something spent today, and an Escalation that waits on it.
      const db = new DatabaseSync(join(world.dirs.data, "kiln.db"), { timeout: 5_000 });
      try {
        db.prepare(
          `insert into projects (name, source, remote_url, clone_path, default_branch, head_commit,
             registered_at) values ('Example', 's', 'r', 'c', 'main', 'h', 'now')`,
        ).run();
        db.prepare(
          `insert into requests (project_id, status, created_at, description)
           values (1, 'active', 'now', 'Smoke request')`,
        ).run();
        db.prepare(
          `insert into escalations (raised_by, request_id, summary, created_at)
           values ('overseer', 1, 'Ship the smoke test?', ?)`,
        ).run(new Date().toISOString());
      } finally {
        db.close();
      }

      const dashboard = await world.dashboard();
      browser = await Browser.launch(profile);

      // Signing in with the launch URL lands on Needs you with the Escalation listed.
      await browser.goto(dashboard.url);
      await browser.waitFor(
        "the Escalation in Needs you",
        `!!document.querySelector("button.row[data-escalation-id='1']")`,
      );
      await browser.waitFor(
        "the open count in the tab title",
        `/^\\(\\d+\\) Kiln/.test(document.title)`,
      );
      const open = await browser.eval<number>(
        `Number(/^\\((\\d+)\\)/.exec(document.title)?.[1] ?? 0)`,
      );
      assert(open >= 1);
      await browser.markDocument();

      // The header strip links to the Health and Cost views; both swap the main area in place.
      await browser.click("#strip a", "Health");
      await browser.waitFor(
        "the Health view",
        `location.pathname === "/health" && /Run checks/.test(document.getElementById("main").innerText)`,
      );
      await browser.eval("history.back()");
      await browser.waitFor("Needs you again after Back", `location.pathname === "/"`);
      await browser.click("#strip a", "today");
      await browser.waitFor(
        "the Cost view",
        `location.pathname === "/cost" && /unclaimed/i.test(document.getElementById("main").innerText)`,
      );

      // A Request opens on Overview while live, and has Transcript and Report tabs.
      await browser.click("button.row.request", "Smoke request");
      await browser.waitFor(
        "the Request Overview",
        `location.pathname === "/requests/1" && /Live feed/.test(document.getElementById("main").innerText)`,
      );
      for (const tab of ["Transcript", "Report", "Overview"]) {
        await browser.click(".tabs a.tab", tab);
        await browser.waitFor(
          `the ${tab} tab`,
          `document.querySelector(".tabs a.tab.active")?.textContent === ${JSON.stringify(tab)}`,
        );
      }
      assert(await browser.sameDocument(), "navigating between views reloaded the page");

      // Each view has its own address and works on reload.
      for (const path of ["/health", "/cost", "/requests/1/report", "/escalations/1"]) {
        await browser.goto(dashboard.origin + path);
        await browser.waitFor(
          `${path} after a reload`,
          `location.pathname === ${
            JSON.stringify(path)
          } && document.getElementById("main").innerText.trim() !== ""`,
        );
      }

      // Approve the Escalation with one click: it leaves Needs you and the count follows.
      await browser.waitFor(
        "the Approve button",
        `[...document.querySelectorAll("button.approve")].length === 1`,
      );
      await browser.click("button.approve");
      await browser.waitFor(
        "the count to drop by one",
        `Number(/^\\((\\d+)\\)/.exec(document.title)?.[1] ?? 0) === ${open - 1}`,
      );
      await browser.waitFor(
        "Recently decided to hold the decision",
        `/Approved/.test(document.getElementById("rail").textContent)`,
      );

      // A live event: while the Request's Overview is open, a new Escalation raised from outside
      // shows up in Needs you and the tab title without any reload.
      await browser.eval(
        `history.pushState(null, "", "/requests/1"), dispatchEvent(new PopStateEvent("popstate"))`,
      );
      await browser.markDocument();
      await asAgent(
        world,
        "overseer",
        (agent) => agent.call("raise_escalation", { summary: "A live one" }),
      );
      await browser.waitFor(
        "the live Escalation in Needs you",
        `/A live one/.test(document.getElementById("rail").innerText)`,
      );
      await browser.waitFor(
        "the open count to follow",
        `Number(/^\\((\\d+)\\)/.exec(document.title)?.[1] ?? 0) === ${open}`,
      );
      assert(await browser.sameDocument(), "the live update reloaded the page");
      assertEquals(await browser.eval("location.pathname"), "/requests/1");
    } finally {
      await browser?.close();
      await world.stopDashboards();
      await world.kiln("daemon", "stop");
      await Deno.remove(profile, { recursive: true }).catch(() => {});
      await Deno.remove(world.root, { recursive: true }).catch(() => {});
    }
  },
});
