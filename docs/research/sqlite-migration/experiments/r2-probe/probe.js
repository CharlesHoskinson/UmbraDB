// R-2 reproduction: does BEGIN IMMEDIATE survive an in-process open+close of -shm?
// DB lives on /root (ext4). better-sqlite3 is required by absolute path from the
// driver lane's existing install; no npm install is run.
const Database = require("/tmp/l3-bs3b/node_modules/better-sqlite3");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const DIR = "/root/r2-probe/run";
const DB = DIR + "/main.db";

function openDb() {
  const db = new Database(DB, { timeout: 0 });
  db.pragma("busy_timeout = 0");
  return db;
}

if (process.argv[2] === "child") {
  // A second OS process. Tries to take the write lock and commit.
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

function arm(mode) {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  const a = openDb();
  a.pragma("journal_mode = WAL");
  a.exec("create table t(id integer primary key, who text)");

  // A takes the write lock and writes, but does not commit yet.
  a.exec("begin immediate");
  a.exec("insert into t(who) values ('A')");

  const shm = DB + "-shm";
  const shmExists = fs.existsSync(shm);
  let held;
  if (mode === "shm-openkeep") {
    held = fs.openSync(shm, "r"); // open, do NOT close
  } else if (mode === "shm-readclose") {
    fs.readFileSync(shm); // open + close  <-- the attack
  }

  const child = JSON.parse(
    execFileSync(process.execPath, [__filename, "child"], { encoding: "utf8" }),
  );

  let aCommit;
  try {
    a.exec("commit");
    aCommit = { ack: true };
  } catch (e) {
    aCommit = { ack: false, code: e.code };
  }
  if (held !== undefined) fs.closeSync(held);
  a.close();

  const v = openDb();
  const rows = v.prepare("select who from t order by id").all().map((r) => r.who);
  const integrity = v.pragma("integrity_check")[0].integrity_check;
  v.close();

  // An acknowledged commit is lost if a COMMIT returned ok but its row is absent.
  const lostA = aCommit.ack && !rows.includes("A");
  const lostB = child.ack && !rows.includes("B");

  console.log(
    `[${mode.padEnd(14)}] shm_present=${shmExists}` +
      ` competitor=${(child.result + (child.code ? " " + child.code : "")).padEnd(22)}` +
      ` A.commit=${aCommit.ack ? "ok" : "FAILED " + aCommit.code}` +
      ` rows=${JSON.stringify(rows)}` +
      ` integrity=${integrity}` +
      ` acknowledged_commit_lost=${lostA || lostB ? "YES" : "no"}`,
  );
}

console.log(
  "better-sqlite3", require("/tmp/l3-bs3b/node_modules/better-sqlite3/package.json").version,
  "| node", process.version,
);
for (const m of ["none", "shm-openkeep", "shm-readclose"]) arm(m);
