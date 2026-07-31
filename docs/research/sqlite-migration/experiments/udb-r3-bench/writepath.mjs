// R-3 Q2: digest cost as a FRACTION of the surrounding SQLite write path.
// Filesystem: ext4 (/dev/sdd on /). journal_mode=wal. page_size stated per run.
import { DatabaseSync } from "node:sqlite";
import { hash as oneShot, randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";
import { unlinkSync, existsSync, statSync } from "node:fs";

const DIR = "/root/udb-r3-bench";
const rm = (p) => { for (const s of ["", "-wal", "-shm"]) if (existsSync(p + s)) unlinkSync(p + s); };
const sha = (b) => oneShot("sha256", b, "buffer");

function open(path, { sync, pageSize }) {
  rm(path);
  const d = new DatabaseSync(path);
  d.exec(`pragma page_size=${pageSize}`);
  d.exec("pragma journal_mode=wal");
  d.exec(`pragma synchronous=${sync}`);
  return d;
}

// ---------------------------------------------------------------- A: per-commit
// One row per transaction -- the saveAndAdvance / watermark-tick shape.
function perCommit({ sync, pageSize, size, rows, mode }) {
  const path = `${DIR}/wp.db`;
  const d = open(path, { sync, pageSize });
  if (mode === "nodigest") {
    d.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, data BLOB NOT NULL) STRICT");
  } else {
    d.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, data BLOB NOT NULL, dg BLOB NOT NULL) STRICT");
  }
  const insN = mode === "nodigest" ? d.prepare("insert into t(k,data) values(?,?)") : null;
  const insD = mode === "nodigest" ? null : d.prepare("insert into t(k,data,dg) values(?,?,?)");
  const payloads = [];
  for (let i = 0; i < 32; i++) payloads.push(randomBytes(size));
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < rows; i++) {
    const p = payloads[i & 31];
    d.exec("BEGIN IMMEDIATE");
    if (mode === "nodigest") insN.run(i, p);
    else if (mode === "sha256") insD.run(i, p, sha(p));
    else if (mode === "crc32") insD.run(i, p, Buffer.from(new Uint32Array([crc32(p)]).buffer));
    d.exec("COMMIT");
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const bytes = statSync(path).size;
  d.close(); rm(path);
  return { usPerCommit: (ms * 1000) / rows, commitsPerSec: (rows / ms) * 1000, dbBytes: bytes };
}

// ---------------------------------------------------------------- B: bulk (amortized fsync)
function bulk({ sync, pageSize, size, rows, mode }) {
  const path = `${DIR}/wp.db`;
  const d = open(path, { sync, pageSize });
  d.exec(mode === "nodigest"
    ? "CREATE TABLE t (k INTEGER PRIMARY KEY, data BLOB NOT NULL) STRICT"
    : "CREATE TABLE t (k INTEGER PRIMARY KEY, data BLOB NOT NULL, dg BLOB NOT NULL) STRICT");
  const insN = mode === "nodigest" ? d.prepare("insert into t(k,data) values(?,?)") : null;
  const insD = mode === "nodigest" ? null : d.prepare("insert into t(k,data,dg) values(?,?,?)");
  const payloads = [];
  for (let i = 0; i < 32; i++) payloads.push(randomBytes(size));
  const t0 = process.hrtime.bigint();
  d.exec("BEGIN IMMEDIATE");
  for (let i = 0; i < rows; i++) {
    const p = payloads[i & 31];
    if (mode === "nodigest") insN.run(i, p);
    else if (mode === "sha256") insD.run(i, p, sha(p));
    else if (mode === "crc32") insD.run(i, p, Buffer.from(new Uint32Array([crc32(p)]).buffer));
  }
  d.exec("COMMIT");
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const bytes = statSync(path).size;
  d.close(); rm(path);
  return { usPerRow: (ms * 1000) / rows, rowsPerSec: (rows / ms) * 1000, dbBytes: bytes, ms };
}

// ---------------------------------------------------------------- C: read path
function readPath({ pageSize, size, rows }) {
  const path = `${DIR}/wp.db`;
  const d = open(path, { sync: "NORMAL", pageSize });
  d.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, data BLOB NOT NULL, dg BLOB NOT NULL) STRICT");
  const ins = d.prepare("insert into t(k,data,dg) values(?,?,?)");
  d.exec("BEGIN IMMEDIATE");
  for (let i = 0; i < rows; i++) { const p = randomBytes(size); ins.run(i, p, sha(p)); }
  d.exec("COMMIT");
  d.exec("pragma wal_checkpoint(TRUNCATE)");
  const sel = d.prepare("select data, dg from t where k = ?");
  const out = {};
  for (const verify of [false, true]) {
    // warm cache identically
    for (let i = 0; i < rows; i++) sel.get(i);
    const t0 = process.hrtime.bigint();
    let acc = 0;
    for (let i = 0; i < rows; i++) {
      const r = sel.get(i);
      if (verify) { const a = sha(r.data); if (!a.equals(r.dg)) throw new Error("mismatch"); acc += a[0]; }
      else acc += r.data[0];
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    out[verify ? "verify" : "plain"] = { usPerRead: (ms * 1000) / rows, readsPerSec: (rows / ms) * 1000, acc };
  }
  d.close(); rm(path);
  return out;
}

const fmt = (n, d = 2) => n.toFixed(d);
console.log("host fs: ext4 (/dev/sdd, mounted /). journal_mode=wal. node", process.version);

console.log("\n## A. Per-commit (1 row per BEGIN IMMEDIATE..COMMIT), page_size=16384");
console.log("| synchronous | value size | mode | us/commit | commits/s | digest cost us | as % of commit |");
console.log("|---|---|---|---:|---:|---:|---:|");
for (const sync of ["FULL", "NORMAL"]) {
  for (const [lbl, size, rows] of [["2 KB jsonb", 2048, 1500], ["5893 B p50", 5893, 1500], ["29158 B p99", 29158, 800]]) {
    const base = perCommit({ sync, pageSize: 16384, size, rows, mode: "nodigest" });
    for (const mode of ["sha256", "crc32"]) {
      const r = perCommit({ sync, pageSize: 16384, size, rows, mode });
      const delta = r.usPerCommit - base.usPerCommit;
      console.log(`| ${sync} | ${lbl} | ${mode} | ${fmt(r.usPerCommit)} | ${Math.round(r.commitsPerSec)} | ${fmt(delta)} | ${fmt((delta / base.usPerCommit) * 100)}% |`);
    }
    console.log(`| ${sync} | ${lbl} | (no digest) | ${fmt(base.usPerCommit)} | ${Math.round(base.commitsPerSec)} | - | - |`);
  }
}

console.log("\n## B. Bulk insert, all rows in ONE transaction (fsync amortized to ~0), page_size=16384");
console.log("| synchronous | value size | mode | us/row | rows/s | digest cost us | as % of row | db bytes |");
console.log("|---|---|---|---:|---:|---:|---:|---:|");
for (const sync of ["FULL", "NORMAL"]) {
  for (const [lbl, size, rows] of [["2 KB jsonb", 2048, 20000], ["5893 B p50", 5893, 20000], ["29158 B p99", 29158, 6000]]) {
    const base = bulk({ sync, pageSize: 16384, size, rows, mode: "nodigest" });
    for (const mode of ["sha256", "crc32"]) {
      const r = bulk({ sync, pageSize: 16384, size, rows, mode });
      const delta = r.usPerRow - base.usPerRow;
      console.log(`| ${sync} | ${lbl} | ${mode} | ${fmt(r.usPerRow)} | ${Math.round(r.rowsPerSec)} | ${fmt(delta)} | ${fmt((delta / base.usPerRow) * 100)}% | ${r.dbBytes} |`);
    }
    console.log(`| ${sync} | ${lbl} | (no digest) | ${fmt(base.usPerRow)} | ${Math.round(base.rowsPerSec)} | - | - | ${base.dbBytes} |`);
  }
}

console.log("\n## C. Read path: point SELECT with and without verify-on-read (page_size=16384, warm)");
console.log("| value size | plain us/read | verify us/read | delta us | as % of read |");
console.log("|---|---:|---:|---:|---:|");
for (const [lbl, size, rows] of [["2 KB jsonb", 2048, 20000], ["5893 B p50", 5893, 20000], ["29158 B p99", 29158, 6000]]) {
  const r = readPath({ pageSize: 16384, size, rows });
  const delta = r.verify.usPerRead - r.plain.usPerRead;
  console.log(`| ${lbl} | ${fmt(r.plain.usPerRead)} | ${fmt(r.verify.usPerRead)} | ${fmt(delta)} | ${fmt((delta / r.plain.usPerRead) * 100)}% |`);
}
