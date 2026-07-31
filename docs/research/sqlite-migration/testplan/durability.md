# Verification plan — lane `durability`

Crash semantics, durability, corruption detection, backup/restore, snapshots, and the evidence
artifacts that record them.

Subject: `\\wsl.localhost\Ubuntu-26.04\root\UDB-sqlite-sprint`, branch `sprint/sqlite-migration`.
Changes read in full: `v1.0.0-sqlite-durability-contract` (5), `v1.0.0-sqlite-chain-archive` (6),
`v1.0.0-sqlite-engine-core` (1); plus `docs/CONTRACT.md`, `docs/durability-contract.md`,
`docs/recovery/EVIDENCE.md`, `docs/checkpoint-store-contract.md`, `src/postgres/durability-probe.ts`.

Requirements are cited **by title**, never by line number (the sprint measured a 41% mis-anchor rate).

---

## 0. Measurements taken while writing this plan

Seven questions in this lane were open in a way that changed what the tests must assert. I settled
them on the ruled binding rather than assuming. Every command and its verbatim output is below; the
findings are used throughout §2–§6, and **three of them correct a premise this lane was handed**.

Conditions for all of §0: host `/root` = **ext4** on `/dev/sdd` (1007 G, 40% used) — *not* `/tmp`,
which is a 32 GB tmpfs on this host; `better-sqlite3@13.0.2` unpacked at `/tmp/l3-bs3b` (code, not
data — no I/O measured from there); `sqlite_version()` **3.53.4**; Node **v24.18.0**; `page_size`
4096; `journal_mode` as stated per probe; `synchronous=FULL` where a write path is exercised;
datasets ≤ 12 MB, i.e. entirely in page cache — **so none of §0 is a performance figure and none of
it may become a threshold.** These are behavioural facts (page role, pragma verdict, function arity,
syscall presence), which is the only class of result §0 claims.

Scripts live at `/root/umbradb-sqlite-research/probe-*.mjs`.

### 0.1 Overflow-page injection can be made deterministic — `dbstat` is compiled in

```
$ wsl -e bash -lc 'cd /root/umbradb-sqlite-research && node probe-overflow.mjs'
sqlite_version   : 3.53.4
page_size        : 4096
dbstat           : PRESENT
DBSTAT compile   : ENABLE_DBSTAT_VTAB
dbstat page mix  : {"internal":1,"overflow":156,"leaf":39}
overflow pages   : 156 first pageno = 3
```

`ENABLE_DBSTAT_VTAB` is present in the pinned build. `SELECT pageno, pagetype, path FROM dbstat
WHERE name=?` enumerates every page of a named table **by role**. This is the mechanism that makes
the corruption fixtures deterministic instead of "corrupt bytes at random and hope": the harness
selects a page whose `pagetype` is exactly `'overflow'` (Class A payload) or exactly `'leaf'` /
`'internal'` (Class C/structural), and the test then *knows* which case it exercised.

`dbstat` is a **fixture-only** dependency. It must not appear in `src/`, and DUR-G7 asserts that.

### 0.2 The two-case result, reproduced on the ruled binding

```
$ wsl -e bash -lc 'cd /root/umbradb-sqlite-research && node probe-overflow2.mjs'
sqlite_version : 3.53.4
overflow pages : 80 | sample path: "/000/000+000000"
leaf pages     : 20
injected 64B 0x5A at overflow page 7, file offset 24676 (was 4141414141414141)
integrity_check: [{"integrity_check":"ok"}]
quick_check    : [{"quick_check":"ok"}]
full scan      : 20 rows, 1 rows containing injected 0x5A bytes, threw: null

[structural] page 6 header cell-count clobbered
[structural] integrity_check: SqliteError: database disk image is malformed  (code SQLITE_CORRUPT)
```

Payload-byte damage in an overflow page: **both pragmas report `ok`, the scan completes, and exactly
one row carries the injected bytes back to the caller as data.** Structural damage: caught.

**Finding that changes a test's shape.** On the structural fixture, `PRAGMA integrity_check`
**throws** `SqliteError { code: 'SQLITE_CORRUPT' }` rather than returning a row list containing a
non-`ok` string. A test written as `expect(rows[0].integrity_check).not.toBe('ok')` fails to compile
the case at all — it throws before the assertion. Every structural-case assertion in §2 is written to
accept **either** observable and to assert on `code === 'SQLITE_CORRUPT'` in the throwing branch.

**Second finding, for the fixture builder.** File offset ≠ value offset. Overflow pages carry a
4-byte big-endian next-page pointer at their head, and the first ~`usable-35` bytes of the value live
inline in the leaf cell. A harness that computes "corrupt byte *k* of the value" by adding *k* to the
marker's file offset lands somewhere else. The correct rule, and the one DUR-F1 implements: pick an
overflow `pageno` from `dbstat`, and write at `(pageno-1)*page_size + j` for `j ≥ 4`.

### 0.3 `quick_check` is **not** uniformly blind — the brief's premise is too strong

This lane was handed "`quick_check` returned `ok` in six of six index-vs-table divergences where
`integrity_check` fired." I could not reproduce that as a general property, and the difference
decides which fixture the negative control must use.

```
$ wsl -e bash -lc 'cd /root/umbradb-sqlite-research && node probe-indexdiv2.mjs'

=== (a) COUNT divergence — extra table row, no index entry ===
  integrity_check: [{"integrity_check":"wrong # of entries in index ix"},
                    {"integrity_check":"row 501 missing from index ix"}]
  quick_check    : [{"quick_check":"wrong # of entries in index ix"}]
  lookup 'val_ORPHAN' via index: [] | via scan: [{"id":9999}]
  count via index: 500 | count via scan: 501

=== (b) CONTENT divergence — same entry count, stale index key ===
  integrity_check: [{"integrity_check":"row 250 missing from index ix"}]
  quick_check    : [{"quick_check":"ok"}]
  lookup 'val_MOVED' via index: [] | via scan: [{"id":250}]
  count via index: 500 | count via scan: 500

=== (b) same file, probing the STALE key ===
  integrity_check: [{"integrity_check":"row 250 missing from index ix"}]
  quick_check    : [{"quick_check":"ok"}]
  lookup 'val_00250' via index: [{"id":250}] | via scan: []
```

`quick_check` **caught** the count divergence. It returned `ok` only on the content divergence, where
entry counts agree and one index key is stale. That matches SQLite's documented scope — `quick_check`
omits exactly the index-content-versus-table-content comparison — and it means:

- The **count-divergence fixture is a false negative control.** A plan that plants it and asserts
  `quick_check === 'ok'` fails, and a plan that plants it and asserts only "the two disagree" passes
  for the wrong reason. The spec's prohibition on `quick_check` survives intact; the *evidence* for it
  must be the content-divergence fixture.
- Case (b) is also a **sharper Class B demonstration** than "a row goes missing": the indexed lookup
  returns row 250 for the stale key `val_00250` **that the table no longer holds**, and returns
  nothing for `val_MOVED` that it does. Wrong row *and* no row, from one fault. The row's bytes are
  intact, so a digest over them verifies clean — which is the whole of change 5's Class B argument,
  now executable.

The plan therefore specifies **both** fixtures, with different assertions, and treats them as
non-interchangeable (DUR-C10 / DUR-NC7).

**Harness fact.** Building either fixture requires `db.unsafeMode(true)` before
`PRAGMA writable_schema=ON`; without it the schema write fails with
`SqliteError: table sqlite_master may not be modified (SQLITE_ERROR)`. `unsafeMode` **is** on the
ruled binding's prototype (§0.5), so this is available. Change 5's precondition P2 lists
`enableDefensive` as verified absent — that is true of the *named* method, but `unsafeMode(true)` is
the equivalent lever and it exists. P2 should be re-read as "no `enableDefensive` entry point", not
"defensive mode cannot be toggled"; a reviewer relying on the stronger reading would conclude these
fixtures are unbuildable, and they are not.

### 0.4 The ruled binding's `backup()` has **no** `AbortSignal` parameter

This lane was handed "`backup()` accepts an `AbortSignal` and ignores it". That is `node:sqlite`'s
behaviour, measured by the contradiction seat. It is **not** the ruled binding's.

```
$ wsl -e bash -lc 'node -e "const D=require(\"/tmp/l3-bs3b/node_modules/better-sqlite3\");
    console.log(Object.getOwnPropertyNames(D.prototype).join(\", \"));
    console.log(\"backup.length=\", D.prototype.backup.length)"'
constructor, prepare, transaction, pragma, explain, backup, serialize, function, aggregate, table,
loadExtension, exec, close, defaultSafeIntegers, unsafeMode
backup.length= 2
```

`better-sqlite3@13.0.2`'s signature is `backup(filename, options)` with
`options = { attached, progress }` (source: `node_modules/better-sqlite3/lib/methods/backup.js`).
There is no signal parameter to accept or ignore. Change 5's design §3.3 already says this; the
brief's framing does not. **E3's shipped sentence is therefore "no cancellation affordance exists",
not "a signal is accepted and ignored"** — and DUR-B4 asserts the *absence*, so that a binding bump
which adds a signal parameter fails the gate rather than silently making the contract stale.

**But cancellation is not structurally impossible, and the plan must not let the contract imply it
is.** The copy is driven by `setImmediate(step)` over page batches, and the `progress` handler is
invoked between steps; a handler that throws rejects the promise and calls `backup.close()`. So a
**cooperative, page-batch-bounded** cancellation is implementable on the ruled binding today. Whether
UmbraDB ships one is a *decision*, not a discovery. DUR-B5 forces it to be recorded either way, so §6
cannot say "uncancellable" when what is true is "we chose not to wire the affordance that exists".

### 0.5 `backup()` opens **no** sidecar descriptor during the copy — measured, not argued

Criterion E10c wants the sidecar-descriptor property recorded per candidate. Here is the method and
the result, which discharges it mechanically rather than by reading source.

```
$ wsl -e bash -lc 'cd /root/umbradb-sqlite-research &&
    strace -f -e trace=openat,write -o /tmp/bk.trace2 node probe-backup-fds.mjs >/dev/null 2>&1;
    grep -nE "MARKER_BACKUP_(START|END)|db-(wal|shm)" /tmp/bk.trace2'
71: openat(AT_FDCWD, ".../src.db-wal", O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC, 0644) = 22
72: openat(AT_FDCWD, ".../src.db-shm", O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC, 0644) = 23
76: write(1, "MARKER_BACKUP_START\n", 20) = 20
82: write(1, "MARKER_BACKUP_END\n", 18) = 18
86: openat(AT_FDCWD, ".../dst.db-wal", ...) = 22
87: openat(AT_FDCWD, ".../dst.db-shm", ...) = 23
```

Between the two markers: **zero** `openat` calls on any sidecar. The source's `-wal`/`-shm` were
opened once, at WAL entry, by the engine's own long-lived handles (which are never closed mid-copy —
the defect is an open-then-**close**, not an open). The destination's were opened after the window by
the verifying connection.

This is the argument change 5 calls "mechanism-level and independent of the timing result", and it is
now a **test** (DUR-B6) rather than a claim. It also gives the descriptor-defect suite its
discriminator: the defect is a *JS `fs`-module* open-then-close of `-shm`, not the engine's handle,
and a test that greps syscalls without that distinction fails the clean case.

### 0.6 The observed backup transcript, recorded as conditions-attached and **not** as a threshold

```
backup result   : {"totalPages":2867,"remainingPages":0} ms= 549 timer ticks= 31
dest integrity  : [{"integrity_check":"ok"}]
dest rows       : 20000
```

Conditions: ext4 `/root`; `journal_mode=WAL`; `synchronous=FULL`; `page_size=4096`; `auto_vacuum`
default (0); ~11.7 MB source, **fully in page cache** on a host with far more RAM; **no concurrent
writer**; `better-sqlite3@13.0.2`; `sqlite_version()` 3.53.4; single process, no worker.

This is **not** B-6/B-7 and must never be cited as if it were. It has no concurrent writer, no
out-of-cache dataset and no `VACUUM INTO` comparison — three of B-6's required conditions. Its only
use here is to confirm the harness shape works (the event loop turned; the destination verified
clean), and DUR-G9 exists specifically to make citing it in a document a gate failure.

### 0.7 `dm-flakey` exists on this host and this host still cannot be the power-loss rig

```
$ wsl -e bash -lc 'which dmsetup; modinfo dm-flakey | head -1'
/usr/sbin/dmsetup
filename: /lib/modules/6.18.33.2-microsoft-standard-WSL2/kernel/drivers/md/dm-flakey.ko
```

The module ships with the WSL2 kernel, so the rig can be **developed and its negative control
proven** here. It cannot be **run for record** here: every block below the device-mapper target
passes through a VHDX file on an NTFS volume under the Windows host cache, so a `dm-flakey`
"drop_writes" interval proves the target dropped writes, not that a real write barrier was or was not
honoured. The 11 µs/commit figure measured on this host is the same artifact from the other
direction. §6 states the admissible host.

---

## 1. Scope

### 1.1 Owned outright — change 5 `v1.0.0-sqlite-durability-contract`, capability `release-contract`

| Requirement (by title) | Acceptance criteria |
|---|---|
| the durability probe verifies library-controlled pragmas instead of deployer-supplied server settings | A1–A8 |
| the synchronous default is FULL and is lowered only under a stated decision rule | B1–B6 |
| integrity coverage follows the three-class corruption model with an explicit column-level coverage set | C3, C4, C10 |
| the value digest is a versioned, length-prefixed, row-bound SHA-256 computed adapter-side | C1, C3a, C3b, C4e, C4f |
| the digest covers the stored bytes and never a logical value | C3c |
| a documented-as-dangerous salvage bypass ships from day one | C3d |
| a covered row cannot be downgraded to unverified, by configuration or by statement | C4a–C4d |
| the schema digest is verified at open and is the one open-scoped corruption failure | C6a |
| the verification pass runs the structural check, the digest sweep, the schema digest and the invariants together, and never refuses | C5, C5a, C5b, C6, C13 |
| Class B corruption is answered by named invariants with an owner per change | C6b, C6c |
| the checksum VFS is considered and declined, with its reasons recorded | C9c |
| the integrity boundary is disclosed using the two-case wording, in every channel a consumer reads | C7, C7a, C8, C9, C9a, C9b |
| corruption recovery is row-scoped and proportionate, never whole-database refusal | C11, C12 |
| the backup primitive is established by measurement on the ruled binding, not asserted | E0–E13 |
| a backup's manifest-to-chunk closure is tested rather than asserted | E12 (P13) |
| the manual pre-tag evidence artifact is re-executed against the new release candidate, never amended | G1–G4 |
| the conformance suite is re-executed with negative controls and gains the properties SQLite creates | G5–G8 (P11, P12, P14, P15), G10 |
| the unmeasured integrity quantities are carried as obligations, never as assumptions | C10, C13, §6 of this plan |
| the known verification gaps are recorded in the catalog rather than left for a green gate to hide | F14, I5 |
| the unbounded transaction hold is documented as unbounded and instrumented rather than claimed to be bounded | H5 (H1/H4/H6 shared with the observability lane) |

### 1.2 Owned outright — change 6 `v1.0.0-sqlite-chain-archive`, capability `chain-archive`

| Requirement (by title) | Acceptance criteria |
|---|---|
| a snapshot is a database file with no outstanding write-ahead-log dependency, together with a manifest | N1, N2 |
| the snapshot and verification tooling runs outside the library process | N0, N0a |
| the snapshot manifest is derived from the finished artifact, never from the source database | N3, N4, N5 |
| the snapshot manifest identifies the artifact well enough to restore it safely | N6–N10 |
| restoring a snapshot runs four checks and reports them separately | N11, N11a–N11d, N12, N13 |
| a snapshot makes no completeness claim | N14, N15 |
| no live-backup primitive is named for the archive until it has been measured on the ruled binding | N16–N18 |
| the archive's durability setting is not lowered without four stated preconditions | R1–R3 |
| each archive table has a stated integrity classification and mechanism | R4–R7, R16c, R18 |
| the digest column and its drift guard follow this lineage's DDL conventions | R8, R8a, R8b, R9, R10, R11, R12 |
| the archive cursor is bounded by its data and its monotonic guard cannot latch | R13, R15, R15a, R16, R16a, R16b |
| the uncovered projection tables have a written rebuild path with an executed transcript | R17 |
| blob content is stored in the database and verified on read by recomputing its address | W4, W5 |
| the ingest cursor advances in the same transaction as the block bundle it passes | W6, W7 |
| (measurement admissibility) every performance-dependent property of the archive is an obligation to measure | M5, M5a, M7 |

### 1.3 Consumed, not owned — change 1 `v1.0.0-sqlite-engine-core`

`every performance-dependent decision is blocked on measurements taken on a real filesystem under
declared conditions` and `the decisions blocked on the measurement gate are named` supply **B-2**
(the `synchronous` default), **B-3a/B-3b** (`page_size`, `auto_vacuum`, per file), **B-6** (backup vs
`VACUUM INTO`) and **B-7** (which pragma values the probe asserts). This lane consumes those; §6
lists every test blocked on them. `the conformance suite is re-executed against the new engine rather
than amended to suit it` is shared with the conformance lane — this lane owns P11–P15 and the crash
half of P1–P10.

### 1.4 Explicitly not this lane

Lease mechanics, `BEGIN IMMEDIATE`, the poll loop and the source guard's *implementation*
(concurrency lane — this lane consumes the guard and tests only its durability consequence); the
temporal encoding and clock (temporal lane); DDL, constraints and `qualify()` (schema lane);
export/import (migration lane); the diagnostic surface's shape (observability, criteria H1–H4, H6).
The tagging in each `acceptance.md` is this lane's **input**; §2 re-types criteria where the tag is
wrong, and every such re-typing is called out as a finding.

### 1.5 Findings against the existing tagging

| Criterion | Tagged | Should be | Why |
|---|---|---|---|
| C10 | `[manual]` | `[CI]` artifact-existence gate + `[manual]` for the value | "the measurement exists with its conditions attached" is machine-checkable against change 1's artifact schema; only the interpretation is manual. Left `[manual]`, it is a promise nobody can fail. |
| E0, E10c | `[manual]` | `[CI]` schema gate on the record | Same shape. The record's *fields* (binding, version, `sqlite_version()`, filesystem, pragmas, dataset-vs-cache, commit count, per-candidate duration/ticks/integrity/rowcount/sidecar-descriptor flag) are a schema. A missing field must fail, not be noticed. |
| E10c | `[manual]` | additionally `[unit]` | §0.5 shows the sidecar-descriptor property is directly observable via `strace` markers. A property that can be measured should not be attested. |
| G1, G2 | `[manual]` | `[manual]` + `[CI]` lint | G3 already specifies the lint; G2 as written could be satisfied by a human eyeballing the table. Bind G2's pass condition to G3's lint output. |
| C6c | `[manual]` | `[unit]` | "each invariant names exactly one owning change" is a parse of the invariant tables in changes 5 and 6. A cross-document consistency test is cheap and R16c already establishes the pattern. |
| I5 | `[doc][CI]` | correct, but **under-specified** | The criterion admits "Windows is out of scope" with no test. If that branch is taken, a CI assertion must fail the build on Windows rather than leaving it undefined. See DUR-G12. |
| W5 | `[unit]` | `[unit]` — correct, and now **buildable** | Was at risk of being written as a random-byte corruption. §0.1/§0.2 supply the deterministic construction. |
| A5 | `[unit][CI]` | correct, with a gap | Nothing in A5 forces the *test host* to have the filesystems it enumerates. See DUR-P5 and §5.4. |

---

## 2. Test inventory

Type key: **U** unit · **P** property (`fast-check`) · **I** integration · **CF** conformance
(P1–P15) · **CR** crash · **BM** benchmark/measurement · **G** CI gate/doc lint.

Every fixture below states `journal_mode`, `synchronous`, `page_size`, `auto_vacuum` and
dataset-vs-RAM where it touches I/O. **No fixture may live on `/tmp`** (DUR-G1 enforces this for the
whole suite). No pass condition below is a number produced by this sprint.

### 2.A The durability probe

| id | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| DUR-P1 | Every probe decision is an exported pure classifier taking observations and returning a violation/warning/null, with no database handle in its signature. Every branch reached by direct injection. | A1 | U | none (no DB) | 100% branch coverage of the classifier module measured by the coverage gate; a classifier whose signature accepts a handle fails the test |
| DUR-P2 | `journal_mode ∈ {off, memory}` → `DurabilityContractError` thrown **before** any `_migrations` row exists, `violations[]` names setting and observed value | A2 | U+I | ext4 `/root`; fresh file per case; `page_size` B-3a; dataset < 1 MB | throws; `code === 'DURABILITY_CONTRACT_VIOLATION'`; `select count(*) from _migrations` = 0 after the throw; no option in the public options type makes it proceed (asserted by a type-level + runtime enumeration test) |
| DUR-P3 | `synchronous=OFF` rejects; `synchronous=NORMAL` under a `FULL` floor returns `kind:"lost-tail"` **and migrations run** | A3 | U+I | ext4; WAL; `page_size` B-3a; fresh file | OFF: throws. NORMAL: `onDurabilityWarning` called once with `kind==='lost-tail'`, `setting==='synchronous'`, `value==='NORMAL'`; `_migrations` non-empty afterwards |
| DUR-P4 | `foreign_keys` ≠ `ON` rejects, and the message names the cascade→GC-no-op consequence | A4 | U+I | ext4; WAL; fresh file | throws; message matches a fixed assertion on the *substance* (contains the `ON DELETE CASCADE` and garbage-collection clauses), asserted against a constant exported by the probe rather than a literal in the test |
| DUR-P5 | A database file on `nfs`/`cifs`/`v9fs`/`tmpfs`/`ramfs`/un-allowlisted `fuse` rejects, naming the type; the refusal is keyed on the reported type | A5 | U (classifier) + I (tmpfs only) | classifier: injected `statfs` f_type values, table-driven. integration: the one filesystem CI can really produce — a file on `/tmp` (tmpfs) | classifier: each injected type yields a violation naming that type. integration: opening a DB under `/tmp` throws `DURABILITY_CONTRACT_VIOLATION` naming `tmpfs`. **The integration half runs on `/tmp` deliberately and is the only test in this plan that may** — it asserts a refusal, not a measurement |
| DUR-P6 | The `fsync` calibration never refuses in any test in the suite | A7 | U + G | injected calibration values spanning implausibly-fast to slow | no input to the calibration classifier produces a `DurabilityViolation`; a static check asserts the calibration's return type cannot be a violation |
| DUR-P7 | The probe's live function reads back what UmbraDB set on **the handle it opened**, not a server setting | "probe verifies library-controlled pragmas" | I | ext4; WAL; fresh file; bootstrap applied | for each pragma in B-7's set, the probe's observation equals a direct `PRAGMA` read on the same handle, and differs from the compiled default where the bootstrap changed it (so the test fails if the probe reads a default rather than the handle) |
| DUR-P8 | `docs/durability-contract.md`'s binding **deployer** preconditions reduce to exactly one — local non-networked filesystem — and each summary-table row cites its enforcing classifier | A8 | G (doc lint) | the rewritten doc | the "binding deployer precondition" list parses to one item; every summary row's Enforcement cell names a symbol that exists in the probe module (resolved by import, not by grep) |
| DUR-P9 | The contract states the `fsync` calibration is best-effort and never a guarantee, and contains no sentence claiming otherwise | A7 | G (doc lint) | the rewritten doc | the required sentence is present; a denylist of claim-shapes ("verifies that the filesystem", "guarantees fsync", "confirms the disk") matches nothing |

### 2.B The `synchronous` decision rule and power loss

| id | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| DUR-S1 | Shipped default is `synchronous = FULL` | B1 | U+I | fresh file, bootstrap only | `PRAGMA synchronous` reads back 2 (FULL) on a freshly bootstrapped connection **and after reopen** (the pragma is per-connection; the reopen half is what makes this meaningful) |
| DUR-S2 | No document in change 5's or change 6's set states a commits/sec figure, throughput ratio or latency for any `synchronous` level as fact | B2, R2 | G (doc lint) | the doc set | a scanner over the change-owned document set finds zero matches for numeric-with-unit patterns (`\d+\s*(commits?/s|tps|ms|µs|us|×|x faster)`) within N words of `synchronous`/`NORMAL`/`FULL`, **except** inside a fenced block explicitly labelled as a measurement record with its conditions |
| DUR-S3 | The contract enumerates all three preconditions for lowering the default | B3 | G (doc lint) | the rewritten contract | three enumerated items present, each matched by an anchor phrase: measured magnitude under change 1's gate conditions; power-loss evidence **with a failing negative control**; a recorded decision naming the accepter |
| DUR-S4 | The contract states SIGKILL trials are inadmissible as power-loss evidence, with the reason | B4 | G (doc lint) | same | the sentence is present and contains the reason (a process crash is the guarantee `NORMAL` *does* make) |
| DUR-S5 | The contract states a measurement on a probe-refused filesystem is inadmissible | B5 | G (doc lint) | same | present |
| DUR-S6 | The contract states `NORMAL` is contract-legal *in kind* and that legality is not sufficiency, **in the same paragraph** | B6 | G (doc lint) | same | both clauses found within one paragraph boundary |
| **DUR-S7** | **The power-loss rig detects the failure it is looking for** (the negative control that licenses everything else) | B3 precondition 2 | CR | see §4.6 | a configuration the rig is *supposed* to catch is caught: `synchronous=OFF` **and** a volatile-cache-loss injection at the same trial count produces ≥1 trial in which an acknowledged commit is absent after restart, or `integrity_check` is non-`ok`, or the cursor is ahead of its data. **A run in which the negative control also passes fails the gate** — it means the rig injects nothing |
| **DUR-S8** | **Under real power loss at `synchronous=FULL`, no acknowledged commit is lost, `integrity_check` is `ok`, and the durable cursor is never ahead of durable data** | B3 precondition 2 | CR | see §4.6 | across N trials (§4.6 fixes N and its justification): zero acknowledged-commit losses; zero non-`ok` structural checks; zero cursor-ahead states. **Blocked on the rig existing — see §6.** Result is *recorded*; it does not by itself lower `synchronous` |
| DUR-S9 | The same rig at `synchronous=NORMAL` produces its result, recorded, with the trade named | B3 precondition 2 | CR | see §4.6 | the run completes and its outcome (whatever it is) is recorded with full conditions. **This test has no pass/fail on the data** — it is the evidence-production step. What gates is DUR-S10 |
| DUR-S10 | A proposal to lower the default is rejected unless all three preconditions are present | B3 | G | the release record | a gate reads the release record; if it records `synchronous=NORMAL` as the default, all three preconditions must be resolvable — a measurement id in change 1's artifact, a power-loss record with a **failing** negative control, and a named accepter. Any missing → fail |

### 2.C Corruption detection and the digest regime

| id | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| DUR-C1 | A covered value corrupted in place is rejected on read with `ValueIntegrityError`, `code==='VALUE_INTEGRITY'`, carrying table + primary key; the bytes are not returned | C1, R11, P15 (half) | U+P+CF | §4.1 `overflow-payload` fixture, ext4, WAL, `synchronous=FULL`, `page_size` B-3a, `auto_vacuum` B-3a, dataset ≪ RAM | throws; `err.code === 'VALUE_INTEGRITY'`; `err.table` and `err.primaryKey` equal the injected row's; the returned value is `undefined` (asserted by a property test over 100 random covered rows that the thrown row is exactly the injected one) |
| DUR-C2 | The **same** corruption is invisible to the structural check: `integrity_check` and `quick_check` both report `ok` and a raw scan returns the corrupted row as data | C2 (payload half), P15 (half), W5 | U | same fixture, raw driver handle (bypassing the adapter) | both pragmas return exactly `[{...: 'ok'}]`; a raw `SELECT` returns the row; the returned bytes differ from the written bytes at the injected offsets. **Fixture asserts `pagetype='overflow'` from `dbstat` before injecting** — a run where no overflow page exists reports `n/a — no overflow pages in scope`, never `pass` |
| DUR-C3 | Structural corruption **is** caught, and the read fails | C2 (structural half) | U | §4.1 `btree-structure` fixture | `integrity_check` either returns a non-`ok` finding **or throws** `SqliteError{code:'SQLITE_CORRUPT'}` (both accepted — §0.2); the adapter read raises `DatabaseCorruptError`, `code==='DATABASE_CORRUPT'` |
| DUR-C4 | The covered set is exactly the specified columns; no `dg` on the excluded tables | C3, R4, R16c | U (schema introspection) | the applied lineages, both files | the set of `(table, column)` carrying `dg` equals the spec's set exactly, derived from `pragma_table_info` over `sqlite_schema`, not from a hand-written list; `ckpt_chunks`, `ckpt_manifests`, `chain_blobs`, `blocks`, `transactions`, `chain_blob_roles` carry none. A table added without a classification fails |
| DUR-C5 | Whole-row substitution (value **and** digest moved from another row) is detected | C3a | U | two covered rows, both valid; swap `(value, dg)` | throws `ValueIntegrityError` naming the substituted row's PK |
| DUR-C6 | The digest is written in the same statement as the value | C3 | U (static + runtime) | adapter source + a statement-log harness | a static check finds no covered-column write statement whose bound parameters omit `dg`; at runtime, a statement recorder shows exactly one statement per covered write carrying both |
| DUR-C7 | The drift-guard trigger aborts an update of a covered column that leaves `dg` unchanged; the same update with a recomputed `dg` succeeds; `sqlite_schema` references no user-defined function | C3b, R9 | U | applied lineage | first update throws with the **drift-guard constraint name** extracted by the single extraction function; second succeeds; a scan of `sqlite_schema.sql` finds no identifier outside SQLite's built-in function set |
| DUR-C8 | The anti-downgrade trigger aborts `UPDATE … SET dg = NULL` over a non-NULL digest; non-NULL→non-NULL still succeeds; a NULL→value write is unobstructed | C4b, R8b | U | applied lineage | three statements, three outcomes, the first naming the anti-downgrade constraint |
| DUR-C9 | A covered row whose `dg` is NULL raises `ValueIntegrityError` on read, naming table + PK; the value is not returned; no warn branch exists on the covered read path | C4d, R11 | U + static | a row inserted with NULL `dg` via a privileged fixture path | throws; a static check over the covered read path finds no branch that logs-and-returns |
| **DUR-C10** | **The digest sweep is blind to Class B and `integrity_check` is not** — index content divergence with matching entry counts | C2, "digest sweep does not replace the structural check", R13 | U | §4.2 `index-content-divergence` fixture (the §0.3 case (b) construction) | `integrity_check` reports `row N missing from index ix`; **`quick_check` returns `ok`**; the indexed lookup returns nothing for the current key and the *stale* key returns a row the table no longer holds; the digest sweep over every covered row reports **zero** failures |
| DUR-C11 | The `dg` column is nullable at schema level with a **named null-tolerant** length constraint; 31 bytes rejected naming the constraint; 32 bytes and `NULL` accepted; no `NOT NULL`/non-null default | C4e, R8 | U | applied lineage | four writes, four outcomes; the rejection's message yields the constraint name through the single extraction function; `pragma_table_info` shows `notnull=0` and `dflt_value IS NULL` |
| DUR-C12 | A bare `CHECK (octet_length(dg)=32)` **also** accepts NULL under three-valued logic | C4f, R8a | U | throwaway table with the bare form | the `NULL` insert succeeds — recording, as an executable fact, that the superseded rationale is false in both forms |
| DUR-C13 | A migration rewriting a covered column's bytes without recomputing `dg` fails the lint; one that recomputes passes | C3c | U + G | two throwaway migrations in a fixture lineage | the lint fails the first naming the table and column, passes the second; and a read after the recomputing migration verifies clean |
| DUR-C14 | Salvage: off by default; enabled it returns damaged bytes **and** reports every bypassed row with table + PK; off, the same read raises; enabling changes neither digest computation, nor the covered set, nor `verifyIntegrity()`'s report | C3d | U | §4.1 fixture ×2 configurations | six assertions, all objective; the `verifyIntegrity()` reports from both configurations compare **deep-equal** |
| DUR-C15 | Verification occurs on **every** read of a covered column and no configuration option disables it | C4a | U + static + G | full options surface | an enumeration test over the public options type finds no key whose effect is to skip verification; a statement-level counter shows verification invoked once per covered-column read across every read entry point (asserted per entry point, so a new entry point without verification fails) |
| DUR-C16 | Schema-digest mismatch → `open()` raises `DatabaseCorruptError` with a `schemaDigest` detail, **without scanning data** | C6a | U | a file whose schema text was altered post-record | throws at `open()`; `err.details.schemaDigest` present; a statement recorder shows no row-reading statement issued before the throw |
| DUR-C17 | A **value**-digest failure does **not** refuse at open | C6a (negative half), C11 | U | §4.1 fixture | `open()` succeeds; `runMigrations` succeeds; lease acquisition succeeds; a read of an *unrelated* key succeeds and returns correct bytes |
| DUR-C18 | I-6 anti-latch: a watermark corrupted upward, whose guard suppresses a legitimate write, raises `ValueIntegrityError` — on the **suppression** path | C6b, R16, R16a | U | §4.3 `latched-cursor` fixture | the **first** suppression raises; a variant with the check placed only on the success path never fires (asserted, not assumed) |
| DUR-C19 | I-8: an archive cursor beyond `coalesce(max(height), -1) + 1` raises on read, **including at zero rows** | R15, R15a | U | fresh zero-row archive + positive cursor | raises on the zero-row state; a `max(height)`-without-`coalesce` variant evaluates to NULL and silently does not fire, and the test asserts that difference |
| DUR-C20 | Each Class B invariant names exactly one owning change across changes 5 and 6, and none owned elsewhere is re-specified | C6c | U (cross-doc) | the two invariant tables | parse both tables; every invariant id appears with exactly one owner; an id with two owning rows fails naming the id |
| DUR-C21 | `CHUNK_INTEGRITY` and `VALUE_INTEGRITY` are distinguishable by `code` alone; the content-addressed tier carries no second digest | C4 | U | applied lineage | two provoked faults yield two distinct `code` values; `dg` absent from the content-addressed tables (subsumed by DUR-C4 but asserted separately so the reason is legible) |
| DUR-C22 | `ValueIntegrityError` carries a machine-readable discriminator naming which check failed | F20, F22 | U | one fault per discriminator | a consumer switch over the discriminator covers digest-mismatch, NULL-digest, and each row-scoped invariant, with no message parsing anywhere in the test |

### 2.D The verification pass

| id | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| DUR-V1 | `verifyIntegrity()` runs all four parts and reports them separately | C5 | U | a database with one fault of each kind planted simultaneously | the returned inventory has four named fields; each names its own finding; overall result is a failure |
| DUR-V2 | It reports overall failure when **any** single part fails — four separate runs, one fault each | C5, C6 | U | four fixtures | four runs, four overall failures, each naming exactly one failing part and three passing/`n/a` |
| DUR-V3 | It never throws and never refuses; the database stays open and usable for undamaged rows | C5, "reports and never refuses" | U | the all-four-faults fixture | returns (does not throw); a subsequent read of an undamaged key succeeds |
| DUR-V4 | It is not invoked from `open()` or `runMigrations` | C5b, N11a | U + static | instrumented build | a call counter on `verifyIntegrity` reads 0 after `open()` + `runMigrations`; a static check finds no call site inside those paths, inside the ingest loop, or on a timer |
| DUR-V5 | `quick_check` appears nowhere as an alternative to `integrity_check` | C5a | G (doc + source lint) | whole repo | occurrences of `quick_check` are confined to an allowlist of exactly two sites: the DUR-C10 negative-control fixture and the prohibiting contract sentence. Any third occurrence fails, naming the file |
| DUR-V6 | A test asserting on either pragma says **which**, and the assertion is on that pragma's result | C5a, §0.3 | G (test lint) | the test suite | a lint over test sources rejects an assertion that ORs the two pragmas' results together |
| DUR-V7 | A structurally-`ok` database with one digest mismatch fails the pass, naming the row | C6 | U | §4.1 fixture | overall failure; `structural: 'ok'`; the failing row's table and PK present |
| DUR-V8 | Every check reports `pass` / `fail` / `n/a — no rows in scope`, and none reports `pass` on empty scope | N11c, N11d | U | a fresh **zero-row** archive — the specified starting state | identity, continuity and digest-sweep report `n/a`; overall is **not** a pass; a build reporting `pass` for all four fails this test |
| DUR-V9 | Every suite in this lane asserts its fixture is non-empty or reports `n/a` | governing trap 2 | G (test lint) | the suite | each test file in this lane either calls the shared `assertFixtureNonEmpty()` helper or declares `@allow-empty-scope` with a reason; a file doing neither fails the lint |

### 2.E Backup, restore and the descriptor hazard

| id | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| DUR-B1 | Before the B-6/B-7 record exists, §6 names **no** live-backup primitive | E1, N16 | G (doc lint) | `docs/CONTRACT.md` §6, archive snapshot doc | a scanner for candidate-primitive tokens (`backup(`, `VACUUM INTO`, `.dump`, `sqlite3_backup`) inside §6 finds none while the record is absent; a named primitive fails as a **defect**, not a draft |
| DUR-B2 | Once the record exists, §6 takes branch A or branch B **according to the recorded result**, not the author's preference | E1, E2 | G | record + §6 | the gate reads the record's per-candidate outcome, derives the branch, and asserts §6 matches. A §6 naming a primitive the record did not select fails |
| DUR-B3 | The B-6/B-7 record carries every admissibility field | E0, E10c, M6 | G (schema) | the record | JSON-schema validation: binding + exact package version; runtime `sqlite_version()`; filesystem (asserted **not** memory-backed and **not** one the probe refuses); `journal_mode`; `synchronous`; `page_size`; `auto_vacuum`; dataset size **relative to page cache**; concurrent-writer commit count > 0; per candidate: wall-clock duration, event-loop tick count, destination structural check, destination row/page count vs source-committed-at-call, **and the sidecar-descriptor boolean** |
| DUR-B4 | §6 states the shipped backup call's **actual** cancellation behaviour, observed on the ruled binding, without deferring to §3 | E3 | U + G | the binding + §6 | runtime assertion: `Database.prototype.backup.length === 2` and the accepted options keys are exactly `{attached, progress}` — **so no `AbortSignal` parameter exists** (§0.4). §6 contains the corresponding sentence. A binding bump introducing a signal parameter **fails this test**, which is the point |
| DUR-B5 | §6 records whether UmbraDB ships the cooperative cancellation the `progress` callback makes possible, and if not, that it is a decision | E3, D3 | G (doc lint) + U | §6; the adapter | §6 contains one of two recorded sentences: *"a page-batch-bounded cancellation is wired via the progress callback, with the batch as the bound"* (and a unit test proves an abort mid-copy rejects and closes the backup handle), **or** *"no cancellation is wired; the affordance exists and was deliberately not used, because …"*. Silence fails. **This test exists because §0.4 shows "uncancellable" would be false as stated** |
| DUR-B6 | The selected candidate's sidecar-descriptor property is measured, not attested | E10c | I (syscall trace) | §4.5 harness | `strace -f -e trace=openat` with in-band markers; **zero** `openat` on `*-wal`/`*-shm` between the markers for a candidate recorded as opening none; a candidate that opens one is recorded as such and the record must match |
| DUR-B7 | An in-process JS `fs` open-then-close of `-shm` while a writer holds `BEGIN IMMEDIATE` voids the lock, a second OS process commits inside the holder's transaction, **both commits report success, one acknowledged commit is lost, and `integrity_check` reports `ok`** | E10a, E10b, N0a, D3 | CR | §4.5, two OS processes | all four observables asserted: two successes, a row count showing one commit lost, `integrity_check === 'ok'`. **This is the plan's most important negative control** — see §3 |
| DUR-B8 | A documented file-copy procedure is out-of-process or post-quiesce, and says which; an in-process instruction fails the lint | E10a | G (doc lint) | §6, archive snapshot doc | every copy procedure block carries exactly one of the two markers; a procedure instructing an in-process copy of the DB or its sidecars fails, naming the block |
| DUR-B9 | §5's embedder precondition and §6's copy procedure name the same mechanism and consequence in the same terms | E10b | G (doc lint) | `docs/CONTRACT.md` | both sections contain the same four consequence clauses (two writers commit / one acknowledged commit silently lost / structural check reports ok / descriptor open-then-close), compared as normalised clause sets rather than as prose |
| DUR-B10 | Copying the main file alone silently restores an older state while `integrity_check` reports healthy | E5, N1 | U | ext4; WAL; commit N rows, do **not** checkpoint; copy `.db` only | the restored copy opens; `integrity_check === 'ok'`; the row count is strictly less than the source's committed count. **Assertion is on the combination** — a healthy check *and* missing data |
| DUR-B11 | A long copy blocks WAL checkpointing, and a passive checkpoint returns not-busy while checkpointing nothing | E6, H4 | U | ext4; WAL; a copy in flight | during the copy, `wal_checkpoint(PASSIVE)` returns `busy: 0` with `pages_checkpointed` 0 and the `-wal` size does not shrink. Asserted as a **conjunction**, so a not-busy return alone is not read as success |
| DUR-B12 | §6 states: no PITR; no `pg_dump`-class live backup in the surveyed field; the verification pass as the post-restore step with its limit in the same paragraph; never-copy-the-main-file-alone in bold | E5, E7, E8, E11 | G (doc lint) | §6 | each sentence present; the limit and the recommendation are within one paragraph boundary |
| DUR-B13 | `pg_dump`/`pg_restore` commands are gone from §6 | E1 | G | `docs/CONTRACT.md` | zero occurrences of `pg_dump`, `pg_restore` outside a historical-note block |
| **DUR-B14 (P13)** | A backup taken **while a GC pass and concurrent writes are running** opens cleanly, satisfies manifest→chunk closure, and passes the verification pass | E12 | P + CF | §4.4 `gc-race` fixture | over ≥50 randomised interleavings: the copy opens; for every manifest in the copy, every referenced chunk is present; the verification pass reports no failure. **Fixture asserts ≥1 manifest and ≥1 GC deletion actually occurred in the trial**, else `n/a` |
| DUR-B15 | Every external precedent citation in the rewritten contract set resolves to a pinned upstream commit or version-pinned URL | E13, I2 | G | the doc set | each citation carries a resolvable pin recorded inline; an unresolvable one must be **absent**, not hedged — a hedge-word scan near an unpinned citation fails |

### 2.F Archive snapshots and restore verification

| id | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| DUR-N1 | No module under `src/` opens a descriptor on an archive DB path or its sidecars; snapshot/manifest/restore tooling lives outside `src/`; the guard passes with **no** exemption entry | N0 | G (static) | repo | the descriptor guard's exemption list is empty (asserted as `length === 0`, so an exemption cannot be added quietly); the tooling's files resolve outside `src/` |
| **DUR-N2** | **The manifest is derived from the finished artifact, never the source** | N3, N4 | U + static | §4.4 with ingest active during production | static: the derivation module's DB-open call sites resolve only to the artifact path. runtime: a snapshot produced under concurrent ingest matches its manifest on **every** derived field, and restore verification passes — i.e. at-or-after capture is harmless **by construction**, which is the property under test |
| DUR-N3 | A snapshot requires no sidecar to reach the state its manifest describes | N2 | U | produced artifact | delete `-wal`/`-shm` beside the artifact; it opens and yields the manifest's row counts and canonical tip |
| DUR-N4 | The manifest carries every identity field; a schema test rejects one missing any | N6 | U | manifest schema | field-by-field: lineage + applied migrations; schema value; network; canonical height range; tip (height + hash); archive watermark rows; per-table row count; content digest; `page_size`; `auto_vacuum`; binding name + pinned version + runtime SQLite version; UmbraDB version. Removing any field fails |
| DUR-N5 | A mismatched applied-migration list fails restore, naming the mismatch, and the archive is not opened for writing | N7 | U | manifest with an altered list | fails; names the difference; a write-handle counter reads 0 |
| DUR-N6 | A wrong-network artifact is reported before any ingest | N8 | U | manifest with a different network | reported; ingest counter 0 |
| DUR-N7 | Two artifacts of the same logical content from two copy paths are **not** byte-identical yet have **equal** content digests | N9, N10 | U | one artifact copied, one compacted | `sha256(fileA) !== sha256(fileB)`; `manifestA.contentDigest === manifestB.contentDigest`; the digest is a single hash over the ordered `(net, height, block_hash)` sequence with a domain-separation prefix (asserted by recomputing it independently in the test) |
| DUR-N8 | Restore reports structural, identity, pragma and continuity **separately**; one injected failure of each kind yields an overall failure naming that check | N11 | U | four fixtures | four runs; each names exactly its own failing check |
| DUR-N9 | A `page_size` or `auto_vacuum` mismatch fails verification and is reported as unrepairable in place | N12 | U | artifact created with a different `page_size` | fails; the report contains the unrepairable-in-place statement |
| DUR-N10 | Removing a canonical block mid-range makes the continuity walk fail, naming the height | N13 | U | populated archive, one row deleted | fails; names the exact height |
| DUR-N11 | No manifest field is named or documented as asserting completeness; the report states all four limits of the walk | N14 | U + G | manifest schema + report | no field name or doc string contains a completeness assertion; the report contains all four limits (fork completeness, transaction/observation completeness, body integrity, and the nullable-body reason) |
| DUR-N12 | Round trip: a snapshot of a populated archive, produced **with ingest active**, restores into a fresh location, passes all four checks and resumes ingest from its watermark | N19 | I | §4.4, ext4, WAL, `synchronous` B-2, `page_size`/`auto_vacuum` B-3b, dataset ≪ RAM | all four checks `pass` (none `n/a`, because the fixture is populated — asserted); ingest resumes at the manifest's watermark and the next bundle commits |
| DUR-N13 | Before the archive-scale runtime measurement (M-7), no document describes the verification pass as more than an on-demand diagnostic and post-restore check | N11b, C13 | G (doc lint) | doc set | a scan finds no scheduling language (`periodic`, `on a schedule`, `nightly`, `cron`, `every N`) within N words of the verification pass, while the M-7 record is absent |
| DUR-N14 | The rebuild path has **one executed transcript** showing an altered projection column reported as divergent, with its two limits stated; until it exists, the contract's archive row claims only resync-from-chain | R17 | I + G | §4.4 with one `blocks` content column altered | the procedure reports that column divergent from the value re-derived from the header blob; the blob is itself rehash-verified in the same run; the transcript records both limits. Absent the transcript, a gate asserts the contract's archive row says only "resynchronise from chain" |

### 2.G Crash properties (P11–P15, P1–P10 re-execution)

| id | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| DUR-X1 (P11) | `journal_mode` and `synchronous` hold at or above their configured floors at **every** covered commit, including after a reopen | G6 | CF + P | ext4; N covered commits with reopens interleaved | at every commit boundary, both pragmas read at-or-above floor. **Negative control DUR-NC1** |
| DUR-X2 (P12) | After a crash, `integrity_check` reports `ok` **and** the durable cursor is not ahead of durable data | G7 | CR + CF | §4.6 rig at the crash tier available (see §5.1 for the SIGKILL/power-loss split) | across N trials: every survivor reports `ok`; in no survivor does the cursor reference a checkpoint absent from the file. **Negative control DUR-NC2** |
| DUR-X3 (P14) | `foreign_keys` is `ON` on every connection | G8 | CF | every connection the suite opens | a connection-open hook asserts `PRAGMA foreign_keys === 1`; **negative control DUR-NC3** shows that with it off a manifest delete silently removes no junction rows |
| DUR-X4 (P15) | A value corrupted in place is detected on read and the same corruption is **not** detected by the structural check | G5, C2 | CF | §4.1 | conjunction of DUR-C1 and DUR-C2 asserted in one property, so the two halves cannot drift apart |
| DUR-X5 | Every surviving P1–P10 crash property runs green against SQLite **and** its forbidden shape runs and **fails** the invariant | G5 | CR + CF | ported crash harness (§4.6) | for each crash property: the conforming shape holds across N trials; the forbidden shape violates the invariant in ≥1 trial. **A property with no failing negative control is not accepted** — the gate fails on a property whose control also passed |
| DUR-X6 (W6/W7) | Archive `setWatermark` is no longer a separate commit; across N randomised crash trials the watermark never refers to a height whose bundle is absent | W6 | CR | §4.4 archive ingest under crash | zero trials with a watermark ahead of its bundle. **Negative control DUR-NC5** |
| DUR-X7 | Re-ingesting an already-committed height is a no-op, not a duplicate-key error | W8 | U | archive | second ingest succeeds and changes no row count |
| DUR-X8 | A `SIGKILL`ed archive writer's successor registers with no cleanup step or expiry wait | S9 | CR | archive, two processes | successor's registration succeeds immediately; no cleanup call in the path (asserted statically) |

### 2.H Evidence, disclosure and CI gates

| id | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| DUR-E1 | `docs/recovery/EVIDENCE.md` is **re-executed**: its Run-identity table names the RC SHA to be tagged and no value is copied forward | G1 | G + manual | the regenerated artifact | the recorded SHA equals the RC's; a differ against the previous artifact shows no unchanged captured-value cell that should have changed (run date, SHA, wallet id, cursor values); the Postgres row is replaced by the SQLite engine identity (binding, pinned version, runtime `sqlite_version()`, `journal_mode`, `synchronous`, `page_size`, `auto_vacuum`, filesystem) |
| **DUR-E2** | **Every field of the Cold-boot round-trip table carries captured output or the literal `NOT CAPTURED`** | G2 | G (doc lint) | the artifact | zero empty cells. **This fails against `main` today** — the six cells at the Cold-boot round-trip table are blank, neither captured nor marked. See §4.7 for what regenerating actually requires |
| DUR-E3 | The lint fails the **required** gate on any empty cell in a binding-rule-2 table, names the field, and passes when the cell reads `NOT CAPTURED` | G3 | U + G | synthetic artifacts | three synthetic documents: blank cell → fail naming the field; `NOT CAPTURED` → pass; captured value → pass. The lint is wired into the required gate, asserted by reading the workflow, not by assuming |
| DUR-E4 | The cost accounting records the evidence re-execution as already required by the roadmap and attributes ~zero incremental cost | G4 | G + manual | the change record | both statements present with the roadmap citation |
| DUR-E5 | The two-case disclosure appears in `docs/CONTRACT.md` §1 with the soundness asymmetry, the coverage table, and detection-is-not-repair | C7 | G (doc lint) | §1 | all four elements present; the asymmetry sentence states a structural `ok` means "no structural fault found", never "the data is intact" |
| DUR-E6 | No document states or implies the engine detects nothing; every WAL-checksum claim is scoped to the log | C8 | G (doc lint) | doc set | a denylist of "detects nothing"-shapes matches nothing; every sentence containing a WAL checksum claim also contains a scoping clause |
| **DUR-E7** | **The not-a-regression paragraph is present and grounded in the probe's actual scope**, and no sentence claims restored parity | C9 | G (doc lint) + U | §1 + `durability-probe.ts` | the paragraph cites the three settings the probe reads, asserted **against the source**: a test imports the probe and asserts its read set is exactly `{fsync, synchronous_commit, full_page_writes}`, so the claim cannot go stale. A repo scan for `data_checksums|amcheck|pg_checksums` outside this paragraph returns nothing. A denylist of restoring-parity shapes matches nothing |
| **DUR-E8** | **The digests demonstrably detect something the PostgreSQL deployment did not** | C9, and the stronger claim this lane is asked to make | I (differential) | the same payload-corruption injection performed against a PostgreSQL fixture (`postgres:17-alpine`, `data_checksums` **off**, as `initdb` defaults) and against the SQLite build | PostgreSQL branch: the corrupted value is returned to the caller with no error. SQLite branch: `ValueIntegrityError`. The test **asserts the PostgreSQL fixture's `data_checksums` is `off`** so the comparison is against the deployment UmbraDB actually shipped, not a hypothetical one. This converts "not a regression" from a documentation claim into a measured one |
| DUR-E9 | The disclosure appears in all six channels and **no channel depends on a container image** | C9a | G | doc set + built surface | six named channels each carry the disclosure or its pointer; a scan finds no registry/image reference in any disclosure path; the code channel is asserted by importing the built barrel and finding the typed errors and the verification pass |
| DUR-E10 | No document cites a corruption frequency figure; the record states no field base rate was obtained | C9b | G (doc lint) | doc set | zero matches for rate-shaped patterns near corruption terms; the honest-open statement present |
| DUR-E11 | The checksum VFS is recorded as considered and **declined** with the process-global reason; the contract warns the verification pragma is silently accepted and does nothing; new databases pre-provision no reserve bytes | C9c, R18 | G + U | doc set + a fresh DB | doc assertions; runtime: `PRAGMA checksum_verification = 1` is accepted and `PRAGMA compile_options` contains no CKSUM entry (both asserted, so "accepted" and "does nothing" are each evidenced); a fresh DB's reserved-bytes count is 0 |
| DUR-E12 | `docs/recovery/CORRUPTION.md` exists with the four consumer paths, names the non-re-derivable tiers, names the verification pass as the post-restore check, and presents filesystem/hardware integrity only as defence-in-depth | C12 | G (doc lint) | the new doc | four paths present and named; the re-derive path explicitly excludes `kv_event` history, `transaction_history.entry` and the observation tables; the recovery-tool/filesystem/ECC mentions each carry a defence-in-depth qualifier |
| DUR-E13 | The timeouts section no longer claims a bounded idle-in-transaction session, and states the whole-database write lock around caller code has no server-side backstop | H5 | G (doc lint) | rewritten `durability-contract.md` §5 | the old claim is absent; both new clauses present |
| DUR-E14 | The `LEASE_FAULT` and `DISK_FULL` rows carry the untestable-in-CI note naming what would close the gap | F14 | G | error catalog | both rows carry the note; each names a concrete closer (a fault-injecting VFS or filesystem) |
| DUR-E15 | The contract set states either that Windows is supported with a named filesystem-locking test, or that it is out of scope | I5 | G | doc set | exactly one of the two statements present |

### 2.I CI gates over the whole lane

| id | Asserts | Type | Pass condition |
|---|---|---|---|
| **DUR-G1** | **No I/O-sensitive test or measurement runs on a memory-backed filesystem** | G | a shared `assertRealFilesystem(dir)` helper resolves the fixture root's filesystem type (via `statfs` f_type, not a string match on the path) and fails on `tmpfs`/`ramfs`/anything the probe refuses. Every fixture factory in this lane calls it. A test file creating a temp dir without it fails a source lint. **The one exemption is DUR-P5's integration half, which asserts a refusal — it is allowlisted by name** |
| DUR-G2 | Every measurement record in this lane's scope carries its full condition set | G | JSON-schema validation over the measurement artifact; a record missing filesystem, `journal_mode`, `synchronous`, `page_size`, `auto_vacuum`, dataset-vs-RAM, writer concurrency, binding + version, `sqlite_version()` fails |
| DUR-G3 | A measurement whose stated filesystem is `tmpfs`/`ramfs`/probe-refused is rejected, and the check fails against a deliberately inadmissible entry | G | M7; the deliberately-bad entry is a fixture in the gate's own test |
| DUR-G4 | No sprint figure appears as a pass threshold anywhere in this lane's tests | G (test lint) | a lint rejects a numeric literal compared against a timing/throughput variable unless the literal resolves to a symbol imported from the B-gate resolution module |
| DUR-G5 | Every negative control in this lane **executes** and is asserted to fail its invariant | G | each control has a test id; the gate asserts each id ran and reported the planted failure. **A control that passes fails the gate.** This is the mechanical form of the governing principle |
| DUR-G6 | Every crash property ships a negative control | G | G5; a crash property id with no paired control id fails |
| DUR-G7 | `dbstat` and `unsafeMode` appear only in fixtures | G (source lint) | zero occurrences under `src/`; occurrences confined to the fixture modules named in §4 |
| DUR-G8 | The runtime `sqlite_version()` matches the supply-chain inventory | G | F19; assertion at suite start |
| DUR-G9 | No document cites the §0.6 transcript, or any pre-B-6 backup figure, as the B-6 result | G | a scan for the transcript's distinguishing values (`2867`, `totalPages`) and for the corpus `node:sqlite` values (`691`, `1539`, `781`, `169678`) outside a block explicitly labelled as superseded |
| DUR-G10 | No document in this lane's set cites the Lean cut-line's survival as migration-safety evidence | G | G10; doc lint |
| DUR-G11 | The conformance-manifest id removals and the `EXPECTED_REQUIRED_COUNT` change are separate commits | G (history) | G11; a check over the commit range fails if one commit touches both |
| DUR-G12 | If the Windows-out-of-scope branch is taken, the build fails on Windows rather than leaving it undefined | G | I5 gap (§1.5); a platform assertion at package entry, asserted by a test |

---

## 3. Negative controls

A negative control that never runs is a comment. Every control below is **planted in a fixture, not
in shipped code**, executes in CI, and is asserted to fail. DUR-G5 fails the gate if any control
passes.

**Planting mechanism, uniformly.** Each control lives in a `test/fixtures/negative/` module that
builds a throwaway database or a throwaway subclass/wrapper in test scope only. None modifies `src/`.
Three planting techniques are used and each is named per control below:

- **(T) throwaway schema** — the fixture applies its own DDL (a lineage variant missing a trigger,
  an index, or a constraint). Nothing ships.
- **(W) wrapper override** — the test subclasses or wraps the shipped adapter and overrides one
  method with the forbidden shape. The shipped class is untouched; the override is local to the file.
- **(F) file surgery** — the fixture writes bytes into a closed database file, using `dbstat` to
  select the page by role. No code path is replaced at all.

| id | Control (the wrong implementation) | Plant | What its failure proves |
|---|---|---|---|
| **DUR-NC1** | A build that reads `synchronous` once at bootstrap and caches it, instead of asserting it at every covered commit | W | That P11 is not vacuous. The pragma is persistent *in the file* and mutable out from under the library; a cached read reports the floor holding while the file says otherwise. Failure = the property is actually checking the live value |
| **DUR-NC2** | The forbidden **cursor-first** ordering: advance the watermark, then save the checkpoint, in two transactions | W | That P12's cursor-never-ahead assertion detects the failure it names. The sprint measured this violating the invariant 4/9 under SIGKILL. Failure = a green P12 means the co-transactional shape held, not that the harness is blind |
| **DUR-NC3** | `foreign_keys = OFF` on the connection | T | That P14 is load-bearing: with it off, a manifest delete silently removes **no** junction rows and reports success — garbage collection becomes a no-op. Failure = the `ON` assertion prevents a real silent no-op |
| **DUR-NC4** | A bare value hash — `sha256(value)` with no version byte, no length prefixes, no table/column/PK binding | W | That the framed preimage is what detects whole-row substitution. Under the control, the moved `(value, dg)` pair verifies **clean**. Failure = the framing, not the algorithm, is doing the work |
| **DUR-NC5** | Archive `setWatermark` as a **separate second commit** after the bundle | W | That DUR-X6 detects the gap. Failure = the single-transaction ingest is what closes it, and the crash test can see the difference |
| **DUR-NC6** | The drift-guard trigger **alone**, with no anti-downgrade trigger | T | That `UPDATE t SET dg = NULL` is accepted, the row becomes permanently unverified, and the every-covered-read-is-verified guarantee becomes false one row at a time. Failure = the anti-downgrade trigger is mandatory, not defence-in-depth. *This is the control for the exact statement the sprint measured slipping through* |
| **DUR-NC7** | `quick_check` offered as a faster alternative to `integrity_check`, evaluated against the **content**-divergence fixture | F | That the two are not interchangeable. §0.3: `integrity_check` reports `row 250 missing from index ix`; `quick_check` returns **`ok`**. Failure = the prohibition is grounded in the fixture that actually distinguishes them — **not** the count-divergence fixture, which `quick_check` catches |
| **DUR-NC7b** | The **count**-divergence fixture offered as the evidence for NC7 | F | That the plan's own first instinct was wrong. `quick_check` reports `wrong # of entries in index ix` here. This control fails *as a control* — it does **not** produce the blindness — and DUR-G5 records it as a **documented non-control**, so a future author cannot re-adopt it. See §0.3 |
| **DUR-NC8** | The digest sweep run **alone**, without the structural check, against the content-divergence fixture | F | That the sweep is Class-B blind by construction. Every row it is handed is intact, so it reports zero failures while an indexed lookup returns the wrong row. Failure = neither tier subsumes the other, executably |
| **DUR-NC9** | The structural check run **alone**, without the sweep, against the overflow-payload fixture | F | The mirror of NC8. `integrity_check` returns `ok` and the corrupted row is returned as data. Together NC8+NC9 prove the two-blindness claim in both directions |
| **DUR-NC10** | An implementation that verifies **value** digests at `open()` and refuses the database on any mismatch | W | That whole-database refusal on one bad record is the shape being avoided. Under the control, every undamaged key becomes unreachable. Failure = row-scoping is a design choice with a measured alternative |
| **DUR-NC11** | A **silently no-opping** monotonic watermark guard (return without action when the incoming position is not greater) | W | That I-6 converts a latch into a detection point. The control drives **four consecutive legitimate advances** and asserts all four are silently discarded, the skipped range never fetched. Failure = the anti-latch check fires on the **first** suppression |
| **DUR-NC11b** | The I-6 digest check placed on the **success** path instead of the suppression path | W | That placement is the whole mechanism. A corrupted-high cursor never takes the success path, so the check never fires. Failure = R16a's placement requirement is load-bearing |
| **DUR-NC12** | An archive cursor bound written as `max(height) + 1` instead of `coalesce(max(height), -1) + 1` | T | That the zero-row state — **the archive's own specified starting state** — is where the bare form silently fails: the comparison evaluates to NULL and the invariant does not fire. Failure = the `coalesce` is not stylistic |
| **DUR-NC13** | A manifest derived **from the source** before the copy starts | W | That derive-from-artifact is what makes at-or-after capture harmless. Under concurrent ingest the control's manifest under-reports the artifact, and the restore verification either fails on a row count or — worse — passes while artifact and label disagree. Failure = the property is structural, not incidental |
| **DUR-NC14** | An `src/`-resident snapshot module that opens the three-file set with JS `fs` calls | W (+ two OS processes) | That an in-process three-file copy **is** the `-shm` descriptor attack performed by our own tooling. Both commits return success, one acknowledged commit is silently lost, `integrity_check` reports `ok`. Failure = the descriptor ban's value is that it takes no exemptions, including for trusted code |
| **DUR-NC15** | A restore verification reporting `pass` for all four checks against a **fresh zero-row archive** | W | That empty scope is not success. This sprint found five separate vacuous-pass instances. Failure = the `n/a — no rows in scope` outcome is doing real work |
| **DUR-NC16** | A `synchronous`-lowering proposal supported only by SIGKILL trials | G (record fixture) | That the decision rule rejects process-crash evidence for a power-loss claim. The gate is fed a synthetic proposal record; it must reject it naming precondition 2. Failure = B4 is enforced, not merely written |
| **DUR-NC17** | A backup-primitive proposal citing a measurement whose recorded binding is not the ruled one | G (record fixture) | That E9's rejection is mechanical. The gate is fed the corpus record (`node:sqlite`, 691 MB, 1,539 ticks, 781 commits) and must reject it on the binding field alone, without reading the timings |
| **DUR-NC18** | A digest computed over a **parsed/re-serialised logical value** | W | That the preimage must be over stored bytes. Under the control, a byte-preserving re-encoding (key order, whitespace, numeric format) fails **every** previously written row although no data is damaged. Failure = the cry-wolf failure mode is avoided by construction, not by care |
| **DUR-NC19** | Salvage mode used as a hot-path verification opt-out | W | That salvage buys no throughput: digests are still computed on write, still compared on read, every mismatch still reported, and `verifyIntegrity()`'s report is unchanged (deep-equal). Failure = the bypass cannot stand in for the prohibited opt-out |
| **DUR-NC20** | An unnamed corruption error (no table, no primary key) | W | That naming the row is what avoids forcing a full restore for a single-row fault. Failure = the consumer can scope the damage |
| **DUR-NC21** | A power-loss rig configuration the rig is supposed to catch (`synchronous=OFF` + cache-loss injection) | rig config | **The control that licenses the entire power-loss result.** If it does not fail, the rig injects nothing and DUR-S8's green is meaningless. See §4.6 |
| **DUR-NC22** | An evidence artifact with a blank cell in a binding-rule-2 table | doc fixture | That DUR-E3's lint fires. Failure = the artifact's existing violation cannot recur |
| **DUR-NC23** | A `verifyIntegrity()` that throws on a finding | W | That the pass reports and never refuses. Under the control the database becomes unusable for undamaged rows. Failure = the report-don't-refuse rule is checked |
| **DUR-NC24** | A translator keyed on numeric `err.errcode` | W | That the string discriminator is load-bearing. Every driver error falls through to the catch-all with no throw and no warning **while the error-catalog drift test stays green** — which is why per-code reachability assertions exist. (Shared with the errors lane; listed here because DUR-C22's discriminator assertions depend on it) |

---

## 4. Fixtures and harnesses

### 4.1 `corruption-injection` — the Class A / Class C fixture factory

The most important new harness in this lane, and §0 establishes it works.

**Build:** ext4 under `/root` (never `/tmp`, DUR-G1 enforced); `page_size` = B-3a; `auto_vacuum` =
B-3a; `journal_mode=WAL`; `synchronous=FULL`. Apply the real lineage. Write **≥ 2,000 covered rows**
across every covered table, with payloads spanning inline-only (< ~`usable-35` bytes) and
overflow-forcing (≥ 8 KB, so ≥ 2 overflow pages at any candidate `page_size`) — UmbraDB's blobs are
the overflow case and the fixture must contain both. Total < 50 MB, i.e. ≪ RAM; this fixture produces
no timing figure so cache residency is stated only for completeness.

**Checkpoint:** `PRAGMA wal_checkpoint(TRUNCATE)` and close, so the injection target is the main
file. A fixture that skips this corrupts a `-wal` frame instead and gets a different (checksummed)
answer — this is the single easiest way to build a test that silently exercises the wrong case.

**Select the page by role** — `SELECT pageno, pagetype FROM dbstat WHERE name = ?`:
- `overflow-payload`: a page with `pagetype='overflow'`. Write 64 bytes at
  `(pageno-1)*page_size + j`, `j ≥ 4` (§0.2: skip the next-page pointer). Asserts a **Class A**
  case.
- `btree-structure`: a page with `pagetype IN ('leaf','internal')`. Clobber the 2-byte cell count at
  header offset 3. Asserts a **Class C/structural** case.
- `inline-payload`: a leaf page, targeting a byte inside a short value's cell body located by marker
  search. Class A without overflow, so the coverage claim is not overflow-specific.

**Guards:** the factory asserts `dbstat` returned ≥1 page of the requested type and **throws** if
not — a fixture with no overflow pages must never silently degrade to corrupting a leaf.
`assertRealFilesystem()` runs first.

**Structural-case assertion helper:** `expectStructuralFault(db)` accepts **either** a non-`ok` row
list **or** a thrown `SqliteError{code:'SQLITE_CORRUPT'}` (§0.2), so a test cannot pass or fail on
which observable the engine happened to pick.

### 4.2 `index-divergence` — the Class B fixture factory

Two constructions, deliberately not interchangeable (§0.3):

- **`content-divergence`** *(the one the negative controls use)*: apply the lineage; insert ~500
  rows; capture the target index's `sqlite_schema` row; `unsafeMode(true)` +
  `PRAGMA writable_schema=ON`; delete the index's schema row; reopen; **UPDATE** one row's indexed
  column; reopen; re-insert the captured schema row verbatim (same `rootpage`). Result: equal entry
  counts, one stale key. `integrity_check` fires, `quick_check` returns `ok`, the stale key resolves
  through the index to a row the table no longer holds, and the row's bytes are intact.
- **`count-divergence`**: identical but **INSERT** a new row instead of updating. `quick_check`
  reports the count mismatch. Kept as an executable record of why it is *not* the control (DUR-NC7b).

Both are file-surgery-free — they use `writable_schema`, which is more robust across page layouts
than editing index b-tree pages by hand.

### 4.3 `latched-cursor` — the I-6 / anti-latch fixture

A watermark row written normally (value + digest), then its **value** corrupted upward via §4.1
overflow/inline injection while its `dg` is left intact — so the corrupted-high state is reachable
and the digest is the thing that detects it. The fixture then drives **four consecutive legitimate
advances**, each of which the monotonic guard would suppress. Asserts:
- with I-6: the **first** suppression verifies the incumbent digest and raises `ValueIntegrityError`;
- with DUR-NC11 (no-op guard): all four advances are silently discarded and the corrupted position
  persists;
- with DUR-NC11b (check on the success path): nothing fires across all four.

### 4.4 `archive-live` — populated archive under concurrent ingest

A real archive lineage on its own file (ext4, `page_size`/`auto_vacuum` = B-3b, `journal_mode=WAL`,
`synchronous` = B-2). Populated to **≥ 50,000 canonical blocks** with transactions, blob rows, both
observation tables and a non-empty archive watermark — enough that the continuity walk, per-table row
counts and content digest are all non-trivially populated, and small enough (target < 2 GB) that CI
can hold it. Dataset-vs-RAM recorded with every run that reports a duration.

A **separate-process** ingest driver commits bundles continuously during snapshot production (this is
what makes DUR-N2's at-or-after property observable at all, and it is the same separate-process
requirement M-7 imposes). A `gc-race` variant additionally runs a garbage-collection pass concurrently
for DUR-B14/P13, and asserts ≥1 manifest and ≥1 chunk reclamation actually occurred in the trial —
otherwise it reports `n/a — no GC activity in scope`.

### 4.5 `descriptor-hazard` — two OS processes and a syscall trace

Process A opens the database, takes `BEGIN IMMEDIATE`, and blocks on a file-based rendezvous.
Process B (a *separate OS process*, not a worker thread) attempts a commit. Between them, a planted
in-process JS `fs.openSync(path + '-shm')` / `fs.closeSync()` runs inside process A. Asserts the four
observables of DUR-B7. The syscall-trace half (DUR-B6) runs
`strace -f -e trace=openat,write` with `MARKER_BACKUP_START` / `MARKER_BACKUP_END` written to stdout
in-band, and greps for sidecar opens **strictly between the markers** — the discriminator §0.5 shows
is necessary, because the engine's own long-lived WAL handles open outside the window and a naive
grep counts them.

### 4.6 `power-loss-rig` — the rig nobody has, specified concretely

**This host cannot be the rig for record** (§0.7). Specified in two tiers.

**Tier 1 — QEMU with an emulated volatile write cache (the primary, and the one CI can own).**
- Guest: a minimal Linux image; the database on a dedicated virtual NVMe namespace,
  `-device nvme,serial=udb,write-cache=off` with `cache=none` on the backing file, so the guest's
  `fsync` reaches the emulated device and the emulated device does not lie.
- Workload: the co-transactional `saveAndAdvance` shape (never a bare insert — the unit of work is
  fixed by change 5's precondition 1), driven at a fixed rate, each commit recording its
  acknowledgement to an **out-of-band** log on a *different* virtual disk that is not part of the
  power cut. That out-of-band log is what makes "acknowledged" checkable after the cut; without it the
  rig can only observe the database's own state and cannot tell a lost commit from one never issued.
- Injection: the host issues `quit` to the QEMU monitor — an instantaneous machine stop, not a guest
  shutdown, so no guest-side flush occurs. The volatile write cache's contents are discarded by
  construction. Injection point is randomised uniformly within the workload window.
- Trials: **N = 200** per configuration. Rationale, stated so it is not a magic number: at N=200, a
  failure mode with a 1.5% per-trial probability is observed with ~95% probability; the sprint's own
  crash harness observed its forbidden shape at 4/9, so the effect sizes that matter here are far
  larger than the rig's resolution. N is recorded with the result, and a larger N never invalidates a
  smaller one — it only tightens the bound. **The plan does not claim N=200 proves absence.**
- Per trial, after restart: (a) `integrity_check` — `ok`; (b) every commit acknowledged in the
  out-of-band log is present in the database; (c) the durable cursor is not ahead of durable data.
- **Negative control (DUR-NC21), mandatory:** the identical rig at `synchronous=OFF` with the same
  injection. It **must** produce ≥1 failing trial. A run where the control is also clean is a
  **rig failure**, reported as such, and the positive result is discarded. This is the criterion
  "with a failing negative control" and DUR-G5 enforces it.

**Tier 2 — `dm-flakey`, as a cheaper pre-flight.** `dmsetup create` over a loop device with the
`drop_writes` feature enabled for an interval; the database sits on the flakey target. Useful for
developing the harness and for proving the *detection* logic before spending a QEMU cycle. **Not
admissible as the recorded evidence on this host**, because every write below the target still passes
through a VHDX file on NTFS under the Windows host cache (§0.7) — the layer that would have to be
honest is the one being emulated away. Admissible only on a bare-metal Linux host with the target over
a real block device, and the record must state which.

**Tier 3 — physical power cut.** A machine with a switched PDU. Highest fidelity, lowest throughput
(minutes per trial). Specified as the tie-breaker if Tier 1 and Tier 2 disagree, not as the default.

**What a green result licenses.** DUR-S8 green at `synchronous=FULL` records that the shipped default
holds under the rig. It does **not** lower anything. Lowering to `NORMAL` requires DUR-S9's result at
`NORMAL` **plus** DUR-S10's three-precondition gate — a magnitude measured under change 1's
conditions, this power-loss evidence with its failing control, and a named accepter in the release
record. Any one missing → rejected.

### 4.7 `evidence-regeneration` — what regenerating `EVIDENCE.md` actually requires

The artifact must be **re-executed**, not amended, and it violates its own binding rule 2 today: the
Cold-boot round-trip table's six cells are blank — neither captured nor marked `NOT CAPTURED`.
Concretely, regeneration needs:

1. **A funded Preprod wallet and a seed file.** The current artifact's run was `npm run test:live`
   with `UMBRADB_LIVE_PREPROD=1` against `indexer.preprod.midnight.network`. CI structurally cannot
   run this; it is the one manual gate.
2. **The RC commit.** Binding rule 1 forbids carrying an earlier green run forward. The Run-identity
   table's SHA must be the SHA that will be tagged.
3. **Replacement of the engine-named rows.** `Postgres | Testcontainers postgres:17-alpine` and the
   M5-3 wording "a fresh object graph is constructed **from Postgres**" are engine-named rows, not
   incidental prose. They become the SQLite engine identity: binding + pinned version, runtime
   `sqlite_version()`, `journal_mode`, `synchronous`, `page_size`, `auto_vacuum`, and the filesystem
   the database file sat on.
4. **The six Cold-boot cells, captured.** They are: `walletId`; durable cursor at kill; durable cursor
   after restore; `highestTransactionId` after restore; full-resync-avoided; tx-history-continuous.
   Note the *values already exist in the artifact's own captured transcript* (the phase-B log line
   reports `appliedId` and `highestTransactionId`, and the phase-A line reports the `walletId`) — the
   table was simply never filled from it. That is the whole defect, and it is why DUR-E3's lint is
   worth more than a reviewer: the evidence was captured and the artifact still shipped incomplete.
   Regeneration transcribes captured output into every cell, or writes the literal `NOT CAPTURED`.
5. **The lint wired into the required gate**, so the state cannot recur (DUR-E3).

### 4.8 `pg-differential` — the fixture that makes the new-capability claim measurable

For DUR-E8. Two adapters, one payload-corruption scenario. The PostgreSQL side uses the project's
pinned `postgres:17-alpine` image, and the fixture **asserts `SHOW data_checksums` returns `off`**
before injecting, so the comparison is against the deployment UmbraDB actually shipped — not a
hypothetical checksummed one. The corruption is applied to the heap file for the target row; the
assertion is that the value comes back to the caller with no error. The SQLite side runs §4.1's
`overflow-payload` case through the same adapter interface and raises `ValueIntegrityError`.

This is the honest strong claim: the digest regime detects a class of fault the previous deployment
returned silently. It is a **new capability**, not restored parity.

### 4.9 Shared helpers

- `assertRealFilesystem(dir)` — `statfs` f_type check, called by every fixture factory (DUR-G1).
- `assertFixtureNonEmpty(scope)` — returns row counts and throws on zero, or the caller must report
  `n/a — no rows in scope` (DUR-V9).
- `expectStructuralFault(db)` — accepts either observable (§0.2).
- `recordConditions()` — emits the full condition set alongside any result, so DUR-G2's schema
  validation has something to validate.
- `withStatementRecorder(db)` — used by DUR-C6, DUR-C15 and DUR-C16 to assert *which* statements ran.

---

## 5. What cannot be tested, and the nearest achievable substitute

### 5.1 The guarantee `synchronous=NORMAL` declines to make, on the CI host

**Cannot:** CI cannot remove power. Everything in the existing corpus came from `SIGKILL`, which is a
*process* crash — precisely the guarantee `NORMAL` **does** make. A `SIGKILL` corpus is evidence about
the guarantee `NORMAL` keeps and says nothing about the one it declines.

**Substitute:** §4.6 Tier 1 (QEMU + `nvme,write-cache=off`) run out-of-band on a host that is not this
one, on a schedule, with its result recorded in the release record rather than as a per-PR gate. In
per-PR CI the substitute is the *rig's own negative control* — DUR-NC21 must be demonstrated failing
at least once per rig revision, so the rig's detection power is a tested property even when the rig's
result is not a gate.

**Explicitly recorded:** the plan does **not** claim N trials prove absence of loss. It claims the rig
detects the failure it looks for, and that no loss was observed at the recorded N.

### 5.2 `SQLITE_IOERR_*` and `SQLITE_FULL`

**Cannot:** the ruled binding exposes no VFS hook (its prototype, §0.4, has no VFS entry), so
`LEASE_FAULT` and `DISK_FULL` are reachable-in-principle and uninjectable in CI.

**Substitute:** (a) DUR-E14 records the gap in the catalog rows themselves, naming what would close it;
(b) a bounded, out-of-CI experiment using a small `dm-error`-backed device or a fault-injecting FUSE
filesystem, recorded once and cited, rather than left as an open forever; (c) the translator's mapping
for these codes is unit-tested by *synthesising* an error object with the binding's exact
`{name, code}` shape — which tests the translation but explicitly **not** the reachability, and the
test's name says so.

### 5.3 A coherently wrong file

**Cannot:** a restore from a stale but internally self-consistent backup passes `integrity_check`,
every digest, the schema digest and every invariant. Nothing UmbraDB can run detects it.

**Substitute:** a test that **demonstrates the limit** rather than closing it — restore an older,
internally consistent snapshot and assert the verification pass reports a full `pass` while the
content is stale. Its purpose is to make the documented limit executable, so a future author cannot
quietly claim the pass covers it. DUR-E5/DUR-E12 assert the limit is stated; this test asserts it is
*true*.

### 5.4 The filesystem-type refusals CI cannot produce

**Cannot:** CI has no `nfs`, `cifs`, `v9fs` mount, and mounting one is a privileged operation.

**Substitute:** the classifier is unit-tested by injecting `statfs` f_type constants directly (which
is the whole decision), and exactly one filesystem type is tested end-to-end — `tmpfs`, via `/tmp`,
which this host has. The gap that remains is that the *observation* function's f_type extraction is
exercised for one type only; DUR-P5 records this and the substitute is a table-driven test over the
constants with a comment naming the untested extraction path.

### 5.5 Windows filesystem locking

**Cannot:** no Windows runner is in scope, and `LockFileEx` semantics differ.

**Substitute:** force the decision (DUR-E15) and, if out-of-scope is chosen, make it *enforced*
(DUR-G12) rather than merely stated. An undeclared platform is the failure mode; a declared and
enforced exclusion is not.

### 5.6 `verifyIntegrity()` at archive scale

**Cannot:** unmeasured, so no runtime assertion is possible and none is written.

**Substitute:** DUR-N13 asserts no document *implies* it is affordable, and §6 specifies the
measurement (M-7) that would promote it from diagnostic to gate. Until then the pass is a diagnostic
and post-restore check, and no test treats it as a gate.

### 5.7 Adversarial modification

**Cannot and will not:** the digests are unkeyed, so they are corruption detection and not tamper
protection, under the single-trusted-writer model.

**Substitute:** DUR-E5 asserts the contract says so in the at-rest section. No test pretends
otherwise; a test claiming tamper detection would be the dishonest kind of coverage.

### 5.8 The field corruption base rate

**Cannot:** no seat obtained one, and the plan will not manufacture one.

**Substitute:** DUR-E10 asserts no document makes a frequency claim in either direction and that the
record states the open honestly.

---

## 6. Blocked on measurement

Every entry names the B-gate or obligation, the datum required, what stays blocked, and — where a
threshold is needed — the experiment that produces it. **No test below may borrow a sprint figure as
its threshold.**

| Blocked test | Gate | Datum required | State until closed |
|---|---|---|---|
| DUR-S1, DUR-P7 (the asserted values) | **B-2** (`synchronous` default), **B-7** (which values the probe asserts) | Sustained commit throughput at `NORMAL` and `FULL`, in-cache and out-of-cache, on ext4, unit of work = co-transactional `saveAndAdvance`. B-2's decision rule: default `FULL`; adopt `NORMAL` **only if** `FULL`'s out-of-cache commit rate leaves < 2× headroom over measured sustained wallet write demand | Tests run against `FULL` as the shipped default and assert **at-or-above-floor**, never a specific level, so closing B-2 changes a constant and not a test |
| DUR-C1, DUR-C11, all §4.1 fixtures | **B-3a** (`page_size`, `auto_vacuum` — wallet file) | The chosen values, with the command that produced the decision | Fixtures parameterise `page_size`/`auto_vacuum` from a single resolution module. **A fixture hard-coding 4096 is a defect**, because the overflow threshold moves with `page_size` and the fixture would silently stop producing overflow pages |
| DUR-N12, DUR-N9, §4.4 | **B-3b** (`page_size`, `auto_vacuum` — archive file) | Same, for the archive's own file; explicitly a **second** decision, and change 6's P3 requires the `auto_vacuum` consequence be recorded **before any archive file exists** | The archive fixture is parameterised identically; DUR-N9's mismatch test needs two distinct values, so it is blocked until B-3b names one |
| DUR-B1, DUR-B2, DUR-B4, DUR-B6, DUR-N-snapshot-copy-path | **B-6** (`backup()` vs `VACUUM INTO`) / **B-7** | The re-measurement on the ruled binding under a concurrent writer at B-2's `synchronous`, on a probe-accepted filesystem, dataset stated relative to page cache, per-candidate duration + event-loop ticks + destination structural check + destination row/page count vs source-committed-at-call + **sidecar-descriptor boolean**. B-6's rule: choose `backup()` if it does not block beyond one batch interval **and** the copy passes `integrity_check`; choose `VACUUM INTO` if `backup()` fails either and it passes both; **if both fail, no online mechanism is specified** and §6 documents the offline post-quiesce copy | DUR-B1 is **active now** and asserts §6 names no primitive. DUR-B2 activates when the record lands. §0.6's transcript is **not** this datum and DUR-G9 fails any document that cites it as such. Branch B is a complete outcome, not an incomplete change |
| DUR-S8, DUR-S9, DUR-S10 | change 5's **precondition 2** (power-loss evidence) | A §4.6 rig run at both `synchronous` levels, N and its justification recorded, **with DUR-NC21 demonstrated failing** | DUR-S10's gate is active now and **rejects** any lowering proposal lacking the evidence. DUR-S8/S9 are authored and skipped-with-reason until a rig host exists — never silently absent, and DUR-G5 asserts they are reported as blocked rather than passing |
| DUR-N13, and any promotion of `verifyIntegrity()` from diagnostic to gate | **M-7** | The verification pass's runtime at a representative archive scale, with the **structural check and the digest sweep measured as separate components**, writer concurrency driven from a **separate process**, all conditions recorded | The pass stays a diagnostic and post-restore check. DUR-N13 fails any document that schedules it. **The measurement that would promote it:** M-7 at the §4.4 archive scale (≥50,000 blocks), both components separately, separate-process writer, out-of-cache and in-cache datasets, on ext4 — plus a stated budget from the change's owner against which the measured runtime is compared. Absent that budget, the measurement records and does not promote |
| DUR-C10's storage-delta half, and any coverage-set narrowing | change 5's **digest write-cost obligation** | Digest write cost under change 1's gate conditions, and the storage delta on **real** rather than synthetic payloads | **Records, never gates.** The coverage set is unconditional. A proposal to drop a table because the measured cost came in high is rejected by DUR-C4, which derives the covered set from the spec and not from a cost input |
| DUR-N14 (the archive rebuild transcript) | change 6's **rebuild-path obligation** | One executed transcript showing an altered projection column reported as divergent, with both limits stated | Until it exists, a gate asserts the contract's archive row claims only "resynchronise from chain" and never a local rebuild |
| DUR-B14/P13 at scale | **M-6** | GC-race backup behaviour with the concurrent-writer commit count recorded, published alongside the B-6 record | The property runs at fixture scale now (correctness); the scaled run is blocked. M-6 **informs** the stall question and does **not** choose the primitive |
| DUR-X1/P11's floor constants | **B-2**, **B-7** | The floors themselves | Asserted as at-or-above a symbol imported from the resolution module; DUR-G4's lint rejects a numeric literal here |

**One cross-cutting rule.** Every blocked test above is **authored and committed now**, reporting
`blocked on <gate>` rather than skipped silently or omitted. DUR-G5 asserts each blocked id is present
and reported as blocked. A blocked test that disappears from the manifest is indistinguishable from a
test that was never written, which is the same failure shape as a negative control that never runs.

---

## Appendix — findings this lane hands back to the sprint

1. **`quick_check` is not uniformly blind** (§0.3). It catches index *count* divergence and returns
   `ok` only on *content* divergence. The spec's prohibition stands; the evidence for it must be the
   content-divergence fixture, and any text or test citing "six of six returned `ok`" should be
   re-derived. Filed against change 5's "verification pass" requirement and criterion C5a.
2. **The ruled binding's `backup()` has no `AbortSignal` parameter** (§0.4) — `backup.length === 2`,
   options `{attached, progress}`. E3's sentence must be "no cancellation affordance exists". The
   accepts-and-ignores finding is `node:sqlite`'s and must not be carried forward.
3. **A cooperative cancellation *is* implementable** on the ruled binding via the `progress` callback
   between `setImmediate` page batches (§0.4). §6 stating "uncancellable" without qualification would
   be false. DUR-B5 forces the decision to be recorded.
4. **`integrity_check` throws rather than returns on a structural fault** (§0.2). Any test asserting
   on its row list fails to exercise the case. Affects C2's structural half, P15, and W5.
5. **`ENABLE_DBSTAT_VTAB` is compiled into the pinned build** (§0.1), which makes deterministic,
   page-role-targeted corruption injection possible. This is what turns "corrupt bytes and hope" into
   a test that knows which case it exercised.
6. **`unsafeMode(true)` exists on the ruled binding's prototype** and is required for the Class B
   fixtures. Change 5's precondition P2 should read "no `enableDefensive` entry point", not
   "defensive mode cannot be toggled" — the stronger reading would wrongly imply these fixtures are
   unbuildable.
7. **`backup()` opens zero sidecar descriptors during the copy** (§0.5), measured with in-band
   markers. E10c can be a test rather than an attestation — but only with the marker discriminator,
   since the engine's own WAL handles open outside the copy window and a naive syscall grep counts
   them as violations.
8. **`EVIDENCE.md`'s six blank cells were already captured in its own transcript.** The phase-A and
   phase-B log lines carry the `walletId`, `appliedId` and `highestTransactionId`; the table was never
   filled from them. The defect is transcription, not capture — which is exactly why a lint is worth
   more than a reviewer here.
