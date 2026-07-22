# verifiable-snapshot-recovery

The capability by which a Midnight wallet restores its replay-derived state from a
local-or-untrusted UmbraDB snapshot and establishes that the restored state is correct
**without replaying the chain from genesis** — reducing every no-replay check to an on-chain
commitment the wallet independently trusts, whose trust reduces to GRANDPA finality.

Requirements below follow EARS (Easy Approach to Requirements Syntax): each is one of Ubiquitous
("The system SHALL..."), Event-driven ("WHEN \<trigger>, the system SHALL..."), Unwanted-behavior
("IF \<trigger>, THEN the system SHALL..."), State-driven ("WHILE \<state>, the system SHALL..."),
or Optional-feature ("WHERE \<feature>, the system SHALL...") form — as in Sprint 4's
`specs/watermarks/spec.md`.

Grounding: `design.md` (this change) folds in the design council's conclusions and the
correctness-gate adjudication (`design/research/2026-07-21-snapshot-root-of-trust/12-…`, Q1–Q3),
which revise the design-lead draft (`design/verifiable-snapshot-design.md`). Every scenario maps to
a test in `tasks.md`'s testing strategy.

## ADDED Requirements

### Requirement: An anchor tuple is stamped alongside each serialized snapshot (L0)

`serialize` SHALL stamp, alongside each wallet-kind's serialized local state, an anchor tuple
`{ blockHeight N, blockHash, treeEndIndex, R_N, finalizedHash }` — where `R_N` is the relevant
tree root recomputed locally at serialization time (`zswapMerkleTreeRoot` + `zswapEndIndex` for the
shielded wallet; both dust roots + end-indices for the dust wallet; the by-address UTXO-set root for
the unshielded wallet) and `finalizedHash` is the finalized head the anchor is bound to. The anchor
field SHALL be an additive schema addition (`shielded-wallet/src/v1/Serialization.ts:67`), such that
a snapshot serialized before this change still deserializes.

#### Scenario: A freshly serialized snapshot carries a complete anchor tuple

- **WHEN** `serialize` is called on a wallet synced to a finalized block `N`
- **THEN** the produced snapshot SHALL contain an anchor with `blockHeight`, `blockHash`,
  `treeEndIndex`, `R_N`, and `finalizedHash` all populated for that block
- **AND** `R_N` SHALL equal the tree root recomputed offline from the snapshot's own local state at
  `treeEndIndex`

#### Scenario: A pre-anchor legacy snapshot still deserializes

- **WHEN** a snapshot serialized before the anchor field existed (no `anchor`) is deserialized
- **THEN** deserialization SHALL succeed structurally rather than throwing on the missing field
- **AND** the wallet SHALL treat the absent anchor as "unverifiable" and refuse to present the
  restore as verified (per the honest-scoping requirement below), not silently accept it as verified

### Requirement: Anchor and cursor are mandatory and cross-checked at deserialize (C2)

At deserialize the system SHALL require BOTH the anchor tuple AND the sync cursor to be present, and
SHALL cross-check them for mutual consistency (the cursor's block/height/end-index must match the
anchor's), rejecting the snapshot before any live sync begins if either is absent or if they
disagree. This closes the gap that today even the cursor is `Schema.optional` in all three
wallet-kind schemas (brief 01 §6 gap 4).

#### Scenario: A snapshot whose cursor and anchor disagree is rejected

- **WHEN** `restoreVerified` deserializes a snapshot whose cursor names a height or end-index that
  does not match the anchor's `blockHeight`/`treeEndIndex`
- **THEN** the call SHALL reject with an anchor/cursor cross-check error before any live sync begins
- **AND** no wallet handle SHALL be returned to the caller

#### Scenario: A snapshot missing either the anchor or the cursor is not accepted as verified

- **WHEN** `restoreVerified` deserializes a snapshot that carries a cursor but no anchor, or an
  anchor but no cursor
- **THEN** the call SHALL NOT return a wallet presented as verified
- **AND** it SHALL either reject or fall back to an explicitly-unverified replay path, never treat
  the partial snapshot as verified

### Requirement: Local ownership is re-validated by re-trial-decrypting claimed notes (C2)

At deserialize, before resuming live sync, the system SHALL re-trial-decrypt each note the snapshot
claims the wallet owns under the **restoring** key, and SHALL reject the snapshot if any claimed note
does not decrypt under that key. This is a cheap, non-ZK per-note seed-binding check: it proves the
snapshot's claimed notes are genuinely this key's notes, not a foreign or tampered set.

#### Scenario: A claimed note that does not trial-decrypt under the restoring key is rejected

- **WHEN** the snapshot claims ownership of a note whose ciphertext does not trial-decrypt to a
  well-formed plaintext under the restoring wallet's key
- **THEN** `restoreVerified` SHALL reject the snapshot with an ownership-revalidation error
- **AND** SHALL NOT resume live sync from the rejected state

#### Scenario: A foreign-tenant snapshot's notes fail ownership re-validation

- **WHEN** a snapshot whose notes belong to a different wallet's key is fed to `restoreVerified`
  under the restoring key
- **THEN** the claimed notes SHALL fail trial-decryption and the snapshot SHALL be rejected
- **AND** the rejection SHALL occur locally, requiring no network round-trip

### Requirement: "Synced" means forward-synced to a network-sourced, finality-verified tip (C1)

The system SHALL define the sync terminus as a **network-sourced, finality-verified tip height** —
established via a GRANDPA finality proof (Tier-1) or a k-of-n independent-endpoint agreement
(Tier-0) — and SHALL forward-sync `[N, tip]` up to that terminus on every verified restore. The
terminus SHALL NOT be derived from a single indexer's self-reported `maxId`. Forward-sync to this
terminus is what provides rollback-resistance and freshness: an old-but-genuine snapshot costs only
extra re-scan, never wrong state.

#### Scenario: The sync terminus is a finality-verified tip, not an indexer maxId

- **WHEN** `restoreVerified` determines how far to forward-sync `[N, tip]`
- **THEN** the terminus SHALL be a height whose finality has been verified against the network
  (Tier-1 justification or Tier-0 k-of-n)
- **AND** the wallet SHALL NOT treat a single indexer's self-reported `maxId` as the sync terminus

#### Scenario: An old-but-genuine rolled-back snapshot still restores to correct state

- **WHEN** an untrusted DB serves a genuine but stale snapshot at height `N_old < current finalized
  tip`
- **THEN** forward-sync `[N_old, tip]` to the finality-verified tip SHALL recover all notes and
  nullifiers created after `N_old`, yielding state equivalent to a from-genesis replay control
- **AND** correctness SHALL NOT depend on any on-chain attestation having detected the rollback

### Requirement: Finality is verified, not assumed — Tier-1 GRANDPA proof with a Tier-0 floor

WHERE a GRANDPA justification verifier is available, the system SHALL verify a finalized height by
fetching `grandpa_proveFinality(N)` from an untrusted endpoint and verifying the Ed25519 threshold
justification locally against a trusted `(set_id, authorities)` weak-subjectivity seed
(`GrandpaJustification::verify_with_voter_set`), plus `state_getReadProof` for `StateKey` against
the finalized header's own `state_root` (both RPCs live: `node/src/openrpc.rs:74,91,481`). WHILE
that verifier is not yet available, the system SHALL fall back to Tier-0: require exact agreement on
`(N, blockHash, R_N)` across k-of-n independently operated endpoints.

#### Scenario: A tampered GRANDPA justification fails Tier-1 verification

- **WHEN** an endpoint returns a `grandpa_proveFinality(N)` whose threshold signatures do not verify
  under the trusted authority set
- **THEN** finality verification SHALL fail and the restore SHALL NOT proceed to accept `N` as
  finalized
- **AND** the failure SHALL NOT be maskable by the endpoint asserting finality without a valid proof

#### Scenario: Tier-0 k-of-n rejects a single lying endpoint

- **WHILE** running with the Tier-0 floor and no justification verifier
- **WHEN** one of n queried endpoints reports a `(N, blockHash, R_N)` that disagrees with the others
- **THEN** the k-of-n check SHALL fail closed rather than accept the majority silently overriding a
  disagreement below the k threshold

### Requirement: R_N is authenticated as a SHA-256 descendant of the header-authenticated StateKey

The system SHALL treat `R_N` as a SHA-256-committed descendant of `StateKey` — the arena Merkle-DAG
root the finalized header authenticates (`StateKey = StorageValue<_, Vec<u8>>`,
`pallets/midnight/src/lib.rs:157`, written by `StateKey::<T>::put(state_root)` at `:347`;
`DefaultHasher = sha2::Sha256`, `storage-core/src/lib.rs:41`; `Sp::hash` = "content-addressed
Merkle node", `arena.rs:1507-1508`). In v1 the system SHALL authenticate `R_N` via k-of-n
cross-check and, where available, `state_getReadProof` for the `StateKey` leaf; it SHALL NOT claim
that `state_getReadProof` alone authenticates `R_N` (the arena walk from `StateKey` down to the
zswap root is a separate, currently-unserved hop — adjudication Q1).

#### Scenario: Restore does not over-claim that the state-read proof alone authenticates R_N

- **WHEN** the wallet obtains `R_N` from `midnight_zswapStateRoot` or `Block.zswapMerkleTreeRoot`
  together with a `state_getReadProof` for `StateKey`
- **THEN** the system SHALL treat `R_N` as trusted only up to the k-of-n / arena-walk basis actually
  discharged, not as fully header-authenticated by the state-read proof alone
- **AND** the trust basis actually used for `R_N` SHALL be recorded for the honest-scoping report

### Requirement: restoreVerified executes its verification steps in a fixed order

WHEN `restoreVerified(serialized, conn)` is invoked, the system SHALL perform, in this order:
(1) decrypt the envelope under the seed-derived AES key; (2) verify the snapshot-commitment signature
under `pk_attest`; (3) authenticate the anchor / `R_N`; (4) run the C2 anchor↔cursor cross-check and
ownership re-decrypt; (5) forward-sync `[N, tip]` to a finality-verified tip; (6) optionally run the
`chain_getBlock` tail-completeness scan. The wallet SHALL resume LIVE sync only after steps 1–5
succeed, exactly as the existing resume path (`ShieldedWallet.ts:238`) does today, with no change to
`Sync.ts`'s `resumeFrom`.

#### Scenario: The steps run in order and each is a gate on the next

- **WHEN** `restoreVerified` is called on a well-formed, authentic snapshot
- **THEN** decryption SHALL precede signature verification, which SHALL precede anchor/`R_N`
  authentication, which SHALL precede the C2 cross-check + ownership re-decrypt, which SHALL precede
  forward-sync to the finality-verified tip
- **AND** the returned wallet SHALL be one whose state has passed steps 1–5

### Requirement: Any verification-step failure aborts before resuming live sync

IF any of the ordered verification steps (decrypt, signature, anchor/`R_N`, C2 cross-check +
ownership re-decrypt, finality-verified forward-sync) fails, THEN `restoreVerified` SHALL abort and
SHALL NOT return a wallet that has resumed live sync from the unverified state — it SHALL surface a
typed error, or (only where the caller opted in) fall back to an explicitly-unverified from-birthday
replay, never a silent acceptance.

#### Scenario: A failed signature check aborts the whole restore

- **WHEN** step 2's signature verification fails on an otherwise-decryptable snapshot
- **THEN** the call SHALL reject before step 3 runs
- **AND** no live sync SHALL have been started from that snapshot

#### Scenario: A failed anchor authentication aborts before live sync

- **WHEN** step 3 cannot authenticate `R_N` (k-of-n disagreement, or a `state_getReadProof` that
  does not check against the finalized header's `state_root`)
- **THEN** the call SHALL reject before forward-sync begins
- **AND** SHALL NOT present the state as verified

### Requirement: sk_attest is derived on a dedicated HD path, separate from spend and viewing keys

The system SHALL derive `sk_attest` from the 24-word BIP39 seed on a dedicated, purpose-separated HD
path — either the `Metadata` role (index reserved) or a new `Attest` role
(`packages/hd/src/HDWallet.ts:17-23`, `m/44'/2400'/{account}'/{role}/{index}`) — and SHALL NOT reuse
the `NightExternal` (spend) or `Zswap`/`Dust` (viewing) keys, so that a leak of `sk_attest` can
neither spend nor de-anonymize.

#### Scenario: sk_attest does not collide with the spend or viewing key material

- **WHEN** `sk_attest` is derived for an account
- **THEN** its HD path role SHALL differ from `NightExternal`, `Zswap`, and `Dust`
- **AND** the derived key SHALL be usable only for attestation signing, never presented as a spend or
  viewing key

### Requirement: The snapshot commitment is signed with Schnorr/secp256k1 bound to pk_attest

The system SHALL sign a canonical snapshot commitment
`canonical(snapshotRoot || anchor{R_N, N, blockHash} || seq || height)` with the stack's native
Schnorr/secp256k1 (`signData`; `packages/unshielded-wallet/src/KeyStore.ts:16-24,48-70`) under
`sk_attest`, and SHALL bind verification to `pk_attest = signatureVerifyingKey(sk_attest)`. The
signature reuses primitives already in the SDK and adds no new cryptographic trust surface.

#### Scenario: A snapshot's commitment verifies under its own pk_attest

- **WHEN** a snapshot signed under `sk_attest` is verified with the `pk_attest` derived from the same
  seed
- **THEN** the signature over the canonical commitment SHALL verify
- **AND** any bit-flip in `snapshotRoot`, `R_N`, `N`, `seq`, or `height` SHALL cause verification to
  fail

### Requirement: Cold-start recovery reconstructs everything from only the 24-word mnemonic

WHEN the user supplies ONLY the 24-word mnemonic (no server, no local counter, no device state), the
system SHALL: derive the seed; derive `sk_attest`, `pk_attest`, the seed-derived blob-id, and the
seed-derived AES key; locate the snapshot in the DB by blob-id; decrypt it; recompute
`snapshotRoot`; verify the signature under `pk_attest`; verify `seq`/`height`; then run the L0/L1
anchor + finality checks and resume live sync. No input beyond the mnemonic SHALL be required to
reach a verified restore.

#### Scenario: A cold boot from 24 words restores a verified wallet

- **WHEN** all local wallet memory is wiped and the user enters only the correct 24 words for a
  wallet whose snapshot is in the DB
- **THEN** the system SHALL re-derive `pk_attest` + blob-id + AES key, locate and decrypt the
  snapshot, verify its signature and sequence, and reconstruct a verified wallet state
- **AND** it SHALL require no locally-retained counter or device secret to do so

### Requirement: A foreign snapshot fails the signature and cannot even be located

IF the DB serves a snapshot that was attested under a different seed than the one the entered
mnemonic re-derives, THEN the restore SHALL fail the `pk_attest` signature check; AND because the
blob-id and AES key are seed-derived, the DB SHALL be unable to locate or relabel another tenant's
blob as this wallet's (killing the cross-wallet-swap threat, brief 05 §3 A3).

#### Scenario: A hosted multi-tenant DB cannot pass off another tenant's snapshot

- **WHEN** a multi-tenant DB returns another tenant's genuinely-attested snapshot in response to this
  wallet's request
- **THEN** the returned blob's signature SHALL verify only under the other tenant's `pk_attest`, not
  under the `pk_attest` these 24 words re-derive, and the restore SHALL reject it
- **AND** the DB SHALL have no seed-derived blob-id under which to serve that foreign blob as this
  wallet's in the first place

### Requirement: The snapshot envelope is encrypted client-side under a seed-derived key (L2)

The system SHALL encrypt the snapshot envelope with AES-256-GCM under a key deterministically derived
from the wallet seed **before** it reaches UmbraDB, such that the DB sees only ciphertext and opaque
content hashes. The plaintext commitment the wallet checks against the chain SHALL be computed
locally after decrypt and SHALL NOT be sent to the DB.

#### Scenario: The DB never receives the plaintext or the plaintext commitment

- **WHEN** a snapshot is persisted to UmbraDB
- **THEN** the bytes written SHALL be AES-256-GCM ciphertext under the seed-derived key
- **AND** the plaintext commitment used for the on-chain check SHALL be computed only locally after
  decrypt, never transmitted to the DB

### Requirement: A running wallet rejects a snapshot below its highest-ever-accepted sequence

WHILE a wallet is running and holds a local highest-ever-accepted `seq`/`anchorHeight`, the system
SHALL reject a snapshot whose `seq` or `anchorHeight` is below that stored maximum (the ROTE-replay
anti-rollback defense; brief 03 §4). This complements — and does not replace — the cold-boot
freshness that forward-sync to the finality-verified tip provides.

#### Scenario: A stale snapshot is rejected by a running wallet's monotonic counter

- **WHILE** a running wallet holds a highest-accepted `seq = s`
- **WHEN** the DB serves a snapshot with `seq < s`
- **THEN** the running wallet SHALL reject it as a rollback
- **AND** SHALL NOT overwrite its live state with the stale snapshot

### Requirement: Optional chain_getBlock tail-completeness closes ciphertext-delivery and spend-hiding for [N, tip]

WHERE full tail delivery-completeness is required, the system SHALL, for the tail `[N, tip]`, fetch
each finalized block body via `chain_getBlock` (`node/src/openrpc.rs:74`), recompute its BlakeTwo256
`extrinsicsRoot` over the SCALE-encoded extrinsics and match it against the finalized header's
`extrinsicsRoot`, and read the COMPLETE authenticated set of zswap outputs + ciphertexts
(`Output.ciphertext`, `zswap/src/structure.rs:307`) and nullifiers (`:215,382`) — closing both the
ciphertext-downgrade and spend-hiding residuals client-side with no node change (adjudication Q2).

#### Scenario: An authenticated full-body tail scan yields the complete output and nullifier set

- **WHERE** the tail-completeness scan is enabled
- **WHEN** the wallet scans `[N, tip]` via `chain_getBlock` and each block's recomputed
  `extrinsicsRoot` matches its finalized header
- **THEN** the extracted set of outputs, ciphertexts, and nullifiers SHALL be exactly the
  consensus-committed set for `[N, tip]`, with no indexer freedom to downgrade a ciphertext to `None`
  or hide a spend
- **AND** the result SHALL agree with the collapsed-tree root check on commitment positions

### Requirement: A block body whose recomputed extrinsicsRoot mismatches is rejected

IF, during the tail-completeness scan, a fetched block body's recomputed BlakeTwo256 `extrinsicsRoot`
does not equal the finalized header's `extrinsicsRoot`, THEN the system SHALL reject that block body
as non-authentic and SHALL NOT extract outputs, ciphertexts, or nullifiers from it.

#### Scenario: A doctored block body fails the extrinsicsRoot match

- **WHEN** an endpoint serves a block body with an added, removed, or altered extrinsic relative to
  the finalized header
- **THEN** the recomputed `extrinsicsRoot` SHALL differ from the header's and the body SHALL be
  rejected
- **AND** the scan SHALL NOT treat the doctored body as a source of authenticated notes or nullifiers

### Requirement: The succinct collapsed-tree ADS is offered as the cheaper commitment-completeness path

WHERE full tail-delivery-completeness is not required, the system SHALL offer the succinct
collapsed-tree ADS instead: apply `zswapMerkleTreeCollapsedUpdate(startIndex, endIndex)` for
`[endIndex_N, endIndex_tip)` and rehash to a root equal to the on-chain tip root
(`transient-crypto/src/merkle_tree.rs:302-405`, invariant at `:921`; wiring
`applyCollapsedUpdate`, unused today at `CoreWallet.ts:148-151`), giving O(log range)
commitment-completeness at far lower bandwidth than the full-body scan.

#### Scenario: The collapsed-tree path proves commitment-completeness without full-body download

- **WHERE** the caller does not require tail delivery-completeness
- **WHEN** the wallet applies the collapsed update over `[endIndex_N, endIndex_tip)` and rehashes
- **THEN** a rehashed root equal to the on-chain tip root SHALL establish commitment-completeness
  (no commitment omitted, inserted, or reordered) in O(log range) hashes
- **AND** the ciphertext-delivery and spend-hiding residuals SHALL remain open on this path (per the
  honest-scoping requirement), because it does not fetch off-tree evidence

### Requirement: The on-chain Compact attestation is optional and never required for correctness

WHERE fast staleness rejection is desired, an on-chain Compact "Attested Manifest Root" MAY be
consulted so a cold boot can skip an obviously-stale re-scan. The system SHALL NOT make restore
correctness depend on the on-chain attestation: a wallet with no attestation available SHALL still
reach a correct verified restore via forward-sync to the finality-verified tip (D1 flipped).

#### Scenario: Restore succeeds correctly with no on-chain attestation present

- **WHEN** `restoreVerified` runs against a deployment that has published no on-chain attestation
- **THEN** the restore SHALL still reach a verified, correct state via the C1 finality-verified
  forward-sync
- **AND** the absence of an attestation SHALL NOT be treated as a verification failure

#### Scenario: The attestation, when present, only accelerates staleness rejection

- **WHERE** an on-chain attestation is present
- **WHEN** the served snapshot's committed height is below the attestation's latest pointer
- **THEN** the wallet MAY reject the stale snapshot early
- **AND** this early rejection SHALL be an optimization over — never a substitute for — the
  forward-sync freshness guarantee

### Requirement: The system never represents a restored balance as complete where a residual exists

The system SHALL NOT present a restored balance or state as "complete" or "fully verified" wherever a
completeness residual applies. "Verified" SHALL mean exactly: commitment-completeness + inclusion +
finality-anchoring + rollback-resistance, plus (only when the `chain_getBlock` tail scan ran) tail
delivery-completeness. IF a residual applies — base-at-N completeness (attest-time honesty), or the
tail on the collapsed-tree-only path (ciphertext-delivery + spend-hiding) — THEN the system SHALL
surface the restore as verified-with-stated-residual, not as complete-balance.

#### Scenario: A collapsed-tree-only restore is not labelled complete-balance

- **WHEN** a restore completes using the collapsed-tree ADS path without the full-body tail scan
- **THEN** the reported verification status SHALL name the open ciphertext-delivery + spend-hiding
  residual for the tail
- **AND** SHALL NOT represent the balance as fully complete

#### Scenario: A snapshot handed to the wallet is not claimed to have base-at-N completeness

- **WHEN** the wallet restores from a snapshot it did not itself build from an authenticated
  forward-scan
- **THEN** the verification status SHALL state that completeness at or below `N` rests on attest-time
  honesty (a non-goal), not on any check this restore performed
- **AND** SHALL NOT imply the `[birthday, N]` history was independently verified complete

### Requirement: The pluggable SnapshotStorage seam backs the encrypted envelope without an in-memory assumption

The system SHALL expose a `SnapshotStorage` reader/writer interface (mirroring the SDK's existing
`TransactionHistoryStorage` split, which bakes in no in-memory assumption) so that UmbraDB's
content-addressed `CheckpointStore` can hold the encrypted envelope, while `PgTransactionHistoryStorage`
(Sprint 7) remains authoritative for tx-history on restore. The seam SHALL be additive and SHALL NOT
require a breaking change to the existing `serialize()`/`restore()` string contract.

#### Scenario: UmbraDB backs snapshot storage through the injected seam

- **WHEN** a wallet is constructed with a `SnapshotStorage` implementation backed by UmbraDB's
  `CheckpointStore`
- **THEN** `serialize`/`restoreVerified` SHALL read and write the encrypted envelope through that
  injected seam
- **AND** a wallet constructed without a `SnapshotStorage` (the legacy bare-string path) SHALL
  continue to work unchanged
