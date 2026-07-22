# Tasks — Full-Chain Storage: Test Plan & Acceptance Criteria

This file is this change's only checkbox/status authority. Phase 0 is this change's own
specification-freeze gate (mirrors `sprint-8.../tasks.md` §0, `sprint-9.../tasks.md` §0). Phases 1+
are the eventual implementation's task breakdown — they belong to whichever branch actually builds
the ingestion/sync code (the v2 schema work on `fix/full-chain-storage-schema-v2` and its
successor implementation branch), reproduced here so that work has a concrete, AC-referenced
checklist to execute against and cannot merge with an AC silently unaddressed. Every task states a
concrete acceptance criterion (a passing test or a succeeding command), per `openspec/config.yaml`'s
tasks rule, and cites the AC-N(s) it closes.

## 0. Specification freeze (this change's own gate)

- [ ] 0.1 This proposal/design/tasks/spec authored, grounded in
  `design/full-chain-storage-design.md`, the v1 design-council audit findings, and this repo's
  existing EARS spec conventions (`sprint-8.../specs/wallet-state-envelope/spec.md`,
  `sprint-9.../specs/connection-robustness/spec.md`).
  - **Acceptance:** `test -f` succeeds for
    `openspec/changes/full-chain-storage-acceptance-criteria/{proposal.md,design.md,tasks.md,`
    `GATE.md,specs/full-chain-archive-verification/spec.md}`.
- [ ] 0.2 Strict-validate this change and the full corpus.
  - **Acceptance:** `npx openspec validate full-chain-storage-acceptance-criteria --strict` and
    `npx openspec validate --all --strict` both exit 0.
- [ ] 0.3 Correctness-audit pass (`AGENTS.md`'s three-persona review — domain-correctness,
  adversarial, release/coverage) confirms every AC-1..AC-10 is falsifiable, has at least one
  concrete scenario, and has no schema-name-specific wording that would break under the v2
  revision.
  - **Acceptance:** the correctness auditor's verdict recorded in `GATE.md` as CONFIRM (or its
    findings fixed and re-reviewed), no open BLOCK.
- [ ] 0.4 Commit on `spec/full-chain-storage-acceptance-criteria`, push the branch. Do NOT merge to
  `feature/full-chain-storage` or `main`.
  - **Acceptance:** branch pushed; no force-push, no `--no-verify`.

## 1. Fork/reorg correctness (AC-1)

- [ ] 1.1 Test: insert competing blocks A and B at the same height with an overlapping transaction
  hash; both persist in full.
  - **Acceptance:** the scenario "Block A and Block B at height H, sharing a transaction hash,
    both persist" (spec AC-1) passes against the schema under test; fails (demonstrating it is a
    real regression test) against v1's `PRIMARY KEY (block_height, tx_hash)` shape.
- [ ] 1.2 Test: a reorg away from block A does not delete A's transaction rows.
  - **Acceptance:** the "later reorg does not delete the losing fork's transaction rows" scenario
    passes.

## 2. Canonical-chain uniqueness (AC-2)

- [ ] 2.1 Empirically verify which Postgres mechanism enforces "at most one canonical block per
  height" for the chosen schema (partial unique index, exclusion constraint, serialized
  application-level check, or other) — this verification is explicitly the v2 schema revision's
  job, consumed here.
  - **Acceptance:** the mechanism is named and cited (file:line in the final migration) in this
    task's completion note.
- [ ] 2.2 Adversarial test: attempt to mark two blocks at the same height canonical simultaneously;
  the attempt is rejected or made unobservable as a two-canonical-rows state.
  - **Acceptance:** the "second canonical row at the same height is rejected" scenario (AC-2)
    passes; a mutation test that disables the enforcement mechanism causes this test to fail,
    proving it is not vacuous.
- [ ] 2.3 Test: a correct reorg flip is observed as a single atomic state transition by a
  concurrent reader.
  - **Acceptance:** the "correct reorg flip is a single observable state transition" scenario
    (AC-2) passes.

## 3. Content-addressed blob integrity (AC-3)

- [ ] 3.1 Test: every blob category (header/body/tx-raw/proof/verifier-key or whatever the final
  schema stores) round-trips and its content hash-matches its key.
  - **Acceptance:** the "stored blob round-trips" scenario (AC-3) passes for every blob category
    the schema defines.
- [ ] 3.2 Test: out-of-band mutation of stored bytes is caught on the next read via a rehash
  comparison, mirroring `CheckpointStore.loadImpl`'s `ChunkIntegrityError` path.
  - **Acceptance:** the "out-of-band corruption... is caught on the next read" scenario (AC-3)
    passes; the corrupted read raises a typed integrity error, never the corrupted bytes.

## 4. Replay-recoverability — the hard gate (AC-4)

- [ ] 4.1 Reconstruct one real shielded (zswap) event purely from archived raw block/transaction
  bytes and confirm it matches the indexer's independently-reported value.
  - **Acceptance:** the "shielded (zswap) event is reconstructed... and matches the indexer"
    scenario (AC-4) passes with no live node/indexer query during reconstruction itself.
- [ ] 4.2 Same for one real unshielded UTXO event.
  - **Acceptance:** the "unshielded UTXO event is reconstructed..." scenario (AC-4) passes.
- [ ] 4.3 Same for one real dust event.
  - **Acceptance:** the "dust event is reconstructed..." scenario (AC-4) passes.
- [ ] 4.4 For any category where 4.1-4.3 (or an equivalent test for a future deferred category)
  cannot be made to pass, reclassify that category to "build now" with its own dedicated table,
  and correct `design/full-chain-storage-design.md` §6's phasing table entry.
  - **Acceptance:** either all of 4.1-4.3 pass as specified, or the design doc is amended to move
    the failing category out of "deferred" before this change's implementation may merge — there
    is no third outcome.

## 5. Chain identity isolation (AC-5)

- [ ] 5.1 Test: ingest data from two networks (e.g. `undeployed` and `preview`) into one archive
  instance; confirm queries scoped to each network return only that network's rows.
  - **Acceptance:** the "two networks ingested into one archive remain queryable only within
    their own scope" scenario (AC-5) passes.
- [ ] 5.2 Test: a contrived height/hash coincidence across two networks does not cause
  cross-network leakage.
  - **Acceptance:** the "height/hash coincidence across two networks" scenario (AC-5) passes.

## 6. Partition/rollover correctness at scale (AC-6)

- [ ] 6.1 Test: ingest data spanning a real partition boundary (including an explicit rollover
  step if the implementation requires one); confirm no data loss on either side.
  - **Acceptance:** the "ingesting across a partition boundary loses no data" scenario (AC-6)
    passes.
- [ ] 6.2 Test: a range query spanning the boundary returns the complete, correctly-ordered,
  non-duplicated result.
  - **Acceptance:** the "range query spanning the boundary" scenario (AC-6) passes.

## 7. Architectural boundary compliance (AC-7)

- [ ] 7.1 Build the automated guard test (mirroring `test/postgres/no-sdk-import-guard.test.ts`'s
  whole-file, not per-line, check) confirming no module under `src/` references the node-RPC or
  indexer-GraphQL client used for ingestion.
  - **Acceptance:** the "no module under `src/` imports node-RPC or indexer-GraphQL client code"
    scenario (AC-7) passes.
- [ ] 7.2 Prove the guard is non-vacuous by temporarily introducing a disallowed import during
  review and confirming the guard fails, then removing it.
  - **Acceptance:** the "guard fails if ingestion code is added directly under `src/postgres/*`"
    scenario (AC-7) is demonstrated and recorded in the review notes.

## 8. Live cross-validation against a real public-testnet stack (AC-8, named gate)

- [ ] 8.1 Once the from-source, pinned-version node/indexer/proof-server stack can sync against
  Preview or Preprod, ingest a contiguous block/transaction range from that live stack into the
  archive.
  - **Acceptance:** the archive holds a contiguous height range sourced from the live stack, not
    from `undeployed`.
- [ ] 8.2 Cross-validate every archived block and transaction in that range against values queried
  directly from the live public network.
  - **Acceptance:** the "every archived block in a range matches the live network's own reported
    value" scenario (AC-8) passes; the "cross-validation mismatch is a hard failure" scenario
    (AC-8) is honored (any mismatch fails the run, not merely logs it).
  - **Note:** this task is gated on infrastructure (the live stack) that does not yet exist for
    this change; it is recorded here as the eventual implementation's required final gate, not
    something this change itself executes.

## 9. Migration/schema hygiene non-regression (AC-9)

- [ ] 9.1 Confirm every pre-existing passing test still passes after the feature lands.
  - **Acceptance:** `npm test` all green, including the pre-existing baseline
    (`test/postgres/migrate.test.ts`, `test/postgres/no-sdk-import-guard.test.ts`, and every other
    existing suite).
- [ ] 9.2 Update `migrate.test.ts`'s migration-count assertion deliberately (not silently) for the
  new migration(s).
  - **Acceptance:** the "full existing test suite remains green" scenario (AC-9) passes, with the
    updated count reviewed as a deliberate change, not a broken/skipped assertion.

## 10. Performance sanity (AC-10)

- [ ] 10.1 At a realistic minimum ingested volume, run `EXPLAIN` against get-block-by-height,
  get-transaction-by-hash, and get-canonical-chain-in-range; confirm each uses an index/
  partition-pruned scan, not a sequential scan.
  - **Acceptance:** all three "EXPLAIN confirms..." scenarios (AC-10) pass.

## 11. Audit chain + verify gate (`AGENTS.md`)

- [ ] 11.1 Three-persona Opus panel (domain-correctness, adversarial, release/coverage) + Codex
  gpt-5.6-sol cold audit + Fable aggregation on the eventual implementation against this spec.
  - **Acceptance:** every requirement in `specs/full-chain-archive-verification/spec.md` maps to a
    passing test (Fable cross-check); no open BLOCK.
- [ ] 11.2 Full verify gate for the eventual implementation.
  - **Acceptance:** `npm test` all green, `tsc --noEmit` clean, `npx openspec validate --all
    --strict` clean, `graphify update .` clean, AC-1 through AC-10 each demonstrably covered.
- [ ] 11.3 Commit and push the implementation branch. Merge to `feature/full-chain-storage` and
  eventually `main` only after this file's phases 1-11 are complete and the audit gate (11.1)
  returns CONFIRM/PASS.
  - **Acceptance:** branch pushed; merge gated on this file's own completion, not attempted before
    it.
