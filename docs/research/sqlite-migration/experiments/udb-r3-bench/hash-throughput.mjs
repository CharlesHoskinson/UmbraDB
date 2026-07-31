// Hash throughput on this host. Pure CPU; no I/O. Node 24.18.
import { hash as oneShotHash, createHash, randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";

const SIZES = [
  ["41 B (archive min blob)", 41],
  ["256 B (small jsonb)", 256],
  ["2 KB (typical jsonb)", 2048],
  ["5893 B (archive p50)", 5893],
  ["11987 B (archive p90)", 11987],
  ["29158 B (archive p99)", 29158],
  ["145167 B (archive max)", 145167],
  ["4 MiB (ckpt DEFAULT_CHUNK_SIZE)", 4 * 1024 * 1024],
];

const ALGOS = [
  ["sha256", (b) => oneShotHash("sha256", b, "buffer")],
  ["sha512", (b) => oneShotHash("sha512", b, "buffer")],
  ["blake2b512", (b) => oneShotHash("blake2b512", b, "buffer")],
  ["blake2s256", (b) => oneShotHash("blake2s256", b, "buffer")],
  ["sha1", (b) => oneShotHash("sha1", b, "buffer")],
  ["md5", (b) => oneShotHash("md5", b, "buffer")],
  ["crc32(zlib)", (b) => crc32(b)],
  ["sha256-createHash", (b) => createHash("sha256").update(b).digest()],
];

function bench(fn, buf, targetMs = 400) {
  // warm
  for (let i = 0; i < 200; i++) fn(buf);
  let n = 64;
  for (;;) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) fn(buf);
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    if (dt >= targetMs || n > 40_000_000) {
      return { nsPerOp: (dt * 1e6) / n, opsPerSec: (n / dt) * 1000, iters: n, ms: dt };
    }
    n = Math.max(n * 2, Math.ceil((n * targetMs) / Math.max(dt, 0.01)));
  }
}

console.log("node", process.version, "| arch", process.arch, "|", process.platform);
console.log(
  "| size | algo | ns/op | ops/s | MB/s |",
);
console.log("|---|---|---:|---:|---:|");
for (const [label, size] of SIZES) {
  const buf = randomBytes(size);
  for (const [name, fn] of ALGOS) {
    // 4 MiB x md5/sha1 etc still fine; keep target lower for the big one
    const r = bench(fn, buf, size >= 1 << 20 ? 300 : 400);
    const mbs = (size / (r.nsPerOp / 1e9)) / 1e6;
    console.log(
      `| ${label} | ${name} | ${r.nsPerOp.toFixed(0)} | ${Math.round(r.opsPerSec).toLocaleString("en-US")} | ${mbs.toFixed(0)} |`,
    );
  }
}
