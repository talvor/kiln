// The Dashboard: `kiln dashboard`, a separate foreground process that is a client of the daemon's
// unix socket (ADR 0001). It serves the page shell on 127.0.0.1. Deno.serve checks neither Host
// nor Origin, so both are checked here, and nothing is served without the session cookie.
//
// The per-launch token lives in this process's memory and nowhere else: it is printed in the URL,
// exchanged once for a session cookie, then dead.
import { call, DaemonError, DaemonNotRunning } from "./client.ts";
import type { EscalationView } from "./escalations.ts";
import { needsYou } from "./needs_you.ts";
import type { KilnPaths } from "./paths.ts";
import appJs from "./web/app.js" with { type: "text" };
import indexHtml from "./web/index.html" with { type: "text" };

const COOKIE = "kiln_dashboard";
const SAFE_METHODS = new Set(["GET", "HEAD"]);

export interface Dashboard {
  /** The URL to print: it carries the token, which works once. */
  url: string;
  /**
   * The URL to hand to the browser-opening command. A command's arguments are visible to every
   * process of the user, so this carries a one-time launch code, never the token. Using either
   * the launch code or the token kills both.
   */
  openUrl: string;
  port: number;
  /** Stop serving and wait until the server has finished. */
  stop(): Promise<void>;
  finished: Promise<void>;
}

const randomSecret = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookieOf(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

const headers = (extra: Record<string, string> = {}) => ({
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  ...extra,
});
const refuse = (status: number, why: string) =>
  new Response(`${why}\n`, {
    status,
    headers: headers({ "content-type": "text/plain; charset=utf-8" }),
  });

/** The longest the daemon is asked to hold an `events.since` call open. */
const POLL_WAIT_MS = 25_000;
const PING_MS = 15_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One feed of "something happened in Kiln" for every connected tab. The daemon's `events.since`
 * long-poll runs only while at least one tab listens, and stops when the last one leaves. Events
 * are only hints: a tab re-fetches what it shows, so a missed one cannot corrupt a page.
 */
function createEventHub(paths: KilnPaths) {
  const listeners = new Set<(cursor: number) => void>();
  let cursor: number | null = null;
  let running = false;
  let listenerEpoch = 0;

  async function loop() {
    let down = false;
    let backoff = 500;
    while (listeners.size > 0) {
      const began = Date.now();
      const epoch = listenerEpoch;
      try {
        const feed = await call<{ events: unknown[]; last: number }>(paths, "events.since", {
          after: cursor ?? 0,
          waitMs: cursor === null ? 0 : POLL_WAIT_MS,
        });
        if (epoch !== listenerEpoch) return;
        cursor = feed.last;
        backoff = 500;
        if (feed.events.length > 0 || down) {
          for (const listener of listeners) listener(cursor);
        }
        down = false;
        if (Date.now() - began < 500) await sleep(500); // never spin on an answer that came at once
      } catch {
        if (epoch !== listenerEpoch) return;
        if (!down) {
          for (const listener of listeners) listener(cursor ?? 0);
        }
        down = true;
        cursor = null; // a restarted daemon may count events afresh; look for the cursor again
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 10_000);
      }
    }
  }
  const start = () => {
    if (running) return;
    running = true;
    loop().finally(() => {
      running = false;
      if (listeners.size > 0) start(); // someone came back while the last call was finishing
    });
  };
  return {
    subscribe(listener: (cursor: number) => void): () => void {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) listenerEpoch++;
      };
    },
  };
}

/** Start serving on 127.0.0.1; port 0 picks a free one. */
export function startDashboard(paths: KilnPaths, opts: { port?: number } = {}): Dashboard {
  const token = randomSecret();
  const launch = randomSecret();
  const session = randomSecret();
  let tokenSpent = false;
  let port = 0;
  const hosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  const hub = createEventHub(paths);
  const closers = new Set<() => void>();

  /** One multiplexed Server-Sent Events stream for a tab. */
  function events(): Response {
    const encoder = new TextEncoder();
    let release = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch { /* the tab is gone; cancel() cleans up */ }
        };
        send("retry: 2000\n\n");
        const unsubscribe = hub.subscribe((cursor) => send(`event: changed\ndata: ${cursor}\n\n`));
        const ping = setInterval(() => send(": ping\n\n"), PING_MS);
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          closers.delete(end);
          unsubscribe();
          clearInterval(ping);
        };
        // What stop() calls: leave, and finish the stream. The same reference is removed on leaving.
        const end = () => {
          close();
          try {
            controller.close();
          } catch { /* already closed */ }
        };
        release = close;
        closers.add(end);
      },
      // Cleanup lives here, not on request.signal, which is not reliable for streams.
      cancel() {
        release();
      },
    });
    return new Response(body, {
      headers: headers({ "content-type": "text/event-stream", "x-accel-buffering": "no" }),
    });
  }

  /** The Needs you list, as the page draws it. */
  async function needsYouView(): Promise<Response> {
    try {
      const [escalations, requests] = await Promise.all([
        call<EscalationView[]>(paths, "escalations.list", { all: true }),
        call<{ id: number; project: string }[]>(paths, "requests.list", { all: true }),
      ]);
      return json({
        running: true,
        ...needsYou(escalations, requests),
        decided: await recentlyDecided(escalations),
      });
    } catch (err) {
      if (err instanceof DaemonNotRunning) {
        return json({ running: false, count: 0, groups: [], stale: [], decided: [] });
      }
      throw err;
    }
  }

  /** The last 20 decisions, newest first. The Source lives in the decision's event. */
  async function recentlyDecided(escalations: EscalationView[]) {
    const decided = escalations.filter((e) =>
      e.decidedAt !== null && e.status !== "open" &&
      e.status !== "stale"
    )
      .sort((a, b) => Date.parse(b.decidedAt!) - Date.parse(a.decidedAt!) || b.id - a.id)
      .slice(0, 20);
    if (decided.length === 0) return [];
    const sources = new Map<number, string>();
    try {
      const feed = await call<{ events: { data: { id?: number; via?: string } }[] }>(
        paths,
        "events.since",
        { after: 0, kinds: ["escalation.decided"] },
      );
      for (const e of feed.events) {
        if (typeof e.data?.id === "number" && e.data.via) sources.set(e.data.id, e.data.via);
      }
    } catch { /* no Source to show is better than no list */ }
    return decided.map((e) => ({
      id: e.id,
      summary: e.summary,
      decision: e.status,
      reason: e.reason,
      decidedAt: e.decidedAt,
      source: sources.get(e.id) ?? null,
    }));
  }

  /** Settle an Escalation for the user. The daemon's refusal is passed on as it was worded. */
  async function decide(req: Request, id: number): Promise<Response> {
    let body: { approved?: unknown; reason?: unknown; confirm?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "That was not a decision.", code: "invalid" }, 400);
    }
    if (typeof body !== "object" || body === null || typeof body.approved !== "boolean") {
      return json({ ok: false, error: "That was not a decision.", code: "invalid" }, 400);
    }
    if (!body.approved && (typeof body.reason !== "string" || !body.reason.trim())) {
      return json({
        ok: false,
        error: "Say why: a rejection needs a reason.",
        code: "invalid",
      }, 400);
    }
    try {
      await call(paths, "escalations.decide", {
        id,
        approved: body.approved,
        reason: body.approved ? undefined : body.reason,
        confirm: body.approved && body.confirm === true,
        via: "dashboard",
      });
      return json({ ok: true });
    } catch (err) {
      if (err instanceof DaemonNotRunning) {
        return json({ ok: false, error: "Kiln is not running.", code: "down" }, 503);
      }
      if (err instanceof DaemonError) {
        return json({ ok: false, error: err.message, code: err.code ?? null }, 409);
      }
      throw err;
    }
  }

  const redirectHome = (setCookie?: string) =>
    new Response(null, {
      status: 303,
      headers: headers({ location: "/", ...(setCookie ? { "set-cookie": setCookie } : {}) }),
    });

  async function handle(req: Request): Promise<Response> {
    if (!hosts().has(req.headers.get("host") ?? "")) return refuse(403, "Wrong Host.");
    if (!SAFE_METHODS.has(req.method) && !origins().has(req.headers.get("origin") ?? "")) {
      return refuse(403, "Wrong Origin.");
    }
    const url = new URL(req.url);

    // The first load: the token buys the session cookie, once, and the page moves to a clean URL.
    const offered = req.method === "GET" && url.pathname === "/"
      ? url.searchParams.get("token")
      : null;
    const launched = req.method === "GET" && url.pathname === `/launch/${launch}`;
    if (offered !== null || launched) {
      const mine = cookieOf(req, COOKIE);
      if (mine !== undefined && same(mine, session)) return redirectHome(); // a reload
      if (tokenSpent || (!launched && !same(offered!, token))) {
        return refuse(
          403,
          "This link has already been used or is wrong. Open the URL printed by `kiln dashboard`.",
        );
      }
      tokenSpent = true;
      return redirectHome(`${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`);
    }

    const cookie = cookieOf(req, COOKIE);
    if (cookie === undefined || !same(cookie, session)) {
      return refuse(403, "Not signed in. Open the URL printed by `kiln dashboard`.");
    }

    if (!SAFE_METHODS.has(req.method)) {
      const act = /^\/api\/escalations\/(\d+)\/decide$/.exec(url.pathname);
      if (act && req.method === "POST") return await decide(req, Number(act[1]));
      return refuse(405, "No such action.");
    }
    // Every view has its own address; the page swaps its main area to match.
    if (url.pathname === "/" || /^\/escalations\/\d+$/.test(url.pathname)) {
      return new Response(req.method === "HEAD" ? null : indexHtml, {
        headers: headers({ "content-type": "text/html; charset=utf-8" }),
      });
    }
    if (url.pathname === "/app.js") {
      return new Response(req.method === "HEAD" ? null : appJs, {
        headers: headers({ "content-type": "text/javascript; charset=utf-8" }),
      });
    }
    if (url.pathname === "/events") return events();
    if (url.pathname === "/api/needs-you") return await needsYouView();
    if (url.pathname === "/api/status") return await status();
    return refuse(404, "Not found.");
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: headers({ "content-type": "application/json" }),
    });

  /** Whether Kiln is running; never starts it. */
  async function status(): Promise<Response> {
    try {
      const s = await call<{ pid: number; version: string; startedAt: string }>(paths, "status");
      return json({ running: true, pid: s.pid, version: s.version, startedAt: s.startedAt });
    } catch (err) {
      if (err instanceof DaemonNotRunning) return json({ running: false });
      throw err; // a daemon that answers badly is not "not running"
    }
  }

  const server = Deno.serve(
    { hostname: "127.0.0.1", port: opts.port ?? 0, onListen: () => {} },
    (req) => handle(req).catch(() => refuse(500, "Something went wrong.")),
  );
  port = server.addr.port;
  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    openUrl: `http://127.0.0.1:${port}/launch/${launch}`,
    port,
    stop: () => {
      for (const close of [...closers]) close(); // open streams would hold a graceful shutdown
      return server.shutdown();
    },
    finished: server.finished,
  };
}

/** Ask the desktop to open a URL in the default browser. Failing is fine: the URL is printed. */
export function openBrowser(url: string): void {
  const [cmd, args] = Deno.build.os === "darwin"
    ? ["open", [url]]
    : Deno.build.os === "windows"
    ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try {
    new Deno.Command(cmd, { args, stdin: "null", stdout: "null", stderr: "null" }).spawn().unref();
  } catch { /* no opener on this machine */ }
}
