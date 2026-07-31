// v2: medians over N reps, interleaved mode order, WAL checkpointed before sizing.
import { DatabaseSync } from "node:sqlite";
import { hash as oneShot, randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";
import { unlinkSync, existsSync, statSync } from "node:fs";

const DIR = "/root/udb-r3-bench";
const rm = (p) => { for (const s of ["", "-wal", "-shm"]) if (existsSync(p + s)) unlinkSync(p + s); };
const sha = (b) => oneShot("sha256", b, "buffer");
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[(s.length - 1) >> 1]; };
const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "n/a");
const MODES = ["nodigest", "sha256", "crc32"];

function run({ sync, pageSize, size, rows, mode, perCommit }) {
  const path = `${DIR}/wp2.db`;
  rm(path);
  const d = new DatabaseSync(path);
  d.exec(`pragma page_size=${pageSize}`);
  d.exec("pragma journal_mode=wal");
  d.exec(`pragma synchronous=${sync}`);
  d.exec(mode === "nodigest"
    ? "CREATE TABLE t (k INTEGER PRIMARY KEY, data BLOB NOT NULL) STRICT"
    : "CREATE TABLE t (k INTEGER PRIMARY KEY, data BLOB NOT NULL, dg BLOB NOT NULL) STRICT");
  const ins = mode === "nodigest"
    ? d.prepare("insert into t(k,data) values(?,?)")
    : d.prepare("insert into t(k,data,dg) values(?,?,?)");
  const payloads = []; for (let i = 0; i < 32; i++) payloads.push(randomBytes(size));
  const put = mode === "nodigest" ? (i, p) => ins.run(i, p)
    : mode === "sha256" ? (i, p) => ins.run(i, p, sha(p))
    : (i, p) => ins.run(i, p, Buffer.from(new Uint32Array([crc32(p)]).buffer));

  const t0 = process.hrtime.bigint();
  if (perCommit) {
    for (let i = 0; i < rows; i++) { d.exec("BEGIN IMMEDIATE"); put(i, payloads[i & 31]); d.exec("COMMIT"); }
  } else {
    d.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < rows; i++) put(i, payloads[i & 31]);
    d.exec("COMMIT");
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  d.exec("pragma wal_checkpoint(TRUNCATE)");
  const bytes = statSync(path).size;
  d.close(); rm(path);
  return { usPerRow: (ms * 1000) / rows, bytes };
}

function sweep({ sync, pageSize, size, rows, perCommit, reps }) {
  const acc = Object.fromEntries(MODES.map((m) => [m, { t: [], b: [] }]));
  for (let r = 0; r < reps; r++) for (const m of MODES) {         // interleaved
    const x = run({ sync, pageSize, size, rows, mode: m, perCommit });
    acc[m].t.push(x.usPerRow); acc[m].b.push(x.bytes);
  }
  return Object.fromEntries(MODES.map((m) => [m, { us: median(acc[m].t), bytes: median(acc[m].b), raw: acc[m].t.map((v) => +v.toFixed(1)) }]));
}

// hash-only cost, same call shape, for the analytic ratio
function hashOnly(size) {
  const b = randomBytes(size);
  for (let i = 0; i < 500; i++) sha(b);
  const n = 20000; const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) sha(b);
  return Number(process.hrtime.bigint() - t0) / 1e3 / n;   // us
}

const CASES = [["2 KB jsonb", 2048], ["5893 B p50", 5893], ["29158 B p99", 29158]];
console.log("fs=ext4 (/dev/sdd, /), journal_mode=wal, page_size=16384, node", process.version);
console.log("SHA-256 alone (us/op):", CASES.map(([l, s]) => `${l}=${fmt(hashOnly(s), 3)}`).join("  "));

for (const perCommit of [true, false]) {
  console.log(`\n## ${perCommit ? "A. Per-commit (1 row / BEGIN IMMEDIATE..COMMIT)" : "B. Bulk (all rows in ONE transaction)"} — median of 5 reps, interleaved`);
  console.log("| sync | size | rows | no-digest us | sha256 us | crc32 us | sha256 delta | sha256 as % | sha256 raw reps |");
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---|");
  for (const sync of ["FULL", "NORMAL"]) {
    for (const [lbl, size] of CASES) {
      const rows = perCommit ? (size > 20000 ? 500 : 900) : (size > 20000 ? 4000 : 12000);
      const s = sweep({ sync, pageSize: 16384, size, rows, perCommit, reps: 5 });
      const dl = s.sha256.us - s.nodigest.us;
      console.log(`| ${sync} | ${lbl} | ${rows} | ${fmt(s.nodigest.us)} | ${fmt(s.sha256.us)} | ${fmt(s.crc32.us)} | ${fmt(dl)} | ${fmt((dl / s.nodigest.us) * 100)}% | ${s.sha256.raw.join(", ")} |`);
    }
  }
}

console.log("\n## D. Storage cost of a 32-byte digest column (main db after wal_checkpoint(TRUNCATE))");
console.log("| size | rows | no-digest bytes | +sha256(32B) bytes | delta | % | delta/row |");
console.log("|---|---:|---:|---:|---:|---:|---:|");
for (const [lbl, size] of CASES) {
  const rows = size > 20000 ? 4000 : 12000;
  const s = sweep({ sync: "NORMAL", pageSize: 16384, size, rows, perCommit: false, reps: 1 });
  const d = s.sha256.bytes - s.nodigest.bytes;
  console.log(`| ${lbl} | ${rows} | ${s.nodigest.bytes} | ${s.sha256.bytes} | ${d} | ${fmt((d / s.nodigest.bytes) * 100)}% | ${fmt(d / rows, 1)} |`);
}
