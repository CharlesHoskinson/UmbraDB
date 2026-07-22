# Mithril-Style Committee Certification for Midnight — Research Note

**Branch:** `research/mithril-committee-certification` · **Date:** 2026-07-22 · **Status:** Research
finding informing future L3/bootstrap-trust decisions — not itself a design-council-ready proposal,
and not a v1 recommendation. Grounded in a completed 4-track audit of the real
`IntersectMBO/mithril` codebase (local checkout `/root/research/mithril`) plus a fifth track over
Midnight's own committee-selection code (`/root/midnight/midnight-node`). Follows the citation/rigor
discipline of `design/verifiable-snapshot-design.md` (**VSD**) and
`design/network-torrent-bootstrap-design.md` (**NTD**, `feature/network-torrent`, read via `git show
origin/feature/network-torrent:design/network-torrent-bootstrap-design.md`): concrete, sourced,
explicit about what's v1-buildable vs. protocol-change-gated vs. research-grade, no overclaiming.

---

## 0. Relationship to VSD and NTD — read this section before the rest

This note does **not** propose replacing either design's current L3/bootstrap-trust mechanism. It
answers a narrower question the task posed: is Cardano's Mithril (stake-weighted threshold-signature
snapshot certification) adoptable on Midnight, using Midnight's own federated consensus committee as
the signing set instead of Cardano SPOs — and if so, where would it actually slot in?

The honest answer requires first fixing a framing error the task's own hint gestures at and that this
note adopts explicitly: **there are three qualitatively different trust modes in play across VSD and
NTD, not two**, and Mithril-style certification is not a peer of "self-attestation" — it sits in a
specific, narrower gap between two mechanisms VSD and NTD already use. §2 makes this precise.

---

## 1. Executive summary

**Verdict: worth pursuing as a named future direction, not worth building now, and it fills a real
gap neither VSD's nor NTD's current mechanisms close.** Horizon: **not before** Midnight persists a
per-epoch, per-committee-member stake weight (§4 — a real protocol-side prerequisite that does not
exist today, not a polish item), and realistically a second-order priority behind NTD's already-shipped
fix and VSD's v1 rollout, because the gap it closes is real but narrow and already has an honest,
shippable stopgap (NTD's self-signed root-of-trust list, explicitly labeled as such).

The crypto core is genuinely reusable (`mithril-stm` has zero Cardano coupling — `Stake = u64`,
`Parameters{m,k,phi_f}` plain numeric, registration takes only `(verification key, stake weight)`,
`mithril-stm/src/lib.rs:193`, `mithril-stm/src/protocol/parameters.rs:21`). The aggregator/signer
service layer is not (`fork-and-swap`, not drop-in — signer identity is built on Cardano's
operational-certificate/KES scheme with no Midnight equivalent). And the one Midnight-side
prerequisite that actually gates buildability — a persisted per-epoch committee-weight structure — is
a real blocker discovered by this research, not an implementation nicety.

The single most valuable, immediately-applicable output of this research track is **not** "port
Mithril" — it is the **parameter-binding design rule** distilled from the real GHSA-724h-fpm5-4qvr
fix (§3.2), which is directly checkable, today, against both VSD's Compact attestation-contract sketch
and NTD's root-of-trust list schema (§6). That check should happen regardless of whether Midnight ever
builds anything Mithril-shaped.

---

## 2. Three trust modes, ranked — and where Mithril-style certification actually fits

Both VSD and NTD, read together, already converge on a strict preference order. Stating it explicitly
resolves what would otherwise look like three competing "L3-shaped" mechanisms:

### Mode 1 — Direct verification (strongest; use whenever reachable)

No attestation, no signer, no committee, no trust in any party's honesty beyond consensus/finality
itself. The client recomputes a commitment locally and compares it against a value obtained from a
**finality-checked on-chain query**. This is VSD's L0 (`assertLocalRootMatches` +
`fetchBlockAnchor` + Tier-0/Tier-1 finality, VSD §2/§4) and it is exactly what NTD's revision moved
its own bootstrap-upgrade path to after the 3-reviewer audit rejected the original self-attestation
contract (NTD §5.2: "recompute locally, then compare against a value obtained from a
finality-checked on-chain query... applies directly to archive data, one layer up the stack, with no
new contract and no publisher-key trust surface"). Forging Mode 1 requires breaking SHA-256 or
subverting GRANDPA finality itself — not compromising any signer's key. **Mode 1 is only available
when the client can already reach a finality-checked chain view** — an RPC/indexer endpoint plus a
trusted `(set_id, authorities)` weak-subjectivity seed (VSD §4).

### Mode 2 — Committee (Mithril-style) certification — the gap this research is about

For the residual case Mode 1 structurally cannot cover: **a client that has not yet synced far enough
to run its own finality check** — the true cold-bootstrap moment, before the client has fetched or
verified any header chain, before it has an RPC/indexer connection it trusts enough to run Tier-0/
Tier-1 against. A quorum of the chain's own consensus committee, signing a compact certificate over a
checkpoint/root via threshold aggregation, gives that client something to verify **without needing to
reach the chain directly first** — the certificate is small, self-contained, and checkable against a
committee public key the client bootstrapped once (the same weak-subjectivity shape VSD §10 point 1
already accepts for the genesis GRANDPA authority set). This is strictly stronger than Mode 3 because
forging it requires compromising a **threshold of a real, consensus-participating committee**, not one
organization's Ed25519 key — but it is strictly weaker than Mode 1 because it still requires trusting
that a majority-honest quorum signed correctly, and (per §4) trusting that the committee-weight data
it was built from is itself accurate.

**This is the exact gap NTD's PKI-TRUSTED window occupies today** (NTD §5.3's state machine,
`PKI-TRUSTED → CHAIN-VERIFIED`). NTD's revised design already correctly identifies that this window
exists and bounds it honestly (NTD §6 point 2) — it does not claim the window is free of trust. What
Mode 2 would change, if built, is *what backs that window*: instead of "the UmbraDB project's own
keypair, or eventually Shielded Labs/Foundation's keypair, asserts this" (Mode 3), the client would
be checking "a threshold of Midnight's own last-known committee attests this" — a broader, more
consensus-grounded trust basis for the identical window, not a different window.

### Mode 3 — Self-certification (weakest; a stopgap that must upgrade, never an end-state)

Single-key or single-org attestation. This is explicitly the pattern both design-council audits
(referenced in NTD's Revision history) found broken when it was proposed as an on-chain,
permissionlessly-forgeable *contract* (`attestArchiveSnapshot`, NTD §5.1) — "publishing to that map
only proves someone with a key claimed a value on a finalized chain... says nothing about whether the
claimed value corresponds to real chain data" (NTD §5.1, verbatim finding). NTD's fix was **not** to
strengthen the self-attestation (more co-signers, bonding/slashing, reputation) — NTD §5.2 explicitly
rejects that path: "every such variant still ultimately roots trust in someone's key(s) being honest...
dressing it up as an on-chain contract doesn't make it consensus-grade." NTD's root-of-trust list
(§4.3 tier 1, "UmbraDB signs its own list... not Shielded-Labs-endorsed") is Mode 3 used *correctly*:
labeled honestly as the weakest tier, explicitly bounded (NTD §6 point 2, point 7), and — critically —
**designed to always upgrade out of**, either to Mode 1 (NTD §5's direct recomputation, which runs
"automatically, by default, the moment it becomes possible, not a manual opt-in step," NTD §5.3) or,
if built, to Mode 2.

VSD's L3 self-attestation (the Compact "Attested Manifest Root," VSD §3(c)) is **also** Mode 3, but
answers a different question than NTD's list does, and this distinction matters for what follows in
§5: VSD's attestation is a wallet attesting **its own private state under its own key**, for
anti-rollback CAS purposes. There is no committee — Mithril or otherwise — that could stand in for
it, because no third party can attest to a wallet's private balance without either the wallet
disclosing it (defeating the purpose) or the committee not actually knowing the fact being attested.
Mode 2 does not compete with VSD's L3 at all; it only ever competes with, or could replace, the Mode-3
tier of a **public-data** bootstrap problem — which is exactly NTD's shape, not VSD's.

### The ranked takeaway

**Prefer Mode 1 always when reachable. Mode 2, if built, only ever backstops the specific window
where Mode 1 is not yet reachable — the cold-bootstrap moment before a client can run its own
finality check. Mode 3 should never be presented as an end state; every current design already
(correctly, post-revision) treats it as a labeled, bounded stopgap that upgrades to Mode 1 the moment
possible.** Mithril-style certification's real value proposition, stated precisely: it would let that
unavoidable stopgap window be backed by "a threshold of the chain's own consensus committee" instead
of "one organization's keypair" — a strictly better Mode-3-replacement for that one specific window,
not a general-purpose upgrade to anything else in either design.

---

## 3. What real Mithril actually offers (condensed audit findings, source-cited)

### 3.1 The crypto core (`mithril-stm`) is reusable close to as-is

Confirmed in the local checkout (`/root/research/mithril/mithril-stm`):

- `pub type Stake = u64;` (`mithril-stm/src/lib.rs:193`) — a plain alias, no ledger coupling.
- `pub struct Parameters { pub m: u64, pub k: u64, pub phi_f: PhiFValue }`
  (`mithril-stm/src/protocol/parameters.rs:21`) — pure numeric lottery/quorum parameters.
- Registration takes only `(verification key, stake weight)` — no pool ID, no ledger query, no
  Cardano-specific identity concept anywhere in the crate's public API.
- Aggregation requires no secret key: any party holding the same set of individual signatures
  produces the identical, independently-verifiable aggregate certificate. "Anyone can aggregate" is
  a code-level property, not a policy choice — this is what makes the scheme auditable by third
  parties who were never part of the signing committee.

**Verdict: the STM math and its `(id, weight)` abstraction are directly reusable as a dependency.**
The message being certified and the source of committee membership/weight are fully caller-supplied
and swappable — nothing in the crate assumes Cardano stake or Cardano identity.

### 3.2 The real GHSA-724h-fpm5-4qvr fix, and the design rule it distills

Root cause (confirmed against the actual fix commits in the local checkout, not just the advisory
text): protocol parameters governing lottery odds/quorum (`phi_f`, `k`, `m`) were **not** bound into
what got cryptographically signed. A legitimately-registered-but-locally-malicious signer could alter
them locally to fake quorum, and the fake-quorum signature would still verify — because nothing
forced the verifier's copy of the parameters to be the same bytes the signer actually used. The fix
required a full mainnet certificate-chain re-genesis (no forward-patch was possible once deployed).

The fix, confirmed by file:line in `/root/research/mithril/mithril-common/src`:

- `ProtocolMessagePartKey::NextProtocolParameters` (`entities/protocol_message.rs:124`) — next-epoch
  parameters become a **message part folded into the current epoch's signed protocol message**, not
  a value that travels alongside the certificate.
- `CertificateVerifier::verify_protocol_parameters_chaining`
  (`certificate_chain/certificate_verifier.rs:398`) — independently recomputes the expected next-epoch
  parameters and checks them against what the previous certificate actually committed to.
- `CertificateVerifier::verify_signed_message_matches_hashed_protocol_message`
  (`certificate_chain/certificate_verifier.rs:248`, invoked at `:200` and `:447`) — recomputes the
  message hash from scratch from the full `ProtocolMessage` and requires it to equal what was actually
  multi-signed. This is the general mechanism: "parameter travels alongside the signature" becomes
  "parameter is provably inside the signature."
- The newer, still-experimental SNARK/IVC path (feature-gated `future_snark`, confirmed in
  `mithril-stm/Cargo.toml:21-27,55-58`) goes further: `Parameters::to_rigid_bytes()`
  (`mithril-stm/src/protocol/parameters.rs`, `RIGID_PROTOCOL_PARAMETERS_BYTES`) and
  `ProtocolMessage::rigid_preimage()`/`compute_rigid_hash_bytes()`
  (`mithril-common/src/entities/protocol_message.rs:305,328,342`) bake the parameters directly into a
  fixed-width preimage that is **constrained inside the recursive proof itself** — forging them would
  invalidate the proof, not just fail an external re-derivation check. **This experimental path pins
  Midnight's own proving stack as dependencies** — `midnight-circuits = "=7.2.2"`,
  `midnight-curves = "=0.3.1"`, `midnight-proofs = "=0.8.1"`, `midnight-zk-stdlib = "=2.3.3"`
  (`mithril-stm/Cargo.toml:55-58`), all `optional = true` under `future_snark`, and marked
  not-for-production in the crate — a genuinely interesting signal that IntersectMBO is already
  building Mithril-on-Midnight-crypto for its own purposes (most plausibly Partner Chains), independent
  of anything Midnight or UmbraDB does. Worth monitoring, not depending on.

**The distilled, directly-reusable design rule** (this is the one output of this whole research track
that should be applied regardless of whether Mithril-style certification is ever built on Midnight):

> Everything that affects how a verifier will interpret or bound-check a **future** signature —
> thresholds, quorum/lottery parameters, committee-membership rules, protocol/version identifiers —
> must itself be inside the hash that gets signed at the previous step, chained forward exactly like
> the payload data is. If some piece of state is allowed to travel *next to* a signature instead of
> *inside* what was signed, it is an unauthenticated side-channel that a legitimately-registered-but-
> locally-malicious party can rewrite while still producing a signature that passes verification over
> data they genuinely do control.

Secondary lesson, from the companion advisory GHSA-qv97-5qr8-2266 (the ancillary-files gap): if a
primary aggregate-signature scheme structurally cannot cover some piece of data (non-determinism,
timing, size make it unsignable in-band), the right response is **not** to ship that data unsigned and
implicitly rely on the main scheme's reputation to cover it — wrap it in an explicit, separate,
honestly-scoped single-key mechanism with its own clearly-disclosed trust assumption, rather than
silently expanding what the primary scheme claims to guarantee. §6 applies both lessons concretely.

### 3.3 `mithril-aggregator`/`mithril-signer` — fork-and-swap, not drop-in

- **One well-isolated Cardano seam**: `trait ChainObserver` — confirmed 5 async methods in
  `mithril-cardano-node-chain/src/chain_observer/interface.rs:25-47`
  (`get_current_datums`, `get_current_era`, `get_current_epoch`, `get_current_chain_point`,
  `get_current_stake_distribution`, plus a defaulted `get_current_kes_period`). Genuinely swappable —
  already factored into its own crate, no other module reaches around it for chain state.
- **Signer identity is deeply Cardano-native and is not a config-swap**: built on Cardano's
  operational-certificate/KES cold-key scheme (`OpCert`, `party_id` = stake-pool ID). Midnight has no
  equivalent identity primitive for this role today — re-platforming means redesigning what "signer
  identity" *means* on Midnight, not swapping a `ChainObserver` implementation.
- `SignedEntityType` (confirmed `pub enum SignedEntityType` at
  `mithril-common/src/entities/signed_entity_type.rs:62`) is a closed Rust enum, not a plugin trait —
  adding a new certifiable artifact type (e.g., a Midnight-native checkpoint root) touches ~5-6
  well-defined call sites; contained by Rust exhaustiveness checks, but real engineering, not a config
  change.
- Genesis-ceremony code is the cleanest, most reusable piece — already Cardano-independent in shape,
  needs only a Midnight epoch source and a Midnight-populated key store to retarget.

**Verdict, unchanged from the completed audit: fork-and-swap.** Keep the STM math, the REST protocol
shape, the certificate-chain/epoch-round machinery, and the genesis ceremony. Replace `ChainObserver`.
Redesign signer identity from scratch (this is the larger of the two changes). Add one new
`SignedEntityType` variant for whatever Midnight-native artifact ends up certified.

---

## 4. Midnight's committee/stake structure — the real prerequisite gap

This is the section that determines the horizon in §1, so it is stated in full rather than summarized.

Midnight's committee is a genuine hybrid, and **not** naturally Mithril-shaped by default:

- **Registered candidates** get committee seats **weighted proportionally to real Cardano ADA stake
  delegation**, bridged via the Partner Chains mechanism and verified via genuine Cardano stake-pool
  cold-key signatures — this is the same `db-sync` `epoch_stake` table / Cardano stake snapshot
  Mithril itself already certifies on the Cardano side. Confirmed in the local `midnight-node`
  checkout: `filter_invalid_candidates.rs` computes each candidate's seat-selection weight directly
  from `c.stake_delegation` — `let weight = c.stake_delegation.0.into(); (Candidate::Registered(c),
  weight)` (`partner-chains/toolkit/committee-selection/authority-selection-inherents/src/
  filter_invalid_candidates.rs:120-121`) — i.e., the raw per-candidate stake number genuinely exists
  in-memory at selection time.
- **Permissioned candidates** are governance-appointed, carry **zero stake**, and get equal weight in
  seat selection regardless.
- **Critically: GRANDPA finality voting itself is flat** — one-authority-one-vote, hardcoded,
  regardless of how a sitting member got their seat (per the completed research: an explicit runtime
  test asserts `weight == 1` for every authority). Stake only ever determines the probabilistic
  **seat-allocation lottery**, once per epoch, at selection time — and the weight information used for
  that lottery is **discarded once seats are assigned**. There is no persisted, per-sitting-member,
  per-epoch numeric weight structure anywhere downstream that a Mithril-style STM quorum check could
  read directly today.

### What would actually need to exist before this is buildable (real blockers, not polish)

1. **Persist each committee member's `stake_delegation` at selection time, per epoch, keyed by
   sitting member.** The raw number exists transiently inside the selection algorithm
   (`filter_invalid_candidates.rs`, confirmed above) and, independently, in the indexer's
   `spo_stake_snapshot` (sourced from Blockfrost) — but neither is currently persisted in a form
   scoped to "this epoch's sitting committee, by member, for downstream signature-weighting use." This
   is genuinely new plumbing, not a read-path change: it means committing to a new epoch-scoped,
   per-member weight table (or equivalent on-chain/indexer artifact) that the current architecture has
   no reason to keep once seat selection completes. `stake_i / Σ stake_i` over that persisted set is
   the natural STM weight once it exists.
2. **An explicit, ratified policy decision for zero-stake permissioned members.** Three real options,
   none free: (a) exclude them from the STM signing set entirely (simplest, but shrinks the quorum
   and changes what "committee-certified" means relative to "the full sitting committee"); (b) assign
   them a nominal/floor weight (arbitrary, needs justification, changes the security-parameter math);
   (c) gate STM-style certification on the SDK's own stated bootstrap-to-trustless philosophy — i.e.,
   only enable it once the permissioned-seat fraction (the D-parameter) has trended toward zero, so
   the scheme approaches Mithril's Cardano-side assumption (all seats are genuinely stake-weighted)
   rather than papering over a large equal-weight bloc with an arbitrary number.

**Neither of these exists today, and both require either a Midnight runtime/pallet change (1) or a
governance decision with real security-parameter consequences (2) before an STM committee scheme is
even meaningful, let alone buildable.** This is why §1's horizon is stated as "not before" rather than
"deprioritized" — it is a genuine sequencing dependency, not a matter of engineering priority alone.

---

## 5. Direct comparison to the current L3/bootstrap mechanisms

| | Mode 1 — Direct verification (VSD §2 L0 / NTD §5) | Mode 2 — Mithril-style committee cert (this research) | Mode 3 — Self-certification (VSD §3(c) / NTD §4.3 tier 1) |
|---|---|---|---|
| Trust basis | SHA-256 + GRANDPA finality only | Threshold of last-known committee, honestly weighted | One key/org's honesty |
| Buildable today? | **Yes**, both VSD and NTD already ship it | **No** — blocked on §4's persistence + policy prerequisites | **Yes**, already the shipped stopgap in both docs |
| Answers "is this the client's own private state, correct"? (VSD's actual L3 question) | N/A — VSD's L0 already answers this for wallet snapshots | **No** — a committee cannot attest private balance data without either disclosure or not knowing the fact | Yes — this is precisely what VSD's L3 self-attestation is for; no committee substitutes for it |
| Answers "is this public archive/checkpoint data genuine, before I can check finality myself"? (NTD's actual question) | Not yet reachable in the cold-bootstrap window by definition | **Yes — this is the one gap Mode 2 actually closes** | Yes, but with the narrowest trust basis of the three, and only as an explicitly-labeled, must-upgrade stopgap |
| New trust surface introduced | None beyond what VSD §10/NTD §6 already accept | A new committee-weight persistence path (§4) + a new quorum-forgery surface if parameter-binding (§6) isn't applied | A single keypair (or later, Shielded Labs'/Foundation's) |
| Cost to build | Already built | New Midnight-side prerequisite (§4) + fork-and-swap aggregator/signer (§3.3) + parameter-binding audit (§6) | Already built |

**Is Mode 2 strictly better than Mode 3, complementary, or a different problem?** Strictly better
**for the identical bootstrap window NTD's PKI-TRUSTED tier already occupies** — same job, broader and
more consensus-grounded trust basis. It is a **different problem** relative to VSD's L3, which Mode 2
cannot substitute for at all (§2). It is **not** a substitute for Mode 1 anywhere either design already
reaches Mode 1 — NTD's own revision already established that once direct recomputation is reachable,
it should run "automatically, by default, the moment it becomes possible" (NTD §5.3), which leaves no
role for a committee certificate to play once that point is reached.

---

## 6. The parameter-binding lesson, applied concretely to VSD and NTD today

This is actionable regardless of whether anything Mithril-shaped is ever built, and should be treated
as a design-council checklist item for both documents' next review pass.

### 6.1 VSD's Compact "Attested Manifest Root" contract (VSD §8, `attest` circuit)

The core CAS check — `assert(prev.height < height, "attestation must advance")` — is fine: `prev` is
read from the on-chain `attestations` map itself, so the monotonicity parameter (what counts as "an
advance") is checked against genuinely on-chain, prior-committed state, not an unauthenticated
side-channel. Domain-separation strings (`"umbradb:attest:v1:id"`, `"umbradb:attest:v1:salt"`) are
compiled into the circuit, so they change the `vk` itself if ever revised — also structurally bound,
not a travels-alongside parameter, in the same spirit as the SNARK/IVC path in §3.2.

**Where the lesson has not yet been applied, and should be, before this contract is finalized:** VSD
§12's own "Secondary" open-decisions list already flags, without connecting it to this failure class,
"contract governance / immutability + pinned vk versioning across protocol upgrades (brief 05 Q4, brief
07 §6.3)." Read against §3.2's rule directly: if a future version of the `attest` circuit (a new `vk`)
is ever introduced, and the *authorization to accept records under the new `vk` as continuing the same
wallet's history* is decided purely by **contract governance** rather than being cryptographically
chained forward from the *previous* `vk`'s own signed history (e.g., a `history`-tree-committed
"vk-transition" record itself signed under the old `sk_attest`), then contract-governance compromise
becomes exactly the unauthenticated side-channel GHSA-724h-fpm5-4qvr describes — a party who never
compromised any individual wallet's `sk_attest` could still redefine what "a valid continuation of this
wallet's attestation history" means for future verifiers, purely by controlling governance. **Concrete
recommendation for VSD's next revision of §12 Q4:** require any future vk transition to be represented
as an on-chain record chained from (signed under, or otherwise cryptographically bound to) the prior
vk's own history — not merely permitted by contract-governance action alone — before ratifying that
open decision.

### 6.2 NTD's root-of-trust list schema (NTD §4.2/§4.4)

NTD's §4.4 already gets the **quorum-vs-mirroring** distinction right in the direction this lesson
cares about most ("independently-hosted mirrors of a list signed by a single key are NOT equivalent"
to threshold signing) — that is the lesson correctly internalized for the mirroring case.

**Where the lesson has not yet been applied:** the schema in §4.2 lists a `signatures` array
(`{keyId, algorithm, signature}`) but **the authorized signer set and the threshold `m` itself — "how
many of which keyIds count as enough" — do not appear anywhere in the signed document**. §4.4 describes
quorum policy only in prose ("an m-of-n threshold signature (e.g., 2-of-3 or 3-of-5)") and describes key
rotation only as an operational process ("a new key is published with an overlap window before the old
one stops being honored for new entries") — but does not specify **who authorizes a rotation event**,
or how a verifier is supposed to tell a genuine rotation from an attacker who has compromised enough of
the current quorum to add their own key to what future verifiers will treat as trusted. Applying
§3.2's rule directly: the *next* authorized signer set and threshold are exactly the kind of thing that
"affects how a verifier will interpret or bound-check a future signature" — and per the rule, that
means the rotation event itself should be **inside** what the current quorum signs (a
`nextAuthorizedKeyIds`/`nextThreshold` field in the current, quorum-signed list, analogous to
`NextProtocolParameters`), not an out-of-band publication a verifier's local config decides to trust
on its own. As specified today, a verifier's notion of "the current authorized signer set" is sourced
from wherever that verifier's config says to look, not from anything the previous quorum itself
committed to — which is precisely the "parameter travels alongside the signature" shape the real
Mithril CVE shows is forgeable by anyone who reaches that side-channel, even without compromising the
main signing keys. **Concrete recommendation for NTD's next revision of §4.4:** add a
`nextAuthorizedKeyIds`/`nextThreshold` (or equivalent) field to the quorum-signed list itself,
required to match on the following list's actual signer set before a rotation is honored, closing this
exact gap the same way `NextProtocolParameters` closes it for Mithril.

---

## 7. Reuse strategy recommendation

Given the fork-and-swap verdict (§3.3) and the reusable STM math (§3.1):

1. **Do not attempt to build Mode 2 now.** §4's prerequisites (persisted per-epoch committee weights,
   a ratified permissioned-member policy) are not in place, and the gap it closes already has an
   honest, shipped stopgap (NTD's Mode-3 self-signed list, correctly labeled and bounded).
2. **Flag Mode 2 as a real future direction, contingent explicitly on §4's prerequisites landing** —
   most naturally as something to revisit if/when Midnight's committee-selection pallet gains reasons
   of its own to persist per-epoch member weights (e.g., for slashing, rewards, or other consensus
   features that would need the same data), at which point the marginal cost of also exposing it for
   an STM-style certification scheme drops substantially. Do not treat this as UmbraDB's or this
   research's job to build the persistence layer to unlock it — that is a Midnight-node/runtime-team
   decision with consequences well outside UmbraDB's scope.
3. **When/if it is built, follow the fork-and-swap pattern (§3.3), not a rewrite:** take `mithril-stm`
   as a dependency close to as-is (its `(id, weight)` abstraction already fits — feed it Midnight
   committee member IDs and the persisted per-member weight from §4 item 1); reuse the
   certificate-chain/epoch-round machinery and genesis-ceremony code; write a Midnight-native
   `ChainObserver` implementation (the one clean, already-proven-swappable seam); design Midnight
   committee-member signer identity from scratch (the real work, §3.3); add one new
   `SignedEntityType`-equivalent for whatever Midnight-native checkpoint/archive root gets certified.
4. **Apply §3.2's parameter-binding rule from day one of any such design** — do not repeat the mistake
   the real GHSA-724h-fpm5-4qvr required a mainnet re-genesis to fix. Any Midnight-native committee
   parameters (quorum `m`, seat-selection lottery parameters, the permissioned-weight policy decided
   in §4 item 2) must be bound inside what gets certified at the previous checkpoint, chained forward,
   exactly like Mithril's fixed version does.
5. **Monitor, do not depend on, the experimental SNARK/IVC path** (`future_snark`,
   `mithril-stm/Cargo.toml:21-27,55-58`). It is genuinely interesting that IntersectMBO is already
   building this on Midnight's own proving stack — worth periodically re-checking whether it has
   stabilized, since a Midnight-native committee-certification scheme built *after* that path matures
   could inherit an even stronger parameter-binding guarantee (in-circuit, not just re-derived) at
   effectively no extra design cost. It is explicitly not-for-production today and should not gate or
   be assumed by anything in this note's near-/mid-term recommendations.

---

## 8. Phasing table

| Capability | v1 / buildable now | Needs Midnight protocol change | Research-grade |
|---|---|---|---|
| Mode 1 — direct verification (VSD L0, NTD §5 recomputation) | ✅ already designed/shipping in both docs | | |
| Mode 3 — self-signed root-of-trust list, honestly labeled, bounded (NTD §4.3 tier 1) | ✅ already designed | | |
| Parameter-binding audit of VSD's vk-versioning open decision (§6.1) | ✅ a design-review action item, no new code | | |
| Parameter-binding fix to NTD's rotation schema (§6.2, `nextAuthorizedKeyIds`) | ✅ a schema addition, no new trust primitive | | |
| `mithril-stm` crate as a dependency for a future Midnight committee-cert scheme | ✅ the crate itself is reusable today | blocked on the prerequisite below before it's *meaningful* | |
| Persisted per-epoch, per-member committee stake weight | | ✅ **real blocker** — needs a `midnight-node`/pallet change (§4 item 1) | |
| Ratified zero-stake permissioned-member weighting policy | | ✅ **real blocker** — governance decision (§4 item 2) | |
| Midnight-native `ChainObserver` + committee-member signer identity | | ✅ once the above land — fork-and-swap engineering (§3.3) | |
| Full Mithril-style Mode 2 committee certification for Midnight | | ✅ gated on all of the above | |
| SNARK/IVC in-circuit parameter binding (`future_snark`) as the eventual cert mechanism | | | ✅ monitor; not-for-production today (§7 item 5) |

---

## 9. Honest residual / limitations — what this would NOT solve

Stated plainly, matching VSD §10's and NTD §6's discipline of never overclaiming:

1. **A Mithril-style Midnight committee scheme still needs a genesis bootstrap trust point, exactly
   like everything else.** The committee's own public key/membership must itself be bootstrapped once,
   out of band — the same irreducible weak-subjectivity seed VSD §10 point 1 and NTD §6 point 1 already
   accept for the GRANDPA genesis authority set. Mode 2 does not remove this; it is not a
   "trustless-from-nothing" mechanism, only a stronger-than-single-key one for a specific window.
2. **Midnight's committee stake is currently Cardano-ADA-sourced, not Midnight-native, and this has
   its own trust implications worth naming explicitly.** A Mode-2 scheme built on today's committee
   composition would be certifying Midnight checkpoints using a trust weighting that ultimately
   derives from Cardano stake-pool delegation data (bridged via Partner Chains, sourced from `db-sync`/
   Blockfrost) — not from anything Midnight-native. This is not disqualifying (Mithril itself
   certifies Cardano data using exactly this kind of stake data, and it is Midnight's real, live
   consensus-weighting mechanism today) but it means "certified by Midnight's committee" is not (yet)
   the same trust claim as "certified by a Midnight-native economic security mechanism" — it inherits
   whatever trust assumptions the Cardano-ADA-stake bridge itself carries, on top of whatever a
   client is trusting the committee-selection process to have done honestly.
3. **The flat one-authority-one-vote GRANDPA finality layer is untouched by any of this.** Mode 2
   would add a new, separately-weighted certification layer *alongside* GRANDPA, not change how
   GRANDPA itself votes — a design decision worth stating explicitly so a future reader does not
   assume STM weighting somehow also changes finality voting weight; per §4, it currently does not,
   and this note does not propose that it should.
4. **The permissioned-member policy decision (§4 item 2) has no objectively-correct answer, only
   trade-offs.** Whichever option is chosen changes the actual security parameter of any resulting
   quorum threshold — this needs to be a ratified governance decision with the trade-off stated
   plainly to whoever ratifies it, not a default an implementer picks quietly.
5. **This research did not verify the exact GRANDPA `weight == 1` runtime-test claim by file:line**
   (unlike §3's and §4 item 1's citations, which were independently spot-checked against local
   checkouts during this write-up) — it is carried forward from the completed research track's
   finding D as given, per this task's instruction to treat completed findings as ground truth.
   Whoever picks this note up for an actual design should re-locate and cite that specific test before
   treating it as load-bearing for a real proposal.
6. **Nothing in this note changes VSD's or NTD's v1 recommendations.** Both remain correct as
   currently designed for the problems they solve; this note adds a third, currently-unbuildable mode
   for a narrower problem, plus one immediately-actionable audit item each (§6).

---

*Grounding: `mithril-stm/src/lib.rs`, `mithril-stm/src/protocol/parameters.rs`,
`mithril-stm/Cargo.toml`, `mithril-common/src/certificate_chain/certificate_verifier.rs`,
`mithril-common/src/certificate_chain/certificate_genesis.rs`,
`mithril-common/src/entities/protocol_message.rs`,
`mithril-common/src/entities/signed_entity_type.rs`,
`mithril-cardano-node-chain/src/chain_observer/interface.rs` (all in local checkout
`/root/research/mithril`, spot-checked against the completed 4-track audit during this write-up, not
re-derived from scratch); `midnight-node/partner-chains/toolkit/committee-selection/
authority-selection-inherents/src/filter_invalid_candidates.rs` (local checkout
`/root/midnight/midnight-node`, spot-checked); `design/verifiable-snapshot-design.md` (VSD, cited
throughout, this branch); `design/network-torrent-bootstrap-design.md` (NTD,
`origin/feature/network-torrent`, read via `git show`). GHSA-724h-fpm5-4qvr and GHSA-qv97-5qr8-2266
per the completed research track's findings, cross-checked against the fix commits in the local
checkout above. No Midnight or Mithril source modified; nothing committed outside this design doc and
the VSD cross-reference in §0 of `design/verifiable-snapshot-design.md`.*
