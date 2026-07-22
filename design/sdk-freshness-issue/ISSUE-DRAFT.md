# Sync completion is measured against the indexer's self-reported tip, with no independent finality check

**Type:** hardening / defense-in-depth (not a vulnerability — see "Framing" below)
**Component:** wallet sync (`SyncProgress`), all three wallet types
**Version:** `midnight-wallet` @ `e744d994`, indexer API v4

### Framing

This is a hardening suggestion, not a security-vulnerability report, so it's filed here rather than through private disclosure. The wallet specification already places the indexer inside the trusted set — `docs/spec/Specification.md:740-743` notes node-fed sync is preferable for security and privacy, and that using an indexer comes "at the cost of having to trust said service." That trust is stated in terms of *privacy*, though. This note is about a different axis — the *completeness/liveness of the tip* a wallet uses to decide it is "fully synced" — which is independently trust-minimizable, and currently isn't reconciled against anything but the indexer itself.

### Observation

A wallet decides it has caught up to the tip by comparing its applied cursor against a value the indexer reports, with no node- or consensus-sourced cross-check.

The completion predicate is:

- Shielded and dust: `packages/abstractions/src/SyncProgress.ts:31-33` — `isConnected && |highestRelevantWalletIndex − appliedIndex| ≤ maxGap` (strict `== 0` for "strictly complete", lines 65-66).
- Unshielded: `packages/unshielded-wallet/src/v1/SyncProgress.ts:29-31` — the same shape over `highestTransactionId − appliedId`.

The only "tip" term — `highestRelevantWalletIndex` / `highestTransactionId` — is supplied by the indexer subscription (`shielded-wallet/src/v1/Sync.ts:293`, `dust-wallet/src/v1/Sync.ts:330`, `unshielded-wallet/src/v1/Sync.ts:112`). Its ultimate origin is a `MAX(id)` over the indexer's own database (`indexer-api/src/infra/storage/ledger_events.rs:92`; the unshielded equivalent at `transaction.rs:522-544`). No finalized-head or finality proof accompanies it.

`FacadeState.isSynced` simply ANDs the three predicates (`facade/src/index.ts:287-292`), and `waitForSyncedState` delegates to them. GRANDPA finality *is* enforced — but by the indexer during ingestion, which the wallet then trusts wholesale. There is no finality-aware component in the default sync path: `node-client` reaches a finalized node but exposes submission only (`NodeClient.ts` / `PolkadotNodeClient.ts:223-233`) and is imported by no sync module. A grep of the wallet source finds no `chain_getHeader` / `getFinalizedHead` on the sync path.

### Impact

This is a view-integrity / liveness concern, not a fund-safety one. Keys still control the coins, the chain remains authoritative, and no forged spend is accepted. But an indexer that under-reports its maximum — a stalled or lagging replica (non-malicious), a compromised or misconfigured indexer, or a man-in-the-middle on a single `indexerHttpUrl` — can make the wallet report `isSynced === true` while it is actually behind. The effect is silent: the wallet surfaces no error, shows a stale balance, and can hide recently-received funds. In the adversarial case an indexer can pin the reported tip and withhold newer events indefinitely; downstream, a merchant or payment flow could under-credit against a stale view.

To be precise about the failure mode: an *honest* lagging indexer's live stream will eventually advance and the wallet will catch up on its own — so "re-sync" is not the remedy, and re-syncing against the same dishonest source does not help. The gap is specifically that the wallet has no independent signal by which to tell "the indexer's tip is the real finalized tip" from "the indexer is behind or withholding."

### Prior art

This is the standard light-client trust boundary, and the usual fix is well-trodden:

- Zcash's wallet-app threat model treats the lightwalletd server as untrusted for *recency* precisely here: a server "not guaranteed to be recent" or a compromised one can make a user "think their balance is lower than it actually is" by omitting incoming transactions.
- Substrate/smoldot light clients verify GRANDPA finality justifications to obtain a trust-minimized finalized head — directly applicable, since Midnight is GRANDPA-finalized and the SDK already reaches a finalized node client (just only for submission).

### Suggested hardening

Anchor "synced" to an independently-obtained, finality-verified tip rather than the indexer's self-reported maximum:

1. Have the indexer's progress carry the finalized block hash/height it has fully processed (a progress anchor), alongside the existing event/transaction max.
2. Independently obtain the finalized head from a node — `chain_getFinalizedHead` + `chain_getHeader`, or a GRANDPA finality proof for stronger trust-minimization — reusing the finalized node client the SDK already has.
3. Extend the completion criterion so "strictly complete" additionally requires the applied position to have reached that network-verified finalized height (minus a small margin), and surface a distinct "possibly-stale / indexer behind finalized head" state to callers rather than silently reporting `isSynced`.

A lighter interim step is to cross-check the reported tip across two or more independent endpoints and flag disagreement.

Happy to help with a PR if this is a direction the team is open to.
