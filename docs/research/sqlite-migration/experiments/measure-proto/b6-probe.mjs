// PROBE for B-6: what backup surface does the RULED binding actually expose?
// The existing backup()-beats-VACUUM INTO measurement was taken on node:sqlite.
import Database from "/tmp/l3-bs3b/node_modules/better-sqlite3/lib/index.js";
import { createRequire } from "node:module";
import { statSync, rmSync, mkdirSync } from "node:fs";
const require = createRequire("/tmp/l3-bs3b/");
const pkg = require("better-sqlite3/package.json");

const DIR = "/root/measure-proto/dbs6";
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

console.log("binding:", pkg.name, pkg.version);
console.log("Database.prototype:", Object.getOwnPropertyNames(Database.prototype).sort().join(", "));

const db = new Database(`${DIR}/src.sqlite`);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = 2");
db.exec("CREATE TABLE t (i INTEGER PRIMARY KEY, b BLOB) STRICT;");
const ins = db.prepare("INSERT INTO t VALUES (?,?)");
const blob = Buffer.alloc(4096, 7);
db.transaction(() => { for (let i = 0; i < 60000; i++) ins.run(i, blob); })();
console.log("source size:", statSync(`${DIR}/src.sqlite`).size);

console.log("typeof db.backup:", typeof db.backup, "| arity:", db.backup.length);
const progress = [];
const t0 = process.hrtime.bigint();
const ret = db.backup(`${DIR}/copy.sqlite`, {
  progress: ({ totalPages, remainingPages }) => { progress.push({ totalPages, remainingPages }); return 100; },
});
console.log("backup() returns:", Object.prototype.toString.call(ret), "| is Promise:", ret instanceof Promise);
const result = await ret;
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log("awaited result:", JSON.stringify(result), "| ms:", ms.toFixed(1), "| progress callbacks:", progress.length);
console.log("copy size:", statSync(`${DIR}/copy.sqlite`).size);

// VACUUM INTO for comparison of surface (not a ruling — single trial, no concurrent writer)
const t1 = process.hrtime.bigint();
db.prepare("VACUUM INTO ?").run(`${DIR}/vac.sqlite`);
console.log("VACUUM INTO ms:", (Number(process.hrtime.bigint() - t1) / 1e6).toFixed(1), "| size:", statSync(`${DIR}/vac.sqlite`).size);

const copy = new Database(`${DIR}/copy.sqlite`, { readonly: true });
console.log("copy integrity_check:", copy.pragma("integrity_check", { simple: true }));
console.log("copy rows:", copy.prepare("select count(*) c from t").get().c);
copy.close();
db.close();
