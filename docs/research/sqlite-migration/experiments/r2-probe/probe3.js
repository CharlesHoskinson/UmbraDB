// G-4 / I-4: does the registration UPDATE report success against an unseeded table?
const Database = require("/tmp/l3-bs3b/node_modules/better-sqlite3");
const fs = require("node:fs");
const DIR = "/root/r2-probe/run3";
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const db = new Database(DIR + "/main.db");
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE writer_generation(
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL,
  owner TEXT NOT NULL) STRICT`);

function register(label) {
  db.exec("begin immediate");
  const info = db.prepare(
    "UPDATE writer_generation SET generation = generation + 1, owner = ? WHERE id = 1",
  ).run("owner-" + label);
  const readBack = db.prepare("SELECT generation, owner FROM writer_generation WHERE id = 1").get();
  db.exec("commit");
  console.log(
    `${label.padEnd(10)} threw=no  changes=${info.changes}  readBack=${JSON.stringify(readBack)}` +
      `  myGeneration=${readBack === undefined ? "undefined" : readBack.generation}`,
  );
  return readBack;
}

console.log("driver: better-sqlite3", require("/tmp/l3-bs3b/node_modules/better-sqlite3/package.json").version);
console.log("\n=== unseeded table (the defect) ===");
register("unseeded");

console.log("\n=== after seeding (migration 007's fix) ===");
db.prepare("INSERT INTO writer_generation(id, generation, owner) VALUES (1, 0, 'seed')").run();
register("seeded");
register("seeded-2");

console.log("\n=== row deleted later (the class I-4 must close) ===");
db.prepare("DELETE FROM writer_generation WHERE id = 1").run();
register("deleted");

db.close();
fs.rmSync(DIR, { recursive: true, force: true });
