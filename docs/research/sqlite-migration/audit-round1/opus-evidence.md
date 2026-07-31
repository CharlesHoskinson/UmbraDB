# Audit: falsifiability and evidence integrity — `opus-evidence`

Seat: `opus-evidence`. Scope: whether this plan can be held to account.
Host: WSL Ubuntu-26.04, ext4 `/dev/sdd` on `/`, tmpfs 32G on `/tmp` (`df -hT /tmp /root`).
Driver used for all experiments: `better-sqlite3@13.0.2` at `/tmp/l3-bs3b`, SQLite `3.53.4`, Node
`v24.18.0`. Experiment scripts: `/root/audit-evidence/exp-{a,b,c,d,e,f,g}*.mjs`. No `npm install`
was run; no repo file was modified.

---

## 1. Verdict

**APPROVE WITH FINDINGS.**

This is the most falsifiable spec set I have audited on this project: 90 requirements and 304
scenarios across six spec files, with **zero** requirements of the "SHALL be robust" /"SHALL handle
errors appropriately" class, and a house style — a positive scenario paired with a named negative
control that must fail — that is exactly the right instrument for this job. I attacked eleven
load-bearing claims experimentally; **nine held exactly**, including the sprint's keystone
(page-checksum gap) and the ruling that broke L2's sidecar. None of the six council-overturned
positions has been reverted, including the two the brief flagged as most tempting, and change 5's §6
handles the stale `node:sqlite` backup measurement correctly — it writes the 781-commit figure up as
a *rejection* negative control rather than citing it as support.

Two findings are critical and must be closed before implementation begins. The first is a premise I
falsified on this machine: `BEGIN IMMEDIATE` does **not** hold SQLite's write lock across an
open-then-close of a descriptor on the `-shm` file inside the holding process, so change 3's
writer-generation guard has a stated safety argument that is false, and I reproduced two processes
both committing with one acknowledged commit **silently lost** and `integrity_check` reporting `ok`.
This also refutes `SYNTHESIS.md`'s "the main WAL database survived the fd-close attack". The second
is that the sprint's most important enhancement — the page-checksum gap — ships with an open-ended
coverage set ("at minimum …") and a re-derivable/non-re-derivable split that leaks: the sync cursor
is classified re-derivable and left uncovered, but the cursor is the thing that decides how much to
re-derive.

Everything else is rework-grade or smaller. Two contaminated latency figures did survive into change
1's spec, but I re-measured them on ext4 and they are conservative rather than wrong — I report the
failed attack as well as the successful ones.

---

## 2. Critical findings

### C1. Change 3's cross-process guard rests on a premise I falsified: an `-shm` fd close voids the WAL write lock, and an acknowledged commit is silently lost

**Change:** `v1.0.0-sqlite-concurrency-lease`
**File:** `specs/transaction-lease/spec.md:127-194` (requirement "a second writer process is detected
and the displaced process is fail-stopped before it can commit"), specifically the scenario
**"The check cannot be raced"** at `:152-158`.

**What is wrong.** That scenario's entire justification is:

> **AND** this SHALL hold because the guard read and the transaction's writes occur inside one
> `BEGIN IMMEDIATE`, which holds SQLite's file-level write lock for the whole transaction, so no
> interleaving between "observe the generation" and "commit" exists.

The premise is false in WAL mode. WAL locking lives in the `-shm` file as POSIX record locks, and
POSIX record locks are dropped when the process closes **any** descriptor on that inode — the exact
rule the council correctly applied to L2's sidecar and then incorrectly declined to apply to the
main database. `SYNTHESIS.md` records under *"What survived a genuine attack"*: "The main WAL
database survived the fd-close attack (its locks live on `-shm`). Only the sidecar is exposed." The
locks living on `-shm` is the reason it is exposed, not the reason it is safe.

**Evidence** (`/root/audit-evidence/exp-d.mjs`, `exp-e.mjs`, `exp-f.mjs`; holder and competitor are
separate OS processes, `busy_timeout=0`, WAL, ext4):

```
holder reads none    2nd writer before=refused(SQLITE_BUSY) after=refused(SQLITE_BUSY) | holder COMMIT ok
holder reads db      2nd writer before=refused(SQLITE_BUSY) after=refused(SQLITE_BUSY) | holder COMMIT ok
holder reads wal     2nd writer before=refused(SQLITE_BUSY) after=refused(SQLITE_BUSY) | holder COMMIT ok
holder reads shm     2nd writer before=refused(SQLITE_BUSY) after=SECOND WRITER COMMITTED | holder COMMIT ok
```

The durable outcome (`exp-e.mjs`) is worse than a race:

```
second writer committed gen=99                 yes
second writer sees rows                        [{"gen":99}]
holder commit result                           COMMIT ok
final rows                                     [{"gen":1}]
integrity_check                                [{"integrity_check":"ok"}]
=> both writers' rows present?                 {"c":1}
```

Both `COMMIT`s returned success. The second writer's acknowledged commit is **gone**. The database
reports itself healthy.

Characterisation (`exp-f.mjs`) — it is the descriptor close, not the read, and it is per-process:

```
holder does none        refused(SQLITE_BUSY)
holder does statonly    refused(SQLITE_BUSY)      <- fs.statSync takes no fd: safe
holder does readdir     refused(SQLITE_BUSY)      <- safe
holder does openkeep    refused(SQLITE_BUSY)      <- open without close: safe
holder does openclose   SECOND WRITER COMMITTED   <- open+close (what readFileSync does): voids it
foreign process reads -shm  refused(SQLITE_BUSY)  <- another process reading it: harmless
```

**Why this is critical rather than academic.** Change 3 *mandates a test that performs this exact
act*. Its scenario at `:40-48` ("Reading every file UmbraDB owns does not void a held lease —
red-team attack 1") requires the holding process to `fs.readFileSync` "the database file, on its
`-wal` and `-shm` sidecars, and on every other file UmbraDB created", enumerating the directory so
future files are covered. That test asserts only the **in-process lease** property, which genuinely
survives (it consults no filesystem — correct). The same act silently voids the **cross-process**
guard specified 80 lines later in the same file. The suite would be green while the guarantee it is
adjacent to is void.

Three further consequences the plan does not currently see:

- Change 2, `specs/temporal-kv/spec.md:370-390`, argues the trigger-assertion TOCTOU window is
  "closed three independent ways", the first being "`SQLITE_BUSY` (5) refusing a second simultaneous
  writer". Under this attack the second writer is not refused. Change 2's concurrency scenario tests
  `wal`/`delete`/`truncate` × two `busy_timeout` values but never with an fd close.
- Change 5 requires the offline backup procedure to copy the sidecars (`specs/release-contract/spec.md:303-305`:
  "Never copy the main database file alone"). A copy loop implemented in-process reads `-shm` and
  therefore voids the writer's locks while it runs.
- Change 5's digest tier cannot detect this class of damage at all: the lost commit is a **missing
  row**, and a digest over stored values says nothing about a row that is not there.

**What the plan should say instead.**
1. Add the `-shm` open/close attack as a scenario against the **writer-generation guard**, not only
   against the lease, with the observable being "no two writers both commit" and "no acknowledged
   commit is lost".
2. Either specify an in-process invariant that no UmbraDB code path — and no documented operator
   procedure, including the offline backup copy — opens and closes a descriptor on `-wal`/`-shm`
   (enforceable as a source guard in the same style as the `INSERT OR REPLACE` ban), **or** state the
   fd-close as a named voiding precondition on the guard, which is exactly the discipline change 2
   already applies to its own adapter guard at `specs/temporal-kv/spec.md:258-264`.
3. Correct `SYNTHESIS.md`'s "survived a genuine attack" entry. It is currently the reason nobody
   looked.

**Limits of my test.** Linux/ext4, `better-sqlite3@13.0.2` / SQLite 3.53.4, WAL. Not tested on
Windows (change 3 already carries a Windows obligation — this belongs in it) and not tested under
`unix-dotfile` or other VFS.

### C2. The page-checksum enhancement ships with an open-ended coverage set, and the re-derivable/non-re-derivable split leaks through the sync cursor

**Change:** `v1.0.0-sqlite-durability-contract`
**File:** `specs/release-contract/spec.md:138-176`; reasoning at `design.md:264-268`; task at
`tasks.md:156-163`.

The requirement reads: digests over "the tables that are **not** re-derivable from chain — **at
minimum** the TemporalKV value tables and the wallet-state envelope store". The design's split is:
"checkpoints, watermarks and the archive are re-derivable from chain; TemporalKV history is not."

**Two defects.**

**(a) "At minimum" makes the coverage set unfalsifiable.** You cannot tell whether an implementation
covering only TemporalKV violates this requirement, and `transaction_history` — which `proposal.md:41`
itself lists among the tables that have no digest, and whose pending/rejected lifecycle rows and
identifier junction are wallet-local rather than chain-derived — is named nowhere in the requirement.
This is the sprint's single most important enhancement and its scope is the one thing not pinned.

**(b) The split leaks.** Re-derivability is only a remedy *if you know to invoke it*, and the item
classified as re-derivable is the item that decides whether you invoke it. `watermarks`
(`src/postgres/migrations/003_watermarks.ts:17-28`: `kind, key, value jsonb, updated_at`) holds the
sync cursor. A silent forward corruption of that cursor makes the wallet believe it has already
synced a range it never processed. The state derived from the skipped range lands in TemporalKV —
the tier the design correctly calls **not** re-derivable — and is permanently wrong. Nothing detects
it: `integrity_check` returns `ok` (C1's transcript and §2.1's), there is no digest on the row, and
change 5's **P12** asserts the cursor-ordering invariant of `docs/checkpoint-store-contract.md:16-18`
only **after a crash**, not against silent in-place corruption. A single-digit flip inside a JSON
cursor value (`1234` → `1934`) parses cleanly.

**What the plan should say instead.** Enumerate the coverage set exhaustively — every table named,
each marked covered or uncovered with the reason — rather than "at minimum". Extend digest coverage
to the durable cursor / `watermarks` value specifically, on the ground that a corrupted cursor
damages the non-re-derivable tier by omission; or, if it is deliberately left uncovered, add a
scenario requiring the whole-database verification pass (`spec.md:178-200`) to check the
cursor-is-not-ahead-of-data invariant on demand and not only post-crash.

---

## 3. Major findings

### M1. Two contaminated latency figures survived into change 1's spec — in the change that owns the anti-contamination rule

`v1.0.0-sqlite-engine-core/specs/sqlite-engine/spec.md:367-374` states, inside a requirement's
negative control and presented as fact:

> **THEN** the event loop CAN be blocked for the full duration — measured at **429 ms** for a 500k-row
> materialisation and **237 ms** for a 64 MiB blob write, against a **0.15–0.3 ms** idle baseline

Traced: `reports/l3-driver.md:301-310`, section header "**on disk**". The script is
`/tmp/l3/07-eventloop.mjs`, and its line 3 reads `const PATH = "/tmp/l3/eventloop.db"`;
`df -hT /tmp` reports `tmpfs 32G`. The lane's own "on disk" label is wrong, which is precisely how
this class of error propagates.

This violates the same spec file's own rule 60 lines later (`:420-421`): *"No requirement, design
decision or contract statement in this migration SHALL cite a throughput, latency or rejection-rate
figure that is not present in that artifact with its conditions attached."*

**I attacked the figure and it substantially held** (`exp-g.mjs`, 64 MiB blob, WAL):

```
64MiB blob write, tmpfs (/tmp), sync=NORMAL      290.7 ms
64MiB blob write, ext4 (/root), sync=NORMAL      409.5 ms
64MiB blob write, ext4 (/root), sync=FULL        297.7 ms
published figure quoted in the spec              237 ms (tmpfs)
```

So the number is an **underestimate** (1.3–1.7×), not a 233× inversion, and the requirement it
supports is unaffected. Grade this as a discipline defect, not a wrong decision: fix by attributing
the figures ("measured on tmpfs; a floor") or moving them behind the measurement artifact.

### M2. "379 commits/s / 233×" is quoted in all five changes as *the* ext4 calibration, and the corpus supports four mutually inconsistent values

Verified in the corpus:

| figure | source |
|---|---|
| 345 c/s (tmpfs baseline 93,386 → **271×**) | `council/contradiction.md:16,90,586` |
| 379 c/s (tmpfs baseline 88,485 → **233×**) | `council/redteam.md:276` |
| 411 c/s (ext2/ext3) | `reports/l6-contracts.md:484` |
| 523 c/s (median of 618/489/523) | `reports/l6-contracts.md:462` |

`v1.0.0-sqlite-durability-contract/design.md:193-194` is the only place in the sprint that discloses
this and concludes "None of them is quotable as a contract input, and this change quotes none" —
correct, and to that author's credit. The other four changes each quote 88,485 → 379 → 233× flatly:
`engine-core/proposal.md:44` and `design.md:568`; `temporal-event-log/design.md:694-695`;
`concurrency-lease/proposal.md:188-189`; `schema-parity/design.md:14`, `proposal.md:152` — and,
most seriously, **inside a spec requirement's scenario** at
`schema-parity/specs/storage-schema/spec.md:641`.

Selecting one of four inconsistent measurements and publishing it as the calibrating fact is the
same defect class the sprint is guarding against, one order of magnitude down. Fix: quote the range
(`345–523 c/s across four independent ext4 runs; 169×–271× versus the tmpfs figures`), or quote no
number and say "two to three orders of magnitude".

### M3. Change 5's doc test does not cover the other four changes, and the program-wide rule has no program-wide gate

The brief asked me to verify this specifically. It does not.

- `durability-contract/tasks.md:199` — "a doc test asserts **the document** contains no
  commits-per-second figure, throughput ratio or latency…" (the document = `docs/durability-contract.md`).
- `durability-contract/acceptance.md:37` (B2) — "No document **in this change's set** states a
  commits-per-second figure … Enforced by a doc test, not by review."

Both are scoped to change 5's own artifacts. Meanwhile change 1's spec asserts the prohibition
*program-wide* ("No requirement, design decision or contract statement **in this migration**…") but
change 1's only mechanical hook is `CI SHALL assert that the artifact exists and that its declared
filesystem is not a memory-backed filesystem` (`spec.md:417-418`) — which checks the artifact, not
the prose. Change 4 states the rule (`spec.md:629-649`) and enforces it with a single acceptance row
marked `[doc]` against its own artifacts.

M1 and M2 are exactly what a program-wide gate would have caught. Fix: put the figure-provenance
lint in change 1, which owns the gate, and scope its glob to `openspec/changes/v1.0.0-sqlite-*/**`
plus `docs/**` — a grep for digit-groups adjacent to `commits/s|ms|MB/s|µs|×` with an allowlist
keyed to artifact datum ids.

### M4. Change 1's parameter-normalisation requirement is tested by a scenario that does not test it, and three of its normative clauses have no scenario at all

`engine-core/specs/sqlite-engine/spec.md:195-232`. The requirement has four clauses: the
normalisation table; `SHALL throw on any other object type`; `No adapter SHALL bind a Date, a
boolean, or an arbitrary object directly`; and the `Date → integer epoch ms` rule.

Its only positive scenario (`:205-210`, "a point-in-time read returns the row the caller asked for")
asserts temporal-projection correctness — which is change 2's Law T3 property, and which would pass
against an implementation that normalises nothing at all if the binding happened to store `Date`
natively. The two following scenarios are both hypothetical negative controls. Nothing observes
`boolean → 1/0`, nothing observes `Buffer`/`Uint8Array`, nothing observes the throw-on-unknown-object
rule, and "no adapter binds a Date directly" admits no observation (it needs a source guard, in the
style of change 3's `BEGIN IMMEDIATE` scan or change 2's `INSERT OR REPLACE` ban).

Fix: one scenario per normalisation class asserting the stored storage class via `typeof()`, plus a
source-scan scenario for the no-direct-bind clause.

### M5. `WITHOUT ROWID` assignment is undecidable as written, and the payload-bearing table it most matters for falls between changes 2 and 4

`schema-parity/specs/storage-schema/spec.md:418-421`: "SHALL declare `WITHOUT ROWID` only on tables
whose rows are **small relative to a page**, and SHALL NOT declare it on `ckpt_chunks` or any other
table whose rows carry a multi-kilobyte payload." No threshold, no page-size reference, no
table-by-table assignment. Only `ckpt_chunks` is decided.

The table this rule most needs to decide is the new event log, whose rows carry the TemporalKV
`value` payload — and change 2, which owns the event-log shape, enumerates its columns
(`temporal-event-log/specs/temporal-kv/spec.md:26-29`) without ever stating rowid-ness. So the one
case where an author might reasonably reach for `WITHOUT ROWID` (a four-column composite key) is
specified by neither owner. Fix: change 4 enumerates the assignment for every table in the lineage;
change 2 states it for the event log.

### M6. Change 3's hold-bound scenario is unfalsifiable, and reuses an already-overloaded term

`concurrency-lease/specs/transaction-lease/spec.md:268-275`:

> **THEN** the transaction SHALL be rolled back and the database write lock SHALL be released
> **before the bound's grace elapses**

"The bound's grace" is defined nowhere in the change — `grep -rn "grace"` over the change returns
this line and four unrelated hits, all of which mean the *checkpoint GC grace window*
(`spec.md:556,580-581`, `design.md:695,713`, `acceptance.md:121`). As written you cannot decide
whether a rollback at bound + 5 s satisfies the scenario. Fix: name a concrete additional allowance
(and note that `spec.md:298-306` already, correctly, says the real bound is "the bound plus the
in-flight statement's remaining runtime" — that is the sentence the scenario should assert).

### M7. Change 5 mandates a digest column on tables whose columns change 2 enumerates exhaustively and whose DDL change 4 owns; neither neighbour knows

`durability-contract/tasks.md:156-159` — "Digest column plus write-path computation plus read-path
re-verification for the TemporalKV value tables …, **coordinated with `v1.0.0-sqlite-schema-parity`
for the DDL**." That coordination is one-directional: `grep -rni "digest"` over
`v1.0.0-sqlite-schema-parity/` returns **zero** hits. Change 4 owns types, domain `CHECK`s and the
migration lineage, mandates `STRICT` and forbids `ANY`, and contemplates no digest column or its
declared type. Change 2's requirement at `temporal-event-log/specs/temporal-kv/spec.md:26-27` says
the store "SHALL persist one row per accepted `put` — `(ns, scope, key, version, value, written_at)`",
an exhaustive list that a digest column contradicts on a strict reading.

Fix: change 4 adds the digest column to its type-mapping requirement (declared type, `octet_length`
`CHECK`, and the `STRICT` interaction); change 2 amends its column enumeration or states that
additive integrity columns are out of its scope.

---

## 4. Minor findings

- **m1.** `schema-parity/specs/storage-schema/spec.md:130-131` lists `ANY` among the declared types
  the system may use; the next requirement at `:142` says "No column SHALL be declared `ANY`."
  Internally inconsistent in adjacent requirements.
- **m2.** `temporal-event-log/specs/temporal-kv/spec.md:378` carries the retired numeric result-code
  form in prose — "`SQLITE_BUSY` (5) … `SQLITE_BUSY_SNAPSHOT` (517)". It is descriptive, not a
  discriminator, so it is not the failure changes 3 and 5 forbid; but it is the only place in the
  five specs where the `node:sqlite` numeric form appears unannotated, and an implementer reading
  only change 2 could carry it forward. Annotate it as "SQLite's own result codes, not the binding's
  discriminator".
- **m3.** `temporal-event-log/specs/temporal-kv/spec.md:360-361` — "because that measurement was
  taken on a RAM disk it is a **floor**: on real storage the penalty is larger, not smaller." True
  for the *absolute* added time; the quantity actually quoted is a **ratio** (1,441× against a
  708 rows/s unconstrained floor), and on real storage the unconstrained floor collapses too, so the
  ratio may well shrink. Say which quantity is the floor.
- **m4.** `engine-core/specs/sqlite-engine/spec.md:493-494` — "the property texts SHALL be unchanged
  … **apart from fixture wiring**". On a requirement whose entire purpose is that no property be
  weakened, "fixture wiring" is an undefined escape hatch. Bound it (e.g. "changes confined to
  `beforeEach`/factory construction, asserted by diff").
- **m5.** `engine-core/specs/sqlite-engine/spec.md:444-449` cites "falling by a factor of 2.64 over
  2.4 GB" inside a requirement. It is an ext4 figure (redteam), so it is not tmpfs-contaminated, but
  it is a throughput figure in a spec with no artifact datum behind it — the same rule as M1.

---

## 5. What I verified and it was correct

Reported at length because it is what makes §2 and §3 credible. Nine of the eleven claims I attacked
held exactly.

**Mechanical checks.**
- `cd /root/UDB-sqlite-sprint && /usr/local/bin/openspec validate --changes --strict --no-interactive`
  → **17 passed, 2 failed (19 items)**. The two failures are `v1.1.0-formal-completion` and
  `v1.1.0-quint-model-checking`, the known pre-existing pair. **All five new changes pass strict.**
- `git status --porcelain` shows only the five new untracked directories under
  `openspec/changes/`; nothing outside them, no product-code modification. Branch
  `sprint/sqlite-migration`.
- All five changes carry the complete five-file set; `v1.0.0-sqlite-schema-parity` additionally
  carries a second delta directory (`specs/temporal-kv/`), which is deliberate — see below.

**Citations spot-checked by opening the cited file at the cited line — 12 of 12 verbatim.**
`src/interfaces/transaction-lease.ts:76` (the `faultKind` union, with `"timeout"` and
`"serialization-failure"` both already members — so change 3's mapping genuinely needs no widening);
`:31-33` ("no TTL, no self-expiry, no stealing"); `:83` ("matching `pg_advisory_lock`'s real
blocking semantics"); `docs/ERROR-CATALOG.md:13` ("no `retryable` marking is weakened");
`docs/STABILITY.md:46`; `src/postgres/checkpoint-store.ts:62-63` (30_000 / 20_000);
`src/postgres/migrations/006_ckpt_chunks_size_bytes.ts:16-19` (`GENERATED ALWAYS AS
(octet_length(data)) STORED`); `Formal/STORAGE_ALGEBRA.md:227-231` (T5(2) **CALLER-ENFORCED**, with
the "trigger remains the sole writer" wording change 2 quotes); `src/interfaces/temporal-kv.ts:153`
(`readonly writtenAt: Date`); `docs/CONTRACT.md:65-67` (the freed-wait clause, verbatim as change 5
quotes it); `src/postgres/checkpoint-store.ts:366-368` (`ChunkIntegrityError` on hash mismatch);
`src/postgres/migrations/chain_archive/001_chain_archive_core.ts:86` ("Not wired into any runner
path that would execute it").

**Driver-surface claims (`exp-a.mjs`), all exact.**
```
E2 err.name                    SqliteError
E2 err.code                    "SQLITE_CONSTRAINT_PRIMARYKEY"
E2 typeof err.errcode          undefined
E2 own props                   ["stack","message","code"]
```
This reproduces `durability-contract/design.md:87` and `concurrency-lease/design.md:823` character
for character. **No numeric result code is used as a live discriminator anywhere in the five
changes** — every occurrence of `errcode`/`517`/`1555`/`5` is inside a negative control, a design
note about the rejected form, or a measurement transcript. The late driver relay was folded in
completely.

**Change 4's `STRICT` enhancement is real and enforceable** (`exp-a.mjs`): `STRICT` rejects
`JSONB`, `BYTEA`, `TIMESTAMPTZ`, `BIGINT` and `INT4` at DDL with exactly the message change 1
quotes (`unknown datatype for s_JSONB.a: "JSONB"`); a `TEXT` bound to an `INTEGER` column fails with
`SQLITE_CONSTRAINT_DATATYPE` / `cannot store TEXT value in INTEGER column t.n` and stores no row.
The change-1/change-4 interface holds: origin-metadata decoding and `STRICT` are compatible, and
each is load-bearing for the other exactly as change 1's scenario at `:224-231` argues.

**64-bit fidelity** (`exp-a.mjs`): default mode returns `9223372036854776000` for `int64max`;
`defaultSafeIntegers(true)` returns `9223372036854775807`. Change 1's claim that the chosen binding
*truncates* where the rejected one *throws*, and that closing this is part of the price of the
ruling, is correct.

**Bind-parameter ceiling** (`exp-b.mjs`): `SQLITE_MAX_VARIABLE_NUMBER` = **32766**; 16,383 × 2
parameters prepares, 16,384 × 2 fails with `too many SQL variables`. Change 1's boundary claim at
`:341-350` and change 4's at `:553-590` are exact to the row.

**`RAISE(ABORT)` does not poison the transaction** (`exp-a.mjs`): after the trigger aborted, a
subsequent insert to an unrelated table succeeded and `COMMIT` succeeded; the rejected row left no
trace. Change 2's requirement at `:300-336` and change 3's poison-emulation rationale at `:463-478`
both rest on a behaviour I reproduced.

**`PRAGMA ignore_check_constraints=on` disables `CHECK` but not triggers** (`exp-a.mjs`), verified
in both directions: the trigger still raised `UMBRADB_WELLFORMED`, and a `CHECK (a > 0)` accepted
`-1`. Change 2's scenario at `:157-162` — that a trigger assertion is strictly harder to bypass than
the `CHECK` it replaces — is correct, and it is a non-obvious claim.

**`ADD COLUMN … GENERATED … STORED`** (`exp-a.mjs`): **SUCCEEDED** on a 0-row table, failed with
`cannot add a STORED column` on a 1-row table. L6's precise reading is right, L4's "refuses
outright" is wrong, and change 4 adopts L6's — including pinning the failure with a test against a
throwaway database.

**L2's sidecar lease really is broken, cross-process, in both journal modes** (`exp-c.mjs`):
```
jm=delete attack=readfile   competitor before=refused(SQLITE_BUSY)  after=ACQUIRED
jm=delete attack=unlink     competitor before=refused(SQLITE_BUSY)  after=ACQUIRED
jm=wal    attack=readfile   competitor before=refused(SQLITE_BUSY)  after=ACQUIRED
jm=wal    attack=unlink     competitor before=refused(SQLITE_BUSY)  after=ACQUIRED
```
Change 3's refusal to use any lock file, its two attack scenarios, and its anti-reintroduction
source guard are all justified. This is the one the brief flagged as most likely to be reverted; it
was not reverted, and the ruling is sound on my own measurement.

**No interrupt primitive** (`exp-a.mjs`): `Object.getOwnPropertyNames(Database.prototype)` =
`constructor,prepare,transaction,pragma,explain,backup,serialize,function,aggregate,table,loadExtension,exec,close,defaultSafeIntegers,unsafeMode`
— identical to change 5's `design.md` §3.1 list. The deletion (not rewording) of `docs/CONTRACT.md`
§3's freed-wait clause is correctly grounded on the **ruled** binding, not on a relay about
`node:sqlite`.

**The page-checksum gap reproduced independently** (`exp-b.mjs`) — 500 rows, WAL,
`wal_checkpoint(TRUNCATE)`, 64 bytes overwritten mid-file at the payload offset, reopened:
```
integrity_check                    [{"integrity_check":"ok"}]
quick_check                        [{"quick_check":"ok"}]
row returned to application?       YES
payload equals pre-corruption?     false
application digest detects it?     YES
full scan rows / digest mismatches 500 / 1
```
Change 5's keystone claim is real, the mechanism it proposes works, and P15 is a genuine property.

**I attacked change 5's own caveat and it held in the plan's favour.** §2.3(3) warns that "a digest
stored adjacent to its value can in principle be damaged by the same event". I clobbered 64 bytes
spanning *both* the value and the digest that follows it in the same row: `integrity_check` → `ok`,
row returned as `{"payload":"AAAAAAAA","digest":"AAAA…e9a60fe2"}`, and the digest check **still
detected the mismatch**. For the caveat to bite, the corruption would have to produce a digest that
matches the corrupted value. The caveat is honest and conservative; it should say so rather than
leaving a reader to weigh it as a comparable risk.

**No reversion to a refuted position, on all six checks.**
1. *Sidecar lease* — not restated as sound; explicitly a forbidden implementation with both attacks
   as scenarios and a source guard against silent reintroduction (`concurrency-lease` `:56-70`).
2. *Logical clock* — genuinely conditional, and better specified than the brief required: **R** is
   defined operationally (≥5,000 back-to-back same-key puts, own autocommitting transactions, no
   throttle, non-tmpfs, at the shipped `journal_mode`/`synchronous`), both branches are written out,
   and a `WHILE` clause forbids starting dependent work before R reports
   (`temporal-event-log` `:164-225`). Change 1 names it in the blocked-decision list `:451-476`.
3. *New `SQLITE_BUSY` code* — forbidden twice (`concurrency-lease` `:411-421`, `durability-contract`
   `:403-416`), with the LND #7869 fund-loss shape and the "missing retry layer, not a missing code"
   diagnosis both named, and correctly framed as a **safety** ruling rather than a SemVer one.
4. *`WITHOUT ROWID`* — ruled against for the content-addressed tables, with the tmpfs caveat carried
   explicitly ("the *factors* SHALL NOT be carried as fact… only the direction") and a stated
   condition under which the ruling reopens.
5. *`GENERATED … STORED`* — L6's precise reading adopted, verified above, and the "the pre-tag
   window is chiefly valuable for this item" argument correctly recorded as **void**.
6. *`backup()` vs `VACUUM INTO`* — **handled correctly, and this is the one I expected to find
   wrong.** Change 5 §6 (`spec.md:266-346`) names no primitive, defers to change 1's B-6/B-7,
   enumerates the re-measurement conditions, specifies both outcomes including "UmbraDB has no
   live-backup mechanism" as a legitimate contract, and writes the 691 MB / 781-concurrent-commit
   figure up as a **rejection** negative control precisely because it came from the other binding.

**Cross-change coordination that could have collided and did not.** Changes 2 and 4 both carry
`specs/temporal-kv/` delta directories. Their `## MODIFIED` header sets are **disjoint** and every
header matches `openspec/specs/temporal-kv/spec.md` byte-for-byte: change 4 takes exactly the two
requirements change 2 declares it is deliberately leaving alone (*"Migrations are idempotent and
ordered"* at merged `:6`, *"Schema isolation is the default, not opt-in"* at `:25`), and change 2
takes the other eight. Two authors who could not see each other's drafts resolved a seam correctly
and each documented the other's ownership.

**Scope discipline.** The chain archive is named as an explicit non-goal in every change; change 5
cites `001_chain_archive_core.ts:86` verbatim; nothing in the plan assumes it migrates. Change 4's
handling is the sharpest — it keeps the `UNIQUE NULLS NOT DISTINCT` translation *rule* as a static
lint precisely because the only in-repo instance lives in the deferred lineage and the rule would
otherwise be lost with it.

**Falsifiability rate.** 90 requirements / 304 scenarios across six spec files, all read. Requirements
with a **material** falsifiability defect: **4 (4.4%)** — M4 (change 1 normalisation), M5 (change 4
`WITHOUT ROWID`), M6 (change 3 hold bound), C2(a) (change 5 digest coverage set). Requirements with a
**soft** defect — falsifiable in principle but with an unbounded term or an undefined oracle: **4
more (total 8.9%)** — change 2's "flat / no upward trend" write-path criterion (`:348-368`), change
1's "same order of magnitude as its idle baseline" (`:364`), change 1's "apart from fixture wiring"
(m4), and change 5's "no sentence SHALL rest solely on a research lane's characterisation" (`:705`,
already marked `[manual]`). **Zero** requirements of the "SHALL be robust / handle errors
appropriately / perform adequately" class. For comparison, the ratio of requirements whose negative
control names a *measured* falsifying observation rather than a hypothetical is high enough that the
specs read as executable test plans; that is the reason the rate is this good.

---

## 6. Coverage gaps

1. **The `-shm` fd-close hazard has no owner.** Change 1 owns the worker topology and file handling,
   change 3 owns the guard whose premise it falsifies, change 5 owns the backup procedure that
   copies sidecars. None of the three currently knows about it. See C1.
2. **Corruption response.** Change 5 states plainly that detection is not repair and that UmbraDB
   ships no repair tool — good. But no change specifies what an operator *does* after
   `ValueIntegrityError` or `DATABASE_CORRUPT`. The implied answer is restore-from-backup plus
   resync, and change 5 also allows the outcome "UmbraDB has **no live-backup mechanism**". Those
   two are consistent only if the offline quiesce-then-copy path is specified as the recovery path,
   which no change does. `SYNTHESIS.md` lists "corruption response and field repair" as an unowned
   surface; it is still unowned.
3. **PostgreSQL → SQLite data migration.** All five changes treat it as out of scope, conditional on
   "no consumers" — a fact change 5 itself records as *unobservable* (a git-tag install leaves no
   registry footprint, `spec.md:736-740`). If the owner answers "yes, someone installs from the
   tag", no change owns the work and the cost is not in the 100–150 day estimate.
4. **Network and DrvFs filesystems.** Change 5's probe refuses `nfs`/`cifs`/`v9fs`/`tmpfs`/`ramfs`
   and change 3 asserts the in-process lease is unaffected — but WSL `/mnt/c` DrvFs is named only in
   change 3's scenario text, not in the probe's refusal list, and that is where this project's own
   development loop runs. Either add it to the refusal set or state why it is excluded.
5. **Windows.** Change 3 blocks the strengthened contract on a Windows experiment; change 5 requires
   the contract to state supported-or-out-of-scope. Neither *does* the work, and the platform
   decision is therefore deferred to whoever writes the contract text last.
6. **The digest column's schema treatment.** See M7 — algorithm, declared type, byte-length `CHECK`,
   and `STRICT` interaction are specified by nobody.
7. **The measurement artifact's own schema.** Change 1 requires a machine-readable artifact and
   enumerates the fields each datum must carry, and four changes reference it as a gate — but no
   change specifies the artifact's identifier scheme, so "cite the artifact datum that supports it"
   (`engine-core:472-476`) has no citation format to use. This is the mechanism M3 would depend on.
