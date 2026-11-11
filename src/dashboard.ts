// The Dashboard: `kiln dashboard`, a separate foreground process that is a client of the daemon's
// unix socket (ADR 0001). It serves the page shell on 127.0.0.1. Deno.serve checks neither Host
// nor Origin, so both are checked here, and nothing is served without the session cookie.
//
// The per-launch token lives in this process's memory and nowhere else: it is printed in the URL,
// exchanged once for a session cookie, then dead.
import { call, DaemonNotRunning } from "./client.ts";
import type { KilnPaths } from "./paths.ts";
import indexHtml from "./web/index.html" with { type: "text" };

const COOKIE = "kiln_dashboard";
const SAFE_METHODS = new Set(["GET", "HEAD"]);

export interface Dashboard {
  /** The URL to open: it carries the token, which works once. */
  url: string;
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

/** Start serving on 127.0.0.1; port 0 picks a free one. */
export function startDashboard(paths: KilnPaths, opts: { port?: number } = {}): Dashboard {
  const token = randomSecret();
  const session = randomSecret();
  let tokenSpent = false;
  let port = 0;
  const hosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  async function handle(req: Request): Promise<Response> {
    if (!hosts().has(req.headers.get("host") ?? "")) return refuse(403, "Wrong Host.");
    if (!SAFE_METHODS.has(req.method) && !origins().has(req.headers.get("origin") ?? "")) {
      return refuse(403, "Wrong Origin.");
    }
    const url = new URL(req.url);

    // The first load: the token buys the session cookie, once, and the page moves to a clean URL.
    const offered = url.searchParams.get("token");
    if (req.method === "GET" && url.pathname === "/" && offered !== null) {
      if (tokenSpent || !same(offered, token)) {
        return refuse(
          403,
          "This link has already been used or is wrong. Open the URL printed by `kiln dashboard`.",
        );
      }
      tokenSpent = true;
      return new Response(null, {
        status: 303,
        headers: headers({
          location: "/",
          "set-cookie": `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`,
        }),
      });
    }

    const cookie = cookieOf(req, COOKIE);
    if (cookie === undefined || !same(cookie, session)) {
      return refuse(403, "Not signed in. Open the URL printed by `kiln dashboard`.");
    }

    if (!SAFE_METHODS.has(req.method)) return refuse(405, "No such action.");
    if (url.pathname === "/") {
      return new Response(req.method === "HEAD" ? null : indexHtml, {
        headers: headers({ "content-type": "text/html; charset=utf-8" }),
      });
    }
    if (url.pathname === "/api/status") return await status();
    return refuse(404, "Not found.");
  }

  /** Whether Kiln is running; never starts it. */
  async function status(): Promise<Response> {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: headers({ "content-type": "application/json" }),
      });
    try {
      const s = await call<{ pid: number; version: string; startedAt: string }>(paths, "status");
      return json({ running: true, pid: s.pid, version: s.version, startedAt: s.startedAt });
    } catch (err) {
      if (err instanceof DaemonNotRunning) return json({ running: false });
      return json({ running: false });
    }
  }

  const server = Deno.serve(
    { hostname: "127.0.0.1", port: opts.port ?? 0, onListen: () => {} },
    (req) => handle(req).catch(() => refuse(500, "Something went wrong.")),
  );
  port = server.addr.port;
  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    port,
    stop: () => server.shutdown(),
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
