// PILOT for B-1 (same-key collision rejection rate) and B-2 (commit throughput),
// on ext4, WAL, ruled binding (better-sqlite3), against the shipped-default pragmas.
// Purpose: confirm the experiment SHAPE works and the two `synchronous` values separate.
// This is a pilot, NOT the artifact.
import Database from "/tmp/l3-bs3b/node_modules/better-sqlite3/lib/index.js";
import { rmSync, mkdirSync } from "node:fs";

const DIR = "/root/measure-proto/dbs";
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

const N = Number(process.argv[2] ?? 5000);

function run(sync) {
  const path = `${DIR}/b1-${sync}.sqlite`;
  const db = new Database(path);
  // pragma order matters: page_size before wal (design §5.4)
  db.pragma("page_size = 4096");
  db.pragma("journal_mode = WAL");
  db.pragma(`synchronous = ${sync}`);
  // The clock-collision shape: one row per (key, valid_from_ms). A second put for the
  // same key inside the same millisecond violates the uniqueness and is rejected.
  db.exec(`CREATE TABLE kv_history (
      key TEXT NOT NULL, valid_from_ms INTEGER NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (key, valid_from_ms)) STRICT, WITHOUT ROWID;`);

  const put = db.prepare("INSERT INTO kv_history (key, valid_from_ms, value) VALUES (?, ?, ?)");
  let rejected = 0, accepted = 0;
  const commitMs = [];
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    const c0 = process.hrtime.bigint();
    try {
      put.run("same-key", Date.now(), `v${i}`); // each put is its own implicit transaction
      accepted++;
    } catch (e) {
      if (String(e.code).startsWith("SQLITE_CONSTRAINT")) rejected++;
      else throw e;
    }
    commitMs.push(Number(process.hrtime.bigint() - c0) / 1e6);
  }
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const sorted = [...commitMs].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  const info = {
    synchronous: db.pragma("synchronous", { simple: true }),
    journal_mode: db.pragma("journal_mode", { simple: true }),
    page_size: db.pragma("page_size", { simple: true }),
    auto_vacuum: db.pragma("auto_vacuum", { simple: true }),
    sqlite_version: db.prepare("select sqlite_version() v").get().v,
  };
  db.close();
  return {
    ...info, n: N, accepted, rejected,
    rejectionRatePct: +(100 * rejected / N).toFixed(3),
    commitsPerSec: +(1000 * N / totalMs).toFixed(1),
    latencyMs: { p50: +pct(50).toFixed(4), p95: +pct(95).toFixed(4), p99: +pct(99).toFixed(4), max: +sorted.at(-1).toFixed(4) },
  };
}

console.log(JSON.stringify({ note: "PILOT ONLY — not the measurement artifact", dir: DIR, results: [run(1), run(2)] }, null, 2));
