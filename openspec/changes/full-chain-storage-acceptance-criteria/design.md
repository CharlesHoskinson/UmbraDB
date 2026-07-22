# Design — Full-Chain Storage Test Plan & Acceptance Criteria

## 0. Scope and method

This change produces criteria, not code. Two constraints shape every requirement below:

1. **Schema-agnostic phrasing.** `design/full-chain-storage-design.md` is v1; a v2 revision is
   being drafted concurrently on `fix/full-chain-storage-schema-v2` to fix the PK bug, the
   canonical-uniqueness gap, the untested replay claim, `block_undo`'s premature shape, and the
   Tier-1/Tier-2 placement question (`design.md` §9.1). Every requirement below is written against
   an **observable property** ("at most one block per height is canonical," "a stored blob's
   content hashes to its key") rather than a table/column name, so it stays valid regardless of
   which schema revision ships. Where v1's design.md is cited, it is cited as the **motivating
   example** of the property under test, not as the required implementation shape.
2. **Falsifiability.** Per `openspec/config.yaml`'s tasks rule ("each task must state its
   acceptance criteria concretely — what test passes, what command succeeds"), every requirement
   below names a concrete test scenario with an unambiguous pass/fail condition, not a design
   intention. AC-4 in particular is written with no escape hatch: if a deferred data category
   cannot pass its replay test, the category must stop being deferred — that is a hard gate, not
   advisory language.

## 1. Why ten requirements, not one per v1 table

The ten acceptance criteria (AC-1 .. AC-10) map directly to the ten review areas named in this
change's task brief, each grounded in a specific, real problem found in v1 or a specific claim v1
makes that has not been tested:

| AC | Property under test | v1 grounding (motivating example only) |
|----|----|----|
| AC-1 | Fork/reorg correctness: two competing blocks at one height, each with a full tx set, both persist | `design.md` §4.3's `transactions` PK omits `block_hash` — the confirmed fork-breaking bug |
| AC-2 | At most one canonical block per height, enforced at the data-layer boundary | `design.md` §4.2's `is_canonical boolean` has no constraint; §5 states the invariant in prose only |
| AC-3 | Content-addressed blob integrity + corruption detection on read | Mirrors `CheckpointStore.loadImpl`'s proven `ChunkIntegrityError`/`ManifestCorruptError` rehash-on-read pattern (`src/postgres/checkpoint-store.ts:260-278`) |
| AC-4 | Replay-recoverability is proven, not assumed, for every deferred category | `design.md` §6's "Defer... replay-recoverable from raw transaction bytes" judgment calls (zswap, unshielded, dust) are asserted, never tested, anywhere in v1 |
| AC-5 | Chain identity isolation across networks | No network/chain-id scoping column or query-boundary test appears anywhere in v1 |
| AC-6 | Partition/rollover correctness at real scale | `design.md` §4.6: range partitioning is specified, rollover automation and its correctness are explicitly deferred and unverified |
| AC-7 | Ingestion/sync code lives outside `src/postgres/*` | Mirrors the proven pattern: `TransactionHistoryStorage`'s adapter seam (Sprint 8) and `test/postgres/no-sdk-import-guard.test.ts`'s whole-file guard |
| AC-8 | Live cross-validation against a real public-testnet stack | `design.md` §3 confirms only against a local `undeployed` devnet; no public-testnet run exists yet |
| AC-9 | No regression to existing passing tests | Standard gate mirroring `migrate.test.ts`'s existing 5-migration idempotency baseline and the SDK-import guard |
| AC-10 | Core query patterns use an index, not a sequential scan, at realistic volume | Not addressed anywhere in v1; `design.md` §4.6 only reasons about partitioning, never measures a plan |

## 2. Relationship to the parallel v2 schema work

This change does not block on v2 landing, and v2 does not block on this change landing — they are
independent artifacts that converge at the eventual implementation's `tasks.md`, which should cite
this spec's AC-N identifiers as its acceptance gate (mirrored in this change's own `tasks.md`
§0). If v2 changes the mechanism by which canonical uniqueness is enforced (a partial unique index,
an exclusion constraint, an application-level `SELECT ... FOR UPDATE` serialization, or something
the revision's own empirical verification lands on), AC-2 is satisfied by whichever mechanism
survives an adversarial concurrent-insert test — the requirement below intentionally does not name
one.

## 3. What "done" means for this change

`tasks.md` §0 tracks this specification's own freeze/validation, matching every other change in
this repo (`sprint-8.../tasks.md` §0, `sprint-9.../tasks.md` §0). This change is done when the spec
file validates under `openspec validate --strict`, every AC has at least one concrete scenario, and
the commit is pushed to `spec/full-chain-storage-acceptance-criteria` — not when the criteria are
satisfied, since satisfying them is the eventual implementation's job, tracked by its own
`tasks.md` referencing this one.
