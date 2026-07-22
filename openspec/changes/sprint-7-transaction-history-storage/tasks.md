# Tasks — Sprint 7: Transaction History Storage

This file is the sprint's only checkbox/status authority. Every phase closes only after its
specified persona review passes or all findings are fixed and re-reviewed (`AGENTS.md`). All
boxes below are unchecked: this draft has not yet been through Phase 0.

## 0. Specification freeze

- [ ] 0.1 This proposal/design/tasks/spec, translated from the twice-audited
  `design/sprint-5-recommendation.md`.
  - **Acceptance:** `test -f` succeeds for `openspec/changes/sprint-7-transaction-history-storage/`
    `{proposal.md,design.md,tasks.md,specs/transaction-history-storage/spec.md}`.
- [ ] 0.2 Validate this change and the full OpenSpec corpus with strict validation.
  - **Acceptance:** `openspec validate sprint-7-transaction-history-storage --strict` and
    `openspec validate --all --strict` both exit 0.
- [ ] 0.3 Resolve `design.md` §7's open question (what "preprod-connected" concretely means:
    endpoint, credentials/seed, or existing infrastructure to reuse) with the repo owner before
    Phase 4 is scheduled. Does not block Phases 1-3.
- [ ] 0.4 Regenerate Graphify for the frozen specification and diagnose the generated multigraph.
  - **Acceptance:** `graphify update .` and
    `graphify diagnose multigraph --graph graphify-out/graph.json --json` both exit 0; only
    repository-owned Graphify outputs appear in `git status --short`.
- [ ] 0.5 Run independent domain-correctness, adversarial, and release/process planning reviews
  (`AGENTS.md`'s three-persona pattern) on this planning tranche; resolve every blocking finding
  before any implementation code is written.
  - **Acceptance:** three distinct read-only persona reports name the exact planning files and
    return `PASS`.
- [ ] 0.6 Commit and push the audited planning tranche, then open a draft sprint PR.
  - **Acceptance:** `git status --short` is clean and a draft GitHub PR exists for this branch.

## 1. Vendor/pin manifest

- [ ] 1.1 Record the exact `midnight-wallet` commit this sprint is built against, SDK package
  versions (`packages/*/package.json`), and — for the Pg-only tier, which needs none of this —
  note explicitly that no image pins are required yet.
  - **Acceptance:** a `Formal/` or `design/`-adjacent pin file (exact path TBD in review) records
    the commit SHA `git -C ~/repos/midnight-wallet rev-parse HEAD` returns at time of pinning.

## 2. Schema + interface

- [ ] 2.1 Add `src/interfaces/transaction-history-storage.ts` mirroring the wallet SDK's
  `TransactionHistoryStorage` shape structurally (not importing it) — `getAll()`, `get(hash)`,
  `serialize()`, `gotPending(entry)`, `gotFinalized(entry)`, `gotRejected(entry)`.
  - **Acceptance:** `tsc --noEmit` passes with the new file included.
- [ ] 2.2 Add migration `00X_transaction_history.sql` per `design.md` §1's schema.
  - **Acceptance:** the migration applies cleanly against a fresh Postgres 17 instance and is
    registered in `src/postgres/migrate.ts`'s `migrations` array.

## 3. PgTransactionHistoryStorage implementation

- [ ] 3.1 Implement the row-lock atomic-merge write path (`design.md` §3) for
  `gotPending`/`gotFinalized`/`gotRejected`, with the merge function injected at construction
  (`design.md` §2 — no wallet-SDK runtime import).
  - **Acceptance:** `specs/transaction-history-storage/spec.md`'s concurrency-invariant scenario
    passes against real Postgres.
- [ ] 3.2 Implement `getAll()`/`get(hash)`/`serialize()` per the interface's fixed
  `Promise<string>` contract for `serialize()` (`design.md` §1).
  - **Acceptance:** `getAll()` returns live `bigint`/`Date`-typed values (no JSON-round-trip
    coercion to strings) — verified against `tx-history-asserts.ts`'s `typeof` checks.
- [ ] 3.3 Implement the identifier-subset pending-clear rule surviving repeated merges
  (`design.md` §3).
  - **Acceptance:** the corresponding scenario in `specs/transaction-history-storage/spec.md`
    passes, including the multi-merge case.
- [ ] 3.4 Translate all driver-level failures through the shared `StorageError` hierarchy
  (`src/interfaces/storage-errors.ts`), matching every other module's convention.
  - **Acceptance:** no raw `postgres.js` error escapes any of the six methods.

## 4. WalletState envelope

- [ ] 4.1 Implement the envelope module per `design.md` §5, checkpointed via a single
  `CheckpointStore.save()` call.
  - **Acceptance:** a runnable example (checkpoint the blob(s), restore on restart) exists in
    `docs/` or `test/`.
- [ ] 4.2 Document explicitly (TSDoc + `design.md` §6 cross-reference) that
  `PgTransactionHistoryStorage` is authoritative for tx-history on restore, and that the
  envelope's internal per-wallet tx-history copy is not independently trusted.
  - **Acceptance:** targeted `rg` review finds this stated once, unambiguously, not implied.

## 5. Storage-swappable conformance harness (Pg-only tier — required merge gate)

- [ ] 5.1 Build a fixture builder taking a `TransactionHistoryStorage` factory; run the existing
  `@midnightntwrk/wallet-sdk-testkit` assertions (`tx-history-asserts.ts`) once against
  `InMemoryTransactionHistoryStorage` and once against `PgTransactionHistoryStorage`.
- [ ] 5.2 Sequential-equivalence oracle: scripted `gotPending`/`gotFinalized`/`gotRejected`
  sequence against both backends; assert identical `getAll()` output.
- [ ] 5.3 Lifecycle correctness: duplicate delivery, out-of-order delivery, `gotRejected`/
  `gotFinalized` for an entry never `gotPending`, and the identifier-subset pending-clear rule
  across several merges.
- [ ] 5.4 Concurrency invariant: two wallet types' `gotFinalized` calls racing on the same tx
  hash must not lose either section — asserted directly against Postgres state, not the
  in-memory reference (which cannot exhibit this race).
- [ ] 5.5 Wire `test:conformance` as a required merge-gate script (matching every other
  UmbraDB module's pre-merge bar), Pg-only, no live wallet or devnet.
  - **Acceptance:** `npm run test:conformance` exits 0 in CI with only a Postgres service
    container, no Docker-in-Docker devnet.

## 6. Live-sync tier (nightly/labeled — blocked on design.md §7's open question)

- [ ] 6.1 Resolve the concrete preprod-connection mechanism (design.md §7) — endpoint,
  credentials, or reused existing infrastructure.
- [ ] 6.2 Genesis sync scenario: real wallet, fixed seed, `PgTransactionHistoryStorage` injected;
  sync to strictly-complete; assert non-zero genesis balances (or, for a preprod-connected node,
  the equivalent real-balance assertion) and tx-history shape.
- [ ] 6.3 Kill/restart/resume scenario: checkpoint via the envelope, destroy the wallet instance,
  restore via the envelope with the same Pg storage; assert resume without full resync and
  tx-history continuity.
- [ ] 6.4 Wire `test:live` as a nightly/labeled script, not a required merge gate.

## 7. Close-out

- [ ] 7.1 Integrate current `main` into the branch before final artifacts.
- [ ] 7.2 Update README, ROADMAP, OpenSpec, and `design/design.md`/`design/tasks.md` supersede
  notes (proposal.md's "Impact" section) without overclaiming live-sync-tier completion if
  Phase 6 is still open.
- [ ] 7.3 Regenerate Graphify after all source/spec/status edits.
- [ ] 7.4 Run the complete Pg-only release matrix (Phase 5) plus TypeScript/TypeDoc checks.
- [ ] 7.5 Commit the final tranche, obtain final PASS verdicts from three independent read-only
  personas on that exact commit, per `AGENTS.md`.
- [ ] 7.6 Push the exact audited head, require its green GitHub trust run, and record validation
  and audit evidence in the draft PR before requesting review.
