// Lavish pages: one local HTML page per Escalation, opened with `lavish-axi` when it is there.
// The daemon writes the page and its decision controls; the page carries a one-time token that
// lets it, and only it, carry the user's decision. Text typed on the page goes to the Overseer as
// a note and is never a decision. The page is never published to a host: it is a file in Kiln's
// data directory, and the only server is a loopback listener that takes the page's forms. Without
// Lavish, the commands (`kiln escalations|approve|reject`) do everything the page does.
import { join } from "@std/path";
import type { Logger } from "./log.ts";
import type { EscalationRecord, Store } from "./store.ts";
import { viewOf } from "./escalations.ts";

const VIEWER = "lavish-axi";
const MAX_FORM_BYTES = 64 * 1024;

async function readCapped(req: Request): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!req.body) return new Uint8Array(new ArrayBuffer(0));
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_FORM_BYTES) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
const VIEWER_TIMEOUT_MS = 60_000;

/** Remove script elements from text, however they are nested or left unclosed. */
export function stripScripts(text: string): string {
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
    // Only once no whole element is left: removing a stray tag first could join a new one.
    if (text === previous) text = text.replace(/<\/?script\b[^>]*>?/gi, "");
  } while (text !== previous);
  return text;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Content from agents as page text: scripts stripped, everything else shown as plain text. */
const content = (text: string): string => escapeHtml(stripScripts(text));

const newToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

export interface PagesOptions {
  store: Store;
  log: Logger;
  dir: string;
  /** Record the user's decision exactly as the CLI's approve and reject do. */
  decide: (params: { id: number; approved: boolean; reason?: unknown }) => void;
}

export function createPages(opts: PagesOptions) {
  const { store, log, dir } = opts;
  let origin = "";

  const pagePath = (id: number) => join(dir, `escalation-${id}.html`);

  function render(e: EscalationRecord): string {
    const view = viewOf(store, e);
    const page = store.getEscalationPage(e.id);
    const notes = store.listEscalationNotes(e.id);
    const open = view.status === "open" && page !== undefined && page.spentAt === null;
    const commands = `kiln approve ${e.id}\nkiln reject ${e.id} --reason "why"`;
    const controls = open
      ? `<form method="post" action="${origin}/escalations/${e.id}/decide">
  <input type="hidden" name="token" value="${page!.token}">
  <h2>Your decision</h2>
  <label>Reason (needed to reject)<br><input type="text" name="reason" size="60"></label>
  <p><button type="submit" name="decision" value="approve">Approve</button>
  <button type="submit" name="decision" value="reject">Reject</button></p>
</form>
<form method="post" action="${origin}/escalations/${e.id}/note">
  <input type="hidden" name="token" value="${page!.token}">
  <h2>Tell the Overseer</h2>
  <p>Text typed here goes to the Overseer. It is never a decision.</p>
  <textarea name="text" rows="4" cols="60"></textarea>
  <p><button type="submit">Send to the Overseer</button></p>
</form>`
      : `<p>This escalation is <strong>${view.status}</strong>${
        view.reason ? `: ${content(view.reason)}` : ""
      }. Nothing more can be decided here.</p>`;
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action ${origin}">
<title>Kiln escalation ${e.id}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem}
pre{white-space:pre-wrap;background:#f4f4f4;padding:1rem}button{font:inherit;padding:.4rem 1rem}</style>
</head><body>
<h1>Escalation ${e.id} <small>[${view.status}]</small></h1>
<h2>${content(e.summary)}</h2>
${e.detail ? `<pre>${content(e.detail)}</pre>` : ""}
${
      notes.length
        ? `<h2>Sent to the Overseer</h2><ul>${
          notes.map((n) => `<li>${content(n.body)}</li>`).join("")
        }</ul>`
        : ""
    }
${controls}
<h2>Or use the commands</h2>
<pre>${escapeHtml(commands)}</pre>
</body></html>
`;
  }

  // Synchronous, so concurrent rewrites cannot interleave and leave a stale page behind.
  function write(id: number) {
    Deno.writeTextFileSync(pagePath(id), render(store.getEscalation(id)));
  }

  /** Open the page in Lavish. Lavish being absent or failing costs nothing: the commands remain. */
  async function open(id: number) {
    try {
      const child = new Deno.Command(VIEWER, {
        args: [pagePath(id)],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch { /* already gone */ }
      }, VIEWER_TIMEOUT_MS);
      const status = await child.status.finally(() => clearTimeout(timer));
      if (!status.success) log.info("lavish could not open the page; use the commands", { id });
    } catch (err) {
      log.info("lavish is not available; use the commands", { id, err });
    }
  }

  const reply = (status: number, message: string) =>
    new Response(
      `<!doctype html><meta charset="utf-8"><title>Kiln</title><p>${escapeHtml(message)}</p>`,
      { status, headers: { "content-type": "text/html; charset=utf-8" } },
    );

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const match = /^\/escalations\/(\d+)\/(decide|note)$/.exec(url.pathname);
    if (req.method !== "POST" || !match) return reply(404, "Not found.");
    if (req.headers.get("host") !== origin.slice("http://".length)) {
      return reply(403, "Refused.");
    }
    const id = Number(match[1]);
    const body = await readCapped(req);
    if (body === undefined) return reply(413, "That is too much text.");
    const form = await new Response(body, {
      headers: { "content-type": req.headers.get("content-type") ?? "" },
    })
      .formData().catch(() => undefined);
    const field = (name: string) => {
      const value = form?.get(name);
      return typeof value === "string" ? value : undefined;
    };
    const page = store.getEscalationPage(id);
    if (!page || field("token") !== page.token) {
      return reply(403, "This page's token is not valid.");
    }
    if (page.spentAt !== null) return reply(409, "This escalation was already decided.");

    if (match[2] === "note") {
      const text = field("text")?.trim();
      if (!text) return reply(400, "Type something to send.");
      const status = viewOf(store, store.getEscalation(id)).status;
      if (status !== "open") return reply(409, `This escalation is ${status}.`);
      store.addEscalationNote(id, text);
      store.appendEvent("escalation.note", { id });
      write(id);
      return reply(200, "Sent to the Overseer. That is not a decision: decide on the page.");
    }

    const decision = field("decision");
    if (decision !== "approve" && decision !== "reject") {
      return reply(400, "Choose approve or reject.");
    }
    try {
      opts.decide({ id, approved: decision === "approve", reason: field("reason") });
    } catch (err) {
      return reply(409, (err as Error).message);
    }
    return reply(200, `Escalation ${id} ${decision === "approve" ? "approved" : "rejected"}.`);
  }

  return {
    /** Serve the page forms on the loopback interface only. */
    start(): Deno.HttpServer {
      const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        (req) =>
          handle(req).catch((err) => {
            log.error("page request failed", { err });
            return reply(500, "Something went wrong.");
          }),
      );
      origin = `http://127.0.0.1:${server.addr.port}`;
      return server;
    },

    /** Where the page of this Escalation is, if it has one. */
    pathOf(id: number): string | undefined {
      return store.getEscalationPage(id) ? pagePath(id) : undefined;
    },

    /** Rewrite a page after the Escalation changed, e.g. was decided. */
    refresh(id: number) {
      if (store.getEscalationPage(id)) write(id);
    },

    /**
     * Give every open Escalation a page. New ones are opened in Lavish; the others are rewritten
     * so that their forms reach this daemon.
     */
    sync(opts: { rewrite?: boolean } = {}) {
      for (const e of store.listEscalations({ openOnly: true })) {
        // One whose Request has ended cannot be decided: it gets no page.
        if (viewOf(store, e).status !== "open") continue;
        if (store.getEscalationPage(e.id)) {
          if (opts.rewrite) write(e.id);
          continue;
        }
        store.addEscalationPage(e.id, newToken());
        write(e.id);
        void open(e.id); // Lavish may be slow; nothing waits for it
      }
    },
  };
}
export type Pages = ReturnType<typeof createPages>;
