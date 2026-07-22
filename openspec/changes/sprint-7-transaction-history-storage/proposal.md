# Proposal — Sprint 7: Transaction History Storage (Wallet Integration Surface)

> **Status:** Draft, translated from `design/sprint-5-recommendation.md` (second post-audit
> revision — two rounds of independent review: 2 Opus reviewers + Codex GPT-5.6 Sol, then a
> final Opus verification + Codex re-audit round). This openspec change itself has **not yet**
> been through this repo's own 3-persona panel/Codex audit (`AGENTS.md`) — that is Phase 0 of
> `tasks.md`, not yet run. Do not treat this draft as implementation-ready until Phase 0 closes.

## Why this sprint is numbered 7, not 5

The recommendation this sprint formalizes calls itself "Sprint 5" in its own working title
(`design/sprint-5-recommendation.md`), written before this repo's openspec sequence had
allocated numbers 5 and 6 to the parallel Lean formalization track
(`sprint-5-formal-watermarks`, complete/merged; `sprint-6-formal-checkpoint-c1`, complete/merged).
Both are taken. This change is filed as **Sprint 7** to avoid colliding with either — the
recommendation doc's own content is unchanged, only the openspec folder number differs from its
working title.

## Why

UmbraDB's four core storage modules (TemporalKV, Transaction/Lease, CheckpointStore, Watermarks)
are implemented and merged (`ROADMAP.md` Milestone 2). This sprint is the first to connect
UmbraDB to a real external caller: the Midnight wallet SDK (`midnight-wallet`). A live
investigation against real, cloned `midnight-wallet`, `midnight-indexer`, and `midnight-node`
checkouts (verified byte-identical to `origin/main` for every file cited, per the recommendation
doc's own provenance note) found that the wallet SDK exposes exactly one pluggable persistence
interface — `TransactionHistoryStorage` — and that UmbraDB does not yet implement it.

**Direction from owner:** UmbraDB is self-contained. Its only external contract is the interface
of the Midnight Node stack (node + indexer + proof-server) and the current wallet SDK. No
dependency on `midnight-dev-env` legacy code or call sites.

This proposal supersedes `design/design.md` §6, §9 (wallet-state rows), §10, and
`design/tasks.md` §6, §8, §9, which described interfaces (`PgWalletStateStore`,
`PgPrivateStateProvider`, a differential gate against a Mongo reference) that do not exist in
the current SDK generation.

## What changes

1. **`PgTransactionHistoryStorage`** — a Postgres-backed implementation of the wallet SDK's
   `TransactionHistoryStorage` interface (`packages/abstractions/src/TransactionHistoryStorage.ts`
   in `midnight-wallet`), keyed by transaction hash, covering the merged shielded+unshielded+dust
   entry schema the facade produces (`mergeWalletEntries`, `packages/facade/src/index.ts:103-150`).
   One storage instance is shared across all three wallet types via the facade, so this module
   must handle **atomic merge under concurrent writers** (a row-lock pattern — `SELECT ... FOR
   UPDATE` held across a caller-supplied TypeScript merge call, inside one transaction — not a
   bare atomic upsert, which can silently lose a section under a race) and reproduce
   `mergeWalletEntries`'s actual per-section merge semantics, not a "last-write-wins"
   approximation. See `design.md` §1-§3.
2. **A WalletState envelope** — a thin, new (not "zero new code") serialization module that
   wraps each of the three wallet types' independently-shaped `serializeState()`/`.restore()`
   strings (`shielded-wallet`, `unshielded-wallet`, `dust-wallet` each have their own distinct
   snapshot schema — there is no single facade-wide `WalletState` blob) plus a schema version tag
   into one JSON envelope, checkpointed as a single `CheckpointStore.save` call. This buys atomic
   persistence of the envelope as a unit (no torn writes across the three sub-wallet strings) —
   it does **not** by itself guarantee the three captured states are mutually consistent as of
   the same block height (open question, `design.md` §6).
3. **A storage-swappable, backend-parameterized conformance harness** built on
   `@midnightntwrk/wallet-sdk-testkit`, run once against `InMemoryTransactionHistoryStorage`
   (the existing in-memory reference) and once against `PgTransactionHistoryStorage`, split into
   a **Pg-only required merge gate** (sequential-equivalence oracle, lifecycle/merge-semantics
   replay, and a concurrency invariant checked directly against Postgres state — no live wallet
   or devnet needed) and a **live-sync tier** needing a genuinely synced wallet (nightly/labeled,
   not a required merge gate; see `design.md` §7 for what "live" means for this sprint).
4. **A vendor/pin manifest** recording the exact `midnight-wallet` commit this sprint was built
   against, SDK package versions, and (for the local-devnet live-sync tier) image digests for
   proof-server, midnight-node, and indexer-standalone.

## Non-goals

- `PgWalletStateStore` / `PgPrivateStateProvider` and a `wallet_state` table (`design/design.md`
  §6/§9) — dead terminology from a prior SDK generation; does not exist in the current SDK.
- A differential state-equivalence gate against the Mongo reference store (`design/design.md`
  §10) — the Mongo store this diffed against is not what any current wallet client uses.
- `midnight-dev-env` call-site rewiring (`design/tasks.md` §9) — interop is proven self-contained
  instead; UmbraDB never imports wallet-SDK runtime code (the merge function is caller-supplied
  and injected at construction — `design.md` §2).
- A custom direct-from-node sync path bypassing the Midnight indexer — considered and rejected;
  UmbraDB's own code must stay 100% agnostic to how sync data arrived and must never import or
  reference indexer internals. Test infrastructure (a devnet or a preprod-connected indexer) is
  the one place indexer specifics may appear, and only as provisioning, never as a code
  dependency.
- Cross-sub-wallet consistency guarantees for the WalletState envelope beyond atomic persistence
  of the bundle as a unit — genuinely open, tracked in `design.md` §6, not resolved by this
  sprint.
- A full genesis rebuild of a private preprod fork (`midnight-node/local-environment`'s
  snapshot-fork tooling) — out of scope unless a later revision of this proposal adopts it
  explicitly; see `design.md` §7's open item on what "preprod" means for this sprint's live tier.

## Impact

- **New in this repo**: `src/interfaces/transaction-history-storage.ts`,
  `src/postgres/transaction-history-storage.ts`, a new migration
  `src/postgres/migrations/00X_transaction_history.sql`, a WalletState envelope module (path TBD
  in `design.md` §5), and a conformance-test harness under `test/` parameterized over both
  backends.
- **Modified**: `README.md`, `ROADMAP.md`, `design/design.md`, `design/tasks.md` (supersede notes
  only, per `design/sprint-5-recommendation.md` §4 item 7).
- **External dependency (new for this project)**: this is the first sprint where UmbraDB's own
  test suite depends on cloned external repositories (`midnight-wallet` for the testkit and
  interface types; `midnight-node` + `midnight-indexer` for the live-sync tier's devnet). These
  are test/dev dependencies only — production `PgTransactionHistoryStorage` code never imports
  wallet-SDK runtime code (design.md §2).
- **Risk**: the concurrent-write atomic-merge requirement is the one genuinely novel correctness
  property in this sprint (no existing UmbraDB module has a shared-instance, multi-writer race on
  the same logical row) — see `design.md` §3 and the concurrency scenario in
  `specs/transaction-history-storage/spec.md`.
- **Delivery**: this proposal/design/tasks/spec are a first draft translating an
  already-twice-audited recommendation into openspec form. Per `AGENTS.md`, this still needs its
  own domain-correctness, adversarial, and release-persona review before implementation begins —
  `tasks.md` Phase 0 tracks that explicitly and is unchecked.
