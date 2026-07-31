# Design — TemporalKV as an event log on SQLite

Change id `v1.0.0-sqlite-temporal-event-log`. Capability `temporal-kv` (MODIFIED).

This document cites `design/design.md` §2 (the TemporalKV DDL), `design/design-interfaces.md` §3.2
(the `TemporalKV` interface contract) and `Formal/STORAGE_ALGEBRA.md` §1 (Laws T1–T5) by section
number wherever it touches a decision they already made, per `openspec/config.yaml`'s design rule.
Where it supersedes one of them, it says so and says why; it never silently duplicates or
contradicts them.

Every code claim is cited `file:line` against the worktree at `sprint/sqlite-migration`
(`3c0c68b`). Every measurement is attributed to the run that produced it and is governed by §12.

**Citation addressing (audit gate G-16).** The round-2 audit measured a systemic rot in the
sprint's cross-change `file:line` layer: of ~221 anchored citations, 41 were resolved and **17
mis-anchored** — while in every mismatch the *statement* was substantively right. It is a pointer
problem, not a comprehension problem, so the fix is the addressing scheme. This change therefore
uses **two different schemes for two different targets**:

- **Cross-change citations** (into sibling `v1.0.0-sqlite-*` change directories) are anchored by
  **requirement title or section title**, because titles do not rot and those documents are being
  edited concurrently by seven authors. Where a number is given it is a secondary hint marked as
  "at time of writing", never the anchor. My own line numbers moved twice in this sprint — once
  visibly, when a coordinator relay's `:377` had already become `:470` by the time I read it.
- **Product-repo citations** (`src/`, `Formal/`, `docs/`, `test/`) keep `file:line`, deliberately.
  Those files are **not** modified by this sprint — `openspec/config.yaml`'s correctness rule
  requires a precise anchor, and a line number against a frozen tree is precise and does not rot.
  Replacing them with titles would lose precision to solve a problem they do not have.

---

## §0. Dependencies, boundaries, and one named seam

### 0.1 What this change consumes from `v1.0.0-sqlite-engine-core` (change 1)

| Consumed | Why this change cannot specify it |
|---|---|
| Driver selection and the `postgres.js`-shaped tagged-template shim | The SQL in this document is written driver-agnostically; the binding decision is a G1/supply-chain ruling, not a temporal one. |
| Pragma bootstrap and its **irreversible** ordering | `journal_mode` and `synchronous` are the two settings §3 and §6 are *conditional on*. This change states which values its guarantees hold under; change 1 sets them. |
| Connection/handle lifecycle replacing `createClient`'s pooled semantics | The transaction-identity guard in §7 is guaranteed by UmbraDB owning the handle. Change 1 owns the handle. |
| **The blocking ext4 measurement gate** | §6's clock decision rule is a function of the gate's output. Without it, the clock policy is unresolved *by construction* and this change says so rather than guessing. |
| The incremental-read transport for `listKeys` — driver iterator, batch policy, abort delivery, and the **worker-enforced idle deadline** | The mechanism is a topology question, not a temporal one; change 1 specifies it in `specs/sqlite-engine/spec.md` and has measured `iterate()` as genuinely lazy. This change states the caller-facing promises (§10.3) and claims the liveness strengthening the deadline makes available. Batch size is change 1's open decision and is referenced here as an obligation, never as a number. |

### 0.2 What this change hands to changes 3, 4 and 5

- **Change 3 (`transaction-lease`)**: sticky-poison emulation for caller atomicity (§8 shows T5
  soundness does *not* depend on it, which is why it is not blocking here); the transaction machinery
  itself (begin/commit/rollback, isolation, the lease, the transaction-hold bound); `busy_timeout` /
  retry policy; and the contention error mapping. The write-set guard in §7 is specified here because
  it is a *temporal* invariant (one recorded `writtenAt` per version), but it is **activated** by
  change 3's transaction wiring.
  **Note the one direction that runs the other way:** the merged requirement *"A caller-supplied
  transaction handle is honored or rejected, never silently ignored"* lives in `temporal-kv`, and
  change 3's deltas resolve against `specs/transaction-lease/`, so change 3 **structurally cannot
  reach it**. This change deltas it (§0.4) and cites change 3 for the semantics.
- **Change 4 (`storage-schema`)**: table/index/trigger name prefixing (identifiers are global per
  database file, so the DDL below is written unprefixed and change 4 prefixes it), `STRICT`, the
  JSON column's type and its `json_valid` `CHECK`, and the `listKeys` prefix-matching mechanism.
- **Change 5 (`release-contract`)**: `EXCLUSION_VIOLATION` becoming unreachable;
  `CLOCK_REGRESSION`'s cause set and `retryable` marking; the `UNRECOGNIZED_POSTGRES_ERROR` rename;
  the rewritten `Formal/STORAGE_ALGEBRA.md` prose; application-level checksums over `kv_event`
  values (SQLite has **no main-database page checksums** — coordinator-verified: 64 corrupted bytes
  in a checkpointed main database yields `integrity_check → ok`, `quick_check → ok`, and the
  corrupted row is returned as data; UmbraDB's existing SHA-256 covers `ckpt_chunks`/`chain_blobs`
  and **not** `kv_event`).

### 0.3 The seam this change deliberately does not close, stated as a risk

`openspec/specs/temporal-kv/spec.md` is the merged spec, and two of its eleven requirements —
**"Migrations are idempotent and ordered"** and **"Schema isolation is the default, not opt-in"** —
are about infrastructure that change 4 owns, while living in *this* capability's file. Change 4's
capability is `storage-schema`, a different capability, so its deltas resolve against a different
spec.

**Consequence, stated plainly:** if nothing else is done, after all five changes are archived the
merged `temporal-kv` spec will still contain the sentence *"The connection factory SHALL create and
operate within a dedicated Postgres schema (default `umbradb`), SHALL set `search_path` …"*, which
will be false. This change does not delta it because rewriting it *is* specifying change 4's
content, which the sprint brief forbids.

**Recommended resolution, for the program owner to rule on, in preference order:**
1. Change 4 adds a second delta directory `specs/temporal-kv/spec.md` containing exactly those two
   `## MODIFIED Requirements` (OpenSpec permits one change to carry deltas for multiple
   capabilities; the constraint is one *author* per change, not one capability).
2. Failing that, a sixth housekeeping change re-points those two requirements after change 4 lands.

Doing neither leaves a merged spec with two false requirements. It is recorded here so that outcome
cannot be reached by accident.

**Update:** change 4 has since taken exactly these two into a `specs/temporal-kv/` delta directory of
its own — resolution (1). Verified: its delta carries only those two headers, and `comm -12` against
this change's nine MODIFIED headers is empty, so the two `temporal-kv` delta sets are disjoint and
neither change silently redefines the other's requirement. The seam is closed; the reasoning is left
standing because the same shape will recur in any multi-change program where a capability's spec
outlives the change that created it.

### 0.4 The seam that was *not* closed, and that this change had to take

A third merged requirement — **"A caller-supplied transaction handle is honored or rejected, never
silently ignored"** — was orphaned in a worse way than the two above, and the compliance audit's M-2
is right that orphaned understates it.

It is not merely unowned. It is **contradicted**. Its merged body mandates that every method
accepting `opts.tx` throw a *"transaction participation not yet supported"* error, while
`v1.0.0-sqlite-concurrency-lease` ships real transactions **in this same sprint**. Left alone, the
archived spec would require an implementation to refuse a feature another change in the same sprint
delivers — false on the day it merges, and false in the direction that makes a conforming
implementation broken rather than merely under-described.

Change 3 cannot fix it: its capability is `transaction-lease` and its deltas resolve against
`specs/transaction-lease/`. This change owns the `temporal-kv` delta surface, so it takes it, as a
ninth MODIFIED requirement.

The boundary is drawn the same way as every other cross-change reference in this document: **what
`TemporalKV` does with a handle is specified here; what a transaction *is* is cited to change 3.**
The merged text's own scoping is what licenses this — *"Until the Transaction/Lease module's real
wiring lands (a later sprint)"* is a condition, and the condition is now met. The clause that
survives untouched is the one the header names and the only one that was never sprint-scoped: a
handle is never accepted and then run outside the transaction it names.

Two details worth recording. First, the frozen surface already anticipated this design:
`TransactionHandleInvalidError`'s own doc (`src/interfaces/transaction-lease.ts:126-132`) says
*"Every storage-layer method accepting `opts.tx` (not just this layer's own methods) can throw this,
since resolving the handle happens before that method's query ever runs"* — so honoring-or-rejecting
was always the intended end state, and the merged requirement was scaffolding. Second, change 3
re-implemented `timeoutMs`/`idleInTxTimeoutMs` as a transaction-*hold* bound (rollback, release the
lock, invalidate the handle, `faultKind:"timeout"`), restoring the semantic
`idle_in_transaction_session_timeout` provided. That gives the handle lifecycle a **defined end
state** that did not exist when the merged text was written, and it is the sharpest scenario in the
requirement: after the bound elapses, a `TemporalKV` call with that handle must reject — it must not
quietly degrade a transactional write into an autocommitted one.

---

## §1. The encoding: what the Lean model already says

`Formal/Lean/UmbraDBFormal/TemporalKV/Model.lean:42` defines
`History (Value Time) := List (Event Value Time)` where `Event` is `{value, writtenAt}` (`:9-12`).
Intervals are **not** part of that structure. They are produced by a total function, `:57-62`:

```lean
def validityIntervals : History Value Time → List (ValidityInterval Time)
  | [] => []
  | [last] => [{ validFrom := last.writtenAt, validTo := none }]
  | first :: second :: rest =>
      { validFrom := first.writtenAt, validTo := some second.writtenAt } ::
        validityIntervals (second :: rest)
```

Read that definition as an operational spec and it is exactly a `LEAD()` window function: each
event's interval starts at its own `writtenAt` and ends at *the next event's* `writtenAt`, with the
last event's upper bound open (`none` ⇒ SQL `NULL`).

The theorems over it are `Laws.lean:283` `adjacent_intervals_gap_free`, `:333`
`intervals_pairwise_disjoint`, and `:358` `validityIntervals_cover_iff`. Two things about them
matter to this design and are easy to get wrong:

- `adjacent_intervals_gap_free` (`:283`) is proved **by bare structural induction with no
  hypothesis at all.** Gap-freedom is a property of the *derivation*, not of the data. Nothing about
  the timestamps is needed for it.
- Non-overlap (`:333`) and the T3/T4 results *are* conditioned — on `WellFormed`
  (`Model.lean:69-72`), which is precisely "`writtenAt` strictly increases along the per-key chain",
  and nothing more. `Time` is abstract, carrying only `[LinearOrder Time]`.

**Design consequence, and the whole basis of this change:** if the concrete store holds an event
list and derives intervals, then the *only* refinement obligation left between the SQL and the Lean
is `WellFormed`. Today's schema instead **materialises** the intervals
(`design/design.md` §2's `kv_history.valid_from`/`valid_to`), which creates a second obligation with
no counterpart in the model at all — "no stored interval is unrelated to any event" — discharged
today only by the GiST `EXCLUDE` constraint. The migration therefore **removes an obligation**
rather than weakening one.

> **Trap 9, honoured explicitly.** Zero Lean lines change under this design, and that fact is
> **not** evidence the migration is safe. `Formal/FORMALIZATION_ROADMAP.md:24` is unambiguous: no
> theorem relates any Lean definition to SQL DDL, a trigger, `clock_timestamp()`, or the TS adapter.
> The model is invariant under total replacement of the concrete layer. The P1–P10 conformance suite
> carries the refinement claim, and per §11 it must be **re-executed, not amended**. No requirement
> or task in this change cites Lean greenness as assurance.

---

## §2. The schema

Supersedes `design/design.md` §2's `kv_current` + `kv_history` pair and
`src/postgres/migrations/001_temporal_kv.ts:72-139` in full. Written unprefixed and without
`STRICT`; change 4 supplies both (§0.2).

```sql
CREATE TABLE kv_event (
  ns          TEXT    NOT NULL,
  scope       TEXT    NOT NULL,
  key         TEXT    NOT NULL,
  version     INTEGER NOT NULL,   -- 1-based, gapless (Law T1)
  value       TEXT    NOT NULL,   -- JSON; column type and json_valid CHECK are change 4's
  written_at  INTEGER NOT NULL,   -- ms since epoch. THE sole temporal coordinate.
  PRIMARY KEY (ns, scope, key, version)
);

-- Makes getAt({at}) a covering-index seek AND makes duplicate instants unrepresentable.
CREATE UNIQUE INDEX kv_event_time ON kv_event (ns, scope, key, written_at);

-- validityIntervals (Model.lean:57-62), compiled to SQL.
CREATE VIEW kv_validity AS
SELECT ns, scope, key, version, value,
       written_at AS valid_from,
       LEAD(written_at) OVER (PARTITION BY ns, scope, key ORDER BY version) AS valid_to
FROM kv_event;
```

Three notes on choices that are not arbitrary:

- **`kv_current` is folded in, not kept.** Keeping a separate live-row table is what forced
  `getAt`'s `UNION ALL … ORDER BY priority LIMIT 1` defence
  (`src/postgres/temporal-kv.ts:230-260`), whose own comment says it exists because *"the EXCLUDE
  constraint only forbids overlaps WITHIN kv_history"* and cannot span the pair. One table, one
  index, no tiebreak. L1's open question 3 flags that `get()` on a hot key becomes
  `ORDER BY version DESC LIMIT 1` rather than a single-row PK hit, and that it did not separately
  benchmark it at 1M versions/key — task 1.4 measures it rather than assuming.
- **`written_at INTEGER`, not `REAL` or TEXT.** Millisecond integers compare and index as integers
  and round-trip a JS `Date` bit-for-bit, which is the property `001_temporal_kv.ts:60-71` exists to
  protect and which `Formal/STORAGE_ALGEBRA.md` §1's second T4 caveat documents.
- **The unique index on `(ns, scope, key, written_at)` is load-bearing twice**: it is the covering
  index for the `{at}` read path *and* it makes two versions of one key sharing an instant
  unrepresentable — a structural backstop under the §6 clock policy whichever way that policy
  resolves.

### 2.1 The write

One statement. §8 explains why splitting it is forbidden.

```sql
INSERT INTO kv_event (ns, scope, key, version, value, written_at)
SELECT :ns, :scope, :key,
       1 + coalesce((SELECT max(version) FROM kv_event e
                      WHERE e.ns=:ns AND e.scope=:scope AND e.key=:key), 0),
       :value,
       <written_at expression — see §6; NOT settled by this change>
WHERE :expectedVersion IS NULL
   OR :expectedVersion = coalesce((SELECT max(version) FROM kv_event e
                                    WHERE e.ns=:ns AND e.scope=:scope AND e.key=:key), 0);
-- changes() = 0  =>  the CAS guard failed; re-read to fill VersionConflictError.actual
```

CAS (`Formal/STORAGE_ALGEBRA.md` §1 Law T2) collapses into the same statement. `expectedVersion = 0n`
— *"this key must not already exist"* (`src/interfaces/temporal-kv.ts:124-131`) — is just the
`max(version) = 0` case, so the three-branch structure at `src/postgres/temporal-kv.ts:113-166`
(`ON CONFLICT DO UPDATE` / `ON CONFLICT DO NOTHING` / guarded `UPDATE`) becomes one shape. The
zero-rows-is-ambiguous problem survives unchanged and is handled the same way — by a follow-up read,
never by the row count alone (§10.2).

### 2.2 The `WellFormed` assertions

```sql
CREATE TRIGGER kv_event_bi BEFORE INSERT ON kv_event
BEGIN
  SELECT raise(ABORT, 'UB_T1_VERSION: version must be exactly prev+1')
   WHERE NEW.version <> 1 + coalesce(
     (SELECT max(version) FROM kv_event e
       WHERE e.ns=NEW.ns AND e.scope=NEW.scope AND e.key=NEW.key), 0);
  SELECT raise(ABORT, 'UB_T4_CLOCK: written_at must strictly exceed the previous version')
   WHERE NEW.written_at <= coalesce(
     (SELECT written_at FROM kv_event e
       WHERE e.ns=NEW.ns AND e.scope=NEW.scope AND e.key=NEW.key
         AND e.version = NEW.version - 1), -9223372036854775808);
END;

CREATE TRIGGER kv_event_bu BEFORE UPDATE ON kv_event
BEGIN SELECT raise(ABORT, 'UB_APPEND_ONLY: kv_event is append-only'); END;

CREATE TRIGGER kv_event_bd BEFORE DELETE ON kv_event
BEGIN SELECT raise(ABORT, 'UB_APPEND_ONLY: kv_event is append-only'); END;
```

Two O(log n) predecessor seeks per insert. Measured flat to 1M rows/key: 467,732 rows/s, per-100k
chunk times 211…212 ms with no upward trend (L1 E5) — but that number is a tmpfs measurement and is
governed by §12; the *shape* (flat, not quadratic) is what task 1.3 must re-establish, not the rate.

`kv_event_bd` is an addition to L1's sketch, which had only the `BEFORE UPDATE` trigger. It is
required because L1's own E2 result shows that on the *interval* design a `DELETE` of a middle row
"silently opens a gap — no trigger objects." Under the event-log encoding a middle `DELETE` cannot
open a gap in the derived intervals (`LEAD()` simply re-links across it), but it *would* break Law
T1's gapless version chain and make `getAt({version})` return `null` for a version that really
existed. Append-only is asserted on both verbs.

---

## §3. T5(1): non-overlap, and why it needs no enforcement

Under §2's encoding, `valid_to` for version *v* **is** `written_at` of version *v+1*, by
construction of the view. Two intervals of one key overlap only if the derivation produces
overlapping ranges over a strictly increasing column, which it cannot. There is no column a bad
write could put a wrong upper bound into. **T5(1) is structural**: `Formal/STORAGE_ALGEBRA.md:213-217`'s
`MECHANISM SPECIFIED` (the `EXCLUDE` constraint) and `:332`'s status row are both rewritten.

### 3.1 The concurrency result, and why it is worth recording even though it is no longer needed

L1's E3 attacked the *trigger-based interval* design — the fallback, not this design — under two
real `sqlite3*` handles on one file with `busy_timeout=0`. It measured the check-then-insert TOCTOU
window closed at three observable points:

- `SQLITE_BUSY` (5) refuses a second simultaneous `BEGIN IMMEDIATE` — one writer, period;
- `SQLITE_BUSY_SNAPSHOT` (517) refuses a stale-snapshot reader upgrading to a writer;
- a fresh snapshot simply *sees* the committed competing row, so the trigger fires normally.

**Correction — I wrote "three independent ways" here and in the spec, and that word was wrong.**
Flagged by `v1.0.0-sqlite-concurrency-lease` as it closed its blocking gate. All three are
consequences of a single foundation, **write-lock exclusivity**, and they fail together rather than
degrading one at a time. Change 3 reproduced the `-shm` descriptor attack and measured that with
exclusivity voided: nothing raises `SQLITE_BUSY`, because both writers hold locks; fresh-snapshot
visibility also fails, because each assertion's snapshot predates the other's commit; and neither
commit is refused. Three independent guarantees would survive one of them failing. One guarantee
observed at three points does not. The honest label for the failure mode is **void, not weakened**,
and change 3 records it as the first entry in its limits list; §3.1 now leads with the qualifier for
the same reason.

Two things worth stating so the correction is not over-read. First, **the enforcement result is
untouched** — the six-cell attack below still holds; what changed is the strength of the *argument*,
not the outcome. Second, this is the same error class as the original `-shm` claim it corrects:
counting observations of one mechanism as independent mechanisms. That is precisely why change 3
flagged it rather than letting it stand, and why the correction belongs in the record rather than
being quietly edited away.

**A reconciliation worth recording, because the two findings look contradictory and are not.** The
red team reported that *"the main WAL database survived the fd-close attack"* — same `readFileSync`,
on `main.db`, under an open `BEGIN IMMEDIATE`, second writer still refused. That result and change
3's are both correct, because they attacked **different files**: in WAL mode the record locks live on
`-shm`, not on the main database. The red team's own sidecar table already contains the signal — its
`journal_mode=wal` row reads *"after read `.db`: refused; after read `-shm`: ACQUIRED"* — but it
applied that datum only to L2's lease sidecar and never carried it across to the main store's T5
argument. Change 3 carried it across. Nobody in the sprint was wrong; a fact was simply never
transported between two lanes.

The practical consequence for this change is the precondition, which is now stated in the spec rather
than assumed: no in-process code may open a descriptor on the database file or its `-wal`/`-shm`
sidecars. Change 3's build-failing source guard (its task titled "descriptor-ban source guard") is the mechanism, covering
path-building helpers and permitting metadata operations; I cite it rather than re-specifying it.

**The journal-mode gap I flagged as open question 4b is now closed, and the ruling is not the one I
expected.** I had framed it as a choice between extending the guard and narrowing my soundness claim
to `wal`. Change 3 measured all three modes with a control arm each, on ext4 with the ruled binding:

| mode | locks live on | read+close `.db` | read+close `-shm` |
|---|---|---|---|
| `wal` | `-shm` | harmless — competitor refused | **voids** → silent loss |
| `delete` | `.db` | **voids** → competitor commits; holder's own `COMMIT` fails | no `-shm` |
| `truncate` | `.db` | **voids** → silent loss, both `COMMIT`s acknowledged | no `-shm` |

and ruled on **expressibility rather than on which mode is safer**. A static source guard cannot be
journal-mode-conditional, because `journal_mode` is a persistent property of the file and mutable at
runtime — a build-time check has no way to know which mode a given file will be in. The only
statically expressible rule covering every mode is the **union**, so the guard now covers the
database file and both sidecars unconditionally, and **my all-modes claim stands unnarrowed**.

That is the better outcome on the merits too, and I had the trade backwards: narrowing to `wal` would
have given up rollback-journal mode's *stronger* exclusion — the reader's SHARED lock blocking the
competing writer outright — to avoid a build rule that costs UmbraDB nothing, since the engine opens
the database natively rather than through the Node filesystem API and change 5's backup is already
out-of-process.

**One asymmetry no corpus artifact recorded, and it is worth keeping.** Under `delete` the *holder's
own* `COMMIT` fails, because the competitor removed the rollback journal underneath it — so that mode
at least errors on one side. Under `wal` and `truncate` both commits are acknowledged and the loss is
**silent on both sides**. My negative controls distinguish the two, because "fails loudly" and "loses
a commit with no signal anywhere" are different hazards and only the second is undetectable without
the cross-path assertions §10.4 requires.

That is the sharp part: in PostgreSQL at READ COMMITTED the same `BEFORE INSERT` overlap-`EXISTS`
trigger is genuinely **unsound** under concurrency — two transactions each fail to see the other's
uncommitted row and both commit overlapping intervals. That is *why* `EXCLUDE` constraints exist:
they take predicate-style locks. On SQLite that race has no representation.

The red team attacked this across **3 journal modes × 2 busy-timeout settings** (L1 had tested one
cell, `wal`/`0`) and **it held in all six**, finding it *stronger* than L1 claimed:

```
journal_mode=wal      bt=0     A.insert:E517  rows=[{k,100,200}]  T5 holds
journal_mode=wal      bt=5000  A.insert:E517  rows=[{k,100,200}]  T5 holds
journal_mode=delete   bt=0     B.insert:E5    rows=[]             T5 holds
journal_mode=delete   bt=5000  B.insert:E5    rows=[]             T5 holds
journal_mode=truncate bt=0     B.insert:E5    rows=[]             T5 holds
journal_mode=truncate bt=5000  B.insert:E5    rows=[]             T5 holds
```

L1 wrote `PRAGMA journal_mode = WAL; -- required for E3's snapshot-upgrade refusal`. **It is not
required.** In rollback-journal mode the reader's SHARED lock blocks the competing writer outright
(errcode 5), which is a *stronger* exclusion than the WAL path. The single-writer assumption is not
load-bearing for T5.

**Why specify it at all, given §3's structural result?** Because the same three mechanisms are what
make the §2.2 `WellFormed` assertions sound under concurrent writers, and those assertions *are* the
remaining refinement obligation. The spec therefore records the enforcement together with the
journal modes it is valid under (`wal`, `delete`, `truncate`, at any `busy_timeout`) and the one
configuration that voids it: **shared-cache mode with `PRAGMA read_uncommitted`**. That last is
L1's open question 7 — an *inference, not a measurement* — and the spec handles it the only honest
way: by requiring the adapter to assert the mode is off at open, so the untested hazard is
unreachable rather than merely unlikely.

### 3.2 The negative that must survive in the record: the `EXCLUDE` transliteration is quadratic

The direct transliteration —
`WHERE EXISTS (SELECT 1 FROM h x WHERE x.k=new.k AND x.vf < new.vt AND new.vf < x.vt)` — is
**quadratic**, because the index on `(k, vf)` can only seek `vf < new.vt`, which for an
append-at-the-end workload is the key's entire history. L1 E4, `KEYS=1 TOTAL=50000`:

| variant | 50k rows | rate | slowdown vs unconstrained |
|---|---|---|---|
| none | 49 ms | 1,020,076 rows/s | 1× |
| `overlap_naive` (the `EXCLUDE` transliteration) | 70,647 ms | **708 rows/s** | **1,441×** |
| `overlap_neighbour` | 122 ms | 410,537 rows/s | 2.48× |
| `eventlog` | 83 ms | 602,802 rows/s | 1.69× |

Per-10k-chunk time for `overlap_naive` grows linearly — 2,653 → 8,425 → 16,988 → 23,929 ms — i.e.
it was **still falling at 50k versions**. This measurement was taken on tmpfs, which per §12 makes
every *rate* here void; but the red team's ruling is that a quadratic penalty measured on a RAM disk
is a **floor**, and gets worse on real storage, not better. It called the recommendation against the
naive transliteration "the best-supported conclusion in the sprint."

`overlap_neighbour` — restrict the check to the immediately adjacent intervals — is flat, and is the
fallback if the event-log encoding is ever abandoned. It carries a real cost that belongs in the
record: **it is sound only inductively.** It presupposes that non-overlap already holds among
existing rows. A GiST exclusion constraint presupposes nothing. That is a genuine, if subtle, loss
of strength, and it is a second reason to prefer §2.

---

## §4. T5(2): gap-freedom becomes structural — the enhancement

### 4.1 What is true today

`Formal/STORAGE_ALGEBRA.md:218-231` is explicit and is worth quoting rather than paraphrasing: the
`EXCLUDE` constraint *"only forbids overlap, it says nothing about gaps"*; contiguity holds *"by
construction of the trigger's write discipline"*; **Status: CALLER-ENFORCED** — *"it holds only as
long as the trigger remains the sole writer of `valid_from` on `kv_history` and `updated_at` on
`kv_current`; a manual `INSERT` bypassing the trigger could violate it and no constraint would catch
that."* The status table at `:333` says the same. `P5`
(`test/postgres/temporal-kv.property.test.ts:134-155`) is, in the algebra's own words, *"the only
thing that would catch a regression there."*

L1 confirmed this weakness is inherited by any interval-based SQLite design: an overlap trigger
accepts `[400,500)` after `[200,300)` without complaint, and a `DELETE` of a middle row silently
opens a gap (E2).

### 4.2 What becomes true

There is no `valid_to` column. `valid_to` for version *v* is `LEAD(written_at)` — *the next event's
own start*. Contiguity is not maintained; it is **the same value read twice**. A gap between
consecutive versions of one key is therefore not "rejected"; it is **unrepresentable**, in the
precise sense that no assignment of values to `kv_event`'s columns denotes one.

The formal counterpart is `Laws.lean:283` `adjacent_intervals_gap_free`, proved by bare structural
induction with **no hypothesis whatsoever** (§1). Gap-freedom does not even depend on `WellFormed`.

The spec states this as a first-class requirement with a *proving* scenario (attempt to create a
gap; observe that the derived `valid_to` equals the next `valid_from` regardless of what was
written) and a **negative control** describing the interval-table design that accepts one — because
the honest way to demonstrate that a hole is closed is to show the shape of the hole.

### 4.3 What a reviewer is owed for a strengthening — the commitments seat's ruling, honoured

T5(2) sits inside the frozen 1.0.0 Lean cut-line `{T3, T5, W1, C1}`
(`openspec/changes/v1.0.0-api-surface/proposal.md` G20). The commitments seat ruled (R4, *"A frozen
commitment that gets stronger is still a change"*) that changing the enforcement mechanism of a
frozen property — **even in the strengthening direction** — is a change a reviewer must be able to
audit, and specified exactly what is owed. This change adopts all of it as requirements, not as
prose:

1. **The refinement register row is rewritten, not carried over** — old mechanism struck, new
   mechanism named, **status label re-derived**: T5(1) `MECHANISM SPECIFIED (EXCLUDE)` →
   *structural*; T5(2) `CALLER-ENFORCED` → *structural*. The register lives at
   `openspec/changes/v1.1.0-formal-completion/design.md`, section "Refinement register & three
statuses", whose row schema is
   `{abstract-theorem, trusted-mechanism, (b)-hypothesis-or-(c)-test, voiding-precondition}` and
   which today splits T5(2) into `T5(2)-abstract` (proved) versus `T5(2)-refinement`
   (register (b): *trigger sole-writer*). That `(b)` hypothesis is exactly what this change
   discharges structurally, so the row's `(b)` entry must be **removed**, not softened.
2. **A new voiding precondition replaces the old one.** "A transaction pooler" is gone; the new
   precondition is *"a second writer process, a network filesystem, or a `-shm` on a filesystem
   without working shared memory"* — plus, from §3.1, *shared-cache mode with `read_uncommitted`*.
3. **The register is written BEFORE the port, not after** (commitments R4(iv)(6)): *"Written after,
   it documents what was built. Written before, it constrains it."* This is task 0.2, and it blocks
   task 2.1.
4. **A negative control ships with every surviving property** (commitments R4(iv)(5) and red team
   #7: *"what a reviewer is owed for a strengthening [is] the register row rewritten … plus the
   negative test that would have caught the old mechanism failing"*). The model is the crash
   harness's own: 9/9 held for the correct shape *and* the forbidden shape violated the invariant
   4/9 times — *which is the only reason 9/9 meant anything*. A migration is precisely the situation
   in which a re-executed test goes green for the wrong reason.
5. **P5 is re-executed against the `kv_validity` view, not amended.** Its current body reads
   `kv_history` directly (`test/postgres/temporal-kv.property.test.ts:143-147`) — a table that will
   not exist. Re-pointing it at the view is a rewrite of the diagnostic, and the rewritten
   diagnostic must be shown to *fail* against a deliberately gapped fixture before it is trusted
   against the real one.

### 4.4 The boundary of the enhancement: an encoding that cannot represent a gap cannot carry one

Found and measured by `v1.0.0-sqlite-data-migration` (change 7), and it qualifies the headline claim
of this change without weakening it. I did not state this consequence in the first three revisions of
this document, and the omission was the kind that reads as a strengthening right up until someone
runs an import.

**The asymmetry.** §4.2 says a gap is *unrepresentable*. That is exactly right, and it is exactly the
problem: unrepresentability is a two-way property. Going forward it means no write can produce a gap.
Going backward it means **no gap can be read in**. The same sentence is a guarantee about the future
and a constraint on the past, and only the first half was written down.

**Why gap-bearing sources are legal rather than pathological.** `kv_history_no_overlap`
(`src/postgres/migrations/001_temporal_kv.ts:97-99`) is an `EXCLUDE` constraint over
`validity WITH &&`. It forbids overlap. `Formal/STORAGE_ALGEBRA.md:218-231` says in terms that it
*"says nothing about gaps"*, which is the whole reason T5(2)'s status there is **CALLER-ENFORCED** —
and `src/postgres/temporal-kv.ts:230-241` already treats a *"manual/backfill `kv_history` row"* as a
live possibility, adding its `UNION`/`priority` tiebreak so that case is deterministic rather than
implementation-defined. So the source schema admits a hole by design, and this project has already
written defensive code against one.

**The worked case.** Versions `[1000, 2000)` and a live row from `3000`. `getAt({at: 2500})` → `null`
in the source; the key genuinely had no value then. Events at 1000 and 3000 in the target; `LEAD()`
gives `[1000, 3000)`; the same read → **version 1**. Change 7 measured that the row count, the
per-row value digests, and **every assertion this change specifies** pass while that happens. That
last clause is the uncomfortable one: my `kv_event_bi` version and clock assertions, my unique time
index, my append-only triggers and my `kv_validity` P5 diagnostic are all satisfied by the converted
store, because they check the *target's* internal coherence and a gap-bearing source converts to a
perfectly coherent target. **None of my checks can see this. That is the point of writing it down.**

**The reduction.** The event log stores one fewer degree of freedom per version than the interval
table: `valid_to` is not a column, it *is* the next version's `valid_from`. Where the source
satisfies `valid_to(v) = valid_from(v+1)` — change 7's **S3** — that column was redundant and nothing
is lost. Where it does not, `valid_to` carried information with nowhere to go. So the conversion is
faithful **exactly** on the S3-satisfying subset, which is the same predicate as gap-freedom. Change
7 verifies S3 per key rather than inheriting it from this adapter's triggers — correctly, since those
triggers constrain only data this adapter wrote, and the whole hazard is data it did not.

**What T3 means across the conversion, and the temptation to be avoided.** T3 is an equivalence
between one store's reads and a fold over *that store's* events. It does not compose across a
conversion: source and target can each satisfy T3 and still answer one query differently. The
formally honest observation is that the abstract model **cannot represent a gap either** —
`Model.lean:42`'s `History` is a list of events and `getAtTime` (`:95-106`) returns the last event at
or before the query, unconditionally — so a gap-bearing `kv_history` was never in the model's image
and the converted answer is the *model-conformant* one.

It would be easy, and wrong, to stop there and call the migration a repair. A migration's obligation
is to preserve what the store returned, not to correct it toward a model the store was never checked
against. A change to an observable read is a repair; repairs are chosen and recorded, never emitted
as a side effect of an encoding change. §4.4's requirement therefore makes the divergence
**observable** — asserted per key against the source's own answers — rather than leaving change 7 to
notice it downstream.

**Division of labour.** This change states the semantics: what the encoding can carry, what a T3
claim means across a conversion, and that structural checks on the target are not evidence. Change 7
polices the boundary: the per-key verification of all six preconditions, and the transport. I cite it
and do not specify it.

**One transport detail that is a T3 hazard and therefore not purely change 7's.** Change 7 measured
that `JSON.parse`/`stringify` destroys `12345678901234567890123` and
`0.1000000000000000055511151231257827`. I re-ran it rather than taking it on report:

```
$ node -e '...'
12345678901234567890123            -> 1.2345678901234568e+22   | preserved: false
0.1000000000000000055511151231257827 -> 0.1                    | preserved: false
two distinct stored texts that parse equal: true
```

The third line is the one that matters and is not in change 7's summary: `JSON.parse` maps two
*different* stored texts to the same JS value, so a fidelity oracle built on parsing does not merely
corrupt data — **it destroys the evidence that it corrupted it**, reporting equality between a
destroyed value and its replacement. Nothing in this change's scenarios may use a JS round trip as an
equality oracle for stored values. The frozen public boundary (`JsonValue`, `z.json()`,
`src/interfaces/temporal-kv.ts:97-107`) still parses, and that is unchanged and out of scope; what is
forbidden is using parsing as the *check*.

---

## §5. What the migration does to the refinement obligation

### 5.1 It shrinks

Today's obligation set: (a) the concrete store supplies a `WellFormed` event list; **and** (b) no
stored interval is unrelated to any event. (b) has no counterpart in `Model.lean` at all and is
discharged today by the GiST constraint. Under §2 there is no interval column, so (b) *disappears*
rather than being re-discharged. The obligation narrows to a single property — `WellFormed`, i.e.
strictly increasing `written_at` per key — enforced by one trigger and testable in isolation.

### 5.2 But the *character* of the evidence changes, and that must not be silent

The commitments seat found a second enforcement demotion that L1 did not name (R4(ii)). Today
`WellFormed` is discharged by a **database CHECK** —
`CONSTRAINT kv_history_range CHECK (valid_from < valid_to)`
(`src/postgres/migrations/001_temporal_kv.ts:96`), whose SQLSTATE 23514 *is* `CLOCK_REGRESSION`.
Under §2 it is discharged by the `kv_event_bi` trigger plus the unique index. **That is still
database-enforced** — L1 deserves the credit — *but*: if the §6 gate resolves toward the monotone
logical clock, the value being asserted is computed by `max(now_ms, prev+1)` in the same `INSERT`,
so on the happy path the assertion becomes vacuous. The trigger stops witnessing *"the clock
behaved"* and starts witnessing *"the adapter emitted the right SQL"*.

That is a real change in what the evidence means, and it is invisible in the status label. It is
recorded here, and §6's decision rule is written so the change is a *consequence of a measurement*
rather than a side effect of a design preference.

Note also the related blind spot: `Time` in the Lean is abstract, carrying only `[LinearOrder Time]`.
A `written_at` running 1.8 s ahead of wall time is perfectly `WellFormed`. **The Lean's continued
greenness is, specifically, silence about drift** — which is the one thing §6 is about.

### 5.3 A finding, not a deliverable

After this migration the TemporalKV refinement obligation is small enough to mechanise for the first
time. Both the red team (§4.8(b)) and the commitments seat (R4 note) say so. It is out of scope here
(see the proposal's non-goals) and is recorded so a future change can pick it up with the reasoning
attached. It is a claim about the *size* of an obligation nobody has discharged — not a discharge.

---

## §6. The clock: conditional, not settled

### 6.1 What SQLite actually gives (measured, capability-level, unaffected by §12)

- `unixepoch('now','subsec')` is **statement-scoped**, not transaction-scoped (L1 E1.2) — i.e. it
  behaves like `clock_timestamp()`, not like `now()`. This is the distinction
  `design/design.md` §2 and `Formal/STORAGE_ALGEBRA.md` §1's Law T4 note care about, and SQLite is
  *automatically* on the correct side of it. The `now()`-fixed-at-transaction-start defect that
  three independent reviewers found in the original Postgres design cannot recur.
- Resolution is a hard **1.000 ms** with no finer option at the SQL layer: 200,000 reads over 150 ms
  produced 147 distinct values, smallest nonzero tick gap 1.000 ms (L1 E1.1). This is exactly the
  precision UmbraDB already truncates to (`001_temporal_kv.ts:79`), so the resolutions match.
- Monotonicity across an NTP step was **not measured** — L1 says so itself (open question 1):
  the claim that `'now'` derives from `CLOCK_REALTIME` is a citation, not a measurement. It is the
  same hazard class as `clock_timestamp()`, so it is not a regression, and this design does not lean
  on it either way.

### 6.2 The inversion

L1's B3 headline: **99.2%** of 5,000 sequential same-key puts rejected (`4961/5000`, E8a). It
proposed a per-key monotone logical clock, `written_at := max(now_ms, prev + 1)`, which accepted
5,000/5,000 (E8b) with drift measured at 0 ms at 10/100/1,000 puts/s and ~1,794–1,858 ms after an
unthrottled 2,000-put burst (E9b).

The red team re-ran the same shape across four durability configurations, on ext4:

```
WAL/OFF     5000 attempts in    40 ms -> accepted   40, rejected 4960 (99.2%)
WAL/NORMAL  5000 attempts in    44 ms -> accepted   45, rejected 4955 (99.1%)
WAL/FULL    5000 attempts in 36150 ms -> accepted 5000, rejected    0 ( 0.0%)
DELETE/FULL 5000 attempts in 36413 ms -> accepted 5000, rejected    0 ( 0.0%)
```

At `synchronous=FULL` a commit costs ~7.2 ms, so two sequential same-key puts **cannot** land in the
same millisecond and the collision rate is **zero**. L1 never varied the pragma and never named it.
`synchronous=FULL` is today's contract. The entire clock crisis — the logical clock, the drift, the
`CLOCK_REGRESSION` re-pointing, and the coupled loss of the accidental same-transaction guard — is
downstream of one setting.

**Ruling for this change: the logical clock is neither adopted nor rejected here.** It is made
conditional on a measurement, because that is what the evidence supports. Specifying it as settled
in either direction would be inventing a fact.

### 6.3 The decision rule (normative)

Let **R** be the rejection rate of the strict-increase assertion, measured as: *N* ≥ 5,000
back-to-back unconditional `put`s to one key, each its own autocommitting transaction, no throttle,
against a database file on a **real (non-tmpfs) filesystem**, at the `journal_mode` and
`synchronous` values that `v1.0.0-sqlite-engine-core` selects as UmbraDB's shipped defaults, with
the dataset size relative to page cache recorded.

- **IF R = 0** — the logical clock **SHALL NOT** be adopted. `written_at` is the truncated SQL wall
  clock; the `kv_event_bi` strict-increase assertion remains a live witness that the clock behaved;
  `CLOCK_REGRESSION` keeps both its documented causes and its `conditional` marking
  (`docs/ERROR-CATALOG.md:73-89`) untouched, which is the outcome that costs change 5 nothing.
- **IF R > 0** — the implementation **SHALL** adopt exactly one of, and record which:
  - **(a)** the per-key monotone logical clock, *together with* a configured maximum-drift threshold
    that raises a typed error when `written_at − wall_clock` exceeds it. The drift bound is not
    optional decoration: it converts an unbounded quantity into a bounded, observable one, and it
    gives `CLOCK_REGRESSION` a **second live cause**, which is what preserves its `conditional`
    marking. Without it, the marking narrows to `non-retryable` and `docs/ERROR-CATALOG.md:13`
    forbids that in terms ("no `retryable` marking is **weakened**"). This is the item no research
    lane caught and it is free only pre-tag.
  - **(b)** a change to the shipped `synchronous`/`journal_mode` default that brings R to 0, with
    the durability consequence written down and ruled on by change 5.
- **Until the gate reports, no implementation task that depends on the policy may start**, and this
  spec **SHALL NOT** be read as having adopted either option.

The rule is falsifiable on its face: a reviewer can point at the gate's recorded R and at the shipped
`written_at` expression and say whether they agree.

### 6.4 Microsecond storage is ruled out, and widening the field buys nothing

`VersionedEntry.writtenAt` is a JS `Date` (`src/interfaces/temporal-kv.ts:153`), pinned to
`VersionedEntrySchema`'s `writtenAt: z.date()` (`:143`) by a real mutual-assignability
`AssertExact` guard (`:156-163`), and `AsOf`'s `{kind:"at"; at: Date}` (`:179-181`) must round-trip
against it. `Date` is millisecond-quantised. L1 measured the boundary loss directly:
`new Date(1785521264259.4443).getTime() = 1785521264259` (E9c). So sub-millisecond storage is ruled
out **by the frozen G1 API, not by SQLite** — L1's framing, and it is correct about the field.

The commitments seat added the part that closes the question (R6, Option B1): **widening the field
buys nothing**, because the *source* is 1.000 ms at the SQL layer regardless (§6.1). A
`writtenAt: bigint` in microseconds would still need the monotone clock and would still drift — it
would just cost a hard break of `VersionedEntry`, `AsOf.at`, `VersionedEntrySchema` and the
`AssertExact` guard for no gain. An additive `writtenAtMicros?: bigint` is worse: two coordinates
that can disagree. **Ruling: keep `writtenAt: Date`.** Not because changing it is expensive — pre-tag
it is nearly free — but because it does not fix the thing it looks like it fixes.

### 6.5 What `writtenAt` means, if (a) is ever taken

Recorded here so the decision is not re-litigated from scratch later. The frozen surface **already**
disclaims wall-clock semantics, in TSDoc that ships in `dist/index.d.ts`
(`src/interfaces/temporal-kv.ts:171-177`): the coordinate is *"not a true transaction commit or
visibility timestamp; commit-time refinement remains a separate obligation."* A monotone logical
clock satisfies the promise the surface actually makes — a strictly increasing per-key coordinate
that agrees with version ordering — and falsifies exactly one clause of it: *"the coordinate is
`clock_timestamp()` at statement/trigger execution."* T3, T4 and T5 are all internal to the
coordinate and none is weakened, because `getAt({at})` compares against the *same* coordinate. The
exposure is entirely external: `Date.now() - entry.writtenAt` can go negative, a TTL keyed on
`writtenAt` expires late by the drift, and correlating `writtenAt` against a chain block timestamp
mis-orders events inside the drift window. The honest documented sentence is: *`writtenAt` is a
store coordinate that is usually wall time and is never behind it; it must not be used as a clock.*
The doc text is change 5's; the mechanism and the drift bound are this change's.

---

## §7. The transaction-identity guard: what is guaranteed, and by what

### 7.1 The loss, stated precisely

`updated_xact bigint NOT NULL DEFAULT txid_current()`
(`src/postgres/migrations/001_temporal_kv.ts:80`) and
`IF OLD.updated_xact = now_xact THEN RAISE … ERRCODE 'UB001'` (`:117-124`) are what
`Formal/STORAGE_ALGEBRA.md:78-95` calls *"the correct, mechanical detector"*, stressing it must not
be built on a timestamp. Routed at `src/postgres/errors.ts:273-277` to `TransactionKeyReuseError`.

SQLite has no SQL-visible transaction identity (L1 E0). L1 tested three substitutes:

- an adapter-supplied token column — **trivially forged**, the caller passes a different value;
- an SQL-derived identity (an `autoincrement` `txn` table the adapter appends to once per `BEGIN`,
  read by the trigger) — correct on the happy path, **defeated by one extra `INSERT INTO txn`**
  (E9a). Strictly stronger than the token; strictly weaker than `txid_current()`, which no statement
  can move;
- move the guard into the adapter (a per-transaction write-set in memory) — the only option that
  reproduces the exact semantics, at the cost of being application code.

**Ruling: the adapter write-set.** `TRANSACTION_KEY_REUSE` — a frozen `code`
(`docs/ERROR-CATALOG.md:25`) — moves from database-enforced to adapter-enforced. The code, its class
and its `non-retryable` marking all survive; its *unforgeability at the SQL layer* does not.

### 7.2 What the red team found, and the precise guarantee that results

L1 called this *"the one unavoidable strict weakening in the lane."* The red team attacked it and
**the attack failed**: with UmbraDB holding `BEGIN IMMEDIATE`, an attacker connection opened on the
same database path was refused (`errcode 5`) and could not bump the counter. Its ruling:

> **the credit belongs to UmbraDB owning the handle, not to the worker** — any design where the
> caller receives an opaque `TransactionHandle` instead of today's `UmbraDBSql` achieves it. The
> residual hole is any escape hatch that runs caller-supplied SQL on the transaction's connection
> (L3 counts 2 live `sql.unsafe` sites); close those and the guard is as unforgeable as
> `txid_current()` in practice.

So the precise, falsifiable statement — and the one the spec makes — is a conjunction with named
parts, not a claim of database enforcement:

1. The detection itself is **adapter code** (an in-memory per-transaction write-set). No SQL
   mechanism detects it. Say so.
2. Forgery from **outside** the transaction is prevented by **`BEGIN IMMEDIATE` holding a
   whole-database write lock**, measured: a competing connection is refused with `SQLITE_BUSY`.
   **This inherits §3.1's correction** — that refusal *is* write-lock exclusivity, not a second,
   independent barrier, so the same in-process descriptor open-and-close that voids the trigger
   assertions' foundation voids this too, and they fail together. The red team's forgery attack
   failed for exactly this reason and therefore carries exactly this precondition. **This claim is
   listed in change 3's inheritance table (cited by its section title, "Inheritance table")**, which enumerates everything in the
   program resting on write-lock exclusivity — the writer-generation fail-stop, ordering 2, the
   migration lock's cross-process exclusion, `prune`'s C2a re-derivation, and this change's two — and
   rules that any such claim stated without the qualifier is a **specification defect**. Cite the
   table; do not restate the qualifier locally. Change 3 built it after finding a second instance of
   the same over-claim one section away from the one it had just fixed, which is the argument for a
   register over per-instance patching.
3. Forgery from **inside** the transaction is prevented **if and only if** no caller-reachable path
   executes caller-supplied SQL on the transaction's connection. That precondition is a *named
   voiding precondition*, and the spec requires it to be asserted by a guard test rather than
   assumed — mirroring the existing `no-sdk-import-guard.test.ts` family.

### 7.3 The coupling that must not be lost

L1 B4's mitigating finding: on the event-log schema the guard is *mostly redundant*, because the
strict-clock assertion already rejects a same-transaction second write — both land in one
millisecond (E8d). **But that is enforcement by accident of clock resolution**, and it evaporates
under §6's option (a): with a monotone clock the second write is accepted again. L1 states the
coupling as *"you cannot take B3's fix without paying B4's cost."*

Therefore: the adapter write-set is required **unconditionally**, regardless of how §6 resolves. It
is not conditional on the gate, because relying on the accidental version would make a frozen
guarantee a function of a pragma.

---

## §8. `RAISE` semantics: `ABORT`, never `ROLLBACK`

Measured (L1 E6): with `RAISE(ABORT)` **and** `RAISE(FAIL)`, after the guard fires
`db.isTransaction === true`, further writes succeed, and `COMMIT` **succeeds**. SQLite does **not**
poison a transaction after a failed statement — a caller can swallow the error and commit. That is a
real difference from PostgreSQL, whose own documented behaviour ("current transaction is aborted,
commands ignored until end of transaction block") the merged spec already records.

The refinement that matters here, and which L2 could not make from outside the temporal lane:
**`ABORT` reverses the entire statement, including anything the trigger body itself wrote.** In L1's
E6 the rejected write left no trace: non-overlap, gap-freedom and history-meets-live all still held
on disk after the swallowed error and the successful commit. **The store-level T5 invariant survives
a swallowed error.** What is lost is *caller atomicity*, not T5.

Two consequences, both normative:

- **The history write must stay inside one statement.** The T5-breaking version of this hazard
  exists only if the adapter splits one logical put across two statements. Under §2.1 there is
  exactly one statement, which is why §2.1 is written the way it is rather than as an
  insert-then-update pair.
- **`RAISE(ROLLBACK)` is banned.** It is not the fix and it is *worse*. Measured (L1 E7a): it does
  end the transaction — and leaves the connection in **autocommit**. Work done before the failure
  was rolled back; a subsequent write by an unaware caller was **accepted and committed on its
  own**; and the caller's `COMMIT` then failed with "cannot commit - no transaction is active".
  Silent partial persistence outside any transaction is a strictly worse failure mode than a
  swallowable error.

Sticky-poison emulation for *caller atomicity* is change 3's (`transaction-lease`). This change
records that **T5's soundness does not depend on it**, so it is not a blocking dependency here — and
records that `docs/CONTRACT.md`'s durability clauses *do* depend on it, so it is not optional
overall.

---

## §9. `INSERT OR REPLACE` is banned in the adapter

Measured (L1 E10):

```
ON CONFLICT DO UPDATE  -> BEFORE UPDATE trigger DOES fire (history row written)
INSERT OR REPLACE      -> BEFORE UPDATE trigger NEVER fires (history row silently lost)
INSERT OR IGNORE       -> does NOT swallow RAISE(ABORT)  (safe)
PRAGMA ignore_check_constraints=on -> disables CHECK, does NOT disable triggers
```

`INSERT OR REPLACE` performs DELETE+INSERT, so it never fires a `BEFORE UPDATE` trigger. This is not
a hypothetical: `put()`'s unconditional case uses exactly the `ON CONFLICT DO UPDATE` shape today
(`src/postgres/temporal-kv.ts:119-124`), and a porter reaching for the "obvious SQLite equivalent"
lands on `INSERT OR REPLACE`. Under §2's append-only table the DELETE half would also be caught by
`kv_event_bd` — but the ban is specified independently of that, because the guard must survive a
future schema that reintroduces an updatable row.

Note the asymmetry the same experiment found, which cuts *in SQLite's favour* and belongs in the
record: `PRAGMA ignore_check_constraints=on` disables `CHECK` constraints but **not** triggers. On
SQLite a trigger assertion is therefore *harder* to bypass than a `CHECK` — which is a second reason
`CHECK (valid_from < valid_to)` (`001_temporal_kv.ts:96`) becomes a trigger assertion rather than a
`CHECK` under §2.2. (`DROP TRIGGER` remains an escape hatch, but so is
`ALTER TABLE … DROP CONSTRAINT` in PostgreSQL; that is not a regression.)

---

## §10. Read paths and the surviving adapter contracts

### 10.1 The four reads

| Method | SQL shape | Notes |
|---|---|---|
| `get` | `WHERE ns/scope/key = … ORDER BY version DESC LIMIT 1` | PK-ordered seek. §2's open item: benchmark at 1M versions/key (task 1.4). |
| `getAt({version: v})` | `WHERE … AND version = :v` | PK seek. The `UNION`/`priority` tiebreak is deleted. |
| `getAt({at: T})` | `WHERE … AND written_at <= :T ORDER BY written_at DESC LIMIT 1` | Covering-index seek on `kv_event_time`. This is `getAtTime` (`Model.lean:95-106`) — *last write at or before T* — directly. |
| `listKeys(prefix)` | ordered scan over `kv_event`, adjacent duplicates skipped | With `kv_current` gone, "newest version only" is no longer free. **This one is not a one-line change — see §10.3.** The prefix predicate is change 4's; the streaming transport is change 1's. |

L1 retracted its own contrary read-path measurement (E7b): a reported 30,077 µs/read against the
interval table was an artefact of a missing index, not an inherent property. Corrected, the read
paths are comparable (5.5 µs interval vs 3.8 µs event-log at 1M rows/key, tmpfs). **The read path is
not a differentiator between the designs; the write path is.** Recording the retraction matters
because the retracted number, if carried forward, would have been a false argument for this change.

### 10.2 What does **not** change

- **`VersionConflictError.actual` still cannot be derived from a row count.** The merged spec's
  requirement stands verbatim in substance: zero-rows is ambiguous between "conflict" and "never
  written", and the adapter re-reads to distinguish. Only the row-count *source* changes, from
  `UPDATE … RETURNING`'s affected rows (`src/postgres/temporal-kv.ts:147-166`) to `changes()` after
  the §2.1 `INSERT … SELECT … WHERE`.
- **Boundary validation** (`ValidationError`, `MAX_JSON_DEPTH`, the NUL/lone-surrogate refusal at
  `src/interfaces/temporal-kv.ts:28-38`) is unchanged in *contract*. That the underlying reason
  changes engine — SQLite stores lone surrogates as U+FFFD and NUL bytes desynchronise `length()`
  rather than being rejected outright — is change 1's silent-corruption trap list, and it makes the
  existing boundary check *more* load-bearing, not less. Recorded, not re-specified.

### 10.3 `listKeys`: the read whose contract had to be re-derived, not assumed

Raised by the coordinator after change 4's author found the requirement unowned and declined to take
it silently. It is a `temporal-kv` requirement, so this change owns it. It went through two revisions
in one sitting, and both are recorded because the reversal is instructive.

**Revision 1 (superseded).** I narrowed the streaming promise, reasoning that the current contract's
strongest clause is backed by a real Postgres-protocol cancellation —
`Query.prototype.cancel()` (`src/postgres/temporal-kv.ts:346`), added after a cross-vendor re-audit
found `iterator.return()` alone was a **silent no-op** before the first batch arrived (`:277-289`) —
and that SQLite has no counterpart. That reasoning was sound on the information available and its
conclusion was wrong, because it inferred the *lazy-iteration* question from the *cancellation*
question.

**Revision 2 (current), on change 1's measurement.** `v1.0.0-sqlite-engine-core` measured its ruled
binding's `iterate()` against a 200,000-row table on a real filesystem and established that it is
**genuinely lazy**: the first row is available in a small fraction of the time full materialisation
takes, and a batched drain completes without any single batch dominating. Change 4's characterisation
("a `postgres.js` server cursor with no SQLite analogue") described `StatementSync` — the binding
that was *rejected* — and is superseded. **The streaming promise therefore stands unweakened**, and
change 1 offered this as a finding rather than imposing it. I take it, and I record that the earlier
narrowing was mine and was wrong.

**What actually changes, property by property.**

1. **At most once per key — preserved, different derivation, one new hazard.** `listKeys` returns
   `AsyncIterable<Key>` (`src/interfaces/temporal-kv.ts:331-334`), so "newest version only"
   (`:314-315`) is observably just "each key at most once". Today that is free: `kv_current` holds one
   row per key. Under §2 the log holds N rows per key, so dedup becomes real work — and the naive
   `SELECT DISTINCT key … ORDER BY key` risks a planner-chosen temp B-tree. That would materialise the
   result set **below the driver**, somewhere no transport choice can rescue it, which is exactly the
   failure a lazy `iterate()` is supposed to prevent. The robust shape does not depend on the planner:
   the primary key is `(ns, scope, key, version)`, so an index-ordered range scan already yields keys
   sorted with duplicates adjacent, and the adapter skips repeats in O(1) memory. The spec states the
   obligation and admits either shape. **`listKeys` must not be evaluated over `kv_validity`** — the
   window function introduces a buffering step, and a query that returns no interval data has no
   reason to pay for it.
2. **Ordering — preserved as a property, but it is a different order.** Postgres orders `text` by the
   database collation; SQLite's default is `BINARY`. The collation is change 4's; the caller-facing
   consequence is this change's: **a resume cursor persisted under the old ordering is not portable
   across the migration.** Free pre-tag (`docs/STABILITY.md:46`), a break to documented behaviour
   after.
   Change 4's subtlety, checked as a property of the encodings rather than taken on report: `BINARY`
   compares UTF-8 bytes and UTF-8 byte order is code-point order, while JavaScript compares UTF-16
   code units. Supplementary-plane characters are surrogate pairs in `U+D800`–`U+DFFF`, which sort
   **below** `U+E000`–`U+FFFF` as code units and **above** them as code points. The two orderings
   disagree on exactly that pair of cases, and the lone-surrogate rejection
   (`src/interfaces/temporal-kv.ts:28-38`) does not help, because both strings are well-formed.
   Consequence: the adapter must not compute a pagination boundary in JavaScript.
3. **Stream liveness — this is the strengthening, and it is a real one.**

**The hazard first, because it is worse than the one originally flagged.** While an iterator is open
the handle **refuses writes** — reads still pass. Under PostgreSQL the cursor lived on a *pooled*
connection: a half-consumed `listKeys` cost one connection and blocked nobody. Under change 1's
single-handle worker it blocks **every write in the process**. And the stream's lifetime belongs to
the consumer, who may simply stop iterating.

The current code already concedes the shape of this at `src/postgres/temporal-kv.ts:291-298`: a
generator suspended at `yield` "isn't running any code to notice", and "no async generator can be
'pushed' from outside without the consumer resuming it." It closes by calling this "a standard,
accepted limit of the async-iterator protocol, not something specific to this method." That framing
was correct **when the cost of the limit was a leaked pooled connection.** The cost is now a wedged
writer. Same limitation, different consequence — and a limitation whose consequence has changed
class is not something a migration may inherit by citing the old acceptance of it. This is the
sharpest thing in the whole `listKeys` seam and neither the old TSDoc nor my revision 1 caught it.

**The strengthening.** Change 1 did not translate the old design; it reallocated responsibility.
Stream liveness moves from the consumer to the **worker**, via a worker-enforced idle deadline that
releases the iterator unilaterally. PostgreSQL could not do this: the suspended generator was the
only party in a position to act, which is precisely why the old TSDoc had to call the gap structural.
The caller-visible consequence — the part that belongs in my requirement rather than change 1's — is
that **an abandoned stream becomes a failed read instead of a stalled writer.** I claim it, cite
change 1 for the mechanism, and do not restate the mechanism.

**One correctness point that only this lane would catch.** A deadline that ends the iteration
*normally* would be a silent-truncation bug: `{done: true}` is indistinguishable from "there are no
more keys", so a caller enumerating keys for deletion, reconciliation or migration would act on a
short list with no error anywhere. The spec therefore requires the release to surface as a **fault on
the next resumption**, never as a normal ending, and carries that as a negative control.

**On batching.** Change 1 filed the batch size as a blocked decision and marked both existing figures
inadmissible as justification, because both are in-process and exclude the worker hop. Revision 1 of
this section priced the abort loss as `batch size × per-row scan cost`; that pricing is **withdrawn**
— it referenced a number that does not exist and that change 1 has ruled cannot yet be justified. The
spec now references the batching *obligation* only, and no criterion in `acceptance.md` is satisfied
or falsified by a particular size.

**Spec craft borrowed from change 1.** The streaming scenario asserts a **ratio between two timings
measured in the same run** (time-to-first-key ≤ 5% of time-to-drain, at ≥100k matching rows) rather
than an absolute latency. A materialise-first implementation drives that ratio toward 1, so the
negative control fails a *test* rather than a review — and the assertion is hardware-independent,
which also satisfies §12's rule against carrying absolute numbers into requirements.

**What this change still does not decide:** the batch size, the transport, and the deadline's
duration. Those are change 1's. The requirement is written so that any of its choices either
satisfies the stated promises or visibly fails them.

### 10.4 Class B invariant I-3: `getAt` asserts its bound through a second b-tree

Distributed by `v1.0.0-sqlite-durability-contract` with its reasoning attached, and the reasoning is
what makes it worth having rather than the rule.

**What a digest cannot see.** Change 5's digest regime covers the stored value **in the table row**.
An index entry is an independent copy of the key columns in a different b-tree. Damage the index copy
while leaving the table row intact and every digest verifies clean, the row's contents are entirely
valid, and the query still returns the wrong row. That is Class B — a wrong answer with no corrupted
value anywhere — and it is precisely the gap the digest regime does not close. `PRAGMA
integrity_check` can in principle detect index/table divergence, but it is a full-database scan and
is not on the read path; SQLite offers no main-database page checksums to fall back on.

**Why this lands hardest here.** `getAt` **is** Law T3. `getAtTime` (`Model.lean:95-106`) is the
mechanised statement, and the `{at}` read is its concrete counterpart. A wrong-row answer at `getAt`
is a false answer from the one law the formal layer actually carries — and per §1 the Lean gate
cannot see it, because the gate certifies the derivation and the store's job is only to supply a
`WellFormed` event list.

**The assertion, and why it is the property rather than a proxy for it.** The `{at}` seek goes through
the time index `(ns, scope, key, written_at)`. Before returning, the adapter re-reads the candidate
**by primary key** `(ns, scope, key, version)` — a different b-tree — and asserts both halves of
"last event at or before `T`":

1. `written_at(candidate) <= T`;
2. the successor version is absent, or `written_at(candidate + 1) > T`.

Those two conjuncts *are* `getAtTime`'s definition, so this is not a heuristic sanity check that
happens to catch some corruptions — it is the query's own correctness condition, evaluated through an
independent path. Both halves are needed and neither is redundant: a damaged index that returns a
version which is too *late* fails (1), and one that returns a version which is too *early* passes (1)
and fails (2). Checking only the bound would accept a stale-but-valid row, which is a wrong answer
that looks right. Cost is two index seeks (change 5's costing) — a correctness decision, not a
performance trade.

**Where it composes with the rest of this change.** T3 does not compose across a **conversion**
(§4.4) and it does not compose across an **index** either. In both cases the answer must be compared
rather than inferred — from the target's internal coherence in the first case, from a single b-tree's
say-so in the second. Both failures are silent, both pass every other check this change specifies,
and both are caught only by an explicit comparison against an independent source of the same fact.
That is the same shape twice, and it is worth naming as a pattern rather than as two coincidences.

**The residual, named.** I-3 as distributed covers the `{at}` path. The mirror hazard — a damaged
primary-key index with an intact time index, corrupting `getAt({version: v})` — is not closed by it.
Law T4's dual-addressing property exercises both paths against each other, but as a sampled property
test rather than a read-time assertion. Recorded in §13 as open question 4b rather than left to be
found later.

### 10.5 Self-audit: does anything in this change report success on a zero-row statement?

Prompted by the coordinator's observation that the same silent-success shape has now appeared three
times in this sprint — the `errcode` catch-all, change 3's unseeded `UPDATE`, and the
deadline-ends-iteration-normally case in §10.3. I swept my own assertions for it. Two findings, one
benign-but-load-bearing and one a real hole I have tightened.

**1. The write statement is sound, and the reason is worth recording.** §2.1's
`INSERT … SELECT … WHERE <guard>` produces exactly zero or one rows, and zero occurs *iff* the CAS
guard is false. Zero rows is therefore treated as **failure** (`VersionConflictError`), never success,
and the follow-up read is what distinguishes conflict from absence. No hole — but note the property
that makes it safe is that the statement has exactly one filter. Any future predicate added to that
`WHERE` would make `changes() = 0` ambiguous between "CAS failed" and "the new predicate excluded the
row", and the error would then be misreported. That constraint is now stated rather than implicit.

**2. The clock assertion passes vacuously when its predecessor row is missing — and its safety rests
on a sibling.** `kv_event_bi`'s second statement compares `NEW.written_at` against
`coalesce((SELECT written_at … WHERE version = NEW.version - 1), <min sentinel>)`. If the predecessor
row does not exist the subquery matches zero rows, `coalesce` yields the sentinel, the comparison is
false, and **no assertion fires**. That is a zero-row-means-success path. It is safe *only* because
the version assertion is the first statement in the same trigger body and rejects any chain gap
before the clock assertion is reached. The safety is real but it is an **ordering dependency between
two assertions**, not a property of the clock assertion itself — so reordering the trigger body, or
lifting the clock check into a separate trigger, would silently break it. Recorded in the spec as a
constraint on the assertion order rather than left to be rediscovered.

**3. The open-time schema probe was genuinely under-specified, and I have tightened it.** The
append-only requirement said the adapter "SHALL verify that the assertions exist in the schema". A
natural implementation queries `sqlite_schema` and treats *no error* as success — which is exactly
the shape: a query matching zero rows reports success and the adapter opens a database with no
assertions on it. The requirement now demands the probe assert an expected **count**, and that a
zero-row result be treated as absence rather than as confirmation. This was a real defect in my own
spec, found by applying the coordinator's question to it.

I-3's own "fails closed, never open" scenario is the fourth instance of the same discipline: a
zero-row re-read through the primary-key index is evidence of divergence, not of agreement, and must
raise rather than fall back to the time index's answer.

---

## §11. Evidence and conformance

- **P1–P5 are re-executed, not amended.** `test/integration/required-tests.manifest.json` carries 25
  required ids, structurally pinned by `EXPECTED_REQUIRED_COUNT = 25` so that silently deleting or
  adding one fails the gate. Per the commitments seat: use that mechanism as designed, and **do not
  edit the pinned count in the same commit as any deletion** — that converts a reviewed contract
  change into a diff nobody reads.
- **P5 is rewritten against `kv_validity`** and must be shown to fail against a gapped fixture
  before it is trusted (§4.3(5)).
- **A new property is needed and did not exist before**: append-only enforcement (`kv_event_bu` /
  `kv_event_bd`). It has no Postgres counterpart because the Postgres schema had no append-only
  table.
- **A green Lean gate is not evidence.** See §1's trap-9 note. No acceptance criterion in this change
  is satisfied by Lean CI.

---

## §12. The measurement caveat that governs every number in this document

Six of the seven research lanes benchmarked against `/tmp`, which on the research host is a **32 GB
tmpfs RAM disk**. Re-measured on ext4, WAL `synchronous=FULL` went from a published 88,485 commits/s
to **379** — a 233× error. Consequently:

- **No throughput, latency or rate quoted here is carried into a requirement as fact.** Where a
  requirement depends on a performance property, it is written as a requirement to *establish* the
  number under stated conditions (filesystem, `synchronous`, `journal_mode`, dataset size relative
  to page cache), not as an assertion of it.
- The numbers that survive re-measurement in *kind* are recorded as shapes, not values: the
  `EXCLUDE` transliteration is **quadratic** (a floor, per §3.2 — it gets worse on real storage);
  the event-log write path is **flat**; the read paths are **comparable**.
- Three classes of result here are **not** affected by the tmpfs error, because they are semantic,
  not I/O-bound, and the red team classified them as such: every syntax/capability probe (L1 E0),
  the `errcode` mappings, the `RAISE` non-poisoning behaviour, `SQLITE_BUSY_SNAPSHOT` behaviour, and
  the trigger/`OR REPLACE` bypass matrix (L1 E10).
- **The one inversion this change is built around** is §6.2's: L1's 99.2% is 0.0% at
  `synchronous=FULL`.

---

## §13. Open questions this change deliberately leaves open

1. **The clock policy** — open by construction; §6.3 is the rule that closes it, and the gate is
   change 1's.
2. **`get()` at 1M versions of one key** — L1 believes it is a covering-index seek and did not
   confirm it (its open question 3). Task 1.4 measures it.
3. **Clock monotonicity across an NTP step** — never measured by anyone in the sprint (L1 open
   question 1). Under §6.3's R = 0 branch, `CLOCK_REGRESSION`'s backward-step cause remains
   *documented but never demonstrated*, exactly as today. This is not a regression, and it is not a
   discharge either.
4. **Shared-cache mode** — asserted-off rather than tested (§3.1, L1 open question 7).
   *(Former open question 4b — descriptor-guard coverage under rollback-journal modes — is **closed**;
   change 3 ruled for the union guard and my all-modes claim stands unnarrowed. See §3.1.)*
4b. **The symmetric index hazard on `getAt({version: v})`.** §10.4's cross-path assertion (Class B
   invariant I-3) protects the `{at}` path by re-reading through the primary-key index. The mirror
   case — a damaged **primary-key** index with an intact time index, corrupting a `{version}` read —
   is **not** closed by it. Law T4's dual-addressing property exercises both paths against each
   other, but as a sampled property test, not as a read-time assertion. Named rather than left to be
   discovered: it is the residual of I-3 as distributed.
5. **The idle deadline's duration, and the batch size** — both change 1's. The deadline's *duration*
   is a liveness/usability trade this change does not price: too short truncates a legitimately slow
   consumer, too long leaves writers blocked. What this change fixes is the *shape* — the release
   must fault, never end normally — so any duration change 1 picks is safe against silent
   truncation. The batch size is change 1's open decision, and no criterion here turns on it.
6. **Whether the transaction-hold bound and the `listKeys` idle deadline can interact.** A `listKeys`
   issued with `opts.tx` is subject to both — change 3's hold bound on the transaction and change 1's
   idle deadline on the iterator — and nothing in the sprint says which fires first or what a caller
   observes if they race. Both individually produce a fault rather than a silent truncation, so the
   dangerous outcome is excluded either way; the *identity* of the error a caller sees is
   unspecified. Flagged rather than invented: it is a cross-change question and neither change 1 nor
   change 3 has been asked it.
7. **Real per-key put rate during wallet sync** — the empirical question that decides whether §6's
   drift would ever be observable at all if option (a) were taken. It is a question about the
   consumer, not about SQLite, and nobody in the sprint owned it.
