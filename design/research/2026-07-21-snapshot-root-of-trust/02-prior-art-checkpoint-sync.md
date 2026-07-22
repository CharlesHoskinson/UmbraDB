# Prior Art: Trustless / Verifiable State-Snapshot & Checkpoint Sync

**Research angle 2 of 4** for the "verifiable wallet-state snapshot root-of-trust" design.
**Date:** 2026-07-21
**Question:** How do other blockchain systems let a node/wallet trust a recent state
snapshot *without full replay*, and which of those patterns fit a ZK-shielded Midnight
wallet restoring its (replay-derived) state from a persistent, possibly remote/untrusted
database (UmbraDB), verified against on-chain commitments without a full rescan?

Every substantive claim below is cited to a primary source (spec, design doc, or
first-party engineering writeup).

---

## 0. Framing: what UmbraDB actually stores, and the threat we're closing

UmbraDB persists a Midnight wallet's **sync state** — for a ZK-shielded (Zswap-style)
wallet this is dominated by a **note-commitment tree** (an incremental Merkle tree of
coin commitments), a set of tracked notes/witnesses, spent-nullifier tracking, and a
**watermark** (the block height/offset synced to). That state is *authoritative by
replay*: it is the deterministic fold of the indexer's relevant-transaction stream from
genesis (or from a birthday) up to the watermark. UmbraDB's `CheckpointStore` snapshots
this fold so the wallet can resume from a checkpoint and replay only `watermark → tip`
instead of from genesis.

The security question is: **if the checkpoint is served by an untrusted UmbraDB (a
remote host, a shared cache, a corrupted local disk), how does the wallet know the
restored state is the true fold, without re-deriving it from genesis?** Every system
below answers a version of "trust a snapshot without replaying it," and the useful ones
all reduce to the same shape: *bind the snapshot to a commitment that is already
authenticated on-chain, and check the snapshot against that commitment locally.*

---

## 1. Ethereum — checkpoint sync + weak-subjectivity checkpoints

**What it is.** Post-Merge consensus-layer (Beacon) nodes bootstrap by downloading a
recent *finalized* Beacon state (~40 MB) out-of-band from a checkpoint provider, instead
of replaying from genesis. This is called *checkpoint sync* or *weak-subjectivity (WS)
sync* [1][2].

**What is committed / what the snapshot carries.** The trust anchor is a single recent
finalized **checkpoint root** (`hash_tree_root` of the Beacon state, i.e. an SSZ Merkle
root) at a finalized epoch. The snapshot is the full Beacon state; its integrity is
self-certifying: the client computes `hash_tree_root(checkpoint_state)` and checks it
equals the checkpoint root it trusts [1].

**What the verifier checks.** (a) `hash_tree_root(downloaded_state) == trusted_root`;
(b) that the trusted root is genuinely on the canonical chain. (b) cannot be proven
cryptographically from genesis under PoS — hence *weak subjectivity*: "it is not safe to
sync from genesis without also having a recent piece of information about the network
(e.g. a finalized hash, block, or state)" [1]. The recommended mitigation is **NxN
bootstrapping**: query the checkpoint root from many *sources* via many *methods* (CLI
input from a friend, multiple checkpoint providers, bootnodes, general peers) and abort
if any threshold disagrees; prefer to "fail fast and loud" over silently self-patching,
because a WS *safety* failure (an off-canonical checkpoint) has unbounded impact on a
user who then makes financial decisions against a false state [1].

**Residual trust.** A recent, socially-agreed checkpoint root. Not eliminated — *reduced*
to "the checkpoint you started from is on the real chain," which is validated by social
consensus / cross-checking multiple providers [1][2]. ethereum.org: "The third party
providing the data is trusted and should be picked carefully" [2].

**Protocol change?** No consensus change. It is a *client-side* bootstrap policy plus an
out-of-band data channel (checkpoint-state endpoints). Execution-layer *snap sync* is
analogous: it starts from a recent 'trusted' checkpoint known to be on the true chain and
regenerates state, verifying block-by-block forward [2].

---

## 2. Cosmos / Tendermint (CometBFT) — state sync

**What it is.** A joining node downloads a recent application-state snapshot in **chunks**
from untrusted peers and applies it, instead of replaying all blocks from genesis; this
"leads to drastically shorter times for joining a network" [3].

**What is committed / what the snapshot carries.** The application periodically takes
deterministic, chunked snapshots; **each chunk is verifiable against the chain
`AppHash`** [4]. The on-chain commitment is the `AppHash` embedded in each block header
(for Gaia, a Merkle root over the set of named IAVL trees) [4]. Snapshots carry per-chunk
SHA-256 checksums in metadata; the whole restored state is checked against the trusted
`AppHash` [4].

**What the verifier checks.** The node is configured with a `trust_height` +
`trust_hash` that the operator obtains from a public RPC or block explorer *they trust*,
with a `trust_period` that "should be significantly smaller than the unbonding period"
[3] — i.e. Tendermint's own weak-subjectivity window. It then: (1) uses the **light
client** to verify the trusted header and obtain a light-client-verified `AppHash` for
the snapshot height; (2) picks a snapshot whose height the light client considers
trustworthy (greater than trusted header, within unbonding period), preferring one served
by the largest number of peers; (3) downloads chunks in parallel from multiple peers;
(4) after all chunks are applied, **compares the resulting app hash to the
light-client-verified chain app hash and discards/restarts on mismatch** [4]. Untrusted
peers cannot forge state: a wrong chunk-set fails the final `AppHash` comparison. Bad
snapshot servers are simply disconnected, not slashed ("these are full nodes not
validators, so we can't punish them") [4].

**Residual trust.** The `trust_hash`/`trust_height` seed (weak subjectivity), obtained
from ≥2 RPC servers [3]. The design explicitly notes the open problem of a peer serving
fake `ListSnapshots` metadata to DoS a joiner, mitigated for now by "pick snapshots
available on a large number of peers" and a mooted future of "placing snapshot manifests
on the blockchain" [4]. The Cosmos SDK ships this as the reusable `snapshots` package [5].

**Protocol change?** The *verification* is client-side against the existing `AppHash`,
but **the application must implement snapshotting** (ABCI `ListSnapshots` / `OfferSnapshot`
/ `LoadSnapshotChunk` / `ApplySnapshotChunk`) and produce deterministic, chunked,
GC'd snapshots [4]. So: no consensus change, but a required node/application-side feature.

---

## 3. Bitcoin — `assumeutxo`

**What it is.** A node loads a serialized **UTXO-set snapshot** (via the `loadtxoutset`
RPC) at a recent "base block," immediately treats the chain up to that base as
*assumed-valid*, syncs to tip from there, and **validates the assumed region in the
background in parallel** [6].

**What is committed / what the snapshot carries.** The snapshot is the full UTXO set at
the base block. Its trust anchor is a **hardcoded hash of the expected UTXO set**, shipped
in the software (`CMainParams::m_assumeutxo_data`) [6]. The snapshot itself carries no
proof; correctness is defined by matching the compiled-in commitment.

**What the verifier checks.** Two-phase: (1) *at load*, the snapshot is populated and
validated into a separate chainstate; the active (background) chainstate keeps doing full
initial-block-download validation of the assumed region. (2) When the **background
chainstate reaches the snapshot's base block, the node hashes the independently-derived
UTXO set and requires it to match the compiled-in `m_assumeutxo_data` value** [6]. Until
that background validation completes, the snapshot chainstate is only *assumed* valid;
afterward it is "indistinguishable from a chainstate built from the traditional IBD
process" [6].

**Residual trust.** During the assumed window, trust is in the **hardcoded commitment in
the Bitcoin Core release** (i.e. in the developers + your ability to review the value) —
*not* in the snapshot server, since a wrong snapshot fails the base-block hash check. The
trust is also *temporary*: full background validation eventually removes it entirely [6].

**Protocol change?** None. UTXO snapshots are "an implementation detail that lives behind
the `ChainstateManager` interface"; there is no consensus commitment to the UTXO set, so
the anchor is a software constant rather than an on-chain root [6]. Purely client-side.

---

## 4. Mina — recursive-SNARK succinct blockchain

**What it is.** Mina "replaces the entire blockchain, starting from genesis to any block,
with an easily verifiable constant-sized cryptographic proof" using recursive zk-SNARKs
[7]. Verifying the proof in the latest block amounts to verifying every transaction up to
a few blocks behind the tip [7].

**What is committed / what the snapshot carries.** Each gossiped block contains a
**protocol state** (hashes of the ledger etc.) and a **recursive SNARK** proving the whole
history up to that state. A wallet-relevant "snapshot" is tiny and *fully self-verifying*:
protocol state (822 B) + a recursive proof (~7 KB) + verification key (~2 KB), plus, for a
specific account, the **account record (181 B) and a Merkle path to it (741 B)** — ~11 KB
total, giving "equivalent security to full nodes," explicitly **not** a trusting light
client [7].

**What the verifier checks.** (1) Verify the blockchain SNARK against the verification key
→ the protocol state (hence the ledger Merkle root) is valid with no trust in the sender;
(2) verify the account's Merkle path resolves to that ledger root — "The resulting merkle
root should match the ledger state that was verified by the blockchain snark" [7]. A node
holds only *one* protocol state and can independently decide a new block is better without
trusting the source [7].

**Residual trust.** Essentially none beyond the SNARK's cryptographic soundness and the
genesis/verification-key setup. This is the strongest trust-minimization of any pattern
here. Caveat: the SNARK proves the *snarked ledger*, a few blocks behind the latest
staged ledger [7].

**Protocol change?** Fundamental. The succinctness is a **consensus/protocol property** —
the chain is *built* to emit a recursive proof of its own validity. You cannot bolt it
onto a chain that does not already produce such proofs.

---

## 5. Zcash — shielded-wallet checkpointing & "wallet birthday"

This is the closest structural analog to Midnight: a ZK-shielded, note-commitment-tree
wallet syncing from an untrusted server (`lightwalletd`).

**What it is.** A light wallet (ZIP-307 protocol) does not replay the whole chain. It
maintains a **local copy of the Sapling note-commitment tree** by sequentially appending
each output commitment (`cmu`) from the compact blocks it receives, and builds/updates
**incremental witnesses** (Merkle paths) for its own notes [8].

**What is committed / what the snapshot carries — the key point.** Every Zcash block
header commits **`finalSaplingRoot`**, defined as "the root of the Sapling note commitment
tree after appending every `cmu` in the block, in-order" [8]. This is the **on-chain
commitment the wallet checks its locally-built tree against**: block-header validation
requires that the wallet's recomputed tree root equals the header's `finalSaplingRoot`
[8]. So a wallet's note-commitment tree is *verifiable against an on-chain Merkle root at
every height* — exactly the anchor a snapshot needs.

**Checkpointing / birthday.** To avoid rebuilding the tree from Sapling activation, the
wallet on first start "queries the commitment tree state for block `X`" — a **tree-state
checkpoint** (a frontier of the note-commitment tree at height `X`) — and starts building
witnesses forward from there; keys it created cannot have any relevant transaction before
`X` [8]. This height is the wallet's **birthday**: "The wallet only downloads blocks
starting with the last checkpoint before its birthday" [9]. Importantly, for an
*imported/pre-existing* seed the birthday assumption is invalid, so the wallet must fall
back to scanning from **Sapling activation** [8]. Incremental Merkle trees can't be
rewound, so wallets cache the tree + per-note witnesses for ~100 recent heights to survive
reorgs [8].

**Residual trust.** Today, `lightwalletd` is documented as a **trusted root of trust**:
under the "Typical Adversary," "Lightwalletd only ever provides valid information coming
from a consistent Zcash blockchain state" [9]. A *compromised* lightwalletd can lie about
balances by omitting/replaying transactions; Zcash's stated fix is "implementing the block
header and note commitment tree validation specified in ZIP 307" — i.e. having the wallet
verify `finalSaplingRoot` itself rather than trust the server [9]. Note the limit: the
`finalSaplingRoot`/witness machinery proves **inclusion** (a note exists, a witness is
valid) but not **completeness/non-omission** — a server can still hide notes destined to
the user, so the wallet under-counts its balance [9]. Compact blocks authenticate
`CompactOutputs` (hence commitments) via header validation, but omission is a separate
liveness concern [8][9].

**Protocol change?** The **anchor already exists on-chain** (`finalSaplingRoot` is a
consensus field). Making the wallet *use* it is a **client-side (SDK) change** — no
consensus change. That is precisely the upgrade ZIP-307 describes and that the threat
model says is "only partially implemented: currently only `prevHash` is checked" [8].

---

## 6. Light-client state proofs / authenticated snapshots (general)

**What it is.** The general mechanism underneath (2), (4), and (5): serve a **Merkle
inclusion proof** of a specific value against an **on-chain state root**, so any value can
be verified offline against a single trusted block header, from an untrusted source.

**Canonical instance — Ethereum `eth_getProof` (EIP-1186).** Returns an account's
balance/nonce/codeHash/storageHash plus an `accountProof` (RLP Merkle-Patricia nodes from
the `stateRoot` down) and per-slot `storageProof` [10]. "Combined with a `stateRoot` (from
the blockheader) it enables offline verification of any account or storage-value. This
allows especially IOT-Devices or even mobile apps which are not able to run a light client
to verify responses from an **untrusted source only given a trusted blockhash**" [10]. The
verifier walks the proof to the `stateRoot` and checks it matches the trusted header.

**Same idea in Cosmos.** For per-chunk verification, an IAVL snapshot chunk "must contain
enough information to reconstruct the Merkle proofs all the way up to the root of the
multistore" so it verifies against the `AppHash` [4]; ICS-23 vector commitments generalize
this across Cosmos.

**Residual trust.** Only the **trusted block header / state root** (obtained via a light
client or a weak-subjectivity checkpoint). The proof itself is trustless; the data source
can be fully untrusted. Completeness (that you were shown *all* relevant entries, not a
valid subset) is **not** covered by inclusion proofs — that needs range/absence proofs or
an independently-known set of keys.

**Protocol change?** Verification is client-side against an existing on-chain root. The
node/indexer must **serve the proofs** (`eth_getProof` is an added RPC; ICS-23 needs the
store to expose proofs). So: no consensus change, but a data-provider (indexer/node)
feature.

---

## 7. Comparison

| Pattern | On-chain commitment | Proof the snapshot carries | Verifier checks | Residual trust | Change needed |
|---|---|---|---|---|---|
| **Eth checkpoint / WS** [1][2] | Finalized state `hash_tree_root` | Full state (self-hashing) | `htr(state)==root` + root is canonical | Recent checkpoint root (weak subj.), N-source cross-check | Client-side + OOB channel |
| **Cosmos state sync** [3][4][5] | `AppHash` in header | Chunks + checksums; optional Merkle proofs to root | Applied state's app hash == light-client `AppHash` | `trust_hash` seed (weak subj.) | App/node must snapshot; verify client-side |
| **Bitcoin assumeutxo** [6] | *None* (software constant) | Nothing; matched to hardcoded hash | Background-derived UTXO hash == compiled `m_assumeutxo_data` | Hardcoded commitment in release (temporary) | Client-side only |
| **Mina** [7] | Recursive SNARK in each block | Constant-size SNARK + Merkle path | Verify SNARK; account path resolves to proven root | ~None (SNARK soundness) | **Consensus/protocol** |
| **Zcash ZIP-307 / birthday** [8][9] | `finalSaplingRoot` (per-block Merkle root) | Note-commitment tree frontier (checkpoint) + witnesses | Rebuilt tree root == `finalSaplingRoot`; witness → anchor | Server (today); anchor if node lies re: header | **Client-side (SDK)** — anchor already on-chain |
| **State proofs (EIP-1186 / ICS-23)** [10][4] | State root in header | Merkle inclusion proof to root | Proof resolves to trusted state root | Trusted header; *no* completeness guarantee | Indexer/node serves proofs; verify client-side |

---

## 8. Synthesis — what fits Midnight + UmbraDB

Midnight's wallet is, structurally, a **Zcash-family shielded wallet**: its heavy state is
a note-commitment (coin-commitment) Merkle tree plus nullifier tracking, folded from an
indexer stream. So the Zcash/ZIP-307 answer maps almost one-to-one, and the general
state-proof pattern (§6) supplies the mechanism. The key realization is that all the
strong patterns converge on one move: **bind each UmbraDB checkpoint to the on-chain
Merkle commitment of the wallet-relevant state at the checkpoint's watermark height, and
re-derive-and-compare locally on restore.** That converts UmbraDB — local or remote,
trusted or not — from a *trusted store* into an *untrusted cache*, because a wrong snapshot
fails the anchor check.

### Recommended design (ranked)

**① Anchor-bound checkpoints (adopt first).** Combine Zcash's `finalSaplingRoot` check
[8] with Cosmos's "verify snapshot against a light-client-obtained root" [4]. Store,
alongside each `CheckpointStore` snapshot, the `(height, blockHash, note-commitment-tree
root)` triple. On restore: recompute the Merkle root of the restored note-commitment tree
(the wallet already maintains this frontier) and require it to equal the **on-chain
commitment for that height**, which the wallet fetches independently from the node/indexer
header (or a light-client-verified header). Wrong DB ⇒ root mismatch ⇒ discard and replay.
- *Trust minimization:* high — removes trust in UmbraDB entirely; residual trust is only
  "the correct on-chain root for height H," handled by ③.
- *Cost:* low — it is a recompute-and-compare plus one extra column per checkpoint.
- *Scope:* **SDK-only**, *iff* Midnight's node/indexer already exposes the per-height
  commitment-tree root (it is a consensus field in Zcash-family designs [8]). If the
  indexer does not surface it, that is a small read-only indexer addition, not a consensus
  change.

**② Merkle state proofs for partial / remote snapshots (adopt as enhancement).** When the
wallet wants to trust *individual* notes or a *partial* snapshot from a remote UmbraDB
without recomputing the whole tree, have the indexer serve **inclusion proofs** of
note-commitments (and nullifier-set membership) against the on-chain root, EIP-1186/ICS-23
style [10][4]. Verify the proof to the trusted root. This is the granular version of ①.
- *Trust minimization:* high (trustless per-item).
- *Cost:* medium. *Scope:* **needs an indexer/node change** to emit proofs. Note both ①
  and ② prove **inclusion, not completeness** — a remote source can still *omit* notes
  (Zcash's documented residual weakness [9]); mitigate by cross-checking the tree *size*/
  frontier position against the on-chain tree at height H, and/or by ③.

**③ Weak-subjectivity / assumeutxo anchor for the root-of-trust itself (adopt alongside
①).** ① reduces trust to "the correct on-chain root for height H." Close that the
Ethereum/Cosmos way — obtain the trusted `(height, root)` from ≥2 independent sources and
abort on disagreement [1][3] — and/or ship a **hardcoded, reviewed checkpoint** for a known
height à la Bitcoin's `m_assumeutxo_data` [6] to serve as the wallet **birthday** anchor
(the natural home for a Midnight "wallet birthday"/genesis-checkpoint). Prefer fail-fast
over silent self-repair [1].
- *Trust minimization:* medium→high. *Cost:* low. *Scope:* **client-side** + a small
  config/ship channel.

**④ Recursive-SNARK succinct state (do not pursue now).** Mina's constant-size,
near-zero-trust proof [7] is the theoretical ideal, but it is a **consensus/protocol
property** Midnight does not emit today. Track as long-term only.

### Bottom line

Adopt **① + ③ immediately** (SDK-side anchor-binding of checkpoints to the on-chain
note-commitment-tree root, with a weak-subjectivity/hardcoded birthday anchor), and add
**②** when remote/untrusted UmbraDB or partial-snapshot trust is needed and the indexer
can serve inclusion proofs. This gives trustless restore against on-chain commitments with
no full rescan and no consensus change — the residual, shared with Zcash, being note
*omission* (completeness), which is bounded by also checking the on-chain tree size/frontier
at the checkpoint height.

---

## Sources

1. Ethereum Foundation (D. Ryan), "WS sync in practice" — weak-subjectivity sync, NxN bootstrapping, safety-vs-liveness. https://notes.ethereum.org/@djrtwo/ws-sync-in-practice
2. ethereum.org, "Nodes and clients" — checkpoint sync / snap sync / light-client trust. https://ethereum.org/en/developers/docs/nodes-and-clients/
3. Tendermint/CometBFT docs, "State Sync" — `trust_height`/`trust_hash`, light-client verification, `trust_period` < unbonding. https://github.com/tendermint/tendermint/blob/v0.34.x/docs/tendermint-core/state-sync.md
4. Tendermint, "ADR-053: State Sync Prototype" — chunks verified against chain `AppHash`, light-client-verified app hash, ABCI snapshot interface, per-chunk Merkle proofs to multistore root, fake-snapshot open question. https://github.com/tendermint/tendermint/blob/master/docs/architecture/adr-053-state-sync-prototype.md
5. Cosmos SDK `snapshots` package (reusable state-sync snapshotting). https://pkg.go.dev/github.com/cosmos/cosmos-sdk/snapshots
6. Bitcoin Core, "Assumeutxo Design" — `loadtxoutset`, background validation, base-block UTXO hash matched against compiled `m_assumeutxo_data`. https://github.com/bitcoin/bitcoin/blob/master/doc/design/assumeutxo.md
7. Mina Protocol, "22kB-Sized Blockchain — A Technical Reference" — recursive-SNARK constant-size proof, non-consensus node with full-node security, account + Merkle path to SNARK-proven ledger root. https://minaprotocol.com/blog/22kb-sized-blockchain-a-technical-reference
8. Zcash, "ZIP-307: Light Client Protocol for Payment Detection" — local note-commitment tree, `finalSaplingRoot` header check, commitment-tree-state checkpoint, Sapling-activation fallback for imported seeds, witness caching. https://zips.z.cash/zip-0307
9. Zcash docs, "Wallet App Threat Model" — lightwalletd as trusted root of trust, omission/replay weaknesses, wallet birthday download rule, planned ZIP-307 validation fix. https://zcash.readthedocs.io/en/latest/rtd_pages/wallet_threat_model.html
10. Ethereum, "EIP-1186: RPC-Method to get Merkle Proofs — `eth_getProof`" — account/storage Merkle proofs against `stateRoot`, offline verification from an untrusted source given a trusted blockhash. https://eips.ethereum.org/EIPS/eip-1186
