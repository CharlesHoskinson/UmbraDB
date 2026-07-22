# Storage Algebra Lean Formalization — Approved Design and Status

- **Status:** M1, the abstract per-key M2 TemporalKV tranche, and abstract
  Watermarks W1 are complete.
  M3b CheckpointStore C1: complete (abstract save-side projection only).
  Later milestones remain subject to their stated proof and refinement gates
- **Branch:** `formal/storage-algebra-lean-m3b-checkpoint-c1`
- **Repository baseline:** `148d17fd9b957136798e98ed5986e865b281fd4f`
- **Lean stack:** Lean 4 / mathlib `v4.32.0`
- **Primary recommendation:** formalize an executable, history-first abstract
  state machine, then prove the named laws as derived theorems and treat the
  PostgreSQL adapter as a separate refinement boundary

This document records the research and repository audit that must precede a
sound Lean formalization. It deliberately does not modify
[`STORAGE_ALGEBRA.md`](./STORAGE_ALGEBRA.md),
[`STORAGE_TYPES.md`](./STORAGE_TYPES.md), or
[`LEAN_FORMALIZATION_PLAN.md`](./LEAN_FORMALIZATION_PLAN.md). Several statements
in those files cannot be translated literally without either becoming
ill-typed or proving a property that the implementation does not have.

## 1. Executive conclusion

The existing algebra has the right domain decomposition but the wrong carrier
for its central TemporalKV laws. A state of the form
`Option (Json × Version × Time)` retains only the current value. It cannot
define historical replay, time-indexed lookup, retention, or validity
intervals, so it cannot support T3–T5. Its proposed `Put` also omits the
candidate timestamp and transaction context that can change the transition's
result. Finally, a transition that can conflict is not an ordinary monoid
action unless failure is totalized or threaded through a Kleisli fold.

The first Lean kernel should therefore use a chronological per-key event
history and a total transition result. Successful writes append one event;
versions are derived from position in the history; timestamps are required to
increase strictly; failed guards leave the history unchanged. This gives one
executable model from which T1–T5 can be derived without assuming the desired
conclusions.

The other storage families need comparable corrections:

- C1 is a join-semilattice for the **set of stored content identities**. A map
  from hash to bytes has a join only for compatible maps or under an explicit
  collision-free/content-identity assumption.
- C2a is a one-step safety/preservation theorem. C2b is trace liveness and
  needs stable unreachability, advancing time, fair scheduling, per-chunk
  selection progress for batched collectors, and successful GC passes.
- W1 is a small overwrite theorem and is a good early proof.
- L1 must distinguish exclusive database lock ownership from non-overlapping
  JavaScript callback execution. Connection loss separates those properties.

The recommended proof boundary is intentional: Lean proves the abstract state
machines and their invariants. PostgreSQL lock behavior, trigger discipline,
clock conversion, commit visibility, SQLSTATE translation, cryptographic
collision resistance, and scheduler fairness remain named refinement
obligations until a later implementation-verification phase.

## 2. Research protocol

The research run used three independent tracks:

1. A repository track compared the formal documents with interfaces,
   migrations, adapter code, tests, OpenSpec changes, git history, and the
   unaudited Sprint 2 transaction/lease proposal.
2. An external track fetched primary sources with Scrapling: current
   PostgreSQL documentation, Lean/mathlib tagged sources, the CRDT literature,
   Lean transition-system work, and mechanized-GC references.
3. A Lean feasibility track checked the proposed representation against the
   exact Lean 4 / mathlib `v4.32.0` APIs and planned a no-`sorry` first slice.

The repository knowledge graph is regenerated on this branch so the research
document and current code/spec relationships are included in the committed
`graphify-out/` artifacts, as required by [`CLAUDE.md`](../CLAUDE.md).

### 2.1 Historical implementation baseline

The following table records repository state at the exact baseline commit named
above. It is research provenance, not a statement of the current branch state.

| Area | Repository state | Formalization consequence |
|---|---|---|
| TemporalKV | `PgTemporalKV`, migration, unit tests, and P1–P5-style property tests exist. | It can inform a later refinement layer, but its concurrency and time behavior cannot be assumed by the abstract kernel. |
| CheckpointStore | Public interface and design only. | Formalize the intended abstract structure first and feed schema defects back into design. |
| Watermarks | Public interface only. | The pure overwrite model can be formalized independently. |
| Transaction/Lease | Public interface plus a remote Sprint 2 proposal explicitly marked not audit-cleared. | Separate lock-holder safety from callback safety and do not certify the proposal by association. |
| Lean | M1 project, executable Layer A model, and first theorem tranche complete with no declaration placeholders. | Keep later storage models and PostgreSQL refinement outside the M1 claim boundary. |

At that baseline, the top-level README and ROADMAP had also drifted. The current
branch has since reconciled those status files, integrated the implemented
TemporalKV, Transaction/Lease, CheckpointStore, and Watermarks sprints from
`main`, and completed the abstract per-key M2 interval and retention tranche.

## 3. Proof-blocking findings

### 3.1 The TemporalKV carrier is too small

`STORAGE_TYPES.md` proposes a per-key state containing only the latest value,
version, and time. T3 needs an ordered history, T4 needs an injective relation
between history position and time, and T5 needs every adjacent timestamp from
which intervals are derived. These data cannot be recovered from the proposed
state.

The implementation itself demonstrates the missing carrier: time lookup
explicitly unions `kv_history` with the live row in `kv_current`. A formal
history must likewise include the current event rather than equating
`events(k)` with rows still in `kv_history`.

### 3.2 The proposed action is not an ordinary monoid action

The current prose alternates between:

```text
apply : State → Put → Except Conflict State
```

and a plain fold from bottom. A failure-producing transition cannot be used in
a plain `List.foldl` without defining how the error is threaded. There are two
sound choices:

- use `Except`/`foldlM`, which has Kleisli composition; or
- totalize every attempt as an explicit `Outcome × State` transition.

The recommended model totalizes individual attempts because the adapter has
more outcomes than CAS conflict: clock regression and same-transaction key
reuse are visible behaviors. A separate transaction runner may short-circuit
and roll back on its first error. These are deliberately different semantics:
`runAttempts` uses a total fold and records every outcome, while
`runTransaction` uses `Except`/`foldlM` and aborts at the first error. Accepted
events, unlike attempted commands, form the ordinary append algebra used for
historical projections.

### 3.3 T3 omits the current event and cannot replay a pruned suffix

T3 defines `events(k)` using only rows still in `kv_history`, but the latest
event remains in `kv_current`. For a query after the latest write, the proposed
fold therefore omits the value that `getAt` returns.

Retention adds a second problem. If versions 1–40 were pruned and the retained
suffix starts at version 41, folding that suffix from an absent state produces
version 1, not 41. A sound retained representation needs a base
certificate/offset and enough per-key metadata to distinguish `Absent` from
`Unavailable`; a floor timestamp alone is insufficient for every key.

### 3.4 The time field is not a commit instant

The trigger records `clock_timestamp()` while its statement is executing.
PostgreSQL documents that `clock_timestamp()` returns the actual current time
and can change within a statement; it is not transaction start time and it is
not commit/visibility time. A transaction can commit later than the stored
timestamp. The abstract model should call the field `writtenAt` or
`recordedAt`, not `commitInstant`, unless a true commit-order abstraction is
introduced.

Strict increase must be an explicit invariant. One-write-per-transaction does
not prevent two transactions from being truncated to the same JavaScript
millisecond, and the migration can reject that case with a clock/range error.

### 3.5 T2 overstates atomic conflict reporting

The adapter's failed conditional `INSERT`/`UPDATE` is followed by a separate
`SELECT` to obtain `actual`. A concurrent writer can change the row between
those statements. The reported `actual` therefore need not be the value at the
failed CAS linearization point and can even equal the caller's expectation by
the time it is read.

The pure theorem can and should return the snapshot used by the abstract
guard. Refinement to the current adapter requires either a stronger SQL shape
that returns the conflict snapshot atomically or a weaker public guarantee.

### 3.6 T5 credits a constraint with more than it enforces

The exclusion constraint covers ranges in `kv_history`; it does not include
the live open-ended interval represented by `kv_current`. History/history
non-overlap is constraint-backed. The boundary between the last history row
and current is maintained by the trigger, the strict clock check, and the rule
that no other writer mutates boundary columns.

The clean abstract theorem should derive all intervals from one strictly
ordered history:

```text
[t₁,t₂), [t₂,t₃), …, [tₙ,∞)
```

Pairwise disjointness and gap-freedom then follow from construction. The SQL
mechanisms become separate evidence that the persisted representation refines
that construction. For a nonempty history, “coverage” means exactly
`[t₁, ∞)`; time before the first event is absent, not a gap in an event's
validity. Empty history has no coverage horizon and is a separate theorem case.

### 3.7 C1 needs compatibility or a collision assumption

For hash-key sets, union is unconditionally associative, commutative, and
idempotent. For maps `Hash ⇀ Bytes`, two maps can bind the same hash to
different bytes, so no unique map union exists without a policy or proof.
Cryptographic collision resistance is not mathematical injectivity.

The formalization should split C1 into:

1. `ChunkIds`, a finite-set projection with join `∪`; and
2. `ChunkMap`, whose merge requires `Compatible a b`, or an explicitly named
   idealized `CollisionFreeOn` assumption.

The proposed PostgreSQL checkpoint design refreshes storage metadata such as
`created_at` on repeated saves, so idempotence is observational over the public
hash-to-bytes projection, not necessarily over every database column.

### 3.8 C2 safety and liveness are different theorem classes

`STORAGE_TYPES.md` says the deletion set is exactly the complement of
reachability, while the algebra correctly introduces a grace period and only
claims eventual collection. Immediate complement deletion contradicts the
grace window.

The current manifest relation is one hop, manifest-to-chunk. A reflexive
transitive closure would silently formalize a richer nested object graph than
the repository exposes. Start with a finite union of manifest reference sets.
Only introduce graph closure if nested references become a real interface
feature.

### 3.9 The checkpoint schema loses list semantics

The interface models a manifest's chunk hashes as an ordered list. The design's
junction table key is only `(manifest_id, chunk_hash)`: it has no ordinal and
collapses repeated hashes. A Lean list model cannot refine that schema until
the schema preserves position and multiplicity, or the public contract is
changed to a set. A save/load reconstruction law is also missing from C1/C2
and should be added before the checkpoint model is frozen.

### 3.10 L1 has two non-equivalent meanings

An advisory session lock can ensure that at most one live database session
holds a key's lock. It does not by itself ensure that at most one JavaScript
callback is executing. If the connection dies, PostgreSQL releases the lock,
another caller can enter, and the old callback may continue unless it receives
a reliable loss signal and stops, or all writes are fenced.

The first Lean law should prove substrate ownership safety. A stronger callback
critical-section theorem must assume lease-loss cancellation/settlement or a
fencing protocol.

## 4. Law-by-law repair map

| Law | Sound abstract statement | Implementation/refinement obligations |
|---|---|---|
| T1 | An `Applied` transition appends one event and the derived current version changes from `n` to `n+1`. | Per-key linearization; all successful writers pass through the guarded path. |
| T2 | `Absent` succeeds exactly at version 0; `At v` succeeds exactly at current version `v`; `Unconditional` cannot be a CAS conflict. Conflict preserves history and reports the same guard snapshot. | Existing-row and absent-row atomic compare/update; atomic conflict snapshot; error precedence; SQLSTATE mapping. |
| T3 | Time lookup is the last event with `writtenAt ≤ T`; equivalently, the projection of the accepted-event prefix through `T`. | Current and history rows form one complete ordered log; define retention metadata before claiming `Unavailable`. |
| T4 | For every retained event index `v`, lookup by `v` equals lookup at that event's `writtenAt`. | Strictly increasing stored timestamps; use recorded-write semantics or add true commit ordering. |
| T5 | Intervals derived from adjacent event times are pairwise disjoint and cover the history horizon without gaps. | History EXCLUDE constraint plus trigger discipline at the live boundary; no direct boundary writes. |
| C1 | Finite hash-key sets form a join-semilattice under union; compatible hash-to-bytes maps merge with the same laws. | Hash/content validation and explicit behavior on a same-hash/different-bytes collision. |
| C2a | An atomic GC step deletes only chunks that are unreachable in its protected snapshot and old enough. | Snapshot/deletion atomicity; reference completeness; no manifest race. |
| C2b | `gcAllEligible` removes every snapshot-eligible chunk in one successful step; a batched trace eventually removes each continuously eligible chunk only under per-chunk selection fairness. | Advancing clock, fair repeated scheduling and selection, successful transactions, stable unreachability. |
| W1 | Updating the same key twice with the same value is observationally idempotent; last update wins. | Public equality/projection and successful serialization. |
| L1 | Every reachable lock state has at most one database holder per key. | Dedicated live session, acquisition/release semantics, connection-close transition. Callback exclusion needs extra cancellation or fencing. |

## 5. Recommended candidate model

This model is frozen for M1. Later milestones may extend it only through the
explicit retention, keyed-store, and refinement boundaries below.

### 5.1 Layer A: per-key temporal history

Use abstract value and time types. Require a linear order on time; keep JSON
serialization and PostgreSQL timestamps outside the first kernel.

```text
Event Value Time := { value : Value, writtenAt : Time }
History           := List (Event Value Time)       -- oldest first
Expectation       := Unconditional | Absent | At Version
Write Value Time  := { value, writtenAt, expectation : Expectation }
Outcome           := Applied VersionedEntry
                   | VersionConflict (actual : Option Version)
                   | ClockNotIncreasing previous candidate
attempt           : History → Write → Outcome × History
runAttempts       : History → List Write → List Outcome × History
runTransaction    : History → List Write → Except Error History
```

Versions are one-based history positions. Absence has current version `0` at
the guard boundary, but `0` is never a stored event version. This removes a
redundant invariant between a stored `version` field and list position. The
PostgreSQL refinement must later prove that its stored integer equals this
derived version and that the length remains within PostgreSQL signed-`bigint`
range, or else expose numeric overflow as an adapter outcome. The explicit
`Expectation` type also avoids pretending that
zero inhabits a positive `Version` type or overloading `Option Version` with
both “unconditional” and “must be absent” meanings.

`WellFormed history` initially needs only strict timestamp ordering. A
successful `attempt` checks CAS against `history.length`, checks that a new
timestamp is greater than the final timestamp, and appends exactly one event.
CAS failure and clock failure return the unchanged history. `runAttempts`
continues after those outcomes; `runTransaction` represents an aborting unit
of work and short-circuits. Rollback of already-applied writes is part of the
transaction runner's semantics, not an accidental consequence of `foldlM`.

The keyed wrapper should make error precedence explicit: (1) evaluate the CAS
expectation, (2) reject same-transaction key reuse, (3) reject a non-increasing
timestamp, and (4) append. This matches the current PostgreSQL path, where a
stale guarded update never invokes the trigger but an accepted/unconditional
write reaches the trigger's transaction and clock checks.

Define:

- `current` as the last event with derived version `history.length`;
- `getAtVersion v` as the one-based indexed event;
- `getAtTime T` as the last event whose timestamp is at most `T`;
- `runAttempts` using an order-preserving total fold;
- `runTransaction` using `List.foldlM` with explicit abort/rollback semantics;
  and
- accepted-event replay as ordinary prefix append/projection.

Represent the final live interval with `Option Time` or `WithTop Time`; do not
invent a finite endpoint merely to reuse the closed-history representation.

Do not use a commutative fold argument for T3. Event order is semantic. Use
`List.foldl_append` for total attempt traces and `List.foldlM_append` only for
the explicitly aborting transaction semantics.

### 5.2 Layer B: keyed store and transaction guard

Lift the per-key kernel to a store `Key → History`. Add transaction identity
and a transaction-local set of keys already written:

```text
TxStatus := Active | Aborted | Committed
TxState  := { id : TxId, status : TxStatus, writtenKeys : Finset Key }
StoreStepOutcome := Temporal Outcome | TransactionKeyReuse
storeStep : Store → TxState → Key → Write
          → StoreStepOutcome × Store × TxState
```

This separation keeps the temporal theorems small while still representing
the adapter's same-key/same-transaction error. The key enters `writtenKeys`
only after `Applied`; CAS is evaluated before the reuse guard to match the
current SQL/trigger path. An operation must reject a non-`Active` state, and a
transaction runner must preserve the association between its `id` and state.
An equivalent multi-transaction model can use `TxId → Option TxState`.

Executable `Finset Key` and `Function.update` definitions require
`[DecidableEq Key]` (or a deliberately scoped classical instance). Store/pool
ownership should also be part of a formal transaction handle before the Sprint
2 global registry design is considered refinable.

### 5.3 Layer C: retention

Do not prune the canonical history in the first milestone. A later
`RetainedHistory` should carry at least:

- the retained suffix;
- the original version offset or a seed entry;
- a per-key availability/birth certificate; and
- a lookup result `Found | Absent | Unavailable`.

All retained T3–T5 theorems must be explicitly restricted to the certified
retention horizon.

### 5.4 Checkpoints

Use two related models:

- `Finset Hash` for the C1 identity projection;
- a finite map `Hash ⇀ Bytes` plus a `Compatible` predicate for data-preserving
  merge.

Executable finite-set/map operations carry `[DecidableEq Hash]`; this is a
computational requirement, not a storage-algebra hypothesis.

Manifests retain an ordered `List Hash`. Reachability is a one-hop finite union
over live manifests. The first abstract `gcAllEligible` step takes a protected
reachability snapshot and a caller-supplied `oldEnough` predicate, then deletes
all chunks that are both unreachable and old enough. Prove its safety and
one-pass eligibility theorem first. If the implementation later deletes
bounded batches, C2b additionally needs per-chunk selection fairness: every
chunk that remains continuously eligible must eventually be selected, not
merely that some GC pass is scheduled.

### 5.5 Watermarks

Model the observable store as `(Kind × Key) → Option Value`. `set` is
`Function.update` with `some value`. Prove overwrite, last-write-wins,
same-value idempotence, distinct-address commutation, and final-matching-command
trace lookup. Database metadata belongs to the refinement projection.

### 5.6 Lease state

Start with an executable state `Key → Option Holder` and guarded transitions
for acquire, failed acquire, release, stale release, and connection close.
Prove that the invariant is preserved along every finite trace. Model callback
start/end only in a later layer with an explicit cancellation/fencing
assumption; do not infer callback exclusion from the `Option Holder` theorem.

## 6. Lean 4 feasibility

The research was checked against the tagged `v4.32.0` sources, not against
moving `main`. The matching toolchain is `leanprover/lean4:v4.32.0`. At the
time of this research the tags resolve to Lean commit
`8c9756b28d64dab099da31a4c09229a9e6a2ef35` and mathlib commit
`81a5d257c8e410db227a6665ed08f64fea08e997`; the generated
`lake-manifest.json` should be committed so that resolution is reproducible.

Useful stable APIs include:

- `List.foldlM_append` for order-preserving composition of failure-producing
  traces, and `List.foldl_append` for total folds;
- `Set.Ico_disjoint_Ico_same` for adjacent half-open intervals and
  `Set.Ico_disjoint_Ico` for the general linear-order criterion;
- `Function.update_idem` for W1;
- `SemilatticeSup.mk'` when a custom join is genuinely justified by
  commutativity, associativity, and idempotence; and
- existing `Finset.union_comm`, `Finset.union_assoc`, and
  `Finset.union_idempotent` laws for the simpler C1 hash-set projection.

`List.foldl_eq_foldr_of_commute` also exists in this release, but it is not a
T3 tool: overwrite/replay is order-sensitive and does not satisfy its
commutation premise. The formalization plan's fold-duality discussion should
be removed rather than repaired around that lemma.

For the full chunk map, `Finmap` is the best initial representation of a
finite dependent partial map. Its `union` is left-biased, which is precisely
why raw chunk maps are not commutative; prove commutativity only from a custom
`Compatible` predicate. `Finsupp` is a worse fit because it requires a
semantically meaningful zero value for bytes.

`Relation.ReflTransGen` exists, but it is not needed for the repository's
current one-hop manifest-to-chunk references. Avoiding an unnecessary closure
keeps C2 faithful to the interface.

The tagged-source audit positively verified `Function.update_self`,
`Function.update_of_ne`, and `Finset.union_idempotent`. It did not find
`Set.Ico_disjoint_Ici`, so derive the live-tail case from
`Set.Iio_disjoint_Ici` and set monotonicity. It also did not find
`List.Chain'` in the inspected v4.32 sources; define a project-specific
`Adjacent` predicate. The first compiled slice must smoke-test every imported
name so a source-layout or namespace difference fails immediately.

Veil is useful precedent, but its current project is pinned to an older Lean
release. The first UmbraDB slice should copy the transition/invariant method,
not add Veil as a dependency.

### 6.1 Approved M1 module layout

```text
Formal/Lean/
  lean-toolchain
  lakefile.lean
  lake-manifest.json
  UmbraDBFormal.lean
  UmbraDBFormal/
    TemporalKV/Model.lean
    TemporalKV/Laws.lean
    TemporalKV/Retention.lean       -- later milestone
    Checkpoint/Projection.lean
    Checkpoint/ChunkMap.lean
    Checkpoint/GC.lean
    Watermarks.lean
    Lease/Model.lean
    Lease/Safety.lean
```

The first vertical slice should contain no `sorry`, `admit`, custom axioms, or
unexplained theorem hypotheses. Collision resistance, SQL semantics, and
fairness must be named assumptions at their boundary rather than global axioms
that can make unrelated theorems vacuous.

A small import/API smoke slice can prove W1, the three `Finset` C1 laws, and
adjacent `Set.Ico` disjointness before the first substantial TemporalKV slice.
That de-risks toolchain and theorem names without changing the priority of the
history model.

### 6.2 First theorem tranche

1. `attempt_applied_version`
2. `attempt_conflict_iff_snapshot_mismatch`
3. `conflict_preserves_history`
4. `clock_failure_preserves_history`
5. `attempt_preserves_wellFormed`
6. `getAtVersion_eq_index`
7. `getAtTime_eq_last_prefix`
8. `accepted_replay_eq_prefix`
9. `dual_address_agrees`
10. `intervals_pairwise_disjoint`
11. `adjacent_intervals_gap_free`
12. `runAttempts_append`
13. `runTransaction_first_error_rolls_back`

M1 completes items 1–9. Items 10–11 belong to the deferred M2 interval/T5
tranche; items 12–13 are also not part of the completed theorem claim. All of
these precede retention, SQL refinement, C2b liveness, and callback-level lease
safety.

## 7. Formalization strategies considered

| Strategy | Strengths | Risks | Decision |
|---|---|---|---|
| A. Executable history-first state machine | Laws are derived from a runnable model; failures and counterexamples are explicit; can become a property-test oracle. | Requires correcting the prose model before theorem work begins. | **Recommended.** |
| B. Law/typeclass-first algebra | Compact statements; attractive for C1 and W1; easy reuse of mathlib algebraic hierarchy. | T1–T5 can become vacuous or mutually inconsistent; partial operations and time/transaction context do not fit an ordinary action cleanly. | Use only around structures that truly satisfy the laws after Strategy A defines them. |
| C. PostgreSQL-refinement-first | Connects directly to production mechanisms. | Requires a semantics for transactions, triggers, locks, clocks, failures, and JavaScript conversion; far larger than the storage algebra and likely to encode unproved assumptions. | Defer until the abstract kernel and adapter obligations are stable. |

The practical architecture is A first, small B-style instances where earned,
then C as a separate refinement program.

## 8. Test and implementation gaps exposed by the proof plan

| Property | Current evidence | Missing evidence that the formal model makes visible |
|---|---|---|
| P1 | Sequential versions 1…N. | Concurrent writers, explicit transactions, clock collisions, and preservation after failure. |
| P2 | Sequential CAS matrix. | Concurrent CAS and one atomic conflict snapshot; byte-for-byte preservation of both current and history. |
| P3 | Time lookup at an existing event timestamp, comparing only `.value`. | Arbitrary time before/between/after events; full entry/version; retention branches. |
| P4 | Version/time lookup checks the current value, version, and `writtenAt`, with sleeps between writes. | One structural equality assertion plus adversarial equal/truncated timestamps; the sleeps avoid the clock edge the law must expose. |
| P5 | Sequential history/history interval checks. | Current-tail boundary, non-vacuous adjacency, and interleaved/concurrent writers. |
| P6–P10 | No implementation-level property suite. | All checkpoint, GC, watermark, and lease laws. |

Additional issues to resolve before claiming refinement:

- all TemporalKV methods reject `opts.tx`, but only `put` has direct rejection
  coverage;
- same-transaction reuse is tested through raw SQL rather than the public
  adapter;
- failed CAS tests do not prove both tables are unchanged;
- the remote Sprint 2 abort design races a Promise but does not establish that
  the underlying SQL operation has been cancelled and settled;
- session `statement_timeout` must be reset before a reserved connection is
  safely returned to the pool;
- a global transaction registry must validate store/pool ownership;
- a failed advisory unlock cannot safely return the same live session to the
  general pool; and
- a same-key SQL error normally aborts a transaction unless savepoint/recovery
  semantics are designed explicitly.

## 9. Trust and refinement boundary

### Completed M1/M2/W1 claims

- The executable Layer A history model assigns the next one-based version and
  appends the accepted event.
- Abstract version conflicts and clock failures preserve history; the conflict
  result is characterized by the executable expectation mismatch.
- Every abstract `attempt` preserves strict timestamp well-formedness.
- Positive version lookup is characterized by its zero-based history index,
  and time lookup is characterized by the last event in the ordered prefix at
  or before the query.
- An all-applied `runAttempts` trace replays writes in order, and an in-bounds
  version lookup agrees with lookup at that entry's timestamp.
- A nonempty history projects to bounded half-open validity intervals followed
  by the live half-infinite tail. Consecutive intervals reuse their boundary,
  a well-formed history yields pairwise-disjoint projected intervals, and the
  interval union covers exactly the horizon from the first write onward.
- Executable prefix retention keeps a complete history or a nonempty retained
  suffix with a positive pruned count. The two availability-floor coordinates
  are derived from that suffix, and positive-version selectors cannot express
  version zero.
- Retention-aware time and exact-version lookup characterize unavailable
  queries, preserve original versions and the live event, and agree with M1
  lookup at and above the retained floor.
- The executable Watermarks model addresses the complete `(kind, key)` pair,
  represents untouched lookup as `none`, and performs unconditional overwrite
  with `some value`.
- W1 proves same-address last-write-wins/idempotence, distinct-address framing
  and commutation, trace append composition, and lookup from the final matching
  command with initial-store fallback.

The API smoke module also compiles selected standalone mathlib contracts. Those
smoke declarations are not checkpoint, watermark, GC, lease, liveness,
keyed-transaction, or SQL-refinement models. The retention and T5 theorems are
supplied by the TemporalKV source and law modules, not by the smoke test.

### Deferred M2–M5 proof work

- M2: interval/T5 disjointness and exact horizon coverage, executable prefix
  retention, unavailable-history classification, and retention-transparent
  per-key T3 are complete. Keyed-store lifting, oracle serialization, and SQL
  retention/refinement remain deferred.
- M3: abstract Watermarks W1 and Checkpoint C1 for finite identities and
  compatible chunk maps are complete. The Checkpoint proof is save-side only;
  ordered reconstruction, collision handling, runtime refinement, and one-step
  C2a GC safety remain deferred.
- M4: lease-holder trace safety and any liveness theorem under explicit
  fairness, cancellation, and failure assumptions.
- M5: keyed transaction and PostgreSQL adapter refinement evidence.

### Named external obligations

- PostgreSQL row-lock, statement, and transaction linearization behavior.
- The actual snapshot returned by failed CAS.
- Trigger exclusivity and SQLSTATE-to-domain-error translation.
- JavaScript `Date` / PostgreSQL timestamp precision and conversion.
- The range invariant or explicit overflow behavior relating unbounded Lean
  `Nat` versions to PostgreSQL signed `bigint`.
- Recorded write time versus transaction commit/visibility time.
- Range constraint scope and current/history boundary discipline.
- Advisory session lock lifetime, reentrancy, cancellation, and connection
  failure behavior.
- Collision resistance/content validation for SHA-256.
- GC scheduling and per-chunk selection fairness, clock progress, and eventual
  successful passes.

This boundary is not a disclaimer. It is the checklist a later refinement proof
or integration-test harness must discharge.

## 10. Sprint 2 transaction/lease proposal

`origin/sprint-2-transaction-lease` at
`237f82140160ff68711362d1f43bf82b1a2b9d16` is explicitly not audit-cleared and
contains specifications/design documents rather than implementation. It
strengthens L1 from unique database lock ownership to non-overlapping active
callbacks. That stronger property is not yet supported under connection loss.

Formalization-relevant blockers are:

1. abort is expressed as a Promise race without proving database cancellation
   and settlement;
2. connection death releases the advisory lock while an old callback may keep
   running;
3. session `statement_timeout` can leak when the connection is pooled again;
4. the proposed same-key transaction scenario conflicts with normal
   transaction-abort behavior after SQL error;
5. the process-global transaction registry has no store/pool ownership check;
   and
6. a suppressed unlock failure may return a session that still owns a lock.

The branch is useful design input, but no theorem in this work should label it
safe until those traces have defined outcomes.

## 11. Evidence matrix

### 11.1 Repository evidence

| Finding | Primary repository locations |
|---|---|
| Current-only formal carrier and proposed action | [`STORAGE_TYPES.md` lines 25–33](./STORAGE_TYPES.md#L25-L33) |
| T3 event definition, retention floor, and replay claim | [`STORAGE_ALGEBRA.md` lines 129–151](./STORAGE_ALGEBRA.md#L129-L151) |
| Adapter time lookup unions history and current | [`temporal-kv.ts` lines 230–254](../src/postgres/temporal-kv.ts#L230-L254) |
| Failed CAS performs a later read for `actual` | [`temporal-kv.ts` lines 149–184](../src/postgres/temporal-kv.ts#L149-L184) |
| Trigger timestamp, transaction-reuse, and strict-clock behavior | [`001_temporal_kv.ts` lines 77–103](../src/postgres/migrations/001_temporal_kv.ts#L77-L103) |
| Exclusion constraint covers `kv_history` ranges | [`001_temporal_kv.ts` lines 49–64](../src/postgres/migrations/001_temporal_kv.ts#L49-L64) |
| Checkpoint API requires an ordered hash list | [`checkpoint-store.ts` lines 119–124](../src/interfaces/checkpoint-store.ts#L119-L124) |
| Proposed checkpoint join table has no ordinal | [`design.md` lines 288–301](../design/design.md#L288-L301) |
| Algebraic L1 and callback-level P10 use different scopes | [`STORAGE_ALGEBRA.md` lines 296–316](./STORAGE_ALGEBRA.md#L296-L316), [`STORAGE_ALGEBRA.md` lines 383–391](./STORAGE_ALGEBRA.md#L383-L391) |
| Current P1–P5 property coverage | [`temporal-kv.property.test.ts`](../test/postgres/temporal-kv.property.test.ts) |
| History-overlap constraint test omits current tail | [`migrate.test.ts` lines 112–128](../test/postgres/migrate.test.ts#L112-L128) |

### 11.2 External primary sources

| Source | Verified fact | Formalization use |
|---|---|---|
| [PostgreSQL 18 date/time functions](https://www.postgresql.org/docs/18/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT) | `clock_timestamp()` is actual wall-clock time and changes even within a statement; transaction-time functions have different semantics. | Name the abstract field `writtenAt`; keep commit visibility separate. |
| [PostgreSQL 18 Read Committed semantics](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED) | A concurrent updater waits, then re-evaluates its `WHERE` predicate on the updated row. | Supports existing-row single-command CAS, but absent-row creation and the later conflict read need separate arguments. |
| [PostgreSQL 18 explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS) | Session advisory locks live until release/session end, survive rollback, and are reentrant within one session. | State exact L1 refinement assumptions; include connection close, pooling, and reentrancy. |
| [PostgreSQL 18 range types](https://www.postgresql.org/docs/18/rangetypes.html#RANGETYPES-CONSTRAINT) | `tstzrange` supports half-open `[)` bounds; exclusion with overlap prevents overlaps but does not create adjacency or cover a separate current table. | Split T5 constraint evidence from trigger-derived gap-freedom/current-tail evidence. |
| [mathlib `v4.32.0` release](https://github.com/leanprover-community/mathlib4/releases/tag/v4.32.0) | Stable release aligned with Lean `v4.32.0`. | Reproducible project pin. |
| [mathlib interval-disjointness source](https://github.com/leanprover-community/mathlib4/blob/v4.32.0/Mathlib/Order/Interval/Set/Disjoint.lean#L39-L40) | Adjacent `Set.Ico` intervals are disjoint in a preorder. | Direct building block for T5. |
| [mathlib `List.foldlM_append`](https://github.com/leanprover/lean4/blob/v4.32.0/src/Init/Data/List/Lemmas.lean#L2035-L2037) | Monadic folds over appended lists compose in order. | Correct trace/replay composition; no commutativity hypothesis. |
| [mathlib Kleisli fold construction](https://github.com/leanprover-community/mathlib4/blob/v4.32.0/Mathlib/Control/Fold.lean#L146-L163) | `foldlM` over a free monoid is represented through Kleisli endomorphisms. | A guarded command replay can have algebraic composition without pretending it is a total `MulAction`. |
| [mathlib `Function.update_idem`](https://github.com/leanprover-community/mathlib4/blob/v4.32.0/Mathlib/Logic/Function/Basic.lean#L589-L591) | Updating one function key twice keeps the last update. | W1. |
| [mathlib `SemilatticeSup.mk'`](https://github.com/leanprover-community/mathlib4/blob/v4.32.0/Mathlib/Order/Lattice.lean#L79-L83) | A supremum semilattice can be built from associative, commutative, idempotent `sup`. | C1 only after map compatibility is established; finite-set union already has the instance. |
| [Preguiça, Baquero, and Shapiro, *Conflict-free Replicated Data Types*](https://arxiv.org/pdf/1805.06358) | State-based convergence uses a join-semilattice, inflationary updates, and least-upper-bound merge. | Supports the algebraic shape of the save-only C1 projection; pruning and arbitrary conflicting maps are outside that structure. |
| [NIST SP 800-107 Rev. 1, §§4.1–4.2 and Table 1](https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication800-107r1.pdf) | Collision resistance is a computational security property; the table assigns SHA-256 an expected 128-bit collision strength. | Do not turn collision resistance into mathematical injectivity; use compatibility, checked collision failure, or a named assumption. |
| [Dijkstra et al., EWD630](https://www.cs.utexas.edu/~EWD/transcriptions/EWD06xx/EWD630.html) | Collector safety forbids reachable nodes from entering the free set, while reclamation progress occurs in later collector cycles. | Separate C2a invariant safety from C2b temporal progress. |
| [Lamport, PlusCal Tutorial Session 9](https://lamport.azurewebsites.net/tla/tutorial/session9.html) | Liveness ranges over whole executions; weak fairness prevents a continuously enabled action from being ignored forever. | C2b must name fairness of `gcStep` and stable eligibility, not merely say that GC is periodic. |
| [Veil project](https://veil.dev/) and [CAV 2025 paper](https://verse-lab.org/papers/veil-cav25.pdf) | Lean can verify safety of executable transition systems through inductive invariants. | Methodological precedent for TemporalKV and lease trace invariants; no dependency is required for the first slice. |
| [McCreight, *A Framework for Verified Garbage Collection*](https://flint.cs.yale.edu/flint/publications/mccreight-thesis.html) | Mechanized GC proofs separate an abstract reachability/safety argument from concrete collector implementation. | Confirms the abstraction boundary, while the full framework is intentionally unnecessary for UmbraDB's one-hop chunk references. |
| [Newcombe et al., *Use of Formal Methods at Amazon Web Services*](https://lamport.azurewebsites.net/tla/formal-methods-amazon.pdf) | Small abstract models are used to expose design errors and validate protocol-level properties before implementation refinement. | Supports model-first scope; it does not substitute for Lean proofs or PostgreSQL refinement. |

One HAL landing page discovered during source discovery presented an Anubis bot
challenge. The research run did not attempt to bypass it and used an accessible
primary paper copy instead. The matrix endpoints above were fetched and their
relevant content markers checked with Scrapling.

## 12. Milestone status

### M0 — freeze semantics

- Approve or amend the decisions in Section 13.
- Update the normative algebra/types so commands, outcomes, time semantics,
  retention, C1 compatibility, C2 liveness assumptions, and L1 scope agree.
- Mark stale status tables explicitly.

### M1 — no-`sorry` TemporalKV vertical slice (completed)

- Pin Lean/mathlib `v4.32.0`.
- Implement Layer A and its well-formedness invariant.
- Prove preservation, T1, T2, lookup basics, and one T4 theorem.
- Add default contract-test compilation, an elaborated-environment axiom audit,
  source scanning, warning-as-error builds, and an independent no-`sorry` check to CI.

### M2 — complete temporal laws (abstract per-key tranche completed)

- Derive bounded historical intervals plus the live tail and prove T5
  disjointness/gap-freedom. **Completed.**
- Prove extensional T5 coverage over the exact nonempty history horizon.
  **Completed.**
- Add canonical prefix retention, separate absence/unavailability outcomes, and
  retention-transparent per-key T3 for time and exact-version selectors.
  **Completed.**
- Lift the per-key laws to a keyed transactional state and generate a checked
  executable oracle for TypeScript property tests. **Deferred.**

### M3 — simple stores (in progress)

- Prove W1. **Completed.**
- Prove C1 for hash sets and compatible maps. **Completed (abstract save-side
  projection only).** The implemented `(manifest_id, position)` key preserves
  ordered duplicate references, but their Lean reconstruction theorem remains
  deferred.
- Prove C2a for one-hop manifest reachability. **Deferred.**

### M4 — leases and liveness (deferred)

- Prove database-holder L1 along finite traces.
- Design fencing/cancellation before attempting callback-level L1.
- Add C2b only after fairness and failure semantics are explicit.

### M5 — refinement evidence (deferred)

- State an adapter refinement relation.
- Strengthen integration/property tests to cover the obligations in Sections 8
  and 9.
- Consider deeper SQL semantics only where tests and named assumptions are not
  sufficient for the desired assurance level.

## 13. Approved implementation decisions

The recommended decision package is:

1. **Temporal carrier:** complete chronological accepted-event history, with
   versions derived from one-based position.
2. **Time meaning:** strictly increasing recorded write time (`writtenAt`), not
   transaction commit/visibility time.
3. **CAS input:** `Unconditional | Absent | At Version`, with no overloaded
   `Option`/zero sentinel inside the kernel.
4. **Failures:** total `attempt` outcomes and `runAttempts` for observational
   traces; a separate aborting/rollback `runTransaction` uses `Except`/Kleisli
   composition; accepted events use append.
5. **Transactions:** temporal kernel first; same-transaction key reuse in a
   keyed wrapper with an explicit write set.
6. **Retention:** implemented abstract extension with a version offset and a
   three-way `Found | Absent | Unavailable` result; PostgreSQL retention and
   floor/error refinement remain deferred.
7. **Checkpoint algebra:** unconditional join only for the hash-key set;
   compatible merge or explicit collision assumption for hash-to-bytes maps.
8. **GC:** deterministic delete-all-eligible C2a/one-pass progress now; batched
   C2b only after per-chunk selection fairness is specified.
9. **Lease:** database-holder exclusion first; callback exclusion only with a
   loss/cancellation or fencing design.
10. **Toolchain:** Lean/mathlib `v4.32.0`, no `sorry`, and no hidden global axioms.

This package authorizes the M1 project scaffold and first proof slice. The
branch remains explicit about which later semantics are still refinement or
liveness obligations rather than purportedly verified facts.
