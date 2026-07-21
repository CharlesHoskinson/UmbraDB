# Proposal — Sprint 3: CheckpointStore

## Why

TemporalKV (Sprint 1) is implemented and merged. Transaction/Lease (Sprint 2) is drafted on
`sprint-2-transaction-lease` and under audit (its own review cycle found real runtime-breaking
bugs, since fixed in that branch's revised draft; it is not yet Codex-cleared or merged). Per
`design/tasks.md`'s phase map, §2 (checkpoint chunker) and §3 (checkpoint manifests, GC, prune)
are "not yet drafted as its own sprint... likely the same sprint... CheckpointStore is one module
per `src/interfaces/checkpoint-store.ts`" — this change drafts that sprint.

This is the largest remaining module: content-addressed chunking, global cross-wallet dedup, a
two-step GC pass (manifest prune, then grace-windowed chunk reclamation), and the project's only
module whose correctness properties (`Formal/STORAGE_ALGEBRA.md` §2, Laws C1/C2a/C2b) depend on
composing the Transaction/Lease layer internally rather than exposing its own `tx` option
(`src/interfaces/checkpoint-store.ts`'s interface doc, final paragraph).

**Dependency on an unmerged sprint, accepted explicitly (per project direction on this point):**
this change drafts `PgCheckpointStore` against Sprint 2's `TransactionLeaseLayer`/
`TransactionHandle`/`resolveTransaction` contract as it stands on `sprint-2-transaction-lease`
today. Those are stable TypeScript interface shapes even though Sprint 2's *implementation* is
still pre-audit; if Sprint 2's Codex-clearing pass changes that contract's shape, this change's
design/tasks must be reconciled before Sprint 3 implementation starts (tracked as task 0.0 below).
Sprint 3 does not implement anything until Sprint 2 actually merges — only the spec is drafted in
parallel, matching how Sprint 2 itself was drafted while Sprint 1 was only newly merged.

## What changes

1. **CheckpointStore (`PgCheckpointStore`)**: the Postgres implementation of
   `src/interfaces/checkpoint-store.ts` — `save`/`load`/`history`/`prune` — against the schema in
   `design/design.md` §3, with two schema corrections this change makes (not yet reflected in
   that document, both found while drafting this sprint at implementation-level detail that
   document never went to):
   - **`ckpt_manifest_chunks` needs a `position` column.** The existing junction table's
     `PRIMARY KEY (manifest_id, chunk_hash)` cannot represent a checkpoint payload that contains
     the same chunk's content more than once (e.g. a run of identical padding/zero bytes landing
     in two different chunk-sized windows) — a second occurrence would either violate the PK or
     silently collapse into the first via an `ON CONFLICT DO NOTHING`, either way losing a
     position `load()` must reconstruct. Fixed in `design.md` §3 below by keying the junction row
     on `(manifest_id, position)` instead, with `chunk_hash` as a plain FK column.
   - **`seq` assignment was never specified.** `design/design.md` §3 declares
     `ckpt_manifests.seq bigint NOT NULL` but no document describes how a caller-visible,
     monotonic-per-`(w,net)` sequence number is actually allocated race-free. Fixed in `design.md`
     §2 below with a small `ckpt_sequence_counters` table and an atomic upsert-increment, the same
     "claim the next number under a single-row lock" shape already used by nothing else in this
     project (TemporalKV's `version` is server-assigned per-row via `UPDATE`, a different
     mechanism that doesn't fit a cross-row sequence).
2. **Chunking**: `save()` splits `data` into fixed-size chunks (default target size — an
   implementation-level decision this change makes, `design.md` §1), SHA-256-hashes each, and
   writes them via the `INSERT ... ON CONFLICT (hash) DO UPDATE SET created_at = now()` dedup
   pattern `design/design.md` §3 already specifies.
3. **GC (`prune`)**: the two-step manifest-prune-then-chunk-reclaim pass from `design/design.md`
   §3, including its already-fixed off-by-one and grace-window TOCTOU protections, implemented
   against real Postgres and covered by property tests P6-P8
   (`Formal/STORAGE_ALGEBRA.md` §5).

## Non-goals (explicitly out of scope for this sprint)

- Watermarks and the remaining Transaction/Lease implementation work — Watermarks is not yet
  drafted as its own sprint; Transaction/Lease is Sprint 2's own scope, not re-litigated here
  except where this change consumes its already-drafted interface.
- `PgPrivateStateProvider`/`PgWalletStateStore` (`design/tasks.md` §6/§7) — both have an
  unresolved scope question (consumer-side vs. shipped-in-repo) that this change does not
  attempt to resolve.
- Any change to `ckpt_chunks`'s or `ckpt_manifests`' already-specified columns beyond the two
  corrections in "What changes" above — this sprint implements `design/design.md` §3, it does
  not redesign it.
- Batching the chunk-reclamation `DELETE` (single unbatched sweep vs. batched) —
  `Performance/DESIGN.md` §3 explicitly defers this to measured data at realistic scale, not a
  design-time guess; this sprint ships the unbatched form and revisits under Milestone 4.
- Any change to `wallet_state`/`CheckpointWalletStateStore` adapter logic (`design/design.md` §9)
  — that is `midnight-dev-env`-side integration, out of this repo's scope per Sprint 1's own
  non-goals.
- Lean formalization work — parallel, independent workstream, as stated in every prior sprint's
  proposal.

## Impact

- **New in this repo**: `src/postgres/checkpoint-store.ts` (`PgCheckpointStore`), a new migration
  `src/postgres/migrations/002_checkpoint_store.ts`, and `test/postgres/checkpoint-store.test.ts`
  + `checkpoint-store.property.test.ts` (P6-P8).
- **Modified**: `src/postgres/errors.ts` gains translations for this module's constraint
  violations; `src/postgres/migrate.ts`'s `migrations` array gains the new migration.
- **Risk**: this module's correctness bar is GC safety (Law C2a, `Formal/STORAGE_ALGEBRA.md` §2)
  — a chunk reclaimed while a live manifest still references it is silent, permanent data loss
  discovered only later, as a `ChunkMissingError` on an unrelated `load()` call far away in time
  from the bug that caused it. This is the sprint's hardest acceptance bar, the same way Law T3
  was Sprint 1's.
- **Risk, this change's own addition**: the `position`-column fix above is new, unreviewed
  design — it has not had the benefit of `design/design.md` §3's own prior audit rounds the way
  the rest of that section has. It is exactly the kind of finding this sprint's own review cycle
  (Opus panel, Fable 5 consolidation, Codex GPT-5.6 Sol audit) exists to pressure-test before
  implementation starts.
- **Delivery**: matches Sprint 1/2's cadence — this proposal/design/tasks/spec drafted and
  reviewed first (3-agent Opus panel + Fable 5 consolidation + Codex GPT-5.6 Sol audit), *then* a
  Sonnet builder implements against it with two parallel Opus auditors per task.
