# Sync completion is measured against the indexer's self-reported tip, with no independent finality check

**Component:** wallet sync (`SyncProgress`), all three wallet types
**Version:** `midnight-wallet` @ `e744d994`, indexer API v4
**Type:** hardening / defense in depth; not a vulnerability report, which is why this is a public issue rather than a private disclosure

I ran into this while building on the SDK. A wallet decides it has caught up to the tip by comparing its applied cursor against a value the indexer reports about itself, and nothing else. If that value is behind the real chain, the wallet still reports itself fully synced, silently.

On scope: the spec already places the indexer inside the trusted set. `docs/spec/Specification.md:740-745` (this repo) says node-fed sync is the best option for security and privacy, and that using an indexer comes "at the cost of having to trust said service." The trust discussed there is about privacy, though. The completeness and liveness of the tip a wallet uses to decide it is "fully synced" is a different axis, one that can be trust-minimized on its own, and today nothing reconciles it against anything but the indexer itself.

### Details

The completion predicate:

- Shielded and dust: `packages/abstractions/src/SyncProgress.ts:31-33`, `isConnected && |highestRelevantWalletIndex - appliedIndex| <= maxGap` (strict `== 0` for "strictly complete", lines 65-66).
- Unshielded: `packages/unshielded-wallet/src/v1/SyncProgress.ts:29-31`, the same shape over `highestTransactionId - appliedId`.

The tip term in each predicate (`highestRelevantWalletIndex` / `highestTransactionId`) comes from the indexer subscription: `packages/shielded-wallet/src/v1/Sync.ts:293`, `packages/dust-wallet/src/v1/Sync.ts:330`, `packages/unshielded-wallet/src/v1/Sync.ts:112`. Its ultimate origin is a `MAX(id)` over the indexer's own database. That part lives in the midnight-indexer repo, not this one: `indexer-api/src/infra/storage/ledger_events.rs:92`, with the unshielded equivalent at `indexer-api/src/infra/storage/transaction.rs:522-544`. No finalized head or finality proof travels with it.

`FacadeState.isSynced` ANDs the three predicates (`packages/facade/src/index.ts:287-292`), and `waitForSyncedState` delegates to them. GRANDPA finality does get enforced, but during ingestion, by the indexer; the wallet relies on that having happened and performs no finality check of its own. The SDK does reach a finalized node, just only to submit: `packages/node-client/src/effect/NodeClient.ts` and `packages/node-client/src/effect/PolkadotNodeClient.ts:223-233` wait for `isFinalized` on a submitted transaction, and no sync module imports `node-client`. The one `getFinalizedHead` call in the tree is in a submission integration test (`packages/capabilities/src/submission/test/submissionService.integration.test.ts:30`); nothing on the sync path queries the finalized head.

### Impact

This is a view-integrity and liveness concern, not a fund-safety one. Keys still control the coins, the chain stays authoritative, and no forged spend is accepted. But an indexer that under-reports its maximum makes the wallet report `isSynced === true` while it is actually behind. That can happen honestly (a stalled or lagging replica) or adversarially (a misconfigured or compromised indexer, or a man-in-the-middle on the single `indexerHttpUrl` a wallet points at). The failure is silent. The wallet raises no error, just shows a stale balance, which can mean recently received funds don't appear at all. In the adversarial case the indexer can pin the reported tip and withhold newer events indefinitely, and a merchant or payment flow gating on `isSynced` would under-credit against the stale view.

The honest case is worth separating out: a lagging but honest indexer's stream eventually advances and the wallet catches up on its own, so "re-sync" is not the remedy, and re-syncing against the same dishonest source doesn't help either. The gap is that the wallet has no independent signal to tell "the indexer's tip is the real finalized tip" apart from "the indexer is behind or withholding."

### Prior art

This is the standard light-client trust boundary. Zcash's wallet app threat model treats lightwalletd as exactly this kind of window into the chain: a compromised server "can make the user think their balance is lower than it actually is" by omitting transactions destined to the user, and even a trusted one serves data that "is not guaranteed to be recent" (https://zcash.readthedocs.io/en/latest/rtd_pages/wallet_threat_model.html). On the Substrate side, light clients close the same gap by verifying "GRANDPA finality justifications" instead of trusting the serving node (https://docs.polkadot.com/reference/tools/light-clients/); smoldot's stated design is that it "does in no way trust the full nodes to be honest" (https://github.com/paritytech/smoldot). Midnight is GRANDPA-finalized and the SDK already has a finalized node client, so the same move is available here.

### Suggested hardening

Anchor "synced" to an independently obtained, finality-verified tip rather than the indexer's self-reported maximum:

1. Have the indexer's progress carry the finalized block hash/height it has fully processed (a progress anchor), alongside the existing event/transaction max.
2. Obtain the finalized head independently from a node, either `chain_getFinalizedHead` + `chain_getHeader` or a GRANDPA finality proof for stronger trust-minimization, reusing the finalized node client the SDK already has.
3. Extend the completion criterion so "strictly complete" also requires the applied position to have reached that network-verified finalized height (minus a small margin), and surface a distinct "possibly stale / indexer behind finalized head" state to callers instead of a silent `isSynced`.

A lighter interim step: cross-check the reported tip across two or more independent indexer endpoints and flag disagreement.

Happy to work up a PR if this is a direction the team is open to.
