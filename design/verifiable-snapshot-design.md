# Verifiable Wallet-State Snapshot — Design (roll-up)

**Branch:** `fix/verifiable-snapshot-v2` (was `feature/verifiable-snapshot`) · **Date:** 2026-07-22 · **Status:** v3 — revised after a second adversarial design-council review round; ready for a third review pass before implementation begins.
**Author role:** Design Lead, synthesizing research briefs 01–11 (`design/research/2026-07-21-snapshot-root-of-trust/`) plus the v2 and v3 fixes below.

This document is **decisive** — it recommends one v1 design and states what is deferred — but it flags, in §12, the genuinely open decisions the council must ratify before any implementation begins. Every load-bearing choice is grounded in a brief (cited `[NN]`) and, where the mechanism lives in Midnight, a `repo/path:line`.

---

## Revision history — v3

Round 2 of design-council review sent v2 back **2-of-3 NEEDS-ROUND-3**: **Claude Fable 5** and **GPT-5.6 Sol** (via Codex) independently found the same core remaining defect; **Claude Opus** judged no-round-3-needed but flagged one related gap (folded in as item 6 below). This revision fixes all of it. Summary:

0. **(The core defect.) The `snapshotRoot` commitment equation never actually bound the wallet's owned notes.** §2.5.2's v2 equation covered cursor, the *global* tree root `R_N^tree`, nullifiers, history, dust, and manifest description — but no canonical owned-notes/ownership-set section. Two snapshots with completely different owned-note sets but identical cursor/nullifiers/tree-root/dust/manifest therefore produced the **same** attested `snapshotRoot` — directly contradicting §3's own prose (the V1b+V2 description at "cursor/notes/nullifiers/history/dust/manifest," line ~189) claiming the root covers "notes." v2's §5.0 had correctly diagnosed that root equality on the *global* tree doesn't bind wallet identity, but the fix that diagnosis called for — an owned-notes section in the governing equation — was never actually added; only the surrounding prose was corrected. **Fixed:** §2.5.2 gains a required `ownedNotesPlain` section (Domain P) folded into the `snapshotRoot` equation; §2.5.4's CDDL requirement is extended to cover it; new §2.5.5 resolves the follow-on question both reviewers raised — how the section's own correctness is established at restore time without a full historical re-scan — by adopting **option (b)** (live-tail re-derivation bounds the risk to the base-at-N) **combined with an explicit, named (a)-residual for the base itself** (attest-time honesty, already §10 item 4, now extended to name owned-notes explicitly). §5.0 is updated to state precisely what this closes (*binding*) versus what it doesn't (*completeness* — still the unchanged §5/§5.1 ciphertext-delivery residual).
1. **Restore API was fail-open on L3 record authentication.** `fetchLatestAttestation` was an unauthenticated query, uncoupled from any freshness proof, and a present-but-mismatched record silently downgraded to `"L0+L1"` exactly like a genuinely-absent one. **Fixed:** §7.1(b) is rewritten around a second, independently-fetched *fresh* `verifyFinalizedTuple` horizon (the current finalized tip, not the checkpoint's own old block) that the attestation lookup is now read-proof-authenticated against (`fetchAuthenticatedAttestation`), and a present-but-mismatched record now throws a dedicated `RollbackDetectedError` instead of silently downgrading — only a *genuinely absent* record (proven absent via the same read-proof) still downgrades quietly.
2. **`attestLeaf` was never reconstructed at restore time.** Only `commitment` and `height` were checked. **Fixed:** §7.1(b)'s L3 step now reconstructs the full `attestLeaf` hash per §2.5.3's equation (genesis/network id, wallet kind, block hash, tree root, end index, encoding version, statement version, sequence, previous commitment) and requires it to equal `record.attestLeaf`.
3. **vk/contract/statement pins were prose-only.** **Fixed:** the restore `conn` config gains typed `attestCircuitVkHash` and `attestStatementVersion` fields (§7.1(b)); a per-restore check hard-fails on `record.statementVersion` mismatch (`PinnedStatementVersionMismatchError`), and a one-time, session-level `assertContractVkPinned` check is specified for the vk-hash pin (§7.1(b), §3.5 cross-ref).
4. **`record.seq` vs `envelope.seq` were allowed to silently diverge.** **Fixed:** §7.1(a)'s envelope schema and §7.1(b)'s restore logic now treat these as one shared sequence space (the wallet's attest-driving `seq` *is* the envelope's persisted `seq`); a hard equality check is added, and the local high-water mark is now updated from the chain-authenticated `record.seq`, never the DB-supplied `envelope.seq`.
5. **`horizon`'s type was missing `R_N`/`endIndex`** despite downstream code reading both. **Fixed:** §7.1(b)'s `HorizonTuple` type now carries the full tuple §4 already returns.
6. **The L1 tail-completeness check was a no-op in the normal case** (Opus's item, folded in here) — `horizon` was derived from the checkpoint's own block, making `anchor.zswapEndIndex == horizon.endIndex` trivially true. **Fixed:** §7.1(b) now derives L1's upper bound from the *same* fresh tip-horizon added for item 1, making the tail span `[checkpoint's endIndex, current finalized tip's endIndex)` genuinely non-trivial — one fix serves both gaps.
7. **AES-GCM was internally contradictory** (encrypt-then-chunk prose vs. per-chunk-nonce spec) and `CheckpointStore.save()`'s actual sequence-allocation order was never checked against source. **Verified directly against `src/postgres/checkpoint-store.ts:139-173` (v3 session):** confirmed — chunking and chunk-hash computation happen in `saveImpl` *before* `withTransaction` opens; `seq` is allocated *inside* the transaction, after chunks are already split, via the atomic `ckpt_sequence_counters` upsert-increment (`next_seq - 1 AS claimed_seq`). An external wrapper genuinely cannot pre-compute a `(seq, chunkIndex)` nonce before that point. **Fixed:** §7.3.1 picks **chunk-then-encrypt** as the sole construction, specifies an injective `uint64(seq) || uint32(chunkIndex)` (96-bit) nonce layout, moves encryption *inside* `PgCheckpointStore.saveImpl`'s transaction (after `seq` allocation, before each chunk's hash/insert) rather than pre-reserving a sequence, widens the AAD to bind chunk index/count/section plus key/encoding version, specifies `encKdfVersion` as a per-manifest rotation-epoch identifier, and corrects the dedup-leak residual: under a monotonic per-`(seq,chunkIndex)` nonce, cross-checkpoint plaintext equality is **no longer observable** as ciphertext equality (every `save()` gets a fresh `seq`); the real residual left is the much weaker chunk-count/byte-length shape leak inherent to any chunked store.
8. **Dust trust-tier labeling was inconsistent** — "consensus-reduced" in §1, the architecture diagram, and the phasing table, versus correctly "Tier-F-lite" in §2.6. **Fixed:** §1, the diagram, and §9's phasing table now split shielded (consensus-reduced) from dust (Tier-F-lite) everywhere they were previously bundled.
9. **§3's "closes threats A1–A4" overclaimed**, contradicting §2.6/§5's own adversarial matrix (ciphertext-downgrade sits under A1 and is explicitly *not* caught by L0/L1). **Fixed:** narrowed to name exactly what the contract supplies — latest-pointer rollback resistance, identity separation, attestation authorization — with commitment-omission correctly attributed to L1 and ciphertext-omission to the §5 residual.
10. **Rollback-recovery retrieval (§3.6 step 3) wasn't concrete** — `AttestRecord` has no storage locator, and a hiding commitment isn't one. **Fixed:** given item 4's `record.seq == envelope.seq` fix, step 3 now retrieves the checkpoint concretely via `CheckpointStore.load(walletId, networkId, record.seq)` — no new `AttestRecord` field needed, since the checkpoint-store's own monotonic sequence *is* the authenticated locator once the two sequence spaces are unified.
11. **Legacy-restore downgrade risk** — a hostile DB could serve an anchor-less envelope to a wallet that has a real on-chain attestation, forcing it through the unverified legacy path. **Fixed:** §7.1(d)'s `restoreLegacyUnverified()` now performs an independent pre-restore L3 pointer probe (when `identity.skAttest` is available) and refuses to proceed on the legacy path if a genuine on-chain record for this wallet's `id` is found.

Section numbers below mostly match v1/v2 to keep prior review comments addressable; new v3 material is inserted as further decimal subsections (§2.5.5, §7.1(e)) or in place within existing v2 subsections, flagged inline.

---

## Revision history — v2

The v1 draft (`8468657`) went to design-council review cold, before any adversarial pass. Three independent reviewers — **Claude Fable 5**, **Claude Opus**, and **GPT-5.6 Sol** (via Codex) — each read it without seeing the others' notes and converged strongly; GPT-5.6 Sol issued an explicit **NEEDS-REWORK / BLOCK** verdict. This revision addresses all eleven convergent and independently-discovered findings. Summary of what changed and why:

1. **Canonical commitment relation was self-contradictory** (§7.3 said `manifestHash` "is exactly" `snapshotRoot`, while §3/§8 use V2's structured root; ciphertext-level and plaintext-level commitments were never formally separated, so a routine key rotation would silently break every prior attested checkpoint's equality check). **Fixed:** new normative §2.5 defines two disjoint commitment domains (plaintext "semantic" vs ciphertext "storage") and a single canonical attestation equation; canonical encoding (old §12 Q6) is promoted from secondary to blocking (new §12 D0).
2. **Envelope migration was fail-open** (`anchor` was `Schema.optional` yet described as "mandatory"; `restoreVerified()` only checked anchors `if (anchor)`, so an anchor-less envelope — legacy or freshly fabricated — sailed through unverified while returning from a function named "Verified"). **Fixed:** §7.1(a) versions the envelope schema; a v2 envelope's anchor is non-optional and any envelope failing that shape is fail-closed, routed to a separately-named, never-"verified" legacy path (§7.1(d)), with a forced-reanchor migration policy.
3. **Rollback recovery was detection-only** (no story for an already-active wallet, no periodic/pre-spend recheck, no quarantine/recovery transition). **Fixed:** new §3.6 defines an explicit restore/operation state machine (`unverified → verified-at-finalized-head → caught-up → active → quarantined`) with concrete recovery steps for in-flight transactions and multi-device CRDT deltas.
4. **vk/circuit succession was unauthenticated** (the Mithril-CVE-class gap, GHSA-724h-fpm5-4qvr: protocol-parameter succession must be bound inside what's cryptographically authenticated, not travel as unauthenticated sidecar metadata) and was filed as merely "secondary." **Fixed:** new §3.5 explicitly commits v1 to full immutability with hard-pinned contract address + vk hash + statement version in client config (option **a**), adds this as a named §10 residual-trust item, and documents a successor-certificate mechanism (option **b**) as the specified-but-deferred v1.1+ upgrade path.
5. **Vocabulary overclaimed** ("consensus-grade," "proves S is exactly correct," "the chain is trusted unconditionally," "kills threats A1–A4"). **Fixed:** replaced throughout with scoped statements consistent with the rigor §10 already used; see inline diffs in §1, §2, §3.
6. **`restoreVerified()` didn't implement its own flagship guarantee** (no L3 attestation check, no `sk_attest` parameter, no L2 sequence check — L0+L1 only). **Fixed:** renamed to `restoreAnchoredCheckpoint()` in §7.1(b), fully rewritten to include the L3 attestation check and L2 anti-rollback sequence check, returning a structured `{wallet, verificationLevel, horizon, residuals}` result instead of a bare `Wallet`.
7. **L0's "proves S is exactly correct" claim was false** — the zswap root is a *global*, wallet-agnostic commitment; root equality alone doesn't bind wallet identity. **Investigated (§5.0):** L0+L1 together prove the *global* tree is complete and untruncated; wallet-identity binding additionally depends on the wallet's own local trial-decryption over that verified-complete leaf set, which is sound **except** for exactly the §5 ciphertext-delivery residual — i.e., items 7 and 5 are the *same* gap seen from two angles, now stated as one unified, correctly-scoped residual rather than two separately-described ones. No new cryptographic primitive was needed; the claim was rewritten. The §5 "first spend re-validates completeness" claim is corrected to scope it to the single spent input, not the whole note set.
8. **Unshielded/dust didn't reduce to an on-chain commitment** despite being described alongside claims that do. **Fixed:** new §2.6 names this explicitly as a separate, weaker **federated-quorum trust tier** (Tier-F / Tier-F-lite), distinct from the consensus-reduced tier the rest of the document claims; "verified"/"trustless" language is no longer applied to these paths unqualified.
9. **Finality proof wasn't cryptographically bound to the values it authenticates** (independently-fetched root + independently-verified finality, not one coupled proof). **Fixed:** §4 and §7.1(b) now define `verifyFinalizedTuple`, a single call that derives `(blockHash, R_N, endIndex, finalizedHash)` from one state-read-proof against one header, with the GRANDPA justification checked against that exact `blockHash` — every downstream check consumes only this one `horizon` object.
10. **The "UmbraDB already implements encryption" claim was factually false.** **Verified against source** (`git show origin/main:src/postgres/checkpoint-store.ts`): `PgCheckpointStore.save()` only SHA-256-hashes chunks and stores raw bytes verbatim — zero encryption. `getOrCreateSalt` (cited as evidence) belongs to the unrelated `PgPrivateStateProvider` subsystem (`design/design.md` §"Encryption keys are derived..."), confirming the earlier session finding that it has nothing to do with the checkpoint/snapshot path. **Fixed:** §2 and §7.3 corrected to state encryption is **not yet implemented**; new §7.3.1 specifies it as a blocking v1 requirement (nonce rule, KDF/domain separation, AAD, key rotation, dedup-leak residual).
11. **BFT-CRDT treatment overstated automatic detection.** A malicious DB can show two devices indefinitely divergent forks unless they actually exchange histories or share an independently-authenticated head. **Fixed:** §2's L2 multi-device bullet now states this as an explicit precondition, proposes the L3 attestation pointer itself as a connectivity-free shared head, and names device-key membership/revocation and non-commutative merge rules as explicitly deferred, not silently solved.

Section numbers below mostly match v1 to keep prior review comments addressable; new material is inserted as decimal subsections (§2.5, §2.6, §3.5, §3.6, §7.1(d), §7.3.1) rather than renumbering the whole document.

---

## 1. Problem and core principle

UmbraDB persists a Midnight wallet's replay-derived sync state; the Midnight SDK ships only in-memory storage (brief 01 §5: every serialized snapshot today is `{local-state hex, protocolVersion, networkId, offset}` with the cursor itself `Schema.optional` — no block hash, no root, no anchor). On memory loss the wallet must restore from UmbraDB — **LOCAL or REMOTE/UNTRUSTED** — and verify the snapshot is correct **without replaying the chain**.

**The owner-set principle (the whole design pivots on it):** we do not prove "S is correct as of the tip." We prove **"snapshot S is complete with respect to on-tree commitments and correct with respect to the finalized chain view, as of a FINALIZED checkpoint block N"** — a deliberately narrower claim than "the complete, correct wallet state" (v1 draft's phrasing overclaimed this; see §5.0/§10 for exactly what is and is not covered, notably the ciphertext-delivery and spend-hiding residuals). Because the chain is append-only and GRANDPA finality precludes reverting blocks ≤ N, that certificate is **valid for horizon N for as long as the residual trust items in §10 hold** — it does not expire on its own terms, but it is not "permanent" in an absolute sense; call it a floor whose *on-tree* completeness is durably certified, not an unconditional permanent guarantee (brief 07 §0; contrast the ledger's rolling 1-hour `global_ttl` spend-anchor window, which is a *spendability* window, not a *verifiability* one — brief 01 §2, `zswap/src/ledger.rs:73-79`). On restore the wallet verifies the certificate, then catches up `[N, tip]` **LIVE** via the normal ADS-authenticated incremental sync. Each proven finalized checkpoint is a **cryptographically-certified floor for on-tree completeness** the wallet never rescans below again — stronger than Zcash's *trusted* birthday only along that specific axis (brief 02 §5, brief 07 §0), not across every axis of correctness.

The reduction that governs every layer (brief 03 §0's theorem): **the DB is never a source of correctness — only of availability.** Every no-replay check must reduce S to a check against an **on-chain commitment the wallet independently trusts**, whose trust in turn reduces to **consensus/finality**. Content-addressing and AES-GCM prove "the bytes I read are the bytes written"; they never prove "the bytes are the correct chain-derived state" (brief 03 §0). That gap is what this design closes — **for the shielded path, by full reduction to consensus; for dust, only to the softer Tier-F-lite tier (single indexer, `@beta`, not node-cross-checked); for the unshielded path in v1, to a federated quorum of indexer operators (Tier-F) — dust and unshielded are both explicitly weaker than shielded and named as such in §2.6 (v3: this sentence previously bundled dust with shielded under "consensus," inconsistent with §2.6's own classification — corrected, item 8).** Every plaintext/semantic value this document calls a "commitment" is precisely defined in §2.5; a canonical, versioned byte-encoding of every committed section (old §12 Q6) is a **blocking v1 requirement**, not optional plumbing — without it, the equations in §2.5 aren't well-defined.

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
   L2 Remote/        │  Client-side AES-256-GCM (seed-derived) — NOT YET BUILT,     │
   untrusted-DB      │    spec in §7.3.1, blocking v1 requirement                    │
   hardening         │  Anti-rollback: local monotonic seq + chain-as-freshness     │
                     │  Multi-device: signed hash-chained CRDT deltas (BFT-CRDT),    │
                     │    conditional on history exchange (§2 bullet 3)             │
                     └─────────────────────────────────────────────────────────────┘
                     ┌─────────────────────────────────────────────────────────────┐
   L1 Bounded-scan   │  Shielded: collapsed-tree range proof vs on-chain root       │
   completeness      │    (ADS already present — 06 §2.1) — consensus-reduced       │
   (ADS)             │  Dust: same mechanism, roots @beta, NOT node-cross-checked   │
                     │    — Tier-F-lite, NOT consensus-reduced (§2.6)               │
                     │  Unshielded: NEW authenticated by-address MB-tree index      │
                     │    — Tier-F, federated-quorum trust tier, NOT               │
                     │    consensus-reduced; see §2.6                                │
                     └─────────────────────────────────────────────────────────────┘
                     ┌─────────────────────────────────────────────────────────────┐
   L0 Anchor         │  {finalized N, blockHash, tree endIndex/frontier, R_N}       │
                     │  finality verified via GRANDPA justification + state-read     │
                     │  — all four values from ONE coupled tuple (§4, §7.1(b))      │
                     └─────────────────────────────────────────────────────────────┘
```

### L0 — The anchor

**What is persisted, alongside each wallet-kind's serialized local state:** the block-anchor tuple `{blockHeight N, blockHash, treeEndIndex, R_N}` for the relevant tree(s) at serialization time — `zswapMerkleTreeRoot` + `zswapEndIndex` for the shielded wallet; both dust roots + end-indices for the dust wallet; the by-address UTXO-set root for the unshielded wallet (brief 01 §6 "strongest anchor candidate", brief 03 §7).

**Why every tree already has a usable root (no node change).** Midnight's `Sp<T,D>` content-addressing (`storage-core/src/arena.rs:1505-1519`) makes the zswap tree, both dust trees, and the whole `LedgerState` DAG deterministically hashable (brief 01 §1). The zswap/dust roots are exposed per-block by the indexer's `Block` type — `zswapMerkleTreeRoot`/`zswapEndIndex` (stable), `dustCommitmentMerkleTreeRoot`/`dustGenerationMerkleTreeRoot` (`@beta`) (`schema-v4.graphql:64-88`). **The load-bearing fact:** collapsing "leaves the hash invariant" (`transient-crypto/src/merkle_tree.rs:921`), so a restored snapshot's `merkle_tree.rehash().root()` — computed **entirely offline from the snapshot alone** — is bit-identical to the full on-chain root at the same `endIndex` (brief 01 §6.2). And the indexer recomputes zswap/full-ledger roots itself and `bail!`s on any mismatch vs the node on every block (brief 04 §3, `chain-indexer/src/application.rs:~404-420`) — so trusting `zswapMerkleTreeRoot` is trusting a value two independent re-executions already agree on. (Dust roots are computed and served but **not** node-cross-checked — no node dust-root RPC exists — so dust anchors ship on softer ground, and per §2.6 are scoped to a federated-quorum trust tier, not the consensus-reduced tier shielded gets; brief 04 §3, brief 06 §2.5.)

**What L0 alone proves — precisely, not "S is exactly correct" (the v1 draft's claim, now retracted).** The zswap commitment tree is **global**: it is the same tree, with the same root, for every wallet observing block N — it is not partitioned per-wallet. Root equality between the wallet's offline recompute and the chain's committed `R_N` therefore proves only that **the snapshot's reconstructed tree frontier — the full leaf set through `endIndex` — is bit-identical to the chain's own frontier at N.** It does **not**, by itself, bind which subset of those leaves the wallet is entitled to call "mine": a snapshot could carry a perfectly correct global frontier while its separate "owned notes" bookkeeping is tampered, truncated, or simply wrong, and L0's root check would not catch it. What closes that gap, and exactly how far it closes it, is worked out precisely in **§5.0** — the short version is that L0+L1 together establish global-tree completeness, and the wallet's own local trial-decryption over that verified-complete leaf set is what actually determines "mine," subject to one residual (ciphertext delivery) that is tracked, not hidden.

**Restore-time L0 check** (zero network, then one query): (1) recompute the local root offline, compare to persisted `R_N` — catches corruption/tamper/bit-rot instantly; (2) query `block(offset:{height:N})` and compare its committed root/endIndex to the persisted anchor — proves the tree frontier is correct as of N with **zero transactions replayed** (brief 01 §6); (3) the finality of N and the authenticity of R_N are discharged by L0's finality sub-layer (§4) — and, per the §4/§7.1(b) v2 fix, steps (2) and (3) now consume **one** coupled `(blockHash, R_N, endIndex, finalizedHash)` tuple rather than two independently-fetched facts that merely happen to agree.

### L1 — Bounded-scan completeness (the ADS)

L0 proves the base tree-frontier at N. L1 makes the live tail `[N, tip]` **verifiably exhaustive** at the tree level, not merely "hopefully complete," closing the *commitment*-omission freedom the anchor alone leaves (brief 06 §0, §2.1). Note precisely, per §5.0: L1 closes tree-level omission for the *global* leaf set, same as L0 — it is still not, by itself, a wallet-identity-binding proof; see §5.0 for the full picture.

- **Shielded / dust — the ADS is already present and already exposed.** The zswap tree is fixed-height-32, append-only over contiguous indices; `MerkleTreeCollapsedUpdate` (`transient-crypto/src/merkle_tree.rs:302-405`) authenticates any leaf range in O(log range) ≤ 32 hashes, served by `zswapMerkleTreeCollapsedUpdate(startIndex,endIndex)` (`schema-v4.graphql:1258`, stable). By the RFC 6962 "fix size + root ⇒ leaf multiset determined" argument, a wallet that applies the bridge for `[endIndex_N, endIndex_tip)` and rehashes to a root equal to the on-chain tip root has a **commitment-completeness proof**: the indexer could not have omitted, inserted, or reordered any commitment (brief 06 §2.1). Penumbra ships exactly this shape in production (chain-provided inline span-hashes + Anchor = global tree root; brief 09 §1.3, ②). **This is SDK-only wiring** — `applyCollapsedUpdate` already exists in the ledger crate but is **never called** by the wallet today (brief 04 §2, `shielded-wallet/src/v1/CoreWallet.ts:148-151`). This path is **consensus-reduced**: the tip root it checks against is itself an on-chain commitment.
- **Unshielded — a genuinely new authenticated by-address index is required, and it is NOT consensus-reduced in v1 — see §2.6.** Unshielded state is `UtxoState{utxos: HashMap<Utxo,UtxoMeta>}` (`ledger/src/structure.rs:2948-2968`), keyed by `ArenaHash(whole-Utxo)` — no address locality, no exposed proof API, and no point-in-time "UTXO set by address" query exists (brief 06 §4.1; the `unshieldedUtxos` query is *proposed*, not extant). Build a **Merkle-B-tree / authenticated-dictionary** keyed by owner address as an indexer-maintained materialized view; a query returns A's UTXO list + Merkle path to `R_utxo(N)`, and for an absent address the **two boundary leaves** `A⁻ < A < A⁺` proving no leaf hides between them (Naor–Nissim / MB-tree non-membership; brief 06 §4.2–4.3). The subtree-size annotation gives verifiable counts — and Midnight's own MPT already carries a `SizeAnn` size monoid (`storage/src/merkle_patricia_trie.rs:499-515`), merely unexposed. **v1 ships this as Tier-F (federated quorum): a signed STH + k≥2 independent indexers, not a reduction to a consensus commitment** — see §2.6 for exactly what that means and does not mean.

### L2 — Remote/untrusted-DB hardening

Three properties the local single-writer case never needed (brief 03 §4, brief 11 §5):

- **Confidentiality.** Client-side **AES-256-GCM** under a key deterministically derived from the wallet seed (Zcash ZIP-32 shape; brief 03 §5). **Corrected from the v1 draft, which claimed this was already implemented: it is not.** `git show origin/main:src/postgres/checkpoint-store.ts` confirms `PgCheckpointStore.save()` splits data into chunks, SHA-256-hashes each chunk plus the ordered hash list (`manifestHash`), and stores the **raw, unencrypted** bytes — there is no encryption anywhere in the checkpoint-envelope path today. The `getOrCreateSalt` mechanism the v1 draft cited belongs to `PgPrivateStateProvider` (`design/design.md`, the "Encryption keys are derived from a per-`(accountId, scope)` salt" passage) — an entirely different subsystem, Midnight contract *private state* storage, unrelated to wallet snapshots. Full v1 requirement spec is in **§7.3.1**. Once built: the DB sees only ciphertext + opaque content hashes; the commitment the DB sees (`manifestHash`) is over *ciphertext* (pure blob integrity, Domain S — §2.5.2), the commitment the wallet checks against the chain (`snapshotRoot`) is over *plaintext* (Domain P), computed locally after decrypt and **never sent to the DB** and **never substituted for or equated with `manifestHash`** (brief 03 §5, §2.5). Layers compose without leaking, and — critically, fixing the v1 draft's contradiction — a key rotation changes `manifestHash` but by construction cannot change `snapshotRoot`, so it never invalidates a prior attestation.
- **Anti-rollback / freshness.** The GCM tag carries **no** freshness — a remote DB can serve a *previously authentic* old snapshot and it decrypts perfectly (the ROTE replay attack; brief 03 §4). Two complementary defenses: (i) a strictly-increasing `seq` + `anchorHeight`, signed by the writer, with the highest-ever-accepted value held in a small trusted local store — protects a *running* wallet; (ii) **the chain as the freshness oracle** — require `anchorHeight ≥` last-known-finalized and `anchorBlockHash` on the canonical header chain (brief 03 §4). **Crucial gap for our exact scenario:** on total memory loss the wallet has *no* local counter, so (i) and (ii) cannot detect a rollback served to a cold-booted wallet. That gap is precisely what L3's on-chain attestation closes at restore time (§3) — and, per the v2 fix in **§3.6**, what an already-*active* wallet must also keep rechecking, since detection-at-restore alone leaves a wallet that resumed on stale-but-genuine state with no story for discovering that fact later.
- **Multi-device (the NECESSARY complement, brief 11 §5) — with an explicit communication precondition, corrected from the v1 draft.** A DB shared across N devices of one wallet is a *horizontal* trust relation none of briefs 01–06 covers. Adopt Kleppmann's **BFT-CRDT**: each device signs its wallet-state deltas and hash-chains each to its causal predecessor; the untrusted DB is demoted to a relay that can delay/drop (detectable, recoverable) but cannot forge, splice out-of-causal-order, or silently rewrite history without the hash chain visibly breaking — **provided devices actually exchange histories, or independently check a shared authenticated head, on some cadence.** This is a precondition, not an automatic consequence of hash-chaining: a malicious DB can show two devices two separate, internally-valid-looking forks **indefinitely** if it simply never lets them compare notes — signatures prove authorship, not synchronization, and a chain that is never cross-checked between devices cannot detect a split it was never shown (brief 11 §5.2, Kleppmann PaPoC 2022, with this caveat added in v2). **v1 requirement:** specify a minimum exchange cadence — either periodic direct device-to-device sync, or (simpler, no device-to-device connectivity required) each device independently re-checks the **L3 attestation pointer** (§3), which is a shared authenticated head by construction, since every device validates it against the chain rather than against each other. **Explicitly deferred, not silently solved:** device-key membership/revocation (adding/removing a device from the trusted signer set) and a merge-rule specification for non-commutative wallet operations (e.g. two devices independently initiating conflicting spends) are out of scope for v1.

### 2.5 Canonical commitment relation (normative)

*(New in v2 — fixes item 1: the internally-contradictory commitment relation.)*

This section is binding. Every "verified" / "matches" / "equality check" claim elsewhere in this document must resolve to exactly the equations below; where prose elsewhere is loose, this section governs.

**2.5.1 The problem this section fixes.** The v1 draft used `manifestHash` and `snapshotRoot` interchangeably in places (old §7.3: "its `manifestHash` … is exactly the `snapshotRoot`") while §3/§8 describe a V2 structured root where `manifestHash` is at most one leaf among several. Worse, the encryption boundary was never disambiguated: `CheckpointStore`'s `manifestHash` commits over **ciphertext** bytes (chunked after encryption, once §7.3.1 ships), while every chain-facing check in §4/§5/§7 is stated over **plaintext** semantics (tree roots, cursor, nullifiers). Under the old text, a routine key rotation or re-encryption (same plaintext, new ciphertext) would change `manifestHash` — and if `manifestHash` were ever substituted for the chain-checked root, **every** prior attested checkpoint would appear to fail its restore-time equality check even though nothing about the wallet's actual state changed. Fixed by strictly separating two commitment domains that must never be equated or substituted for one another.

**2.5.2 Two domains, never conflated.**

*Domain P (plaintext / semantic).* Everything the chain-facing verification layers (L0/L1/L3) check is computed over decrypted, canonicalized plaintext:

- `R_N^tree` — the per-tree Merkle root (zswap / dust) at finalized height N, as exposed on-chain.
- `cursorPlain` — the wallet's local sync cursor (endIndex, appliedIndex) in canonical encoding.
- `ownedNotesPlain` — **new in v3 (item 0, the core round-2 defect).** Canonical encoding of the wallet's own local owned-note set at N: for each note the wallet currently believes it owns, its commitment `cc_i` (the same value the zswap tree indexes, `ZswapLocalState`'s local note representation — `ledger-v8.d.ts`'s `QualifiedCoinInfo`/note-commitment shape, the wallet's actual local representation, not a re-derivation), its `mt_index`, and its value/type fields, sorted by `mt_index` for determinism. This is **exactly** the section whose absence from v2's equation was the round-2 defect: without it, the `snapshotRoot` equation bound the global tree frontier and the wallet's bookkeeping metadata (cursor, nullifiers) but never the wallet's *actual claim about which notes are its own* — the one thing that makes the snapshot *this wallet's* state rather than an interchangeable, equally-valid-looking one for the same cursor. See §2.5.5 for exactly what including this section does and does not prove, and how its own correctness is established at restore time.
- `nullifiersPlain` — canonical encoding of the wallet's known-spent set at N.
- `historyRef` — a reference into L3's on-chain `history` tree (§8), not a local blob.
- `dustPlain` — dust-tree state, if applicable.
- `manifestSectionPlain` — a plaintext *description* of which storage sections exist (which chunk ranges hold which logical section) — used only as an input section of the semantic root; this is a namesake of, but never equal to, `CheckpointStore.manifestHash` (Domain S below). The old draft's collision of these two names is exactly what produced the contradiction; v2 keeps the names visibly distinct in this section on purpose.

The **semantic root** (V2's `snapshotRoot`) is a domain-separated hash tree over exactly these plaintext sections, using the canonical encoding of §2.5.4:

```
snapshotRoot := H_dom("umbradb:snapshot:v3:root",
                        H(cursorPlain), R_N^tree, H(ownedNotesPlain), H(nullifiersPlain),
                        historyRef, H(dustPlain), H(manifestSectionPlain))
```

*(v3: `H(ownedNotesPlain)` added; the domain tag advances to `v3` since this changes the equation's input arity — an old `v2`-tagged root and a new `v3`-tagged root are never confusable, by the same domain-separation discipline §2.5.4 already applies to `encodingVersion`.)*

This is the **only** root any chain-facing equality check (L0 §2, L1 §5, L3 §3/§8) may compare against an on-chain value or attest to. `manifestHash` is never an input to `snapshotRoot` and is never compared against a chain-derived value.

*Domain S (storage / ciphertext).* `CheckpointStore.manifestHash` (`src/interfaces/checkpoint-store.ts`, confirmed against source — §7.3/item 10) is a SHA-256 over the ordered list of per-chunk SHA-256 hashes of the **stored** bytes — once §7.3.1 ships, that means AES-GCM ciphertext + nonce + auth tag, not plaintext. `manifestHash` proves only "the bytes I read back are the bytes that were written" (blob integrity — brief 03 §0's own theorem). It has **no chain-facing meaning** and **must not** be substituted for `snapshotRoot` in any restore-time equality check, attestation, or `AttestRecord`. Re-encryption (key rotation) changes `manifestHash` and **must not**, and by this construction cannot, change `snapshotRoot` — the two domains are independent under precisely that operation, which is the fix for "key rotation breaks every prior attested checkpoint."

**2.5.3 Full canonical attestation equation.** The single value the L3 contract commits to, and that a verifying client must reconstruct, binds all of the following (previously scattered, partial, and in places contradictory across §3/§7/§8):

```
salt        := H_dom("umbradb:attest:v2:salt", sk_attest, seq)
commitment  := persistentCommit(snapshotRoot, salt)
attestLeaf  := H_dom("umbradb:attest:v2:leaf",
                       genesisHash,                 // chain + network domain
                       walletKindTag, id,            // pseudonym, §8
                       encodingVersion,               // §2.5.4
                       blockHash, blockHeight,        // = N
                       R_N^tree, endIndex,
                       commitment,
                       seq, prevCommitment,
                       statementVersion)              // §3.5 — pinned vk/circuit version
history.insertHash(attestLeaf)        // NOT a bare commitment (v1 draft's gap)
attestations[id] := AttestRecord { attestLeaf, commitment, height: N, seq,
                                    prevCommitment, statementVersion, encodingVersion }
```

Binding at minimum, per the audit's list: chain genesis/network id, wallet kind/identity, encoding version, block hash/height/end-indices, semantic (plaintext) root, storage-manifest *description* (Domain P, never Domain S's hash), sequence number, previous commitment, and attestation-statement version. The L3 history-tree leaf now commits the **complete attestation record** (`attestLeaf`), not a bare `commitment` value as the v1 §8 sketch had it.

**2.5.4 Canonical encoding — promoted from secondary to blocking v1 requirement.** The v1 draft's §12 listed "canonical versioned snapshot-section encoding (CBOR/CDDL)" as secondary/non-blocking — but V2 (the design this document selects for v1) cannot be implemented without it: every hash above requires a byte-exact, versioned, canonical serialization of each plaintext section, or two semantically-identical snapshots (e.g. differing only in map key order) silently produce different `snapshotRoot` values, breaking every downstream equality check. **This is now §12 D0, blocking:** define a CDDL schema for each plaintext section (cursor, **owned-note set — new in v3**, nullifier set, dust state, manifest-section description) under an explicit `encodingVersion` tag carried inside `attestLeaf`. The owned-note-set CDDL entry canonicalizes the list of `{cc: bytes32, mt_index: uint, value: uint, type: bytes32}` records sorted ascending by `mt_index`, matching `ownedNotesPlain`'s definition in §2.5.2. A future encoding change ships as a new `encodingVersion`, never a silent reinterpretation of old bytes.

### 2.5.5 Owned-notes binding: what it closes, and restore-time correctness (new in v3 — the core round-2 fix)

*(New in v3. Resolves the follow-on question both Fable 5 and GPT-5.6 Sol raised once the missing `ownedNotesPlain` section was identified: given `ownedNotesPlain` is now part of the attested `snapshotRoot`, how is *its own* correctness established at restore time, when a zero-replay restore cannot in general re-run trial-decryption over the wallet's full historical range?)*

**What adding `ownedNotesPlain` closes.** Before v3, two snapshots could differ arbitrarily in their claimed owned-note set while producing an identical `snapshotRoot` — the equation was silent on ownership entirely, so nothing prevented substituting one wallet's note claims for another's (or a truncated/tampered subset) without invalidating any check. After v3, `ownedNotesPlain` is committed inside `snapshotRoot`, which is in turn the value `commitment`/`attestLeaf` bind on-chain (§2.5.3). **This closes *binding*:** a restoring client that recomputes `snapshotRoot` from a candidate envelope and compares it against the on-chain-attested `commitment` (§7.1(b)'s L3 step) is now cryptographically assured the owned-note set it is about to load is *exactly* the one that was attested at N — an attacker (hostile DB or otherwise) cannot substitute a different owned-note set into an otherwise-valid envelope without the root, and hence the restore's L3 check, failing.

**What it does not close, by itself: *completeness*.** Binding says "this is the owned-note set that was attested"; it says nothing about whether *that set itself* was correct and exhaustive at attest time. A wallet that attested a wrong or incomplete owned-note set (e.g., its own attest-time trial-decryption missed a note, or was run against a tampered feed) will faithfully re-derive the same wrong `snapshotRoot` at restore time and pass every check — the binding makes tampering *after* attestation detectable, not tampering *of* attestation itself. This is a different axis from, and does not change the scope of, the existing §5/§5.1 ciphertext-delivery-completeness residual, which is about whether the wallet's local trial-decryption (at whatever time it runs) saw every ciphertext it should have.

**The restore-time correctness question, resolved: option (b), combined with a named (a)-residual for the base.**

Three options were on the table (from the round-2 audit): (a) trust owned-notes correctness transported forward from attest-time honesty alone; (b) require the live sync tail `[N, tip]` to independently re-derive/cross-check owned notes going forward from N, bounding risk to only the base-at-N; (c) something else.

**Decision: (b) is the operative mechanism, with (a) explicitly named as the irreducible residual for the base set at N.**

- **Going forward from N — (b), and it costs nothing new.** §1's normal restore flow *already* requires the wallet to catch up `[N, tip]` live via the normal ADS-authenticated incremental sync (this was never optional — it's the design's own baseline, not a new mechanism invented for this fix). That live catch-up performs genuine trial-decryption over every commitment in `[N, tip]`, under the wallet's own viewing key, exactly as an always-online wallet would. So from the moment of restore forward, the owned-note set is **never** taken on attested faith — it is independently re-derived by the restoring device itself, continuously, using the same mechanism (and subject to the same §5.0/§5.1 ciphertext-delivery caveat) as normal operation. This is what "bounds the risk to only the base-at-N" means concretely: the attested `ownedNotesPlain` is used *once*, as the wallet's starting point at N, and every note added after N is independently earned by the restoring device's own decryption, not inherited from the attestation.
- **The base set at N itself — (a), named explicitly, not hidden.** There is no zero-replay mechanism that re-verifies the *base* `ownedNotesPlain` at N was itself exhaustively and correctly derived, short of re-running trial-decryption over the entire history through N — exactly the replay this design exists to avoid. This is not a new gap invented by adding the section; it is the same non-goal the document already states in §1/§10 item 4 ("we defend against a hostile *DB*, not a wallet compromised *at attest time*") — extended, explicitly, to cover the owned-notes section specifically, since prior to v3 that section didn't exist to have this property named against it. **This is added to §10's residual list as an explicit sub-item of item 4** (see §10), rather than left as an implicit consequence of "attest-time honesty" generically.
- **Why not (a) alone:** it would mean the entire fix is cosmetic — a hostile-at-attest-time or buggy wallet's bad owned-note set would ride forward unchallenged forever, since nothing downstream ever re-checks it. That is a materially weaker guarantee than what the live-tail mechanism gets for free.
- **Why not built as a bigger mechanism (something closer to (c)):** a scheme that re-validates the *base* set at N without replay would need either a consensus-level per-wallet ownership commitment (which does not exist — the zswap tree is global, per §5.0) or a third-party attestor re-running the wallet's own trial-decryption (which requires handing over the viewing key, a strictly worse privacy trade than the residual it would close). Given the live-tail mechanism already closes everything *except* the base, and the base is already an explicitly-scoped non-goal elsewhere in this document, building further machinery here would be solving a problem this design has already, correctly, declined to solve (§1's stated non-goal).

**Practical consequence for `restoreAnchoredCheckpoint()` (§7.1(b)):** no new restore-time check is added for `ownedNotesPlain` beyond the existing `snapshotRoot`-vs-`commitment` equality (which now covers it structurally). What changes is downstream: callers are expected to treat the owned-note set as **provisional-at-N, hardening as `[N, tip]` catch-up proceeds** — exactly matching §3.6's `verified-at-finalized-head → caught-up` state transition, which already exists for this reason. `AnchoredRestoreResult.residuals` (§7.1(b)) gains `"owned-notes-base-at-N is attest-time-honesty-only (§2.5.5/§10.4)"` as an explicit named residual string, so callers cannot mistake "root verified" for "owned-note set independently re-proven."

### 2.6 Trust tiers: consensus-reduced vs federated-quorum (unshielded, dust)

*(New in v2 — fixes item 8.)*

§1's rule — "every no-replay check must reduce to an on-chain commitment the wallet independently trusts" — is met **fully** by shielded L0/L1 (the zswap root reduces to consensus/finality, verified by an independent recompute the indexer's own ingestion pipeline `bail!`s on mismatch against). It is **not** met, in v1, by:

- **Unshielded** (§7.2's `unshieldedUtxos` proof): backed by a **signed indexer state-transition-history (STH)** plus monitors plus k≥2 independent indexers. This is a **federated/quorum trust model** — trusting a threshold of operators not to collude — not a reduction to an on-chain commitment. No node RPC today exposes a consensus-attested UTXO-subtree root to check against (§7.2 option 1 is explicitly "doesn't exist today").
- **Dust** (roots `@beta`, not node-cross-checked, per §2/§9's own text): a softer version of the same issue. The indexer computes and serves dust roots but nothing independently re-derives or cross-checks them against the node the way zswap roots are (the indexer's ingestion `bail!`s on a zswap mismatch; no equivalent dust check exists).

**Ratified policy:** this document must not apply the phrase "verified" / "trustless" / the DB-is-never-a-source-of-correctness theorem to the unshielded or dust paths without the qualifier attached. Concretely:

- The unshielded v1 mechanism is labeled, everywhere it appears (§7.2, §9), **Tier-F (federated quorum)**: signed-STH + k-of-n monitor cross-check, trusting a *threshold of indexer operators*, not consensus.
- Dust is labeled **Tier-F-lite**: single indexer, `@beta`, not cross-checked at all pending a node dust-root RPC.
- §10's residual trust list carries this forward as an explicit, standing item (§10 item 3), not a footnote.
- This is a scope acknowledgment, not a deferred bug: v1 still ships Tier-F unshielded verification (real value over "trust the DB blindly"), it is just never described with consensus-reduced language. True reduction requires the node/protocol changes already named in §7.2 (options 1/3).

### L3 — Self-certification

The layer that (a) gives a **cold-booted** wallet consensus-anchored latest-pointer detection — conditional on a fresh finalized view (§4, §10 item 2) and pinned attestation semantics (§3.5) remaining sound, not an unconditional "consensus-grade" guarantee as the v1 draft put it — (b) transports attest-time correctness forward, conditional on attest-time honesty (§10 item 4) — and (c) optionally proves S's correctness to a third party. This is the design's biggest decision — §3.

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
| New trust surface | contract governance (05 Q4) — **pinned immutable in v1, §3.5** | **audited hand-written IR + pinned vk, no compiler attestation** (07 §6.3) | same + a research prover to audit |
| Cost / effort | small circuit, deploy once | engineering: author+audit one IR | **research-grade heavy lift** (08 §5) |

**Recommendation — v1 ships (c), the Compact "Attested Manifest Root" (brief 05, variant V1b+V2).** The decisive argument: the feature's *raison d'être* is restore from a **REMOTE/UNTRUSTED** DB after **memory loss**, and in that exact scenario the wallet has no local monotonic counter, so the only thing that can tell a cold-booted wallet "the DB just served you an old-but-genuine snapshot" is a monotonic pointer held **outside the DB's control, on the one authority this design designates as its root of trust** — the chain's finalized head (that designation is itself contingent on GRANDPA's safety assumption and a weak-subjectivity-bootstrapped authority set, §10 item 1 — "the chain is trusted" inside this document's threat model, not unconditionally in absolute terms; the v1 draft's phrasing overstated this). Midnight's transcript/CAS execution model makes this rollback protection *structural and free*: a replayed old `attest` tx re-runs its transcript against current state, the recorded height-monotonicity `assert` no longer holds, and the tx fails (brief 05 §4.3, C7). **Narrowed in v3 (item 9 — the v2 text overclaimed "closes threats A1–A4," contradicting §2.6/§5's own adversarial matrix, which places ciphertext-downgrade under A1 and explicitly states L0/L1 don't catch it).** One small shared contract (bigger anonymity set) supplies exactly three properties: **latest-pointer rollback resistance** (a replayed old `attest` tx fails the height-monotonicity `assert` — closes A2 for a cold-booted or actively-rechecking wallet, §3.6), **identity separation** (the per-wallet pseudonym `id` derived from `sk_attest` prevents one tenant's attestation from being mistaken for another's — closes A3), and **attestation authorization** (only the holder of `sk_attest` can produce a valid `attest` transcript for a given `id` — closes A4, forgery). It does **not** close A1 (omission) on its own — commitment-level omission within the attested tree is L1's job (§ "L1 — Bounded-scan completeness"), not L3's, and ciphertext-level omission (a note's evidence downgraded to `None`) is outside what any on-tree commitment can see at all, tracked as the standing §5/§5.0 residual. All three properties the contract does supply are further **conditional on** a fresh finalized view (A5, unclosed, §4/§10 item 2) and honest attest-time behavior (§10 item 4) remaining true; the contract does not eliminate either, and does not by itself provide any post-activation safety story (that gap, and its fix, is §3.6).

Ship **variant V1b+V2**: latest-pointer semantics (the anti-rollback CAS) **plus** an on-chain `history` Merkle tree (turns *intentional* point-in-time restore into a verifiable first-class op, pairs with UmbraDB's TemporalKV) **plus** a Merkle-committed structured snapshot root over domain-separated sections (cursor/notes/nullifiers/history/dust/manifest — precisely defined in §2.5), enabling partial verification and later selective disclosure (brief 05 §4.4, §5.1). Carry `prevCommitment` in `AttestRecord` **from day one** (costs 32 bytes; keeps the §6.2 hash-chain-of-custody and the IVC upgrade open — brief 05 §6.2, brief 08 §8). Commit a *hiding* `persistentCommit(snapshotRoot, salt)` with salt re-derived from `(sk_attest, seq)` so a hosted DB cannot even *identify* whose snapshot it holds (brief 05 §7). Derive `sk_attest` at a dedicated HD path, purpose-separated from spend/viewing keys (brief 05 §4.5).

For a **purely-local, single-writer, trusted** UmbraDB the attestation is optional — UmbraDB's own `Formal/STORAGE_ALGEBRA.md` §6 already concluded content-addressing + AES-GCM suffice there and "no ADS/Merkle layer is warranted" (brief 03 §7). L3 becomes mandatory the moment the DB is remote or the checkpoint is exported.

**Recommended v1.1 companion — (a) the offline v-lightweight ZK certificate [07].** Also buildable today (hand-written `IrSource`, proven by the running proof-server via `/prove` with caller-supplied `ProvingKeyMaterial`, verified off-chain by the standalone `VerifierKey::verify` — brief 07 §1.5, §4). It **composes** with (c): (c) answers "is this the latest S I committed?"; (a) answers "is S actually my correct, on-chain-anchored state at finalized N?" privately, with zero footprint, and provably to a third party (brief 07 §5). It is **not** a v1 blocker because it does not close the rollback gap and it introduces a genuinely new trust surface — a hand-authored IR with **no Compact-compiler correctness attestation**, whose `vk` must be independently audited and pinned in trusted config (brief 07 §6.3). Ship it once that audit discipline is in place.

**Deferred / research-grade — (b) the recursive IVC ratchet [08].** Midnight's own `midnight-zk` ships the machinery (`aggregation/src/ivc/`, single-curve BLS12-381 atomic accumulation, O(1) proof+verify regardless of #checkpoints; the trees' internal digests are already Poseidon so the completeness fold is cheap in-circuit — brief 08 §2, §3.4). But it needs a **new native-Rust prover** (not `:6300`) + a WASM/TS bridge (heavy sidecar prover + light verifier), and its per-step constant is a full in-circuit KZG self-verifier (K≥17, seconds/step — brief 08 §2.2, §5). **It earns its heavy lift only for the v-strong completeness case** (a proof ∝ prefix-leaves that recursion folds into O(1)+delta); for the v-lightweight cert, a fresh standalone proof each checkpoint is simpler and recursion buys little (brief 08 §5). Keep the door open by carrying `prevCommitment`/frontier/`R_N` in the record and `AssignedState` shapes; do not build for v1.

### 3.5 vk/circuit succession & v1 immutability commitment

*(New in v2 — fixes item 4, the Mithril-CVE-class gap.)*

The v1 draft chained snapshot **data** forward (`prevCommitment` in `AttestRecord`) but never chained the **verifier/circuit** forward, and filed "pinned vk versioning across protocol upgrades" as merely secondary. If a future circuit/vk version's authority came from contract governance alone rather than being cryptographically chained from the prior circuit's own attested history, that is the exact failure class behind the real Mithril vulnerability **GHSA-724h-fpm5-4qvr** — protocol parameters traveling as unauthenticated metadata next to a signature, not bound inside what's signed.

**Decision (ratified here): option (a) — full v1 immutability, hard-pinned.**

- Client config **must** hard-pin: `contractAddress`, `attestCircuitVkHash`, `attestStatementVersion` (the `statementVersion` field threaded through `attestLeaf`, §2.5.3). No dynamic vk discovery, no "latest deployed contract" resolution, no automatic following of a governance-selected successor.
- If Midnight governance deploys a new attestation contract/vk version, v1 clients simply do not follow it — they keep verifying against the pinned v1 attestation history until an explicit client software update repins them. This makes the pin, and the software update that changes it, the auditable trust event — not something on-chain governance alone can silently trigger.
- Filed as an explicit residual-trust item, §10 item 4 (absent from the v1 draft's list, which was itself the gap): a compromised or coerced software update that changes the pin is exactly the same trust class as "the client software is honest" (already implicit everywhere) but is now named for this specific component, because it is where an unaudited pin change would have outsized blast radius (silently accepting a malicious successor circuit).

**Why (a) over (b) for v1 scope:** this matches the "ship v1 conservatively" pattern the rest of this document already uses — Zcash-parity completeness residual (§5), deferred in-circuit finality (§4), deferred IVC ratchet (§3). Building unaudited successor-authentication machinery under this design's timeline would be a fifth piece of new, unaudited cryptographic infrastructure; deferring it while explicitly scoping v1 to immutability is lower-risk and keeps the residual honest rather than hidden. This is genuinely "narrow/future-only" exactly because v1 clients never auto-follow a successor — it would become live/dangerous only if a future version relaxed that, which is precisely what option (b) below is for, deliberately gated behind its own future ratification.

**Option (b) — successor-certificate mechanism — specified, not built, the named v1.1+ path.** A `migration` record type, signed/proved under the **current** (pinned v1) attestation semantics, binding: `nextContractAddress`, `nextVkHash`, `nextStatementVersion`, `nextEncodingVersion`, `networkId`/`genesisHash`, and `latestHistoryRoot` (the current contract's own `history` tree root at migration time). The old, already-trusted circuit is the one that gets to vouch for the new one, chained from the pinned genesis version forward — closing the Mithril-CVE-class gap by construction, because succession is bound *inside* what's cryptographically authenticated rather than traveling as unauthenticated sidecar metadata. Clients that later choose to follow a successor validate this migration chain rather than trusting a governance announcement directly. Not built for v1; carried here so the shape is decided in advance rather than improvised under upgrade pressure.

### 3.6 Rollback recovery & operation state machine

*(New in v2 — fixes item 3: detection-only rollback story.)*

The v1 draft's L3 detected a rollback at cold-boot restore time and stopped there — no story for an already-active wallet, no periodic recheck, no quarantine/recovery transition, and §11.4's tests covered only cold-boot rejection ("accept stale-but-genuine state, resume, discover later" was untested and unspecified).

**States:**

```
unverified ──► verified-at-finalized-head ──► caught-up ──► active ──► quarantined
                                                                │            │
                                                                └────────────┘
                                                          (periodic/pre-spend recheck
                                                           finds divergence)
```

- **`unverified`** — envelope decoded, no L0/L1/L2/L3 checks run yet.
- **`verified-at-finalized-head`** — `restoreAnchoredCheckpoint()` (§7.1(b)) has returned with `verificationLevel` at least `"L0+L1"`, ideally `"L0+L1+L3"`, against horizon N.
- **`caught-up`** — live incremental sync has advanced `[N, tip]` and the wallet's local view matches the current chain tip.
- **`active`** — the wallet accepts user-initiated operations (new syncs, spends, new attestations).
- **`quarantined`** — reachable only from `active`, entered when a recheck (below) finds the wallet's active state diverges from the current on-chain attestation pointer for its own `id`.

**Recheck policy (v1 requirement, not optional):**

- **Pre-spend:** before any outbound spend, re-query the L3 attestation pointer for this wallet's own `id` and compare its `seq`/`height` against the local high-water mark this device's active state descends from. This is mandatory, not best-effort — it is the cheapest point to catch a stale-but-genuine base before it produces an unrecoverable action.
- **Periodic:** while `active`, re-run the same pointer check on an operator-configurable interval (v1 default: every N blocks or M minutes, whichever comes first). This closes the "resumed on stale state and never spent" gap the pre-spend check alone would miss.
- **Divergence condition:** if the on-chain pointer shows a **higher** `seq`/`height` with a **different** `commitment` than what this device's active state descends from, that is rollback (or legitimate multi-device advancement — see below) discovered post-activation.

**Recovery transition (`active → quarantined → …`):**

1. **Freeze** all outbound operations (spends, new attestations) immediately on detecting divergence.
2. **Do not trust** the current in-memory/local-DB state as a base to build further from.
3. **Re-anchor — retrieval made concrete (v3, item 10; the v2 text said "the pointer's commitment/historyRef identifies a checkpoint," which was never actionable: `AttestRecord` carries no storage locator, and `commitment` is a *hiding* commitment by construction (§3's `persistentCommit(snapshotRoot, salt)`), not a lookup key.** Given §7.1(b)/item 4's fix unifying `record.seq` and `envelope.seq` into one sequence space, the concrete retrieval step is: fetch `record := fetchAuthenticatedAttestation(...)` for this wallet's `id` against the current finalized tip (§7.1(b)), then call `CheckpointStore.load(walletId, networkId, record.seq)` directly — `CheckpointStore`'s own per-`(walletId,networkId)` monotonic sequence *is* the authenticated locator, once `record.seq` is known to equal the envelope's own `seq` field. No new `AttestRecord` field is needed. Re-run `restoreAnchoredCheckpoint()` against the loaded envelope; it will independently re-derive `snapshotRoot` and check it against `record.commitment`, so a wrong or stale load is still caught by the normal L3 equality check, not trusted blindly. If the load fails (`CheckpointNotFoundError`, pruned, or the loaded envelope fails its own L0/L1 checks), fall back to a full replay from the last independently-authenticated floor (§1's normal `[N, tip]` catch-up mechanism, just triggered from a deeper floor than usual). A residual note: if the checkpoint blob lives in a *different* UmbraDB instance/backend than the one currently configured (e.g. the wallet switched storage providers), `record.seq` alone cannot locate it — this cross-backend case is out of scope for v1 and named here rather than silently assumed away.
4. **In-flight submitted transactions** built on the rolled-back base: re-validate each against current chain state before resubmission. This generalizes §5's "first spend re-validates" mechanism to *every* in-flight transaction post-quarantine, not just the first: any whose witness path or nullifier set no longer matches current state is discarded and rebuilt, never blindly resubmitted.
5. **Multi-device CRDT deltas** (§2 L2 bullet 3) built causally on top of the rolled-back base are equally untrusted: the BFT-CRDT hash chain from that point forward is re-rooted at the new verified floor; deltas that don't re-derive cleanly against it are flagged for manual/policy-driven conflict resolution, never silently replayed. (Note: a divergence at this check can also be legitimate — a sibling device advanced the pointer honestly while this device was offline. The recovery path is the same either way: re-anchor to the current pointer's state before resuming; the distinction between "attacker rollback" and "honest sibling advance" matters for user-facing messaging, not for the mechanical recovery steps.)
6. Only after steps 1–5 does the wallet transition back to `caught-up → active`.

Corresponding tests are added to §11.4/§11.5 below.

---

## 4. Finality trust (brief 10)

L0's anchor check proves *agreement* between the wallet's recomputation and whatever answered the query — it does **not**, by itself, prove that answerer is honest, nor that N is genuinely finalized (brief 01 §6 gap 1). Brief 10 closes this as far as it can be closed — and, fixed in v2, the values it closes must all come from **one coupled tuple**, not several independently-fetched facts that happen to agree (item 9).

**The v1 draft's gap:** the restore pseudocode independently fetched a root via `anchor.blockHash` and independently called `verifyFinality(blockHeight, finalizedHash)` — nothing forced the finality proof to be about the *same* `(blockHash, treeRoot, endIndex)` tuple actually being checked. Two independently-true facts are not the same as one coupled proof; a malicious or compromised endpoint could in principle serve a genuinely-finalized-but-wrong block's finality proof alongside a different block's tree root, and the old flow had no mechanism forcing them to agree beyond "the caller happened to pass matching-looking arguments."

**Fixed — `verifyFinalizedTuple`, a single coupled derivation:**

```
horizon := verifyFinalizedTuple(endpoint, claimedBlockHash):
  1. header := fetch header for claimedBlockHash
  2. proof  := state_getReadProof([twox128("Midnight")+twox128("StateKey")], claimedBlockHash)
  3. R_N, endIndex := sp_state_machine::read_proof_check(header.state_root, proof, StateKey)
       // couples R_N/endIndex to THIS header's own state_root -- not a second, independent query
  4. justification := grandpa_proveFinality(header.number)
  5. GrandpaJustification::verify_with_voter_set(justification, header.hash(), header.number,
                                                   trusted_authority_set)
       // couples finality to the SAME header.hash() derived in step 1
  6. return { blockHeight: header.number, blockHash: header.hash(), R_N, endIndex,
              finalizedHash: header.hash() }
```

Every subsequent check — L0 on-chain agreement, L1's tail-scan upper bound, L3's attestation height comparison — consumes **only** this returned `horizon` object; none of them re-fetch `blockHash`/`R_N`/finality independently. This is threaded through `restoreAnchoredCheckpoint()` in §7.1(b).

**Recommendation: Tier-1 — a bounded, one-shot GRANDPA justification check + state-read-proof per restore.** A wallet holding a trusted `(set_id, authorities)` (bootstrapped once from the genesis GRANDPA authority set in the public chain spec, or any set it once verified — the same weak-subjectivity seed every BFT/PoS light client has) fetches `grandpa_proveFinality(N)` from **any** (now untrusted) endpoint, verifies the Ed25519 threshold-signature justification locally via `GrandpaJustification::verify_with_voter_set` (`polkadot-sdk .../grandpa/src/justification.rs:166-233`), walking authority-set handoffs forward with warp-sync fragments if needed (brief 10 §1–2). Then `state_getReadProof(...)` + `read_proof_check` reads `pallet_midnight::StateKey` — hence R_N — out of N's trie, checked against the header's *own* `state_root`, never against the responder's word (brief 10 §3; `pallets/midnight/src/lib.rs:341-347`). Both RPCs are **live on Midnight nodes today** (`node/src/openrpc.rs:91,96-98,481,485-487`); this is wallet-SDK plumbing, not a node change. It is a bounded on-demand check (one historical N, not a streaming daemon), which is exactly the restore shape.

- **Tier-0 (ship-now fallback, before the justification verifier is built):** k-of-n RPC/indexer cross-check — query ≥2–3 independently operated endpoints for `(N, blockHash, R_N)` and require exact agreement (brief 10 §5, brief 02 §1 NxN). Closes "one indexer lies alone"; does **not** close coordinated-operator or single-vendor-hosts-everything.
- **Tier-2 (only if continuous trustless sync becomes a product requirement):** embed `smoldot` via `subxt-lightclient` (already latent in the dep graph — brief 10 §2). Not needed for one-shot restore.

**In-circuit finality — DEFER.** Folding GRANDPA into the IVC step is *expressible* (the `curve25519`/`sha2_512`/`blake2b` chips exist in `midnight-zk`'s `ZkStdLibArch`) but **SNARK-hostile**: Ed25519 emulation + SHA-512 per precommit × up to ⅔ of `MaxAuthorities=10_000`, plus Blake2-256 trie hashing — a single justification can dwarf the whole zswap circuit and blow past the k=25 ceiling (brief 08 §6). The wallet must obtain trusted R_N off-circuit *anyway* (it is the IVC's public-input anchor), so moving a cheap off-circuit Ed25519-batch-verify into an extremely expensive in-circuit one is a bad trade for the wallet's own restore. Keep three concerns in three layers: **recursion** transports "each step folded against the root the verifier supplied"; **Tier-1 off-circuit** supplies "that root is genuinely finalized R_N"; **the ADS** supplies "the folded delta was complete" (brief 08 §6). Design `AssignedState` to carry R_N + the finalized block hash so in-circuit finality *could* be added later as a self-contained-PCD upgrade for a third-party auditor who won't run its own finality check (the Mina model) — but ship with finality off-circuit.

---

## 5. The completeness SOUNDNESS gap (briefs 06/07/09)

### 5.0 What L0, L1, and local trial-decryption each actually prove (rewritten — item 7)

*(New in v2. This section replaces the v1 draft's overstated "L0 proves S is exactly correct" and "first spend re-validates completeness" claims with a precise account, and unifies what were previously two separately-described gaps into one correctly-scoped residual.)*

The zswap commitment tree is **global** — one tree, one root, shared identically by every wallet observing block N. This has a direct consequence for what root-equality checks can and cannot prove:

- **L0 alone** proves: the snapshot's reconstructed tree frontier (the full leaf set through `endIndex`) is bit-identical to the chain's own frontier at N. It says nothing about which subset of those leaves belong to *this* wallet — a snapshot with a perfectly correct global frontier could still have wrong, truncated, or fabricated "owned notes" bookkeeping alongside it, undetected by L0.
- **L0 + L1 together** prove: the *entire* global commitment set through tip — not just the frontier at one height, the full ordered leaf sequence — is present, uncorrupted, untruncated, and unreordered (§ "L1 — Bounded-scan completeness" above). This is still a property of the *shared* tree, not of ownership.
- **What actually establishes "my note list"** is the wallet's own **local trial-decryption**, keyed by its viewing key, run over the leaf set L0+L1 have just proven complete. No external party can forge or silently alter this step, because the wallet performs it itself with a secret only it holds — decryption success/failure for a given leaf is not something a malicious indexer can fake. **Provided** the wallet actually received every output's ciphertext to attempt decryption against, this closes wallet-identity binding completely.
- **That proviso is exactly the ciphertext-delivery completeness residual already described below (§5, "Ciphertext-downgrade under-count").** A malicious indexer that omits or downgrades one output's ciphertext to `None` makes that leaf's tree-commitment still present and still counted by L0/L1 — but the wallet never receives the bytes needed to test "is this mine?", so a genuinely-owned note silently vanishes from the owned set with **no signal from L0 or L1 that anything is wrong.**

**Conclusion, stated precisely for the first time in this document:** items 7 and 5 of the audit are the *same* gap seen from two angles — "L0/L1 doesn't bind wallet identity" and "ciphertext delivery isn't proven complete" are one residual, not two. No new cryptographic primitive is required beyond what §5 already recommends (NxN cross-indexer checks, the event-stream contiguity signal, the detection-tag overlay, eventual node-level accumulator/body-proof); what was needed, and is now done, is retracting the false "L0 proves S is exactly correct" claim and stating the actual, narrower, correctly-scoped guarantee everywhere it matters (§1, §2, here, §10).

**v3 correction (round-2 audit, item 0):** the paragraph above was itself incomplete in one specific way, caught independently by Fable 5 and GPT-5.6 Sol. "No new cryptographic primitive is required" was correct — but it was read (reasonably, given the v2 text) as implying the *governing commitment equation* was already adequate once the prose was fixed. It was not: §2.5.2's `snapshotRoot` equation had no owned-notes section at all, so nothing this section describes ("what actually establishes 'my note list'" — local trial-decryption) was ever *bound into the attested commitment*. A wallet's local trial-decryption output could be correct and the attested `snapshotRoot` would still not reflect it, because that output was never a committed input. **Fixed in §2.5.2/§2.5.5 (new in v3):** `ownedNotesPlain` — the wallet's own local trial-decryption *output* — is now a required section of `snapshotRoot`. This closes *binding* (the attested root now actually reflects a specific owned-note claim, and a substituted or tampered claim changes the root) — it is a distinct property from the *completeness* this section's own analysis is about (whether trial-decryption saw every ciphertext it should have), which remains open exactly as scoped above. See §2.5.5 for the full treatment, including how the new section's own restore-time correctness is established without requiring historical replay.

**The "first spend re-validates completeness" claim, corrected.** The v1 draft's §5 (Penumbra-style mitigation ③) claimed a first post-restore spend "re-validates tail completeness for free." This overstates what happens: a spend re-validates only that the **one specific input being spent** has a witness path reaching a real, currently-reachable historical root — it demonstrates that single note's tree-membership held. It says nothing about notes the wallet never attempted to spend, and in particular gives **zero** signal about a systematically-omitted ciphertext for a *different* input the wallet never noticed was missing. It is retained as one mitigation signal among several (NxN, contiguity check, detection tag), not described as validating overall completeness.

### 5.1 Phasing (unchanged reasoning, restated with the corrected claim)

The ADS (L1) closes *commitment*-completeness for the tree it authenticates (still subject to §5.0's scoping — it authenticates the shared tree, not wallet-specific ownership). Two residuals survive, both narrower than generic omission, both reducible to the same missing primitive — an authenticated binding from an on-chain consensus commitment to **off-tree** data — and, per §5.0, both are facets of the *same* wallet-identity-binding gap, not independent concerns:

1. **Ciphertext-downgrade under-count (brief 06 §2.4).** Each on-chain output's note ciphertext lives in the *transaction body* (`zswap/src/structure.rs:307`, `Output.ciphertext: Option<…>`), **not** in the commitment tree — committed only by the block's Substrate `extrinsicsRoot`, which the indexer does not surface. The root check proves every *commitment* is present; a malicious indexer that downgrades a leaf's evidence to `None` makes a genuinely-yours note invisible. The ZK completeness proof inherits this exactly: its "not-mine" branch is only sound if it decrypts the *authentic* ciphertext, which nothing on-tree guarantees (brief 07 §3.1). **This is a soundness wall no proving power fixes — orthogonal to recursion** (brief 08 §7), and is exactly the residual identified in §5.0.
2. **Spend-hiding (brief 06 §3).** Nullifiers are plain hash sets with no exposed proof/non-membership API (`merkle_patricia_trie.rs` has `insert/lookup/remove` but no `prove`/`verify`). But **only the wallet can spend its own notes** (the nullifier needs the coin secret key), so a hidden spend is an **over-count**, self-correcting at spend time (the network rejects the duplicate nullifier) — it bites for real only in the multi-device case where device B spent and device A restores a pre-spend checkpoint (brief 06 §3), a case now additionally covered by §3.6's recovery state machine for the "discovered post-activation" variant.

**Recommended phasing:**

- **v1 — ship with the Zcash-parity residual, explicitly documented (see §5.0 for the precise claim it makes, not "S is exactly correct").** This matches every production shielded chain: they all *verify the tree* and *trust the server for delivery* (brief 09 §8 — Zcash, Penumbra, Aztec, Namada). Mitigate with (a) NxN cross-indexer checks — two honest indexers disagree on the evidence for a given `mt_index` (brief 06 §2.4 option 1); (b) the event-stream contiguity check — `ZswapOutput` carries `mt_index`, so the wallet confirms the delivered events cover a contiguous run with no gaps, a second cheap completeness signal that must agree with the tree size (brief 06 §2.4); (c) Penumbra-style **first-post-restore-spend re-validation** — scoped correctly per §5.0: it re-validates the spent input's own tree-membership, one signal among several, not overall completeness.
- **Near-term overlay — Aztec-style "constrained delivery" via a Compact-emitted detection tag (brief 09 ③).** Require every shielded output to also emit a recipient-bound tag (folds into the same L3 attestation contract, same `persistentHash`/`poseidon2` primitive), turning an omitted ciphertext into a detectable event. **Honest limit:** an *overlay* tag is not consensus-emitted, so a malicious indexer can still omit the *tag* — it raises the bar but does not fully close the gap (brief 09 §10).
- **Long-term — the only true close is a node/protocol change.** A Substrate **body-inclusion proof** (indexer serves ciphertext + `state_getReadProof` path to `extrinsicsRoot`, wallet checks vs trusted header) or a per-block **header-committed ciphertext accumulator** (MMR of `(mt_index, H(evidence))`) for ciphertext-delivery; a **nullifier-set non-membership proof** (CONIKS-style absence path) or an **authenticated nullifier accumulator** for spend-completeness (brief 06 §2.4 option 2/3, §3). Flag both to the Midnight node team.

**Council decision:** ratify shipping v1 with the documented Zcash-parity residual (§12 D2), stated per §5.0's precise scoping. It is the honest, industry-standard position; over-claiming completeness would be the design's biggest integrity risk — see §12's closing risk statement, unchanged in v2.

---

## 6. Privacy-from-scanner vs completeness (brief 09)

L2 encrypts the snapshot *at rest* (once §7.3.1 ships — see the item-10 correction in §2), but the entity that **feeds** the wallet — the indexer, or a remote UmbraDB acting as a scan accelerator — still learns which notes are ours today, because selecting "our" data requires the viewing key (the Monero / Penumbra-view baseline every other system is trying to escape — brief 09 §1.1, §5). This is the single biggest gap the prior-art study exposes, and it is orthogonal to completeness.

**Recommendation: overlay-now, consensus-later.**

- **v1.x overlay (shippable today, no protocol change):** an Aztec-style **detection tag** — `poseidon2(detectionSecret, index)`, contract-emitted, indexed by the node/indexer — bound to a per-address detection secret and folded into the L3 attestation contract's key hygiene (brief 09 ①, Aztec `getPrivateLogsByTags`). The untrusted UmbraDB/indexer then serves "logs matching these tags," never learning ownership beyond the tag set. This converts the remote-DB threat model from "trusted for privacy" to "learns only an opaque superset" — the property the task asked for.
- **Long-term (Midnight protocol change we don't control):** a **consensus-emitted clue key** in the address format, Penumbra-FMD style (`ck_d` in the address, consensus rules on clue count + precision → *detection ambiguity* the server cannot disambiguate, **and** constrained delivery). This is the gold standard and it closes **both** privacy and the ciphertext-delivery completeness gap of §5 at once — because the same tag, if consensus-emitted, makes omission an on-chain violation (brief 09 ①-native, ③). Flag to the Midnight team alongside §5's body-proof/accumulator asks.
- **Watch, don't build — OMR as the ceiling.** Oblivious Message Retrieval (Liu–Tromer) is the only primitive giving privacy **and** completeness against a fully malicious server, post-quantum — but ~100 MB detection keys and per-message FHE make it impractical (Aztec's own verdict; brief 09 §7). Research track.

**The unavoidable tension (brief 09 §10), for the council:** an overlay tag buys privacy but a malicious indexer can *omit* the tag, re-opening the very completeness gap it was meant to close — and the anchor/ADS only detects omission of *committed* leaves, not of *off-tree* tags. So the honest overlay position is "privacy win now; completeness still bounded by NxN + first-spend-revalidation (scoped per §5.0), fully closed only by the consensus clue key later." §12 D3.

---

## 7. Delivery — the two PRs and the persistence substrate

### 7.1 SDK PR — `midnight-wallet` (additive, no breaking change to existing `restore()`; see §7.1(d) for the legacy path)

**(a) Versioned anchor field on the snapshot schema** (`shielded-wallet/src/v1/Serialization.ts:67`, symmetric for dust/unshielded). *Rewritten in v2 to fix item 2 — the fail-open envelope migration bug.*

The v1 draft declared `anchor` `Schema.optional` "so old snapshots still decode," then contradictorily described anchor+cursor as "mandatory," and `restoreVerified()` only ran verification `if (anchor)` — meaning an anchor-less envelope (a genuinely old snapshot, **or** a freshly fabricated envelope that simply omits the field) sailed straight through to `startFirst(...)` with **zero** verification, from a function named "Verified." This is threat A2 (rollback) walking in the front door.

**Fixed:** the envelope schema is versioned. Any envelope claiming `envelopeVersion: 2` carries a **non-optional** `anchor`:

```ts
envelopeVersion: Schema.Literal(2),
anchor: Schema.Struct({                 // MANDATORY for any v2 envelope -- no longer Schema.optional
  zswapMerkleTreeRoot: Schema.String,   // from ledger.ZswapLocalState.merkleTreeRoot
  zswapEndIndex: Schema.BigInt,         // the range LOWER boundary for the L1 tail proof
  blockHash: Schema.String,
  blockHeight: Schema.Number,
  finalizedHash: Schema.String,         // superseded at verify-time by verifyFinalizedTuple's horizon (§4)
}),
snapshotRoot: Schema.String,            // Domain P root, §2.5.3 -- what L3 actually attests to
seq: Schema.Number,                     // v3 (item 4): this IS the attestation contract's seq --
                                         // see the note below, not a second, independent counter
```

An envelope with **no** `envelopeVersion` field at all is, by definition, pre-upgrade legacy — it cannot enter `restoreAnchoredCheckpoint()` (§7.1(b)) at all; decoding routes it exclusively to `restoreLegacyUnverified()` (§7.1(d)), which can never return a "verified" result. A malformed v2 envelope (claims `envelopeVersion: 2` but is missing/corrupt `anchor`) is a hard schema-validation failure, not a silent fallback.

**`seq` is one shared sequence space, not two — new in v3, item 4.** The v2 sketch let `envelope.seq` (the checkpoint's own sequence, set by `CheckpointStore.save()`, §7.3) and `AttestRecord.seq` (the attestation contract's internal per-`id` counter, incremented once per `attest()` call, §2.5.3/§8) drift independently: the salt derivation used `record.seq`, but the local high-water mark was updated from `envelope.seq`, with nothing forcing them to agree. **Resolved by unifying them:** the v1 shape is one attestation per checkpoint save — the wallet's client code drives both `CheckpointStore.save()`'s persisted `seq` field and the `attest()` call's `seqAsBytes(prev.seq + 1)` witness from the *same* locally-tracked counter, so `envelope.seq === record.seq` is an invariant of correct operation, not a coincidence. §7.1(b) now asserts this equality explicitly at restore time (a mismatch is a strong tamper/substitution signal, not a benign divergence) and updates the local high-water mark from `record.seq` — the chain-authenticated value — never from `envelope.seq`, which is merely the untrusted DB's claim about the blob it served.

`buildSnapshot` reads `w.state.merkleTreeRoot` (already on `ledger.ZswapLocalState`, `ledger-v8.d.ts:2996`; dust via `commitmentTreeRoot()`/`generatingTreeRoot()`, `:1596,1601`) plus the block anchor from the new indexer field (7.2), and computes `snapshotRoot` per §2.5.3.

**Legacy migration policy:** on the first successful post-upgrade `save()` of a legacy wallet, the SDK forces a fresh full anchor capture (re-derives `R_N`/cursor/`endIndex` at the current sync tip) and writes `envelopeVersion: 2` — a **forced re-anchor on first post-upgrade save**. `SnapshotStorage` exposes `requiresReanchor(summary): boolean` so callers can surface this to users/telemetry.

**(b) `restoreAnchoredCheckpoint()` — renamed from `restoreVerified()`, and rewritten to actually implement its own flagship guarantee.** *Rewritten in v2 to fix item 6 (a real functional gap: the old sketch ran L0+finality+L1 only, took no `sk_attest`, ran no L3 check and no L2 sequence check, yet returned a bare `Promise<Wallet>` as though it had) — and to fix item 9 (all checks now consume one coupled `horizon` tuple, §4). **Rewritten again in v3** to fix round-2 items 1 (L3 fetch was unauthenticated, present-but-mismatched silently downgraded), 2 (only `commitment`/`height` were checked, not the full `attestLeaf`), 3 (vk/statement pins were prose-only), 4 (`record.seq`/`envelope.seq` could silently diverge), 5 (`horizon`'s type was missing `R_N`/`endIndex`), and 6/Opus (the L1 tail check was a no-op because its upper bound was derived from the checkpoint's own block).*

```ts
type VerificationLevel = "L0" | "L0+L1" | "L0+L1+L3";

interface HorizonTuple {                       // v3 (item 5): now carries the full tuple §4 returns
  blockHeight: number; blockHash: string; finalizedHash: string;
  R_N: string; endIndex: bigint;
}

interface AnchoredRestoreResult {
  wallet: Wallet;
  verificationLevel: VerificationLevel;      // callers can no longer mistake a partial-tier
                                              // restore for the full L3 guarantee
  horizon: { checkpoint: HorizonTuple; tip: HorizonTuple };   // v3: TWO horizons -- see below
  residuals: readonly string[];              // e.g. ["ciphertext-delivery-completeness (§5.0)",
                                              // "spend-hiding (§5.1)", "attest-time-honesty (§10.4)",
                                              // "owned-notes-base-at-N is attest-time-honesty-only (§2.5.5/§10.4)"]
}

static async restoreAnchoredCheckpoint(
  serialized: string,
  conn: {
    indexerHttpUrl: string; grandpaEndpoints: string[]; contractAddress: string;
    attestCircuitVkHash: Bytes32;            // NEW v3 (item 3) -- was prose-only in §3.5
    attestStatementVersion: number;          // NEW v3 (item 3) -- was prose-only in §3.5
    genesisHash: Bytes32;
  },
  identity: { skAttest: Bytes32 },           // required to derive the L3 pseudonym id
): Promise<AnchoredRestoreResult> {
  const envelope = deserializeEnvelope(serialized);
  if (envelope.envelopeVersion !== 2 || !envelope.anchor) {
    throw new SnapshotEnvelopeUnverifiableError();     // fail-closed (§7.1(a)/item 2), never silently downgrades
  }
  const anchor = envelope.anchor;

  // v3 (item 3): the vk pin is a property of the deployed CONTRACT, not of any one record --
  // checked once per session, not re-derived per restore (see prose below for what this can
  // and can't check today).
  await assertContractVkPinned(conn);

  // horizon #1: the CHECKPOINT's own block N -- used for L0's on-chain-agreement check, unchanged
  // in shape from v2's single-horizon design.
  const checkpointHorizon = await verifyFinalizedTuple(conn, anchor.blockHash);
  if (checkpointHorizon.blockHash !== anchor.blockHash) throw new SnapshotAnchorMismatchError();

  // L0a: offline self-consistency
  assertLocalRootMatches(envelope, anchor);
  // L0b: on-chain agreement -- against checkpointHorizon.R_N, not a second independently-fetched value
  if (checkpointHorizon.R_N !== anchor.zswapMerkleTreeRoot) throw new SnapshotAnchorMismatchError();
  // L0c: finality already checked inside verifyFinalizedTuple
  let level: VerificationLevel = "L0";

  // horizon #2 -- NEW in v3 (items 1 and 6): the CURRENT finalized TIP, fetched fresh and
  // independent of anything the checkpoint envelope itself claims. One fetch fixes two
  // previously-separate bugs:
  //  (item 6) L1's tail check now spans [anchor.zswapEndIndex, tipHorizon.endIndex) -- genuinely
  //    non-trivial. The v2 code used checkpointHorizon here, which is BY DEFINITION derived from
  //    the checkpoint's own block, making the range always empty -- a no-op disguised as a check.
  //  (item 1) the L3 attestation lookup below is authenticated against a FRESH finalized view,
  //    not left as a bare, freshness-blind query -- see fetchAuthenticatedAttestation.
  const claimedFinalizedHead = await fetchClaimedFinalizedHead(conn);  // untrusted CLAIM; the GRANDPA
                                                                         // justification inside
                                                                         // verifyFinalizedTuple is what
                                                                         // actually certifies it -- this
                                                                         // is the same "claim, then
                                                                         // independently verify" pattern
                                                                         // §4 already uses for claimedBlockHash
  const tipHorizon = await verifyFinalizedTuple(conn, claimedFinalizedHead);
  if (tipHorizon.blockHeight < checkpointHorizon.blockHeight) throw new SnapshotAnchorMismatchError();

  // L1: bounded-scan completeness, tail rehashed [anchor.zswapEndIndex, tipHorizon.endIndex)
  await verifyTailComplete(conn.indexerHttpUrl, anchor.zswapEndIndex, tipHorizon);
  level = "L0+L1";

  // L2: local anti-rollback sequence check
  assertSeqNotBelowHighestAccepted(envelope.seq, loadLocalHighWaterMark());

  // L3: on-chain attestation check -- rewritten in v3 (items 1, 2, 3, 4)
  const id = derivePseudonymId(identity.skAttest);
  // v3 (item 1): reads `attestations[id]` via a state_getReadProof against tipHorizon.blockHash's
  // OWN state_root -- the same coupling discipline §4 already uses for R_N/endIndex -- rather than
  // a bare, unauthenticated RPC call trusted from whatever endpoint answered. `probe.present` is
  // false ONLY when the read-proof proves non-membership of `id` at this height: a cryptographically
  // backed "genuinely absent," not merely "this endpoint chose not to return one."
  const probe = await fetchAuthenticatedAttestation(conn, id, tipHorizon);

  if (probe.present) {
    const record = probe.record;

    // v3 (item 4): the two sequence spaces are unified by construction (§7.1(a)) -- enforce it.
    if (record.seq !== envelope.seq) {
      throw new RollbackDetectedError("record.seq != envelope.seq: substituted or stale blob");
    }
    // v3 (item 3): pinned statement version, enforced at the actual check site, not just documented.
    if (record.statementVersion !== conn.attestStatementVersion) {
      throw new PinnedStatementVersionMismatchError();
    }

    const salt = deriveSalt(identity.skAttest, record.seq);
    const expectedCommitment = persistentCommit(envelope.snapshotRoot, salt);

    // v3 (item 2): reconstruct the FULL attestLeaf per §2.5.3's canonical equation -- genesis/
    // network id, wallet kind, block hash/height, tree root, end index, encoding version,
    // statement version, sequence, and previous commitment -- not just `commitment`/`height`.
    const expectedLeaf = attestLeafHash({
      genesisHash: conn.genesisHash, walletKindTag: envelope.walletKindTag, id,
      encodingVersion: envelope.encodingVersion, blockHash: anchor.blockHash,
      blockHeight: anchor.blockHeight, R_N: anchor.zswapMerkleTreeRoot, endIndex: anchor.zswapEndIndex,
      commitment: expectedCommitment, seq: record.seq, prevCommitment: record.prevCommitment,
      statementVersion: record.statementVersion,
    });

    const matches = record.attestLeaf === expectedLeaf
      && record.commitment === expectedCommitment
      && record.height <= tipHorizon.blockHeight;

    if (!matches) {
      // v3 (item 1b): PRESENT-but-mismatched is a distinct, hard-failing path -- a positive
      // rollback/substitution signal per §3.6's own divergence definition -- never a silent
      // downgrade the way genuine absence is.
      throw new RollbackDetectedError("attestation record present but does not match this envelope");
    }

    level = "L0+L1+L3";
    updateLocalHighWaterMark(record.seq, tipHorizon.blockHeight);   // from the CHAIN value (item 4),
                                                                      // never from envelope.seq
  }
  // else: probe proved genuine absence (e.g. first-ever attestation for this wallet) -- the ONLY
  // case that still downgrades silently to "L0+L1", now clearly distinguished from a mismatch.

  const wallet = await startFirst(Wallet, envelope.deserialized);
  return {
    wallet, verificationLevel: level,
    horizon: { checkpoint: checkpointHorizon, tip: tipHorizon },
    residuals: RESIDUALS_FOR[level],   // L3-reaching levels include the §2.5.5 owned-notes-base residual
  };
}
```

`assertContractVkPinned` (v3, item 3) checks a static property of `conn.contractAddress`, not a per-record value, so it runs once per session/connection rather than per restore. If the node/ledger exposes a per-contract deployed-verifier-key-hash read (to be confirmed against Midnight's contract-state API before implementation), this queries it and hard-fails on a mismatch against `conn.attestCircuitVkHash`; if no such read exists, the pin is enforced structurally instead — the client only ever talks to the single hard-pinned `conn.contractAddress` (§3.5), and `attestStatementVersion` is the concrete per-record value the L3 step above actually checks. Either way, the config type now carries both fields as first-class, typed, and — for `attestStatementVersion` — runtime-enforced, closing the "prose-only" gap.

This is a gate in front of the existing resume path — no change to `Sync.ts`'s `resumeFrom` (brief 04 §4b). It finally *calls* `applyCollapsedUpdate`, which the ledger crate exposes but the wallet never invokes (brief 04 §2, brief 06 §7). Once `verificationLevel: "L0+L1+L3"` is returned, the wallet transitions to `verified-at-finalized-head` in §3.6's state machine; callers proceed through `caught-up → active` and must wire in §3.6's periodic/pre-spend recheck.

**(c) `SnapshotStorage` interface** — mirror the reader/writer split of the existing `TransactionHistoryStorage` (`abstractions/src/TransactionHistoryStorage.ts:215-216`), which is a plain injected interface with **no in-memory assumption baked in**. Today the `serialize()`/`restore()` blob is a bare `string` the caller must persist itself — there is no pluggable snapshot-storage seam the way there is for tx-history (brief 04 §4c). Adding `SnapshotStorage` lets UmbraDB back *both* snapshot and tx-history through one facade constructor arg.

**(d) `restoreLegacyUnverified()` — new in v2, the explicit unverified path required by item 2. Extended in v3 (item 11) with a pre-restore L3 pointer probe, closing the legacy-downgrade risk.** A separately-named static factory for envelopes with no `envelopeVersion` field (pre-upgrade legacy snapshots):

**The v3 gap this closes:** a hostile DB could serve a legacy-shaped (anchor-less) envelope to a wallet that in fact *has* a real, valid on-chain attestation — forcing it through this unverified path even though `restoreAnchoredCheckpoint()` was genuinely available and would have caught a rollback. Nothing about an envelope's own claimed shape should be trusted to decide how much verification the wallet gets, since that shape is exactly what a hostile DB controls. **Fixed:** when `identity.skAttest` is available, this path now performs an independent, cheap pre-restore probe of the L3 pointer *before* accepting the legacy path, refusing to proceed silently if a real record is found:

```ts
static async restoreLegacyUnverified(
  serialized: string,
  conn?: { indexerHttpUrl: string; grandpaEndpoints: string[]; contractAddress: string; genesisHash: Bytes32 },
  identity?: { skAttest: Bytes32 },        // NEW v3 (item 11) -- optional: legacy callers that
                                            // genuinely have no key material yet can't run this
                                            // probe, and that gap is named below, not hidden
): Promise<{ wallet: Wallet }> {
  if (conn && identity) {
    // v3 (item 11): independent of anything the envelope itself claims -- a hostile DB cannot
    // downgrade a wallet that HAS a real attestation just by serving an anchor-less blob, because
    // this probe doesn't consult the envelope at all.
    const tipHorizon = await verifyFinalizedTuple(conn, await fetchClaimedFinalizedHead(conn));
    const id = derivePseudonymId(identity.skAttest);
    const probe = await fetchAuthenticatedAttestation(conn, id, tipHorizon);
    if (probe.present) {
      // a real on-chain record exists for this wallet -- refuse the unverified path outright;
      // the caller must obtain a v2 envelope and use restoreAnchoredCheckpoint() instead.
      throw new LegacyRestoreRefusedError(
        "on-chain attestation exists for this wallet -- legacy/unverified restore is refused; " +
        "obtain a v2 envelope and use restoreAnchoredCheckpoint()",
      );
    }
  }
  // No conn/identity supplied, OR the probe found genuine absence: proceed unverified. The
  // no-conn/no-identity case is a named residual, not a silent gap -- see prose below.
  const deserialized = deserializeLegacy(serialized);   // the pre-v2 shape only
  // deliberately NO anchor/finality/L1/L3 checks -- there is nothing to check against
  return { wallet: await startFirst(Wallet, deserialized) };
}
```

This return type has **no** `verificationLevel` field at all — it cannot be confused, structurally, with a verified result. Callers are expected to flag wallets restored this way for a forced re-anchor at next save (§7.1(a)'s migration policy) and, if the deployment is remote/untrusted, to treat the restored state as unverified until that re-anchor completes.

**Named residual (v3, item 11):** the pre-restore probe requires `identity.skAttest` — a wallet that genuinely has no key material available yet (e.g. very first-ever restore before any keys are derived) cannot run it, and in that specific case this path still proceeds unverified with no independent check, same as before v3. This is not silently swept under "legacy is unverified" generically — it is a distinct, named sub-case: SDK callers with `skAttest` available (the overwhelmingly common case — restoring an *existing* wallet, which is what "legacy" implies) get the protection; a from-scratch wallet with no keys yet has nothing on-chain to probe for regardless, so the gap is vacuous for that sub-case.

### 7.2 Indexer PR — `midnight-indexer` (additive, `@beta` where dust)

- **`TreeAnchor` on the ledger-event types** — the prerequisite reverse map. A restoring wallet has an event-cursor `appliedIndex`, not an endIndex/height; there is no field today mapping "event id → the committed root when I reached it" (brief 04 §2). Add `zswapAnchor: TreeAnchor!` on `ZswapLedgerEvent` (and `@beta` dust variants) via a `#[ComplexObject]` resolver following the existing FK chain `ledger_events → transactions → regular_transactions` — the anchor columns (`zswap_merkle_tree_root`, `zswap_start/end_index`, dust indices) **already exist**, so **zero new migration** (brief 04 §3, `indexer-common/migrations/postgres/001_initial.sql:47-59`):
  ```graphql
  type TreeAnchor { endIndex: Int!, root: HexEncoded!, block: Block! }
  ```
- **`unshieldedUtxos(address, offset): UnshieldedUtxoProof`** — the genuinely new authenticated surface, **Tier-F / federated-quorum trust per §2.6**, not consensus-reduced. **Not** a bare `[UnshieldedUtxo!]!` (that carries no completeness proof) but `{ utxos, boundaryLo, boundaryHi, merklePaths, root, rootSignature }` (brief 06 §4.3, §7). Needs the new MB-tree materialized view (§4.2 of brief 06), a signer (Signed-Tree-Head), and ideally a monitor cross-checking `R_utxo` against the consensus utxo-subtree root. `R_utxo` anchoring options, honestly ranked (brief 06 §4.4): (1) whole-set root-match vs the `utxo`-subtree root in `midnight_ledgerStateRoot` — strongest, would be consensus-reduced, but needs the node to expose that root + an MPT serialization the wallet can rehash (doesn't exist today); (2) **signed STH + monitor cross-check + k≥2 indexers — Tier-F, v1's actual mechanism**; (3) consensus change — cleanest, deferred.
- **CI:** weave both into `native_e2e.rs` (byte-identical reference stream vs a real `midnight-node` container) and the `qa/tests` schema-introspection/deprecation smoke test (brief 04 §5). Signed CLA + Apache-2.0 headers (brief 04 §5).

### 7.3 The UmbraDB persistence substrate

*Corrected in v2: the v1 draft's claims about encryption status and the `manifestHash`/`snapshotRoot` relationship were both wrong; both are fixed here, cross-referencing §2.5 and §7.3.1.*

- **`CheckpointStore`** (`src/interfaces/checkpoint-store.ts`) is content-addressed, chunked, and **always fully rehashes+verifies every chunk on `load()`** before returning (throwing `ChunkIntegrityError`/`ChunkMissingError`/`ManifestCorruptError`). Verified directly against `git show origin/main:src/postgres/checkpoint-store.ts`: `PgCheckpointStore.save()` splits `data` into chunks, SHA-256s each chunk, SHA-256s the ordered chunk-hash list into `manifestHash`, and stores the **raw bytes as given** — no encryption step exists in this file or anywhere else in the checkpoint path today. `manifestHash` is a **Domain S (storage/ciphertext-when-encryption-ships)** value per §2.5.2 — it is **not** the same value as, and must never be substituted for, the **Domain P** `snapshotRoot` that L3 actually attests to. (The v1 draft's claim that "its `manifestHash` … is exactly the `snapshotRoot`" is retracted; see §2.5.1 for why that equation was actively harmful.) Its per-`(walletId,networkId)` monotonic `CheckpointSequence` is the natural home for L2's anti-rollback `seq` and for §2.5.3's `seq` field.
- **Sprint-7 `PgTransactionHistoryStorage`** implements the SDK's `TransactionHistoryStorage<WalletEntry>` — brief 04 §4c confirms this needs **zero SDK change** (the interface is unprivileged and injected). The new `SnapshotStorage` (7.1c) is the symmetric seam for the snapshot blob itself.
- The **CheckpointStore `WalletState` envelope** carries the serialized local state + the new L0 anchor manifest + `snapshotRoot` as one atomic unit; L2's AES-GCM (§7.3.1, **not yet implemented — v1 blocking requirement**) encrypts each chunk **inside** `saveImpl`'s own atomic transaction, after chunking and after `seq` allocation (v3, item 7 — see §7.3.1 for why this ordering is required); L3's attestation commits `snapshotRoot` (Domain P), never `manifestHash` (Domain S).

### 7.3.1 AES-256-GCM v1 requirement — new in v2, replaces the retracted "already implemented" claim (item 10); construction fixed and sequence-ordering verified in v3 (item 7)

**What was actually found in current source, verified directly (not trusted from prior prose):**

```
$ git show origin/main:src/postgres/checkpoint-store.ts   # saveImpl()
  chunkHashes = chunks.map(sha256)
  manifestHash = sha256(Buffer.concat(chunkHashes))
  INSERT INTO ckpt_chunks (hash, data) VALUES (chunkHashes[i], chunks[i])   -- raw bytes, unencrypted
```

No `encrypt`, `AES`, or `GCM` symbol appears anywhere in `src/interfaces/checkpoint-store.ts` or `src/postgres/checkpoint-store.ts`. The only hit for `getOrCreateSalt` in the whole `origin/main` tree is in `design/design.md`'s description of `PgPrivateStateProvider`'s per-`(accountId, scope)` salt — an entirely separate subsystem (Midnight contract *private state* storage, not wallet snapshots). The v1 draft's §2 claim that "UmbraDB already implements this" was false; corrected throughout (§2, §7.3).

**v3 re-verification of `saveImpl`'s actual sequence-allocation order (re-checked directly against `src/postgres/checkpoint-store.ts:139-173` this session, not trusted from the v2 prose above):** confirmed. `saveImpl` computes `chunks = splitChunks(data, chunkSize)` and `chunkHashes = chunks.map(sha256)` **before** `this.txLayer.withTransaction(...)` is ever called. Only *inside* that transaction — after the chunk-insert loop has already run — does it allocate `seq`:

```ts
// saveImpl, current source, annotated:
const chunks = splitChunks(data, chunkSize);        // <- chunking happens BEFORE the tx opens
const chunkHashes = chunks.map(sha256);              // <- chunk hashes computed BEFORE the tx opens
return await this.txLayer.withTransaction(async (tx) => {
  for (...) { INSERT INTO ckpt_chunks ...; }          // chunk rows written first
  const seqRows = await sql`
    INSERT INTO ckpt_sequence_counters (w, net) VALUES (${walletId}, ${networkId})
    ON CONFLICT (w, net) DO UPDATE SET next_seq = ckpt_sequence_counters.next_seq + 1
    RETURNING next_seq - 1 AS claimed_seq`;            // <- seq allocated AFTER chunks already exist
  const seq = seqRows[0].claimed_seq;
  ...
});
```

This confirms the round-2 finding exactly: an external encryption wrapper sitting in front of `save()` cannot construct a `(seq, chunkIndex)`-derived nonce, because `seq` does not exist yet at the point such a wrapper would need to encrypt. This rules out "encrypt-then-hand-to-`save()`" as a viable v1 shape for a per-chunk-nonce, sequence-derived construction — encryption must move to a point in the code that *has* `seq`, i.e. inside `saveImpl` itself, after the sequence-allocation step. (The chunk-insert loop currently running *before* sequence allocation is not itself a problem to fix — it's reordered below as part of moving encryption in, not because the current order is unsafe on its own.)

**v1 construction (blocking, not yet built) — chunk-then-encrypt, resolving the v2 draft's encrypt-then-chunk / per-chunk-nonce self-contradiction (v3, item 7):**

The v2 text specified a per-chunk nonce while simultaneously implying the plaintext is encrypted as one blob before `CheckpointStore` ever sees it (mirroring "L2 wraps the plaintext before it reaches chunking") — those two statements cannot both be true: a single whole-blob encryption has no per-chunk boundaries to derive a per-chunk nonce from. **Resolved: chunk-then-encrypt**, matching the existing content-addressed chunk-store architecture (chunks are already the unit of storage, hashing, and dedup — encryption should be too), not encrypt-then-chunk:

1. `saveImpl` restructured: split plaintext into chunks (position-only, no crypto yet — unchanged from today), open the transaction, allocate `seq` via the existing atomic upsert-increment (unchanged — this preserves the current gapless-on-abort property; see "why not pre-reservation" below), **then**, now that `seq` is known, encrypt each chunk and hash the **ciphertext** (not plaintext) for the content-addressed chunk table, in the same loop that currently just hashes-and-inserts plaintext chunks.
2. **Nonce layout — injective by construction, not by hash/truncation:** `nonce := uint64(seq) || uint32(chunkIndex)` — exactly 96 bits (12 bytes), GCM's standard nonce width, built by direct concatenation of two integers already known at encryption time. This is **injective by construction**: distinct `(seq, chunkIndex)` pairs produce distinct byte strings with zero collision probability, unlike a hash or truncation of a tuple (which the v2 draft's phrasing left ambiguous and which does carry a birthday-bound collision risk). `seq` is globally monotonic per `(walletId, networkId)` and never reused; `chunkIndex` is bounded by the chunk count of one save. No two chunks, ever, across any wallet/checkpoint, can share a nonce under the same key (see the KDF scoping below for why "under the same key" is the correct qualifier).
3. **Why moving encryption inside the transaction, not sequence pre-reservation:** the alternative — reserving a `seq` value before chunking/encrypting, then using it in a later transaction to actually write — was considered and rejected. The current `ckpt_sequence_counters` upsert-increment is deliberately **inside** the same transaction as the chunk/manifest writes specifically so an aborted `save()` never burns a sequence number (comment in source: "gapless and monotonic under concurrency by construction"). Pre-reserving would either (a) burn sequence numbers on any subsequently-failed save (reintroducing gaps the current design explicitly avoids), or (b) require a second cross-transaction coordination mechanism to reconcile a reserved-but-unconsumed sequence. Moving encryption to a point *inside* the existing transaction, after the existing seq-allocation step, achieves the goal with no new failure mode and no schema change to the sequence-counter table.
4. **KDF / domain separation:** `key := HKDF-SHA256(ikm = seed-derived attest-adjacent secret, info = "umbradb:snapshot:v3:enc:" || walletId || networkId || scope, salt = per-(walletId,networkId) random 32-byte value stored alongside the manifest)`. This salt is a **new, dedicated** value — explicitly **not** `getOrCreateSalt`, which belongs to the unrelated private-state-provider subsystem and must not be reused across subsystems.
5. **Key-rotation epoch model — made concrete in v3 (item 7d).** v2 left `encKdfVersion` as "a version tracked the same way as `encodingVersion`" without saying what identifies *which* rotated key decrypts a given record. **Fixed:** `encKdfVersion` is a small monotonic integer stored **per-manifest** (a new column alongside `manifest_hash` in `ckpt_manifests`, at the same granularity `seq`/`manifestHash` already live at — not a single global "current version"), naming the key-derivation epoch under which *that manifest's* chunks were encrypted. A client holds a small local table `epoch → key material` (each epoch's key independently re-derivable via the same HKDF construction with an epoch-specific `info`/`salt` component); `load()` reads `encKdfVersion` off the manifest row and looks up the matching epoch's key before attempting to decrypt. Rotation (v1 policy: eager — new `save()` calls after a rotation use the new epoch and its `encKdfVersion`; existing rows keep decoding under their original epoch's key until an explicit migration re-saves them; lazy read-through re-encryption is an acceptable v1.1 relaxation) never requires re-deriving old ciphertext, since each manifest is self-describing about which epoch decrypts it.
6. **Authenticated data (AAD) — widened in v3 (item 7b).** v2's AAD bound only `(walletId, networkId, sequence, envelopeVersion)` — too coarse: it did not bind a chunk to its *position* within the manifest, nor to the encoding/key-construction version in force. **Fixed:** `AAD := (walletId, networkId, seq, envelopeVersion, chunkIndex, chunkCount, encKdfVersion, encodingVersion)`. This closes two gaps the narrower AAD left open: (a) a chunk from one position in a manifest being silently substituted for another position of the *same* manifest (same wallet/network/seq/envelopeVersion, different `chunkIndex` — undetected by the v2 AAD, detected by v3's); (b) a chunk encrypted under one `encKdfVersion`/`encodingVersion` being mistakenly decrypted as though it were a different version.
7. **Content-addressed dedup / equality-leak residual — corrected in v3 (item 7e); the v2 claim was inconsistent with its own nonce design.** The v2 text claimed "identical plaintext at different checkpoints... will produce identical ciphertext and will dedupe" under "the same key+nonce-derivation context" — but that claim directly contradicts the monotonic `(seq, chunkIndex)` nonce this same section specifies: `seq` is fresh and never reused on every `save()`, so two *different* checkpoints (necessarily two different `seq` values) always encrypt under different nonces even when both use the current key epoch and even when the plaintext is byte-identical — meaning their ciphertext is **never** identical, and there is **no** cross-checkpoint dedup collision, hence no cross-checkpoint equality leak. The only way two chunks could ever share a nonce is the same `(seq, chunkIndex)` pair being encrypted twice under the same key epoch, which cannot happen because `seq` is allocated fresh and monotonically on every `save()` (never re-issued, never re-derived for a repeat write). **The actual, corrected residual** is much weaker and orthogonal to nonce/plaintext-equality entirely: a storage-layer operator can still observe **chunk count and total byte length per manifest** (the *shape* of a checkpoint, not its content or its equality to any other checkpoint) — an unavoidable property of any chunked store, encrypted or not, and now the residual actually stated in §10 rather than the disproven cross-checkpoint-equality claim.

---

## 8. Compact / circuit sketches (illustrative, uncompiled)

**L3 — Attested Manifest Root (brief 05 §4.1, V1b+V2). Sub-zswap circuit; all constructs in current stdlib.** *Updated in v2 to match §2.5.3's canonical equation (statementVersion, encodingVersion, full-record history leaf) and §3.5's pinned-vk immutability commitment.*
```compact
struct AttestRecord {
  attestLeaf: Bytes<32>;      // H(genesisHash, walletKindTag, id, encodingVersion, blockHash,
                               //   height, R_N, endIndex, commitment, seq, prevCommitment,
                               //   statementVersion)  -- the FULL record, not a bare commitment (§2.5.3)
  commitment: Bytes<32>;      // persistentCommit(snapshotRoot, salt) -- Domain P only, never manifestHash
  height: Uint<64>;
  seq: Uint<64>;
  prevCommitment: Bytes<32>;
  statementVersion: Uint<32>; // pinned in client config per §3.5 -- this contract/circuit is v1-immutable
  encodingVersion: Uint<32>;  // §2.5.4
}
export ledger attestations: Map<Bytes<32>, AttestRecord>;   // pseudonym id -> latest
export ledger history: MerkleTree<32, Bytes<32>>;           // every attestLeaf (full record hash), V1b
witness attestSecretKey(): Bytes<32>;                        // dedicated HD path, not the spend key
witness snapshotRoot(): Bytes<32>;                           // Domain P Merkle root over plaintext sections (§2.5.2)

export circuit attest(height: Uint<64>): [] {
  const sk = attestSecretKey();
  const id = disclose(persistentHash([pad(32,"umbradb:attest:v2:id"), sk]));   // C8 pseudonym
  const isUpdate = attestations.member(id);
  const prev = isUpdate ? attestations.lookup(id) : default;
  if (isUpdate) assert(prev.height < height, "attestation must advance");      // C7 CAS anti-rollback
  const salt = persistentHash([pad(32,"umbradb:attest:v2:salt"), sk, seqAsBytes(prev.seq + 1)]);
  const c = persistentCommit(snapshotRoot(), salt);                            // hiding (C3), Domain P
  const leaf = persistentHash([pad(32,"umbradb:attest:v2:leaf"), genesisHash, walletKindTag, id,
                                encodingVersion, blockHash, disclose(height), rN, endIndex, c,
                                seqAsBytes(prev.seq + 1), prev.commitment, statementVersion]);
  history.insertHash(leaf);                                                    // full record, not bare c
  attestations.insert(id, AttestRecord { attestLeaf: leaf, commitment: c, height: disclose(height),
                                         seq: disclose(prev.seq + 1), prevCommitment: prev.commitment,
                                         statementVersion: disclose(statementVersion),
                                         encodingVersion: disclose(encodingVersion) });
}
```
This contract's address and `attestCircuitVkHash`/`statementVersion` are **pinned, immutable client config for v1** (§3.5, option a) — no in-circuit or contract-governed succession mechanism ships in v1. The successor-certificate shape for a later, explicitly-ratified v1.1+ (§3.5 option b) is a separate `migration` record type, not sketched here since it is not being built now.

**L3 — offline v-lightweight ZK certificate (brief 07 §2.1). Hand-written zkir; public inputs `{hash(S), R_N, N, id}`; ∝ owned notes; k≈20; verify in ms.**
```
for each owned note i:  ownership: k*_i = c_i · esk (EcMul); assert plain_i[0]==0 (Poseidon-CTR decrypt)  // "mine"
                        membership: c^cc_i = PersistentHash("midnight:zswap-cc[v1]", info_i, pk)         // 1 SHA-256
                                    assert merkle_path_root(path_i, c^cc_i) == R_N                        // ≤32 Poseidon
binding:  assert hash(S) == TransientHash(canonical_encode({info_i, index_i}))
id:       public  TransientHash("umbra:07:id", sk)
```
Proves inclusion + ownership + value-binding at finalized N; **does not** prove completeness — see §5.0/§5.1 for the precise, corrected scope of what completeness means here. Verified off-chain by `VerifierKey::verify` (`transient-crypto/src/proofs.rs:545-558`).

**L3 research — IVC ratchet state (brief 08 §2.1):** `AssignedState = (checkpoint cursor N, Poseidon frontier commitment, R_N + finalizedHash anchor field)`; `Witness = the L1 ADS delta (N,N+1]`; `circuit_transition` **internalises the collapsed-update completeness check** (pure Poseidon, brief 08 §3.4). O(1) proof/verify; O(delta) per step. Native-Rust prover, not `:6300`.

---

## 9. Phasing table

*Updated in v2: encryption row corrected (item 10), unshielded/dust rows relabeled Tier-F (item 8), canonical encoding promoted to blocking (item 1), envelope versioning and restore-API rows added (items 2, 6). Updated in v3: owned-notes binding row added (item 0), authenticated L3 lookup row added (item 1), AES-GCM row's construction corrected (item 7).*

| Capability | Layer | v1 (no protocol change) | Needs node/protocol change | Research-grade |
|---|---|---|---|---|
| Canonical versioned section encoding (CBOR/CDDL), incl. owned-note set | §2.5.4 | ✅ **blocking, promoted from secondary [D0]; owned-note-set entry added [v3 item 0]** | | |
| `snapshotRoot` binds `ownedNotesPlain` (owned-notes binding) | §2.5.2/§2.5.5 | ✅ **new, blocking — the round-2 core defect [D6, v3 item 0]** | | |
| Owned-notes-base-at-N restore-time correctness (live-tail re-derivation, option b) | §2.5.5 | ✅ **no new mechanism — reuses §1's existing `[N,tip]` catch-up [v3 item 0]** | | |
| Anchor tuple persisted + offline root recompute | L0 | ✅ [01 §6] | | |
| On-chain agreement check (`block(offset)`), coupled tuple | L0/§4 | ✅ `verifyFinalizedTuple` [item 9] | | |
| Finality: Tier-0 k-of-n RPC | L0/§4 | ✅ [10 §5] | | |
| Finality: Tier-1 GRANDPA justification + state-read-proof | L0/§4 | ✅ SDK plumbing [10 §3] | | |
| Finality: in-circuit | §4 | | | ✅ defer [08 §6] |
| Shielded commitment-completeness (collapsed-tree ADS) — **consensus-reduced** | L1 | ✅ SDK wires up existing API [06 §2] | | |
| Dust commitment-completeness (same ADS mechanism) — **Tier-F-lite, NOT consensus-reduced [§2.6, v3 item 8]** | L1 | ✅ SDK wires up existing API [06 §2] | dust roots `@beta`, not node-cross-checked [06 §2.5] | |
| Unshielded authenticated by-address index (MB-tree) — **Tier-F, federated quorum, NOT consensus-reduced [§2.6]** | L1 | ✅ indexer signed-STH + monitor [06 §4.4-②] | consensus utxo-root for full trustlessness [06 §4.4-①/③] | |
| Envelope versioning + fail-closed legacy split | §7.1(a)/(d) | ✅ **new, blocking [item 2]** | | |
| Legacy-path pre-restore L3 pointer probe (prevents downgrade of a wallet with a real attestation) | §7.1(d) | ✅ **new, blocking when `identity.skAttest` available [v3 item 11]** | | |
| `restoreAnchoredCheckpoint` (L0+L1+L2+L3, structured result) | §7.1(b) | ✅ **new, blocking [item 6]; L1 tail range made non-trivial, full `attestLeaf` reconstructed, vk/statementVersion enforced, seq unified [v3 items 2/3/4/6]** | | |
| Authenticated L3 attestation lookup (state-read-proof vs fresh tip) + distinct `RollbackDetectedError` for present-but-mismatched | §7.1(b) | ✅ **new, blocking [v3 item 1]** | | |
| Client-side AES-GCM | L2 | ❌ **NOT implemented today, verified against source [item 10]; v1 blocking, spec §7.3.1; construction fixed to chunk-then-encrypt inside `saveImpl`'s transaction, injective nonce, corrected dedup-leak claim [v3 item 7]** | | |
| Anti-rollback (local monotonic + chain-freshness) | L2 | ✅ [03 §4] | | |
| Multi-device signed hash-chained CRDT deltas — **conditional on history-exchange precondition [item 11]** | L2 | ✅ [11 §5] | | |
| On-chain Attested Manifest Root (rollback for cold-boot) | L3 | ✅ Compact V1b+V2, canonical-equation §2.5.3 [05] | | |
| vk/contract pin, immutable, no successor-following | L3/§3.5 | ✅ **client-config hard pin, v1 decision [item 4]** | | |
| Successor-certificate mechanism | L3/§3.5 | | | v1.1+ specified, not built [item 4] |
| Rollback recovery state machine + periodic/pre-spend recheck | L3/§3.6 | ✅ **new, blocking [item 3]** | | |
| Offline v-lightweight ZK certificate | L3 | v1.1 opt-in [07 §2] | | |
| Recursive IVC checkpoint ratchet (O(1) history) | L3 | | | ✅ [08] |
| Ciphertext-delivery completeness (= wallet-identity-binding residual, §5.0) | §5 | ⚠️ Zcash-parity residual + NxN | body-proof / ciphertext accumulator [06 §2.4] | |
| Spend-completeness (nullifiers) | §5 | ⚠️ contained by only-spend-own-notes | nullifier non-membership / accumulator [06 §3] | |
| Privacy-from-scanner (detection tag) | §6 | v1.x overlay tag [09 ①] | consensus clue key (FMD) [09 ①-native] | OMR [09 §7] |
| Transparency-log checkpoint (cheaper self-cert) | L3 alt | multi-tenant hosted opt-in [11 §4] | | |

---

## 10. Honest residual trust (after all v1 layers)

*Rewritten in v2: adds the vk/circuit-pin item (item 4, absent before — itself a gap the audit flagged) and the unshielded/dust federated-trust item (item 8); tightens vocabulary throughout to match this section's own pre-existing rigor (item 5) rather than weakening it; folds in the AES-GCM dedup-leak residual (item 10) and the BFT-CRDT communication precondition (item 11).*

The floor, stated plainly (brief 03 §7, brief 06 §6, brief 10 §0):

1. **Consensus/finality.** Correctness reduces to an on-chain root; that root's trust reduces to **GRANDPA not reverting blocks ≤ N**. The certificate *inherits* this, it does not remove it. Tier-1 makes it *verifiable* rather than *assumed*, down to one irreducible weak-subjectivity seed (the genesis authority set, trusted once) (brief 10 §0). This is the sense in which "the chain is trusted" in this document — a designated root of trust *within this threat model*, not an unconditional guarantee independent of GRANDPA's own safety assumptions (v1 draft's phrasing overstated this; corrected in §3).
2. **Restore-time and ongoing freshness (A5).** The wallet must obtain the *genuine* finalized R_N — a light-client problem, mitigated (not eliminated) by Tier-1 + multi-endpoint, strongest with a local node (brief 05 §9, brief 07 §6.2). **Extended in v2 (§3.6):** freshness is not a one-time restore-time check — an already-active wallet must keep rechecking (pre-spend, periodic) against the L3 pointer, or a rollback accepted at cold-boot and never rechecked is functionally the same gap recurring silently.
3. **Unshielded and dust verification are federated-quorum trust (Tier-F/Tier-F-lite), not consensus-reduced trust — new in v2, §2.6.** This is a scope acknowledgment, not a deferred bug: v1 ships real value over "trust the DB blindly," but it must never be described with the same "verified"/"trustless" language the shielded path earns. True reduction requires the node/protocol changes named in §7.2.
4. **Attest-time honesty (L3-c) / circuit-and-pin correctness (L3-a, and the vk pin itself) — expanded in v2, §3.5; extended in v3, §2.5.5.** The attestation transports correctness forward but cannot create it — a wallet compromised *at attest time* pins bad state (an explicit non-goal; brief 05 §1). The offline proof only means "the statement *this vk's circuit* encodes holds" — the hand-written IR must be audited and its vk pinned (brief 07 §6.3). **New in v2:** the L3-c contract/vk pin itself (§3.5) is a named residual — v1 clients trust that their hard-pinned `contractAddress`/`attestCircuitVkHash`/`statementVersion` were pinned correctly and that the client software delivering that pin is honest; a compromised software update that silently changes the pin is the attack this design is *not* trying to solve, same class as "the client software is honest" generally, but now named explicitly for this component because a bad pin has outsized blast radius (silent acceptance of a malicious successor circuit). **New in v3 (item 0, §2.5.5):** the newly-committed `ownedNotesPlain` section's *base value at N* is transported forward under this exact same attest-time-honesty umbrella — a wallet whose owned-note bookkeeping was already wrong or incomplete at attest time will attest, and re-verify at restore, a self-consistent but wrong base. This is not a new class of trust — it is the pre-existing item-4 residual, now explicitly named against the specific commitment section it applies to, per the round-2 audit's request not to leave this unspecified. The risk from this residual does **not** compound over time: §2.5.5's mechanism (b) means every note added after N is independently re-derived by the restoring device's own live trial-decryption over `[N, tip]`, never inherited from the attestation.
5. **Ciphertext-delivery + spend completeness — restated precisely per §5.0.** Open in v1 (§5) — Zcash-parity, bounded by NxN + only-spend-own-notes (scoped correctly, §5.0) + first-spend re-validation (scoped correctly, §5.1), fully closed only by a node change. This is the *same* residual as "L0+L1 don't bind wallet identity" (item 7) — not a second, independent gap. **Distinct from item 4's owned-notes-base residual (v3):** this item is about *completeness* of what the wallet's trial-decryption can see; item 4's new sub-item is about *correctness of the base commitment as transported forward*, even assuming trial-decryption saw everything it was shown. §2.5.5 has the full distinction.
6. **Privacy.** Rests on the seed's ≥256-bit entropy and the secrecy of the seed-derived key (brief 03 §7). The remote scanner still learns ownership until the detection-tag overlay ships (§6). **New in v2, corrected in v3 (item 7e):** the v2 text claimed a content-addressed dedup equality leak across checkpoints of the same wallet; that claim was inconsistent with the monotonic per-`(seq, chunkIndex)` nonce construction §7.3.1 specifies (fresh `seq` on every `save()` ⇒ ciphertext is never identical across two different checkpoints, even for byte-identical plaintext) — there is **no** cross-checkpoint equality leak under the corrected construction. The residual that actually survives is narrower: an operator can observe chunk count / total byte length per checkpoint (shape, not content or cross-checkpoint equality) — unavoidable in any chunked store.
7. **Multi-device split-view detection requires an active communication precondition — new in v2, §2 L2 bullet 3 / item 11.** Hash-chained, signed deltas detect tampering only between devices (or a device and the L3 pointer) that actually compare notes on some cadence; a malicious DB can otherwise show indefinitely divergent forks to devices that never exchange history. Device-key membership/revocation and non-commutative merge-rule specification remain explicitly out of scope for v1.
8. **Trusted-setup + proving-system soundness** (KZG BLS12-381 SRS, Halo2) — shared with the entire chain, not new to us (brief 07 §6.5-6).

The DB itself is trusted for **availability only** — strengthened by plain multi-host replication extending the NxN habit to the blob (brief 11 §3; erasure-coding/DAS explicitly rejected as disproportionate at wallet-snapshot scale). **TEE attestation is rejected** as a substitute (attests code identity, not chain-relative data; its own root of trust has broken repeatedly — Foreshadow/SGAxe/Downfall, and the wallet-shaped Secret Network consensus-seed extraction — brief 11 §1); acceptable only as an orthogonal at-rest confidentiality layer *underneath* the anchor.

---

## 11. Post-implementation testing strategy

Every design claim must map to a test that could falsify it. Organized by layer and by the adversary each defends against. *v2 adds tests for the state machine (§3.6), envelope fail-closure (§7.1), coupled-tuple finality (§4), the AES-GCM spec (§7.3.1), and the corrected L0/L1/L0+L1+L3 claims (§5.0, §7.1(b)). v3 adds tests for owned-notes binding (§2.5.5), authenticated/present-vs-absent L3 lookup (§7.1(b)), full `attestLeaf` reconstruction, `seq` unification, the now-non-trivial L1 tail range, the revised AES-GCM construction (§7.3.1), and the legacy-path pre-restore probe (§7.1(d)).*

### 11.1 Unit + property tests
- **L0 collapse-invariant (the load-bearing fact):** property test that `serialize → deserialize → rehash().root()` is bit-identical to the on-chain root at the same `endIndex`, across randomized note sets and `firstFree` values (brief 01 §6.2). Falsifies the "offline recompute" claim if it ever diverges.
- **L0's precise scope (item 7):** a test snapshot with a correct global tree frontier but tampered/truncated owned-notes bookkeeping must pass L0 alone and be caught only once L1 + local trial-decryption run — asserting the corrected §5.0 claim, not the retracted "L0 proves S is exactly correct" one.
- **L1 completeness algebra:** property test that `applyCollapsedUpdate` over `[endIndex_N, endIndex_tip)` is a monoid homomorphism and that any *omitted/reordered/inserted* commitment in the range makes the rehashed root diverge from the tip root (brief 06 §2.1). Fuzz the collapsed-update bytes.
- **L1 unshielded boundary proof — labeled Tier-F:** property test that the MB-tree non-membership proof accepts iff `A⁻ < A < A⁺` are genuinely adjacent, and rejects any forged `[]` for a present address or any dropped UTXO within a present address's list (brief 06 §4.3); a companion test asserts the SDK never labels this result "consensus-verified" (§2.6).
- **L2 anti-rollback monotonicity:** property test that a snapshot with `seq`/height below the highest-ever-accepted is rejected; that the chain-freshness check rejects `anchorHeight <` last-known-finalized.
- **L2 BFT-CRDT — with the communication precondition (item 11):** property test for fork*-consistency under periodic exchange — signed hash-chained deltas converge under causal delivery when devices actually compare notes; a companion **negative** test confirms that two devices that never exchange history/pointer checks remain indefinitely divergent and undetected, documenting the precondition rather than hiding it.
- **L3 attestation CAS:** unit test that a replayed old `attest` tx fails against advanced state (transcript re-run), and that height-monotonicity `assert` holds (brief 05 §4.3).
- **L3 canonical equation (§2.5.3):** property test that `manifestHash` (Domain S) changing under key rotation never changes `snapshotRoot` (Domain P) or any attested `commitment` — the direct regression test for the fixed contradiction (item 1).
- **L3 pinned vk (§3.5):** unit test that a client configured with a pinned `attestCircuitVkHash`/`statementVersion` rejects any attestation record whose `statementVersion` doesn't match, even if the contract address matches (guards against a silently-swapped successor).
- **L3 ZK circuit:** negative tests that a note not decrypting to `esk`, a commitment not under `R_N`, or a tampered `hash(S)` all fail proof generation/verification (brief 07 §2.1); `CircuitModel` cost-model run to confirm k≈20 for m=50–200 notes.
- **Owned-notes binding (new in v3, item 0/§2.5.5) — the direct regression test for the round-2 defect:** property test that two envelopes with identical `cursorPlain`/`nullifiersPlain`/`R_N^tree`/`dustPlain`/`manifestSectionPlain` but *different* `ownedNotesPlain` produce **different** `snapshotRoot` values. This must fail against the pre-v3 equation (documented as the regression baseline) and pass against §2.5.2's v3 equation — the falsifying test for exactly the defect both Fable 5 and GPT-5.6 Sol independently found.
- **`attestLeaf` full reconstruction (new in v3, item 2):** unit test that `restoreAnchoredCheckpoint` rejects a record whose `attestLeaf` doesn't match a full §2.5.3 reconstruction even when `commitment` and `height` alone would have passed — i.e. a record with a correct `commitment`/`height` but a tampered `genesisHash`, `walletKindTag`, `blockHash`, `R_N`, `endIndex`, `encodingVersion`, `seq`, or `prevCommitment` inside the leaf must still be rejected. Regression test for the v2 gap where only `commitment`/`height` were checked.
- **`record.seq` / `envelope.seq` unification (new in v3, item 4):** unit test that a well-formed record with `record.seq !== envelope.seq` is rejected via `RollbackDetectedError`, even when `commitment`/`attestLeaf` would otherwise match under the (wrong) salt; a companion test confirms the local high-water mark is updated from `record.seq`, not `envelope.seq`, after a successful L3-verified restore.
- **`HorizonTuple` completeness (new in v3, item 5):** type-level/unit test that both `checkpoint` and `tip` horizons expose `R_N` and `endIndex`, and that L1's tail-check and L0's on-chain-agreement check each consume the correct one of the two (not silently swapped).

### 11.2 Integration tests (against a real `midnight-node` + indexer, testcontainers)
- End-to-end `serialize → CheckpointStore.save → load → restoreAnchoredCheckpoint → start` on a live devnet, extending the existing `serializationAndRestoration.integration.test.ts` two-step restore-then-start flow (brief 04 §1); assert the returned `verificationLevel` is exactly `"L0+L1+L3"` for a properly-attested checkpoint.
- **Envelope fail-closure (item 2):** a hand-fabricated envelope claiming `envelopeVersion: 2` but omitting `anchor` must throw `SnapshotEnvelopeUnverifiableError` from `restoreAnchoredCheckpoint`, never fall through to an unverified `startFirst`; a genuinely legacy (no `envelopeVersion`) envelope must route only through `restoreLegacyUnverified` and never produce a `verificationLevel`.
- **Coupled finality tuple (item 9):** integration test with a mock endpoint that serves a genuinely-finalized-but-different block's justification alongside the target block's state-read-proof — `verifyFinalizedTuple` must reject, proving the coupling actually holds and isn't just two calls that happen to agree in the happy path.
- Indexer `TreeAnchor` resolver and `unshieldedUtxos` proof woven into `native_e2e.rs` byte-identical reference stream (brief 04 §5); schema-introspection smoke test must not trip on the new fields.
- Tier-1 finality: verify `grandpa_proveFinality(N)` + `state_getReadProof` against a real node, including an authority-set-change spanning warp-sync fragment (brief 10 §1-3).
- **AES-GCM (§7.3.1, items 10/7):** round-trip encrypt/decrypt through the real `CheckpointStore`; nonce-uniqueness property test across a large save volume for one wallet (asserting the `uint64(seq)||uint32(chunkIndex)` layout is injective in practice, not merely by argument); confirm `manifestHash` changes and `snapshotRoot`/attested `commitment` do not change across a key-rotation re-save of identical plaintext; **new in v3:** confirm two different `save()` calls of byte-identical plaintext for the same wallet produce **different** ciphertext (the corrected item-7e claim — this must now FAIL against the old encrypt-then-chunk/random-nonce framing and PASS against the monotonic-nonce construction); confirm AAD tampering (swapped `chunkIndex`, wrong `encKdfVersion`) fails GCM authentication.
- **Authenticated L3 lookup, present-vs-absent (new in v3, item 1):** integration test with a mock endpoint that serves a stale-but-genuinely-finalized old checkpoint block alongside an unauthenticated (non-read-proof-backed) attestation record — `fetchAuthenticatedAttestation` must reject the record as unauthenticated rather than accept it; a companion test confirms a state-read-proof correctly proving *non-membership* of `id` at the fresh tip height produces `probe.present === false` (the only case still allowed to downgrade silently to `"L0+L1"`), while a state-read-proof for a *present-but-mismatched* record throws `RollbackDetectedError`, never downgrades silently.
- **L1 tail check non-triviality (new in v3, item 6):** integration test asserting `checkpointHorizon.endIndex !== tipHorizon.endIndex` in the normal case (i.e. the tip has actually advanced past the checkpoint), and that `verifyTailComplete` is invoked with a genuinely non-empty range — regression test for the v2 no-op bug.
- **Legacy pre-restore probe (new in v3, item 11):** integration test where a wallet with a real on-chain attestation is served an anchor-less (legacy-shaped) envelope; `restoreLegacyUnverified(serialized, conn, identity)` must throw `LegacyRestoreRefusedError` rather than silently restoring unverified; a companion test confirms `restoreLegacyUnverified(serialized)` (no `conn`/`identity`) still proceeds unverified, documenting the named residual for that sub-case.

### 11.3 Real-preprod exercise
- Restore a wallet from an UmbraDB snapshot taken at a **finalized** preprod checkpoint N, verify the anchor against preprod's committed `zswapMerkleTreeRoot`, catch up `[N, tip]` live, and confirm balance parity with a from-genesis replay control. (Note the memory-file caveat: our own preprod experience shows the installed wallet-SDK API can differ from in-tree tooling — pin versions.)
- Dust anchor exercised separately and flagged: dust roots are `@beta`, Tier-F-lite, and **not** node-cross-checked (brief 04 §3) — assert the softer trust posture explicitly, and assert the SDK never labels a dust-only restore `"L0+L1+L3"` without the dust caveat surfaced.

### 11.4 Failure / recovery (cold-boot — the core scenario, plus the post-activation scenario new in v2)
- **Cold-boot from zero local state:** wipe all local wallet memory, restore purely from UmbraDB, confirm `restoreAnchoredCheckpoint` reconstructs correct state; confirm that *without* the L3 on-chain attestation a rolled-back snapshot is undetectable, and *with* it the cold-booted wallet detects the rollback via the chain pointer (the argument in §3 — this is the test that justifies L3 being v1).
- **Post-activation rollback discovery (§3.6, new in v2):** resume from a stale-but-genuine snapshot with no attestation check available at restore time (or one that passed because it was the honestly-latest state at that moment), advance to `active`, then have a sibling device (or the test harness) advance the on-chain pointer past what this device's active state descends from; confirm the periodic recheck (or the mandatory pre-spend recheck, tested separately) transitions the wallet to `quarantined`, freezes outbound operations, and completes the §3.6 recovery sequence without data loss beyond the documented residual.
- **Pre-spend recheck (§3.6):** confirm a spend attempted immediately after an off-band pointer advance is blocked by the mandatory pre-spend recheck, not merely by the periodic one (tests the stricter of the two triggers independently).
- Corrupted chunk / manifest → `ChunkIntegrityError`/`ManifestCorruptError` surfaces and restore falls back to replay (never bricks — brief 05 §8).
- Partial/interrupted `save` (AbortSignal) → no half-written manifest; monotonic `seq` unbroken.

### 11.5 Adversarial tests (each maps to a threat in brief 05 §3)
- **Omission (A1/completeness):** malicious indexer stub that (a) omits a *committed* leaf → L1 root check must catch; (b) downgrades a ciphertext to `None` → must be caught only by NxN cross-indexer disagreement, and the test **documents** it is NOT caught by the single-indexer root check nor by L0/L1 (the honest, unified §5.0/§5 residual).
- **Rollback (A2):** DB serves an old-but-genuine snapshot → L3 CAS pointer rejects for a cold-booted wallet; L2 monotonic rejects for a running wallet; §3.6's periodic/pre-spend recheck rejects for an already-`active` wallet that missed the initial detection.
- **Cross-wallet swap (A3):** hosted multi-tenant DB serves another tenant's genuine attested snapshot → fails the per-wallet salt/id commitment check.
- **Attestation forgery (A4):** plant an on-chain attestation for an attacker-chosen hash → fails without `sk_attest`.
- **Envelope fabrication (new in v2, item 2):** a freshly fabricated envelope with no `anchor` (mimicking either a legacy snapshot or an attacker's attempt to skip verification) is proven to be structurally incapable of producing a `verificationLevel` result via any code path.
- **Successor/vk substitution (new in v2, item 4):** an attestation record referencing a different `statementVersion`/contract than the pinned client config is rejected outright, even if otherwise well-formed — proving v1's immutability commitment is enforced, not just documented.
- **Tag-collision (§6 overlay):** two addresses producing colliding detection tags → confirm the wallet still trial-decrypts correctly and no false-negative note loss; confirm a malicious indexer omitting a *tag* is bounded by NxN (the §6 residual).
- **Split-view / equivocation (multi-device):** DB shows different snapshots to two devices → each device's independent anchor check accepts only chain-correct states; BFT-CRDT hash chain detects the horizontal divergence **only once the devices actually exchange histories or check the shared L3 pointer** (item 11) — a companion test with communication permanently withheld documents the divergence going undetected, as an honest residual rather than a silent gap.
- **Owned-note-set substitution (new in v3, item 0):** a hostile DB serves an otherwise-valid envelope with a substituted/tampered `ownedNotesPlain` (e.g. an extra note, or the true owner's notes replaced by an attacker's) while keeping cursor/nullifiers/tree-root/dust/manifest identical → `snapshotRoot` recomputation must diverge from the attested `commitment`, and `restoreAnchoredCheckpoint` must reject at the L3 step. This is the adversarial-side companion to the 11.1 property test — proves the binding holds against an actively hostile substitution, not just a random-input property.
- **Present-but-mismatched attestation (new in v3, item 1):** DB serves a genuine, present on-chain attestation record for this wallet's `id` that does not match the served envelope (wrong `commitment`, wrong `attestLeaf` fields, or wrong `seq`) → must throw `RollbackDetectedError`, never silently downgrade to `"L0+L1"`; a companion test with a genuinely-absent record (first-ever attestation) confirms that case alone still downgrades quietly, proving the two paths are actually distinguished, not just documented as distinguished.

### 11.6 Claim-to-test matrix (the correctness gate)
The correctness-audit spec gate must confirm each design claim has a falsifying test before implementation: (C1) offline recompute = on-chain root → 11.1 collapse-invariant + 11.3; (C2) tail scan verifiably complete (tree-level, per §5.0's scoping) → 11.1 L1 + 11.5 omission; (C3) rollback detectable on cold-boot AND post-activation → 11.4 + 11.5 A2; (C4) finality verifiable not assumed, as one coupled tuple → 11.2 Tier-1 + coupled-tuple test; (C5) remote DB is availability-only for the consensus-reduced (shielded/dust) tier, federated-quorum for unshielded/dust-beta (§2.6) → 11.5 A1-A4; (C6) completeness residual is exactly the unified ciphertext-delivery/wallet-identity-binding gap of §5.0 + spend-hiding → 11.5 omission documents the non-caught cases; (C7, new) the Domain P/Domain S separation holds under key rotation → 11.1 canonical-equation test; (C8, new) the vk/contract pin is enforced, not advisory → 11.5 successor-substitution test; **(C9, new in v3)** `snapshotRoot` binds the owned-note set (a substitution changes the root) → 11.1 owned-notes-binding property test + 11.5 owned-note-set substitution; **(C10, new in v3)** a present-but-mismatched L3 record hard-fails distinctly from a genuinely-absent one → 11.2 authenticated-lookup test + 11.5 present-but-mismatched test; **(C11, new in v3)** the L1 tail check is non-trivial in the normal case → 11.2 L1 tail non-triviality test.

---

## 12. Open decisions for the design council to ratify

**D0 (new, blocking) — canonical versioned snapshot-section encoding (CBOR/CDDL), promoted from the v1 draft's "secondary" list.** Ratify §2.5.4: without a byte-exact canonical encoding per plaintext section, `snapshotRoot` (§2.5.2) is not well-defined and every downstream equality check is unsound. This must land before any V2 implementation work, not alongside or after it.

**D1 (top) — L3 primary = the Compact Attested Manifest Root, and it is v1, not optional, for the remote case.** Ratify that a cold-booted wallet restoring from an untrusted DB genuinely needs a consensus-held monotonic pointer (§3), so the on-chain attestation ships in v1 for remote/hosted deployments (optional only for purely-local single-writer). Ratify V1b+V2 shape with `prevCommitment` from day one, using the canonical attestation equation of §2.5.3 (not the v1 draft's looser, contradictory version). Accept the §1 framing as a written non-goal: we defend against a hostile *DB*, not a wallet compromised *at attest time* (brief 05 Q3, also now §10 item 4) — or the feature over-claims.

**D2 — ship v1 with the documented Zcash-parity completeness residual (§5, precisely scoped per §5.0).** Ratify that ciphertext-delivery + spend-hiding remain open in v1 — understood as the *same* underlying wallet-identity-binding gap identified independently as item 7, not two separate gaps — bounded by NxN + only-spend-own-notes (correctly scoped) + first-spend re-validation (correctly scoped, §5.1), and are closed only by a Midnight node change we will formally request (body-inclusion proof / header ciphertext-accumulator / nullifier accumulator). This is the industry-standard position (brief 09 §8); the alternative is blocking v1 on a protocol change we don't control.

**D3 — privacy-from-scanner: overlay-now vs consensus-later (§6).** Ratify shipping the overlay detection tag as v1.x (privacy win, completeness still bounded), and formally requesting the consensus-emitted clue key (FMD) from Midnight as the principled close of both privacy and ciphertext-delivery completeness. Accept that an overlay tag is itself omittable (brief 09 §10).

**D4 (new) — vk/circuit succession: v1 ships fully immutable, hard-pinned (§3.5, option a).** Ratify that v1 client config hard-pins `contractAddress` + `attestCircuitVkHash` + `attestStatementVersion`, that v1 clients never auto-follow a governance-selected successor, and that this pin is a named §10 residual-trust item rather than an implicit assumption. Ratify the successor-certificate mechanism (§3.5, option b) as the specified, not-yet-built v1.1+ upgrade path, to be re-ratified separately before it ships.

**D5 (new) — unshielded/dust are Tier-F (federated quorum), not consensus-reduced, and must be labeled as such everywhere (§2.6).** Ratify that v1 ships the signed-STH + k-of-n monitor mechanism for unshielded and continues serving `@beta` dust roots, but that "verified"/"trustless" language is reserved for the consensus-reduced shielded/dust-root path and never applied unqualified to these two.

**D6 (new, v3) — `snapshotRoot` binds `ownedNotesPlain`, and the restore-time correctness question is resolved via option (b) + a named (a)-residual for the base (§2.5.5).** Ratify: (1) the canonical `snapshotRoot` equation (§2.5.2) includes a required `ownedNotesPlain` section, closing the round-2-identified defect that the equation didn't actually bind the wallet's owned-note set despite §3's prose claiming it did; (2) the restore-time correctness of that section is established by the live `[N, tip]` catch-up sync independently re-deriving owned notes going forward (option b — no new mechanism, this is §1's existing baseline catch-up), bounding attest-time-honesty reliance (option a) to exactly the base set at N, which is named explicitly as a §10 item-4 sub-residual rather than left implicit. Ratify that this closes *binding* (a substituted/tampered owned-note set changes the root) and is explicitly orthogonal to the pre-existing *completeness* residual (§5/§5.1, unchanged).

**Secondary (flag, not blocking):** finality Tier-0 → Tier-1 sequencing (§4); `R_utxo` anchoring option 2 vs waiting for a consensus utxo-root (brief 06 §4.4); HD path for `sk_attest` and interaction with key rotation (brief 05 Q7); BFT-CRDT device-key membership/revocation and non-commutative merge-rule design (§2 item 11, explicitly deferred, not silently assumed solved); minimum multi-device history-exchange cadence, or reliance on the L3 pointer as a connectivity-free shared head (§2 item 11); whether the node/ledger actually exposes a per-contract deployed-verifier-key-hash read for `assertContractVkPinned` (§7.1(b), item 3) to check against at session start — needs confirming against Midnight's contract-state API before implementation, flagged rather than assumed.

**The biggest risk.** Over-claiming completeness — unchanged from v1, but now backed by the corrected §5.0 claim rather than the retracted one, and by v3's actual owned-notes binding rather than a claim about it that the governing equation didn't yet implement. The design's honesty rests on stating, everywhere "verified" appears, that v1 proves *commitment*-completeness (of the shared, global tree) + *binding* of the attested owned-note set (v3) + inclusion + rollback-resistance (conditional on the residuals in §10) + finality-anchoring (as one coupled tuple), but **not** ciphertext-delivery or spend completeness, **not** correctness of the owned-notes base at N beyond attest-time honesty (v3, §10 item 4), and **not** consensus-reduced trust for the unshielded/dust paths — those need a node change or remain Tier-F by design. A design that quietly implies "fully verified, no trust in the feed" would be wrong in exactly the way brief 06 §2.4 / brief 07 §3.1 / brief 09 §10 warn, and would mislead users into financial decisions against a possibly-under-counted balance. Second-order risk, unchanged: L3-a's hand-written, compiler-un-attested IR + pinned vk is a new trust surface that must be audited before v1.1, or it "verifies" nothing useful (brief 07 §6.3). Third-order risk, new in v2: a compromised or careless client-software update that changes the §3.5 pin is now a named, auditable event rather than an implicit possibility — the mitigation is process (software-update review), not cryptography, and this document does not claim otherwise. Fourth-order risk, new in v3: this round's fix pattern — a prose claim getting ahead of the governing equation that's supposed to enforce it — is exactly what produced the round-2 defect in the first place; future revisions should diff every "the root covers X" prose claim against §2.5.2's actual equation before publishing, not trust that a prior correction of the prose was itself sufficient.

---

*Grounding: briefs 01–11 in `design/research/2026-07-21-snapshot-root-of-trust/`; UmbraDB `src/interfaces/checkpoint-store.ts`, `src/postgres/checkpoint-store.ts` (encryption-status claim verified directly against this file for v2 — item 10; sequence-allocation ordering re-verified directly against `src/postgres/checkpoint-store.ts:139-173` for v3 — item 7), `Formal/STORAGE_ALGEBRA.md` §6, `design/design.md` (`getOrCreateSalt`/`PgPrivateStateProvider` cross-check for v2); Midnight source cited inline. No Midnight source modified; nothing committed to Midnight. v2 revision responds to a 3-reviewer design-council audit (Claude Fable 5 / Claude Opus / GPT-5.6 Sol via Codex); v3 revision responds to a round-2 audit by the same three reviewers (Fable 5 and GPT-5.6 Sol independently converged on the core owned-notes-binding defect; Opus's no-round-3 verdict included one folded-in item).*
