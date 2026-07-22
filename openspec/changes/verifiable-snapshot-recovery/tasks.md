# Tasks — Verifiable Wallet-State Snapshot Recovery

Each task states concrete acceptance criteria (what test passes / what command succeeds), per this
repo's `openspec/config.yaml` tasks rule. Implementer builds against `design.md` + `spec.md`; each
task is CLOSED only when its acceptance criteria are demonstrably met and reviewed. Requirement IDs
(R1–R20) below map to the EARS requirements in `specs/verifiable-snapshot-recovery/spec.md`, in order.

## 0. SDK schema + seams (additive, no breaking change)

- [ ] 0.1 **Anchor field on the snapshot schema** (R1; `design.md` §2/§6). Add
  `anchor: Schema.optional(Schema.Struct({ blockHeight, blockHash, treeEndIndex, R_N, finalizedHash }))`
  to `shielded-wallet/src/v1/Serialization.ts:67`, symmetric for dust/unshielded. `buildSnapshot`
  reads the locally-recomputed root (`w.state.merkleTreeRoot` for shielded; `commitmentTreeRoot()`/
  `generatingTreeRoot()` for dust) plus the block anchor from the new indexer `TreeAnchor` field.
  **Acceptance:** `tsc --noEmit` passes; a snapshot serialized before this change still deserializes
  (round-trip test on a captured legacy blob); a freshly serialized snapshot carries all five anchor
  fields and `R_N` equals the offline `rehash().root()` at `treeEndIndex`.
- [ ] 0.2 **`SnapshotStorage` reader/writer interface** (R20; `design.md` §6). Mirror the existing
  `TransactionHistoryStorage` split (`abstractions/src/TransactionHistoryStorage.ts:215-216`) — a
  plain injected interface with no in-memory assumption. **Acceptance:** a wallet constructed with a
  `SnapshotStorage` backed by UmbraDB `CheckpointStore` reads/writes the envelope through the seam; a
  wallet constructed without one (legacy bare-string path) still works — both covered by tests.
- [ ] 0.3 **`restoreVerified()` static factory skeleton** (R7/R8; `design.md` §7). Sibling to
  `restore()` (`ShieldedWallet.ts:238`); a gate in front of the existing resume path, no change to
  `Sync.ts`'s `resumeFrom`. **Acceptance:** `tsc --noEmit` passes; the ordered step pipeline
  (decrypt → sig → anchor/`R_N` → C2 → forward-sync → optional tail) is present with each step a hard
  gate; a unit test proves a thrown error at step *k* prevents step *k+1* from running.

## 1. L0 anchor + C2 local re-validation

- [ ] 1.1 **Offline root recompute + on-chain agreement** (R1; `design.md` §2). Recompute the local
  root and compare to `anchor.R_N`; query `block(offset:{hash})` and compare the committed root/
  endIndex. **Acceptance:** a property test that `serialize → deserialize → rehash().root()` is
  bit-identical to the on-chain root at the same `endIndex` across randomized note sets and
  `firstFree` values (the load-bearing collapse-invariant, `merkle_tree.rs:921`); a tampered local
  root is caught offline with zero network.
- [ ] 1.2 **Anchor↔cursor cross-check, both mandatory** (R2; `design.md` §2). **Acceptance:** a
  snapshot whose cursor height/end-index disagrees with the anchor is rejected before any live sync,
  no wallet handle returned; a snapshot missing either the anchor or the cursor is never returned as
  verified.
- [ ] 1.3 **Ownership re-validation — re-trial-decrypt claimed notes** (R3; `design.md` §2).
  **Acceptance:** a claimed note that does not trial-decrypt under the restoring key is rejected with
  an ownership-revalidation error and no live sync; a foreign-tenant note set fails locally with no
  network round-trip.
- [ ] 1.4 **R_N authentication basis, without over-claiming** (R6; `design.md` §2, adjudication Q1).
  Take `R_N` from `Block.zswapMerkleTreeRoot`/`midnight_zswapStateRoot` under k-of-n; optionally add
  `state_getReadProof` for `StateKey` against the header `state_root`. **Acceptance:** the recorded
  trust basis for `R_N` is exactly the k-of-n / arena-walk actually discharged — a test asserts the
  code never labels `R_N` "header-authenticated by the state-read proof alone."

## 2. C1 finality-verified-tip terminus + finality tiers

- [ ] 2.1 **C1 sync terminus** (R4; `design.md` §3). The forward-sync terminus is a network-sourced,
  finality-verified tip, never a single indexer's `maxId`. **Acceptance:** an integration test on a
  live devnet forward-syncs `[N_old, tip]` from a *deliberately stale* snapshot and reaches state
  equal to a from-genesis replay control (the rollback-costs-only-rescan property); a test asserts the
  terminus is never taken from `maxId` alone.
- [ ] 2.2 **Tier-1 GRANDPA justification + state-read-proof** (R5; `design.md` §3). Verify
  `grandpa_proveFinality(N)` via `GrandpaJustification::verify_with_voter_set` against a trusted
  authority-set seed; `state_getReadProof(StateKey)` via `read_proof_check`. **Acceptance:** an
  integration test against a real node verifies both, including an authority-set-change warp-sync
  fragment; a tampered justification fails verification and blocks the restore.
- [ ] 2.3 **Tier-0 k-of-n floor** (R5; `design.md` §3). **Acceptance:** with no justification verifier,
  querying n endpoints where one disagrees on `(N, blockHash, R_N)` fails closed below the k threshold.

## 3. Seed-binding + cold-start (Q3 Option A)

- [ ] 3.1 **`sk_attest` derivation on a dedicated HD path** (R9; `design.md` §4). Metadata role
  reserved index, or a new `Attest = 5` role (`HDWallet.ts:17-23`). **Acceptance:** `sk_attest`'s role
  differs from `NightExternal`/`Zswap`/`Dust`; a test asserts it is never surfaced as a spend or
  viewing key.
- [ ] 3.2 **Sign the snapshot commitment** (R10; `design.md` §4). `signData(sk_attest,
  canonical(snapshotRoot‖anchor‖seq‖height))`; `pk_attest = signatureVerifyingKey(sk_attest)`.
  **Acceptance:** a signature over the canonical commitment verifies under the matching `pk_attest`; a
  bit-flip in any committed field (`snapshotRoot`/`R_N`/`N`/`seq`/`height`) fails verification.
- [ ] 3.3 **Cold-start recovery from only 24 words** (R11; `design.md` §4/§7). Re-derive
  seed → `sk_attest`/`pk_attest`/blob-id/AES key → locate → decrypt → recompute `snapshotRoot` →
  verify sig + seq → L0/L1. **Acceptance:** a failure/recovery test wipes all local state, enters only
  the correct 24 words, and reconstructs a verified wallet with no locally-retained counter or device
  secret (the core scenario).
- [ ] 3.4 **Foreign-snapshot rejection** (R12; `design.md` §4). **Acceptance:** an adversarial test in
  which a multi-tenant DB returns another tenant's genuinely-attested blob — the signature verifies
  only under *their* `pk_attest`, restore rejects it, and the DB has no seed-derived blob-id under
  which to serve it as ours (threat A3).

## 4. L2 encryption + anti-rollback

- [ ] 4.1 **AES-256-GCM under a seed-derived key** (R13; `design.md` §8). Wrap plaintext before
  chunking; compute the plaintext commitment locally after decrypt, never send it to the DB.
  **Acceptance:** the bytes written to UmbraDB are ciphertext; a test asserts no code path transmits
  the plaintext commitment to the DB.
- [ ] 4.2 **Running-wallet monotonic anti-rollback** (R14; `design.md` §8). Highest-ever-accepted
  `seq`/`anchorHeight` in the `CheckpointStore` sequence. **Acceptance:** a property test that a
  snapshot with `seq`/height below the stored maximum is rejected by a running wallet and does not
  overwrite live state. Reserve envelope fields for the v1.1 multi-device signed-CRDT deltas (fields
  present, unused).

## 5. L1 tail completeness (offer both paths)

- [ ] 5.1 **Collapsed-tree ADS path** (R17; `design.md` §5b). Wire `applyCollapsedUpdate` over
  `[endIndex_N, endIndex_tip)` (unused today, `CoreWallet.ts:148-151`). **Acceptance:** a property test
  that the rehashed root equals the on-chain tip root iff no commitment in the range is omitted,
  inserted, or reordered (fuzz the collapsed-update bytes); the test documents that this path leaves
  the ciphertext-delivery + spend-hiding residual open.
- [ ] 5.2 **`chain_getBlock` full-body tail scan** (R15/R16; `design.md` §5a, adjudication Q2). For
  `[N, tip]`: enumerate `chain_getBlockHash(N..tip)`, fetch bodies, recompute the BlakeTwo256
  `extrinsicsRoot` and match the finalized header, filter `pallet_midnight` `call_index(0)`
  (`lib.rs:371-373`), ledger-deserialize, extract every `Output.ciphertext` (`structure.rs:307`) +
  `nullifier` (`:215,382`). **Acceptance:** an integration test proves the extracted output/ciphertext/
  nullifier set equals the consensus-committed set for a synthetic tail (agreeing with the
  collapsed-tree positions); an adversarial test with a doctored body (added/removed/altered extrinsic)
  fails the `extrinsicsRoot` match and the body yields no notes/nullifiers.

## 6. Honest scoping + optional attestation

- [ ] 6.1 **Honest completeness scoping** (R19; `design.md` §5/§0). **Acceptance:** a test asserts a
  collapsed-tree-only restore reports the open ciphertext-delivery + spend-hiding residual and never
  labels the balance complete; a snapshot the wallet did not itself build is reported as
  verified-with-base-at-N-residual, never as `[birthday, N]`-complete. This is the design's #1 risk;
  the assertion is executable, not documentation-only.
- [ ] 6.2 **On-chain attestation is optional** (R18; `design.md` §0/§9). **Acceptance:** a test proves
  `restoreVerified` reaches a verified, correct state against a deployment with NO on-chain attestation
  (via C1 forward-sync); when present, the attestation only accelerates staleness rejection and its
  absence is never a verification failure.

## 7. Indexer PR (additive, `@beta` where dust)

- [ ] 7.1 **`TreeAnchor` resolver** (supports R1). `#[ComplexObject]` on `ZswapLedgerEvent` (and
  `@beta` dust) following `ledger_events → transactions → regular_transactions`; anchor columns
  already exist — **zero migration** (`001_initial.sql:47-59`). **Acceptance:** woven into
  `native_e2e.rs` byte-identical reference stream; schema-introspection/deprecation smoke test passes;
  the resolver returns `{ endIndex, root, block }` matching the node.
- [ ] 7.2 **`unshieldedUtxos(address, offset): UnshieldedUtxoProof`** (supports R6 unshielded). MB-tree
  materialized view + signed-STH + monitor (brief 06 §4.4-②); returns `{ utxos, boundaryLo, boundaryHi,
  merklePaths, root, rootSignature }`. **Acceptance:** a property test that the non-membership proof
  accepts iff `A⁻ < A < A⁺` are genuinely adjacent and rejects a forged empty result for a present
  address or a dropped UTXO; consensus utxo-root anchoring explicitly deferred.

## 8. Testing strategy (post-implementation) and claim-to-test matrix

Every EARS requirement maps to at least one falsifying test. Categories: **unit**, **property**,
**integration** (real `midnight-node` + indexer via testcontainers, plus a real-preprod exercise),
and **adversarial** (each maps to a threat). A CI pass is not sufficient evidence on its own; a
close-out differential review re-reads spec against committed tests, per every prior sprint's standard.

### 8.1 Unit + property
- [ ] 8.1a **L0 collapse-invariant** (R1): property — `serialize → deserialize → rehash().root()` is
  bit-identical to the on-chain root at the same `endIndex` across randomized note sets/`firstFree`.
- [ ] 8.1b **L1 completeness algebra** (R15/R17): property — `applyCollapsedUpdate` is a monoid
  homomorphism over the range and ANY omitted/reordered/inserted commitment diverges the rehashed root
  from the tip root; fuzz the collapsed-update bytes.
- [ ] 8.1c **Signature binding** (R10): unit — negative tests that a bit-flip in each committed field
  fails Schnorr verification; positive round-trip under the matching `pk_attest`.
- [ ] 8.1d **Anti-rollback monotonicity** (R14): property — a snapshot with `seq`/height below the
  stored maximum is rejected by a running wallet.
- [ ] 8.1e **Ownership re-validation** (R3): unit — a note not trial-decrypting under the restoring key
  is rejected; a note that does decrypt is accepted.
- [ ] 8.1f **Ordered gate** (R7/R8): unit — an injected failure at each step blocks the next and no
  live sync starts.
- [ ] 8.1g **Honest scoping** (R19): unit — the reported status names the exact residual per path and
  never labels a residual-bearing restore "complete."

### 8.2 Integration (real node + indexer; testcontainers + real-preprod)
- [ ] 8.2a **End-to-end verified restore** (R1/R4/R7/R20): `serialize → SnapshotStorage(CheckpointStore)
  .save → cold load → restoreVerified → start` on a live devnet, extending
  `serializationAndRestoration.integration.test.ts`.
- [ ] 8.2b **C1 forward-sync equivalence** (R4): forward-sync `[N_old, tip]` from a stale snapshot to
  the finality-verified tip equals a from-genesis replay control (balance parity).
- [ ] 8.2c **Tier-1 finality** (R5/R6): `grandpa_proveFinality(N)` + `state_getReadProof(StateKey)`
  against a real node, including an authority-set-change warp-sync fragment.
- [ ] 8.2d **`chain_getBlock` tail-completeness** (R15/R16): extracted output/ciphertext/nullifier set
  equals the consensus-committed set; `extrinsicsRoot` match verified on real bodies.
- [ ] 8.2e **Indexer resolvers** (R1 support): `TreeAnchor` + `unshieldedUtxos` woven into
  `native_e2e.rs`; schema smoke test green.
- [ ] 8.2f **Real-preprod exercise**: restore at a finalized preprod checkpoint N, verify against
  preprod's committed `zswapMerkleTreeRoot`, catch up `[N, tip]`, confirm balance parity; dust anchor
  exercised separately and flagged (`@beta`, not node-cross-checked). Pin SDK versions (the in-tree vs
  installed-SDK API drift this project has already hit).

### 8.3 Adversarial (each maps to a threat)
- [ ] 8.3a **Omission** (R15/R16/R17/R19): a malicious indexer stub that (a) omits a committed leaf →
  collapsed-tree root check catches it; (b) downgrades a ciphertext to `None` → caught by the
  `chain_getBlock` tail scan, and the test documents it is NOT caught on the collapsed-tree-only path
  (the honest residual).
- [ ] 8.3b **Rollback** (R4/R14/R18): the DB serves an old-but-genuine snapshot → a running wallet's
  monotonic `seq` rejects it; a cold-booted wallet reaches correct state anyway via C1 forward-sync
  (the D1-flip test — this is the test that justifies the attestation being *optional*, not v1).
- [ ] 8.3c **Anchor / tag tamper** (R1/R2/R6/R16): a tampered local root is caught offline; a mutated
  anchor that disagrees with the cursor is rejected at the C2 cross-check; a doctored block body fails
  the `extrinsicsRoot` match.
- [ ] 8.3d **Cold-boot-from-24-words** (R11): wipe all local state, enter only the mnemonic, reconstruct
  a verified wallet; confirm no locally-retained counter/device secret is needed.
- [ ] 8.3e **Foreign-snapshot rejection** (R12): a multi-tenant DB serves another tenant's attested
  blob → fails the `pk_attest` signature and has no seed-derived blob-id to serve it under (threat A3).
- [ ] 8.3f **Finality forgery** (R5): an endpoint asserts finality without a valid GRANDPA justification
  → Tier-1 blocks; a lone lying endpoint under Tier-0 → k-of-n fails closed.

### 8.4 Claim-to-test matrix (the correctness gate)

| Req | EARS form | Primary test(s) |
|---|---|---|
| R1 anchor stamped | Ubiquitous | 8.1a, 8.2a, 8.2e, 8.3c |
| R2 anchor+cursor mandatory & cross-checked | Ubiquitous/Unwanted | 1.2, 8.3c |
| R3 ownership re-decrypt | Event-driven | 8.1e, 8.3e |
| R4 finality-verified-tip terminus | Ubiquitous | 8.2b, 8.3b |
| R5 finality verified (Tier-1/Tier-0) | Optional/State-driven | 8.2c, 8.3f |
| R6 R_N = SHA-256 descendant of StateKey | Ubiquitous | 1.4, 8.2c, 7.2 |
| R7 fixed verification order | Event-driven | 8.1f, 8.2a |
| R8 any-step failure aborts | Unwanted | 8.1f |
| R9 sk_attest dedicated HD path | Ubiquitous | 3.1 |
| R10 Schnorr signature bound to pk_attest | Ubiquitous | 8.1c |
| R11 cold-start from 24 words | Event-driven | 8.3d |
| R12 foreign snapshot rejected/unlocatable | Unwanted | 8.3e |
| R13 client-side AES-GCM, no plaintext to DB | Ubiquitous | 4.1 |
| R14 running-wallet anti-rollback | State-driven | 8.1d, 8.3b |
| R15 chain_getBlock tail-completeness | Optional | 8.1b, 8.2d, 8.3a |
| R16 extrinsicsRoot mismatch rejected | Unwanted | 8.2d, 8.3a, 8.3c |
| R17 collapsed-tree ADS offered | Optional | 8.1b, 8.3a |
| R18 attestation optional, not correctness | Optional/Unwanted | 6.2, 8.3b |
| R19 never over-claim completeness | Unwanted | 8.1g, 8.3a |
| R20 SnapshotStorage seam | Ubiquitous | 0.2, 8.2a |

- [ ] 8.4a **Close-out differential review**: an auditor re-reads spec against the committed tests and
  confirms every requirement above has at least one falsifying test that actually ran (a CI pass alone
  is not sufficient), and re-runs `openspec validate verifiable-snapshot-recovery --strict`.
