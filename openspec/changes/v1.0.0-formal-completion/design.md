# Design — v1.0.0: Formal completion (`formal-completion`)

Lean 4 / mathlib design for the C2a and L1 mechanizations, the anti-vacuity discipline, the refinement register, and the CI faithfulness manifest. Carriers reuse the existing repo (`TemporalKV.History`, `Checkpoint.{ChunkIds,ChunkMap}`, `Watermarks.Store`). Every new module MUST be transitively imported by `UmbraDBFormalTest/Trust.lean` so `#audit_umbradb_trust` reaches it (validated by GF0's red-gate probe).

## §1 C2a — GC reachability-safety (`Checkpoint/GC.lean`)

Faithful shape (union over `live` only is correct; every-instant follows from prefix-universality of a plain foldl `run`):
```lean
structure GCState (Hash) [DecidableEq Hash] where
  manifests : ManifestId → ChunkIds Hash   -- refs(m)
  live      : Finset ManifestId
  deleted   : Finset Hash
def reachable (s) : Finset Hash := s.live.biUnion s.manifests
def Safe (s) : Prop := Disjoint s.deleted (reachable s)
```
**Anti-vacuity (audit-mandated): model an UNGUARDED primitive so the unsafe op is representable and excluded, not unrepresentable.**
```lean
def collectHashes (hs : Finset Hash) (s) : GCState Hash        -- unguarded: can delete anything
def collect (s) := collectHashes (allChunks s \ reachable s) s -- the safe wrapper
theorem collect_safe (s) (h : Safe s) : Safe (collect s)
theorem collectHashes_reachable_breaks_safe (s) (c) (hc : c ∈ reachable s) :
    ¬ Safe (collectHashes {c} s)                               -- the _can_violate witness
theorem gcSafety_invariant (ops : List GCOp) : Safe (GCState.empty.run ops)
```
The positive witness (`collect_moves_witness`) must reclaim a chunk **once registered then unlinked** (so `unlink` genuinely shrinks `live`). **C2a same-tx visibility is a *sequential-trace modeling choice*, recorded as a register row — NOT a dischargeable Lean hypothesis** in this single-trace model.

## §2 L1 — lease mutual exclusion (`Transaction/Lease.lean`)

**Anti-vacuity (audit-mandated): model at the level of ATTEMPTS with a blocking outcome, so `WellFormedTrace` cannot encode its own conclusion.**
```lean
inductive Outcome | acquired | blocked | released
def acquire (key) (holder) (s : LeaseSet) : LeaseSet × Outcome  -- a held key ⇒ (s, blocked)
def holders : List LeaseOp → Key → Finset Token                 -- unique tokens; not Finset Holder
def WellFormedTrace : List LeaseOp → Prop  -- admits two holders issuing OVERLAPPING acquires on one key
theorem acquire_while_held_blocks (s) (key) (h : key ∈ heldKeys s) (holder) :
    (acquire key holder s).2 = Outcome.blocked
theorem lease_mutex_all_prefixes (trace) (h : WellFormedTrace trace) (key) (n) :
    (holders (trace.take n) key).card ≤ 1
```
Non-vacuity witness `contended_simultaneous_example`: two distinct holders' overlapping acquires on one key, second `blocked` — replaces the insufficient serial-alternation witness. Mutex is a theorem about acquire-semantics, not a global predicate.

## §3 Supporting gates

- **Multi-key (`KeyedStore := Key → History`) — FRAMING ONLY.** `attemptKeyed_frame` (key≠key' ⇒ untouched) + per-key re-derivation of T1/T2 by delegating to `TemporalKV.Laws`. This proves cross-**key** independence; it does **NOT** close the spec's T1 cross-**writer** OPEN (that is composition, deferred). Gap-table entry MUST say so.
- **C1 collision hygiene:** keep `CollisionFreeOn` as `Set.InjOn digest (realized values)` (already in `ChunkMap.lean`) — never global `Function.Injective` (false by pigeonhole on finite `Hash` ⇒ vacuous). Stays a hypothesis; no axiom; allowlist untouched.
- **Ordered reconstruction, C2b (round-model + explicit fairness hypothesis), composition (needs a shared writer-role lease key), cursor-vs-data ordering:** deferred; signatures in `Formal/FORMAL-COMPLETION-ROADMAP.md`.

## §4 Refinement register & three statuses

Every law reports exactly one of **`ABSTRACT-PROVED`** (Lean, Trust-audited), **`RUNTIME-TESTED`** (P1–P10 sampled conformance — not a proof), **`REFINEMENT-UNPROVED`** (trusted, register-itemized). A printed Lean hypothesis for an RR obligation **relocates, does not prove**, the Postgres correspondence. Register row = {abstract-theorem, trusted-mechanism, (b)-hypothesis-or-(c)-test, voiding-precondition}. T5(2) is split: `T5(2)-abstract` (proved) vs `T5(2)-refinement` (register (b): trigger sole-writer).

## §5 CI faithfulness manifest

`#audit_umbradb_trust` enforces axiom-cleanliness only (no law registry). Add:
1. checked-in `law-manifest.json` mapping each law-ID → theorem name → **pinned type** (`#check @gcSafety_invariant : <exact type>` guards that fail to elaborate on drift/weakening);
2. an overclaim-drift test diffing the release-doc "proved" list vs the manifest;
3. **negative CI controls** — deleting/weakening any required theorem MUST turn CI red;
4. assert `lake build --wfail` includes the Test library (else the Trust command-elaborator never runs).
