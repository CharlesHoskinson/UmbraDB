// Probe 5: does the ruled binding's backup() open any filesystem descriptor on the -wal/-shm
// sidecars of the SOURCE database? (change 5, criterion E10c). Run under strace and grep.
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("/tmp/l3-bs3b/");
const Database = require("better-sqlite3");

const DIR = "/root/umbradb-sqlite-research/.probe5";
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const SRC = `${DIR}/src.db`;
const DST = `${DIR}/dst.db`;

const db = new Database(SRC);
db.pragma("page_size = 4096");
db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL");
db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v BLOB NOT NULL) STRICT");
const ins = db.prepare("INSERT INTO t (id, v) VALUES (?, ?)");
const tx = db.transaction(() => {
  for (let i = 1; i <= 20000; i++) ins.run(i, Buffer.alloc(512, 0x41));
});
tx();
// leave uncheckpointed WAL content on purpose
console.log("MARKER_BACKUP_START");
let ticks = 0;
const t = setInterval(() => ticks++, 1);
const started = Date.now();
const res = await db.backup(DST);
clearInterval(t);
console.log("MARKER_BACKUP_END");
console.log("backup result   :", JSON.stringify(res), "ms=", Date.now() - started, "timer ticks=", ticks);
console.log("backup.length   :", Database.prototype.backup.length, "(no AbortSignal parameter)");
db.close();

const d2 = new Database(DST, { readonly: true });
console.log("dest integrity  :", JSON.stringify(d2.pragma("integrity_check")));
console.log("dest rows       :", d2.prepare("select count(*) as c from t").get().c);
console.log("dest sidecars   :", ["-wal", "-shm"].map((s) => `${s}:${fs.existsSync(DST + s)}`).join(" "));
d2.close();
