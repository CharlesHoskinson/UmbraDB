// R-3 adjudication re-tests on the ruled binding better-sqlite3@13.0.2
// Run from /root/r3-adjudicate (ext4, not tmpfs).
const fs = require("fs");
const path = require("path");
const Database = require("/tmp/l3-bs3b/node_modules/better-sqlite3");

const dir = "/root/r3-adjudicate";
const log = (...a) => console.log(...a);

function fresh(name) {
  const p = path.join(dir, name);
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(p + s); } catch {} }
  return p;
}
function findAll(buf, needle) {
  const out = []; let i = 0;
  while ((i = buf.indexOf(needle, i)) !== -1) { out.push(i); i += 1; }
  return out;
}

log("driver: better-sqlite3", require("/tmp/l3-bs3b/node_modules/better-sqlite3/package.json").version,
    "/ SQLite", new Database(":memory:").prepare("select sqlite_version() v").get().v);

// ---------- T1: payload corruption in checkpointed main DB ----------
{
  log("\n=== T1: payload byte corruption -> integrity_check/quick_check/read-back ===");
  const p = fresh("t1.db");
  let db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, payload TEXT NOT NULL) STRICT");
  const ins = db.prepare("INSERT INTO t (id, payload) VALUES (?, ?)");
  const tx = db.transaction(() => {
    for (let i = 1; i <= 500; i++) ins.run(i, `PAYLOAD_${String(i).padStart(6, "0")}_` + "X".repeat(24));
  });
  tx();
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  const buf = fs.readFileSync(p);
  const marker = Buffer.from("PAYLOAD_000400_");
  const off = buf.indexOf(marker);
  log("file size", buf.length, "; corrupting 22 bytes at payload offset", off + 8);
  for (let i = 0; i < 22; i++) buf[off + 8 + i] ^= 0xa5;
  fs.writeFileSync(p, buf);
  db = new Database(p);
  log("integrity_check :", JSON.stringify(db.pragma("integrity_check")));
  log("quick_check     :", JSON.stringify(db.pragma("quick_check")));
  const row = db.prepare("SELECT payload FROM t WHERE id = 400").get();
  log("read-back id=400:", JSON.stringify(row.payload.slice(0, 40)));
  log("RETURNED-AS-DATA:", row.payload.startsWith("PAYLOAD_000400_") ? "no (unexpected)" : "YES - corrupted bytes returned, no error");
  db.close();
}

// ---------- T2: index-copy corruption -> quick_check blind, integrity_check reports ----------
{
  log("\n=== T2: secondary-index divergence -> quick_check vs integrity_check ===");
  const p = fresh("t2.db");
  let db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, tag TEXT NOT NULL) STRICT; CREATE INDEX t_tag ON t(tag)");
  const ins = db.prepare("INSERT INTO t (id, tag) VALUES (?, ?)");
  const tx = db.transaction(() => {
    for (let i = 1; i <= 500; i++) ins.run(i, `TAGVAL_${String(i).padStart(6, "0")}`);
  });
  tx();
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  const buf = fs.readFileSync(p);
  const sites = findAll(buf, Buffer.from("TAGVAL_000400"));
  log("sites of TAGVAL_000400:", JSON.stringify(sites), "(expect 2: table copy + index copy)");
  const idxCopy = sites[sites.length - 1]; // later offset = index b-tree in this layout
  buf[idxCopy + 7] = 0x58; // TAGVAL_X00400
  fs.writeFileSync(p, buf);
  const db2 = new Database(p);
  log("integrity_check :", JSON.stringify(db2.pragma("integrity_check")));
  log("quick_check     :", JSON.stringify(db2.pragma("quick_check")));
  const byIndex = db2.prepare("SELECT id FROM t INDEXED BY t_tag WHERE tag = 'TAGVAL_000400'").get();
  const byScan = db2.prepare("SELECT id FROM t NOT INDEXED WHERE tag = 'TAGVAL_000400'").get();
  log("byIndex:", JSON.stringify(byIndex ?? null), " byScan:", JSON.stringify(byScan ?? null));
  db2.close();
}

// ---------- T3: cksumvfs absence on the ruled binding ----------
{
  log("\n=== T3: checksum VFS availability in better-sqlite3@13.0.2 ===");
  const db = new Database(":memory:");
  const opts = db.pragma("compile_options").map(r => r.compile_options);
  log("compile_options containing CKSUM:", JSON.stringify(opts.filter(o => /CKSUM/i.test(o))));
  log("pragma checksum_verification ->", JSON.stringify(db.pragma("checksum_verification")));
  let setErr = null;
  try { db.pragma("checksum_verification = 1"); } catch (e) { setErr = e.message; }
  log("set checksum_verification=1 ->", setErr ? "ERROR: " + setErr : "silently accepted (no-op)");
  db.close();
}

// ---------- T4: bare digest vs framed (domain-separated) digest under row substitution ----------
{
  log("\n=== T4: row substitution -- bare sha256(value) vs framed preimage ===");
  const crypto = require("crypto");
  const p = fresh("t4.db");
  const db = new Database(p);
  db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, dg_bare BLOB, dg_framed BLOB) WITHOUT ROWID, STRICT");
  const sha = (b) => crypto.createHash("sha256").update(b).digest();
  const frame = (table, col, pk, val) => {
    const parts = [Buffer.from([0x01])];
    for (const f of [table, col, pk, val]) {
      const b = Buffer.from(f, "utf8");
      const len = Buffer.alloc(4); len.writeUInt32BE(b.length);
      parts.push(len, b);
    }
    return sha(Buffer.concat(parts));
  };
  const val = '{"balance":0,"utxos":[]}'; // identical value in two rows
  const ins = db.prepare("INSERT INTO kv (k, v, dg_bare, dg_framed) VALUES (?, ?, ?, ?)");
  ins.run("alice", val, sha(Buffer.from(val)), frame("kv", "v", "alice", val));
  ins.run("mallory", val, sha(Buffer.from(val)), frame("kv", "v", "mallory", val));
  // substitute: overwrite alice's (v, dg) pair with mallory's -- simulates page-level row swap
  const m = db.prepare("SELECT v, dg_bare, dg_framed FROM kv WHERE k='mallory'").get();
  db.prepare("UPDATE kv SET v=?, dg_bare=?, dg_framed=? WHERE k='alice'").run(m.v, m.dg_bare, m.dg_framed);
  const a = db.prepare("SELECT v, dg_bare, dg_framed FROM kv WHERE k='alice'").get();
  const bareOk = Buffer.compare(sha(Buffer.from(a.v)), a.dg_bare) === 0;
  const framedOk = Buffer.compare(frame("kv", "v", "alice", a.v), a.dg_framed) === 0;
  log("bare digest verifies after substitution?  ", bareOk ? "YES -- substitution UNDETECTED" : "no");
  log("framed digest verifies after substitution?", framedOk ? "YES (bad)" : "NO -- substitution DETECTED");
  db.close();
}

// ---------- T5: BEFORE UPDATE trigger guard (no UDF) ----------
{
  log("\n=== T5: dg-not-recomputed trigger guard ===");
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, dg BLOB) WITHOUT ROWID, STRICT;
    CREATE TRIGGER kv_dg_guard BEFORE UPDATE OF v ON kv
    WHEN NEW.dg IS OLD.dg
    BEGIN SELECT RAISE(ABORT, 'digest not recomputed for updated value'); END;`);
  db.prepare("INSERT INTO kv VALUES ('a','v1',x'01')").run();
  let r1 = "ACCEPTED";
  try { db.prepare("UPDATE kv SET v='v2' WHERE k='a'").run(); } catch (e) { r1 = "REJECTED -> " + e.message; }
  let r2 = "ACCEPTED";
  try { db.prepare("UPDATE kv SET v='v2', dg=x'02' WHERE k='a'").run(); } catch (e) { r2 = "REJECTED -> " + e.message; }
  log("UPDATE v without new dg:", r1);
  log("UPDATE v with new dg   :", r2);
  db.close();
}
