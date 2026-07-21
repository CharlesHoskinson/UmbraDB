# checkpoint-store (implementation)

The Postgres-backed implementation of `src/interfaces/checkpoint-store.ts`. Extends (does not
replace) the interface-level requirements already implied by that file's own TSDoc contract, and
depends on the Transaction/Lease module's `withTransaction` (Sprint 2) per `design.md` §8.

## ADDED Requirements

### Requirement: Checkpoint payloads are split into fixed-size chunks with a correctly-sized remainder

`PgCheckpointStore.save` SHALL split `data` into chunks of `opts.chunkSize ?? DEFAULT_CHUNK_SIZE`
bytes each, except the final chunk, which SHALL contain exactly the remaining bytes when
`data.byteLength` is not an exact multiple of the chunk size.

#### Scenario: A payload whose length is not a multiple of the chunk size produces a correctly-sized final chunk
- **WHEN** `save` is called with `data` whose length is `chunkSize * k + r` for some `k >= 0` and
  `0 < r < chunkSize`
- **THEN** exactly `k + 1` chunks SHALL be produced
- **AND** the final chunk SHALL be exactly `r` bytes

#### Scenario: A payload smaller than one chunk produces exactly one chunk
- **WHEN** `save` is called with `data` shorter than `chunkSize`
- **THEN** exactly one chunk SHALL be produced, containing all of `data`

### Requirement: Chunk storage is content-addressed and globally deduplicated

`PgCheckpointStore` SHALL write each chunk keyed by its SHA-256 content hash, SHALL NOT create a
second row for a hash that already exists, and SHALL refresh that row's garbage-collection clock
on every write that references it, regardless of which wallet or checkpoint the write belongs to.

#### Scenario: Identical chunk content across different checkpoints is stored once
- **WHEN** two `save` calls (for the same or different `walletId`/`networkId`) each produce a
  chunk with identical byte content
- **THEN** `ckpt_chunks` SHALL contain exactly one row for that content's hash after both calls
- **AND** that row's stored bytes SHALL be unchanged by the second write

#### Scenario: Re-referencing an existing chunk refreshes its GC clock
- **WHEN** a `save` call produces a chunk whose hash already exists in `ckpt_chunks`
- **THEN** that row's `created_at` SHALL be updated to the time of this write
- **AND** its `data` SHALL remain byte-identical to what was already stored

### Requirement: A manifest preserves the exact order and multiplicity of its chunks, including repeats

The manifest-to-chunk association SHALL record each chunk reference at an explicit position
within its manifest, SHALL support the same chunk hash appearing at more than one position in a
single manifest, and `load` SHALL reconstruct the original payload by concatenating chunks in
position order.

#### Scenario: A payload containing a repeated chunk round-trips correctly
- **WHEN** `save` is called with `data` such that two of its chunks are byte-identical to each
  other (e.g. a repeated padding run landing on two chunk boundaries)
- **THEN** the manifest SHALL record both occurrences, each at its own position
- **AND** `load` SHALL return `data` reconstructed with both occurrences present, in the original
  order, byte-identical to the input

#### Scenario: A manifest's chunks are read back in position order regardless of storage order
- **WHEN** a manifest's chunk rows are fetched from storage
- **THEN** they SHALL be ordered by their recorded position before concatenation
- **AND** the reconstructed payload SHALL NOT depend on any incidental physical row order

### Requirement: Checkpoint sequence numbers are gapless, monotonic, and scoped per wallet+network

`PgCheckpointStore.save` SHALL assign each new checkpoint the next sequence number for its
`(walletId, networkId)` pair, starting at 1, with no gap and no repeat under concurrent callers,
and independently per distinct `(walletId, networkId)` pair.

#### Scenario: Sequential saves for one wallet+network produce consecutive sequence numbers
- **WHEN** N checkpoints are saved in sequence for the same `(walletId, networkId)`
- **THEN** the assigned sequence numbers SHALL be exactly `1, 2, ..., N` in order

#### Scenario: Concurrent saves for one wallet+network still produce a gapless, non-repeating sequence
- **WHEN** N `save` calls for the same `(walletId, networkId)` are issued concurrently
- **THEN** the assigned sequence numbers SHALL be exactly the set `{1, ..., N}`, each value
  assigned exactly once

#### Scenario: Different wallet+network pairs have independent sequence counters
- **WHEN** `save` is called for two distinct `(walletId, networkId)` pairs
- **THEN** each pair's first checkpoint SHALL be assigned sequence `1`, independent of the other
  pair's sequence progression

### Requirement: load always fully verifies chunk integrity before returning

`PgCheckpointStore.load` SHALL rehash every chunk in the resolved manifest and compare it against
that chunk's recorded hash before returning, for every call, with no unverified/fast-path variant.

#### Scenario: A checkpoint whose stored chunk content matches its recorded hash loads successfully
- **WHEN** `load` is called for a checkpoint whose every chunk's stored bytes still hash to the
  value recorded in its manifest
- **THEN** `load` SHALL return a `CheckpointRecord` with the reconstructed `data`

#### Scenario: A chunk whose stored content no longer matches its recorded hash is rejected
- **WHEN** a chunk referenced by the resolved manifest has been altered so its content no longer
  hashes to the value recorded for it
- **THEN** `load` SHALL reject with `ChunkIntegrityError`
- **AND** the error SHALL carry both the chunk's recorded hash and its actual rehashed value

#### Scenario: A manifest referencing a chunk absent from storage is rejected
- **WHEN** the resolved manifest references a chunk hash with no corresponding row in chunk
  storage
- **THEN** `load` SHALL reject with `ChunkMissingError` carrying that chunk hash
- **AND** SHALL NOT reject with a generic or null-reference error instead

### Requirement: load and history distinguish "no checkpoint" from "checkpoint exists elsewhere"

`PgCheckpointStore.load` SHALL reject with `CheckpointNotFoundError` when no checkpoint exists for
the given `(walletId, networkId)`, and separately when a specific requested `sequence` does not
exist for an otherwise-valid `(walletId, networkId)` — both cases populating the error with the
`walletId`/`networkId`/`sequence` actually requested.

#### Scenario: No checkpoint exists for the wallet+network at all
- **WHEN** `load` is called for a `(walletId, networkId)` with zero saved checkpoints
- **THEN** the call SHALL reject with `CheckpointNotFoundError`

#### Scenario: The wallet+network has checkpoints but not at the requested sequence
- **WHEN** `load` is called with an explicit `sequence` that was never assigned for an otherwise
  valid `(walletId, networkId)`
- **THEN** the call SHALL reject with `CheckpointNotFoundError` carrying that `sequence`

#### Scenario: Omitting sequence loads the latest checkpoint
- **WHEN** `load` is called with `sequence` omitted for a `(walletId, networkId)` with at least
  one saved checkpoint
- **THEN** the call SHALL return the checkpoint with the highest assigned sequence number

### Requirement: history is newest-first, scoped per wallet+network, and supports cursor paging with no gap or duplicate

`PgCheckpointStore.history` SHALL return checkpoint summaries in descending sequence order,
bounded by `opts.limit`, scoped strictly to the requested `(walletId, networkId)`, and SHALL
support continuing via `opts.before` such that consecutive pages contain neither a gap nor a
duplicate.

#### Scenario: History for one wallet+network never includes another's checkpoints
- **WHEN** `history` is called for a given `(walletId, networkId)` that has checkpoints, and a
  different `(walletId, networkId)` pair also has checkpoints
- **THEN** the returned summaries SHALL only include checkpoints belonging to the requested pair

#### Scenario: Paging with before continues without gap or duplicate
- **WHEN** `history` is called with `limit = L` for a wallet+network with `N > L` checkpoints,
  then called again with `opts.before` set to the last page's oldest returned `sequence`
- **THEN** the second page SHALL contain the next `L` (or fewer, if exhausted) checkpoints
  strictly older than the first page's oldest entry
- **AND** no sequence number SHALL appear in both pages

### Requirement: prune rejects a retainCount below 1 before any deletion runs

`PgCheckpointStore.prune` SHALL reject with `ValidationError` when `retainCount < 1`, and SHALL
NOT delete any manifest or chunk as a side effect of a rejected call.

#### Scenario: retainCount of zero is rejected with no effect
- **WHEN** `prune` is called with `retainCount = 0`
- **THEN** the call SHALL reject with `ValidationError`
- **AND** no row in `ckpt_manifests` or `ckpt_chunks` SHALL be deleted as a result

### Requirement: prune retains exactly the N newest complete manifests per wallet+network

`PgCheckpointStore.prune(walletId, networkId, retainCount)` SHALL delete every complete manifest
for that `(walletId, networkId)` older than the `retainCount`-th newest, and SHALL retain exactly
the `retainCount` newest, including at the `retainCount = 1` boundary.

#### Scenario: Pruning to retain the single newest manifest keeps only it
- **WHEN** `N` checkpoints exist for a `(walletId, networkId)` and `prune(..., retainCount = 1)`
  is called
- **THEN** only the checkpoint with the highest sequence number SHALL remain after the call
- **AND** all `N - 1` older checkpoints SHALL be deleted

#### Scenario: Pruning to retain k newest keeps exactly those k
- **WHEN** `N > k` checkpoints exist for a `(walletId, networkId)` and `prune(..., retainCount =
  k)` is called
- **THEN** exactly the `k` checkpoints with the highest sequence numbers SHALL remain
- **AND** `PruneResult.prunedSequences` SHALL list exactly the `N - k` deleted sequence numbers

### Requirement: A chunk still referenced by any surviving manifest is never reclaimed (Law C2a)

Across any interleaving of concurrent `save` and `prune` calls, `PgCheckpointStore` SHALL NOT
delete a chunk that any manifest surviving that same instant still references, regardless of
which wallet's manifest the reference belongs to.

#### Scenario: A chunk shared across wallets survives one wallet's prune
- **WHEN** two different wallets' checkpoints reference the same chunk, and one wallet's
  checkpoint referencing it is pruned while the other wallet's checkpoint referencing it survives
- **THEN** that chunk SHALL remain in storage
- **AND** `load` on the surviving checkpoint SHALL succeed without `ChunkMissingError`

#### Scenario: Interleaved save and prune never orphans a live manifest's chunk
- **WHEN** `save` and `prune` calls are issued concurrently, potentially sharing chunk content
  across calls
- **THEN** for every checkpoint that remains listed in `history` afterward, `load` SHALL succeed
  without `ChunkMissingError` or `ChunkIntegrityError`

### Requirement: Chunk reclamation respects the grace window, protecting against re-reference races

`PgCheckpointStore.prune` SHALL NOT physically delete a chunk younger than the grace window, even
if that chunk is currently unreferenced by any surviving manifest at the moment `prune` runs.

#### Scenario: A newly unreferenced chunk within the grace window is not reclaimed
- **WHEN** a chunk becomes unreferenced by any surviving manifest, and less than the grace window
  has elapsed since that chunk's `created_at` was last refreshed
- **THEN** `prune` SHALL NOT delete that chunk
- **AND** it SHALL NOT appear in that call's `reclaimedChunks`/`reclaimedBytes` counts

#### Scenario: An unreferenced chunk past the grace window is eventually reclaimed
- **WHEN** a chunk has been unreferenced by any surviving manifest for longer than the grace
  window
- **THEN** a subsequent `prune` call SHALL delete it
- **AND** it SHALL be counted in that call's `reclaimedChunks`/`reclaimedBytes`

### Requirement: manifestHash is computed once at write time from the ordered chunk-hash sequence

`CheckpointSummary.manifestHash` SHALL equal SHA-256 of the manifest's chunk hashes concatenated
in position order, computed at `save` time and returned unchanged by subsequent `load`/`history`
calls for that checkpoint.

#### Scenario: Identical payloads saved as separate checkpoints report the same manifestHash
- **WHEN** the same `data` is saved twice as two separate checkpoints (distinct sequence numbers)
- **THEN** both checkpoints' `CheckpointSummary.manifestHash` SHALL be equal

#### Scenario: Payloads differing only in chunk order report different manifestHash
- **WHEN** two payloads produce the same set of chunk hashes but in a different order
- **THEN** their `manifestHash` values SHALL differ
