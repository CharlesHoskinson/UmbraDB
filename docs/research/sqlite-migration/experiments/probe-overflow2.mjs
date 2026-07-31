// Probe 2: dbstat-driven, deterministic overflow-page injection, and the file-offset vs
// value-offset mapping (overflow pages carry a 4-byte next-page pointer).
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("/tmp/l3-bs3b/");
const Database = require("better-sqlite3");

const DIR = "/root/umbradb-sqlite-research/.probe2";
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const P = `${DIR}/t.db`;
const PS = 4096;

const db = new Database(P);
db.pragma(`page_size = ${PS}`);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL");
db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v BLOB NOT NULL) STRICT");
db.exec("CREATE TABLE small (id INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT");
const ins = db.prepare("INSERT INTO t (id, v) VALUES (?, ?)");
for (let i = 1; i <= 20; i++) ins.run(i, Buffer.alloc(20000, 0x41));
const insS = db.prepare("INSERT INTO small (id, v) VALUES (?, ?)");
for (let i = 1; i <= 200; i++) insS.run(i, `INLINE_${i}`);
db.pragma("wal_checkpoint(TRUNCATE)");

// dbstat gives (name, path, pageno, pagetype). path encodes the b-tree position; for overflow
// pages of a row it is the leaf path plus "+NNNNN". Pick the row we want by its rowid via a
// two-step: read the leaf page holding rowid=7, then take the overflow chain that follows it.
const stat = db
  .prepare("select name, path, pageno, pagetype, payload from dbstat where name='t' order by pageno")
  .all();
const overflow = stat.filter((r) => r.pagetype === "overflow");
console.log("sqlite_version :", db.prepare("select sqlite_version() as v").get().v);
console.log("overflow pages :", overflow.length, "| sample path:", JSON.stringify(overflow[0].path));
console.log("leaf pages     :", stat.filter((r) => r.pagetype === "leaf").length);
db.close();

// Deterministic value-offset -> file-offset mapping for the FIRST overflow page of a row:
// SQLite stores the first ~ (usable - 35) bytes inline in the leaf cell, then the remainder in a
// chain of overflow pages, each of which begins with a 4-byte big-endian next-page pointer.
// So: byte k of overflow page N (k >= 4) lives at file offset (N-1)*PS + k.
const pageNo = overflow[3].pageno; // an arbitrary but deterministic overflow page
const fileOff = (pageNo - 1) * PS + 100; // 100 bytes in: well past the 4-byte next pointer
const buf = fs.readFileSync(P);
const before = buf.slice(fileOff, fileOff + 8).toString("hex");
buf.fill(0x5a, fileOff, fileOff + 64);
fs.writeFileSync(P, buf);
console.log(`injected 64B 0x5A at overflow page ${pageNo}, file offset ${fileOff} (was ${before})`);

const db2 = new Database(P);
console.log("integrity_check:", JSON.stringify(db2.pragma("integrity_check")));
console.log("quick_check    :", JSON.stringify(db2.pragma("quick_check")));
let hits = 0,
  rows = 0,
  threw = null;
try {
  for (const r of db2.prepare("select id, v from t").iterate()) {
    rows++;
    if (r.v.includes(Buffer.alloc(8, 0x5a))) hits++;
  }
} catch (e) {
  threw = `${e.code ?? e.name}: ${e.message}`;
}
console.log("full scan      :", rows, "rows,", hits, "rows containing injected 0x5A bytes, threw:", threw);

// --- Contrast: structural (b-tree) corruption on the SAME file shape ---------------------------
db2.close();
const DIR3 = "/root/umbradb-sqlite-research/.probe3";
fs.rmSync(DIR3, { recursive: true, force: true });
fs.mkdirSync(DIR3, { recursive: true });
const P3 = `${DIR3}/t.db`;
const d3 = new Database(P3);
d3.pragma(`page_size = ${PS}`);
d3.pragma("journal_mode = WAL");
d3.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT");
d3.exec("CREATE INDEX ix ON t (v)");
const i3 = d3.prepare("INSERT INTO t (id, v) VALUES (?, ?)");
for (let i = 1; i <= 2000; i++) i3.run(i, `row_${String(i).padStart(6, "0")}`);
d3.pragma("wal_checkpoint(TRUNCATE)");
const s3 = d3.prepare("select pageno, pagetype, path, name from dbstat order by pageno").all();
const leaf = s3.find((r) => r.pagetype === "leaf" && r.name === "t" && r.pageno > 2);
d3.close();
const b3 = fs.readFileSync(P3);
// Corrupt the leaf page HEADER (cell count / cell content offset), which is b-tree structure.
const hOff = (leaf.pageno - 1) * PS;
b3.writeUInt16BE(0xfff0, hOff + 3); // absurd cell count
fs.writeFileSync(P3, b3);
const d3b = new Database(P3);
console.log("\n[structural] page", leaf.pageno, "header cell-count clobbered");
console.log("[structural] integrity_check:", JSON.stringify(d3b.pragma("integrity_check")).slice(0, 300));
console.log("[structural] quick_check    :", JSON.stringify(d3b.pragma("quick_check")).slice(0, 300));
try {
  const n = d3b.prepare("select count(*) as c from t").get();
  console.log("[structural] count(*)       : RETURNED", n.c);
} catch (e) {
  console.log("[structural] count(*)       : THREW", e.code ?? e.name, "-", e.message);
}
d3b.close();
