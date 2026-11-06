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
     status text not null default 'active' check (status in ('active', 'done', 'cancelled')),
     created_at text not null
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
  /**
   * Remove a Project, keeping its record and history. Refused (ActiveRequestsError) while it has
   * active Requests unless forced, in which case they are cancelled.
   */
  removeProject(name: string, opts?: { force?: boolean }): ProjectRecord;
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
    return {
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
          if (active > 0) {
            db.prepare(
              "update requests set status = 'cancelled' where project_id = ? and status = 'active'",
            )
              .run(project.id);
          }
          db.prepare("update projects set removed_at = ? where id = ?").run(removedAt, project.id);
          insertEvent.run(
            removedAt,
            "project.removed",
            JSON.stringify({ id: project.id, name, forced: !!o?.force, cancelledRequests: active }),
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
