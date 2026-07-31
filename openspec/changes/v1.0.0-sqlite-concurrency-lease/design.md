# Design — SQLite concurrency, transactions and the writer lease

Change `v1.0.0-sqlite-concurrency-lease`, capability `transaction-lease`.

Existing decisions this change touches are cited by section number and are never silently
duplicated or contradicted (`openspec/config.yaml` design rule):

- **`design/design.md` §5 "Commit/transaction layer"** — the writer-lease pattern, the
  advisory-lock class registry, and the "the lease MUST be acquired and released on a single
  connection" fix. §1 of this document supersedes the *mechanism*; the *semantics* §5 fixed are
  preserved.
- **`design/design-interfaces.md` §3.1 "Transaction/Lease layer"** — the interface contract already
  implemented in `src/interfaces/transaction-lease.ts`. This change makes **no** type change to it;
  §1.3 "Transaction participation" (the opaque handle threaded via `opts.tx`) is preserved verbatim
  in shape, and §1.1's thrown-`code`-discriminated error idiom governs every fault added here.
- **`Formal/STORAGE_ALGEBRA.md` §4** — Law L1 and the atomicity envelope. §1 of this document
  restates L1's *mechanism* and §2 adds a guarantee §4 previously left to a deployment
  precondition. §4's removal of TTL/lease-stealing is **not** reversed; §2.4 states why.
- **`Formal/STORAGE_ALGEBRA.md` §2** — C2a (`Deleted ∩ ⋃_{m ∈ Live} refs(m) = ∅`, `:260`). §9 of
  this document re-derives it; it does not carry the Postgres derivation over.
- **`Formal/STORAGE_ALGEBRA.md` §5** — P10 (`:389`). §11 specifies what P10 must become.

---

## 0. Dependencies on other changes in this sprint

Stated rather than specified, per the sprint's boundary rule.

| # | Depends on | What this change consumes | What breaks here if it goes the other way |
|---|---|---|---|
| D-1 | `v1.0.0-sqlite-engine-core` | The **driver and topology**, both now **ruled**: a version-pinned `better-sqlite3`, with the handle confined to a dedicated worker thread. §7.1's discriminator is re-keyed to that ruling; §5's reason was already written topology-independently and is unchanged. | If the ruling were revisited toward the built-in, §7.1's mapping key changes shape again — see §7.1's note on why the key, not just the value, is the fragile part. |
| D-2 | `v1.0.0-sqlite-engine-core` | The **handle-unforgeability** guarantee — the handle never escapes the worker, so a caller cannot reach the database. | §6's poison flag stays correct either way, but the *residual* hole named in `council/redteam.md` §3.2 item 3 (a caller-supplied-SQL escape hatch on the transaction's connection) must be closed there, not here. |
| D-3 | `v1.0.0-sqlite-engine-core` | The **ext4 measurement gate**, and specifically its blocked decision **B-4**, which that change assigns to *this* one: the lease poll interval, the lease timeout budget, and whether the worker's per-statement write-lock amplification is acceptable. The required datum is commit latency at the chosen `synchronous` on a real filesystem — the quantity that moved 233×. | If the gate does not land, B-4 cannot be decided, and the poll schedule, retry parameters and default hold bound have no defensible values. This change is then implementable in structure but not in numbers. |
| D-3a | `v1.0.0-sqlite-engine-core` | The **per-statement deadline enforced inside the worker**, and the enumerated set of statements that cannot be aborted. | §4.3's transaction-hold bound is a *different* object and must not be conflated with it — see §4.5. |
| D-4 | `v1.0.0-sqlite-schema-parity` | Table/index **name prefixing** (index and trigger names are global per database file) and the migration **runner**. | The writer-registration table's physical name is that change's; its columns and protocol are §2's. |
| D-5 | `v1.0.0-sqlite-durability-contract` | The **error catalog**: the new non-retryable file-fault codes and the code the §2 fail-stop fault carries. | §7 states the behavioural constraints the code must satisfy; if the catalog cannot supply a distinct non-retryable code, §2's fault must **not** fall back to `TRANSACTION_FAULT`, which is retryable — see §7.3. |
| D-6 | `v1.0.0-sqlite-temporal-event-log` | The **adapter-side transaction-identity guard** and the T5 `BEFORE INSERT` trigger. | §6.3's precision — what the poison emulation protects and what it does not — is written against that trigger's `RAISE(ABORT)` behaviour; if the trigger is replaced by an application-side check, §6.3 must be re-derived. |

**Obligations handed *out* of this change by gate R-2.** These follow from §2.1's defect but land in
another capability's spec, so they are stated here and handed over rather than edited in place.

| # | Handed to | Obligation | Why it follows from this change |
|---|---|---|---|
| H-2 | `v1.0.0-sqlite-temporal-event-log` | its requirement *"the engine configuration under which trigger-based enforcement is sound is asserted, not assumed"* states the check-then-insert TOCTOU window is "closed **three independent ways**" — `SQLITE_BUSY` refusing a second simultaneous writer, `SQLITE_BUSY_SNAPSHOT` refusing a stale-snapshot upgrade, and fresh-snapshot visibility making a competing row visible to the assertion. **The three are not independent.** All three are consequences of write-lock exclusivity, and §2.1 shows one in-process `-shm` open+close removes it: two writers then hold write locks simultaneously, so nothing raises `SQLITE_BUSY`; each transaction's assertion runs against a snapshot taken before the other committed, so fresh-snapshot visibility does not see it either; and neither commit is refused. The claim needs qualifying with the same precondition, and the word "independent" is the specific thing to strike. | The trigger's soundness rests on the same `BEGIN IMMEDIATE` this change owns |
| H-5 | `v1.0.0-sqlite-durability-contract` | Any offline backup/restore procedure that copies the database together with its `-wal`/`-shm` sidecars must be specified **out-of-process or post-quiesce** (§2.6). An in-process three-file copy performs the attack from inside our own documentation. Also worth re-reading the `backup()`-versus-`VACUUM INTO` ruling against this: `backup()` is executed by the engine and opens no `fs` descriptor on the sidecars. | Backup is the most likely legitimate reason for any code to touch `-wal`/`-shm` |

---

## 1. The lease: the sidecar is rejected; L1 moves in-process

### 1.1 What broke, stated as a property rather than as a bug

Lane L2 chose a **per-key sidecar SQLite lock file held open under `BEGIN IMMEDIATE`**
(`reports/l2-concurrency.md` §4, "the lock IS the held transaction"), on the strength of exp 07:
non-blocking try, bounded wait, per-key independence, in-process mutual exclusion between two
connections, and cross-process crash release in 0 ms with no heartbeat. Every one of those
measurements is real. The design is still unusable, for a reason that is a property of the
primitive rather than a defect in the sketch:

> **A POSIX record lock (`fcntl(F_SETLK)`) is released when the holding process closes *any* file
> descriptor referring to that inode — not only the descriptor the lock was taken on.**

SQLite's unix VFS carries an elaborate workaround for exactly this (it defers closing its own
descriptors and reference-counts inodes). That workaround defends SQLite's own descriptors. It
cannot defend against a descriptor opened by Node's `fs` module in the same process. Measured
(`council/redteam.md` §3.1):

```
child: {"holder":"acquired","pid":461492}
[pre]  competitor tryAcquire -> {"ok":false,"errcode":5,"msg":"database is locked"}
child: {"holder":"readFileSync done","bytes":8192}
[post-readFileSync] competitor tryAcquire -> {"ok":true, ...}
*** MUTUAL EXCLUSION BROKEN: two live holders of the same lease key ***

-- attack 2: rm the sidecar lock file while held --
[post-unlink] competitor tryAcquire -> {"ok":true}
*** MUTUAL EXCLUSION BROKEN: new inode => new lock space => two live holders ***

=== sidecar journal_mode=default ===   pre: refused  after read .db: ACQUIRED  after read -shm: ACQUIRED
=== sidecar journal_mode=wal     ===   pre: refused  after read .db: refused   after read -shm: ACQUIRED
```

Three consequences the sketch cannot absorb:

1. **L2's sketch never sets `journal_mode` on the sidecar**, so the shipped lease lands in the
   `default` (= `delete`) row — the row where reading the `.db` file voids it.
2. **WAL on the sidecar is a partial mitigation only.** It moves the locks to `-shm`; reading
   `-shm` still voids them. The red team's own remediation list ends at "(c) never be opened by
   anything but SQLite in-process" and then concedes: *"given that (c) is unenforceable against
   consumer code in the same process…"*.
3. **`unlink` is unmitigable for a sidecar.** A tmp cleaner, a container image layer, a Docker
   volume reset, or a runbook step that reads "clear the stale lock files" produces two live
   holders with no error on either side.

**Ruling: the per-key sidecar is rejected and must not be implemented.** L2's claim that it is
"strictly safer than `pg_advisory_lock`" is struck from the record, as the red team requires.

### 1.2 What the obligation actually is

The obligation is narrower than the sidecar was built for, and the repo says so in three places
that agree:

- `docs/CONTRACT.md:109-110` — *"**Do not run two writer processes.** UmbraDB is designed for a
  single writer against a single Postgres instance; running two writer processes is unsupported in
  the 1.0 model."*
- `src/interfaces/transaction-lease.ts:14-15` — *"correct for this project's **single-process,
  single-writer** deployment; revisit only if a real multi-process/crash-recovery requirement
  appears."*
- `Formal/STORAGE_ALGEBRA.md` §5, P10 (`:389-393`) — the guarantee is *connection*-scoped; the test
  uses eight independent connections in one process and calls multiple processes "ideal", not
  required.

So Law L1's live obligation is **mutual exclusion between concurrent async callers and connections
inside one process**. The cross-process case is a *separate* obligation, and §2 owns it.

### 1.3 The mechanism: a process-local per-key FIFO mutex

`acquireLease` / `tryAcquireLease` / `withLease` serialize on a module-level
`Map<key, waiterQueue>` in the UmbraDB process. No file is created. No `fcntl` or `flock` is taken.
Nothing on the filesystem is consulted, so:

| Attack | Sidecar | Process-local mutex |
|---|---|---|
| `fs.readFileSync` of the lock file | **voids the lease, silently** | no file exists to read |
| `unlink` of the lock file | **two live holders, silently** | no file exists to unlink |
| Filesystem without working POSIX locks (NFS, SMB, WSL `/mnt/c` DrvFs) | **silently void** | unaffected |
| Holder process `SIGKILL`ed | kernel releases the `fcntl` lock; successor in 0 ms | the mutex dies with the heap that held it; a successor process starts with an empty map |
| Windows (`LockFileEx`, different semantics) | **inference, never measured** (`reports/l2-concurrency.md` §5 item 6) | platform-independent by construction |

The crash-release column is the one that looks like a regression and is not. A sidecar's crash
release is *fast*; a process-local mutex's crash release is *exact*, because the mutex and the
process have the same lifetime by construction. This is precisely the shift the lane already
identified — *"a shift of failure domain from **connection** to **process**, and the process domain
is strictly the coarser (safer) one"* — reached without a file.

The frozen semantics at `src/interfaces/transaction-lease.ts:31-33` — *"no TTL, no self-expiry, no
stealing"* — are satisfied literally. So is `LeaseTimeoutError`'s frozen doc at `:81-86` (both
halves: a `timeoutMs` that elapses throws; no `timeoutMs` waits indefinitely and the error cannot
occur), and `LeaseAcquireOptions.signal`'s promise of genuine mid-wait cancellation at `:186-188`,
which a JS queue delivers at wake granularity rather than poll granularity.

**One frozen TSDoc clause must be edited**, and it ships in `dist/index.d.ts`:
`src/interfaces/transaction-lease.ts:83` reads *"matching `pg_advisory_lock`'s real blocking
semantics"*. That is a mechanism reference sitting on the frozen surface. The *behaviour* it
describes is preserved; the *reference* becomes false. Free pre-tag; a published falsehood in a
machine-read artifact after.

### 1.4 Options considered and rejected

| Option | Why rejected |
|---|---|
| **Per-key sidecar SQLite lock file** (L2's choice) | §1.1. Voided by one `fs.readFileSync`; defeated by `unlink`; both silent. |
| **Sidecar + the red team's four mitigations** (WAL, protected directory, SQLite-only access, a P10 negative control) | (a), (b) and (d) are real improvements; **(c) is unenforceable against consumer code in the same process**, and (c) is the one the safety argument rests on. Retains a silent-void mode. |
| **Raw `flock(2)` beside the database** | `flock` locks attach to the *open file description*, not to `(process, inode)`, so they are immune to the descriptor-close attack — a genuinely better primitive. **But Node exposes no binding.** Verified on the installed runtime, §12(b): `fs` and `fs/promises` export nothing matching `/lock/i`, and `O_EXLOCK`/`O_SHLOCK` are `undefined`. It needs a native addon, and it is still defeated by `unlink`. |
| **Lock table row + heartbeat + stale takeover** | Rejected on the project's own prior grounds. This is exactly the TTL/lease-stealing design `Formal/STORAGE_ALGEBRA.md:303-317` and `src/interfaces/transaction-lease.ts:9-15` **already removed**, because L1 cannot be guaranteed for arbitrary caller code without a fencing token, a lease-loss `AbortSignal`, and fencing checks on every downstream write. Safety would rest on "no live holder is ever stalled longer than `T`" — unknowable, and this project's own recorded environment has a VM that crash-reboots under load. |
| **`BEGIN EXCLUSIVE` held open on the main database** | Whole-database, so it cannot express per-key leases (`wallet-sync:{networkId}`), and it serializes writers holding no lease. Also measured: in WAL mode `BEGIN EXCLUSIVE` does not even block readers (`reports/l2-concurrency.md` exp 03E) — it is `IMMEDIATE` with a misleading name. |
| **`PRAGMA locking_mode = EXCLUSIVE`** | Measured to lock every *other* connection out of the file entirely, including reads (`council/contradiction.md` §3.E) — incompatible with a writer + N readers model. It also moves WAL's locks off `-shm` and onto the main `.db` inode, which makes the descriptor-close attack *reachable against the main database*, i.e. it converts the one thing that survived into one more thing that does not. |
| **A permanently open read transaction as a liveness beacon** | Would let a second process detect a live first one. Rejected: a long-held read snapshot **completely blocks WAL checkpointing** while reporting `busy: 0`, so `-wal` grows without bound. Recorded here because it is otherwise tempting. |

---

## 2. Cross-process: the writer-generation guard

### 2.1 The attack the main database does NOT survive — corrected under gate R-2

**An earlier revision of this design rested on a claim that is false, and this is the most important
paragraph in the document.** The red team recorded (`council/redteam.md` §3.2 item 2):

> **The main WAL database survived the fd attack.** Same `readFileSync`, on `main.db` under an open
> `BEGIN IMMEDIATE`: the second writer was still refused, the commit succeeded, `integrity_check`
> was `ok`. The hazard is specific to rollback-journal-mode files, which is why it hits the lease
> sidecar and not the main store.

That test read **`main.db`**. It did not read **`main.db-shm`**, which is where WAL keeps the locks.
Reading the file the locks are *not* on proves nothing about the file they *are* on, and the
immunity conclusion drawn from it is wrong. Gate R-2's evidence seat found this, the adjudicator
reproduced it, and I reproduced it a third time independently — my own script, on ext4, against the
ruled binding — before changing a line here (§12(g)):

```
[none          ] competitor=refused SQLITE_BUSY  A.commit=ok rows=["A"] integrity=ok acknowledged_commit_lost=no
[shm-openkeep  ] competitor=refused SQLITE_BUSY  A.commit=ok rows=["A"] integrity=ok acknowledged_commit_lost=no
[shm-readclose ] competitor=COMMITTED            A.commit=ok rows=["A"] integrity=ok acknowledged_commit_lost=YES
```

**A single `fs.readFileSync` of `-shm` inside the holding process voids the write lock held by an
open `BEGIN IMMEDIATE`.** A second OS process then takes the lock and commits *inside* the holder's
transaction. **Both `COMMIT`s return ok. One acknowledged commit is silently lost.
`integrity_check` still returns `ok`.** The middle arm isolates the mechanism: opening the
descriptor and keeping it open is harmless, so the fault is the **close**, not the read — POSIX
record locks are dropped when a process closes any descriptor on the inode, exactly as for the
sidecar.

Three consequences, and they reshape the rest of this section:

1. **Locus buys less than was claimed.** WAL moves the locks from `.db` to `-shm`, so it makes the
   *likelier* accident harmless. It does not make the object immune; it relocates the exposed inode.
   The honest statement is "`-shm` is a less likely thing to read than `.db`" — a probability
   argument, not a safety one, and it must never again be written as the latter.
2. **The guard did not create this hazard and deleting the guard would not remove it.** What the
   attack voids is `BEGIN IMMEDIATE` itself — the primitive under *every* UmbraDB write, and the one
   change 2's trigger soundness and §9's C2a re-derivation also rest on. The guard is a victim of
   the defect, not its cause. The thing to eliminate is the in-process open+close (§2.6).
3. **The failure is strictly worse than the sidecar's.** The sidecar's void produced two lease
   holders with the store intact. This produces two committed writers, a **lost acknowledged
   commit**, and a clean `integrity_check` — silent data loss with no detector anywhere.

**What still holds, and it is why the guard stays on the main database rather than moving back to a
sidecar: coextensiveness.** A sidecar can be deleted as housekeeping — a tmp cleaner, a "clear the
stale locks" runbook step — and the `unlink` attack that follows is fatal and plausible. The main
database cannot be deleted without destroying the thing being protected, so `unlink` against it is
indistinguishable from `rm -rf` on the store. The guard is therefore exposed to **one** of the two
attacks rather than both, and the surviving exposure is the one §2.6 can make enforceable against
UmbraDB's own code. Moving the guard to a sidecar would reacquire the unlink exposure and keep the
descriptor exposure — strictly worse on both axes. That is a comparative argument, and it is stated
as one.

### 2.2 The protocol

A single-row registration table in the wallet lineage (physical name and prefixing are D-4's):

```
writer_generation(
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  generation    INTEGER NOT NULL,   -- monotonically increasing, never reset
  owner         TEXT    NOT NULL,   -- uuid, unique per open
  pid           INTEGER,            -- diagnostic only, never authoritative
  host          TEXT,               -- diagnostic only, never authoritative
  registered_at INTEGER NOT NULL    -- epoch ms, diagnostic only
)
```

**Registration, once, at open (after `runMigrations`):**

```
BEGIN IMMEDIATE;                                  -- the database write lock: cross-process, kernel-backed
UPDATE writer_generation
   SET generation = generation + 1, owner = :uuid, pid = :pid, host = :host, registered_at = :now
 WHERE id = 1;
SELECT generation FROM writer_generation WHERE id = 1;   -- read back inside the same transaction
COMMIT;
```

The read-back value is this process's `myGeneration`. `pid` and `host` are diagnostics for the
"the wallet is stuck" support case; **nothing in the protocol reads them**, because a pid is not a
liveness proof across restarts, hosts or containers.

**The guard, on every write transaction:**

```
BEGIN IMMEDIATE;                                  -- already required by §4
SELECT generation FROM writer_generation WHERE id = 1;
-- if generation != myGeneration:  ROLLBACK; throw WriterDisplaced (non-retryable)
... the transaction's real work ...
COMMIT;
```

**And on every lease acquisition**, so a displaced process cannot hand out leases it has no right
to. That read is *not* a safety mechanism (it is outside the write lock); it is a fast-fail. Safety
is the write-transaction check alone.

### 2.3 Why this is sound, and exactly how far it goes

`BEGIN IMMEDIATE` takes SQLite's file-level write lock, which is exclusive across processes. The
guard `SELECT` and the transaction's writes are inside it. Therefore — **while the write lock is
intact** — no interleaving exists between "observe the generation" and "commit": once process B's
registration commits, no transaction from process A can commit. There is no timer, no heartbeat, no
liveness inference, and no window whose size a reviewer has to trust.

**The qualifier is load-bearing and is stated first, not in a footnote.** The exclusivity is a
property of a POSIX record lock, and §2.1 shows that lock is dropped when the holding process closes
*any* descriptor on `-shm`. So the soundness argument reads, in full:

> **Given that no code in the holding process opens and closes a descriptor on the database's `-wal`
> or `-shm` file**, the guard read and the transaction's writes are inseparable, and at most one
> process commits.

If that precondition is violated the guarantee is not weakened, it is **absent**: two writers commit
and one acknowledged commit is lost, with no error and a clean `integrity_check`. §2.6 is what makes
the precondition enforceable rather than aspirational, and §2.6's residue — that it binds UmbraDB's
code and not the embedding application's — is the honest limit of this whole section.

What it delivers, precisely:

- **Detected:** two writer processes are no longer undefined behaviour.
- **Fail-stop, transaction-granular:** the displaced process is refused at its **next** write
  transaction, *before* that transaction commits, with a typed non-retryable error.
- **No stale-lock cleanup:** a crashed writer leaves `generation = N` and no lock anywhere; the
  successor bumps to `N+1` and runs. There is no "remove the stale lock file" step, which is the
  operational failure mode every pid-file design ships with.
- **Crash-safe by construction:** the registration is an ordinary committed row, so a crash mid-way
  either committed or did not.

What it does **not** deliver, stated as limits rather than as caveats:

- **It is void, not merely weakened, if the write lock is voided.** §2.1, §2.6. This is the first
  limit listed because it is the one that was previously stated as an absence of limits.
- **It does not refuse the second process at open.** Later-wins, not first-wins. §3.2 rules on this.
- **It is transaction-granular, not lease-granular.** A displaced process running a multi-transaction
  critical section under `withLease` may have committed some of its transactions and be refused on
  the next. Each transaction remains atomic; the *sequence* may be torn. This is strictly better
  than today's undefined behaviour and strictly weaker than a lease-level guarantee, and the spec
  says so in a scenario.
- **It is not a fencing token for caller code.** Callers get no token and check nothing. This is
  deliberate; see §2.4.
- **Notification latency is best-effort.** An idle process learns it was displaced only at its next
  write. An optional out-of-transaction poll may shorten that; it is a *detector*, never an
  authority, and safety must not degrade if it is disabled. Any implementation that makes safety
  depend on the poll interval has reintroduced a TTL and is a defect.

### 2.4 Why this does not reopen the decision `STORAGE_ALGEBRA.md` §4 closed

`Formal/STORAGE_ALGEBRA.md:303-317` removed TTL self-expiry and lease stealing because *"TTL-based
expiry makes L1 impossible to guarantee for arbitrary caller code, because `withLease`'s callback
has no way to learn its lease was stolen mid-execution and stop."* That objection is about a
callback that must **learn and react**. It does not bite here:

- There is no TTL and no expiry. A generation changes only when another process actually registers
  — an *observed* event, not an inferred one.
- The displaced callback does not need to learn anything, because its writes **cannot commit**. The
  enforcement is at the storage boundary, not in caller code, and it requires no fencing check on
  any downstream write.
- No lease is stolen. The per-key lease (§1) is process-local and is never transferred.

The guard is therefore additive to §4, not a reversal of it: it converts §4's *deployment
precondition* ("don't run two writer processes") into a *detected, enforced* fail-stop.

### 2.5 Preconditions, written down

The guard's soundness assumes: the two processes open **the same inode** at the same path; SQLite's
own file locking works on that filesystem; and **no code in the holding process opens and closes a
descriptor on the database's `-wal` or `-shm` file**. The first two are preconditions of the
*store*, not of the guard — a store whose file has been swapped, or whose locking does not work, has
already lost. `v1.0.0-sqlite-engine-core` owns the startup filesystem probe; this change requires
that the probe exists and that the §5 contract text names the precondition.

The third is new, is specific to this engine, and is the subject of §2.6.

### 2.6 The descriptor precondition, made enforceable

The precondition "nothing opens and closes `-wal`/`-shm` in this process" is exactly the shape the
red team called **unenforceable** when it appeared as the sidecar's mitigation (c). It is not
enforceable against arbitrary consumer code sharing the process, and pretending otherwise would
repeat the error this gate exists to correct. What *can* be done is to split it into a part that is
mechanically enforced and a part that is documented, and to be explicit about which is which:

**Enforced, mechanically, against UmbraDB's own code: a source guard.** The same instrument change 2
uses to ban `INSERT OR REPLACE` — an executable check that fails the build, not a review convention.
It bans, anywhere in UmbraDB's sources, any `node:fs` operation that opens a descriptor on **the
database file or either of its `-wal` / `-shm` sidecars**: `readFile`/`readFileSync`,
`open`/`openSync`, `copyFile`, `createReadStream`, and any helper that takes the database path and
derives one of those paths from it. `stat`/`existsSync`, which do **not** open a descriptor, remain
permitted, and the check must distinguish them — banning them instead would be both wrong and a
signal the author had not read §2.1's middle arm.

This is worth stating precisely because the middle arm of the reproduction narrows the ban usefully:
the fault is the **close**, not the open. A descriptor opened and *held* is harmless. But "open and
never close" is not a discipline any codebase can sustain, so the guard bans the open outright and
accepts that it is stricter than the minimum. Being stricter than necessary is the correct direction
for a rule whose violation is silent data loss.

### 2.6.1 Why the ban covers the database file too, and why it cannot be journal-mode-conditional

An earlier revision of this guard was scoped to `-wal`/`-shm` only. Change 2 found the gap and
correctly declined to close it unilaterally: **which file carries the write lock is
journal-mode-dependent**, so a sidecar-only ban protects the `wal` case and nothing else. I measured
all three modes on ext4 against the ruled binding before ruling (§12(h)):

| `journal_mode` | locks live on | in-process read+close of `.db` | of `-shm` |
|---|---|---|---|
| `wal` | `-shm` | **harmless** — competitor still refused | **voids** — competitor commits, acknowledged commit lost, `integrity_check` `ok` |
| `delete` | the database file | **voids** — competitor commits; A's own `COMMIT` then fails `SQLITE_IOERR_DELETE_NOENT`; the competitor's acknowledged commit is lost | no `-shm` exists |
| `truncate` | the database file | **voids** — competitor commits, acknowledged commit lost, both `COMMIT`s return ok | no `-shm` exists |

Two things this settles.

**The `delete` row is why the red team and I appeared to contradict each other, and neither of us was
wrong — we attacked different files.** The signal was already inside the red team's own sidecar
table, whose `journal_mode=wal` row reads *"after read `.db`: refused; after read `-shm`:
ACQUIRED"*. That observation was applied to the lease sidecar and never carried across to the main
store's exclusivity argument, so I inherited a `wal`-shaped conclusion and change 2 inherited an
all-modes one. A fact simply never moved between two lanes. That is the failure mode this parallel
structure produces, and it is recorded here so the next reader does not re-litigate it.

**Ruling: extend the ban to the database file, unconditionally, for all modes.** Not merely because
it is safer, but because the alternative is not implementable:

- **A static source check cannot be journal-mode-conditional.** `journal_mode` is a persistent
  property *of the database file*, mutable at runtime and out from under us — which is exactly why a
  conformance property asserting the mode at every commit was proposed in the first place. A source
  guard runs at build time and cannot know which mode a file will be in. The only rule a static
  check can express that covers all modes is the **union** of the files any mode exposes: the
  database and both sidecars.
- **The cost to UmbraDB's own sources is near zero.** The engine opens the database through its
  native binding, not through `node:fs`; nothing in the adapter has a legitimate reason to open a
  descriptor on its own store. The one procedure that would have — an offline backup copy — is
  already being specified out-of-process by the release-contract capability (H-5), which is what
  makes this ban cheap rather than obstructive.
- **Change 2's all-modes T5 soundness claim is preserved**, which was the point of the question. The
  narrower option would have forced that claim down to `wal` alone and given up rollback-journal
  mode's *stronger* exclusion — paying real capability to avoid a build rule that costs nothing.

**The honest asymmetry the widening introduces, stated because it changes what the embedder must
avoid.** Under the shipped `wal` mode an in-process read of the database file is *measured
harmless*; only `-shm` is exposed. But reading `main.db` is a far more plausible act than reading
`-shm` — a naive backup, a size check that opens rather than `stat`s, a checksum utility — and under
`delete`/`truncate` it is fatal. So the rule is stated over the whole artifact set rather than
per-mode, and the contract text says plainly that under the default mode only the sidecars are
actually exposed, so an embedder sees both the rule and its reason without being told something
false in either direction.

### 2.6.2 Everything that inherits this precondition

Write-lock exclusivity is load-bearing in more places than the writer-generation guard, and each
inherits the precondition. Listing them is what stops the next author re-deriving one as
unconditional:

| # | Claim | Owner | Inherits because |
|---|---|---|---|
| E-1 | A displaced writer cannot commit | this change, §2.3 | the guard read and the writes are inseparable only while the lock holds |
| E-2 | A second process cannot register mid-transaction | this change, ordering 2 | it is `SQLITE_BUSY` that refuses B |
| E-3 | The wallet migration lock excludes a concurrent `runMigrations` **across processes** | this change, §2.2 / task 2.4 | the process-local mutex is per-process; cross-process exclusion is the write lock |
| E-4 | `prune`'s C2a safety — "no other writer can commit for the transaction's duration" | this change, §9 | the re-derivation is *from* `BEGIN IMMEDIATE` |
| E-5 | T5 trigger soundness under concurrent writers in all three journal modes | change 2 | the six-cell attack result assumes exclusivity in every cell |
| E-6 | The transaction-identity guard refusing forgery from outside the process | change 2 | an external actor is refused by the write lock, not by the adapter |
| E-7 | Migrations are excluded across processes by the migration lock, "reinforced by `BEGIN IMMEDIATE` making two migration transactions mutually exclusive across processes regardless" — the clause that makes the handover to the generation guard continuous rather than gapped | change 4, `design.md` §"Migrations are deliberately *not* covered by the generation guard" | the reinforcement clause **is** write-lock exclusivity, and it is what closes the window before any process has a `myGeneration` |
| E-8 | Removal of the archive's row locking is "discharged by single-writer serialization under `BEGIN IMMEDIATE`, not by the guards being unnecessary" | change 6, requirement "the removal of row locking is justified, not assumed" | the two-session interleaving proof it replaces holds only while exclusivity holds |
| E-9 | The archive's single-transaction ingest bundle | change 6 | both its atomicity and its exclusion of a concurrent ingest rest on the write lock |
| E-10 | A whole-import transaction holds the whole-database write lock for the import's duration — the premise of change 7's negative control against that shape | change 7, "a single whole-file transaction (negative control)" | if the lock can be voided mid-import, the stated consequence does not follow and the long-held-transaction diagnostic it trips may never trip |

**E-8 and E-9 carry a second, independent qualifier: the archive's own writer-generation guard
(G-8).** `BEGIN IMMEDIATE` serializes *transactions*; it does not make a process a single writer.
Two `archive:sync` instances interleave transactions perfectly legally, so "single-writer
serialization" is not established by the write lock alone — it needs the guard as well as the
descriptor precondition. That qualifier is change 6's to carry in its own text.

Every row is sound under the source guard plus the documented embedder precondition, and none is
sound without. Where a scenario in *this* specification asserts one it carries the qualifier
explicitly; each other change carries it in its own text, because a qualifier recorded only in a
neighbour's design document is precisely how invariant I-4 was lost.

**This table is a checked enumeration, not an authored one, and the distinction is the whole point.**
Its first version covered only the five-change sprint and was silently incomplete the moment changes
6 and 7 landed — the same over-claim shape, an enumeration presented as complete, that this change
exists to correct elsewhere. It is therefore maintained against a mechanical sweep across **all
seven** change directories for the exclusivity phrasings, not against an author's recollection, and
the sweep is a gate condition rather than a habit.

**Documented, not enforced: the embedding application.** UmbraDB cannot stop a wallet, a diagnostic,
a crash reporter or a naive backup script in the same process from reading `-shm`. `docs/CONTRACT.md`
§5 must therefore name this as a binding precondition on the *embedder*, in the same register as the
existing filesystem preconditions, and must state the consequence in the terms the reproduction
produced: not "locking may be unreliable" but **"two writers may both commit and an acknowledged
commit may be silently lost, with `integrity_check` reporting `ok`."** A precondition whose
consequence is stated vaguely is one nobody prioritises.

**The two obligations this creates in other changes** (handed over, not specified here — §0):

- **Change 5 (`release-contract`)** owns backup/restore. Any offline copy procedure that reads the
  database file together with its `-wal`/`-shm` sidecars must be specified as **out-of-process**
  (a separate process, e.g. a CLI, so the close happens in a process holding no lock) or
  **post-quiesce** (after UmbraDB has closed the database and no transaction is open). An in-process
  three-file copy is the attack, performed by our own documentation. This is *also* an argument the
  contradiction seat's `backup()`-over-`VACUUM INTO` ruling should be re-read against, since
  `backup()` is executed by the engine and opens no `fs` descriptor on the sidecars at all.
- **Change 2 (`temporal-kv`)** claims at its requirement *"the engine configuration under which trigger-based enforcement is sound is asserted, not assumed"* that the
  check-then-insert TOCTOU window is "closed three independent ways". Under this defect the three
  are **not independent**: all three rest on write-lock exclusivity. See §0's handover row.

---

## 3. `docs/CONTRACT.md` §5 — the strengthening, and its limit

### 3.1 What §5 says today and what it becomes

Today (`docs/CONTRACT.md:101-112`): the lease *"does **not** fence writes against connection
death"*, and *"**Do not run two writer processes.** … running two writer processes is unsupported in
the 1.0 model."*

Two edits, one strengthening and one honest replacement:

- **The connection-death clause is retired, not reworded.** Under §1 the lease has no connection.
  A lease is held by the process and released by explicit release or process exit; the
  "mutual exclusion may have lapsed" hazard that `withLease`'s entire `onReleaseFault` apparatus
  exists to report (`src/interfaces/transaction-lease.ts:189-197`,
  `src/postgres/transaction-lease.ts:403-472`) becomes unreachable. The API stays (G1 freezes it);
  the *hazard* is gone.
- **"Unsupported" becomes "detected and fail-stopped."** New §5 text, which is exactly §2.3 and no
  more: a second writer process is detected; the displaced process is refused at its next write
  transaction, before that transaction commits, with a typed non-retryable error; the guarantee is
  transaction-granular; it does not hold if the database file is deleted or replaced beneath a live
  process.

### 3.2 Ruling: the mandate's stronger sentence is NOT claimed

The enhancement mandate offers "a second writer process is **refused**" *if and only if* the
mechanism holds. It is not claimed, for a reason that is worth stating in full because it is the
kind of thing a later reader will otherwise try to "fix":

**First-wins refusal requires an OS-supplied liveness signal, and there is none available
in-process without a native dependency.** To refuse process B at open, B must decide whether the
recorded owner A is still alive. The available answers are:

1. **A held OS lock** — the OS answers "is the holder live" for free. This is why file locks are
   used. Every in-process variant is §1.1: voidable by a descriptor close, and by `unlink`.
2. **A pid / heartbeat / TTL** — a liveness *inference*. Rejected by §1.4 and by
   `Formal/STORAGE_ALGEBRA.md:303-317`.
3. **Refuse whenever the row is non-null, clear it on clean shutdown** — sound, but a crashed
   writer wedges the store until an operator runs a documented cleanup step. For a *daemon* that is
   a reasonable trade; for a **wallet library** whose canonical bug report is "the wallet is stuck"
   it converts a rare silent hazard into a common loud one. Rejected on product grounds, explicitly.
4. **A native `flock(2)` / `LockFileEx` guard** — sound, immune to the descriptor-close attack
   (locks attach to the open file description), still defeated by `unlink`, and **not reachable
   from Node core** (§12(b), verified). This is the option that would earn the stronger sentence.

**Ruling.** Claim the fail-stop form. Do not claim refusal-at-open. If
`v1.0.0-sqlite-engine-core` rules for a third-party native binding, re-open this with a concrete
question — does that binding expose file locking, or would an `flock` addon be a *new* dependency
class? — and price refusal-at-open then. Until that is answered by reading the binding's source,
writing "a second writer process is refused" would be the same over-claim that broke the sidecar,
made a second time in the same change.

---

## 4. `BEGIN IMMEDIATE`, the whole-database lock, and what bounds it

### 4.1 Why `IMMEDIATE`, not `DEFERRED`

`DEFERRED` takes no write lock at `BEGIN`; the first write attempts an upgrade, which yields
`SQLITE_BUSY` or, if any other connection committed since the read snapshot,
`SQLITE_BUSY_SNAPSHOT`. `SQLITE_BUSY_SNAPSHOT` is **not** retried by the busy handler — measured
returning immediately under a non-zero `busy_timeout` — and does **not** auto-rollback the reader's
transaction (`reports/l2-concurrency.md` exp 04/13, exp 09A). So a `DEFERRED` write path converts an
acquisition-time wait into an unavoidable **mid-callback** failure, after arbitrary caller code has
already run.

That is not merely inefficient; it is the LND failure shape. The contradiction seat's C14 ruling:
the LND P0 that L7 documents *"is specifically a `DEFERRED` lock upgrade escaping mid-transaction,
which `BEGIN IMMEDIATE` structurally prevents (LND's own fix was `_txlock=immediate`)"* — and L7's
B8 (that `SQLITE_BUSY` needs a new frozen error code) is therefore a **conditional**, not an
absolute: *"If any write path is ever allowed to be `DEFERRED`, L7's B8 fires and a new code is
needed."* `BEGIN IMMEDIATE` on every write path is what makes §7's zero-surface-change mapping true.

### 4.2 The loss nobody replaced

`withTransaction` becomes a **whole-database** write mutex. Measured: a writer to a *different
table in the same file* gets `SQLITE_BUSY`; an `await` inside the callback holds the lock for the
whole await, with another writer still `BUSY` 352 ms in (`reports/l2-concurrency.md` exp 11A, 11D).
`fn` is arbitrary caller code (`src/interfaces/transaction-lease.ts:234-237`).

Today that is bounded by the server: `idle_in_transaction_session_timeout`, sent as a startup
parameter at `src/postgres/client.ts:180`, default 120 000 ms
(`DEFAULT_IDLE_IN_TX_TIMEOUT_MS`, `client.ts:145`; documented at
`docs/durability-contract.md:104`). Under SQLite there is no server, no watchdog thread, and no
backstop of any kind. The feasibility seat: *"Today that is a slow query; tomorrow it is a stalled
database. L2 recorded the mechanism; nobody rated it"* (`council/feasibility.md` §4 item 7).

### 4.3 What bounds it here

A **transaction-hold watchdog owned by the layer**. When `withTransaction` opens
`BEGIN IMMEDIATE`, it arms a timer for the hold bound. If the timer fires while `fn` has not
settled, the layer:

1. `ROLLBACK`s the transaction on the connection it owns — releasing the whole-database write lock;
2. unregisters the handle, so every later use of it throws `TransactionHandleInvalidError`
   (the registry already gives exactly this behaviour, `src/postgres/transaction-lease.ts:48-61`);
3. rejects `withTransaction` with `TransactionFaultError(faultKind:"timeout")`; and
4. lets `fn` run to completion in the background and discards its outcome — `fn` is not
   interruptible and pretending otherwise is what `docs/CONTRACT.md` §3's deleted clause did.

This does two things at once. It restores the *semantic* `idle_in_transaction_session_timeout`
provided, and it keeps two frozen options alive that the lane report writes off:

- `TransactionOptions.timeoutMs` (`src/interfaces/transaction-lease.ts:166`) is documented as
  *"Statement/transaction timeout; a timeout surfaces as {@link TransactionFaultError}"*.
  Implementing it as a **transaction-hold** bound keeps that sentence true and keeps
  `faultKind:"timeout"` reachable, instead of L2's "validated-then-ignored".
- `UmbraDBConnectionOptions.idleInTxTimeoutMs` supplies the **default** bound, so a caller who
  passes no `timeoutMs` is still bounded. Its current default (120 000 ms) is the starting value;
  the shipped default is a number to establish behind D-3, not to assert.

**The honest limit:** a `fn` that blocks the thread synchronously — a tight loop, a
`readFileSync` of a huge file, a synchronous crypto call — cannot be bounded, because the timer
cannot fire. That limit is real, is a property of the runtime rather than of this design, and is
written into the contract text rather than discovered.

### 4.4 The write queue is mandatory, not an optimisation

Two concurrent in-process `withTransaction` calls on one connection produce a `SqliteError` with
`code === "SQLITE_ERROR"` and the message *"cannot start a transaction within a transaction"*
(verified on the ruled binding, §12(f); `reports/l2-concurrency.md` exp 07/7 records the same
failure against the other candidate). A FIFO write queue serializes top-level transactions.
**Nested** calls must not enter the queue — that is a guaranteed self-deadlock — they take §10's
savepoint path.

### 4.5 The hold bound and change 1's statement deadline are different objects

`v1.0.0-sqlite-engine-core` enforces a **per-statement** deadline inside the worker, and can abort a
running statement whose plan re-invokes a per-row guard. That is not the bound §4.3 specifies, and
conflating them would leave the real gap open:

- **Change 1's statement deadline** bounds *one statement's* execution. It closes the
  `statement_timeout` gap for row-visiting statements and, by that change's own requirement,
  explicitly does **not** close it for statements whose cost is inside the engine with no per-row
  guard — a single-row index seek, a `backup()`, a `VACUUM INTO`.
- **§4.3's hold bound** bounds *the whole transaction's* possession of the whole-database write
  lock, across every statement, every await, and every gap in between. Nothing in change 1 bounds
  that, because the time is spent in caller code between statements, not inside a statement.

The interaction that must be stated rather than discovered: a transaction whose current statement is
one of the uncancellable cases cannot be rolled back until that statement returns, so the hold bound
fires late by that statement's remaining runtime. That is a bounded, nameable residue rather than an
unbounded hole, and the contract text says which cases produce it by referring to change 1's
enumerated list rather than restating it.

---

## 5. Acquisition waits in JS. `busy_timeout = 0`. The reason, re-derived.

### 5.1 The measurement

The naive port of the blocking wait fails P10 (`reports/l2-concurrency.md` exp 10):

```
(a) blocking busy_timeout=1000: acquired=1/8 failed=[7x LeaseTimeoutError] maxActive=1 overlap=false elapsed=7018ms
(b) poll loop timeout=5000    : acquired=8/8 failed=[]                     maxActive=1 overlap=false elapsed=171ms
```

### 5.2 The reason L2 gave, and why it must not be carried over

L2's stated mechanism is *"keeps the event loop turning so an in-process holder can actually
release."* Under `v1.0.0-sqlite-engine-core`'s worker topology the main event loop keeps turning by
construction, so that reason predicts the hazard is gone. **It is not; it moved.** The contradiction
seat built the worker and put the blocking wait inside it (`council/contradiction.md` §3.W):

```
blocking : mainTicks 3649  ["acquired@39ms","contend-start@49ms","contend-end:failed(5)@3054ms","released@3054ms"]
poll     : mainTicks 3654  ["acquired@36ms","contend-start@50ms","released@300ms","contend-end:acquired(poll)@304ms"]
```

The release message sat in the **worker's** queue for three seconds while the worker was blocked
inside SQLite's busy handler; the main loop was perfectly healthy throughout. The feasibility seat
reached the same conclusion independently and named the trap: an implementer reading L3's
0.6 ms main-loop lag figure would reasonably conclude the hazard was retired
(`council/feasibility.md` §2.1).

**The correct reason, and the one the requirement is written against:** *a blocking wait inside
SQLite pins the queue that must deliver the release.* Which queue that is depends on the topology —
the JS event loop in-process, the worker's message queue off-thread — and the requirement must not
name one, or it becomes false the next time the topology changes.

This also rules against `busy_timeout` values imported from multi-process daemons: L6's 30 000 ms
and L7's 60 000 ms are correct for CLN and LND, which do their waiting in separate OS processes,
and actively harmful in a single-process library that waits in JS.

### 5.3 What replaces it

`PRAGMA busy_timeout = 0` on **every** handle — a true non-blocking probe, the
`pg_try_advisory_lock` equivalent (`reports/l2-concurrency.md` exp 03D) — plus a bounded, jittered
retry classifier in the adapter, built with LND's parameters (bounded attempts, jitter, a cap)
rather than a flat poll, which L2 itself flags as untested against long batches (`§5` item 2). The
poll schedule and the retry parameters are numbers to **establish** behind D-3, under stated
conditions, not to copy from a tmpfs-era run.

Two consequences worth recording:

- **The acquisition bound is preserved, not invented.** UmbraDB's existing `lock_timeout` default
  is 30 000 ms (`docs/durability-contract.md:103`,
  `DEFAULT_LOCK_TIMEOUT_MS`, `src/postgres/client.ts:144`), and
  `DEFAULT_MIGRATION_LOCK_TIMEOUT_MS` is 30 000 ms (`src/postgres/migrate.ts:18`). L7's field
  evidence — *"5 seconds is not a default, it is a bug"* — argues for keeping them, not shortening
  them.
- **`SQLITE_BUSY_TIMEOUT` becomes unreachable by construction.** L2 could not produce it and listed
  the mapping defensively (`§5` item 5). With `busy_timeout = 0` there is no busy handler to give
  up, so it cannot be raised. That closes the open question by design rather than by experiment, and
  the spec asserts it as a testable property rather than assuming it.

---

## 6. Sticky-poison emulation, scoped precisely

### 6.1 The gap

`src/interfaces/transaction-lease.ts:216-226` documents, at length and as frozen contract, that once
any query through `tx` rejects, the whole underlying transaction is poisoned server-side — so a
caller who swallows the rejection and keeps going gets **nothing** committed. SQLite does not do
this. Measured (`council/contradiction.md` §3.A): after `1555 UNIQUE constraint failed`, the
connection is still in its transaction, the next `INSERT` succeeds, and `COMMIT` commits both
surrounding writes.

**The documented consequence of a frozen error therefore inverts: "you get nothing" becomes "you get
a partial transaction."** That is a safety regression, not a nicety, and it is invisible in the type
system.

### 6.2 The hole neither lane could see, and where the flag goes

L2 specifies the flag as set *"when any statement through it throws"* (`reports/l2-concurrency.md`
B4). Under this migration a whole class of transaction-scoped errors is thrown **by the adapter,
before any statement reaches SQLite** — the transaction-identity guard (D-6) is the immediate
example, because `txid_current()` has no unforgeable substitute and the check moves into the
adapter. Measured (`council/contradiction.md` §3.A2):

```
adapter threw: TransactionKeyReuseError (adapter-enforced)
isTransaction: true | NO statement reached SQLite
ON DISK: [{"id":1,"v":"a"},{"id":2,"v":"c"}]   <- PARTIAL COMMIT survives an adapter-thrown error
```

Today that same error arrives from the server as a SQLSTATE and *does* poison the transaction.
**Ruling (the seat's, adopted): the flag is set by the adapter wrapper on any thrown `StorageError`
whose scope is the transaction — not by the statement executor.** Two lines of code, specified by
nobody until now, and the difference between "you get nothing" and a partial commit.

**Scope rules, stated so an implementer cannot get them wrong:**

- Poison is **per-transaction and monotone**. Once poisoned, always poisoned, for the life of that
  transaction. This matches Postgres, where a failed statement poisons the whole transaction
  regardless of savepoints unless the caller explicitly `ROLLBACK TO` — which UmbraDB never
  exposed.
- A failure inside a **nested** scope (§10's savepoint reentrancy) poisons the outer transaction
  too. Conservative and sound; the alternative would let a nested retry commit half a logical
  operation, which is the exact hazard being closed.
- A poisoned transaction always ends in `ROLLBACK`, never `COMMIT`, whatever `fn` returns.
- Every later use of the handle rejects with the **original** error, so the caller sees the fault
  that actually happened rather than a generic "poisoned" error.

### 6.3 What the emulation protects — and what it does not

This is the precision the corpus has and the lane reports do not, and getting it wrong in either
direction produces a bad implementation.

**It does NOT protect T5.** Lane L1's refinement, confirmed by the contradiction seat (§2.9): a
`RAISE(ABORT)` in a `BEFORE INSERT` trigger reverses the **entire statement, including the trigger's
own history INSERT**. So a swallowed T5 violation leaves the store T5-coherent with or without the
poison flag. **T5's soundness depends on the caller-atomicity design rule "never split a logical put
across two statements" (D-6's), not on this emulation.** An implementer who believes the emulation
is what keeps T5 sound will under-test the design rule, which is the thing that actually carries it.

**It DOES protect caller atomicity** — the frozen documented consequence at `:216-226`, which is
about what a *caller* observes after swallowing an error, not about what the store's own invariants
permit. That is the whole of its job, and it should be tested as exactly that.

---

## 7. Contention errors: zero surface change

### 7.1 The mapping, keyed on the ruled binding's discriminator

**The discriminator is a string, not a number, and this is a correction.** The research corpus keys
its mapping on `err.errcode`, the numeric *extended* result code (`reports/l2-concurrency.md` exp
04: `errcode=517`, `errcode=1555`). That is correct for `node:sqlite` and **wrong for the binding
`v1.0.0-sqlite-engine-core` ruled**. On a version-pinned `better-sqlite3` the thrown error is a
`SqliteError` whose `code` is the extended result-code *name*; verified on the installed copy,
§12(f), where the error's own property list is exactly `["stack","message","code"]` — **there is no
numeric `errcode` field at all**, so a mapping keyed on one does not merely read the wrong field, it
reads `undefined` and falls through to the catch-all for every contention error.

| Discriminator (`err.name === "SqliteError"`) | Context | UmbraDB code | Retryable | Frozen today? |
|---|---|---|---|---|
| `code === "SQLITE_BUSY"` | lease acquire, bound elapsed | `LEASE_TIMEOUT` | retryable | yes (`docs/ERROR-CATALOG.md:35`) |
| `code === "SQLITE_BUSY"` | migration lock acquire, bound elapsed | `MIGRATION_LOCK_TIMEOUT` | retryable | yes (`:44`) |
| `code === "SQLITE_BUSY"` | `BEGIN IMMEDIATE` in `withTransaction`, bound elapsed | `TRANSACTION_FAULT` (`faultKind:"timeout"`) | retryable | yes (`:34`) |
| `code === "SQLITE_BUSY_SNAPSHOT"` | snapshot stale on write upgrade | `TRANSACTION_FAULT` (`faultKind:"serialization-failure"`) | retryable | yes |
| `code === "SQLITE_LOCKED"` | DDL against a live cursor on the same connection | programmer error, non-retryable; **prevented**, not mapped | — | D-4 owns the runner |
| `code === "SQLITE_CANTOPEN"` / `"SQLITE_NOTADB"` / `"SQLITE_CORRUPT"` / `"SQLITE_READONLY"` / `"SQLITE_IOERR"` | file-level faults | **not** `CONNECTION_ERROR` (§7.4) | non-retryable | D-5 owns the codes |

**No arm of this table parses a message string**, and that is a constraint rather than an accident.
The ruled binding's error object carries only `["code","message","stack"]` — no structured field
naming a constraint, a table or a column — so any classification that needs more than `err.code`
must read prose. Every mapping above is decidable from `err.code` plus the situation, so this
capability parses nothing. Where a future distinction cannot be made that way, it goes through the
**single shared parse function** change 6 established and change 1 prescribes — one function, one
place, round-trip tested against the declared names it parses — and never through an ad-hoc regex at
the call site. §10's nested-`BEGIN` case is the near miss worth naming: it is distinguished by
message text in SQLite, and this design does not classify it at all, because §4.4's write queue and
§10's savepoint path make it unreachable by construction rather than something to recognise after
the fact.

Two further properties of this table are worth stating because they are what makes it survivable:

- **The mapping is keyed on the *situation* plus the result-code name, never on a driver-specific
  representation of that name.** The situation column is what carries the mapping — the same
  `SQLITE_BUSY` means three different frozen codes depending on where it arose — and situations do
  not change when a binding does.
- **The key's *shape* is the fragile part, not its values.** A numeric key and a string key both
  express the same result codes; swapping bindings silently changes which field holds them, and a
  wrong field produces no type error and no test failure except in the tests that assert the mapped
  code. The spec therefore requires a test asserting the discriminator field is present and
  non-`undefined` on a real thrown error, so a future binding swap fails loudly at that assertion
  rather than quietly re-routing every contention error to the catch-all.

Every retryable target is an existing frozen code carrying an existing frozen `faultKind` member.
`src/interfaces/transaction-lease.ts:76` reads verbatim:

```ts
readonly faultKind: "connection-lost" | "serialization-failure" | "deadlock" | "timeout" | "unknown",
```

**Zero surface change.** This is the commitments seat's R-relay ruling, and it corrects L7's B8 —
labelled by L7 "the single strongest negative this lane found" — which was written without L2's
mapping in hand.

### 7.2 Why adding a code is forbidden

L7 proposed adding a `BUSY`/`WRITE_CONTENDED` code. The commitments seat ruled (R-relay, ruling 3):

> Adding one would repeat LND's mistake in a new form: it promotes a transient into the caller's
> decision surface, which is exactly the shape that produced #7869 (a transient BUSY surfaced to the
> caller mid-protocol, leaving durable state advanced while the counterparty was not told).

LND's maintainer's own diagnosis is *"the current logic just sets a value, but then doesn't actually
try re-execute the transaction before reporting the error back to the caller"* — **a missing retry
layer, not a missing code**. So the requirement is not "do not add a code" as taste; it is: keep
`SQLITE_BUSY` **inside** UmbraDB behind a bounded retry, and surface it only when the bound is
exhausted, at which point `LEASE_TIMEOUT` / `MIGRATION_LOCK_TIMEOUT` /
`TRANSACTION_FAULT("timeout")` are *precisely* right, because they already mean "a bounded wait
elapsed". Ship LND's four layers as UmbraDB's own contract, not as caller advice.

The commitments seat also records the counter-fact honestly, and the spec must not misstate it:
adding a code is *permitted* by `docs/STABILITY.md:20-22` even post-tag, in a minor. The prohibition
here is a **safety** ruling, not a SemVer one, and the requirement says so.

### 7.3 The one fault this change does need a home for

§2's writer-displacement fault is a genuinely new *situation*. Its constraints:

- It **SHALL be non-retryable.** It is terminal: the process has been displaced and no retry can
  succeed. Marking it retryable would be the LND shape inverted — a caller's bounded-retry loop
  would spin against a permanent condition.
- It **SHALL NOT** be routed to `TRANSACTION_FAULT`, which is frozen **retryable**
  (`src/interfaces/transaction-lease.ts:73`, `docs/ERROR-CATALOG.md:34`).
- It **SHALL** be distinguishable from every contention outcome without parsing a message string,
  which is what `retryable` exists for (`docs/ERROR-CATALOG.md:8-9`).

The code itself is D-5's to add. This change specifies the constraints and forbids the two wrong
answers.

### 7.4 `CONNECTION_ERROR` becomes unreachable, never repurposed

Embedded SQLite has no connection. The nearest failure modes (`SQLITE_CANTOPEN`, `NOTADB`,
`CORRUPT`, `READONLY`, `IOERR`) are all **non-retryable**, and `CONNECTION_ERROR` is frozen
**retryable** (`docs/ERROR-CATALOG.md:25,65`). Mapping any of them onto it is repurposing, which
`docs/STABILITY.md` forbids by name — and the commitments seat's deeper argument is the one that
decides it:

> `retryable`'s stated purpose is "so a caller decides whether to retry **without parsing a message
> string**". A field whose entire point is that the caller need not read the message **cannot have
> its meaning changed by editing the message.**

So `CONNECTION_ERROR` stays exported, stays in the catalog, and becomes a code this adapter never
throws. The drift test compares the doc's code set against the *exported* class set
(`docs/ERROR-CATALOG.md:50-58`); reachability is not in scope, so the gate stays correctly green.

**The cost the seat priced, which this change must pay:** making it unreachable deletes a pinned
required conformance id (`crash.pg-kill-save.typed-connection-error`) and with it *"the only
empirical evidence that a retryable frozen code is reachable at all under the new engine."* This
change therefore requires a **replacement reachability test** for at least one retryable code under
SQLite. Deleting the evidence and not replacing it is how a green gate stops meaning anything.

---

## 8. Isolation, re-derived from WAL

- **WAL gives a `DEFERRED` reader real snapshot isolation, free.** Measured: a reader pinned its
  snapshot and saw 2 rows while three writer commits landed, then 5 after committing
  (`reports/l2-concurrency.md` exp 09B). That is `repeatable read`, strictly stronger than
  Postgres's READ COMMITTED default.
- **Therefore the two explicit isolation overrides become no-ops.** `src/postgres/checkpoint-store.ts:392`
  (`load`) and `:458` (`history`) both pass `{ isolation: "repeatable read" }` for the same
  torn-read fix. Drop them from the call sites; `TransactionOptions.isolation`
  (`src/interfaces/transaction-lease.ts:164`) stays on the frozen surface as
  validated-then-ignored, documented.
- **`serializable` is also free and `40001` cannot occur between writers**, because writers are
  serialized by the file write lock. `faultKind:"serialization-failure"` re-points to
  `SQLITE_BUSY_SNAPSHOT` — the same *shape* of error (your snapshot is stale, retry the whole
  transaction) reached by a different route. `faultKind:"deadlock"` becomes unreachable: with one
  write lock per file there is no cycle to detect.
- **Read paths must stop taking the write lock.** This is the trap in the no-op finding. `load` and
  `history` are *reads*, and §4.1 requires every `withTransaction` to open `BEGIN IMMEDIATE`. If
  they keep routing through `withTransaction`, they take the whole-database write lock for the
  duration of a multi-megabyte checkpoint reassembly and block the sync writer — a regression
  Postgres never had. The layer therefore provides an **internal read-snapshot primitive**
  (`BEGIN DEFERRED` on a reader connection, no write lock, snapshot-stable), used by those two call
  sites. It is internal: the frozen surface gains nothing, and `withTransaction` cannot be made
  read-only because `fn` is arbitrary.
- **Readers are never blocked by writers** (exp 03E/03F, exp 13), so no `lock_timeout` analogue is
  needed on the read path at all.

---

## 9. `prune`, and a justification that is wrong as written

`src/postgres/checkpoint-store.ts:485-487` says, verbatim:

```
// No isolation override -- READ COMMITTED, Postgres's default via withTransaction, is a
// stated dependency (design.md §3): the grace-window TOCTOU argument relies on READ
// COMMITTED's per-row re-evaluation semantics.
```

**Under WAL that sentence is false**, and copy-pasting it forward would be the worst outcome of this
change. A `DEFERRED` prune evaluates its `NOT EXISTS (… ckpt_manifest_chunks …)` against a
**snapshot**, so a chunk re-referenced by a `save` that committed after the snapshot still looks
unreferenced — and gets reclaimed. That is a direct **C2a** violation
(`Formal/STORAGE_ALGEBRA.md:260`: `Deleted ∩ ⋃_{m ∈ Live} refs(m) = ∅`), i.e. a live chunk deleted,
i.e. a checkpoint that no longer loads.

**The re-derivation, which must be written rather than assumed:** under `BEGIN IMMEDIATE`, **and
while the write lock is intact (§2.6.2)**, no other writer can commit for the transaction's whole
duration, so `Live` cannot grow between step 1's `DELETE … RETURNING` and step 2's reachability
scan. C2a therefore holds **trivially**, and it holds *more* simply than under Postgres, where the
argument needed per-row re-evaluation semantics to work at all. The obligation moves from "READ
COMMITTED behaves as documented" to "this transaction is `IMMEDIATE` **and nothing in this process
opened and closed a descriptor on the database artifact set**", which is a smaller claim and, unlike
the old one, mechanically checkable in both halves.

That qualifier is not decorative. If the write lock is voided mid-prune, a competing `save` can
commit a manifest that re-references a chunk *between* the two steps, and step 2 reclaims it — the
same C2a violation the `DEFERRED` negative control demonstrates, reached by a different route and
with no error raised. The re-derivation is therefore stated with its precondition attached wherever
it appears, including in the code comment and in `Formal/STORAGE_ALGEBRA.md` §2.

Two consequences: the 15-minute grace window is **no longer load-bearing for safety** (keep it for
the backup story, which `v1.0.0-sqlite-durability-contract` owns); and `Formal/STORAGE_ALGEBRA.md`
§2's C2a status line must be re-derived rather than carried over, because a reviewer who sees
"C2a: MECHANISM SPECIFIED, P8 green" after the migration is looking at a different claim wearing the
same words.

---

## 10. Reentrancy: `SAVEPOINT` instead of a documented footgun

`src/interfaces/transaction-lease.ts:207-214` documents nesting as *"Not reentrant … under a small
connection pool this **can** deadlock."* Under a single-threaded engine "can" becomes "does": the
inner call waits for a write lock the outer call holds on the same thread and cannot release.

SQLite has no nested `BEGIN` (`SQLITE_ERROR`, "cannot start a transaction within a transaction"), but
`SAVEPOINT` covers the case fully — measured: an inner rollback leaves the outer write intact, and a
bare `SAVEPOINT` outside a transaction opens one (`reports/l2-concurrency.md` exp 08a, 08d). A
nested `withTransaction` therefore resolves to `SAVEPOINT sp<n>` / `RELEASE` / `ROLLBACK TO` and
does **not** enter §4.4's write queue.

This is an *additive* behaviour change — previously-broken code now works — which G2 permits. It
interacts with §6.2's monotone poison exactly as stated there: an inner failure poisons the outer
transaction, matching Postgres.

---

## 11. What P10 must become

The red team's finding (`council/redteam.md` §2 #7) is the one that governs the test plan:

> **P1–P10 as written would pass against a lease that is void.** My `readFileSync` attack breaks Law
> L1 with no error and no signal; L2's own proposed startup probe (two in-process connections,
> assert the second is refused) does not catch it either. So "re-execute P10" is necessary and not
> sufficient — **P10 must gain a negative control**.

The model is `docs/recovery`'s own crash harness, where *"the forbidden cursor-first ordering
violated the invariant in 4 of 9 runs, so the harness genuinely detects the failure it is looking
for."* P10 therefore gains three negative controls — the two attacks, plus the forbidden blocking
`busy_timeout` implementation — each of which must **fail** against the implementation it targets,
and the whole suite is **re-executed, not amended** (trap 9: a green gate certifies depth, never
breadth; the P1–P10 conformance suite, not the proof assistant, carries the refinement claim).

Note the interaction with the pinned manifest: `test/integration/required-tests.manifest.json`
carries 25 required ids structurally pinned by `EXPECTED_REQUIRED_COUNT = 25`
(`test/integration/check-required-tests.ts:100`), and the seat's rule is that the pinned count must
change in a **separate, reviewed commit** from any id deletion. That mechanic is D-5's; this change
must not defeat it by editing count and ids together.

---

## 12. Verification of external claims (`openspec/config.yaml` correctness rule)

Claims about installed runtimes and repository state, with the command that produced each. Claims
taken from a research artifact are labelled as such and are never presented as this change's own
measurements.

**(a) The frozen `faultKind` union already contains the members the mapping needs.**

```
$ grep -n "readonly faultKind" src/interfaces/transaction-lease.ts
76:    readonly faultKind: "connection-lost" | "serialization-failure" | "deadlock" | "timeout" | "unknown",
```

**(b) Node exposes no file-locking API, so `flock(2)` is not reachable without a native addon**
(§1.4, §3.2). Run on the same runtime the project declares (`package.json` `engines: node >=24`):

```
$ node -e 'const fs=require("node:fs"),fsp=require("node:fs/promises"),c=require("node:constants");
           console.log(process.version, JSON.stringify(Object.keys(fs).filter(k=>/lock/i.test(k))),
           JSON.stringify(Object.keys(fsp).filter(k=>/lock/i.test(k))), c.O_EXLOCK, c.O_SHLOCK)'
v24.18.0 [] [] undefined undefined
```

**(c) The timeout defaults this change re-points.**

```
$ sed -n '143,145p' src/postgres/client.ts
export const DEFAULT_STATEMENT_TIMEOUT_MS = 120_000; // 120s
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000; // 30s
export const DEFAULT_IDLE_IN_TX_TIMEOUT_MS = 120_000; // 120s
$ sed -n '100,104p' docs/durability-contract.md
| GUC | Default | Purpose |
|---|---|---|
| `statement_timeout` | 120 000 ms | bounds any single statement |
| `lock_timeout` | 30 000 ms | bounds how long a statement waits for a lock (incl. the bounded migration-lock acquire) |
| `idle_in_transaction_session_timeout` | 120 000 ms | terminates a session left idle inside an open transaction |
```

**(d) The pre-tag window.**

```
$ sed -n '46p' docs/STABILITY.md
**Current version: `0.9.5` — the commitments above are NOT yet in force.**
```

**(f) The ruled binding's error discriminator — the correction in §7.1, verified rather than
relayed.** Run against the `better-sqlite3` copy already installed at `/tmp/l3-bs3b` by the driver
lane; **no `npm install` was run**:

```
$ cd /tmp/l3-bs3b && node -e '...open WAL db, busy_timeout=0, provoke each error...'
better-sqlite3 13.0.2 sqlite 3.53.4
CONSTRAINT -> name=SqliteError code=SQLITE_CONSTRAINT_PRIMARYKEY ownProps=["stack","message","code"]
BUSY -> name=SqliteError code=SQLITE_BUSY
NESTED BEGIN -> name=SqliteError code=SQLITE_ERROR msg=cannot start a transaction within a transaction
BUSY_SNAPSHOT -> name=SqliteError code=SQLITE_BUSY_SNAPSHOT
```

Three things this establishes, each of which a requirement depends on. The discriminator is
`err.code` carrying the extended result-code **name**, with `err.name === "SqliteError"`. The
error's own-property list is exactly `["stack","message","code"]`, so **the numeric `errcode` field
the research corpus keys on does not exist on this binding** — a mapping ported unchanged from the
corpus would read `undefined` for every contention error and fall through to the catch-all. And the
nested-`BEGIN` failure that makes §4.4's write queue mandatory surfaces as `SQLITE_ERROR`, not as a
numeric `1`.

**(g) Gate R-2: `BEGIN IMMEDIATE` does not survive an in-process open+close of `-shm`.** Reproduced
independently by me before this design was changed — my own script, not the adjudicator's — with the
database on **`/root` (ext4, verified `df -T`), never `/tmp`**, against the ruled binding. Script at
`/root/r2-probe/probe.js`; `better-sqlite3` required by absolute path from the driver lane's
existing install, **no `npm install` run**. Three arms: a control, a mechanism-isolation arm that
opens the descriptor and holds it, and the attack.

```
$ wsl -e bash -lc 'df -T /root | tail -1; cd /root/r2-probe && node probe.js'
/dev/sdd       ext4 1055762868 397189544 604869852  40% /
better-sqlite3 13.0.2 | node v24.18.0
[none          ] shm_present=true competitor=refused SQLITE_BUSY    A.commit=ok rows=["A"] integrity=ok acknowledged_commit_lost=no
[shm-openkeep  ] shm_present=true competitor=refused SQLITE_BUSY    A.commit=ok rows=["A"] integrity=ok acknowledged_commit_lost=no
[shm-readclose ] shm_present=true competitor=COMMITTED              A.commit=ok rows=["A"] integrity=ok acknowledged_commit_lost=YES
```

Method: process A opens the database in WAL with `busy_timeout=0`, runs `BEGIN IMMEDIATE` and an
uncommitted `INSERT`, performs the arm's action, then a **separate OS process** B attempts
`BEGIN IMMEDIATE` + `INSERT` + `COMMIT`; A then commits; a third connection reads the final rows.
"Acknowledged commit lost" is computed, not judged: a `COMMIT` that returned ok whose row is absent
from the final read.

What each arm establishes. `[none]` is the control — the guarantee holds and B is refused, so the
harness detects the thing it is looking for. `[shm-openkeep]` opens the descriptor and does **not**
close it, and B is still refused — which isolates the fault to POSIX **close** semantics rather than
to reading the file, and is what makes the §2.6 ban's shape defensible. `[shm-readclose]` performs
one `fs.readFileSync` of `-shm`: B commits, **both** `COMMIT`s return ok, one acknowledged commit is
gone, and `integrity_check` reports `ok`. This falsifies the immunity claim an earlier revision of
§2.1 took from `council/redteam.md` §3.2 item 2, whose test read `main.db` — the file the locks are
not on.

**(h) Which file carries the write lock, per journal mode — the fact that decided §2.6.1.** Same
harness as (g), parameterised by `journal_mode` and attack target. Database on `/root` (ext4),
script at `/root/r2-probe/probe2.js`, ruled binding, no `npm install`:

```
$ wsl -e bash -lc 'cd /root/r2-probe && node probe2.js'
better-sqlite3 13.0.2 | node v24.18.0
mode=wal      attack=none competitor=refused SQLITE_BUSY  A.commit=ok                              rows=["A"] integrity=ok ack_commit_lost=no
mode=wal      attack=db   competitor=refused SQLITE_BUSY  A.commit=ok                              rows=["A"] integrity=ok ack_commit_lost=no
mode=wal      attack=shm  competitor=COMMITTED            A.commit=ok                              rows=["A"] integrity=ok ack_commit_lost=YES
mode=delete   attack=none competitor=refused SQLITE_BUSY  A.commit=ok                              rows=["A"] integrity=ok ack_commit_lost=no
mode=delete   attack=db   competitor=COMMITTED            A.commit=FAILED SQLITE_IOERR_DELETE_NOENT rows=["A"] integrity=ok ack_commit_lost=YES
mode=truncate attack=none competitor=refused SQLITE_BUSY  A.commit=ok                              rows=["A"] integrity=ok ack_commit_lost=no
mode=truncate attack=db   competitor=COMMITTED            A.commit=ok                              rows=["A"] integrity=ok ack_commit_lost=YES
```

Each mode has a control arm, and every control refuses the competitor — so the harness detects the
property it is asserting in all three. The `wal`/`db` row independently confirms the red team's
original observation (reading the database file under WAL is harmless); the `delete` and `truncate`
rows show the same read is **fatal** where the locks live on that file. One detail no corpus artifact
records: under `delete` the holder's own `COMMIT` fails with `SQLITE_IOERR_DELETE_NOENT` — the
competitor removed the rollback journal underneath it — so in that mode the holder at least gets an
error, while the competitor's acknowledged commit is still lost. Under `wal` and `truncate` both
`COMMIT`s return ok and the loss is silent on both sides.

**(i) Invariant I-4: the registration `UPDATE` is silent against a missing row.** Script at
`/root/r2-probe/probe3.js`, `/root` (ext4), ruled binding, no `npm install`:

```
$ wsl -e bash -lc 'cd /root/r2-probe && node probe3.js'
driver: better-sqlite3 13.0.2

=== unseeded table (the defect) ===
unseeded   threw=no  changes=0  readBack=undefined  myGeneration=undefined

=== after seeding (migration 007's fix) ===
seeded     threw=no  changes=1  readBack={"generation":1,"owner":"owner-seeded"}  myGeneration=1
seeded-2   threw=no  changes=1  readBack={"generation":2,"owner":"owner-seeded-2"}  myGeneration=2

=== row deleted later (the class I-4 must close) ===
deleted    threw=no  changes=0  readBack=undefined  myGeneration=undefined
```

Two facts this establishes, and the second is why the seed row is not sufficient on its own. The
`UPDATE` reports success with `changes = 0` and the read-back returns `undefined`, with nothing
thrown — so a registration that checks neither retains an undefined generation and continues. And
the **deleted** arm reproduces the defect *after* the seed exists, which is the difference between
closing the instance and closing the class.

The consequence that makes this severe rather than merely untidy follows deterministically from the
comparison the guard performs: with `myGeneration` undefined, each later guard read is also undefined,
so `generation !== myGeneration` is false and **every** write transaction passes. The guard does not
reject spuriously — it stops existing, silently, while every test that seeds its fixture stays green.
That is the shape this whole change was written to eliminate, found inside the mechanism built to
eliminate it.

**(e) Taken on an artifact's authority, not re-measured here.** Every SQLite behavioural result:
the descriptor-close and `unlink` attacks and the `main.db` survival (`council/redteam.md` §3.1,
§3.2); the blocking-`busy_timeout`-inside-the-worker deadlock and the poisoning / adapter-guard gap
(`council/contradiction.md` §3.W, §3.A, §3.A2); `locking_mode=EXCLUSIVE` locking readers out
(`§3.E`); P10's 1/8 vs 8/8, the SIGKILL crash release, savepoint nesting, `BUSY_SNAPSHOT`
behaviour and the WAL snapshot-isolation result (`reports/l2-concurrency.md` exp 05, 08, 09, 10,
13). All of the *timing* figures in those runs are subject to the sprint-wide tmpfs caveat; this
change's requirements are written against **outcomes** (`maxActive ≤ 1`, all acquirers succeed,
mutual exclusion holds), never against a millisecond figure.

A second caveat applies to that same corpus and is the reason for (f): **every one of those runs was
executed against `node:sqlite`, not against the binding that was ruled.** The *semantic* results
carry over — SQLite's locking, savepoint, snapshot and non-poisoning behaviour are engine
properties, not binding properties, and `v1.0.0-sqlite-engine-core` re-confirmed non-poisoning on
the ruled binding directly. The *representational* results do not carry over, and §7.1 is the place
that mattered. Anywhere this design cites a corpus result, it cites the behaviour and not the
driver-specific value that expressed it.
