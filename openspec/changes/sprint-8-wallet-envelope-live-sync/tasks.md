# Tasks — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery

This file is the sprint's only checkbox/status authority. Every phase closes only after its
specified persona review passes or all findings are fixed and re-reviewed (`AGENTS.md`). All boxes
below are unchecked: this draft has not yet been through Phase 0.

## 0. Specification freeze

- [ ] 0.1 This proposal/design/tasks/spec, closing Sprint 7's deferred envelope (`design.md` §5)
  and live tier (§7) and adding the adapter seam.
  - **Acceptance:** `test -f` succeeds for `openspec/changes/sprint-8-wallet-envelope-live-sync/`
    `{proposal.md,design.md,tasks.md,specs/wallet-state-envelope/spec.md}`.
- [ ] 0.2 Validate this change and the full OpenSpec corpus with strict validation.
  - **Acceptance:** `npx openspec validate sprint-8-wallet-envelope-live-sync --strict` and
    `npx openspec validate --all --strict` both exit 0.
- [ ] 0.3 Regenerate Graphify for the frozen specification and diagnose the generated multigraph.
  - **Acceptance:** `graphify update .` and `graphify diagnose multigraph --graph
    graphify-out/graph.json --json` both exit 0; only repository-owned Graphify outputs appear in
    `git status --short`.
- [ ] 0.4 Run independent domain-correctness, adversarial, and release/process-planning reviews
  (`AGENTS.md`'s three-persona pattern) on this planning tranche. Reviewers must specifically
  adjudicate the two correctness-gate open questions (`design.md` §3.2 lifecycle-detail fidelity;
  §5 cross-sub-wallet consistency) and confirm the envelope decision (a) and the accepted weaker
  consistency contract are stated as binding spec text, not left implicit.
  - **Acceptance:** three distinct read-only persona reports name the exact planning files and
    return `PASS`.
- [ ] 0.5 Commit and push the audited planning tranche, then open a draft sprint PR.
  - **Acceptance:** `git status --short` is clean and a draft GitHub PR exists for this branch.

## 1. Vendor/pin manifest (for the nightly live tier)

- [ ] 1.1 Record the exact `midnight-wallet` commit this sprint's live/cold-boot tiers build
  against (`git -C ~/repos/midnight-wallet rev-parse HEAD` — currently
  `e744d994fc94d7770fbd2c802d7bd4480cce83db`), the SDK package versions
  (`packages/*/package.json`), the public preprod endpoints
  (`design/environment/preprod-connection.md`), and note that the Pg-only required gate needs none
  of this.
  - **Acceptance:** a `design/`-adjacent pin file records the commit SHA and endpoint set; the
    Pg-only gate has zero dependency on it.

## 2. Envelope module (Pg-only — required gate)

- [ ] 2.1 Add `src/interfaces/wallet-state-envelope.ts`: the `WalletStateEnvelope` type, its Zod
  schema, the `ENVELOPE_VERSION` constant, and `encode`/`decode` (with version + JSON-shape
  guards). No `@midnightntwrk/*` import; sub-wallet strings typed opaque.
  - **Acceptance:** `npm run typecheck` passes with the new file; a targeted `rg` finds no
    `@midnightntwrk` import in the file.
- [ ] 2.2 Add `src/postgres/wallet-state-envelope.ts`: `PgWalletStateEnvelopeStore` wrapping an
  injected `CheckpointStore` — `save` encodes → `CheckpointStore.save`; `load` →
  `CheckpointStore.load` → decode + version-check. No new migration (reuses CheckpointStore
  storage).
  - **Acceptance:** `specs/wallet-state-envelope/spec.md`'s save/load round-trip scenario passes
    against a real Postgres container; no new file in `src/postgres/migrations/`.
- [ ] 2.3 Version + corruption guards: `decode` of an unrecognized `envelopeVersion` or a
  corrupt/non-JSON payload rejects with the typed envelope error, never a best-effort restore.
  - **Acceptance:** the two IF-unwanted scenarios (unrecognized version; corrupt envelope) pass.

## 3. Adapter seam (Pg-only for its own tier — required gate)

- [ ] 3.1 Implement the `test/`-tier adapter mapping the SDK `TransactionHistoryStorage`
  (`TransactionHistoryStorage.ts:163-216`) onto `PgTransactionHistoryStorage`, constructed with the
  caller-supplied merge function (`test/postgres/reference-merge.ts` in the Pg-only tier;
  `mergeWalletEntries` in the live tier). Adapter lives outside `src/`.
  - **Acceptance:** `rg` finds no `@midnightntwrk/*` runtime import anywhere under `src/`; the
    adapter compiles against the real SDK types.
- [ ] 3.2 Lifecycle-detail round-trip (`design.md` §3.2, decision (i)): the adapter persists
  `submittedAt`/`finalizedBlock`/`rejectedAt`/`reason` (into a non-reserved `sections` key — must
  NOT start with `THS_RESERVED_KEY_PREFIX`) and reconstructs a schema-valid SDK lifecycle on
  `getAll()`.
  - **Acceptance:** a scripted `got*` trace read back via `getAll()` decodes cleanly against the
    SDK's `TransactionHistoryEntryCommonSchema` (`TransactionHistoryStorage.ts:75-85`), lifecycle
    detail intact — the IF-unwanted lifecycle-fidelity scenario passes.
- [ ] 3.3 Map the round-trip-critical common fields (`timestamp:Date`, `fees:bigint|null`) so
  `getAll()` returns live `bigint`/`Date` values (inherits Sprint 7's requirement through the
  adapter, verified end-to-end here).
  - **Acceptance:** `typeof entry.fees === "bigint"` and `entry.timestamp instanceof Date` after a
    round-trip through the adapter.

## 4. Pg-only conformance suite (required merge gate) — `test:conformance`

- [ ] 4.1 Envelope unit + fast-check property tests: `decode(encode(x)) ≡ x` for arbitrary
  sub-wallet strings, any sub-wallet absent/`null`.
- [ ] 4.2 `PgWalletStateEnvelopeStore` save/load round-trip against a Postgres container (latest +
  by-sequence; not-saved → `CheckpointNotFoundError`).
- [ ] 4.3 Adapter seam round-trip against a Postgres container (scripted SDK-shaped `got*` →
  `getAll()` yields schema-valid SDK entries).
- [ ] 4.4 No-runtime-SDK-import guards for both new `src/` modules.
- [ ] 4.5 Wire `test:conformance` in `package.json` as a required merge-gate script — Pg container
  only, no wallet SDK, no devnet.
  - **Acceptance:** `npm run test:conformance` exits 0 in CI with only a Postgres service
    container.

## 5. Live preprod DB-sync + cold-boot tiers (nightly/labeled — NOT a required gate)

- [ ] 5.1 Live DB-sync test (`design.md` §4): adapt `preprodUnshieldedSync.manual.integration.test.ts`
  to inject the adapter as `config.txHistoryStorage`; sync the funded unshielded wallet against
  public preprod; assert `balances[nativeToken] === 1_000_000_000n` AND the `b194e71d…493341` row
  is present via `pgStorage.getAll()`.
  - **Acceptance:** the live DB-sync scenario passes against public preprod with a real Postgres
    backend; the DB row for `b194e71d…` is observed.
- [ ] 5.2 Cold-boot recovery test (`design.md` §5): sync → `unshielded.serializeState()` → envelope
  → `save` → destroy wallet+process → fresh process → `load` → restore → `getAll()`; assert resume
  without full resync AND tx-history continuity off the Pg store.
  - **Acceptance:** the restored wallet resumes from its snapshot cursor (no genesis rescan) and
    `getAll()` still returns the `b194e71d…` row after the cold boot.
- [ ] 5.3 Wire `test:live` in `package.json` as a nightly/labeled script, not a required merge gate.
  - **Acceptance:** `test:live` is excluded from the required PR gate and runs on the nightly/labeled
    trigger only.

## 6. Close-out

- [ ] 6.1 Integrate current `main` into the branch before final artifacts, then re-run the Pg-only
  required gate.
- [ ] 6.2 Update `README.md`, `ROADMAP.md`, and the Sprint 7 change's status notes to record that
  Sprint 8 proves the storage module in situ (a real preprod row + a cold-boot resume), without
  overclaiming live-tier completion if Phase 5 is still open.
- [ ] 6.3 Regenerate Graphify after all source/spec/status edits.
- [ ] 6.4 Run the complete Pg-only release matrix (Phase 4) plus `npm run typecheck` and
  `npm run docs:storage:check`.
- [ ] 6.5 Commit the final tranche; obtain final `PASS` verdicts from three independent read-only
  personas on that exact commit (`AGENTS.md`), specifically re-checking the two correctness-gate
  open questions were resolved (or explicitly deferred to `verifiable-snapshot-recovery`) with
  binding spec text.
- [ ] 6.6 Push the exact audited head, require its green GitHub trust run, and record validation +
  audit evidence in the draft PR before requesting review.
