# Gate notes — Task 6: differential state-equivalence gate (G11)

Close-out record for `tasks.md` §6 (`design.md` §5; `01` checklist item 4; `council/B` §1; `02`-T11).
The rescoped G11 gate is two in-repo halves; both are now satisfied.

## 6.1 — P3 is the differential gate's replay-equivalence / fold anchor (documentation, no new test code)

**P3** (`test/postgres/temporal-kv.property.test.ts`, "P3 (Law T3): `getAt({at})` matches a
from-scratch fold of the put sequence, for an arbitrary T"; `Formal/STORAGE_ALGEBRA.md` §5) IS the
differential gate's **replay-equivalence / fold-equality half**. It asserts, over fast-check-generated
put sequences, that reading as-of an arbitrary time `T` equals folding the sub-sequence of writes with
`writtenAt ≤ T` — i.e. the state you recover by replaying the log up to `T` equals the state the store
reports. That is exactly the "replay a prefix of the write sequence and get the same state" property the
original §10 differential gate diffed a foreign store to obtain.

**No-import rationale (why P3 needs no replaced/foreign store).** `01` checklist item 4 found the
original §10 gate blocked by a **missing subject** — the store it diffed against ("the Mongo store …
is not in this repo"). P3 obtains the replay-equivalence guarantee **entirely from UmbraDB's own
adapter + a plain, from-scratch reference fold written inline in the test** (see the test's own comment:
"Plain, from-scratch reference fold — NOT the code under test"). It imports **nothing** from any
consumer/indexer/wallet application and needs no second engine to diff against: the fold reference is a
few lines of array `filter`/`reduce`, and the subject is `PgTemporalKV.getAt`. So the fold-equivalence
half of the differential gate is met without importing the replaced store — honouring the
indexer-agnostic boundary (`design.md` §4; `ROADMAP` G11; acceptance G1/G3).

**Manifest binding.** P3's manifest-reserved id is `[[property.p3.replay-fold-equivalence]]`
(`required-tests.manifest.json` → `required`). Task 6.1 added that `[[…]]` token to the P3 test title
(title-only; **P3's logic is unchanged**) so the skip-enforcement check (`check-required-tests.ts`)
binds and enforces it. P3 is green in the required gate:
`npx vitest run test/postgres/temporal-kv.property.test.ts` passes.

## 6.2 — fault-schedule differential (`test/postgres/differential-equivalence.test.ts`)

**Unblocked — G5 is merged** (co-transactional `save({tx})` / `saveAndAdvance`; `design.md` §2.3
post-G5 note). The test:

- **Seeded, mixed fault schedule.** A fixed `SEED` drives a `mulberry32` PRNG + a seeded Fisher-Yates
  shuffle (never `Math.random`) to produce a reproducible schedule of numbered write batches, mixing
  the three G9 faults — **T1** (process-kill mid-save, `before-commit` SIGKILL), **T2** (Postgres-kill
  mid-save, `pg_terminate_backend` of the worker's in-flight backend), **T5** (crash between data and
  cursor, `after-data-commit-before-cursor` SIGKILL) — with fault-free (`none`) batches interleaved.
  The base multiset guarantees ≥1 of each fault, so all three are genuinely exercised; the schedule is
  logged for reproducibility.
- **Recovery = a real resume from durable state.** After each fault the run re-reads the **durable
  cursor** and re-applies the batches at/after it through UmbraDB's own adapters — the idempotent resume
  a consumer performs on restart — converging the fault run to the fully-synced state.
- **In-repo reference (no foreign import).** The reference is a **fault-free replay of the same
  schedule via UmbraDB's own adapters** (`PgTemporalKV` + `saveAndAdvance` over
  `PgCheckpointStore`/`PgWatermarks`) into a **separate** wallet — the same §2.3 keystone reference
  discipline `cursor-durability.crash.test.ts` uses. It is **not** a copy of the fault run and **not**
  an imported engine. (`test/postgres/reference-merge.ts` is the transaction-**history** merge stand-in;
  it does **not** model KV/checkpoint/watermark current state, so — per the Task 5.1 note and the
  keystone discipline — the current-state reference is built from the adapters, not from
  `reference-merge.ts`. This resolves the `design.md` §5 wording that named `reference-merge.ts`: the
  file exists as `01` observed, but is the wrong model for this state, so the keystone reference
  discipline is followed instead. Import-cleanliness is asserted by a static audit of the test's own
  imports.)
- **Current-state-only equality (exhaustive predicate).** Equality is judged on **current state only**:
  the full `kv_current` row set (every `ns/key → value`) + the full `watermarks` row set (every
  `kind → value`) + the **latest complete checkpoint payload bytes**. `kv_history` rows and `version`
  columns are **excluded** (they legitimately diverge because replay re-applies version-bumping upserts
  and writes duplicate manifests — `council/B` §1); that divergence (more complete manifests; higher kv
  `version` for a re-applied key) is asserted **explicitly**, not hand-waved.
- **Negative control (mandatory, has teeth).** A deliberately-broken variant genuinely **drops a
  committed range** — it skips the recovery step of one faulted (data-dropping T1) batch, so that
  batch's `kv_current` datum never lands and the cursor marches past it — and the test confirms the
  current-state equality assertion **FIRES** (throws) on that real divergence, proving the check would
  catch a fault that dropped a range.

**Manifest reconciliation.** The test carries `[[differential.fault-schedule.state-equivalent]]`, added
to `required-tests.manifest.json` → `required` (it is a required, non-live test). The
skip-enforcement check now tracks it by id.
