# Algebraic Specification of the midnight-pg-store Storage Layer

Grounded in a structural analysis of Midnight's real ledger-v8 primitives
(`ZswapLocalState`, `MerkleTreeCollapsedUpdate`) and an audit of this
project's own interfaces against them (2026-07-20). One structure, four
faces. Each module is a distinct algebra over a shared transactional
substrate; the transaction layer is what makes the other three's laws hold
at all.

**Revision note (this version):** a cross-vendor Codex GPT-5.6 Sol audit,
run independently of the Opus review that approved the previous version,
found this document mathematically self-contradictory: Law T4 as
originally stated is impossible to satisfy given P1 permitted multiple
same-key writes inside one transaction (Postgres's `now()` is fixed at
transaction start, so two such writes share one recorded timestamp — no
timestamp-based lookup can then distinguish them). It also found T3's
retention interaction makes `null` ambiguous between "never existed" and
"pruned away," that T5 only ever had a non-overlap guarantee not the
gap-freedom it claimed, that L1 cannot hold for arbitrary caller code once
TTL/lease-stealing is in the picture, and that "GUARANTEED" is a dishonest
label before any of this is actually implemented. All fixed below — this
is a structural revision, not a wording pass. See git history for the
prior version if the before/after is useful.

Notation: `S` = state set, `·` = right action of an event on state, `E*` =
free monoid of events under concatenation, `π` = observation projection,
`⊑` = semilattice order.

**Status labels (replacing the previous "GUARANTEED"/"ASPIRATIONAL"
scheme, which claimed things were guaranteed before any implementation
existed):**
- **MECHANISM SPECIFIED** — a concrete schema constraint, trigger
  discipline, or type-level device is specified in this document that would
  enforce the law once actually built and tested; not yet true of any
  running system.
- **CALLER-ENFORCED** — holds only if callers/implementers follow a
  documented rule; no schema constraint or type forbids violating it.
- **OPEN** — not yet resolved by this document; requires a decision before
  implementation.

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

**Structural rule, introduced by this revision, that everything else in
this section depends on: at most one `put` to a given key `k` may occur
within a single database transaction.** A second `put` to the same key in
the same transaction MUST be rejected (not silently accepted, not silently
merged) — enforced at the trigger level (§ implementation note below), not
merely documented. This exists because Postgres's `now()` is fixed at
transaction start and constant for the transaction's entire duration; two
writes to the same key in one transaction would otherwise be
indistinguishable by wall-clock timestamp, which is exactly the defect that
broke Law T4 in the prior version of this document (below).

**Implementation note (normative for the Postgres adapter) — corrected
after a follow-up review found this paragraph still describing the
abandoned mechanism.** The `BEFORE UPDATE` trigger on `kv_current` must
check, before doing anything else: `IF OLD.updated_xact = txid_current()
THEN RAISE EXCEPTION ...`, where `updated_xact bigint NOT NULL DEFAULT
txid_current()` is a column dedicated to this check — NOT a comparison on
`updated_at`. This distinction matters because `updated_at` itself is
`clock_timestamp()`-derived (§ Law T4 below), which changes on every
statement and would therefore never equal a prior write's value even within
the same transaction — a same-transaction detector built on `updated_at`
would simply never fire. `txid_current()`, by contrast, is the current
transaction's ID: constant across every statement within one transaction
(including across `sql.begin()`'s savepoint-based nesting) and distinct
across different transactions (returned as the 64-bit epoch-extended id, so
32-bit wraparound is not a practical collision risk). `OLD.updated_xact =
txid_current()` is therefore true if and only if `OLD` was itself written
earlier in the currently-executing transaction — the correct, mechanical
detector this rule needs. See `design/design.md` §2 for the exact DDL.

**Law T1 — gapless monotonicity (algebraic content of "gapless").** For
successive non-conflict states `s, s' = s · Put`,
`s'.version = s.version + 1`, with `⊥ · Put` producing `version = 1`. This
is exactly `firstFree`'s "only index i+1 reachable from i," but enforced
*operationally* (server assigns current+1) rather than *structurally*. Two
concurrent `put`s could each read version `v` and both attempt `v+1`; only
serialization (row-level locking on `UPDATE`, which Postgres provides
per-row regardless of transaction wrapping) prevents a gap or a duplicate.
**Status: MECHANISM SPECIFIED for single-key serialization** (Postgres's
own row lock on `UPDATE ... WHERE key = ...` already serializes concurrent
writers to the *same* row without needing an explicit transaction wrapper);
**OPEN for cross-key/writer-role coordination** (nothing here specifies
what happens if two independent processes are meant to act as a single
logical writer — that is the Transaction/Lease module's job, not
TemporalKV's, and is out of this document's scope until that module
exists).

**Law T2 — CAS as a guarded partial action.**
`put(k, v, expectedVersion=e)` is defined iff `e = current.version` (or
`e = 0n` ∧ current = ⊥); otherwise it yields `conflict`
(`VersionConflictError(e, actual)`), leaving state unchanged. This is the
ledger's *partial action* pattern — `s · w` defined only when `w` starts at
`s`'s current index — with `expectedVersion` playing the role the index
plays structurally in the ledger. Omitting `expectedVersion` makes the
action *total* (unconditional write). **Status: MECHANISM SPECIFIED** — the
guard is a real `WHERE version = e` predicate in a plain `UPDATE` statement
(NOT an `INSERT ... ON CONFLICT`, which cannot express "fail when the row
is absent" — this exact confusion caused the original CAS-guard bug found
and fixed earlier this session); a mismatch affects 0 rows, and the caller
distinguishes "conflict" from "never written" by a follow-up read, not by
row-count alone.

**Law T3 — temporal-projection / observational equivalence, scoped to
retention.** Let `completeEvents(k)` be the complete chronological sequence of
accepted puts to `k`. In the PostgreSQL representation, that sequence is the
bounded rows in `kv_history` followed by the live row in `kv_current`; the live
row is an event and MUST NOT be omitted from the projection. Retention may
remove only an oldest prefix, producing a nonempty `availableEvents(k)` suffix
that still contains the live event. Then, for any `T` at or after the derived
`oldestAvailableAt` floor:

    getAt(k, at=T)
      = shiftVersion(prunedCount(k),
          fold(availableEvents(k) filtered to writtenAt ≤ T))
      = fold(completeEvents(k) filtered to writtenAt ≤ T)

Here `shiftVersion(n, entry)` adds the removed-prefix length `n` to the local
suffix-fold version; the suffix fold MUST NOT restart externally visible
versions at one. Exact-version lookup has the corresponding derived
`oldestAvailableVersion` floor, preserves the original one-based version
numbers after pruning, and agrees with the complete sequence at and above that
floor. A version above the live version is absent; a time after the live event
returns the live event.

For `T` older than that retention floor, `getAt` MUST NOT return `null` or
stale data as if the key had never existed at `T` — that conflates "never
existed" with "existed, but the record was pruned," which the interface's
own documented contract for `get`/`getAt` (absence ⇒ `null`) does not
permit conflating. Instead, `getAt` for a `T` older than the retention
floor MUST throw a distinct error carrying the actual floor
(`HistoryUnavailableError { oldestAvailableAt, oldestAvailableVersion }` —
already part of the TemporalKV error hierarchy), so a caller can distinguish
"this key never existed at T" from "this key's history at T was pruned and
is no longer knowable." **Status: MECHANISM SPECIFIED within retention**
(the `[valid_from, valid_to)` interval read is the fold, precomputed);
**OPEN beyond retention until PostgreSQL floor metadata, coherent floor/result
classification, and adapter error wiring are implemented** — the error type
exists, but no retention mechanism (`pg_cron` or partitioning) may be enabled
until those refinement obligations land.

**Law T4 — dual-addressing agreement at recorded write timestamps.** `AsOf` is
`{version: v} | {at: T}` — two projections `π_v` and `π_T` of the same
history. Every successfully persisted version carries a distinct, strictly
increasing `clock_timestamp()`-derived coordinate named `writtenAt(v)`. The
one-write-per-key-per-transaction rule and same-key row-lock serialization are
the operational assumptions that make those coordinates distinct. The law is:

    getAt(k, {at = writtenAt(v)})  =  getAt(k, {version = v})

`writtenAt(v)` is a recorded statement/trigger-execution timestamp, not the
actual transaction commit or visibility instant. T4 deliberately makes no
claim about lookup at a true commit instant. A refinement theorem relating
recorded write time to commit/visibility time remains deferred. **Status:
MECHANISM SPECIFIED**, conditional on successful persistence, enforcement of
the one-write-per-key-per-transaction rule, strict same-key timestamp increase,
and use of `clock_timestamp()` rather than transaction-stable `now()`.

**Second residual caveat, found only by actually running the implementation
(no prior review — Opus or cross-vendor — caught this one, since it only
manifests when you observe real `Date` round-tripping, not from reading the
design):** Postgres `timestamptz` carries microsecond precision; JS `Date`
carries only milliseconds. A caller who reads `writtenAt` back from `put`
or `get` and passes it into a later `getAt({at: ...})` call is handing back
a value already truncated the moment it left Postgres — if the stored
instant were left at full microsecond precision, the round-tripped,
millisecond-truncated `Date` could land strictly *before* the true
`valid_from`, making the interval-containment lookup miss the row entirely
(T4 broken in practice, not merely the visibility-timestamp distinction
above). Fix: `updated_at`/`valid_from`/`valid_to` are stored ALREADY
truncated to millisecond precision (`date_trunc('milliseconds',
clock_timestamp())`, `migrations/001_temporal_kv.ts`), so the value read
back and the value round-tripped are bit-for-bit identical. This narrows,
rather than eliminates, the same-key-serialization argument above: two
writes to the *same* key in different transactions landing within the same
truncated millisecond now collide (the older write's `valid_to` and the
newer's `valid_from` become numerically equal, tripping
`kv_history_range`'s `CHECK (valid_from < valid_to)`, SQLSTATE `23514`,
translated to `ClockRegressionError`) — far rarer than the bug it replaces
(requires sub-millisecond-apart *serialized* writes to one key, not just a
backward clock step), and explicitly accepted here rather than silently
possible.

**Law T5 — temporal coherence, now split into its two actually-distinct
parts.** For a fixed `k`, the set of `[valid_from, valid_to)` intervals in
`kv_history` (plus the live `kv_current` row) must:
1. **Never overlap.** Two rows matching the same `T` would make T3
   ill-defined. **Status: MECHANISM SPECIFIED** — the
   `EXCLUDE USING gist (ns WITH =, scope WITH =, key WITH =, validity WITH &&)`
   constraint makes this a database-enforced invariant Postgres itself
   rejects a violation of; this is genuinely mechanism-backed, not just
   trigger discipline.
2. **Never leave an unintended gap.** This is a SEPARATE guarantee from
   (1) — the EXCLUDE constraint only forbids overlap, it says nothing about
   gaps, and the two are logically independent (a schema could easily have
   neither, one, or both). Gap-freedom here holds **by construction of the
   trigger's write discipline**, not by any database constraint: each new
   history row's `valid_from` is set to `OLD.updated_at`, which is exactly
   the `valid_to` (or `kv_current.updated_at`) that the *previous* write to
   this key set — so the chain of intervals is contiguous by the trigger
   always reusing the prior write's boundary value as the next row's start.
   **Status: CALLER-ENFORCED** (specifically, "trigger-enforced" — it holds
   only as long as the trigger remains the sole writer of `valid_from` on
   `kv_history` and `updated_at` on `kv_current`; a manual `INSERT` bypassing
   the trigger could violate it and no constraint would catch that). Do not
   conflate this with (1)'s database-level guarantee.

---

## 2. CheckpointStore — idempotent join-semilattice with a reachability closure

**Chunk write is idempotent.** `writeChunk(h, d)` via
`INSERT … ON CONFLICT (hash) DO UPDATE SET created_at = now()`.
Content-addressing gives `f(f(x)) = f(x)` on the `(hash → data)` map:
writing the same hash twice leaves `data` unchanged (only the GC clock
refreshes). **Status: MECHANISM SPECIFIED** — `hash` is PK, `data` never
overwritten with different bytes because equal hash ⇒ equal content.

**Law C1 — the *save-only* chunk projection is a join-semilattice (not the
full store, which also prunes).** The chunk set considered only under
`writeChunk`/`save` operations, ordered by ⊆, has `save` = join
(`chunks' = chunks ∪ newChunks`), idempotent (`x ⊔ x = x`, dedup by hash)
and commutative (two wallets saving overlapping chunks in either order
reach the same set). **This does not extend to the full store**: `prune`
removes chunks, so the store as a whole (save + prune) is not a monotone
semilattice — only the write-side projection is. **Status: MECHANISM
SPECIFIED** for the save-only projection.

**Law C2 — GC reachability, split into safety (unconditional) and eventual
collection (conditional) — conflating these was the original bug.** Let
`Live` = all manifests surviving prune, `refs(m)` = the chunk hashes `m`'s
junction-table rows reference (see `design.md` §3's `ckpt_manifest_chunks`
table, which replaced an array-of-hashes column this document originally,
incorrectly, assumed a GIN index could accelerate).
- **C2a (safety, unconditional):** `Deleted ∩ ⋃_{m ∈ Live} refs(m) = ∅` —
  GC never deletes a chunk any live manifest references. This must hold at
  every instant, not just eventually.
  **Status: MECHANISM SPECIFIED** — the refcount/scan runs in the same
  transaction as the manifest write it needs to see, so no concurrent
  `save` can resurrect a reference mid-reclaim.
- **C2b (eventual collection, explicitly conditional — this is where the
  original "survivors = closed set, chunk deleted iff unreachable" wording
  overclaimed):** an unreachable chunk older than the grace window is
  *eventually* deleted, **not** immediately upon becoming unreachable — the
  grace window is a deliberate, intentional delay (a TOCTOU guard for a
  chunk mid-re-reference by a not-yet-committed `save`), so "deleted iff
  unreachable" was never literally true and should not be restated as if it
  were. **Status: MECHANISM SPECIFIED**, conditional on a GC pass actually
  running periodically (a scheduling concern, not an algebraic one).

---

## 3. Watermarks — trivial last-write-wins (deliberately *not* event-sourced)

**Law W1.** `set(kind, key, v)` is idempotent overwrite:
`set(set(x, v), v) = set(x, v)`; `get` returns the last `set`. There is no
version, no history, no fold — contrast T1/T3 directly: TemporalKV keeps
`events(k)`; Watermarks keeps only `last`. This is a **deliberate algebraic
choice**: a sync cursor needs current progress, not lineage, so the design
drops the entire event-sourced structure rather than carrying dead
versioning. Monotonicity is explicitly *not* a law here (callers hold a
lease if they need it). **Status: MECHANISM SPECIFIED** (single-row
upsert) — conditional on the stored value actually being losslessly
JSON-representable, which an earlier `WatermarkValueSchema` draft (a
`z.record(z.string(), z.unknown())` shape admitting non-JSON-safe values
like nested `bigint`/`undefined`/`Date`) did NOT guarantee; fixed by
rebuilding `WatermarkValueSchema` on the shared `JsonValueSchema`
(`src/interfaces/watermarks.ts`, already applied).

---

## 4. Transaction / Lease — the control algebra the other three run inside

**Law L1 — mutual exclusion, simplified after review found the original
design couldn't actually deliver it.** For any lease `key`,
`|holders(key)| ≤ 1` at every instant. **The original design's `ttlMs`
self-expiry and lease-stealing semantics are REMOVED from this interface**
— a lease is held from `acquireLease`/`withLease` until either explicit
`releaseLease` or the holding connection closes, full stop, with no
self-expiry and no fencing-token machinery. The review that caught this
was exactly right: TTL-based expiry makes L1 impossible to guarantee for
*arbitrary* caller code, because `withLease`'s callback has no way to learn
its lease was stolen mid-execution and stop — guaranteeing that would need
a monotonic fencing token, a lease-loss `AbortSignal`, and every downstream
write checking the fencing token, none of which this project needs yet for
a single-process, single-writer deployment. Simpler is correct here: no
TTL, no stealing, so L1 holds unconditionally for as long as the holding
connection lives. Revisit only if a real multi-process/crash-recovery
requirement appears. **Status: MECHANISM SPECIFIED** by the
`sql.reserve()`-pinned advisory lock (the design's earlier fixed
connection-pool blocker); breaks only under a transaction-pooling proxy,
which the deployment forbids.

**Atomicity envelope — which laws are conditional.** `withTransaction` is
the boundary within which the data algebras' laws hold:

| Law | Holds unconditionally | Conditional |
|---|---|---|
| T1 gapless monotonicity | yes, per-key (row lock) | cross-key/writer-role coordination is OPEN |
| T2 CAS guard | yes (atomic `WHERE version = e`) | — |
| T3 temporal projection | yes, within retention | PostgreSQL pruning, floor metadata/classification, and error wiring are OPEN |
| T4 dual-addressing at `writtenAt` | yes, for successfully persisted writes | strict same-key timestamp increase and one-write-per-key-per-tx enforcement |
| T5(1) non-overlap | yes (EXCLUDE constraint) | — |
| T5(2) gap-freedom | — | yes, trigger remains sole writer of the boundary columns |
| C2a safety | yes (same-tx scan) | — |
| C2b eventual collection | — | yes, a GC pass actually runs |
| W1 LWW | yes | — |
| L1 mutual exclusion | yes, for the life of the connection | — |

---

## 5. Testable-law deliverable (fast-check + Vitest)

Each maps to an `fc.property` over arbitrary event sequences. Several of
these are **not testable through the public interface alone** — this was a
real finding, not a stylistic nitpick: a production interface should not
grow adapter-only methods just to make a property test possible, so P5–P8
below require adapter-private conformance diagnostics (a test-only export,
clearly marked as such, not part of the public `TemporalKV`/`CheckpointStore`
surface).

- **P1 (T1):** for any sequence of sequential, top-level (not
  transaction-wrapped — the one-write-per-tx rule means this property no
  longer needs a shared transaction to exercise T1 at all) `put`s to one
  key, emitted versions are exactly `1,2,3,…` — no gap, no repeat.
- **P2 (T2):** for random `expectedVersion e`, `put` succeeds iff `e` =
  current version (or `e = 0n` against an absent key), else throws
  `VersionConflictError` with `actual` set correctly (a real conflicting
  version, or `undefined` for a never-written key — these are different
  outcomes, test both) and leaves state unchanged.
- **P3 (T3):** for a random sequence with timestamps and a random `T`
  within the retained window, `getAt({at:T})` equals folding the
  sub-sequence with `writtenAt ≤ T`. Separately, test that a `T` older than
  the retention floor throws `HistoryUnavailableError`, not `null`.
- **P4 (T4):** for every committed version `v`, `getAt({version:v})` and
  `getAt({at: writtenAt(v)})` return **the same full `VersionedEntry`**
  (version, value, and `writtenAt` — not just `.value`, which the original
  property under-specified and could pass even when adjacent versions
  happen to share a value).
- **P5 (T5, adapter-private diagnostic):** generate interleaved writes;
  assert (a) no two history intervals for one key overlap [tests T5(1),
  redundant with the EXCLUDE constraint but confirms it fires correctly],
  and (b) every interval's `valid_from` equals the immediately preceding
  interval's `valid_to` with no gap [tests T5(2), which no constraint
  enforces — this is the only thing that would catch a regression there].
- **P6 (C-idempotence):** writing the same `(hash,data)` twice leaves
  `data` identical and chunk count unchanged.
- **P7 (C1, adapter-private diagnostic for the chunk set):** for two random
  chunk multisets saved in either order, the resulting chunk set is
  identical (commutative idempotent join). The public API doesn't expose
  the raw chunk set — use a private diagnostic query, or substitute a
  black-box check (reload every resulting checkpoint and compare bytes).
- **P8 (C2a, black-box testable without adapter-private access):** after
  random save/prune sequences, reload every surviving checkpoint via the
  public `load`/`loadAt` API and confirm none throws `ChunkIntegrityError`
  or `CheckpointNotFoundError` for a checkpoint that should still be valid
  — this is the practical, public-API version of "no reachable chunk is
  ever reclaimed."
- **P9 (W1):** `get` after N random `set`s to one key returns the last
  value; `set·set` of equal value is indistinguishable from one.
- **P10 (L1):** under concurrent `withLease` calls on one key from
  multiple connections (ideally multiple processes, not just multiple
  in-process callers, since the guarantee is connection-scoped), an
  instrumented critical section never observes overlap (holder count ≤ 1).
  With TTL/stealing removed (§4), this property is now well-defined and
  actually provable — the original version's caveat about TTL making L1
  untestable no longer applies.

**Bottom line.** This revision trades some of the previous version's
overclaimed certainty for actually-defensible guarantees: T4 is now
well-defined (via the one-write-per-key-per-transaction rule) instead of
silently broken; T5 is honestly split into a mechanism-backed half and a
trigger-discipline half instead of one conflated "GUARANTEED"; T3's
retention interaction has an actual error type instead of a silent `null`;
L1 is simplified to something genuinely provable instead of a TTL design
that made the guarantee impossible for arbitrary code. Nothing here is
claimed to be "GUARANTEED" — that label is retired until real
implementation and tests exist to back it.

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
