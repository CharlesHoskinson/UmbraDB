// Backfill v2: keyset-paginated (resumable) backfill + write-lock hold time vs batch size.
import { DatabaseSync } from "node:sqlite";
import { hash as oneShot, randomBytes } from "node:crypto";
import { unlinkSync, existsSync, statSync, copyFileSync } from "node:fs";

const DIR = "/root/udb-r3-bench";
const SRC = `${DIR}/archive.db`;          // built by verify-backfill.mjs (300k rows, ~2.97 GB)
const rm = (p) => { for (const s of ["", "-wal", "-shm"]) if (existsSync(p + s)) unlinkSync(p + s); };
const sha = (b) => oneShot("sha256", b, "buffer");
const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "n/a");
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, (s.length * p) | 0)]; };

console.log("fs=ext4 (/dev/sdd, /), journal_mode=wal, synchronous=NORMAL, page_size=16384");

function prep(batch) {
  const P = `${DIR}/bf.db`; rm(P);
  copyFileSync(SRC, P);
  const d = new DatabaseSync(P);
  d.exec("pragma journal_mode=wal"); d.exec("pragma synchronous=NORMAL");
  // reset: null out the digest column so every run backfills the same 300k rows
  d.exec("BEGIN IMMEDIATE"); d.exec("UPDATE chain_blobs SET dg = NULL"); d.exec("COMMIT");
  d.exec("pragma wal_checkpoint(TRUNCATE)");
  return { d, P, before: statSync(P).size };
}

console.log("\n## Keyset-paginated resumable backfill: `WHERE hash > :cursor ORDER BY hash LIMIT :n`");
console.log("| batch | rows | total s | rows/s | lock hold ms med | p99 | max | txns | db delta MB |");
console.log("|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const BATCH of [200, 1000, 5000]) {
  const { d, P, before } = prep(BATCH);
  const sel = d.prepare("select hash, data from chain_blobs where hash > ? order by hash limit ?");
  const sel0 = d.prepare("select hash, data from chain_blobs order by hash limit ?");
  const upd = d.prepare("update chain_blobs set dg = ? where hash = ?");
  const holds = [];
  let cursor = null, done = 0, txns = 0;
  const t0 = process.hrtime.bigint();
  for (;;) {
    const rows = cursor === null ? sel0.all(BATCH) : sel.all(cursor, BATCH);
    if (rows.length === 0) break;
    const dg = rows.map((r) => sha(r.data));               // hashing happens OUTSIDE the write txn
    const l0 = process.hrtime.bigint();
    d.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < rows.length; i++) upd.run(dg[i], rows[i].hash);
    d.exec("COMMIT");
    holds.push(Number(process.hrtime.bigint() - l0) / 1e6);
    txns++;
    cursor = rows[rows.length - 1].hash;
    done += rows.length;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  d.exec("pragma wal_checkpoint(TRUNCATE)");
  const after = statSync(P).size;
  const left = d.prepare("select count(*) c from chain_blobs where dg is null").get().c;
  console.log(`| ${BATCH} | ${done} | ${fmt(ms / 1000)} | ${Math.round((done / ms) * 1000)} | ${fmt(q(holds, 0.5))} | ${fmt(q(holds, 0.99))} | ${fmt(q(holds, 1))} | ${txns} | ${fmt((after - before) / 1e6, 1)} |`);
  if (left !== 0) console.log(`   !! ${left} rows left unbackfilled`);
  d.close(); rm(P);
}

console.log("\n## Resumability: kill mid-backfill, restart from the persisted cursor");
{
  const { d, P } = prep(1000);
  d.exec("CREATE TABLE IF NOT EXISTS backfill_progress (job TEXT PRIMARY KEY, cursor BLOB)");
  const sel = d.prepare("select hash, data from chain_blobs where hash > ? order by hash limit ?");
  const sel0 = d.prepare("select hash, data from chain_blobs order by hash limit ?");
  const upd = d.prepare("update chain_blobs set dg = ? where hash = ?");
  const setCur = d.prepare("insert into backfill_progress(job,cursor) values('dg',?) on conflict(job) do update set cursor=excluded.cursor");
  const getCur = d.prepare("select cursor from backfill_progress where job='dg'");
  const step = (n) => {                                   // n batches then "crash"
    let cur = getCur.get()?.cursor ?? null, done = 0;
    for (let b = 0; b < n; b++) {
      const rows = cur === null ? sel0.all(1000) : sel.all(cur, 1000);
      if (rows.length === 0) return { done, exhausted: true };
      const dg = rows.map((r) => sha(r.data));
      d.exec("BEGIN IMMEDIATE");
      for (let i = 0; i < rows.length; i++) upd.run(dg[i], rows[i].hash);
      cur = rows[rows.length - 1].hash;
      setCur.run(cur);                                    // cursor advances IN THE SAME TXN
      d.exec("COMMIT");
      done += rows.length;
    }
    return { done, exhausted: false };
  };
  const a = step(50);
  console.log(`  pass 1: ${a.done} rows, cursor persisted = ${getCur.get().cursor.toString("hex").slice(0, 16)}...`);
  console.log(`  nulls remaining: ${d.prepare("select count(*) c from chain_blobs where dg is null").get().c}`);
  let total = a.done;
  for (;;) { const r = step(1000); total += r.done; if (r.exhausted) break; }
  console.log(`  resumed to completion: ${total} rows total, nulls remaining = ${d.prepare("select count(*) c from chain_blobs where dg is null").get().c}`);
  console.log(`  cursor is committed in the SAME transaction as the digests -> exactly-once, no re-hash of committed rows`);
  d.close(); rm(P);
}

console.log("\n## Alternative: table rebuild (CREATE ... AS SELECT / DROP / RENAME) instead of ADD COLUMN + UPDATE");
{
  const P = `${DIR}/bf2.db`; rm(P); copyFileSync(SRC, P);
  const d = new DatabaseSync(P);
  d.exec("pragma journal_mode=wal"); d.exec("pragma synchronous=NORMAL");
  const before = statSync(P).size;
  d.function("udb_sha256", { deterministic: true }, sha);
  const t0 = process.hrtime.bigint();
  d.exec("BEGIN IMMEDIATE");
  d.exec("CREATE TABLE chain_blobs_new (hash BLOB PRIMARY KEY, data BLOB NOT NULL, dg BLOB NOT NULL) STRICT");
  d.exec("INSERT INTO chain_blobs_new(hash,data,dg) SELECT hash,data,udb_sha256(data) FROM chain_blobs");
  d.exec("DROP TABLE chain_blobs");
  d.exec("ALTER TABLE chain_blobs_new RENAME TO chain_blobs");
  d.exec("COMMIT");
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  d.exec("pragma wal_checkpoint(TRUNCATE)");
  console.log(`  single-transaction rebuild: ${fmt(ms / 1000)} s -- ONE write lock held for the ENTIRE duration`);
  console.log(`  peak db+wal bytes: db=${(statSync(P).size / 1e9).toFixed(3)} GB (was ${(before / 1e9).toFixed(3)} GB)`);
  console.log(`  => not resumable, and the lock hold is ${fmt(ms / 1000)} s vs ~0.1 s per batch for the paginated route`);
  d.close(); rm(P);
}
