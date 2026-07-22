# 11 — Non-ZK / Complementary Alternatives to the ZK-Anchored Design

**Date:** 2026-07-21
**Angle:** Breadth check on the "verifiable wallet-state snapshot" design (branch
`feature/verifiable-snapshot`). Prior briefs (01–06) converged on: an **on-chain-root anchor**
at a finalized checkpoint, an **authenticated-range ADS** for bounded-scan completeness,
**client-side encryption**, **anti-rollback** via monotonic height/seq, and an **optional
ZK self-certification / Compact on-chain attestation** (brief 05) for the layer that removes
replay entirely. This brief surveys **non-ZK (or ZK-complementary)** primitives for the same
two jobs — (a) attesting a snapshot's correctness, (b) making a remote/untrusted persistent
DB robust — and is honest about where each one is a genuine substitute, a useful complement,
or a dead end, compared against the ZK/anchor/ADS baseline.

**Builds on (does not re-derive):** brief 01 (state commitments), brief 02 (checkpoint-sync
prior art — Ethereum WS-sync, Cosmos state-sync, `assumeutxo`, all already NxN-gossip-shaped),
brief 03 (the anchor + "inclusion ≠ completeness" theorem, §7's residual-trust ledger), brief 05
(Compact on-chain attestation as the ZK-adjacent self-cert layer), brief 06 (the ADS that closes
tail-completeness). Nothing here contradicts those; the question is strictly **where a lighter
primitive is the right call instead of, or underneath, what they already recommend.**

---

## 0. The two jobs, restated, and why "non-ZK" is not one bucket

**Job (a) — self-certification.** The live, replay-derived wallet wants to leave behind a
verifiable trace ("I was correct and complete as of this snapshot") that a later restore can
check without replay. Brief 05's answer is a Compact attestation; §4 below asks whether a
plain signed, publicly-logged checkpoint gets most of the value for far less cost.

**Job (b) — remote/untrusted-DB robustness.** UmbraDB may be hosted, shared across devices, or
simply not fully trusted. Brief 03/06's answer is "trust the DB for availability only, verify
everything against the chain anchor." This brief asks: is there an off-the-shelf pattern
(verifiable databases, erasure coding, CRDTs) that strengthens or cheapens that story?

The five research areas below split cleanly across these two jobs, plus one (TEE) that claims
to address both and is examined skeptically for that reason.

---

## 1. TEE attestation (SGX/TDX, SEV-SNP, Nitro Enclaves) — a plausible-sounding dead end for job (a)

### 1.1 What remote attestation actually is, across all three vendors

The pattern is identical in shape everywhere: a chip-rooted secret signs a **report** binding
(i) a **measurement** of the exact code/data loaded, and (ii) an arbitrary **user payload**, and
a relying party checks a **certificate chain back to the vendor's root** before trusting either.

- **Intel SGX (DCAP).** A **Quoting Enclave (QE)** generates ECDSA-signed *quotes*; a
  **Provisioning Certification Enclave (PCE)** is "the local certificate authority that issues
  certificates for QE," and the **Provisioning Certification Service (PCS)** roots the whole
  chain in an Intel-issued certificate — DCAP exists specifically so a data center can run this
  infrastructure itself rather than calling Intel's older EPID-based remote-attestation service
  [Intel, *Attestation Services for Intel SGX*,
  https://www.intel.com/content/www/us/en/developer/tools/software-guard-extensions/attestation-services.html;
  Safeheron, *Demystify Remote Attestation*, https://safeheron.com/blog/what-is-remote-attestation/].
- **AMD SEV-SNP.** "The attestation report contains a cryptographic hash, called the launch
  measurement, of the initial guest memory contents and initial vCPU state," signed by a
  **Versioned Chip Endorsement Key (VCEK)** derived from a chip-unique **Chip Endorsement Key
  (CEK)**, itself rooted in an AMD platform key — the report additionally binds firmware/microcode
  version, and remote attestation "can be used for encrypted disk unlock" among other bootstrap
  uses [AWS, *Attest an EC2 instance with AMD SEV-SNP*,
  https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/snp-attestation.html].
- **AWS Nitro Enclaves.** An enclave requests a **signed attestation document** from the Nitro
  Hypervisor containing **PCR measurements** (PCR0 = enclave image hash, PCR1 = kernel/boot,
  PCR2 = application, PCR3/PCR4 = parent-instance IAM role/instance ID, PCR8 = signing
  certificate); the document is COSE_Sign1/CBOR-encoded and its certificate chains to an
  **AWS-published Nitro root** [AWS, *Cryptographic attestation*,
  https://docs.aws.amazon.com/enclaves/latest/user/set-up-attestation.html].

### 1.2 Could a snapshot be TEE-attested? Yes, mechanically — and here is exactly what that would and would not prove

Run the wallet's replay/scan logic inside an enclave; have it sign `(H(snapshot), height,
anchorBlockHash)` as the report's user payload. A restoring party checks the vendor cert chain,
the reported code measurement (matches the known-good wallet binary), and the payload. This is
a real, working construction — **but note precisely what it attests**: *"this exact, unmodified
binary, running on genuine vendor silicon, output this hash."* It says **nothing about whether
the chain data fed into that binary was itself genuine or complete** — the enclave has to be
handed a view of the chain from somewhere, and if that feed is untrusted, the attestation just
certifies "correct execution over data I cannot vouch for," which is not the property job (a)
needs. To close that, the enclave would *also* need the anchor check from brief 03 — at which
point TEE attestation has added a hardware trust dependency **on top of** the anchor, not
instead of it. It only becomes a genuine substitute for the anchor if you're willing to trust
the *hardware vendor* as much as you trust the *chain's own consensus* — which §1.3 argues is a
strictly worse bet.

### 1.3 Why crypto/chain-anchored proofs are preferred: the SGX break history is not incidental, it is the argument

A ZK/hash-based anchor's soundness reduces to public, long-studied mathematical assumptions
(collision resistance, discrete-log-type hardness) plus the chain's own consensus/finality — a
break is a publishable, falsifiable mathematical or protocol event. A TEE's soundness reduces to
**a specific vendor's silicon and firmware being un-broken at the moment of attestation** — a
much narrower, much less battle-tested surface that has failed repeatedly, on both major
vendors, in ways that specifically defeated attestation itself:

- **Foreshadow (2018)** was a transient-execution attack that read SGX-protected memory and, by
  "combining a transient execution attack with other tricks, leaked secrets from Intel's
  quoting enclave, enabling forgery of remote attestations" [USENIX Security 2018, van Bulck et
  al., *Foreshadow*, https://www.usenix.org/system/files/conference/usenixsecurity18/sec18-van_bulck.pdf].
  This broke the *attestation root itself*, not merely enclave contents.
- **SGAxe (2020)**, an evolution of CacheOut, again "extracted the SGX attestation keys from
  Intel's quoting enclave... effectively breaking the most appealing feature of SGX, which is
  the ability for an enclave to prove its trustworthiness over the network," on a **fully
  patched** post-Foreshadow machine [sgaxe.com, *SGAxe: How SGX Fails in Practice*,
  https://sgaxe.com/files/SGAxe.pdf]. Two separate, years-apart breaks of the same trust root.
- **Downfall (2023, CVE-2022-40982)**, a Gather-Data-Sampling attack, "allows an attacker to
  bypass SGX — and every other isolation boundary — on Intel Core processors across five
  generations," letting a malicious co-tenant "steal sensitive information like passwords and
  encryption keys" from other users/enclaves on shared cloud hardware [Cubist, *Intel SGX is
  broken (again)*, https://cubist.dev/blog/intel-sgx-is-broken-again-what-the-downfall-attack-means-for-secure-hardware;
  Moghimi, *Downfall*, USENIX Security 2023, https://downfall.page/media/downfall.pdf].
- **AMD is not exempt.** CVE-2024-56161 (disclosed 2025) let "an attacker with local
  administrator privilege load malicious CPU microcode resulting in loss of confidentiality and
  integrity of a confidential guest running under AMD SEV-SNP," due to "an insecure hash
  function in the signature validation for microcode updates" [The Hacker News,
  https://thehackernews.com/2025/02/amd-sev-snp-vulnerability-allows.html].
- **The wallet-shaped cautionary tale.** Secret Network — a blockchain whose entire private-state
  model rests on SGX enclaves holding a shared "consensus seed" master key, structurally similar
  to a TEE-attested wallet secret — had that seed extracted via an SGX flaw in 2023: "exposure
  of the consensus seed would enable the complete retroactive disclosure of all Secret-4 private
  transactions since the chain began" [Blockworks, *Secret Network Crypto Transactions Not So
  Secret After All*, https://blockworks.co/news/secret-network-crypto-transactions-not-so-secret-after-all].
  This is the single most on-point precedent for the exact failure mode this angle is checking:
  a TEE holding wallet-adjacent secret state, broken by a hardware side channel, with
  **retroactive, silent, unbounded** blast radius — categorically worse than a ZK-soundness
  break, which cannot retroactively deanonymize past-verified proofs.

**Verdict: TEE attestation is a plausible-sounding but ultimately weaker substitute for job (a),
and no help at all for job (b).** It attests code identity, not chain-relative data
correctness; closing that gap re-imports the anchor it was meant to replace; and its own root
of trust has broken, on both vendors, more than once, with at least one break directly
analogous to a wallet-secret compromise. It is a legitimate **complement** in one narrow role:
confidentiality-at-rest for a hosted UmbraDB (encrypt/decrypt inside an enclave so the host
operator cannot read plaintext even with root access) or as **trusted proving hardware to
accelerate the wallet's own scan/attest step** — in both cases the enclave is an optimization
layered *underneath* the anchor check, never a replacement for it, and even that role should be
weighed against the fact that a broken TEE fails silently while a broken SNARK assumption or a
forked chain fails loudly and is independently detectable via NxN cross-checking (brief 02 §1).

---

## 2. Verifiable / authenticated databases — the pattern is right, the generic tool is the wrong instance

### 2.1 The class

An **authenticated data structure** or **verifiable outsourced database** lets a client holding
only a short digest verify that a server's query answer over a large, server-held dataset is
both *sound* (the answer matches the committed data) and *complete* (no matching row was
dropped), at cost far below re-running the query — this is exactly brief 03's "verifiable
computing" framing (Gennaro–Gentry–Parno) and brief 06's Merkle-B-tree/authenticated-dictionary
survey, generalized from "range/membership over one tree" to "arbitrary SQL over a relational
schema."

- **vSQL** (Zhang, Genkin, Katz, Papadopoulos, Papamanthou, IEEE S&P 2017) gives verifiable
  **arbitrary SQL queries over a dynamic (updatable) outsourced database** — "efficiently verify
  the correctness of responses returned by the (untrusted) server," using an interactive-proof
  backend extended with polynomial delegation for outsourced/auxiliary input, achieving
  **verification cost polylogarithmic in the auxiliary input** (which for SQL can be as large as
  the whole database) and **server overhead up to 120× lower than generic SNARK-based
  approaches**, without SNARKs' query-dependent preprocessing
  [eprint 2017/1145, https://eprint.iacr.org/2017/1145].
- **IntegriDB** (Zhang, Katz, Papamanthou, CCS 2015) covers a rich SQL subset — **multidimensional
  range queries, JOIN, SUM, MAX/MIN, COUNT, AVG**, and limited nesting — over a database the
  client does not trust the host to answer honestly, with proofs of "a few KB," verification of
  "tens of milliseconds," and server computation "under a minute" even at 10⁵ rows, **including
  efficient updates** [http://integridb.github.io/IntegriDB.pdf; project page
  http://integridb.github.io/].
- **Merkle²** (Hu, Hooshmand, Kalidhindi, Yang, Popa, IEEE S&P 2021) is the low-latency answer to
  a real weakness of naive Merkle-log/key-transparency designs: prior transparency logs made
  users "wait an hour or more" for updates to take effect; Merkle² "propagates updates in as
  little as 1 second and can support 100× more users" via a new append/monitor/lookup data
  structure [eprint 2021/453, https://eprint.iacr.org/2021/453].

### 2.2 Mapping onto UmbraDB — validates the pattern, does not replace the instance

This is precisely the design pattern brief 03 (§1, "digest + proof, sound + complete") and
brief 06 (the ADS closing tail-completeness) already adopted — the generic literature confirms
it is the *right shape of answer*. But it is not the right **tool** to bolt onto UmbraDB,
for a concrete reason: brief 06 found that Midnight's own **domain-specific** append-only
Merkle tree (`MerkleTreeCollapsedUpdate`, already served by the indexer, `O(log range)` cost,
no new backend) gives commitment-completeness **for free, today** — cheaper and simpler than
standing up a generic verifiable-SQL layer (vSQL's interactive-proof/polynomial-delegation
machinery, or IntegriDB's per-index authenticated B-trees) over a schema (notes, nullifiers,
UTXOs) that Midnight already commits in its own way. Generic verifiable-SQL exists to solve a
**harder** problem — arbitrary ad hoc queries (joins, aggregates) over a schema the verifier does
not control in advance — which is not UmbraDB's actual query shape ("give me my notes as of
height N," not "sum all payments to address X grouped by month").

**Where it would earn its keep:** if the design ever needs to prove answers to genuinely
*analytic* queries over wallet history from an untrusted host — e.g., a hosted UmbraDB serving
"total value received in Q3, broken out by counterparty" with a proof, rather than "restore my
note set" — that is exactly vSQL/IntegriDB's problem, not the zswap tree's. Flag as a
**forward-looking option**, not a current recommendation: **reject for job (a)/(b) as currently
scoped; revisit only if UmbraDB grows an untrusted analytic-query surface.** Merkle²'s low-latency
lesson, separately, is worth carrying into §4 (transparency-log checkpoints) regardless of this
verdict — it is the fix for the one real weakness a CT-style log has that a Compact attestation
does not.

---

## 3. Data availability & durability — right instinct, wrong scale for erasure coding

### 3.1 Availability is a different property from integrity, and the design already knows this

Brief 03 §7 and brief 06 §6 already state the residual precisely: "the DB is trusted for
*availability only*, never for correctness." This section is about strengthening *that specific
half* — can a remote UmbraDB be prevented from **withholding or losing** the snapshot, as
distinct from tampering with it (already handled by the anchor).

### 3.2 The three tools, at the scale that actually matters

- **Replication / backup.** For a **single wallet's own snapshot** — kilobytes to low megabytes,
  not a blockchain's full state — the proportionate answer is simply **N full copies across
  independent failure domains** (e.g., streaming/WAL-based Postgres replication, or periodic
  `pg_basebackup`-style snapshots to a second provider/region). This is cheap, well-understood,
  and — usefully — composes with brief 03 §4's already-recommended **NxN cross-check pattern**:
  querying k ≥ 2 independent UmbraDB replicas and comparing not just gives availability but
  *strengthens* the tamper/rollback detection already prescribed for headers, extended to the
  snapshot blob itself. No new primitive is needed; extend the existing NxN habit to the
  snapshot store.
- **Erasure coding / Reed-Solomon.** The right tool when **one large dataset** is sharded across
  **many, individually-unreliable** storage nodes, none of which can hold the whole thing — the
  canonical instances are Filecoin/IPFS-style content-addressed storage networks and blockchain
  **data-availability layers**. Celestia is the clean reference: block data is arranged into a
  k×k matrix and **2-D Reed-Solomon–extended** into a 2k×2k matrix, so that "if light nodes
  receive a valid response for each sampling query, then there is a high probability guarantee
  that the whole block's data is available" [Celestia Docs, *Data Availability*,
  https://docs.celestia.org/learn/celestia-101/data-availability/]. This buys storage-efficiency
  at a **fixed redundancy factor spread across many independent shares** — valuable when the
  dataset is too big for any one party to hold in full, or must be verifiably available to many
  mutually-distrusting light clients without any of them downloading it whole.
- **Data-availability sampling (DAS).** The probabilistic technique layered on the above so that
  a *light client* can be confident a *large* dataset is fully published **without downloading
  it**, originating in Al-Bassam et al.'s fraud-and-data-availability-proofs construction
  [arXiv:1809.09044, *Fraud and Data Availability Proofs*, https://arxiv.org/pdf/1809.09044] and
  productionized in Celestia.

### 3.3 Why the heavier two are disproportionate here

A wallet's own snapshot is a single, small blob that **the wallet itself already possesses (or
can re-derive by replay)** — there is no "too big to hold in full" problem, and no population of
*other people's* light clients who need probabilistic confidence they don't have to download it.
DAS answers "is this large public dataset available to strangers who can't afford to check it
directly"; a wallet asking "can I get *my own* cached blob back" is a much simpler, deterministic
question that plain multi-host replication answers outright, at a fraction of the engineering
cost. Erasure coding earns its complexity only past a scale (many shards, many independent
storage parties, dataset too large for full replication to be cheap) that a wallet cache does
not reach — it becomes relevant only if UmbraDB itself, as an infrastructure product, later
needs to shard a **large, shared** index (e.g. the address-indexed UTXO ADS from brief 06 §4, at
full-chain scale) across many untrusted storage nodes; that is a UmbraDB-the-service concern, not
a UmbraDB-the-wallet-cache concern.

**Verdict: adopt plain replication (extends the existing NxN pattern to the snapshot blob, ~zero
new design surface); explicitly reject erasure coding and DAS as disproportionate at
wallet-snapshot scale** — flag them only as the right future tool if UmbraDB ever becomes a
large shared multi-tenant data-availability layer in its own right.

---

## 4. Signed checkpoints / transparency logs — a real, cheaper alternative to Compact, with a sharp boundary on when it actually works

### 4.1 The pattern, and two production instances of it

Brief 03/05/06 already use RFC 6962's Signed-Tree-Head model as the theoretical vocabulary.
Two deployable systems instantiate that model as a **lightweight, off-chain, non-ZK
self-certification layer** — exactly the shape job (a) is asking about as a Compact alternative.

- **Sigsum**, a minimalistic transparency log purpose-built for "signed checksum submissions for
  a wide variety of applications ... neither known nor trusted by the log operator." Its design
  is precise about the trust model: "the overall system is said to be secure if a log monitor
  can discover every signed checksum that an end-user would accept," and the load-bearing
  assumption is explicit — security holds "**at most a threshold of independent witnesses stop
  following protocol**." Witnesses are cheap to run: "the log provides the O(log N) consistency
  proof when requesting a cosignature, and the witness only needs to store the O(1) latest
  checkpoint it observed." Verification for an end-user needs **no new outbound network
  connection** — proofs travel with the data — at a cost of accepting **5–10 minutes of latency**
  before a cosigned checkpoint is available [Sigsum design doc,
  https://git.sigsum.org/sigsum/plain/doc/design.md].
- **Trillian**, Google's general-purpose transparency-log server generalizing Certificate
  Transparency to arbitrary data: `GetLatestSignedLogRoot` returns "tree size, hash value,
  timestamp, and signature" for the current root; it is "stable" and "used in production... by
  many large-scale Certificate Transparency log operators," though **now in maintenance mode**,
  with the project explicitly steering new deployments to its successor, **Tessera**
  [google/trillian, https://github.com/google/trillian; Trillian docs,
  https://google.github.io/trillian/docs/TransparentLogging.html]. Worth flagging plainly: don't
  build a new dependency on a codebase its own maintainers are retiring.

### 4.2 Head-to-head against brief 05's Compact attestation

| | **Compact on-chain attestation (brief 05)** | **Transparency-log checkpoint (Sigsum/Trillian-style)** |
|---|---|---|
| Anti-rollback mechanism | **Structural, for free** — Midnight's transcript/CAS execution model (brief 05 C7) makes a replayed old attest tx fail because chain state moved; monotonicity is enforced by **consensus the wallet already trusts unconditionally** | Enforced by the **log + a witness quorum** — a genuinely *new* trust party the wallet did not need before |
| Who must be honest for the guarantee to hold | Chain consensus only (no new party) | The log operator **and/or** a threshold of independent witnesses actually cross-checking it |
| Cost per checkpoint | Seconds of local ZK proof generation + a DUST tx fee (brief 05 §4.6) | A bare signature (microseconds); **zero** proving cost, **zero** chain fee |
| Latency to a durable, checkable commitment | One block's finality | 5–10 min for a cosigned checkpoint (Sigsum design doc) or Trillian's batching interval; mitigated by Merkle²-style low-latency logs if needed (§2.1) |
| Degrades to what, on failure | Falls back to replay — the attestation only ever *removes* work, never *replaces* ground truth (brief 05 §8) | Same shape *if and only if* witnesses are real and independent; collapses to **zero protection** if the log is self-hosted by the same operator being defended against |

### 4.3 The sharp boundary: this is a genuine substitute in exactly one deployment shape

A public transparency log's security comes from **many unrelated parties using the same log and
gossiping about it** — CT's own security model is monitors/auditors comparing signed heads across
a shared, multi-tenant log. Applied to a **single wallet's** self-hosted or purpose-stood-up log,
this collapses: there are no independent witnesses to cross-check a log that only one tenant
ever queries, and if the log operator *is* the same untrusted UmbraDB host being defended
against, the "attestation" adds nothing — it is signed by the party the design distrusts. This
is the same trap brief 05 §9 flags for its own weakest link (restore-time freshness, "not
fixable inside the contract") wearing a different hat.

**Where it genuinely works:** a **multi-tenant hosted UmbraDB** offering could run *one shared*
transparency log across all its tenants (or use a public one like Sigsum's production
deployment), giving every tenant a real, cross-checkable, near-free anti-rollback signal — a
single log now has an actual population of mutually-distrusting users capable of noticing a
split view, exactly CT's original security argument. In that shape, it is a legitimately cheaper
alternative to a per-wallet Compact attestation.

**Verdict: optional, conditional adopt.** Keep brief 05's Compact attestation as the **default** —
it needs no new trust party and gets rollback protection free from consensus already trusted for
everything else. Offer a transparency-log checkpoint as a **cheaper opt-in specifically for
multi-tenant hosted deployments**, documented plainly as trusting a log-operator-plus-witness-
quorum instead of consensus, and only sound when witness cosigning is genuinely multi-party —
never as a drop-in replacement in the single-wallet case this whole design is centered on.

---

## 5. Threshold signatures, social recovery, and CRDTs for the multi-device case

### 5.1 The actual question: DB shared across N devices of the same wallet

This is a **new** gap none of briefs 01–06 covers head-on — they analyze wallet-vs-untrusted-DB
(a vertical trust relationship to the chain); this is wallet-instance-vs-wallet-instance (a
horizontal relationship between mutually-trusting siblings sharing one DB).

### 5.2 CRDTs get you convergence, not tamper-evidence — until you sign them

**Conflict-free Replicated Data Types** (Shapiro, Preguiça, Baquero, Zawirski, 2011; survey
arXiv:1805.06358, https://arxiv.org/abs/1805.06358) let any replica accept local updates without
coordination and guarantee that replicas which have seen the same updates converge to the same
state — "Strong Eventual Consistency." That is exactly the right *shape* for two devices editing
the same wallet's local cache concurrently (e.g. device A creates a new note, device B spends
one), but the base CRDT model assumes **honest, non-Byzantine replicas** — it says nothing about
a tampering or lying DB sitting between them.

**Martin Kleppmann's fix closes exactly that gap.** "Making CRDTs Byzantine Fault Tolerant"
(PaPoC 2022) augments CRDT deltas with signatures and a **hash chain to the causal predecessor**:
"each node signs the deltas it produces, and each delta includes a hash of the previous delta,"
requiring only **causal delivery** (weaker than total ordering/consensus — no agreement protocol
needed) to achieve what the paper calls **fork\*-consistency**: "if two nodes diverge, they can be
reunited by exchanging their operation histories, and the signatures guarantee no node deviated
from the protocol" [https://martin.kleppmann.com/papers/bft-crdt-papoc22.pdf]. Concretely for
UmbraDB: each device signs and hash-chains its wallet-state deltas before writing them; the
untrusted DB is demoted to a **relay/blob-store** role — it can delay or drop deltas
(an availability failure, detectable and recoverable by re-fetch, same as brief 03's framing) but
cannot forge a delta, splice in an out-of-causal-order one, or silently rewrite history without
the hash chain visibly breaking.

**How this composes with the existing anchor — complement, not substitute.** BFT-CRDT signing
gives a **horizontal** check (device B can tell device A's copy was tampered with, or that A's
updates were hidden from B); the on-chain anchor (briefs 03/05/06) gives the **vertical** check
(the resulting state matches the chain). Neither subsumes the other: two devices could
BFT-CRDT-agree perfectly on a state that is **stale or simply wrong relative to the chain** if
neither ever re-checked the anchor — that residual is exactly brief 03 §6/06 §6's completeness
gap, now also needing to be checked between siblings, not only against the chain. The two layers
should run **together**: signed hash-chained deltas for sibling-to-sibling tamper-evidence,
anchor+ADS checks for chain-relative correctness, at essentially no cost conflict (a signature +
hash per delta is cheap and orthogonal to a Merkle-path check against the chain root).

### 5.3 Threshold signatures and social recovery solve adjacent, different problems — don't conflate them

**FROST** (Komlo & Goldberg, SAC 2020) is a **t-of-n Schnorr threshold signature** scheme,
"secure to be run in parallel," enabling "true threshold signing" where "only a threshold t out
of n possible participants are required" [eprint 2020/852, https://eprint.iacr.org/2020/852], now
in production use (Coinbase's threshold signing service; the Zcash Foundation's own FROST work
[Coinbase, *Production Threshold Signing Service*,
https://www.coinbase.com/blog/production-threshold-signing-service]). This answers a **key
custody** question — *who may authorize a spend or attestation* — not a database-consistency
question. It would only be relevant here if "multi-device" means each device holds a **share**
of brief 05's `sk_attest` rather than the same full key: a 2-of-3 threshold attest adds
loss-resilience (one device's share leaking or being lost doesn't compromise or brick attesting)
at the cost of a coordination round among devices — a real option, but a materially bigger lift
than either the Compact single-key design (05) or the CRDT approach above, and it solves a
**different** problem than the one this section's prompt actually asks (DB robustness across
devices, not who signs).

**Social recovery** (Buterin's guardian-based proposals; Argent-style smart-contract wallets)
solves **key loss** — recovering wallet access when the seed itself is gone — via
guardian-approved recovery flows, entirely off the ZK/anchor axis and well precedented in
production [Ready, *What is Social Recovery?*, https://www.ready.co/learn/what-is-social-recovery].
This is out of scope for "make the DB robust"; it is the standard non-ZK answer to a different
question ("what if the wallet's own secret is gone," not "what if the DB lies"). Flag as a
candidate **separate future angle** if the design council ever wants to cover seed-loss, not
folded into this brief's recommendation.

**Verdict:** for the *stated* problem (DB shared across devices, consistency + anti-rollback),
**signed hash-chained deltas (BFT-CRDT, Kleppmann's construction)** are the right, proportionate,
non-ZK primitive — cheap, needs only causal (not total) ordering, and slots in underneath the
existing anchor rather than replacing anything. Threshold signatures and social recovery are
real, production-proven tools for **adjacent** problems (key custody, key loss) and should not be
adopted as a stand-in for database-consistency machinery.

---

## 6. Synthesis — layered recommendation

| Primitive | Closes | Layer relative to existing design | Verdict |
|---|---|---|---|
| TEE remote attestation (SGX/TDX/SEV-SNP/Nitro) | "code identity" attestation | Would sit *above* job (a) | **Reject as substitute for the anchor/ZK.** Attests execution, not chain-relative correctness; still needs a trusted chain feed; own root of trust (vendor silicon) has broken repeatedly, incl. a wallet-shaped Secret Network failure. Usable only as an orthogonal confidentiality/perf layer *underneath* the anchor. |
| vSQL / IntegriDB (verifiable outsourced SQL) | job (b), generic query integrity+completeness | Would replace brief 06's ADS | **Reject as current adoption; validates the pattern.** Midnight's own zswap tree already gives the same guarantee more cheaply for the actual query shape ("my notes," not ad hoc SQL). Revisit only if UmbraDB grows an untrusted analytic-query surface. |
| Merkle² (low-latency transparency-log data structure) | log-propagation latency | A building block for §4 | **Adopt the lesson, not necessarily the library** — if a transparency-log checkpoint (below) is ever built, use its low-latency design, not vanilla CT/Trillian batching. |
| Replication/backup of the snapshot blob | job (b), availability/durability | Extends brief 03 §4's NxN pattern | **Adopt.** Cheap, proportionate, strengthens tamper detection as a side effect. |
| Erasure coding / DA sampling (Celestia-style) | job (b), availability at scale | N/A at wallet scale | **Reject at this scale.** Right tool only if UmbraDB becomes a large shared multi-tenant DA layer in its own right. |
| Signed transparency-log checkpoint (Sigsum/Trillian) | job (a), cheaper self-cert | Alternative to brief 05's Compact attestation | **Conditional adopt** — genuinely cheaper *only* for multi-tenant hosted deployments with real witness cross-checking; keep Compact as the single-wallet default (free consensus-CAS, no new trust party). |
| Signed hash-chained CRDT deltas (Kleppmann BFT-CRDT) | multi-device DB-sharing consistency + tamper-evidence | New layer, orthogonal to the anchor | **Adopt.** Cheap (signature + hash per delta), needs only causal delivery, closes a gap briefs 01–06 never addressed (sibling-to-sibling, not wallet-to-chain). |
| Threshold signatures (FROST) / social recovery | key custody / key loss | Orthogonal — different problem | **Out of scope for DB robustness**; legitimate, production-proven, but solves who-may-sign or how-to-recover-a-lost-seed, not database consistency. Flag as a separate future angle. |

**The biggest tradeoff, stated once, plainly.** Every non-ZK primitive surveyed here buys
cheapness by moving trust from a **public, falsifiable, long-lived mathematical/consensus
assumption** (hash/SNARK soundness, chain finality — the ZK/anchor baseline) onto some
**operational party** (a silicon vendor, a log operator, a witness quorum, a device population).
That trade is often a *good* one — replication, hash-chained CRDT deltas, and even a
witness-cosigned transparency log in the right (multi-tenant) deployment shape are honest,
proportionate wins that this brief recommends folding in. But it is a *categorically* weaker
trust model in general: operational-party compromise can be silent, partial, and specific to a
moment in time (a broken enclave, a colluding log operator) in a way a broken hash function or a
finalized-then-reorged chain is not — the former can leak retroactively and undetectably (Secret
Network's consensus-seed extraction is the sharpest example), the latter is a publishable,
independently-checkable event. The one place a non-ZK primitive is not merely cheaper but
**strictly necessary** — because the ZK/anchor design says nothing about it at all — is the
multi-device case: signed, hash-chained CRDT deltas solve sibling-consistency, a problem
orthogonal to chain-anchoring, and belong in the design regardless of how the ZK question is
resolved.

---

## Sources

- Intel, *Attestation Services for Intel® Software Guard Extensions* — DCAP, QE/PCE/PCS chain.
  https://www.intel.com/content/www/us/en/developer/tools/software-guard-extensions/attestation-services.html
- Safeheron, *Demystify Remote Attestation: Explore the DCAP Certificate Chain*.
  https://safeheron.com/blog/what-is-remote-attestation/
- AWS, *Attest an Amazon EC2 instance with AMD SEV-SNP* — launch measurement, VCEK/CEK chain.
  https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/snp-attestation.html
- AWS, *Cryptographic attestation* (Nitro Enclaves) — PCR0–PCR8, COSE_Sign1/CBOR, Nitro root.
  https://docs.aws.amazon.com/enclaves/latest/user/set-up-attestation.html
- Van Bulck et al., *Foreshadow: Extracting the Keys to the Intel SGX Kingdom*, USENIX Security
  2018 — broke the SGX attestation (quoting enclave) key itself.
  https://www.usenix.org/system/files/conference/usenixsecurity18/sec18-van_bulck.pdf
- Van Schaik et al., *SGAxe: How SGX Fails in Practice*, 2020 — extracted attestation keys again
  post-Foreshadow mitigation, on fully patched hardware. https://sgaxe.com/files/SGAxe.pdf
- Moghimi, *Downfall: Exploiting Speculative Data Gathering*, USENIX Security 2023
  (CVE-2022-40982). https://downfall.page/media/downfall.pdf
- Cubist, *Intel SGX is broken (again) — what the Downfall attack means for secure hardware*.
  https://cubist.dev/blog/intel-sgx-is-broken-again-what-the-downfall-attack-means-for-secure-hardware
- The Hacker News, *AMD SEV-SNP Vulnerability Allows Malicious Microcode Injection with Admin
  Access* (CVE-2024-56161, 2025). https://thehackernews.com/2025/02/amd-sev-snp-vulnerability-allows.html
- Blockworks, *Secret Network Crypto Transactions Not So Secret After All* — SGX-held consensus
  seed extracted, retroactive privacy loss. https://blockworks.co/news/secret-network-crypto-transactions-not-so-secret-after-all
- Zhang, Genkin, Katz, Papadopoulos, Papamanthou, *vSQL: Verifying Arbitrary SQL Queries over
  Dynamic Outsourced Databases*, IEEE S&P 2017. https://eprint.iacr.org/2017/1145
- Zhang, Katz, Papamanthou, *IntegriDB: Verifiable SQL for Outsourced Databases*, ACM CCS 2015.
  http://integridb.github.io/IntegriDB.pdf ; project page http://integridb.github.io/
- Hu, Hooshmand, Kalidhindi, Yang, Popa, *Merkle²: A Low-Latency Transparency Log System*, IEEE
  S&P 2021. https://eprint.iacr.org/2021/453
- Celestia Docs, *Data Availability* — 2-D Reed-Solomon encoding + sampling.
  https://docs.celestia.org/learn/celestia-101/data-availability/
- Al-Bassam, Sonnino, Buterin, *Fraud and Data Availability Proofs: Maximising Light Client
  Security and Scaling Blockchains with Dishonest Majorities*. https://arxiv.org/pdf/1809.09044
- Sigsum design document — witness cosigning, freshness/append-only checks, latency/cost model.
  https://git.sigsum.org/sigsum/plain/doc/design.md
- google/trillian — general transparency log server; `GetLatestSignedLogRoot`; maintenance-mode
  status, successor Tessera. https://github.com/google/trillian ;
  https://google.github.io/trillian/docs/TransparentLogging.html
- Shapiro, Preguiça, Baquero, Zawirski, *Conflict-free Replicated Data Types*, 2011 (survey
  arXiv:1805.06358). https://arxiv.org/abs/1805.06358
- Kleppmann, *Making CRDTs Byzantine Fault Tolerant*, PaPoC 2022 — signed, hash-chained deltas;
  causal delivery; fork*-consistency. https://martin.kleppmann.com/papers/bft-crdt-papoc22.pdf
- Komlo, Goldberg, *FROST: Flexible Round-Optimized Schnorr Threshold Signatures*, SAC 2020.
  https://eprint.iacr.org/2020/852
- Coinbase, *Production Threshold Signing Service*.
  https://www.coinbase.com/blog/production-threshold-signing-service
- Ready, *What is Social Recovery?* — guardian-based key-loss recovery.
  https://www.ready.co/learn/what-is-social-recovery
- Local grounding — UmbraDB `design/research/2026-07-21-snapshot-root-of-trust/01–06` (briefs
  built upon throughout; no source code read or modified for this angle).

No source was modified; no code was committed.
