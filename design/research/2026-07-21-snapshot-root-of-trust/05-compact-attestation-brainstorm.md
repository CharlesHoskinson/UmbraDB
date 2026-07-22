# 05 — Compact-Contract Snapshot Attestation: Design Brainstorm

**Date:** 2026-07-21
**Angle:** Use a Compact contract so the live, replay-derived wallet ATTESTS a commitment to its
snapshot on-chain, giving a later restore (or a remote/untrusted UmbraDB) something to verify
against without replaying the chain.
**Status:** Brainstorm / design-space exploration. No code changed. Contract sketches are
UNCOMPILED illustrations, flagged as such.

---

## 1. The problem, restated as a root-of-trust question

The wallet SDK's in-memory state is *correct by construction*: it is a fold over the indexer
stream, and every intermediate state was produced by applying verified chain data
(`ShieldedWallet.serializeState()` / `restore()` — the SDK's own seam for this is
`~/repos/midnight-wallet/packages/shielded-wallet/src/ShieldedWallet.ts:110` and
`packages/dust-wallet/src/DustWallet.ts:238`; the serialized form is "local state, transaction
history, and block height", `packages/abstractions/src/WalletState.ts:17`).

When UmbraDB persists that state (CheckpointStore) and a later process restores it, the restored
state's only pedigree is *"it came out of the database."* UmbraDB already gives us
**self-consistency**: every `load()` rehashes every chunk against the manifest and the manifest
against `manifestHash` (`src/interfaces/checkpoint-store.ts:7,32,40-43`). What it cannot give us
is **authenticity and freshness**: a compromised or hostile DB can serve a snapshot that is
internally consistent but (a) not one this wallet ever produced, or (b) an old one this wallet
*did* produce (rollback), or (c) one produced by a *different* wallet.

So the missing object is an **authenticated, rollback-protected root of trust for
`manifestHash`** that lives outside the DB's control. The chain is the one place the wallet
already trusts (its whole state is derived from it). Hence the owner's idea: the live wallet
attests `H(snapshot)` via a Compact contract.

**The honest framing of what any attestation can achieve** (this shapes everything below):

> An attestation *transports* attest-time trust forward in time; it does not *create*
> correctness. It proves "an agent holding the wallet's secret committed to exactly these bytes,
> at a chain-observable moment, and no later commitment supersedes it." If the live wallet was
> correct when it attested (which is the premise of 'correct by construction'), the restored
> state inherits that correctness. If the wallet was buggy/compromised *at attest time*, the
> attestation faithfully pins the bad state. Only Variant 3 (proof-of-correct-scan) would go
> beyond trust-transport, and §6 argues it is not tractable in Compact today.

---

## 2. Grounding: what Compact/Midnight actually gives us

Capability inventory used by the designs below. Everything here is verified against docs or
in-tree source; nothing is invented.

| # | Capability | Source |
|---|-----------|--------|
| C1 | **Witnesses** are private inputs supplied by the TS driver; the contract "must not assume the code of any witness function" — an adversary can supply anything, so only circuit-checked properties count. | https://docs.midnight.network/compact/reference/compact-reference §"Declaring witnesses for private state management" |
| C2 | **Explicit disclosure**: witness-derived data (including exported-circuit *arguments*) must be wrapped in `disclose()` before touching the public ledger. Privacy is the default. | https://docs.midnight.network/compact/reference/explicit-disclosure |
| C3 | `persistentHash<T>(v): Bytes<32>` and `persistentCommit<T>(v, rand): Bytes<32>` are **SHA-256-based**, upgrade-stable, and `persistentCommit` with good `rand` is a *hiding* commitment (stdlib says its output need not be `disclose()`d). | https://docs.midnight.network/compact/standard-library/exports §persistentHash/persistentCommit; impl: `~/repos/midnight-ledger/base-crypto/src/hash.rs:93` |
| C4 | Public ledger ADTs: `Cell`, `Counter`, `Set`, `Map<K,V>`, `List`, `MerkleTree<n≤32,T>`, `HistoricMerkleTree` (checkRoot accepts *past* roots). TS side can read `root()`, build `pathForLeaf()`. | https://docs.midnight.network/compact/reference/ledger-adt |
| C5 | In-circuit Merkle verification: `merkleTreePathRoot` / `merkleTreePathRootNoLeafHash` over `MerkleTreePath<n,T>`. This is exactly how real zswap spends verify membership. | stdlib exports §merkleTreePathRoot; `~/repos/midnight-ledger/zswap/zswap.compact:41` |
| C6 | **Kernel** exposes `blockTimeGreaterThan/LessThan(time)` (comparisons against wall-clock seconds) — there is **no way to read the current block height or time as a value** inside a circuit. Also `self()`, `claimZswapNullifier`, `claimContractCall`, `checkpoint`. | https://docs.midnight.network/compact/reference/ledger-adt §Kernel |
| C7 | **Transcript model**: a tx is (public transcript of ledger ops + ZK proof). At application the transcript is *re-run against current state*; asserts over read values fail if state moved. This gives free replay-protection and CAS-like semantics for our monotonicity guard. | https://docs.midnight.network/concepts/how-midnight-works/smart-contracts §"Transcripts and ZK Snarks" |
| C8 | Identity binding pattern (bboard): store `owner = disclose(publicKey(localSecretKey(), seq))` where `publicKey = persistentHash([domain-sep, seq, sk])`; later prove key knowledge by regenerating and `assert`-ing equality — auth without signatures, without revealing `sk`. | https://docs.midnight.network/tutorials/bboard/smart-contract §"Create the publicKey helper circuit" |
| C9 | The **real zswap preimage formats** are public Compact code: coin commitment `persistentHash<CoinPreimage>{sep:"midnight:zswap-cc[v1]",...}`, coin pk `persistentHash<PublicKeyPreimage>{sep:"midnight:zswap-pk[v1]", secretKey}`, global tree = `HistoricMerkleTree<32, Bytes<32>>`. A circuit of ours *could* recompute a note's commitment exactly as zswap does. | `~/repos/midnight-ledger/zswap/zswap.compact:17-80` |
| C10 | `for` loops must have **compile-time-known bounds** ("the need for the compiler to generate finite proving circuits"); no recursion, no unbounded iteration. | compact-reference §for statements |
| C11 | Contract public state is queryable per-address, **as of a block offset**, from the indexer: `contractAction(address, offset)`. | `~/repos/midnight-indexer/indexer-api/graphql/schema-v4.graphql:1266` |
| C12 | `ownPublicKey(): ZswapCoinPublicKey` returns the caller's coin pk — but it is context-supplied, best treated as a convenience, not an authentication root; C8 is the auth pattern. | stdlib exports §ownPublicKey |
| C13 | Fees are paid in DUST generated by held NIGHT; a small contract call is a routine tx (cadence cost ≈ dust decay, not cash). | https://docs.midnight.network/concepts/dust-architecture, https://docs.midnight.network/guides/generating-dust-programmatically |

Two **negative** capability facts that constrain the design space (worth stating loudly because
they kill otherwise-attractive variants):

- **N1 — No global-state oracle in-circuit.** A user contract cannot read the *global* zswap
  commitment tree root (or nullifier set) inside a circuit. Ledger ops touch only the
  contract's *own* declared fields (C4); kernel ops (C6) reference the containing transaction,
  not historical chain state. So "prove in-circuit that my snapshot's notes are in Midnight's
  commitment tree" is not expressible — that cross-check must happen client-side at restore
  (it's cheap there, §5.3).
- **N2 — No unbounded computation.** C10 rules out any circuit that scans a block range of
  unknown size. Proof-of-correct-scan can only be approached incrementally, and even then hits
  a completeness wall (§6).

---

## 3. Threat model

Actors:

- **W** — the wallet process holding the seed. Trusted *while live and freshly replay-derived*
  (that is the premise we are extending, not a new assumption).
- **DB** — UmbraDB (possibly remote/hosted). **Untrusted for integrity**: may tamper, substitute,
  roll back, or withhold. Trusted only for availability (and even that failure is detectable).
- **CHAIN** — Midnight consensus. Trusted (the wallet already assumes this).
- **VIEW** — whatever node/indexer the restoring wallet queries. Semi-trusted: can lie by
  *omission/staleness* (eclipse), can be cross-checked against multiple endpoints (C11 allows
  point-in-time queries from any indexer).

Attacks we want restore to defeat:

| Attack | Description |
|---|---|
| A1 Substitution | DB serves internally-consistent bytes W never produced (fabricated notes → wallet shows phantom balance, or omitted notes → funds "lost", poisoned sync cursor → wallet skips real notes). |
| A2 Rollback | DB serves an *old genuine* snapshot (hides recent spends → double-display; hides recent receipts). |
| A3 Cross-wallet swap | Hosted multi-tenant DB serves another wallet's genuine, attested snapshot. |
| A4 Attestation forgery | DB (or anyone) plants an on-chain attestation for a hash of its choosing, "authenticating" A1. |
| A5 Stale view | DB colludes with VIEW to show an old contract state so A2 verifies. |

Explicit **non-goals** (state them or the design overclaims): wallet-compromise *at attest time*
(only §6-full would address it; intractable); DB availability (withholding is detectable, not
preventable); metadata privacy beyond what §7 achieves.

---

## 4. Variant 1 — On-chain latest-pointer attestation ("Attested Manifest Pointer")

### 4.1 What goes on chain

A single shared contract (one deployment serves all UmbraDB users — bigger anonymity set, §7)
with a map from an unlinkable per-wallet pseudonym to the *latest* attestation record:

```compact
// SKETCH — not compiled. pragma/circuit syntax to be validated against compactc.
import CompactStandardLibrary;

struct AttestRecord {
  commitment: Bytes<32>,  // hiding commitment to the snapshot root (§4.2)
  height: Uint<64>,       // wallet-claimed "synced through block N"
  seq: Uint<64>,          // per-identity attestation counter
}

export ledger attestations: Map<Bytes<32>, AttestRecord>;

witness attestSecretKey(): Bytes<32>;   // dedicated HD-derived key, NOT the spend key (§4.5)
witness snapshotRoot(): Bytes<32>;      // = CheckpointStore manifestHash (or §5 Merkle root)

export circuit attest(height: Uint<64>): [] {
  const sk  = attestSecretKey();
  // C8 pattern: pseudonymous identity = domain-separated hash of the secret
  const id  = disclose(persistentHash<Vector<2, Bytes<32>>>(
                [pad(32, "umbradb:attest:v1:id"), sk]));

  // monotonicity + implicit CAS via the transcript model (C7)
  const isUpdate = attestations.member(id);
  const prevSeq  = isUpdate ? attestations.lookup(id).seq : 0;
  if (isUpdate) {
    assert(attestations.lookup(id).height < height,
           "attestation must advance the sync height");
  }

  // salt derived from (sk, seq): commitment is hiding, yet re-derivable at
  // restore with nothing but the seed and the public record — no salt to store
  const salt = persistentHash<Vector<3, Bytes<32>>>(
                 [pad(32, "umbradb:attest:v1:salt"), sk, seqAsBytes(prevSeq + 1)]);
  const c    = persistentCommit<Bytes<32>>(snapshotRoot(), salt);   // hiding (C3)

  attestations.insert(id, AttestRecord {
    commitment: c,
    height: disclose(height),
    seq: disclose((prevSeq + 1) as Uint<64>),
  });
}
```

(`seqAsBytes` = the `Uint`→`Bytes<32>` cast, compact-reference §"Casts of Bytes to and from
Field and Uint". Whether the compiler accepts `persistentCommit`'s output undisclosed when
`salt` is witness-*derived* rather than witness-fresh needs a compile check — C3's doc language
is "under the assumption that rand is sufficiently random". Worst case we wrap in `disclose()`,
which is semantically fine: the commitment is still hiding.)

### 4.2 What the wallet does

**Attest-time** (after a verified sync to block N, on a cadence — e.g. every checkpoint save, or
every K blocks / T hours):

1. `serializeState()` → snapshot bytes; `CheckpointStore.save()` → `manifestHash` (already
   SHA-256 content-addressed, `checkpoint-store.ts:7,32`).
2. Call `attest(N)` with witnesses `sk_attest` (HD-derived, §4.5) and `snapshotRoot =
   manifestHash`. Proof is generated by the wallet's own proof server
   (`midnight-wallet/packages/prover-client`), tx submitted like any other.
3. Persist nothing extra. The salt re-derives from `(sk, seq)`; `seq` is public in the record.

**Restore-time**:

1. `CheckpointStore.load()` — UmbraDB's own integrity check gives snapshot ↔ `manifestHash`.
2. Derive `id` from `sk_attest`; query `contractAction(attestContract, latest)` (C11) from
   **k ≥ 2 independent endpoints** (mitigates A5); read `AttestRecord{commitment, height, seq}`.
3. Re-derive `salt(sk, seq)`, recompute `persistentCommit(manifestHash, salt)`, require equality
   with `commitment`; require snapshot's internal "synced through" == `height`.
4. On success: adopt the state, resume incremental sync from `height`. On failure: refuse the
   snapshot and fall back to replay (the attestation makes replay a *fallback*, never a lie).

### 4.3 What this proves, precisely

- The bytes restored are byte-identical to a snapshot that an agent knowing `sk_attest`
  committed to (A1 dead: DB cannot fabricate — it would need `sk`; A4 dead: a forged
  attestation would need a proof over the `id` derivation, i.e. `sk`).
- That commitment is the **latest** for this identity: the `Map` holds exactly one record per
  `id`, the circuit asserts height-monotonicity, and — the elegant part — the transcript model
  (C7) makes this a compare-and-swap: a *replayed old attest tx* re-runs its transcript against
  current state, the recorded `lookup`/`assert` no longer holds, and the tx fails. Rollback of
  the *on-chain pointer* is impossible without `sk` (A2 dead, up to A5).
- Binding to *this* wallet: `id` is derived from this seed's `sk_attest` in-circuit, so a
  hosted DB serving another tenant's genuine snapshot fails step 3's commitment check under *my*
  salt and *my* id (A3 dead).

**Residual trust:** (i) attest-time wallet honesty (§1's framing — explicit non-goal to remove);
(ii) `height` is wallet-claimed, not chain-verified (C6: a circuit cannot read height; we can
sandwich the attest *time* with `kernel.blockTimeGreaterThan/LessThan` bounds as a sanity
corridor, but the height↔snapshot correspondence rests on the same attest-time honesty we
already assume); (iii) freshness of the restore-time chain view (A5) is a light-client problem,
mitigated — not eliminated — by multi-endpoint querying; the strongest form is a local node.

### 4.4 Variant 1b — keep history on-chain (pairs beautifully with TemporalKV)

Add `export ledger history: MerkleTree<32, Bytes<32>>` and `history.insertHash(c)` on every
attest (C4). Now *every* commitment ever attested has an on-chain membership witness, while the
`Map` still marks the unique latest. This distinguishes two restore verdicts:

- **verified-latest** — matches the Map pointer (the default safety bar), vs.
- **verified-historical** — user *deliberately* restores an older checkpoint (UmbraDB's whole
  TemporalKV/`getAt` ethos) and we can still prove "this exact snapshot was attested by me,
  at seq s < latest" via a Merkle path against `history` (TS-side `pathForLeaf`, C4; or even
  in-circuit later via C5, e.g. proving it to a third party).

Rollback *fraud* stays dead (the Map pointer is unforgeable); rollback *by user intent* becomes
a verifiable first-class operation instead of an unverifiable one. Depth-32 = 4B attestations
per contract instance; per-user cadence makes this a non-limit.

### 4.5 Key hygiene

Derive `sk_attest` at a dedicated HD path (the SDK already has an HD package,
`midnight-wallet/packages/hd`), purpose-separated from spend/viewing keys: attesting must not
require unsealing the spend key, and a leaked `sk_attest` must not spend funds — worst case an
attacker can *attest garbage over my pointer* (denial-of-restore-verification, recoverable by
replay) but cannot steal or read state.

### 4.6 Cost & feasibility

Circuit: ~4 `persistentHash/Commit` invocations + one Map lookup/insert — *smaller than a single
zswap spend* (which does a depth-32 Merkle path + 2 persistent hashes in-circuit,
`zswap.compact:35-66`). Proof generation: seconds on the local proof server; attestation is
asynchronous and off the hot path. On-chain: one Map entry (~100 B) per wallet, one tx per
cadence tick, fees in DUST (C13). Feasibility risk: **low** — every construct used is in the
current stdlib/ledger-ADT docs.

---

## 5. Variant 2 — Merkle-committed structured snapshot ("Attested Manifest *Root*")

Same contract, same trust model — the *shape of the committed value* changes.

### 5.1 Design

Instead of `snapshotRoot = manifestHash` (a flat SHA-256 over the ordered chunk-hash list),
the wallet builds a **canonical Merkle tree** whose leaves are the snapshot's semantic sections,
each hashed with domain separation:

```
leaf 0: H("umbra:leaf:cursor"   || sync cursor: height, block hash, indexer offsets)
leaf 1: H("umbra:leaf:notes"    || canonical encoding of unspent shielded notes)
leaf 2: H("umbra:leaf:nulls"    || watched nullifier set)
leaf 3: H("umbra:leaf:history"  || tx-history chunk list)
leaf 4: H("umbra:leaf:dust"     || dust-wallet state)
leaf 5: H("umbra:leaf:manifest" || CheckpointStore manifestHash)   // ties to raw bytes too
...
root  = Merkle over leaves        (SHA-256, i.e. persistentHash-compatible, C3)
```

`attest()` commits `root` exactly as in §4. Building the tree with `compact-runtime`'s
`StateBoundedMerkleTree` (https://docs.midnight.network/api-reference/compact-runtime/classes/StateBoundedMerkleTree)
keeps the digest format `MerkleTreeDigest`-compatible, so **future circuits can consume
membership paths via `merkleTreePathRoot` (C5) without re-plumbing**.

### 5.2 What this buys over Variant 1

- **Partial verification / partial restore**: verify the sync cursor or a single section against
  the attested root with one Merkle path — without downloading the whole snapshot from a remote
  UmbraDB. (Flat `manifestHash` needs the full manifest; Merkle needs log-depth.)
- **Third-party provability** (later, optional): "prove to an auditor my attested snapshot at
  height N contained note X / balance ≥ B" as a small Compact circuit over a `MerkleTreePath`
  — the attestation record becomes an anchor for selective disclosure (C2's ethos), not just
  restore integrity.
- **Section-level fault localization** on restore mismatch (which section diverged → better
  diagnostics than "hash differs").

### 5.3 The zswap cross-check (client-side, and why not in-circuit)

Every unspent note in the snapshot corresponds to a coin commitment whose preimage format we
know exactly (C9). At restore, the wallet can therefore *independently re-validate the
snapshot's economic content against the chain*: recompute each note's commitment
(`"midnight:zswap-cc[v1]"` preimage) and check membership in the **global** zswap
`HistoricMerkleTree<32>` via a fresh chain/indexer query, and check its nullifier's absence.
This is a *second, wallet-independent* leg of trust: even a snapshot attested by a buggy wallet
cannot smuggle in a note the chain never saw (shrinks — does not eliminate — the attest-time
honesty gap: omission and cursor-poisoning are still only caught by the attestation itself).

Doing this check **in-circuit** at attest time is not expressible: N1 — a user contract cannot
reach the global commitment tree root from a circuit. This is the single Compact capability
whose absence most limits the stronger variants; worth raising with the Midnight team as a
feature request (a kernel op like `zswapCommitmentRootIsRecent(rt)` would unlock §6-lite
completeness for *presence*, though still not for *absence/omission*).

Cost: Variant 1 + a few hundred hashes off-circuit at attest; identical on-chain footprint.
Feasibility: same as V1 (the circuit is unchanged; only the committed value's construction
differs). The only new work is a **canonical serialization spec** for snapshot sections — which
UmbraDB needs anyway for cross-version stability (§9 Q6).

---

## 6. Variant 3 — Proof-of-correct-scan (full and lite)

### 6.1 Full version: prove the snapshot IS the correct scan of [birthday, N]

What it would need in-circuit: (a) iterate all chain outputs in the range — unbounded, violates
C10/N2; (b) trial-decrypt every candidate note under the viewing key — per-note plausible,
million-fold repetition not; (c) prove **completeness** ("no note was missed") — requires
proving a universal statement over chain data the circuit cannot even access (N1); (d) no
recursion/folding primitives exposed in Compact to amortize any of this.

**Verdict: not tractable in Compact today, and not close.** This is not a "needs optimization"
gap; three separate load-bearing capabilities (unbounded/recursive circuits, in-circuit access
to historical global state, in-circuit note decryption at scale) are absent by design. Anyone
who claims this variant should be asked which of N1/N2 they repealed.

### 6.2 Lite version: incremental *well-formedness* of the delta

What IS expressible with C3/C5/C9/C10 for a bounded delta of K notes (K a compile-time bound,
e.g. 64 per attest, multiple attests for larger deltas):

- new root chains from previous: `newRoot = H(prevRoot || deltaDigest)` — an on-chain **hash
  chain of custody** across attestations (record gains a `prevCommitment` link);
- every added note's commitment recomputes correctly from its claimed `ShieldedCoinInfo` per
  the exact zswap preimage (C9) — i.e. the note is *plausible*, bound to my key in-circuit via
  `derivePublicKey`-equivalent (`zswap.compact:74-80`);
- claimed balance delta = sum of added minus spent note values (arithmetic in-circuit);
- spent notes' nullifiers derive correctly from `sk` (C9's `"midnight:zswap-cn[v1]"` preimage).

What it still **cannot** prove: that those notes exist on chain (N1 — client-side §5.3 covers
presence at restore), and above all **completeness** (that the wallet didn't omit a note it
received). Since omission is precisely the interesting failure of a corrupt scanner, §6.2
upgrades the trust statement only from "wallet honest at attest time" to "wallet honest at
attest time, and its state evolution is hash-chained and shape-correct". Real but modest —
priced at a substantially bigger circuit (K × several SHA-256 preimages ≈ K zswap-spends of
proving work) and a canonical in-circuit note encoding.

**Verdict: defer.** Design the V1/V2 record shape so §6.2 can be added later (include
`prevCommitment` in `AttestRecord` from day one — it costs 32 bytes and buys the hash-chain
now, §6.2's substrate later).

---

## 7. Privacy analysis (all variants)

What the chain learns per attestation: `(id, commitment, height, seq, timestamp)`.

- `id` is a domain-separated hash of a dedicated key (C8-style) — unlinkable to the wallet's
  zswap public key or addresses (different preimage domains; `"midnight:zswap-pk[v1]"` vs ours).
- `commitment` is *hiding* (C3): observers cannot brute-force even a guessable snapshot (the
  salt is secret-derived). This is why we commit rather than post `manifestHash` bare — a bare
  hash would let a hosted UmbraDB *confirm* which tenant owns which pseudonym by hashing blobs
  it stores (correlation A3-adjacent). With the commitment, the hosted DB stores bytes it cannot
  link to any pseudonym. Neat inversion: the DB holds the data but can't identify it; the chain
  identifies the data but can't read it.
- Residual leakage: pseudonym *linkability across its own attestations* (same `id` each time —
  deliberate, it IS the pointer), so cadence/timing/height-progression of one pseudonymous
  wallet is visible, plus membership in the "uses UmbraDB attestation" set. Mitigations if ever
  needed: randomized cadence; epoch-rotated ids (`id_e = H(sep‖sk‖epoch)` — old entries retired
  by the key holder in the same tx); both re-derivable from the seed. Not worth the complexity
  for v1 — flag as a knob.

---

## 8. Comparison and recommendation

| | V0 local sig (strawman) | **V1 pointer** | **V1b +history** | **V2 Merkle root** | V3-lite | V3-full |
|---|---|---|---|---|---|---|
| A1 substitution | dead | dead | dead | dead | dead | dead |
| A2 rollback | **alive** (DB serves old signed pair) | dead* | dead* (+ verifiable intentional PIT restore) | dead* | dead* | dead* |
| A3 cross-wallet | dead | dead | dead | dead | dead | dead |
| A4 forgery | dead | dead | dead | dead | dead | dead |
| A5 stale view | n/a (no chain) | multi-endpoint / local node | same | same | same | same |
| Attest-time honesty needed | yes | yes | yes | yes (shrunk by §5.3 restore cross-check) | mostly (omission uncaught) | no |
| Partial verify / selective disclosure | no | no | history proofs | **yes** | yes | yes |
| Compact feasibility | n/a | **high** (sub-zswap circuit) | high | high | medium (big circuit) | **infeasible (N1,N2)** |
| Extra cost over V1 | — | baseline: 1 small tx/cadence, DUST | +1 tree insert | off-circuit hashing + canonical encoding spec | K× zswap-spend proving | — |

\* dead up to A5, which is a light-client freshness question, not an attestation question.

**Recommendation: V1b + V2 combined — "Attested Manifest Root, latest-pointer semantics with
on-chain history"** — with the `AttestRecord` carrying `prevCommitment` from day one to keep
§6.2 open. Why this point in the space:

1. Every construct is verified-available in Compact **today** (C1-C11); the circuit is smaller
   than a zswap spend. No fantasy capabilities.
2. It kills the entire DB-adversary threat class (A1-A4) with *one small contract*, and turns
   the only survivor (A5) into a standard light-client question shared by every chain client.
3. The transcript-model CAS (C7) means rollback protection is not bolted on — replayed or
   racing attestations fail *structurally*. That is the clever-but-sound core: we get
   compare-and-swap semantics from Midnight's execution model for free.
4. The Merkle root + hiding commitment gives remote-UmbraDB a coherent story: the host can
   neither forge, nor roll back, nor even *identify* whose snapshot it holds; partial
   verification works over the wire.
5. It degrades gracefully: verification failure never bricks a wallet — restore falls back to
   replay, which remains the ground truth. The attestation only ever *removes* the need for
   replay, never replaces its authority.

---

## 9. Open questions (honest list, for the design council)

1. **Restore-time freshness (A5).** Multi-endpoint `contractAction` queries raise the collusion
   bar but are not a proof of tip. Do we require a configurable "k-of-n endpoints agree"
   policy? Is there / will there be a Midnight light-client header-verification path a wallet
   can embed? This is the weakest link of the whole design and it is *not* fixable inside the
   contract.
2. **Concurrency & multi-device.** Two devices attesting from one seed race on the CAS; the
   loser's tx fails (C7). Fail-and-retry is probably correct (single-writer matches UmbraDB's
   lease model), but do we want per-device pseudonyms with a reconciliation rule instead?
   Interacts with the lease: does "holds the UmbraDB writer lease" gate "may attest"?
3. **Is trust-transport enough?** The council must explicitly accept the §1 framing: we defend
   against a hostile *DB*, not a wallet compromised *at attest time*. If the latter enters the
   threat model, the answer is §6-full, which is infeasible — so it must be ruled a non-goal in
   writing, or the feature overclaims.
4. **Contract governance.** A shared attest contract has a maintenance authority
   (https://docs.midnight.network/guides/making-decision-on-contract-updatability). An upgraded
   contract could subvert semantics future attestations rely on. Deploy immutable? Pin the
   verifier key / contract version in the SDK config?
5. **Compile-check the sketch.** `persistentCommit` disclosure treatment with witness-derived
   salt; ternary/`member`+`lookup` transcript shape; `Uint<64>`→`Bytes<32>` cast ergonomics;
   actual DUST cost of the call on testnet-02. Half a day with `compactc` answers all four.
6. **Canonical snapshot encoding.** V2 needs a stable, versioned, canonical serialization of
   snapshot sections (and §6.2 would need it in-circuit-representable). The SDK's serialized
   form is currently a branded JSON string (`WalletState.ts:17`) — JSON canonicalization is a
   known swamp; do we freeze a versioned CBOR/CDDL section encoding at the UmbraDB boundary?
7. **Attestation key derivation path.** Which HD path (purpose'/coin'/account'/...) for
   `sk_attest`; interaction with the SDK's `hd` package and with future key-rotation.

## 10. Source index

- Compact language reference (witnesses, disclosure, for-bounds, casts):
  https://docs.midnight.network/compact/reference/compact-reference
- Explicit disclosure: https://docs.midnight.network/compact/reference/explicit-disclosure
- Std-lib exports (persistentHash/Commit=SHA-256, merkleTreePathRoot, ownPublicKey, blockTime*):
  https://docs.midnight.network/compact/standard-library/exports
- Ledger ADTs incl. Kernel (no height read), Map, MerkleTree≤32, HistoricMerkleTree, TS-side
  root()/pathForLeaf(): https://docs.midnight.network/compact/reference/ledger-adt
- Transcript/CAS execution model:
  https://docs.midnight.network/concepts/how-midnight-works/smart-contracts
- bboard identity pattern: https://docs.midnight.network/tutorials/bboard/smart-contract
- Zswap preimages & tree: `~/repos/midnight-ledger/zswap/zswap.compact` (lines 17-80);
  `~/repos/midnight-ledger/base-crypto/src/hash.rs:93` (persistent_hash = SHA-256)
- Indexer contract-state query: `~/repos/midnight-indexer/indexer-api/graphql/schema-v4.graphql:1266`
- Wallet SDK seam: `~/repos/midnight-wallet/packages/abstractions/src/WalletState.ts:17`,
  `packages/shielded-wallet/src/ShieldedWallet.ts:110`, `packages/dust-wallet/src/DustWallet.ts:238`
- UmbraDB anchor object: `~/repos/UmbraDB/src/interfaces/checkpoint-store.ts:7,32,40-43`
- DUST/fees: https://docs.midnight.network/concepts/dust-architecture,
  https://docs.midnight.network/guides/generating-dust-programmatically
