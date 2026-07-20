# Storage Types — reference for formalization

Companion to `STORAGE_ALGEBRA.md`. This document lists the concrete types
each algebraic law in that spec quantifies over, with pointers to their
TypeScript source (`src/interfaces/`) so a future Lean (or other proof
assistant) formalization has a precise, unambiguous signature to start from
rather than re-deriving it from prose.

## TemporalKV (`src/interfaces/temporal-kv.ts`)

- `Namespace`, `Scope`, `Key` — opaque strings; a key is the product
  `(Namespace, Scope, Key)`.
- `Version` — `bigint`, strictly positive once written, monotonically
  increasing per key (Law T1).
- `JsonValue` — the recursive JSON value type (`z.json()`); the value
  domain `Json` in the algebra spec's `S_k = (value: Json, version: ℕ⁺,
  writtenAt: Time)`.
- `VersionedEntry<T>` — the state `S_k` itself: `{ namespace, scope, key,
  value: T, version, writtenAt: Date }`.
- `AsOf` — the sum type `{ version: Version } | { at: Date }`; the two
  projections `π_v`/`π_T` in Law T4.
- `VersionConflictError` — the `conflict` outcome of the guarded partial
  action in Law T2, carrying `expected`/`actual: Version | undefined`.

**For a Lean formalization:** model `Key = Namespace × Scope × KeyStr`,
`State k = Option (Json × Version × Time)` (the `⊥` bottom is `none`), and
`apply : State k → Put → Except Conflict (State k)` where `Put = { value :
Json, expectedVersion : Option Version }`. Law T1/T2 become a single
theorem about `apply`'s version-transition behavior; Law T3 is a theorem
relating `getAt` to `List.foldl apply none` over a time-filtered event
list; Law T4 is a theorem equating two definitions of `getAt` under a
stated alignment hypothesis (that `valid_from` is sourced from the same
`writtenAt` that produced `version`).

## CheckpointStore (`src/interfaces/checkpoint-store.ts`)

- `ContentHash` — `string`, a SHA-256 hex digest; the domain of the
  idempotent chunk map `f : ContentHash → Bytes` in Law C-idempotence.
- `CheckpointSequence` — `number`, monotonic per `(walletId, networkId)`.
- `CheckpointSummary` / `CheckpointRecord` — a manifest: `{ sequence,
  manifestHash, chunkCount, ... }` plus, for `CheckpointRecord`, the
  reconstructed `data: Uint8Array`.
- `PruneResult` — `{ prunedSequences, reclaimedChunks, reclaimedBytes }`;
  the observable outcome of the reachability-closure GC (Law C2).

**For a Lean formalization:** model the global chunk store as
`ChunkStore = ContentHash → Option Bytes` and manifests as
`Manifest = { hashes : List ContentHash, ... }`. Law C1 (join-semilattice)
is a theorem that `save` commutes and is idempotent on `ChunkStore` under
union of referenced hash sets. Law C2 (reachability closure) is a theorem
that `∀ c ∈ ChunkStore.keys, c ∉ ⋃ (Live.map Manifest.hashes) →
gc-eligible c`, i.e. GC's deletion set is exactly the complement of the
reachable set — a set-algebra identity, not just an implication.

## Watermarks (`src/interfaces/watermarks.ts`)

- `WatermarkKind`, `WatermarkKey` — opaque strings.
- `WatermarkValue` — `string | number | Record<string, unknown>`; no
  version, no history (Law W1 — deliberately not event-sourced).

**For a Lean formalization:** `State = WatermarkKind × WatermarkKey →
Option WatermarkValue`; `set` is literal `Function.update`, and Law W1
(`set (set x v) v = set x v`) is `Function.update_idem` or equivalent —
likely already a one-line proof from Lean's core library once the type is
stated, which is itself worth confirming as part of the formalization (a
law that "proves itself" from a standard-library lemma is a good sign the
design is not hiding accidental complexity).

## Transaction/Lease (`src/interfaces/transaction-lease.ts`)

- `TransactionHandle`, `Lease` — opaque branded handles; not data the
  algebra above operates on, but the *scope* within which its laws hold
  (see `design-algebra.md` §4's conditional-laws table).
- `Lease.key: string`, `Lease.token: string` — the mutual-exclusion
  invariant in Law L1 (`|holders(key)| ≤ 1`) is stated over `key`; `token`
  is the mechanism that lets `releaseLease` reject a stale/duplicate
  release, not part of the invariant's statement itself.

**For a Lean formalization:** Law L1 is naturally a property of a
*trace* (a sequence of acquire/release events) rather than a pure function
— model it as an invariant over an interleaving of
`Acquire key | Release key` events and prove no valid trace has two
concurrent `Acquire key` events without an intervening `Release key`. This
is closer to a small model-checking-style proof than an algebraic identity;
flag it as a different proof *style* from T1–T5/C1–C2/W1 when scoping the
Lean work, not a harder or easier one, just structurally different (safety
property over traces vs. an equational law over states).

## What's NOT in scope for this formalization

`PrivateStateProvider` and `WalletStateStore` are excluded — per the
2026-07-20 interface audit (see `design/design-interfaces.md` §4, as
corrected by that audit), `PrivateStateProvider` is an externally-mandated
SDK contract with its own stateful/throw-heavy protocol that does not
compose algebraically with the four modules above, and
`WalletStateStore`'s production implementation
(`CheckpointWalletStateStore`) is a thin adapter over `CheckpointStore` +
`Watermarks`, not a fifth algebra of its own.
