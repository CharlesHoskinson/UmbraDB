# Algebraic Specification of the midnight-pg-store Storage Layer

Grounded in a structural analysis of Midnight's real ledger-v8 primitives
(`ZswapLocalState`, `MerkleTreeCollapsedUpdate`) and an audit of this
project's own interfaces against them (2026-07-20). One structure, four
faces. Each module is a distinct algebra over a shared transactional
substrate; the transaction layer is what makes the other three's laws hold
at all.

Notation: `S` = state set, `·` = right action of an event on state, `E*` =
free monoid of events under concatenation, `π` = observation projection,
`⊑` = semilattice order. "GUARANTEED" = enforced today by a schema
constraint, trigger, or type; "ASPIRATIONAL" = stated as intent but not yet
enforced by any constraint or test.

**Grounding fact this whole document builds on:** `(State, applyEvent)` for
Midnight's real `ZswapLocalState` is a right action of the free monoid `E*`
on the state set `S` — `replayEvents` is `foldl apply` over an event list,
and it is a *partial* action, well-defined only when events are applied in
strict index order from the current `firstFree`. `applyCollapsedUpdate` is a
monoid homomorphism onto an "index-skip" submonoid, and its correctness
requires the induced action commutes with direct replay up to an
observation projection π (spendable coins, `firstFree`, roots) —
observational equivalence, not full state equality. `DustLocalState` has no
such homomorphism. Everything below applies the same lens to our own
storage layer.

---

## 1. TemporalKV — event-sourced right action with a CAS guard

**Signature.** For each key `k = (ns, scope, key)`, a state
`S_k = (value: Json, version: ℕ⁺, writtenAt: Time)`, plus a bottom `⊥`
(never written). The event set is `Put(value, expectedVersion?)`. Define

    apply : (S_k ∪ {⊥}) × Put → (S_k ∪ {⊥}) ∪ {conflict}

`replayEvents = foldl apply ⊥` — the same free-monoid right action as
`ZswapLocalState`, but here the monoid element is a caller-issued put, not a
ledger event indexed on a global tree.

**Law T1 — gapless monotonicity (algebraic content of "gapless").** For
successive non-conflict states `s, s' = s · Put`,
`s'.version = s.version + 1`, with `⊥ · Put` producing `version = 1`. This
is exactly `firstFree`'s "only index i+1 reachable from i," but enforced
*operationally* (server assigns current+1) rather than *structurally*. Two
concurrent `put`s could each read version `v` and both attempt `v+1`; only
serialization prevents a gap or a duplicate. **Status: GUARANTEED only
inside a transaction / writer-lease; ASPIRATIONAL otherwise** — nothing in
the type system forbids a race.

**Law T2 — CAS as a guarded partial action.**
`put(k, v, expectedVersion=e)` is defined iff `e = current.version` (or
`e = 0n` ∧ current = ⊥); otherwise it yields `conflict`
(`VersionConflictError(e, actual)`), leaving state unchanged. This is the
ledger's *partial action* pattern — `s · w` defined only when `w` starts at
`s`'s current index — with `expectedVersion` playing the role the index
plays structurally in the ledger. Omitting `expectedVersion` makes the
action *total* (unconditional write), which is precisely where T1 can
silently break under concurrency. **Status: GUARANTEED** (the guard is a
`WHERE version = e` in the UPDATE; a mismatch affects 0 rows).

**Law T3 — temporal-projection / observational equivalence.** Let
`events(k)` be the committed put-sequence. Then

    getAt(k, at=T)  =  fold(events(k) filtered to writtenAt ≤ T)

i.e. a read-as-of-T must equal replaying only the events at or before T.
This is *the same property* the ledger's `applyCollapsedUpdate` homomorphism
must satisfy — `π ∘ collapse = π ∘ replay` — applied to our own design, with
`π` = "the value + version live at T." In Postgres it is discharged by the
`[valid_from, valid_to)` interval read (`valid_from ≤ T < valid_to`), which
*is* the fold, precomputed. **Status: GUARANTEED for `getAt` reachable
within retention; ASPIRATIONAL beyond it** — `pg_cron` history deletion caps
how far back T3 holds, so `getAt` past the retention window silently
violates it (returns `null`/stale rather than the true fold).

**Law T4 — dual-addressing agreement (a genuine, currently-unenforced
law).** `AsOf` is `{version: v} | {at: T}` — two projections `π_v` and `π_T`
of the same history. They must agree at commit instants:

    getAt(k, {at = commitInstant(v)})  =  getAt(k, {version = v})

The design maintains **two separate intervals** — a version interval and a
wall-clock `tstzrange` — over the same rows. Agreement is only guaranteed if
`valid_from` of version `v` equals exactly the `writtenAt`/`updated_at` used
as the version boundary. The trigger sets `valid_from = OLD.updated_at`, so
alignment *depends on the trigger being the sole writer of both columns*.
**Status: ASPIRATIONAL** — assumed by construction, enforced by no
constraint. A property test (P4 below) is the only thing that would catch
drift.

**The `tstzrange` + `GiST EXCLUDE` upgrade as an algebraic law.** Replacing
the app-trigger `CHECK (valid_from < valid_to)` with

    EXCLUDE USING gist (ns WITH =, scope WITH =, key WITH =, validity WITH &&)

makes **non-overlap of a key's history intervals a database-enforced
invariant**, not prose. Law T5 — *temporal coherence*: for a fixed `k`, the
set of `[valid_from, valid_to)` intervals partitions its lifetime with no
overlap and no gap other than pre-creation. Overlap ⇒ T3 is ill-defined (two
rows match one `T`). Today overlap is merely *not produced* by the trigger
(**ASPIRATIONAL**); under EXCLUDE it becomes **GUARANTEED** — the DB rejects
the second write. This is the single highest-value change: it moves T5 from
"trust the trigger" to "the engine cannot represent a violation," the same
way the ledger makes races unrepresentable structurally rather than merely
checked.

---

## 2. CheckpointStore — idempotent join-semilattice with a reachability closure

**Chunk write is idempotent.** `writeChunk(h, d)` via
`INSERT … ON CONFLICT (hash) DO UPDATE SET created_at = now()`.
Content-addressing gives `f(f(x)) = f(x)` on the `(hash → data)` map:
writing the same hash twice leaves `data` unchanged (only the GC clock
refreshes). **Status: GUARANTEED** — `hash` is PK, `data` never overwritten
with different bytes because equal hash ⇒ equal content.

**Law C1 — chunk store is a join-semilattice.** The global chunk set
ordered by ⊆ has `save` = join (`chunks' = chunks ∪ newChunks`), idempotent
(`x ⊔ x = x`, dedup by hash) and commutative (two wallets saving overlapping
chunks in either order reach the same set). Manifests never mutate a chunk,
so joins never conflict. **Status: GUARANTEED.**

**Law C2 — GC reachability closure (restate so it can't regress).** Let
`Live` = all manifests surviving prune, `refs(m)` = `m.chunk_hashes`. A
chunk `c` may be physically deleted **iff** `c ∉ ⋃_{m ∈ Live} refs(m)`.
Equivalently: `survivors = ⋃ refs(Live)` is closed — GC must never delete a
member of it. The refcount/scan runs in the manifest-write transaction, so
no concurrent `save` resurrects a reference mid-reclaim; the 15-minute grace
window covers `ON CONFLICT DO UPDATE` re-references whose manifest INSERT is
still uncommitted. **Status: GUARANTEED by the same-transaction scan + grace
window** (this is the dedup/GC race already fixed earlier this session; C2
is its regression guard).

---

## 3. Watermarks — trivial last-write-wins (deliberately *not* event-sourced)

**Law W1.** `set(kind, key, v)` is idempotent overwrite:
`set(set(x, v), v) = set(x, v)`; `get` returns the last `set`. There is no
version, no history, no fold — contrast T1/T3 directly: TemporalKV keeps
`events(k)`; Watermarks keeps only `last`. This is a **deliberate algebraic
choice**: a sync cursor needs current progress, not lineage, so the design
drops the entire event-sourced structure rather than carrying dead
versioning. Monotonicity is explicitly *not* a law here (callers hold a
lease if they need it). **Status: GUARANTEED** (single-row upsert).

---

## 4. Transaction / Lease — the control algebra the other three run inside

**Law L1 — mutual exclusion.** For any lease `key`, `|holders(key)| ≤ 1` at
every instant. `withLease` acquire→run→release, backed by a
`sql.reserve()`-pinned advisory lock. **Status: GUARANTEED** by the
pinned-connection advisory lock (the design's earlier fixed blocker); breaks
only under a transaction-pooling proxy, which the deployment forbids.

**Atomicity envelope — which laws are conditional.** `withTransaction` is
the boundary within which the data algebras' laws hold:

| Law | Holds unconditionally | Conditional on serialization |
|---|---|---|
| T1 gapless monotonicity | — | **yes** (concurrent puts must serialize) |
| T2 CAS guard | yes (atomic `WHERE version = e`) | — |
| T3 temporal projection | yes, per committed history | — |
| T4 dual-addressing | — | yes (both intervals written in one tx) |
| C1 join / C2 closure | — | **yes** (scan + write same tx) |
| W1 LWW | yes | — |

The lease is *coarse* mutual exclusion (writer role); the transaction is
*fine* atomicity. T1 needs both: a lease serializes writers to a key-space,
the transaction makes read-current-then-write-current+1 atomic.

---

## 5. Testable-law deliverable (fast-check + Vitest)

Each maps to an `fc.property` over arbitrary event sequences. **G** = would
catch a real regression today; **A** = documents intent, needs the noted
enforcement first.

- **P1 (T1, G):** for any `put` sequence to one key in one tx, emitted
  versions are exactly `1,2,3,…` — no gap, no repeat.
- **P2 (T2, G):** for random `expectedVersion e`, `put` succeeds iff `e` =
  current version, else throws `VersionConflictError` and state is
  unchanged.
- **P3 (T3, G):** for a random sequence with timestamps and a random `T`,
  `getAt({at:T})` equals folding the sub-sequence with `writtenAt ≤ T`.
- **P4 (T4, A→G):** for every committed version `v`,
  `getAt({version:v}).value === getAt({at: commitInstant(v)}).value`. *This
  is the law currently only assumed* — P4 is the sole guard on
  dual-addressing drift.
- **P5 (T5, A→G):** generate interleaved writes; assert no two history
  intervals for one key overlap. Fails today only if the trigger is buggy;
  under the `GiST EXCLUDE` upgrade the DB enforces it and P5 becomes a
  redundant confirmation (keep it as the migration's acceptance test).
- **P6 (C-idempotence, G):** writing the same `(hash,data)` twice leaves
  `data` identical and chunk count unchanged.
- **P7 (C1, G):** for two random chunk multisets saved in either order, the
  resulting chunk set is identical (commutative idempotent join).
- **P8 (C2, G):** after random save/prune sequences,
  `deletedChunks ∩ ⋃ refs(Live) = ∅` — no reachable chunk is ever reclaimed.
- **P9 (W1, G):** `get` after N random `set`s to one key returns the last
  value; `set·set` of equal value is indistinguishable from one.
- **P10 (L1, G):** under concurrent `withLease` on one key, an instrumented
  critical section never observes overlap (holder count ≤ 1).

**Bottom line.** Seven of ten laws (T2, T3, C-idempotence, C1, C2, W1, L1)
are GUARANTEED by constraints/transactions already in the design and their
tests would catch regressions immediately. Three (T1, T4, T5) are the fault
lines: T1 depends on serialization discipline, T4 and T5 depend on the
trigger being the sole coherent writer of two parallel interval
representations. Adopting the `tstzrange` + `GiST EXCLUDE` constraint
converts T5 from trigger-trust to engine-guarantee and gives T4 a firm
boundary to align against — the one change that moves the layer's most
fragile law from aspirational to structural, mirroring how the ledger makes
its linearity unrepresentable-to-violate rather than merely checked.

---

## 6. On not adding a Merkle/authenticated data structure

Separately researched and reviewed: for this single-writer, local,
non-Byzantine wallet cache, a Merkle/authenticated-data-structure layer is
**not warranted as a general addition** — every production precedent found
(Certificate Transparency logs via Trillian, Ethereum's state trie, Sui's
object store) exists to let mutually-distrusting third parties verify state
independently of the operator, a problem this deployment does not have.
AES-GCM's own auth tag already gives tamper-evidence for the encrypted
blobs at the point they're written and read by the trusted process that
holds the key.

This is a threat-model-conditional conclusion, not a categorical one — the
review that checked this research flagged, correctly, that it does not
address (a) an attacker or corruption bypassing the DB entirely and editing
Postgres's on-disk files directly (row-level tags are re-verified only on
the trusted writer's own read path, not against an independent root), or
(b) a future "export this checkpoint and let someone else verify it"
requirement, which would flip the threat model to the exact
external-verifier case Trillian/CT solve. Both are logged here as accepted,
named risks under the current threat model, not dismissed as non-issues —
revisit if either becomes a real requirement.

The SHA-256 content-addressing already in `CheckpointStore` (Law C1) is,
incidentally, already a rudimentary authenticated structure for chunk
integrity (a chunk's hash IS a proof of its own content) — the open
question this section answers is only whether to go further and build a
Merkle tree of manifests/checkpoints on top of it. The answer, under the
current threat model, is no.
