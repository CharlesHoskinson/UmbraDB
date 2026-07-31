import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { openSync, readSync, writeSync, closeSync, statSync, rmSync } from "node:fs";
const DIR = "/root/corruption-lab";
const sha256 = (b) => createHash("sha256").update(b).digest();
function slurp(p) { const fd = openSync(p, "r"); const n = statSync(p).size; const b = Buffer.alloc(n); readSync(fd, b, 0, n, 0); closeSync(fd); return b; }
function poke(p, o, b) { const fd = openSync(p, "r+"); writeSync(fd, b, 0, b.length, o); closeSync(fd); }
function sites(p, needle) { const b = slurp(p); const out = []; let i = b.indexOf(needle); while (i >= 0) { out.push(i); i = b.indexOf(needle, i + 1); } return out; }
function ic(p) { try { const d = new DatabaseSync(p); const r = d.prepare("PRAGMA integrity_check").all().map(x => x.integrity_check); d.close(); return r.slice(0, 2).join("; ") + (r.length > 2 ? ` (+${r.length - 2})` : ""); } catch (e) { return `THREW ${e.code}`; } }

// Build once; each trial works on a copy.
const base = `${DIR}/dgbase.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(base + s); } catch {} }
{
  const db = new DatabaseSync(base);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE t (k TEXT NOT NULL PRIMARY KEY, v TEXT NOT NULL, digest BLOB NOT NULL) STRICT, WITHOUT ROWID");
  for (let i = 1; i <= 400; i++) {
    const v = JSON.stringify({ i, pad: "VALUEPAYLOAD_" + String(i).padStart(6, "0") + "_" + "p".repeat(30) });
    db.prepare("INSERT INTO t VALUES (?,?,?)").run(`k${String(i).padStart(4, "0")}`, v, sha256(Buffer.from(v)));
  }
  db.exec("VACUUM");                 // remove stale free-space copies so a hit is always a live cell
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}
const copy = (dst) => { const b = slurp(base); const fd = openSync(dst, "w"); writeSync(fd, b, 0, b.length, 0); closeSync(fd); };
function sweep(p) {
  let checked = 0, mism = 0, unread = 0, threw = null;
  try {
    const d = new DatabaseSync(p);
    for (const r of d.prepare("SELECT k,v,digest FROM t").all()) {
      checked++;
      try { if (!sha256(Buffer.from(r.v)).equals(Buffer.from(r.digest))) mism++; } catch { unread++; }
    }
    d.close();
  } catch (e) { threw = e.code; }
  return { checked, mism, unread, threw };
}
function readK200(p) { try { const d = new DatabaseSync(p); const r = d.prepare("SELECT v,hex(digest) h FROM t WHERE k='k0200'").get(); d.close(); return r; } catch (e) { return `THREW ${e.code}`; } }

const clean = readK200(base);
console.log(`baseline k0200 value tail : ...${clean.v.slice(-24)}`);
console.log(`baseline k0200 digest     : ${clean.h.slice(0, 16)}...`);
console.log(`baseline sweep            : ${JSON.stringify(sweep(base))}\n`);

const vsites = sites(base, Buffer.from("VALUEPAYLOAD_000200"));
console.log(`'VALUEPAYLOAD_000200' live sites after VACUUM: ${JSON.stringify(vsites)}\n`);

for (const [label, width] of [["value only, 4B", 4], ["value only, 16B", 16], ["value+digest smear, 64B", 64], ["value+digest smear, 200B", 200]]) {
  const p = `${DIR}/dg2-${width}.db`; copy(p);
  poke(p, vsites[0], Buffer.alloc(width, 0x5a));
  const rk = readK200(p);
  const sw = sweep(p);
  console.log(`[${label}] smashed ${width}B at ${vsites[0]}`);
  console.log(`   k0200 now      : ${typeof rk === "string" ? rk : "..." + rk.v.slice(-24) + "  digest " + rk.h.slice(0, 16) + "..."}`);
  console.log(`   digest sweep   : ${JSON.stringify(sw)}`);
  console.log(`   integrity_check: ${ic(p)}\n`);
}
