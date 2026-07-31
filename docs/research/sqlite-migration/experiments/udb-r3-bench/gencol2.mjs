// Follow-ups: does a UDF-bearing schema survive VACUUM / backup / a different binding?
import { DatabaseSync } from "node:sqlite";
import { hash as oneShot } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
const req = createRequire("/root/l3-bs3b/x.js");

const P = "/root/udb-r3-bench/gencol2.db";
for (const s of ["", "-wal", "-shm"]) if (existsSync(P + s)) unlinkSync(P + s);
const sha = (b) => oneShot("sha256", b, "buffer");
const say = (t) => console.log("\n### " + t);

// build
{
  const d = new DatabaseSync(P);
  d.exec("pragma journal_mode=wal");
  d.function("udb_sha256", { deterministic: true }, sha);
  d.exec(`CREATE TABLE t (k INTEGER PRIMARY KEY, data BLOB NOT NULL,
          dg BLOB GENERATED ALWAYS AS (udb_sha256(data)) STORED) STRICT`);
  const st = d.prepare("insert into t(k,data) values(?,?)");
  for (let i = 0; i < 50; i++) st.run(i, Buffer.from("row" + i));
  d.close();
}

say("A. VACUUM with the UDF ABSENT");
{
  const d = new DatabaseSync(P);
  try { d.exec("VACUUM"); console.log("  VACUUM: ACCEPTED"); }
  catch (e) { console.log("  VACUUM: FAILED -> " + e.message); }
  d.close();
}
say("B. VACUUM with the UDF PRESENT");
{
  const d = new DatabaseSync(P);
  d.function("udb_sha256", { deterministic: true }, sha);
  try { d.exec("VACUUM"); console.log("  VACUUM: ACCEPTED"); }
  catch (e) { console.log("  VACUUM: FAILED -> " + e.message); }
  d.close();
}
say("C. UPDATE of a non-generated column, UDF absent");
{
  const d = new DatabaseSync(P);
  try { d.prepare("update t set data=? where k=0").run(Buffer.from("changed")); console.log("  UPDATE: ACCEPTED"); }
  catch (e) { console.log("  UPDATE: REJECTED -> " + e.message); }
  try { d.prepare("delete from t where k=49").run(); console.log("  DELETE: ACCEPTED"); }
  catch (e) { console.log("  DELETE: REJECTED -> " + e.message); }
  d.close();
}
say("D. better-sqlite3@13.0.2 (the pinned binding) opening the same file, UDF absent");
{
  let BS;
  try { BS = req("better-sqlite3"); } catch (e) { console.log("  cannot load better-sqlite3: " + e.message); }
  if (BS) {
    const d = new BS(P);
    console.log("  bs3 sqlite_version:", d.prepare("select sqlite_version() v").get().v);
    try { console.log("  select dg  => ok (" + d.prepare("select count(dg) c from t").get().c + " rows)"); }
    catch (e) { console.log("  select dg FAILED -> " + e.message); }
    try { d.prepare("insert into t(k,data) values(?,?)").run(999, Buffer.from("bs3")); console.log("  INSERT: ACCEPTED"); }
    catch (e) { console.log("  INSERT: REJECTED -> " + e.message); }
    // now register on bs3 and retry
    d.function("udb_sha256", { deterministic: true }, sha);
    try { d.prepare("insert into t(k,data) values(?,?)").run(998, Buffer.from("bs3b")); console.log("  INSERT after bs3 registers UDF: ACCEPTED"); }
    catch (e) { console.log("  INSERT after bs3 registers UDF: REJECTED -> " + e.message); }
    try { console.log("  bs3 builtin sha3? ", d.prepare("select hex(sha3(x'00')) h").get().h); }
    catch (e) { console.log("  bs3 builtin sha3: absent -> " + e.message); }
    d.close();
  }
}
say("E. Online backup API with UDF absent (page-level copy)");
{
  const d = new DatabaseSync(P);
  try {
    const { backup } = await import("node:sqlite");
    await backup(d, "/root/udb-r3-bench/gencol2-bak.db");
    console.log("  backup(): ACCEPTED");
  } catch (e) { console.log("  backup(): " + e.message); }
  d.close();
}
say("F. Does a STORED gencol value survive a corrupted-data write? (drift test)");
{
  // Can an attacker/bug write data without the digest updating? No -- but can the digest be
  // written directly?
  const d = new DatabaseSync(P);
  d.function("udb_sha256", { deterministic: true }, sha);
  try { d.prepare("update t set dg=? where k=1").run(Buffer.alloc(32)); console.log("  direct write to gencol: ACCEPTED (!!)"); }
  catch (e) { console.log("  direct write to gencol: REJECTED -> " + e.message); }
  d.close();
}
