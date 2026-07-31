// Fable adjudication — holder process.
// Opens the DB, takes BEGIN IMMEDIATE, inserts, then on command performs the
// requested action on the -shm file, then on command commits.
import Database from "/tmp/l3-bs3b/node_modules/better-sqlite3/lib/index.js";
import fs from "node:fs";

const dbPath = process.argv[2];
const action = process.argv[3]; // "none" | "shm-readclose" | "shm-openkeep"

const db = new Database(dbPath);
db.pragma("journal_mode = wal");
db.pragma("busy_timeout = 0");
db.exec("create table if not exists t(who integer)");
db.exec("begin immediate");
db.exec("insert into t values (1)");
process.stdout.write("HELD\n");

await new Promise((r) => process.stdin.once("data", r));
let kept = null;
if (action === "shm-readclose") {
  // fs.readFileSync = open + read + close on the -shm inode, inside this process
  fs.readFileSync(dbPath + "-shm");
} else if (action === "shm-openkeep") {
  kept = fs.openSync(dbPath + "-shm", "r"); // open WITHOUT close
}
process.stdout.write("ACTED\n");

await new Promise((r) => process.stdin.once("data", r));
let result = "COMMIT-OK";
try { db.exec("commit"); } catch (e) { result = "COMMIT-ERR " + e.code; }
process.stdout.write(result + "\n");
if (kept !== null) fs.closeSync(kept);
await new Promise((r) => process.stdin.once("data", r));
process.exit(0);
