// E3: addressing/ordering columns -- and the index-redundancy rule.
// Uses large integers so their big-endian on-disk encoding is locatable.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { openSync, readSync, writeSync, closeSync, statSync, rmSync } from "node:fs";

const DIR = "/root/corruption-lab";
const sha256 = (b) => createHash("sha256").update(b).digest();
const be4 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const be6 = (n) => { const b = Buffer.alloc(6); b.writeUIntBE(n, 0, 6); return b; };

function fresh(path) {
  for (const s of ["", "-wal", "-shm"]) { try { rmSync(path + s); } catch {} }
  const db = new DatabaseSync(path); db.exec("PRAGMA journal_mode=WAL"); return db;
}
function slurp(p) { const fd = openSync(p, "r"); const n = statSync(p).size; const b = Buffer.alloc(n); readSync(fd, b, 0, n, 0); closeSync(fd); return b; }
function poke(p, off, bytes) { const fd = openSync(p, "r+"); writeSync(fd, bytes, 0, bytes.length, off); closeSync(fd); }
function sites(p, needle) { const b = slurp(p); const out = []; let i = b.indexOf(needle); while (i >= 0) { out.push(i); i = b.indexOf(needle, i + 1); } return out; }
function ic(p) { const d = new DatabaseSync(p); const r = d.prepare("PRAGMA integrity_check").all().map(x => x.integrity_check); d.close(); return r.join("; "); }
function qc(p) { const d = new DatabaseSync(p); const r = d.prepare("PRAGMA quick_check").all().map(x => x.quick_check); d.close(); return r.join("; "); }
const hr = (t) => console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);

// ============================================================ 2. ckpt_sequence_counters.next_seq
hr("2. ckpt_sequence_counters.next_seq -- checkpoint tier, digest fully intact");
{
  const p = `${DIR}/ckpt.db`;
  const BASE = 1000000000;
  function build() {
    const db = fresh(p);
    db.exec(`CREATE TABLE u_ckpt_chunks (hash BLOB NOT NULL PRIMARY KEY, data BLOB NOT NULL, created_at INTEGER NOT NULL) STRICT`);
    db.exec(`CREATE TABLE u_ckpt_manifests (id INTEGER PRIMARY KEY AUTOINCREMENT, w TEXT NOT NULL, net TEXT NOT NULL,
      seq INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0, manifest_hash BLOB NOT NULL, label TEXT, created_at INTEGER NOT NULL) STRICT`);
    db.exec(`CREATE INDEX u_ckpt_manifests_lookup ON u_ckpt_manifests (w,net,complete,seq DESC)`);
    db.exec(`CREATE TABLE u_ckpt_manifest_chunks (manifest_id INTEGER NOT NULL REFERENCES u_ckpt_manifests(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, chunk_hash BLOB NOT NULL REFERENCES u_ckpt_chunks(hash), PRIMARY KEY (manifest_id,position)) STRICT, WITHOUT ROWID`);
    db.exec(`CREATE TABLE u_ckpt_sequence_counters (w TEXT NOT NULL, net TEXT NOT NULL, next_seq INTEGER NOT NULL DEFAULT 2, PRIMARY KEY (w,net)) STRICT, WITHOUT ROWID`);
    db.prepare("INSERT INTO u_ckpt_sequence_counters VALUES ('w','n',?)").run(BASE);
    return db;
  }
  const save = (db, payload) => {
    const data = Buffer.from(payload), h = sha256(data);
    db.prepare("INSERT INTO u_ckpt_chunks VALUES (?,?,?) ON CONFLICT(hash) DO UPDATE SET created_at=excluded.created_at").run(h, data, Date.now());
    const seq = db.prepare(`INSERT INTO u_ckpt_sequence_counters (w,net) VALUES ('w','n')
      ON CONFLICT (w,net) DO UPDATE SET next_seq = u_ckpt_sequence_counters.next_seq + 1
      RETURNING next_seq - 1 AS claimed_seq`).get().claimed_seq;
    const id = db.prepare("INSERT INTO u_ckpt_manifests (w,net,seq,complete,manifest_hash,created_at) VALUES ('w','n',?,1,?,?) RETURNING id")
      .get(seq, sha256(Buffer.concat([h])), Date.now()).id;
    db.prepare("INSERT INTO u_ckpt_manifest_chunks VALUES (?,0,?)").run(id, h);
    return seq;
  };
  const load = (db) => {
    const m = db.prepare("SELECT id,seq,manifest_hash FROM u_ckpt_manifests WHERE w='w' AND net='n' AND complete ORDER BY seq DESC LIMIT 1").get();
    if (!m) return null;
    const rows = db.prepare(`SELECT mc.position, mc.chunk_hash, c.hash, c.data FROM u_ckpt_manifest_chunks mc
      LEFT JOIN u_ckpt_chunks c ON c.hash=mc.chunk_hash WHERE mc.manifest_id=? ORDER BY mc.position`).all(m.id);
    const parts = [], hs = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.position !== i) return { err: "ManifestCorruptError(position)" };
      if (r.hash === null) return { err: "ChunkMissingError" };
      if (!sha256(r.data).equals(Buffer.from(r.chunk_hash))) return { err: "ChunkIntegrityError" };
      parts.push(r.data); hs.push(Buffer.from(r.chunk_hash));
    }
    if (!sha256(Buffer.concat(hs)).equals(Buffer.from(m.manifest_hash))) return { err: "ManifestCorruptError(hash)" };
    return { seq: m.seq, data: Buffer.concat(parts).toString(), allSha256Checks: "PASSED" };
  };

  let db = build();
  for (let i = 0; i < 40; i++) save(db, `ENVELOPE_STATE_AT_BLOCK_${String(i).padStart(6, "0")}`);
  console.log(`before : load() -> ${JSON.stringify(load(db))}`);
  const ns = db.prepare("SELECT next_seq FROM u_ckpt_sequence_counters").get().next_seq;
  console.log(`         next_seq = ${ns}`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();

  const s = sites(p, be4(ns));
  console.log(`next_seq ${ns} appears at ${s.length} site(s) in the file: ${JSON.stringify(s)}  (no index covers it)`);
  poke(p, s[0], be4(BASE + 5));
  console.log(`corrupted 4 bytes at ${s[0]}: next_seq ${ns} -> ${BASE + 5}`);
  console.log(`integrity_check : ${ic(p)}`);
  console.log(`quick_check     : ${qc(p)}`);

  db = new DatabaseSync(p);
  const got = save(db, "ENVELOPE_STATE_AT_BLOCK_000040");
  console.log(`save() -> seq ${got}  (succeeded; there is NO UNIQUE (w,net,seq) on ckpt_manifests)`);
  console.log(`after  : load() -> ${JSON.stringify(load(db))}`);
  console.log(`dupes  : ${JSON.stringify(db.prepare("SELECT seq, count(*) c FROM u_ckpt_manifests GROUP BY seq HAVING c>1").all())}`);
  db.close();
}

// ============================================================ 3. ckpt_manifests.seq, both sites
hr("3. ckpt_manifests.seq -- an INDEXED column: one site vs both sites");
{
  const BASE = 1000000000;
  function build(p) {
    const db = fresh(p);
    db.exec(`CREATE TABLE u_ckpt_manifests (id INTEGER PRIMARY KEY AUTOINCREMENT, w TEXT NOT NULL, net TEXT NOT NULL,
      seq INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0, manifest_hash BLOB NOT NULL, label TEXT, created_at INTEGER NOT NULL) STRICT`);
    db.exec(`CREATE INDEX u_ckpt_manifests_lookup ON u_ckpt_manifests (w,net,complete,seq DESC)`);
    for (let i = 1; i <= 9; i++)
      db.prepare("INSERT INTO u_ckpt_manifests (w,net,seq,complete,manifest_hash,label,created_at) VALUES ('w','n',?,1,?,?,?)")
        .run(BASE + i, sha256(Buffer.from(`m${i}`)), `SEQMARK_${String(i).padStart(3, "0")}`, 1700000000000 + i);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  }
  const latest = (p) => { const d = new DatabaseSync(p); const r = d.prepare("SELECT seq,label FROM u_ckpt_manifests WHERE w='w' AND net='n' AND complete ORDER BY seq DESC LIMIT 1").get(); d.close(); return r; };

  for (const mode of ["table-copy only", "index-copy only", "both copies"]) {
    const p = `${DIR}/ckpt3-${mode.split(" ")[0]}.db`;
    build(p);
    const s = sites(p, be4(BASE + 2));
    const target = mode === "table-copy only" ? [s[0]] : mode === "index-copy only" ? [s[1]] : s;
    for (const o of target) poke(p, o, be4(BASE + 99));
    console.log(`\n[${mode}] seq ${BASE + 2} had ${s.length} sites ${JSON.stringify(s)}; smashed ${JSON.stringify(target)}`);
    console.log(`  integrity_check : ${ic(p)}`);
    console.log(`  quick_check     : ${qc(p)}`);
    console.log(`  latest          : ${JSON.stringify(latest(p))}   (uncorrupted answer: seq ${BASE + 9} / SEQMARK_009)`);
  }
}

// ============================================================ 4. kv_event columns
hr("4. kv_event -- which columns have a redundant index copy, and which do not");
{
  const p = `${DIR}/kv.db`;
  const t0 = 1700000000000;
  function build() {
    const db = fresh(p);
    db.exec(`CREATE TABLE kv_event (ns TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL,
      value TEXT NOT NULL, written_at INTEGER NOT NULL, PRIMARY KEY (ns,scope,key,version)) STRICT`);
    db.exec(`CREATE UNIQUE INDEX kv_event_time ON kv_event (ns,scope,key,written_at)`);
    db.exec(`CREATE VIEW kv_validity AS SELECT ns,scope,key,version,value, written_at AS valid_from,
      LEAD(written_at) OVER (PARTITION BY ns,scope,key ORDER BY version) AS valid_to FROM kv_event`);
    db.exec(`CREATE TRIGGER kv_event_bi BEFORE INSERT ON kv_event BEGIN
      SELECT raise(ABORT,'UB_T4_CLOCK') WHERE NEW.written_at <= coalesce(
        (SELECT written_at FROM kv_event e WHERE e.ns=NEW.ns AND e.scope=NEW.scope AND e.key=NEW.key AND e.version=NEW.version-1), -9223372036854775808);
      END`);
    for (let v = 1; v <= 10; v++)
      db.prepare("INSERT INTO kv_event VALUES ('ns','sc','k',?,?,?)").run(v, JSON.stringify({ marker: `KVVALUE_${String(v).padStart(4, "0")}` }), t0 + v * 1000);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  }
  const at = (t) => { const d = new DatabaseSync(p); const r = d.prepare("SELECT version,value FROM kv_event WHERE ns='ns' AND scope='sc' AND key='k' AND written_at <= ? ORDER BY written_at DESC LIMIT 1").get(t); d.close(); return r; };
  const intervals = () => { const d = new DatabaseSync(p); const r = d.prepare("SELECT version, valid_from-? f, valid_to-? t FROM kv_validity WHERE version BETWEEN 4 AND 6").all(t0, t0); d.close(); return r; };

  build();
  console.log(`site counts: value=${sites(p, Buffer.from("KVVALUE_0005")).length}  written_at(v5)=${sites(p, be6(t0 + 5000)).length}`);
  console.log(`before: getAt(t0+5500) -> ${JSON.stringify(at(t0 + 5500))}`);

  // 4a: value column -- single site, no index
  build();
  const vs = sites(p, Buffer.from("KVVALUE_0005"));
  poke(p, vs[0], Buffer.from("KVVALUE_9999"));
  console.log(`\n[value, ${vs.length} site] integrity_check=${ic(p)}  read-back=${JSON.stringify(at(t0 + 5500))}`);

  // 4b: written_at -- two sites (table + kv_event_time)
  for (const mode of ["table only", "index only", "both"]) {
    build();
    const ws = sites(p, be6(t0 + 5000));
    const tgt = mode === "table only" ? [ws[0]] : mode === "index only" ? [ws[1]] : ws;
    for (const o of tgt) poke(p, o, be6(t0 + 9500));
    console.log(`\n[written_at ${mode}] ${ws.length} sites ${JSON.stringify(ws)} -> smashed ${JSON.stringify(tgt)}`);
    console.log(`  integrity_check : ${ic(p)}`);
    console.log(`  quick_check     : ${qc(p)}`);
    console.log(`  getAt(t0+5500)  : ${JSON.stringify(at(t0 + 5500))}   (uncorrupted: version 5)`);
    console.log(`  kv_validity     : ${JSON.stringify(intervals())}`);
  }
}
