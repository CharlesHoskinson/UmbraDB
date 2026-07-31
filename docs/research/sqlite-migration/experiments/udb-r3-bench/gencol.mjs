// R-3 Q4: can the digest be a GENERATED ALWAYS AS (...) STORED column computed by SQLite?
import { DatabaseSync } from "node:sqlite";
import { hash as oneShot } from "node:crypto";
import { unlinkSync, existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";

const P = "/root/udb-r3-bench/gencol.db";
for (const s of ["", "-wal", "-shm"]) if (existsSync(P + s)) unlinkSync(P + s);

const say = (t) => console.log("\n### " + t);

say("1. Does node:sqlite expose a hash function to SQL? (builtins)");
{
  const d = new DatabaseSync(":memory:");
  for (const f of ["sha3", "sha1", "md5", "crc32", "sha256", "hash", "digest", "checksum"]) {
    try { d.prepare(`select ${f}(x'00')`).get(); console.log(`  PRESENT ${f}`); }
    catch (e) { console.log(`  absent  ${f}  -> ${e.message}`); }
  }
  d.close();
}

say("2. Register a deterministic UDF and try to use it in a STORED generated column");
{
  const d = new DatabaseSync(P);
  d.exec("pragma journal_mode=wal");
  d.function("udb_sha256", { deterministic: true }, (b) => oneShot("sha256", b, "buffer"));
  console.log("  UDF registered.");
  try {
    d.exec(`CREATE TABLE t (
      k INTEGER PRIMARY KEY,
      data BLOB NOT NULL,
      dg BLOB GENERATED ALWAYS AS (udb_sha256(data)) STORED
    ) STRICT`);
    console.log("  CREATE TABLE with UDF in STORED gencol: ACCEPTED");
  } catch (e) { console.log("  CREATE TABLE REJECTED -> " + e.message); }
  try {
    d.prepare("insert into t(k,data) values(?,?)").run(1, Buffer.from("hello"));
    const r = d.prepare("select hex(dg) h from t where k=1").get();
    console.log("  INSERT ok, dg=" + r.h);
    console.log("  expected =" + oneShot("sha256", Buffer.from("hello"), "buffer").toString("hex").toUpperCase());
  } catch (e) { console.log("  INSERT failed -> " + e.message); }
  d.close();
}

say("3. Reopen the SAME file WITHOUT registering the UDF (the portability test)");
{
  const d = new DatabaseSync(P);
  try { console.log("  select count(*) => " + d.prepare("select count(*) c from t").get().c); }
  catch (e) { console.log("  SELECT count failed -> " + e.message); }
  try { console.log("  select data      => ok, " + JSON.stringify(d.prepare("select k,length(data) n from t").all())); }
  catch (e) { console.log("  SELECT data failed -> " + e.message); }
  try { console.log("  select dg        => " + JSON.stringify(d.prepare("select hex(dg) h from t").all())); }
  catch (e) { console.log("  SELECT dg failed -> " + e.message); }
  try { d.prepare("insert into t(k,data) values(?,?)").run(2, Buffer.from("world")); console.log("  INSERT without UDF: ACCEPTED (!)"); }
  catch (e) { console.log("  INSERT without UDF REJECTED -> " + e.message); }
  try { d.exec("pragma integrity_check"); console.log("  integrity_check ran"); }
  catch (e) { console.log("  integrity_check failed -> " + e.message); }
  d.close();
}

say("4. Third-party tooling: the sqlite3 CLI / any non-Node reader");
try {
  console.log(execSync(`sqlite3 ${P} "select count(*) from t;" 2>&1 || true`).toString().trim());
} catch (e) { console.log("  sqlite3 CLI: " + (e.stdout ? e.stdout.toString().trim() : e.message)); }
try {
  console.log("  .dump ->", execSync(`sqlite3 ${P} ".dump t" 2>&1 || true`).toString().trim().split("\n").slice(0, 6).join(" | "));
} catch (e) { console.log("  .dump: " + (e.stdout ? e.stdout.toString().trim() : e.message)); }
try {
  console.log("  backup ->", execSync(`sqlite3 ${P} ".backup /root/udb-r3-bench/gencol-backup.db" 2>&1 || true`).toString().trim() || "(silent = ok)");
} catch (e) { console.log("  backup: " + (e.stdout ? e.stdout.toString().trim() : e.message)); }

say("5. VACUUM / schema-rebuild with the UDF absent");
try {
  console.log("  vacuum ->", execSync(`sqlite3 ${P} "vacuum;" 2>&1 || true`).toString().trim() || "(silent = ok)");
} catch (e) { console.log("  vacuum: " + (e.stdout ? e.stdout.toString().trim() : e.message)); }

say("6. directOnly / non-deterministic UDF in a gencol");
{
  const d = new DatabaseSync(":memory:");
  d.function("nd_hash", (b) => oneShot("sha256", b, "buffer"));           // default flags
  d.function("do_hash", { directOnly: true, deterministic: true }, (b) => oneShot("sha256", b, "buffer"));
  for (const [n, f] of [["nd_hash (no deterministic flag)", "nd_hash"], ["do_hash (directOnly)", "do_hash"]]) {
    try { d.exec(`CREATE TABLE g_${f} (a BLOB, d BLOB GENERATED ALWAYS AS (${f}(a)) STORED)`);
          d.prepare(`insert into g_${f}(a) values(?)`).run(Buffer.from("x"));
          console.log(`  ${n}: CREATE+INSERT ACCEPTED`); }
    catch (e) { console.log(`  ${n}: REJECTED -> ${e.message}`); }
  }
  d.close();
}

say("7. ADD COLUMN ... GENERATED ... STORED on empty vs non-empty (plan's claim)");
{
  const d = new DatabaseSync(":memory:");
  d.exec("CREATE TABLE e (a BLOB)");
  try { d.exec("ALTER TABLE e ADD COLUMN s INTEGER GENERATED ALWAYS AS (length(a)) STORED"); console.log("  empty table: ACCEPTED"); }
  catch (e) { console.log("  empty table: REJECTED -> " + e.message); }
  d.exec("CREATE TABLE f (a BLOB)");
  d.prepare("insert into f values(?)").run(Buffer.from("q"));
  try { d.exec("ALTER TABLE f ADD COLUMN s INTEGER GENERATED ALWAYS AS (length(a)) STORED"); console.log("  non-empty table: ACCEPTED"); }
  catch (e) { console.log("  non-empty table: REJECTED -> " + e.message); }
  try { d.exec("ALTER TABLE f ADD COLUMN v INTEGER GENERATED ALWAYS AS (length(a)) VIRTUAL"); console.log("  non-empty VIRTUAL: ACCEPTED"); }
  catch (e) { console.log("  non-empty VIRTUAL: REJECTED -> " + e.message); }
  d.close();
}

say("8. STRICT table: what column type may a digest use?");
{
  const d = new DatabaseSync(":memory:");
  for (const t of ["BLOB", "TEXT", "INTEGER", "BYTEA", "VARCHAR(64)"]) {
    try { d.exec(`CREATE TABLE s_${t.replace(/[^a-z0-9]/gi,"")} (a INTEGER PRIMARY KEY, d ${t}) STRICT`); console.log(`  STRICT column type ${t}: ACCEPTED`); }
    catch (e) { console.log(`  STRICT column type ${t}: REJECTED -> ${e.message}`); }
  }
  d.close();
}
console.log("\nfile size:", existsSync(P) ? statSync(P).size : "(gone)");
