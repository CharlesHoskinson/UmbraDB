// E2: UmbraDB-specific corruption consequences, on the proposed SQLite DDL
// (v1.0.0-sqlite-schema-parity design.md §12.1 + v1.0.0-sqlite-temporal-event-log design.md §2).
// Every read path below is a faithful transcription of the real one in src/postgres/*.ts.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { openSync, readSync, writeSync, closeSync, statSync, rmSync } from "node:fs";

const DIR = "/root/corruption-lab";
const sha256 = (b) => createHash("sha256").update(b).digest();

function fresh(path) {
  for (const s of ["", "-wal", "-shm"]) { try { rmSync(path + s); } catch {} }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}
function slurp(path) {
  const fd = openSync(path, "r"); const size = statSync(path).size;
  const buf = Buffer.alloc(size); readSync(fd, buf, 0, size, 0); closeSync(fd);
  return buf;
}
function poke(path, off, bytes) {
  const fd = openSync(path, "r+"); writeSync(fd, bytes, 0, bytes.length, off); closeSync(fd);
}
// Replace the first occurrence of `find` with `repl` (same length) in the main db file.
function swap(path, find, repl) {
  const buf = slurp(path);
  const off = buf.indexOf(Buffer.from(find));
  if (off < 0) throw new Error(`pattern not found: ${find}`);
  if (Buffer.from(find).length !== Buffer.from(repl).length) throw new Error("length mismatch");
  poke(path, off, Buffer.from(repl));
  return off;
}
function ic(path) {
  const db = new DatabaseSync(path);
  const r = db.prepare("PRAGMA integrity_check").all().map(x => x.integrity_check).join("; ");
  db.close(); return r;
}
const hr = (t) => console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);

// ============================================================ 1. watermarks.value
hr("1. watermarks.value -- the sync cursor, classified 're-derivable, UNCOVERED'");
{
  const p = `${DIR}/wm.db`;
  const db = fresh(p);
  db.exec(`CREATE TABLE u_watermarks (
    kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (kind,key)) STRICT, WITHOUT ROWID`);
  db.prepare("INSERT INTO u_watermarks VALUES (?,?,?,?)")
    .run("chain_archive", "sync", JSON.stringify({ height: 1200000 }), Date.now());
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();

  const off = swap(p, '{"height":1200000}', '{"height":9200000}');
  console.log(`corrupted 1 byte-run at offset ${off}: height 1200000 -> 9200000 (JSON stays valid)`);
  console.log(`integrity_check : ${ic(p)}`);

  // Faithful to PgWatermarks.getImpl: "No read-side validation ... returned exactly as the
  // driver parsed it" (src/postgres/watermarks.ts, getImpl comment).
  const db2 = new DatabaseSync(p);
  const got = JSON.parse(db2.prepare("SELECT value FROM u_watermarks WHERE kind=? AND key=?")
    .get("chain_archive", "sync").value);
  console.log(`get()           : ${JSON.stringify(got)}   <-- returned to the caller as data`);

  // Faithful to PgChainArchiveStore.setWatermark's monotonic ON CONFLICT ... WHERE guard
  // (src/postgres/chain-archive-store.ts): only a STRICTLY GREATER height may overwrite.
  const set = (h) => db2.prepare(`
    INSERT INTO u_watermarks AS w (kind,key,value,updated_at) VALUES ('chain_archive','sync',?,?)
    ON CONFLICT (kind,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    WHERE json_type(w.value,'$.height') IS NOT 'integer'
       OR json_type(excluded.value,'$.height') IS NOT 'integer'
       OR CAST(json_extract(excluded.value,'$.height') AS REAL)
        > CAST(json_extract(w.value,'$.height') AS REAL)`)
    .run(JSON.stringify({ height: h }), Date.now());
  for (const h of [1200001, 1300000, 5000000, 9199999]) {
    set(h);
    const now = JSON.parse(db2.prepare("SELECT value FROM u_watermarks").get().value).height;
    console.log(`  legitimate setWatermark(${String(h).padStart(7)}) -> stored height is now ${now}`);
  }
  console.log("  ^ the anti-regression guard LATCHES the corruption: no honest write can undo it.");
  db2.close();
}

// ============================================================ 2. ckpt_sequence_counters.next_seq
hr("2. ckpt_sequence_counters.next_seq -- 're-derivable' checkpoint tier; digest is intact");
{
  const p = `${DIR}/ckpt.db`;
  const db = fresh(p);
  db.exec(`CREATE TABLE u_ckpt_chunks (hash BLOB NOT NULL PRIMARY KEY, data BLOB NOT NULL, created_at INTEGER NOT NULL) STRICT`);
  db.exec(`CREATE TABLE u_ckpt_manifests (id INTEGER PRIMARY KEY AUTOINCREMENT, w TEXT NOT NULL, net TEXT NOT NULL,
    seq INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0, manifest_hash BLOB NOT NULL, label TEXT,
    created_at INTEGER NOT NULL) STRICT`);
  db.exec(`CREATE INDEX u_ckpt_manifests_lookup ON u_ckpt_manifests (w,net,complete,seq DESC)`);
  db.exec(`CREATE TABLE u_ckpt_manifest_chunks (manifest_id INTEGER NOT NULL REFERENCES u_ckpt_manifests(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, chunk_hash BLOB NOT NULL REFERENCES u_ckpt_chunks(hash),
    PRIMARY KEY (manifest_id,position)) STRICT, WITHOUT ROWID`);
  db.exec(`CREATE TABLE u_ckpt_sequence_counters (w TEXT NOT NULL, net TEXT NOT NULL,
    next_seq INTEGER NOT NULL DEFAULT 2, PRIMARY KEY (w,net)) STRICT, WITHOUT ROWID`);

  // Faithful to PgCheckpointStore.saveImpl: seq alloc, manifest insert, junction insert.
  function save(payload) {
    const data = Buffer.from(payload);
    const h = sha256(data);
    db.prepare("INSERT INTO u_ckpt_chunks VALUES (?,?,?) ON CONFLICT(hash) DO UPDATE SET created_at=excluded.created_at").run(h, data, Date.now());
    const mh = sha256(Buffer.concat([h]));
    const seq = db.prepare(`INSERT INTO u_ckpt_sequence_counters (w,net) VALUES ('w','n')
      ON CONFLICT (w,net) DO UPDATE SET next_seq = u_ckpt_sequence_counters.next_seq + 1
      RETURNING next_seq - 1 AS claimed_seq`).get().claimed_seq;
    const id = db.prepare("INSERT INTO u_ckpt_manifests (w,net,seq,complete,manifest_hash,created_at) VALUES ('w','n',?,1,?,?) RETURNING id")
      .get(seq, mh, Date.now()).id;
    db.prepare("INSERT INTO u_ckpt_manifest_chunks VALUES (?,0,?)").run(id, h);
    return { seq, id };
  }
  // Faithful to PgCheckpointStore.loadImpl: ORDER BY seq DESC LIMIT 1, then rehash-verify.
  function load(handle) {
    const m = handle.prepare("SELECT id,seq,manifest_hash FROM u_ckpt_manifests WHERE w='w' AND net='n' AND complete ORDER BY seq DESC LIMIT 1").get();
    if (!m) return null;
    const rows = handle.prepare(`SELECT mc.position, mc.chunk_hash, c.hash, c.data FROM u_ckpt_manifest_chunks mc
      LEFT JOIN u_ckpt_chunks c ON c.hash = mc.chunk_hash WHERE mc.manifest_id=? ORDER BY mc.position`).all(m.id);
    const parts = [], hashes = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.position !== i) return { err: "ManifestCorruptError(position gap)" };
      if (r.hash === null) return { err: "ChunkMissingError" };
      if (!sha256(r.data).equals(Buffer.from(r.chunk_hash))) return { err: "ChunkIntegrityError" };
      parts.push(r.data); hashes.push(Buffer.from(r.chunk_hash));
    }
    if (!sha256(Buffer.concat(hashes)).equals(Buffer.from(m.manifest_hash))) return { err: "ManifestCorruptError(hash)" };
    return { seq: m.seq, data: Buffer.concat(parts).toString(), verified: "all SHA-256 checks PASSED" };
  }

  for (let i = 1; i <= 40; i++) save(`ENVELOPE_STATE_AT_BLOCK_${String(i).padStart(6, "0")}`);
  console.log(`before corruption: load() -> ${JSON.stringify(load(db))}`);
  const nsBefore = db.prepare("SELECT next_seq FROM u_ckpt_sequence_counters").get().next_seq;
  console.log(`next_seq = ${nsBefore}`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();

  // next_seq = 41 is stored as a 1-byte serial-type-1 integer. Find the WITHOUT-ROWID PK record
  // for ('w','n') and rewrite the payload byte 41 -> 5.
  const buf = slurp(p);
  const rec = Buffer.from([0x04, 0x04, 0x11, 0x11, 0x01, 0x77, 0x6e, nsBefore]); // hdrlen,?,text3,text3,int1,'w','n',next_seq
  let off = buf.indexOf(Buffer.from([0x11, 0x11, 0x01, 0x77, 0x6e, nsBefore]));
  if (off < 0) { console.log("!! could not locate next_seq record; aborting case 2"); }
  else {
    poke(p, off + 5, Buffer.from([5]));
    console.log(`corrupted 1 byte at offset ${off + 5}: next_seq ${nsBefore} -> 5`);
    console.log(`integrity_check : ${ic(p)}`);
    const db2 = new DatabaseSync(p);
    db2.exec("PRAGMA foreign_keys=ON");
    // reattach the save/load closures to the reopened handle
    const save2 = (payload) => {
      const data = Buffer.from(payload); const h = sha256(data);
      db2.prepare("INSERT INTO u_ckpt_chunks VALUES (?,?,?) ON CONFLICT(hash) DO UPDATE SET created_at=excluded.created_at").run(h, data, Date.now());
      const mh = sha256(Buffer.concat([h]));
      const seq = db2.prepare(`INSERT INTO u_ckpt_sequence_counters (w,net) VALUES ('w','n')
        ON CONFLICT (w,net) DO UPDATE SET next_seq = u_ckpt_sequence_counters.next_seq + 1
        RETURNING next_seq - 1 AS claimed_seq`).get().claimed_seq;
      const id = db2.prepare("INSERT INTO u_ckpt_manifests (w,net,seq,complete,manifest_hash,created_at) VALUES ('w','n',?,1,?,?) RETURNING id")
        .get(seq, mh, Date.now()).id;
      db2.prepare("INSERT INTO u_ckpt_manifest_chunks VALUES (?,0,?)").run(id, h);
      return seq;
    };
    const s = save2("ENVELOPE_STATE_AT_BLOCK_000041");
    console.log(`save() succeeded, returned seq = ${s}  (no error, no constraint violation --`);
    console.log(`   there is NO UNIQUE (w,net,seq) on ckpt_manifests, in PG or in the SQLite DDL)`);
    console.log(`load() -> ${JSON.stringify(load(db2))}`);
    console.log(`  ^ the wallet just persisted block 41 and read back block 40, with EVERY`);
    console.log(`    content-address and manifest-hash check PASSING. A value digest cannot see this.`);
    db2.close();
  }
}

// ============================================================ 3. ckpt_manifests.seq
hr("3. ckpt_manifests.seq on an OLD manifest -- same class, one byte");
{
  const p = `${DIR}/ckpt2.db`;
  const db = fresh(p);
  db.exec(`CREATE TABLE u_ckpt_manifests (id INTEGER PRIMARY KEY AUTOINCREMENT, w TEXT NOT NULL, net TEXT NOT NULL,
    seq INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0, manifest_hash BLOB NOT NULL, label TEXT,
    created_at INTEGER NOT NULL) STRICT`);
  for (let i = 1; i <= 9; i++)
    db.prepare("INSERT INTO u_ckpt_manifests (w,net,seq,complete,manifest_hash,label,created_at) VALUES ('w','n',?,1,?,?,?)")
      .run(i, sha256(Buffer.from(`m${i}`)), `SEQMARK_${String(i).padStart(3, "0")}`, 1700000000000 + i);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  const pick = (h) => { const d = new DatabaseSync(h); const r = d.prepare("SELECT seq,label FROM u_ckpt_manifests WHERE w='w' AND net='n' AND complete ORDER BY seq DESC LIMIT 1").get(); d.close(); return r; };
  console.log(`before: latest = ${JSON.stringify(pick(p))}`);
  // Row for seq=2 carries label SEQMARK_002; its seq byte sits immediately before the label text.
  const buf = slurp(p);
  const lblOff = buf.indexOf(Buffer.from("SEQMARK_002"));
  // walk back to find the serial-type-1 integer payload equal to 2 preceding the label
  let seqOff = -1;
  for (let k = lblOff - 1; k > lblOff - 12; k--) if (buf[k] === 2) { seqOff = k; break; }
  poke(p, seqOff, Buffer.from([99]));
  console.log(`corrupted 1 byte at offset ${seqOff}: manifest #2's seq 2 -> 99`);
  console.log(`integrity_check : ${ic(p)}`);
  console.log(`after : latest = ${JSON.stringify(pick(p))}   <-- an 8-checkpoint-old state is now "latest"`);
}

// ============================================================ 4. kv_event.written_at / version
hr("4. kv_event -- the non-re-derivable tier; what a VALUE digest still misses");
{
  const p = `${DIR}/kv.db`;
  const db = fresh(p);
  db.exec(`CREATE TABLE kv_event (ns TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
    version INTEGER NOT NULL, value TEXT NOT NULL, written_at INTEGER NOT NULL,
    PRIMARY KEY (ns,scope,key,version)) STRICT`);
  db.exec(`CREATE UNIQUE INDEX kv_event_time ON kv_event (ns,scope,key,written_at)`);
  db.exec(`CREATE VIEW kv_validity AS SELECT ns,scope,key,version,value, written_at AS valid_from,
    LEAD(written_at) OVER (PARTITION BY ns,scope,key ORDER BY version) AS valid_to FROM kv_event`);
  const t0 = 1700000000000;
  for (let v = 1; v <= 10; v++)
    db.prepare("INSERT INTO kv_event VALUES ('ns','sc','k',?,?,?)").run(v, JSON.stringify({ v }), t0 + v * 1000);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();

  const at = (h, t) => { const d = new DatabaseSync(h); const r = d.prepare("SELECT version,value FROM kv_event WHERE ns='ns' AND scope='sc' AND key='k' AND written_at <= ? ORDER BY written_at DESC LIMIT 1").get(t); d.close(); return r; };
  console.log(`before: getAt(t0+5500) -> ${JSON.stringify(at(p, t0 + 5500))}`);
  // written_at for v=5 is t0+5000 = 1700000005000 -> 6-byte big-endian serial type 5
  const be6 = Buffer.alloc(6); be6.writeUIntBE(t0 + 5000, 0, 6);
  const off = swap(p, be6, (() => { const b = Buffer.alloc(6); b.writeUIntBE(t0 + 9500, 0, 6); return b; })());
  console.log(`corrupted 6 bytes at offset ${off}: version 5's written_at t0+5000 -> t0+9500`);
  console.log(`integrity_check : ${ic(p)}   <-- the UNIQUE index on (ns,scope,key,written_at) is`);
  console.log(`   still satisfied (t0+9500 collides with nothing), and BEFORE-INSERT triggers`);
  console.log(`   never re-run on rows already on disk.`);
  console.log(`after : getAt(t0+5500) -> ${JSON.stringify(at(p, t0 + 5500))}   <-- was v5`);
  const d = new DatabaseSync(p);
  console.log(`kv_validity intervals now: ${JSON.stringify(d.prepare("SELECT version,valid_from-? AS from_off, valid_to-? AS to_off FROM kv_validity WHERE version BETWEEN 4 AND 6").all(t0, t0))}`);
  console.log(`  ^ version 5 now has valid_to < valid_from: an interval that Model.lean's`);
  console.log(`    validityIntervals cannot denote. A digest over 'value' alone does not cover it.`);
  d.close();
}

// ============================================================ 5. _migrations.name
hr("5. _migrations.name -- 're-derivable' bookkeeping");
{
  const p = `${DIR}/mig.db`;
  const db = fresh(p);
  db.exec(`CREATE TABLE u_migrations (name TEXT NOT NULL PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT, WITHOUT ROWID`);
  for (const n of ["000_schema", "001_temporal_kv", "002_checkpoint_store", "003_watermarks",
    "004_transaction_history", "005_kv_current_fillfactor", "006_ckpt_chunks_size_bytes", "007_writer_generation"])
    db.prepare("INSERT INTO u_migrations VALUES (?,?)").run(n, Date.now());
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  const off = swap(p, "004_transaction_history", "004_transaction_hiXtory");
  console.log(`corrupted 1 byte at offset ${off}: '004_transaction_history' -> '004_transaction_hiXtory'`);
  console.log(`integrity_check : ${ic(p)}`);
  const d = new DatabaseSync(p);
  const applied = new Set(d.prepare("SELECT name FROM u_migrations").all().map(r => r.name));
  console.log(`runMigrations sees applied = ${[...applied].filter(n => n.startsWith("004")).join(",") || "(no 004)"} `);
  console.log(`  -> it will re-run 004_transaction_history. Outcome depends on the statement:`);
  console.log(`     CREATE TABLE -> "table already exists" (LOUD, safe).`);
  console.log(`     ALTER TABLE ADD COLUMN / INSERT seed -> may succeed and corrupt further.`);
  console.log(`ordering check  : ${JSON.stringify(d.prepare("SELECT name FROM u_migrations ORDER BY name").all().map(r => r.name))}`);
  d.close();
}

// ============================================================ 6. transaction_history identifiers
hr("6. transaction_history_identifiers.identifier -- redundancy already exists in `entry`");
{
  const p = `${DIR}/th.db`;
  const db = fresh(p);
  db.exec(`CREATE TABLE u_th (wallet_id TEXT NOT NULL, tx_hash TEXT NOT NULL, entry TEXT NOT NULL,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('pending','finalized','rejected')), updated_at INTEGER NOT NULL,
    PRIMARY KEY (wallet_id,tx_hash)) STRICT, WITHOUT ROWID`);
  db.exec(`CREATE TABLE u_th_ident (wallet_id TEXT NOT NULL, tx_hash TEXT NOT NULL, identifier TEXT NOT NULL,
    PRIMARY KEY (wallet_id,tx_hash,identifier),
    FOREIGN KEY (wallet_id,tx_hash) REFERENCES u_th(wallet_id,tx_hash) ON DELETE CASCADE) STRICT, WITHOUT ROWID`);
  const ids = ["IDENTIFIER_AAAA", "IDENTIFIER_BBBB"];
  db.prepare("INSERT INTO u_th VALUES (?,?,?,?,?)").run("w1", "tx1",
    JSON.stringify({ txHash: "tx1", identifiers: ids, lifecycle: { status: "pending" } }), "pending", Date.now());
  for (const i of ids) db.prepare("INSERT INTO u_th_ident VALUES ('w1','tx1',?)").run(i);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  const buf = slurp(p);
  const last = buf.lastIndexOf(Buffer.from("IDENTIFIER_AAAA"));
  poke(p, last + 11, Buffer.from("ZZZZ"));
  console.log(`corrupted 4 bytes at offset ${last + 11} (the junction copy only)`);
  console.log(`integrity_check : ${ic(p)}`);
  const d = new DatabaseSync(p);
  const row = d.prepare("SELECT entry FROM u_th WHERE wallet_id='w1' AND tx_hash='tx1'").get();
  const fromEntry = JSON.parse(row.entry).identifiers;
  const fromJunction = d.prepare("SELECT identifier FROM u_th_ident WHERE wallet_id='w1' AND tx_hash='tx1' ORDER BY identifier").all().map(r => r.identifier);
  console.log(`entry.identifiers    : ${JSON.stringify(fromEntry)}`);
  console.log(`junction identifiers : ${JSON.stringify(fromJunction)}   <-- diverged`);
  console.log(`  ^ the junction is fully derivable from 'entry'. A digest over 'entry' plus a`);
  console.log(`    cross-check on read detects this with NO digest column on the junction table.`);
  d.close();
}

// ============================================================ 7. WAL boundary
hr("7. WAL frame checksums -- confirming where the exposure window actually starts");
{
  const p = `${DIR}/wal.db`;
  const db = fresh(p);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT");
  for (let i = 1; i <= 200; i++) db.prepare("INSERT INTO t VALUES (?,?)").run(i, `WALPAYLOAD_${String(i).padStart(6, "0")}`);
  // deliberately NOT checkpointed: rows live in the -wal file
  const walSize = statSync(p + "-wal").size, mainSize = statSync(p).size;
  console.log(`uncheckpointed: main=${mainSize}B  wal=${walSize}B`);
  db.close(); // node:sqlite checkpoints on close, so re-open a fresh writer that leaves WAL dirty
}
{
  const p = `${DIR}/wal2.db`;
  for (const s of ["", "-wal", "-shm"]) { try { rmSync(p + s); } catch {} }
  const db = new DatabaseSync(p);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA wal_autocheckpoint=0");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT");
  for (let i = 1; i <= 200; i++) db.prepare("INSERT INTO t VALUES (?,?)").run(i, `WALPAYLOAD_${String(i).padStart(6, "0")}`);
  const walPath = p + "-wal";
  const walBuf = slurp(walPath);
  const off = walBuf.indexOf(Buffer.from("WALPAYLOAD_000150"));
  console.log(`WALPAYLOAD_000150 found in -wal at offset ${off} (wal size ${walBuf.length})`);
  if (off > 0) {
    poke(walPath, off + 11, Buffer.from("999999"));
    // A second connection reading the same WAL must re-validate frame checksums.
    const d2 = new DatabaseSync(p);
    let n = 0, bad = 0;
    try {
      for (const r of d2.prepare("SELECT id,v FROM t").all()) { n++; if (!r.v.startsWith(`WALPAYLOAD_${String(r.id).padStart(6, "0")}`)) bad++; }
      console.log(`reader over corrupted WAL: ${n} rows, ${bad} corrupted   integrity_check=${d2.prepare("PRAGMA integrity_check").all().map(x=>x.integrity_check).join(";")}`);
    } catch (e) { console.log(`reader over corrupted WAL: THREW ${e.code} ${e.message}`); }
    d2.close();
  }
  db.close();
}

// ============================================================ 8. digest-adjacent corruption
hr("8. The digest column itself -- false-positive rate of the proposed mechanism");
{
  const p = `${DIR}/dg.db`;
  const db = fresh(p);
  db.exec("CREATE TABLE t (k TEXT NOT NULL PRIMARY KEY, v TEXT NOT NULL, digest BLOB NOT NULL) STRICT, WITHOUT ROWID");
  for (let i = 1; i <= 200; i++) {
    const v = JSON.stringify({ i, pad: "VALUEPAYLOAD_" + String(i).padStart(6, "0") });
    db.prepare("INSERT INTO t VALUES (?,?,?)").run(`k${i}`, v, sha256(Buffer.from(v)));
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  // The digest BLOB is stored immediately after the value TEXT in the same record. A 64-byte
  // smash starting inside the value therefore lands on BOTH -- the "same event damages both" case.
  const buf = slurp(p);
  const vo = buf.indexOf(Buffer.from("VALUEPAYLOAD_000100"));
  poke(p, vo, Buffer.alloc(64, 0x5a));
  const d = new DatabaseSync(p);
  console.log(`smashed 64 bytes at offset ${vo}, spanning value AND digest of >=1 row`);
  console.log(`integrity_check : ${ic(p)}`);
  let checked = 0, mismatch = 0, unreadable = 0;
  for (const r of d.prepare("SELECT k,v,digest FROM t").all()) {
    checked++;
    try { if (!sha256(Buffer.from(r.v)).equals(Buffer.from(r.digest))) mismatch++; }
    catch { unreadable++; }
  }
  console.log(`digest sweep    : ${checked} rows checked, ${mismatch} MISMATCH, ${unreadable} unreadable`);
  console.log(`  ^ a co-located digest still detects: forging a matching SHA-256 by accident is`);
  console.log(`    the thing that does not happen. Co-location costs detection only if the`);
  console.log(`    corruption is a coherent rewrite, not a smear.`);
  d.close();
}
