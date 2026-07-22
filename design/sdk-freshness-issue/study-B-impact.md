# Study B — Attack, Impact, and Prior Art for the Midnight Wallet SDK "sync-complete" freshness gap

Scope: this study assesses the *security/trust significance and user impact* of the wallet SDK
judging "sync complete / caught up to tip" against an **indexer-self-reported** high-water mark
rather than a network-sourced, finality-verified chain tip. It is written to support a **public,
non-sensitive GitHub issue** framed as a trust/hardening observation. A sibling study (Study A)
establishes the exact code path; this study assumes that finding and independently re-confirms the
load-bearing lines below.

Bottom line up front: **this is a defense-in-depth / hardening request, not a spec-violating
vulnerability.** The wallet's own design spec documents the indexer as a *trusted* component. The
realistic harm is **view-integrity and liveness** (a wallet can believe it is fully synced while
behind or while an incoming payment is withheld), **not loss of funds**. Fair severity: **Medium.**
The standard fix is well-established prior art: reconcile "caught up" against a finality-anchored
tip (verify GRANDPA finality) or cross-check multiple sources, and expose staleness to callers.

---

## 1. The mechanism (re-confirmed)

### 1.1 Completion is `appliedCursor == indexerReportedMax`, gated only by `isConnected`

Unshielded completion predicate
(`~/repos/midnight-wallet/packages/unshielded-wallet/src/v1/SyncProgress.ts:29-33`):

```ts
isCompleteWithin(data: SyncProgressData, maxGap: bigint = 50n): boolean {
  const applyLag = BigInt(Math.abs(Number(data.highestTransactionId - data.appliedId)));
  return data.isConnected && applyLag <= maxGap;
}
```

`isStrictlyComplete()` is `isCompleteWithin(0n)` (`SyncProgress.ts:53-55`). The shielded/dust wallets
use the identical shape in `packages/abstractions/src/SyncProgress.ts:31-34`
(`applyLag = |highestRelevantWalletIndex - appliedIndex|; return isConnected && applyLag <= maxGap`).

The public "is the wallet synced?" surface ANDs these three per-sub-wallet predicates
(`packages/facade/src/index.ts:287-292`):

```ts
public get isSynced(): boolean {
  return (
    this.shielded.state.progress.isStrictlyComplete() &&
    this.dust.state.progress.isStrictlyComplete() &&
    this.unshielded.progress.isStrictlyComplete()
  );
}
```

The runtime's `syncComplete` getter is the same idea expressed as gaps
(`packages/runtime/src/WalletBuilder.ts:143-145`): `sourceGap === 0n && applyGap === 0n`.

### 1.2 Every term on the right-hand side is supplied by the indexer

`highestTransactionId` / `maxId` enter the wallet **only** from the indexer's own subscription
payload — there is no second, independent source:

- Unshielded: `packages/unshielded-wallet/src/v1/Sync.ts:106-116` —
  `highestTransactionId: BigInt(update.highestTransactionId)` taken straight from the
  `UnshieldedTransactionsProgress` message; `isConnected: true` is set on receipt.
- Dust: `packages/dust-wallet/src/v1/Sync.ts:330` — `highestRelevantWalletIndex = BigInt(updates.at(-1)!.maxId)`.
- Shielded: `packages/shielded-wallet/src/v1/Sync.ts:293` — `highestRelevantWalletIndex = BigInt(lastUpdate.maxId)`.

### 1.3 What the indexer's number actually means

The GraphQL contract documents `highestTransactionId` as an **indexer-local** maximum, not a chain
tip (`~/repos/midnight-indexer/indexer-api/graphql/schema-v4.graphql:2424-2429`):

> "The highest transaction ID of all currently known transactions for a subscribed address."

The implementation is a `MAX()` over the indexer's own database rows for that owner
(`indexer-api/src/infra/storage/transaction.rs:522-550`): `SELECT MAX(tx_id) FROM (MAX(creating_transaction_id) … UNION ALL MAX(spending_transaction_id) …) WHERE owner = $1`.
The progress stream simply re-polls that value on a jittered interval
(`indexer-api/src/infra/api/v4/subscription/unshielded.rs:284-310`).

Consequently the reported "tip" is **the high-water mark of what this indexer instance has ingested
and matched for this address** — it moves only as fast as (and no further than) that indexer's own
ingestion. It carries **no attestation** that it equals the network's finalized head. A wallet that
has applied everything up to this number concludes "strictly complete" whether or not the number
reflects the real tip.

### 1.4 The indexer *does* gate on finality — but the wallet cannot verify that it did

The chain-indexer subscribes to the node's **finalized-block** stream and recomputes/guards Merkle
roots before writing (`~/repos/midnight-indexer/docs/architecture.md:16`). So an *honest* indexer
serves finality-gated data. The gap is that this property lives entirely on the trusted side of the
boundary: the wallet receives a bare integer and takes it on faith. Nothing in the wallet verifies a
finality proof, a signed header, or even the indexer's own reported block height against a second
source.

---

## 2. Threat-model fit: is the indexer TRUSTED by design?

**Yes — the indexer is a trusted component in the wallet's documented design.** This is the decisive
question for framing, and the evidence is in Midnight's own repos, so the issue should be filed as a
**hardening / defense-in-depth request**, not as a claim that a stated non-trust assumption was
violated.

Wallet design spec, `~/repos/midnight-wallet/docs/spec/Specification.md`:

- The trust-minimized baseline is node sync, explicitly: *"Literal implementation of a Midnight
  Wallet, applying transactions one by one, provided by a local node is the best option from
  security and privacy standpoint"* (`:740-743`).
- Using an indexer is presented as a deliberate trust trade-off: *"An alternative idea is to use an
  indexing service, **at the cost of having to trust said service**."* (`:745`).
- *"It still needs to be **trusted by the user** though, because it has access to otherwise private
  information."* (`:759`).
- The spec even anticipates the indexer conveying finalization: the unshielded indexer supplies UTXOs
  *"augmented by information about transactions they were created and spent at (**including
  finalization information**)"* (`:766-768`), and finality is a GRANDPA concept in Midnight
  (`:672`: *"Midnight uses Grandpa finalization gadget, which provide definitive information about
  finalization"*).

Two honest nuances that keep the framing fair:

1. **The documented trust is stated in terms of *privacy* ("access to otherwise private
   information"), not explicitly in terms of *completeness/liveness of the tip*.** The spec never
   says "the wallet also trusts the indexer to truthfully report that you are caught up to the
   network." So "the completion signal is only as honest as the indexer" is a *consequence* of the
   trust model that the design does not call out — which is exactly what makes a **defense-in-depth
   note legitimate**: completeness/freshness is a distinct trust axis from privacy, and it is the one
   most amenable to being trust-minimized (see §5) even while accepting the privacy trust.

2. **The public docs do not publish a formal wallet/indexer threat model.** The indexer is described
   as data-plane infrastructure between node and apps
   (docs.midnight.network — Midnight Indexer overview) with no stated trust boundary. So the trust
   assumption is *implicit and documented only in the wallet spec*. Making it explicit — and adding a
   cheap cross-check — is a reasonable maintainer-respecting ask.

**Framing verdict:** file as a **hardening / robustness issue** ("the wallet cannot distinguish
'caught up to the network' from 'caught up to what this indexer chose to report,' and has no
independent tip check"), explicitly acknowledging the indexer is trusted by design. Do **not** frame
it as a fund-loss vulnerability.

---

## 3. Concrete scenarios and impact, ranked by realism

For each: **funds are never at risk** — on-chain state is authoritative and unchanged, and the
wallet's keys still control every coin. What is at risk is the **integrity and freshness of the
wallet's *view*** and the correctness of decisions taken on that view. The failure is *silent*:
in all three cases the wallet reports `isSynced === true` with **no error and no staleness signal**.

### (a) Honest but lagging / stalled indexer replica — HIGH realism, non-malicious

- **Lagging (transient):** a replica behind the chain head reports an older `highestTransactionId`.
  The wallet catches up to it, shows `isSynced`, and displays a balance missing recent activity.
  *This class largely self-heals for the honest case*: once the replica ingests the newer block it
  (i) pushes the new transaction event and (ii) raises `highestTransactionId`, so `applyGap`
  re-opens then closes. The wallet is *transiently* and *invisibly* wrong, then converges.
- **Stalled (persistent):** if the chain-indexer is crashed/stuck, or the client is pinned to a
  frozen/rolled-back read replica, the high-water mark **never advances**. Because the progress
  subscription keeps polling and re-emitting the same value with `isConnected: true`
  (`subscription/unshielded.rs:284-310`), the wallet sits at `applyGap === 0`, `isConnected === true`
  → **`isSynced === true` indefinitely, with a stale view and no signal to keep waiting.** This is
  the practically important non-malicious case, and it is indistinguishable to the wallet from a
  genuinely caught-up state.
- **User impact:** stale balance; *incoming funds appear absent*; a merchant/PoS integration that
  treats `isSynced && balance` as ground truth may under-credit a payer or believe a real payment
  never arrived. No theft — the coins exist and are spendable once synced against a live indexer.

### (b) Malicious / compromised indexer under-reporting the max — MEDIUM realism, HIGH severity-if-realized

- A hostile (or MITM-controlled, §c) indexer **pins `highestTransactionId` at an old value and
  withholds the corresponding transaction/UTXO events**. The wallet believes it is fully synced and
  **never** surfaces the withheld incoming funds — potentially indefinitely and undetectably from
  within the SDK.
- This is exactly the Zcash "compromising server" outcome: *"make the user think their balance is
  lower than it actually is"* by omitting incoming transactions (see §4).
- **User impact:** targeted, persistent censorship of the user's *view* of specific inbound payments;
  the victim may take adverse real-world action (re-request payment, ship nothing, assume a
  counterparty defaulted). Still **not fund-loss** — withholding a view cannot move coins, forge a
  spend the wallet would accept, or make the victim's keys sign anything.

### (c) MITM on the indexer connection — LOW–MEDIUM realism (TLS-dependent)

- If transport auth is absent/broken, a network attacker can act as the malicious indexer of (b):
  drop/rewrite progress frames to hold the reported tip down and strip incoming events. Same
  view-integrity/liveness impact; same "no fund-loss" ceiling. Standard TLS/endpoint-pinning closes
  this specific vector but does **not** close (a) or (b), which are properties of a *legitimately
  connected* indexer.

### Scope precision (fair boundaries)

- **This is a VIEW-integrity + availability issue, not fund-theft.** The chain is the source of
  truth; the gap only affects what the wallet *shows* and *when it thinks it is done*.
- **The gap is about *under-reporting / liveness*** (hiding things that exist). *Over-reporting /
  fabrication* (an indexer inventing UTXOs) is a **separate, adjacent** concern: the SDK's unshielded
  apply path books indexer-provided UTXOs without a Merkle-root consistency check (the spec reserves
  root checks for shielded/dust — `Specification.md` apply-offer steps). That authenticity concern is
  **out of scope** for this freshness issue and should not be conflated with it, but it is worth a
  one-line "related" note because both stem from the same single-source-of-truth trust in the
  indexer.

---

## 4. Existing partial mitigations (and their limits)

- **Reconnection with backoff:** `RunningV1Variant.startSync` retries on error with exponential
  backoff + jitter (`packages/unshielded-wallet/src/v1/RunningV1Variant.ts:139-150`). *Limit:* this
  handles a *dropped* connection, not a *live-but-lying/stalled* one. A healthy connection serving a
  pinned max never triggers a retry.
- **`isConnected` gate:** completion requires `isConnected` (`SyncProgress.ts:31`). *Limit:*
  `isConnected` is set `true` merely on *receiving* any update (`Sync.ts:112`); it proves "we heard
  something," not "what we heard is the true tip." A live stalled/malicious indexer keeps it `true`.
- **`maxGap` tolerance (default 50):** `isCompleteWithin` tolerates a small lag, but `isSynced`/
  `isStrictlyComplete` use `0n`. *Limit:* orthogonal to the trust gap — a tolerance around the wrong
  reference point does not make the reference point trustworthy.
- **Indexer-side finality gating:** honest indexers ingest only finalized blocks
  (`architecture.md:16`). *Limit:* unverifiable by the wallet; it is a property of the *trusted* side.
- **Node client already exists in the SDK — but is not used for sync.** `PolkadotNodeClient` connects
  directly to the node and already observes GRANDPA-**finalized** status
  (`packages/node-client/src/effect/PolkadotNodeClient.ts:223-233`, emitting
  `SubmissionEvent.Finalized{ blockHeight }`). It is wired **only** into the submission path
  (`packages/capabilities/src/submission/submissionService.ts:15-19`), never into completion. This
  materially lowers the cost of the fix in §5 — a finalized-head source is already in the dependency
  set.
- **No multi-indexer / cross-check:** wallet configuration is a **single** `indexerHttpUrl`
  (`packages/facade/src/index.ts:339-341`); there is no second endpoint to diverge against. Even the
  "latest block" the wallet fetches for validation comes from the *same* indexer, not the node
  (`packages/capabilities/src/validation/blockData.ts:34-50`).

**Net:** today's mitigations address *transport* and *disconnection*, not *single-source trust in the
completion signal*. There is no independent tip.

---

## 5. Prior art — how trust-minimized clients decide "caught up to tip"

The standard practice is to anchor "caught up" to something the client can *verify* or *cross-check*,
not a single server's self-report.

### 5.1 Substrate/Polkadot light clients verify GRANDPA finality (most directly applicable)

Midnight is a Substrate/GRANDPA chain (its own wallet spec says so — `Specification.md:672`). The
canonical trust-minimized way to learn the finalized head on such a chain is to **verify a GRANDPA
finality justification**: a light client tracks the authority-set changes and checks that ≥2/3 of the
authorities signed a block, establishing finality without trusting the serving node. This is exactly
what **smoldot** does. See Polkadot's Light Clients docs
(https://docs.polkadot.com/develop/toolkit/parachains/light-clients/) and smoldot
(https://github.com/paritytech/smoldot). Because the SDK already has a node client that sees
finalized status (§4), reconciling completion against a verified/observed finalized head is the
natural, low-friction fix.

### 5.2 Zcash light-wallet threat model (the closest analogue, same trust axis)

Zcash's Wallet App Threat Model is a near-exact analogue of Midnight's wallet↔indexer relationship
and even predicts this issue's outcomes
(https://zcash.readthedocs.io/en/latest/rtd_pages/wallet_threat_model.html):

- Trusted (typical) server: *"Lightwalletd only ever provides valid information coming from a
  consistent Zcash blockchain state. However, **the information is not guaranteed to be recent**, and
  part of it may change (e.g. after a reorg) and even revert to old state."* — i.e. the freshness axis
  is explicitly *not* covered by trusting the server for validity.
- Compromising (untrusted) server: it can *"make the user think their balance is lower than it
  actually is"* by omitting incoming transactions — precisely scenario (b) above.
- Mitigation guidance: run/control your own lightwalletd (reduce single-server trust). The Midnight
  analogue is multi-indexer cross-check and/or a node-anchored tip.

### 5.3 Cosmos/CometBFT and Ethereum light clients (general pattern)

Tendermint/CometBFT light clients verify **signed headers against the validator set** to accept a
height as finalized; Ethereum's beacon light client verifies **finalized headers via sync-committee
signatures**. In both, "caught up to tip" means "verified a signature/quorum over the header at that
height," never "a server told me a number." Same principle: bind completion to a cryptographically
attested tip.

---

## 6. Severity and remediation framing

### Severity: **Medium** (view-integrity + availability; not confidentiality-of-funds, not fund-loss)

Rationale:
- **Impact ceiling is a stale/withheld *view*.** No key compromise, no theft, no forged spend the
  wallet accepts; funds remain spendable once synced against an honest source. This caps severity
  below High.
- **But the failure is silent, can be persistent, and can be adversarially targeted** (scenario b),
  and it degrades the *safety-critical* `isSynced`/balance signals that integrators (exchanges, PoS,
  auto-sweeps) reasonably treat as ground truth. A silent, indefinite "you're synced" that is false
  is materially worse than a visible "still syncing," which lifts it above Low.
- **No confidentiality delta:** a malicious indexer already sees the viewing data by design (it is
  trusted for privacy); this gap adds no new information leak.

A CVSS-style sketch lands around Medium: high availability/integrity-of-view impact, no
confidentiality or fund-integrity impact, attack requires a privileged position (be/subvert the
configured indexer, or MITM a weak transport).

### Suggested remediation (standard, ordered by leverage)

1. **Anchor completion to a finality-verified tip.** Reconcile "strictly complete" against the node's
   GRANDPA-finalized head — ideally by *verifying* a finality justification (smoldot-style, §5.1), at
   minimum by *observing* the node's finalized height via the already-present `PolkadotNodeClient`
   (§4) and requiring the indexer's reported tip to reach it. "Caught up" should mean "reached a tip
   I independently believe is the network's," not "reached the number this indexer sent."
2. **Multi-source cross-check.** Allow configuring more than one indexer and flag/​degrade when their
   reported tips diverge beyond a tolerance (Zcash's "control your infrastructure" guidance, §5.2),
   converting silent single-source trust into detectable disagreement.
3. **Surface staleness / liveness explicitly.** Track wall-clock time since the reported tip last
   advanced and expose a distinct "cannot confirm caught up to network tip" state, so a stalled or
   pinning indexer produces an observable signal instead of a false `isSynced`.
4. **Tighten the public contract.** Rename/document `isSynced` to distinguish "caught up to the
   indexer's reported data" from "caught up to the verified network tip," so integrators do not
   over-trust the former. Cheap, and immediately reduces the blast radius of (a)/(b).

### One-paragraph issue framing (drop-in)

> The wallet SDK decides "fully synced" by comparing its applied cursor to
> `highestTransactionId`/`maxId`, a value the connected indexer computes over its *own* database and
> self-reports (schema-v4.graphql:2424-2429; SyncProgress.ts:29-33; Sync.ts:112). There is no
> independent, finality-anchored tip: a single stalled replica or a hostile/MITM'd indexer that pins
> that number and withholds the matching events makes `isSynced` return `true` while the wallet is
> behind or is being shown an incomplete view — silently and, in the malicious case, indefinitely.
> We recognize the indexer is a *trusted* component by design (Specification.md:745,759), so this is
> a **defense-in-depth request**, not a claim of a broken invariant, and the impact is
> **view-integrity/liveness, not loss of funds**. The standard fix is to reconcile completion to a
> finality-verified tip (the SDK already reaches a GRANDPA-finalized node client for submission —
> PolkadotNodeClient.ts:223-233) and/or cross-check multiple indexers, mirroring Substrate light
> clients (smoldot GRANDPA justifications) and the Zcash light-wallet threat model.

---

## Appendix — citation index

Wallet SDK (`~/repos/midnight-wallet`):
- `packages/unshielded-wallet/src/v1/SyncProgress.ts:29-33,53-55` — completion predicate.
- `packages/abstractions/src/SyncProgress.ts:31-34` — shared shielded/dust predicate.
- `packages/facade/src/index.ts:287-292` — public `isSynced`; `:339-341` — single `indexerHttpUrl`.
- `packages/runtime/src/WalletBuilder.ts:143-145` — `syncComplete` gap check.
- `packages/unshielded-wallet/src/v1/Sync.ts:106-116` — `highestTransactionId`/`isConnected` from indexer.
- `packages/dust-wallet/src/v1/Sync.ts:330`; `packages/shielded-wallet/src/v1/Sync.ts:293` — `maxId`.
- `packages/unshielded-wallet/src/v1/RunningV1Variant.ts:139-150` — reconnection/backoff.
- `packages/node-client/src/effect/PolkadotNodeClient.ts:223-233` — GRANDPA-finalized observation.
- `packages/capabilities/src/submission/submissionService.ts:15-19` — node client used only for submit.
- `packages/capabilities/src/validation/blockData.ts:34-50` — "latest block" fetched from indexer.
- `docs/spec/Specification.md:740-745,759,766-768,672` — documented indexer trust model + GRANDPA.

Indexer (`~/repos/midnight-indexer`):
- `indexer-api/graphql/schema-v4.graphql:2424-2429` — `highestTransactionId` semantics.
- `indexer-api/src/infra/storage/transaction.rs:522-550` — `MAX()` over indexer DB.
- `indexer-api/src/infra/api/v4/subscription/unshielded.rs:284-310` — progress polling loop.
- `docs/architecture.md:16` — chain-indexer consumes finalized blocks.

External prior art:
- Zcash Wallet App Threat Model — https://zcash.readthedocs.io/en/latest/rtd_pages/wallet_threat_model.html
- Polkadot Light Clients — https://docs.polkadot.com/develop/toolkit/parachains/light-clients/
- smoldot — https://github.com/paritytech/smoldot
