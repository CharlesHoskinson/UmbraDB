// (a) Independent re-verification of the premise: SQLite main-db has no page checksums.
// (b) Forgeability of a bare digest, and the cost of domain separation.
import { DatabaseSync } from "node:sqlite";
import { hash as oneShot, createHash, randomBytes } from "node:crypto";
import { unlinkSync, existsSync, openSync, readSync, writeSync, closeSync, statSync } from "node:fs";

const DIR = "/root/udb-r3-bench";
const rm = (p) => { for (const s of ["", "-wal", "-shm"]) if (existsSync(p + s)) unlinkSync(p + s); };
const sha = (b) => oneShot("sha256", b, "buffer");
const fmt = (n, d = 3) => n.toFixed(d);

// ---------------------------------------------------------------- (a) premise re-check
console.log("## a. Premise re-check: corrupt 64 bytes of a CHECKPOINTED main db");
{
  const P = `${DIR}/corrupt.db`; rm(P);
  const d = new DatabaseSync(P);
  d.exec("pragma page_size=4096"); d.exec("pragma journal_mode=wal"); d.exec("pragma synchronous=FULL");
  d.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT");
  const ins = d.prepare("insert into t(k,v) values(?,?)");
  d.exec("BEGIN IMMEDIATE");
  for (let i = 0; i < 500; i++) ins.run(i, "SENTINEL-VALUE-" + String(i).padStart(6, "0") + "-" + "x".repeat(60));
  d.exec("COMMIT");
  d.exec("pragma wal_checkpoint(TRUNCATE)");
  const before = d.prepare("select v from t where k=250").get().v;
  d.close();

  // Two corruption sites, to separate STRUCTURE from CONTENT.
  const size = statSync(P).size;
  const whole = Buffer.alloc(size);
  { const f = openSync(P, "r"); readSync(f, whole, 0, size, 0); closeSync(f); }
  const needle = Buffer.from("SENTINEL-VALUE-000250-");
  const contentOff = whole.indexOf(needle) + needle.length;   // inside row k=250's TEXT payload
  const sites = [
    ["CELL CONTENT (inside row k=250's TEXT value)", contentOff],
    ["arbitrary mid-file offset (likely page structure)", Math.floor(size / 2)],
  ];
  for (const [what, off] of sites) {
    // restore a pristine copy each time
    { const f = openSync(P, "r+"); writeSync(f, whole, 0, size, 0); closeSync(f); }
    const fd = openSync(P, "r+");
    const buf = Buffer.alloc(64); readSync(fd, buf, 0, 64, off);
    for (let i = 0; i < 64; i++) buf[i] = 0x5a;
    writeSync(fd, buf, 0, 64, off); closeSync(fd);
    console.log(`\n   --- corrupted 64 bytes at offset ${off}/${size}: ${what}`);
    const e = new DatabaseSync(P);
    for (const pr of ["integrity_check", "quick_check"]) {
      try { console.log(`   PRAGMA ${pr} -> ` + JSON.stringify(e.prepare("pragma " + pr).all()).slice(0, 120)); }
      catch (err) { console.log(`   PRAGMA ${pr} -> THREW "${err.message}"`); }
    }
    let changed = 0, sample = null;
    try {
      for (const r of e.prepare("select k, v from t").iterate()) {
        const want = "SENTINEL-VALUE-" + String(r.k).padStart(6, "0") + "-" + "x".repeat(60);
        if (r.v !== want) { changed++; if (!sample) sample = { k: r.k, got: r.v.slice(0, 46) }; }
      }
    } catch (err) { console.log(`   full scan THREW "${err.message}"`); }
    console.log(`   rows returned whose TEXT differs from what was written: ${changed}` + (sample ? `  e.g. k=${sample.k} got ${JSON.stringify(sample.got)}` : ""));
    const dgCatches = changed > 0;
    console.log(`   an application digest over the value catches it: ${dgCatches ? "YES" : "n/a (no row payload altered)"}`);
    e.close();
  }
  rm(P);
}

// ---------------------------------------------------------------- (b) forgeability
console.log("\n## b. Forgeability of a BARE digest sha256(value)");
{
  const P = `${DIR}/forge.db`; rm(P);
  const d = new DatabaseSync(P);
  d.exec("pragma journal_mode=wal");
  d.exec("CREATE TABLE kv (ns TEXT, scope TEXT, key TEXT, value TEXT NOT NULL, dg BLOB NOT NULL, PRIMARY KEY(ns,scope,key)) STRICT");
  const ins = d.prepare("insert into kv values(?,?,?,?,?)");
  // two DIFFERENT keys that legitimately hold the SAME value -- extremely common (empty state,
  // default config, a zeroed balance, `{}`)
  const v = JSON.stringify({ balance: 0, utxos: [] });
  ins.run("wallet", "alice", "state", v, sha(Buffer.from(v)));
  ins.run("wallet", "mallory", "state", v, sha(Buffer.from(v)));
  const alice = JSON.stringify({ balance: 1000000, utxos: ["u1"] });
  d.prepare("update kv set value=?, dg=? where key='state' and scope='alice'").run(alice, sha(Buffer.from(alice)));
  // Now: swap alice's row payload with mallory's, digest and all. Bare digest verifies fine.
  const a = d.prepare("select value,dg from kv where scope='alice'").get();
  const m = d.prepare("select value,dg from kv where scope='mallory'").get();
  d.exec("BEGIN IMMEDIATE");
  d.prepare("update kv set value=?, dg=? where scope='alice'").run(m.value, m.dg);
  d.exec("COMMIT");
  const back = d.prepare("select value,dg from kv where scope='alice'").get();
  const ok = sha(Buffer.from(back.value)).equals(Buffer.from(back.dg));
  console.log(`   alice's value replaced by mallory's row (a whole-row substitution)`);
  console.log(`   bare digest sha256(value) verifies?  ${ok ? "YES -- CORRUPTION UNDETECTED" : "no"}`);

  // domain-separated preimage
  const ds = (table, pk, col, val) => {
    const h = createHash("sha256");
    h.update(Buffer.from([0x01]));                      // version
    const parts = [table, ...pk, col];
    for (const p of parts) { const b = Buffer.from(p, "utf8"); const L = Buffer.alloc(4); L.writeUInt32BE(b.length); h.update(L); h.update(b); }
    const vb = Buffer.isBuffer(val) ? val : Buffer.from(val, "utf8");
    const L = Buffer.alloc(4); L.writeUInt32BE(vb.length); h.update(L); h.update(vb);
    return h.digest();
  };
  const dgA = ds("kv", ["wallet", "alice", "state"], "value", a.value);
  const dgM = ds("kv", ["wallet", "mallory", "state"], "value", m.value);
  console.log(`   domain-separated digests differ for the same value in different rows: ${!dgA.equals(dgM)}`);
  const dgSame1 = ds("kv", ["wallet", "alice", "state"], "value", v);
  const dgSame2 = ds("kv", ["wallet", "mallory", "state"], "value", v);
  console.log(`   two rows with IDENTICAL values still get different digests: ${!dgSame1.equals(dgSame2)}`);
  console.log(`   after the same substitution, domain-separated digest verifies? ${ds("kv", ["wallet","alice","state"], "value", m.value).equals(dgM) ? "YES (bug)" : "no -- CORRUPTION DETECTED"}`);
  d.close(); rm(P);
}

// ---------------------------------------------------------------- (c) cost of domain separation
console.log("\n## c. Cost of the domain-separated preimage vs a bare hash (us/op)");
function bench(fn, n = 200000) {
  for (let i = 0; i < 2000; i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn();
  return Number(process.hrtime.bigint() - t0) / 1e3 / n;
}
const dsStream = (table, pk, col, vb) => {
  const h = createHash("sha256");
  h.update(Buffer.from([0x01]));
  for (const p of [table, ...pk, col]) { const b = Buffer.from(p, "utf8"); const L = Buffer.alloc(4); L.writeUInt32BE(b.length); h.update(L); h.update(b); }
  const L = Buffer.alloc(4); L.writeUInt32BE(vb.length); h.update(L); h.update(vb);
  return h.digest();
};
// precomputed tag: the table/column/pk framing is stable per prepared statement; only the pk
// varies per row, so the constant prefix can be built once.
const mkPrefix = (table, col) => {
  const chunks = [Buffer.from([0x01])];
  for (const p of [table, col]) { const b = Buffer.from(p, "utf8"); const L = Buffer.alloc(4); L.writeUInt32BE(b.length); chunks.push(L, b); }
  return Buffer.concat(chunks);
};
const PREFIX = mkPrefix("kv_current", "value");
const dsFast = (pkBuf, vb) => {
  const h = createHash("sha256");
  h.update(PREFIX); const L = Buffer.alloc(8);
  L.writeUInt32BE(pkBuf.length, 0); L.writeUInt32BE(vb.length, 4);
  h.update(L); h.update(pkBuf); h.update(vb);
  return h.digest();
};
console.log("| value size | bare oneShot | bare createHash | domain-sep (naive) | domain-sep (prefix cached) | DS overhead |");
console.log("|---|---:|---:|---:|---:|---:|");
for (const [lbl, size] of [["64 B", 64], ["256 B", 256], ["2 KB", 2048], ["5893 B p50", 5893], ["29158 B p99", 29158]]) {
  const vb = randomBytes(size);
  const pkBuf = Buffer.from("wallet alice state", "utf8");
  const n = size > 10000 ? 30000 : 200000;
  const a = bench(() => sha(vb), n);
  const b = bench(() => createHash("sha256").update(vb).digest(), n);
  const c = bench(() => dsStream("kv_current", ["wallet", "alice", "state"], "value", vb), n);
  const e = bench(() => dsFast(pkBuf, vb), n);
  console.log(`| ${lbl} | ${fmt(a)} | ${fmt(b)} | ${fmt(c)} | ${fmt(e)} | +${fmt(e - a)} us |`);
}
