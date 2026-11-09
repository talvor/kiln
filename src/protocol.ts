// Newline-delimited JSON over the daemon's local socket.

export interface Request {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}
/** Why a call was refused, for a caller that acts on the reason rather than on the text. */
export const ERROR_CODES = [
  "stale",
  "final",
  "needs-confirm",
  "not-found",
  "halted",
  "invalid",
] as const;
export type ErrorCode = typeof ERROR_CODES[number];

export const errorCodeOf = (err: unknown): ErrorCode | undefined => {
  const code = (err as { code?: unknown } | null)?.code;
  return ERROR_CODES.find((c) => c === code);
};

/** Who asked for a change: `cli` for the command line. Recorded in the event the change makes. */
export const sourceOf = (via: unknown): string | undefined => {
  if (via === undefined || via === null) return undefined;
  if (typeof via !== "string" || !via.trim() || via.length > 40 || !/^[\w.-]+$/.test(via)) {
    throw Object.assign(new Error('"via" must be a short name such as "cli".'), {
      code: "invalid" as const,
    });
  }
  return via;
};

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; code?: ErrorCode };

export async function* readLines(
  conn: { readable: ReadableStream<Uint8Array> },
): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of conn.readable) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) yield line;
    }
  }
}

export async function writeJson(conn: Deno.Conn, value: unknown): Promise<void> {
  await conn.write(new TextEncoder().encode(JSON.stringify(value) + "\n"));
}
