// Conformance-lane prototypes, round 2. All file I/O under /root (ext4), never /tmp (tmpfs).
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { rmSync, mkdirSync, copyFileSync, readFileSync, statSync } from "node:fs";
const require = createRequire("/tmp/l3-bs3b/");
const Database = require("better-sqlite3");

const DIR = "/root/umbradb-sqlite-research/scratch-conformance/dbs2";
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

const SCHEMA = `
CREATE TABLE kv_event (
  ns TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
  version INTEGER NOT NULL, written_at INTEGER NOT NULL,
  value TEXT NOT NULL, dg BLOB,
  PRIMARY KEY (ns, scope, key, version)
) WITHOUT ROWID;
CREATE UNIQUE INDEX kv_event_time ON kv_event (ns, scope, key, written_at);
CREATE TABLE watermarks (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, dg BLOB, PRIMARY KEY (kind, key));
CREATE TABLE ckpt_chunks (hash BLOB PRIMARY KEY, data BLOB NOT NULL);
CREATE TABLE ckpt_manifests (wallet TEXT, network TEXT, seq INTEGER, PRIMARY KEY (wallet, network, seq));
`;
const digest = (ns, scope, key, version, value) =>
  createHash("sha256").update(Buffer.from([1]))
    .update(Buffer.from(`${ns.length}:${ns}|${scope.length}:${scope}|${key.length}:${key}|${version}|`))
    .update(Buffer.from(value, "utf8")).digest();

function seed(db, n) {
  const ins = db.prepare("INSERT INTO kv_event (ns,scope,key,version,written_at,value,dg) VALUES (?,?,?,?,?,?,?)");
  for (let v = 1; v <= n; v++) {
    const val = JSON.stringify({ v });
    ins.run("ns", "sc", "k", v, 1000 + v * 1000, val, digest("ns", "sc", "k", v, val));
  }
}
const R = {};

// ---- A: stale-index divergence at a query the damage actually changes -----------------------
{
  const path = `${DIR}/stale.sqlite`;
  const db = new Database(path);
  db.exec(SCHEMA); seed(db, 5);           // v1..v5 at written_at 2000..6000
  db.unsafeMode(true); db.pragma("writable_schema = ON");
  const idx = db.prepare("SELECT sql, rootpage FROM sqlite_schema WHERE name='kv_event_time'").get();
  db.prepare("DELETE FROM sqlite_schema WHERE name='kv_event_time'").run();
  db.close();
  const d2 = new Database(path); d2.unsafeMode(true); d2.pragma("writable_schema = ON");
  d2.prepare("UPDATE kv_event SET written_at = 9000 WHERE version = 3").run(); // true v3 is now 9000
  d2.prepare("INSERT INTO sqlite_schema (type,name,tbl_name,rootpage,sql) VALUES ('index','kv_event_time','kv_event',?,?)").run(idx.rootpage, idx.sql);
  d2.close();

  const d3 = new Database(path);
  const T = 4500;
  const viaTimeIndex = d3.prepare(`SELECT version, written_at FROM kv_event INDEXED BY kv_event_time
     WHERE ns='ns' AND scope='sc' AND key='k' AND written_at <= ${T} ORDER BY written_at DESC LIMIT 1`).get();
  const viaScan = d3.prepare(`SELECT version, written_at FROM kv_event NOT INDEXED
     WHERE ns='ns' AND scope='sc' AND key='k' AND written_at <= ${T} ORDER BY written_at DESC LIMIT 1`).get();
  // The I-3 cross-path re-read: fetch the candidate by PRIMARY KEY and check both halves.
  const reread = viaTimeIndex ? d3.prepare(`SELECT written_at FROM kv_event NOT INDEXED
     WHERE ns='ns' AND scope='sc' AND key='k' AND version = ?`).get(viaTimeIndex.version) : null;
  const succ = viaTimeIndex ? d3.prepare(`SELECT written_at FROM kv_event NOT INDEXED
     WHERE ns='ns' AND scope='sc' AND key='k' AND version = ?`).get(viaTimeIndex.version + 1) : null;
  const rows = d3.prepare("SELECT ns,scope,key,version,value,dg FROM kv_event NOT INDEXED").all();
  R.A = {
    T,
    answerViaTimeIndex: viaTimeIndex,
    truthViaTableScan: viaScan,
    crossPathReread: reread,
    boundHalfPasses: reread ? reread.written_at <= T : null,
    successorHalfPasses: succ ? succ.written_at > T : true,
    everyValueDigestVerifies: rows.every((r) => digest(r.ns, r.scope, r.key, r.version, r.value).equals(r.dg)),
    integrityCheck: d3.pragma("integrity_check", { simple: true }),
  };
  d3.close();
}

// ---- B: fixture cost, four mechanisms -------------------------------------------------------
{
  const N = 100;
  const time = (fn) => { const t = process.hrtime.bigint(); for (let i = 0; i < N; i++) fn(i); return +(Number(process.hrtime.bigint() - t) / N / 1e6).toFixed(4); };

  const memMs = time(() => { const d = new Database(":memory:"); d.exec(SCHEMA); d.close(); });
  const fileFullMs = time((i) => { const d = new Database(`${DIR}/a-${i}.db`); d.pragma("journal_mode=wal"); d.pragma("synchronous=FULL"); d.exec(SCHEMA); d.close(); });
  const fileNormalMs = time((i) => { const d = new Database(`${DIR}/b-${i}.db`); d.pragma("journal_mode=wal"); d.pragma("synchronous=NORMAL"); d.exec(SCHEMA); d.close(); });

  // template: build once, then copy the file per test
  const tmpl = `${DIR}/template.db`;
  { const d = new Database(tmpl); d.pragma("journal_mode=delete"); d.exec(SCHEMA); d.close(); }
  const copyMs = time((i) => { copyFileSync(tmpl, `${DIR}/c-${i}.db`); const d = new Database(`${DIR}/c-${i}.db`); d.pragma("journal_mode=wal"); d.pragma("synchronous=FULL"); d.close(); });

  // template: serialize once, deserialize into memory per test
  let ser = null;
  { const d = new Database(":memory:"); d.exec(SCHEMA); ser = d.serialize(); d.close(); }
  const deserMs = time(() => { const d = new Database(ser); d.close(); });

  R.B = {
    conditions: "ext4 (/root, /dev/sdd), better-sqlite3@13.0.2, sqlite " + new Database(":memory:").prepare("select sqlite_version() v").get().v + ", node " + process.version + ", schema = 4 tables + 1 index, n=" + N,
    freshInMemoryMs: memMs,
    freshFileWalFullMs: fileFullMs,
    freshFileWalNormalMs: fileNormalMs,
    copyTemplateThenOpenWalFullMs: copyMs,
    deserializeTemplateInMemoryMs: deserMs,
    templateBytes: statSync(tmpl).size,
  };
}

// ---- C: does the P5 loop shape pass vacuously? ----------------------------------------------
{
  // Reproduce the existing P5 assertion shape against a 1-interval history.
  const intervals = [{ valid_from: 1000, valid_to: 2000 }];
  let assertions = 0;
  for (let i = 0; i < intervals.length - 1; i++) assertions++;
  R.C = { intervalsGeneratedForN2Puts: 1, assertionsExecuted: assertions, vacuous: assertions === 0 };
}

// ---- D: cancellation-guard hoisting needs a join --------------------------------------------
{
  const db = new Database(":memory:");
  db.exec("CREATE TABLE a (i INTEGER PRIMARY KEY, k INTEGER); CREATE TABLE b (i INTEGER PRIMARY KEY, k INTEGER);");
  const ia = db.prepare("INSERT INTO a VALUES (?,?)"), ib = db.prepare("INSERT INTO b VALUES (?,?)");
  db.transaction(() => { for (let i = 0; i < 3000; i++) { ia.run(i, i % 100); ib.run(i, i % 100); } })();
  let calls = 0;
  db.function("guard", { deterministic: false }, (_x) => { calls += 1; return 1; });
  const rows = db.prepare("SELECT count(*) c FROM a JOIN b ON a.k = b.k WHERE guard(a.i) = 1").get();
  R.D = { joinedRows: rows.c, guardInvocations: calls, hoisted: calls < rows.c };
}

console.log(JSON.stringify(R, null, 2));
