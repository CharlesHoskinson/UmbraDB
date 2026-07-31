# Design — SQLite durability contract, error catalog and evidence

Change `v1.0.0-sqlite-durability-contract`, capability `release-contract`. This is the written half
of the PostgreSQL → SQLite migration: contracts, catalog, probe, backup/restore, corruption
detection, observability, evidence.

Per `openspec/config.yaml`'s design rule, every decision below that touches an existing one cites
it by section number: `design/design.md` §3 (content-addressed checkpoint chunker), §5 (commit /
transaction layer), §7 (driver / toolkit choice), §8 (test infrastructure), §10 (state-equivalence
gate); `design/design-interfaces.md` §1.1 (one error idiom: thrown, `code`-discriminated typed
errors), §1.2 (async pattern), §1.3 (transaction participation), §2 (`storage-errors.ts` shared
base); `Formal/STORAGE_ALGEBRA.md` §1 (TemporalKV), §2 (CheckpointStore's join-semilattice and
reachability closure), §3 (Watermarks), §4 (Transaction/Lease control algebra), §5 (the testable-law
deliverable P1–P10). Nothing here duplicates or contradicts them; where a mechanism named in one of
them ceases to exist, that is said explicitly rather than silently replaced.

---

## §0. Scope, dependencies, and one structural note

### 0.1 What this change owns

The documents (`docs/CONTRACT.md`, `docs/durability-contract.md`, `docs/ERROR-CATALOG.md`,
`docs/STABILITY.md`, `docs/recovery/EVIDENCE.md`), the startup durability probe
(`src/postgres/durability-probe.ts` → its SQLite successor), the `{code → meaning → retryable}`
catalog, backup/restore, the corruption-detection decision, and the evidence obligations that carry
the abstract-to-concrete refinement claim.

### 0.2 Dependencies on the other four changes, stated rather than specified

| Depends on | Change | What this design consumes | What it does **not** decide |
|---|---|---|---|
| Driver + shim + worker topology + pragma bootstrap order | 1 `v1.0.0-sqlite-engine-core` | **the driver ruling — a pinned `better-sqlite3`, not the `node:sqlite` built-in** (§0.4); that the library owns the handle and applies pragmas at open; that a blocking measurement gate exists | worker or no worker; `page_size`; `auto_vacuum` |
| The measurement gate | 1 | every performance-conditioned requirement here references it, **including the backup-primitive decision** (§4.3) | the numbers themselves |
| TemporalKV encoding + clock policy | 2 | that `written_at` is strictly increasing per key | whether the monotone logical clock is adopted |
| Lease, `BEGIN IMMEDIATE`, JS poll loop, contention mapping | 3 | that lock waits are implemented in JavaScript, so an abort is observable at a poll boundary | the lease mechanism; `busy_timeout`; sticky poison |
| `STRICT` DDL, named `CHECK` constraints, migration lineage | 4 | that every `CHECK` is explicitly named, so `SQLITE_CONSTRAINT_CHECK` routing by name survives | the DDL |

Three of these are *conditional* in the spec, not assumed: the surviving half of the cancellation
contract (§3.3) is written to hold only if change 3 ships a JavaScript poll loop; the corruption
digest's write cost (§2.4) is written as a measurement obligation under change 1's gate, not a
number; and the backup primitive (§4.3) is written as a **decision rule with both branches**, because
the measurement that would have settled it was taken against a driver that is no longer the one
shipping.

### 0.3 Why this spec uses `## ADDED Requirements` and not `## MODIFIED Requirements`

`openspec/specs/` contains exactly one merged capability — `temporal-kv` (`ls openspec/specs/` →
`temporal-kv` only). `release-contract` exists solely as a delta inside
`openspec/changes/v1.0.0-api-surface/specs/release-contract/spec.md` and has never been merged into
a baseline. A `## MODIFIED Requirements` header here would be a delta against nothing. The
deletions this change makes — most importantly `docs/CONTRACT.md:65-67` — are therefore expressed as
**positive, falsifiable requirements about the resulting document** ("§3 SHALL contain exactly two
timings, and SHALL NOT contain a clause promising the wait is freed"), which is strictly more
checkable than a `REMOVED` header would have been. Change 2 (`temporal-kv`) is the only change in
this sprint that legitimately writes `## MODIFIED Requirements`.

### 0.4 The driver ruling, and the three things in this change it moves

`v1.0.0-sqlite-engine-core` has ruled for a **pinned `better-sqlite3`**, not the `node:sqlite`
built-in, on the commitments seat's grounds: `docs/STABILITY.md:18` commits UmbraDB to "No breaking
changes to the exported surface or the error-`code` set in a minor or patch release," and that
promise cannot be made about a substrate whose platform reserves the right to change it in a minor
and that no lockfile, no `docs/supply-chain/inventory.md` row and no CI gate can observe.

Every research artefact in the corpus that measured driver behaviour measured `node:sqlite`.
Re-probed by this author against the already-installed copy of the ruled binding (**no `npm install`
was run**; the checkout at `/tmp/l3-bs3b` was placed there during the research phase):

```
$ wsl -e bash -lc 'cd /tmp/l3-bs3b && node -e "
    const D=require(\"better-sqlite3\"); const p=Object.getOwnPropertyNames(D.prototype);
    console.log(\"prototype:\", p.join(\",\"));
    console.log(\"has interrupt:\", p.includes(\"interrupt\"));
    console.log(\"has enableDefensive:\", p.includes(\"enableDefensive\"), \"| setAuthorizer:\", p.includes(\"setAuthorizer\"));
    const db=new D(\":memory:\");
    console.log(\"pkg version:\", require(\"better-sqlite3/package.json\").version,
                \"| sqlite_version:\", db.prepare(\"select sqlite_version() v\").get().v);
    try{ db.exec(\"create table t(a integer primary key)\");
         db.exec(\"insert into t values(1)\"); db.exec(\"insert into t values(1)\"); }
    catch(e){ console.log(\"err.name=\",e.name,\"| err.code=\",JSON.stringify(e.code),
                          \"| typeof err.errcode=\",typeof e.errcode); }"'
prototype: constructor,prepare,transaction,pragma,explain,backup,serialize,function,aggregate,table,loadExtension,exec,close,defaultSafeIntegers,unsafeMode
has interrupt: false
has enableDefensive: false | setAuthorizer: false
pkg version: 13.0.2 | sqlite_version: 3.53.4
err.name= SqliteError | err.code= "SQLITE_CONSTRAINT_PRIMARYKEY" | typeof err.errcode= undefined
```

Three consequences for this change, in descending order of how badly a naive port would fail:

1. **The error discriminator is a string, not a number** (§5.4). `err.errcode` is **`undefined`** on
   the ruled binding — so a translator keyed on the numeric extended result codes that appear
   throughout the research corpus (5, 517, 275, 1555, 1811) would not throw, would not warn, and
   would route *every* driver error to the catch-all. That is a silent-failure shape, not a compile
   error, and it is exactly the class of trap this sprint has already been bitten by twice.
2. **The backup measurement must be redone** (§4.3). The contradiction seat's `backup()`-versus-
   `VACUUM INTO` result was measured on `node:sqlite`. `better-sqlite3` exposes a different backup
   surface — a two-argument `backup(destination, options)` returning a promise with a progress
   callback, with no `AbortSignal` parameter at all — so both the blocking behaviour and the
   "accepts an `AbortSignal` and ignores it" finding must be re-established before either can enter
   a contract. Change 1 records this as blocked decisions **B-6/B-7**.
3. **The hardening primitives are absent, and the cancellation deletion is confirmed rather than
   weakened.** `enableDefensive` and `setAuthorizer` — cited in the research as hardening with no
   PostgreSQL analogue — do not exist on the ruled binding, so no requirement here may assume them.
   And `interrupt` is absent too: the prototype above contains no interrupt entry and no progress
   handler, which is the same conclusion three lanes reached for the other driver. **The §3 deletion
   holds under the ruled binding, and now on this author's own measurement rather than on a relay.**

`sqlite_version()` is **3.53.4** on the ruled binding against 3.53.1 on `node:sqlite` at Node
v24.18.0 — the opposite direction from L3's assertion that the built-in ships the newest SQLite.
That value must be recorded in `docs/supply-chain/inventory.md` and asserted in CI, so a patch bump
cannot swap the storage engine under a frozen contract.

---

## §1. The durability contract, inverted

### 1.1 What Postgres asked of a deployer, and what SQLite asks of the library

`docs/durability-contract.md:18-26` is a seven-row table of which four rows are **deployer**
obligations UmbraDB can only inspect: `fsync=on`, `full_page_writes=on`, `synchronous_commit` not
`off`, and no transaction pooler. `src/postgres/durability-probe.ts` reads three of them through
`current_setting($1)` (`:200-206`) and infers the fourth by taking a session advisory lock and
checking `pg_locks` for it (`:154-187`). The probe's own honesty about that fourth check is the
right precedent for everything below: `docs/durability-contract.md:73-77` calls it "a **best-effort**
detector, not a guarantee" and states that "the **binding requirement is that the deployer** connect
UmbraDB directly to PostgreSQL."

Under SQLite three of the four obligations become library-controlled and one disappears:

| Postgres precondition | SQLite successor | Who owns it now |
|---|---|---|
| `fsync = on` (probe-refuses) | `journal_mode` not `off`/`memory` **and** `synchronous` not `OFF` | UmbraDB, at open |
| `full_page_writes = on` (probe-refuses, overridable) | **no analogue** — the WAL carries a per-frame checksum, so a torn frame is truncated at recovery | nobody; the hazard changes shape (see §2) |
| `synchronous_commit` not `off` (probe-warns) | `synchronous` not `NORMAL` under a `FULL` policy — **warn**, never refuse | UmbraDB, at open |
| no transaction pooler (probe-refuses) | the file is not on a filesystem where SQLite's locking or WAL shared memory is unsafe | the deployer; UmbraDB detects |
| — | `foreign_keys = ON` (off by default, per-connection, non-persistent) | UmbraDB, every connection |

The `full_page_writes` row is the improvement L6 identified and it is real for the WAL. The
`foreign_keys` row is new and is not a hygiene nit: `ON DELETE CASCADE` in the checkpoint schema is
what lets garbage collection delete a manifest at all, so a connection that forgets the pragma turns
GC into a **silent no-op** — a `Formal/STORAGE_ALGEBRA.md` §2 reachability-closure matter, not a
config matter. It belongs in a conformance property, which is why it appears as P14 in §6.3.

### 1.2 The probe's new shape

The existing probe's structure is worth preserving exactly: pure classifiers
(`classifyFsync`, `classifyFullPageWrites`, `classifySynchronousCommit`,
`assertNoTransactionPooler` — `src/postgres/durability-probe.ts:72-135`) that are unit-testable with
no database, plus one live function that gathers observations and hands them to the classifiers
(`:194-234`). That separation is why the pooler branch is testable "by direct injection … no
transaction-pooler harness required in CI" (`:148-153`), and it is the single most reusable thing in
the file. The SQLite probe keeps it.

Four classifier decisions, mapped one-to-one onto today's:

1. **Hard refusal, no override** — `journal_mode ∈ {off, memory}`. This is the `fsync=off` analogue:
   a crash can leave the database arbitrarily corrupted rather than merely missing a tail, which is
   exactly the distinction `classifyFsync` draws at `:78-80`.
2. **Hard refusal, no override** — `synchronous = OFF (0)`. Same category, same reasoning.
3. **Warning, never a refusal** — `synchronous = NORMAL (1)` while the configured policy is `FULL`.
   This is the exact analogue of `classifySynchronousCommit` (`:101-118`): a bounded lost tail on
   power loss, recoverable, deliberately acceptable to an operator. The typed warning keeps its
   `kind: "lost-tail"` discriminant so `runMigrations`' `onDurabilityWarning` callback surface is
   unchanged.
4. **Hard refusal** — the database file is on a filesystem where SQLite's locking or WAL shared
   memory is unsafe (`nfs`, `cifs`/`smb`, `v9fs`, `tmpfs`, `ramfs`, un-allowlisted `fuse`). This is
   the transaction-pooler detector's true successor: both are "the environment silently breaks a
   primitive we depend on." Unlike the pooler check it is a **hard signal** (a `statfs` filesystem
   type), not a heuristic — which is a strict improvement. L6 measured the case that motivates it:
   SQLite entered WAL mode on a 9p/`drvfs` mount without complaint, where WAL's shared-memory index
   is not safe (L6 §3.4 — cited, not re-measured here).

A fifth check, the `fsync`-latency calibration, is a **warning only and must be framed as a
heuristic**. Three orders of magnitude separate a real write barrier from a no-op, so it discriminates
usefully, but a battery-backed controller is a legitimate reason for a fast `fsync`. This is the
same "detector, never a guarantee" framing `docs/durability-contract.md:73-77` already uses, and the
docs must reuse that language rather than inventing a stronger one. **No in-process probe can verify
that a filesystem is honest about `fsync`.** Saying so plainly is part of the deliverable.

The three server-side timeouts (`docs/durability-contract.md:94-115`) do not survive intact.
`lock_timeout` has a faithful analogue in `busy_timeout` (owned by change 3). `statement_timeout` has
none without a progress handler. `idle_in_transaction_session_timeout` has none at all — and that
one matters, see §7.2.

### 1.3 The `synchronous` decision rule, and why no number appears in it

`synchronous=FULL` versus `NORMAL` is the largest single lever in the migration and **its magnitude
is unknown**. Six of seven research lanes benchmarked against `/tmp`, which on the research host is
a 32 GB tmpfs RAM disk. Re-measured on ext4 the same harness moved from a published 88,485
commits/s to 379 — a 233x error — and two of the lane's conclusions inverted rather than shifted.
The corpus contains at least four mutually inconsistent ext4 figures for the same quantity (345,
379, 411, 523 commits/s, from three independent re-runs plus the one lane that used real storage).
None of them is quotable as a contract input, and this change quotes none.

L6's argument that `NORMAL` is *already contract-legal* is correct **in kind**: it maps precisely
onto the `synchronous_commit=off` lost tail that `classifySynchronousCommit`
(`src/postgres/durability-probe.ts:101-118`) warns about rather than refuses, and
`docs/durability-contract.md:47-54` explicitly calls that "a recoverable trade an operator may
accept deliberately." Legality is not sufficiency. Two things are missing before the lever can be
spent:

- **A magnitude measured under stated conditions.** Filesystem, `journal_mode`, `synchronous`,
  dataset size relative to page cache, and the unit of work (the `saveAndAdvance` co-transactional
  shape, per `design/design.md` §5 and `Formal/STORAGE_ALGEBRA.md` §4, not a bare insert). That
  measurement is change 1's blocking gate; this change references it and does not duplicate it.
- **Power-loss evidence, which nobody has.** Every crash result in the sprint is SIGKILL. SIGKILL is
  a *process* crash, and a process crash is precisely the guarantee `synchronous=NORMAL` **does**
  make. It says nothing whatsoever about the guarantee `NORMAL` declines to make. L6 states this as
  its own most important caveat and could not produce power-loss evidence on the host; neither could
  any seat.

The rule the spec fixes is therefore a conjunction, and it is falsifiable: the default is `FULL`;
lowering the default requires (a) a magnitude measured under change 1's gate conditions, (b)
power-loss evidence from a rig that actually removes power or faithfully emulates a lost volatile
write cache — a `dm-flakey` / QEMU `nvme,write-cache=off` harness or a physical power-cut rig — with
the cursor-ordering invariant of `docs/checkpoint-store-contract.md:16-18` asserted across N trials
**and a negative control that fails**, and (c) a recorded decision naming what is being traded. Any
one missing, and the default stands. Offering the SIGKILL corpus as (b) is a specification violation,
and the spec says so as a negative-control scenario.

---

## §2. The corruption regression: recorded as an improvement, actually a hole

### 2.1 The measurement, re-run by this author

L6 recorded WAL frame checksums as making the torn-page hazard "structurally absent" and filed it as
a durability improvement. That covers the write-ahead log. It does not cover the main database file,
which carries **no page checksums at all**. Re-run on the worktree host rather than taken from a
report:

```
$ wsl -e bash -lc 'cd /root/umbradb-sqlite-research && node --version && node verify-checksum.mjs'
v24.18.0
pre-corruption  read id=400 : PAYLOAD_000400_xxxxxxxxxxxxxxx
corrupted 64 bytes at offset 26624 of 53248 (page_size boundary-agnostic)
integrity_check         : [{"integrity_check":"ok"}]
quick_check             : [{"quick_check":"ok"}]
post-corruption read id=400 : PAYLOAD_000400_xxxxxxxxxxxxxxx
full scan: 500 rows read, 1 with corrupted payload
```

The script writes 500 rows, forces `wal_checkpoint(TRUNCATE)` so everything lands in the main file,
overwrites 64 bytes mid-file, reopens, and scans. SQLite reports the database healthy under both
checks and returns the corrupted row to the application **as data**. L6's own §3.10 found the same
thing with a single flipped byte and recorded it as a caveat on `integrity_check`; the red team
found it and called it a regression. The regression framing is correct.

**The framing my earlier draft used was wrong in two directions, and gate R-3 corrected both.**

*First: "SQLite detects nothing" is false and would not survive review.* The adjudicator's re-test on
the ruled binding added the control the earlier runs lacked, and the result is two-case: **payload**
corruption passes both pragmas and is returned as data (the exposure — and it is the overflow-page
case, which is exactly how UmbraDB stores blobs), while **structural** corruption *is* caught by both
checks and the read throws the corruption result code. The narrower claim is the defensible one, and
it is also the one that correctly scopes what the verification pass adds over the structural check.
All contract wording uses the two-case form.

*Second, and more consequential: UmbraDB is not losing page checksums, because it never had them.*
I verified this myself rather than repeating the relay:

```
$ cd /root/UDB-sqlite-sprint
$ grep -n 'readSetting(' src/postgres/durability-probe.ts
204:    const fsync = await readSetting("fsync");
205:    const synchronousCommit = await readSetting("synchronous_commit");
206:    const fullPageWrites = await readSetting("full_page_writes");
$ grep -rn 'data_checksums\|amcheck\|pg_checksums' docs/ src/ README.md ; echo "exit $?"
exit 1
```

The probe reads three settings and page checksums are not among them; no shipped document has ever
mentioned `data_checksums`, `amcheck` or `pg_checksums`; and PostgreSQL initialises the option **off**
by default across UmbraDB's whole supported range, which the project's own pinned bench image reports.
So the migration removes **the operator's option to enable a protection UmbraDB never required,
checked or promised** — not a guarantee the project made. That is a *weaker engineering claim and a
stronger documentation obligation*: any sentence implying UmbraDB is restoring parity would be false,
and falsely in the direction an informed reader catches immediately. My earlier draft (and the sprint
synthesis) carried that error; it is corrected at the source here.

None of this weakens the obligation. It converts "restore lost parity" into "disclose an undisclosed
gap and close it where it bites", which is what this change does.

### 2.2 The three-class frame replaces the re-derivability axis

The draft split coverage on re-derivable versus non-re-derivable. Gate R-3 replaced that axis, and it
was right to: a digest never fires on two of the three ways this store can hand back a wrong answer.

| Class | What goes wrong | What answers it |
|---|---|---|
| **A** | wrong **bytes** returned for the addressed row | a value digest |
| **B** | wrong **row**, or no row, returned — index-copy damage, a flipped canonical flag, a corrupted-high cursor | **invariants** and index redundancy; a digest is blind, because the row it verifies is intact |
| **C** | `sqlite_schema` text damage — a `CHECK`, a type, an index definition silently altered | a schema digest verified at open |

Re-derivability survives as the *obligation test inside Class A*: non-re-derivable Class-A exposure
means COVER. That is why the axis was not simply wrong — it was answering the right question about
the wrong population.

Two consequences my draft got wrong and the ruling fixed:

- **`transaction_history.entry` was omitted and must be covered.** It is the only copy of
  locally-merged lifecycle detail, produced by a first-writer-wins merge over caller-supplied
  sections — not re-derivable in any sense.
- **`watermarks.value` was treated as a re-derivable tier and must be covered.** A corrupted-high
  cursor silently skips a block range; the monotonic guard then **latches** the damage permanently;
  and the `kv_event` rows for the skipped range are lost by omission without one covered byte
  changing. That is the cursor-ahead-of-data silent-skip failure `docs/checkpoint-store-contract.md:16-18`
  names and that an entire v1.0.0 change exists to make unreachable. A one-byte flip reaching that
  state is not a re-derivable-tier problem.

And one contradiction the corruption seat caught in my own text: I had written "the TemporalKV value
tables and the wallet-state envelope store" as the covered set while excluding `ckpt_chunks` as
already covered. **`PgWalletStateEnvelopeStore` adds no table** — the envelope *is* `ckpt_chunks`
rows. As drafted the requirement mandated and forbade covering the same bytes. The spec now names
columns, and the phrase is excised.

### 2.3 What UmbraDB already covers, and the coverage set

`CheckpointStore` is content-addressed and re-verifies on load:
`src/postgres/checkpoint-store.ts:65-66` computes the SHA-256, `:366-368` throws `ChunkIntegrityError`
when a loaded chunk's hash does not match its content-address, and `:378` recomputes the manifest
hash from the chunk hashes in order. That is a real application-level checksum over the checkpoint
tier — the mechanism `Formal/STORAGE_ALGEBRA.md` §2's reachability closure is expressed over — and a
second digest there is **forbidden as redundant**. The chain-archive blob store has the same property.

Covered (`dg BLOB`): `kv_event.value`; `watermarks.value` in **both** lineages;
`transaction_history.entry`; all non-PK columns of `bridge_observations` and
`verifier_key_observations`. Uncovered, each with a stated mechanism rather than a shrug: the
content-addressed tables (rehash-on-read); `blocks` / `transactions` / `chain_blob_roles` as
projections of verified blobs, protected by invariant I-2 plus a documented rebuild path;
`kv_event.written_at` / `version` and the identifier junction (Class B cross-checks);
`ckpt_manifests.seq` and `ckpt_sequence_counters.next_seq` (closed by change 4's invariant, not
duplicated here); `_migrations` and `writer_generation` (rules I-5 and I-4).

The two observation tables resolve change 6's open question M-5: change 6's own lineage documents
them as **not cleanly re-derivable** — part of the bridge registration data is Cardano-side and the
replay reconstruction is unverified — and for verifier-key observations there is no upstream to
re-derive from at all. Their row count is bounded by bridge activity rather than chain size, so the
storage objection that rules out digesting the projection tables does not apply.

### 2.4 The digest, and why the shape matters more than the algorithm

SHA-256, unconditionally: fastest cryptographic hash on the target hardware, and the same primitive
the content-addressed tables already use, so the codebase carries one.

The load-bearing decision is not the algorithm, it is the **preimage**. It is versioned,
length-prefixed and binds table, column and primary key — and the adjudicator's re-test shows why
that is not theoretical: after a whole-row substitution, a bare hash of the value verifies **clean**
and the substitution goes undetected, while the framed preimage detects it. A digest that can be
moved between rows is not a row integrity check.

Two constraints carried from field scar tissue, both non-optional:

- **The digest covers the stored bytes, never a logical value**, and any migration that rewrites those
  bytes recomputes it in the same migration. A digest over a parsed or re-serialised value fires
  spuriously the moment an encoding changes — key ordering, whitespace, numeric formatting — and a
  checksum that cries wolf is a checksum operators turn off. This is the failure family that has bitten
  streaming and wide-column stores, and it is avoided by construction rather than by care.
- **A documented-as-dangerous salvage bypass ships on day one.** Relational engines, filesystems,
  key-value and log stores were each *forced* to add a read-past-corruption lever after the fact.
  Designing it in now — off by default, named dangerous, every bypassed row reported — is strictly
  better than adding it in a hotfix while a consumer is losing data.

  **This is not the escape hatch that was removed.** The removed hatch was an undefined
  "operating envelope" term that could narrow *mandatory coverage*. The salvage lever changes neither
  the coverage set nor whether digests are computed and compared: it only decides whether a *failing*
  read throws or returns the damaged bytes loudly. The spec forbids it from being usable as a
  verification or performance opt-out, with a negative control.

Computed adapter-side on the caller's thread, before any worker hop, and bound in the same statement
as the value. The generated-column route is rejected: a deterministic UDF in a `STORED` generated
column does work, but it becomes a permanent schema dependency under which compaction and every
third-party write fail with a missing-function error. Every covered table carries a no-UDF trigger
that aborts an update leaving `dg` unchanged — re-tested working, with no schema dependency.

### 2.4a Two of my own digest rules were overturned, both by execution rather than argument

Round-2 review reversed two rules I wrote. In both cases the adjudicator settled it by running SQL,
and in both cases my stated reasoning was the thing that failed. Both corrections amend the closed
R-3 ruling, which stands as amended.

**(a) The length constraint. My rule was wrong, and my reason for it was wrong twice over.** I
prohibited any length `CHECK` in the migration that adds `dg`, reasoning that `NULL` marks a digest
not yet computed and a length constraint would foreclose it. Measured: `ALTER TABLE … ADD COLUMN dg
BLOB CONSTRAINT … CHECK (dg IS NULL OR octet_length(dg) = 32)` is accepted on a **populated**
`STRICT` table, rejects 31 bytes naming the constraint, and accepts both 32 bytes and `NULL`. And the
form I was actually guarding against fails too: the **bare** `CHECK (octet_length(dg) = 32)` *also*
accepts `NULL`, because a constraint evaluating to NULL passes under three-valued logic rather than
failing. My rationale was therefore false for the form change 4 mandates *and* for the form I
imagined. The prohibition narrows to constraints that **reject** a NULL — no `NOT NULL`, no non-null
default — and the named null-tolerant length constraint becomes **required**. It earns its place on
this sprint's own philosophy: a truncated or garbage digest becomes unrepresentable rather than
merely detected.

**(b) "No opt-out" was true of configuration and false of one UPDATE statement.** My drift-guard
trigger fires when a covered column is updated without recomputing `dg`. It is **one-directional**:
it does not fire on an update of `dg` alone. Measured with my trigger installed verbatim,
`UPDATE t SET dg = NULL` is **accepted** — one statement, no covered-column touch, the row
permanently unverified, and the only signal a once-per-process warning at some later read. My own
requirement forbidding "any term whose value could make the coverage set conditional" was, in effect,
indicting the column it coexisted with.

Two fixes, both mandatory. First, an **anti-downgrade trigger** per covered table: abort any update
setting `dg` to NULL where it is currently non-NULL. No UDF, does not obstruct a legitimate recompute,
and cannot obstruct a backfill, which only ever writes NULL to a value. Second — the part I should
have caught when writing it — **the NULL-warn read branch is dead code in every lineage this release
ships.** I specified it for a mid-backfill world and then specified elsewhere that v1.0.0 ships with
zero backfill. A branch reachable only through the downgrade in (b) or through corruption has exactly
one function: masking both. A NULL `dg` on a covered row is `ValueIntegrityError`. Warn semantics
return only with a change that actually ships a backfill, as part of that change.

`dg` therefore stays nullable **at the schema level only** — which is what keeps a future backfill
expressible and what the null-tolerant constraint preserves — while at runtime no legitimate NULL
exists on a covered row. The backfill mechanism stays specified because a backfilled digest certifies
bytes **as found**, not as originally written, which is itself a reason coverage lands pre-tag.

### 2.5 Verification is tiered, and neither tier subsumes the other

| Tier | What | When |
|---|---|---|
| 1 | rehash-on-read of the content-addressed tables | every load — already shipped, must not be weakened |
| 2 | verify-on-read of every covered `dg` | every read of the covered column — **mandatory, always on, no opt-out** |
| 3 | `verifyIntegrity()` — structural check **and** digest sweep **and** schema digest **and** invariants, reported together, never refusing | on demand; required post-restore |

Three rulings inside this, two of which go against a seat:

1. **Verify-on-read is mandatory.** The cost seat argued default-off from a large *relative* number
   on a warm point read. Overruled on its own absolute figures — single-digit microseconds against a
   commit dominated by `fsync`, on wallet-state tables that are not bulk-scan hot paths. Relative
   percentage is the wrong unit, and a default-off verify makes the contract's central promise
   conditional on a flag, which is the removed escape hatch in another shape.
2. **`quick_check` is deleted as an alternative, everywhere.** My draft offered it as "the faster
   variant." Across every index-versus-table divergence produced in this sprint, `quick_check`
   returned `ok` while the full structural check reported the fault and an indexed lookup returned
   nothing for a row a scan still found. It is not an alternative anywhere in the spec.
3. **The digest sweep does not replace the structural check.** The sweep is Class-B blind by
   construction: it verifies the rows it is handed and cannot see an index that omits rows. The
   structural check is Class-A blind. The sweep being several times cheaper is a nice fact, not a
   substitution argument.

### 2.6 The counter-evidence, weighed rather than omitted

The contract seat surfaced this against its own recommendation, and it belongs in the record so a
future reader can see the case was actually argued rather than assumed:

- Firefox and Chromium add **zero** application checksums over SQLite, and Chromium says so
  explicitly in a source comment.
- A value digest covers only 2 of SQLite's 8 documented corruption categories.
- The one published field rate — WeChat's — is **fewer than 1 in 10,000 users**.
- RocksDB ships this exact feature and **defaults it off**, for a non-trivial read cost.
- Kafka **deleted** its per-record CRC, with reasoning that generalises to any encoding layer.

That is a serious case and it does not win here, for one reason: **the browsers bought the right to
skip detection by holding an out-of-band rebuild source.** A corrupted profile database is refetched
or regenerated. TemporalKV history has no such source — it is the only copy, and no resync
reconstructs it. The same asymmetry decides every row of the coverage table: where an out-of-band
source exists (checkpoints, the chain archive, the projection tables) this change declines to digest
and documents the rebuild instead; where it does not, it covers. The argument is the asymmetry, not
the benefit.

Two known-unknowables are recorded in the contract rather than argued away: the **coherently wrong
file** — a restore from a stale but internally self-consistent backup passes every check UmbraDB can
run — and adversarial modification, which is out of scope under the single-trusted-writer trust model
because the digests are unkeyed. And no field base rate was obtained by any seat, so no document may
make a frequency claim in either direction; one figure that circulated in council review was
unsourced and is excluded by requirement.

### 2.7 Cost is recorded, and does not gate

A digest costs CPU on the write path and bytes in the row. My draft made the coverage set contingent
on the measured cost fitting an "operating envelope" — an undefined term conditioning a mandatory
guarantee, which is the same defect as a default-off verify. **That is removed.** The measurement is
an obligation under change 1's gate that **records**; the coverage set is unconditional. The
justification is arithmetic rather than preference: the measured write cost is single-digit
microseconds against a `synchronous=FULL` commit costing three orders of magnitude more, and even an
infinitely fast hash would save a few microseconds — no plausible measurement changes the answer, so
no term may gate it.

### 2.8 The checksum VFS: declined, not deferred

SQLite ships a first-party checksum VFS. It is declined, with the reasons recorded so nobody
re-proposes it without new upstream facts. It is not compiled into the pinned driver build
(re-tested: no CKSUM compile option, and `PRAGMA checksum_verification = 1` is **silently accepted
and does nothing** — a sharp edge the contract must warn about, because an operator following
SQLite's own documentation gets no error and no protection). Its enabling path is not reachable from
the runtime. Its registration is **process-global**: it becomes the default VFS for every subsequently
opened connection in the host process, and UmbraDB is a library in someone else's process — that
reason does not expire with a future release. Its own history includes a defect in which the shim
overwrote WAL frame checksums such that uncheckpointed transactions could not be recovered, which is
the one failure a checksum must never have; an application digest's worst failure is a recoverable
false rejection of one row. And it would not discharge the obligation anyway: main-file only,
Fletcher-style, surfacing as an I/O error indistinguishable from disk failure.

Reserve-bytes pre-provisioning is also declined: it permanently freezes `page_size` and forecloses the
reserve-bytes consumer `SECURITY.md` already names as 1.1 headroom.

### 2.9 Class B: the invariants, and who owns each

No digest reaches Class B, and Class B is the larger real exposure. The instrument is a bounded
index-seek assertion at the moment of use, plus structural unrepresentability where the schema can
express it. This change **coordinates** the list and **owns** one item; it does not re-specify an
invariant another change owns, because a duplicated invariant is a divergence waiting to happen.

| # | Invariant | Owner |
|---|---|---|
| I-1 | `next_seq > max(seq)` per `(wallet, network)` asserted inside every checkpoint save and load, plus a `UNIQUE (wallet, network, seq)` constraint as defence-in-depth | **change 4** — already closed; recorded here only so the coverage table is complete |
| I-2 | at most one canonical block per `(network, height)`, as a partial unique index on every partition child | **change 6** — already in its DDL; elevated by gate R-3 from schema detail to a normative requirement with its own scenario |
| I-3 | `getAt` asserts via the **primary-key auto-index** — a different b-tree from the time index — that the returned version satisfies the `at` bound and that the next version does not | **change 2** |
| I-4 | writer registration asserts a single affected row and a defined read-back; failure is a startup error, not an undefined generation | **change 3** |
| I-5 | migration-lineage law: every migration's first statement is non-idempotent DDL and each migration runs in one transaction, so replay caused by `_migrations` damage is guaranteed loud | **change 4** |
| **I-6** | **anti-latch**: when a monotonic watermark guard suppresses a write as a regression, verify the **incumbent** row's digest in the same transaction and raise `ValueIntegrityError` on failure instead of silently no-opping | **change 5 (this change)**, for the watermarks primitive contract; **change 6** applies it to the archive-side guard |
| I-7 | transaction-history read-path cross-checks: the entry's own lifecycle status agrees with the `lifecycle` column; identifier junction rows derive-and-compare against the entry's identifiers | **change 4** |
| I-8 | archive cursor sanity: the archive watermark's height does not exceed the maximum recorded block height plus one | **change 6** |

I-6 is this change's because it is a property of the watermarks *contract*, not of any one adapter,
and because it is the direct answer to the finding that makes `watermarks.value` a covered column at
all: the monotonic guard does not merely fail to notice a corrupted-high cursor, it **latches** it —
every subsequent correct write is discarded as a regression, permanently. Verifying the incumbent
digest at exactly the moment the guard would suppress a write converts the latch into a detection
point, and it costs one digest comparison on a path that was already reading the row.

I-3 is the one I hand to change 2 with the most care attached, because it is the invariant that
catches the case a digest provably cannot: a damaged index copy leaves the table row intact, so the
row digest verifies clean while the read returns the wrong version or no row. Two seeks on a
deliberately different access path is the whole mechanism.

### 2.10 Recovery: detection is not worse than nothing; whole-database refusal is

The failure shape to avoid is documented in the field: one bad record denying an entire wallet, with
the salvage tool since deleted. The shape to copy is the scoped one — open, repair what can be
repaired, tell the operator exactly what is damaged.

- **Value-digest failures are row-scoped and read-time.** Thrown by the read that addressed the
  damaged row and by nothing else. Open, migrations, lease acquisition and every undamaged key keep
  working. One corrupted history entry leaves a working wallet — strictly better than today, where it
  leaves a working wallet *acting on a wrong value*.
- **The schema digest is the one deliberate exception, and it is open-scoped.** Schema-text damage is
  not row damage: it silently weakens the rules governing every future write, so continuing to write
  is continuing to corrupt. It is bounded — one small region, one query — and never depends on
  scanning data, so it does not reintroduce the whole-database-refusal hazard.
- **`verifyIntegrity()` reports and never refuses**, and is never wired into startup.
- **Errors name the row.** An unnamed corruption error forces a full restore for a single-row fault.

Four consumer paths go in a new `docs/recovery/CORRUPTION.md`, linked from the contract and the
README: scope the damage with the verification pass; re-derive where the tier allows (checkpoints,
the archive, the projection tables — *not* `kv_event` history, `transaction_history.entry` or the
observation tables, which is exactly why those carry digests); restore from backup with the
verification pass as the post-restore check; or accept a bounded, known loss per key. The honest
value proposition is written in those terms: **UmbraDB does not promise to repair corruption; it
promises corruption is never silent, so the response can be proportionate instead of total.** The
digest is also what makes "is my backup good?" answerable at all — the first benefit a consumer feels,
independent of any live corruption.

What the document must not do: present the SQLite command-line recovery tool, a checksumming
filesystem or error-correcting memory as *the* answer. Filesystem-level integrity is defence-in-depth
advice, never discharge of the obligation, because a library cannot verify its deployer adopted it.

---

## §3. Cancellation: delete the clause, keep what a mechanism delivers

### 3.1 Why the middle timing cannot be reworded

`docs/CONTRACT.md:65-67` promises that during a long read "the in-flight cursor / lock wait is
**freed**: the driver's `query.cancel()` fires and the wait unwinds." `src/postgres/abort.ts:30-36`
records exactly what that rests on and is unusually candid about it: "there is no general way to
cancel an in-flight Postgres query from here without dedicated per-call cancellation machinery.
`listKeys` and lease acquisition build their OWN dedicated cancellation on top of real
`query.cancel()`." `query.cancel()` opens a **second connection** and issues a protocol
`CancelRequest`. An embedded engine has no second connection, no protocol, and no server to send it
to.

Three lanes concurred independently, and the commitments seat ruled on the text: the driver exposes
no `sqlite3_interrupt` and no progress handler, and because the API is synchronous the event loop is
blocked for the whole call — an `AbortSignal` scheduled to fire mid-query provably cannot fire until
the query has already returned.

Those lanes measured `node:sqlite`. **The conclusion holds for the ruled binding on this author's own
measurement** (§0.4): `Object.getOwnPropertyNames(Database.prototype)` on `better-sqlite3@13.0.2`
enumerates `constructor, prepare, transaction, pragma, explain, backup, serialize, function,
aggregate, table, loadExtension, exec, close, defaultSafeIntegers, unsafeMode` — no interrupt entry
and no progress handler. The deletion therefore does not rest on a relay about a driver that is not
shipping, which matters because the driver ruling inverted two other relays in this change (§0.4).
Rewording "freed" into "may be freed" or "is best-effort" would preserve a sentence that names a
mechanism that does not exist under either candidate. **Delete it.**

### 3.2 What the worker does and does not restore

The feasibility seat measured a worker-thread RPC at transaction granularity and concluded the 32x
per-operation figure was a granularity artefact of a fixed round trip. The red team then showed the
round trip is **not fixed** — it grows with payload (114.7 µs at one statement per message, 503.6 µs
at a hundred) — and, decisively, that amortisation is **structurally unreachable for
`withTransaction(fn)`**. `withTransaction` is a frozen G1 export whose body is arbitrary caller code
on the main thread; `src/interfaces/transaction-lease.ts` says so itself ("`fn` is arbitrary caller
code with no mechanism for this layer to interrupt it partway through"). A JS closure cannot be
shipped to a worker as a program. A three-statement caller callback measured 538.7 µs of pure
transport across five round trips.

So the honest position is: **partial cancellation may be promisable; full cancellation is not.** The
worker's real justification is event-loop liveness (a large `.all()` blocks the loop for hundreds of
milliseconds and a wallet's websocket heartbeat dies), which is a different problem, and it is
change 1's to decide.

### 3.3 What survives, precisely

Four statements, each with its own truth condition:

1. **Pre-dispatch abort survives verbatim.** An already-aborted signal issues no query. This is
   `withAbort`'s first line (`src/postgres/abort.ts:38-40`), is engine-independent, and needs no
   change.
2. **Mid-quick-write survives, trivially and now unconditionally.** "The write may still complete"
   becomes "the write may always still complete."
3. **A wait UmbraDB implements *in JavaScript* observes an abort at its next poll boundary.** Change 3
   replaces a blocking `busy_timeout` with a JS poll loop; a poll loop returns to the event loop, so
   the abort lands, bounded by the poll interval rather than freed instantly. This is a genuine
   survivor and it is the only mid-wait guarantee that can be made. It is written **conditionally**:
   the sentence ships only if change 3 ships the poll loop, and the contract must name the bound
   (the poll interval), not promise immediacy.
4. **Everything else is uncancellable and must be named**: any scan inside a single SQLite call; the
   body of `withTransaction(fn)`; the backup call; and `VACUUM INTO`, which cannot be aborted at all.

On the backup call specifically, the corpus fact is **driver-specific and no longer applies as
written**. `node:sqlite`'s `backup()` accepts an `AbortSignal` and ignores it — the contradiction
seat measured a signal aborted at 5 ms still producing a completed 169,678-page copy. The ruled
binding's `backup` takes `(destination, options)` and has **no `AbortSignal` parameter at all**
(§0.4), so the honest statement is not "it ignores the signal" but "there is no cancellation
affordance to offer." Which sentence §6 ships depends on the re-measurement in §4.3, and the spec
requires §6 to state the *actual* cancellation behaviour of the shipped call rather than carrying the
other driver's finding forward.

The backup clause is a **stated exception to §3 written into §6**, so a reader of the backup
section is not left to discover it. `TransactionLeaseLayer.releaseLease(lease)` remains
signal-less for the reason `docs/CONTRACT.md:57-60` already gives — release is the always-run cleanup
half of a lease — and that reasoning is engine-independent.

---

## §4. Backup and restore: the seats disagreed, and the deciding measurement used the wrong driver

### 4.1 The disagreement

- **L5** measured `VACUUM INTO` freezing the JS thread — 0 event-loop ticks over 2.26 s, extrapolated
  to roughly 11 minutes frozen at 400 GB — and recommended `backup()`.
- **L6** measured `backup()` restarting under writer interference, called `VACUUM INTO` "the right
  primitive," and wrote it into its rewritten CONTRACT §6 as *the* command. L6 owns the contract
  text, so its answer was on track to ship.
- **The contradiction seat** re-ran both on a 691 MB ext4 database with a writer racing the copy and
  ruled that L6 has it backwards, noting that L6's "restarts" claim was **a citation dressed as a
  finding** — L6's own evidence block shows a `backup()` completing with no restart observed.

### 4.2 The measurement that settled it, and why it no longer settles it

Contradiction seat §3.I, quoted as the seat recorded it (measured by that seat, not re-run here,
**and measured against `node:sqlite`**):

```
source: 691.4 MB, rows=150000
VACUUM INTO : 2045 ms, event-loop ticks during = 0
backup()    : 2584 ms, ticks during = 1539, pages=169677, concurrent commits landed = 781
vac.db  rows=150000 integrity=ok
api.db  rows=150780 integrity=ok        (source at start = 150000)
backup(signal aborted at 5ms) -> COMPLETED anyway: 169678
```

On `node:sqlite`, `backup()` did not restart, did not fail and did not degrade: it produced an
integrity-clean copy of a *later* committed state while 781 transactions committed underneath it, and
it kept the event loop alive (1,539 ticks against `VACUUM INTO`'s zero). L6's contrary "restarts"
claim was a citation dressed as a finding, and L5 measured the same direction as the seat.

**None of that transfers automatically.** `v1.0.0-sqlite-engine-core` has ruled for a pinned
`better-sqlite3` (§0.4), whose backup surface is a different function with a different signature and
different threading behaviour, and it flags this as blocked decisions **B-6/B-7**. Two of the three
lines of support are therefore about a driver that is not shipping, and the third — L7's survey
finding Bitcoin Core using the online backup API (`sqlite3_backup_init` + `sqlite3_backup_step(-1)`)
while no surveyed project uses `VACUUM INTO` for live backup — is an argument about the *C API*, not
about either JavaScript binding's wrapper.

Picking a primitive anyway and asserting it would repeat, at the level of a written contract,
precisely the error that cost this sprint most of its numbers: carrying a measurement into a
conclusion whose conditions had changed underneath it.

### 4.3 The ruling: a decision rule, not a primitive

**§6 SHALL NOT name a live-backup primitive until the comparison has been re-measured on the ruled
binding.** The rule, and both branches, are fixed now so the measurement decides rather than the
author.

*Measurement conditions, all of which must be recorded with the result* (the same discipline change 1
imposes on the `synchronous` gate, and change 2 on the logical clock): the binding and its exact
package version; the `sqlite_version()` reported at runtime; the filesystem holding the source
database, which must be one the durability probe would accept — never `tmpfs`; `journal_mode` and the
`synchronous` level in force; the dataset size, stated relative to the host's page cache; a
concurrent-writer load with its commit count recorded; and, for each candidate, the wall-clock
duration, the event-loop tick count during the copy, the destination's structural check result, and
the destination's row or page count against the source's committed state at the call.

*Branch A — the online backup call keeps the event loop turning and produces a structurally clean
copy under concurrent commits.* Then it is the documented live-backup mechanism, `VACUUM INTO` is
documented as compaction only, and §6 ships sentences 2–6 below.

*Branch B — the ruled binding's backup blocks the thread, restarts under writer interference, or
produces a copy that fails verification under concurrent commits.* Then **UmbraDB documents that it
has no live-backup mechanism**, and §6 states the offline procedure plainly — quiesce writers, then
copy or compact — rather than presenting a primitive that does not deliver. This branch is not a
fallback to be embarrassed about: it is what Zallet's published procedure amounts to, and a contract
that says "stop the writer first" is worth more than one that promises an online backup the engine
cannot honour.

Under **either** branch, §6 gains these sentences, each traceable and none dependent on which
primitive wins:

1. **The shipped backup call's actual cancellation behaviour, stated.** On `node:sqlite` that was
   "accepts an `AbortSignal` and ignores it"; the ruled binding's `backup` has no signal parameter at
   all, so the true sentence is that no cancellation affordance exists. Whichever holds, §6 states it
   as a named exception to §3 (§3.3 item 4) rather than carrying the other driver's finding forward.
2. **The backup captures a state at or after the call**, not a snapshot taken at the call. So §6's
   current "a mid-GC dump is safe to restore" (`docs/CONTRACT.md:127-130`) cannot be re-justified by
   snapshot isolation — it must be re-justified as *any committed state is closed under
   manifest → chunk*, which is `Formal/STORAGE_ALGEBRA.md` §2's reachability closure. Today that
   closure is a documented property of `pg_dump`'s single snapshot; tomorrow it is a property of
   **UmbraDB's own code**, so it must be **tested**, not asserted. That is property P13 (§6.3).
3. **Never copy `umbradb.db` alone.** The `-wal` sidecar holds every commit since the last
   checkpoint. L6 measured that restoring the main file without it silently reverted the database to
   before the `CREATE TABLE` — the table was simply gone, with `integrity_check` reporting `ok`.
   Postgres has no comparable single-file footgun and the contract must carry this in bold.
4. **A long-running copy blocks WAL checkpointing for its whole duration**, and
   `wal_checkpoint(PASSIVE)` returns `busy: 0` while checkpointing nothing — it reports success while
   doing nothing, which is a silent failure mode for anyone monitoring it (L6 §3.9, cited).
5. **There is no PITR.** Point-in-time recovery becomes a deployer capability (an atomic
   filesystem/volume snapshot of `.db` + `-wal` + `-shm`) that UmbraDB cannot provide. Say it
   plainly rather than leaving it implied.
6. **`PRAGMA integrity_check` is the documented post-restore step, with its limit stated in the same
   paragraph** — it verifies b-tree structure, not cell content (§2.1). Presenting it without the
   limit would be worse than omitting it.

### 4.4 The precedent, cited honestly

L7's survey supplies the outside confirmation that no SQLite project has a live-backup story
matching `pg_dump`: Core Lightning warns that `.dump` and `VACUUM INTO` "lock the main database for
long time periods, which will negatively affect your lightningd instance" and **retracted** its
Litestream recommendation after it crashed `lightningd`; LND's SQL `Copy` is
`errors.New("not implemented")`; Zallet's backup procedure begins "Stop Zallet."

These are **L7 citations to external repositories, verified by no seat and not re-verified here** —
there is no network path from this worktree to those sources and `openspec/config.yaml`'s
correctness rule forbids asserting an external claim from memory. The spec therefore requires that
each such citation be re-verified against a pinned upstream commit or a version-pinned document URL
**before the contract text ships**, and that any citation that cannot be re-verified be struck rather
than softened. That is a requirement, not a caveat.

**This precedent is the one thing in §4 the driver ruling does not move.** It is a claim about what
SQLite-backed projects do operationally, not about a JavaScript binding's wrapper, so it survives
branch A and branch B alike — and under branch B it stops being background and becomes the
justification for the contract text.

### 4.5 A second, mechanism-level argument that does not depend on the timing measurement

`v1.0.0-sqlite-concurrency-lease` closed its own blocking gate by reproducing the shared-memory
descriptor defect: a single **in-process open-then-close** of the `-shm` sidecar voids the write lock
held under `BEGIN IMMEDIATE`, after which a second operating-system process commits inside the
holder's transaction. **Both commits return success, one acknowledged commit is silently lost, and
the structural check still reports `ok`.**

The consequence for §6 is direct and uncomfortable: **an offline procedure that tells a consumer to
copy the three-file set with in-process filesystem calls is that attack, performed by UmbraDB's own
documentation.** Any file-copy procedure must therefore be specified as **out-of-process**, or taken
**after a quiesce with no writer transaction open**, and must say which. Change 3 also ships a
build-failing source guard banning in-process `-wal`/`-shm` descriptor opens including via
path-building helpers, so an in-process procedure would fail the build as well as the contract — better
discovered here than in CI.

This gives branch A a second argument that is **independent of the timing re-measurement**: the
online backup call opens no filesystem descriptor on the sidecars, so it is structurally incapable of
triggering the defect, where a hand-rolled copy is not. The re-measurement therefore records the
sidecar-descriptor property per candidate alongside its timing.

One residue from change 3 lands in the contract rather than in code: **the source guard binds
UmbraDB, not the embedding application.** `docs/CONTRACT.md` §5 carries the descriptor precondition as
binding on the *embedder*, with its consequence written concretely — two writers both commit, an
acknowledged commit is silently lost, the structural check reports `ok` — on the reasoning that a
vaguely stated precondition is one nobody prioritises. §6's copy procedure and §5's precondition must
name the same mechanism in the same vocabulary, so a consumer who reads one and not the other still
ends up safe.

---

## §5. The error catalog

### 5.1 The count, verified rather than inherited

The research brief asserted 25 codes. The commitments seat counted 24. Both numbers exist in the
repository and they are **different objects**. Derived by this author:

```
$ cd /root/UDB-sqlite-sprint
$ awk '/^\| Code \| Class \| Meaning \| Retryable \|/{f=1;next} f&&/^\|---/{next} f&&!/^\|/{f=0} f' docs/ERROR-CATALOG.md | wc -l
24
$ grep -rhoE 'readonly code = "[A-Z_]+"' src/ | sort -u | grep -vE 'CHAIN|BLOB|BLOCK' | wc -l
24
$ grep -n 'EXPECTED_REQUIRED_COUNT =' test/integration/check-required-tests.ts
100:export const EXPECTED_REQUIRED_COUNT = 25;
```

**The catalog is 24 codes.** `EXPECTED_REQUIRED_COUNT = 25` is the pinned length of the *required
conformance-test id* list in `test/integration/required-tests.manifest.json`, not a code count. The
seat is right and the brief conflated two pins. The catalog's own text already says the count is
derived, never asserted: `docs/ERROR-CATALOG.md:48-58` and the drift test's header comment
(`test/api-surface/error-catalog-drift.test.ts:19-31`) both make the drift test the authority. That
discipline is preserved; this change adds rows and lets the count self-correct.

### 5.2 Four rulings from the commitments seat, honored

**(a) An unreachable code is not a breaking change.** The policy names four forbidden verbs
(`docs/STABILITY.md:18-25`: removed, changed incompatibly, renamed, repurposed;
`docs/ERROR-CATALOG.md:13` adds: `retryable` weakened). A code whose class stays exported, stays
narrowable, and simply never fires is none of them, and the drift test compares the doc's set against
the *exported* set, so it stays correctly green.

**(b) `CONNECTION_ERROR`'s repurposing *is* a breaking change, and the reason is not the verb.**
Its current meaning (`docs/ERROR-CATALOG.md:25`) is a driver-level connection failure — a network
code, a class-08 SQLSTATE, or a `28xxx` auth failure — and it is marked **retryable**. Re-pointing it
at `SQLITE_CANTOPEN` / `SQLITE_READONLY` / `SQLITE_NOTADB` keeps the marking while inverting the
behaviour the marking predicts: those conditions almost never clear on retry. `retryable` exists
precisely "so a caller decides whether to retry **without parsing a message string**"
(`docs/ERROR-CATALOG.md:8-9`; `src/interfaces/storage-errors.ts:19-38`). **A field whose entire point
is that the caller need not read the message cannot have its meaning changed by editing the
message.** The catalog already documents this exact pathology for persistent `28xxx` auth failures
(`:108-120`) and already resolves it the same way — *a new additive code*, not a repurposing. The
precedent is in the document.

Ruling: `CONNECTION_ERROR` stays in the catalog, marked **documented-unreachable**. Add, all
additive and all free pre-tag:

| Code | Class | Retryable | Why |
|---|---|---|---|
| `DATABASE_UNAVAILABLE` | `DatabaseUnavailableError` | non-retryable | `SQLITE_CANTOPEN` / `SQLITE_READONLY` / `SQLITE_NOTADB` — the situations that would otherwise have lied about retryability |
| `DISK_FULL` | `DiskFullError` | **conditional** | `SQLITE_FULL` genuinely clears if the operator frees space; `conditional` is the honest marking |
| `DATABASE_CORRUPT` | `DatabaseCorruptError` | non-retryable | `SQLITE_CORRUPT`, or a failing `integrity_check`. `CORRUPT` is already taken by the envelope decoder (`docs/ERROR-CATALOG.md:40`) — do not reuse it |
| `VALUE_INTEGRITY` | `ValueIntegrityError` | non-retryable | §2.3's stored-digest mismatch. Deliberately distinct from `CHUNK_INTEGRITY`, so a consumer can tell "the engine says the file is broken" from "a row's payload no longer matches its recorded digest" |

`TRANSACTION_POOLER_DETECTED` is **retained and documented unreachable** — keeping it costs nothing
and removing it costs a major. `DURABILITY_CONTRACT_VIOLATION` survives with its trigger conditions
restated (§1.2).

**(c) `CLOCK_REGRESSION` cannot silently narrow.** It is marked `conditional`
(`docs/ERROR-CATALOG.md:42`) *because* one of its two causes — the same-millisecond precision
collision — is genuinely caller-fixable (`:73-89`), a distinction the document records as having
been added by a fourth-round cross-vendor re-audit that found the prior blanket "non-retryable"
wording wrong. If change 2 adopts a monotone logical clock, that cause disappears and the marking
would narrow to `non-retryable` — **a forbidden weakening under `docs/ERROR-CATALOG.md:13`**. No lane
caught this.

This change does not decide the clock. It imposes an invariant on whichever way change 2 rules: the
`conditional` marking is preserved, either because the same-millisecond cause survives (the red team
ruled against adopting the logical clock at all, having measured the collision rate at 0.0% at
`synchronous=FULL`) or because a **second live cause** is introduced — a bounded-drift check that
raises `ClockRegressionError` when the store coordinate leads wall time by more than a configured
threshold, which is caller-fixable by waiting. Falsifiable either way: the catalog row must read
`conditional` and the rationale section must name two live causes.

**(d) The catalog freezes `{code → meaning → retryable}` and never freezes `{situation → code}`.**
That is what a consumer actually depends on — "when the database becomes unreachable I catch
`CONNECTION_ERROR`" — and no gate can see it: routing a situation to a new code satisfies every
letter of the policy, passes the drift test, produces no compile error, and breaks the consumer at
runtime. Today it is *silently unpromised*, which is the worst of the three available states.

Ruling: **bind it.** `docs/STABILITY.md` gains one sentence stating that for each catalog row, the
situation its Meaning cell describes raises that row's code, except where the row is explicitly
marked documented-unreachable. That makes this change's own `CONNECTION_ERROR` handling legal and
visible instead of quiet. A second sentence records that "additive-only" does **not** automatically
extend to widening the exported string-literal union types (`SharedStorageErrorCode`,
`TemporalKVErrorCode`, `CheckpointStoreErrorCode`, `TransactionLeaseErrorCode`,
`WalletStateEnvelopeErrorCode`, and `faultKind` at `src/interfaces/transaction-lease.ts:76`), because
widening a union in an output position breaks a consumer's exhaustive `switch`.

### 5.3 The one code that must not be added

`SQLITE_BUSY` already has three homes in the frozen surface — `LEASE_TIMEOUT` at the lease acquire,
`MIGRATION_LOCK_TIMEOUT` at the migration-lock acquire, and `TRANSACTION_FAULT` with
`faultKind: "timeout"` or `"serialization-failure"`, both **already members** of the frozen union at
`src/interfaces/transaction-lease.ts:76`. Adding a `BUSY` / `WRITE_CONTENDED` code would promote a
transient into the caller's decision surface, which is exactly the shape that produced LND's P0
fund-loss bug (#7869), whose maintainer diagnosis was a *missing retry layer*, not a missing code.
The catalog governance requirement records the prohibition; change 3 owns the retry layer itself.

`UNRECOGNIZED_POSTGRES_ERROR` is renamed to `UNRECOGNIZED_DATABASE_ERROR` (and the class
`UnrecognizedPostgresError` → `UnrecognizedDatabaseError`) **pre-tag**. This is the clearest case in
the ledger where the pre-tag window buys something unobtainable later at any price, and it costs one
commit. The six `Pg*` adapter class names are the same problem in a non-machine-facing position;
keeping them is defensible, but it must be a recorded decision rather than an oversight, and this
change requires the decision to be written down.

### 5.4 The discriminator is a string, and the naive port fails silently

Every error-translation sketch in the research corpus keys on `err.errcode` carrying the **numeric**
extended result code — `switch (err.errcode) { case 1811: … case 275: … case 5: … case 517: … }` —
because that is what `node:sqlite` exposes. **On the ruled binding `err.errcode` is `undefined`**
(§0.4, measured). The discriminator is `err.code`, a string carrying the extended result code's
*name*, with `err.name === "SqliteError"`:

```
err.name= SqliteError | err.code= "SQLITE_CONSTRAINT_PRIMARYKEY" | typeof err.errcode= undefined
```

Two consequences, and the first is the dangerous one.

**(a) A numeric-keyed translator does not fail loudly — it routes everything to the catch-all.**
`switch (undefined)` matches no numeric case and falls to `default`. There is no throw, no warning
and no type error, because the driver error is `unknown` at the boundary. The observable symptom is
that every database failure in the product surfaces as the unrecognised-error code and *nothing else
in the catalog is ever reachable* — `LEASE_TIMEOUT`, `TRANSACTION_FAULT`, `CLOCK_REGRESSION`,
`TRANSACTION_KEY_REUSE` all go dark at once while the drift test stays green, because the drift test
compares the doc's set against the *exported class* set and reachability is not in its scope
(`docs/ERROR-CATALOG.md:48-58`). This is a silent-failure shape, and the spec carries it as a
negative-control scenario so a reviewer can name the observation that detects it: a conformance test
asserting a *specific* frozen code is raised by a *specific* provoked fault.

**(b) `.code` now collides with `StorageError.code`, and the passthrough must not key on it.**
`src/interfaces/storage-errors.ts:25-38` gives every `StorageError` an `abstract readonly code:
string`. Today's translator opens with a `StorageError` passthrough so an already-typed error is not
re-wrapped, and today that is unambiguous because the `postgres.js` error carries a SQLSTATE in a
different field. Under the ruled binding **both** a driver error and a `StorageError` carry a string
`.code`, so a passthrough written as "if it has a string `.code`, pass it through" would pass raw
driver errors straight to the caller — defeating the whole "no raw driver error escapes" property
that `UNRECOGNIZED_POSTGRES_ERROR` exists to guarantee. The classifier must key on
`err instanceof StorageError` for the passthrough and on `err.name === "SqliteError"` for the driver
branch, never on the presence of `.code`. This hazard did not exist for the driver the research
measured, and it is created by the ruling.

The routing *by constraint name* for check violations is unaffected in kind: the message still reads
`CHECK constraint failed: <name-or-expression>` and still degrades to the expression text when the
constraint is unnamed, which is why change 4 must name every `CHECK` explicitly.

### 5.5 Routing the faults other changes raise, and where the catalog's boundary sits

I own the catalog, so a sibling change that specifies a fault without naming its code has left a
decision unowned rather than delegated. Two exist in change 4, both saying in terms that the code
"belongs to `v1.0.0-sqlite-durability-contract`'s catalog and is not chosen here":

- the **checkpoint-sequence assertion** (invariant I-1) failing at `save()` when the claimed sequence
  is not strictly greater than the existing maximum;
- the **transaction-history cross-check** (invariant I-7) failing on read when the lifecycle column
  disagrees with the entry document, or the junction rows disagree with the entry's identifiers.

**Neither mints a new code**, which honours change 4's own instruction to check the existing catalog
first. The rule I adopt is **scope**, because scope is the question a consumer actually asks — is
this one addressable thing I can reason about, or is the file itself suspect?

- **Addressable scope** (a named table and primary key, or a named store partition) →
  `VALUE_INTEGRITY`. Triggers: a digest mismatch, a NULL digest on a covered row, and every row-scoped
  invariant violation, which is both change-4 faults plus I-3, I-6, I-7 and I-8.
- **Whole database file** → `DATABASE_CORRUPT`. Triggers: the driver's corruption result code, a
  failing structural check, and a schema-digest mismatch.

This is consistent with the R-3 ruling, which already assigned `ValueIntegrityError` to I-3, I-6, I-7
and I-8; routing I-1 anywhere else would split one class across two codes for no benefit visible to a
gain. It also keeps the recovery posture coherent: `VALUE_INTEGRITY` is the row-scoped, read-time,
proportionate-response code, and `DATABASE_CORRUPT` is the one that legitimately implicates the file.

One consequence I have to accept and pay for: a single code now has several triggers. If a consumer
had to read a message to tell a digest mismatch from an invariant violation, I would be committing
the exact sin I prohibit when I forbid repurposing a code by editing its meaning. So
`ValueIntegrityError` carries a machine-readable discriminator naming the failed check, alongside the
table and primary key it already carries.

**The catalog's boundary.** Change 7 deferred migration-refusal catalog membership to me; I had not
ruled it, and its two supporting citations into this change resolve to unrelated passages after the
R-3 rewrite moved my line numbers — so the question was owned by nobody, which is the finding. The
ruling: `docs/ERROR-CATALOG.md` covers errors thrown **through the library's frozen public surface**.
A failure raised by a process that is not the library — the migration tool, the archive sync CLI, the
snapshot tool — is a tool diagnostic under the one error idiom, adds no catalog row, is not a
`StorageError`, and is not re-pointed at an existing code. That is a *membership* ruling only: exit
codes, report schemas and operator presentation belong to the changes owning those tools, and they
now specify them **against** this rule instead of deferring back to it.

**And the migration digest is two artifacts, not one.** Change 7's "bytes as stored, through one
canonicalisation" is not a hedge, it is incoherent — it names a preimage that is neither the stored
bytes nor a canonical form, and no implementation satisfies both readings. The `dg` I specify is over
the **exact bytes SQLite stores**, no canonicalisation, persisted, verified on every read. A
source-to-target fidelity comparison during import is a different operation entirely: a
**non-persisted transport check** over canonically parsed values, necessarily not byte-identical
because two engines do not encode identically. Named distinctly, it does not violate the
one-mechanism-per-tier rule, because it is a comparison performed once during import rather than a
stored mechanism verified on read.

**A note on citation form, since this is how the decision got lost.** Change 7's pointers into this
change were line numbers, and my R-3 rewrite moved every one of them. Cross-change references into
this change should address **requirement titles**, which do not rot when a sibling section grows.

---

## §6. Evidence: re-execute, never amend

### 6.1 `docs/recovery/EVIDENCE.md`

Its own binding rule 1 (`:10-11`) forbids amendment: "The run MUST be against the **RC commit** — the
exact SHA that will be tagged. An earlier green run against a different commit does **not** satisfy
R5 and MUST NOT be copied in." Its Run-identity table records `Postgres | Testcontainers
postgres:17-alpine` (`:28`) and M5-3 reads "a **fresh object graph** is constructed **from
Postgres**" (`:61`). These are engine-named rows, not incidental prose.

**And the cost is a sunk cost of the tag, not a cost of this migration.** `ROADMAP.md:389-398` sets
the remaining path to 1.0.0, and step 4 is "Then, and only then, `1.0.0` — re-running the tag gate
(R1–R12) against the new RC." R5 (`docs/v1-implementation-guideline.md:862`) is the manual Preprod
round-trip against the RC. A new RC and a fresh R5 run were already mandatory before this sprint
existed. This is a material correction to L6, which billed EVIDENCE.md under "what the migration
breaks." Both facts go in the spec: re-execute, and do not charge it to the migration.

**A defect that exists today, before any migration.** Binding rule 2 (`:12-13`): "Values are
**captured output**, never retyped from memory or expectation. If a field could not be captured,
write `NOT CAPTURED` — do not infer it." The entire **Cold-boot round-trip table at `:44-53` is
blank** — six fields, none filled, none marked `NOT CAPTURED`. A blank cell is neither. The
re-execution fills them or marks them, and a doc lint makes a blank cell in a binding-rule-2 table a
gate failure so it cannot recur.

### 6.2 The conformance manifest is the interlock, and it must be used as designed

`test/integration/required-tests.manifest.json` carries 25 required ids, structurally pinned by
`EXPECTED_REQUIRED_COUNT = 25` (`test/integration/check-required-tests.ts:100`) so that silently
deleting or adding a required entry fails the gate. Derived by this author:

```
$ python3 -c "import json,re; m=json.load(open('test/integration/required-tests.manifest.json'));
  pat=re.compile(r'pg-|backend|synchronous-commit');
  print(len([e for e in m['required'] if pat.search(e['id'])]));
  print([e['id'] for e in m['required'] if e['file'].startswith('test/postgres/')])"
6
['property.p3.replay-fold-equivalence', 'differential.fault-schedule.state-equivalent',
 'differential.fault-schedule.negative-control-fires', 'differential.reference.import-clean']
```

**Six required ids are engine-named in the id itself** —
`crash-harness.smoke.pg-terminate-backend-drops-and-recovers`,
`crash-harness.smoke.suite-watchdog-bounds-stalled-backend`,
`crash.pg-kill-save.typed-connection-error`, `crash.pg-kill-save.retry-benign-duplicate`,
`crash.cursor-durability.synchronous-commit-on`, `crash.cursor-durability.synchronous-commit-off` —
plus one engine-named deferred id, and **four** more required ids live under `test/postgres/`. (The
commitments seat listed five required plus one deferred and said "three more live in
`test/postgres/`"; the counts above are this author's and are what the spec uses.)

Two consequences the spec fixes:

- Making `CONNECTION_ERROR` unreachable **deletes a pinned required id**,
  `crash.pg-kill-save.typed-connection-error`, whose whole assertion is that an unclean kill mid-save
  rejects with a *typed* class and its stable `.code`, never a message substring. That deletion
  removes the only empirical evidence that a retryable frozen code is reachable at all under the new
  engine. The spec therefore requires a **replacement required id** that proves at least one member
  of the frozen retryable set `{TRANSACTION_FAULT, LEASE_TIMEOUT, MIGRATION_LOCK_TIMEOUT}` is
  actually reachable under SQLite.
- **Do not edit `EXPECTED_REQUIRED_COUNT` in the same commit as the id deletions.** That converts a
  reviewed contract change into a diff nobody reads. Separate, reviewed commits.

### 6.3 P1–P10 re-executed, plus P11–P15

`Formal/STORAGE_ALGEBRA.md` §5 is the testable-law deliverable and the P1–P10 suite is what carries
the abstract-to-concrete refinement claim. The Lean cut-line `{T3, T5, W1, C1}` survives this
migration **untouched**, because it models an abstract store and the abstract-to-concrete bridge was
always an explicitly trusted, unmechanized one. That survival is *evidence of the disconnection*, not
evidence of portability, and this change forbids citing it as safety evidence. P1–P10 must be
**re-executed against SQLite, not ported-and-assumed**.

And re-execution alone is insufficient: a migration is precisely the situation in which a
re-executed test goes green for the wrong reason. L6's own crash harness is the model — 9/9 held for
the co-transactional shape *and* the forbidden cursor-first shape violated the invariant 4/9, which
is the only reason 9/9 meant anything. Every surviving crash property ships its negative control.

Five new properties, for obligations SQLite creates that Postgres never had:

| # | Property | Why it is new |
|---|---|---|
| P11 | `journal_mode=WAL` and `synchronous` at or above the configured floor hold at **every** commit the durability contract covers | the pragma is persistent *in the file* and mutable out from under the library |
| P12 | after a crash, `integrity_check=ok` **and** the durable cursor is not ahead of durable data | `docs/checkpoint-store-contract.md:16-18`; today one of these had no analogue |
| P13 | a `backup()` copy satisfies the manifest → chunk reachability closure | today a documented property of `pg_dump`; tomorrow a property of our own code (§4.3 item 2; `Formal/STORAGE_ALGEBRA.md` §2) |
| P14 | `foreign_keys=ON` on every connection | off by default, per-connection, non-persistent; without it GC is a silent no-op (§1.1) |
| P15 | a value corrupted in place is **detected** on read, and the same corruption is **not** detected by `integrity_check` alone | §2.3, with §2.1's measurement as its negative control |

The refinement register (`openspec/changes/v1.1.0-formal-completion/design.md`) is rewritten **before
the port, not after** — written after, it documents what was built; written before, it constrains it
— with each status label **re-derived** rather than carried over, and with an explicit sentence that
the mechanisms named in the C2a and L1 rows no longer exist. A reviewer who sees a status label
after the migration that was earned before it is looking at a different claim wearing the same words.

---

## §7. Observability and the missing backstop

### 7.1 Nothing can look at a running embedded engine from outside

`pg_stat_activity`, `pg_stat_statements`, `EXPLAIN ANALYZE` against a live workload,
`log_min_duration_statement`, `psql` on a wedged system and every exporter built on them have **no
SQLite analogue**. `dbstat` and `sqlite3_status` are not substitutes: they describe a database file
and a process's own counters, not what a running instance is currently doing. If change 1 puts the
engine on a worker thread the situation is worse, not better, because the worker owns the only
handle. For a library whose canonical bug report is "the wallet is stuck," that is a real
operational regression and it was recorded by no lane.

The answer is a **diagnostic surface**, not a new frozen API. `v1.0.0-api-surface` deferred a public
observability API deliberately (its acceptance criterion N3), and this change does not reopen that.
What it requires is an internal diagnostic operation and a written triage procedure that together
answer, without attaching a debugger: what statement is in flight and for how long; how old the open
transaction is and who opened it; whether the lease is held and by whom; the WAL size and the last
`wal_checkpoint` result; busy/retry counters; and `integrity_check`/`quick_check` on demand.

One documented trap belongs in the same paragraph: `wal_checkpoint(PASSIVE)` returns `busy: 0` while
checkpointing nothing, so **a `busy: 0` return is not a success signal** and must not be monitored as
one (§4.3 item 4).

### 7.2 The backstop that disappears

`docs/durability-contract.md:94-115` applies `idle_in_transaction_session_timeout` (default
120,000 ms) as a startup parameter so "no statement, lock wait, or idle-in-transaction session can
hang unbounded." Under SQLite there is **no analogue at all**, and the exposure is larger than it
looks: `withTransaction` holds a **whole-database** write lock around arbitrary caller code
(`design/design-interfaces.md` §1.3; `design/design.md` §5). Today a slow callback is a slow query on
a server that will eventually terminate the session. Tomorrow it is a stalled database with no
server to intervene. A JavaScript watchdog can bound wall clock and raise a diagnostic, but it
cannot unwind a synchronous C call.

The contract must therefore say the true thing — that the hold is unbounded and that the only
mitigation is a diagnostic — rather than repeating a sentence about bounded sessions that will have
become false.

---

## §8. The pre-tag price ledger

Every break this change makes, with what it costs now and what it would cost after the tag. The
governing fact is `docs/STABILITY.md:46`: the commitments are **not yet in force** at `0.9.5`, and
`:60-63` permits a breaking change between `0.9.5` and `1.0.0`.

| Item | Pre-tag cost | Post-tag cost |
|---|---|---|
| Rename `UNRECOGNIZED_POSTGRES_ERROR` + class | one commit + CHANGELOG entry | **forces a major** (a frozen `code` renamed and an exported class removed) |
| `CLOCK_REGRESSION` keeps `conditional` | free if change 2 is constrained now | **forces a major** if it narrows (`docs/ERROR-CATALOG.md:13`) |
| `CONNECTION_ERROR` documented-unreachable | CHANGELOG entry | free (an unreachable code is not a forbidden verb) — but a *repurposing* would force a major |
| Add `DATABASE_UNAVAILABLE` / `DISK_FULL` / `DATABASE_CORRUPT` / `VALUE_INTEGRITY` | CHANGELOG entry | free under `docs/STABILITY.md:20-22` (additive) — **except** for the exported union widening (§5.2(d)) |
| Delete `docs/CONTRACT.md` §3's middle timing | doc break + release note | doc break + release note (a documented behaviour retracted; not a type break either way) |
| Rewrite `docs/CONTRACT.md` §6 | doc rewrite, gated on the §4.3 re-measurement | doc rewrite; naming the wrong primitive post-tag is a documented-behaviour retraction |
| Key error translation on the string discriminator (§5.4) | free — no shipped code depends on the numeric form | free as a code change; but shipping the numeric form would have made most of the catalog silently unreachable |
| Bind `{situation → code}` in `docs/STABILITY.md` | one sentence | binding it later is a **narrowing of a policy**, which is far harder to justify once consumers exist |
| Delete a pinned conformance id + change the pin | two reviewed commits | same, plus the contract argument is now against a live promise |

Nothing in this change is a permanent, unavoidable break. The one permanently broken *promise* is
`docs/CONTRACT.md:65-67`, and it is broken by physics rather than by timing: it cannot be bought back
at any price, before or after the tag, with any driver.

---

## §9. What this design deliberately does not resolve

Stated as open, with the experiment that closes each, because an explicit "unresolved, here is how to
resolve it" is worth more than a confident invention.

0. **Which backup primitive UmbraDB uses.** Change 1's blocked decisions **B-6/B-7**. The
   contradiction seat's comparison was measured against `node:sqlite` and the ruled binding exposes a
   different backup surface, so §6 cannot name a primitive until the comparison is re-run under the
   conditions and against the two branches fixed in §4.3. This is the only requirement in the change
   whose *outcome* is deliberately left open; its *rule* is not.
1. **The magnitude of the `synchronous` lever.** Closed by change 1's measurement gate under the
   stated conditions (§1.3).
2. **Whether `NORMAL` is safe under power loss.** Closed only by a rig that removes power or
   faithfully emulates a lost volatile write cache. Nobody in the sprint has such evidence and the
   spec forbids substituting SIGKILL for it (§1.3).
3. **The write cost of the value digest.** Measured under change 1's gate and **recorded only** — the
   coverage set is unconditional and no measured value narrows it (§2.7). Alongside it: the storage
   delta on real rather than synthetic payloads.
3a. **The verification pass's runtime at archive scale**, both components, with a **separate-process**
   writer. Until measured it is documented as an on-demand diagnostic and post-restore check, and no
   text may recommend a scheduled pass (§2.5).
3b. **The field corruption base rate.** No seat obtained one; every cost/benefit here is priced
   against a hazard, not a probability, and the contract makes no frequency claim in either direction.
   One figure circulating in council review was unsourced and is excluded by requirement (§2.6).
3c. **An executed rebuild procedure for the archive projection tables.** Until one transcript exists,
   the contract's archive row says "resynchronise from chain" and does not claim a local rebuild
   (change 6's acceptance).
4. **I/O fault injection.** `SQLITE_IOERR_*` and `SQLITE_FULL` are the codes `LEASE_FAULT` and
   `DISK_FULL` live on, and neither candidate binding exposes a VFS hook — the ruled binding's
   prototype (§0.4) contains no VFS entry — so they are reachable-in-principle and
   untestable-in-practice. Options nobody evaluated: a FUSE fault-injecting filesystem, or
   `dm-error`. The spec requires this to be **recorded as a known coverage gap in the catalog**
   rather than left for a green gate to hide.
7. **`err.code` stability across binding versions.** The string discriminator is the load-bearing
   fact for the whole translation layer and it was verified empirically on `better-sqlite3@13.0.2`
   only (§0.4). It needs a pinned regression test on day one, alongside the `sqlite_version()`
   assertion, so a dependency bump that changed the shape could not pass CI silently.
5. **Windows.** UmbraDB is a wallet library with no stated OS restriction, and the new precondition
   is a local filesystem with working advisory locks. Windows uses `LockFileEx` with different
   semantics, and the filesystem-refusal probe needs a Windows path. Unowned by any lane; the spec
   requires it to be declared either supported-and-tested or explicitly out of scope.
6. **Whether any external consumer of `0.9.5` exists.** A git-tag install leaves no registry
   footprint, so a zero-consumer claim is *unobservable*, not proven. Every judgement about how expensive a
   break is turns on it. The spec requires the answer to be recorded in the release record rather
   than assumed in either direction.
