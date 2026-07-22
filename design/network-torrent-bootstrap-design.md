# Network Module: BitTorrent Alternative Retrieval + PKI Bootstrap Trust — Design

**Branch:** `feature/network-torrent` · **Date:** 2026-07-22 · **Status:** Design draft, not yet council-reviewed.
**Scope:** design only — no working code in this change. Follows the rigor/citation discipline of
`design/verifiable-snapshot-design.md` (hereafter **VSD**): concrete, sourced, explicit about
what's deferred, explicit about honest residual trust, does not overclaim.

**Relationship to the other two active design tracks (do not duplicate, must compose):**

1. **Full-chain archival storage** (separate, in-progress research track, different agents): a
   content-addressed blob store generalizing `ckpt_chunks` into something like `chain_blobs`, for
   raw block/tx/proof payloads. This design does **not** define that schema. It treats it as "a
   SHA-256 content-addressed blob store, table/column names TBD" and defines a narrow interface
   (§2.1) that either that future store, or today's `CheckpointStore`, can satisfy.
2. **Verifiable wallet-state snapshot** (`feature/verifiable-snapshot`, council-reviewed, referred
   to throughout as **VSD**): the 4-layer L0–L3 architecture for proving a *wallet's* restored
   state is correct without replay. This design's §5 composes with VSD §3's L3 "Attested Manifest
   Root" Compact contract pattern rather than replacing it — it proposes a second, structurally
   identical but namespace-separated on-chain surface for *archive manifests* rather than *wallet
   state*, and an out-of-band PKI path that is explicitly weaker than and strictly subordinate to
   VSD's on-chain check.

---

## 1. rqbit research findings

Source: `github.com/ikatson/rqbit` — README (`raw.githubusercontent.com/ikatson/rqbit/main/README.md`),
root `Cargo.toml` (workspace manifest), LICENSE, and the GitHub commits/releases API, fetched
2026-07-22.

### 1.1 Library vs. CLI

It is a genuine Cargo **workspace**, not a monolithic CLI-only binary:

```
[workspace]
members = [
  "crates/rqbit",            # CLI binary
  "crates/librqbit",         # <- the library crate, published to crates.io
  "crates/buffers", "crates/clone_to_owned", "crates/bencode",
  "crates/sha1w", "crates/librqbit_core", "crates/librqbit_lsd",
  "crates/peer_binary_protocol", "crates/dht", "crates/upnp",
  "crates/tracker_comms", "crates/upnp-serve",
  "desktop/src-tauri",        # Tauri desktop app wrapping the web UI
]
```

`librqbit` is real, independently versioned (workspace is at `9.0.0-rc.0` as of this fetch — past
the `v9.0.0-beta.2` tagged release), and the README states directly: "rqbit ... Has HTTP API and
Web UI, and can be used as a library." So it is embeddable **in Rust** — but UmbraDB is TypeScript,
and there is **no** napi-rs/N-API/WASM binding published for `librqbit` (none referenced anywhere
in the README, workspace, or crate list). The only cross-language integration surface it ships is
the HTTP API.

### 1.2 HTTP/JSON API viability

Confirmed viable and sufficient for everything task 1 asked about. Default listen address
`127.0.0.1:3030`. From the README's HTTP API section:

| Capability | Endpoint |
|---|---|
| Add a torrent (magnet, HTTP URL, or local `.torrent` file) | `POST /torrents` |
| **Create a torrent from a local folder and start seeding** | `POST /torrents/create` |
| List all torrents | `GET /torrents` |
| Torrent details/progress/peer stats | `GET /torrents/{id}` |
| Stream a file with HTTP range/seek support | `GET /torrents/{id}/stream/{file_idx}` |
| Pause / resume | `POST /torrents/{id}/pause`, `POST /torrents/{id}/start` |
| Web UI (human debugging) | `GET /web/` |

This covers: add-by-magnet, progress polling, file listing, and seeding new content from local
files — everything the sidecar-over-HTTP hypothesis needed. What it does **not** confirm (not
found in the README excerpt fetched, needs verification against `librqbit`'s OpenAPI spec at
implementation time) is a dedicated endpoint that returns the raw per-piece hash list; the
`.torrent` metainfo itself carries those hashes and can be fetched/parsed, so this is a minor
implementation detail, not a viability blocker.

**Conclusion on integration shape:** sidecar process + local HTTP calls, as the task's working
hypothesis predicted. No FFI/native-binding path exists to embed `librqbit` directly in a Node
process, and even where a hypothetical binding existed, the HTTP-sidecar shape is preferable here
anyway — it gives process isolation, independent crash/restart handling, and zero ABI coupling to
Node's N-API version, at the cost of one extra process and one loopback HTTP hop.

### 1.3 BEP 52 (BitTorrent v2 / SHA-256) — **not supported**

This matters a lot for the design and the finding is negative. The README's "Supported BEPs"
section lists BEP-3, 5, 7, 9, 10, 11, 12, 14, 15, 20, 23, 27, 29, 32, 47, and 53 — it runs from
BEP-3 to BEP-53 but **BEP-52 is conspicuously absent**. Corroborated structurally: the workspace
has a crate literally named `crates/sha1w` (a SHA-1 wrapper) and no `sha2`/v2-hashing crate
anywhere in the member list. rqbit is a **BitTorrent v1 client**: flat SHA-1 piece hashing only.

**Consequence (see §2.2):** torrent piece hashes and UmbraDB's SHA-256 content hashes are two
independent hash domains that cannot be identity-mapped. The design below treats BitTorrent's own
integrity check as a cheap, untrusted early-reject filter only — the real trust boundary is
UmbraDB's own SHA-256 re-verification on ingest, exactly as `CheckpointStore.load()` already does
today for local reads (`src/postgres/checkpoint-store.ts`: every chunk is rehashed and compared
against its stored hash before being returned, throwing `ChunkIntegrityError` on mismatch — the
same discipline extends unchanged to torrent-delivered chunks).

### 1.4 DHT (BEP 5) / PEX (BEP 11)

Both supported and explicitly listed: **BEP-5 (DHT Protocol)** and **BEP-11 (Peer Exchange)**. DHT
gives magnet-link peer discovery without a dedicated tracker. For chain-archive distribution this
is attractive (the content is public — no confidentiality reason to avoid the public DHT swarm),
but the root-of-trust design in §4–§5 does not depend on DHT for its trust properties: DHT/PEX
only affect *how peers are found*, never *whether downloaded bytes are correct* — that is closed
entirely by the SHA-256 re-verification gate (§2.2), independent of transport/discovery mechanism.
A private/curated tracker or explicit seed list remains available as a config option if broader
DHT exposure is undesirable operationally (e.g., to keep known-good seeders discoverable without
depending on public DHT health).

### 1.5 License

Apache License 2.0 (`LICENSE`, "Copyright 2021 Igor Katson") — directly compatible with UmbraDB's
own Apache-2.0 licensing. No further legal friction identified.

### 1.6 Maturity / activity / footprint

- **Activity:** commit history (GitHub API, fetched 2026-07-22) shows ongoing development through
  July 2026 — recent commits include "add mDNS advertising for the HTTP API," HTTP API router
  refactors, and upload-body-limit configuration fixes. Latest tagged release `v9.0.0-beta.2`
  (2026-01-20); the workspace on `main` has since moved to `9.0.0-rc.0`, i.e. actively converging
  toward a v9 stable rather than abandoned mid-beta.
- **Maturity caveat:** the v9 line is pre-1.0/pre-stable (`-rc.0` as of this fetch); v8.1.1 was the
  last fully stable tagged release before the v9 rewrite began. **Recommendation: pin an exact
  release tag/commit, do not track `main`,** and re-evaluate the pin when v9 reaches a stable tag.
- **Dependency footprint:** the workspace itself is small and mostly first-party (12 crates, the
  large majority of which are rqbit's own sub-crates — `librqbit_core`, `bencode`, `buffers`,
  `sha1w`, `peer_binary_protocol`, `dht`, `upnp`, `tracker_comms`, `upnp-serve` — rather than a deep
  external dependency tree), consistent with the project's own "small/lean" framing. This was
  **not** independently measured (no binary-size or `cargo tree` run against a real checkout) —
  flagged as a task for whoever picks up implementation, not claimed as verified here.

---

## 2. Network module architecture

### 2.1 Where it lives, and the boundary it must respect

UmbraDB's `test/postgres/no-sdk-import-guard.test.ts` enforces, repo-wide, that nothing under
`src/` references `@midnightntwrk/*` at runtime — `src/postgres/*` must stay "just Postgres
persistence." The network/torrent module must be held to the **same discipline, one level over**:
`src/postgres/*` must never import from, or know about, the network module, torrents, or rqbit.

**Recommendation: `src/network/` as a sibling directory in this repo for v1**, not a new package/
repo yet. Reasons: (a) it needs no build-tooling changes (single `package.json`, no workspace
manager in play today — confirmed: `package.json` has no `workspaces` field), (b) it can share the
existing `vitest`/`tsconfig` setup, (c) extraction to a standalone package later is cheap *because*
the dependency direction below is kept one-way from day one — the same posture UmbraDB itself was
extracted under. If the module grows a large dependency footprint of its own (a torrent client
binary, HTTP client libs, etc.) that UmbraDB's core consumers shouldn't be forced to install,
splitting it into a genuinely separate `@umbradb/network-torrent` package becomes a natural v2 move
— flagged in §7, not designed further here.

```
src/
  postgres/        <- unchanged; MUST NOT import src/network/*
  interfaces/       <- unchanged; gains one new narrow interface (below)
  network/          <- NEW, this design
    rqbit-sidecar.ts        # process lifecycle + typed HTTP client
    export-snapshot.ts      # blob-store content -> torrent
    import-snapshot.ts      # torrent -> verified blob-store content
    root-of-trust.ts        # fetch/parse/verify the root-of-trust list (§4)
    trust-upgrade.ts        # PKI-trusted -> chain-verified state machine (§5)
    bootstrap.ts            # the "birthday-floor" orchestration flow (§3)
```

`src/network/*` depends on:
- Node's `child_process`/`fetch` (sidecar process + HTTP calls),
- a new, narrow interface in `src/interfaces/` — **not** on `src/postgres/*` directly:

```ts
// src/interfaces/chain-blob-source.ts (new, narrow — satisfiable by CheckpointStore today,
// or by the future chain_blobs store once that design lands; src/network/* codes only to this)
interface ChainBlobSource {
  getBlob(hash: ContentHash): Promise<Uint8Array | null>;
  putBlob(hash: ContentHash, data: Uint8Array): Promise<void>; // implementation re-verifies hash
  listBlobHashes(scope: BlobScope): Promise<ContentHash[]>;    // e.g. all chunks for a manifest
}
```

This mirrors the existing `TransactionHistoryStorage`/`PgTransactionHistoryStorage` seam (VSD §7.3
notes this pattern needs "zero SDK change" because the interface is unprivileged and injected) —
`src/network/*` is wired to a concrete implementation only at the application's composition root,
never by reaching into `src/postgres/*` internals.

**New guard test, symmetric to the existing one:** add
`test/postgres/no-network-import-in-core-guard.test.ts` walking `src/postgres/**` and
`src/interfaces/**` (excluding the new `chain-blob-source.ts` interface file itself) for any
reference to `network`, `rqbit`, `torrent`, or `bittorrent`, the same whole-file-substring
technique the existing SDK guard uses (chosen deliberately to catch re-exports, not just
`import`-prefixed lines — the F4 fix documented in that test applies identically here).

### 2.2 Sidecar lifecycle and the SHA-256 re-verification gate

- **Spawn:** `child_process.spawn('rqbit', ['server', 'start', '--http-api-listen-addr',
  '127.0.0.1:<port>', '--output-folder', dataDir])` — exact pinned version (§1.6), checksummed
  binary, its own data directory kept separate from Postgres data. `RqbitSidecarClient` owns:
  readiness polling (`GET /torrents` returning 200), a single-instance lock (avoid double-spawn on
  process restart races), graceful `SIGTERM` shutdown with a `SIGKILL` timeout fallback, and
  crash-restart with exponential backoff. None of this logic is exposed outside `src/network/`.
- **Export (seed a snapshot):** materialize the blob set named by `listBlobHashes(scope)` into a
  local directory (layout choice — one file per content hash vs. one concatenated file plus an
  index — deferred to implementation; one-file-per-hash keeps rqbit's own internal piece-size
  choice fully decoupled from UmbraDB's chunk boundaries and simplifies partial reseed, at the cost
  of more files/inodes for a large snapshot), then `POST /torrents/create` against that directory.
  Capture the resulting `infoHash` + `.torrent` metainfo. This `{infoHash, manifestHash, anchor}`
  triple is exactly the record that later gets published into the root-of-trust list (§4).
- **Import (consume a snapshot):** `POST /torrents` with a magnet URI or infoHash (+ optional
  explicit tracker/peer list if DHT is disabled per §1.4), poll `GET /torrents/{id}` for progress,
  and on completion read the downloaded files. **Every file/chunk is SHA-256-rehashed and compared
  against the expected content hash before being handed to `ChainBlobSource.putBlob`.** rqbit's own
  SHA-1 piece-level "complete" status is used only as a signal "worth re-hashing now," never as the
  security boundary — this is the direct consequence of §1.3's BEP-52 finding: BitTorrent-level
  integrity and UmbraDB-level content-addressing are two independent hash domains, and only the
  second one is ever trusted. This exactly extends `CheckpointStore.load()`'s existing "always
  fully rehashes+verifies every chunk on load()" discipline to a new, untrusted transport.
- **"Expected content hash" for import comes from one of two places**, both covered by §5: a
  root-of-trust list entry (bootstrap case, §4) or an already-established local manifest the caller
  already trusts (ordinary resync/reseed case, no bootstrap-trust question at all).

---

## 3. Alternative retrieval: the bootstrap flow

"Alternative retrieval" means concretely: a fresh preprod/testnet node or wallet, instead of a full
RPC/indexer resync from genesis, downloads a recent verified snapshot via BitTorrent — fast,
P2P, load-balanced across seeders, no single RPC/indexer endpoint as a bottleneck or single point
of failure — and then only replays the short tail `[N, tip]` live.

```
1. Fresh node/wallet, zero local state, networkId known.
2. Fetch the root-of-trust list for that networkId (§4). Pick the latest entry.
3. Verify the entry itself — PKI signature check (§5, "PKI-TRUSTED" path). This is the ONLY
   step that doesn't require the chain to already be reachable/verifiable.
4. Import via §2.2: download via rqbit, SHA-256-re-verify every blob, ingest into the
   ChainBlobSource. BitTorrent's own hash checks are never the trust boundary (§1.3, §2.2).
5. The imported data, anchored at {blockHeight N, blockHash, stateRoot/manifestHash}, becomes
   the node/wallet's BIRTHDAY FLOOR — reusing VSD §1's framing verbatim, one layer up the
   stack: "a cryptographically-certified birthday floor [the node] never rescans below again,"
   here applied to full-chain bootstrap rather than wallet-state restore.
6. From N, sync LIVE via the normal RPC/indexer path for [N, tip] only — a short tail, not a
   from-genesis replay.
7. As soon as the node/wallet can perform VSD §4's finality check (Tier-0 k-of-n or Tier-1
   GRANDPA-justification + state-read-proof — reused unchanged, not redesigned here) and query
   the L3 on-chain attestation contract (§5) for a matching commitment at height >= N, its trust
   in the bootstrap data upgrades from PKI-TRUSTED to CHAIN-VERIFIED (§5). This should happen
   automatically, by default, the moment it becomes possible — not a manual opt-in step.
```

**Precise relationship to VSD, stated explicitly so the two docs don't get conflated:** VSD's
L0–L3 stack proves a *wallet's derived balance state* is correct without chain replay. This
design's root-of-trust + PKI mechanism is one layer **below** that: it is about bootstrapping the
*chain archive data itself* (blocks/txs/proofs, the substrate VSD's own L1 tail-scan and any
from-genesis path would otherwise have to fetch slowly via RPC/indexer). A wallet can use torrent
bootstrap to fast-forward its local archive copy, then run VSD's normal L0–L3 checks against that
data exactly as if it had synced it slowly. A full node (not just a wallet) gets an even more
direct benefit: skip full historical block download/re-execution entirely, landing at a
sufficiently-verified state to begin normal consensus-following forward. Neither replaces the
other; §5 is designed so they compose through one shared value (`manifestHash`), not two disjoint
trust stores.

---

## 4. Root-of-trust list design

### 4.1 Prior art (briefly researched, per the task's instruction)

- **Bitcoin Core `assumevalid`** (`chainparams.cpp`, `defaultAssumeValid`): a hardcoded, recent,
  deeply-buried block hash shipped **inside the client's own source code**, reviewed via Bitcoin
  Core's normal open PR process. Crucially, per Bitcoin Core's own documentation, it is a *pure
  performance optimization with no consensus impact* — a node still downloads, hashes, and fully
  validates every rule (PoW, no-double-spend, no-coins-from-nothing) for the entire history; it
  only *skips signature-script verification* for ancestors of the assume-valid block. If the
  assume-valid hash happens to sit on an invalid chain, full validation still rejects it the moment
  it hits a real rule violation. This is a **strictly weaker** claim than what a snapshot-bootstrap
  mechanism needs to make (we skip *download and replay*, not just *script verification*), which is
  exactly why VSD's L3 and this design's §5 insist on a real on-chain check to upgrade trust —
  `assumevalid`'s "no consensus impact" property doesn't transfer for free to a "skip the data
  entirely" mechanism; it has to be earned by the L3 composition below.
- **Bitcoin Core AssumeUTXO** (26.0+): closer prior art — nodes import a hash-committed UTXO-set
  snapshot at a checkpoint height for near-instant "usable" sync, then **background-validate**
  against full history afterward, upgrading trust once that completes. This is structurally the
  same "cheap-trust-now, upgrade-to-full-trust-later, same commitment checked both times" shape
  §5 proposes.
- **Ethereum weak-subjectivity checkpoint sync**: a trusted `(blockRoot, epoch)` pair supplied
  out-of-band from a community-maintained, **explicitly-not-single-source-of-truth** list
  (`eth-clients/checkpoint-sync-endpoints` — the repo's own README warns some endpoints "may not be
  up to date," and recommends cross-checking against multiple independent sources/explorers before
  trusting one). This is the most direct precedent for §4.2's "don't rely on one publisher" and
  §6's honest-residual framing.

Sources: [Bitcoin Core `assumevalid` behavior](https://github.com/bitcoin/bitcoin/blob/master/src/chainparams.cpp),
[AssumeUTXO overview](https://www.spark.money/research/bitcoin-assumeutxo-fast-sync),
[eth-clients/checkpoint-sync-endpoints](https://github.com/eth-clients/checkpoint-sync-endpoints),
[Ethereum weak subjectivity](https://ethereum.org/developers/docs/consensus-mechanisms/pos/weak-subjectivity/).

### 4.2 Structure

A small, versioned, append-only JSON document, one per network:

```json
{
  "network": "preprod",
  "schemaVersion": 1,
  "entries": [
    {
      "infoHash": "<40-hex BitTorrent v1 info-hash>",
      "manifestHash": "<sha256 hex — same value structure the L3 contract commits to, §5.1>",
      "anchor": { "blockHeight": 1234567, "blockHash": "0x...", "finalizedHash": "0x..." },
      "publishedAt": "2026-07-22T00:00:00Z",
      "torrentFileUrl": "https://.../<infoHash>.torrent",
      "supersedes": "<prior manifestHash, or null>"
    }
  ],
  "signatures": [
    { "keyId": "umbradb-v1-2026", "algorithm": "ed25519", "signature": "<base64>" }
  ]
}
```

`torrentFileUrl` is a **convenience mirror only** — never trust-bearing; if unreachable, the
`infoHash` alone plus DHT/PEX (§1.4) is sufficient to locate peers.

**Note on "mainnet":** Midnight does not have a production mainnet at the time of this design
(preprod/testnet are the live networks referenced throughout this repo's docs) — the list format
above is network-parameterized from day one so it needs no redesign when mainnet exists, but there
is nothing to publish for it yet.

### 4.3 Who signs it (three honestly-ranked postures)

The task's proposal is that this reuses PKI signatures **from Shielded Labs or the Midnight
Foundation**. That cannot be unilaterally delivered by this design — UmbraDB is an independent
project, not a Shielded Labs deliverable (its own repo plan is explicit: standalone OSS, no
Shielded-Labs authority implied). So this section ranks what's actually deliverable at each tier:

1. **v1, buildable now, weakest, honestly labeled:** UmbraDB signs its own list with its own
   keypair, clearly labeled `"issuer": "umbradb-project"` — **not** Shielded-Labs-endorsed. This
   still gives real bootstrap convenience (P2P instead of RPC-bottlenecked resync) with an honest,
   narrow trust claim: "the UmbraDB project vouches this torrent's content matched this chain
   anchor at publish time," nothing more.
2. **v1.x/v2, needs external coordination, the one the task actually asks for:** Shielded Labs or
   the Midnight Foundation signs (ideally via a threshold/multisig committee, §5.2) or endorses
   (co-signs) the list. Gated entirely on them opting in — cannot be built alone.
3. **Recommended shape for tier 2, reusing infrastructure that already exists rather than asking
   for new PKI from scratch:** `midnight-node`'s actual release pipeline already signs artifacts —
   confirmed by reading `midnight-node/docs/security/{image-signing,signing-runbook,
   verification-guide}.md`, `.github/workflows/release-image.yml`, and
   `docs/operations/release-checklist.md`. Container images get **GitHub-native artifact
   attestations** (`actions/attest-build-provenance`, SLSA build provenance, verified via
   `gh attestation verify ... --owner midnightntwrk` — no separate Fulcio/Rekor dependency to
   operate) plus SBOM attestation; the release checklist additionally documents **Cosign keyless
   signing** (Sigstore, OIDC-identity-bound, transparency-log-anchored) for images and srtool
   runtime-WASM artifacts, with `docs/security/signing-runbook.md` covering monitoring and failure
   procedures. **None of this exists yet for chain-checkpoint/snapshot data** — but the
   organizational muscle (a `midnightntwrk`-org-controlled repo, an OIDC-bound release workflow,
   an established "attest + verify by owner" habit) is exactly what a snapshot root-of-trust list
   needs, and it is far less to ask of Shielded Labs than standing up a brand-new long-lived
   keypair-management PKI. **Concrete ask for §7's coordination-tier row:** publish
   `snapshot-root-of-trust.json` as a build artifact of a `midnightntwrk`-owned repo/workflow,
   attested the same way images are today; verifying nodes/wallets check it with the same
   `gh attestation verify`-equivalent flow (or the SDK-embedded Sigstore-verification library
   equivalent), inheriting Shielded Labs' *existing* trust root instead of a new one. A classic
   static Ed25519/threshold keypair (as sketched in §4.2's `signatures` field) remains the fallback
   if they'd rather not depend on GitHub/Sigstore infrastructure for this artifact type — the two
   are not mutually exclusive; §4.2's `signatures` array can carry either shape.

---

## 5. PKI ↔ L3 composition (the crux)

### 5.1 One shared value, two independent verification paths

The root-of-trust entry's `manifestHash` is defined to be **the exact same value structure** VSD
§3/§8's L3 Compact contract commits to via `persistentCommit(snapshotRoot, salt)` — concretely, for
the archive-bootstrap case, a SHA-256 over the position-ordered content-hash sequence of the
exported blob set, i.e. the same construction `ckpt_manifests.manifest_hash` already computes today
(`src/postgres/checkpoint-store.ts`: "SHA-256 over the position-ordered chunk-hash sequence").
Two paths can each attest to this one value:

- **(a) PKI path — bootstrap-only, available before the chain is reachable.** The root-of-trust
  list entry, signed per §4.3, asserts "`manifestHash` X corresponds to chain anchor N." This is
  the *only* path usable by a node/wallet with zero prior chain state (§3 step 3).
- **(b) On-chain path — consensus-grade, available once VSD §4's finality check is reachable.**
  Query a Compact contract's ledger map for a record whose commitment equals `manifestHash` X at a
  height ≥ N, exactly VSD §3/§8's pattern.

### 5.2 A new, namespace-separated on-chain surface — not a reuse of the wallet contract

VSD's L3 `attestations: Map<pseudonymId, AttestRecord>` is **wallet-scoped**, keyed by a
wallet-derived pseudonym (`persistentHash([pad(32,"umbradb:attest:v1:id"), sk])` under a
wallet-owned `sk_attest`). An archive snapshot has no wallet owner — it's published by whoever runs
the export (§2.2), a role, not a wallet identity. Reusing the *same* map with a wallet-shaped key
would be a category error. Recommendation: a **structurally identical, namespace-separated second
export** in the same or a sibling Compact contract:

```compact
// New export, same pattern as VSD §8's AttestRecord/attest — different subject, different
// domain-separation tag, different (publisher-role, not wallet) key derivation.
struct ArchiveAttestRecord { commitment: Bytes<32>; height: Uint<64>; seq: Uint<64>; prevCommitment: Bytes<32>; }
export ledger chainSnapshotAttestations: Map<Bytes<32>, ArchiveAttestRecord>;  // publisherId -> latest
export ledger archiveHistory: MerkleTree<32, Bytes<32>>;

witness publisherSecretKey(): Bytes<32>;   // a committee/publisher key, NOT a wallet's sk_attest
witness manifestRoot(): Bytes<32>;

export circuit attestArchiveSnapshot(height: Uint<64>): [] {
  const sk = publisherSecretKey();
  const id = disclose(persistentHash([pad(32,"umbradb:archive-attest:v1:id"), sk]));  // domain-
                                                                                       // separated
                                                                                       // from
                                                                                       // "umbradb:attest:v1:id"
  const isUpdate = chainSnapshotAttestations.member(id);
  const prev = isUpdate ? chainSnapshotAttestations.lookup(id) : default;
  if (isUpdate) assert(prev.height < height, "attestation must advance");   // same CAS anti-
                                                                              // rollback shape as
                                                                              // VSD §8
  const c = manifestRoot();   // publishers of public archive data have no reason to hide
                               // the root the way a wallet hides its snapshot commitment
                               // (VSD §3's V2 salted-hiding-commit does not apply here) —
                               // ship the plain root, not a hiding commitment
  archiveHistory.insertHash(c);
  chainSnapshotAttestations.insert(id, ArchiveAttestRecord { commitment: c, height: disclose(height),
                                     seq: disclose(prev.seq + 1), prevCommitment: prev.commitment });
}
```

This is **illustrative, uncompiled**, matching VSD §8's own disclaimer for its sketches. It reuses
VSD's exact CAS anti-rollback argument (a replayed old `attestArchiveSnapshot` tx fails against
advanced height, VSD §3's decisive argument for why L3 closes cold-boot rollback) applied to
archive publishers instead of wallets. `publisherSecretKey()` is deliberately a **committee/role**
key, not a wallet key — see §5.4 for who should hold it.

### 5.3 The trust-upgrade state machine

```
PKI-TRUSTED  --[VSD §4 finality check reachable AND chainSnapshotAttestations
                lookup finds a record with commitment == manifestHash at height >= N]-->
                                                                        CHAIN-VERIFIED

PKI-TRUSTED  --[lookup finds NO matching record, or a DIFFERENT commitment at that
                publisherId]--> INTEGRITY-FAILURE (hard fail: discard/quarantine the
                                ingested data, do not silently keep it)
```

- Every blob ingested via the bootstrap path (§3) is tagged internally with its trust state
  (`trustLevel: 'pki-bootstrap' | 'chain-verified'`) — **never silently presented as fully
  verified** while still in the PKI-TRUSTED state. This is the direct analogue of VSD's own
  discipline never to imply "fully verified, no trust in the feed" when a residual gap remains
  (VSD §12's "biggest risk" framing).
- The upgrade check runs automatically, by default, as soon as it becomes possible — not an
  opt-in extra step (per the task's explicit instruction). It reuses VSD §4's Tier-0/Tier-1
  finality machinery unchanged; this design adds no new finality-verification code, only a new
  ledger-map lookup once finality is already established.
- **A security-conscious operator can disable the PKI path entirely** (config flag) and fall back
  to (i) full RPC/indexer replay from genesis, or (ii) bootstrapping only from an `infoHash`+
  `manifestHash` the operator already trusts out of band, skipping the root-of-trust list. Default
  posture: PKI-bootstrap-on for wallets/light clients (fast start matters, and the auto-upgrade
  bounds the exposure), recommended PKI-bootstrap-off for validator/archival nodes (should sync
  from genesis or from a self-verified attestation, not a convenience list) — this default split
  should be ratified by whoever reviews this design, not silently assumed.

### 5.4 Key governance

- **Threshold, not a single key.** A single Ed25519 signer (or single GitHub-attestation identity)
  is a single point of failure with unbounded (within the PKI-only blast radius, §6) reach. Mirror
  Ethereum's checkpoint-sync-endpoint "don't trust one provider" habit *and* go further: recommend
  an **m-of-n threshold** (e.g. 2-of-3 or 3-of-5) over the `signatures` array, or equivalently,
  requiring agreement across ≥2 independently-hosted mirrors of the list (own list-mirroring
  discipline, cheap to add, doesn't require Shielded Labs to build threshold crypto if they'd
  rather not).
- **Rotation.** Each key is versioned (`keyId`, e.g. `"shielded-labs-2026-q3"`); a new key is
  published with an overlap window before the old one stops being honored for *new* entries;
  already-published, already-verified entries remain valid under whichever key signed them (no
  retroactive invalidation from routine rotation).
- **Revocation.** An explicit `revokedKeyIds: string[]` field (or equivalent out-of-band channel,
  matching `midnight-node/SECURITY.md`'s existing disclosure/advisory process) — a revoked key's
  signatures must be treated as absent, not merely "old," the moment revocation is known.
- **Compromise blast radius — the load-bearing governance property, stated precisely.** A
  compromised PKI key can, at most, mislead a node/wallet that is (a) bootstrapping from zero prior
  state, **and** (b) has PKI-bootstrap enabled, **and** (c) has not yet reached CHAIN-VERIFIED
  (§5.3), **and** (d) is not cross-checking multiple independent list mirrors. It **cannot**, by
  construction, forge a passing on-chain `chainSnapshotAttestations` check: that check is a Compact
  contract state read verified against actual consensus/finality (VSD §4's machinery, untouched by
  this design), and the PKI signature is never an input to it — the two trust roots are
  structurally disjoint and only happen to be checked against the same `manifestHash` value for
  convenience. This is the same shape the task asked for explicitly and the same shape
  `assumevalid`'s "no consensus impact" property has (§4.1) — the difference is `assumevalid` earns
  that property by *still fully validating everything*, while this design earns it by *always
  performing the on-chain check the moment it's possible* and *never letting the PKI path touch the
  chain-verification logic itself*.

---

## 6. Honest residual trust

Stated plainly, matching VSD §10's discipline of never overclaiming:

1. **Consensus/finality.** Identical to VSD §10 point 1, inherited unchanged: correctness reduces
   to an on-chain root, whose trust reduces to GRANDPA not reverting blocks ≤ N, down to one
   irreducible weak-subjectivity seed (the genesis authority set). This design adds no new
   finality primitive; it reuses VSD §4's.
2. **The PKI-bootstrap window is a real, not fully eliminable, exposure — shared by every
   bootstrap-trust mechanism that has ever shipped** (Bitcoin `assumevalid`/AssumeUTXO, Ethereum
   weak-subjectivity checkpoint sync, Zcash's *trusted* birthday — VSD §1 already notes ours is
   *stronger* than Zcash's for the wallet case; the PKI-bootstrap path reintroduces a Zcash-like
   trusted-third-party assumption specifically for the pre-sync window). An attacker who both
   compromises enough PKI keys (past the threshold, before revocation propagates) **and** can
   deny the victim any real path to chain connectivity (eclipse-style, so it never reaches
   CHAIN-VERIFIED) could sustain a false view for that one victim indefinitely. Mitigation is
   defense-in-depth (§5.4's threshold + mirror cross-check, sane default timeouts that push toward
   attempting the upgrade promptly) — not elimination, and this document does not claim
   elimination.
3. **BitTorrent transport is fully untrusted for correctness, always.** Every byte is
   SHA-256-re-verified against `manifestHash` before ingestion (§2.2), regardless of rqbit's own
   SHA-1 piece-level "complete" status. A malicious or buggy seeder can waste the bootstrapper's
   time/bandwidth but cannot get bad data accepted, and per point 2's bound, cannot get bad data
   permanently labeled chain-verified.
4. **BEP-52 gap (§1.3).** Torrent piece hashes and UmbraDB content hashes are two independent hash
   domains, bridged only by our own re-verification step, never by a BitTorrent-native mechanism.
   Revisit if rqbit (or an alternative client) ships BEP-52 — would allow piece hashes to *align
   with* (not replace) content hashes, tightening the transport-level integrity story, but the
   application-level SHA-256 re-verify should remain regardless (defense in depth, not solely
   reliant on a third-party client's hashing correctness).
5. **The rqbit sidecar is trusted for availability/liveness only**, never for correctness — same
   framing VSD §10 uses for the DB itself ("trusted for availability only"). Treat it exactly like
   an untrusted remote peer in VSD's own threat model.
6. **Root-of-trust list hosting is a single point of failure for the bootstrap-convenience path
   only**, never for correctness. If unreachable, or if the operator disables it (§5.3), fall back
   to ordinary RPC/indexer sync from genesis — the mechanism degrades to "no faster than today,"
   never to "silently wrong."
7. **The Shielded-Labs/Foundation-endorsed tier (§4.3 tier 2/3) is a coordination dependency this
   design cannot deliver alone.** If that coordination never happens, UmbraDB should ship (and
   keep clearly, permanently labeled as) only its own weaker, self-signed tier-1 list — never
   silently upgrade its own labeling to imply official endorsement it doesn't have.
8. **The new `chainSnapshotAttestations` Compact contract (§5.2) is a new trust surface** in
   exactly the sense VSD §12 flags for its own L3 contract — contract governance, immutability, and
   pinned-verifier-key versioning across protocol upgrades apply here too, and this design does not
   resolve those questions any more than VSD did for its own contract; they are open items for
   whoever reviews this design, same as VSD §12's open items were flagged for council ratification
   rather than silently assumed.

---

## 7. Phasing table

| Capability | Buildable now (UmbraDB alone) | Needs Shielded Labs / Foundation coordination | Research-grade / upstream-dependent |
|---|---|---|---|
| rqbit sidecar spawn + typed HTTP client | ✅ §2.2 | | |
| Export flow (blobs → torrent, `POST /torrents/create`) | ✅ §2.2 (works today against `CheckpointStore`; consumes `chain_blobs` unchanged once that schema lands) | | |
| Import flow + mandatory SHA-256 re-verification gate | ✅ §2.2 | | |
| `src/network/` module + `ChainBlobSource` interface + new architectural guard test | ✅ §2.1 | | |
| Bootstrap orchestration (birthday-floor flow, §3) | ✅ as design/interface now; full-chain usefulness partially blocked on `chain_blobs` landing (wallet-checkpoint case works today unblocked) | | |
| Root-of-trust list v1, UmbraDB-self-signed, clearly labeled non-official | ✅ §4.3 tier 1 | | |
| `chainSnapshotAttestations` Compact contract (§5.2) | ✅ buildable/prototypable now, **needs the same design-council review VSD's L3 went through before being treated as canonical** | | |
| Trust-upgrade state machine (§5.3) reusing VSD §4's finality checks | ✅ (VSD §4 machinery is already designed; this adds only the new ledger-map lookup) | | |
| Shielded Labs / Foundation co-signing or GitHub-attestation-based publishing of the list (§4.3 tier 2/3) | | ✅ pure coordination ask | |
| Any official Shielded-Labs-published checkpoint/snapshot cadence or endorsement | | ✅ | |
| BEP-52-aligned piece hashing | | | ✅ upstream-dependent on rqbit (or an alternative client) shipping it |
| Anti-eclipse hardening for the bootstrap window (multi-path root-of-trust fetch, network-diversity checks) | | | ✅ |

---

## 8. Open questions for whoever reviews this design

Mirroring VSD §12's practice of surfacing genuinely open decisions rather than silently picking one:

- **Default posture for §5.3's PKI-bootstrap on/off split** (wallets default-on, nodes
  default-off, as sketched) — needs ratification, not assumed.
- **File layout for exported torrents** (one file per content hash vs. concatenated blob +
  index, §2.2) — affects reseed granularity and inode overhead; deferred to implementation
  measurement against real snapshot sizes, same spirit as `checkpoint-store.ts`'s own
  `DEFAULT_CHUNK_SIZE` being flagged "revisit under Milestone 4 once real measurements exist."
- **Whether `src/network/` stays in-repo or becomes a separate package** (§2.1) — recommended
  in-repo for v1, revisit once its own dependency footprint is measured.
- **Whether §5.2's new Compact contract is a genuinely separate contract or a second export
  namespace inside VSD's existing one** — sketched as separate here for clean domain separation,
  but the two share enough shape that a combined deploy might be simpler operationally; a call for
  whoever owns the Compact contract deployment plan.
- **Whether tier-2 signing (§4.3) should be GitHub-attestation-based or classic Ed25519/threshold**
  — proposed GitHub-attestation-based as the lower-friction ask given existing infrastructure, but
  this is Shielded Labs'/the Foundation's call, not this design's to make unilaterally.

---

*Grounding: rqbit README/Cargo.toml/LICENSE/commits (`github.com/ikatson/rqbit`, fetched
2026-07-22); `design/verifiable-snapshot-design.md` (cited throughout as VSD);
`src/postgres/checkpoint-store.ts`, `src/postgres/migrations/002_checkpoint_store.ts`;
`test/postgres/no-sdk-import-guard.test.ts`; `midnight-node/docs/security/*`,
`midnight-node/docs/operations/release-checklist.md`,
`midnight-node/.github/workflows/release-image.yml` (fetched from local `/root/midnight/midnight-node`
checkout); Bitcoin Core `assumevalid`/AssumeUTXO and Ethereum weak-subjectivity checkpoint-sync
prior art (public sources cited inline, §4.1). No Midnight source modified; nothing committed
outside this design doc.*
