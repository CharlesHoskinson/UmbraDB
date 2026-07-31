// Coordinator verification of the red team's page-checksum claim:
// does SQLite's integrity_check detect silent corruption of a MAIN-DB page
// after the WAL has been checkpointed? Postgres offers data_checksums for this.
import { DatabaseSync } from 'node:sqlite';
import { openSync, readSync, writeSync, closeSync, statSync, unlinkSync } from 'node:fs';

const path = '/root/umbradb-sqlite-research/.checksum-probe.db';
for (const f of [path, path + '-wal', path + '-shm']) { try { unlinkSync(f); } catch {} }

const db = new DatabaseSync(path);
db.exec('PRAGMA journal_mode=WAL');
db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
const ins = db.prepare('INSERT INTO t(id,payload) VALUES(?,?)');
for (let i = 0; i < 500; i++) ins.run(i, 'PAYLOAD_' + String(i).padStart(6, '0') + '_' + 'x'.repeat(64));
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');   // force everything into the main DB file
const before = db.prepare('SELECT payload FROM t WHERE id=?').get(400);
db.close();

console.log('pre-corruption  read id=400 :', before.payload.slice(0, 30));

// Corrupt 64 bytes deep inside the main database file, well past the header.
const size = statSync(path).size;
const off = Math.floor(size / 2);
const fd = openSync(path, 'r+');
const orig = Buffer.alloc(64);
readSync(fd, orig, 0, 64, off);
writeSync(fd, Buffer.alloc(64, 0x5a), 0, 64, off);   // 'ZZZZ...'
closeSync(fd);
console.log(`corrupted 64 bytes at offset ${off} of ${size} (page_size boundary-agnostic)`);

const db2 = new DatabaseSync(path);
const integrity = db2.prepare('PRAGMA integrity_check').all();
const quick = db2.prepare('PRAGMA quick_check').all();
console.log('integrity_check         :', JSON.stringify(integrity));
console.log('quick_check             :', JSON.stringify(quick));

let after = null, err = null;
try { after = db2.prepare('SELECT payload FROM t WHERE id=?').get(400); }
catch (e) { err = e.message; }
console.log('post-corruption read id=400 :', after ? after.payload.slice(0, 30) : 'ERROR: ' + err);

let scanned = 0, corrupted = 0;
for (const row of db2.prepare('SELECT id,payload FROM t').all()) {
  scanned++;
  if (!row.payload.startsWith('PAYLOAD_' + String(row.id).padStart(6, '0'))) corrupted++;
}
console.log(`full scan: ${scanned} rows read, ${corrupted} with corrupted payload`);
db2.close();
for (const f of [path, path + '-wal', path + '-shm']) { try { unlinkSync(f); } catch {} }
