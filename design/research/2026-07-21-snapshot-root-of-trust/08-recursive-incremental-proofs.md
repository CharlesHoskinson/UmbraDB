# 08 — Recursive / incremental proofs (IVC / PCD / folding): can the certified-checkpoint scheme RATCHET in O(1)?

**Date:** 2026-07-21
**Angle:** The core design certifies "snapshot `S` is the complete, correct wallet state as of **finalized** block `N`" — a cryptographically-certified **birthday floor** below which the wallet never rescans, with the client catching up `[N, tip]` live. This brief asks whether **recursive/incremental proof systems** (IVC / PCD / folding) let that certificate **ratchet**: each new finalized checkpoint proof `π_{N+1}` *extends* `π_N` in ~O(1), folding in only the ADS-authenticated leaf range `(N, N+1]`, without ever re-proving `[birthday, N]` from scratch.

**Builds on (does not re-derive):** brief 01 (state commitments; the zswap/dust trees and their roots), brief 02 (Mina snarked-ledger vs staged-ledger tail split, §II.b), brief 03 (the three no-replay options — membership / bounded tail replay / ZK-proof-of-scan — and the completeness residual §6), brief 05 (why proof-of-correct-scan is **infeasible in Compact**: N1 no in-circuit global-state oracle, N2 no recursion/unbounded loops), brief 06 (the ADS that makes the bounded tail scan verifiably *complete*).

All `repo/path:line` citations are against the local clones read 2026-07-21 (`~/repos/midnight-zk` and `~/repos/halo2` cloned this session from github.com/midnightntwrk; `~/repos/midnight-ledger` pre-existing). Nothing was modified or committed. Paper citations are IACR ePrint / primary URLs.

---

## 0. The answer up front

**Yes — and Midnight's own proof system already ships the machinery.** Recursive proof composition makes the checkpoint certificate an *incrementally verifiable computation*: the wallet keeps **one constant-size proof + one constant-size state summary**, and advancing the certified birthday floor from `N` to `N+1` costs **prover work proportional to the delta `(N, N+1]` plus a fixed recursion overhead — independent of the total history `[birthday, N]`** — while **proof size and verification time stay constant** no matter how many checkpoints have been ratcheted. This is not a research aspiration for Midnight: the `midnight-zk` repo contains a complete IVC framework (`aggregation/src/ivc/`) built on Halo2-style KZG **atomic accumulation** over BLS12-381, with a worked example (`aggregation/examples/ivc.rs`) whose state is *literally a counter plus a Poseidon hash-chain value* — structurally identical to "checkpoint height `N` plus a running frontier commitment."

**This directly answers brief 07's open question §7 Q2** ("Does `midnight-proofs`/`midnight-zk-stdlib` expose an in-circuit proof-verification (accumulation/IVC) gadget a third party can use?"): **yes** — the `midnight-aggregation` crate is exactly that gadget, and it resolves the library-vs-VM tension brief 07 §3.3 flagged (recursion lives in the Rust **library**, not in the ZKIR VM / `:6300` proof-server path, which has none — §3.6 below).

The honest boundary (§4): recursion compresses the **consistency chain** ("I correctly folded each delta I was handed"), not the **completeness claim** ("the delta I was handed was all of my notes"). Completeness is still supplied by the **ADS-authenticated delta** of brief 06, and the anchor's trust still reduces to **consensus/finality** (brief 03 §7, brief 10). Recursion buys unbounded compression of an arbitrarily long certified chain; it does not manufacture trust in the inputs. Two distinct walls, per brief 07 §3.3: recursion **demolishes the succinctness wall** (folds the ∝-history chunk-batch into O(1) + delta) but **leaves the soundness wall standing** (the off-tree ciphertext-delivery gap, a node change — §7).

---

## 1. Survey of IVC / PCD / folding (RQ1)

### 1.0 Two families, one goal

**Incrementally Verifiable Computation (IVC)** [Valiant 2008] proves "state `s_N` is the result of applying `N` transition steps to a genesis state" with a proof whose size and verification cost are **independent of `N`**. **Proof-Carrying Data (PCD)** [Chiesa–Tromer 2010] generalises IVC from a line (a chain) to a DAG of provers with heterogeneous statements. Every construction reduces to one problem: *how does step `i` cheaply attest that step `i-1`'s proof was valid, without the cost blowing up as the chain grows?* Two lineages answer it:

- **(A) Accumulation / deferred-verification ("atomic accumulation").** Each step still emits a full SNARK proof, but the SNARK verifier's **one expensive check** (a pairing, or an inner-product-argument opening) is *not* performed in-circuit — it is folded into a running **accumulator** and discharged **once**, at the very end, by an off-circuit **decider**. Originated in **Halo** [Bowe–Grigg–Hopwood 2019, ePrint 2019/1021], abstracted as *accumulation schemes* and shown to yield PCD in **BCMS20** [Bünz–Chiesa–Mishra–Spooner, *Proof-Carrying Data from Accumulation Schemes*, ePrint 2020/499], and instantiated for pairing/KZG commitments ("atomic accumulation") in **Halo Infinite / BDFG21** [ePrint 2020/1536]. **This is the family Midnight ships (§3), and Mina/Pickles (§1.6) is its most famous deployment.**
- **(B) Folding schemes.** Avoid a per-step SNARK *entirely*. A **folding scheme** reduces "check two instances of a relation" to "check one instance," using a folding-verifier far cheaper than a SNARK verifier (Nova: **two group scalar multiplications**). All constraint-satisfaction checking is deferred to a **single** final SNARK over the folded instance. **Nova → SuperNova → HyperNova**, and **ProtoStar / ProtoGalaxy**, are this family.

The distinction matters for Midnight because family (A) needs no second curve and reuses the exact PLONK/KZG stack Midnight already has, whereas family (B) is fastest on a **cycle of curves** Midnight does not ship (§3.3).

### 1.1 Nova — folding for relaxed R1CS

[Kothapalli–Setty–Tzialla, *Nova: Recursive Zero-Knowledge Arguments from Folding Schemes*, CRYPTO 2022, ePrint 2021/370, https://eprint.iacr.org/2021/370]

- **Proves:** `s_N = F^{(N)}(s_0)` for a step function `F`, via a folding scheme for *relaxed* R1CS (R1CS augmented with a slack/error term so two instances fold linearly).
- **Prover / step:** dominated by **two multi-exponentiations of size `O(|F|)`** (the step circuit). **No FFTs.** Crucially, "the prover's work to update the proof does not depend on the number of steps executed thus far."
- **Recursion overhead:** the augmentation circuit is a **constant dominated by two group scalar multiplications** — "the smallest recursion overhead in the literature" (abstract). Verifier work does not grow with `N`.
- **Proof size:** naively `O(|F|)` group elements; compressible to **`O(log|F|)`** by capping the chain with a zk-SNARK (e.g. Spartan) over the final folded instance.
- **Setup / assumptions:** **no trusted setup, no FFTs**; instantiable over "any cycle of elliptic curves where DLOG is hard" (the reference impl uses the **Pasta** 2-cycle, switching curve each step so in-circuit EC arithmetic stays native). Transparent, discrete-log + random-oracle.

### 1.2 SuperNova — non-uniform IVC

[Kothapalli–Setty, *SuperNova: Proving universal machine executions without universal circuits*, ePrint 2022/1758, https://eprint.iacr.org/2022/1758]

- **Proves:** IVC where each step may run a **different** circuit (e.g. one per VM opcode). Folds the R1CS instance of the *executed* step into a running instance.
- **Key cost property — "à la carte":** per step the prover pays **only for the instruction actually executed**, not for the sum of all supported instruction circuits. This is the property a **heterogeneous** checkpoint delta wants (a step that folds a shielded range vs. a step that folds an unshielded range need not each pay the other's circuit).
- Same folding-scheme cost profile as Nova; same transparent/cycle-of-curves setup.

### 1.3 HyperNova — folding for CCS (Plonkish/R1CS/AIR)

[Kothapalli–Setty, *HyperNova: Recursive arguments for customizable constraint systems*, CRYPTO 2024, ePrint 2023/573, https://eprint.iacr.org/2023/573]

- **Proves:** IVC whose steps are expressed in **CCS**, which "simultaneously generalizes Plonkish, R1CS, and AIR without overheads."
- **Prover / fold:** a **single MSM of size = the number of variables** in the constraint system (no commitment to a Nova-style cross-term/error vector); uses a **sumcheck**-based multi-folding, and can **fold multiple instances at once**.
- Transparent; discrete-log + RO; Plonkish-native, which makes it the folding-family member *closest* to Midnight's Plonkish arithmetization — but still a folding scheme (family B), not KZG accumulation.

### 1.4 ProtoStar — generic accumulation for special-sound protocols

[Bünz–Chen, *ProtoStar: Generic Efficient Accumulation/Folding for Special-Sound Protocols*, ASIACRYPT 2023, ePrint 2023/620, https://eprint.iacr.org/2023/620]

- **Proves:** accumulation for **any** `(2k-1)`-move special-sound protocol whose verifier checks `ℓ` degree-`d` equations — i.e. **Plonkish with high-degree custom gates and (vector) lookups**, not just addition/multiplication.
- **Accumulation verifier:** **3 group scalar multiplications + a hash of `d` field elements** (generally `k+2` EC mults and `k+d+O(1)` field/hash ops) — *independent of the number of gates and of lookup-table size*.
- **Accumulation prover:** independent of lookup-table size, logarithmic in the number of supported circuits.
- **Setup / assumptions:** **no trusted setup, no pairings, no FFTs** (additive/Pedersen-style commitments). This is the folding-family answer to "I want Plonkish + lookups but no trusted setup."

### 1.5 Halo2 accumulation — the KZG/atomic-accumulation lineage (Midnight's)

[Halo, ePrint 2019/1021, https://eprint.iacr.org/2019/1021; BCMS20, ePrint 2020/499, https://eprint.iacr.org/2020/499; Halo Infinite/BDFG21, ePrint 2020/1536, https://eprint.iacr.org/2020/1536]

- **Proves (as used by Midnight):** a PLONK proof, where the KZG opening/pairing check is turned into an **accumulator** (a deferred "dual MSM" / pairing claim). The in-circuit verifier does the arithmetic/commitment-combination parts and **emits a new accumulator**; the single **pairing** is deferred and checked once by the decider. PCD follows by BCMS20.
- **Proof size:** **constant** — one PLONK/KZG proof plus a constant-size accumulator (a pair of group elements after `collapse`).
- **Verifier cost:** **constant** — verify one PLONK proof + a **single pairing** for the accumulator. (`aggregation/src/ivc/verifier.rs:5-6`: "Verification is constant-time regardless of how many steps the prover has performed.")
- **Setup / assumptions:** a **universal, updatable KZG SRS** (a *trusted* powers-of-tau setup, but circuit-independent) over a pairing-friendly curve (Midnight: **BLS12-381**). With a single curve the in-circuit verifier must **emulate** the curve's group operations non-natively; atomic accumulation makes that affordable by *deferring the pairing* rather than doing it in-circuit.

### 1.6 Mina / Pickles — the canonical "compress unbounded history to O(1)"

[Mina, *22kB-Sized Blockchain — A Technical Reference*, https://minaprotocol.com/blog/22kb-sized-blockchain-a-technical-reference; Pickles accumulation, https://o1-labs.github.io/proof-systems/pickles/accumulation.html]

- **Proves:** the *entire* Mina chain state, recursively — each block proof verifies the previous chain proof, "compressing an unlimited number of blocks into a single succinct proof" of **~22 KB**, constant regardless of chain length. This is **exactly the ratchet the checkpoint scheme wants, at chain scale**: a certified "everything up to here is valid" that extends forward one step at a time.
- **How:** **Kimchi** (a PLONK variant with **IPA/bulletproof** commitments, *no trusted setup*) + **Pickles** recursion over the **Pasta** (Pallas/Vesta) **cycle of curves**, so "one proof can attest to the correctness of another without costly field emulation." Uses IPA-style accumulation (family A) — same lineage as Midnight's KZG accumulation, but transparent and 2-cycle rather than pairing + single-curve.
- Brief 02 §II.b already grounded the closely-related **snarked-ledger vs. staged-ledger** split and the `k = 290` finality depth: a recursive SNARK certifies the ledger "a few blocks behind," and only the short tail is applied explicitly — the on-chain analogue of "trust the certified floor, scan `[N, tip]` live."

### 1.7 Plonky2 / Plonky3 — recursive PLONK + FRI

[Polygon Zero, *Plonky2: Fast Recursive Arguments with PLONK and FRI*, https://docs.rs/crate/plonky2/latest/source/plonky2.pdf; https://polygon.technology/blog/introducing-plonky2]

- **Proves:** recursion by verifying a **FRI**-based PLONK proof inside another, over the **64-bit Goldilocks** field (small-field arithmetic → ~40× faster proving than 256-bit KZG fields).
- **Setup / assumptions:** **no trusted setup** (FRI is hash-based, transparent, plausibly post-quantum). Recursive proof in **~170 ms on a laptop**; size-optimised proofs **~43–45 KB** (~1M gas to verify on Ethereum). Plonky3 is the modular successor.
- Fastest transparent recursion, but a **different field and commitment scheme** from Midnight — adopting it means a second, parallel proving stack (§3.3).

### 1.8 Comparison table

| System | Family | Proves | Proof size | Prover / step | Verifier | Setup |
|---|---|---|---|---|---|---|
| **Nova** | folding (R1CS) | `s_N=F^{(N)}(s_0)` | `O(log|F|)` (capped) | 2 MSM of `O(|F|)`; no FFT | O(1); +2 scalar-mult circuit | transparent, DLOG, **2-cycle** |
| **SuperNova** | folding, non-uniform | multi-circuit IVC | `O(log|F|)` | à la carte: only executed step | O(1) | transparent, 2-cycle |
| **HyperNova** | folding (CCS) | Plonkish/R1CS/AIR IVC | `O(log)` | 1 MSM = #vars; sumcheck; multi-fold | O(1) | transparent, 2-cycle |
| **ProtoStar** | folding/accum. | special-sound + lookups | `O(log)` | indep. of table size | 3 scalar-mult + hash | **no trusted setup, no pairings** |
| **Halo2/KZG accum.** (**Midnight**) | atomic accumulation | any PLONK relation | **O(1)** | 1 PLONK proof of (transition + in-circuit KZG verifier) | 1 PLONK verify + **1 pairing** | **universal KZG SRS** (trusted), BLS12-381, single curve |
| **Mina/Pickles** | IPA accumulation | whole chain | ~22 KB const. | 1 Kimchi proof + accum. | O(1) | transparent, Pasta 2-cycle |
| **Plonky2/3** | recursive FRI | any Plonkish | ~43 KB | ~170 ms recursion | O(1), ~1M gas | **no trusted setup**, Goldilocks |

---

## 2. Applicability to the checkpoint ratchet (RQ2) — validated against Midnight's own IVC

### 2.1 The model: a checkpoint IS an IVC step

Midnight's IVC framework (`aggregation/src/ivc/mod.rs`) defines exactly four things an application must supply — and the checkpoint ratchet maps onto each cleanly:

| IVC trait member (`ivc/mod.rs`) | Checkpoint-ratchet instantiation |
|---|---|
| `IvcState::State` / `AssignedState` (`:94-128`) — a full off-circuit state **plus a constant-size in-circuit summary** that "computationally determines" it (a hash/commitment) | The **frontier tuple** of brief 06 §5.3: `(N, zswapEndIndex_N, zswapMerkleTreeRoot_N, dust end-indices+roots, R_utxo_N)` — and a running commitment to the wallet's note/nullifier set. Constant-size; the on-chain root **is** a Poseidon field element (§3.4). |
| `IvcState::genesis` (`:111-112`) | The wallet **birthday** (block below which no note exists). |
| `IvcTransition::Witness` (`:186-188`) — the **secret per-step input** | The **ADS-authenticated delta** `(N, N+1]`: the `MerkleTreeCollapsedUpdate` boundary hashes (brief 06 §2.1), the ciphertexts/events in range, and the viewing key. |
| `IvcTransition::circuit_transition` (`:202-207`) — in-circuit next-state | Constrain: apply the collapsed update, **rehash and check it matches `root_{N+1}`**, decrypt/filter the delta, update the note-set commitment, advance the cursor. **This internalises brief 06's completeness check into the circuit.** |
| `IvcState::decider` (`:114-127`) — off-circuit invariant check | Off-circuit re-check that the summary binds the full state, plus the one accumulator pairing. |

The IVC circuit (`aggregation/src/ivc/circuit.rs:68-86`) then wraps each step to prove the conjunction: **(1)** `state_{N+1}` is the transition applied to `state_N` with the delta witness; **(2)** `state_N` is genesis **OR** `prev_proof` is a valid proof of the *same IVC circuit* for `state_N` (self-verification, `circuit.rs:147-198`); **(3)** the new accumulator folds the previous one (`circuit.rs:214-222`). The genesis step is special-cased so the first checkpoint needs no prior proof (`circuit.rs:200-212`, `prover.rs:72-87`).

The example `aggregation/examples/ivc.rs` makes the shape unmistakable: `State { cnt, val }` where `val` is a **Poseidon hash-chain** and `cnt` counts steps (`ivc.rs:30-38`), the transition hashes `N` times and increments `cnt` (`ivc.rs:135-161`). Replace "Poseidon hash-chain over nothing" with "Poseidon frontier commitment folding in the authenticated delta," and `cnt` with the checkpoint height, and you have the ratchet verbatim.

### 2.2 Does IVC give O(1) proof + delta-bounded prover work? — CONFIRMED

**Proof size and verification: constant in the number of checkpoints — confirmed by construction and by Midnight's docstrings.** `ivc/mod.rs:14-20`: "the proof size and verification time are *constant* regardless of the number of steps `N`: the prover folds each new step into the existing proof incrementally rather than proving the entire chain from scratch. Note that `N` … is **not** revealed by the proof." Verification (`ivc/verifier.rs:49-88`) is one `plonk::prepare` (verify one PLONK proof) + one accumulator `accumulate` + one `final_acc.check` — **a single pairing**. Independent of history length. The wallet stores **one** `IvcInstance` `{vk_repr, state, acc}` (`circuit.rs:39-44`) + one proof blob, discarding all intermediate checkpoint proofs.

**Per-step prover work: fixed recursion overhead + delta-proportional transition — confirmed.** `prover.rs:62-147` shows `prove_step` does, once per step: apply the transition off-circuit (`T::transition`, `:63-64`); verify the *previous* proof off-circuit into a `DualMSM` and fold it (`plonk::prepare` + `Accumulator::from_dual_msm` + `accumulate` + `collapse`, `:97-118`); and **prove one instance of the fixed IVC circuit** (`:133-140`). The IVC circuit's size is `|transition circuit| + |in-circuit KZG verifier| + |accumulator fold|`. The verifier+fold part is a **fixed constant independent of `N`**; the transition part is **proportional to the delta** the step folds in (in the example, `N` Poseidon rounds — `ivc.rs:172` `N = 1_000` per step). Therefore:

> **Per-step prover cost = O(delta in `(N, N+1]`) + O(fixed recursion overhead), independent of the total history `[birthday, N]`.** Advancing the birthday floor from `N` to `N+1` never re-touches `[birthday, N]`. This is precisely the ratchet the design hypothesised, and it holds.

Two honest caveats on "delta-bounded":

1. **The fixed overhead is heavy, not free.** The dominant cost each step is the **in-circuit KZG PLONK verifier + curve emulation**, not the transition. The example needs circuit size `K = 17` (`ivc.rs:170`, ~130k rows) mostly for the verifier, and `prove_step` runs in **seconds** even for a trivial transition. So "O(1) per step" has a large constant: every ratchet step pays one full recursive-verification proof. This is inherent to accumulation-family IVC (it is why folding-family Nova, whose per-step overhead is *two scalar mults*, exists at all).
2. **The delta must fit one circuit of fixed `K`.** A step folds a bounded delta; a checkpoint spanning many blocks must either size `K` for the worst-case delta or be split into several IVC steps (each still O(1) to verify). Because checkpoints are **finality-bounded and frequent**, the per-step delta is naturally small and bounded — the good case for IVC.

### 2.3 The ratchet, end to end

`genesis(birthday) --δ₁--> ckpt_{N₁} --δ₂--> ckpt_{N₂} --…--> ckpt_{N_k}`, each `δ_i` the authenticated leaf range `(N_{i-1}, N_i]`. The wallet (or an untrusted UmbraDB acting as prover) keeps only `(instance_{N_k}, proof_{N_k})`. To publish a fresher floor it calls `prove_step(δ_{k+1})` — O(delta) work — and can `resume_from` a saved intermediate state to re-anchor (`prover.rs:49-53`). Restore verifies one proof in constant time and adopts `state_{N_k}` as the birthday floor; the live client catch-up `[N_k, tip]` is **unchanged** — recursion governs only the *frozen* `[birthday, N_k]` region and how cheaply `N_k` advances.

---

## 3. Fit with Midnight's Halo2/KZG-over-BLS12-381 stack (RQ3)

### 3.1 Midnight already ships the recursion — it is not a missing primitive

The `midnight-zk` repo *is* Midnight's proof system: `proofs/` is "a Plonk proof system using **KZG commitments**," `curves/` implements **BLS12-381 and JubJub**, and the stack began as a fork of PSE **halo2 v0.3.0** (`~/repos/midnight-zk/README.md`). On top of it sits a first-class recursion toolkit:

- **`aggregation/src/ivc/`** — the full IVC framework analysed in §2.
- **`aggregation/src/multi_circuit_aggregator/`** — a **PCD** aggregator that folds proofs from **heterogeneous** circuits (different VKs) into one succinct proof, tracking a Poseidon **claims hash-chain** + a deferred-verification accumulator, "both constant-size regardless of how many proofs were aggregated" (`multi_circuit_aggregator/mod.rs:1-30`). This is the tool for a checkpoint step that must fold **shielded + dust + unshielded** deltas of different circuit shapes in one ratchet.
- **In-circuit verifier gadgets** — `circuits/src/verifier/{kzg.rs, msm.rs, accumulator.rs, verifier_gadget.rs}` implement the in-circuit KZG PLONK verifier and the `AssignedAccumulator`.
- **The accumulation primitive is in the *shipped* base proof system**, not just the toolkit: `proofs/src/poly/kzg/msm.rs:205` (`DualMSM`) and `proofs/src/plonk/verifier.rs:371` (`prepare`) are the deferred-pairing objects the IVC folds. `midnight-proofs`, `midnight-circuits`, `midnight-zk-stdlib` are published crates (README crates.io badges).

**Answer: Midnight's proving system already supports the accumulation/recursion the checkpoint ratchet needs. No different proof system is required.**

### 3.2 It is single-curve BLS12-381 accumulation — NOT Nova-over-a-cycle

`circuits/src/verifier/types.rs:52,138-153` defines `SelfEmulation`/`BlstrsEmulation` with `type F = midnight_curves::Fq` (the BLS12-381 **scalar** field), `type C = G1Projective`, `type Engine = Bls12`. "Self-emulation" = the circuit verifies proofs over the **same** curve it is proven on. Because a single-curve in-circuit KZG verifier cannot perform a native BLS12-381 pairing, Midnight uses **atomic accumulation** (family A, §1.5): the in-circuit verifier emulates the G1 group operations (coordinates in the base field `Fp`, emulated non-natively) and emits an accumulator; the **pairing is deferred** to the off-circuit decider (`ivc/verifier.rs:82-85`, a single `final_acc.check`). So the checkpoint ratchet does **not** need Nova, a Pasta cycle, or any curve Midnight lacks — it reuses BLS12-381 + KZG directly. (A `BnEmulation` over BN256 also exists — `types.rs:187-200` — but BLS12-381 is Midnight's curve.)

Trade-off vs. the folding family: this inherits KZG's **universal trusted SRS** (the "Midnight" powers-of-tau SRS, `SrsSource::Midnight`, `ivc.rs:175-176`) and the heavy in-circuit-emulation constant (§2.2). It gains a genuinely **O(1)** pairing-verified proof and, decisively, **zero new cryptographic surface** — same curve, same commitment, same SRS, same Poseidon as production Midnight.

### 3.3 Client-side verification: yes, and off-chain by design

The checkpoint proof is a **client-to-client / DB-to-client** artifact, never a transaction. `IvcVerifier` (`ivc/verifier.rs:21-88`) is a lightweight struct holding the self-VK + KZG verifier params; `verify` is pure Rust, constant-time, no chain interaction. This matches the design's "client catches up live" and brief 05's off-chain restore check: the ratchet proof is verified where the snapshot is restored, not on-chain. (Contrast brief 05's *on-chain attestation*, which transports trust via a Compact contract; the ratchet proof instead **carries its own correctness** and needs only a trusted anchor root as input.)

### 3.4 SNARK-friendly hashing — the trees' internal digests are already Poseidon (a decisive convenience)

The single biggest "will the in-circuit check be affordable" question resolves in the design's favour. Midnight's zswap/dust commitment trees are a **deliberate hybrid** (brief 07 §1.2): the **leaf** is `persistent_hash` = SHA-256 (`merkle_tree.rs:194-198`), but every **internal node** combines with `transient_hash` = **Poseidon** (`transient-crypto/src/hash.rs:76-82`, `PoseidonChip`; `merkle_tree.rs:208-210`), and `MerkleTreeDigest` is a **scalar-field element `Fr`** (`merkle_tree.rs:275`), not a byte string. The trees are SNARK-native **by design** — real zswap spends prove Merkle membership in-circuit (brief 01 §2 `path_for_leaf`; brief 05 C5 `merkleTreePathRoot`). The consequence for the ratchet is precise and favourable:

- **The completeness fold is pure Poseidon.** The `MerkleTreeCollapsedUpdate` boundary is a set of **subtree digests** (already `Fr`); rehashing them up to confirm `root_{N+1}` is only `transient_hash` (Poseidon) combining — cheap, over the circuit's **native field**, using the *same* `PoseidonChip` as the IVC transcript and state-commitment. No SHA-256 is touched to check that the range is complete and chains to the new root.
- **Only binding an *owned* note's value to its leaf costs SHA-256** — one `persistent_hash` per note the wallet actually decrypts (brief 07 §2.3, ~2,000 rows/note), because the leaf format is SHA-256. So the SHA-256 tax is ∝ **owned notes** (small), not ∝ **range leaves** (large): the expensive hash rides only on the wallet's own note set, while the completeness-of-range check stays Poseidon. `degrade_to_transient` (`hash.rs:63-76`) bridges the SHA-256 leaf into the Poseidon domain, exactly as the on-chain tree does.

**Poseidon availability confirmed:** `ZkStdLibArch { poseidon: true, .. }` and `std_lib.poseidon(..)` (`ivc.rs:126-133,156`).

### 3.5 This is NOT a Compact contract — which is exactly why it is feasible

Brief 05 §6.1 correctly ruled proof-of-correct-scan **infeasible in Compact** (N2: `for` loops need compile-time bounds, no recursion — `compact-reference` C10; N1: no in-circuit global-state oracle). The ratchet **sidesteps N2 entirely**: it is a **native Rust circuit** built directly against `midnight-proofs`/`midnight-circuits`/`midnight-aggregation`, where recursion is a supported primitive — not Compact, where it is not. The Compact language cannot express recursion; the **underlying proof system can**, and the ratchet uses the latter. N1 is *not* repealed (§4): the on-chain anchor root is still a circuit **input**, not something the circuit reads from global chain state.

### 3.6 Reconciling with brief 07 — recursion lives in the LIBRARY, not the ZKIR VM

Brief 07 §1.5/§3.3/§7 Q2 found — correctly — that the **ZKIR VM has no recursion**: the `zkir-v3` `Instruction` ISA (`TransientHash`, `PersistentHash`, `EcMul`, `Assert`, …) has **no "verify a proof in-circuit" opcode**, and the running `:6300` proof-server only proves caller-supplied ZKIR, so a completeness proof chunked on the ZKIR path (brief 07 §3.3) is a **linear batch** of chunk proofs, verified ∝ #chunks, *not* one O(1) proof. Brief 07 §7 Q2 then left the decisive question open: *does the underlying Halo2 stack expose an in-circuit verifier/accumulation gadget at all?*

**08 closes that question: yes, but in a different layer.** The two findings are complementary, not contradictory — they describe two distinct surfaces of the same proof system:

| Surface | Recursion? | What proves it | Used for |
|---|---|---|---|
| **ZKIR VM** (`zkir`/`zkir-v3`, compiled from Compact) — brief 07 | **No** — no verify-proof opcode | the `:6300` proof-server, on caller-supplied IR | on-chain transaction proofs; brief 07's standalone per-checkpoint certificate |
| **Rust circuit library** (`midnight-proofs` + `midnight-circuits` verifier gadgets + `midnight-aggregation`) — brief 08 | **Yes** — `std_lib.verifier()` is an in-circuit KZG PLONK verifier; `aggregation/src/ivc` is a full IVC/PCD framework | a **new** native-Rust prover (not the `:6300` server) | off-chain, client-verified checkpoint **ratchet** |

So brief 07's "no recursion" is exactly right *for the path a hand-written ZKIR circuit can use today*, and brief 08's "recursion ships" is exactly right *for the Rust library one layer below Compact/ZKIR*. **The ZKIR IR is too coarse to express in-circuit proof verification (brief 07 path (a)); `midnight-aggregation` expresses it natively (brief 07 path (b), now concrete).** This is the "library-vs-VM distinction" — and it decides the integration path (§5): the ratchet cannot run on the `:6300` server; it needs a purpose-built Rust prover binary.

---

## 4. The honest limit — recursion compresses CONSISTENCY, not COMPLETENESS (RQ4)

This is the load-bearing section; be precise about what recursion buys versus what the ADS must still supply.

### 4.1 What recursion proves

`π_{N+1}` proves: *"there exists a delta witness such that `state_{N+1}` is the transition applied to `state_N`, AND `state_N` was itself certified by a valid `π_N` of this same circuit, AND the accumulator folds correctly."* Inductively: **every transition in the chain from genesis satisfied its relation.** That is a statement about the **consistency of the fold** — "I correctly folded each delta I was handed into a state that legitimately chains from the previous certified state."

Midnight's own PCD aggregator states the boundary exactly: verifying the folded proof "guarantees that every claim has a valid inner proof, **but says nothing about *what* was proved**. It is up to the verifier to decide whether the claims are meaningful by checking that each VK belongs to a trusted circuit" (`multi_circuit_aggregator/mod.rs:32-45`). **Recursion certifies the fold; the transition *relation* certifies the meaning; the *inputs* certify the facts.**

### 4.2 What recursion does NOT prove — and who must

Recursion does **not** by itself prove that the delta folded at each step was the **complete** set of the wallet's leaves in `(N, N+1]`. Completeness enters **only** through what the transition relation is written to demand of its inputs:

- **Completeness of the delta → supplied by the ADS (brief 06), internalised by the transition circuit.** The step circuit *can* constrain "the leaves I folded are exactly those authenticated by the `MerkleTreeCollapsedUpdate` boundary against `root_{N+1}`" — i.e. it can move brief 06's commitment-completeness check **inside** the circuit, so each step's shielded-commitment completeness becomes a *proven* fact carried O(1) forward. This is the real prize: the ratchet doesn't just compress a chain of "trust me" snapshots, it compresses a chain of **ADS-verified** ones.
- **Authenticity of the anchor root → still external (unchanged N1 / brief 03 §7).** The circuit takes `root_{N+1}` as a public input/witness; it cannot know it is the *real consensus* root. Trust in that root still reduces to **consensus/finality**, outside both UmbraDB and the proof. Recursion transports the anchor-trust forward faithfully; it does not create it (same framing as brief 05 §1 for attestations).
- **The two irreducible ADS residuals survive verbatim.** Recursion can only fold what the ADS delivers. Brief 06 §2.4's **ciphertext-downgrade under-count** (a committed leaf whose off-tree ciphertext is withheld as `None`) and §3's **spend-hiding** (no nullifier-set completeness ADS) are **inputs the ADS cannot authenticate**, so the transition circuit cannot constrain them, so recursion cannot certify them. They remain node/protocol-layer gaps (block-body proofs / a header-committed nullifier or ciphertext accumulator), exactly as brief 06 §6 concluded. **Recursion narrows nothing here; it faithfully carries forward whatever completeness the ADS did or did not establish.**

### 4.3 Buys vs. must-still-provide

| | Recursion / IVC buys | Must still be supplied by… |
|---|---|---|
| Chain length | O(1) proof + verify for arbitrarily many checkpoints; O(delta) per new step | — |
| Consistency | "every fold was a valid transition of this circuit" | (proof-system soundness + KZG SRS) |
| Shielded-commitment completeness `(N,N+1]` | **carried O(1) forward once internalised** | the **ADS collapsed-update** (brief 06 §2), as the transition's authenticated input |
| Anchor authenticity | faithful forward transport of the trusted root | **consensus/finality** (brief 03 §7); the root is a circuit input (N1) |
| Ciphertext-delivery completeness | nothing | node body-proof / ciphertext accumulator (brief 06 §2.4) |
| Spend completeness | nothing | nullifier-set ADS / node change (brief 06 §3) |

**Bottom line for RQ4:** recursion converts "a chain of individually-ADS-verified checkpoints" into "one constant-size certificate of the whole chain," and lets the birthday floor advance in delta-work. It **compresses the consistency chain and transports the ADS's completeness result**; it does **not** repair the ADS's completeness *holes*, nor manufacture anchor trust. What the ADS cannot see, the recursion cannot certify.

---

## 5. Integration cost — the decisive question (TypeScript wallet vs. Rust prover)

The cryptography is in-house, but the wallet is not. The SDK is **TypeScript** (briefs 01/04); the IVC prover is **Rust** (`midnight-aggregation`). Three facts fix the integration shape:

1. **The `:6300` proof-server cannot run the ratchet.** It proves caller-supplied **ZKIR**, which has no verify-proof opcode (§3.6, brief 07 §1.5). A ratchet prover is a **new native-Rust binary** linking `midnight-proofs` + `midnight-circuits` (verifier gadgets) + `midnight-aggregation` — a from-scratch build. This sharpens brief 03 §3c ("no such prover exists") to: *the cryptography exists as published crates; the prover binary and its wallet integration do not.*
2. **A WASM bridge is precedented but the prover is heavy.** Midnight already ships Rust→TS proving bridges — `ledger-wasm` (`@midnight/ledger`), `zkir-wasm`, `zkir-v3-wasm`, `wasm-proving-demos` — and the `midnight-zk` `proofs`/`curves` crates carry `cfg(target_arch="wasm32")` targets (`proofs/Cargo.toml:60`, `curves/Cargo.toml:54`). So an IVC prover *can* be WASM-compiled in principle. **But** each step is a full in-circuit KZG self-verifier + curve emulation (§2.2: `K≥17`, ~130k rows, MSM/FFT-heavy, seconds/step, large SRS in memory) — hostile to a browser WASM sandbox (memory ceilings, threads, MSM throughput). The realistic split is **heavy prover as a native sidecar service** (a purpose-built binary, structurally like `:6300` but running `aggregation`, invoked off the hot path) + **light verifier in WASM/TS at restore** (`IvcVerifier::verify` = one PLONK verify + one pairing — cheap, WASM-friendly).
3. **No Compact front-end, no compiler attestation.** The transition circuit is authored at the `midnight-circuits`/`midnight-aggregation` Rust level (brief 07 path (b)), which — like brief 07 §4/§6 warns for hand-written ZKIR — carries **no compiler-provided correctness attestation**; the circuit and its VK must be independently audited and pinned.

**Is it viable, or research-grade?** Honestly: **research-grade heavy lift**, justified by *scale*. Weigh it against brief 07's non-recursive ZKIR path:

| | Non-recursive standalone proof (brief 07) | Recursive ratchet (this brief) |
|---|---|---|
| Per-checkpoint proof size | small, ~witness-independent | **O(1), identical** |
| Per-checkpoint *prover* cost | v-lightweight: ∝ **owned notes** (`k≈20`); v-strong: ∝ **prefix leaves** (∝`E_N`, thousands of chunk-proofs) | **∝ delta `(N_{prev},N]`** + fixed recursion overhead |
| History kept | discard old, make a fresh proof each time | **one** proof, extended forward |
| Runs on `:6300`? | **yes, today** (brief 07 path a) | **no** — new Rust prover |
| Build effort | engineering (author + audit one IR) | **research** (author IVC circuits + stand up a prover service) |

The takeaway is sharp: **for brief 07's v-lightweight certificate (∝ owned notes, already small, buildable today), recursion buys little** — a wallet can just mint a fresh standalone certificate at each new finalized `N` and discard the old one; there is no growing history to fold. **Recursion earns its heavy lift precisely for brief 07's v-strong completeness case**, whose cost is ∝`E_N` with "no IVC to fold it" (brief 07 §3.3) and which explicitly asked for exactly this tool (brief 07 §7 Q2): the ratchet folds the ∝-prefix chunk-batch into **O(1) proof + O(delta) per step**, turning "thousands of chunk proofs re-minted each checkpoint" into "one proof, advanced by only the new leaves." That — folding an otherwise linear-in-history completeness proof into a constant-size ratchet — is the enhancement worth the build.

If per-step *prover latency* is the binding constraint, the **folding family** (Nova/HyperNova ~2 scalar-mult overhead, or ProtoStar with Plonkish+lookups and no trusted setup) is materially cheaper per step — but only over a **cycle of curves / small field Midnight does not ship** (§3.3, §1.7), i.e. a whole parallel proving stack with new crypto to audit. Midnight's KZG-accumulation path trades a heavier prover for **zero new cryptographic surface** (same curve, SRS, Poseidon, trees) — the right trade for a wallet feature that must bind to Midnight's exact `R_N`.

---

## 6. Folding angle-10 (GRANDPA finality) into the IVC step — feasible, heavy, usually unnecessary

The owner asks whether each IVC step can **also** verify that `N` is GRANDPA-finalized (or that finality advanced correctly), so the recursive proof **self-contains** the finalized-anchor trust rather than taking `R_N` on faith.

**Expressibility: yes — the gadgets exist.** Brief 10 established that GRANDPA finality reduces to (a) an **Ed25519** threshold-signature check over the precommit set (`check_message_signature_with_buffer`, brief 10 §1), (b) authority-set-handoff tracking (warp-sync fragments, brief 10 §2), and (c) a **Blake2-256 Merkle-Patricia** state-read-proof to extract `R_N` from `N`'s `state_root` (brief 10 §3). Every one of those primitives is a togglable chip in `midnight-zk`'s `ZkStdLibArch` (`zk_stdlib/src/lib.rs:121-167`): **`curve25519`** (foreign Edwards chip → Ed25519 point ops, `circuits/src/ecc/foreign/edwards_chip.rs` with windowed `msm`), **`sha2_512`** (Ed25519's challenge hash, `Sha512Chip`), and **`blake2b`** (the Substrate trie hash, `Blake2bChip`). So an in-circuit GRANDPA-finality-plus-`R_N`-read is **expressible today** with existing stdlib gadgets — this is precisely what Mina/Pickles does (verify consensus in-circuit, recursively; §1.6).

**Cost: severe, on three axes that all point the wrong way.** Unlike the zswap tree (Poseidon, SNARK-native), GRANDPA is built from **SNARK-hostile** primitives:
- **Ed25519 = foreign-curve emulation + SHA-512.** Each signature is one emulated Curve25519 double-base scalar-mul (thousands of rows) + a SHA-512 (thousands more) + point decompression. Multiply by **⅔ of the authority set** per justification (Midnight's `MaxAuthorities` ceiling is **10,000**, brief 10 §5) — a single finality justification can dwarf the entire zswap completeness circuit and blow past the `k=25` single-circuit ceiling.
- **Blake2-256 state trie.** Reading `R_N` in-circuit means hashing ~`log(state)` trie nodes with Blake2b (non-friendly) against the header `state_root` — heavier than the Poseidon zswap fold, and over a *different* commitment than the zswap root the ratchet already checks.
- **Authority-set handoffs.** A self-contained-from-genesis proof would also fold the warp-sync fragment chain (more Ed25519 justifications) — brief 10 §2's per-handoff cost, now in-circuit.

**Architectural verdict: keep finality OFF-circuit; fold it in only for self-contained third-party verifiability.** Brief 10's own recommendation is **Tier 1** — a **bounded, one-shot, off-circuit** justification check at restore (tens of ms; the wallet checks one historical `N`, not a stream). The wallet **already must obtain the trusted finalized `R_N` off-circuit** — it is the public-input anchor the IVC folds against (§2.1, §4.2; the circuit takes `R_N` as input, N1). Moving a cheap off-circuit Ed25519-batch-verify **into** an extremely expensive emulated-Ed25519 + SHA-512 + Blake2 in-circuit computation is a bad trade **for the wallet's own restore**: it multiplies prover cost by orders of magnitude to internalize a check the verifier can do itself in milliseconds. The clean separation is:

> **Recursion** transports "each step folded against the root the verifier supplied" (consistency). **Brief 10 Tier 1 (off-circuit)** supplies "that root is genuinely finalized `R_N`" (anchor authenticity). **Brief 06** supplies "the folded delta was complete" (completeness). Three concerns, three layers — do not collapse them into one circuit.

The **one** case that justifies in-circuit finality is a **self-contained PCD certificate** for a verifier who will *not* run its own finality check and trusts only the **genesis authority set** — e.g. a third-party auditor, or a fully-offline verifier. That is the Mina model, and it is coherent, but it converts the ratchet from "a wallet convenience" into "a chain light-client-in-a-SNARK" — a distinct, much larger research program whose cost is dominated entirely by Ed25519/SHA-512/Blake2, not by the wallet logic. **Recommendation: design `AssignedState` to carry `R_N` (and the finalized block hash) as the anchor field so that in-circuit finality *could* be added later as a self-contained-PCD upgrade, but ship with finality verified off-circuit per brief 10 Tier 1.** (This mirrors brief 05 §6's "defer V3-full, keep the record shape open" discipline.)

---

## 7. Note, do not conflate: the completeness SOUNDNESS gap is orthogonal to recursion

Brief 07 §3.1/§3.3/§7 Q1 isolates **two distinct walls** for a completeness proof, and recursion touches only one:

- **The succinctness wall** — a completeness proof is ∝ prefix-leaves with "no IVC to fold it." **Recursion demolishes this** (§5): fold the chunks into O(1) + delta.
- **The soundness wall** — the note **ciphertext is off-tree** (`Output.ciphertext`, brief 06 §2.4), so `R_N` does not authenticate what the "not-mine" branch must decrypt; a witness supplier can feed a garbage ciphertext for a leaf that is genuinely the wallet's, and the circuit *soundly but wrongly* certifies "not mine." **Recursion does nothing here.** Folding an unsound per-step relation a million times yields a succinct proof of an unsound statement. Closing it needs an **authenticated commitment↔ciphertext binding** — a Substrate body-inclusion proof or a header-committed ciphertext accumulator (brief 06 §2.4, brief 07 §7 Q1): a **node/protocol change**, upstream of and independent from recursion.

So recursion is an **efficiency** enhancement to the *consistency/succinctness* dimension; it is **orthogonal** to the completeness *soundness* residual, which briefs 06 and 07 correctly locate at the node/protocol layer. State both when presenting the ratchet, or it will be read as closing a gap it does not touch.

---

## 8. Feasibility summary and recommendation

**Feasibility: unusually high for a "recursive proof" proposal, because the primitive is in-house** — but gated by integration, not cryptography. Every ingredient exists in Midnight's own published crates: IVC (`aggregation/src/ivc/`), PCD for heterogeneous deltas (`multi_circuit_aggregator/`), the in-circuit KZG verifier + `DualMSM` accumulator (`circuits/src/verifier/`, `proofs/src/poly/kzg/msm.rs`), Poseidon (`ZkStdLibArch.poseidon`), and — decisively — **hybrid trees whose internal digests are Poseidon field elements** (§3.4) so the completeness fold is cheap in-circuit. The gaps are all **integration**: (i) not wired into any shipped path (grep of `midnight-ledger`/`-node`/`-wallet` for `midnight-aggregation`/`::ivc::` is empty); (ii) needs a **new native-Rust prover** (the `:6300` server has no recursion, §3.6); (iii) the TS-wallet bridge (sidecar prover + WASM verifier, §5); (iv) a heavy per-step prover constant (§2.2).

**Recommendation.** Prototype the ratchet as a native-Rust IVC over `midnight-aggregation`: `AssignedState = (checkpoint cursor + Poseidon frontier commitment + anchor R_N/finalized-hash field)`; `Witness = the brief-06 ADS delta`; `circuit_transition` **internalising the collapsed-update completeness check** (pure Poseidon, §3.4). Verify **client-side** at restore (`IvcVerifier::verify`); verify **finality off-circuit** per brief 10 Tier 1. Scope it as the **upgrade path** brief 03 §7 and brief 07 §7 Q2 both named — the tool that folds brief 07's ∝-prefix v-strong completeness proof into O(1)+delta — not as a replacement for brief 07's buildable-today v-lightweight certificate (for which a fresh standalone proof is simpler). It eliminates re-scanning `[birthday, N]` and compresses the whole certified history to O(1), while leaving the live `[N, tip]` catch-up, the finality anchor (brief 10), and the two irreducible ADS/consensus soundness residuals (briefs 06/07) exactly where those briefs left them.

---

## 9. Sources

**Local source (read-only, 2026-07-21):**
- `~/repos/midnight-zk` (cloned this session, github.com/midnightntwrk/midnight-zk):
  `README.md` (proofs=PLONK/KZG, curves=BLS12-381+JubJub, halo2 v0.3.0 fork);
  `aggregation/src/ivc/mod.rs:14-20,55-128,186-208` (IVC framing: constant proof/verify, traits),
  `aggregation/src/ivc/circuit.rs:39-44,68-86,137-224` (single-step relation: self-verify + transition + accumulate; genesis case),
  `aggregation/src/ivc/prover.rs:49-53,62-147` (`prove_step`: transition, `plonk::prepare`, `from_dual_msm`, `accumulate`, `collapse`, prove one IVC circuit; `resume_from`),
  `aggregation/src/ivc/verifier.rs:5-6,49-88` (constant-time verify = prepare + single pairing; decider),
  `aggregation/src/ivc/setup.rs:24-59` (universal KZG SRS, genesis prover),
  `aggregation/examples/ivc.rs:30-38,122-197` (Poseidon hash-chain State{cnt,val}; K=17, N=1000/step),
  `aggregation/src/multi_circuit_aggregator/mod.rs:1-45` (PCD over heterogeneous circuits; Poseidon claims chain; "says nothing about *what* was proved"),
  `circuits/src/verifier/types.rs:52,138-200` (`SelfEmulation`/`BlstrsEmulation`: F=BLS12-381 scalar `Fq`, C=G1Projective, Engine=Bls12; BnEmulation),
  `circuits/src/verifier/{kzg.rs,msm.rs,accumulator.rs,verifier_gadget.rs}` (in-circuit KZG verifier + accumulator),
  `proofs/src/poly/kzg/msm.rs:205` (`DualMSM`), `proofs/src/plonk/verifier.rs:371` (`prepare`),
  `proofs/Cargo.toml:60`, `curves/Cargo.toml:54` (`cfg(target_arch="wasm32")` targets → WASM-compilable prover);
  `zk_stdlib/src/lib.rs:111,121-167,297` (`ZkStdLibArch` toggles: poseidon/sha2_256/**sha2_512**/keccak_256/**blake2b**/secp256k1/p256/bls12_381/**curve25519**/jubjub; `Curve25519Chip = ForeignEdwardsEccChip`),
  `circuits/src/ecc/foreign/edwards_chip.rs:1002-1041` (foreign-Edwards windowed `msm` → in-circuit Ed25519 point ops).
- `~/repos/midnight-ledger`:
  `transient-crypto/src/hash.rs:60-101` (`transient_hash` = Poseidon; `degrade_to_transient` persistent↔transient bridges),
  `transient-crypto/src/merkle_tree.rs:194-210,275,301-405` (**hybrid tree**: SHA-256 `persistent_hash` leaf `:194-198`, Poseidon `transient_hash` internal nodes `:208-210`; `MerkleTreeDigest(Fr)` `:275`; collapsed-update bridge),
  `ledger-wasm/` (`@midnight/ledger` — precedent Rust→TS proving bridge), `zkir-wasm/`, `zkir-v3-wasm/`, `wasm-proving-demos/`;
  `zkir/`, `zkir-v3/` (Compact→circuit compiler, **no recursion opcode**); confirmed `midnight-aggregation`/`::ivc::` unused across `midnight-ledger`, `midnight-node`, `midnight-wallet`.
- `~/repos/umbradb-snapshot-design/.../01–07, 10` (built upon throughout — esp. **07** §1.5/§3.3/§7 Q2 the ZKIR-no-recursion finding + open in-circuit-verifier question 08 answers; **07** §3.1/§7 Q1 the soundness wall; **10** §1-3,5 GRANDPA justification = Ed25519 threshold sig + Blake2 state-read-proof, Tier-1 one-shot off-circuit check; **06** the ADS delta; **03** §3c/§7 the anchor residual).

**Papers / specs (primary):**
- Kothapalli, Setty, Tzialla, *Nova: Recursive Zero-Knowledge Arguments from Folding Schemes*, CRYPTO 2022. https://eprint.iacr.org/2021/370
- Kothapalli, Setty, *SuperNova: Proving universal machine executions without universal circuits*. https://eprint.iacr.org/2022/1758
- Kothapalli, Setty, *HyperNova: Recursive arguments for customizable constraint systems*, CRYPTO 2024. https://eprint.iacr.org/2023/573
- Bünz, Chen, *ProtoStar: Generic Efficient Accumulation/Folding for Special-Sound Protocols*, ASIACRYPT 2023. https://eprint.iacr.org/2023/620
- Bünz, Chiesa, Mishra, Spooner, *Proof-Carrying Data from Accumulation Schemes*, 2020. https://eprint.iacr.org/2020/499
- Bowe, Grigg, Hopwood, *Recursive Proof Composition without a Trusted Setup* (Halo), 2019. https://eprint.iacr.org/2019/1021
- Boneh, Drake, Fisch, Gabizon, *Halo Infinite: Proof-Carrying Data from Additive Polynomial Commitments* (atomic accumulation for KZG), 2020. https://eprint.iacr.org/2020/1536
- Polygon Zero, *Plonky2: Fast Recursive Arguments with PLONK and FRI*. https://docs.rs/crate/plonky2/latest/source/plonky2.pdf ; https://polygon.technology/blog/introducing-plonky2
- Mina, *22kB-Sized Blockchain — A Technical Reference*. https://minaprotocol.com/blog/22kb-sized-blockchain-a-technical-reference ; Pickles accumulation, https://o1-labs.github.io/proof-systems/pickles/accumulation.html
- Valiant, *Incrementally Verifiable Computation* (TCC 2008); Chiesa, Tromer, *Proof-Carrying Data and Hearsay Arguments* (ICS 2010) — IVC/PCD definitions.

No source was modified; no code was committed.
