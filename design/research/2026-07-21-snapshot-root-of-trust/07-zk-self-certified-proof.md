# 07 — A lightweight, self-certified ZK proof for a finalized wallet-state snapshot

**Date:** 2026-07-21
**Angle:** Instead of an *on-chain* attestation (brief 05) or a *replay* on restore, have the
wallet — which after a full sync already holds the whole witness (commitment tree, its notes,
the viewing keys) — emit a **succinct, offline, self-certified ZK proof** that the persisted
snapshot is the correct wallet state *as of a finalized block N*. On memory loss the wallet
restores the snapshot and **verifies the proof** rather than re-scanning `[birthday, N]`.
**Status:** Design + feasibility study. No source modified, nothing committed. Everything is
grounded in the local clones (`~/repos/midnight-ledger`, `-node`, `-wallet`) and Midnight docs;
circuit sketches are illustrations, flagged as such. All `repo/path:line` citations are as read
2026-07-21.

> **Read-order note.** This brief continues 01 (state commitments / the on-chain anchor `R_N`),
> 03 (authenticated-snapshot integrity; the inclusion-vs-completeness gap), and 05 (the Compact
> on-chain attestation and *why* proof-of-correct-scan is infeasible **in Compact**). It composes
> with **06 (ADS-bounded-scan)**, which I have read: 06 shows that shielded **commitment**-range
> completeness is *already* authenticated by Midnight's own tree (the collapsed-update bridge +
> on-chain root, 06 §2.1), and — decisively for §3 below — that **ciphertext delivery** is *not*
> on-tree and remains an open residual (06 §2.4). §3 is reconciled against the real 06.

---

## 0. The statement, reframed to what is actually tractable

The naïve statement "prove my wallet state is correct *now*" is infeasible for the reasons
brief 05 §6 nailed: an in-circuit scan of an unbounded, ever-moving chain tip. The tractable
statement narrows this on **two** axes at once — a **frozen horizon** and a **self-certification**:

> **Statement (frozen finalized checkpoint).** *"I, the holder of viewing key `vk`, certify that
> snapshot artifact `S` encodes the complete set of my notes/UTXOs as of **finalized** block `N`,
> consistent with the on-chain zswap commitment-tree root `R_N` that is public at `N`."*

Two structural facts make this permanent and cheap where "prove current state" is neither:

1. **Finality freezes history.** Midnight is Substrate-based with **GRANDPA** finality; the node
   exposes `chain_getFinalizedHead` and `grandpa_proveFinality`
   (`~/repos/midnight-node/node/src/openrpc.rs:76,97,467,486`). A block `N` that GRANDPA has
   finalized is never reverted, so the *entire prefix* `[genesis, N]` — and therefore `R_N` and
   the correct note-set at `N` — is **immutable**. A proof anchored to finalized `N` is valid
   **permanently for horizon `N`**; it never expires. Contrast a spend anchor, whose validity is
   a rolling 1-hour `global_ttl` window (brief 01 §2) — that TTL is a *spendability* window, not a
   *verifiability* window, and does not apply here.

2. **The proof does not need to reach the tip.** On restore the client (a) verifies the proof →
   "`S` correct & complete as of `N`", then (b) catches up `[N, tip]` **live** via the normal
   incremental sync + the ADS (06). The tail is out of the proof's scope. The proof's *whole job*
   is to eliminate re-replay of `[birthday, N]`, not to be current.

So each proof is a **cryptographically-certified checkpoint** — a *proven* wallet birthday.
This is strictly stronger than Zcash's birthday heuristic (brief 02), which is *trusted*
("scan from this height, we promise nothing is earlier"): here the floor is *proven*. Regenerate
at a newer finalized `N` whenever you want the live catch-up short; each proof is independently,
permanently valid for its own horizon.

**Public inputs** (what a verifier is handed): `hash(S)`, `R_N`, `N` (bound to the finalized
block hash), and optionally an unlinkable wallet pseudonym `id`.
**Private witness** (never revealed): `vk` (and the coin secret key), the note set, the Merkle
paths, salts.

There are two strengths of this statement, and the gap between them is the whole feasibility
story (§2 vs §3):

- **v-lightweight — inclusion + binding + key-knowledge.** Proves every note `S` claims is
  genuinely mine and genuinely in the tree at `R_N`. Size ∝ **#notes I own** (small). *Does not*
  prove I was shown all my notes (the completeness gap).
- **v-strong — ADS-backed completeness.** Additionally proves `S` is *exactly* the `vk`-decryptable
  subset of the ADS-authenticated leaf range → closes omission. Size ∝ **#leaves processed** in
  the frozen prefix (large).

---

## 1. Grounding: Midnight's real proving stack (what a third party can actually author, prove, verify)

Everything below is read from the local clones; nothing about the ZK capability is invented.

### 1.1 The proof system is Halo2/PLONKish + KZG over BLS12-381 — and it is on crates.io

`transient-crypto` builds proofs with the `midnight-proofs` crate (a Halo2 derivative), the
`midnight-zk-stdlib` gadget/relation layer, and `midnight-circuits` gadgets, committing with
**KZG over `Bls12`** (BLS12-381):

- `~/repos/midnight-ledger/transient-crypto/src/proofs.rs:18-26` imports
  `midnight_curves::Bls12`, `midnight_proofs::poly::kzg::params::{ParamsKZG, ParamsVerifierKZG}`,
  and `midnight_zk_stdlib::{MidnightCircuit, MidnightPK, MidnightVK, Relation}`.
- `proofs.rs:80` — `pub struct ParamsProver(pub Arc<ParamsKZG<Bls12>>)`: the prover SRS is a KZG
  structured reference string over BLS12-381 (the `midnight-trusted-setup` output; fetched per
  degree via the proof-server `/fetch-params/{k}`, `proof-server/src/endpoints.rs:79-88`).
- Outer curve (the circuit field): `transient-crypto/src/curve.rs:49-58` — base `midnight_curves::Fp`,
  **scalar `Fq` (the in-circuit field `Fr`)**, points `G1Affine`. There is also an **embedded
  curve** (a Jubjub-analogue over `Fq`) used for encryption / Pedersen commitments / key derivation.

**Decisive fact for "buildable by a third party":** these are **published crates**, not vendored
internals. `~/repos/midnight-ledger/Cargo.lock` resolves them from
`registry+https://github.com/rust-lang/crates.io-index`:
`midnight-circuits 6.1.0`, `midnight-proofs 0.7.1`, `midnight-zk-stdlib 1.1.0`,
`midnight-curves 0.2.0` (lock lines 2834-2837, 2876-2879, 3121-3124, 3290-3293); the IR crates
are `midnight-zkir 2.1.0` and `midnight-zkir-v3 3.0.0-rc.1`
(`zkir/Cargo.toml:2-3`, `zkir-v3/Cargo.toml:2-3`); the wrapping crate is
`midnight-transient-crypto 1.0.0`. **A third party can depend on the exact prover/verifier the
wallet uses**, directly from crates.io.

### 1.2 Two hashes: SHA-256 for durable commitments, Poseidon for in-circuit work

- **`persistentHash` / `persistentCommit` = SHA-256** (`base-crypto`, brief 05 C3). Durable,
  upgrade-stable; **expensive in-circuit** (a full SHA-256 block is thousands of PLONK rows).
- **`transient_hash` = Poseidon** over the outer scalar field —
  `transient-crypto/src/hash.rs:78-84` calls `PoseidonChip::hash`. This is the SNARK-friendly hash;
  **cheap in-circuit** (tens of rows). `transient_commit` (`hash.rs:86-90`) is the Poseidon
  hiding-commitment.

The zswap **commitment tree is a deliberate hybrid** that exploits this split
(`transient-crypto/src/merkle_tree.rs`):
- **leaf** = `persistent_hash` (SHA-256), `merkle_tree.rs:194-198`;
- **internal nodes** combine with `transient_hash` (Poseidon), `merkle_tree.rs:205-210`
  (`transient_hash(&[acc, sibling])` / `transient_hash(&[sibling, acc])` by side, after
  `degrade_to_transient` of the leaf).

So an **in-circuit depth-32 Merkle path is ~32 Poseidon compressions** (cheap) plus, if you
recompute the leaf, one SHA-256 (the costly part). This is exactly why real zswap spends verify
inclusion in-circuit at reasonable cost, and it directly bounds our circuit cost (§2.3).
`ZSWAP_TREE_HEIGHT = 32` (`zswap/src/lib.rs:23`).

### 1.3 The zswap preimages are public and re-derivable in-circuit

From `~/repos/midnight-ledger/zswap/zswap.compact` (the real spend/output circuit):
- **coin commitment** `c = persistentHash<CoinPreimage>{sep:"midnight:zswap-cc[v1]", info, dataType, data: pk.bytes}` (`zswap.compact:44-50`) — SHA-256;
- **nullifier** `nul = persistentHash{sep:"midnight:zswap-cn[v1]", …, data: sk.bytes}` (`:52-59`) — SHA-256, from the secret key;
- **spend public key** `pk = persistentHash<PublicKeyPreimage>{sep:"midnight:zswap-pk[v1]", secretKey}` (`:74-82`) — SHA-256;
- **inclusion** `merkleTree.checkRoot(merkleTreePathRootNoLeafHash<32>(path))` (`:41`) — the Poseidon path root;
- **value commitment** = Pedersen on the embedded curve: `hashToCurve([color,segment])` base,
  `ecMulGenerator(rc)` blinding, `ecMul(colorBase, value)` (`:66-69`).

A circuit of ours can recompute all of these *bit-identically* — the formats are public code.

### 1.4 Note encryption is SNARK-friendly — the single most consequential finding for completeness

`transient-crypto/src/encryption.rs:14-21` documents the scheme, and the surprise is that it is
**entirely built from in-circuit-cheap primitives**:

> El-Gamal on the **embedded curve** to establish `K* = g^{xy}`; derive a symmetric key
> `K = transient_hash(K*.x, K*.y)` (Poseidon); encrypt the message as a **Poseidon-CTR stream**,
> substituting **field addition for XOR** (no IV, since `K` is ephemeral).

`decrypt` (`encryption.rs:194-217`): `k_star = c · sk` (embedded scalar-mul), `k =
transient_hash([k_star.x, k_star.y])`, `plain[i] = ciph[i] − transient_hash([k, i])`, then the
**tag check** `plain[0] == 0` decides "is this mine?". The ciphertext is
`{ c: EmbeddedGroupAffine, ciph: Vec<Fr> }` (`encryption.rs:100-104`); a `ShieldedCoinInfo` is a
few field elements, so `ciph` is ~5 elements.

**Consequence:** an in-circuit *trial-decryption* of one note costs ≈ **one embedded-curve
scalar-mul + ~5 Poseidon hashes + one equality gate** — no AES, no non-friendly AEAD. This is
what makes the completeness circuit *expressible at all* (Zcash-style AEAD would not be); it is
still ∝ #leaves (§3), but the per-leaf constant is small. The shielded wallet derives this key at
`zswap/src/keys.rs:68` (`derive_encryption_secret_key`) and trial-decrypts off-circuit at
`zswap/src/local.rs:189` (`secret_keys.try_decrypt(ciph)`) — the exact computation the circuit
would witness.

### 1.5 How a circuit is authored, proved, and verified — the zkir VM

The prover proves a **universal circuit — an in-circuit VM — parameterized by an IR program**:

- `Zkir` is `Relation + Deserializable` (`proofs.rs:150-210`); `MidnightCircuit::from_relation(ir)`
  turns an IR into a Halo2 circuit, `k = from_relation(self).min_k()` (`proofs.rs:183`).
- **The IR is a plain, serializable data structure** you can build by hand:
  `IrSource { inputs, do_communications_commitment, instructions: Arc<Vec<Instruction>> }`
  (`zkir-v3/src/ir.rs:34-45`). `Operand` is `Variable(Identifier) | Immediate(Fr)` (`:100`).
- **Instruction set** (`zkir-v3/src/ir.rs:282-560`) — a complete circuit-authoring ISA:
  `Add/Mul/Neg/Not` (field arithmetic; `Add` also on `JubjubPoint`), `LessThan{bits}`,
  `TestEq`, `Assert`, `ConstrainEq`, `ConstrainBits`, `ConstrainToBoolean`, `CondSelect`,
  `DivModPowerOfTwo`, `EcMul`, `EcMulGenerator`, `HashToCurve` (embedded curve),
  **`TransientHash` (Poseidon, arbitrary arity)**, **`PersistentHash` (SHA-256, 2-field output)**,
  `PublicInput`/`PrivateInput` (guarded transcript reads), `Output` (adds to the communications
  commitment). Merkle-path verification is *not* a primitive — you build it from `TransientHash` +
  `CondSelect` + `ConstrainEq`, exactly as zswap does.
- **Keygen is deterministic from the IR:** `IrSource::keygen` → `setup_pk/setup_vk`
  (`proofs.rs:196-214`) using the KZG SRS for `k`. **Prove:** `ir.prove(rng, params, pk, preimage)`
  → `midnight_zk_stdlib::prove` (`zkir-v3/src/ir.rs:58-76`). **Verify:** `VerifierKey::verify(params,
  proof, statement)` → `midnight_zk_stdlib::verify::<DummyRelation,…>` (`proofs.rs:545-558`).

Two facts that answer the coordinator's core questions:

- **The running proof-server proves *arbitrary caller-supplied* IR, not only Compact circuits.**
  `/prove` accepts `(ProofPreimageVersioned, Option<ProvingKeyMaterial>, Option<Fr>)`
  (`endpoints.rs:245-320`); `ProvingKeyMaterial { prover_key, verifier_key, ir_source }`
  (`proofs.rs:646-660`). If the caller supplies the material it is used verbatim; only if `None`
  does it resolve a *built-in* zswap/dust key by `key_location`. `/check` likewise takes an
  optional `WrappedIr` (`endpoints.rs:175-240`). **So a hand-written zkir circuit + self-generated
  keys is proven by the same proof-server binary we built and run on `:6300`** — no fork required.
- **Verification is standalone, off-chain, contract-free.** `VerifierKey::verify` needs only
  *(verifier params, verifier key, public inputs, proof)* and internally uses a `DummyRelation` —
  it does **not** need the IR. Verifier params for `k ≤ 14` are embedded in the binary
  (`static/bls_midnight_2p14`, `proofs.rs:120`, `VERIFIER_MAX_DEGREE = 14` at `:104`); larger `k`
  (up to 25, `endpoints.rs:82`) fetch params on demand. **This is precisely the "client-side
  verification, not on-chain" the offline proof wants** — the restore path calls `verify` with the
  wallet-pinned `vk` and the three public inputs.

**Verdict on the authoring paths the coordinator asked about:**

| Path | Author with | Prover | Verifier | Assessment |
|---|---|---|---|---|
| **(a) raw zkir** | build an `IrSource` in Rust (or emit its serialized form) | the **existing proof-server** (`/prove` with supplied `ProvingKeyMaterial`) or in-proc `ProofPreimage::prove` | `VerifierKey::verify` (standalone) | **Lowest friction. Reuses the running stack end-to-end.** Recommended. |
| **(b) midnight-zk Halo2 gadgets** | implement a custom `Relation` on `midnight-circuits`/`-zk-stdlib` (Poseidon/ECC/SHA-256 chips) | your own binary (proof-server only knows how to turn *zkir* into a `MidnightCircuit`) | `VerifierKey::verify`, still compatible | More expressive / tighter layout; you run your own prover. Use only if the IR ISA is too coarse. |
| **(c) standalone (arkworks/plonky/other halo2)** | off-Midnight framework | your own | your own | You must re-implement Midnight's SHA-256 preimages, Poseidon params, embedded curve to bind to `R_N`. Highest effort + audit surface, no reuse. Not recommended. |

The honest answer to "can a third party hand-write a circuit for Midnight's prover?" is **yes, via
path (a), today** — the IR is a public, serializable ISA, keygen is public, the proof-server proves
supplied IR, and the verifier is a standalone library call. What is *not* provided is a
**human-ergonomic authoring front-end** (Compact is that front-end, and it deliberately forbids the
very things we need — global-state access, unbounded loops; brief 05 N1/N2). Authoring at the IR
level is assembly-level and, crucially, **carries no compiler-provided correctness attestation**
(§4, §6).

---

## 2. The v-lightweight self-certification circuit (buildable today)

### 2.1 Exact statement

For the private note-set `{ (info_i, index_i, path_i) }_{i<m}` and coin secret key `sk`
(with encryption secret key `esk` derived per `keys.rs:68`):

1. **Snapshot binding.** `hash(S)` (public) equals the canonical digest of the witnessed note-set:
   `assert  hash(S) == TransientHash(canonical_encode({info_i, index_i}))`. (Poseidon over the
   sections; ties the proof to the exact bytes UmbraDB persisted. A stable canonical section
   encoding is required — the same one brief 05 §5 and brief 05 Q6 call for.)
2. **Ownership (per note, SNARK-cheap path).** Bind each note to *my* key via the **encryption
   relation**, not the SHA-256 spend path: witness the note's on-chain ciphertext `(c_i, ciph_i)`;
   compute `k*_i = c_i · esk` (`EcMul`), `k_i = TransientHash(k*_i.x, k*_i.y)`, and
   `assert plain_i[0] == 0` where `plain_i[t] = ciph_i[t] − TransientHash(k_i, t)` — i.e. *this note
   decrypts to me*. Bind `esk` to a single public `enc_pk = esk·G` (`EcMulGenerator`) so all notes
   share one key-knowledge proof.
3. **Chain membership (per note).** Recompute the coin commitment
   `c^{cc}_i = PersistentHash("midnight:zswap-cc[v1]", info_i, pk)` (one SHA-256; `pk` derived once
   via `zswap-pk[v1]`), then `assert  merkle_path_root(path_i, c^{cc}_i) == R_N` — the Poseidon
   path (≤32 `TransientHash`) against the **public** on-chain root `R_N`.
4. **Freshness / horizon.** `R_N` and `N` are public inputs, bound at restore to the **finalized**
   block hash (§0, §5). The circuit does not read `N` from chain (it cannot — brief 05 C6/N1); the
   *client* checks `R_N`/`N` against the finalized head.
5. **Pseudonym (optional, unlinkable).** Public `id = TransientHash("umbra:07:id", sk)` — a
   domain-separated key-bound handle; lets the same wallet's checkpoints be recognized *by the
   holder* without revealing `sk` or linking to zswap addresses (brief 05 §7 ethos).

### 2.2 What it proves — and its honest limit

Proves: every note in `S` is (a) exactly encoded by `hash(S)`, (b) genuinely **addressed to my
viewing key** (decrypts), and (c) genuinely **present on-chain at finalized `N`** (`R_N`), all
without revealing `vk`, `sk`, *which* leaves are mine, or the note contents. It is **offline**
(no tx; contrast brief 05's on-chain attestation), **non-forgeable** (forgery needs `sk`/`esk`),
and **unlinkable** (hiding; the only public key-bound value is the opt-in `id`).

**Limit — this is inclusion, not completeness.** Like brief 03 §3(a) / §6, it cannot prove `S`
contains *all* my notes; a corrupt writer could emit a proof over a *subset* (hiding funds — an
under-count, not a theft). Completeness needs §3. **For the frozen-checkpoint use, v-lightweight is
nonetheless the right default**, because the omission risk is bounded by the *same* attest-time /
scan-time honesty premise UmbraDB already lives under for its self-produced snapshots (brief 05
§1), and the certificate additionally kills fabrication, cross-wallet swap, and stale-base attacks.

### 2.3 Size / prove / verify

Per-note in-circuit cost, from §1.2–1.4 (order-of-magnitude PLONK rows; *run
`midnight_proofs::dev::cost_model::CircuitModel`, imported at `zkir-v3/src/ir.rs:16`, for exact
counts*):

| Component | Primitive | ~rows/note |
|---|---|---|
| coin-commitment recompute | 1× SHA-256 (`PersistentHash`) | ~2,000 |
| Merkle inclusion (depth 32) | 32× Poseidon (`TransientHash`) | ~1,600 |
| ownership decrypt | 1× `EcMul` + ~5 Poseidon | ~2,000 |
| bookkeeping (eq/select/encode) | field ops | ~few hundred |
| **per note** | | **~6,000** |
| key-knowledge (once) + snapshot digest | `EcMulGenerator` + Poseidon | ~few thousand |

For a realistic wallet of `m ≈ 50–200` notes: ~0.3–1.2M rows → **`k ≈ 19–21`** (single proof,
well under the `k ≤ 25` ceiling, `endpoints.rs:82`). **Prove time:** seconds to a few minutes on
the proof server (comparable to a batch of `m` zswap spends, since a spend is the same
SHA-256+path+EC shape, `zswap.compact:34-70`), off the hot path. **Proof size:** small and
essentially witness-independent — Halo2/KZG proofs are single-digit KB (the "≈128-byte" figure in
Midnight marketing / brief 03 is optimistic for this backend, but the load-bearing properties hold:
compact and constant-ish). **Verify:** `VerifierKey::verify`, **milliseconds, independent of `m`**,
using the embedded `k ≤ 14` verifier params only for small circuits — for `k ≈ 20` the restore
client fetches the verifier params once (or the wallet ships them). **Verdict: buildable today via
path (a).** No new capability is required — only engineering (write + audit the IR, generate keys
from the public SRS, pin the `vk`).

**Optimization:** the SHA-256 coin-commitment recompute dominates. If completeness is not required,
you can *drop* step 3's SHA-256 and instead witness `c^{cc}_i` directly and prove only Poseidon
inclusion + ownership — but then you no longer bind `info_i` (value) to the on-chain leaf, weakening
"correct balance." Keep the SHA-256 for a value-sound certificate.

---

## 3. The v-strong ADS-backed completeness circuit (expressible, heavy, chunked)

### 3.1 What brief 06 actually authenticates — and the hole it leaves

Reconciling with the real brief 06 changes the picture in two ways, one helpful and one damaging.

**Helpful — the range root is `R_N` itself; there is no separate ADS root to invent.** 06 §2.1
shows the zswap tree is a fixed-height-32 append-only tree over *contiguous* indices, and the
`MerkleTreeCollapsedUpdate` bridge (`transient-crypto/src/merkle_tree.rs:302-405`;
`zswapMerkleTreeCollapsedUpdate`, `schema-v4.graphql:1258`) authenticates any leaf range in
**O(log) ≤ 32 hashes**. By the RFC 6962 "fix size + root ⇒ leaf multiset determined" argument
(06 §1a, §2.1), the on-chain root `R_N` at end-index `E_N` **already pins the complete set of
commitments** `[0, E_N)` — no commitment can be omitted, inserted, or reordered without `R_N`
diverging. So the circuit does not need a new `A_N`: its witness is the collapsed-range bridge to
the *same public `R_N`*, and "no gaps in the leaf range" comes for free from fixed-size-plus-root.
This is exactly the capability a Compact contract lacks (brief 05 N1), and a hand-written circuit
consuming `R_N` + the bridge is what makes completeness *expressible*.

**Damaging — the ciphertexts are off-tree, so `R_N` does not authenticate what the circuit must
decrypt (06 §2.4).** The leaf is the bare commitment; the note **ciphertext** `(c_j, ciph_j)` lives
in the transaction body (`zswap/src/structure.rs:307`, `Output.ciphertext: Option<…>`), committed
only by the block's Substrate `extrinsicsRoot` — which the indexer does **not** surface to wallets
(06 §2.4; brief 01 §6 gap 1). This is fatal to the "not-mine" branch of a completeness proof
(§3.2): to prove leaf `j` is *not* mine, the circuit must decrypt *its* authentic ciphertext, but
nothing on-tree binds `ciph_j` to leaf `j`. A witness supplier can hand the circuit a **garbage
ciphertext** for a leaf that is genuinely mine; it "fails to decrypt," and the circuit soundly —
but wrongly — certifies "not mine." **`R_N` alone cannot make the completeness proof sound.** Closing
this needs an authenticated commitment↔ciphertext binding that does not exist today: 06 §2.4's
options — a Substrate body-inclusion proof, or a new per-block **ciphertext accumulator** committed
in the header. This is a **node/protocol change**, not a circuit-authoring problem.

### 3.2 Statement and construction

> *"`S` is exactly the `esk`-decryptable subset of the ADS-authenticated leaf range `[0, E_N)`
> committed by `A_N`, and its every member is on-chain at `R_N`."*

For **every** leaf `j` in the authenticated range, in-circuit:
`k*_j = c_j · esk`; `k_j = TransientHash(k*_j.x,k*_j.y)`; `plain_j = ciph_j ⊖ Poseidon-CTR(k_j)`;
`mine_j = (c_j ≠ identity) ∧ (plain_j[0] == 0)` (the exact `decrypt` predicate, including the
`is_identity` exclusion at `encryption.rs:200-204`). Then:
- if `mine_j` → the note is in `S` (accumulate into the running snapshot digest),
- if `¬mine_j` → it is correctly excluded,
- and the collapsed-range bridge to `R_N` proves the range is complete with no skipped commitment `j`.

Because *every committed leaf* is processed, **commitment-level omission is impossible** — this
closes the part of the gap that inclusion proofs (§2, brief 03 §6) structurally cannot. **But the
`¬mine_j` branch is only sound if `ciph_j` is the authentic ciphertext for leaf `j`** — and per
§3.1 nothing on-tree guarantees that. So this circuit delivers *true* completeness **only** given an
authenticated ciphertext↔commitment binding (06 §2.4's body-proof or ciphertext-accumulator, a node
change). Absent it, the proof certifies "`S` is exactly the decryptable subset **of the ciphertext
set I was given**" — which pushes completeness back onto trusting delivery, exactly brief 06's
residual, now inside the circuit rather than removed by it.

### 3.3 The size line — where "lightweight" breaks

Per-leaf cost is dominated by **one embedded-curve scalar-mul + ~5 Poseidon** (§1.4), i.e.
~2,000 rows/leaf — *cheap per leaf, but paid for every leaf, including the ~99.99% that are not
mine* (that is the definition of completeness). The ceiling on a single proof is `k = 25`
(`endpoints.rs:82`) ≈ 33M rows ≈ **~16k leaves per proof**. Concretely:

- A frozen prefix with `E_N` outputs needs ≈ `E_N / 16,000` proofs of `k=25` (or more,
  smaller proofs). For a mature chain with millions of outputs this is **thousands of proofs** —
  the same wall brief 05 §6 hit, now *expressible* but not *succinct*.
- **There is no recursion/IVC in the IR VM.** The `Instruction` set (§1.5) has no "verify a proof
  in-circuit" op, so the chunks **cannot be folded into one `O(1)` proof by the zkir path.** The
  fold must be done by **chaining accumulator statements**: chunk `t` takes the prior running
  digest as a public input and emits the next; the restore client verifies *all* chunk proofs and
  checks the accumulator chain. Total verify work is then ∝ #chunks (still ms each, but linear in
  prefix size), and total prove work is ∝ `E_N`.

**So the honest size verdict:** v-strong is **∝ #leaves in the frozen prefix**, not #notes owned —
it is *not* lightweight, and cannot be made lightweight on today's zkir path. What the ADS +
SNARK-friendly decryption buy is a **change of kind**: from "inexpressible in Compact" (brief 05
§6) to "expressible and chunkable in a hand-written circuit, at a cost linear in the prefix." That
linear cost is the true completeness tax; the interesting engineering question (§7) is whether
`midnight-proofs`' underlying Halo2 accumulation can fold the chunks — path (b) territory, not
zkir.

**Two distinct walls, and the deeper one is not about ZK.** v-strong is blocked by (i) a
**succinctness** wall — ∝#leaves cost with no IVC to fold it (an efficiency question, §7 Q1); and
(ii) a **soundness** wall — the ciphertext↔commitment binding is not authenticated on-chain (§3.1,
§3.2), so no amount of proving power yields *true* completeness without a node/protocol change (§7
Q2). Wall (ii) is the fundamental one: the ZK proof cannot manufacture a completeness guarantee the
chain does not already authenticate. This is the honest limit — and it is the *same* wall brief 06
hits for ciphertext delivery, not a new one the circuit introduces or removes.

---

## 4. Honest verdict: buildable today vs. needs new tooling

| Capability | Status | What it rests on |
|---|---|---|
| **Hand-write a circuit for Midnight's prover (path a)** | **YES, today** | zkir `IrSource` is a public serializable ISA; keygen public; proof-server proves supplied IR (`endpoints.rs:245-320`). |
| **Prove it on the running proof-server (`:6300`)** | **YES, today** | `/prove` accepts caller `ProvingKeyMaterial` (`proofs.rs:646-660`). |
| **Verify off-chain, client-side, no contract** | **YES, today** | `VerifierKey::verify` standalone (`proofs.rs:545-558`); embedded/fetchable KZG verifier params. |
| **All primitives the circuit needs** | **YES, today** | SHA-256 + Poseidon + embedded-curve EC + Merkle-from-Poseidon + range/eq/select, all IR ops (§1.5); SNARK-friendly decryption (§1.4). |
| **v-lightweight certificate (inclusion+binding+ownership)** | **BUILDABLE (engineering only)** | above; size ∝ #owned notes; `k≈20`; verify ms. |
| **v-strong completeness — *sound*** | **BLOCKED (needs node change)** | ciphertext↔commitment binding is not on-chain (§3.1/§3.2, 06 §2.4) → no true completeness without a Substrate body-proof or header ciphertext-accumulator. Not a ZK problem. |
| **v-strong completeness — *succinct* (given soundness)** | **NOT today** | ∝`E_N` cost with no IVC in the zkir VM → a linear batch of chunk proofs, not one `O(1)` proof. |
| **Human-ergonomic authoring front-end for such circuits** | **NOT today** | Compact is the only front-end and forbids the needed ops (brief 05 N1/N2); IR-level authoring is assembly-grade + unaudited-by-compiler. |

**What v-strong *would* need, in priority order:** (1) an **authenticated ciphertext delivery**
primitive (06 §2.4 option 2/3 — the soundness blocker; a node/protocol change; without it the
proof certifies completeness only relative to an untrusted ciphertext set); (2) a
**recursion/aggregation** layer over `midnight-proofs` (Halo2 supports accumulation; whether
`midnight-zk-stdlib` exposes an in-circuit verifier gadget is open, §7) to fold the ∝`E_N` chunks
into `O(1)`; both are stack/protocol gaps, not "author the IR" gaps. The lightweight certificate
needs neither.

---

## 5. Composition: when the offline ZK proof vs. the on-chain attestation

The four artifacts stack — each removes a different attack, and they share the *same* on-chain
anchor `R_N`:

- **Anchor (01/03):** `R_N` + finalized `N` from the wallet's own trusted chain view — the root of
  trust every option reduces to. The ZK proof's job is to bind `hash(S)` to `R_N` *cryptographically
  and privately*.
- **ADS (06):** authenticates the frozen prefix's **commitment** range for *free* (fixed-size +
  `R_N`, no ZK needed — 06 §2.1). This is what a Compact contract cannot reach in-circuit (brief 05
  N1) and what a hand-written circuit consumes to reason about completeness. **But note the
  leverage:** 06's commitment-completeness is already a cheap *non-ZK* check (download the O(log)
  bridge, rehash, compare to `R_N`). So for the wallet's **own** restore, "ADS + locally
  re-trial-decrypt the range" (06 §5.1) is the pragmatic completeness path, and the v-strong ZK
  circuit is *worth its ∝#leaves cost only when you must prove completeness to a **third party*** (an
  auditor) or avoid holding the range at all. Both the ADS path and the ZK path share the **same
  ceiling**: neither closes 06 §2.4's ciphertext-delivery residual without a node change (§3.1).
- **Compact on-chain attestation (05):** an on-chain, rollback-protected **pointer** to `hash(S)`,
  with compare-and-swap freshness from the transcript model.
- **This offline ZK proof (07):** an off-chain, non-forgeable, unlinkable **certificate** that
  `S` is correct as of finalized `N`.

**Decision rule — offline ZK (07) vs. on-chain attestation (05):**

| Use **05 on-chain attestation** when… | Use **07 offline ZK proof** when… |
|---|---|
| you need **rollback/freshness across independent restores** (multi-device, hosted DB) — the chain pointer + CAS is the freshness oracle (05 §4.1). | you need **zero on-chain footprint / zero fee / zero metadata** — no tx, nothing observable, maximal privacy. |
| you want a **cheap, small** commit (sub-zswap circuit, 05 §4.6) and are content with *trust-transport*. | you want to **prove properties of `S`** (ownership, on-chain presence, value-soundness) to *yourself at restore* or a *third party*, not merely pin bytes. |
| the verifier is *the chain / another contract*. | the verifier is a **client, offline** (`VerifierKey::verify`), possibly disconnected. |
| freshness matters more than what-is-committed. | **finality already gives permanence** (§0) and you don't need a live pointer — the certificate is self-contained. |

**They compose, and the best design uses both:** post the 05 pointer to `hash(S)` for
rollback/freshness *and* attach the 07 certificate for private, self-contained correctness. 05
answers *"is this the latest `S` I committed?"*; 07 answers *"is `S` actually my correct,
on-chain-anchored state at finalized `N`?"*. The anchor `R_N` is common to both; the ADS (06) is
what would let 07 answer the stronger *"…and complete?"*.

**On restore, the pipeline is:** (1) `CheckpointStore.load()` → blob integrity (UmbraDB, brief 03);
(2) `VerifierKey::verify(vk_pinned, proof, {hash(S), R_N, N, id})` → the 07 certificate; (3)
check `R_N/N` on the **finalized** header chain (`chain_getFinalizedHead`); (4) *(optional)* check
the 05 pointer for latest-ness; (5) resume **live** sync `[N, tip]` via the ADS (06) + normal
collapsed-update stream (brief 01 §2). Steps 1–4 replace the entire `[birthday, N]` re-scan;
step 5 is the short tail the proof deliberately does not cover (§0).

---

## 6. Trust model and residual

**What the 07 certificate removes** (relative to a bare restored blob): fabrication of non-existent
notes (they wouldn't be under `R_N`), wrong-key / cross-wallet notes (they wouldn't decrypt to
`esk`), value forgery (coin-commitment SHA-256 binds `info_i` to the leaf), and — because `N` is
**finalized** — any dependence on a live/rolling anchor. The proof is non-forgeable (needs `sk`/`esk`)
and reveals nothing (`vk`, `sk`, note contents, and *which* leaves are mine all stay in the private
witness).

**Residual trust (irreducible, stated honestly):**

1. **Finality assumption.** The certificate's permanence rests on **GRANDPA not reverting blocks
   `≤ N`**. State this explicitly (as the coordinator directs); it is the same trust the whole
   chain already assumes, but the certificate *inherits* it rather than removing it.
2. **Anchor freshness at restore (A5, brief 05 §3).** The client must obtain the *genuine* finalized
   `R_N/N` — a light-client problem. `chain_getFinalizedHead` + `grandpa_proveFinality`
   (`openrpc.rs:97`) or multi-endpoint cross-check mitigate; a local node is strongest. **Not fixable
   inside the proof.**
3. **Circuit-correctness / verifier-key pinning.** A valid proof only means "the statement *this
   `vk`'s circuit encodes* holds". Since we **hand-write the IR with no Compact compiler
   attestation** (§4), the IR must be **independently audited** and its `vk` **pinned** in trusted
   wallet config (brief 05 Q4, now sharper: no compiler in the loop). This is the biggest *new*
   trust surface 07 introduces over 05. A malicious/buggy IR that "verifies" proves nothing useful.
4. **Completeness (v-lightweight only).** Inclusion ≠ completeness (§2.2); omission is caught only by
   v-strong (§3) or by the same scan-time honesty UmbraDB already assumes for self-produced
   snapshots. With v-strong you additionally trust that the circuit encodes the *true* decryption
   rule and the *correct* keys (brief 03 §7(ii)).
5. **SRS / trusted setup.** KZG over BLS12-381 needs the `midnight-trusted-setup` SRS; soundness
   rests on its toxic-waste ceremony (shared with all Midnight proving — not new to us).
6. **Proving-system soundness** (Halo2/`midnight-proofs`) — shared with the entire chain.

**Net:** 07 converts UmbraDB's blob-integrity into a *chain-anchored, private, permanent*
correctness certificate for a finalized horizon, at the cost of one new audited circuit + a pinned
verifier key. It does not remove the finality assumption or the restore-time light-client problem —
it *reduces to* them, which is the best any snapshot root-of-trust can do (brief 03 §7).

---

## 7. Open questions

1. **The single biggest one — authenticated ciphertext delivery (a soundness gap, not a ZK gap).**
   A completeness circuit's "not-mine" branch is only sound if it decrypts the *authentic*
   ciphertext for every leaf, but ciphertexts are off-tree and unauthenticated by `R_N` (§3.1/§3.2,
   06 §2.4). No proving power fixes this; it needs a Substrate body-inclusion proof or a header-level
   ciphertext accumulator (a node/protocol change). **Until Midnight authenticates commitment↔
   ciphertext, a ZK completeness proof cannot deliver more completeness than the ciphertext feed it
   is given — which is exactly brief 06's open residual.** This decides whether the strong
   certificate can ever be *sound*, and it is upstream of every efficiency question.
2. **Recursion/aggregation (the succinctness question).** Does `midnight-proofs`/`midnight-zk-stdlib`
   expose an **in-circuit proof-verification (accumulation/IVC) gadget** a third party can use? If
   yes, v-strong (once sound) folds the ∝`E_N` chunks into one succinct proof; if no, completeness
   stays a linear batch (§3.3) and "lightweight completeness" is a contradiction. Halo2 supports
   accumulation in principle — the question is whether it is *exposed* to circuit authors here.
   *(Note: 06 §2.1 already resolves the earlier "no-gaps over a range" worry — fixed-size + `R_N`
   determines the commitment multiset, so commitment-range completeness is not in doubt; only
   ciphertext delivery and succinctness are.)*
3. **Verifier-key distribution & governance.** How is the pinned `vk` shipped, versioned, and
   rotated across protocol upgrades (the zswap preimages/tree hash could change on a hard fork,
   brief 05 §C3/C10)? A `vk` mismatch silently makes every certificate unverifiable.
4. **SHA-256 cost vs. a Poseidon-only re-anchoring.** The coin-commitment SHA-256 dominates
   v-lightweight (§2.3). Is there a value-sound way to bind `info_i` to the leaf using only Poseidon
   (e.g. proving against a Poseidon re-commitment the wallet also maintains), or is the SHA-256 leaf
   format load-bearing? Half a day with the `CircuitModel` cost model answers the size questions
   precisely.
5. **Exact `ProofPreimage` plumbing for a non-transaction circuit.** `/prove` wraps everything in
   `ProofPreimageVersioned::V2` and a `key_location` (`endpoints.rs:250-315`); the transcript
   vectors (`inputs`, `private_transcript`, `public_transcript_inputs/outputs`, `binding_input`,
   `proofs.rs:705-722`) must be populated to match a *non-ledger* circuit. Confirm the raw `/prove`
   path works for a standalone IR with no `Transaction` wrapper (it appears to — `data:
   Some(ProvingKeyMaterial)` bypasses the resolver — but this needs a live test against `:6300`).

---

## Source index

Local source (read-only; nothing modified):
- **Proving stack:** `~/repos/midnight-ledger/transient-crypto/src/proofs.rs` (KZG/BLS12-381
  `:18-26,80`; `VERIFIER_MAX_DEGREE=14` `:104`; `Zkir`/keygen `:150-214`; `verify` `:545-558`;
  `KeyLocation` `:623`, `WrappedIr` `:646`, `ProvingKeyMaterial` `:652`, `ProofPreimage` `:705`);
  `curve.rs:49-58` (outer/embedded curves); `hash.rs:78-90` (Poseidon `transient_hash`,
  `transient_commit`); `encryption.rs:14-21,100-104,139-158,194-217` (SNARK-friendly note
  encryption/decryption); `merkle_tree.rs:194-210,301-404` (hybrid SHA-256/Poseidon tree, range
  bridge).
- **IR / VM:** `zkir-v3/src/ir.rs` (`IrSource` `:34-45`, `Operand` `:100`, `Instruction` ISA
  `:282-560`, `TransientHash` `:452`, `PersistentHash` `:462`); `zkir-v3/src/ir_vm.rs` (VM,
  cost-model import `:16`); `zkir/Cargo.toml:2-3`, `zkir-v3/Cargo.toml:2-3`.
- **Proof-server:** `proof-server/src/endpoints.rs` (`/prove` `:245-320`, `/check` `:175-240`,
  `/fetch-params/{k}` `:79-88`, `k` range `0..=25` `:82`).
- **zswap circuit / keys:** `zswap/zswap.compact:34-82` (spend, cc/cn/pk preimages, Poseidon path,
  Pedersen value commit); `zswap/src/keys.rs:68,104,140` (encryption key derivation, `try_decrypt`);
  `zswap/src/local.rs:189` (off-circuit trial-decryption); `zswap/src/lib.rs:23`
  (`ZSWAP_TREE_HEIGHT=32`).
- **Finality / anchor:** `midnight-node/node/src/openrpc.rs:76,97,467,486`
  (`chain_getFinalizedHead`, `grandpa_proveFinality`); anchor `R_N` per brief 01
  (`midnight_zswapStateRoot`, indexer `Block.zswapMerkleTreeRoot`).
- **Dependency provenance:** `midnight-ledger/Cargo.lock:2834-2837,2876-2879,3121-3124,3290-3293`
  (`midnight-circuits 6.1.0`, `midnight-curves 0.2.0`, `midnight-proofs 0.7.1`,
  `midnight-zk-stdlib 1.1.0`, all `registry+…crates.io-index`).
- **Docs:** Midnight — public/private state & zk-SNARK bridge, https://docs.midnight.network/;
  Compact reference (witnesses, for-bounds, kernel — the front-end constraints 07 bypasses),
  https://docs.midnight.network/compact/reference/compact-reference.
- **Prior briefs (this directory):** 01 (anchor/`R_N`, trees, finality gap), 02 (Zcash birthday),
  03 (inclusion-vs-completeness, ROTE rollback, verify-vs-recompute), 05 (Compact on-chain
  attestation; N1/N2 infeasibility of in-circuit scan), **06 (ADS-bounded-scan): §2.1 commitment-range
  completeness via collapsed-update + `R_N`; §2.4 the off-tree ciphertext-delivery residual that
  §3.1/§3.2 above inherit; §5 anchor/attestation composition).**
