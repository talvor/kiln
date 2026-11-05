import { join } from "jsr:@std/path@1";
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
];

export class StoreTooNewError extends Error {
  constructor(found: number, supported: number) {
    super(
      `The store is at schema version ${found}, newer than this Kiln supports (${supported}). ` +
        `It was written by a newer Kiln; upgrade Kiln instead of opening it with this version.`,
    );
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
    return {
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
