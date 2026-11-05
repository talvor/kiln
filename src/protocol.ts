// Newline-delimited JSON over the daemon's local socket.

export interface Request {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}
export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export async function* readLines(conn: Deno.Conn): AsyncGenerator<string> {
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
