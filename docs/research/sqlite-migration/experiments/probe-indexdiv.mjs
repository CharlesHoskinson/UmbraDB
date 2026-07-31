// Probe 3: index-vs-table divergence — does integrity_check fire where quick_check returns ok,
// on the ruled binding? This is the discriminator the plan must assert on by name.
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("/tmp/l3-bs3b/");
const Database = require("better-sqlite3");

const DIR = "/root/umbradb-sqlite-research/.probe4";
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const P = `${DIR}/t.db`;

let db = new Database(P);
db.pragma("journal_mode = DELETE"); // keep it single-file for simplicity
db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
db.exec("CREATE INDEX ix ON t (v)");
const ins = db.prepare("INSERT INTO t (id, v) VALUES (?, ?)");
for (let i = 1; i <= 500; i++) ins.run(i, `val_${String(i).padStart(5, "0")}`);
const ixRow = db.prepare("select type,name,tbl_name,rootpage,sql from sqlite_schema where name='ix'").get();
console.log("ix schema row  :", JSON.stringify(ixRow));
db.close();

// Hide the index from the schema, insert a row (so no index entry is written), restore the index.
db = new Database(P);
db.unsafeMode(true);
db.exec("PRAGMA writable_schema = ON");
db.exec("DELETE FROM sqlite_schema WHERE name = 'ix'");
db.close();

db = new Database(P);
db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run(9999, "val_ORPHAN");
db.close();

db = new Database(P);
db.unsafeMode(true);
db.exec("PRAGMA writable_schema = ON");
db.exec(
  `INSERT INTO sqlite_schema (type,name,tbl_name,rootpage,sql) VALUES ('${ixRow.type}','${ixRow.name}','${ixRow.tbl_name}',${ixRow.rootpage},'${ixRow.sql}')`,
);
db.close();

db = new Database(P);
const ic = db.pragma("integrity_check");
const qc = db.pragma("quick_check");
console.log("integrity_check:", JSON.stringify(ic).slice(0, 400));
console.log("quick_check    :", JSON.stringify(qc).slice(0, 400));

// The observable consequence: indexed lookup misses a row a table scan finds.
const viaIndex = db.prepare("select id from t indexed by ix where v = 'val_ORPHAN'").all();
const viaScan = db.prepare("select id from t where +v = 'val_ORPHAN'").all();
console.log("via index      :", JSON.stringify(viaIndex));
console.log("via table scan :", JSON.stringify(viaScan));

// And what a per-row digest sweep would say about the same fault: the row is intact.
const row = db.prepare("select id, v from t where +v = 'val_ORPHAN'").get();
console.log("row bytes intact (a digest over them would verify clean):", JSON.stringify(row));
db.close();
