// E1: What does PRAGMA integrity_check actually detect on a modern SQLite?
// Establishes the detection surface: table leaf vs index page vs WITHOUT ROWID vs CHECK vs STRICT.
import { DatabaseSync } from "node:sqlite";
import { openSync, readSync, writeSync, closeSync, statSync } from "node:fs";
import { rmSync } from "node:fs";

const DIR = "/root/corruption-lab";

function fresh(path) {
  for (const s of ["", "-wal", "-shm"]) { try { rmSync(path + s); } catch {} }
  return new DatabaseSync(path);
}

// Overwrite `len` bytes at absolute file offset `off` with a deterministic pattern.
function smash(path, off, len, byte = 0x5a) {
  const fd = openSync(path, "r+");
  const buf = Buffer.alloc(len, byte);
  writeSync(fd, buf, 0, len, off);
  closeSync(fd);
}

// Find the absolute file offset of the first occurrence of `needle` in the main db file.
function findBytes(path, needle) {
  const fd = openSync(path, "r");
  const size = statSync(path).size;
  const buf = Buffer.alloc(size);
  readSync(fd, buf, 0, size, 0);
  closeSync(fd);
  return { off: buf.indexOf(Buffer.from(needle)), size };
}

function checks(path) {
  const db = new DatabaseSync(path);
  const out = {};
  try { out.integrity = JSON.stringify(db.prepare("PRAGMA integrity_check").all()); }
  catch (e) { out.integrity = "THREW: " + e.code + " " + e.message; }
  try { out.quick = JSON.stringify(db.prepare("PRAGMA quick_check").all()); }
  catch (e) { out.quick = "THREW: " + e.code + " " + e.message; }
  db.close();
  return out;
}

function report(label, path, readback) {
  const c = checks(path);
  console.log(`  integrity_check : ${c.integrity}`);
  console.log(`  quick_check     : ${c.quick}`);
  if (readback) {
    const db = new DatabaseSync(path);
    try { console.log(`  read-back       : ${readback(db)}`); }
    catch (e) { console.log(`  read-back       : THREW ${e.code ?? ""} ${e.message}`); }
    db.close();
  }
}

console.log("sqlite", new DatabaseSync(":memory:").prepare("select sqlite_version() v").get().v);
console.log("");

// ---------------------------------------------------------------- A: rowid table leaf payload
{
  const p = `${DIR}/a-rowid-leaf.db`;
  const db = fresh(p);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, payload TEXT NOT NULL) STRICT");
  const ins = db.prepare("INSERT INTO t VALUES (?,?)");
  for (let i = 1; i <= 500; i++) ins.run(i, `PAYLOAD_${String(i).padStart(6, "0")}_zzzzzzzzzzzzzzzz`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const { off, size } = findBytes(p, "PAYLOAD_000400_");
  console.log(`A. rowid-table LEAF payload  (offset ${off} of ${size})`);
  smash(p, off + 15, 16, 0x58); // clobber the tail of row 400's payload only
  report("A", p, (db) => JSON.stringify(db.prepare("SELECT payload FROM t WHERE id=400").get()));
  console.log("");
}

// ---------------------------------------------------------------- B: secondary index key
{
  const p = `${DIR}/b-index-key.db`;
  const db = fresh(p);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, tag TEXT NOT NULL) STRICT");
  db.exec("CREATE INDEX t_tag ON t (tag)");
  const ins = db.prepare("INSERT INTO t VALUES (?,?)");
  for (let i = 1; i <= 500; i++) ins.run(i, `TAG_${String(i).padStart(6, "0")}_qqqqqqqqqqqqqqqq`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  // The LAST occurrence of the marker is in the index b-tree (index is created after the table
  // pages, so it lives later in the file); the first is the table leaf.
  const fd = openSync(p, "r"); const size = statSync(p).size;
  const buf = Buffer.alloc(size); readSync(fd, buf, 0, size, 0); closeSync(fd);
  const first = buf.indexOf(Buffer.from("TAG_000400_"));
  const last = buf.lastIndexOf(Buffer.from("TAG_000400_"));
  console.log(`B. secondary INDEX key       (table copy @${first}, index copy @${last}, size ${size})`);
  if (first === last) { console.log("  ! only one copy found; skipping"); }
  else {
    smash(p, last + 4, 6, 0x39); // change the digits inside the index copy only
    report("B", p, (db) => JSON.stringify({
      byIndex: db.prepare("SELECT id FROM t WHERE tag = 'TAG_000400_qqqqqqqqqqqqqqqq'").get() ?? null,
      byScan: db.prepare("SELECT id FROM t WHERE +tag = 'TAG_000400_qqqqqqqqqqqqqqqq'").get() ?? null,
    }));
  }
  console.log("");
}

// ---------------------------------------------------------------- C: WITHOUT ROWID PK payload
{
  const p = `${DIR}/c-wor-leaf.db`;
  const db = fresh(p);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE t (k TEXT NOT NULL PRIMARY KEY, v TEXT NOT NULL) STRICT, WITHOUT ROWID");
  const ins = db.prepare("INSERT INTO t VALUES (?,?)");
  for (let i = 1; i <= 500; i++) ins.run(`KEY_${String(i).padStart(6, "0")}`, `VAL_${String(i).padStart(6, "0")}_wwwwwwwwwwwwwwww`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const { off, size } = findBytes(p, "VAL_000400_");
  console.log(`C. WITHOUT ROWID leaf value  (offset ${off} of ${size})`);
  smash(p, off + 11, 16, 0x57);
  report("C", p, (db) => JSON.stringify(db.prepare("SELECT v FROM t WHERE k='KEY_000400'").get()));
  console.log("");
}

// ---------------------------------------------------------------- D: WITHOUT ROWID PK *key*
{
  const p = `${DIR}/d-wor-key.db`;
  const db = fresh(p);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE t (k TEXT NOT NULL PRIMARY KEY, v TEXT NOT NULL) STRICT, WITHOUT ROWID");
  const ins = db.prepare("INSERT INTO t VALUES (?,?)");
  for (let i = 1; i <= 500; i++) ins.run(`KEY_${String(i).padStart(6, "0")}`, `VAL_${String(i).padStart(6, "0")}`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const { off, size } = findBytes(p, "KEY_000400");
  console.log(`D. WITHOUT ROWID PRIMARY KEY (offset ${off} of ${size})`);
  smash(p, off + 4, 6, 0x37); // KEY_000400 -> KEY_777777, breaks b-tree ordering
  report("D", p, (db) => JSON.stringify({
    seek400: db.prepare("SELECT k,v FROM t WHERE k='KEY_000400'").get() ?? null,
    count: db.prepare("SELECT count(*) c FROM t").get(),
    ordered: db.prepare("SELECT count(*) c FROM (SELECT k, lag(k) OVER (ORDER BY rowid) p FROM t) WHERE p IS NOT NULL AND k < p").get(),
  }));
  console.log("");
}

// ---------------------------------------------------------------- E: CHECK constraint violation
{
  const p = `${DIR}/e-check.db`;
  const db = fresh(p);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE t (
     id INTEGER PRIMARY KEY,
     lifecycle TEXT NOT NULL CONSTRAINT t_lifecycle_enum CHECK (lifecycle IN ('pending','finalized','rejected')),
     h BLOB NOT NULL CONSTRAINT t_h_len CHECK (octet_length(h) = 32)
   ) STRICT`);
  const ins = db.prepare("INSERT INTO t VALUES (?,?,?)");
  for (let i = 1; i <= 300; i++) ins.run(i, "finalized", Buffer.alloc(32, i & 0xff));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const fd = openSync(p, "r"); const size = statSync(p).size;
  const buf = Buffer.alloc(size); readSync(fd, buf, 0, size, 0); closeSync(fd);
  const off = buf.indexOf(Buffer.from("finalized"));
  console.log(`E. CHECK-violating value     (offset ${off} of ${size})`);
  smash(p, off, 9, 0x71); // 'finalized' -> 'qqqqqqqqq', violates the enum CHECK
  report("E", p, (db) => JSON.stringify(db.prepare("SELECT id,lifecycle FROM t WHERE lifecycle NOT IN ('pending','finalized','rejected')").all()));
  console.log("");
}

// ---------------------------------------------------------------- F: STRICT type violation
{
  const p = `${DIR}/f-strict.db`;
  const db = fresh(p);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER NOT NULL) STRICT");
  const ins = db.prepare("INSERT INTO t VALUES (?,?)");
  for (let i = 1; i <= 300; i++) ins.run(i, 1000000 + i);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  // Corrupt a serial-type byte in a record header so an INTEGER column decodes as TEXT.
  // Locate the record for n = 1000200 (0x0F4304) and smash the header region just before it.
  const fd = openSync(p, "r"); const size = statSync(p).size;
  const buf = Buffer.alloc(size); readSync(fd, buf, 0, size, 0); closeSync(fd);
  console.log(`F. record-header serial type (size ${size}) -- blind smash of 8 bytes at 0.6*size`);
  smash(p, Math.floor(size * 0.6), 8, 0x1b);
  report("F", p, (db) => JSON.stringify({
    typecheck: db.prepare("SELECT count(*) c FROM t WHERE typeof(n) <> 'integer'").get(),
    sum: db.prepare("SELECT count(*) c, sum(n) s FROM t").get(),
  }));
  console.log("");
}
