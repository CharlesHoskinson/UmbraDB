# 09 — How other shielded chains handle "a service scans the chain for my wallet": trust, completeness, privacy — and what to steal for our design

**Date:** 2026-07-21
**Angle 9 of the snapshot root-of-trust research.** Every prior brief (01–06) treats Midnight's
indexer as a scanner the wallet folds a stream from, and each ends at the same two walls: the
indexer can **omit** (completeness) and, for a *remote* UmbraDB/indexer, it can **learn which
notes are ours** (privacy). This brief studies the systems whose whole design is "an untrusted
service scans a shielded chain on my behalf" — the exact analog of Midnight's model — and extracts
what ENHANCES our scheme (anchor + ADS + finalized-checkpoint proof + optional Compact attestation).

**Builds on:** brief 01 (state commitments, collapse-invariant), brief 02 (Zcash lightwalletd /
`finalSaplingRoot` / birthday — recapped, not re-derived), brief 03 (inclusion≠completeness theorem,
remote-DB privacy via client-side encryption), brief 05 (Compact attestation), brief 06 (the ADS
that makes the tail scan verifiably complete, and the ciphertext-downgrade residual §2.4).

Every claim is cited to a primary source URL. No source was modified; nothing was committed.

---

## 0. The framing that organizes everything: two ORTHOGONAL properties

A "service scans the chain for my wallet" raises two independent questions, and the systems below
each answer them differently. Keeping them apart is the whole point:

- **(I) Scan integrity / completeness** — *did the scanner show me all and only the real
  chain data (no omission, no fabrication)?* This decomposes (brief 06) into commitment-completeness
  (no note-commitment omitted) and ciphertext/delivery-completeness (for every commitment I was
  shown the payload, or a proof there is none).
- **(II) Privacy from the scanner** — *does the scanner learn which notes/transactions are mine?*

The load-bearing observation across all five systems: **(I) is universally handled by VERIFYING the
note-commitment tree against an on-chain root — never by trusting the scanner** — while **(II) is the
open frontier, and the systems sit on a spectrum from "hand the scanner your full viewing key" to
"hand it only a detection key it learns nothing from."** Our design has (I) well in hand (anchor +
ADS); the highest-value ideas below are all about (II) — and the one primitive that closes *both* at
once against a fully malicious server (OMR) is the north star nobody has shipped yet.

---

## 1. Penumbra — the closest analog, and it splits delegation into TWO keys (highest-value target)

Penumbra is structurally Midnight's twin: a ZK-shielded, note-commitment-tree chain where "users
must scan the entire chain to determine which transactions relate to their addresses"
[FMD overview, https://protocol.penumbra.zone/main/crypto/fmd.html]. What makes it the single most
useful system to study is that Penumbra deliberately offers **two different ways to delegate the
scan, with two different keys and two different trust levels** — and names the trade-off explicitly.

### 1.1 Delegation model A — the *view service* (full viewing key, trusted)

`pcli`/`pclientd` run a **view service** that "is responsible for scanning and synchronizing private
state into a local database … can be embedded in an application, or run standalone on a relatively
untrusted server" and by default "includes a view service that synchronizes with the chain and scans
with a viewing key" [Penumbra guide, https://guide.penumbra.zone/usage/pcli ; architecture summary
in https://penumbra.exchange/blog/shielded-upgradability]. Crucially, `pclientd` initializes "in view
mode, with **only a full viewing key**" [https://guide.penumbra.zone/network/node/pclientd/configure].

So: running the view service on a remote/"untrusted" server means that server **holds your full
viewing key and sees everything** — every note, amount, and counterparty. This is the naive
delegation, and it is exactly the trust cost our remote-UmbraDB design is trying to avoid (brief 03
solves the *at-rest* version with client-side encryption, but a remote view service that *feeds* the
wallet still needs the viewing key to scan). This is the baseline to beat.

### 1.2 Delegation model B — FMD *detection keys* (probabilistic, untrusted-tolerant)

Penumbra's headline contribution is that it does NOT force you into model A. The FMD overview states
the design tension precisely: delegating scanning "is possible using *viewing keys*, as in Zcash, but
viewing keys represent the capability to view **all** activity related to a particular address, so
they can only be delegated to **trusted** third parties. Instead, it would be useful to be able to
delegate only a probabilistic *detection* capability … [which] would not include the ability to view
the details of a transaction, only a probabilistic association" — this is **Fuzzy Message Detection
(FMD)**, from Beck, Len, Miers & Green [https://protocol.penumbra.zone/main/crypto/fmd.html ; paper
https://eprint.iacr.org/2021/089].

How it is wired into the protocol (this is a *shipped, consensus-level* feature, not a proposal):

- **Clue key in the address.** "Each Penumbra diversified address includes as part of the encoded
  address an S-FMD *clue key*" `ck_d = [dtk_d]B`, alongside the transmission key `pk_d`
  [https://protocol.penumbra.zone/main/addresses_keys/addresses.html ;
  https://protocol.penumbra.zone/main/crypto/fmd/system_mapping.html]. The address is the 80-byte
  string `d || pk_d || ck_d` (F4Jumbled, Bech32m-encoded).
- **Detection key is derivable and disclosable.** `dtk_d = from_le_bytes(prf_expand(b"PenumbraExpndFMD",
  ivk, d))` — "This key is what the user can optionally disclose to a third-party service for
  detection" [system_mapping]. It examines each *clue* and returns detect / no-detect.
- **Clues on outputs, with consensus rules.** Each output carries a clue; the false-positive rate is
  the sender-chosen `p = 2^-n`. To stop leaks, "we add dummy clues to the transaction until there are
  an equal number of clues and outputs. A consensus rule verifies that all transactions have an equal
  number of clues and outputs," and another consensus rule "verifies that clues … have been generated
  using the appropriate precision, within a grace period of 10 blocks" [system_mapping].
- **Detection ambiguity.** The security property that makes it safe to hand a detection key to an
  adversary: "the server cannot distinguish between false and true positives"
  [https://protocol.penumbra.zone/main/crypto/fmd/threat_model.html]. A detector sees a *fuzzy
  superset* of your messages at rate `p`, and cannot tell which hits are real.
- **Compact, constant-size keys.** Penumbra extends R-FMD2 "to support arbitrarily precise detection
  with **compact, constant-size keys**" so the clue key fits in the address
  [https://protocol.penumbra.zone/main/crypto/fmd/construction.html].
- **Open-world threat model** (unlike the academic "closed world"): "Multiple untrusted servers
  perform FMD … there is no single centralized detection server with all detection keys … FMD is
  opt-in." Malicious detection servers "may collude, sharing the sets of detection keys they have,"
  and can inject traffic to bias the false-positive statistics — the residual privacy risk of FMD
  [threat_model].

### 1.3 How Penumbra VERIFIES the scan (property I) — and it is our anchor, exactly

Independently of *who* scans, the client rebuilds the note-commitment tree itself and checks it
against the chain. The **Tiered Commitment Tree (TCT)** is "an append-only, ZK-friendly Merkle tree";
its root is the **Anchor = Global Tree Root**
[https://protocol.penumbra.zone/main/sct/tct.html]. Two facts map one-to-one onto our design:

- **The chain provides collapsed span-hashes inline** — Midnight's `MerkleTreeCollapsedUpdate` twin.
  "When a client detects that an entire block, or an entire epoch, contained nothing of interest for
  it, it doesn't need to construct that span of the commitment tree: it merely inserts the singular
  **summary hash for that block or epoch, which is provided by the chain itself inline with the
  stream of blocks**" [tct.html]. This is precisely brief 06 §2.1's authenticated-range-query bridge,
  in production. On the live testnets the client "streams and scans at rates upwards of 10,000
  CompactBlocks per second … If the client does not detect any relevant data, the TCT design allows
  it to fast-forward … and throw away the CompactBlock data" [shielded-upgradability].
- **Spends validate a historical tree root on-chain.** A Spend proof takes a public "Merkle anchor
  ∈ F_q of the state commitment tree" and the zk-SNARK "certifies that … the witnessed Merkle
  authentication path is a valid Merkle path to the provided public anchor"
  [https://protocol.penumbra.zone/main/shielded_pool/action/spend.html]. The chain checks the anchor
  is a real historical root. This is Zcash's `finalSaplingRoot` idea (brief 02 §5) as a *per-spend
  anchor* — identical to brief 01/03's "verify the locally-recomputed root against the on-chain root."

**Completeness residual (property I, delivery half):** the client trusts the connected full node /
detection server to *deliver* all relevant clues/payloads. FMD's detection ambiguity buys **privacy,
not completeness** — a malicious detector can still omit. This is the same ciphertext-downgrade gap
brief 06 §2.4 isolates. Penumbra does **not** have a verifiable-scan (completeness) proof; it has a
verifiable *tree* plus a privacy-preserving delegated *detector*.

### 1.4 The one-line Penumbra takeaway

Penumbra proves that **you can move the scan onto an untrusted server without giving it your viewing
key** — by disclosing a *detection key* whose output is a fuzzy superset it cannot disambiguate. That
is the exact primitive our remote-UmbraDB/indexer story is missing. It does NOT solve completeness;
for that, tree-anchoring (which we already have) plus the ADS (brief 06) plus §9's ideas are needed.

---

## 2. Zcash — lightwalletd vs `finalSaplingRoot` (recap), and why OMR was invented for it

Brief 02 §5 covered this in depth; the delta relevant here:

- **Trust vs verify.** Today lightwalletd is "a **trusted** root of trust" — "Lightwalletd only ever
  provides valid information" — and a compromised one can under-count by omission; the stated fix is
  to have the wallet do "the block header and note commitment tree validation specified in ZIP 307,"
  i.e. verify its rebuilt tree root against the header's `finalSaplingRoot` rather than trust the
  server [https://zcash.readthedocs.io/en/latest/rtd_pages/wallet_threat_model.html ; ZIP-307
  https://zips.z.cash/zip-0307]. Same shape as Penumbra §1.3: **verify the tree, trust the server for
  delivery.**
- **Birthday = trust the checkpoint base.** ZIP-307's tree-state checkpoint + wallet birthday avoids
  rescanning from Sapling activation; an imported seed with no birthday must fall back to activation
  [ZIP-307]. This is our finalized-checkpoint base (brief 02 §8-③).
- **Why it matters for §9:** Zcash's residual omission gap is the *motivating application* for
  Oblivious Message Retrieval (Liu & Tromer explicitly target "privacy-preserving payment systems";
  §7). Zcash-family shielded scanning is the canonical OMR use-case — a strong signal that OMR is the
  primitive aimed at exactly our problem.

---

## 3. Aztec — PXE + note *tagging*, "constrained delivery", and it names OMR/PIR as the endgame

Aztec's **Private Execution Environment (PXE)** is the client-side wallet runtime that discovers,
decrypts, and stores the user's notes. Its note-discovery story is the most instructive of all the
systems because Aztec (a) *moved away from trial-decryption*, (b) invented an on-chain **completeness**
notion for the discovery hint, and (c) explicitly documents OMR/PIR as the eventual privacy fix.

### 3.1 Tagging replaced trial-decryption

"PXE's trial decryption of notes has been replaced in favor of a **tagging and discovery** approach …
much more efficient and … scale[s] a lot better." Each log is `[tag, x, y, z]`; the node "indexes
logs by their tag and exposes an API (`getPrivateLogsByTags()`)"; the recipient computes its own tags
and "query[ies] for relevant logs without downloading and attempting to decrypt everything." Tags are
`poseidon2(secret, index)`, siloed to the contract address
[https://docs.aztec.network/developers/docs/foundational-topics/advanced/storage/note_discovery].
This is a *deterministic detection tag* — cheaper than FMD but with a different privacy profile (the
node sees exactly which tag you ask for; see §3.3).

### 3.2 "Constrained delivery" — an ON-CHAIN completeness guarantee for the discovery hint

This is the idea worth stealing. Aztec distinguishes tagging strategies by whether they can back
**constrained delivery**: an in-circuit guarantee that the tag was correctly emitted so the recipient
is *guaranteed to be able to find the note*. Handshake-based tags "can back constrained delivery,"
whereas "tagging with known sender … **cannot be constrained, i.e., it cannot guarantee that the
recipient will find the message**" [note_discovery]. Note validity is separately anchored: discovery
runs `compute_note_hash_nonce`, then "Note hash tree inclusion is validated separately" [note_discovery]
— the tree-anchor check again (property I), plus an on-chain *delivery* guarantee (the ciphertext-
downgrade gap of brief 06 §2.4, closed by construction for constrained sends).

### 3.3 Aztec's own metadata leak, and it points straight at OMR/PIR

Tagging's weakness: "when your PXE queries an Aztec node for logs with specific tags, the node can
observe your IP address and correlate it with which tags … this network-level metadata can leak
information about your activity." Aztec's documented long-term fix is verbatim our synthesis target:

> "**Oblivious message retrieval (OMR)**: Allows retrieving messages without the server knowing which
> messages were accessed. **Private information retrieval (PIR)**: … querying a database without
> revealing which records you're interested in. … currently **impractical in production due to
> computational costs**. They represent a long-term goal." [note_discovery]

An independent, production team reaching the exact same conclusion — OMR/PIR is the right endgame for
privacy-from-the-scanner, but too expensive to ship today — strongly de-risks §9's ranking.

---

## 4. Namada / MASP — Sapling-derived, with a fast-sync indexer that is a convenience, not an authority

Namada's **Multi-Asset Shielded Pool (MASP)** "is a zero-knowledge circuit (zk-SNARK) that **extends
the Zcash Sapling circuit** to add support for sending arbitrary assets"
[https://docs.namada.net/users/shielded-accounts]. It therefore inherits Sapling's note-commitment
tree + anchor (verify-against-chain), i.e. property I is Zcash's.

**Fast sync = trust for availability, not correctness.** "Syncing the shielded wallet directly from
the chain is performance-intensive, so it's **recommended to sync using a running instance of the
`namada-masp-indexer`**" [https://docs.namada.net/integrating-with-namada/sdk/shielded-sync]. The
indexer "crawls Namada networks, extracting MASP transaction data and builds data structures that
keep track of the state of the current MASP **commitment tree, note positions**, etc. … Namada clients
are able to synchronize … very quickly, alleviating remote procedure calls to full nodes"
[https://github.com/anoma/namada-masp-indexer]. The client keeps a `fetched`/`scanned` split — it
**fetches** commitment-tree/witness data + candidate notes from the indexer and **scans** (trial-
decrypts) locally with the spend/viewing key [shielded-sync code sample]. The viewing key is *not*
handed to the indexer (unlike a remote Penumbra view service), so Namada's remote sync is more private
than §1.1 — but it has the **same completeness residual** as Zcash: the indexer can omit, and the tree
anchor is what bounds the damage. No FMD/detection-key layer.

**Takeaway:** Namada is the "fast-sync via an untrusted indexer that serves *tree + witnesses*, client
trial-decrypts locally" pattern — closest to how Midnight's indexer already works, and confirms that
*serving witness/tree data* (not the viewing key) is the privacy-preferable division of labor when you
have no detection-key primitive. It validates our ADS-serves-the-bridge, wallet-decrypts-locally split.

---

## 5. Monero / Iron Fish — the all-or-nothing view-key baseline everyone is trying to escape

- **Monero view key.** A view-only wallet with the private view key sees **all** incoming outputs;
  there is no probabilistic/partial detection — delegation is total-visibility. Outgoing spends aren't
  reflected without importing key images, so a view-only balance can be wrong
  [https://www.getmonero.org/resources/user-guides/view_only.html ;
  https://www.getmonero.org/resources/moneropedia/viewkey.html]. The cautionary tale: a hosted light
  wallet that held users' view keys on central servers "admitted its architecture was incompatible
  with privacy" — the direct analog of §1.1's remote view service.
- **Iron Fish.** Sapling-family `ivk`/`ovk`; "View Keys … give **full visibility** into a particular
  wallet" [https://ironfish.network/learn/blog/2023-07-20-view_keys ;
  https://ironfish.network/learn/whitepaper/protocol/transactions]. Same all-or-nothing shape.

**Takeaway:** these two are the negative baseline. Handing a scanner the viewing key (Monero, Iron
Fish, Penumbra-view §1.1, and any remote-view-service framing of UmbraDB) is exactly what FMD (§1.2),
tagging (§3), and OMR (§7) exist to avoid. Our remote-UmbraDB design must not regress to this.

---

## 6. Cross-system comparison

| System | Who scans / delegation key | Completeness (I): trust or verify? | On-chain commitment verified | Privacy from scanner (II) | Fast-sync / birthday + its trust |
|---|---|---|---|---|---|
| **Penumbra view svc** | server w/ **full viewing key** | verify *tree* (anchor); trust server for delivery | TCT Anchor = global tree root; per-spend anchor [tct/spend] | **none** (sees all) | TCT fast-forward via chain-provided span hashes; trust = tree root |
| **Penumbra FMD** | server w/ **detection key** | trust server for delivery (FMD ≠ completeness) | same TCT anchor | **probabilistic** (fuzzy superset `p`, detection ambiguity) | opt-in; open-world multi-server |
| **Zcash light** | lightwalletd (trusted today) | trust today; ZIP-307 = verify vs `finalSaplingRoot` | `finalSaplingRoot` per block header | none (server-side); wallet holds keys | birthday/tree-state checkpoint; trust = checkpoint root |
| **Aztec PXE** | Aztec node via **tag** queries | verify note-hash-tree incl.; **constrained delivery** guarantees findability | note hash tree; nullifier tree | tag-access pattern + IP leak (OMR/PIR = future fix) | sliding-window over tag indexes; trust = finalized block |
| **Namada MASP** | masp-indexer (untrusted) | trust indexer for delivery; verify tree/witnesses vs chain | Sapling note-commitment tree anchor | key **not** shared; client trial-decrypts | indexer fast-sync (availability only); `trust_height/hash` for state-sync |
| **Monero / Iron Fish** | holder of **view key** | trust (holder sees all) | note/output on chain | **none** (total visibility) | n/a |
| **OMR (Liu–Tromer)** | untrusted **detector** w/ detection key | **verify** — completeness holds vs malicious server | (application's tree) | **full** — detector learns nothing | digest is per-scan; north-star, unshipped |

---

## 7. The primitive that closes BOTH properties at once — Oblivious Message Retrieval (OMR)

FMD (§1.2) and tagging (§3) give privacy but **not** completeness against a malicious server, and FMD
only gives *probabilistic* privacy (the false-positive cover). **Oblivious Message Retrieval** (Liu &
Tromer, CRYPTO 2022) is the primitive that gives both, against a fully adversarial server:

> "Untrusted servers can **detect messages on behalf of recipients**, and summarize these into a
> compact encrypted **digest** that recipients can easily decrypt. These servers operate obliviously
> and **do not learn anything about which messages are addressed to which recipients**. **Privacy,
> soundness, and completeness hold even if everyone but the recipient is adversarial and colluding**
> (unlike in prior schemes), and are post-quantum secure."
> [https://eprint.iacr.org/2021/1256 ; code https://github.com/ZeyuThomasLiu/ObliviousMessageRetrieval]

Mechanics: the recipient gives the detector a **detection key** and a bound `k̄` on expected pertinent
messages; the detector accumulates all pertinent messages into a digest; the recipient decodes it and
"recover[s] all of the pertinent messages with high probability, assuming … the number of pertinent
messages did not exceed `k̄`" [README]. This is exactly "a remote untrusted UmbraDB/indexer scans and
returns only my notes, learning nothing, and I can trust it didn't drop any."

The catch is cost, which is why nobody has shipped it (Aztec §3.3 calls it impractical). From the
reference implementation: **detection key ~99–129 MB**; detector **~0.02–0.15 sec/message** (FHE, so
per-message work over the *whole* board); digest ~280–560 KB; recipient decode <20 ms; "a couple of
USD per million messages" [README benchmarks]. PerfOMR (USENIX Security 2024,
https://eprint.iacr.org/2024/204) cuts communication/computation but it is still heavy. **OMR is the
north star, not a v1 dependency.**

---

## 8. Does anyone already do a "verifiable scan"? — No; they verify the TREE and trust the SERVER

Across all five production systems the pattern is identical and worth stating flatly:

- **Completeness of the note-commitment TREE is VERIFIED** against an on-chain root (Penumbra anchor,
  Zcash `finalSaplingRoot`, Aztec note-hash tree, Namada/MASP Sapling anchor). This is our anchor +
  brief 06 ADS. **Solved, and Penumbra's inline span-hashes prove the ADS shape is production-real.**
- **Delivery/detection completeness is TRUSTED** — every one of them can be lied to by omission at the
  ciphertext/clue layer; none has a deployed proof that the scan was exhaustive. The only construction
  that would make the scan itself verifiable-complete against a malicious server is **OMR** (§7), and
  it is unshipped everywhere.

So the honest answer to the coordinator's question — *"does anyone already do a verifiable scan / a
detection-key pattern we should adopt?"* — is: **the detection-key/tag privacy pattern is real and
shipped (Penumbra FMD, Aztec tagging); the completeness-verifiable scan is not (only OMR, research).**

---

## 9. Synthesis — the top 3 enhancements to fold into our design

Our design already nails property I (anchor + ADS + finalized checkpoint). The enhancements below are
ranked by impact-per-feasibility, and are overwhelmingly about property II (privacy from a remote
scanner) plus one completeness sharpening.

### ① (HIGHEST) Add a detection-key / tag layer so a REMOTE UmbraDB/indexer scans WITHOUT the viewing key

This is the single biggest gap the study exposes. Brief 03/05 make the *stored* snapshot private
(client-side AES-GCM), but the entity that **feeds** the wallet — the indexer, or a remote UmbraDB
acting as a scan accelerator — still learns which notes are ours today, because selecting "our" data
requires the viewing key (§1.1/§5 baseline) or a trial-decrypt/fetch pattern that leaks interest.
Penumbra (FMD detection keys) and Aztec (tags) both show how to move the scan onto an untrusted server
that learns only a fuzzy/opaque superset. Two implementation routes, honestly ranked:

- **Overlay tag, shippable on Midnight TODAY (no protocol change).** Aztec's tags are *contract-level*
  (`poseidon2(secret, index)`, indexed by the node). Midnight can do the same via a Compact
  contract-emitted tag bound to a per-address detection secret — folding directly into brief 05's
  attestation contract (same key-hygiene, same `persistentHash` primitive, C3/C8). The untrusted
  UmbraDB/indexer then serves "logs matching these tags," never learning ownership beyond the tag set.
  *Residual:* an overlay tag is not consensus-emitted, so a malicious indexer can still **omit** a tag
  (re-opening completeness) — which is why ③ pairs with it, and why constrained delivery matters.
- **Native clue key in the address, strongest but a protocol change we don't control.** Penumbra's
  approach — clue key in the address, consensus-checked clue count + precision — gives detection
  ambiguity and is the gold standard, but requires Midnight to add an FMD field to its address format
  and consensus rules. **Flag to the Midnight team** (alongside brief 05 §5.3's kernel-op request and
  brief 06 §2.4's ciphertext-accumulator ask) as the principled long-term fix.

Impact: converts our remote-DB threat model from "trusted for privacy" (Monero/Penumbra-view baseline)
to "untrusted, learns only a fuzzy superset" — the exact property the task asked for.

### ② Adopt Penumbra's "chain provides collapsed span-hashes inline + anchor = global root" as the ADS/restore recipe

Penumbra is the production existence-proof of brief 06's ADS. Concretely fold in: (a) the wallet, on
restore, rebuilds its tree from Midnight's `MerkleTreeCollapsedUpdate` bridge for `[endIndex_N, tip]`
and asserts its rehashed root equals the on-chain `zswapMerkleTreeRoot` — Penumbra's fast-forward +
anchor check, one-to-one; (b) treat the on-chain root as a **per-spend anchor** (Penumbra spend proof)
so that the *first post-restore spend re-validates tail completeness for free* — the chain rejects a
spend whose witness path doesn't reach a real historical root. This costs nothing new (Midnight already
has the collapsed-update API and per-block roots, brief 01/06) and gives us Penumbra-grade property-I
assurance with a name and a shipped precedent.

### ③ Adopt Aztec "constrained delivery" as the model for closing the ciphertext-downgrade completeness gap (brief 06 §2.4)

The one residual all our briefs leave open is delivery/omission: an indexer can present a committed
leaf but withhold (downgrade to `None`) its ciphertext, making a real note invisible. Aztec closes the
analog by **enforcing in-circuit that the discovery hint (tag) is correctly emitted** so the recipient
is *guaranteed* to find the note ("constrained delivery"). The Midnight translation: require, via a
Compact contract or (better) a protocol rule, that every shielded output emit a detection tag/clue
bound to the recipient — turning "omitted ciphertext" into a *detectable, on-chain* violation rather
than a silent under-count. This is the cleanest conceptual fix for brief 06 §2.4 and it composes with
① (the same tag that gives remote-scan privacy, if consensus-emitted, also gives delivery completeness).
Longer-term (needs a Midnight rule); track with ①'s native route.

**Watch, don't build yet: OMR as the ceiling.** OMR (§7) is the only primitive that gives ① *and* ③
against a fully malicious server (privacy + completeness), and it is post-quantum. But ~100 MB keys,
per-message FHE, and Aztec's own "impractical in production" verdict mean it is a research track, not a
v1 dependency. FMD/tagging (①) is the pragmatic 80/20; OMR is where the design should be *able* to go.

---

## 10. The biggest open question

**Privacy-from-the-scanner and completeness pull in opposite directions, and only a consensus-level
tag or full OMR reconciles them.** ① wants the scan delegated to an untrusted party that learns
nothing; ③ wants that delegation to be provably exhaustive. If we ship ① as an *overlay* tag
(feasible on Midnight today, no protocol change), the untrusted indexer can still **omit a tag**, so
the tag buys privacy but re-opens the very completeness gap ③ was meant to close — and the anchor/ADS
(property I) only detects omission of *committed* leaves, not of *off-tree tags/ciphertexts* (brief 06
§2.4). The two clean ways out both cost something we don't fully control: (a) push the clue/tag into
Midnight's **consensus** (Penumbra-style clue key + clue-count/precision rules → detection ambiguity
*and* constrained delivery), a protocol change; or (b) full **OMR**, which gives privacy + completeness
against a malicious detector but is currently impractical (§7).

So the concrete decision the design council must make: **do we accept an overlay detection-tag now
(privacy win, completeness still bounded by ③-as-detection + NxN cross-indexer checks), or hold out for
a consensus-emitted clue key (privacy + completeness, but gated on a Midnight protocol change)?** That
trade — overlay-now vs consensus-later, and whether an untrusted indexer's freedom to drop a tag is
tolerable given the anchor already prevents *commitment* omission — is the open question this study
surfaces and cannot resolve from the outside.

---

## Sources

**Penumbra**
- Fuzzy Message Detection overview — viewing-key-vs-detection-capability tension, Bloom-filter analogy,
  Beck et al. reference: https://protocol.penumbra.zone/main/crypto/fmd.html
- S-FMD threat model — open vs closed world, detection ambiguity, colluding malicious detectors:
  https://protocol.penumbra.zone/main/crypto/fmd/threat_model.html
- S-FMD in Penumbra — clue keys in addresses, detection keys disclosed to third parties, dummy-clue
  and precision consensus rules: https://protocol.penumbra.zone/main/crypto/fmd/system_mapping.html
- Constructing S-FMD — compact constant-size keys, `p = 2^-n`, diversified detection:
  https://protocol.penumbra.zone/main/crypto/fmd/construction.html
- Addresses and Detection Keys — `dtk_d`/`ck_d` derivation, address = `d || pk_d || ck_d`:
  https://protocol.penumbra.zone/main/addresses_keys/addresses.html
- Tiered Commitment Tree — Anchor = global tree root, chain-provided block/epoch summary hashes,
  fast-forward: https://protocol.penumbra.zone/main/sct/tct.html
- Spend action — public "Merkle anchor" input, zk Merkle-path-to-anchor, on-chain anchor validation:
  https://protocol.penumbra.zone/main/shielded_pool/action/spend.html
- Guide (pcli) — view service scans with a viewing key, can run standalone on a relatively untrusted
  server: https://guide.penumbra.zone/usage/pcli
- Guide (pclientd configure) — view mode with only a full viewing key:
  https://guide.penumbra.zone/network/node/pclientd/configure
- Shielded Upgradability — CompactBlock scan rates, TCT fast-forward, download-full-block-on-detect:
  https://penumbra.exchange/blog/shielded-upgradability

**Zcash**
- ZIP-307 Light Client Protocol — tree-state checkpoint, birthday, `finalSaplingRoot`:
  https://zips.z.cash/zip-0307
- Wallet threat model — lightwalletd as trusted root of trust, omission residual, ZIP-307 fix:
  https://zcash.readthedocs.io/en/latest/rtd_pages/wallet_threat_model.html

**Aztec**
- Note Discovery — tagging (`poseidon2(secret,index)`), `getPrivateLogsByTags`, four tagging-secret
  strategies, constrained delivery, sliding window, and OMR/PIR as long-term privacy fix:
  https://docs.aztec.network/developers/docs/foundational-topics/advanced/storage/note_discovery
- PXE overview: https://docs.aztec.network/developers/docs/foundational-topics/pxe

**Namada / MASP**
- Shielded Sync (SDK) — fast sync via masp-indexer recommended; fetched/scanned split:
  https://docs.namada.net/integrating-with-namada/sdk/shielded-sync
- MASP overview — Sapling circuit extended to multi-asset:
  https://docs.namada.net/users/shielded-accounts
- namada-masp-indexer — crawls chain, tracks commitment tree + note positions, serves via HTTP RPC:
  https://github.com/anoma/namada-masp-indexer

**Monero / Iron Fish**
- Monero view-only wallets / view key — full incoming visibility, key-image import for outgoing:
  https://www.getmonero.org/resources/user-guides/view_only.html ;
  https://www.getmonero.org/resources/moneropedia/viewkey.html
- Iron Fish view keys — ivk/ovk, full visibility:
  https://ironfish.network/learn/blog/2023-07-20-view_keys ;
  https://ironfish.network/learn/whitepaper/protocol/transactions

**Cryptographic primitives**
- Beck, Len, Miers, Green, *Fuzzy Message Detection*, ACM CCS 2021 — outsource detection to an
  untrustworthy server with chosen false-positive rate `p`: https://eprint.iacr.org/2021/089
- Liu & Tromer, *Oblivious Message Retrieval*, CRYPTO 2022 — untrusted detector, oblivious digest,
  privacy+soundness+completeness vs fully adversarial colluding parties, post-quantum:
  https://eprint.iacr.org/2021/1256 ; https://github.com/ZeyuThomasLiu/ObliviousMessageRetrieval
- Liu, Ren et al., *PerfOMR*, USENIX Security 2024 — reduced OMR communication/computation:
  https://eprint.iacr.org/2024/204

No source was modified; no code was committed.
