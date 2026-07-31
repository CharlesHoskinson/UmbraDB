// Fable round-2 adjudication re-tests T1-T3.
// Run: node /root/fable-adj2/t123.cjs   (cwd /root, ext4)
const Database = require('/tmp/l3-bs3b/node_modules/better-sqlite3');
const fs = require('fs');

const DBP = '/root/fable-adj2/t.db';
for (const f of [DBP, DBP + '-wal', DBP + '-shm']) { try { fs.unlinkSync(f); } catch {} }
const db = new Database(DBP);
db.pragma('journal_mode = WAL');
console.log('driver: better-sqlite3', require('/tmp/l3-bs3b/node_modules/better-sqlite3/package.json').version,
  '/ SQLite', db.prepare('select sqlite_version() v').get().v);

// ===== T1: dg length CHECK mechanics (change 4 form vs change 5/6 prohibition) =====
console.log('\n=== T1: ADD COLUMN dg BLOB with null-tolerant named CHECK, populated STRICT table ===');
db.exec('CREATE TABLE s_kv (id INTEGER PRIMARY KEY, value BLOB NOT NULL) STRICT');
const ins = db.prepare('INSERT INTO s_kv (value) VALUES (?)');
for (let i = 0; i < 50; i++) ins.run(Buffer.from('v' + i));
// change 4's mandated form, as a named constraint, via ALTER TABLE on a populated table:
try {
  db.exec('ALTER TABLE s_kv ADD COLUMN dg BLOB CONSTRAINT s_kv_dg_len CHECK (dg IS NULL OR octet_length(dg) = 32)');
  console.log('ALTER TABLE ADD COLUMN with named null-tolerant CHECK: ACCEPTED');
} catch (e) { console.log('ALTER TABLE ADD COLUMN with CHECK: REJECTED ->', e.message); }
const r = (sql, args) => { try { db.prepare(sql).run(...args); return 'ACCEPTED'; } catch (e) { return 'REJECTED -> ' + e.message; } };
console.log('insert dg=NULL          :', r('INSERT INTO s_kv (value, dg) VALUES (?, NULL)', [Buffer.from('x')]));
console.log('insert dg=31 bytes      :', r('INSERT INTO s_kv (value, dg) VALUES (?, ?)', [Buffer.from('x'), Buffer.alloc(31)]));
console.log('insert dg=32 bytes      :', r('INSERT INTO s_kv (value, dg) VALUES (?, ?)', [Buffer.from('x'), Buffer.alloc(32)]));
console.log('update dg -> NULL       :', r('UPDATE s_kv SET dg = NULL WHERE id = 1', []));

console.log('\n--- T1b: is even the BARE length CHECK null-intolerant? (changes 5/6 stated rationale) ---');
db.exec('CREATE TABLE bare (id INTEGER PRIMARY KEY, dg BLOB CHECK (octet_length(dg) = 32)) STRICT');
console.log('bare CHECK, insert NULL :', r('INSERT INTO bare (dg) VALUES (NULL)', []),
  '   [SQL CHECK semantics: NULL result = pass]');
console.log('bare CHECK, 31 bytes    :', r('INSERT INTO bare (dg) VALUES (?)', [Buffer.alloc(31)]));

// ===== T2: R-3 drift-guard trigger is one-directional =====
console.log('\n=== T2: drift guard vs UPDATE t SET dg = NULL (silent verification downgrade) ===');
db.exec('CREATE TABLE kv (id INTEGER PRIMARY KEY, value BLOB NOT NULL, dg BLOB) STRICT');
db.exec(`CREATE TRIGGER kv_dg_guard BEFORE UPDATE OF value ON kv
WHEN NEW.dg IS OLD.dg
BEGIN SELECT RAISE(ABORT, 'digest not recomputed for updated value'); END`);
db.prepare('INSERT INTO kv (value, dg) VALUES (?, ?)').run(Buffer.from('payload'), Buffer.alloc(32, 7));
console.log('update value, same dg   :', r('UPDATE kv SET value = ? WHERE id = 1', [Buffer.from('tampered')]));
console.log('UPDATE kv SET dg = NULL :', r('UPDATE kv SET dg = NULL WHERE id = 1', []),
  '   <- row silently downgraded to permanently-unverified');
console.log('dg after                :', db.prepare('SELECT dg FROM kv WHERE id = 1').get().dg);
// proposed closure: anti-downgrade trigger (no UDF), greenfield lineages where NULL is unreachable
db.exec(`CREATE TRIGGER kv_dg_nodown BEFORE UPDATE OF dg ON kv
WHEN NEW.dg IS NULL AND OLD.dg IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'digest downgrade to NULL forbidden'); END`);
db.prepare('UPDATE kv SET dg = ? WHERE id = 1').run(Buffer.alloc(32, 7)); // restore
console.log('with anti-downgrade trg :', r('UPDATE kv SET dg = NULL WHERE id = 1', []));
console.log('legit dg recompute      :', r('UPDATE kv SET value = ?, dg = ? WHERE id = 1', [Buffer.from('new'), Buffer.alloc(32, 9)]));

// ===== T3: cancellation primitives on the ruled binding =====
console.log('\n=== T3: interrupt / progress-callback availability ===');
const proto = Object.getOwnPropertyNames(Database.prototype).sort();
console.log('Database.prototype:', proto.join(' '));
console.log('has interrupt:', proto.includes('interrupt'));
const opts = db.pragma('compile_options').map(o => o.compile_options);
console.log('OMIT_PROGRESS_CALLBACK compiled:', opts.filter(o => /PROGRESS/.test(o)));
db.close();
