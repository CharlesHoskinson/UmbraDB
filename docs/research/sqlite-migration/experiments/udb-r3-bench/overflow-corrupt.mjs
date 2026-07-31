// Cleanest form of the premise: corrupt bytes inside an OVERFLOW page.
// Overflow pages carry a 4-byte next-page pointer followed by pure payload -- no cell headers,
// no pointer array. This is exactly how UmbraDB stores ckpt_chunks.data / chain_blobs.data.
import { DatabaseSync } from "node:sqlite";
import { hash as oneShot } from "node:crypto";
import { unlinkSync, existsSync, openSync, readSync, writeSync, closeSync, statSync } from "node:fs";

const P = "/root/udb-r3-bench/ovf.db";
const rm = (p) => { for (const s of ["", "-wal", "-shm"]) if (existsSync(p + s)) unlinkSync(p + s); };
const sha = (b) => oneShot("sha256", b, "buffer");
rm(P);

const PAGE = 4096;
const N = 40;
const BLOBSZ = 60000;                       // >> page size => guaranteed overflow chain

const d = new DatabaseSync(P);
d.exec(`pragma page_size=${PAGE}`); d.exec("pragma journal_mode=wal"); d.exec("pragma synchronous=FULL");
d.exec("CREATE TABLE chain_blobs (hash BLOB PRIMARY KEY, data BLOB NOT NULL) STRICT");
const ins = d.prepare("insert into chain_blobs(hash,data) values(?,?)");
d.exec("BEGIN IMMEDIATE");
const expect = new Map();
for (let i = 0; i < N; i++) {
  const b = Buffer.alloc(BLOBSZ, 0);
  for (let j = 0; j < BLOBSZ; j += 4) b.writeUInt32BE((i << 20) ^ j, j);   // deterministic, distinctive
  const h = sha(b);
  expect.set(h.toString("hex"), b);
  ins.run(h, b);
}
d.exec("COMMIT");
d.exec("pragma wal_checkpoint(TRUNCATE)");
d.close();

const size = statSync(P).size;
console.log(`db=${size} bytes, page_size=${PAGE}, ${N} blobs of ${BLOBSZ} B (each spans ~${Math.ceil(BLOBSZ / (PAGE - 4))} overflow pages)`);

// Find a byte offset deep inside an overflow page: locate our distinctive pattern, then
// pick an offset comfortably inside a page (away from the 4-byte next-pointer at page start).
const whole = Buffer.alloc(size);
{ const f = openSync(P, "r"); readSync(f, whole, 0, size, 0); closeSync(f); }
const marker = Buffer.alloc(4); marker.writeUInt32BE((7 << 20) ^ 20000);   // blob 7, offset 20000
const hit = whole.indexOf(marker);
const pageIdx = Math.floor(hit / PAGE);
const inPage = hit - pageIdx * PAGE;
console.log(`pattern for blob#7 @ file offset ${hit} -> page ${pageIdx + 1}, byte ${inPage} within page (page starts with the 4-byte next-overflow pointer)`);
const off = pageIdx * PAGE + Math.max(inPage, 1024);   // keep well clear of the page header

const fd = openSync(P, "r+");
const buf = Buffer.alloc(64); readSync(fd, buf, 0, 64, off);
const before = Buffer.from(buf);
for (let i = 0; i < 64; i++) buf[i] ^= 0xff;
writeSync(fd, buf, 0, 64, off); closeSync(fd);
console.log(`corrupted 64 bytes at file offset ${off} (page ${Math.floor(off / PAGE) + 1}, byte ${off % PAGE} in page)`);
console.log(`  before: ${before.subarray(0, 16).toString("hex")}...`);
console.log(`  after : ${buf.subarray(0, 16).toString("hex")}...`);

const e = new DatabaseSync(P);
for (const pr of ["integrity_check", "quick_check"]) {
  try { console.log(`PRAGMA ${pr} -> ${JSON.stringify(e.prepare("pragma " + pr).all())}`); }
  catch (err) { console.log(`PRAGMA ${pr} -> THREW "${err.message}"`); }
}
let rows = 0, mismatched = 0;
for (const r of e.prepare("select hash, data from chain_blobs").iterate()) {
  rows++;
  const want = expect.get(Buffer.from(r.hash).toString("hex"));
  if (!want || !Buffer.from(r.data).equals(want)) mismatched++;
}
console.log(`rows returned: ${rows}; rows whose BLOB bytes differ from what was written: ${mismatched}`);

// Does the content-address (the PK) catch it? This is UmbraDB's existing getBlob() check.
let dgCaught = 0;
for (const r of e.prepare("select hash, data from chain_blobs").iterate()) {
  if (!sha(Buffer.from(r.data)).equals(Buffer.from(r.hash))) dgCaught++;
}
console.log(`rows caught by rehash-vs-primary-key (the existing AC-3 check): ${dgCaught}`);
console.log(dgCaught > 0 && mismatched > 0
  ? "VERDICT: SQLite reported ok and returned corrupted bytes as data; the application digest is the ONLY detector."
  : "VERDICT: this flip did not produce silent content corruption.");
e.close();
