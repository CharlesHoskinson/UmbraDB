// Conformance-lane prototypes. Run: node /root/umbradb-sqlite-research/scratch-conformance/probe.mjs
// All file-backed work happens under /root (ext4), never /tmp (tmpfs on this host).
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { rmSync, mkdirSync } from "node:fs";
const require = createRequire("/tmp/l3-bs3b/");
const Database = require("better-sqlite3");

const DIR = "/root/umbradb-sqlite-research/scratch-conformance/dbs";
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
`;

const digest = (ns, scope, key, version, value) =>
  createHash("sha256")
    .update(Buffer.from([1]))
    .update(Buffer.from(`${ns.length}:${ns}|${scope.length}:${scope}|${key.length}:${key}|${version}|`))
    .update(Buffer.from(value, "utf8"))
    .digest();

function seed(db, n, base = 1000) {
  const ins = db.prepare("INSERT INTO kv_event (ns,scope,key,version,written_at,value,dg) VALUES (?,?,?,?,?,?,?)");
  for (let v = 1; v <= n; v++) {
    const val = JSON.stringify({ v });
    ins.run("ns", "sc", "k", v, base + v * 1000, val, digest("ns", "sc", "k", v, val));
  }
}

const results = {};

// ---------------------------------------------------------------- A: stale-index planting
{
  const path = `${DIR}/stale-index.sqlite`;
  const db = new Database(path);
  db.pragma("journal_mode = wal");
  db.exec(SCHEMA);
  seed(db, 5); // versions 1..5 at written_at 2000,3000,4000,5000,6000

  // Plant: hide the time index from the schema, mutate the table, unhide.
  // The b-tree pages of the hidden index are never maintained, so its copy of the key
  // columns diverges from the table while every table row (and its digest) stays valid.
  db.unsafeMode(true); // better-sqlite3 sets SQLITE_DBCONFIG_DEFENSIVE=1 by default
  db.pragma("writable_schema = ON");
  const idxRow = db.prepare("SELECT sql, rootpage FROM sqlite_schema WHERE name = 'kv_event_time'").get();
  db.prepare("DELETE FROM sqlite_schema WHERE name = 'kv_event_time'").run();
  db.close();

  const db2 = new Database(path);
  db2.unsafeMode(true);
  db2.pragma("writable_schema = ON"); // required to write a db whose schema was hand-edited
  // Rewrite version 3's timestamp: 4000 -> 9000. Table row is internally valid and its digest
  // (which does not cover written_at, per change 5's coverage set) still verifies.
  db2.prepare("UPDATE kv_event SET written_at = 9000 WHERE version = 3").run();
  db2.prepare("INSERT INTO sqlite_schema (type,name,tbl_name,rootpage,sql) VALUES ('index','kv_event_time','kv_event',?,?)").run(idxRow.rootpage, idxRow.sql);
  db2.close();

  // Re-open: restore the index's schema row pointing at its original root page.
  // Simpler, equivalent planting: drop the schema row, mutate, then re-point.
  const db3 = new Database(path);
  let planted = false, byIndex = null, byScan = null, digestsOk = null, integrity = null;
  try {
    integrity = db3.pragma("integrity_check", { simple: true });
    byIndex = db3.prepare("SELECT version, written_at FROM kv_event INDEXED BY kv_event_time WHERE ns='ns' AND scope='sc' AND key='k' AND written_at <= 5000 ORDER BY written_at DESC LIMIT 1").get();
    byScan = db3.prepare("SELECT version, written_at FROM kv_event NOT INDEXED WHERE ns='ns' AND scope='sc' AND key='k' AND written_at <= 5000 ORDER BY written_at DESC LIMIT 1").get();
    const rows = db3.prepare("SELECT ns,scope,key,version,value,dg FROM kv_event NOT INDEXED").all();
    digestsOk = rows.every((r) => digest(r.ns, r.scope, r.key, r.version, r.value).equals(r.dg));
    planted = true;
  } catch (e) {
    results.A_error = String(e);
  }
  results.A = { planted, integrity, byIndex, byScan, digestsOk };
  db3.close();
}

// ------------------------------------------- A2: simpler planting — index over the wrong expression
{
  const path = `${DIR}/wrong-index.sqlite`;
  const db = new Database(path);
  db.exec(SCHEMA);
  seed(db, 5);
  db.unsafeMode(true);
  db.pragma("writable_schema = ON");
  // Swap the declared index SQL without rebuilding the b-tree: the planner now believes the
  // index is ordered by (ns,scope,key,version) while its pages are ordered by written_at.
  db.prepare("UPDATE sqlite_schema SET sql = ? WHERE name = 'kv_event_time'")
    .run("CREATE UNIQUE INDEX kv_event_time ON kv_event (ns, scope, key, version)");
  db.close();
  const db2 = new Database(path);
  let out = {};
  try {
    out.integrity = db2.pragma("integrity_check", { simple: true });
    out.byIndex = db2.prepare("SELECT version, written_at FROM kv_event INDEXED BY kv_event_time WHERE ns='ns' AND scope='sc' AND key='k' AND version = 3").get();
    out.byScan = db2.prepare("SELECT version, written_at FROM kv_event NOT INDEXED WHERE ns='ns' AND scope='sc' AND key='k' AND version = 3").get();
  } catch (e) { out.error = String(e); }
  results.A2 = out;
  db2.close();
}

// ---------------------------------------------------------------- B: fixture cost
{
  const t0 = process.hrtime.bigint();
  const N = 200;
  for (let i = 0; i < N; i++) {
    const d = new Database(":memory:");
    d.exec(SCHEMA);
    d.close();
  }
  const memNs = Number(process.hrtime.bigint() - t0) / N / 1e6;

  const t1 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    const p = `${DIR}/fx-${i}.sqlite`;
    const d = new Database(p);
    d.pragma("journal_mode = wal");
    d.pragma("synchronous = FULL");
    d.exec(SCHEMA);
    d.close();
  }
  const fileMs = Number(process.hrtime.bigint() - t1) / N / 1e6;
  results.B = { perFreshInMemoryDbMs: +memNs.toFixed(4), perFreshFileDbMs_ext4_wal_full: +fileMs.toFixed(4), n: N };
}

// ---------------------------------------------------------------- C: gap-bearing conversion
{
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  // Source (Postgres-shaped): kv_history [1000,2000) v1, live row from 3000 (v2).
  // Converted event log: events at written_at 1000 and 3000.
  db.prepare("INSERT INTO kv_event VALUES ('ns','sc','k',1,1000,'{\"v\":1}',NULL)").run();
  db.prepare("INSERT INTO kv_event VALUES ('ns','sc','k',2,3000,'{\"v\":2}',NULL)").run();
  const derived = db.prepare(`
    SELECT version, written_at AS valid_from,
           lead(written_at) OVER (PARTITION BY ns,scope,key ORDER BY version) AS valid_to
    FROM kv_event WHERE key='k' ORDER BY version`).all();
  const at2500 = db.prepare("SELECT version FROM kv_event WHERE key='k' AND written_at <= 2500 ORDER BY written_at DESC LIMIT 1").get();
  // Source answer at 2500 is null: 2500 is in neither [1000,2000) nor [3000,inf).
  results.C = { derivedIntervals: derived, convertedGetAt2500: at2500, sourceGetAt2500: null };
}

// ---------------------------------------------------------------- D: pragma / trigger interactions
{
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE t (v INTEGER CHECK (v > 0));`);
  db.exec(`CREATE TABLE e (version INTEGER, prev INTEGER);`);
  db.exec(`CREATE TRIGGER e_ver BEFORE INSERT ON e
           BEGIN SELECT RAISE(ABORT,'umbradb:version-chain') WHERE NEW.version <> coalesce((SELECT max(version) FROM e),0) + 1; END;`);
  db.pragma("ignore_check_constraints = ON");
  let checkBypassed = false, triggerFired = false, triggerMsg = null;
  try { db.prepare("INSERT INTO t VALUES (-1)").run(); checkBypassed = true; } catch { checkBypassed = false; }
  db.prepare("INSERT INTO e VALUES (1, NULL)").run();
  try { db.prepare("INSERT INTO e VALUES (3, NULL)").run(); } catch (err) { triggerFired = true; triggerMsg = err.message; }
  // Zero-row vacuity: the same trigger against an EMPTY table
  const db2 = new Database(":memory:");
  db2.exec(`CREATE TABLE e (version INTEGER, written_at INTEGER);`);
  db2.exec(`CREATE TRIGGER e_clk BEFORE INSERT ON e
            BEGIN SELECT RAISE(ABORT,'umbradb:clock') WHERE NEW.written_at <= (SELECT written_at FROM e WHERE version = NEW.version - 1); END;`);
  let vacuous = false;
  try { db2.prepare("INSERT INTO e VALUES (7, 1)").run(); vacuous = true; } catch { vacuous = false; }
  results.D = { checkConstraintBypassed: checkBypassed, triggerStillFired: triggerFired, triggerMsg, clockTriggerVacuousOnMissingPredecessor: vacuous };
}

// ---------------------------------------------------------------- E: RAISE(ROLLBACK) vs ABORT
{
  const db = new Database(`${DIR}/abort.sqlite`);
  db.exec(`CREATE TABLE e (v INTEGER);
           CREATE TRIGGER g BEFORE INSERT ON e BEGIN SELECT RAISE(ROLLBACK,'boom') WHERE NEW.v = 99; END;`);
  let out = {};
  db.prepare("BEGIN IMMEDIATE").run();
  db.prepare("INSERT INTO e VALUES (1)").run();
  try { db.prepare("INSERT INTO e VALUES (99)").run(); } catch (e) { out.raised = e.message; }
  out.inTransactionAfterRollbackRaise = db.inTransaction;
  db.prepare("INSERT INTO e VALUES (2)").run(); // unaware follow-up write
  try { db.prepare("COMMIT").run(); out.commitOk = true; } catch (e) { out.commitError = e.message; }
  out.rows = db.prepare("SELECT v FROM e ORDER BY v").all().map((r) => r.v);
  results.E = out;
  db.close();
}

console.log(JSON.stringify(results, null, 2));
