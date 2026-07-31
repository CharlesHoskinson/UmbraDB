// v3: (i) raw fsync latency on ext4, (ii) noise floor for the per-commit case,
// (iii) storage delta including a small-row (watermark/kv) shape and a tight-fit shape.
import { DatabaseSync } from "node:sqlite";
import { hash as oneShot, randomBytes } from "node:crypto";
import { openSync, fsyncSync, writeSync, closeSync, unlinkSync, existsSync, statSync } from "node:fs";

const DIR = "/root/udb-r3-bench";
const rm = (p) => { for (const s of ["", "-wal", "-shm"]) if (existsSync(p + s)) unlinkSync(p + s); };
const sha = (b) => oneShot("sha256", b, "buffer");
const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "n/a");
const stats = (a) => { const s = [...a].sort((x, y) => x - y);
  return { min: s[0], p25: s[(s.length * 0.25) | 0], med: s[(s.length * 0.5) | 0], p75: s[(s.length * 0.75) | 0], p99: s[(s.length * 0.99) | 0], max: s[s.length - 1] }; };

// ---- (i) raw fsync on ext4
{
  const p = `${DIR}/fsync.probe`;
  const fd = openSync(p, "w");
  const buf = Buffer.alloc(4096, 7);
  const lat = [];
  for (let i = 0; i < 300; i++) {
    writeSync(fd, buf, 0, buf.length, i * 4096);
    const t0 = process.hrtime.bigint(); fsyncSync(fd);
    lat.push(Number(process.hrtime.bigint() - t0) / 1e3);
  }
  closeSync(fd); unlinkSync(p);
  const s = stats(lat);
  console.log(`## i. Raw fsync() latency, ext4 (/dev/sdd), 4 KB write, 300 samples (us)`);
  console.log(`   min=${fmt(s.min)}  p25=${fmt(s.p25)}  median=${fmt(s.med)}  p75=${fmt(s.p75)}  p99=${fmt(s.p99)}  max=${fmt(s.max)}`);
  console.log(`   => ONE fsync = ${fmt(s.med)} us. SHA-256 of a 5893 B p50 blob = 3.49 us  ->  ratio 1 : ${fmt(s.med / 3.49, 0)}`);
}

// ---- (ii) per-commit distributions: no-digest vs sha256, same run, many commits
function commitLatencies({ sync, size, rows, digest }) {
  const path = `${DIR}/wp3.db`; rm(path);
  const d = new DatabaseSync(path);
  d.exec("pragma page_size=16384"); d.exec("pragma journal_mode=wal"); d.exec(`pragma synchronous=${sync}`);
  d.exec(digest
    ? "CREATE TABLE t (k INTEGER PRIMARY KEY, data BLOB NOT NULL, dg BLOB NOT NULL) STRICT"
    : "CREATE TABLE t (k INTEGER PRIMARY KEY, data BLOB NOT NULL) STRICT");
  const ins = digest ? d.prepare("insert into t(k,data,dg) values(?,?,?)") : d.prepare("insert into t(k,data) values(?,?)");
  const pl = []; for (let i = 0; i < 32; i++) pl.push(randomBytes(size));
  const lat = [];
  for (let i = 0; i < rows; i++) {
    const p = pl[i & 31];
    const t0 = process.hrtime.bigint();
    d.exec("BEGIN IMMEDIATE");
    if (digest) ins.run(i, p, sha(p)); else ins.run(i, p);
    d.exec("COMMIT");
    lat.push(Number(process.hrtime.bigint() - t0) / 1e3);
  }
  d.close(); rm(path);
  return stats(lat);
}
console.log("\n## ii. Per-commit latency DISTRIBUTION (us), 1 row / txn, 1200 commits, page_size=16384");
console.log("| sync | size | digest | min | p25 | median | p75 | p99 |");
console.log("|---|---|---|---:|---:|---:|---:|---:|");
for (const sync of ["FULL", "NORMAL"]) {
  for (const [lbl, size] of [["2 KB jsonb", 2048], ["5893 B p50", 5893], ["29158 B p99", 29158]]) {
    for (const digest of [false, true]) {
      const s = commitLatencies({ sync, size, rows: 1200, digest });
      console.log(`| ${sync} | ${lbl} | ${digest ? "sha256" : "none"} | ${fmt(s.min)} | ${fmt(s.p25)} | ${fmt(s.med)} | ${fmt(s.p75)} | ${fmt(s.p99)} |`);
    }
  }
}

// ---- (iii) storage delta, incl. small rows and a tight-fit row
function storage({ size, rows, pageSize }) {
  const out = {};
  for (const digest of [false, true]) {
    const path = `${DIR}/wp3s.db`; rm(path);
    const d = new DatabaseSync(path);
    d.exec(`pragma page_size=${pageSize}`); d.exec("pragma journal_mode=wal"); d.exec("pragma synchronous=NORMAL");
    d.exec(digest
      ? "CREATE TABLE t (k INTEGER PRIMARY KEY, data BLOB NOT NULL, dg BLOB NOT NULL) STRICT"
      : "CREATE TABLE t (k INTEGER PRIMARY KEY, data BLOB NOT NULL) STRICT");
    const ins = digest ? d.prepare("insert into t(k,data,dg) values(?,?,?)") : d.prepare("insert into t(k,data) values(?,?)");
    d.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < rows; i++) { const p = randomBytes(size); if (digest) ins.run(i, p, sha(p)); else ins.run(i, p); }
    d.exec("COMMIT");
    d.exec("pragma wal_checkpoint(TRUNCATE)"); d.exec("VACUUM");
    out[digest ? "dg" : "no"] = statSync(path).size;
    d.close(); rm(path);
  }
  return out;
}
console.log("\n## iii. Storage delta of a 32-byte BLOB digest column (VACUUMed main db)");
console.log("| row value size | page_size | rows | no-digest bytes | +digest bytes | delta | % | delta/row |");
console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
for (const [lbl, size, rows, ps] of [
  ["64 B (watermark jsonb)", 64, 40000, 4096],
  ["256 B (small kv)", 256, 40000, 4096],
  ["2 KB jsonb", 2048, 20000, 4096],
  ["2 KB jsonb", 2048, 20000, 16384],
  ["1020 B (tight fit @4K)", 1020, 40000, 4096],
  ["5893 B p50", 5893, 12000, 16384],
  ["29158 B p99", 29158, 4000, 16384],
]) {
  const s = storage({ size, rows, pageSize: ps });
  const d = s.dg - s.no;
  console.log(`| ${lbl} | ${ps} | ${rows} | ${s.no} | ${s.dg} | ${d} | ${fmt((d / s.no) * 100)}% | ${fmt(d / rows, 1)} |`);
}
