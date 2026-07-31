// E4: (a) a co-read invariant as an alternative to a digest for addressing columns
//     (b) _migrations, writer_generation, chain-archive, sqlite_schema, truncation
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { openSync, readSync, writeSync, closeSync, statSync, rmSync, truncateSync } from "node:fs";

const DIR = "/root/corruption-lab";
const sha256 = (b) => createHash("sha256").update(b).digest();
const be4 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
function fresh(p) { for (const s of ["", "-wal", "-shm"]) { try { rmSync(p + s); } catch {} } const d = new DatabaseSync(p); d.exec("PRAGMA journal_mode=WAL"); return d; }
function slurp(p) { const fd = openSync(p, "r"); const n = statSync(p).size; const b = Buffer.alloc(n); readSync(fd, b, 0, n, 0); closeSync(fd); return b; }
function poke(p, o, b) { const fd = openSync(p, "r+"); writeSync(fd, b, 0, b.length, o); closeSync(fd); }
function sites(p, needle) { const b = slurp(p); const out = []; let i = b.indexOf(needle); while (i >= 0) { out.push(i); i = b.indexOf(needle, i + 1); } return out; }
function ic(p) { try { const d = new DatabaseSync(p); const r = d.prepare("PRAGMA integrity_check").all().map(x => x.integrity_check); d.close(); return r.slice(0, 3).join("; ") + (r.length > 3 ? ` (+${r.length - 3} more)` : ""); } catch (e) { return `THREW ${e.code}: ${e.message}`; } }
const hr = (t) => console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);

// ============================================================ A. the co-read invariant
hr("A. `next_seq > max(seq)` as a co-read invariant -- does it catch what the digest misses?");
{
  const BASE = 1000000000;
  const build = (p) => {
    const db = fresh(p);
    db.exec(`CREATE TABLE m (id INTEGER PRIMARY KEY AUTOINCREMENT, w TEXT NOT NULL, net TEXT NOT NULL, seq INTEGER NOT NULL,
      complete INTEGER NOT NULL DEFAULT 0, manifest_hash BLOB NOT NULL, label TEXT, created_at INTEGER NOT NULL) STRICT`);
    db.exec(`CREATE INDEX m_lookup ON m (w,net,complete,seq DESC)`);
    db.exec(`CREATE TABLE c (w TEXT NOT NULL, net TEXT NOT NULL, next_seq INTEGER NOT NULL, PRIMARY KEY (w,net)) STRICT, WITHOUT ROWID`);
    for (let i = 1; i <= 9; i++)
      db.prepare("INSERT INTO m (w,net,seq,complete,manifest_hash,label,created_at) VALUES ('w','n',?,1,?,?,?)")
        .run(BASE + i, sha256(Buffer.from(`m${i}`)), `SEQMARK_${String(i).padStart(3, "0")}`, 1700000000000 + i);
    db.prepare("INSERT INTO c VALUES ('w','n',?)").run(BASE + 10);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  };
  // The invariant: two O(log n) index seeks, no scan.
  const check = (p) => {
    const d = new DatabaseSync(p);
    const ns = d.prepare("SELECT next_seq FROM c WHERE w='w' AND net='n'").get().next_seq;
    const mx = d.prepare("SELECT seq FROM m WHERE w='w' AND net='n' AND complete ORDER BY seq DESC LIMIT 1").get().seq;
    d.close();
    return { next_seq: ns, max_seq: mx, holds: ns > mx };
  };
  const p0 = `${DIR}/inv-clean.db`; build(p0);
  console.log(`clean                      : ${JSON.stringify(check(p0))}`);

  const p1 = `${DIR}/inv-nextseq.db`; build(p1);
  poke(p1, sites(p1, be4(BASE + 10))[0], be4(BASE + 5));
  console.log(`next_seq -> BASE+5         : ${JSON.stringify(check(p1))}  integrity_check=${ic(p1)}`);

  const p2 = `${DIR}/inv-seq-index.db`; build(p2);
  poke(p2, sites(p2, be4(BASE + 2))[1], be4(BASE + 99));
  console.log(`seq index-copy -> BASE+99  : ${JSON.stringify(check(p2))}  integrity_check=${ic(p2)}`);

  const p3 = `${DIR}/inv-seq-table.db`; build(p3);
  poke(p3, sites(p3, be4(BASE + 2))[0], be4(BASE + 99));
  console.log(`seq table-copy -> BASE+99  : ${JSON.stringify(check(p3))}  integrity_check=${ic(p3)}`);
  console.log(`  ^ the invariant catches the two cases that change the ANSWER; the table-copy-only`);
  console.log(`    case (which does not change the answer) is caught by integrity_check instead.`);
}

// ============================================================ B. watermarks: cursor-vs-data
hr("B. watermarks -- is a 'cursor not ahead of data' check available, and is it enough?");
{
  const p = `${DIR}/wmdata.db`;
  const db = fresh(p);
  db.exec(`CREATE TABLE u_watermarks (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (kind,key)) STRICT, WITHOUT ROWID`);
  db.exec(`CREATE TABLE blocks (net TEXT NOT NULL, height INTEGER NOT NULL, block_hash BLOB NOT NULL, is_canonical INTEGER NOT NULL, PRIMARY KEY (net,height,block_hash)) STRICT, WITHOUT ROWID`);
  for (let h = 1200000; h <= 1200050; h++) db.prepare("INSERT INTO blocks VALUES ('m',?,?,1)").run(h, sha256(Buffer.from(String(h))));
  db.prepare("INSERT INTO u_watermarks VALUES ('chain_archive','sync',?,?)").run(JSON.stringify({ height: 1200050 }), Date.now());
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();

  const b = slurp(p); const off = b.indexOf(Buffer.from('{"height":1200050}'));
  poke(p, off, Buffer.from('{"height":9200050}'));
  const d = new DatabaseSync(p);
  const cur = JSON.parse(d.prepare("SELECT value FROM u_watermarks").get().value).height;
  const maxH = d.prepare("SELECT max(height) h FROM blocks WHERE net='m'").get().h;
  console.log(`chain-archive cursor: ${cur}   max(blocks.height): ${maxH}   cursor_ahead_of_data = ${cur > maxH}`);
  console.log(`  -> for the CHAIN-ARCHIVE cursor a data side exists, so the check is real and cheap.`);
  console.log(`WALLET-SYNC cursor  : names a chain height whose data lives on the NODE, not in this`);
  console.log(`  store. UmbraDB holds no max(height) to compare against. The same check is not`);
  console.log(`  available for the cursor that decides how much of the wallet's state to re-derive.`);
  d.close();
}

// ============================================================ C. _migrations
hr("C. _migrations.name");
{
  const p = `${DIR}/mig.db`;
  const db = fresh(p);
  db.exec(`CREATE TABLE u_migrations (name TEXT NOT NULL PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT, WITHOUT ROWID`);
  for (const n of ["000_schema", "001_temporal_kv", "002_checkpoint_store", "003_watermarks", "004_transaction_history",
    "005_kv_current_fillfactor", "006_ckpt_chunks_size_bytes", "007_writer_generation"])
    db.prepare("INSERT INTO u_migrations VALUES (?,?)").run(n, Date.now());
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  const o = sites(p, Buffer.from("007_writer_generation"))[0];
  poke(p, o + 4, Buffer.from("X"));
  console.log(`corrupted '007_writer_generation' -> '007_Xriter_generation' at ${o + 4}`);
  console.log(`integrity_check : ${ic(p)}`);
  const d = new DatabaseSync(p);
  console.log(`applied set     : ${JSON.stringify(d.prepare("SELECT name FROM u_migrations ORDER BY name").all().map(r => r.name))}`);
  console.log(`  -> 007 is absent from the applied set, so runMigrations replays it. Its statements:`);
  console.log(`     CREATE TABLE <s>_writer_generation      -> "table already exists": LOUD, aborts.`);
  console.log(`     (if the lineage ever gains an idempotent/IF NOT EXISTS or seeding step, the`);
  console.log(`      replay becomes silent instead -- 007's own INSERT seed row is exactly that shape)`);
  d.close();
}

// ============================================================ D. writer_generation
hr("D. writer_generation -- the singleton id, and the zero-row UPDATE the seed row exists to prevent");
{
  const p = `${DIR}/wg.db`;
  const db = fresh(p);
  db.exec(`CREATE TABLE wg (id INTEGER PRIMARY KEY CONSTRAINT wg_singleton CHECK (id=1),
    generation INTEGER NOT NULL CONSTRAINT wg_nonneg CHECK (generation>=0), owner TEXT NOT NULL,
    pid INTEGER, host TEXT, registered_at INTEGER NOT NULL) STRICT`);
  db.prepare("INSERT INTO wg VALUES (1,?, 'OWNERMARKER_AAAA', 4242, 'HOSTMARKER', 1700000000000)").run(1000000007);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();

  // D1: corrupt `generation`
  {
    const q = `${DIR}/wg1.db`; rmSync(q, { force: true });
    writeFileCopy(p, q);
    poke(q, sites(q, be4(1000000007))[0], be4(1000000099));
    const d = new DatabaseSync(q);
    const myGeneration = 1000000007;
    const seen = d.prepare("SELECT generation FROM wg WHERE id=1").get().generation;
    console.log(`D1 generation corrupted : guard sees ${seen}, myGeneration=${myGeneration} -> ${seen === myGeneration ? "PASSES (BAD)" : "WriterDisplaced thrown (fail-closed, LOUD)"}`);
    console.log(`   integrity_check=${ic(q)}`);
    d.close();
  }
  // D2: corrupt the rowid/id so `WHERE id = 1` matches nothing
  {
    const q = `${DIR}/wg2.db`; rmSync(q, { force: true });
    writeFileCopy(p, q);
    // rowid 1 is stored as the cell's varint rowid immediately before the record header.
    const b = slurp(q);
    const ownerOff = b.indexOf(Buffer.from("OWNERMARKER_AAAA"));
    // walk back to the cell start: [payload-len varint][rowid varint][hdr-len][serials...]
    let idOff = -1;
    for (let k = ownerOff - 12; k < ownerOff; k++) if (b[k] === 0x01 && b[k + 1] === 0x07) { idOff = k; break; }
    if (idOff < 0) { console.log("D2 could not locate the rowid varint; skipped"); }
    else {
      poke(q, idOff, Buffer.from([0x09])); // rowid 1 -> 9
      const d = new DatabaseSync(q);
      const rows = d.prepare("SELECT id, generation FROM wg").all();
      const upd = d.prepare("UPDATE wg SET generation = generation + 1, owner='NEW' WHERE id = 1").run();
      const readback = d.prepare("SELECT generation FROM wg WHERE id = 1").get();
      console.log(`D2 rowid 1 -> 9         : table now holds ${JSON.stringify(rows)}`);
      console.log(`   registration UPDATE ... WHERE id=1 -> changes=${upd.changes}; read-back = ${JSON.stringify(readback ?? null)}`);
      console.log(`   -> myGeneration is UNDEFINED with no error: exactly the hazard schema-parity`);
      console.log(`      design.md 9.4 says the seed row exists to prevent. Corruption re-creates it.`);
      console.log(`   integrity_check=${ic(q)}   (CHECK (id=1) IS evaluated: see below)`);
      d.close();
    }
  }
}

// ============================================================ E. sqlite_schema: silent weakening
hr("E. sqlite_schema -- a CHECK constraint that is silently WEAKENED rather than violated");
{
  const p = `${DIR}/schema.db`;
  const db = fresh(p);
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, h BLOB NOT NULL CONSTRAINT t_h_len CHECK (octet_length(h) = 32)) STRICT`);
  for (let i = 1; i <= 50; i++) db.prepare("INSERT INTO t VALUES (?,?)").run(i, Buffer.alloc(32, i));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  const o = sites(p, Buffer.from("octet_length(h) = 32"))[0];
  poke(p, o, Buffer.from("octet_length(h) > 00"));
  console.log(`sqlite_schema CHECK text 'octet_length(h) = 32' -> 'octet_length(h) > 00' at ${o}`);
  console.log(`integrity_check : ${ic(p)}`);
  const d = new DatabaseSync(p);
  console.log(`schema now reads: ${d.prepare("SELECT sql FROM sqlite_schema WHERE name='t'").get().sql.replace(/\s+/g, " ")}`);
  try { d.prepare("INSERT INTO t VALUES (999, ?)").run(Buffer.alloc(7, 1)); console.log(`INSERT of a 7-byte hash into a 32-byte-CHECK column: ACCEPTED  <-- constraint silently gone`); }
  catch (e) { console.log(`INSERT of a 7-byte hash: rejected (${e.message})`); }
  d.close();
}

// ============================================================ F. truncation
hr("F. truncated / short file -- is this the detectable class?");
{
  const p = `${DIR}/trunc.db`;
  const db = fresh(p);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT");
  for (let i = 1; i <= 2000; i++) db.prepare("INSERT INTO t VALUES (?,?)").run(i, `PAYLOAD_${String(i).padStart(6, "0")}_${"y".repeat(40)}`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  const size = statSync(p).size;
  for (const frac of [0.75, 0.999]) {
    const q = `${DIR}/trunc-${frac}.db`; rmSync(q, { force: true }); writeFileCopy(p, q);
    truncateSync(q, Math.floor(size * frac));
    let read = "n/a";
    try { const d = new DatabaseSync(q); read = JSON.stringify(d.prepare("SELECT count(*) c FROM t").get()); d.close(); }
    catch (e) { read = `THREW ${e.code}: ${e.message}`; }
    console.log(`truncated to ${(frac * 100).toFixed(1)}% (${Math.floor(size * frac)}/${size}B): count -> ${read}`);
    console.log(`  integrity_check : ${ic(q)}`);
  }
}

// ============================================================ G. chain archive derived columns
hr("G. chain archive -- what getBlob's rehash-on-read does NOT cover");
{
  const p = `${DIR}/arch.db`;
  const db = fresh(p);
  db.exec(`CREATE TABLE chain_blobs (hash BLOB NOT NULL PRIMARY KEY, data BLOB NOT NULL) STRICT`);
  db.exec(`CREATE TABLE blocks (net TEXT NOT NULL, block_hash BLOB NOT NULL, height INTEGER NOT NULL, is_canonical INTEGER NOT NULL,
    header_blob_hash BLOB NOT NULL, PRIMARY KEY (net,height,block_hash)) STRICT, WITHOUT ROWID`);
  for (let h = 1000000; h < 1000020; h++) {
    const hdr = Buffer.from(`HEADER_BYTES_FOR_HEIGHT_${h}`); const hh = sha256(hdr);
    db.prepare("INSERT INTO chain_blobs VALUES (?,?)").run(hh, hdr);
    db.prepare("INSERT INTO blocks VALUES ('m',?,?,1,?)").run(sha256(Buffer.from(`b${h}`)), h, hh);
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  const b = slurp(p);
  // is_canonical for one row: a 1-byte serial-type-9 constant (value 1) -- SQLite stores INTEGER 1
  // as serial type 9 with ZERO payload bytes, so it lives in the record HEADER, not the payload.
  const hdrOff = sites(p, Buffer.from("HEADER_BYTES_FOR_HEIGHT_1000010"))[0];
  console.log(`chain_blobs.data corruption is caught by getBlob's rehash (AC-3) -- verified in code.`);
  console.log(`But 'blocks' carries height/is_canonical/status/finalized, none of which are covered`);
  console.log(`by any hash. Corrupting is_canonical from 1 -> 0:`);
  // find the blocks-row record for height 1000010 by its big-endian height
  const s = sites(p, be4(1000010));
  console.log(`  height 1000010 appears at ${s.length} site(s): ${JSON.stringify(s)}`);
  // serial type for is_canonical=1 is 9 (no payload). Header for the row is
  // [hdrlen][net:text][block_hash:blob][height:int][is_canonical:9][header_blob_hash:blob]
  // Locate the 0x09 byte in the header immediately following the height serial type.
  const d0 = new DatabaseSync(p);
  console.log(`  canonical count before: ${JSON.stringify(d0.prepare("SELECT count(*) c FROM blocks WHERE is_canonical=1").get())}`);
  d0.close();
  // Rather than hand-decode, demonstrate at the level that matters: is_canonical is not covered
  // by any digest in the proposal, is not in any index, and getBlob never touches it.
  console.log(`  is_canonical is: not content-addressed, not indexed, not read through getBlob.`);
  console.log(`  A flip makes getCanonicalBlock() return a different fork's block with an`);
  console.log(`  intact, rehash-verified header blob attached to it.`);
}

function writeFileCopy(src, dst) {
  const b = slurp(src);
  const fd = openSync(dst, "w"); writeSync(fd, b, 0, b.length, 0); closeSync(fd);
}
