// Probe: can we deterministically locate an overflow page for a given row on the ruled binding,
// so a corruption-injection fixture targets the payload-byte case rather than b-tree structure?
// Run: node /root/umbradb-sqlite-research/probe-overflow.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("/tmp/l3-bs3b/");
const Database = require("better-sqlite3");

const DIR = "/root/umbradb-sqlite-research/.probe";
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const P = `${DIR}/t.db`;

const db = new Database(P);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL");
db.pragma("page_size = 4096");
console.log("sqlite_version   :", db.prepare("select sqlite_version() as v").get().v);
console.log("page_size        :", db.pragma("page_size", { simple: true }));

// Does the pinned build have dbstat?
let hasDbstat = false;
try {
  db.prepare("select * from dbstat limit 0").all();
  hasDbstat = true;
} catch (e) {
  console.log("dbstat           : ABSENT —", e.message);
}
console.log("dbstat           :", hasDbstat ? "PRESENT" : "absent");

const opts = db.pragma("compile_options").map((r) => r.compile_options);
console.log("DBSTAT compile   :", opts.filter((o) => /DBSTAT|CKSUM/i.test(o)).join(",") || "(none)");

db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v BLOB NOT NULL) STRICT");
const ins = db.prepare("INSERT INTO t (id, v) VALUES (?, ?)");
// row 1: small (inline, no overflow). rows 2..N: large (forces overflow pages)
ins.run(1, Buffer.from("SMALL_INLINE_PAYLOAD"));
const big = (n) => {
  const b = Buffer.alloc(20000, 0x41);
  b.write(`BIGPAYLOAD_${String(n).padStart(6, "0")}_`, 0);
  return b;
};
for (let i = 2; i <= 40; i++) ins.run(i, big(i));
db.pragma("wal_checkpoint(TRUNCATE)");

if (hasDbstat) {
  const rows = db
    .prepare("select name, path, pageno, pagetype, payload from dbstat where name='t' order by pageno")
    .all();
  const byType = {};
  for (const r of rows) byType[r.pagetype] = (byType[r.pagetype] || 0) + 1;
  console.log("dbstat page mix  :", JSON.stringify(byType));
  const ov = rows.filter((r) => r.pagetype === "overflow");
  console.log("overflow pages   :", ov.length, "first pageno =", ov[0]?.pageno);
}

// Independent of dbstat: locate a known payload marker by byte search in the main file.
db.close();
const buf = fs.readFileSync(P);
const marker = Buffer.from("BIGPAYLOAD_000020_");
const off = buf.indexOf(marker);
console.log("marker offset    :", off, "-> page", Math.floor(off / 4096) + 1);

// Corrupt deep inside that payload (well past the marker, mid-page) and re-check.
const target = off + 4096; // ~1 page into the payload => guaranteed an overflow page, not the b-tree cell header
buf.fill(0x5a, target, target + 64);
fs.writeFileSync(P, buf);

const db2 = new Database(P);
console.log("integrity_check  :", JSON.stringify(db2.pragma("integrity_check")));
console.log("quick_check      :", JSON.stringify(db2.pragma("quick_check")));
let read;
try {
  const r = db2.prepare("select v from t where id = 20").get();
  read = `RETURNED ${r.v.length} bytes, corrupted-region byte = 0x${r.v[4096 - (off % 1) + 0]?.toString(16)}`;
  const stillA = r.v.slice(target - off, target - off + 8).toString("hex");
  read += ` | bytes at injection = ${stillA}`;
} catch (e) {
  read = `THREW ${e.code ?? e.name}: ${e.message}`;
}
console.log("read id=20       :", read);

// full scan
let scanned = 0,
  damaged = 0;
try {
  for (const r of db2.prepare("select id, v from t").iterate()) {
    scanned++;
    if (!r.v.includes(Buffer.from("AAAAAAAAAAAAAAAA"))) damaged++;
    else if (r.v.includes(Buffer.from("ZZZZZZZZ"))) damaged++;
  }
} catch (e) {
  console.log("scan threw       :", e.code ?? e.name, e.message);
}
console.log("full scan        :", scanned, "rows read,", damaged, "carrying injected bytes");
db2.close();
