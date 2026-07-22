# Angle 10 — GRANDPA finality proofs and a trustless anchor for "block N is finalized"

Deep-research brief, 2026-07-21. Scope: whether a restoring wallet can verify,
without trusting an indexer or RPC endpoint, that (a) block `N` is GRANDPA-final
and will not revert, and (b) the Midnight-specific state commitment `R_N`
(`pallet_midnight::StateKey`, per brief 01) is genuinely the value stored in `N`'s
header. This is angle 10 of the "verifiable wallet-state snapshot root-of-trust"
research, building directly on 01 (`midnight-state-commitments.md`) and 03
(`authenticated-snapshot-integrity.md`), which both named "the anchor's trust
reduces to the chain's consensus/finality" as the one residual assumption they
deferred. This brief closes that gap as far as it can be closed and states
exactly what remains irreducible.

All local citations are `repo/path:line` against `~/repos/midnight-node`
(Midnight's fork/config of the pattern) and against the exact `polkadot-sdk`
commit midnight-node's `Cargo.toml` pins (git tag `polkadot-stable2606`,
cached checkout `~/.cargo/git/checkouts/polkadot-sdk-dee0edd6eefa0594/660acef`,
read 2026-07-21). Doc citations are marked with URLs.

---

## 0. The one-sentence answer

**Yes — with a caveat on the authority-set bootstrap.** A wallet that already
knows (i) the genesis GRANDPA authority set (public, part of the chain spec)
or (ii) any single subsequent authority set it once verified, can walk forward
through GRANDPA justifications / warp-sync fragments to an arbitrary current
authority set with **zero trust in any RPC or indexer** — every step is a
locally-checkable Ed25519 threshold-signature proof over a chain of headers.
Given that verified header for `N`, `state_getReadProof` plus
`sp_state_machine::read_proof_check` reads `pallet_midnight::StateKey` (hence
`R_N`) out of `N`'s trie **with the same zero-trust guarantee**, because the
proof is checked against the header's own `state_root`, not against whatever
served it. The residual trust is exactly two things, both irreducible and both
small: the genesis authority set is trusted once (weak subjectivity, shared by
every PoS/BFT light client design), and the wallet must not be fed a header
that only *looks* canonical — i.e. it must fetch `N`'s hash from
`chain_getFinalizedHead` (or better, from its own tracked best-finalized state)
rather than accept an arbitrary caller-supplied hash unchecked.

---

## 1. GRANDPA justifications and what a light client can check (RQ1)

**What a justification is.** A `GrandpaJustification<Header>` bundles (i) a
GRANDPA `Commit` — the target block plus the set of signed precommits that
carried it past the ⅔-of-voting-weight threshold — and (ii) `votes_ancestries`,
the header chain needed to prove every precommit's target routes back to the
commit's base block:

```rust
pub struct GrandpaJustification<Block: BlockT> {
    pub justification: sp_consensus_grandpa::GrandpaJustification<Block::Header>,
    _block: PhantomData<Block>,
}
```
`polkadot-sdk/substrate/client/consensus/grandpa/src/justification.rs:38-42`
(commit above `polkadot-stable2606`, checkout `660acef`).

**Verification is fully local and stateless given `(set_id, authorities)`.**
`GrandpaJustification::verify_with_voter_set` (same file, lines 166-233):
constructs an `AncestryChain` purely from the justification's own
`votes_ancestries`, calls `finality_grandpa::validate_commit(&commit, voters,
&ancestry_chain)` to check the precommits reach the ⅔ voting-weight threshold,
then iterates every signed precommit and checks its Ed25519 signature via
`sp_consensus_grandpa::check_message_signature_with_buffer(...)` — no network
call, no external state, just the justification bytes plus the caller-supplied
`(set_id, authorities: AuthorityList)`. This is the entire trust-reduction: **if
you already know the correct authority set for `set_id`, you can verify
finality of any block the justification names with nothing else.**

**RPC surface.** Midnight exposes the standard Substrate GRANDPA RPC set,
confirmed live in the node:
- `grandpa_proveFinality(block: Number) -> Option<EncodedFinalityProof>` —
  `midnight-node/node/src/rpc.rs:190-205` wires
  `sc_consensus_grandpa_rpc::Grandpa::new(...)` into the RPC module; declared in
  `polkadot-sdk/.../grandpa/rpc/src/lib.rs:47-64` (the `#[rpc]` trait) and listed
  as a live method name in `midnight-node/node/src/openrpc.rs:96-98,485-487`.
- `grandpa_roundState`, `grandpa_subscribeJustifications` — same files, same
  lines; useful for liveness/monitoring, not for the anchor proof itself.
- `state_getReadProof(keys, at) -> ReadProof<Hash>` — declared
  `polkadot-sdk/.../client/rpc-api/src/state/mod.rs:117-120`; live in Midnight,
  `midnight-node/node/src/openrpc.rs:91,481` (§3 below uses this).

`grandpa_proveFinality`'s actual behavior (not just its signature) matters for
correctness: the doc comment on `prove_finality` in
`polkadot-sdk/.../grandpa/src/finality_proof.rs:19-33` states the exact
contract — *"Finality of block B is proved by providing: 1) the justification
for the descendant block F; 2) headers sub-chain (B; F] if B != F; 3) proof of
GRANDPA::authorities() if the set changes at block F… If authorities set has
changed several times in the (U; F] interval, multiple finality proof
fragments are returned… and they must be verified in-order."* Concretely, the
RPC response is a `FinalityProof<Header>` —
`polkadot-sdk/.../grandpa/src/finality_proof.rs:139-146` —
`{ block: Hash, justification: EncodedJustification, unknown_headers:
Vec<Header> }`. The wallet does not need block `N` itself to carry a
justification (Midnight's default `GRANDPA_JUSTIFICATION_PERIOD` is 512 blocks,
`midnight-node/node/src/service.rs:241`, i.e. full justifications are only
*persisted* roughly every 512 blocks plus at every authority-set change) —
`grandpa_proveFinality(N)` finds the nearest justified descendant `F ≥ N`,
returns its justification plus the `(N, F]` header chain, and the wallet
verifies the whole bundle as one unit (headers link by parent-hash, the
justification finalizes `F`, therefore `N` is finalized too, since GRANDPA
finalizes chains not blocks — `polkadot-sdk/.../grandpa/src/justification.rs`
ancestry-chain check, above).

---

## 2. Authority-set bootstrap and tracking (RQ2)

This is the one place genuine "weak subjectivity" enters, exactly as in every
BFT/PoS light client (Cosmos IBC light clients and Ethereum's post-merge
sync-committee light clients have the identical shape: trust one validator/
committee set once, then follow signed handoffs forward).

**Where the trust root lives.** Midnight's genesis GRANDPA authority set is
built into the chain spec from each node's `initial_authorities()` —
`midnight-node/node/src/chain_spec/mod.rs:90-114,240-288` populates
`SessionKeys{ grandpa: get_from_seed::<GrandpaId>(s), … }` per validator, and the
chain spec (a public, hash-checkable artifact distributed with every node
release, `midnight-node/res/…`) is the canonical source. **A wallet's minimal
trusted input is the chain-spec-derived genesis authority set and genesis hash**
— equivalent to hard-coding a checksum in the client, the same trust model
every Substrate light client (and every other chain's light client) uses.

**Following authority-set changes trustlessly — warp sync.** Substrate's GRANDPA
warp-sync mechanism formalizes exactly the "follow the handoffs forward" step,
and Midnight runs it: `midnight-node/node/src/service.rs:591-593,607` wires
`sc_consensus_grandpa::warp_proof::NetworkProvider::new(...)` into
`WarpSyncConfig::WithProvider(warp_sync)`. The proof structure:

```rust
pub struct WarpSyncFragment<Block: BlockT> {
    pub header: Block::Header,               // last block finalized by set S
    pub justification: GrandpaJustification<Block>, // justification under set S
}
pub struct WarpSyncProof<Block: BlockT> {
    proofs: Vec<WarpSyncFragment<Block>>,
    is_finished: bool,
}
```
`polkadot-sdk/.../grandpa/src/warp_proof.rs:64-78`. Verification
(`WarpSyncProof::verify`, same file lines 205-247) starts from a caller-supplied
`(set_id, authorities)` — the trust root above — and, for each fragment in
order: (1) verifies the fragment's justification against the *current*
authority set (`proof.justification.verify(current_set_id,
&current_authorities)`), (2) checks the header actually contains a GRANDPA
`ScheduledChange` digest (`find_scheduled_change`), and (3) if so, advances
`current_authorities`/`current_set_id` to the new set and repeats. Every step
is checked against data already inside the previous step's verified output —
**no fragment is trusted because of who served it; each is only accepted
because the *previous* fragment's justification, verified under the
*previous* authority set, proved the handoff.** This is precisely a chain of
finality proofs, catenated: bootstrap once from genesis (or any prior trusted
checkpoint), then walk forward with zero additional trust.

`MAX_WARP_SYNC_PROOF_SIZE = 8 MiB` per proof message
(`polkadot-sdk/.../warp_proof.rs:61`) bounds a single round-trip; a long-lived
chain needs multiple round trips, which is fine — the accumulated verifier state
(`set_id`, `authorities`) is the only thing carried between them
(`GrandpaVerifier`/`VerifierState`, `warp_proof.rs:279-330`).

**Is a literal browser/mobile light client already wired up?** Not currently,
but the tooling exists one config flip away: `subxt` (Parity's Rust client,
already a dependency of Midnight's own BEEFY relay —
`midnight-node/relay/Cargo.toml:9`, `subxt = { workspace = true,
default-features = true }`) has an optional `light-client` feature that embeds
`smoldot` — a from-scratch Rust GRANDPA light client implementing exactly the
warp-sync + justification-verification protocol above. `smoldot-light` is
already present in `midnight-node/Cargo.lock` (lines ~16287-16354,18105-18122)
as a transitive dependency of `subxt-lightclient`, but no crate in the current
tree enables that feature (`default-features = true` on a bare `subxt` pulls in
`jsonrpsee`/native transport, not `light-client`) — so it is latent
infrastructure, not a running component.

---

## 3. Reading `R_N` trustlessly given a verified header (RQ3)

Once `N`'s header is verified (§1-2), extracting the Midnight-specific
commitment is a standard Substrate Merkle-Patricia storage-read proof, not
anything Midnight-specific.

**The storage item.** `StateKey<T> = StorageValue<_, Vec<u8>, ValueQuery>`
(`midnight-node/pallets/midnight/src/lib.rs:151-157`), written every block in
`on_finalize`: `StateKey::<T>::put(state_root)` where `state_root =
LedgerApi::apply_post_block_update(...)`
(`midnight-node/pallets/midnight/src/lib.rs:341-347` — matches brief 01 §1). The
pallet's `construct_runtime!` binding is `pub type Midnight =
pallet_midnight::Pallet<Runtime>;` (`midnight-node/runtime/src/lib.rs:1053`), so
`StateKey`'s trie key is the standard FRAME `StorageValue` derivation —
`twox_128("Midnight") ++ twox_128("StateKey")`, a single fixed 32-byte prefix,
no map hashing, no argument to guess.

**The proof.** `state_getReadProof(keys: [that one key], at: Some(N's hash)) ->
ReadProof<Hash>` — RPC trait at
`polkadot-sdk/.../client/rpc-api/src/state/mod.rs:117-120`, exposed live in
Midnight (`node/src/openrpc.rs:91,481`). Server-side this is
`sc_state_machine::prove_read` / `prove_read_on_trie_backend`
(`polkadot-sdk/.../primitives/state-machine/src/lib.rs`, the `TrieBackend` with
a recorder), which walks the Merkle-Patricia trie from the header's
`state_root` down to the target key, recording every trie node touched — a
standard compact Merkle inclusion proof, structurally identical to the
"logarithmic audit path" brief 03 §1 describes for RFC 6962's Merkle trees,
just over a Patricia trie instead of a binary tree.

**Client-side check — no trust in whoever answered the RPC.**
`sp_state_machine::read_proof_check::<H, _>(root: H::Out, proof: StorageProof,
keys) -> HashMap<Vec<u8>, Option<Vec<u8>>>`
(`polkadot-sdk/.../primitives/state-machine/src/lib.rs:829-846`): rebuilds a
`create_proof_check_backend` purely from `(root, proof)` and re-derives the
value for each key by walking the *proof's own* nodes — if any node doesn't
hash-chain to the given `root`, the check fails. **`root` here is `N`'s
`state_root`, which the wallet already has from the header it verified in §1-2
— never a value taken on faith from the RPC response.** This closes exactly the
gap brief 01 §6 gap-1 named: *"no Substrate state-proof (`state_getReadProof`)
or finality/header-chain verification wired into the wallet SDK today."* The
mechanism to close it is standard, already RPC-exposed, and needs zero new node
capability — only wallet-SDK plumbing (this is a build task, not a research
gap; scope of "wire it up" is out of this brief's remit).

**Sketch, end to end:**
1. Wallet holds trusted `(set_id, authorities)` (§2), tracks best-finalized
   height/hash it has itself verified.
2. `chain_getFinalizedHead()` (or the wallet's own tracked tip) gives a
   candidate finalized hash; `grandpa_proveFinality(N)` gives
   `{justification, unknown_headers}` (§1).
3. Verify the justification chain under `(set_id, authorities)`; if it spans an
   authority-set change, verify the intervening `WarpSyncFragment`s (§2) first
   and use the resulting `(set_id', authorities')`. Output: `N`'s header is
   authentic and finalized, in particular `N.state_root` is authentic.
4. `state_getReadProof([twox128("Midnight")+twox128("StateKey")], N.hash())`
   returns a `ReadProof`; `read_proof_check(N.state_root, proof, [key])`
   returns the actual `StateKey` bytes — this **is** the ledger content-address
   from brief 01 §1, and, per brief 01 §1's RPC mapping,
   `midnight_zswapStateRoot`/`midnight_ledgerStateRoot` are deterministic
   functions of exactly this value (`tagged_serialize` of the `Ledger`
   struct). No indexer, no full node's word — the wallet derived `R_N` from a
   proof checked against a root it verified itself.

---

## 4. BEEFY / bridging — does it help here? (RQ4)

**Yes, Midnight runs BEEFY, but for a different purpose than wallet snapshots,
and it does not directly commit to `R_N`.** BEEFY (Bridge Efficiency Enabling
Finality Yielder) is "*a secondary protocol to GRANDPA to support efficient
bridging between [a chain] and remote, segregated blockchains… In BEEFY, all
honest validators sign on a GRANDPA finalized block. This reduces the efforts
on the light client side, as tracking forks, GRANDPA justifications, etc., is
no longer necessary. [It] utilizes Merkle Mountain Ranges (MMR)… and the ECDSA
signature scheme (more efficiently verifiable on EVM). Light clients now only
have to check if the block has a super-majority of BEEFY votes."*
(Polkadot Wiki, *Learn Consensus*, "Bridging: BEEFY",
https://wiki.polkadot.com/learn/learn-consensus/, fetched 2026-07-21).

**Midnight's concrete wiring** (all confirmed live, not hypothetical):
`sc_consensus_beefy::start_beefy_gadget` runs alongside GRANDPA
(`midnight-node/node/src/service.rs:840-846`); `pallet_beefy`/`pallet_beefy_mmr`
are in the runtime (`midnight-node/runtime/src/lib.rs:466-528,1097-1103`); RPCs
`beefy_getFinalizedHead`/`beefy_subscribeJustifications`, and
`mmr_root`/`mmr_generateProof`, are live (`node/src/openrpc.rs:99-104`). There
is also a **standalone BEEFY relayer** in-tree,
`midnight-node/relay/{main.rs,relayer.rs,justification.rs}`, that bridges BEEFY
commitments to Cardano (partner-chains architecture) — using `subxt` to
subscribe to BEEFY justifications and encode them for Cardano consumption
(`relay/src/cardano_encoding.rs`).

**What the MMR leaf actually commits to** — and the gap this leaves. The
standard `MmrLeaf` shape is
```rust
pub struct MmrLeaf<BlockNumber, Hash, MerkleRoot, ExtraData> {
    pub version: MmrLeafVersion,
    pub parent_number_and_hash: (BlockNumber, Hash),  // ← chains to the header
    pub beefy_next_authority_set: BeefyNextAuthoritySet<MerkleRoot>,
    pub leaf_extra: ExtraData,                        // ← runtime-pluggable
}
```
(`polkadot-sdk/.../primitives/consensus/beefy/src/mmr.rs:53-64`). Midnight sets
`type BeefyDataProvider = ();` in `pallet_beefy_mmr::Config`
(`midnight-node/runtime/src/lib.rs:527`), and `impl BeefyDataProvider<Vec<u8>>
for () { fn extra_data() -> Vec<u8> { Vec::new() } }`
(`polkadot-sdk/.../beefy/src/mmr.rs:39-43`) — **`leaf_extra` is empty.** The
custom BEEFY payload Midnight *does* carry (`midnight-node/node/src/payload.rs`,
`MmrRootAndBeefyStakesProvder`, confirmed in §5 of this repo's own source) is
`{MMR root, current/next BEEFY stakes, current/next BEEFY authority-set
commitments}` — built for **committee handoff to the Cardano bridge**, not for
exposing `R_N`. So BEEFY gives a wallet an authenticated `parent_number_and_hash`
(a block hash) far more cheaply than a full GRANDPA warp-sync chain would (see
below), but reading `R_N` out of that authenticated header still requires the
same `state_getReadProof` step as §3 — BEEFY shortens step 1-3 of the §3 sketch,
it does not replace step 4.

**Why it would still be cheaper, if wired up for wallets.** Two independent
savings: (a) MMR membership proofs are `O(log leaves)` regardless of how far
back `N` is, vs. GRANDPA warp sync needing one `WarpSyncFragment` **per
authority-set change** between the wallet's last checkpoint and `N` (§2); (b)
ECDSA/secp256k1 signatures are what the BEEFY payload is signed with
specifically because they are cheaper to verify in constrained/foreign
environments (the wiki's stated rationale is EVM-friendliness, but the same
property — no pairing-friendly-curve or Ed25519 dependency needed — helps any
minimal client, e.g. a WASM/mobile wallet that doesn't want a full Ed25519
batch-verification stack). Neither saving currently reaches the wallet, because
(i) `leaf_extra` carries no ledger-state commitment, and (ii) no wallet-facing
BEEFY-based read-proof tooling exists in this tree.

---

## 5. Practicality: full client vs. k-of-n RPC, and the recommendation (RQ5)

**Cost of client-side GRANDPA verification.** Per justification: one
`finality_grandpa::validate_commit` (pure Rust, weight-threshold arithmetic
over the precommit set) plus one Ed25519 signature check per precommit
(`sp_consensus_grandpa::check_message_signature_with_buffer`,
`polkadot-sdk/.../grandpa/src/justification.rs:198-215`). Ed25519 verification
is on the order of tens of microseconds per signature in any modern
implementation (a widely-cited, non-Midnight-specific figure — no
Midnight-specific benchmark was run for this brief); even a large validator
set (Midnight's runtime bounds authorities at `MaxAuthorities = 10_000`,
`midnight-node/runtime/src/lib.rs:584` — a compile-time ceiling, not the actual
live committee size, which this brief did not find recorded in-repo) keeps this
in the low tens-of-milliseconds range for one justification. **This is cheap in
absolute terms.** The real cost driver is not CPU, it is **engineering
surface**: correctly implementing/maintaining warp-sync-fragment verification,
authority-set-change tracking, and the Merkle-Patricia proof checker inside a
wallet SDK (mobile/browser) is a nontrivial dependency to own, even though the
building blocks (`sp_consensus_grandpa`, `sp_state_machine`, or the `smoldot`
light client via `subxt-lightclient`, §2) already exist upstream.

**k-of-n RPC cross-checking, compared.** Querying `M` independent
node/indexer operators for `chain_getFinalizedHead` + `midnight_ledgerStateRoot`
(or an indexer's `Block.zswapMerkleTreeRoot`, per brief 01 §6) and accepting on
agreement is trivial to implement and reduces trust to "not all `M` operators
collude or are compromised simultaneously" — a social/operational trust
assumption, not a cryptographic one. It gives **no protection** against a
scenario where the operators genuinely are compromised or are all the wallet
vendor's own infrastructure (the common case for a hosted wallet backend) — the
exact scenario brief 03 §4's rollback/equivocation analysis worries about for a
remote DB, generalized to a remote RPC/indexer.

**Recommendation — three trust tiers, adopt progressively:**

1. **Tier 0 (ship now): k-of-n RPC/indexer cross-check.** Query ≥2-3
   independently operated endpoints (ideally not all controlled by one party)
   for `(N, N.hash, R_N)` and require exact agreement before accepting an
   anchor. Zero new cryptographic work; closes the "one indexer lies alone"
   case; does not close a coordinated-operator or single-vendor-hosts-everything
   case. This is the right default for most deployments today and matches what
   brief 01 §6 already recommends as immediately buildable.
2. **Tier 1 (medium lift): single GRANDPA justification check per anchor.**
   Wallet fetches `grandpa_proveFinality(N)` from **any** endpoint (now
   untrusted — the proof is self-certifying), verifies it against a
   **wallet-tracked** `(set_id, authorities)` that it updates via warp-sync
   fragments as authority sets change, then does the `state_getReadProof`
   read of §3 against the now-verified `N.state_root`. This removes the
   "trust the RPC's word" step entirely for the specific anchor being
   checked, at the cost of implementing/maintaining justification + read-proof
   verification (both are self-contained, well-scoped algorithms — no
   ongoing chain-following daemon is required, only "verify this one anchor
   on demand," since a wallet restoring from a snapshot only needs to check
   one historical `N`, not stream every block). **This is the recommended
   target for the snapshot-restore use case specifically**, because it is a
   bounded, one-shot check, not a persistent light-client process.
3. **Tier 2 (heavy lift, only if continuous trustless sync is a product
   requirement): full running light client.** Embed `smoldot` via
   `subxt-lightclient` (already latent in the dependency graph, §2) or build
   an equivalent, continuously tracking finalized head and authority set so
   the wallet always has a live, self-verified `(set_id, authorities, best
   finalized N)` with no per-restore RPC round-trip needed for the
   justification chain. Justified only if the wallet needs continuous
   trustless finality tracking beyond the one-shot restore check (e.g. a
   background daemon, not just a restore flow) — for the stated snapshot
   root-of-trust problem, Tier 1 already reduces the anchor's trust to
   consensus; Tier 2 buys operational independence from any RPC endpoint at
   all, at meaningfully higher integration cost.

**Bottom line for this design:** Tier 1 is sufficient to make the load-bearing
assumption in the prompt — *"the finality gadget does not revert ≤ N"* —
**verifiable, not merely assumed**, for the one-shot restore-time check this
design needs, using only RPC methods (`grandpa_proveFinality`,
`state_getReadProof`) already live on Midnight nodes today. BEEFY (§4) is not
needed to reach this; it would only sweeten Tier 1/2 if Midnight ever exposes a
ledger-state commitment in the MMR leaf's `leaf_extra` (currently empty) — worth
flagging to the node team as a cheap future win (a single extra field), but not
assumed or required by this recommendation.

---

## Sources

Local source (read-only):
- `~/repos/midnight-node`: `node/src/{rpc.rs,service.rs,openrpc.rs,payload.rs,
  chain_spec/mod.rs,subscription_bounds.rs}`, `runtime/src/{lib.rs,beefy.rs}`,
  `pallets/midnight/src/lib.rs`, `relay/src/{main.rs,relayer.rs,justification.rs,
  cardano_encoding.rs}`, `primitives/beefy/src/lib.rs`, `Cargo.toml`,
  `Cargo.lock`, `relay/Cargo.toml`.
- `~/.cargo/git/checkouts/polkadot-sdk-dee0edd6eefa0594/660acef` (git tag
  `polkadot-stable2606`, the exact commit midnight-node's `Cargo.toml` pins):
  `substrate/client/consensus/grandpa/{src/justification.rs,src/warp_proof.rs,
  src/finality_proof.rs,rpc/src/{lib.rs,finality.rs}}`,
  `substrate/client/rpc-api/src/state/mod.rs`,
  `substrate/primitives/state-machine/src/lib.rs`,
  `substrate/primitives/consensus/beefy/src/mmr.rs`.

Doc sources:
- Polkadot Wiki, *Learn Consensus* — GRANDPA description, probabilistic vs.
  provable finality, and the "Bridging: BEEFY" section quoted in §4.
  https://wiki.polkadot.com/learn/learn-consensus/ (fetched 2026-07-21)
- GRANDPA paper (Stewart, Kokoris-Kogias et al., W3F), referenced by the wiki
  page above as the formal source for the finality-gadget protocol:
  https://github.com/w3f/consensus/blob/master/pdf/grandpa.pdf

Prior briefs read first (per operating instructions):
- `01-midnight-state-commitments.md` — established `StateKey`/`state_root`,
  `midnight_zswapStateRoot`/`midnight_ledgerStateRoot`, and named "no
  Substrate state-proof or finality/header-chain verification wired into the
  wallet SDK" as gap 1, which §3 of this brief closes at the protocol level.
- `03-authenticated-snapshot-integrity.md` — established that every no-replay
  verification "must ultimately reduce the snapshot to a check against an
  on-chain commitment the wallet independently trusts," and that this
  anchor's trust "reduces to the chain's consensus/finality, which is outside
  [that brief's] scope." This brief is that scope.

No source was modified; no code was committed.
