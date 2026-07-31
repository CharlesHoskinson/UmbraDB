import { DatabaseSync } from "node:sqlite";
const d = new DatabaseSync(":memory:");
d.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT");
d.prepare("insert into t values(1,'a')").run();

const t = (label, sql) => { try { d.exec(sql); console.log("  ACCEPTED  " + label); } catch (e) { console.log("  REJECTED  " + label + "  -> " + e.message); } };
console.log("## ALTER TABLE ADD COLUMN variants on a NON-EMPTY STRICT table");
t("ADD COLUMN dg BLOB                      ", "ALTER TABLE t ADD COLUMN dg BLOB");
t("ADD COLUMN dg2 BLOB NOT NULL            ", "ALTER TABLE t ADD COLUMN dg2 BLOB NOT NULL");
t("ADD COLUMN dg3 BLOB NOT NULL DEFAULT x''", "ALTER TABLE t ADD COLUMN dg3 BLOB NOT NULL DEFAULT x''");
t("ADD COLUMN dg4 BLOB CHECK(length(dg4)=32)", "ALTER TABLE t ADD COLUMN dg4 BLOB CHECK(length(dg4)=32)");
t("ADD COLUMN dg5 BLOB GENERATED ... STORED ", "ALTER TABLE t ADD COLUMN dg5 BLOB GENERATED ALWAYS AS (length(v)) STORED");
t("ADD COLUMN dg6 BLOB GENERATED ... VIRTUAL", "ALTER TABLE t ADD COLUMN dg6 BLOB GENERATED ALWAYS AS (length(v)) VIRTUAL");

console.log("\n## Guard: can a trigger make an adapter-computed digest un-forgeable from SQL?");
const e = new DatabaseSync(":memory:");
e.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, dg BLOB NOT NULL) STRICT");
e.exec(`CREATE TRIGGER kv_dg_guard BEFORE UPDATE OF v ON kv
        WHEN NEW.dg IS OLD.dg
        BEGIN SELECT RAISE(ABORT, 'digest not recomputed for updated value'); END`);
e.prepare("insert into kv values('a','v1',x'11')").run();
try { e.prepare("update kv set v='v2' where k='a'").run(); console.log("  UPDATE v without touching dg: ACCEPTED (drift possible)"); }
catch (err) { console.log("  UPDATE v without touching dg: REJECTED -> " + err.message); }
try { e.prepare("update kv set v='v3', dg=x'22' where k='a'").run(); console.log("  UPDATE v WITH a new dg: ACCEPTED"); }
catch (err) { console.log("  UPDATE v WITH a new dg: REJECTED -> " + err.message); }

console.log("\n## sqlite_version / compile options relevant to checksums");
console.log("  node:sqlite ->", e.prepare("select sqlite_version() v").get().v);
try { console.log("  compile_options:", e.prepare("pragma compile_options").all().map(r => r.compile_options).join(", ")); }
catch (err) { console.log("  compile_options: " + err.message); }
try { console.log("  checksum VFS?  ", JSON.stringify(e.prepare("pragma checksum_verification").all())); }
catch (err) { console.log("  pragma checksum_verification (cksmvfs): " + err.message); }
