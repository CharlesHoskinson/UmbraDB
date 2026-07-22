# Tasks — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery

This file is the sprint's only checkbox/status authority. Every phase closes only after its
specified persona review passes or all findings are fixed and re-reviewed (`AGENTS.md`).

**Status update (F9, this commit):** the implementation described by Phases 0-5 below was built,
then put through a 4-auditor cross-vendor panel, which returned 3 `BLOCK` verdicts (F1/F2/F3 among
the blocking findings, plus several must-fix items F4-F8). This commit fixes every Batch 1
(blocker) and Batch 2 (must-fix/gate/pin/doc) finding from that panel's consolidated fix plan.
Boxes below are checked where the underlying deliverable is objectively done and verified (a
command was run and its output confirmed in this pass) — see each box's own note. Boxes that
require a THIRD PARTY action this commit cannot itself perform (a fresh multi-persona **PASS**
re-audit of this exact commit; pushing and opening/updating the PR) are deliberately left
UNCHECKED, not rubber-stamped — that is the re-audit's and orchestrator's job, tracked at 0.4/6.5
and 0.5/6.6 respectively. See "Deferred to Sprint 9" at the end of this file for findings this
commit intentionally does NOT implement.

## 0. Specification freeze

- [x] 0.1 This proposal/design/tasks/spec, closing Sprint 7's deferred envelope (`design.md` §5)
  and live tier (§7) and adding the adapter seam.
  - **Acceptance:** `test -f` succeeds for `openspec/changes/sprint-8-wallet-envelope-live-sync/`
    `{proposal.md,design.md,tasks.md,specs/wallet-state-envelope/spec.md}`. Verified this pass —
    all four files exist and are current (design.md/spec.md/tasks.md updated by this commit's audit
    fixes; `proposal.md`'s status line updated to match, below).
- [x] 0.2 Validate this change and the full OpenSpec corpus with strict validation.
  - **Acceptance:** `npx openspec validate sprint-8-wallet-envelope-live-sync --strict` and
    `npx openspec validate --all --strict` both exit 0. Verified this pass — both commands exit 0
    (the full corpus: 8/8 items pass, including this change).
- [x] 0.3 Regenerate Graphify for the frozen specification and diagnose the generated multigraph.
  - **Acceptance:** `graphify update .` and `graphify diagnose multigraph --graph
    graphify-out/graph.json --json` both exit 0; only repository-owned Graphify outputs appear in
    `git status --short`. Verified this pass — both exit 0 (1088 nodes, 1800 edges, 105
    communities); only the pre-existing, repo-tracked `graphify-out/{graph.json,graph.html,
    GRAPH_REPORT.md,manifest.json}` changed.
- [ ] 0.4 Run independent domain-correctness, adversarial, and release/process-planning reviews
  (`AGENTS.md`'s three-persona pattern) on this planning tranche. Reviewers must specifically
  adjudicate the two correctness-gate open questions (`design.md` §3.2 lifecycle-detail fidelity;
  §5 cross-sub-wallet consistency) and confirm the envelope decision (a) and the accepted weaker
  consistency contract are stated as binding spec text, not left implicit.
  - **Acceptance:** three distinct read-only persona reports name the exact planning files and
    return `PASS`. **NOT done by this commit** — the 4-auditor panel already ran once (3 `BLOCK`);
    this commit is the fix pass for that panel's findings. A fresh re-audit of THIS exact commit is
    the re-audit step this box tracks; left unchecked until that PASS verdict is in hand.
- [ ] 0.5 Commit and push the audited planning tranche, then open a draft sprint PR.
  - **Acceptance:** `git status --short` is clean and a draft GitHub PR exists for this branch.
  This commit closes the "clean tree" half; pushing/opening-or-updating the PR is the orchestrator's
  step, not performed here (left unchecked; see the report-back notes in the PR/commit trail).

## 1. Vendor/pin manifest (for the nightly live tier)

- [x] 1.1 Record the exact `midnight-wallet` commit this sprint's live/cold-boot tiers build
  against (`git -C ~/repos/midnight-wallet rev-parse HEAD` — currently
  `e744d994fc94d7770fbd2c802d7bd4480cce83db`), the SDK package versions
  (`packages/*/package.json`), the public preprod endpoints
  (`design/environment/preprod-connection.md`), and note that the Pg-only required gate needs none
  of this.
  - **Acceptance:** a `design/`-adjacent pin file records the commit SHA and endpoint set; the
    Pg-only gate has zero dependency on it. `design/environment/versions.lock.json` records the
    commit SHA (`midnight_repos.midnight-wallet`), the `effect`/`@midnightntwrk/wallet-sdk-
    abstractions` devDependency pins (F9: `effect` now exact-pinned at `3.22.0`, replacing the
    prior `^3.19.19` range), and the live-run evidence (below).
  - **F9 live-run evidence (recorded here, not only in `versions.lock.json`):** `versions.lock.json`
    `.faucet`/`.sprint_8_wallet_envelope_adapter.live_run_confirmed` records that on 2026-07-22 both
    `test:live` tests passed against public preprod: `preprod-db-sync` observed the faucet tx
    `b194e71d4d22ed09846cd88aab67c6bb4eec69ea6df5aead3bdb22bfe3493341` (identifier
    `00ea17cf14c2aa1b6bf867d247cb2b8e3ff016444e086451de7aa4e70062a20bea`) as a UmbraDB row;
    `cold-boot-recovery` observed the restored wallet's initial `progress.appliedId = 505701n`
    (nonzero — proof of resume from the snapshot cursor, not genesis). **Caveat:** that run predates
    this commit's F3 fix (routing the DB-sync/cold-boot read side through the adapter's own
    `getAll()` instead of a raw `PgTransactionHistoryStorage` instance) — the live/cold-boot test
    FILES have since been edited (F3) and must typecheck/compile (verified: `npm run typecheck`
    clean) but have NOT been re-run against real preprod with those edits in place. The orchestrator
    re-running `npm run test:live` against real preprod is the pending confirmation this box notes.

## 2. Envelope module (Pg-only — required gate)

- [x] 2.1 Add `src/interfaces/wallet-state-envelope.ts`: the `WalletStateEnvelope` type, its Zod
  schema, the `ENVELOPE_VERSION` constant, and `encode`/`decode` (with version + JSON-shape
  guards). No `@midnightntwrk/*` import; sub-wallet strings typed opaque.
  - **Acceptance:** `npm run typecheck` passes with the new file; a targeted `rg` finds no
    `@midnightntwrk` import in the file. Verified this pass. **F7 fix (this commit):** the schema is
    now `.strict()` at both object levels (fail-closed on an unknown top-level or `subWallets`
    field).
- [x] 2.2 Add `src/postgres/wallet-state-envelope.ts`: `PgWalletStateEnvelopeStore` wrapping an
  injected `CheckpointStore` — `save` encodes → `CheckpointStore.save`; `load` →
  `CheckpointStore.load` → decode + version-check. No new migration (reuses CheckpointStore
  storage).
  - **Acceptance:** `specs/wallet-state-envelope/spec.md`'s save/load round-trip scenario passes
    against a real Postgres container; no new file in `src/postgres/migrations/`. Verified this
    pass (`test/postgres/wallet-state-envelope.test.ts`, 22 tests green). **F8 fix (this commit):**
    `save` now rejects with `ValidationError` when the envelope's own echoed `walletId`/`networkId`
    do not match the call args, symmetric with `load`'s existing cross-check.
- [x] 2.3 Version + corruption guards: `decode` of an unrecognized `envelopeVersion` or a
  corrupt/non-JSON payload rejects with the typed envelope error, never a best-effort restore.
  - **Acceptance:** the two IF-unwanted scenarios (unrecognized version; corrupt envelope) pass.
    Verified this pass, plus F7's new unknown-top-level-field scenario.

## 3. Adapter seam (Pg-only for its own tier — required gate)

- [x] 3.1 Implement the `test/`-tier adapter mapping the SDK `TransactionHistoryStorage`
  (`TransactionHistoryStorage.ts:163-216`) onto `PgTransactionHistoryStorage`, constructed with the
  caller-supplied merge function (`test/postgres/reference-merge.ts`'s `referenceMergeEntries`, in
  BOTH the Pg-only tier and the live tier). Adapter lives outside `src/`. **Audit correction (F1):**
  the earlier draft of this task claimed the live tier injects the real SDK's `mergeWalletEntries`
  — false; the raw SDK function operates on a different entry shape and assumes both merge operands
  are always defined (throws on the first write of a hash), so it cannot be injected here at all.
  Both tiers inject `referenceMergeEntries`, an UmbraDB-shaped function mirroring the SDK's
  documented merge semantics. **F1(c) parity test**
  (`test/postgres/reference-merge-parity.test.ts`): a REAL runtime diff was achieved -- the facade
  package's `dist` script built cleanly (after first building its two then-missing workspace
  dependencies) well under the ~10 minute budget -- dynamically importing the real
  `mergeWalletEntries`/`mergeUnshieldedSections` and diffing their output against
  `referenceMergeEntries`'s on translated inputs (identifiers, scalar facts, lifecycle, per-section
  merge), gated on `facadeMergeAvailable()` so it degrades to skipped (not failing) where the
  sibling checkout is not built. An unconditional, dependency-free source-faithful rule-assertion
  half of the same file is the required-gate-safe fallback/baseline (`design.md` §3.3).
  - **Acceptance:** `rg` finds no `@midnightntwrk/*` runtime import anywhere under `src/`; the
    adapter compiles against the real SDK types.
- [x] 3.2 Lifecycle-detail round-trip (`design.md` §3.2, decision (i)): the adapter persists
  `submittedAt`/`finalizedBlock`/`rejectedAt`/`reason` (into a non-reserved `sections` key — must
  NOT start with `THS_RESERVED_KEY_PREFIX`) and reconstructs a schema-valid SDK lifecycle on
  `getAll()`.
  - **Acceptance:** a scripted `got*` trace read back via `getAll()` decodes cleanly against the
    SDK's `TransactionHistoryEntryCommonSchema` (`TransactionHistoryStorage.ts:75-85`), lifecycle
    detail intact — the IF-unwanted lifecycle-fidelity scenario passes. Verified this pass. **F2
    fix (this commit):** the stash key is renamed to `UMBRADB_ADAPTER_LIFECYCLE_DETAIL_KEY`
    (`__umbradb_adapter_lifecycle_detail`) under a dedicated reserved prefix; the write path now
    THROWS `ValidationError` if an incoming entry's extension carries a key inside that reserved
    namespace (fail loud, no clobber); the read path Zod-validates the stashed shape before use and
    throws a typed, per-hash `SerializationFailedError` on a malformed stash. **F6 fix (this
    commit):** `mapSdkStatusToUmbra`/`mapUmbraStatusToSdk` now throw `SerializationFailedError` on
    an unmapped value in both directions instead of silently returning `undefined`.
- [x] 3.3 Map the round-trip-critical common fields (`timestamp:Date`, `fees:bigint|null`) so
  `getAll()` returns live `bigint`/`Date` values (inherits Sprint 7's requirement through the
  adapter, verified end-to-end here).
  - **Acceptance:** `typeof entry.fees === "bigint"` and `entry.timestamp instanceof Date` after a
    round-trip through the adapter. Verified this pass.

## 4. Pg-only conformance suite (required merge gate) — `test:conformance`

- [x] 4.1 Envelope unit + fast-check property tests: `decode(encode(x)) ≡ x` for arbitrary
  sub-wallet strings, any sub-wallet absent/`null`. Verified this pass
  (`test/postgres/wallet-state-envelope.property.test.ts`).
- [x] 4.2 `PgWalletStateEnvelopeStore` save/load round-trip against a Postgres container (latest +
  by-sequence; not-saved → `CheckpointNotFoundError`). Verified this pass.
- [x] 4.3 Adapter seam round-trip against a Postgres container (scripted SDK-shaped `got*` →
  `getAll()` yields schema-valid SDK entries). Verified this pass, plus F3's new GATE-tier test
  (`gotFinalized` → `getAll()` → real SDK schema + `finalizedBlock.height` equality, no env vars).
- [x] 4.4 No-runtime-SDK-import guards for both new `src/` modules. Verified this pass. **F4 fix
  (this commit):** `test/postgres/no-sdk-import-guard.test.ts` now checks the WHOLE FILE source for
  `@midnightntwrk` (not just lines starting with `import`), with a fixture proving the new guard
  catches a re-export shape the old per-line filter would have missed.
- [x] 4.5 Wire `test:conformance` in `package.json` as a required merge-gate script — Pg container
  only, no wallet SDK, no devnet.
  - **Acceptance:** `npm run test:conformance` exits 0 in CI with only a Postgres service
    container. Verified this pass locally (Testcontainers-managed Postgres, no external service
    needed). **F5 fix (this commit):** `.github/workflows/conformance.yml` added — runs
    `test:conformance` on `pull_request`/`push`/`workflow_dispatch`, `ubuntu-latest` (Docker already
    present for Testcontainers, no `services: postgres` needed), never the env-gated live tier.

## 5. Live preprod DB-sync + cold-boot tiers (nightly/labeled — NOT a required gate)

- [x] 5.1 Live DB-sync test (`design.md` §4): adapt `preprodUnshieldedSync.manual.integration.test.ts`
  to inject the adapter as `config.txHistoryStorage`; sync the funded unshielded wallet against
  public preprod; assert `balances[nativeToken] === 1_000_000_000n` AND the `b194e71d…493341` row
  is present via `adapter.getAll()`.
  - **Acceptance:** the live DB-sync scenario passes against public preprod with a real Postgres
    backend; the DB row for `b194e71d…` is observed. **Confirmed 2026-07-22** (see 1.1's live-run
    evidence) against the PRE-F3 version of this test (raw `pgStorage.getAll()`). **F3 fix (this
    commit):** the read side now goes through `adapter.getAll()` instead, additionally asserting the
    entry decodes against the real SDK schema with `finalizedBlock.height > 0` — typechecks/compiles
    (verified) but has NOT been re-run live with this exact edit; pending the orchestrator's
    `test:live` re-run.
- [x] 5.2 Cold-boot recovery test (`design.md` §5): sync → `unshielded.serializeState()` → envelope
  → `save` → destroy wallet+process → fresh process → `load` → restore → `getAll()`; assert resume
  without full resync AND tx-history continuity off the Pg store.
  - **Acceptance:** the restored wallet resumes from its snapshot cursor (no genesis rescan) and
    `getAll()` still returns the `b194e71d…` row after the cold boot. **Confirmed 2026-07-22** (see
    1.1's live-run evidence: restored `progress.appliedId = 505701n`) against the PRE-F3 version of
    this test. **F3 fix (this commit):** the AFTER-resume continuity read now goes through
    `adapterAfterRestart.getAll()` (the pre-restore row-presence read at line ~138 is deliberately
    KEPT as the one raw `PgTransactionHistoryStorage` read, proving row-presence-without-resync
    independent of the adapter) — typechecks/compiles (verified) but not yet re-run live with this
    exact edit; pending the orchestrator's `test:live` re-run.
- [x] 5.3 Wire `test:live` in `package.json` as a nightly/labeled script, not a required merge gate.
  - **Acceptance:** `test:live` is excluded from the required PR gate and runs on the nightly/labeled
    trigger only.

## 6. Close-out

- [ ] 6.1 Integrate current `main` into the branch before final artifacts, then re-run the Pg-only
  required gate. **Not performed by this commit** — out of this fix pass's scope (no `main`
  integration was requested); left for the orchestrator/close-out pass.
- [ ] 6.2 Update `README.md`, `ROADMAP.md`, and the Sprint 7 change's status notes to record that
  Sprint 8 proves the storage module in situ (a real preprod row + a cold-boot resume), without
  overclaiming live-tier completion if Phase 5 is still open. **Not performed by this commit** —
  out of this fix pass's explicit scope (the audit fix plan this commit implements does not include
  README/ROADMAP edits); left for the orchestrator/close-out pass.
- [x] 6.3 Regenerate Graphify after all source/spec/status edits. Done this commit — `graphify
  update .` re-run after every code/spec/tasks/proposal edit below (1088 nodes, 1800 edges, 105
  communities); `graphify diagnose multigraph` exits 0.
- [x] 6.4 Run the complete Pg-only release matrix (Phase 4) plus `npm run typecheck` and
  `npm run docs:storage:check`. Done this commit — all three green (see the commit's own verify
  step; exact pass/skip counts in the PR/report trail).
- [ ] 6.5 Commit the final tranche; obtain final `PASS` verdicts from three independent read-only
  personas on that exact commit (`AGENTS.md`), specifically re-checking the two correctness-gate
  open questions were resolved (or explicitly deferred to `verifiable-snapshot-recovery`) with
  binding spec text. Commit done this pass; the three-persona **PASS** re-audit itself is the
  re-audit step this fix pass exists to be re-checked against — left unchecked until that verdict
  is in hand (see 0.4).
- [ ] 6.6 Push the exact audited head, require its green GitHub trust run, and record validation +
  audit evidence in the draft PR before requesting review. **Not performed by this commit** — no
  push was requested; the orchestrator's job once the re-audit (6.5) passes.

## Deferred to Sprint 9 (Batch 3 — recorded as honest deferrals, NOT implemented here)

The consolidated 4-auditor fix plan explicitly scoped the following findings OUT of this fix pass
("Batch 3"). They are recorded here as tracked Sprint 9 work, not silently dropped:

- **"F10" — emit-SDK-shape-vs-typed-throw decision.** A broader design question for a future
  sprint: when the adapter's reconstruction cannot produce a fully faithful SDK-shaped lifecycle
  (beyond the specific malformed-stash case this commit's F2 fix already resolves via a typed
  throw), should the adapter ever have a LENIENT mode that emits a best-effort/degraded SDK shape
  instead of always throwing? Not decided or implemented here — this commit's own F2/F6 fixes are
  strictly fail-closed (typed throw, never a best-effort shape), and that stays the behavior unless
  Sprint 9 explicitly revisits it. **Note:** this label collides with the UNRELATED "F10 (serialize
  doc note)" finding from Batch 2 (§3.4 above, `design.md`/spec.md), which IS implemented in this
  commit — the two are distinct findings from the panel's consolidated numbering; flagged here so
  the re-audit does not conflate them.
- **F11 — cold-boot conflicting-history nightly test.** A new nightly/labeled scenario: a
  divergent Pg-vs-blob tx-history (the restored sub-wallet's own embedded history copy disagrees
  with what `PgTransactionHistoryStorage`/the adapter's `getAll()` returns) should still resolve to
  the restored wallet reading Pg via the adapter as authoritative. The existing cold-boot test only
  exercises the CONSISTENT case (Pg and the blob agree, because both come from the same real sync);
  a deliberately-diverged fixture is Sprint 9 work.
- **F12 — SDK-loader hardening.** `test/integration/live-fixtures/midnight-wallet-sdk-loader.ts`:
  (a) an environment-variable override point + a proper typed surface for the dynamically-loaded
  SDK modules (currently `Promise<any>` throughout, by design, per that file's own doc — a typed
  wrapper is future work, not a correctness bug); (b) zeroize the derived seed buffer after use
  (`deriveUnshieldedSeed` calls `hdWallet.clear()` on the HD wallet object but does not additionally
  zero the raw `seedBuffer`/derived key `Buffer` it builds along the way) to match `hdWallet.clear()`'s
  own defensive intent.
- **F2 defense-in-depth.** A SECOND layer of reserved-namespace protection at the Sprint-7
  `PgTransactionHistoryStorage` boundary itself — either a second reserved prefix scoped to
  adapter-level concerns (distinct from `THS_RESERVED_KEY_PREFIX`, which is Sprint 7's own, and
  `UMBRADB_ADAPTER_RESERVED_KEY_PREFIX`, which is enforced only at the adapter layer, this commit),
  or a dedicated, first-class lifecycle-detail COLUMN on the `transaction_history` table so the
  adapter's stash is not sharing the general-purpose `sections` JSONB at all. This commit's F2 fix
  (the adapter's own write-time reserved-key rejection + read-time Zod validation) is the complete
  fix for the finding as scoped; a second, storage-layer-level defense is an explicit Sprint 9
  hardening decision, not implemented here (would touch Sprint 7's already-audited surface, which
  this sprint's own proposal.md explicitly declines to silently patch).
