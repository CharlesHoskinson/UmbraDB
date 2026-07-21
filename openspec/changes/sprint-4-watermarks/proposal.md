# Proposal — Sprint 4: Watermarks

## Why

TemporalKV (Sprint 1), Transaction/Lease (Sprint 2), and CheckpointStore (Sprint 3) are all
implemented and merged. Watermarks is the last of the four core storage modules
(`ROADMAP.md`'s Milestone 2), and `design/tasks.md`'s phase map calls it out as "the smallest
remaining module" (`src/interfaces/watermarks.ts`) with no unresolved scope question blocking it
— unlike `PgPrivateStateProvider`/`PgWalletStateStore` (§6/§7), which stay explicitly out of
scope until that question is answered.

**This sprint's draft is grounded in a targeted research round, matching this project's own
established practice of not drafting a schema from assumption alone** (Sprint 1's design was
"grounded in deep research... 105-agent fan-out research" before its first draft; every sprint
since has cross-checked its own design against real production precedent). Before writing this
proposal, three independent research passes (each using real web fetches, not answering from
memory) investigated: (1) whether a small, extremely-high-churn "cursor" table has a known
Postgres operational pitfall this project hasn't hit yet; (2) how real production systems
(Debezium, Solana, Sui, Aptos, and Midnight's own real indexer schema) actually model sync-cursor
storage; (3) JSONB round-trip pitfalls specific to an opaque, caller-defined progress value. All
three are cited by section number throughout `design.md` below.

**Headline finding, stated up front because it corrects this repo's own prior documentation**:
`design/design.md` §4 currently says Watermarks needs "no design change" from its original sketch.
That is right about the *logical* schema (`(kind, key, value, updated_at)` is validated almost
exactly by Debezium's own `debezium_offset_storage` table) but wrong about *physical storage
parameters* — a table updated on every sync tick is exactly the shape (few rows, extremely
frequent per-row `UPDATE`) that benefits from an explicit `fillfactor` tuned for HOT (Heap-Only
Tuple) updates, which the original sketch never considered. This proposal is the first document
to specify that correction.

## What changes

1. **`PgWatermarks`**: the Postgres implementation of `src/interfaces/watermarks.ts` — `set`/`get`
   — against the schema in `design/design.md` §4, with one physical-parameter addition (an
   explicit `fillfactor`, `design.md` §1) this change makes at a level of detail that document
   never went to, plus a documented caller convention for large numeric cursor values (`design.md`
   §4) closing a real, research-found gap between what Postgres stores and what the JS driver
   returns.
2. **Composing Transaction/Lease directly via `opts.tx`** — unlike `CheckpointStore` (which
   composes `withTransaction` internally and exposes no `tx` option), `Watermarks`' interface
   accepts a caller-supplied `TransactionHandle` directly on both `set` and `get`, the same pattern
   `TemporalKV` already uses. This sprint wires that composition for the first time for this
   module.
3. **Cancellation**: pre-check-only `withAbort`, matching `PgTemporalKV.get`/`put` — Watermarks has
   no lock waits and no open cursors, so (per the research consolidation, and consistent with
   Sprint 3's own corrected understanding of `withAbort`'s real, narrower contract) there is
   nothing here that would ever justify the dedicated `raceAgainstAbort` mechanism `acquireLease`/
   `listKeys` use.

## Non-goals (explicitly out of scope for this sprint)

- `PgPrivateStateProvider`/`PgWalletStateStore` (`design/tasks.md` §6/§7) — unresolved scope
  question, not this sprint's to resolve.
- Any change to the shared `WatermarkValueSchema = JsonValueSchema` reuse
  (`src/interfaces/watermarks.ts`) — the research round found a real gap (large integers silently
  losing precision through the JS driver's `JSON.parse`), but the fix adopted here is a documented
  caller *convention*, not a schema-level refinement, specifically because `JsonValueSchema` is
  shared with `TemporalKV` and narrowing it would change that already-implemented, already-audited
  module's contract too — out of scope for a Watermarks-only sprint. See `design.md` §4's own
  reasoning for this choice.
- Per-table `autovacuum` tuning (`design.md` §1) — the research found this is not the first lever
  for this table's shape (the row-count threshold and `autovacuum_naptime` dominate at this size;
  HOT pruning does the real work); this sprint adds a monitoring assertion instead of any
  `autovacuum_vacuum_*` override, revisit only if that assertion actually degrades in practice.
- Typed columns in place of the opaque `jsonb value` column (an alternative real systems — Sui,
  Aptos — actually chose) — considered and declined, `design.md` §5's accepted-tradeoffs section
  states why explicitly rather than leaving the alternative unaddressed.
- A `jsonb_typeof` CHECK constraint on `value`'s shape — considered (a real, cheap, commonly-
  recommended pattern per the research) and declined because it would contradict this module's
  deliberate no-fixed-shape contract; validation stays at the Zod boundary only.
- Lean formalization work — parallel, independent workstream, as stated in every prior sprint's
  proposal.

## Impact

- **New in this repo**: `src/postgres/watermarks.ts` (`PgWatermarks`), a new migration
  `src/postgres/migrations/003_watermarks.ts`, and `test/postgres/watermarks.test.ts` +
  `watermarks.property.test.ts` (P9, `Formal/STORAGE_ALGEBRA.md` §5).
- **Modified**: `src/postgres/migrate.ts`'s `migrations` array gains the new migration;
  `src/interfaces/watermarks.ts` gains a TSDoc note on `WatermarkValue` documenting the
  large-integer-as-decimal-string convention (no type or schema change, doc-only).
- **Risk**: this is the smallest and lowest-risk module in the project by a wide margin — no
  transaction composition of its own to get wrong (unlike CheckpointStore), no versioning
  algebra to satisfy (unlike TemporalKV), a single-row upsert with well-understood Postgres
  semantics. The one genuine risk this sprint's own research surfaced is silent, not loud: a
  cursor value large enough to exceed `Number.MAX_SAFE_INTEGER` would corrupt on read with no
  error at all, anywhere in the stack, unless the documented string-encoding convention is
  actually followed by every caller — a documentation/discipline risk, not a code-correctness one.
- **Delivery**: matches Sprint 1-3's cadence — this proposal/design/tasks/spec drafted and
  reviewed first (3-agent Opus panel + Fable 5 consolidation + Codex GPT-5.6 Sol audit, preceded
  this time by the research round already described above), *then* a Sonnet builder implements
  against it with two parallel Opus auditors per task.
