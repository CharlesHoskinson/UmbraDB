// Probe 4: separate the two index faults.
//   (a) count divergence  — index has fewer entries than the table
//   (b) content divergence — index has the RIGHT entry count but the WRONG key for a row
// quick_check is documented as doing everything integrity_check does EXCEPT verifying that index
// content matches table content. (a) should be visible to both; (b) should be visible only to
// integrity_check. The plan must specify (b), not (a).
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("/tmp/l3-bs3b/");
const Database = require("better-sqlite3");

function build(dir, mutate) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const P = `${dir}/t.db`;
  let db = new Database(P);
  db.pragma("journal_mode = DELETE");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
  db.exec("CREATE INDEX ix ON t (v)");
  const ins = db.prepare("INSERT INTO t (id, v) VALUES (?, ?)");
  for (let i = 1; i <= 500; i++) ins.run(i, `val_${String(i).padStart(5, "0")}`);
  const ixRow = db
    .prepare("select type,name,tbl_name,rootpage,sql from sqlite_schema where name='ix'")
    .get();
  db.close();

  // hide the index
  db = new Database(P);
  db.unsafeMode(true);
  db.exec("PRAGMA writable_schema = ON");
  db.exec("DELETE FROM sqlite_schema WHERE name = 'ix'");
  db.close();

  // mutate the table while the index is invisible
  db = new Database(P);
  mutate(db);
  db.close();

  // restore the index definition, pointing at the same (now stale) root page
  db = new Database(P);
  db.unsafeMode(true);
  db.exec("PRAGMA writable_schema = ON");
  db.exec(
    `INSERT INTO sqlite_schema (type,name,tbl_name,rootpage,sql) VALUES ('${ixRow.type}','${ixRow.name}','${ixRow.tbl_name}',${ixRow.rootpage},'${ixRow.sql}')`,
  );
  db.close();
  return P;
}

function report(label, P, probeValue) {
  const db = new Database(P);
  const ic = JSON.stringify(db.pragma("integrity_check"));
  const qc = JSON.stringify(db.pragma("quick_check"));
  const viaIndex = db.prepare("select id from t indexed by ix where v = ?").all(probeValue);
  const viaScan = db.prepare("select id from t where +v = ?").all(probeValue);
  const cntIdx = db.prepare("select count(*) as c from t indexed by ix where v > ''").get().c;
  const cntScan = db.prepare("select count(*) as c from t where +v > ''").get().c;
  console.log(`\n=== ${label} ===`);
  console.log("  integrity_check:", ic.slice(0, 300));
  console.log("  quick_check    :", qc.slice(0, 300));
  console.log(`  lookup '${probeValue}' via index:`, JSON.stringify(viaIndex), "| via scan:", JSON.stringify(viaScan));
  console.log("  count via index:", cntIdx, "| count via scan:", cntScan);
  db.close();
}

// (a) count divergence: insert a row while the index is hidden -> index is one entry short.
const Pa = build("/root/umbradb-sqlite-research/.pa", (db) => {
  db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run(9999, "val_ORPHAN");
});
report("(a) COUNT divergence — extra table row, no index entry", Pa, "val_ORPHAN");

// (b) content divergence: UPDATE an existing row's value while the index is hidden.
// Entry count is unchanged; the index key for rowid 250 is stale.
const Pb = build("/root/umbradb-sqlite-research/.pb", (db) => {
  db.prepare("UPDATE t SET v = ? WHERE id = ?").run("val_MOVED", 250);
});
report("(b) CONTENT divergence — same entry count, stale index key", Pb, "val_MOVED");
report("(b) same file, probing the STALE key", Pb, "val_00250");
