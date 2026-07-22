# Verifiable Wallet-State Snapshot — Design (roll-up)

**Branch:** `fix/verifiable-snapshot-v2` (was `feature/verifiable-snapshot`) · **Date:** 2026-07-22 · **Status:** v2 — revised after adversarial design-council review; ready for a second review pass before implementation begins.
**Author role:** Design Lead, synthesizing research briefs 01–11 (`design/research/2026-07-21-snapshot-root-of-trust/`) plus the v2 fixes below.

This document is **decisive** — it recommends one v1 design and states what is deferred — but it flags, in §12, the genuinely open decisions the council must ratify before any implementation begins. Every load-bearing choice is grounded in a brief (cited `[NN]`) and, where the mechanism lives in Midnight, a `repo/path:line`.

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

The reduction that governs every layer (brief 03 §0's theorem): **the DB is never a source of correctness — only of availability.** Every no-replay check must reduce S to a check against an **on-chain commitment the wallet independently trusts**, whose trust in turn reduces to **consensus/finality**. Content-addressing and AES-GCM prove "the bytes I read are the bytes written"; they never prove "the bytes are the correct chain-derived state" (brief 03 §0). That gap is what this design closes — **for the shielded/dust path, by reduction to consensus; for the unshielded path in v1, only to a federated quorum of indexer operators, explicitly weaker and named as such in §2.6.** Every plaintext/semantic value this document calls a "commitment" is precisely defined in §2.5; a canonical, versioned byte-encoding of every committed section (old §12 Q6) is a **blocking v1 requirement**, not optional plumbing — without it, the equations in §2.5 aren't well-defined.

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
   L1 Bounded-scan   │  Shielded/dust: collapsed-tree range proof vs on-chain root  │
   completeness      │    (ADS already present — 06 §2.1) — consensus-reduced       │
   (ADS)             │  Unshielded: NEW authenticated by-address MB-tree index      │
                     │    — federated-quorum trust tier, NOT consensus-reduced;     │
                     │    see §2.6                                                   │
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
- `nullifiersPlain` — canonical encoding of the wallet's known-spent set at N.
- `historyRef` — a reference into L3's on-chain `history` tree (§8), not a local blob.
- `dustPlain` — dust-tree state, if applicable.
- `manifestSectionPlain` — a plaintext *description* of which storage sections exist (which chunk ranges hold which logical section) — used only as an input section of the semantic root; this is a namesake of, but never equal to, `CheckpointStore.manifestHash` (Domain S below). The old draft's collision of these two names is exactly what produced the contradiction; v2 keeps the names visibly distinct in this section on purpose.

The **semantic root** (V2's `snapshotRoot`) is a domain-separated hash tree over exactly these plaintext sections, using the canonical encoding of §2.5.4:

```
snapshotRoot := H_dom("umbradb:snapshot:v2:root",
                        H(cursorPlain), R_N^tree, H(nullifiersPlain),
                        historyRef, H(dustPlain), H(manifestSectionPlain))
```

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

**2.5.4 Canonical encoding — promoted from secondary to blocking v1 requirement.** The v1 draft's §12 listed "canonical versioned snapshot-section encoding (CBOR/CDDL)" as secondary/non-blocking — but V2 (the design this document selects for v1) cannot be implemented without it: every hash above requires a byte-exact, versioned, canonical serialization of each plaintext section, or two semantically-identical snapshots (e.g. differing only in map key order) silently produce different `snapshotRoot` values, breaking every downstream equality check. **This is now §12 D0, blocking:** define a CDDL schema for each plaintext section (cursor, nullifier set, dust state, manifest-section description) under an explicit `encodingVersion` tag carried inside `attestLeaf`. A future encoding change ships as a new `encodingVersion`, never a silent reinterpretation of old bytes.

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

**Recommendation — v1 ships (c), the Compact "Attested Manifest Root" (brief 05, variant V1b+V2).** The decisive argument: the feature's *raison d'être* is restore from a **REMOTE/UNTRUSTED** DB after **memory loss**, and in that exact scenario the wallet has no local monotonic counter, so the only thing that can tell a cold-booted wallet "the DB just served you an old-but-genuine snapshot" is a monotonic pointer held **outside the DB's control, on the one authority this design designates as its root of trust** — the chain's finalized head (that designation is itself contingent on GRANDPA's safety assumption and a weak-subjectivity-bootstrapped authority set, §10 item 1 — "the chain is trusted" inside this document's threat model, not unconditionally in absolute terms; the v1 draft's phrasing overstated this). Midnight's transcript/CAS execution model makes this rollback protection *structural and free*: a replayed old `attest` tx re-runs its transcript against current state, the recorded height-monotonicity `assert` no longer holds, and the tx fails (brief 05 §4.3, C7). One small shared contract (bigger anonymity set) closes threats A1–A4 (substitution, rollback, cross-wallet swap, forgery) — **conditional on** a fresh finalized view (A5, unclosed, §4/§10 item 2) and honest attest-time behavior (§10 item 4) remaining true; it does not eliminate either, and does not by itself provide any post-activation safety story (that gap, and its fix, is §3.6).

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
3. **Re-anchor:** re-run `restoreAnchoredCheckpoint()` against the checkpoint the attestation pointer's `commitment`/`historyRef` identifies. If that snapshot's blob is unavailable or fails its own L0/L1 checks, fall back to a full replay from the last independently-authenticated floor (§1's normal `[N, tip]` catch-up mechanism, just triggered from a deeper floor than usual).
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
seq: Schema.Number,
```

An envelope with **no** `envelopeVersion` field at all is, by definition, pre-upgrade legacy — it cannot enter `restoreAnchoredCheckpoint()` (§7.1(b)) at all; decoding routes it exclusively to `restoreLegacyUnverified()` (§7.1(d)), which can never return a "verified" result. A malformed v2 envelope (claims `envelopeVersion: 2` but is missing/corrupt `anchor`) is a hard schema-validation failure, not a silent fallback.

`buildSnapshot` reads `w.state.merkleTreeRoot` (already on `ledger.ZswapLocalState`, `ledger-v8.d.ts:2996`; dust via `commitmentTreeRoot()`/`generatingTreeRoot()`, `:1596,1601`) plus the block anchor from the new indexer field (7.2), and computes `snapshotRoot` per §2.5.3.

**Legacy migration policy:** on the first successful post-upgrade `save()` of a legacy wallet, the SDK forces a fresh full anchor capture (re-derives `R_N`/cursor/`endIndex` at the current sync tip) and writes `envelopeVersion: 2` — a **forced re-anchor on first post-upgrade save**. `SnapshotStorage` exposes `requiresReanchor(summary): boolean` so callers can surface this to users/telemetry.

**(b) `restoreAnchoredCheckpoint()` — renamed from `restoreVerified()`, and rewritten to actually implement its own flagship guarantee.** *Rewritten in v2 to fix item 6 (a real functional gap: the old sketch ran L0+finality+L1 only, took no `sk_attest`, ran no L3 check and no L2 sequence check, yet returned a bare `Promise<Wallet>` as though it had) — and to fix item 9 (all checks now consume one coupled `horizon` tuple, §4).*

```ts
type VerificationLevel = "L0" | "L0+L1" | "L0+L1+L3";

interface AnchoredRestoreResult {
  wallet: Wallet;
  verificationLevel: VerificationLevel;      // callers can no longer mistake a partial-tier
                                              // restore for the full L3 guarantee
  horizon: { blockHeight: number; blockHash: string; finalizedHash: string };
  residuals: readonly string[];              // e.g. ["ciphertext-delivery-completeness (§5.0)",
                                              // "spend-hiding (§5.1)", "attest-time-honesty (§10.4)"]
}

static async restoreAnchoredCheckpoint(
  serialized: string,
  conn: { indexerHttpUrl: string; grandpaEndpoints: string[]; contractAddress: string },
  identity: { skAttest: Bytes32 },           // NEW -- required to derive the L3 pseudonym id;
                                              // its absence was the old sketch's tell that L3 was never wired in
): Promise<AnchoredRestoreResult> {
  const envelope = deserializeEnvelope(serialized);
  if (envelope.envelopeVersion !== 2 || !envelope.anchor) {
    throw new SnapshotEnvelopeUnverifiableError();     // fail-closed (§7.1(a)/item 2), never silently downgrades
  }
  const anchor = envelope.anchor;

  // ONE finalized tuple; every later check consumes only this object (§4, item 9)
  const horizon = await verifyFinalizedTuple(conn, anchor.blockHash);
  if (horizon.blockHash !== anchor.blockHash) throw new SnapshotAnchorMismatchError();

  // L0a: offline self-consistency
  assertLocalRootMatches(envelope, anchor);
  // L0b: on-chain agreement -- against horizon.R_N, not a second independently-fetched value
  if (horizon.R_N !== anchor.zswapMerkleTreeRoot) throw new SnapshotAnchorMismatchError();
  // L0c: finality was already checked inside verifyFinalizedTuple -- not repeated here
  let level: VerificationLevel = "L0";

  // L1: bounded-scan completeness, tail rehashed up to horizon.endIndex/tip
  await verifyTailComplete(conn.indexerHttpUrl, anchor.zswapEndIndex, horizon);
  level = "L0+L1";

  // L2: local anti-rollback sequence check -- entirely absent from the old sketch
  assertSeqNotBelowHighestAccepted(envelope.seq, loadLocalHighWaterMark());

  // L3: on-chain attestation check -- MANDATORY for a "L0+L1+L3" result; absent/mismatched/stale
  // is NOT a hard error for local/optional-L3 deployments (§3) but MUST downgrade the reported tier
  const id = derivePseudonymId(identity.skAttest);
  const record = await fetchLatestAttestation(conn.contractAddress, id);
  const expectedCommitment = record
    ? persistentCommit(envelope.snapshotRoot, deriveSalt(identity.skAttest, record.seq))
    : undefined;
  if (record && record.commitment === expectedCommitment && record.height <= horizon.blockHeight) {
    level = "L0+L1+L3";
    updateLocalHighWaterMark(envelope.seq, horizon.blockHeight);   // rearms L2 for the next restore
  }

  const wallet = await startFirst(Wallet, envelope.deserialized);
  return { wallet, verificationLevel: level, horizon, residuals: RESIDUALS_FOR[level] };
}
```

This is a gate in front of the existing resume path — no change to `Sync.ts`'s `resumeFrom` (brief 04 §4b). It finally *calls* `applyCollapsedUpdate`, which the ledger crate exposes but the wallet never invokes (brief 04 §2, brief 06 §7). Once `verificationLevel: "L0+L1+L3"` is returned, the wallet transitions to `verified-at-finalized-head` in §3.6's state machine; callers proceed through `caught-up → active` and must wire in §3.6's periodic/pre-spend recheck.

**(c) `SnapshotStorage` interface** — mirror the reader/writer split of the existing `TransactionHistoryStorage` (`abstractions/src/TransactionHistoryStorage.ts:215-216`), which is a plain injected interface with **no in-memory assumption baked in**. Today the `serialize()`/`restore()` blob is a bare `string` the caller must persist itself — there is no pluggable snapshot-storage seam the way there is for tx-history (brief 04 §4c). Adding `SnapshotStorage` lets UmbraDB back *both* snapshot and tx-history through one facade constructor arg.

**(d) `restoreLegacyUnverified()` — new in v2, the explicit unverified path required by item 2.** A separately-named static factory for envelopes with no `envelopeVersion` field (pre-upgrade legacy snapshots):

```ts
static async restoreLegacyUnverified(serialized: string): Promise<{ wallet: Wallet }> {
  const deserialized = deserializeLegacy(serialized);   // the pre-v2 shape only
  // deliberately NO anchor/finality/L1/L3 checks -- there is nothing to check against
  return { wallet: await startFirst(Wallet, deserialized) };
}
```

This return type has **no** `verificationLevel` field at all — it cannot be confused, structurally, with a verified result. Callers are expected to flag wallets restored this way for a forced re-anchor at next save (§7.1(a)'s migration policy) and, if the deployment is remote/untrusted, to treat the restored state as unverified until that re-anchor completes.

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
- The **CheckpointStore `WalletState` envelope** carries the serialized local state + the new L0 anchor manifest + `snapshotRoot` as one atomic unit; L2's AES-GCM (§7.3.1, **not yet implemented — v1 blocking requirement**) wraps the plaintext before it reaches chunking; L3's attestation commits `snapshotRoot` (Domain P), never `manifestHash` (Domain S).

### 7.3.1 AES-256-GCM v1 requirement — new in v2, replaces the retracted "already implemented" claim (item 10)

**What was actually found in current source, verified directly (not trusted from prior prose):**

```
$ git show origin/main:src/postgres/checkpoint-store.ts   # saveImpl()
  chunkHashes = chunks.map(sha256)
  manifestHash = sha256(Buffer.concat(chunkHashes))
  INSERT INTO ckpt_chunks (hash, data) VALUES (chunkHashes[i], chunks[i])   -- raw bytes, unencrypted
```

No `encrypt`, `AES`, or `GCM` symbol appears anywhere in `src/interfaces/checkpoint-store.ts` or `src/postgres/checkpoint-store.ts`. The only hit for `getOrCreateSalt` in the whole `origin/main` tree is in `design/design.md`'s description of `PgPrivateStateProvider`'s per-`(accountId, scope)` salt — an entirely separate subsystem (Midnight contract *private state* storage, not wallet snapshots). The v1 draft's §2 claim that "UmbraDB already implements this" was false; corrected throughout (§2, §7.3).

**v1 requirement spec (blocking, not yet built):**

- **Nonce-uniqueness rule:** counter-based, not random — `nonce := (walletId, networkId, manifestSeq, chunkIndex)`-derived, 96 bits, REQUIRED over random generation. Counter-based is strictly safer here (avoids birthday-bound collision risk entirely) and is free to implement since `seq` and chunk position are already tracked by `CheckpointStore`.
- **KDF / domain separation:** `key := HKDF-SHA256(ikm = seed-derived attest-adjacent secret, info = "umbradb:snapshot:v2:enc:" || walletId || networkId || scope, salt = per-(walletId,networkId) random 32-byte value stored alongside the manifest)`. This salt is a **new, dedicated** value — explicitly **not** `getOrCreateSalt`, which belongs to the unrelated private-state-provider subsystem and must not be reused across subsystems. Version this construction as `encKdfVersion`, tracked the same way as `encodingVersion` (§2.5.4).
- **Authenticated data (AAD):** bind `(walletId, networkId, sequence, envelopeVersion)` into the GCM AAD so ciphertext cannot be silently moved between wallets/checkpoints/sequence positions without detection.
- **Key rotation / migration:** rotation re-encrypts chunks (v1 policy: eager re-encryption on next `save()`; lazy read-through re-encryption is an acceptable v1.1 relaxation). Per §2.5.2, rotation changes `manifestHash` (Domain S) but by construction cannot change `snapshotRoot` (Domain P) or any attested commitment — this is the concrete fix for the bug where the v1 draft's conflated domains would have broken every prior attestation on rotation.
- **Content-addressed dedup interaction, stated explicitly rather than left implicit:** `CheckpointStore`'s chunk table is globally content-addressed by ciphertext hash. Two wallets/checkpoints with identical plaintext but different keys/nonce-derivation contexts produce different ciphertext and do not collide — no leak there. But identical plaintext encrypted under the **same** key+nonce-derivation context (e.g. a wallet re-saving byte-identical state) **will** produce identical ciphertext and will dedupe — an operator of the storage layer can observe that two checkpoints for the *same* wallet are byte-identical. This is a low-severity equality leak inherent to any content-addressed store; it is now a documented residual (§10) rather than an unstated one.

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

*Updated in v2: encryption row corrected (item 10), unshielded/dust rows relabeled Tier-F (item 8), canonical encoding promoted to blocking (item 1), envelope versioning and restore-API rows added (items 2, 6).*

| Capability | Layer | v1 (no protocol change) | Needs node/protocol change | Research-grade |
|---|---|---|---|---|
| Canonical versioned section encoding (CBOR/CDDL) | §2.5.4 | ✅ **blocking, promoted from secondary [D0]** | | |
| Anchor tuple persisted + offline root recompute | L0 | ✅ [01 §6] | | |
| On-chain agreement check (`block(offset)`), coupled tuple | L0/§4 | ✅ `verifyFinalizedTuple` [item 9] | | |
| Finality: Tier-0 k-of-n RPC | L0/§4 | ✅ [10 §5] | | |
| Finality: Tier-1 GRANDPA justification + state-read-proof | L0/§4 | ✅ SDK plumbing [10 §3] | | |
| Finality: in-circuit | §4 | | | ✅ defer [08 §6] |
| Shielded/dust commitment-completeness (collapsed-tree ADS) — **consensus-reduced** | L1 | ✅ SDK wires up existing API [06 §2] | dust roots `@beta`, not node-cross-checked [06 §2.5] | |
| Unshielded authenticated by-address index (MB-tree) — **Tier-F, federated quorum, NOT consensus-reduced [§2.6]** | L1 | ✅ indexer signed-STH + monitor [06 §4.4-②] | consensus utxo-root for full trustlessness [06 §4.4-①/③] | |
| Envelope versioning + fail-closed legacy split | §7.1(a)/(d) | ✅ **new, blocking [item 2]** | | |
| `restoreAnchoredCheckpoint` (L0+L1+L2+L3, structured result) | §7.1(b) | ✅ **new, blocking [item 6]** | | |
| Client-side AES-GCM | L2 | ❌ **NOT implemented today, verified against source [item 10]; v1 blocking, spec §7.3.1** | | |
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
4. **Attest-time honesty (L3-c) / circuit-and-pin correctness (L3-a, and the vk pin itself) — expanded in v2, §3.5.** The attestation transports correctness forward but cannot create it — a wallet compromised *at attest time* pins bad state (an explicit non-goal; brief 05 §1). The offline proof only means "the statement *this vk's circuit* encodes holds" — the hand-written IR must be audited and its vk pinned (brief 07 §6.3). **New in v2:** the L3-c contract/vk pin itself (§3.5) is a named residual — v1 clients trust that their hard-pinned `contractAddress`/`attestCircuitVkHash`/`statementVersion` were pinned correctly and that the client software delivering that pin is honest; a compromised software update that silently changes the pin is the attack this design is *not* trying to solve, same class as "the client software is honest" generally, but now named explicitly for this component because a bad pin has outsized blast radius (silent acceptance of a malicious successor circuit).
5. **Ciphertext-delivery + spend completeness — restated precisely per §5.0.** Open in v1 (§5) — Zcash-parity, bounded by NxN + only-spend-own-notes (scoped correctly, §5.0) + first-spend re-validation (scoped correctly, §5.1), fully closed only by a node change. This is the *same* residual as "L0+L1 don't bind wallet identity" (item 7) — not a second, independent gap.
6. **Privacy.** Rests on the seed's ≥256-bit entropy and the secrecy of the seed-derived key (brief 03 §7). The remote scanner still learns ownership until the detection-tag overlay ships (§6). **New in v2:** the AES-GCM content-addressed dedup interaction (§7.3.1) is a documented low-severity residual — an operator can observe that two checkpoints for the *same* wallet are byte-identical.
7. **Multi-device split-view detection requires an active communication precondition — new in v2, §2 L2 bullet 3 / item 11.** Hash-chained, signed deltas detect tampering only between devices (or a device and the L3 pointer) that actually compare notes on some cadence; a malicious DB can otherwise show indefinitely divergent forks to devices that never exchange history. Device-key membership/revocation and non-commutative merge-rule specification remain explicitly out of scope for v1.
8. **Trusted-setup + proving-system soundness** (KZG BLS12-381 SRS, Halo2) — shared with the entire chain, not new to us (brief 07 §6.5-6).

The DB itself is trusted for **availability only** — strengthened by plain multi-host replication extending the NxN habit to the blob (brief 11 §3; erasure-coding/DAS explicitly rejected as disproportionate at wallet-snapshot scale). **TEE attestation is rejected** as a substitute (attests code identity, not chain-relative data; its own root of trust has broken repeatedly — Foreshadow/SGAxe/Downfall, and the wallet-shaped Secret Network consensus-seed extraction — brief 11 §1); acceptable only as an orthogonal at-rest confidentiality layer *underneath* the anchor.

---

## 11. Post-implementation testing strategy

Every design claim must map to a test that could falsify it. Organized by layer and by the adversary each defends against. *v2 adds tests for the state machine (§3.6), envelope fail-closure (§7.1), coupled-tuple finality (§4), the AES-GCM spec (§7.3.1), and the corrected L0/L1/L0+L1+L3 claims (§5.0, §7.1(b)).*

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

### 11.2 Integration tests (against a real `midnight-node` + indexer, testcontainers)
- End-to-end `serialize → CheckpointStore.save → load → restoreAnchoredCheckpoint → start` on a live devnet, extending the existing `serializationAndRestoration.integration.test.ts` two-step restore-then-start flow (brief 04 §1); assert the returned `verificationLevel` is exactly `"L0+L1+L3"` for a properly-attested checkpoint.
- **Envelope fail-closure (item 2):** a hand-fabricated envelope claiming `envelopeVersion: 2` but omitting `anchor` must throw `SnapshotEnvelopeUnverifiableError` from `restoreAnchoredCheckpoint`, never fall through to an unverified `startFirst`; a genuinely legacy (no `envelopeVersion`) envelope must route only through `restoreLegacyUnverified` and never produce a `verificationLevel`.
- **Coupled finality tuple (item 9):** integration test with a mock endpoint that serves a genuinely-finalized-but-different block's justification alongside the target block's state-read-proof — `verifyFinalizedTuple` must reject, proving the coupling actually holds and isn't just two calls that happen to agree in the happy path.
- Indexer `TreeAnchor` resolver and `unshieldedUtxos` proof woven into `native_e2e.rs` byte-identical reference stream (brief 04 §5); schema-introspection smoke test must not trip on the new fields.
- Tier-1 finality: verify `grandpa_proveFinality(N)` + `state_getReadProof` against a real node, including an authority-set-change spanning warp-sync fragment (brief 10 §1-3).
- **AES-GCM (§7.3.1, item 10):** round-trip encrypt/decrypt through the real `CheckpointStore`; nonce-uniqueness property test across a large save volume for one wallet; confirm `manifestHash` changes and `snapshotRoot`/attested `commitment` do not change across a key-rotation re-save of identical plaintext.

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

### 11.6 Claim-to-test matrix (the correctness gate)
The correctness-audit spec gate must confirm each design claim has a falsifying test before implementation: (C1) offline recompute = on-chain root → 11.1 collapse-invariant + 11.3; (C2) tail scan verifiably complete (tree-level, per §5.0's scoping) → 11.1 L1 + 11.5 omission; (C3) rollback detectable on cold-boot AND post-activation → 11.4 + 11.5 A2; (C4) finality verifiable not assumed, as one coupled tuple → 11.2 Tier-1 + coupled-tuple test; (C5) remote DB is availability-only for the consensus-reduced (shielded/dust) tier, federated-quorum for unshielded/dust-beta (§2.6) → 11.5 A1-A4; (C6) completeness residual is exactly the unified ciphertext-delivery/wallet-identity-binding gap of §5.0 + spend-hiding → 11.5 omission documents the non-caught cases; (C7, new) the Domain P/Domain S separation holds under key rotation → 11.1 canonical-equation test; (C8, new) the vk/contract pin is enforced, not advisory → 11.5 successor-substitution test.

---

## 12. Open decisions for the design council to ratify

**D0 (new, blocking) — canonical versioned snapshot-section encoding (CBOR/CDDL), promoted from the v1 draft's "secondary" list.** Ratify §2.5.4: without a byte-exact canonical encoding per plaintext section, `snapshotRoot` (§2.5.2) is not well-defined and every downstream equality check is unsound. This must land before any V2 implementation work, not alongside or after it.

**D1 (top) — L3 primary = the Compact Attested Manifest Root, and it is v1, not optional, for the remote case.** Ratify that a cold-booted wallet restoring from an untrusted DB genuinely needs a consensus-held monotonic pointer (§3), so the on-chain attestation ships in v1 for remote/hosted deployments (optional only for purely-local single-writer). Ratify V1b+V2 shape with `prevCommitment` from day one, using the canonical attestation equation of §2.5.3 (not the v1 draft's looser, contradictory version). Accept the §1 framing as a written non-goal: we defend against a hostile *DB*, not a wallet compromised *at attest time* (brief 05 Q3, also now §10 item 4) — or the feature over-claims.

**D2 — ship v1 with the documented Zcash-parity completeness residual (§5, precisely scoped per §5.0).** Ratify that ciphertext-delivery + spend-hiding remain open in v1 — understood as the *same* underlying wallet-identity-binding gap identified independently as item 7, not two separate gaps — bounded by NxN + only-spend-own-notes (correctly scoped) + first-spend re-validation (correctly scoped, §5.1), and are closed only by a Midnight node change we will formally request (body-inclusion proof / header ciphertext-accumulator / nullifier accumulator). This is the industry-standard position (brief 09 §8); the alternative is blocking v1 on a protocol change we don't control.

**D3 — privacy-from-scanner: overlay-now vs consensus-later (§6).** Ratify shipping the overlay detection tag as v1.x (privacy win, completeness still bounded), and formally requesting the consensus-emitted clue key (FMD) from Midnight as the principled close of both privacy and ciphertext-delivery completeness. Accept that an overlay tag is itself omittable (brief 09 §10).

**D4 (new) — vk/circuit succession: v1 ships fully immutable, hard-pinned (§3.5, option a).** Ratify that v1 client config hard-pins `contractAddress` + `attestCircuitVkHash` + `attestStatementVersion`, that v1 clients never auto-follow a governance-selected successor, and that this pin is a named §10 residual-trust item rather than an implicit assumption. Ratify the successor-certificate mechanism (§3.5, option b) as the specified, not-yet-built v1.1+ upgrade path, to be re-ratified separately before it ships.

**D5 (new) — unshielded/dust are Tier-F (federated quorum), not consensus-reduced, and must be labeled as such everywhere (§2.6).** Ratify that v1 ships the signed-STH + k-of-n monitor mechanism for unshielded and continues serving `@beta` dust roots, but that "verified"/"trustless" language is reserved for the consensus-reduced shielded/dust-root path and never applied unqualified to these two.

**Secondary (flag, not blocking):** finality Tier-0 → Tier-1 sequencing (§4); `R_utxo` anchoring option 2 vs waiting for a consensus utxo-root (brief 06 §4.4); HD path for `sk_attest` and interaction with key rotation (brief 05 Q7); BFT-CRDT device-key membership/revocation and non-commutative merge-rule design (§2 item 11, explicitly deferred, not silently assumed solved); minimum multi-device history-exchange cadence, or reliance on the L3 pointer as a connectivity-free shared head (§2 item 11).

**The biggest risk.** Over-claiming completeness — unchanged from v1, but now backed by the corrected §5.0 claim rather than the retracted one. The design's honesty rests on stating, everywhere "verified" appears, that v1 proves *commitment*-completeness (of the shared, global tree) + inclusion + rollback-resistance (conditional on the residuals in §10) + finality-anchoring (as one coupled tuple), but **not** ciphertext-delivery or spend completeness, and **not** consensus-reduced trust for the unshielded/dust paths — those need a node change or remain Tier-F by design. A design that quietly implies "fully verified, no trust in the feed" would be wrong in exactly the way brief 06 §2.4 / brief 07 §3.1 / brief 09 §10 warn, and would mislead users into financial decisions against a possibly-under-counted balance. Second-order risk, unchanged: L3-a's hand-written, compiler-un-attested IR + pinned vk is a new trust surface that must be audited before v1.1, or it "verifies" nothing useful (brief 07 §6.3). Third-order risk, new in v2: a compromised or careless client-software update that changes the §3.5 pin is now a named, auditable event rather than an implicit possibility — the mitigation is process (software-update review), not cryptography, and this document does not claim otherwise.

---

*Grounding: briefs 01–11 in `design/research/2026-07-21-snapshot-root-of-trust/`; UmbraDB `src/interfaces/checkpoint-store.ts`, `src/postgres/checkpoint-store.ts` (encryption-status claim verified directly against this file for v2 — item 10), `Formal/STORAGE_ALGEBRA.md` §6, `design/design.md` (`getOrCreateSalt`/`PgPrivateStateProvider` cross-check for v2); Midnight source cited inline. No Midnight source modified; nothing committed to Midnight. v2 revision responds to a 3-reviewer design-council audit (Claude Fable 5 / Claude Opus / GPT-5.6 Sol via Codex).*
