// R-2 follow-up: which file carries the write lock, per journal mode?
// Same harness as probe.js, parameterised by (journal_mode, attack target).
// DB on /root (ext4). better-sqlite3 by absolute path; no npm install.
const Database = require("/tmp/l3-bs3b/node_modules/better-sqlite3");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const DIR = "/root/r2-probe/run2";
const DB = DIR + "/main.db";

function openDb() {
  const db = new Database(DB, { timeout: 0 });
  db.pragma("busy_timeout = 0");
  return db;
}

if (process.argv[2] === "child") {
  const db = openDb();
  let out;
  try {
    db.exec("begin immediate");
    db.exec("insert into t(who) values ('B')");
    db.exec("commit");
    out = { result: "COMMITTED", ack: true };
  } catch (e) {
    out = { result: "refused", code: e.code };
  }
  db.close();
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

function arm(mode, target) {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  const a = openDb();
  const applied = a.pragma(`journal_mode = ${mode}`)[0].journal_mode;
  a.exec("create table t(id integer primary key, who text)");
  a.exec("begin immediate");
  a.exec("insert into t(who) values ('A')");

  const path = target === "db" ? DB : target === "shm" ? DB + "-shm" : null;
  let attacked = "none";
  if (path) {
    if (fs.existsSync(path)) { fs.readFileSync(path); attacked = "read+close"; }
    else attacked = "ABSENT";
  }

  const child = JSON.parse(
    execFileSync(process.execPath, [__filename, "child"], { encoding: "utf8" }),
  );

  let aCommit;
  try { a.exec("commit"); aCommit = { ack: true }; }
  catch (e) { aCommit = { ack: false, code: e.code }; }
  a.close();

  const v = openDb();
  const rows = v.prepare("select who from t order by id").all().map((r) => r.who);
  const integrity = v.pragma("integrity_check")[0].integrity_check;
  v.close();

  const lost = (aCommit.ack && !rows.includes("A")) || (child.ack && !rows.includes("B"));
  console.log(
    `mode=${applied.padEnd(8)} attack=${(target || "none").padEnd(4)}(${attacked.padEnd(10)})` +
      ` competitor=${(child.result + (child.code ? " " + child.code : "")).padEnd(22)}` +
      ` A.commit=${aCommit.ack ? "ok" : "FAILED " + aCommit.code}` +
      ` rows=${JSON.stringify(rows).padEnd(11)} integrity=${integrity}` +
      ` ack_commit_lost=${lost ? "YES" : "no"}`,
  );
}

console.log("better-sqlite3", require("/tmp/l3-bs3b/node_modules/better-sqlite3/package.json").version,
  "| node", process.version);
for (const [m, t] of [
  ["wal", null], ["wal", "db"], ["wal", "shm"],
  ["delete", null], ["delete", "db"],
  ["truncate", null], ["truncate", "db"],
]) arm(m, t);
