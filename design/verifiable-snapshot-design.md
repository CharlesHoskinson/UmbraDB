# Verifiable Wallet-State Snapshot — Design (roll-up)

**Branch:** `feature/verifiable-snapshot` · **Date:** 2026-07-21 · **Status:** Design draft for the design council's correctness-gate review.
**Author role:** Design Lead, synthesizing research briefs 01–11 (`design/research/2026-07-21-snapshot-root-of-trust/`).

This document is **decisive** — it recommends one v1 design and states what is deferred — but it flags, in §12, the genuinely open decisions the council must ratify before any implementation begins. Every load-bearing choice is grounded in a brief (cited `[NN]`) and, where the mechanism lives in Midnight, a `repo/path:line`.

### Related research (2026-07-22)

See `design/mithril-committee-certification-research.md` (branch `research/mithril-committee-certification`) for a research note investigating whether a Mithril-style (Cardano) stake-weighted threshold-signature committee-certification scheme is adoptable for Midnight, using Midnight's own federated consensus committee as signers. **Verdict: not before Midnight persists per-epoch committee-member stake weights (a real protocol-side prerequisite that does not exist today) — flagged as a future direction, not a v1 change.** Two points from that note are directly relevant here and worth checking against this document's §8 `attest` circuit sketch and §12 Q4 (contract governance / vk versioning): (1) this design's L3 self-attestation answers a different question than committee certification could ever answer — a wallet attesting its own private state under its own key is not something a third-party committee can stand in for, since no committee can attest a private balance it cannot see; (2) the *parameter-binding lesson* distilled from the real Mithril CVE (GHSA-724h-fpm5-4qvr) — "everything that affects how a verifier will interpret a **future** signature must be inside what was signed at the previous step, not travel alongside it" — should be checked against any future revision of this design's open vk-versioning/contract-governance decision (§12 Q4); the research note's §6.1 spells out the concrete gap.

---

## 1. Problem and core principle

UmbraDB persists a Midnight wallet's replay-derived sync state; the Midnight SDK ships only in-memory storage (brief 01 §5: every serialized snapshot today is `{local-state hex, protocolVersion, networkId, offset}` with the cursor itself `Schema.optional` — no block hash, no root, no anchor). On memory loss the wallet must restore from UmbraDB — **LOCAL or REMOTE/UNTRUSTED** — and verify the snapshot is correct **without replaying the chain**.

**The owner-set principle (the whole design pivots on it):** we do not prove "S is correct as of the tip." We prove **"snapshot S is the complete, correct wallet state as of a FINALIZED checkpoint block N."** Because the chain is append-only and GRANDPA finality precludes reverting blocks ≤ N, that certificate is **permanently valid for horizon N** — it never expires (brief 07 §0; contrast the ledger's rolling 1-hour `global_ttl` spend-anchor window, which is a *spendability* window, not a *verifiability* one — brief 01 §2, `zswap/src/ledger.rs:73-79`). On restore the wallet verifies the certificate, then catches up `[N, tip]` **LIVE** via the normal ADS-authenticated incremental sync. Each proven finalized checkpoint is a **cryptographically-certified "birthday floor"** the wallet never rescans below again — strictly stronger than Zcash's *trusted* birthday (brief 02 §5, brief 07 §0).

The reduction that governs every layer (brief 03 §0's theorem): **the DB is never a source of correctness — only of availability.** Every no-replay check must reduce S to a check against an **on-chain commitment the wallet independently trusts**, whose trust in turn reduces to **consensus/finality**. Content-addressing and AES-GCM prove "the bytes I read are the bytes written"; they never prove "the bytes are the correct chain-derived state" (brief 03 §0). That gap is what this design closes.

---

## 2. The layered architecture, made concrete

Four layers, each with a precise job, a precise mechanism, and a precise residual it hands to the next.

```
                     ┌─────────────────────────────────────────────────────────────┐
   L3 Self-cert      │  On-chain Compact "Attested Manifest Root" (05)  ── v1        │
   (freshness +      │  Offline v-lightweight ZK certificate (07)       ── v1.1 opt  │
    permanence)      │  Recursive IVC checkpoint ratchet (08)           ── research  │
                     └─────────────────────────────────────────────────────────────┘
                     ┌─────────────────────────────────────────────────────────────┐
   L2 Remote/        │  Client-side AES-256-GCM (seed-derived)                       │
   untrusted-DB      │  Anti-rollback: local monotonic seq + chain-as-freshness     │
   hardening         │  Multi-device: signed hash-chained CRDT deltas (BFT-CRDT)     │
                     └─────────────────────────────────────────────────────────────┘
                     ┌─────────────────────────────────────────────────────────────┐
   L1 Bounded-scan   │  Shielded/dust: collapsed-tree range proof vs on-chain root  │
   completeness      │    (ADS already present — 06 §2.1)                            │
   (ADS)             │  Unshielded: NEW authenticated by-address MB-tree index       │
                     └─────────────────────────────────────────────────────────────┘
                     ┌─────────────────────────────────────────────────────────────┐
   L0 Anchor         │  {finalized N, blockHash, tree endIndex/frontier, R_N}       │
                     │  finality verified via GRANDPA justification + state-read     │
                     └─────────────────────────────────────────────────────────────┘
```

### L0 — The anchor

**What is persisted, alongside each wallet-kind's serialized local state:** the block-anchor tuple `{blockHeight N, blockHash, treeEndIndex, R_N}` for the relevant tree(s) at serialization time — `zswapMerkleTreeRoot` + `zswapEndIndex` for the shielded wallet; both dust roots + end-indices for the dust wallet; the by-address UTXO-set root for the unshielded wallet (brief 01 §6 "strongest anchor candidate", brief 03 §7).

**Why every tree already has a usable root (no node change).** Midnight's `Sp<T,D>` content-addressing (`storage-core/src/arena.rs:1505-1519`) makes the zswap tree, both dust trees, and the whole `LedgerState` DAG deterministically hashable (brief 01 §1). The zswap/dust roots are exposed per-block by the indexer's `Block` type — `zswapMerkleTreeRoot`/`zswapEndIndex` (stable), `dustCommitmentMerkleTreeRoot`/`dustGenerationMerkleTreeRoot` (`@beta`) (`schema-v4.graphql:64-88`). **The load-bearing fact:** collapsing "leaves the hash invariant" (`transient-crypto/src/merkle_tree.rs:921`), so a restored snapshot's `merkle_tree.rehash().root()` — computed **entirely offline from the snapshot alone** — is bit-identical to the full on-chain root at the same `endIndex` (brief 01 §6.2). And the indexer recomputes zswap/full-ledger roots itself and `bail!`s on any mismatch vs the node on every block (brief 04 §3, `chain-indexer/src/application.rs:~404-420`) — so trusting `zswapMerkleTreeRoot` is trusting a value two independent re-executions already agree on. (Dust roots are computed and served but **not** node-cross-checked — no node dust-root RPC exists — so dust anchors ship on softer ground; brief 04 §3, brief 06 §2.5.)

**Restore-time L0 check** (zero network, then one query): (1) recompute the local root offline, compare to persisted `R_N` — catches corruption/tamper/bit-rot instantly; (2) query `block(offset:{height:N})` and compare its committed root/endIndex to the persisted anchor — proves S is exactly correct as of N with **zero transactions replayed** (brief 01 §6). The finality of N and the authenticity of R_N are discharged by L0's finality sub-layer (§4).

### L1 — Bounded-scan completeness (the ADS)

L0 proves the base at N. L1 makes the live tail `[N, tip]` **verifiably exhaustive**, not merely "hopefully complete," closing the *commitment*-omission freedom the anchor alone leaves (brief 06 §0, §2.1).

- **Shielded / dust — the ADS is already present and already exposed.** The zswap tree is fixed-height-32, append-only over contiguous indices; `MerkleTreeCollapsedUpdate` (`transient-crypto/src/merkle_tree.rs:302-405`) authenticates any leaf range in O(log range) ≤ 32 hashes, served by `zswapMerkleTreeCollapsedUpdate(startIndex,endIndex)` (`schema-v4.graphql:1258`, stable). By the RFC 6962 "fix size + root ⇒ leaf multiset determined" argument, a wallet that applies the bridge for `[endIndex_N, endIndex_tip)` and rehashes to a root equal to the on-chain tip root has a **commitment-completeness proof**: the indexer could not have omitted, inserted, or reordered any commitment (brief 06 §2.1). Penumbra ships exactly this shape in production (chain-provided inline span-hashes + Anchor = global tree root; brief 09 §1.3, ②). **This is SDK-only wiring** — `applyCollapsedUpdate` already exists in the ledger crate but is **never called** by the wallet today (brief 04 §2, `shielded-wallet/src/v1/CoreWallet.ts:148-151`).
- **Unshielded — a genuinely new authenticated by-address index is required.** Unshielded state is `UtxoState{utxos: HashMap<Utxo,UtxoMeta>}` (`ledger/src/structure.rs:2948-2968`), keyed by `ArenaHash(whole-Utxo)` — no address locality, no exposed proof API, and no point-in-time "UTXO set by address" query exists (brief 06 §4.1; the `unshieldedUtxos` query is *proposed*, not extant). Build a **Merkle-B-tree / authenticated-dictionary** keyed by owner address as an indexer-maintained materialized view; a query returns A's UTXO list + Merkle path to `R_utxo(N)`, and for an absent address the **two boundary leaves** `A⁻ < A < A⁺` proving no leaf hides between them (Naor–Nissim / MB-tree non-membership; brief 06 §4.2–4.3). The subtree-size annotation gives verifiable counts — and Midnight's own MPT already carries a `SizeAnn` size monoid (`storage/src/merkle_patricia_trie.rs:499-515`), merely unexposed.

### L2 — Remote/untrusted-DB hardening

Three properties the local single-writer case never needed (brief 03 §4, brief 11 §5):

- **Confidentiality.** Client-side **AES-256-GCM** under a key deterministically derived from the wallet seed (Zcash ZIP-32 shape; brief 03 §5). UmbraDB already implements this (per-`(accountId, scope)` salt via `getOrCreateSalt`). The DB sees only ciphertext + opaque content hashes; the commitment the DB sees is over *ciphertext* (pure blob integrity), the commitment the wallet checks against the chain is over *plaintext*, computed locally after decrypt and **never sent to the DB** (brief 03 §5). Layers compose without leaking.
- **Anti-rollback / freshness.** The GCM tag carries **no** freshness — a remote DB can serve a *previously authentic* old snapshot and it decrypts perfectly (the ROTE replay attack; brief 03 §4). Two complementary defenses: (i) a strictly-increasing `seq` + `anchorHeight`, signed by the writer, with the highest-ever-accepted value held in a small trusted local store — protects a *running* wallet; (ii) **the chain as the freshness oracle** — require `anchorHeight ≥` last-known-finalized and `anchorBlockHash` on the canonical header chain (brief 03 §4). **Crucial gap for our exact scenario:** on total memory loss the wallet has *no* local counter, so (i) and (ii) cannot detect a rollback served to a cold-booted wallet. That gap is precisely what L3's on-chain attestation closes (§3), which is why L3 is load-bearing, not decorative, for the remote case.
- **Multi-device (the NECESSARY complement, brief 11 §5).** A DB shared across N devices of one wallet is a *horizontal* trust relation none of briefs 01–06 covers. Adopt Kleppmann's **BFT-CRDT**: each device signs its wallet-state deltas and hash-chains each to its causal predecessor; the untrusted DB is demoted to a relay that can delay/drop (detectable, recoverable) but cannot forge, splice out-of-causal-order, or silently rewrite history without the hash chain visibly breaking (brief 11 §5.2, Kleppmann PaPoC 2022). Needs only *causal* delivery — no consensus. This is a **strict complement**: BFT-CRDT gives sibling-to-sibling tamper-evidence (horizontal); the anchor gives chain-relative correctness (vertical); neither subsumes the other (two siblings can BFT-agree on a chain-stale state — brief 11 §5.2).

### L3 — Self-certification

The layer that (a) gives a **cold-booted** wallet consensus-grade rollback protection, (b) transports attest-time correctness forward permanently, and (c) optionally proves S's correctness to a third party. This is the design's biggest decision — §3.

---

## 3. The L3 decision (recommendation + what's deferred)

Three candidates, honestly compared:

| | (c) Compact Attested Manifest Root [05] | (a) Offline v-lightweight ZK cert [07] | (b) Recursive IVC ratchet [08] |
|---|---|---|---|
| Buildable today? | **Yes** — sub-zswap circuit, all constructs in current stdlib (05 §4.6) | **Yes** — hand-written zkir on the running proof-server, path (a) (07 §4) | **No** — needs a new native-Rust prover; `:6300` has no recursion opcode (08 §3.6) |
| Anti-rollback for a **cold-booted** wallet | **Yes** — consensus-CAS pointer, no local state needed (05 §4.3) | **No** — a certificate cannot say "this is the *latest* S" (07 §6 residual 2) | Yes, but only via the same on-chain anchoring |
| Freshness across independent restores / multi-device | **Yes** (05 §4.1) | No | No |
| Zero on-chain footprint / max privacy | No (one tx/cadence, DUST fee) | **Yes** — no tx, nothing observable (07 §2.2) | Yes (client-to-client) |
| Third-party provability of S's content | history-proof only (05 §4.4) | **Yes** — selective disclosure (07 §5) | Yes |
| Proof size vs history | O(1) pointer | ∝ owned notes (small, k≈20) | **O(1)** for arbitrarily long certified history |
| New trust surface | contract governance (05 Q4) | **audited hand-written IR + pinned vk, no compiler attestation** (07 §6.3) | same + a research prover to audit |
| Cost / effort | small circuit, deploy once | engineering: author+audit one IR | **research-grade heavy lift** (08 §5) |

**Recommendation — v1 ships (c), the Compact "Attested Manifest Root" (brief 05, variant V1b+V2).** The decisive argument: the feature's *raison d'être* is restore from a **REMOTE/UNTRUSTED** DB after **memory loss**, and in that exact scenario the wallet has no local monotonic counter, so the only thing that can tell a cold-booted wallet "the DB just served you an old-but-genuine snapshot" is a monotonic pointer held **outside the DB's control, on the one authority the wallet already trusts unconditionally** — the chain. Midnight's transcript/CAS execution model makes this rollback protection *structural and free*: a replayed old `attest` tx re-runs its transcript against current state, the recorded height-monotonicity `assert` no longer holds, and the tx fails (brief 05 §4.3, C7). One small shared contract (bigger anonymity set) kills the entire DB-adversary threat class A1–A4 (substitution, rollback, cross-wallet swap, forgery), leaving only A5 (stale restore-time view), which is a standard light-client freshness question handled by §4 + multi-endpoint query.

Ship **variant V1b+V2**: latest-pointer semantics (the anti-rollback CAS) **plus** an on-chain `history` Merkle tree (turns *intentional* point-in-time restore into a verifiable first-class op, pairs with UmbraDB's TemporalKV) **plus** a Merkle-committed structured snapshot root over domain-separated sections (cursor/notes/nullifiers/history/dust/manifest), enabling partial verification and later selective disclosure (brief 05 §4.4, §5.1). Carry `prevCommitment` in `AttestRecord` **from day one** (costs 32 bytes; keeps the §6.2 hash-chain-of-custody and the IVC upgrade open — brief 05 §6.2, brief 08 §8). Commit a *hiding* `persistentCommit(snapshotRoot, salt)` with salt re-derived from `(sk_attest, seq)` so a hosted DB cannot even *identify* whose snapshot it holds (brief 05 §7). Derive `sk_attest` at a dedicated HD path, purpose-separated from spend/viewing keys (brief 05 §4.5).

For a **purely-local, single-writer, trusted** UmbraDB the attestation is optional — UmbraDB's own `Formal/STORAGE_ALGEBRA.md` §6 already concluded content-addressing + AES-GCM suffice there and "no ADS/Merkle layer is warranted" (brief 03 §7). L3 becomes mandatory the moment the DB is remote or the checkpoint is exported.

**Recommended v1.1 companion — (a) the offline v-lightweight ZK certificate [07].** Also buildable today (hand-written `IrSource`, proven by the running proof-server via `/prove` with caller-supplied `ProvingKeyMaterial`, verified off-chain by the standalone `VerifierKey::verify` — brief 07 §1.5, §4). It **composes** with (c): (c) answers "is this the latest S I committed?"; (a) answers "is S actually my correct, on-chain-anchored state at finalized N?" privately, with zero footprint, and provably to a third party (brief 07 §5). It is **not** a v1 blocker because it does not close the rollback gap and it introduces a genuinely new trust surface — a hand-authored IR with **no Compact-compiler correctness attestation**, whose `vk` must be independently audited and pinned in trusted config (brief 07 §6.3). Ship it once that audit discipline is in place.

**Deferred / research-grade — (b) the recursive IVC ratchet [08].** Midnight's own `midnight-zk` ships the machinery (`aggregation/src/ivc/`, single-curve BLS12-381 atomic accumulation, O(1) proof+verify regardless of #checkpoints; the trees' internal digests are already Poseidon so the completeness fold is cheap in-circuit — brief 08 §2, §3.4). But it needs a **new native-Rust prover** (not `:6300`) + a WASM/TS bridge (heavy sidecar prover + light verifier), and its per-step constant is a full in-circuit KZG self-verifier (K≥17, seconds/step — brief 08 §2.2, §5). **It earns its heavy lift only for the v-strong completeness case** (a proof ∝ prefix-leaves that recursion folds into O(1)+delta); for the v-lightweight cert, a fresh standalone proof each checkpoint is simpler and recursion buys little (brief 08 §5). Keep the door open by carrying `prevCommitment`/frontier/`R_N` in the record and `AssignedState` shapes; do not build for v1.

---

## 4. Finality trust (brief 10)

L0's anchor check proves *agreement* between the wallet's recomputation and whatever answered the query — it does **not** prove that answerer is honest, nor that N is genuinely finalized (brief 01 §6 gap 1). Brief 10 closes this as far as it can be closed.

**Recommendation: Tier-1 — a bounded, one-shot GRANDPA justification check + state-read-proof per restore.** A wallet holding a trusted `(set_id, authorities)` (bootstrapped once from the genesis GRANDPA authority set in the public chain spec, or any set it once verified — the same weak-subjectivity seed every BFT/PoS light client has) fetches `grandpa_proveFinality(N)` from **any** (now untrusted) endpoint, verifies the Ed25519 threshold-signature justification locally via `GrandpaJustification::verify_with_voter_set` (`polkadot-sdk .../grandpa/src/justification.rs:166-233`), walking authority-set handoffs forward with warp-sync fragments if needed (brief 10 §1–2). Then `state_getReadProof([twox128("Midnight")+twox128("StateKey")], N.hash)` + `sp_state_machine::read_proof_check(N.state_root, proof, key)` reads `pallet_midnight::StateKey` — hence R_N — out of N's trie, checked against the header's *own* `state_root`, never against the responder's word (brief 10 §3; `pallets/midnight/src/lib.rs:341-347`). Both RPCs are **live on Midnight nodes today** (`node/src/openrpc.rs:91,96-98,481,485-487`); this is wallet-SDK plumbing, not a node change. It is a bounded on-demand check (one historical N, not a streaming daemon), which is exactly the restore shape.

- **Tier-0 (ship-now fallback, before the justification verifier is built):** k-of-n RPC/indexer cross-check — query ≥2–3 independently operated endpoints for `(N, blockHash, R_N)` and require exact agreement (brief 10 §5, brief 02 §1 NxN). Closes "one indexer lies alone"; does **not** close coordinated-operator or single-vendor-hosts-everything.
- **Tier-2 (only if continuous trustless sync becomes a product requirement):** embed `smoldot` via `subxt-lightclient` (already latent in the dep graph — brief 10 §2). Not needed for one-shot restore.

**In-circuit finality — DEFER.** Folding GRANDPA into the IVC step is *expressible* (the `curve25519`/`sha2_512`/`blake2b` chips exist in `midnight-zk`'s `ZkStdLibArch`) but **SNARK-hostile**: Ed25519 emulation + SHA-512 per precommit × up to ⅔ of `MaxAuthorities=10_000`, plus Blake2-256 trie hashing — a single justification can dwarf the whole zswap circuit and blow past the k=25 ceiling (brief 08 §6). The wallet must obtain trusted R_N off-circuit *anyway* (it is the IVC's public-input anchor), so moving a cheap off-circuit Ed25519-batch-verify into an extremely expensive in-circuit one is a bad trade for the wallet's own restore. Keep three concerns in three layers: **recursion** transports "each step folded against the root the verifier supplied"; **Tier-1 off-circuit** supplies "that root is genuinely finalized R_N"; **the ADS** supplies "the folded delta was complete" (brief 08 §6). Design `AssignedState` to carry R_N + the finalized block hash so in-circuit finality *could* be added later as a self-contained-PCD upgrade for a third-party auditor who won't run its own finality check (the Mina model) — but ship with finality off-circuit.

---

## 5. The completeness SOUNDNESS gap (briefs 06/07/09)

The ADS (L1) closes *commitment*-completeness. Two residuals survive, both narrower than generic omission, both reducible to the same missing primitive — an authenticated binding from an on-chain consensus commitment to **off-tree** data:

1. **Ciphertext-downgrade under-count (brief 06 §2.4).** Each on-chain output's note ciphertext lives in the *transaction body* (`zswap/src/structure.rs:307`, `Output.ciphertext: Option<…>`), **not** in the commitment tree — committed only by the block's Substrate `extrinsicsRoot`, which the indexer does not surface. The root check proves every *commitment* is present; a malicious indexer that downgrades a leaf's evidence to `None` makes a genuinely-yours note invisible. The ZK completeness proof inherits this exactly: its "not-mine" branch is only sound if it decrypts the *authentic* ciphertext, which nothing on-tree guarantees (brief 07 §3.1). **This is a soundness wall no proving power fixes — orthogonal to recursion** (brief 08 §7).
2. **Spend-hiding (brief 06 §3).** Nullifiers are plain hash sets with no exposed proof/non-membership API (`merkle_patricia_trie.rs` has `insert/lookup/remove` but no `prove`/`verify`). But **only the wallet can spend its own notes** (the nullifier needs the coin secret key), so a hidden spend is an **over-count**, self-correcting at spend time (the network rejects the duplicate nullifier) — it bites for real only in the multi-device case where device B spent and device A restores a pre-spend checkpoint (brief 06 §3).

**Recommended phasing:**

- **v1 — ship with the Zcash-parity residual, explicitly documented.** This matches every production shielded chain: they all *verify the tree* and *trust the server for delivery* (brief 09 §8 — Zcash, Penumbra, Aztec, Namada). Mitigate with (a) NxN cross-indexer checks — two honest indexers disagree on the evidence for a given `mt_index` (brief 06 §2.4 option 1); (b) the event-stream contiguity check — `ZswapOutput` carries `mt_index`, so the wallet confirms the delivered events cover a contiguous run with no gaps, a second cheap completeness signal that must agree with the tree size (brief 06 §2.4); (c) Penumbra-style **first-post-restore-spend re-validation** — the chain rejects a spend whose witness path doesn't reach a real historical root, so the first spend re-validates tail completeness for free (brief 09 ②).
- **Near-term overlay — Aztec-style "constrained delivery" via a Compact-emitted detection tag (brief 09 ③).** Require every shielded output to also emit a recipient-bound tag (folds into the same L3 attestation contract, same `persistentHash`/`poseidon2` primitive), turning an omitted ciphertext into a detectable event. **Honest limit:** an *overlay* tag is not consensus-emitted, so a malicious indexer can still omit the *tag* — it raises the bar but does not fully close the gap (brief 09 §10).
- **Long-term — the only true close is a node/protocol change.** A Substrate **body-inclusion proof** (indexer serves ciphertext + `state_getReadProof` path to `extrinsicsRoot`, wallet checks vs trusted header) or a per-block **header-committed ciphertext accumulator** (MMR of `(mt_index, H(evidence))`) for ciphertext-delivery; a **nullifier-set non-membership proof** (CONIKS-style absence path) or an **authenticated nullifier accumulator** for spend-completeness (brief 06 §2.4 option 2/3, §3). Flag both to the Midnight node team.

**Council decision:** ratify shipping v1 with the documented Zcash-parity residual (§12 D2). It is the honest, industry-standard position; over-claiming completeness would be the design's biggest integrity risk.

---

## 6. Privacy-from-scanner vs completeness (brief 09)

L2 encrypts the snapshot *at rest*, but the entity that **feeds** the wallet — the indexer, or a remote UmbraDB acting as a scan accelerator — still learns which notes are ours today, because selecting "our" data requires the viewing key (the Monero / Penumbra-view baseline every other system is trying to escape — brief 09 §1.1, §5). This is the single biggest gap the prior-art study exposes, and it is orthogonal to completeness.

**Recommendation: overlay-now, consensus-later.**

- **v1.x overlay (shippable today, no protocol change):** an Aztec-style **detection tag** — `poseidon2(detectionSecret, index)`, contract-emitted, indexed by the node/indexer — bound to a per-address detection secret and folded into the L3 attestation contract's key hygiene (brief 09 ①, Aztec `getPrivateLogsByTags`). The untrusted UmbraDB/indexer then serves "logs matching these tags," never learning ownership beyond the tag set. This converts the remote-DB threat model from "trusted for privacy" to "learns only an opaque superset" — the property the task asked for.
- **Long-term (Midnight protocol change we don't control):** a **consensus-emitted clue key** in the address format, Penumbra-FMD style (`ck_d` in the address, consensus rules on clue count + precision → *detection ambiguity* the server cannot disambiguate, **and** constrained delivery). This is the gold standard and it closes **both** privacy and the ciphertext-delivery completeness gap of §5 at once — because the same tag, if consensus-emitted, makes omission an on-chain violation (brief 09 ①-native, ③). Flag to the Midnight team alongside §5's body-proof/accumulator asks.
- **Watch, don't build — OMR as the ceiling.** Oblivious Message Retrieval (Liu–Tromer) is the only primitive giving privacy **and** completeness against a fully malicious server, post-quantum — but ~100 MB detection keys and per-message FHE make it impractical (Aztec's own verdict; brief 09 §7). Research track.

**The unavoidable tension (brief 09 §10), for the council:** an overlay tag buys privacy but a malicious indexer can *omit* the tag, re-opening the very completeness gap it was meant to close — and the anchor/ADS only detects omission of *committed* leaves, not of *off-tree* tags. So the honest overlay position is "privacy win now; completeness still bounded by NxN + first-spend-revalidation, fully closed only by the consensus clue key later." §12 D3.

---

## 7. Delivery — the two PRs and the persistence substrate

### 7.1 SDK PR — `midnight-wallet` (additive, no breaking change)

Three additions, all slotting into extension points brief 04 §1 identified:

**(a) Anchor field on the snapshot schema** (`shielded-wallet/src/v1/Serialization.ts:67`, symmetric for dust/unshielded). Purely additive Effect `Schema.Struct` — old snapshots still decode:

```ts
anchor: Schema.optional(Schema.Struct({
  zswapMerkleTreeRoot: Schema.String,   // from ledger.ZswapLocalState.merkleTreeRoot — exists, never read today
  zswapEndIndex: Schema.BigInt,         // the range LOWER boundary for the L1 tail proof
  blockHash: Schema.String,
  blockHeight: Schema.Number,
  finalizedHash: Schema.String,         // the finalized head the anchor is bound to (§4)
})),
```
`buildSnapshot` reads `w.state.merkleTreeRoot` (already on `ledger.ZswapLocalState`, `ledger-v8.d.ts:2996`; dust via `commitmentTreeRoot()`/`generatingTreeRoot()`, `:1596,1601`) plus the block anchor from the new indexer field (7.2). **Make the anchor+cursor combination mandatory and internally cross-checked at deserialize** — the existing `offset` is `Schema.optional` in all three schemas today, so even the cursor isn't guaranteed present (brief 01 §6 gap 4).

**(b) `restoreVerified()` — a sibling static factory to `restore()`** (`ShieldedWallet.ts:238`). Deserializes via the same path, then runs the L0+L1 checks *before* `startFirst`:

```ts
static async restoreVerified(serialized, conn: { indexerHttpUrl; grandpaEndpoints }): Promise<Wallet> {
  const deserialized = deserializeState(serialized);          // as restore() today
  const anchor = extractAnchor(serialized);
  if (anchor) {
    // L0: offline self-consistency — recompute local root, compare to anchor.zswapMerkleTreeRoot
    assertLocalRootMatches(deserialized, anchor);
    // L0: on-chain agreement — block(offset:{hash}) committed root == anchor
    const committed = await fetchBlockAnchor(conn.indexerHttpUrl, anchor.blockHash);
    if (committed.zswapMerkleTreeRoot !== anchor.zswapMerkleTreeRoot) throw new SnapshotAnchorMismatchError();
    // L0: finality — Tier-1 GRANDPA justification + state-read-proof (§4), or Tier-0 k-of-n
    await verifyFinality(conn.grandpaEndpoints, anchor.blockHeight, anchor.finalizedHash);
    // L1: bounded-scan completeness — collapsed-update [endIndex_N, tip] rehash == on-chain tip root
    await verifyTailComplete(conn.indexerHttpUrl, anchor.zswapEndIndex);   // wires up applyCollapsedUpdate
  }
  return startFirst(Wallet, deserialized);   // then .start(secretKeys) resumes LIVE [N,tip] exactly as today
}
```
This is a gate in front of the existing resume path — no change to `Sync.ts`'s `resumeFrom` (brief 04 §4b). It finally *calls* `applyCollapsedUpdate`, which the ledger crate exposes but the wallet never invokes (brief 04 §2, brief 06 §7).

**(c) `SnapshotStorage` interface** — mirror the reader/writer split of the existing `TransactionHistoryStorage` (`abstractions/src/TransactionHistoryStorage.ts:215-216`), which is a plain injected interface with **no in-memory assumption baked in**. Today the `serialize()`/`restore()` blob is a bare `string` the caller must persist itself — there is no pluggable snapshot-storage seam the way there is for tx-history (brief 04 §4c). Adding `SnapshotStorage` lets UmbraDB back *both* snapshot and tx-history through one facade constructor arg.

### 7.2 Indexer PR — `midnight-indexer` (additive, `@beta` where dust)

- **`TreeAnchor` on the ledger-event types** — the prerequisite reverse map. A restoring wallet has an event-cursor `appliedIndex`, not an endIndex/height; there is no field today mapping "event id → the committed root when I reached it" (brief 04 §2). Add `zswapAnchor: TreeAnchor!` on `ZswapLedgerEvent` (and `@beta` dust variants) via a `#[ComplexObject]` resolver following the existing FK chain `ledger_events → transactions → regular_transactions` — the anchor columns (`zswap_merkle_tree_root`, `zswap_start/end_index`, dust indices) **already exist**, so **zero new migration** (brief 04 §3, `indexer-common/migrations/postgres/001_initial.sql:47-59`):
  ```graphql
  type TreeAnchor { endIndex: Int!, root: HexEncoded!, block: Block! }
  ```
- **`unshieldedUtxos(address, offset): UnshieldedUtxoProof`** — the genuinely new authenticated surface (L1 unshielded). **Not** a bare `[UnshieldedUtxo!]!` (that carries no completeness proof) but `{ utxos, boundaryLo, boundaryHi, merklePaths, root, rootSignature }` (brief 06 §4.3, §7). Needs the new MB-tree materialized view (§4.2 of brief 06), a signer (Signed-Tree-Head), and ideally a monitor cross-checking `R_utxo` against the consensus utxo-subtree root. `R_utxo` anchoring options, honestly ranked (brief 06 §4.4): (1) whole-set root-match vs the `utxo`-subtree root in `midnight_ledgerStateRoot` — strongest, but needs the node to expose that root + an MPT serialization the wallet can rehash (doesn't exist today); (2) **signed STH + monitor cross-check + k≥2 indexers** — best cost/trust for first ship; (3) consensus change — cleanest, deferred.
- **CI:** weave both into `native_e2e.rs` (byte-identical reference stream vs a real `midnight-node` container) and the `qa/tests` schema-introspection/deprecation smoke test (brief 04 §5). Signed CLA + Apache-2.0 headers (brief 04 §5).

### 7.3 The UmbraDB persistence substrate

The SDK additions land on substrate UmbraDB already has:

- **`CheckpointStore`** (`src/interfaces/checkpoint-store.ts`) is content-addressed, chunked, and **always fully rehashes+verifies every chunk on `load()`** before returning (throwing `ChunkIntegrityError`/`ChunkMissingError`/`ManifestCorruptError`) — its `manifestHash` (SHA-256 over the ordered chunk-hash list) is exactly the `snapshotRoot` the L3 attestation commits to (brief 05 §4.2). Its per-`(walletId,networkId)` monotonic `CheckpointSequence` is the natural home for L2's anti-rollback `seq`.
- **Sprint-7 `PgTransactionHistoryStorage`** implements the SDK's `TransactionHistoryStorage<WalletEntry>` — brief 04 §4c confirms this needs **zero SDK change** (the interface is unprivileged and injected). The new `SnapshotStorage` (7.1c) is the symmetric seam for the snapshot blob itself.
- The **CheckpointStore `WalletState` envelope** carries the serialized local state + the new L0 anchor manifest as one atomic unit; L2's AES-GCM wraps the plaintext before it reaches chunking; L3's attestation commits the `manifestHash`.

---

## 8. Compact / circuit sketches (illustrative, uncompiled)

**L3 — Attested Manifest Root (brief 05 §4.1, V1b+V2). Sub-zswap circuit; all constructs in current stdlib.**
```compact
struct AttestRecord { commitment: Bytes<32>; height: Uint<64>; seq: Uint<64>; prevCommitment: Bytes<32>; }
export ledger attestations: Map<Bytes<32>, AttestRecord>;   // pseudonym id -> latest
export ledger history: MerkleTree<32, Bytes<32>>;           // every attested commitment (V1b)
witness attestSecretKey(): Bytes<32>;                        // dedicated HD path, not the spend key
witness snapshotRoot(): Bytes<32>;                           // Merkle root over snapshot sections (V2)

export circuit attest(height: Uint<64>): [] {
  const sk = attestSecretKey();
  const id = disclose(persistentHash([pad(32,"umbradb:attest:v1:id"), sk]));   // C8 pseudonym
  const isUpdate = attestations.member(id);
  const prev = isUpdate ? attestations.lookup(id) : default;
  if (isUpdate) assert(prev.height < height, "attestation must advance");      // C7 CAS anti-rollback
  const salt = persistentHash([pad(32,"umbradb:attest:v1:salt"), sk, seqAsBytes(prev.seq + 1)]);
  const c = persistentCommit(snapshotRoot(), salt);                            // hiding (C3)
  history.insertHash(c);
  attestations.insert(id, AttestRecord { commitment: c, height: disclose(height),
                                         seq: disclose(prev.seq + 1), prevCommitment: prev.commitment });
}
```

**L3 — offline v-lightweight ZK certificate (brief 07 §2.1). Hand-written zkir; public inputs `{hash(S), R_N, N, id}`; ∝ owned notes; k≈20; verify in ms.**
```
for each owned note i:  ownership: k*_i = c_i · esk (EcMul); assert plain_i[0]==0 (Poseidon-CTR decrypt)  // "mine"
                        membership: c^cc_i = PersistentHash("midnight:zswap-cc[v1]", info_i, pk)         // 1 SHA-256
                                    assert merkle_path_root(path_i, c^cc_i) == R_N                        // ≤32 Poseidon
binding:  assert hash(S) == TransientHash(canonical_encode({info_i, index_i}))
id:       public  TransientHash("umbra:07:id", sk)
```
Proves inclusion + ownership + value-binding at finalized N; **does not** prove completeness (§5). Verified off-chain by `VerifierKey::verify` (`transient-crypto/src/proofs.rs:545-558`).

**L3 research — IVC ratchet state (brief 08 §2.1):** `AssignedState = (checkpoint cursor N, Poseidon frontier commitment, R_N + finalizedHash anchor field)`; `Witness = the L1 ADS delta (N,N+1]`; `circuit_transition` **internalises the collapsed-update completeness check** (pure Poseidon, brief 08 §3.4). O(1) proof/verify; O(delta) per step. Native-Rust prover, not `:6300`.

---

## 9. Phasing table

| Capability | Layer | v1 (no protocol change) | Needs node/protocol change | Research-grade |
|---|---|---|---|---|
| Anchor tuple persisted + offline root recompute | L0 | ✅ [01 §6] | | |
| On-chain agreement check (`block(offset)`) | L0 | ✅ [01 §6] | | |
| Finality: Tier-0 k-of-n RPC | L0/§4 | ✅ [10 §5] | | |
| Finality: Tier-1 GRANDPA justification + state-read-proof | L0/§4 | ✅ SDK plumbing [10 §3] | | |
| Finality: in-circuit | §4 | | | ✅ defer [08 §6] |
| Shielded/dust commitment-completeness (collapsed-tree ADS) | L1 | ✅ SDK wires up existing API [06 §2] | dust roots `@beta`, not node-cross-checked [06 §2.5] | |
| Unshielded authenticated by-address index (MB-tree) | L1 | ✅ indexer signed-STH + monitor [06 §4.4-②] | consensus utxo-root for full trustlessness [06 §4.4-①/③] | |
| Client-side AES-GCM | L2 | ✅ (UmbraDB has it) [03 §5] | | |
| Anti-rollback (local monotonic + chain-freshness) | L2 | ✅ [03 §4] | | |
| Multi-device signed hash-chained CRDT deltas | L2 | ✅ [11 §5] | | |
| On-chain Attested Manifest Root (rollback for cold-boot) | L3 | ✅ Compact V1b+V2 [05] | | |
| Offline v-lightweight ZK certificate | L3 | v1.1 opt-in [07 §2] | | |
| Recursive IVC checkpoint ratchet (O(1) history) | L3 | | | ✅ [08] |
| Ciphertext-delivery completeness | §5 | ⚠️ Zcash-parity residual + NxN | body-proof / ciphertext accumulator [06 §2.4] | |
| Spend-completeness (nullifiers) | §5 | ⚠️ contained by only-spend-own-notes | nullifier non-membership / accumulator [06 §3] | |
| Privacy-from-scanner (detection tag) | §6 | v1.x overlay tag [09 ①] | consensus clue key (FMD) [09 ①-native] | OMR [09 §7] |
| Transparency-log checkpoint (cheaper self-cert) | L3 alt | multi-tenant hosted opt-in [11 §4] | | |

---

## 10. Honest residual trust (after all v1 layers)

The floor, stated plainly (brief 03 §7, brief 06 §6, brief 10 §0):

1. **Consensus/finality.** Correctness reduces to an on-chain root; that root's trust reduces to **GRANDPA not reverting blocks ≤ N**. The certificate *inherits* this, it does not remove it. Tier-1 makes it *verifiable* rather than *assumed*, down to one irreducible weak-subjectivity seed (the genesis authority set, trusted once) (brief 10 §0).
2. **Restore-time freshness (A5).** The wallet must obtain the *genuine* finalized R_N — a light-client problem, mitigated (not eliminated) by Tier-1 + multi-endpoint; strongest with a local node (brief 05 §9, brief 07 §6.2).
3. **Ciphertext-delivery + spend completeness.** Open in v1 (§5) — Zcash-parity, bounded by NxN + only-spend-own-notes + first-spend re-validation; fully closed only by a node change.
4. **Attest-time honesty (L3-c) / circuit correctness (L3-a).** The attestation transports correctness forward but cannot create it — a wallet compromised *at attest time* pins bad state (an explicit non-goal; brief 05 §1). The offline proof only means "the statement *this vk's circuit* encodes holds" — the hand-written IR must be audited and its vk pinned (brief 07 §6.3).
5. **Privacy.** Rests on the seed's ≥256-bit entropy and the secrecy of the seed-derived key (brief 03 §7). The remote scanner still learns ownership until the detection-tag overlay ships (§6).
6. **Trusted-setup + proving-system soundness** (KZG BLS12-381 SRS, Halo2) — shared with the entire chain, not new to us (brief 07 §6.5-6).

The DB itself is trusted for **availability only** — strengthened by plain multi-host replication extending the NxN habit to the blob (brief 11 §3; erasure-coding/DAS explicitly rejected as disproportionate at wallet-snapshot scale). **TEE attestation is rejected** as a substitute (attests code identity, not chain-relative data; its own root of trust has broken repeatedly — Foreshadow/SGAxe/Downfall, and the wallet-shaped Secret Network consensus-seed extraction — brief 11 §1); acceptable only as an orthogonal at-rest confidentiality layer *underneath* the anchor.

---

## 11. Post-implementation testing strategy

Every design claim must map to a test that could falsify it. Organized by layer and by the adversary each defends against.

### 11.1 Unit + property tests
- **L0 collapse-invariant (the load-bearing fact):** property test that `serialize → deserialize → rehash().root()` is bit-identical to the on-chain root at the same `endIndex`, across randomized note sets and `firstFree` values (brief 01 §6.2). Falsifies the "offline recompute" claim if it ever diverges.
- **L1 completeness algebra:** property test that `applyCollapsedUpdate` over `[endIndex_N, endIndex_tip)` is a monoid homomorphism and that any *omitted/reordered/inserted* commitment in the range makes the rehashed root diverge from the tip root (brief 06 §2.1). Fuzz the collapsed-update bytes.
- **L1 unshielded boundary proof:** property test that the MB-tree non-membership proof accepts iff `A⁻ < A < A⁺` are genuinely adjacent, and rejects any forged `[]` for a present address or any dropped UTXO within a present address's list (brief 06 §4.3).
- **L2 anti-rollback monotonicity:** property test that a snapshot with `seq`/height below the highest-ever-accepted is rejected; that the chain-freshness check rejects `anchorHeight <` last-known-finalized.
- **L2 BFT-CRDT:** property test for fork*-consistency — signed hash-chained deltas converge under causal delivery; any spliced/reordered/forged delta breaks the hash chain (brief 11 §5.2).
- **L3 attestation CAS:** unit test that a replayed old `attest` tx fails against advanced state (transcript re-run), and that height-monotonicity `assert` holds (brief 05 §4.3).
- **L3 ZK circuit:** negative tests that a note not decrypting to `esk`, a commitment not under `R_N`, or a tampered `hash(S)` all fail proof generation/verification (brief 07 §2.1); `CircuitModel` cost-model run to confirm k≈20 for m=50–200 notes.

### 11.2 Integration tests (against a real `midnight-node` + indexer, testcontainers)
- End-to-end `serialize → CheckpointStore.save → load → restoreVerified → start` on a live devnet, extending the existing `serializationAndRestoration.integration.test.ts` two-step restore-then-start flow (brief 04 §1).
- Indexer `TreeAnchor` resolver and `unshieldedUtxos` proof woven into `native_e2e.rs` byte-identical reference stream (brief 04 §5); schema-introspection smoke test must not trip on the new fields.
- Tier-1 finality: verify `grandpa_proveFinality(N)` + `state_getReadProof` against a real node, including an authority-set-change spanning warp-sync fragment (brief 10 §1-3).

### 11.3 Real-preprod exercise
- Restore a wallet from an UmbraDB snapshot taken at a **finalized** preprod checkpoint N, verify the anchor against preprod's committed `zswapMerkleTreeRoot`, catch up `[N, tip]` live, and confirm balance parity with a from-genesis replay control. (Note the memory-file caveat: our own preprod experience shows the installed wallet-SDK API can differ from in-tree tooling — pin versions.)
- Dust anchor exercised separately and flagged: dust roots are `@beta` and **not** node-cross-checked (brief 04 §3) — assert the softer trust posture explicitly.

### 11.4 Failure / recovery (cold-boot — the core scenario)
- **Cold-boot from zero local state:** wipe all local wallet memory, restore purely from UmbraDB, confirm `restoreVerified` reconstructs correct state; confirm that *without* the L3 on-chain attestation a rolled-back snapshot is undetectable, and *with* it the cold-booted wallet detects the rollback via the chain pointer (the argument in §3 — this is the test that justifies L3 being v1).
- Corrupted chunk / manifest → `ChunkIntegrityError`/`ManifestCorruptError` surfaces and restore falls back to replay (never bricks — brief 05 §8).
- Partial/interrupted `save` (AbortSignal) → no half-written manifest; monotonic `seq` unbroken.

### 11.5 Adversarial tests (each maps to a threat in brief 05 §3)
- **Omission (A1/completeness):** malicious indexer stub that (a) omits a *committed* leaf → L1 root check must catch; (b) downgrades a ciphertext to `None` → must be caught only by NxN cross-indexer disagreement, and the test **documents** it is NOT caught by the single-indexer root check (the honest §5 residual).
- **Rollback (A2):** DB serves an old-but-genuine snapshot → L3 CAS pointer rejects for a cold-booted wallet; L2 monotonic rejects for a running wallet.
- **Cross-wallet swap (A3):** hosted multi-tenant DB serves another tenant's genuine attested snapshot → fails the per-wallet salt/id commitment check.
- **Attestation forgery (A4):** plant an on-chain attestation for an attacker-chosen hash → fails without `sk_attest`.
- **Tag-collision (§6 overlay):** two addresses producing colliding detection tags → confirm the wallet still trial-decrypts correctly and no false-negative note loss; confirm a malicious indexer omitting a *tag* is bounded by NxN (the §6 residual).
- **Split-view / equivocation (multi-device):** DB shows different snapshots to two devices → each device's independent anchor check accepts only chain-correct states; BFT-CRDT hash chain detects the horizontal divergence (brief 03 §4, brief 11 §5).

### 11.6 Claim-to-test matrix (the correctness gate)
The correctness-audit spec gate must confirm each design claim has a falsifying test before implementation: (C1) offline recompute = on-chain root → 11.1 collapse-invariant + 11.3; (C2) tail scan verifiably complete → 11.1 L1 + 11.5 omission; (C3) rollback detectable on cold-boot → 11.4 + 11.5 A2; (C4) finality verifiable not assumed → 11.2 Tier-1; (C5) remote DB is availability-only → 11.5 A1-A4; (C6) completeness residual is exactly ciphertext-delivery + spend-hiding → 11.5 omission documents the non-caught cases.

---

## 12. Open decisions for the design council to ratify

**D1 (top) — L3 primary = the Compact Attested Manifest Root, and it is v1, not optional, for the remote case.** Ratify that a cold-booted wallet restoring from an untrusted DB genuinely needs a consensus-held monotonic pointer (§3), so the on-chain attestation ships in v1 for remote/hosted deployments (optional only for purely-local single-writer). Ratify V1b+V2 shape with `prevCommitment` from day one. Accept the §1 framing as a written non-goal: we defend against a hostile *DB*, not a wallet compromised *at attest time* (brief 05 Q3) — or the feature over-claims.

**D2 — ship v1 with the documented Zcash-parity completeness residual (§5).** Ratify that ciphertext-delivery + spend-hiding remain open in v1, bounded by NxN + only-spend-own-notes + first-spend re-validation, and are closed only by a Midnight node change we will formally request (body-inclusion proof / header ciphertext-accumulator / nullifier accumulator). This is the industry-standard position (brief 09 §8); the alternative is blocking v1 on a protocol change we don't control.

**D3 — privacy-from-scanner: overlay-now vs consensus-later (§6).** Ratify shipping the overlay detection tag as v1.x (privacy win, completeness still bounded), and formally requesting the consensus-emitted clue key (FMD) from Midnight as the principled close of both privacy and ciphertext-delivery completeness. Accept that an overlay tag is itself omittable (brief 09 §10).

**Secondary (flag, not blocking):** finality Tier-0 → Tier-1 sequencing (§4); `R_utxo` anchoring option 2 vs waiting for a consensus utxo-root (brief 06 §4.4); contract governance / immutability + pinned vk versioning across protocol upgrades (brief 05 Q4, brief 07 §7.3); canonical versioned snapshot-section encoding (CBOR/CDDL) needed by V2 and any future in-circuit use (brief 05 Q6); HD path for `sk_attest` and interaction with key rotation (brief 05 Q7).

**The biggest risk.** Over-claiming completeness. The design's honesty rests on stating, everywhere "verified" appears, that v1 proves *commitment*-completeness + inclusion + rollback-resistance + finality-anchoring, but **not** ciphertext-delivery or spend completeness — those need a node change. A design that quietly implies "fully verified, no trust in the feed" would be wrong in exactly the way brief 06 §2.4 / brief 07 §3.1 / brief 09 §10 warn, and would mislead users into financial decisions against a possibly-under-counted balance. Second-order risk: L3-a's hand-written, compiler-un-attested IR + pinned vk is a new trust surface that must be audited before v1.1, or it "verifies" nothing useful (brief 07 §6.3).

---

*Grounding: briefs 01–11 in `design/research/2026-07-21-snapshot-root-of-trust/`; UmbraDB `src/interfaces/checkpoint-store.ts`, `Formal/STORAGE_ALGEBRA.md` §6; Midnight source cited inline. No Midnight source modified; nothing committed.*
