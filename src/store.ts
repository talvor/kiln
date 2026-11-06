import { join } from "@std/path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import type { Logger } from "./log.ts";

/**
 * Ordered schema migrations. The store's `user_version` is the number of migrations applied.
 * Never edit a shipped migration; append a new one.
 */
export const MIGRATIONS: string[] = [
  // 1: key/value metadata and the append-only event log.
  `create table meta (key text primary key, value text not null) strict;
   create table events (
     id integer primary key,
     ts text not null,
     kind text not null,
     data text not null default '{}'
   ) strict;
   create trigger events_no_update before update on events
     begin select raise(abort, 'events are append-only'); end;
   create trigger events_no_delete before delete on events
     begin select raise(abort, 'events are append-only'); end;`,
  // 2: registered Projects.
  `create table projects (
     id integer primary key,
     name text not null unique,
     source text not null,
     remote_url text not null,
     clone_path text not null,
     default_branch text not null,
     head_commit text not null,
     setup_command text,
     test_command text,
     lint_command text,
     build_command text,
     baseline text,
     warnings text not null default '[]',
     registered_at text not null
   ) strict;`,
  // 3: managing Projects: pause, soft removal (history is kept; the name is freed for a new
  // registration), and Requests, so removal can tell whether work is still active.
  `create table projects_new (
     id integer primary key,
     name text not null,
     source text not null,
     remote_url text not null,
     clone_path text not null,
     default_branch text not null,
     head_commit text not null,
     setup_command text,
     test_command text,
     lint_command text,
     build_command text,
     baseline text,
     warnings text not null default '[]',
     registered_at text not null,
     paused integer not null default 0,
     removed_at text
   ) strict;
   insert into projects_new (id, name, source, remote_url, clone_path, default_branch, head_commit,
       setup_command, test_command, lint_command, build_command, baseline, warnings, registered_at)
     select id, name, source, remote_url, clone_path, default_branch, head_commit,
       setup_command, test_command, lint_command, build_command, baseline, warnings, registered_at
     from projects;
   drop table projects;
   alter table projects_new rename to projects;
   create unique index projects_active_name on projects (name) where removed_at is null;
   create table requests (
     id integer primary key,
     project_id integer not null references projects (id),
     status text not null default 'active' check (status in ('active', 'done')),
     created_at text not null
   ) strict;`,
  // 4: sessions (the addresses agents work under) and the Messages between them. Messages are
  // append-only; what happens to them afterwards (read, delivered, dead-lettered) lives in
  // message_status.
  `create table sessions (
     address text primary key,
     role text not null check (role in ('overseer', 'leader', 'worker')),
     department text,
     cwd text not null,
     opened_at text not null
   ) strict;
   create unique index sessions_one_overseer on sessions (role) where role = 'overseer';
   create unique index sessions_one_leader on sessions (department) where role = 'leader';
   create table messages (
     id integer primary key,
     sender text not null references sessions (address),
     recipient text not null references sessions (address),
     kind text not null check (kind in ('assignment', 'result', 'question', 'answer')),
     body text not null,
     in_reply_to integer references messages (id),
     assignment_id integer references messages (id),
     synthesised integer not null default 0,
     sent_at text not null
   ) strict;
   create trigger messages_no_update before update on messages
     begin select raise(abort, 'messages are append-only'); end;
   create trigger messages_no_delete before delete on messages
     begin select raise(abort, 'messages are append-only'); end;
   create table message_status (
     message_id integer primary key references messages (id),
     read_at text,
     deliveries integer not null default 0,
     last_delivery_at text,
     dead_lettered_at text
   ) strict;`,
  // 5: Worktrees (checkouts outside the Project's clone, each with its own ports), the branch of
  // each Request, and Assignments with their own branch and Worktree.
  `create table worktrees (
     id integer primary key,
     path text not null,
     branch text not null,
     port_base integer not null,
     created_at text not null,
     released_at text
   ) strict;
   create unique index worktrees_live_ports on worktrees (port_base) where released_at is null;
   alter table requests add column branch text;
   alter table requests add column worktree_id integer references worktrees (id);
   create table assignments (
     id integer primary key,
     request_id integer not null references requests (id),
     number integer not null,
     branch text,
     worktree_id integer references worktrees (id),
     status text not null default 'active' check (status in ('active', 'merged')),
     pushed integer not null default 0,
     created_at text not null,
     merged_at text,
     unique (request_id, number)
   ) strict;`,
];

export class StoreTooNewError extends Error {
  constructor(found: number, supported: number) {
    super(
      `The store is at schema version ${found}, newer than this Kiln supports (${supported}). ` +
        `It was written by a newer Kiln; upgrade Kiln instead of opening it with this version.`,
    );
  }
}

/** A Project as registered: where it came from, Kiln's clone, its commands and test baseline. */
export interface ProjectRecord {
  id: number;
  name: string;
  /** What the user gave Kiln: a path or a URL. */
  source: string;
  remoteUrl: string;
  /** Kiln's own clone of the Project. */
  clonePath: string;
  defaultBranch: string;
  headCommit: string;
  setupCommand: string | null;
  testCommand: string | null;
  lintCommand: string | null;
  buildCommand: string | null;
  /** The result of the test command on the clean checkout; null when there is no test command. */
  baseline: Baseline | null;
  warnings: string[];
  registeredAt: string;
  /** A paused Project accepts no new Requests. */
  paused: boolean;
  /** Set when the Project was removed; its record and history stay. */
  removedAt: string | null;
}
export interface Baseline {
  passed: boolean;
  exitCode: number;
  durationMs: number;
  /** The commit the baseline was recorded on. */
  commit: string;
  /** The end of the test command's output. */
  outputTail: string;
  recordedAt: string;
}
export type NewProject = Omit<ProjectRecord, "id" | "registeredAt" | "paused" | "removedAt">;
/** What can change on a registered Project. */
export type ProjectPatch = Partial<
  Pick<
    ProjectRecord,
    | "paused"
    | "defaultBranch"
    | "headCommit"
    | "setupCommand"
    | "testCommand"
    | "lintCommand"
    | "buildCommand"
    | "baseline"
    | "warnings"
  >
>;

/** A checkout of a Project outside its clone, with the ports it may use. */
export interface WorktreeRecord {
  id: number;
  path: string;
  branch: string;
  /** First of the WORKTREE_PORTS consecutive ports reserved for this Worktree. */
  portBase: number;
  releasedAt: string | null;
}
export const WORKTREE_PORTS = 10;
export const FIRST_WORKTREE_PORT = 20_000;
const LAST_WORKTREE_PORT = 60_000;

export interface RequestRecord {
  id: number;
  projectId: number;
  status: "active" | "done";
  /** The branch the Request's merged Assignments accumulate on; null until it is created. */
  branch: string | null;
  worktreeId: number | null;
}
export interface AssignmentRecord {
  id: number;
  requestId: number;
  /** Counted per Request, from 1. */
  number: number;
  branch: string | null;
  worktreeId: number | null;
  status: "active" | "merged";
  /** Whether the merge has reached the remote. */
  pushed: boolean;
}

export class UnknownRequestError extends Error {
  constructor(id: number) {
    super(`No request ${id} exists.`);
  }
}
export class UnknownAssignmentError extends Error {
  constructor(id: number) {
    super(`No assignment ${id} exists.`);
  }
}

export type Role = "overseer" | "leader" | "worker";
export type MessageKind = "assignment" | "result" | "question" | "answer";

/** The address an agent works under, and where it sits in the chain of command. */
export interface SessionRecord {
  address: string;
  role: Role;
  /** Set for leaders and workers; the overseer belongs to no department. */
  department: string | null;
  /** Directory Kiln wakes the agent in. */
  cwd: string;
  openedAt: string;
}
export type NewSession = Omit<SessionRecord, "openedAt">;

/** A Message and what has happened to it since it was sent. */
export interface MessageRecord {
  id: number;
  from: string;
  to: string;
  kind: MessageKind;
  body: Record<string, unknown>;
  /** The assignment a result answers, or the question an answer answers. */
  inReplyTo: number | null;
  /** The assignment a question asks about, if any. */
  assignmentId: number | null;
  /** Written by Kiln itself rather than by the sender. */
  synthesised: boolean;
  sentAt: string;
  readAt: string | null;
  /** How many Nudges have been sent for it. */
  deliveries: number;
  lastDeliveryAt: string | null;
  deadLetteredAt: string | null;
}
export type NewMessage = Pick<MessageRecord, "from" | "to" | "kind" | "body"> & {
  inReplyTo?: number | null;
  assignmentId?: number | null;
  synthesised?: boolean;
};
export interface MessageFilter {
  to?: string;
  from?: string;
  kind?: MessageKind;
  inReplyTo?: number;
  /** Not yet read, dead-lettered, or completed: what an agent still has to pick up. */
  waiting?: boolean;
}

export class UnknownSessionError extends Error {
  constructor(address: string) {
    super(`No session is open at "${address}".`);
  }
}
export class DuplicateSessionError extends Error {}

export class UnknownProjectError extends Error {
  constructor(name: string) {
    super(`No project named "${name}" is registered.`);
  }
}

/** Removal refused: the Project still has active Requests. */
export class ActiveRequestsError extends Error {
  constructor(name: string, readonly count: number) {
    super(
      `"${name}" has ${count} active request${count === 1 ? "" : "s"}; ` +
        `finish them or remove the project with --force.`,
    );
  }
}

export class DuplicateProjectError extends Error {
  constructor(name: string) {
    super(`A project named "${name}" is already registered.`);
  }
}

export interface StoreInfo {
  schemaVersion: number;
  sqliteVersion: string;
  journalMode: string;
}

export interface Store {
  info(): StoreInfo;
  /** Write a consistent copy of the store into the backups directory; returns its path. */
  backup(label?: string): Promise<string>;
  appendEvent(kind: string, data?: Record<string, unknown>): void;
  /** Record a Project; throws DuplicateProjectError if the name is taken. */
  addProject(project: NewProject): ProjectRecord;
  /** Registered Projects; removed ones only when asked for. */
  listProjects(opts?: { includeRemoved?: boolean }): ProjectRecord[];
  /** The registered (not removed) Project with this name; throws UnknownProjectError. */
  getProject(name: string): ProjectRecord;
  /** Change a Project; throws UnknownProjectError. */
  updateProject(name: string, patch: ProjectPatch): ProjectRecord;
  /** Remove a Project, keeping its record and history; refuse active Requests unless forced. */
  removeProject(name: string, opts?: { force?: boolean }): ProjectRecord;
  /** Begin a Request on a Project (no branch or Worktree yet). */
  addRequest(projectId: number): RequestRecord;
  /** Throws UnknownRequestError. */
  getRequest(id: number): RequestRecord;
  /** Begin an Assignment of a Request, numbered after the Request's earlier ones. */
  addAssignment(requestId: number): AssignmentRecord;
  /** Throws UnknownAssignmentError. */
  getAssignment(id: number): AssignmentRecord;
  /** Reserve a free port block for a new Worktree; throws if none is left. */
  addWorktree(wt: { path: string; branch: string }): WorktreeRecord;
  getWorktree(id: number): WorktreeRecord;
  /** Give back a Worktree's ports. */
  releaseWorktree(id: number): void;
  /** Record the branch and Worktree a Request or Assignment works on. */
  attachRequest(id: number, branch: string, worktreeId: number): void;
  attachAssignment(id: number, branch: string, worktreeId: number): void;
  /** Forget a Request or Assignment whose branch could not be created. */
  discardRequest(id: number): void;
  discardAssignment(id: number): void;
  /** Record that an Assignment was merged into its Request's branch. */
  markMerged(assignmentId: number): void;
  markPushed(assignmentId: number): void;
  /** Open a session; throws DuplicateSessionError if its address, or its seat, is taken. */
  addSession(session: NewSession): SessionRecord;
  listSessions(): SessionRecord[];
  /** Throws UnknownSessionError. */
  getSession(address: string): SessionRecord;
  /** Append a Message. Messages are never changed or removed afterwards. */
  appendMessage(message: NewMessage): MessageRecord;
  getMessage(id: number): MessageRecord | undefined;
  listMessages(filter?: MessageFilter): MessageRecord[];
  markRead(ids: number[]): void;
  /** Count one more Nudge for each of these Messages. */
  recordDelivery(ids: number[]): void;
  deadLetter(id: number): void;
  close(): void;
}

export interface StoreOptions {
  file: string;
  backupsDir: string;
  log: Logger;
  migrations?: string[];
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function openStore(opts: StoreOptions): Promise<Store> {
  const migrations = opts.migrations ?? MIGRATIONS;
  const existed = (() => {
    try {
      Deno.statSync(opts.file);
      return true;
    } catch {
      return false;
    }
  })();

  const db = new DatabaseSync(opts.file);
  try {
    const mode = db.prepare("pragma journal_mode = wal").get()!.journal_mode;
    if (mode !== "wal") {
      throw new Error(
        `Could not enable WAL mode on ${opts.file} (got "${mode}"). The store must be on a local filesystem.`,
      );
    }
    db.exec("pragma foreign_keys = on; pragma busy_timeout = 5000;");
    const version = () => db.prepare("pragma user_version").get()!.user_version as number;

    const found = version();
    if (found > migrations.length) throw new StoreTooNewError(found, migrations.length);

    let backupSeq = 0;
    // Uses SQLite's online backup API (VACUUM INTO fails to open its target under Deno on macOS).
    const backup = async (label = "manual"): Promise<string> => {
      Deno.mkdirSync(opts.backupsDir, { recursive: true, mode: 0o700 });
      const dest = join(opts.backupsDir, `kiln-${label}-${stamp()}-${backupSeq++}.db`);
      await sqliteBackup(db, dest);
      Deno.chmodSync(dest, 0o600);
      return dest;
    };

    if (found < migrations.length) {
      if (existed) {
        const dest = await backup(`pre-migrate-v${found}`);
        opts.log.info("store backed up before migration", {
          from: found,
          to: migrations.length,
          backup: dest,
        });
      }
      for (let v = found; v < migrations.length; v++) {
        db.exec("begin");
        try {
          db.exec(migrations[v]);
          db.exec(`pragma user_version = ${v + 1}`);
          db.exec("commit");
        } catch (err) {
          db.exec("rollback");
          throw err;
        }
        opts.log.info("store migrated", { version: v + 1 });
      }
    }

    const insertEvent = db.prepare("insert into events (ts, kind, data) values (?, ?, ?)");
    const insertProject = db.prepare(
      `insert into projects (name, source, remote_url, clone_path, default_branch, head_commit,
         setup_command, test_command, lint_command, build_command, baseline, warnings, registered_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const toRecord = (row: Record<string, unknown>): ProjectRecord => ({
      id: row.id as number,
      name: row.name as string,
      source: row.source as string,
      remoteUrl: row.remote_url as string,
      clonePath: row.clone_path as string,
      defaultBranch: row.default_branch as string,
      headCommit: row.head_commit as string,
      setupCommand: row.setup_command as string | null,
      testCommand: row.test_command as string | null,
      lintCommand: row.lint_command as string | null,
      buildCommand: row.build_command as string | null,
      baseline: row.baseline ? JSON.parse(row.baseline as string) : null,
      warnings: JSON.parse(row.warnings as string),
      registeredAt: row.registered_at as string,
      paused: row.paused === 1,
      removedAt: row.removed_at as string | null,
    });
    const selectActive = db.prepare("select * from projects where name = ? and removed_at is null");
    const getProject = (name: string): ProjectRecord => {
      const row = selectActive.get(name);
      if (!row) throw new UnknownProjectError(name);
      return toRecord(row);
    };
    const countActive = db.prepare(
      "select count(*) n from requests where project_id = ? and status = 'active'",
    );
    const toSession = (row: Record<string, unknown>): SessionRecord => ({
      address: row.address as string,
      role: row.role as Role,
      department: row.department as string | null,
      cwd: row.cwd as string,
      openedAt: row.opened_at as string,
    });
    const toMessage = (row: Record<string, unknown>): MessageRecord => ({
      id: row.id as number,
      from: row.sender as string,
      to: row.recipient as string,
      kind: row.kind as MessageKind,
      body: JSON.parse(row.body as string),
      inReplyTo: row.in_reply_to as number | null,
      assignmentId: row.assignment_id as number | null,
      synthesised: row.synthesised === 1,
      sentAt: row.sent_at as string,
      readAt: row.read_at as string | null,
      deliveries: row.deliveries as number,
      lastDeliveryAt: row.last_delivery_at as string | null,
      deadLetteredAt: row.dead_lettered_at as string | null,
    });
    const messageSelect =
      `select m.*, s.read_at, s.deliveries, s.last_delivery_at, s.dead_lettered_at
       from messages m join message_status s on s.message_id = m.id`;
    const inTransaction = <T>(work: () => T): T => {
      db.exec("begin");
      try {
        const result = work();
        db.exec("commit");
        return result;
      } catch (err) {
        db.exec("rollback");
        throw err;
      }
    };
    const getMessage = (id: number): MessageRecord | undefined => {
      const row = db.prepare(`${messageSelect} where m.id = ?`).get(id);
      return row ? toMessage(row) : undefined;
    };
    const toRequest = (row: Record<string, unknown>): RequestRecord => ({
      id: row.id as number,
      projectId: row.project_id as number,
      status: row.status as "active" | "done",
      branch: row.branch as string | null,
      worktreeId: row.worktree_id as number | null,
    });
    const toAssignment = (row: Record<string, unknown>): AssignmentRecord => ({
      id: row.id as number,
      requestId: row.request_id as number,
      number: row.number as number,
      branch: row.branch as string | null,
      worktreeId: row.worktree_id as number | null,
      status: row.status as "active" | "merged",
      pushed: row.pushed === 1,
    });
    const toWorktree = (row: Record<string, unknown>): WorktreeRecord => ({
      id: row.id as number,
      path: row.path as string,
      branch: row.branch as string,
      portBase: row.port_base as number,
      releasedAt: row.released_at as string | null,
    });
    const getRequest = (id: number): RequestRecord => {
      const row = db.prepare("select * from requests where id = ?").get(id);
      if (!row) throw new UnknownRequestError(id);
      return toRequest(row);
    };
    const getAssignment = (id: number): AssignmentRecord => {
      const row = db.prepare("select * from assignments where id = ?").get(id);
      if (!row) throw new UnknownAssignmentError(id);
      return toAssignment(row);
    };
    return {
      addRequest: (projectId) => {
        const { lastInsertRowid } = db.prepare(
          "insert into requests (project_id, created_at) values (?, ?)",
        ).run(projectId, new Date().toISOString());
        return getRequest(Number(lastInsertRowid));
      },
      getRequest,
      addAssignment: (requestId) =>
        inTransaction(() => {
          getRequest(requestId);
          const next = Number(
            db.prepare(
              "select coalesce(max(number), 0) + 1 n from assignments where request_id = ?",
            )
              .get(requestId)!.n,
          );
          const { lastInsertRowid } = db.prepare(
            "insert into assignments (request_id, number, created_at) values (?, ?, ?)",
          ).run(requestId, next, new Date().toISOString());
          return getAssignment(Number(lastInsertRowid));
        }),
      getAssignment,
      addWorktree: (wt) =>
        inTransaction(() => {
          const used = new Set(
            db.prepare("select port_base from worktrees where released_at is null").all()
              .map((r) => r.port_base as number),
          );
          let base = FIRST_WORKTREE_PORT;
          while (used.has(base)) base += WORKTREE_PORTS;
          if (base + WORKTREE_PORTS > LAST_WORKTREE_PORT) {
            throw new Error("No free port block is left for a new worktree.");
          }
          const { lastInsertRowid } = db.prepare(
            "insert into worktrees (path, branch, port_base, created_at) values (?, ?, ?, ?)",
          ).run(wt.path, wt.branch, base, new Date().toISOString());
          return toWorktree(
            db.prepare("select * from worktrees where id = ?").get(Number(lastInsertRowid))!,
          );
        }),
      getWorktree: (id) => toWorktree(db.prepare("select * from worktrees where id = ?").get(id)!),
      releaseWorktree: (id) => {
        db.prepare("update worktrees set released_at = ? where id = ? and released_at is null")
          .run(new Date().toISOString(), id);
      },
      attachRequest: (id, branch, worktreeId) => {
        db.prepare("update requests set branch = ?, worktree_id = ? where id = ?")
          .run(branch, worktreeId, id);
      },
      attachAssignment: (id, branch, worktreeId) => {
        db.prepare("update assignments set branch = ?, worktree_id = ? where id = ?")
          .run(branch, worktreeId, id);
      },
      discardRequest: (id) => {
        db.prepare("delete from requests where id = ? and branch is null").run(id);
      },
      discardAssignment: (id) => {
        db.prepare("delete from assignments where id = ? and branch is null").run(id);
      },
      markMerged: (id) => {
        db.prepare("update assignments set status = 'merged', merged_at = ? where id = ?")
          .run(new Date().toISOString(), id);
      },
      markPushed: (id) => {
        db.prepare("update assignments set pushed = 1 where id = ?").run(id);
      },
      addSession: (s) => {
        const openedAt = new Date().toISOString();
        try {
          db.prepare(
            "insert into sessions (address, role, department, cwd, opened_at) values (?, ?, ?, ?, ?)",
          ).run(s.address, s.role, s.department, s.cwd, openedAt);
        } catch (err) {
          if (/UNIQUE constraint failed/.test((err as Error).message)) {
            throw new DuplicateSessionError(
              s.role === "overseer"
                ? "There is already an overseer."
                : s.role === "leader" && s.department
                ? `Department "${s.department}" already has a leader, or "${s.address}" is open.`
                : `A session is already open at "${s.address}".`,
            );
          }
          throw err;
        }
        return { ...s, openedAt };
      },
      listSessions: () =>
        db.prepare("select * from sessions order by opened_at, address").all().map(toSession),
      getSession: (address) => {
        const row = db.prepare("select * from sessions where address = ?").get(address);
        if (!row) throw new UnknownSessionError(address);
        return toSession(row);
      },
      appendMessage: (m) =>
        inTransaction(() => {
          const { lastInsertRowid } = db.prepare(
            `insert into messages (sender, recipient, kind, body, in_reply_to, assignment_id, synthesised, sent_at)
             values (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            m.from,
            m.to,
            m.kind,
            JSON.stringify(m.body),
            m.inReplyTo ?? null,
            m.assignmentId ?? null,
            m.synthesised ? 1 : 0,
            new Date().toISOString(),
          );
          db.prepare("insert into message_status (message_id) values (?)").run(lastInsertRowid);
          return getMessage(Number(lastInsertRowid))!;
        }),
      getMessage,
      listMessages: (f = {}) => {
        const where: string[] = [];
        const values: (string | number)[] = [];
        if (f.to !== undefined) (where.push("m.recipient = ?"), values.push(f.to));
        if (f.from !== undefined) (where.push("m.sender = ?"), values.push(f.from));
        if (f.kind !== undefined) (where.push("m.kind = ?"), values.push(f.kind));
        if (f.inReplyTo !== undefined) (where.push("m.in_reply_to = ?"), values.push(f.inReplyTo));
        if (f.waiting) {
          where.push(
            `s.read_at is null and s.dead_lettered_at is null and
             (m.kind != 'assignment' or not exists (
               select 1 from messages r where r.kind = 'result' and r.in_reply_to = m.id
             ))`,
          );
        }
        return db.prepare(
          `${messageSelect} ${where.length ? `where ${where.join(" and ")}` : ""} order by m.id`,
        ).all(...values).map(toMessage);
      },
      markRead: (ids) =>
        inTransaction(() => {
          const stmt = db.prepare(
            "update message_status set read_at = ? where message_id = ? and read_at is null",
          );
          const now = new Date().toISOString();
          for (const id of ids) stmt.run(now, id);
        }),
      recordDelivery: (ids) =>
        inTransaction(() => {
          const stmt = db.prepare(
            "update message_status set deliveries = deliveries + 1, last_delivery_at = ? where message_id = ?",
          );
          const now = new Date().toISOString();
          for (const id of ids) stmt.run(now, id);
        }),
      deadLetter: (id) => {
        db.prepare("update message_status set dead_lettered_at = ? where message_id = ?")
          .run(new Date().toISOString(), id);
      },
      addProject: (p) => {
        const registeredAt = new Date().toISOString();
        try {
          const { lastInsertRowid } = insertProject.run(
            p.name,
            p.source,
            p.remoteUrl,
            p.clonePath,
            p.defaultBranch,
            p.headCommit,
            p.setupCommand,
            p.testCommand,
            p.lintCommand,
            p.buildCommand,
            p.baseline ? JSON.stringify(p.baseline) : null,
            JSON.stringify(p.warnings),
            registeredAt,
          );
          return {
            ...p,
            id: Number(lastInsertRowid),
            registeredAt,
            paused: false,
            removedAt: null,
          };
        } catch (err) {
          if (/UNIQUE constraint failed/.test((err as Error).message)) {
            throw new DuplicateProjectError(p.name);
          }
          throw err;
        }
      },
      listProjects: (o) =>
        db.prepare(
          `select * from projects ${
            o?.includeRemoved ? "" : "where removed_at is null "
          }order by id`,
        ).all().map(toRecord),
      getProject,
      updateProject: (name, patch) => {
        const project = getProject(name);
        const columns: Record<keyof ProjectPatch, string> = {
          paused: "paused",
          defaultBranch: "default_branch",
          headCommit: "head_commit",
          setupCommand: "setup_command",
          testCommand: "test_command",
          lintCommand: "lint_command",
          buildCommand: "build_command",
          baseline: "baseline",
          warnings: "warnings",
        };
        const sets: string[] = [];
        const values: (string | number | null)[] = [];
        for (const key of Object.keys(patch) as (keyof ProjectPatch)[]) {
          if (!(key in columns) || patch[key] === undefined) continue;
          const value = patch[key];
          sets.push(`${columns[key]} = ?`);
          values.push(
            key === "paused"
              ? (value ? 1 : 0)
              : key === "baseline" || key === "warnings"
              ? (value === null ? null : JSON.stringify(value))
              : value as string | null,
          );
        }
        if (sets.length) {
          db.prepare(`update projects set ${sets.join(", ")} where id = ?`).run(
            ...values,
            project.id,
          );
        }
        return getProject(name);
      },
      removeProject: (name, o) => {
        const project = getProject(name);
        const active = Number(countActive.get(project.id)!.n);
        if (active > 0 && !o?.force) throw new ActiveRequestsError(name, active);
        const removedAt = new Date().toISOString();
        db.exec("begin");
        try {
          db.prepare("update projects set removed_at = ? where id = ?").run(removedAt, project.id);
          insertEvent.run(
            removedAt,
            "project.removed",
            JSON.stringify({ id: project.id, name, forced: !!o?.force }),
          );
          db.exec("commit");
        } catch (err) {
          db.exec("rollback");
          throw err;
        }
        return { ...project, removedAt };
      },
      info: () => ({
        schemaVersion: version(),
        sqliteVersion: db.prepare("select sqlite_version() v").get()!.v as string,
        journalMode: db.prepare("pragma journal_mode").get()!.journal_mode as string,
      }),
      backup,
      appendEvent: (kind, data = {}) => {
        insertEvent.run(new Date().toISOString(), kind, JSON.stringify(data));
      },
      close: () => db.close(),
    };
  } catch (err) {
    db.close();
    throw err;
  }
}
