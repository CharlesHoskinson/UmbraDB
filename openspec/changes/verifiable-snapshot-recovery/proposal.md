# Proposal — Verifiable Wallet-State Snapshot Recovery

> **Status:** Design — formal spec (synthesis pass 2). Folds in the design council's and the
> correctness-gate adjudication's settled conclusions, which **revise** the design-lead draft
> (`design/verifiable-snapshot-design.md`). Not yet implemented; drafted for build sign-off.

## Why

UmbraDB persists a Midnight wallet's replay-derived sync state, but the Midnight SDK ships only
in-memory storage: every serialized snapshot today is `{local-state hex, protocolVersion,
networkId, offset}` with the cursor itself `Schema.optional` — no block hash, no tree root, no
finality anchor (`design/verifiable-snapshot-design.md` §1; brief 01 §5). On memory loss the
wallet must restore from UmbraDB — which may be **local or REMOTE/UNTRUSTED** — and be sure the
restored state is correct **without replaying the chain from genesis**.

The governing reduction (brief 03 §0): **the DB is never a source of correctness, only of
availability.** Content-addressing and AES-GCM prove "the bytes I read are the bytes written";
they never prove "the bytes are the correct chain-derived state." UmbraDB's own
`Formal/STORAGE_ALGEBRA.md` §6 reached exactly this conclusion — content-addressing + AES-GCM
suffice for the *local, single-writer, non-Byzantine* case, and it explicitly flags that a future
"export this checkpoint and let someone else verify it" requirement "would flip the threat model
to the exact external-verifier case." That flip is precisely this feature. This change closes the
gap between blob-integrity and chain-relative correctness.

**What the council + adjudication settled (this proposal encodes the revised design, not the
draft):**

1. **The Compact on-chain attestation is demoted from load-bearing to optional.** The design-lead
   draft (§3, D1) made an on-chain "Attested Manifest Root" mandatory in v1 to give a cold-booted
   wallet rollback protection. The gate, Fable, and Codex all confirmed this is **not needed for
   correctness**: forward-syncing to a **network-sourced, finality-verified tip** already provides
   both rollback-resistance and freshness — an old-but-genuine snapshot merely costs extra re-scan,
   never wrong state, because the wallet always catches up to the same finalized tip. The
   attestation survives only as an *optional optimization* (fast staleness rejection so a cold boot
   can skip an obviously-stale re-scan). The offline ZK certificate (brief 07) is v1.1, for
   **third-party provability only**; self-restore does not need it.
2. **"Synced" must be redefined (C1 — the load-bearing gap, currently MISSING in the SDK).** The
   sync terminus MUST be a network-sourced, finality-verified tip height (Tier-1 GRANDPA
   justification + state-read proof; Tier-0 k-of-n independent endpoints as the ship-now floor),
   **not** the indexer's self-reported `maxId`. This is also the upstream SDK gap this project's
   own `design/sdk-freshness-issue/` study found.
3. **Mandatory local re-validation at deserialize (C2).** An anchor↔cursor cross-check plus local
   ownership re-validation — re-trial-decrypt the snapshot's claimed notes under the *restoring*
   key (cheap, non-ZK) — which also gives per-note seed-binding.
4. **`R_N` is header-authenticated by content-addressing (adjudication Q1).** `StateKey` is the
   SHA-256 Merkle-DAG root over the whole `LedgerState`; `R_N` is a hash-linked descendant. v1
   authenticates it via k-of-n cross-check + optionally `state_getReadProof` for `StateKey`; a thin
   "serve arena node by hash" surface is a later trust-minimization, not v1-blocking.
5. **Tail completeness is client-side closable with no node change (adjudication Q2 — major).** For
   the tail `[N, tip]`, fetch each finalized block body via `chain_getBlock`, recompute and match
   its BlakeTwo256 `extrinsicsRoot` against the finalized header, and read the complete authenticated
   set of zswap outputs/ciphertexts/nullifiers — closing **both** the ciphertext-delivery and
   spend-hiding residuals that briefs 06/07 wrongly said needed a node change. The succinct
   collapsed-tree ADS remains the cheaper option when full completeness is not required; offer both.
6. **Seed-binding = Option A (adjudication Q3).** Derive `sk_attest` from the 24-word BIP39 seed on
   a dedicated HD path and sign the snapshot commitment with the stack's native Schnorr/secp256k1.
   Cold-start from **only** the 24 words re-derives `pk_attest` + seed-derived blob-id + AES key,
   which locate, decrypt, and authenticate the snapshot. Foreign/other-tenant snapshots fail the
   signature and cannot even be located.

## What changes

Introduces one new capability spec, `verifiable-snapshot-recovery`, delivered across two additive,
non-protocol PRs (brief 04) landing on substrate UmbraDB already has.

1. **Anchor stamping at save (L0).** `serialize` stamps an anchor tuple
   `{blockHeight N, blockHash, treeEndIndex, R_N, finalizedHash}` alongside each wallet-kind's
   serialized local state (`shielded-wallet/src/v1/Serialization.ts:67`, symmetric for dust/
   unshielded). Additive Effect `Schema.Struct`; old snapshots still decode. Anchor **and** cursor
   are made mandatory and internally cross-checked at deserialize.
2. **C1 finality-verified-tip sync terminus.** A new SDK requirement that "synced" resolve to a
   network-sourced, finality-verified tip — Tier-1 `grandpa_proveFinality(N)` +
   `state_getReadProof` (both live: `node/src/openrpc.rs:74,91,481`) or Tier-0 k-of-n — never the
   indexer's `maxId`.
3. **`restoreVerified()` — a sibling static factory to `restore()`** (`ShieldedWallet.ts:238`) that
   runs the fixed verification order before resuming live sync: decrypt → signature under
   `pk_attest` → anchor / `R_N` → C2 anchor↔cursor cross-check + ownership re-decrypt → forward-sync
   to a finality-verified tip → optional `chain_getBlock` tail-completeness. It finally *calls*
   `applyCollapsedUpdate`, which the ledger crate exposes but the wallet never invokes today
   (`shielded-wallet/src/v1/CoreWallet.ts:148-151`).
4. **Seed-binding (Option A).** `sk_attest` at a dedicated HD path (Metadata role reserved index,
   or a new Attest role; `packages/hd/src/HDWallet.ts:17-23`), signing via Schnorr/secp256k1
   `signData`/`signatureVerifyingKey` (`packages/unshielded-wallet/src/KeyStore.ts:16-24,48-70`),
   with the full cold-start-from-24-words recovery flow.
5. **Encryption + anti-rollback (L2).** Client-side AES-256-GCM under a seed-derived key; a
   strictly-monotonic `seq`/`anchorHeight` in the envelope for a running wallet's anti-rollback. The
   plaintext commitment is computed locally after decrypt and never sent to the DB.
6. **`SnapshotStorage` interface + persistence substrate.** A pluggable reader/writer seam mirroring
   the SDK's existing `TransactionHistoryStorage` split, letting UmbraDB's `CheckpointStore`
   (content-addressed) hold the encrypted envelope; `PgTransactionHistoryStorage` (Sprint 7) stays
   authoritative for tx-history on restore. The `WalletState` envelope itself is Sprint 8.
7. **Indexer PR (additive, `@beta` where dust).** An event→block anchor resolver (`TreeAnchor` on
   the ledger-event types — the anchor columns already exist, zero migration:
   `indexer-common/migrations/postgres/001_initial.sql:47-59`) and, for the unshielded model, an
   authenticated by-address index (`unshieldedUtxos(address, offset): UnshieldedUtxoProof`).
8. **Optional `chain_getBlock` tail-completeness** and the **demoted optional on-chain attestation**
   — both offered, neither required for correctness.

## Non-goals (explicitly out of scope)

- **On-chain Compact "Attested Manifest Root" as a correctness requirement.** Demoted (D1 flipped)
  to an *optional* fast-staleness-rejection optimization. Restore correctness never depends on it.
- **Completeness at or below the snapshot horizon N.** The base-at-N `[birthday, N]` completeness
  rests on attest-time honesty — a stated non-goal (brief 05 §1). We defend against a hostile *DB*,
  not a wallet compromised *at the moment it wrote the snapshot*. (A wallet that built its own
  snapshot from an authenticated forward-scan *does* have base completeness; a snapshot handed to it
  does not, and this spec never claims otherwise.)
- **The offline v-lightweight ZK certificate (brief 07).** v1.1, for third-party provability only;
  not needed for self-restore. Carries a new trust surface (hand-authored IR + pinned `vk`) that
  must be audited first (brief 07 §6.3).
- **Recursive IVC checkpoint ratchet (brief 08).** Research-grade; needs a new native-Rust prover.
  Reserve `prevCommitment`/frontier/`R_N` envelope fields to keep the upgrade open; do not build.
- **Multi-device signed hash-chained CRDT deltas (brief 11 §5).** Deferred to v1.1; reserve envelope
  fields now.
- **Any Midnight node / protocol change.** The trust-minimizing "serve arena node by hash" surface
  (adjudication Q1), a consensus-emitted clue key / FMD (brief 09), a Substrate body-inclusion proof
  or nullifier accumulator (brief 06 §2.4/§3): all flagged to the Midnight team, none in this scope.
- **Privacy-from-scanner detection tag (brief 09).** A v1.x overlay; the remote scanner still learns
  ownership until it ships. Out of scope here.
- **The unshielded MB-tree's full trustless anchoring** (consensus utxo-root). v1 ships the
  signed-STH + monitor + k-of-n option (brief 06 §4.4-②); the consensus-root close is deferred.
- **Lean formalization.** Parallel, independent workstream, as in every prior sprint's proposal.

## Impact

- **New:** `openspec/changes/verifiable-snapshot-recovery/` (this change) and, on build, the SDK
  additions (anchor field, `restoreVerified`, `SnapshotStorage`) + indexer additions (`TreeAnchor`
  resolver, `unshieldedUtxos` proof). All additive; neither a breaking SDK change nor a protocol
  change.
- **Substrate reused:** UmbraDB `CheckpointStore` (content-addressed envelope, per-`(walletId,
  networkId)` monotonic sequence for the anti-rollback `seq`), `PgTransactionHistoryStorage`
  (Sprint 7, authoritative for tx-history), the `WalletState` envelope (Sprint 8).
- **Biggest risk — over-claiming completeness (the design's own #1 risk, brief 06 §2.4 / 07 §3.1 /
  09 §10).** Everywhere "verified" appears it MUST mean *commitment*-completeness + inclusion +
  finality-anchoring + rollback-resistance + (with `chain_getBlock`) tail delivery-completeness —
  and MUST NOT imply complete-balance where a residual exists (base-at-N, or tail without the
  full-body scan). A UI that quietly implies "fully verified, no trust in the feed" would mislead
  users into financial decisions against a possibly-under-counted balance. This is encoded as an
  Unwanted-behavior requirement, not left to discipline.
- **Second-order risk:** the demoted attestation and the v1.1 ZK cert must not creep back in as
  correctness dependencies; the spec pins them as optional/deferred.
- **Delivery:** matches this project's cadence — proposal/design/tasks/spec drafted and reviewed
  first, *then* an implementer builds against it with per-task auditors. This change is the formal
  output of the design-council + adjudication rounds already recorded in
  `design/research/2026-07-21-snapshot-root-of-trust/00–12`.
