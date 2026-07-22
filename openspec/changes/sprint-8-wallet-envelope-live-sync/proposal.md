# Proposal — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery

> **Status:** Implemented and audited (F9 status update). The envelope module, the adapter seam,
> the Pg-only conformance suite, and the live preprod DB-sync + cold-boot recovery tests described
> below are all implemented, and the live tiers were confirmed to pass against real public preprod
> on 2026-07-22 (funding tx `b194e71d4d22ed09846cd88aab67c6bb4eec69ea6df5aead3bdb22bfe3493341`,
> restored `progress.appliedId = 505701n` — `tasks.md` §1.1). This implementation was then put
> through a 4-auditor cross-vendor panel (domain-correctness, adversarial, and release/process
> personas per `AGENTS.md`), which returned 3 `BLOCK` verdicts plus several must-fix findings
> (F1-F9, catalogued and fixed in the commit that added this status line — see `tasks.md`'s
> per-task notes for exactly what changed and why). A fresh re-audit of that fix commit is the
> pending next step (`tasks.md` §0.4/§6.5) — this proposal is no longer an unreviewed draft, but it
> is also not yet re-audit-`PASS`ed on its current, fixed head. Findings the fix commit explicitly
> deferred to Sprint 9, rather than silently folding in here, are recorded in `tasks.md`'s "Deferred
> to Sprint 9" section.

## Why this sprint exists, and why it unblocks Sprint 7

Sprint 7 (`openspec/changes/sprint-7-transaction-history-storage/`) landed the one new storage
module the wallet SDK's pluggable persistence surface actually requires: `PgTransactionHistoryStorage`,
a Postgres-backed implementation of the SDK's `TransactionHistoryStorage` interface
(`src/postgres/transaction-history-storage.ts` + `src/interfaces/transaction-history-storage.ts`,
implemented against `midnight-wallet packages/abstractions/src/TransactionHistoryStorage.ts:163-216`).
Sprint 7's own plan also *contemplated* two further deliverables — a WalletState envelope
(`sprint-7-transaction-history-storage/design.md` §5, tasks Phase 4) and a live-sync verification
tier (§7, tasks Phase 6) — but left both as design questions gated on an unresolved
"what does preprod mean" open item (§7). Those two are the difference between "a storage class
that typechecks and passes Pg-only unit tests" and "a wallet that provably persists to Postgres,
observes a real on-chain balance, and resumes from a cold boot without a full resync."

The unresolved preprod question is now resolved. A de-risking run **proved the live sync path
end-to-end**: the real `UnshieldedWallet` synced our funded preprod wallet against the public
preprod indexer in ~1.3s and observed the full 1000 tNIGHT, materializing tx-history entry
`b194e71d…493341` (identifier `00ea17cf…20bea`, the faucet tx) finalized at block 1,763,274
(`AUTONOMOUS_RUN_LOG.md:226-243`; reusable wiring at
`~/repos/midnight-wallet/packages/wallet-integration-tests/test/preprodUnshieldedSync.manual.integration.test.ts`).
The endpoints, wallet, and faucet facts are recorded in `design/environment/preprod-connection.md`
and `design/environment/verification-checklist.md`.

This sprint therefore carves the envelope, the live-sync verification, and a cold-boot recovery
test into their own concrete, buildable scope, and adds the one piece Sprint 7 deliberately did
not specify: **the adapter that is the seam** between the real SDK's `TransactionHistoryStorage`
config slot and UmbraDB's `PgTransactionHistoryStorage`. With Sprint 8's end-to-end proof in
hand — a real preprod tx landing as a UmbraDB DB row, and a cold-boot resume off that row —
Sprint 7's storage module is demonstrated to work in the real wiring it was written for, and can
merge. Sprint 7 stays scoped to the storage module; Sprint 8 is what proves the module in situ.

**Direction from owner (unchanged, carried from Sprint 7):** UmbraDB is self-contained. Its only
external contract is the interface of the Midnight Node stack (node + indexer + proof-server) and
the current wallet SDK. UmbraDB's own module code must never import or reference the Midnight
indexer or any wallet-SDK runtime code; the adapter is the one place SDK types appear, and it is
test/integration-tier code, not core-module code.

## Scope of Sprint 8 (functional DB-backed persistence + recovery)

This sprint delivers **functional** DB-backed persistence and recovery. It explicitly does **not**
deliver the trust-minimized *verifiable* snapshot recovery (anchor / finality / completeness /
seed-binding) — that is a separate feature (`verifiable-snapshot-recovery`, researched in parallel,
`AUTONOMOUS_RUN_LOG.md:196-224`) that sits *on top of* this sprint's functional layer as the
future hardening layer. Sprint 8's design references it as the future correctness envelope, and is
deliberately structured so that hardening layer can bolt on without re-opening this sprint's
persistence contract.

## What changes

1. **WalletState envelope** (recommendation `design/sprint-5-recommendation.md` §1 module 2;
   Sprint 7 `design.md` §5) — a thin serialization module (`src/interfaces/wallet-state-envelope.ts`
   + `src/postgres/wallet-state-envelope.ts`) that wraps the three sub-wallets' **independent**
   `serializeState()` strings — shielded, unshielded, dust, each with its own distinct snapshot
   schema (`shielded-wallet/src/v1/Serialization.ts:66-119`,
   `unshielded-wallet/src/v1/Serialization.ts:43-90`, `dust-wallet/src/v1/Serialization.ts:62-114`;
   the testkit's own `saveState` at `wallet-sdk-testkit/src/wallet.ts:215-249` serializes all three
   separately into three files, confirming there is no single facade-wide blob) — plus a
   **schema-version tag** into **one versioned JSON envelope**, persisted as a **single
   `CheckpointStore.save()` call** per `(walletId, networkId)` (`src/interfaces/checkpoint-store.ts:142`).
   **Decision: option (a), one versioned envelope** (recommendation §1's recommended option, over
   (b) three coordinated checkpoints) — see `design.md` §1. The envelope buys atomic persistence
   of the bundle as a unit; it does **not** buy cross-sub-wallet same-height consistency, and this
   sprint accepts the weaker contract explicitly (below and `design.md` §5).

2. **The adapter (the seam)** — a mapping between the real SDK `TransactionHistoryStorage`
   (Effect-Schema entries: `hash`, `identifiers`, optional `protocolVersion`/`status`/`timestamp:Date`/
   `fees:bigint|null`, and a **lifecycle discriminated union** carrying per-status detail —
   `submittedAt` / `finalizedBlock{hash,height,timestamp}` / `rejectedAt`+`reason`,
   `TransactionHistoryStorage.ts:23-85,135-157`) and UmbraDB's `PgTransactionHistoryStorage` (whose
   own entry models `lifecycle` as a bare `{status}` union, `src/interfaces/transaction-history-storage.ts:166-178`).
   The adapter backs the SDK's `configuration.txHistoryStorage` slot with Postgres. **No wallet-SDK
   runtime import in any core module** (`src/postgres/*`, `src/interfaces/*`); the adapter is the
   only place the SDK types are referenced, and it lives under `test/`/integration tier, injecting
   `PgTransactionHistoryStorage` and its caller-supplied merge function exactly as Sprint 7
   requires (`sprint-7-transaction-history-storage/design.md` §2). See `design.md` §3.

3. **Live preprod DB-sync verification** (integration test, nightly/labeled — **not** a required
   merge gate) — drive the funded preprod wallet (seed at `~/.midnight-preprod-wallet.seed`)
   through the SDK with the Pg-backed storage injected via the adapter, sync against **public
   preprod** using the proven `UnshieldedWallet` + indexer-WS wiring
   (`preprodUnshieldedSync.manual.integration.test.ts`), and assert the on-chain 1000 tNIGHT tx
   (`b194e71d…493341`) materializes as a **UmbraDB DB row** readable via `getAll()`. This is the
   "verify the DB actually syncs" proof. See `design.md` §4 and the testing strategy (§7).

4. **Functional cold-boot recovery test** (integration test, nightly/labeled) — sync → serialize
   each sub-wallet state → envelope → `CheckpointStore.save` into Postgres → destroy the wallet +
   process → fresh process → `CheckpointStore.load` the envelope → restore each sub-wallet →
   `PgTransactionHistoryStorage.getAll()` for tx-history → assert resume **without a full resync**
   and **tx-history continuity** (the Pg store is authoritative for tx-history on restore, not the
   blob's embedded copy). This is *functional* recovery; the trust-minimized verification is the
   separate feature above. See `design.md` §5-§6.

5. **Pg-only conformance** for the envelope module and the adapter seam
   (save/load/schema-version round-trip; scripted SDK-shaped `got*` traces through the adapter into
   Postgres and back) as the **required merge gate** — needs only a plain Postgres container, no
   wallet SDK sync, no devnet. The live-sync (item 3) and cold-boot (item 4) tiers are
   nightly/labeled. See `design.md` §7.

## Non-goals (explicitly out of scope)

- **Trust-minimized / verifiable snapshot recovery** (anchor, finality, completeness,
  seed-binding, no-replay integrity against an untrusted DB). This is the separate
  `verifiable-snapshot-recovery` feature that sits on top of this functional layer; Sprint 8
  references it as future hardening but does not implement any of it.
- **Cross-sub-wallet same-height consistency.** The three sub-wallet snapshots sync independently
  (`Sync.ts` subscriptions are per-sub-wallet), so the envelope captures three states that may be
  at different block heights. This sprint **accepts the weaker contract explicitly**: "each
  sub-wallet resumes from its own last-known point; the three are bundled into one save/load call
  for operational atomicity only." This is recommendation §3 open question 5, and Sprint 7
  `design.md` §6.2's default (a); it is stated as binding spec text here, not left implicit.
- **Any change to `PgTransactionHistoryStorage`'s own contract** (Sprint 7). The adapter maps onto
  the Sprint 7 storage module as-is; if the adapter surfaces a genuine gap in that module's
  contract (e.g. lifecycle-detail fidelity, `design.md` §3.2 / open question 2), it is recorded as
  a finding, not silently patched into Sprint 7's already-audited surface.
- **Multi-wallet-per-process multiplexing.** One `PgTransactionHistoryStorage` instance and one
  envelope per `(walletId, networkId)` (Sprint 7 `design.md` §4). Unchanged here.
- **A fully local devnet live tier.** The recommendation's original plan scoped live-sync to a
  local `docker-compose-dynamic.yml` devnet; the superseding owner direction (Sprint 7 `design.md`
  §7) points the live tier at **public preprod** instead, now proven. The local devnet is noted as
  an escalation option only, not built.
- **Lean formalization** of the envelope — parallel, independent workstream, as in every prior
  sprint's proposal.

## Impact

- **New in this repo**: `src/interfaces/wallet-state-envelope.ts` (envelope type + version tag +
  codec contract), `src/postgres/wallet-state-envelope.ts` (`PgWalletStateEnvelopeStore`, wrapping
  `CheckpointStore`), a `test/`-tier adapter mapping the SDK `TransactionHistoryStorage` onto
  `PgTransactionHistoryStorage`, a Pg-only conformance suite for both (required gate), and two
  nightly/labeled integration tests (`test:live` preprod DB-sync + cold-boot recovery).
- **Modified**: `package.json` gains `test:conformance` (required, Pg-only) and `test:live`
  (nightly) scripts; `README.md`, `ROADMAP.md`, and the Sprint 7 change's status notes record that
  Sprint 8 is what proves the storage module in situ.
- **External dependency (test/dev only, as in Sprint 7)**: the live-sync and cold-boot tiers depend
  on a built `midnight-wallet` checkout (the SDK packages, testkit, and the ledger-v8 native
  bindings) plus a funded preprod wallet seed and public preprod endpoints. Production envelope and
  storage code import **none** of this — the adapter is test-tier and is the only SDK-typed code.
- **Risk**: the one genuinely novel correctness surface this sprint adds is the **adapter's
  lifecycle-detail round-trip** — the real SDK lifecycle carries `submittedAt`/`finalizedBlock`/
  `rejectedAt`+`reason` that UmbraDB's Sprint-7 entry models only as a bare `{status}`; whether
  `getAll()` must reconstruct a schema-valid SDK lifecycle object (not just a status) is a correctness-
  gate open question (`design.md` §3.2). The cross-sub-wallet consistency contract is the other
  (accepted-but-weaker, `design.md` §5).
- **Delivery**: this proposal/design/tasks/spec are a first draft. Per `AGENTS.md`, it still needs
  its own domain-correctness, adversarial, and release-persona review before any implementation
  code — `tasks.md` Phase 0 tracks that and is unchecked.
