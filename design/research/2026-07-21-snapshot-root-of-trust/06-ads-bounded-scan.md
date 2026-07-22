# 06 — A lightweight ADS that makes the bounded tail scan [anchor N, tip] verifiably COMPLETE

**Date:** 2026-07-21
**Angle:** Close the one residual every prior brief left open. Briefs 01–05 reduce snapshot
correctness to an on-chain **anchor** and a **bounded incremental scan** of `[N, tip]`, but each
one flags that the anchor proves **inclusion, not completeness** — a note/UTXO addressed to the
wallet can still be *omitted* from the tail, silently under-counting funds. This brief designs a
lightweight authenticated data structure (ADS) that makes the tail scan **verifiably exhaustive**,
grounded in Midnight's real trees and the authenticated-range-query literature.

**Builds on (does not re-derive):** brief 01 (state commitments, collapse-invariant),
brief 02 (Zcash omission residual §5, state-proof completeness caveat §6/§8-②),
brief 03 (the "inclusion ≠ completeness" theorem §1/§3a/§6),
brief 04 (SDK/indexer PR seams), brief 05 (Compact attestation of the frontier).

All `repo/path:line` citations are against the local clones read 2026-07-21; nothing was
modified. Web citations are URLs.

---

## 0. The gap, stated exactly

Every prior brief ends at the same wall. Brief 03 §3(a): membership proofs "prove *inclusion* and
never *completeness* … an untrusted DB can serve a valid-but-partial snapshot that hides funds (an
under-count / denial, not a theft)." Brief 02 §5 names it in the closest analog: Zcash's
`finalSaplingRoot`/witness machinery "proves **inclusion** … but not **completeness/non-omission**
— a server can still hide notes destined to the user, so the wallet under-counts its balance."
Brief 03 §6 calls this "the deepest residual, and it is fundamental": the only ways to establish
completeness are (i) **scan** — trial-decrypt every candidate up to the tip — or (ii) a **ZK proof
of the scan**.

This brief takes route (i) and makes it *cheap and verifiable*: an ADS turns the bounded tail
scan from "trust the indexer showed me everything in `[N, tip]`" into "the indexer **cannot**
show me a proper subset of `[N, tip]` without the omission being detected against an on-chain
root." The distinction that organizes the whole brief:

- **Commitment-completeness** — *no committed leaf in the index range was omitted.* The zswap/dust
  Merkle trees already give this, and Midnight already serves the exact API. This brief shows the
  hypothesis is right: for the shielded model the ADS is **largely already present** (§2).
- **Ciphertext-delivery completeness** — *for every committed leaf, I was shown the ciphertext (or
  a proof there is none) so I can decide if it is mine.* The zswap tree does **not** give this; the
  ciphertext is off-tree. This is the real shielded residual, and it is narrower than "omission" in
  general but still open (§2.4).
- **Spend-completeness** — *no spend of my notes was hidden.* No ADS exists for the nullifier set
  today (§3).
- **Unshielded set-completeness** — *I was shown every UTXO for my address.* No authenticated
  address index exists; this needs a genuinely new ADS (§4).

---

## 1. Prior art: the standard technique for proving a filtered/range query returned EVERYTHING

The literature on **authenticated data structures** (ADS) / **verifiable outsourced databases**
solves exactly "an untrusted server returns a query answer plus a proof that it is *sound and
complete* w.r.t. a short digest the verifier trusts." Two families matter here.

### 1a. Append-only logs over a contiguous index (→ the shielded case)

- **Merkle hash tree + audit path + consistency proof.** RFC 6962 (Certificate Transparency) is
  the reference: a Merkle Tree Hash over an *ordered* list, a **Merkle audit path** proving a leaf
  is present, and a **Merkle consistency proof** proving "that any particular version of the log
  is a superset of any particular previous version" — i.e. append-only-ness between two tree sizes
  [RFC 6962 §§2.1, 2.1.1, 2.1.2, https://datatracker.ietf.org/doc/html/rfc6962]. The load-bearing
  property for us: **if you fix the leaf count `n` and the root `R`, the multiset of leaves is
  fully determined.** Anyone who hands you a set of `n` leaves that rehashes to `R` has, by
  collision-resistance, handed you *all* of them — omission is impossible without breaking the
  root. This is completeness-by-fixed-size-and-root, and it is precisely how a fixed-height
  append-only commitment tree gets range-completeness for free.
- **Merkle Mountain Range (MMR).** An append-only forest of perfect binary trees, "strictly append
  only … elements are added from the left to the right" with peaks "bagged" into one digest
  [grin, https://docs.grin.mw/wiki/chain-state/merkle-mountain-range/; opentimestamps,
  https://github.com/opentimestamps/opentimestamps-server/blob/master/doc/merkle-mountain-range.md].
  MMRs give O(log n) inclusion + O(log n) "consistency"/extension proofs without a fixed height —
  the shape to reach for when a structure grows unboundedly and you cannot pre-commit a height.
- **History trees.** Crosby & Wallach, *Efficient Data Structures for Tamper-Evident Logging*
  (USENIX Security 2009, https://www.usenix.org/legacy/event/sec09/tech/full_papers/crosby.pdf):
  a versioned Merkle tree supporting **membership** and **incremental** (consistency) proofs so an
  auditor verifies the log never rewrote history — the general form of RFC 6962's two proof types.

### 1b. Sorted authenticated dictionaries over keys (→ the unshielded case)

Here the query is not "give me index range `[a,b)`" but "give me *all* records with key = A", and
completeness means "you did not drop any of A's records and did not hide the fact that a key
between two shown keys exists." The canonical technique, stable across 25 years of the literature:

> **Return the matching records, plus the two *boundary* records immediately outside the queried
> range (the predecessor of the low end and the successor of the high end), each with its
> authentication path; the verifier checks the boundaries are *adjacent* in the sorted order to
> the returned block. Adjacency + inclusion of the boundaries proves nothing was omitted between
> them.**

Primary sources for this "boundary/frontier proof":
- **Naor & Nissim**, *Certificate Revocation and Certificate Update* (USENIX Security 1998) — the
  original **authenticated dictionary**: a sorted 2-3 tree where a **non-membership** proof is the
  pair of adjacent present elements bracketing the absent key.
- **Goodrich, Tamassia, Schwerin**, *Implementation of an Authenticated Dictionary with Skip Lists
  and Commutative Hashing* (DISCEX 2001) — the **authenticated skip list**, same
  membership/non-membership-by-adjacency guarantee with a simpler dynamic structure.
- **Devanbu, Gertz, Martel, Stubblebine**, *Authentic Data Publication over the Internet*
  (J. Computer Security 2003) and **Martel et al.**, *A General Model for Authenticated Data
  Structures* (Algorithmica 2004) — generalize inclusion+boundary proofs to **range and selection
  queries**, formalizing *completeness* of a query answer.
- **Li, Hadjieleftheriou, Kollios, Reyzin**, *Dynamic Authenticated Index Structures for
  Outsourced Databases* (SIGMOD 2006) — the **Merkle B-tree (MB-tree)**: a B+-tree with a Merkle
  hash per node; a range query returns the matching leaves *and the two boundary leaves*, proving
  no tuple in between was suppressed. This is the workhorse for exactly our unshielded query.
- **CONIKS** (Melara et al., USENIX Security 2015) and Google **Key Transparency** — a Merkle
  **prefix tree** (sparse Merkle tree) keyed by a hash of the identifier, giving authenticated
  **absence** proofs (the path to the key's slot terminates empty). The map analog of the dict:
  useful when the key space is a fixed-width hash rather than a sortable name.

**The one idea to carry forward:** completeness always reduces to *pinning the neighbourhood* —
either (append-only) fix the size+root so the leaf set is determined, or (sorted) return the
adjacent boundary elements so no key can hide between them. Midnight already implements the first;
the second must be built for unshielded (§4).

---

## 2. Shielded (zswap) — the ADS is largely already present, and here is exactly why

### 2.1 The collapsed-tree update IS an authenticated range query, and it is real API

The zswap note-commitment tree is a fixed-height (`ZSWAP_TREE_HEIGHT = 32`,
`zswap/src/lib.rs:23`), append-only Merkle tree whose leaves — coin commitments — occupy
**contiguous** indices `0..first_free`. Appending is `try_update_hash(first_free, coin_com.0, aux)`
(`zswap/src/ledger.rs:106-110`); the leaf hash is the commitment, the aux is
`Option<Sp<ContractAddress>>` (`zswap/src/ledger.rs:43`). So the bounded tail scan over
`[N, tip]` is an **authenticated range query over the contiguous leaf interval
`[endIndex_N, endIndex_tip)`.**

The bridge that authenticates that interval already exists in the ledger and is already served by
the indexer:

- `MerkleTreeCollapsedUpdate { start, end, hashes: Vec<MerkleTreeDigest> }`
  (`transient-crypto/src/merkle_tree.rs:302-311`). `MerkleTreeCollapsedUpdate::new(tree, start,
  end)` (`:380-405`) emits one subtree hash per **binary-counter step** between `start` and
  `end+1` (`step_sizes`, `:322-356`) — i.e. **O(log(range))**, at most ≈ tree height = 32 hashes,
  regardless of how many leaves the range contains.
- `State::apply_collapsed_update` (`zswap/src/local.rs:73-83`) folds it into the wallet's local
  tree and `rehash()`es; `MerkleTree::apply_collapsed_update` (`merkle_tree.rs:1088-1105`) checks
  the segment count matches and `partial_insert`s each boundary hash.
- **Indexer surface (stable, not `@beta`):** `Query.zswapMerkleTreeCollapsedUpdate(startIndex,
  endIndex): MerkleTreeCollapsedUpdate!` (`schema-v4.graphql:1258`), returning
  `{ startIndex, endIndex, update: HexEncoded!, protocolVersion }` (`:1100-1117`). **`update` is
  the hex-serialized Rust struct above — hashes only, no ciphertexts, no coin data.**

**What it proves.** The collapse operation "leaves the hash invariant" (`merkle_tree.rs:921`, cited
brief 01 §2): a wallet that applies the boundary hashes for `[endIndex_N, endIndex_tip)` and
rehashes obtains a tree whose root is **bit-identical** to the full on-chain tree at `endIndex_tip`
— *iff every one of its own leaves in that range is present and correct.* Compare that root to the
on-chain `Block.zswapMerkleTreeRoot` at the tip (`schema-v4.graphql:64`, stable field). A match is
a **completeness proof for the commitment set**: by collision-resistance of the tree hash, there
is exactly one leaf multiset of size `endIndex_tip` that hashes to that root, so the indexer cannot
have omitted, inserted, or reordered any commitment in `[endIndex_N, endIndex_tip)` without the
final root diverging. This is the RFC 6962 "fix size + root ⇒ leaf set determined" argument (§1a)
instantiated on Midnight's own tree. **Hypothesis 1 confirmed: for commitment-completeness the ADS
is already built and already exposed.**

### 2.2 Cost

Per shielded tail scan: **O(log) boundary hashes** (≤32 × 32 B ≈ 1 KB) for the collapsed update,
**plus one ciphertext per output** actually emitted in `[N, tip]` (needed anyway to decrypt),
**plus one 32-B root fetch** at the tip. The authentication overhead beyond the data you must
download to decrypt is a single logarithmic bridge — negligible.

### 2.3 Privacy

Preserved, and arguably improved. The collapsed update is **public commitment hashes only** — it
reveals nothing about which leaves are the wallet's; the wallet decrypts locally with its viewing
key (`ZswapPreimageEvidence::try_with_keys`, `ledger/src/events.rs:70-84`). The wallet can fetch
the *whole* range's boundary bridge without disclosing which indices it cares about — the access
pattern hides its interest set (brief 03 §5's requirement). Commitments are hiding
(`persistentCommit`, brief 05 C3), so proving them against the public root leaks tree positions,
not ownership.

### 2.4 The real shielded residual: ciphertext-delivery completeness ≠ commitment completeness

Here is the refinement the coordinator's hypothesis needs. The coordinator asked: *"does omitting a
ciphertext become DETECTABLE (a committed leaf with no matching ciphertext)?"* The honest answer is
**partially, and the gap is precise.**

Each on-chain output surfaces to the wallet as `EventDetails::ZswapOutput { commitment,
preimage_evidence, contract, mt_index }` (`ledger/src/events.rs:92-97`), where
`preimage_evidence ∈ { Ciphertext(box), PublicPreimage{coin,recipient}, None }`
(`:58-70`). Crucially, **the ciphertext is NOT in the Merkle tree** — the leaf is the bare
commitment (`zswap/src/ledger.rs:106-110`); `Output.ciphertext` is `Option<Sp<CoinCiphertext>>`
(`zswap/src/structure.rs:307`), carried in the transaction body, not the commitment tree.

Consequences:
- The collapsed-tree root proves **all commitments** are present. Because each `ZswapOutput` also
  carries its `mt_index`, the wallet can additionally check the delivered events cover a
  **contiguous** run of indices `[endIndex_N, endIndex_tip)` with no gaps — a second, cheap
  completeness signal on the *event* stream that must agree with the tree size.
- But the binding **commitment ↔ ciphertext is only checkable *after* decryption**: decrypt the
  ciphertext → recover `CoinInfo` → recompute the commitment (`"midnight:zswap-cc[v1]"` preimage,
  brief 05 C9) → check it equals the leaf. A malicious indexer that swaps a real ciphertext for
  **garbage** is caught (decrypt fails or commitment mismatches). A malicious indexer that
  **downgrades** a leaf's evidence to `None` (claiming "no recoverable ciphertext was attached")
  makes a note that is genuinely the wallet's **invisible** — the commitment is present and hashes
  correctly, only the off-tree ciphertext is withheld. The root check **cannot** detect this,
  because nothing on-tree commits to the evidence.

So the ADS closes commitment-omission but leaves **ciphertext-downgrade under-count** open. This is
narrower than the generic Zcash omission gap (brief 02 §5) — the attacker cannot forge, reorder, or
drop commitments, only refuse to help you decrypt one — but it is the same *class* of residual.

**Where the missing authentication lives.** The ciphertext is part of the transaction body, which
is committed by the block's Substrate `extrinsicsRoot` (brief 01 "Layer A", the standard header
trie). That root **is** consensus-authenticated but is **not surfaced to wallets** by the indexer
today. Three ways to close it, in increasing cost:
1. **Accept it as the documented residual** (Zcash-parity). An indexer that withholds ciphertexts
   is a liveness/availability failure detectable by cross-checking a second indexer (the two
   disagree on the evidence for a given `mt_index`) — brief 02 §1's NxN principle.
2. **Authenticated ciphertext delivery** — have the indexer serve, per `mt_index`, the ciphertext
   *plus* a Substrate `state_getReadProof`/body inclusion path to the block's `extrinsicsRoot`,
   which the wallet checks against a trusted header. Turns downgrade into a detectable forgery.
   Needs the node/indexer to expose body proofs (nothing does today — brief 01 §6 gap 1).
3. **A per-block ciphertext accumulator** — a new consensus commitment (e.g. an MMR of
   `(mt_index, H(evidence))`) whose root sits in the header, giving a compact completeness proof
   that the evidence for each committed leaf is exactly as shown. A protocol change; the cleanest
   long-term fix; flag to the Midnight team alongside brief 05 §5.3's kernel-op request.

### 2.5 Dust trees — same mechanism, same residual, `@beta`

Both dust trees are structurally identical fixed-height-32 append-only Merkle trees
(`DustUtxoState.commitments: MerkleTree<()>`, `DustGenerationState.generating_tree:
MerkleTree<DustGenerationInfo>`, `ledger/src/dust.rs:892-937`), with the same collapse semantics
and the same collapsed-update API: `dustCommitmentMerkleTreeUpdate` / `dustGenerationMerkleTreeUpdate`
(`schema-v4.graphql:1284,1288`) and per-block roots `dustCommitmentMerkleTreeRoot` /
`dustGenerationMerkleTreeRoot` (`:84,88`). So dust commitment-completeness is **also already
present** — but every one of these fields is `@beta` (unstable, brief 01 §6 gap 2; brief 04 §3
caveat), and dust roots are computed by the indexer but **not cross-checked against the node**
(brief 04 §3, `docs/testing.md`), so the dust anchor is only as strong as the indexer's own
computation. The generation tree additionally commits a *schedule*, not a balance (brief 01 §3), so
even a complete generation-tree scan must be re-evaluated against "now" locally.

---

## 3. Spend-completeness — no ADS exists, and the threat is narrower than it looks

The coordinator asks whether there is "an equivalent completeness structure for the nullifier set,
so a hidden SPEND is also detectable." **There is not, today.**

- zswap nullifiers are a plain set: `nullifiers: HashMap<Nullifier, ()>` (`zswap/src/ledger.rs:46`).
  Dust nullifiers likewise: `nullifiers: HashSet<DustNullifier>` (`dust.rs:895`),
  `DustGenerationState … generating_set: HashSet<…>` (`dust.rs:915`). A grep for a sparse-Merkle /
  nullifier tree over the ledger finds none — only in-circuit "nullifier root check" booleans in
  the dust spend program (`dust.rs:625,1799`), which check the *commitment/generation* roots, not
  a nullifier-set root.
- These sets are *technically* Merkleized — every storage `HashMap<K,V>` is a size-annotated
  Merkle-Patricia trie internally, `Map<ArenaHash<K>, (Sp<K>,Sp<V>)>` (`storage/src/storage.rs:50-61`;
  trie at `storage/src/merkle_patricia_trie.rs`), so the nullifier set has a content-addressed root
  folded into `midnight_ledgerStateRoot`. **But the MPT exposes no external proof API** — its
  public methods are `new/insert/lookup/lookup_sp/remove/iter/size/ann/prune`
  (`merkle_patricia_trie.rs:68-195`); there is **no `prove(key)`/`verify(root,key,proof)`** and no
  non-membership (absence) proof. So there is no way to serve a compact proof that a given
  nullifier is *absent* (note unspent) or *present* (note spent) against the on-chain root.

**Why the residual is smaller than "omission" suggests.** A spend of the wallet's own note requires
the wallet's coin secret key (the nullifier is `coin.nullifier(SenderEvidence::User(sk))`,
`zswap/src/local.rs:90-93`). **Only the wallet can spend its own notes** — so a third party cannot
forge a spend to make you *lose* funds. The failure mode of a hidden spend is therefore an
**over-count**, not theft: the indexer hides a `ZswapInput` event carrying your nullifier, your
restored state still lists the note as unspent, and you later attempt to re-spend it — at which
point the network rejects it (`TransactionInvalid::… ` on a duplicate nullifier; the
`coin_coms_set`/nullifier checks). Self-correcting at spend time; a wrong balance *display* until
then. It bites for real only in the **multi-device** case: device B spends a note, device A
restores from a checkpoint that predates it and never sees B's spend.

**What an ADS here would take.** Either (a) expose a **non-membership proof** on the existing
nullifier MPT (a CONIKS-style absence path against the ledger-state root — a node/indexer + storage
change to add a `prove`/`verify` API the MPT lacks), letting the wallet prove each of its notes is
still unspent at the tip; or (b) an **authenticated nullifier accumulator** (append-only MMR/sparse
Merkle tree with a header-committed root) giving compact spend-inclusion proofs. Absent either, tail
spend-completeness rests on the *event stream* being complete — and `ZswapInput` events carry **no
`mt_index`** (unlike outputs; `events.rs:88-91`), so there is **no positional/contiguity check** for
inputs. Input-completeness is thus the weakest leg: it reduces to the same block-body authentication
as §2.4. **Honest bottom line: spends have no completeness ADS today; the only-spend-your-own-notes
invariant contains the damage to a multi-device display bug; closing it fully is a node change.**

---

## 4. Unshielded (UTXO) — a genuinely new lightweight ADS is required

### 4.1 Why nothing existing suffices

- The ledger's unshielded state is `UtxoState { utxos: HashMap<Utxo, UtxoMeta> }`
  (`ledger/src/structure.rs:2948-2968`), where `Utxo { value, owner, type_, intent_hash, output_no }`
  (`:2832-2838`). It **has** a content-addressed root (part of `midnight_ledgerStateRoot`), but the
  `HashMap` keys the trie by `ArenaHash(Utxo)` — a hash of the **whole** UTXO
  (`storage/src/storage.rs:50-61`). So a given owner's UTXOs are **scattered** across the trie by
  hash; there is **no address locality**, hence no way to do an authenticated *range* query "all
  UTXOs of address A" against this trie, and no exposed proof API anyway (§3).
- The indexer's only address-keyed unshielded surface is `unshieldedTransactions(address,
  transactionId)` (`schema-v4.graphql:1994`) — a per-transaction event stream — plus per-tx
  `unshieldedCreatedOutputs`/`unshieldedSpentOutputs` (`:186,190,2046,2050`). There is **no
  point-in-time "UTXO set as of block N by address" query.** (Brief 04 §3 *proposed* one,
  `unshieldedUtxos(address, offset)`, as new surface; the task's hypothesis 2 slightly overstates
  it as "existing but unauthenticated" — it does not exist yet, and when added, a bare
  `[UnshieldedUtxo!]!` list carries **no completeness proof** at all.)

So the unshielded model is the one place hypothesis 2 is right that **a new ADS must be built.**

### 4.2 The structure: an authenticated address-indexed UTXO dictionary (MB-tree shape)

Build a **Merkle-ized sorted map keyed by owner address** — an MB-tree (§1b, Li et al. 2006) or
authenticated skip list — that the indexer maintains as a materialized view over the ledger's UTXO
set:

```
key   = owner address A            (sortable, fixed-width)
value = the canonical, sorted list of A's live UTXOs at block N
        [ (intentHash, outputNo, tokenType, value, ctime, initialNonce, …) ]
        (the fields UnshieldedUtxo already exposes, schema-v4.graphql:2434-2470)
leaf  = H( A || H(canonical(value)) )
node  = H(left || right)   with a subtree-SIZE annotation per node
root  = R_utxo(N)          committed/signed and cross-checked (§4.4)
```

A per-address value can itself be a small **append-only MMR** of that address's UTXO-creation
events with tombstones for spends (so history/temporal queries compose with UmbraDB's TemporalKV),
but the outer sorted dictionary is what provides *completeness across addresses*.

### 4.3 The completeness proof (the boundary technique, instantiated)

A query `unshieldedUtxos(A, offset: N)` returns:
1. The list `value(A)` — A's UTXOs — with the Merkle path from `leaf(A)` to `R_utxo(N)` (proves
   the shown set is **exactly** what the committed map holds for A: soundness + intra-key
   completeness, since the leaf commits the *whole* canonical sorted list, not individual UTXOs).
2. If A is **absent** (no UTXOs), the **two boundary leaves** — A's predecessor `A⁻` and successor
   `A⁺` in sort order — each with its path, and the verifier checks `A⁻ < A < A⁺` and that `A⁻,A⁺`
   are **adjacent** in the tree. Adjacency + inclusion proves no leaf for A can hide between them
   (Naor–Nissim / MB-tree non-membership, §1b) — an authenticated "you have zero UTXOs," which a
   bare list can fake by returning `[]`.

Because each leaf commits A's *entire* sorted UTXO list, per-address completeness needs no
intra-list boundary elements; the subtree-size annotation additionally lets the indexer answer a
verifiable **count** ("A has exactly k UTXOs") — and note the ledger's own MPT **already carries a
`SizeAnn` subtree-size annotation** (`merkle_patricia_trie.rs:499-515`,
`Semigroup`/`Monoid` summing sizes), so size-annotated authenticated counting is a proven-present
primitive in Midnight's storage layer, merely not exposed as proofs.

### 4.4 Anchoring `R_utxo(N)` — three options, honestly ranked

This is the crux and the honest weak point: unlike the shielded root, there is **no single on-chain
address-indexed UTXO root** to check against. `R_utxo` is a *view* the indexer computes, not a
consensus field.

1. **Whole-set root-match (strongest, no new consensus).** The indexer serves the entire UTXO set
   with a root computed the *ledger's own way* — rehash the `HashMap<Utxo,UtxoMeta>` MPT — and the
   wallet checks it equals the `utxo`-subtree root inside `midnight_ledgerStateRoot`
   (`structure.rs:2988`, `#[storable(child)]`). Complete **by construction** (the whole set is
   pinned to a consensus root), then the wallet filters by address locally. *Cost:* O(total UTXOs),
   not O(A's UTXOs) — fine for a light unshielded set, heavy at scale. *Needs:* the node/indexer to
   expose the utxo-subtree root and an MPT serialization the wallet can rehash (neither exists
   today).
2. **Signed STH + cross-check (pragmatic).** The indexer maintains the address-indexed MB-tree,
   **signs** `R_utxo(N)` (a Certificate-Transparency Signed-Tree-Head, RFC 6962 §3.5), and a
   **monitor** periodically reconciles it against option-1's consensus set. Wallets fetch the
   boundary proof against the signed root from **k ≥ 2 independent indexers** and abort on
   disagreement (brief 02 §1 NxN, brief 05 §4.2 multi-endpoint). *Residual:* trust the signed root
   (a weak-subjectivity-style assumption) unless the monitor cross-check is run. *Cost:* O(log +
   |A's UTXOs|). Best cost/trust balance for a first ship.
3. **Consensus change (cleanest, heaviest).** Have the ledger maintain an address-indexed
   authenticated map (or annotate the existing UTXO MPT to support address-range proofs) with
   `R_utxo` in the header. Fully trustless, but a node/protocol change — track as long-term, same
   bucket as §2.4-option-3.

### 4.5 Cost & privacy (unshielded)

*Cost:* option 2 is one signed root + an O(log n) boundary proof + A's UTXO list. *Privacy:*
weaker than shielded by nature — unshielded UTXOs are transparent and already queried by clear
address (`unshieldedTransactions(address)`), so the ADS leaks nothing the model doesn't already
leak; the boundary proof does reveal A's neighbours' addresses, which are already public. No
viewing key is involved.

---

## 5. How it composes with the anchor (01/03) and the Compact attestation (05)

### 5.1 With the anchor tuple

Brief 01 §6 / brief 03 §7 persist an anchor tuple `{blockHeight, blockHash, treeEndIndex, treeRoot}`
and check the local rehashed root against the on-chain root at N. The ADS extends this from a
**point check at N** to a **range check across [N, tip]**:

- Persist, in the snapshot manifest, the **frontier at N**: `zswapEndIndex_N` (and both dust
  end-indices), plus the roots. These *are* the range's lower boundary.
- On restore: verify the snapshot's own rehashed root == persisted `treeRoot` at N (offline,
  brief 01 §6 step 2), then fetch `zswapMerkleTreeCollapsedUpdate(zswapEndIndex_N,
  zswapEndIndex_tip)` and the tip root, apply + rehash, and confirm the tip root. That single
  bridge **proves the tail contains no omitted commitment** — upgrading brief 03 §3(b)'s "bounded
  tail scan" from "trusted base + hopefully-complete scan" to "trusted base + *provably*-complete
  commitment scan." The endIndex is the exact range boundary that makes this well-defined.

### 5.2 With the Compact attestation (brief 05)

Brief 05 attests a hiding commitment to the snapshot root on-chain. The ADS gives that attestation
a **precise, verifiable boundary to attest**: include the **frontier** — `(zswapEndIndex,
zswapMerkleTreeRoot, dustCommitmentEndIndex, dustGenerationEndIndex, R_utxo)` — inside the
attested `AttestRecord`/Merkle leaf set (brief 05 §5.1 leaf 0 "sync cursor"). Then at restore the
frontier itself is authenticated two ways: (i) it matches the on-chain attestation (brief 05's
anti-rollback CAS), and (ii) the collapsed-update from that exact endIndex to the tip rehashes to
the current on-chain root. The attestation says *"I, the live wallet, was complete through
endIndex E and here is E's committed frontier"*; the ADS says *"and here is the proof nothing
between E and the tip was hidden from you."* Attestation transports **base** trust; the ADS
discharges **tail** completeness. They compose exactly along the endIndex seam — which is why
brief 05's record must carry the endIndex/frontier, not just a flat `manifestHash`.

---

## 6. Residual trust after adding the ADS

| Completeness class | Structure | Status after ADS | Residual |
|---|---|---|---|
| Shielded **commitment** [N,tip] | zswap collapsed-tree, on-chain root | **Closed** — already-present API (§2) | root's own trust → consensus (brief 03 §7) |
| Shielded **ciphertext delivery** | (off-tree; block body) | **Open** — downgrade-to-`None` under-count (§2.4) | needs body proof / ciphertext accumulator; else Zcash-parity + NxN |
| Dust commitment/generation | dust collapsed-trees | **Closed but `@beta`** + not node-cross-checked (§2.5) | schema stability; indexer-only dust root |
| **Spend** (nullifiers) | none (hash sets, no proof API) | **Open** — no ADS (§3) | contained by only-spend-your-own-notes to a multi-device over-count |
| Unshielded **set by address** | new MB-tree/skip-list (§4) | **Closed against `R_utxo`** | `R_utxo` anchoring (§4.4): signed+cross-check, or consensus change |

The irreducible floor is unchanged from brief 03 §7: the DB is trusted for **availability only**;
correctness reduces to an on-chain root; that root's trust reduces to **consensus/finality**, which
is outside UmbraDB. The ADS removes the *omission* freedom the prior briefs left the indexer, for
every class where Midnight exposes (or we add) an authenticated root — leaving exactly two genuine
holes: **shielded ciphertext downgrade** and **spend hiding**, both of which reduce to the same
missing primitive (an authenticated binding from an on-chain consensus commitment to the off-tree
data — block-body proofs or new header accumulators), i.e. a **node/protocol** change, not a
wallet or indexer one.

---

## 7. Concrete SDK / indexer changes (extending brief 04)

**Already sufficient, wire it up (no backend change):**
- **Shielded/dust commitment-completeness.** The wallet SDK already *has* `applyCollapsedUpdate`
  but never calls it (brief 04 §2: "defined but never called"). The change is SDK-only: in the
  verifying restore path (brief 04 §1 seam `restoreVerified()`), after resuming, fetch
  `zswapMerkleTreeCollapsedUpdate(endIndex_N, endIndex_tip)` + the tip root, apply, rehash, and
  assert equality. `ZswapLocalState.merkleTreeRoot` / `firstFree` already exist to read
  (`ledger-v8.d.ts:2996,2982`, brief 04 §1). Add the endIndex/frontier to the snapshot `anchor`
  field (brief 04 §4a schema, purely additive). Weave into the e2e reference stream (brief 04 §5).

**New indexer surface (extends brief 04 §3):**
- **Ledger-event → block/endIndex reverse map** (brief 04 §3's `TreeAnchor`) is the prerequisite:
  a restoring wallet has an event-cursor `appliedIndex`, not an endIndex, so it needs "the committed
  endIndex+root at the point I reached." Follow brief 04's FK-chain resolver (`ledger_events →
  transactions → regular_transactions`, columns already present, `001_initial.sql:47-59`).
- **`unshieldedUtxos(address, offset): UnshieldedUtxoProof`** — extend brief 04 §3's proposed query
  to return **not** a bare `[UnshieldedUtxo!]!` but `{ utxos, boundaryLo, boundaryHi, merklePaths,
  root, rootSignature }` (§4.3). This needs the new MB-tree materialized view (§4.2), a signer, and
  ideally a monitor cross-checking against the consensus utxo-subtree root (§4.4 option 2).
- **(Longer-term, needs node)** expose the `utxo`-subtree root + MPT serialization for §4.4 option 1;
  a Substrate body-inclusion proof for §2.4 option 2; an MPT non-membership proof API for §3(a).

**Honest "does not exist yet" list:**
- No node RPC for a Substrate body/state proof surfaced through the wallet SDK (brief 01 §6 gap 1)
  → §2.4 ciphertext and §3 spend completeness cannot be fully closed wallet-side today.
- The MPT has no `prove`/`verify` / non-membership API (`merkle_patricia_trie.rs`) → no compact
  nullifier absence proof, no compact UTXO-subtree proof, today.
- Dust anchor fields are `@beta` and not node-cross-checked → dust completeness ships on softer
  ground than shielded.

---

## 8. Sources

**Local source (read-only, 2026-07-21):**
- `~/repos/midnight-ledger`: `transient-crypto/src/merkle_tree.rs:302-405,921,1088-1105`
  (MerkleTreeCollapsedUpdate: struct, step_sizes, new, apply);
  `zswap/src/lib.rs:23` (ZSWAP_TREE_HEIGHT); `zswap/src/ledger.rs:37-48,95-124` (State, apply_output);
  `zswap/src/local.rs:49-55,73-93` (local State, apply_collapsed_update, nullifier derivation);
  `zswap/src/structure.rs:300-309` (Output.ciphertext Option); `ledger/src/events.rs:40-180`
  (Event / EventDetails::ZswapOutput{commitment,preimage_evidence,mt_index}, ZswapPreimageEvidence,
  ZswapInput has no mt_index); `ledger/src/dust.rs:625,892-937,1799` (dust trees, nullifier sets);
  `ledger/src/structure.rs:2832-2838,2948-2968,2975-2993` (Utxo, UtxoState, LedgerState children);
  `storage/src/storage.rs:50-61,1241-1247` (HashMap=Map<ArenaHash,…>=MPT, keyed by hash(K));
  `storage/src/merkle_patricia_trie.rs:68-195,499-515` (MPT public API — no proof method; SizeAnn
  subtree-size monoid).
- `~/repos/midnight-indexer`: `indexer-api/graphql/schema-v4.graphql:64,84,88,186,190,1100-1117,
  1258,1271,1284,1288,1994,2434-2470` (zswapMerkleTreeRoot, dust roots `@beta`,
  MerkleTreeCollapsedUpdate type, zswap/dust collapsed-update queries, contract as-of-block,
  unshieldedTransactions, UnshieldedUtxo fields).
- `~/repos/UmbraDB/design/research/2026-07-21-snapshot-root-of-trust/01–05` (built upon throughout).

**Literature (web):**
- RFC 6962, *Certificate Transparency* — Merkle audit path (inclusion) + consistency proof
  (append-only completeness) + Signed Tree Head. https://datatracker.ietf.org/doc/html/rfc6962
- Naor & Nissim, *Certificate Revocation and Certificate Update*, USENIX Security 1998 —
  authenticated dictionary; non-membership by adjacent boundary elements.
- Goodrich, Tamassia, Schwerin, *Implementation of an Authenticated Dictionary with Skip Lists and
  Commutative Hashing*, DISCEX 2001 — authenticated skip list.
- Devanbu, Gertz, Martel, Stubblebine, *Authentic Data Publication over the Internet*, J. Computer
  Security 2003; Martel et al., *A General Model for Authenticated Data Structures*, Algorithmica
  2004 — completeness of range/selection query answers via boundary proofs.
- Li, Hadjieleftheriou, Kollios, Reyzin, *Dynamic Authenticated Index Structures for Outsourced
  Databases*, SIGMOD 2006 — Merkle B-tree; range-query completeness via boundary leaves.
- Melara et al., *CONIKS: Bringing Key Transparency to End Users*, USENIX Security 2015 — Merkle
  prefix tree with authenticated absence proofs.
- Crosby & Wallach, *Efficient Data Structures for Tamper-Evident Logging*, USENIX Security 2009 —
  history trees (membership + incremental proofs).
  https://www.usenix.org/legacy/event/sec09/tech/full_papers/crosby.pdf
- Merkle Mountain Range — grin, https://docs.grin.mw/wiki/chain-state/merkle-mountain-range/ ;
  opentimestamps, https://github.com/opentimestamps/opentimestamps-server/blob/master/doc/merkle-mountain-range.md
- Wikipedia, *Merkle tree*. https://en.wikipedia.org/wiki/Merkle_tree

No source was modified; no code was committed.
