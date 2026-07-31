import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { openSync, readSync, writeSync, closeSync, statSync, rmSync } from "node:fs";
const DIR = "/root/corruption-lab";
const sha256 = (b) => createHash("sha256").update(b).digest();
const be4 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
function fresh(p) { for (const s of ["", "-wal", "-shm"]) { try { rmSync(p + s); } catch {} } const d = new DatabaseSync(p); d.exec("PRAGMA journal_mode=WAL"); return d; }
function slurp(p) { const fd = openSync(p, "r"); const n = statSync(p).size; const b = Buffer.alloc(n); readSync(fd, b, 0, n, 0); closeSync(fd); return b; }
function poke(p, o, b) { const fd = openSync(p, "r+"); writeSync(fd, b, 0, b.length, o); closeSync(fd); }
function sites(p, needle) { const b = slurp(p); const out = []; let i = b.indexOf(needle); while (i >= 0) { out.push(i); i = b.indexOf(needle, i + 1); } return out; }
function ic(p) { try { const d = new DatabaseSync(p); const r = d.prepare("PRAGMA integrity_check").all().map(x => x.integrity_check); d.close(); return r.slice(0, 3).join("; ") + (r.length > 3 ? ` (+${r.length - 3})` : ""); } catch (e) { return `THREW ${e.code}`; } }
const hr = (t) => console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);

// ============================================================ G. blocks.is_canonical
hr("G. blocks.is_canonical -- a 1-bit flip on a column no hash covers");
{
  const p = `${DIR}/arch.db`;
  const db = fresh(p);
  db.exec(`CREATE TABLE chain_blobs (hash BLOB NOT NULL PRIMARY KEY, data BLOB NOT NULL) STRICT`);
  db.exec(`CREATE TABLE blocks (net TEXT NOT NULL, height INTEGER NOT NULL, block_hash BLOB NOT NULL,
    is_canonical INTEGER NOT NULL, header_blob_hash BLOB NOT NULL, PRIMARY KEY (net,height,block_hash)) STRICT, WITHOUT ROWID`);
  const H = 1000000000;
  for (let i = 0; i < 20; i++) {
    const h = H + i;
    // two competing blocks at the fork height, one canonical
    const mk = (tag, canon) => {
      const hdr = Buffer.from(`HEADERBYTES_${tag}_${h}`); const hh = sha256(hdr);
      db.prepare("INSERT INTO chain_blobs VALUES (?,?)").run(hh, hdr);
      db.prepare("INSERT INTO blocks VALUES ('m',?,?,?,?)").run(h, sha256(Buffer.from(tag + h)), canon, hh);
    };
    mk("A", 1); if (i === 10) mk("B", 0);
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  const canonOf = (q) => { const d = new DatabaseSync(q); const r = d.prepare("SELECT height, hex(substr(block_hash,1,4)) bh, is_canonical FROM blocks WHERE net='m' AND height=? ORDER BY bh").all(H + 10); const c = d.prepare("SELECT count(*) c FROM blocks WHERE is_canonical=1").get().c; d.close(); return { rows: r, canonicalCount: c }; };
  console.log(`before: ${JSON.stringify(canonOf(p))}`);
  // Locate the record payload for height H+10 and flip the is_canonical serial type in its header.
  const b = slurp(p);
  const hs = sites(p, be4(H + 10));
  let done = 0;
  for (const ho of hs) {
    // header immediately precedes payload: [hdrlen][st_net][st_height][st_blockhash][st_canon][st_hdrblob]
    for (let k = ho - 8; k < ho; k++) {
      if (b[k] === 0x06 && b[k + 1] === 0x0f && b[k + 2] === 0x04) { // hdrlen=6, text(1), int32
        const canonByte = k + 4;
        if (b[canonByte] === 0x09 || b[canonByte] === 0x08) {
          poke(p, canonByte, Buffer.from([b[canonByte] === 0x09 ? 0x08 : 0x09]));
          console.log(`flipped is_canonical serial type at ${canonByte} (0x0${b[canonByte]} -> 0x0${b[canonByte] === 9 ? 8 : 9})`);
          done++;
        }
      }
    }
    if (done) break;
  }
  if (!done) console.log("!! could not locate the is_canonical serial-type byte");
  else {
    console.log(`integrity_check : ${ic(p)}`);
    console.log(`after : ${JSON.stringify(canonOf(p))}`);
    console.log(`  ^ 1 byte, no index copy, no content-address. getBlob() on the attached header`);
    console.log(`    still passes its SHA-256 rehash: the BLOB is fine, the CLASSIFICATION is not.`);
  }
}

// ============================================================ H. transaction_history redundancy
hr("H. transaction_history_identifiers -- the redundancy that already exists in `entry`");
{
  const p = `${DIR}/th.db`;
  const db = fresh(p);
  db.exec(`CREATE TABLE u_th (wallet_id TEXT NOT NULL, tx_hash TEXT NOT NULL, entry TEXT NOT NULL,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('pending','finalized','rejected')), updated_at INTEGER NOT NULL,
    PRIMARY KEY (wallet_id,tx_hash)) STRICT, WITHOUT ROWID`);
  db.exec(`CREATE TABLE u_th_ident (wallet_id TEXT NOT NULL, tx_hash TEXT NOT NULL, identifier TEXT NOT NULL,
    PRIMARY KEY (wallet_id,tx_hash,identifier), FOREIGN KEY (wallet_id,tx_hash) REFERENCES u_th(wallet_id,tx_hash) ON DELETE CASCADE) STRICT, WITHOUT ROWID`);
  db.exec(`CREATE INDEX u_th_ident_rev ON u_th_ident (wallet_id, identifier, tx_hash)`);
  const ids = ["IDENTIFIER_AAAA", "IDENTIFIER_BBBB"];
  db.prepare("INSERT INTO u_th VALUES (?,?,?,?,?)").run("w1", "tx1",
    JSON.stringify({ txHash: "tx1", identifiers: ids, lifecycle: { status: "pending" } }), "pending", 1700000000000);
  for (const i of ids) db.prepare("INSERT INTO u_th_ident VALUES ('w1','tx1',?)").run(i);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  const s = sites(p, Buffer.from("IDENTIFIER_AAAA"));
  console.log(`'IDENTIFIER_AAAA' appears at ${s.length} sites (entry JSON + junction PK + reverse index): ${JSON.stringify(s)}`);
  poke(p, s[1], Buffer.from("IDENTIFIER_ZZZZ")); // junction PK copy only
  console.log(`corrupted the junction PK copy only, at ${s[1]}`);
  console.log(`integrity_check : ${ic(p)}`);
  const d = new DatabaseSync(p);
  console.log(`entry.identifiers    : ${JSON.stringify(JSON.parse(d.prepare("SELECT entry FROM u_th").get().entry).identifiers)}`);
  console.log(`junction identifiers : ${JSON.stringify(d.prepare("SELECT identifier FROM u_th_ident ORDER BY identifier").all().map(r => r.identifier))}`);
  d.close();
}

// ============================================================ I. WAL boundary
hr("I. WAL frame checksums -- confirming the exposure window starts at checkpoint");
{
  const p = `${DIR}/wal2.db`;
  for (const s of ["", "-wal", "-shm"]) { try { rmSync(p + s); } catch {} }
  const db = new DatabaseSync(p);
  db.exec("PRAGMA journal_mode=WAL"); db.exec("PRAGMA wal_autocheckpoint=0");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT");
  for (let i = 1; i <= 200; i++) db.prepare("INSERT INTO t VALUES (?,?)").run(i, `WALPAYLOAD_${String(i).padStart(6, "0")}`);
  const wal = p + "-wal";
  console.log(`main=${statSync(p).size}B  wal=${statSync(wal).size}B (uncheckpointed)`);
  const wb = slurp(wal); const off = wb.indexOf(Buffer.from("WALPAYLOAD_000150"));
  console.log(`corrupting 'WALPAYLOAD_000150' inside the -wal at offset ${off}`);
  poke(wal, off + 11, Buffer.from("999999"));
  const d2 = new DatabaseSync(p);
  let n = 0, bad = 0, err = null;
  try { for (const r of d2.prepare("SELECT id,v FROM t").all()) { n++; if (r.v !== `WALPAYLOAD_${String(r.id).padStart(6, "0")}`) bad++; } }
  catch (e) { err = `${e.code}: ${e.message}`; }
  console.log(`second reader over the corrupted WAL: rows=${n} corrupted=${bad} err=${err}`);
  console.log(`  (SQLite validates each frame's two checksums; frames from the damaged one onward`);
  console.log(`   are treated as not-committed, so the reader sees a shorter, CONSISTENT history.)`);
  d2.close(); db.close();
}

// ============================================================ J. digest co-located with its value
hr("J. Is a digest stored next to its value still useful? (the 'same event damages both' worry)");
{
  const p = `${DIR}/dg.db`;
  const db = fresh(p);
  db.exec("CREATE TABLE t (k TEXT NOT NULL PRIMARY KEY, v TEXT NOT NULL, digest BLOB NOT NULL) STRICT, WITHOUT ROWID");
  for (let i = 1; i <= 400; i++) {
    const v = JSON.stringify({ i, pad: "VALUEPAYLOAD_" + String(i).padStart(6, "0") + "_" + "p".repeat(30) });
    db.prepare("INSERT INTO t VALUES (?,?,?)").run(`k${String(i).padStart(4, "0")}`, v, sha256(Buffer.from(v)));
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  for (const width of [4, 64, 512, 4096]) {
    const q = `${DIR}/dg-${width}.db`; const b = slurp(p);
    const fd = openSync(q, "w"); writeSync(fd, b, 0, b.length, 0); closeSync(fd);
    const vo = sites(q, Buffer.from("VALUEPAYLOAD_000200"))[0];
    poke(q, vo, Buffer.alloc(width, 0x5a));
    let checked = 0, mism = 0, unread = 0;
    let icr = ic(q);
    try {
      const d = new DatabaseSync(q);
      for (const r of d.prepare("SELECT k,v,digest FROM t").all()) {
        checked++;
        try { if (!sha256(Buffer.from(r.v)).equals(Buffer.from(r.digest))) mism++; } catch { unread++; }
      }
      d.close();
    } catch (e) { unread = -1; }
    console.log(`smash ${String(width).padStart(4)}B at ${vo}: rows=${checked} digest-MISMATCH=${mism} unreadable=${unread}  integrity_check=${icr}`);
  }
  console.log(`  ^ co-location does not defeat the digest: a smear that damages value and digest`);
  console.log(`    together still fails the comparison. It would only defeat it if the corruption`);
  console.log(`    were a coherent rewrite of BOTH -- i.e. a second valid (value,SHA-256) pair.`);
}
