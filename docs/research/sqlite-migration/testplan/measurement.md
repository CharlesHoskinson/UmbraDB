# Test plan — lane `measurement`

**Subject:** change `v1.0.0-sqlite-engine-core`, the measurement gate and the blocked-decision
register **B-1 … B-8**, plus every downstream test that cannot get a threshold until a B-gate closes.

**Governing rule for this lane, stronger than the sprint's:** this lane produces *no* pass thresholds.
It produces the apparatus that produces them, and the executable decision rules that convert an
artifact datum into a choice. Where a number appears below it is either (a) a **labelled-inadmissible**
reference carried so a reviewer can see what is being replaced, or (b) an **apparatus-validation
pilot** measured by this lane — which is admissible as evidence that *the experiment discriminates*
and inadmissible as evidence for *any decision*. Both are marked inline. Neither may be cited by a
requirement.

---

## 0. Ground facts this lane measured (apparatus validation, not the artifact)

Recorded first because five of the six sections below depend on whether these mechanisms exist on the
host at all. Every command is pasted; nothing here is asserted.

### 0.1 The host

```
$ findmnt -T /root -o TARGET,SOURCE,FSTYPE,OPTIONS
TARGET SOURCE   FSTYPE OPTIONS
/      /dev/sdd ext4   rw,relatime,discard,errors=remount-ro,data=ordered

$ findmnt -T /tmp -o TARGET,SOURCE,FSTYPE,OPTIONS
TARGET SOURCE FSTYPE OPTIONS
/tmp   tmpfs  tmpfs  rw,nosuid,nodev,size=32740652k,nr_inodes=1048576

$ free -b | head -2
               total        used        free      shared  buff/cache   available
Mem:     67052851200  5518753792 48757682176  2239905792 15669002240 61534097408

$ uname -r
6.18.33.2-microsoft-standard-WSL2
```

62.4 GiB RAM. `/root` is ext4 on `/dev/sdd`, 577 GB free. `/tmp` is a 32 GB tmpfs, exactly as the
brief states. **The `/dev/sdd` device is a WSL2 VHDX on Windows NTFS** — see §5.2, this is a
first-class condition, not a footnote.

### 0.2 The three-detector filesystem check works, and the detectors agree

Prototype at `/root/measure-proto/fscheck.mjs`. Run against both filesystems:

```
$ node fscheck.mjs /root/measure-proto        $ node fscheck.mjs /tmp
  mount.fstype        "ext4"                    mount.fstype        "tmpfs"
  statfs.magicHex     "0xef53"                  statfs.magicHex     "0x1021994"
  diskstats.deltaSectors  65752 (sdd)           diskstats.deltaSectors  0
  fsync p50 / p99     4.164 / 7.715 ms          fsync p50 / p99   0.000591 / 0.004228 ms
  REFUSE              false                     REFUSE              true
```

Three findings that shape the design of M-01…M-04:

1. **`mountinfo` fstype and `statfs` magic agree**, but they are the *same* evidence read two ways —
   both trust the kernel's declaration. They are not independent.
2. **The `/proc/diskstats` delta is genuinely independent and behavioural.** 32 MiB of varied,
   `fsync`'d content produced 65,752 sectors (≈32.1 MB) on `sdd` and **exactly zero** on tmpfs. This
   detector survives a doctored mount table, a bind mount, an overlay whose upper layer is tmpfs, and
   a container that hides `/proc/mounts` — none of which the first two survive.
3. **`fsync` cost separates by ~7,000×** (4.164 ms vs 0.000591 ms). This is recorded as a *corroborating
   observation* and is deliberately **not** a gate predicate: a battery-backed NVMe with a volatile
   write cache can post sub-100 µs `fsync`, so a latency threshold would produce false refusals on
   legitimate hardware. Detector 3 measures *whether bytes reached a block device*, which has no such
   failure mode.

### 0.3 Out-of-cache is reachable in minutes — the research's excuse is refuted

The research phase declined to measure beyond the page cache and used its own unmeasured claim
("out-of-cache behaviour was unobservable") as the reason. It is observable, cheaply, three ways, all
verified present on this host:

```
$ cat /sys/fs/cgroup/cgroup.controllers
cpuset cpu io memory hugetlb pids rdma

$ sync && echo 3 > /proc/sys/vm/drop_caches && free -h | head -2
               total        used        free      shared  buff/cache   available
Mem:            62Gi       4.9Gi         57Gi      2.1Gi        3.0Gi        57Gi     # was 15Gi
```

And the decisive one — a cgroup v2 memory cap **does** bound the page cache available to the bench
process (`/root/measure-proto/cgroup-check.sh`):

```
$ systemd-run --scope -q -p MemoryMax=512M -p MemorySwapMax=0 --slice=bench.slice \
    /root/measure-proto/cgroup-check.sh
cgroup: /bench.slice/run-p1569906-i1571373.scope
memory.max: 536870912
memory.swap.max: 0
memory.current after reading 2GiB: 535982080
file cache in cgroup: file 532688896
```

A 2 GiB file read inside a 512 MiB cap holds file cache at 532 MiB. **A 4 GiB dataset under a 512 MiB
cap gives an 8:1 over-cache ratio in minutes**, without building an 80 GB database and without waiting
for the Midnight sync. This is the mechanism §4.4 specifies.

### 0.4 The B-1/B-2 experiment shape works and the two `synchronous` values separate

Pilot at `/root/measure-proto/b1b2-pilot.mjs`. 5,000 back-to-back same-key puts into a
`STRICT, WITHOUT ROWID` table with `PRIMARY KEY (key, valid_from_ms)`, each put its own implicit
transaction, on `/root` (ext4), WAL, `better-sqlite3@13.0.2` / SQLite 3.53.4, `page_size=4096`,
`auto_vacuum=0`, single writer, dataset ≪ RAM.

| `synchronous` | accepted | rejected | rejection rate | commits/s | p50 | p95 | p99 |
|---|---|---|---|---|---|---|---|
| `1` (NORMAL) | 52 | 4,948 | **98.96 %** | 97,828 | 0.0087 ms | 0.012 ms | 0.036 ms |
| `2` (FULL) | 5,000 | 0 | **0.000 %** | 140.8 | 4.651 ms | 16.96 ms | 31.16 ms |

> **INADMISSIBLE FOR ANY DECISION.** Single run, one page size, no concurrent writer, no out-of-cache
> cell, no repetition, and no `cv`. It is pasted because it proves the apparatus **discriminates** —
> which is the only claim this lane makes for it. When the real harness runs, these must be reproduced
> within the artifact's declared repetition envelope or the discrepancy is itself a finding.

Four things the pilot establishes about the *design* of the experiments, which are not numbers and do
carry forward:

**(a) B-1 is not an independent experiment. It is determined by B-2, and the relationship is an
identity.** At NORMAL, 52 puts were accepted over 51.1 ms of wall clock — one accept per distinct
millisecond, because the collision key is a millisecond timestamp. At FULL, p50 commit latency of
4.65 ms means no two puts can share a millisecond, so the rate is 0% by construction, not by chance.
The identity is:

```
accepted ≈ ceil(total_elapsed_ms / clock_granularity_ms)      [when latency < granularity]
rejection_rate ≈ 0                                            [when latency > granularity]
```

This is load-bearing twice over. It gives B-1 a **built-in consistency control** (NC-06): if the
measured rejection rate is not predicted by the measured commit latency, one of the two measurements
is wrong and neither may be used. And it means B-1's close rule must be evaluated **after** B-2's,
never in parallel — which the plan's task ordering must state, because §6.4's table reads as if the
eight rules are independent.

**(b) The rejection phenomenon is real on ext4 and reproduces L1's headline.** L1's "99.2 %" was
measured on a RAM disk and was therefore rightly quarantined — but 98.96 % on ext4 at WAL/NORMAL shows
the finding was *right for the wrong reason*. The gate must not be read as having refuted L1; it
refuted L1's *evidence*. B-1 remains genuinely open, and its outcome is a live coin-flip on B-2.

**(c) A physical reason the corpus's `NORMAL` figures are chaotic.** In WAL mode `synchronous=NORMAL`
does not `fsync` at commit at all — it syncs at checkpoint. So at WAL/NORMAL a tmpfs and an ext4 run
*should* be close, and the 233× tmpfs error is a property of the **`FULL`** cell specifically. This
predicts, correctly, that the corpus's `NORMAL` numbers would be inconsistent for reasons unrelated to
tmpfs — see §0.5.

**(d) `better-sqlite3` reports `synchronous` as an integer** (`1`/`2`), not a name. The artifact schema
must normalise, or two cells describing the same condition will not compare equal (M-05).

### 0.5 The corpus figures are worse than "four inconsistent values"

The brief names four mutually inconsistent ext4 `WAL/FULL` figures. Grepping the corpus for their
provenance found two further defects:

| figure | source | defect |
|---|---|---|
| 379 c/s | `corpus/council-redteam.md:118` | — |
| 523 c/s | `corpus/l6-contracts.md:462` | median of `[618, 489, 523]`; the spread is 26 % and only the median was propagated |
| 345 c/s | `corpus/council-contradiction.md:90` | — |
| **411 c/s** | `corpus/l6-contracts.md:484` | **measured on `fstype=ext2/ext3`, not ext4** — the harness printed its own filesystem and the figure was still carried forward as an ext4 datum |
| *140.8 c/s* | this lane's pilot, §0.4 | a **fifth** value, below all four |

And the same defect on the value the brief did *not* flag — ext4 `WAL/NORMAL`:

| 14,229 c/s (`l6-contracts.md:841`) | 47,263 c/s (`council-contradiction.md:586`) | 97,828 c/s (pilot §0.4) |
|---|---|---|

**A 6.9× spread on `NORMAL`, on the same filesystem, none of it tmpfs-attributable.** The brief's
instruction to treat the four `FULL` figures as inadmissible is correct and **insufficient**: the
`NORMAL` figures are equally inadmissible, and the 411 c/s row shows the corpus was conflating
filesystems, which is precisely the conditions-recording failure the gate exists to prevent. Test M-16
enforces the wider quarantine.

### 0.6 B-6's premise is worse than "a different backup surface"

Probe at `/root/measure-proto/b6-probe.mjs`, 60,000 × 4 KiB rows, 264 MiB source, WAL, `synchronous=2`,
ext4:

```
binding: better-sqlite3 13.0.2
Database.prototype: aggregate, backup, close, constructor, defaultSafeIntegers, exec, explain,
                    function, loadExtension, pragma, prepare, serialize, table, transaction, unsafeMode
typeof db.backup: function | arity: 2
backup() returns: [object Promise] | is Promise: true
awaited result: {"totalPages":67520,"remainingPages":0} | ms: 604.0 | progress callbacks: 676
copy integrity_check: ok | copy rows: 60000
VACUUM INTO ms: 656.7
```

`better-sqlite3`'s `backup()` is **asynchronous, returns a Promise, and is incrementally paced** — 676
progress callbacks at 100 pages per step over 67,520 pages, with the step size returned by the caller's
`progress` handler. `node:sqlite`'s is a different mechanism with a different threading model.

The consequence for the B-6 close rule is structural, not numeric. §6.4's rule reads *"choose `backup()`
if it completes without blocking the worker beyond one batch interval"* — but on the ruled binding
**"blocks the worker" is not a property of `backup()`, it is a property of the progress step size the
caller chooses.** A step of 100 pages yields to the event loop 676 times; a step of 67,520 does not
yield at all and is indistinguishable from `VACUUM INTO`. So E-06 must **sweep the step size** and B-6's
outcome is a *pair* (`mechanism`, `pagesPerStep`), not a single mechanism. This is a defect in the close
rule as written, reported in §5.7. The 604 ms / 656.7 ms figures are single-trial with **no concurrent
writer** and are inadmissible — the close rule's whole point is the concurrent-writer condition.

---

## 1. Scope

Requirements covered, by change and **title**:

### `v1.0.0-sqlite-engine-core` — owned outright

| Requirement (title) | Coverage |
|---|---|
| *every performance-dependent decision is blocked on measurements taken on a real filesystem under declared conditions* | **full** — all four scenarios |
| *the decisions blocked on the measurement gate are named, and none of them is settled by this change* | **full** — both scenarios |

Acceptance criteria discharged: **P0, P1, P2** (preconditions), **F1–F9** (the whole measurement-gate
block), **D4, D5, D6** (the value-justification half of the bootstrap block), **C18** (batch size and
idle deadline cite across-the-boundary data), **B14** (chunk size cites the datum that closed B-5).

### `v1.0.0-sqlite-engine-core` — partial, boundary stated

| Requirement (title) | This lane owns | Another lane owns |
|---|---|---|
| *the pragma bootstrap is an ordered, once-only sequence whose effect is verified by read-back* | that the chosen `page_size`/`auto_vacuum` **cite an artifact datum** (D4–D6) | that the bootstrap *applies and reads back* those values (D1–D3), and the WAL-first negative control (D2) |
| *a result set is streamed across the worker boundary in batches, and a stream can never wedge the writer* | the **B-8 measurement series** — TTFR, drain, round-trips, abort latency, WAL growth, across the worker hop (P2, C18) | the streaming **mechanism** tests (C12–C17), including the write-wedge control |
| *no statement is issued with more bound parameters than the engine accepts* | that the chunk size **cites B-5's datum** (B14) | the ceiling tests themselves (B11–B13) |

### Downstream changes — this lane specifies the experiment, the owning change consumes it

| Gate | Owning capability | What this lane ships |
|---|---|---|
| **B-1** | change 2 (`sqlite-temporal-event-log`) | E-01 + the ordering constraint that B-1 is evaluated after B-2 |
| **B-2** | change 1 | E-02 |
| **B-3a / B-3b** | change 1; **B-3b unblocks change 6's layout ruling** | E-03a / E-03b |
| **B-4** | change 3 (`sqlite-concurrency-lease`) | E-04 |
| **B-5** | change 4 (`sqlite-schema-parity`) — *derived from B-8* | folded into E-08 |
| **B-6 / B-7** | change 5 (`sqlite-durability-contract`) | E-06; B-7 is mechanical once B-2/B-3a/B-3b close |
| **B-8** | change 1 | E-08 |

### Explicitly **not** in this lane

The P1–P10 conformance re-execution (G1–G3); the `fast-check` property suites; `EVIDENCE.md`
regeneration; the cancellation-guard join tests (C20a–C20e); the correction-register sweep (J3*);
supply-chain criteria (A1–A7) **except** A4's `sqlite_version()` assertion, which shares the artifact's
binding block and is cross-referenced in M-05.

---

## 2. Test inventory

Two families. **M-\*** are apparatus tests: they assert the harness, the artifact and the gate behave
correctly, and they run in CI on every commit. **E-\*** are the experiments: they run on demand,
produce artifact data, and their "pass condition" is *that a decision rule evaluates to exactly one
outcome*, never that a number lands in a range.

### 2.1 The filesystem guard — the single most valuable thing this lane ships

| ID | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| **M-01** | The guard classifies `/root` (ext4) as admissible and `/tmp` (tmpfs) as memory-backed, on all three detectors independently. | F3, GATE scenario *a memory-backed measurement is refused* | unit | live host paths `/root/<scratch>` and `/tmp/<scratch>` | `verdict.REFUSE === false` for the ext4 path and `true` for the tmpfs path, **and** each of `memoryBackedBy.{mountinfo, statfsMagic, noDiskIO}` matches its expected value per path. A run where the three disagree **fails**, even if the aggregate verdict is right. |
| **M-02** | The guard refuses to run and exits non-zero with a message naming the detected fstype. | F3 | unit | harness invoked with target dir on tmpfs | Exit code ≠ 0; stderr contains the resolved mount point, the fstype string, and the phrase identifying the figures as inadmissible. No artifact file is written. |
| **M-03** | The behavioural detector is not fooled by a mount table that says ext4. | F3 (hardening) | integration | a tmpfs bind-mounted under a path inside the ext4 tree — `mount --bind /tmp /root/<scratch>/fake-ext4` | `mountinfo` may resolve to either; `diskstats.deltaSectors === 0` and the aggregate verdict is `REFUSE`. **This test is the reason detector 3 exists** and must fail if detector 3 is deleted. |
| **M-04** | The guard's own write probe is not elided. | F3 | unit | the probe buffer | Every 1 MiB block written by the probe differs from every other in its first 8 bytes (asserted by reading the file back before unlink), so a compressing or deduplicating layer cannot produce a zero-sector delta on a real disk. |
| **M-05** | CI asserts the *artifact's declared* filesystem is not memory-backed — independently of whether the harness ran the guard. | F5, GATE scenario *a memory-backed measurement is refused* | CI gate | committed artifact | The workflow fails if `admissibility.verdict !== "ADMISSIBLE"`, if any datum's `conditions.memoryBacked !== false`, or if the artifact is absent. Failure message contains `inadmissible figures`. |

> **Why the guard is a *harness* refusal and an *artifact* assertion, both.** A guard that only runs
> inside the harness is bypassed by hand-editing a JSON file; an assertion that only reads the artifact
> is satisfied by an artifact whose declaration is wrong. M-02 and M-05 are the same rule enforced at
> two different times and neither substitutes for the other.

### 2.2 Artifact schema and completeness

| ID | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| **M-06** | Every datum carries every condition field. | F2 | CI gate | committed artifact + a JSON-schema-shaped validator | The validator fails if any element of `data[]` omits any of: `fsType`, `fsSource`, `fsMountOptions`, `memoryBacked`, `journalMode`, `synchronous`, `pageSize`, `autoVacuum`, `walAutocheckpoint`, `datasetBytes`, `hostRamBytes`, `pageCacheCapBytes`, `cacheResidencyRatio`, `concurrentWriter`, `bindingName`, `bindingVersion`, `sqliteVersion`, `workerBoundary`, `iterations`, `warmupIterations`. Missing ≠ `null`: `null` is permitted **only** for `pageCacheCapBytes` and must be explicit. |
| **M-07** | `synchronous` is normalised so cells compare. | F2 | unit | synthetic data rows | A datum recording `synchronous: 2` and one recording `synchronous: "FULL"` both validate to the canonical form, and the validator rejects any third spelling. (§0.4(d).) |
| **M-08** | The artifact contains the three mandatory cells. | F4, GATE scenario *the artifact is complete enough to decide the pragma values* | CI gate | committed artifact | At least one datum with canonical `synchronous=FULL`; at least one with `NORMAL`; at least one with `cacheResidencyRatio ≥ 4` **and** a `windows[]` array of length ≥ 4. |
| **M-09** | The out-of-cache cell reports a series, not an aggregate. | GATE scenario *out-of-cache behaviour is measured rather than extrapolated* | CI gate | the out-of-cache datum | `windows[]` present, each element carrying `{windowIndex, rowsOrBytes, elapsedMs, throughput}`; the datum additionally carries `decay = first_window_throughput / last_window_throughput` **computed from the series, present even when ≈ 1.0**, and a `stillFalling` boolean derived from whether the last window is the minimum. |
| **M-10** | The artifact is reproducible by one command. | F1 | CI gate | `npm run measure` | The command exits 0 and writes an artifact validating against M-06 and M-08. Re-running at the same `harnessVersion` produces an artifact with the same **shape** — same datum ids, same condition keys. No value is compared (this is the existing G14 existence-gate discipline from `bench/types.ts`, reused deliberately). |
| **M-11** | The artifact records the host's virtualization layer. | §5.2 | CI gate | committed artifact | `host.virtualization` is present and non-empty; on this host it reads `wsl2` and `host.blockDeviceBacking` names the VHDX. A missing value fails. |

### 2.3 The register, and citation enforcement

| ID | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| **M-12** | Every register row is `BLOCKED` with a named missing datum, or `CLOSED` citing a datum id that exists in the artifact. | F6, P1 | CI gate | `openspec/changes/v1.0.0-sqlite-engine-core/` register + artifact | For each of B-1, B-2, B-3a, B-3b, B-4, B-5, B-6, B-7, B-8: status ∈ {`BLOCKED`,`CLOSED`}; if `CLOSED`, every id in `closedBy[]` resolves to a `data[].id` in the artifact. A `CLOSED` row citing a non-existent id fails **naming the id**. |
| **M-13** | B-1's required datum is stated exactly. | F6 | doc check | register | B-1's `requiredDatum` string names *same-key collision rejection rate*, *the chosen `synchronous`*, and *a non-memory-backed filesystem*. All three tokens present. |
| **M-14** | The forbidden-weakening note is present on B-1. | F8 | doc check | register | B-1's row contains a reference to `docs/ERROR-CATALOG.md`'s no-narrowing rule and the words identifying a narrowing as forbidden. |
| **M-15** | No requirement, design statement or contract text cites a figure absent from the artifact. | F7, GATE final clause | CI gate | all seven `v1.0.0-sqlite-*/` change directories + `docs/CONTRACT.md` + the artifact | A sweep extracts every numeric literal matching a throughput / latency / rate / ratio shape (`\d[\d,._]*\s*(c/s|commits?/s|ms|µs|us|MB/s|rows/s|%|×|x)`), excludes lines carrying a `MENTION:` marker of the four classes established by task 0.5b, and asserts every survivor appears in the artifact with matching conditions. **UNMARKED-AND-UNCITED = 0** is the gate; the sweep prints TOTAL / CITED / MARKED / UNCITED per directory and the full UNCITED and MARKED lists (the J3a ratio discipline, reused). |
| **M-16** | The wider quarantine: the corpus's `NORMAL` figures are quarantined too. | §0.5, F7 | CI gate | as M-15 | The literals `14,229`, `47,263`, `88,485`, `17,423`, `213.4`, `345`, `379`, `411`, `523`, `1.138`, `2.9` in a throughput/latency context are in the sweep's **explicit deny-list**: each occurrence must carry a `MENTION:` marker or be a `CLOSED` citation to an artifact datum. A bare occurrence fails naming the value and the file. |
| **M-17** | The 411 c/s conflation is recorded, not silently dropped. | §0.5 | doc check | register or design corrections | Text exists stating that one of the disputed figures was measured on `ext2/ext3` and carried forward as ext4, and that the `NORMAL` figures span 6.9× on the same filesystem. Present as a **conditions-recording failure**, not as a throughput claim. |

### 2.4 The experiments

Each experiment's pass condition is *"the decision rule evaluates to exactly one outcome and the
register records it with the datum ids"* — never a numeric threshold. The rule text below is the
executable form of `design.md` §6.4, with the additions this lane found necessary.

| ID | Gate | Workload | Vary | Hold | n | Statistic | Decision rule (executable) |
|---|---|---|---|---|---|---|---|
| **E-01** | **B-1** | ≥5,000 back-to-back same-key puts, each its own implicit transaction, into `PRIMARY KEY (key, valid_from_ms)` `STRICT, WITHOUT ROWID` | `synchronous` ∈ {NORMAL, FULL}; cache-resident and over-cache | ext4; WAL; **shipped pragma defaults for everything B-2/B-3a have not yet fixed**; single writer; `page_size` as bootstrapped; clock granularity = 1 ms | 5 runs × 5,000 puts per cell | rejection rate = rejected/n, per run; report median and full 5-run spread | Read the cell at **B-2's chosen** `synchronous`. Rejection rate **exactly 0 across all 5 runs** → clock **NOT adopted**, `CLOCK_REGRESSION` keeps `conditional`, unchanged. **Any run non-zero** → change 2 adopts a clock, and any retryability change must be *additive*. There is no third outcome. **Ordering constraint: E-01 is evaluated only after B-2 is CLOSED** (§0.4(a)). |
| **E-02** | **B-2** | Sustained single-row commit loop + a bulk ingest loop, both against the wallet shape | `synchronous` ∈ {NORMAL, FULL} × {in-cache, over-cache} | ext4; WAL; `page_size` from E-03a's sweep or the bootstrap default with the choice recorded; `wal_autocheckpoint` at the compiled 1000; single writer, then a second cell with one concurrent writer | 5 runs per cell, ≥30 s or 50,000 commits each | commits/s from total wall clock; p50/p95/p99 per-commit latency; `cv` across runs | **Default to `FULL`.** Adopt `NORMAL` **only if** the out-of-cache `FULL` commit rate < 2 × the wallet's measured sustained write demand. Requires a *measured* demand figure — see §6, **D-1**. If demand is unmeasured, B-2 stays BLOCKED; it may not be closed by assuming demand. If `NORMAL` is adopted, `docs/CONTRACT.md` §1 states the weakened durability position **and** §5.1's power-loss gap explicitly. |
| **E-03a** | **B-3a** | The wallet workload — small rows, high same-key churn, the `temporalKV.put.*` and `watermarks.*` shapes already in `bench/workloads/` | `page_size` ∈ {4096, 8192, 16384, 32768} × `auto_vacuum` ∈ {NONE, INCREMENTAL, FULL} | ext4; WAL; `synchronous` at B-2's value; single writer; identical dataset per cell | 5 runs per cell | throughput (ops/s); p99 latency; on-disk file size; freelist page count; space returned after `DELETE` and after `DROP TABLE` | `page_size`: **smallest size within 10 % of the best measured throughput, ties broken downward.** `auto_vacuum`: **`NONE` unless** the wallet lineage ships a delete-heavy path with a *written* reclaim requirement → then `INCREMENTAL` + an explicit vacuum step. **`FULL` is not selected for the wallet file.** |
| **E-03b** | **B-3b** | The archive workload — large blobs, append-then-prune, the `checkpointStore.save.*` shapes | as E-03a | ext4; WAL; `synchronous` at B-2's value | 5 runs per cell | as E-03a, plus reclaim duration | `page_size` by the same rule, measured **separately**. `auto_vacuum`: `NONE` if change 6 ships no retention/pruning requirement; `INCREMENTAL` + explicit vacuum if it does; **`FULL` only if** change 6 requires space return be automatic rather than scheduled. **Closing this row unblocks change 6's layout ruling** — change 6 selects its form from the outcome, not the reverse. |
| **E-03c** | **B-3a/b (direction)** | The disputed `DROP` vs `DELETE` direction | statement ∈ {`DROP TABLE`, `DELETE`} × `auto_vacuum` ∈ {NONE, INCREMENTAL(+explicit vacuum), FULL} × scale ∈ {6k, 120k rows} × schema ∈ {rowid PK, composite PK + secondary index} | ext4; WAL; identical payload bytes per cell; WAL checkpointed to `TRUNCATE` before and after each step | **20 runs per cell** — the two prior results are single trials | median and IQR of statement duration and of reclaim duration, reported separately | **This experiment is designed to be able to conclude "no direction".** If the two medians' 95 % CIs overlap at both scales and both schemas → publish **"direction does not matter; reclamation is a function of `auto_vacuum` and pages freed, orthogonal to which statement freed them"** and J9a's *disputed* marking is replaced by *settled: no direction*. If they separate consistently in the same direction at both scales → publish the direction **with its conditions**. If they separate in *opposite* directions at the two scales → publish that, which is the finding that explains why two single trials disagreed. |
| **E-04** | **B-4** | Lease acquisition under contention — reuse `bench/workloads/lease.ts`'s contender model, ported | poll interval ∈ {5, 10, 25, 50, 100 ms}; contenders ∈ {1, 2, 4, 8, 16} | ext4; WAL; `synchronous` at B-2's value; worker boundary **present** | ≥1,000 acquisitions per cell | p99 acquisition latency; acquisitions/timeouts; **total write-lock hold time** under the worker, against an in-process control | **Choose the largest poll interval whose p99 acquisition latency < (lease timeout budget ÷ 4).** If none satisfies it, **raise the timeout budget** (do not shrink the interval past the point polling dominates CPU) and record the raise in `docs/CONTRACT.md`. Separately: worker write-lock amplification **accepted** if measured total hold stays within one order of magnitude of the in-process control; **escalated to change 3 as a design question** if not. |
| **E-06** | **B-6** | Online backup of a populated wallet file **under a concurrent writer**, on the **ruled binding** | mechanism ∈ {`backup()`, `VACUUM INTO`} × **`pagesPerStep` ∈ {1, 100, 1000, all}** (§0.6) | ext4; WAL; `synchronous` at B-2's value; a writer committing continuously throughout; dataset ≥ 2× the page-cache cap | 5 runs per cell | max observed worker stall (event-loop lag on the worker, sampled at 1 ms); total backup duration; `integrity_check` on the copy; row-count equality with a snapshot taken at backup start | **Choose `backup()` at a named `pagesPerStep` if** max worker stall ≤ one batch interval (B-8's chosen value) **and** the copy passes `integrity_check`. **Choose `VACUUM INTO` if** no `backup()` configuration passes both and `VACUUM INTO` passes both. **If both fail**, neither is specified as online; change 5 §6 documents an offline post-quiesce copy as the only supported procedure. **B-6's outcome is the pair (mechanism, pagesPerStep), not a mechanism.** |
| **E-07** | **B-7** | — | — | — | — | — | **Mechanical.** Once B-2, B-3a and B-3b are CLOSED, the durability probe asserts exactly the per-file values the bootstrap sets. Pass condition: for each of the two files, the probe's asserted tuple `(journal_mode, synchronous, page_size, auto_vacuum)` is **string-equal** to the register's closed values, verified by a test that reads both. A probe asserting a value the bootstrap does not set, or vice versa, fails. |
| **E-08** | **B-8** (and **B-5**) | A streamed drain of a large result set **across the worker boundary** | batch size ∈ {1, 16, 64, 256, 1024, 4096, 16384} | ext4; WAL; `synchronous` at B-2's value; worker boundary **present**; identical row shape and count per cell; the abort injected at a fixed fraction of the drain | 5 runs per cell | **time-to-first-row**; total drain time; round-trip count; **observed abort latency** (abort signal → iteration rejects); **WAL growth** (bytes) during a long-lived stream | **Choose the smallest batch size whose TTFR is within 2× of the smallest batch tested, subject to total drain time within 1.5× of the best measured.** Idle deadline = **10 × measured p99 inter-batch pull interval, floored at 1 s.** If no batch size satisfies both bounds, change 2 re-scopes the streaming promise — the bounds are not relaxed here. **B-5** (the ≤32,766-parameter chunk size) is closed from the same transport series: it is the same trade, and B-5's chosen value cites E-08's datum ids. |

### 2.5 Out-of-cache reachability

| ID | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| **M-18** | The over-cache condition was actually achieved, not merely requested. | F4, GATE scenario *out-of-cache behaviour is measured* | integration | any datum with `cacheResidencyRatio > 1` | The datum carries `pageCacheCapBytes` (the cgroup `memory.max` in force) **and** an observed `maxFileCacheBytes` read from the cgroup's `memory.stat` `file` counter during the run. Assertion: `datasetBytes ≥ 4 × maxFileCacheBytes`. A run where the cap was set but the dataset fit inside it **fails** — see NC-10. |
| **M-19** | The cheap mechanism and the expensive one agree in shape. | §4.4 | integration | the cgroup-capped 4 GiB run and the Midnight-sync-instrumented run | Both produce a `windows[]` series and both report `decay` and `stillFalling`. The assertion is **not** that the numbers match — different datasets — but that the *cgroup run's decay is not smaller than 1.0 when the sync run's is greater than 1.0*, i.e. the cheap proxy does not report "no decay" where the real workload shows decay. A disagreement in that direction invalidates the proxy and is a finding. |

---

## 3. Negative controls

A negative control that never runs is a comment. Each of these is planted, executes, and is asserted
to fail. **How they are planted without shipping:** every control lives in the test tree under
`test/measurement/controls/`, constructs its wrong implementation *locally* inside the test body (a
locally-defined function, a locally-written artifact fixture, or a `mount --bind` performed and torn
down by the test), and asserts the gate rejects it. **No control mutates a file under `src/`, `bench/`
or `openspec/`.** The three that need a planted line in a real document (NC-03, NC-04, NC-11) write it
into a *copy* of the directory tree in a temp dir under `/root` and run the sweep against the copy.

| ID | Wrong implementation planted | How planted | What a failing-as-expected run proves | What a **green** run of the control proves |
|---|---|---|---|---|
| **NC-01** | The harness is pointed at `/tmp`. | Test invokes the harness with `MEASURE_DIR=/tmp/<scratch>`. | The guard refuses, exits non-zero, names `tmpfs`, and writes no artifact. | **This is the control the whole lane exists for.** Green proves the 233× class of error is now *detected*, not merely *documented*. It does not prove the figures are right — only that the specific failure that invalidated six of seven research lanes is caught before an artifact exists. |
| **NC-02** | A mount table that claims ext4. | `mount --bind /tmp /root/<scratch>/fake-ext4` inside the test, unmounted in teardown. | Detector 3 (`diskstats`) reports zero sectors; aggregate verdict `REFUSE`. | That the guard's independence is real. **Delete detector 3 and this test must fail** — that is its purpose. Without NC-02, detector 3 is unfalsified code and would be dropped as redundant in the first refactor. |
| **NC-03** | A requirement citing a throughput figure that is not in the artifact. | A line reading a plausible `c/s` figure is appended to a *copy* of a spec file in a temp tree. | M-15's sweep reports it under UNCITED and the gate fails naming the file and the value. | That "no requirement may cite a figure absent from the artifact" is **enforceable rather than aspirational** — which is the non-negotiable the brief names. |
| **NC-04** | The same planted line, carrying a `MENTION:criterion` marker. | As NC-03, with the marker comment. | The line does **not** appear under UNCITED but **does** appear in the MARKED list printed in full. | That the marker **re-files rather than hides** (the J3e discipline). A marker that suppressed the line would convert the gate into an opt-out. |
| **NC-05** | An artifact datum missing one condition field. | A fixture artifact is written with `pageSize` deleted from one datum. | M-06 fails, naming the datum id and the missing field. | That the condition set is enforced per-datum, not per-artifact. An artifact that declares conditions once in a header and omits them per-cell is exactly how the corpus's 411 c/s row happened (§0.5). |
| **NC-06** | A B-1 result inconsistent with its own commit latency. | A fixture datum asserting a 50 % rejection rate alongside a measured p50 commit latency of 4.6 ms. | The consistency check fails: at 4.6 ms/commit against 1 ms granularity, the predicted rate is 0 %, and a 50 % observation contradicts it. Neither datum is usable. | That B-1 and B-2 **cross-validate**. This is the control that catches a B-1 run accidentally executed at the wrong `synchronous`, which is precisely L1's original defect. |
| **NC-07** | The `FULL` cell re-measured on tmpfs alongside the ext4 cell. | The harness is run twice with `ALLOW_TMPFS_FOR_CONTROL=1`, an env var honoured **only** by this test and asserted absent from the shipped harness's option surface by M-02. | The two `FULL` commit rates differ by **≥ 2 orders of magnitude**. | The GATE requirement's own negative-control scenario (*research-phase figures are invalid and their reuse is prevented*), executed rather than narrated. Note the requirement deliberately fixes the *finding* (≥2 orders) and not the ratio — the assertion must be `≥ 100×`, never `≈ 233×`. |
| **NC-08** | An in-process batch-size figure offered as B-8's justification. | A register row is written with `closedBy: ["D-inproc-01"]` where that datum has `workerBoundary: false`. | M-12 plus a B-8-specific check fails: B-8 may be closed only by data with `workerBoundary: true`. | F9 — that the 1.138 ms/256 and 2.9 ms/256 figures cannot re-enter through the register. Without this control, "explicitly inadmissible" is a sentence in a design document. |
| **NC-09** | A single-writer figure labelled as concurrent. | A fixture datum with `concurrentWriter: true` produced by a run with no second writer. | The harness records an observed writer-commit count alongside the flag; the check fails when `concurrentWriter === true` and `observedConcurrentCommits === 0`. | That B-6's whole close rule — which turns on the concurrent-writer condition — cannot be satisfied by a run that did not have one. |
| **NC-10** | An "out-of-cache" run whose dataset fits in the cap. | A cgroup scope with `MemoryMax=8G` and a 4 GiB dataset. | M-18 fails: `datasetBytes (4 GiB) < 4 × maxFileCacheBytes`. | That the out-of-cache cell measures being out of cache, rather than declaring it. The research phase's failure was not a wrong number; it was a *label*. |
| **NC-11** | A zero-row / empty-scope artifact. | A fixture artifact with `data: []`, and a register with all rows `CLOSED` citing nothing. | M-08 fails on missing mandatory cells; M-12 fails on `CLOSED` with an empty `closedBy[]`; **and the summary reports `n/a — no data in scope`, never `pass`.** | The sprint's second trap: five separate vacuous-pass instances were found. An artifact-driven gate is *especially* exposed to this, because "no data" and "no violations" have the same shape. |
| **NC-12** | The decay computation reports nothing when there is no decay. | A fixture out-of-cache datum whose windows are flat. | M-09 still requires `decay` and `stillFalling` to be **present**, with `decay ≈ 1.0` and `stillFalling: false`. Absence of the fields fails. | That "no decay observed" is a recorded result, not a silence indistinguishable from a missing measurement. The research phase's out-of-cache claim was an *absence*, and absences are what this gate exists to convert into data. |
| **NC-13** | `backup()` measured with no progress step — i.e. one un-yielding call. | An E-06 cell run at `pagesPerStep: all`. | The measured worker stall is comparable to `VACUUM INTO`'s, and B-6's rule selects neither on stall grounds. | §0.6 — that "does `backup()` block the worker?" is a question about the step size, not about the mechanism. This control makes the false framing visible in the data instead of in a review comment. |

---

## 4. Fixtures and harnesses

### 4.1 Reuse, do not replace

`bench/` already contains the right architecture and it is kept:

| Existing | Reused how |
|---|---|
| `bench/stats.ts` — `summarize()`, `tinybenchSamples()`, `measureManual()` | **Unchanged.** Percentiles, `sd`, `cv` come from here so the measurement artifact and the PostgreSQL baseline compute their statistics identically. This is what makes any cross-engine comparison meaningful at all. |
| `bench/types.ts` — `LatencyStats`, the `HARNESS_VERSION` existence-gate discipline | `LatencyStats` embedded verbatim in the new artifact's `statistic` block. The G14 rule — *the gate is the artifact's existence and structural reproducibility, never a number* — is adopted wholesale (M-10). |
| `bench/harness.ts` — env-override pattern (`BENCH_PROFILE`, `BENCH_OUT`, `parseNums`) | Same option shape, prefixed `MEASURE_*`, so operators do not learn a second convention. |
| `bench/workloads/temporal-kv.ts`, `watermarks.ts` | Row shapes and churn patterns for E-03a's wallet profile. |
| `bench/workloads/checkpoint-store.ts` | Blob shapes and the 1/16/64/256 MB size ladder for E-03b's archive profile. |
| `bench/workloads/lease.ts` | Contender model for E-04. |
| `bench/workloads/gc.ts` | The `declaredEnvelope` + `cliffDetermination` pattern — a **rule-based adjudication recorded next to the data** — is the exact shape every B-gate close rule needs. E-01…E-08's `decision` blocks are modelled on it. |

**What must be new:** `bench/environment.ts` is PostgreSQL/Testcontainers-specific and is replaced by
`bench/sqlite-environment.ts`, which opens a file and records conditions. It is a replacement, not an
edit — `environment.ts` stays until the PostgreSQL baseline is retired (§5.4).

### 4.2 The artifact — `bench/measurement.<harnessVersion>.json`

```jsonc
{
  "schema": "umbradb-sqlite-measurement/v1",
  "harnessVersion": "1.0.0-sqlite-measurement.1",
  "generatedAt": "...", "runId": "...",
  "host": {
    "ramBytes": 67052851200, "kernel": "6.18.33.2-microsoft-standard-WSL2",
    "cpuModel": "...", "cores": 0,
    "virtualization": "wsl2",                       // M-11
    "blockDeviceBacking": "VHDX on NTFS via /dev/sdd"
  },
  "admissibility": {                                 // written by the guard, asserted by CI (M-05)
    "target": "/root/...",
    "mount": { "mountPoint": "/", "fstype": "ext4", "source": "/dev/sdd",
               "mountOpts": "rw,relatime", "superOpts": "rw,discard,errors=remount-ro,data=ordered" },
    "statfs": { "magicHex": "0xef53", "name": "ext2/3/4" },
    "diskstats": { "wroteBytes": 33554432, "deltaSectors": 65752, "perDevice": { "sdd": 65752 } },
    "fsyncCostMs": { "p50": 4.164, "p99": 7.715 },   // corroboration only, never a predicate
    "detectors": { "mountinfo": false, "statfsMagic": false, "noDiskIO": false },
    "verdict": "ADMISSIBLE"
  },
  "binding": { "name": "better-sqlite3", "version": "13.0.2", "integrity": "sha512-...",
               "sqliteVersion": "3.53.4", "compileOptions": ["..."] },
  "data": [{
    "id": "D-001", "experiment": "B-2", "cell": "sync=FULL,in-cache,4096",
    "conditions": { /* the 20 fields M-06 enforces */ },
    "statistic": { /* LatencyStats from bench/stats.ts */ },
    "throughput": { "unit": "commits/s", "value": 0, "runs": [0,0,0,0,0], "cv": 0 },
    "windows": [ { "windowIndex": 0, "rowsOrBytes": 0, "elapsedMs": 0, "throughput": 0 } ],
    "decay": 1.0, "stillFalling": false,
    "observedConcurrentCommits": 0,                  // NC-09
    "maxFileCacheBytes": 0                           // M-18
  }],
  "decisions": [{
    "id": "B-2", "owner": "v1.0.0-sqlite-engine-core",
    "status": "BLOCKED", "requiredDatum": "...", "rule": "...",
    "closedBy": [], "outcome": null, "outcomeRecordedAt": null
  }]
}
```

Every datum has an `id`. **A specification cites `D-001`, never a number** — which is what makes M-15
mechanically checkable rather than a reviewer's sweep.

### 4.3 Data volume and shape, concretely

| Experiment | Volume | Shape | Wall-clock estimate |
|---|---|---|---|
| E-01 | 5 runs × 5,000 puts × 2 `synchronous` values × 2 cache conditions = 100,000 puts | one key, 20-byte value | FULL dominates: ~5,000 × 4.6 ms × 5 × 2 ≈ **4 min**; NORMAL negligible |
| E-02 | 5 runs × ≥50,000 commits × 2 × 2 = ≥1,000,000 commits; ingest cells at 4 GiB each | wallet row: `(key TEXT, valid_from INTEGER, value TEXT ~200 B)` | ~**40–60 min**, FULL-dominated |
| E-03a | 4 page sizes × 3 `auto_vacuum` × 5 runs = 60 cells | 2,000,000 wallet rows ≈ 500 MB per cell | ~**60 min** |
| E-03b | 60 cells | 6,000 × 4 KiB blobs ≈ 24 MB, plus a 256 MB checkpoint ladder cell | ~**45 min** |
| E-03c | 2 statements × 3 `auto_vacuum` × 2 scales × 2 schemas × **20 runs** = 480 trials | 6k and 120k rows, both schemas | ~**30 min** — cheap, and 20 runs is what makes it conclusive where two single trials were not |
| E-04 | 5 intervals × 5 contender counts × ≥1,000 acquisitions | lease row | ~**30 min** |
| E-06 | 2 mechanisms × 4 step sizes × 5 runs = 40 backups of a ≥2 GiB file under a live writer | archive shape | ~**45 min** |
| E-08 | 7 batch sizes × 5 runs, 500,000-row drains, plus a long-lived-stream WAL-growth cell | `listKeys` shape | ~**30 min** |
| **Out-of-cache cells** | 4 GiB dataset under a 512 MiB cgroup cap = **8:1** over-cache | as the parent experiment | additive, ~**20 min** |

Total ≈ **5 hours** for a full sweep. That is a *runnable* number, which matters: a gate that takes a
week is a gate that gets skipped.

### 4.4 Forcing the out-of-cache condition — three mechanisms, ranked

1. **cgroup v2 memory cap (primary).** Verified in §0.3. `systemd-run --scope -p MemoryMax=512M
   -p MemorySwapMax=0`. Gives an arbitrary, *declared*, reproducible cache-residency ratio in minutes,
   and the cap is readable from inside the run so M-18 can assert the condition was achieved rather
   than requested. **`MemorySwapMax=0` is mandatory** — without it the kernel swaps instead of evicting
   and the run measures swap, not disk.
2. **`drop_caches` between windows (secondary).** Verified writable in §0.3. Gives a **cold-start**
   datum, which is a different quantity from *sustained* out-of-cache and is worth having: it is the
   condition a wallet meets on process restart. Not a substitute for (1) — dropping caches once at the
   start does not keep a 4 GiB dataset out of a 62 GiB cache.
3. **The Midnight sync (the real one, once).** 1.0.0 is already blocked on a full local Midnight sync,
   which is genuinely out-of-cache at genuine scale. Instrument it with per-window throughput and I/O
   counters. It is nearly free because it is a tag precondition regardless — but it runs **once**, on a
   schedule this lane does not control, and it cannot be swept. **So it is the validation of the cheap
   proxy (M-19), not the source of the sweep.** Change 1's design says the same and is right: the gate
   must not *depend* on the sync.

### 4.5 Harnesses to build

| Harness | Purpose |
|---|---|
| `bench/fs-guard.ts` | The three detectors. Exported as a function so the harness calls it, and as a CLI so CI calls it independently. Prototype exists at `/root/measure-proto/fscheck.mjs`. |
| `bench/sqlite-environment.ts` | Opens a file, applies pragmas in the irreversible order (`page_size` → `journal_mode` → rest), reads every one back, and returns the frozen `conditions` block. **The conditions are read from the live handle, never from the config that was requested** — a pragma that silently failed to apply must not be recorded as applied. |
| `bench/measure.ts` | Entrypoint. `npm run measure`. Same env-override shape as `bench/harness.ts`. |
| `bench/decide.ts` | Reads the artifact, evaluates each close rule, writes the `decisions[]` block and the register. **The rules are code, not prose** — this is what makes "reading the artifact *determines* the answer" true rather than aspirational. |
| `bench/cite-check.ts` | M-15/M-16's sweep. Reuses the four `MENTION:` marker classes and the J3a print-the-ratio discipline. |
| `bench/worker-stream-bench.ts` | E-08. Must exercise the **real** worker topology, not a simulation of it — an in-process measurement of a worker protocol is the exact figure F9 declares inadmissible. |
| `test/measurement/controls/` | NC-01…NC-13. |

---

## 5. What cannot be tested, and the nearest achievable substitute

### 5.1 The thing B-2 actually trades away — power-loss durability

**This is the most important gap in the plan.** `synchronous=NORMAL` in WAL mode survives a *process*
crash and can lose committed transactions on an *OS crash or power loss*. `FULL` does not. That
difference is the entire content of the B-2 decision — and **no test in this plan measures it.**

SIGKILL tests prove process-crash durability and are worth running, but they pass identically at
`NORMAL` and `FULL`, so a green SIGKILL suite is evidence of nothing about B-2. Reporting it as such
would be the exact failure mode this sprint exists to prevent.

*Nearest achievable substitute, in descending order:*

- **`dm-flakey` with `drop_writes`.** Present as a loadable module on this host
  (`/lib/modules/6.18.33.2-microsoft-standard-WSL2/kernel/drivers/md/dm-flakey.ko`), though **not
  currently loaded** — `dmsetup targets` reports only `verity striped linear error`. It can drop writes
  to simulate a device that lied about persisting, then `integrity_check` the result. Crude: it does not
  reproduce *reordering*, which is the mechanism by which `NORMAL` actually loses data.
- **`dm-log-writes`** is the correct tool — it records the write stream and replays it to any point,
  which is exactly the power-loss model. **It is not present in this kernel** (checked; only `dm-delay`
  and `dm-flakey` exist). Substitute unavailable without a custom kernel.
- **A VM with a forced reset.** Achievable (Docker is running, §5.4), heavy, and the WSL2 VHDX layer
  sits underneath it either way.

**What the plan does instead:** B-2's outcome must state the untested consequence in `docs/CONTRACT.md`
§1 as an explicit, named gap — *"`NORMAL` was selected on measured throughput headroom; its power-loss
behaviour was not measured on this host and no test in this suite distinguishes it from `FULL`."* An
honest gap is worth more than a SIGKILL suite that appears to cover it.

### 5.2 Bare-metal ext4

Every figure this plan produces is **ext4 on a WSL2 VHDX on Windows NTFS on the host's real storage**.
`fsync` traverses that stack, and the measured 4.164 ms p50 (§0.2) is a property of the stack, not of
ext4. This is not a small caveat: `FULL`'s commit rate is *entirely* an `fsync`-cost measurement.

*Substitute:* record `host.virtualization` and `host.blockDeviceBacking` as first-class conditions
(M-11), and declare the figures portable in **order of magnitude and direction**, not in absolute value.
Every close rule in §2.4 is deliberately written as a *ratio* or an *ordering* — "smallest within 10 %
of best", "within 2× of smallest", "less than 2× headroom", "same order of magnitude" — precisely so
the decisions survive a change of host that the numbers would not. **This is a design property of the
rules and must not be edited away into absolute thresholds.**

### 5.3 The PostgreSQL comparison is one-sided, and here is what would fix it

`bench/baseline.1.0.0-perf-baseline.1.json` was recorded `2026-07-24T08:15:03Z` against
`postgres@sha256:742f40…2193` (PG 17.10), Node v24.18.0, tinybench 2.9.0 — with `shared_buffers=256MB`,
`work_mem=16MB`, `max_wal_size=2GB` and `max_parallel_workers_per_gather=0`. **No PostgreSQL server runs
on this host now**, so any SQLite-vs-PostgreSQL claim compares a fresh SQLite number against a
PostgreSQL number taken on possibly different hardware, on a different date, under a different cache
state — and *nothing in the baseline artifact records the host*. `EnvironmentBlock` captures the
image, the server version, the settings, the Node version and the harness version. It does **not**
capture CPU, RAM, filesystem or storage device. The baseline is therefore not merely one-sided; it is
**not attributable to a machine at all**.

*What a fair comparison would require, all of it:*

1. The **same host**, same session, same storage — no cross-date comparison.
2. The same `cacheResidencyRatio` on both sides. PostgreSQL's `shared_buffers=256MB` plus the OS page
   cache is a completely different cache architecture from SQLite's `cache_size=-16000` (16 MB, per the
   compiled `DEFAULT_CACHE_SIZE`) plus the page cache. Matching "dataset vs RAM" does not match cache
   behaviour, and this must be stated rather than papered over.
3. The same **durability posture** on both sides — PostgreSQL `synchronous_commit=on` against SQLite
   `synchronous=FULL`, or `off` against `NORMAL`. Comparing PG's default against SQLite `NORMAL` is the
   same class of error as the tmpfs one: it compares a durable configuration against a non-durable one
   and reports the difference as an engine property.
4. The same workload driven through **UmbraDB's own adapters** on both sides, which `bench/harness.ts`
   already does correctly for PostgreSQL.
5. An `environment` block on the PostgreSQL side carrying host CPU, RAM, filesystem and virtualization —
   **fields the current schema does not have.**

*Achievable substitute, and it is achievable:* the Docker daemon **is** running on this host
(`docker info --format '{{.ServerVersion}}'` → `29.6.1`), and `bench/environment.ts` pins the image by
digest, so `npm run bench` can produce a **same-host, same-session PostgreSQL baseline** today. That
closes items 1 and 5 at the cost of one bench run. Items 2–4 are configuration discipline, specified
above. **Until that re-baseline exists, no requirement may state a SQLite-vs-PostgreSQL comparison**;
the committed baseline is admissible only as a record of what the PostgreSQL implementation did, on an
unrecorded machine, on one date.

### 5.4 Consumer hardware

The chosen batch size, poll interval and page size are optimal for *this* host's storage. Consumers run
wallets on unknown hardware.

*Substitute:* E-03a, E-04 and E-08 must record the **flatness** of their curves, not only the optimum —
i.e. the width of the region within the rule's tolerance band. A rule that selects a value sitting on a
cliff is fragile across hosts even if it is correct here; a rule that selects from a broad plateau is
robust. **`decisions[].outcome` must carry `plateauWidth` alongside the chosen value.** This costs
nothing — the sweep already measures every point — and it is the only defence against a value tuned to
one VHDX.

### 5.5 Whether the wallet's sustained write demand justifies `NORMAL`

B-2's close rule turns on *"the wallet's measured sustained write demand"* and **that quantity does not
exist**. It is not in the corpus, not in the baseline, and not measurable from a synthetic benchmark —
it is a property of the Midnight sync workload.

*Substitute:* it is the one quantity the instrumented Midnight sync yields for free. Recorded as
blocked dependency **D-1** in §6. **B-2 may not close without it**, because "default to `FULL`" is only
a safe default if the alternative branch is unreachable-by-measurement rather than unreachable-by-
omission — and at 140.8 c/s (pilot, inadmissible) the headroom question is clearly live, not academic.

### 5.6 The idle deadline's real-world trigger

E-08 measures the p99 inter-batch pull interval under a *benchmark* consumer that pulls promptly. The
deadline exists for a consumer that stalls — a GC pause, a blocked event loop, a suspended laptop. A
benchmark cannot produce the tail that the deadline is sized against.

*Substitute:* measure the p99 under an **adversarial** consumer that injects randomised stalls drawn
from a declared distribution, and record the distribution as a condition. State plainly that the
10×-p99 rule is calibrated against a synthetic tail. Additionally: because a too-short deadline
converts a slow consumer into a failed read, the *consequence of being wrong* is asymmetric and the
floor (1 s) is doing more work than the multiplier.

### 5.7 A defect in the B-6 close rule as written

Reported here rather than silently worked around. §6.4's B-6 rule treats "blocks the worker" as a
property of the mechanism. On the ruled binding it is a property of the caller-chosen `pagesPerStep`
(§0.6). The rule as written can be satisfied or defeated at will by an unstated parameter, which makes
it non-deterministic — the exact defect §6.4's preamble says it exists to prevent. **E-06 sweeps the
step size and B-6's outcome is the pair `(mechanism, pagesPerStep)`.** Change 5 must adopt the pair or
restate the rule.

### 5.8 Reproducibility across runs of the gate itself

The artifact's reproducibility gate is *structural* (M-10), inherited from G14 — same shape, no value
compared. That is correct and it means **the gate cannot detect a host that has drifted**: a re-run on a
degraded disk produces a valid artifact with different numbers and passes.

*Substitute:* record `admissibility.fsyncCostMs` in every artifact (already in the schema) and print a
**warning, not a failure**, when it moves by more than 2× between artifacts at the same
`harnessVersion`. A failure would be wrong — the host legitimately changes — but a silent drift is how
a re-measurement quietly stops being comparable to the decision it justified.

---

## 6. Blocked-on-measurement

### 6.1 The dependency order — B-gates are not independent

`design.md` §6.4 presents eight rules as a flat table. They are not flat. Evaluating them in the wrong
order produces a decision that looks closed and is not:

```
  D-1 (wallet sustained write demand, from the Midnight sync)
        │
        ▼
  B-2 (synchronous) ─────┬──────────────┬──────────────┬────────────┐
        │                │              │              │            │
        ▼                ▼              ▼              ▼            ▼
  B-1 (clock)      B-3a (wallet)   B-3b (archive)   B-4 (lease)   B-8 (stream batch)
   → change 2            │              │              │            │
                         │              ▼              ▼            ▼
                         │        change 6 layout   change 3    B-5 (chunk size)
                         │                                       → change 4
                         └──────┬───────┘                          │
                                ▼                                  │
                          B-7 (probe asserts)  ←────────────────────┘
                             → change 5
                                ▲
                          B-6 (backup) — needs B-2 and B-8's batch interval
                             → change 5
```

**Three ordering constraints the flat table hides**, each of which must be stated in `tasks.md` §0:

1. **B-1 after B-2.** B-1's rejection rate is a deterministic consequence of B-2's commit latency
   (§0.4(a)). Running E-01 before B-2 closes produces a number for the wrong pragma — L1's original
   defect, repeated.
2. **B-6 after B-8.** B-6's rule says *"without blocking the worker beyond one batch interval."* The
   batch interval is B-8's output. B-6 cannot be evaluated before B-8 closes, and B-6 must be
   **re-evaluated** if B-8's chosen batch size later changes.
3. **B-2 after D-1.** §5.5.

### 6.2 Tests blocked on a threshold that does not yet exist

| Blocked test | Owning change | Needs | Until then |
|---|---|---|---|
| Durability probe asserts a pragma tuple per file (E-07) | 5 | B-2, B-3a, B-3b CLOSED | Test exists and is **skipped with an explicit `blocked-on: B-2,B-3a,B-3b` reason string**, not commented out and not silently passing. A skipped test with a machine-readable reason is greppable; a commented one is invisible. |
| Bootstrap read-back asserts the *intended* values (D1) | 1 | B-2, B-3a, B-3b | Same. The **mechanism** test (that read-back happens at all, and the WAL-first control D2) is **not** blocked and runs now against placeholder values. |
| `perf-batching.test.ts` re-baselined at the chosen chunk size (B14) | 1/4 | B-5, derived from B-8 | Runs at the current constant with the value marked provisional in the register. |
| Lease timeout budget conformance (P10) at the chosen poll interval | 3 | B-4 | P10 runs against the existing budget; the *interval* assertion is blocked. |
| Change 6's layout ruling and any retention test asserting space is returned | 6 | B-3b | **Hard-blocked.** §4.10 establishes that at `NONE` and at `INCREMENTAL`-without-explicit-vacuum, neither `DROP` nor `DELETE` reclaims — so a retention test written before B-3b closes may be asserting a reclaim that cannot occur. |
| Clock adoption tests, `CLOCK_REGRESSION` retryability | 2 | B-1 | **Hard-blocked, and blocked in both directions.** If B-1 resolves to 0 %, the tests are not written at all rather than written and skipped — a skipped test for an unadopted design accretes into a phantom requirement. |
| Backup contract test (`docs/CONTRACT.md` §6) | 5 | B-6 as a **pair** (§5.7) | Blocked. |
| Stream idle-deadline expiry test (C15) | 1 | B-8 | The **mechanism** (worker releases, resume fails with a typed error) is testable now against a placeholder deadline; the **value** is blocked. Split the test so the mechanism is not held hostage to the number. |
| Any SQLite-vs-PostgreSQL comparative assertion | any | a same-host PG re-baseline (§5.3) | **Blocked, and achievable today** — Docker is running. This is the cheapest blocked item in the sprint. |

### 6.3 Blocked-on-measurement, restated as the gate's own precondition

**P0 blocks the value-choosing half of change 1 and it is not satisfiable by this lane alone.** The
artifact requires an out-of-cache cell (§4.4 mechanism 1 — cheap, available today) and B-2 requires
D-1 (the sync — expensive, scheduled elsewhere). The honest statement of the critical path:

- **Available today:** the filesystem guard, the artifact schema, the citation sweep, every negative
  control, E-01, E-02's cells, E-03a/b/c, E-04, E-06, E-08, and the out-of-cache cells via cgroup.
  That is P1, P2, F1–F9, D4–D6, C18 — **everything except B-2's final branch.**
- **Not available today:** D-1, and therefore B-2's *close*, and therefore B-1's evaluation, and
  therefore change 2's clock decision.

That is a real dependency and it should be scheduled, not discovered. The mitigation is that **`FULL` is
the default** under B-2's rule: if the sync is delayed, the sprint may adopt `FULL` provisionally,
record B-2 as `CLOSED-BY-DEFAULT` with the headroom branch explicitly untested, and — critically —
**B-1 then evaluates against `FULL`, where the pilot (§0.4, inadmissible) suggests the rejection rate is
0 % and the clock is not adopted.** Change 2 should know that its most likely outcome is "no clock", and
should not build the clock in anticipation.

---

## Appendix — prototype artifacts

All under `/root/measure-proto/` (never `/tmp`), written by this lane, none of it product code:

| File | What it is |
|---|---|
| `fscheck.mjs` | Three-detector filesystem guard prototype. Basis for `bench/fs-guard.ts`. |
| `b1b2-pilot.mjs` | B-1/B-2 experiment-shape pilot. §0.4. |
| `b6-probe.mjs` | `better-sqlite3` backup-surface probe. §0.6. |
| `cgroup-check.sh` | cgroup v2 page-cache cap verification. §0.3. |

No `npm install` was run; `better-sqlite3@13.0.2` was loaded from the pre-unpacked `/tmp/l3-bs3b`.
No file under `src/`, `test/`, `bench/` or `openspec/` was modified.
