import * as sqlite from "node:sqlite";
const { DatabaseSync } = sqlite;
const dir = await Deno.makeTempDir({ prefix: "kiln-" });
console.log("dir", dir, "sqlite", new DatabaseSync(":memory:").prepare("select sqlite_version() v").get());
const db = new DatabaseSync(dir + "/a.db");
db.exec("pragma journal_mode=wal; create table t(x)");
const tries: Record<string, () => void> = {
  plain: () => db.exec(`vacuum into '${dir}/b1.db'`),
  mode0700dir: () => { Deno.mkdirSync(dir + "/sub", { mode: 0o700 }); db.exec(`vacuum into '${dir}/sub/b2.db'`); },
  umask077: () => { Deno.umask(0o077); db.exec(`vacuum into '${dir}/b3.db'`); },
  dated: () => db.exec(`vacuum into '${dir}/kiln-manual-2026-11-05T19-31-28-282Z-0.db'`),
};
for (const [k, f] of Object.entries(tries)) {
  try { f(); console.log(k, "ok"); } catch (e) { console.log(k, "FAIL", String(e)); }
}

try {
  const n = await sqlite.backup(db, dir + "/c.db");
  const c = new DatabaseSync(dir + "/c.db");
  console.log("backupFn ok pages", n, c.prepare("pragma integrity_check").get(), c.prepare("pragma journal_mode").get());
} catch (e) { console.log("backupFn FAIL", String(e)); }
