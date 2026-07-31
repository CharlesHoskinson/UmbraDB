// R-3 Q3 + Q5: whole-database verification pass and the backfill, on a realistically
// sized chain-archive-shaped database. ext4, WAL, page_size=16384.
import { DatabaseSync } from "node:sqlite";
import { hash as oneShot, randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";
import { unlinkSync, existsSync, statSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const DIR = "/root/udb-r3-bench";
const P = `${DIR}/archive.db`;
const rm = (p) => { for (const s of ["", "-wal", "-shm"]) if (existsSync(p + s)) unlinkSync(p + s); };
const sha = (b) => oneShot("sha256", b, "buffer");
const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "n/a");
const NROWS = Number(process.env.NROWS ?? 300000);
const dropCaches = () => { try { writeFileSync("/proc/sys/vm/drop_caches", "3"); execSync("sync"); return true; } catch { return false; } };

// Log-normal-ish sampler matching L5's measured [min,p50,p90,p99,max]=[41,5893,11987,29158,145167]
function sampleSize() {
  const u = Math.random();
  if (u < 0.02) return 41 + ((Math.random() * 500) | 0);
  if (u < 0.50) return 200 + ((Math.random() * 5700) | 0);
  if (u < 0.90) return 5893 + ((Math.random() * 6094) | 0);
  if (u < 0.99) return 11987 + ((Math.random() * 17171) | 0);
  return 29158 + ((Math.random() * 116009) | 0);
}

console.log(`fs=ext4 (/dev/sdd, /), journal_mode=wal, page_size=16384, node ${process.version}`);
console.log(`Building chain_blobs-shaped table, ${NROWS.toLocaleString("en-US")} rows, L5 size distribution...`);

// ---------------- build: hash IS the primary key (today's content-addressed shape)
rm(P);
{
  const d = new DatabaseSync(P);
  d.exec("pragma page_size=16384"); d.exec("pragma journal_mode=wal"); d.exec("pragma synchronous=NORMAL");
  d.exec("CREATE TABLE chain_blobs (hash BLOB PRIMARY KEY, data BLOB NOT NULL) STRICT");
  const ins = d.prepare("insert or ignore into chain_blobs(hash,data) values(?,?)");
  const t0 = process.hrtime.bigint();
  let bytes = 0;
  for (let b = 0; b < NROWS; b += 5000) {
    d.exec("BEGIN IMMEDIATE");
    for (let i = b; i < Math.min(b + 5000, NROWS); i++) {
      const p = randomBytes(sampleSize()); bytes += p.length; ins.run(sha(p), p);
    }
    d.exec("COMMIT");
  }
  d.exec("pragma wal_checkpoint(TRUNCATE)");
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  built in ${fmt(ms / 1000)} s; logical blob bytes = ${(bytes / 1e9).toFixed(2)} GB; db file = ${(statSync(P).size / 1e9).toFixed(2)} GB`);
  d.close();
}
const DBBYTES = statSync(P).size;

// ---------------- 1. whole-database verification pass (rehash every blob vs its PK)
function verifyPass({ cold, algo }) {
  if (cold) dropCaches();
  const d = new DatabaseSync(P);
  d.exec("pragma journal_mode=wal"); d.exec("pragma synchronous=NORMAL");
  const it = d.prepare("select hash, data from chain_blobs").iterate();
  const t0 = process.hrtime.bigint();
  let n = 0, bad = 0, bytes = 0;
  for (const r of it) {
    n++; bytes += r.data.length;
    if (algo === "sha256") { if (!sha(r.data).equals(r.hash)) bad++; }
    else if (algo === "crc32") { crc32(r.data); }
    else { /* scan only */ }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  d.close();
  return { ms, n, bad, bytes, rowsPerSec: (n / ms) * 1000, mbps: bytes / 1e6 / (ms / 1000) };
}
console.log("\n## 1. Whole-database verification pass (full table scan + rehash)");
console.log("| cache | work | rows | wall s | rows/s | MB/s | mismatches |");
console.log("|---|---|---:|---:|---:|---:|---:|");
for (const cold of [true, false]) {
  for (const algo of ["scan", "crc32", "sha256"]) {
    const r = verifyPass({ cold, algo });
    console.log(`| ${cold ? "cold (drop_caches)" : "warm"} | ${algo} | ${r.n} | ${fmt(r.ms / 1000)} | ${Math.round(r.rowsPerSec)} | ${fmt(r.mbps, 0)} | ${r.bad} |`);
  }
}
console.log(`  (drop_caches available: ${dropCaches()})`);

// ---------------- 2. verification concurrent with a writer (single-writer topology)
console.log("\n## 2. Verification pass CONCURRENT with a writer (WAL, same process, 2 connections)");
{
  const reader = new DatabaseSync(P, { readOnly: true });
  const writer = new DatabaseSync(P);
  writer.exec("pragma journal_mode=wal"); writer.exec("pragma synchronous=NORMAL"); writer.exec("pragma busy_timeout=5000");
  const ins = writer.prepare("insert or ignore into chain_blobs(hash,data) values(?,?)");
  let writes = 0, writeErr = null, stop = false;
  const t0 = process.hrtime.bigint();
  // Interleave: verify a slice of rows, write a batch, repeat -- proves the writer is not blocked.
  const it = reader.prepare("select hash, data from chain_blobs").iterate();
  let n = 0;
  for (const r of it) {
    n++; sha(r.data);
    if (n % 20000 === 0) {
      try {
        writer.exec("BEGIN IMMEDIATE");
        for (let i = 0; i < 200; i++) { const p = randomBytes(2048); ins.run(sha(p), p); writes++; }
        writer.exec("COMMIT");
      } catch (e) { writeErr = e.message; try { writer.exec("ROLLBACK"); } catch {} stop = true; break; }
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  verified ${n} rows in ${fmt(ms / 1000)} s while committing ${writes} new rows in ${Math.floor(n / 20000)} write txns`);
  console.log(`  writer error: ${writeErr ?? "none -- reader never blocked the writer"}`);
  reader.close(); writer.close();
}

// ---------------- 3. backfill: add a digest column to a populated table
console.log("\n## 3. Backfill a digest column onto the populated table");
{
  const d = new DatabaseSync(P);
  d.exec("pragma journal_mode=wal"); d.exec("pragma synchronous=NORMAL");
  // 3a. the STORED generated-column route
  try { d.exec("ALTER TABLE chain_blobs ADD COLUMN dgs BLOB GENERATED ALWAYS AS (length(data)) STORED"); console.log("  3a ADD COLUMN ... STORED on populated table: ACCEPTED"); }
  catch (e) { console.log(`  3a ADD COLUMN ... STORED on populated table: REJECTED -> ${e.message}`); }
  // 3b. plain nullable ADD COLUMN (metadata-only?)
  let t0 = process.hrtime.bigint();
  d.exec("ALTER TABLE chain_blobs ADD COLUMN dg BLOB");
  console.log(`  3b ALTER TABLE ADD COLUMN dg BLOB (nullable): ${fmt(Number(process.hrtime.bigint() - t0) / 1e6)} ms  <- metadata-only`);
  // 3c. batched resumable UPDATE, measuring per-batch write-lock hold time
  const sel = d.prepare("select hash, data from chain_blobs where dg is null order by hash limit ?");
  const upd = d.prepare("update chain_blobs set dg = ? where hash = ?");
  const remaining = () => d.prepare("select count(*) c from chain_blobs where dg is null").get().c;
  const BATCH = 2000;
  const holds = [];
  t0 = process.hrtime.bigint();
  let done = 0;
  for (;;) {
    const rows = sel.all(BATCH);
    if (rows.length === 0) break;
    const digests = rows.map((r) => sha(r.data));          // hash OUTSIDE the write txn
    const l0 = process.hrtime.bigint();
    d.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < rows.length; i++) upd.run(digests[i], rows[i].hash);
    d.exec("COMMIT");
    holds.push(Number(process.hrtime.bigint() - l0) / 1e6);
    done += rows.length;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const hs = [...holds].sort((a, b) => a - b);
  console.log(`  3c batched backfill: ${done} rows, BATCH=${BATCH}, total ${fmt(ms / 1000)} s, ${Math.round((done / ms) * 1000)} rows/s`);
  console.log(`     write-lock hold per batch (ms): min=${fmt(hs[0])} median=${fmt(hs[hs.length >> 1])} p99=${fmt(hs[(hs.length * 0.99) | 0])} max=${fmt(hs[hs.length - 1])}`);
  console.log(`     resumable: 'where dg is null' remaining after run = ${remaining()}`);
  d.exec("pragma wal_checkpoint(TRUNCATE)");
  const after = statSync(P).size;
  console.log(`     db size before=${(DBBYTES / 1e9).toFixed(3)} GB  after=${(after / 1e9).toFixed(3)} GB  delta=${((after - DBBYTES) / 1e6).toFixed(1)} MB (${fmt(((after - DBBYTES) / DBBYTES) * 100)}%)`);
  t0 = process.hrtime.bigint();
  d.exec("VACUUM");
  console.log(`     VACUUM after backfill: ${fmt(Number(process.hrtime.bigint() - t0) / 1e6 / 1000)} s -> ${(statSync(P).size / 1e9).toFixed(3)} GB`);
  d.close();
}

// ---------------- 4. integrity_check / quick_check cost on the same DB for comparison
console.log("\n## 4. SQLite's own PRAGMA checks on the same database, for cost comparison");
{
  const d = new DatabaseSync(P);
  for (const pragma of ["quick_check", "integrity_check"]) {
    dropCaches();
    const t0 = process.hrtime.bigint();
    const r = d.prepare(`pragma ${pragma}`).all();
    console.log(`  ${pragma}: ${fmt(Number(process.hrtime.bigint() - t0) / 1e6 / 1000)} s -> ${JSON.stringify(r).slice(0, 80)}`);
  }
  d.close();
}
console.log(`\nfinal db: ${(statSync(P).size / 1e9).toFixed(3)} GB`);
