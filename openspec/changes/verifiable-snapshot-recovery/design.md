# Design — Verifiable Wallet-State Snapshot Recovery

Implementation-level design for the `verifiable-snapshot-recovery` capability. Folds the design
council's conclusions and the correctness-gate adjudication
(`design/research/2026-07-21-snapshot-root-of-trust/12-…`, Q1–Q3) into a buildable v1, **revising**
the design-lead draft (`design/verifiable-snapshot-design.md`). Every load-bearing choice cites a
research brief (`[NN]`) and, where the mechanism lives in Midnight, a verified `repo/path:line`
(spot-re-verified against `~/repos/midnight-{node,ledger,wallet}` on 2026-07-22 — see §11).

Touch-points with UmbraDB's own prior design (cited per this repo's config rule): the encrypted
envelope lands on `CheckpointStore` (`src/interfaces/checkpoint-store.ts`;
`Formal/STORAGE_ALGEBRA.md` §2, Laws C1/C2a/C2b) and the anti-rollback `seq` reuses its
per-`(walletId, networkId)` monotonic sequence; `Formal/STORAGE_ALGEBRA.md` §6 already concluded
content-addressing + AES-GCM suffice for the *local* case and **explicitly flagged that a future
"export this checkpoint and let someone else verify it" requirement flips the threat model to the
external-verifier case** — this feature is that flip, and this design is the layer §6 said would then
be warranted.

## 0. The revision, stated up front

The draft's biggest decision (§3/§12 D1) was that an on-chain Compact attestation must ship in v1 to
give a cold-booted wallet rollback protection. **The council flipped this.** The decisive
observation: rollback-resistance and freshness are already provided by **forward-syncing to a
network-sourced, finality-verified tip** (C1). An untrusted DB that serves an *old-but-genuine*
snapshot cannot make the wallet wrong — the wallet forward-syncs `[N_old, tip]` to the same finalized
tip and recovers everything after `N_old`; the rollback costs only re-scan time. Therefore:

- **C1 (finality-verified-tip sync terminus) is the load-bearing correctness mechanism**, and it is
  the piece currently **missing** in the SDK (this project's `design/sdk-freshness-issue/` study).
- **The on-chain Compact attestation is demoted to an optional optimization** (fast staleness
  rejection so a cold boot can skip an obviously-stale re-scan). Never a correctness dependency.
- **The offline ZK certificate (brief 07) is v1.1**, for *third-party* provability only.
- **Local authentication is done by a seed-derived Schnorr signature (Q3 Option A)** — ownership +
  anti-substitution + anti-rollback binding at cold boot — with no on-chain footprint required.

## 1. Architecture (revised layering)

```
  Restore terminus   Forward-sync to a NETWORK-sourced, FINALITY-VERIFIED tip  (C1 — load-bearing)
  (freshness/rollback)  Tier-1 GRANDPA justification + state-read-proof │ Tier-0 k-of-n floor
                     ─────────────────────────────────────────────────────────────────────────
  L2  at-rest        Client-side AES-256-GCM (seed-derived key)
      hardening      Anti-rollback: monotonic seq/anchorHeight (running wallet)
                     [reserve envelope fields: signed-CRDT deltas → v1.1]
                     ─────────────────────────────────────────────────────────────────────────
  L1  completeness   Tail [N,tip]:  (a) chain_getBlock + extrinsicsRoot  → FULL delivery-completeness
      of the tail          OR       (b) collapsed-tree ADS (cheaper)     → commitment-completeness
                     ─────────────────────────────────────────────────────────────────────────
  L0  anchor +       {finalized N, blockHash, treeEndIndex, R_N, finalizedHash}
      ownership      C2: anchor↔cursor cross-check + re-trial-decrypt claimed notes (seed-bound)
                     R_N = SHA-256 descendant of header-authenticated StateKey (k-of-n / arena walk)
                     ─────────────────────────────────────────────────────────────────────────
  Cold-start key     sk_attest @ dedicated HD path → sign(snapshotRoot‖anchor‖seq‖height)
      binding        Schnorr/secp256k1; pk_attest, seed-derived blob-id + AES key (Q3 Option A)
  ─────────────────────────────────────────────────────────────────────────────────────────────
  OPTIONAL / DEFERRED:  on-chain Compact attestation (fast-staleness only) · offline ZK cert (v1.1) ·
                        IVC ratchet (research) · detection tag (v1.x) · arena-by-hash surface (node)
```

## 2. L0 — anchor and local ownership (C2)

**Anchor tuple.** `serialize` stamps `{ blockHeight N, blockHash, treeEndIndex, R_N, finalizedHash }`
per wallet kind. `R_N` is recomputed locally: `w.state.merkleTreeRoot` for the shielded wallet
(already on `ledger.ZswapLocalState`, never read today), `commitmentTreeRoot()`/`generatingTreeRoot()`
for dust, the by-address UTXO-set root for unshielded (brief 01 §6; brief 03 §7). Additive Effect
`Schema.optional(Schema.Struct({...}))` on `Serialization.ts:67`, symmetric for dust/unshielded —
old snapshots still decode. Because **collapsing leaves the hash invariant**
(`transient-crypto/src/merkle_tree.rs:921`), a restored snapshot's `merkle_tree.rehash().root()`,
computed entirely offline, is bit-identical to the full on-chain root at the same `endIndex`
(brief 01 §6.2) — the check that catches corruption/tamper/bit-rot with zero network.

**R_N authentication (adjudication Q1 — precise).** `StateKey` is the SHA-256 Merkle-DAG root over
the whole `LedgerState`; `R_N` is a hash-linked descendant node. Verified in source:
`StateKey<T> = StorageValue<_, Vec<u8>, ValueQuery>` (`pallets/midnight/src/lib.rs:157`, bounded
`ConstU32<1065>` at `:149`), written each block by `StateKey::<T>::put(state_root)` (`:347`);
`DefaultHasher = sha2::Sha256` (`storage-core/src/lib.rs:41`); `Sp::hash()` is "the root key of
`self`, as a content-addressed Merkle node" (`arena.rs:1507-1508`), and `deserialize` re-derives a
node's hash from content, so reconstructing a node authenticates it (`arena.rs:349-410`,
`:66-79`). **Consequence:** anyone who hands the wallet arena bytes that rehash node-by-node up to
the header-authenticated `StateKey` has handed it the authentic `R_N`. **But** the arena DAG is *not*
in the Substrate trie — `state_getReadProof` authenticates only the `StateKey` **leaf** against the
header's `state_root`; the descent `StateKey → zswap → coin_coms → R_N` needs the arena nodes, which
no RPC serves as a verifiable walk today. So:

- **v1:** take `R_N` from `Block.zswapMerkleTreeRoot` (`schema-v4.graphql:64`, cross-checked by the
  indexer's own re-execution + node `bail!`, brief 04 §3) or `midnight_zswapStateRoot`, and reduce
  trust by k-of-n across independent endpoints; optionally add `state_getReadProof` for `StateKey`.
  The spec **forbids over-claiming** that the state-read proof alone authenticates `R_N`.
- **Later trust-minimization (node/indexer, not v1-blocking, not consensus):** a "serve arena node by
  hash" surface lets the wallet rehash the path root→zswap→`coin_coms` and recompute
  `R_N = coin_coms.rehash().root()` from the now-authenticated subtree — the true close of brief 01
  §6 gap-1. Added to the same ask-list as §5's body-proof.

**C2 — mandatory cross-check + ownership re-validation.** Today even the cursor is `Schema.optional`
in all three schemas (brief 01 §6 gap 4). This design makes anchor **and** cursor mandatory and
cross-checked at deserialize, and adds a **local ownership re-validation**: re-trial-decrypt each
claimed note under the *restoring* key. It is cheap and non-ZK, gives per-note seed-binding, and is
what rejects a foreign/tampered note set locally with no network round-trip.

## 3. C1 — the finality-verified-tip sync terminus (the load-bearing gap)

"Synced" is redefined: the terminus is a **network-sourced, finality-verified tip height**, never a
single indexer's self-reported `maxId`. Two tiers (brief 10):

- **Tier-1 (target):** a bounded, one-shot GRANDPA justification check per restore. Holding a trusted
  `(set_id, authorities)` weak-subjectivity seed (bootstrapped once from the genesis authority set),
  fetch `grandpa_proveFinality(N)` from any untrusted endpoint and verify the Ed25519 threshold
  justification locally via `GrandpaJustification::verify_with_voter_set`
  (`polkadot-sdk .../grandpa/src/justification.rs:166-233`), plus `state_getReadProof` for `StateKey`
  against the header's own `state_root` (`sp_state_machine::read_proof_check`). Both RPCs are live:
  `chain_getBlock`/`grandpa_proveFinality`/`state_getReadProof` at `node/src/openrpc.rs:74,91,481`.
  Wallet-SDK plumbing, not a node change.
- **Tier-0 (ship-now floor):** query ≥ k-of-n independently operated endpoints for
  `(N, blockHash, R_N)` and require exact agreement (brief 10 §5; brief 02 NxN). Closes "one indexer
  lies alone"; does not close coordinated operators.

In-circuit finality is **deferred** (SNARK-hostile: Ed25519 + SHA-512 per precommit × up to ⅔ of
`MaxAuthorities=10_000`; brief 08 §6). The wallet obtains trusted `R_N` off-circuit anyway.

## 4. Seed-binding — Q3 Option A (signature)

**Derivation.** `sk_attest = HDWallet.fromSeed(mnemonicToSeed(words)).selectAccount(a)
.selectRole(ROLE_ATTEST).deriveKeyAt(i)` — a dedicated role, either `Metadata` (role 4) at a reserved
index (zero schema change) or a new `Attest = 5` (cleanest; CONTRIBUTING spec-parity + test-vector
regen cost, brief 04 §5). Roles are `NightExternal=0, NightInternal=1, Dust=2, Zswap=3, Metadata=4`
(`packages/hd/src/HDWallet.ts:17-23`; path `m/44'/2400'/{account}'/{role}/{index}`, `:37-38,135-139`).
Never reuse the spend (`NightExternal`) or viewing (`Zswap`/`Dust`) keys.

**Signing.** `pk_attest = signatureVerifyingKey(sk_attest)`; `sig = signData(sk_attest,
canonical(snapshotRoot ‖ anchor{R_N,N,blockHash} ‖ seq ‖ height))` — native Schnorr/secp256k1 (BIP340)
already in the unshielded keystore (`packages/unshielded-wallet/src/KeyStore.ts:16-24,48-70`;
`schnorr` from `@noble/curves/secp256k1`, `spec-reference/src/key-derivation-reference.ts:14,102`).
No new crypto, verifies in microseconds.

**Seed-derived location + encryption.** `blob-id = persistentHash("umbradb:attest:v1:id", sk_attest)`;
AES key seed-derived (brief 03 §5). So the DB can neither identify nor substitute; a foreign blob has
no id under which to be served as ours.

**Why Option A over B (ZK proof-of-preimage).** B is expressible (`transient_hash(seed‖domain‖salt)`
+ a zkir preimage proof) but drags in the proof-server, an audited hand-written IR, a pinned `vk`, and
the KZG SRS (brief 07 §6.3) to prove "I know the secret" — which a signature settles in microseconds.
Keep B for v1.1 only if a *third party* must be convinced of seed-ownership without seeing `pk_attest`.

## 5. Completeness — what "verified" means, and the residual

L1 tail completeness has two paths (offer both):

- **(a) Full delivery-completeness — `chain_getBlock` + `extrinsicsRoot` (adjudication Q2, major).**
  For `[N, tip]`, fetch each finalized block body (`chain_getBlock`, `node/src/openrpc.rs:74`),
  recompute the BlakeTwo256 ordered-trie `extrinsicsRoot` over the SCALE-encoded extrinsics and match
  it against the finalized header, then extract every `Output.ciphertext`
  (`zswap/src/structure.rs:307`, `Some`/`None` as truly on-chain) and every `nullifier` (`:215,382`).
  Midnight txs are `send_mn_transaction(_origin, midnight_tx: Vec<u8>)` at `call_index(0)`
  (`pallets/midnight/src/lib.rs:371-373`), so each is one self-describing extrinsic. This closes
  **both** §5 residuals for the tail with no node change — an indexer can no longer downgrade a
  ciphertext to `None` or hide a spend. Cost: full-body download + SCALE-decode + ledger-deserialize
  of the tail (fine for a short recent-N tail; heavy for a long tail).
- **(b) Commitment-completeness — collapsed-tree ADS (cheaper).** `applyCollapsedUpdate` over
  `[endIndex_N, endIndex_tip)` rehashing to the on-chain tip root (`merkle_tree.rs:302-405`, invariant
  `:921`; unused today at `CoreWallet.ts:148-151`). O(log range) ≤ 32 hashes. Leaves the
  ciphertext-delivery + spend-hiding residual **open** (Zcash-parity), bounded by NxN +
  only-spend-own-notes + first-spend re-validation (brief 09 ②).

**Honest scoping (non-negotiable, encoded as an Unwanted requirement).** "Verified" = commitment-
completeness + inclusion + finality-anchoring + rollback-resistance, plus (only with path (a)) tail
delivery-completeness. It NEVER implies complete-balance where a residual exists: base-at-N
`[birthday, N]` rests on attest-time honesty (a non-goal — brief 05 §1), and the collapsed-tree-only
tail keeps the delivery/spend residual. A wallet that *built its own* snapshot from an authenticated
forward-scan does have base completeness; a snapshot handed to it does not.

## 6. Delivery — two additive PRs on existing substrate

**SDK PR (`midnight-wallet`, additive):** (a) the anchor field on the snapshot schema
(`Serialization.ts:67`); (b) `restoreVerified()` — a sibling static factory to `restore()`
(`ShieldedWallet.ts:238`) running the §7 ordered checks as a gate in front of the existing resume
path (no change to `Sync.ts`'s `resumeFrom`), finally *calling* `applyCollapsedUpdate`; (c) a
`SnapshotStorage` reader/writer interface mirroring the existing `TransactionHistoryStorage` split
(`abstractions/src/TransactionHistoryStorage.ts:215-216`), which bakes in no in-memory assumption.

**Indexer PR (`midnight-indexer`, additive, `@beta` where dust):** a `TreeAnchor` `#[ComplexObject]`
resolver on the ledger-event types mapping event-cursor → committed root (the anchor columns already
exist — **zero migration**: `indexer-common/migrations/postgres/001_initial.sql:47-59`); and, for
the unshielded model, `unshieldedUtxos(address, offset): UnshieldedUtxoProof` — an authenticated
by-address MB-tree (signed-STH + monitor + k≥2 indexers for v1; consensus utxo-root deferred; brief
06 §4.4-②).

**Persistence substrate (UmbraDB):** `CheckpointStore` holds the AES-GCM envelope (its `manifestHash`
= the `snapshotRoot` the signature commits to); its monotonic `CheckpointSequence` is the home for the
anti-rollback `seq`; `PgTransactionHistoryStorage` (Sprint 7) stays authoritative for tx-history on
restore; the `WalletState` envelope itself is Sprint 8.

## 7. Restore verification order (the gate)

`restoreVerified(serialized, conn)` performs, in order, aborting on any failure before live sync:

1. **Decrypt** the envelope under the seed-derived AES key.
2. **Signature** — verify `sig` over the canonical commitment under `pk_attest` (§4).
3. **Anchor / R_N** — offline root recompute vs `R_N`; on-chain agreement (`block(offset)`);
   authenticate `R_N` per §2 (k-of-n, optional `state_getReadProof`); verify finality per §3.
4. **C2** — anchor↔cursor cross-check + re-trial-decrypt claimed notes under the restoring key.
5. **Forward-sync `[N, tip]`** to the finality-verified tip (C1) — the freshness/rollback guarantee.
6. **Optional** — `chain_getBlock` tail-completeness scan (§5a) for full delivery-completeness.

Then `startFirst(Wallet, deserialized)` → `.start(secretKeys)` resumes LIVE exactly as today.

## 8. Anti-rollback, encryption, multi-device (L2)

AES-256-GCM under the seed-derived key wraps the plaintext before it reaches chunking; the plaintext
commitment is computed locally after decrypt and never sent to the DB. A running wallet holds a
highest-ever-accepted `seq`/`anchorHeight` and rejects any snapshot below it (ROTE-replay defense,
brief 03 §4) — complementary to, not a replacement for, C1's cold-boot freshness. **Multi-device
signed hash-chained CRDT deltas (brief 11 §5) are deferred to v1.1**; reserve envelope fields now so
the upgrade is non-breaking.

## 9. Phasing table

| Capability | Layer | v1 (no protocol change) | Needs node/protocol change | Research-grade / deferred |
|---|---|---|---|---|
| Anchor tuple persisted + offline root recompute | L0 | ✅ [01 §6] | | |
| On-chain agreement (`block(offset)`) | L0 | ✅ [01 §6] | | |
| **C1 sync terminus = finality-verified tip (Tier-0 k-of-n)** | C1 | ✅ [10 §5] | | |
| **C1 Tier-1 GRANDPA justification + state-read-proof** | C1 | ✅ SDK plumbing [10 §3] | | |
| `R_N` k-of-n + `state_getReadProof(StateKey)` | L0 | ✅ [Q1] | arena-node-by-hash for full trustlessness [Q1] | |
| **C2 anchor↔cursor cross-check + ownership re-decrypt** | L0 | ✅ [Q3, 01 §6] | | |
| Commitment-completeness (collapsed-tree ADS) | L1 | ✅ SDK wires up existing API [06 §2] | dust roots `@beta`, not node-cross-checked [06 §2.5] | |
| **Tail delivery-completeness (`chain_getBlock` + extrinsicsRoot)** | L1 | ✅ client-side, no node change [Q2] | node change only buys succinctness | |
| Unshielded authenticated by-address index (MB-tree) | L1 | ✅ signed-STH + monitor [06 §4.4-②] | consensus utxo-root [06 §4.4-①/③] | |
| Client-side AES-GCM (seed-derived) | L2 | ✅ (UmbraDB has it) [03 §5] | | |
| Anti-rollback (running-wallet monotonic seq) | L2 | ✅ [03 §4] | | |
| **Seed-binding signature (Q3 Option A)** | key | ✅ Schnorr/secp256k1, reuses SDK [Q3] | | |
| Cold-start recovery from 24 words | key | ✅ [Q3] | | |
| On-chain Compact attestation | opt | ✅ optional fast-staleness only [05] (DEMOTED) | | |
| Offline v-lightweight ZK certificate | opt | | | v1.1, third-party only [07] |
| Multi-device signed hash-chained CRDT deltas | L2 | | | v1.1 [11 §5] |
| Recursive IVC ratchet (O(1) history) | opt | | | research [08] |
| Privacy-from-scanner detection tag | priv | | consensus clue key / FMD [09] | v1.x overlay [09 ①] |
| Ciphertext-delivery + spend completeness | §5 | ✅ tail via [Q2]; ⚠️ base-at-N is a non-goal | base-at-N accumulator [06] | |

## 10. Honest residual trust (after all v1 layers)

1. **Consensus/finality** — correctness reduces to GRANDPA not reverting blocks ≤ N; Tier-1 makes it
   *verifiable*, down to one weak-subjectivity seed (brief 10 §0).
2. **Restore-time freshness (A5)** — mitigated by C1 + multi-endpoint; strongest with a local node.
3. **Base-at-N completeness** — a non-goal (attest-time honesty); the *tail* is fully closable via Q2.
4. **Attest-time honesty** — the snapshot transports correctness forward, cannot create it (brief 05
   §1).
5. **Privacy** — the remote scanner still learns ownership until the detection-tag overlay ships (§9).
6. **Trusted-setup + proving-system soundness** — shared with the whole chain, not new to us.

The DB is trusted for **availability only**. TEE attestation is rejected as a substitute (attests
code identity, not chain-relative data; brief 11 §1); acceptable only as an orthogonal at-rest layer.

## 11. Source re-verification (this pass, 2026-07-22)

Re-checked read-only against `~/repos/midnight-{node,ledger,wallet}`, per this repo's correctness
rule: `StateKey = StorageValue<_, Vec<u8>, ValueQuery>` (`pallets/midnight/src/lib.rs:157`),
`StateKeyLength = ConstU32<1065>` (`:149`), `StateKey::<T>::put(state_root)` (`:347`);
`DefaultHasher = sha2::Sha256` (`storage-core/src/lib.rs:41`); `Sp::hash` content-addressed Merkle
node (`arena.rs:1507-1508`), `ArenaHash` (`:131`); `chain_getBlock` (`node/src/openrpc.rs:74`);
`send_mn_transaction` `call_index(0)` (`pallets/midnight/src/lib.rs:371-373`); `Output.ciphertext:
Option<Sp<CoinCiphertext, D>>` (`zswap/src/structure.rs:307`, `:387`), `nullifier: Nullifier`
(`:215,382`). All match. HD roles (`packages/hd/src/HDWallet.ts:17-23`) and Schnorr signing
(`packages/unshielded-wallet/src/KeyStore.ts`) per brief 12 Q3, not independently re-opened this pass.
No Midnight source modified; nothing committed.
