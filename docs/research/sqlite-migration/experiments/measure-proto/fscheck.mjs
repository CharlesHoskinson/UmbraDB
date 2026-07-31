// Prototype: is the measurement target on a memory-backed filesystem?
// Three independent checks. Any one of them saying "memory-backed" is a refusal.
import { statfsSync, realpathSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// statfs f_type magic numbers (linux/magic.h)
const MAGIC = {
  0x01021994: "tmpfs",
  0x858458f6: "ramfs",
  0x1cd1: "devtmpfs?", // devtmpfs reports tmpfs magic in practice
  0xef53: "ext2/3/4",
  0x9123683e: "btrfs",
  0x58465342: "xfs",
  0x2fc12fc1: "zfs",
  0x794c7630: "overlayfs",
  0x01021997: "v9fs (9p)",
  0x6969: "nfs",
  0x4d44: "vfat/msdos",
  0x5346544e: "ntfs",
  0xf15f: "ecryptfs",
  0x958458f6: "hugetlbfs",
};
const MEMORY_MAGICS = new Set([0x01021994, 0x858458f6, 0x958458f6]);
const MEMORY_FSTYPES = new Set(["tmpfs", "ramfs", "devtmpfs", "hugetlbfs"]);

// ---- check 1: /proc/self/mountinfo, longest-prefix mount resolution ----
function mountFor(path) {
  const real = realpathSync(path);
  const lines = readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n");
  let best = null;
  for (const line of lines) {
    // ... <mountpoint is field 5> ... " - " <fstype> <source> <superopts>
    const [pre, post] = line.split(" - ");
    const pf = pre.split(" ");
    const mountPoint = pf[4];
    const mountOpts = pf[5];
    const sf = post.split(" ");
    const fstype = sf[0], source = sf[1], superOpts = sf[2];
    const isPrefix = real === mountPoint || real.startsWith(mountPoint === "/" ? "/" : mountPoint + "/");
    if (isPrefix && (!best || mountPoint.length > best.mountPoint.length)) {
      best = { mountPoint, fstype, source, mountOpts, superOpts };
    }
  }
  return best;
}

// ---- check 2: statfs magic ----
function statfsInfo(path) {
  const s = statfsSync(path);
  const magic = Number(s.type);
  return { magic, magicHex: "0x" + magic.toString(16), name: MAGIC[magic] ?? "unknown", sizeBytes: Number(s.blocks) * Number(s.bsize) };
}

// ---- check 3: behavioural — does an fsync'd write reach a block device? ----
function diskstatsSectors() {
  const out = new Map();
  for (const line of readFileSync("/proc/diskstats", "utf8").trim().split("\n")) {
    const f = line.trim().split(/\s+/);
    // field 3 = device name, field 10 (idx 9) = sectors written
    out.set(f[2], Number(f[9]));
  }
  return out;
}
function writeReachesDisk(dir, bytes = 32 * 1024 * 1024) {
  const before = diskstatsSectors();
  const p = join(dir, `.fscheck-${process.pid}.bin`);
  const buf = Buffer.alloc(1024 * 1024, 0x5a);
  const fd = openSync(p, "w");
  try {
    for (let i = 0; i < bytes / buf.length; i++) {
      // vary content so a dedup/compress layer cannot elide the write
      buf.writeUInt32LE(i, 0); buf.writeUInt32LE(Math.random() * 2 ** 32, 4);
      writeSync(fd, buf);
    }
    fsyncSync(fd);
  } finally { closeSync(fd); unlinkSync(p); }
  const after = diskstatsSectors();
  let deltaSectors = 0;
  const per = {};
  for (const [dev, v] of after) {
    const d = v - (before.get(dev) ?? 0);
    if (d > 0) { per[dev] = d; deltaSectors += d; }
  }
  return { deltaSectors, deltaBytesApprox: deltaSectors * 512, wroteBytes: bytes, perDevice: per };
}

// ---- also: fsync cost, recorded but NOT used as a gate ----
function fsyncCostMs(dir, n = 50) {
  const p = join(dir, `.fscheck-sync-${process.pid}.bin`);
  const fd = openSync(p, "w");
  const b = Buffer.alloc(4096, 1);
  const samples = [];
  try {
    for (let i = 0; i < n; i++) {
      b.writeUInt32LE(i, 0);
      writeSync(fd, b, 0, b.length, i * 4096);
      const t0 = process.hrtime.bigint();
      fsyncSync(fd);
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  } finally { closeSync(fd); unlinkSync(p); }
  samples.sort((a, b) => a - b);
  return { n, p50: samples[Math.floor(n * 0.5)], p99: samples[Math.floor(n * 0.99)] };
}

const target = process.argv[2] ?? process.cwd();
const mount = mountFor(target);
const sf = statfsInfo(target);
const disk = writeReachesDisk(target);
const fsync = fsyncCostMs(target);

const verdict = {
  target,
  mount,
  statfs: sf,
  diskstats: disk,
  fsync,
  ramBytes: Number(/MemTotal:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"))[1]) * 1024,
  memoryBackedBy: {
    mountinfo: MEMORY_FSTYPES.has(mount?.fstype),
    statfsMagic: MEMORY_MAGICS.has(sf.magic),
    noDiskIO: disk.deltaSectors === 0,
  },
};
verdict.REFUSE = Object.values(verdict.memoryBackedBy).some(Boolean);
console.log(JSON.stringify(verdict, null, 2));
