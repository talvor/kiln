// The Dashboard's Requests rail, Overview and Cancel: the real `kiln dashboard --no-open` against
// the real daemon, over HTTP. Requests do not start without a Playbook run, so tests seed them in
// the store file, the way tests/manage.test.ts does.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { rawCall } from "./helpers.ts";
import { withWorld, type World } from "./world.ts";
import { openTeam } from "./router_helpers.ts";

type D = Awaited<ReturnType<World["dashboard"]>>;
interface Row {
  id: number;
  status: string;
  waiting: boolean;
  recent: boolean;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function seed(world: World, fill: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(join(world.dirs.data, "kiln.db"), { timeout: 5_000 });
  try {
    db.prepare(
      `insert into projects (name, source, remote_url, clone_path, default_branch, head_commit,
         registered_at) values ('Example', 's', 'r', 'c', 'main', 'h', 'now')`,
    ).run();
    fill(db);
  } finally {
    db.close();
  }
}
const request = (db: DatabaseSync, status: string, description: string) =>
  Number(
    db.prepare(
      "insert into requests (project_id, status, created_at, description) values (1, ?, 'now', ?)",
    ).run(status, description).lastInsertRowid,
  );
const event = (db: DatabaseSync, ts: string, kind: string, data: unknown) =>
  db.prepare("insert into events (ts, kind, data) values (?, ?, ?)").run(
    ts,
    kind,
    JSON.stringify(data),
  );

const rail = async (d: D, cookie: string): Promise<Row[]> =>
  (await (await d.fetch("/api/needs-you", { cookie })).json()).requests;
const post = (d: D, cookie: string, path: string) =>
  d.fetch(path, { method: "POST", cookie, origin: d.origin });

withWorld("the rail marks running, waiting and recently failed Requests", async (w) => {
  await openTeam(w);
  seed(w, (db) => {
    request(db, "active", "Running");
    const waiting = request(db, "active", "Waiting on you");
    db.prepare(
      `insert into escalations (raised_by, request_id, summary, created_at)
       values ('overseer', ?, 'Ship?', 'now')`,
    ).run(waiting);
    const recent = request(db, "failed", "Failed today");
    event(db, hoursAgo(2), "request.cancelled", { id: recent });
    const old = request(db, "failed", "Failed long ago");
    event(db, hoursAgo(48), "request.cancelled", { id: old });
    request(db, "done", "Done");
  });
  const d = await w.dashboard();
  const cookie = await d.signIn();
  const rows = await rail(d, cookie);
  assertEquals(rows.map((r) => [r.id, r.status, r.waiting, r.recent]), [
    [5, "done", false, false],
    [4, "failed", false, false],
    [3, "failed", false, true],
    [2, "active", true, true],
    [1, "active", false, true],
  ]);
});

withWorld("failed Requests without an end time use a known start or stay finished", async (w) => {
  await openTeam(w);
  seed(w, (db) => {
    const recent = request(db, "failed", "Started today");
    event(db, hoursAgo(2), "request.started", { id: recent });
    const old = request(db, "failed", "Started long ago");
    event(db, hoursAgo(48), "request.started", { id: old });
    const last = request(db, "failed", "Recent event");
    event(db, hoursAgo(1), "message.sent", { request: last });
    request(db, "failed", "No timestamp");
  });
  const d = await w.dashboard();
  const cookie = await d.signIn();
  const rows = await rail(d, cookie);
  assertEquals(rows.map((r) => [r.id, r.recent]), [
    [4, false],
    [3, true],
    [2, false],
    [1, true],
  ]);
  const db = new DatabaseSync(join(w.dirs.data, "kiln.db"), { timeout: 5_000 });
  try {
    event(db, hoursAgo(1), "request.cancelled", { id: 2 });
  } finally {
    db.close();
  }
  assertEquals((await rail(d, cookie)).map((r) => [r.id, r.recent]), [
    [4, false],
    [3, true],
    [2, true],
    [1, true],
  ]);
});

withWorld("a Request's Overview has its steps, assignments, budget and events", async (w) => {
  await openTeam(w); // starts the daemon, which creates the store
  seed(w, (db) => {
    const id = request(db, "active", "Build it");
    db.prepare("insert into steps (request_id, position, spec, status) values (?, 1, ?, 'active')")
      .run(id, JSON.stringify({ name: "Implement", department: "dev" }));
    event(db, hoursAgo(1), "request.started", { id });
    event(db, hoursAgo(0.5), "step.done", { request: id, step: 1 });
  });
  const d = await w.dashboard();
  const cookie = await d.signIn();
  const res = await d.fetch("/api/requests/1", { cookie });
  assertEquals(res.status, 200);
  const view = await res.json();
  assertEquals(view.request.steps.map((s: { name: string }) => s.name), ["Implement"]);
  assertEquals(typeof view.request.costUsd, "number");
  assert(view.events.some((e: { kind: string }) => e.kind === "request.started"));
  const later = await (await d.fetch(`/api/requests/1?after=${view.events[0].id}`, { cookie }))
    .json();
  assertEquals(later.events.map((e: { kind: string }) => e.kind), ["step.done"]);
  // The daemon may append events of its own in between, so the cursor can only have moved on.
  assert(later.last >= view.last);
  const empty = await (await d.fetch(`/api/requests/1?after=${view.last}`, { cookie })).json();
  assertEquals(empty.events, []);
  const badCursor = await d.fetch("/api/requests/1?after=oops", { cookie });
  assertEquals(badCursor.status, 400);
  await badCursor.body?.cancel();
  // The page itself is served at the Request's own address.
  const page = await d.fetch("/requests/1", { cookie });
  assertEquals(page.status, 200);
  await page.body?.cancel();
  const missing = await d.fetch("/api/requests/99", { cookie });
  assertEquals(missing.status, 404);
  await missing.body?.cancel();
  const bad = await d.fetch("/requests/abc", { cookie });
  assertEquals(bad.status, 404);
  await bad.body?.cancel();
});

withWorld("Cancel fails the Request, records Source dashboard and is refused twice", async (w) => {
  await openTeam(w); // starts the daemon, which creates the store
  seed(w, (db) => request(db, "active", "Doomed"));
  const d = await w.dashboard();
  const cookie = await d.signIn();
  const denied = await d.fetch("/api/requests/1/cancel", { method: "POST", cookie });
  assertEquals(denied.status, 403); // no Origin: refused before it reaches the daemon
  await denied.body?.cancel();
  assertEquals((await rail(d, cookie))[0].status, "active");
  const res = await post(d, cookie, "/api/requests/1/cancel");
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
  const [row] = await rail(d, cookie);
  assertEquals([row.status, row.recent], ["failed", true]);
  const view = await (await d.fetch("/api/requests/1", { cookie })).json();
  assertEquals(view.request.status, "failed");
  assert(view.events.some((e: { kind: string }) => e.kind === "request.cancelled"));
  const again = await post(d, cookie, "/api/requests/1/cancel");
  assertEquals(again.status, 409);
  const refusal = await again.json();
  assertEquals([refusal.ok, refusal.code], [false, "final"]);
  const cancelled = await rawCall(w, "events.since", {
    after: 0,
    waitMs: 0,
    kinds: ["request.cancelled"],
  });
  assertEquals(
    (cancelled.result as { events: { data: { via?: string } }[] }).events.map((e) => e.data.via),
    ["dashboard"],
  );
});
