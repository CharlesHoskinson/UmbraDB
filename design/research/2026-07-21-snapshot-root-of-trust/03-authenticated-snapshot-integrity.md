# Angle 3 — Authenticated Snapshot Integrity: root of trust between authoritative in-memory state and a persistent, possibly remote/untrusted cache

Deep-research brief, 2026-07-21. Scope: how the in-memory wallet DB can trust
a restored snapshot **without a full replay**, and how the remote/untrusted-DB
case changes the requirements. One of four angles for the "verifiable
wallet-state snapshot root-of-trust" design.

Local grounding read first (cited inline as `[UmbraDB]`):
`src/interfaces/checkpoint-store.ts`, `design/design.md` §§3/6/10,
`Formal/STORAGE_ALGEBRA.md` §§2/6.

---

## 0. The question, stated precisely, and the gap it exposes

The authoritative wallet state `S` is defined **operationally, by replay**:
for Midnight's real `ZswapLocalState`, `(State, applyEvent)` is a right action
of the free monoid of ledger events, and `replayEvents = foldl apply` over the
event list in strict `firstFree` index order — so the *correct* state at block
`N` is, by definition, `S_N = replayEvents(chain[0..N])`
[UmbraDB `Formal/STORAGE_ALGEBRA.md` "Grounding fact"]. A snapshot is a
persisted serialization of some `S`. The question — "how does the in-memory DB
know a restored snapshot is correct without a replay?" — is therefore:
**how do we check `S_snapshot == replayEvents(chain[0..N])` without recomputing
the right-hand side?**

### The gap UmbraDB already has, named exactly

UmbraDB's `CheckpointStore` is already a content-addressed, chunked,
integrity-verifying store: `save()` splits data into fixed-size chunks keyed by
their own SHA-256 hash, writes an immutable manifest (the ordered chunk-hash
list), and `load()` **always fully rehashes and verifies every chunk** before
returning, throwing `ChunkIntegrityError`/`ChunkMissingError`/`ManifestCorruptError`
otherwise [UmbraDB `src/interfaces/checkpoint-store.ts` lines 119–172]. Chunk
writes are idempotent and content-addressing gives `f(f(x))=f(x)` on the
`hash→data` map [UmbraDB `Formal/STORAGE_ALGEBRA.md` §2, Law C1]. At the app
layer, private state is sealed under **AES-256-GCM** with keys derived from a
per-`(accountId, scope)` salt [UmbraDB `design/design.md` §6 lines 452–492].

All of this proves exactly one thing: **the blob you read back is the blob that
was written.** A content hash `h(blob)` binds `blob ↔ h`; an AES-GCM tag binds
`ciphertext ↔ (key, ciphertext)` and proves it was sealed by the key-holder and
not altered. **Neither binds `blob ↔ chain.`** A malicious or buggy writer can
persist a blob that hashes cleanly and decrypts cleanly yet encodes a *wrong*
state — an extra note that is not yours, a missing spend, an inflated balance,
a `firstFree` off by one. Content-addressing is tamper-evidence of the bytes;
it is **not** proof that the bytes are the correct chain-derived state.

UmbraDB's own formal spec states this conclusion and its boundary precisely:
for a single-writer, local, non-Byzantine wallet cache a Merkle/authenticated-
data-structure layer is "**not warranted as a general addition**," because every
production precedent for one (Certificate Transparency via Trillian, Ethereum's
state trie, Sui's object store) exists to let *mutually-distrusting third
parties* verify state independently of the operator — a problem the local
deployment does not have; AES-GCM's own auth tag already gives tamper-evidence
"at the point they're written and read by the trusted process that holds the
key" [UmbraDB `Formal/STORAGE_ALGEBRA.md` §6]. Critically, §6 then flags the
two cases that flip the threat model — (a) an attacker editing Postgres's
on-disk files directly, and (b) a "**export this checkpoint and let someone
else verify it**" requirement — as "the exact external-verifier case
Trillian/CT solve." **This angle is precisely case (b) generalized: a
remote/untrusted DB is an external, adversarial party serving the snapshot.**
The rest of this brief is what §6 defers.

### One theorem frames everything below

The **only** authority on "what the chain says at block `N`" is the chain
itself — its consensus-validated headers and the state commitments inside them.
Therefore *every* no-replay verification must ultimately reduce the snapshot to
a check against an **on-chain commitment the wallet independently trusts**.
The database is never a source of correctness; at most it is a source of
*availability*, i.e. an untrusted accelerator of a scan the wallet could always
redo from a trusted anchor. Keep this reduction in mind — it is the residual
trust assumption every option shares (§7).

---

## 1. Authenticated data structures and verifiable/outsourced databases (RQ1)

**What they are.** An authenticated data structure (ADS) lets an untrusted
*prover* (here, the DB) answer queries about a dataset such that a *verifier*
holding only a short **digest** (a root hash) can check each answer with a
compact **proof**, without holding the data. The canonical primitive is the
**Merkle hash tree**: leaves are hashes of data blocks, each internal node is
the hash of its children, and the single **root hash** commits the whole set;
any leaf's correctness is provable by a logarithmic **audit path** of sibling
hashes up to the root [Wikipedia, *Merkle tree*,
https://en.wikipedia.org/wiki/Merkle_tree]. RFC 6962 (Certificate
Transparency) is the reference specification of this used as a verifiable log:
it fixes SHA-256, defines the **Merkle Tree Hash (MTH)** over an ordered list,
a **Merkle audit path** ("if the root computed from the audit path matches the
true root, then the audit path is proof that the leaf exists in the tree"), and
a **Merkle consistency proof** proving the append-only property — "that any
particular version of the log is a superset of any particular previous version"
[RFC 6962 §§1.3, 2.1, 2.1.1, 2.1.2,
https://datatracker.ietf.org/doc/html/rfc6962]. Merkle trees also "avoid the
need to blindly trust logs: if a log attempts to show different things to
different people, this can be efficiently detected by comparing tree roots and
consistency proofs" [RFC 6962 §1.2].

The general framing is **verifiable computing**: a weak client offloads a
computation to an untrusted worker, which returns the result *plus a proof it
was computed correctly*, and — the defining property — "the client [can] verify
the proof with significantly less computational effort than computing the
function from scratch" [Wikipedia, *Verifiable computing*,
https://en.wikipedia.org/wiki/Verifiable_computing, formalized by
Gennaro–Gentry–Parno]. That is exactly the no-replay property we want: verify
`S == replayEvents(chain[0..N])` more cheaply than recomputing the fold.

**What they guarantee — and what they do NOT.** An ADS/Merkle proof guarantees
**data-integrity relative to a commitment**: "the answer I gave is consistent
with the root digest `R`." It says **nothing about whether `R` itself is the
right value** — a Merkle proof against a *wrong* root is a perfectly valid proof
of wrong data. This is the exact analogue of UmbraDB's blob gap: content-
addressing/ADS proves `blob` matches `R`, not that `R` is the correct chain-
derived commitment. The semantic-correctness question ("is the committed data
the true scan result?") is *out of scope* for the ADS itself and must be
discharged separately, by binding `R` to a trusted anchor (§2) or by proving the
computation that produced it (§3c). Second, plain membership proofs give
**inclusion, not completeness**: a prover can honestly prove every note it
*chose to show* is in the tree while silently *omitting* notes — the verifier
cannot detect the omission from inclusion proofs alone. For a shielded wallet
this is the decisive limitation (§3, §6).

---

## 2. Signed/committed snapshots and the trusted on-chain anchor (RQ2)

The standard construction: the snapshot carries a **commitment** (a Merkle
root / state root) **plus a block height `N`**, and the verifier checks the
commitment against a **trusted anchor**. In CT the anchor is the log's
**Signed Tree Head (STH)** — the root hash + tree size, signed by the log; a
client that has seen an STH "can later demand a proof of inclusion" and treat
inconsistency as "evidence of the incorrect operation of the log"
[RFC 6962 §§1.2, 3.5, https://datatracker.ietf.org/doc/html/rfc6962]. The
signature answers *who commits it*: in CT, the log operator; and misbehaviour
is caught by **monitors/auditors** and gossip comparing signed heads
[Wikipedia, *Certificate Transparency* §"monitors and auditors",
https://en.wikipedia.org/wiki/Certificate_Transparency].

**For a wallet the anchor must be the chain, and the chain signs it, not the
DB.** The trusted anchor is a **consensus-validated on-chain commitment at
height `N`** that the wallet has independently obtained: (i) the block
**header** at `N` from the wallet's own trusted header chain (or a trusted
finalized-checkpoint hash), and (ii) the on-chain **state commitment** carried
in that header. For Midnight/Zswap this commitment is concrete: the ledger
maintains a **Merkle tree of coin/note commitments** with published **roots**
and a `firstFree` cursor — UmbraDB's formal grounding cites exactly these
(`ZswapLocalState`, `MerkleTreeCollapsedUpdate`, `roots`, `firstFree`), and
`applyCollapsedUpdate` is a monoid homomorphism whose correctness is
observational equivalence up to the projection π = (spendable coins,
`firstFree`, roots) [UmbraDB `Formal/STORAGE_ALGEBRA.md` "Grounding fact"].
Midnight itself splits state into **public on-chain state** and **private
locally-held encrypted state** [Midnight Docs, *What is Midnight?*,
https://docs.midnight.network/]. So the note-commitment-tree root at `N` is
public and on-chain — it is the ideal anchor, and *the chain's consensus/finality
is what "signs" it*. The snapshot's own state root is then checked *against*
that public root; the DB neither produces nor signs the anchor.

The snapshot should therefore carry, at minimum: `anchorHeight N`,
`anchorBlockHash`, a **state commitment** over the wallet's own note/coin set,
the on-chain **note-commitment-tree root** and `firstFree` at `N`, per-note
**membership (audit) paths**, and — for the untrusted case — a monotonic
**sequence number** and a **writer signature** over `(seq, N, anchorBlockHash,
stateRoot)` (§4).

---

## 3. The crux — no-replay verification: three options compared (RQ3)

### (a) Membership proofs against the on-chain state root
The snapshot proves, for each note it claims the wallet holds, a Merkle audit
path from that note's commitment to the on-chain commitment-tree root at `N`
(RFC 6962-style inclusion [§2.1.1]); and it proves each claimed spend by the
presence of its **nullifier** in the on-chain nullifier set, and each claimed
*unspent* note by nullifier **non-membership**.
- **Guarantee:** the shown notes genuinely exist on-chain and their spent/unspent
  status is as claimed — fabrication and double-spend are detected.
- **Cost:** cheap; `O(log n)` hashes per note, verified locally.
- **What it CANNOT do:** prove **completeness**. Inclusion proofs never show you
  were shown *all* your notes; an untrusted DB can serve a valid-but-partial
  snapshot that hides funds (an under-count / denial, not a theft) [§1, §6]. For
  a shielded pool, "which notes are mine and unspent" is discovered only by
  **trial-decryption of every note ciphertext** with the viewing key — an
  inclusion proof cannot substitute for that scan. So (a) alone is insufficient
  for a shielded wallet.

### (b) Bounded incremental replay from the snapshot's block to tip
Trust the snapshot's *base* via a commitment, then **scan only the short tail**
`[N, tip]` — never from genesis. This is precisely Mina's **snarked-ledger vs.
staged-ledger** split: a recursive zk-SNARK certifies the ledger "a few blocks
behind the latest," while "the latest ledger… is verified explicitly by
[applying] the transactions to the ledger and [is] not guaranteed by the
blockchain proof"; a syncing block producer "amounts to verifying `k`
blockchain SNARKs and applying the transactions in those `k` blocks," where
`k` = 290 is the Ouroboros-Samasika finality depth [Mina Protocol,
*22kB-Sized Blockchain*, https://minaprotocol.com/blog/22kb-sized-blockchain-a-technical-reference].
- **Guarantee:** completeness *within the tail* is established by the trustless
  scan; the base is trusted via its commitment.
- **Cost:** bounded — `tip − N` blocks, not the whole chain.
- **Residual:** it does **not** close the completeness gap at the **base** unless
  the base commitment itself certifies "these are all your notes at `N`" — which
  for a shielded pool again requires a scan up to `N`. So (b) in practice means:
  **trust a prior *self-produced* (or ZK-certified) snapshot as the base, scan
  only the tail.** For a wallet that already trusts its own historical scan up
  to a finalized checkpoint, this is the best cost/trust balance and maps
  directly onto UmbraDB's §10 replay-equivalence gate applied *at load time*.

### (c) A ZK proof that the snapshot is the correct scan result
The snapshot carries a succinct proof that `S = replayEvents(chain[0..N])`,
**including completeness** (every note addressed to the given viewing key was
included). This is verifiable computing at its strongest [Wikipedia,
*Verifiable computing*] and is what Mina does for the whole chain: it "replaces
the entire blockchain… with an easily verifiable constant-sized cryptographic
proof," and a non-consensus node with "a protocol state, the account, a merkle
path to this account, and a verification key" has "equivalent security to full
nodes… in a trustless manner" — the Merkle path's "resulting merkle root should
match the ledger state that was verified by the blockchain snark"
[Mina Protocol, *22kB-Sized Blockchain*]. Midnight already runs zk-SNARKs
(≈128-byte proofs, verified in milliseconds) as its public/private bridge
[Midnight Docs, https://docs.midnight.network/], so the primitive exists.
- **Guarantee:** fully closes the semantic-correctness gap, including
  completeness, with **no replay at all** — verify in `≪` the cost of the scan.
- **Cost/trust:** a **prover** must generate it; no such "prove my wallet scan
  is complete" prover exists in Midnight's wallet stack today — this is a
  research build, not an off-the-shelf option. Trust shifts to the proving
  system's soundness and to the circuit encoding the *real* scan rule and the
  correct viewing keys.

**Summary.** (a) is cheap but cannot prove completeness → unsafe alone for
shielded state. (b) reduces trust to a short tail-scan plus a trusted base
commitment → the pragmatic recommendation. (c) is the only option that fully
eliminates replay and closes completeness, at the cost of building a prover.

---

## 4. Remote/untrusted DB: tampering, staleness, rollback (RQ4)

When UmbraDB is hosted/shared across devices, the snapshot is served by an
**untrusted party**. Three distinct properties are needed; UmbraDB today has
only fragments of them.

**Tamper-detection.** AES-GCM's auth tag detects blob tampering **on the
wallet's own read path** [UmbraDB `design/design.md` §6] — but note the boundary
§6 itself draws: row-level tags "are re-verified only on the trusted writer's
own read path, not against an independent root," so an attacker "editing
Postgres's on-disk files directly" is *not* covered
[UmbraDB `Formal/STORAGE_ALGEBRA.md` §6]. Against a remote DB this is exactly the
live threat. The fix is the anchor check of §2: the wallet re-derives the state
commitment from the decrypted blob and checks it against the **on-chain** root,
so tampering that survives the GCM tag (e.g. a substituted-but-authentic older
blob) still fails the anchor check.

**Staleness / rollback (the key new attack).** The auth tag carries **no
freshness** — a remote DB can serve a *previously authentic* snapshot at an old
height and it will decrypt and verify perfectly. This is the classic **rollback
/ replay attack** on outsourced state: ROTE defines it as an adversary who
"violates the integrity of a protected application state by **replaying old
persistently stored data** or by starting multiple application instances," with
"serious consequences on applications such as financial services," and shows a
**single platform cannot efficiently prevent rollback** using only untrusted
storage — you need either trusted local non-volatile monotonic state or a
distributed set of platforms attesting each other's freshness (ROTE's approach:
"the only way to violate integrity is to reset **all** participating platforms")
[Matetic et al., *ROTE: Rollback Protection for Trusted Execution*, USENIX
Security 2017, https://eprint.iacr.org/2017/048]. Mitigations, in increasing
strength:
1. **Monotonic sequence + signed height.** Snapshot carries a strictly
   increasing `seq` and `anchorHeight`, signed by the writer over
   `(seq, N, anchorBlockHash, stateRoot)`. The wallet persists the **highest
   `seq`/height it has ever accepted** in a small trusted local store and rejects
   any snapshot below it. This is anti-rollback via a wallet-controlled
   monotonic counter — the local-NV-memory scheme ROTE compares against.
2. **Use the chain as the freshness oracle (best for a wallet).** Require
   `anchorHeight ≥` the last height the wallet knows finalized, and
   `anchorBlockHash` on the canonical header chain. An old snapshot is then
   rejected *because its height is below the wallet's known tip* — anti-rollback
   folds into the same §2 anchor check, and the freshness authority is the
   chain, not a fragile local counter.
**Split-view / equivocation** (a shared DB showing different snapshots to
different devices) is the CT split-view problem [RFC 6962 §1.2; Wikipedia,
*Certificate Transparency*]. For a single-user multi-device wallet the clean
answer is that **each device verifies against the chain anchor independently**:
the chain is the shared source of truth, so an equivocation that still passes
every device's anchor check is harmless (both snapshots are correct-as-of-their-
height), and one that fails is rejected — no gossip protocol is required.

**Net:** treat the remote snapshot as an **untrusted accelerator**. On load
from an untrusted DB, (1) verify GCM tag → blob integrity; (2) verify writer
signature + monotonic `seq`/height → anti-rollback/freshness; (3) verify
`anchorBlockHash` against trusted headers → the state is anchored to the real
chain; (4) re-establish completeness at the tip by a **bounded tail replay**
(§3b) — never trust the DB for correctness, only for saving the genesis-to-`N`
scan.

---

## 5. Privacy of shielded/viewing-key-derived state (RQ5)

A remote DB must not learn the shielded state. The standard approach is
**client-side encryption under a key deterministically derived from the wallet
seed**. Zcash's ZIP-32 is the reference: a wallet "only need[s] to store a
single seed," a one-time backup of which recovers all funds, and *all* shielded
keys are derived from it; the seed MUST carry ≥256 bits of entropy or it "will
be a weak link in the derivation of *all* keys" [ZIP-32, *Shielded HD Wallets*,
https://zips.z.cash/zip-0032]. The privacy-relevant material is **viewing-key-
derived**: viewing keys are "derived directly from a user's spending key" and
grant visibility into transaction value/memo/target for a shielded address
without spend authority [Electric Coin Company, *Explaining viewing keys*,
https://electriccoin.co/blog/explaining-viewing-keys/]. UmbraDB already
implements the mechanism: app-layer **AES-256-GCM** with keys derived from a
per-`(accountId, scope)` salt looked up via `getOrCreateSalt`, so the same at-
rest key is re-derivable across restarts [UmbraDB `design/design.md` §6
lines 452–492]. The remote DB stores only ciphertext (`bytea`) and opaque
content hashes; decrypted notes never leave the client.

**Interaction with the integrity/commitment scheme.** Encryption and
authentication must be **layered so the commitment does not leak plaintext**:
- The commitment the **DB sees** (chunk hashes / manifest root) is computed over
  **ciphertext** — pure blob integrity, exactly what `CheckpointStore` already
  does [UmbraDB `src/interfaces/checkpoint-store.ts`]. It reveals nothing about
  the shielded contents.
- The commitment the **wallet checks against the chain** (the state root over
  the wallet's notes) is computed over **plaintext** *locally, after decryption*,
  and is **never sent to the DB.**
- The **on-chain** note-commitment-tree root is already public and leaks nothing
  extra: note commitments are *hiding* commitments, so membership proofs against
  the public root reveal which *tree positions* are proven but not that they are
  *yours* — provided the wallet fetches proofs without revealing its query set
  (fetch the subtree / use a light-client access pattern that does not disclose
  exactly which leaves it cares about). Encrypt-then-MAC ordering (GCM is an
  AEAD, so this holds) ensures the DB cannot use the integrity layer as a
  decryption oracle.

Thus privacy (seed-derived encryption) and integrity (on-chain-anchored
commitment) compose cleanly: the DB is zero-knowledge of plaintext, while the
wallet still gets a chain-anchored correctness check over the decrypted state.

---

## 6. The completeness gap is the deepest residual, and it is fundamental

Worth isolating because it recurs in every option. For a **shielded** wallet,
"the correct state" is not just "these commitments are on-chain" but "these are
**all and only** the notes addressed to my viewing key, with correct spent
status." Inclusion/membership proofs (option a) prove *inclusion* and never
*completeness* [§1; RFC 6962 §2.1.1 proves a leaf is present, not that a set is
exhaustive]. The only ways to establish completeness are (i) **scan** — trial-
decrypt every note up to `N` — or (ii) a **ZK proof of the scan** (option c)
that certifies completeness relative to the given viewing keys. Consequently,
**absent a ZK-proof-of-scan, some scan is unavoidable**; the design choice is
only *how much* scan (genesis→tip vs. checkpoint→tip) and *whom* you trust for
the checkpoint base. This is the semantic core of UmbraDB's §10 note that its
differential/state-equivalence gate "proves the … implementations agree with
EACH OTHER … it does NOT prove either one equals the true fold-over-all-events-
from-genesis" — the replay-equivalence property P3 is the only real check
[UmbraDB `design/design.md` §10; `Formal/STORAGE_ALGEBRA.md` Law T3].

---

## 7. Recommended verification protocol and the residual trust assumption

**Local, single-writer, trusted process (UmbraDB's current deployment).** Keep
what STORAGE_ALGEBRA §6 concluded: content-addressing + AES-GCM suffice. The
writer *is* the authority — it produced `S` by scanning, so blob-integrity on
its own read path is enough; **no ADS/Merkle layer is warranted**
[UmbraDB `Formal/STORAGE_ALGEBRA.md` §6]. No change recommended here.

**Remote/untrusted DB (this angle's scope) — the snapshot carries:**
1. `anchorHeight N`, `anchorBlockHash`.
2. On-chain **note-commitment-tree root** + `firstFree` at `N`, and a wallet-
   side **state root** over its own note/coin set.
3. Per-held-note **Merkle membership paths** to the on-chain root; per-spend
   **nullifier** membership; per-unspent-note nullifier **non-membership**.
4. Content/manifest hashes + **AES-GCM** ciphertext (privacy + blob integrity).
5. Monotonic **`seq`** and a **writer signature** over
   `(seq, N, anchorBlockHash, stateRoot)`.

**The wallet checks, in order, against a trusted anchor:**
1. AES-GCM tag → blob not tampered; decrypt with seed-derived key.
2. Writer signature + `seq`/height ≥ highest ever accepted → **anti-rollback /
   freshness** [ROTE, https://eprint.iacr.org/2017/048].
3. `anchorBlockHash` is on the wallet's **trusted header chain** at `N`, and the
   snapshot's state root's constituent note commitments verify against the
   **on-chain commitment-tree root** at `N` → the state is anchored to the real
   chain, not merely to a self-consistent blob [RFC 6962 §2.1.1;
   Mina *22kB* Merkle-path-to-account].
4. **Bounded incremental replay** `[N, tip]` (§3b) to re-establish completeness
   at the tip → the untrusted snapshot is accepted only as an accelerator of a
   scan the wallet could always redo from a trusted checkpoint base. Upgrade
   path: replace this tail-scan's *base* trust with a **ZK proof of scan**
   (§3c) to eliminate replay entirely.

**The anchor** is the wallet's independently trusted view of the **chain**:
verified block headers / a trusted finalized-checkpoint hash and the on-chain
state commitment they carry. The chain's consensus signs it; the DB never does.

**Residual trust assumption (irreducible).** The DB is trusted for
*availability only*, never for correctness. Correctness reduces to the on-chain
anchor; the anchor's trust reduces to the chain's **consensus/finality**, which
is outside UmbraDB's scope. Beyond that: (i) the **completeness** guarantee is
only as good as the base — membership proofs never prove you saw *all* your
notes, so without a ZK-proof-of-scan a scan-to-base is assumed trusted (§6);
(ii) with option (c) you additionally trust the **proving system's soundness**
and that the circuit encodes the true scan rule and the correct **viewing
keys** — the proof certifies completeness only *relative to the keys given*;
(iii) **privacy** rests on the seed's ≥256-bit entropy and the secrecy of the
seed-derived encryption key [ZIP-32]. Under the current single-writer local
threat model none of this is needed; it becomes mandatory the moment the DB is
remote or the checkpoint is exported for third-party verification — the exact
threat-model flip UmbraDB `Formal/STORAGE_ALGEBRA.md` §6 named and deferred.

---

## Sources

- RFC 6962, *Certificate Transparency* (Laurie, Langley, Kasper, June 2013) —
  Merkle Hash Tree, Signed Tree Head, audit paths (inclusion), consistency
  proofs (append-only), split-view detection.
  https://datatracker.ietf.org/doc/html/rfc6962
- Wikipedia, *Merkle tree* — root-hash commitment + logarithmic audit path.
  https://en.wikipedia.org/wiki/Merkle_tree
- Wikipedia, *Verifiable computing* — Gennaro–Gentry–Parno; verify with far less
  work than recomputing. https://en.wikipedia.org/wiki/Verifiable_computing
- Mina Protocol, *22kB-Sized Blockchain — A Technical Reference* — recursive
  zk-SNARK proof of full chain state; non-consensus node with Merkle path to
  account; snarked-ledger vs. staged-ledger (bounded tail).
  https://minaprotocol.com/blog/22kb-sized-blockchain-a-technical-reference
- Matetic, Ahmed, Kostiainen, Dhar, Sommer, Gervais, Juels, Capkun, *ROTE:
  Rollback Protection for Trusted Execution*, USENIX Security 2017 —
  replay-of-old-persisted-state attack; single platform cannot prevent
  rollback with untrusted storage alone. https://eprint.iacr.org/2017/048
- Wikipedia, *Certificate Transparency* — monitors/auditors, split-view.
  https://en.wikipedia.org/wiki/Certificate_Transparency
- Electric Coin Company, *Explaining viewing keys* (2020) — viewing keys derived
  from the spending key; selective disclosure without spend authority.
  https://electriccoin.co/blog/explaining-viewing-keys/
- ZIP-32, *Shielded Hierarchical Deterministic Wallets* — single seed,
  deterministic key derivation, ≥256-bit entropy requirement.
  https://zips.z.cash/zip-0032
- Midnight Docs, *What is Midnight?* — public on-chain state vs. private
  locally-held encrypted state; zk-SNARK public/private bridge.
  https://docs.midnight.network/
- Local grounding — UmbraDB `src/interfaces/checkpoint-store.ts` (content-
  addressed, integrity-verifying store); `design/design.md` §§3 (chunker),
  6 (AES-256-GCM, seed/salt key derivation, `wallet_state` + genesis hash),
  10 (state-equivalence gate + replay-equivalence gap);
  `Formal/STORAGE_ALGEBRA.md` §2 (Laws C1/C2, content-addressing), §6 (the ADS
  decision and its threat-model boundary), "Grounding fact" (`ZswapLocalState`
  right-monoid-action replay, `MerkleTreeCollapsedUpdate`, roots/`firstFree`).
