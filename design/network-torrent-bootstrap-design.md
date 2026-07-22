# Network Module: BitTorrent Alternative Retrieval + PKI Bootstrap Trust — Design

**Branch:** `feature/network-torrent` · **Date:** 2026-07-22 · **Status:** Design draft, revised
post design-council review (see Revision history below); not yet re-reviewed.
**Scope:** design only — no working code in this change. Follows the rigor/citation discipline of
`design/verifiable-snapshot-design.md` (hereafter **VSD**): concrete, sourced, explicit about
what's deferred, explicit about honest residual trust, does not overclaim.

## Revision history

- **2026-07-22 (this revision).** Three independent design-council reviewers — Claude Fable 5,
  Claude Opus, GPT-5.6 Sol — each read the full v1 draft and unanimously returned NEEDS-REWORK,
  converging independently on the same critical flaw: §5's `attestArchiveSnapshot` Compact contract
  let **any** key-holder self-attest **any** `manifestRoot` at **any** claimed height, gated only by
  per-publisher height-monotonicity — that proves someone claimed something on a finalized chain,
  not that the claim is true, so the document's central security claim (a compromised PKI key
  "cannot, by construction, forge a passing on-chain check") was false as written. This revision:
  (1) **removes `attestArchiveSnapshot` entirely** and replaces the CHAIN-VERIFIED upgrade with
  **direct recomputation of the archive's block-hash chain against real, finality-checked on-chain
  block hashes** (VSD §2/L0's pattern, one layer up the stack — no new contract, no publisher-key
  trust surface, strictly stronger); (2) fixes the buggy substring-based architectural guard tests
  and adds the missing reverse-direction guard (§2.1); (3) fixes `ChainBlobSource` to specify a
  real manifest (ordered hashes *and* sizes — a `manifestHash` alone cannot reveal its own
  preimages), a staging/quarantine area, and atomic manifest-level promotion (§2.1); (4) adds
  explicit resource bounds on ingest (§2.3); (5) reframes the rqbit sidecar's unauthenticated
  loopback API as a confidentiality/exfiltration risk, not just an availability concern, with
  concrete hardening (§2.4); (6) strengthens root-of-trust governance — canonicalization, quorum
  honesty (mirrors of one key ≠ threshold), expiry, monotonic-version rollback protection (§4);
  (7) adds the wallet DHT-announcement privacy leak to the threat model (§6); (8) tones down
  overclaiming (the old "DHT trust is closed entirely by SHA-256" line and any implication that
  PKI-TRUSTED is sufficiently verified for consequential use). All changes below are substantive
  redesign, not caveat-only edits, per the reviewers' explicit instruction not to patch-and-flag.

**Relationship to the other two active design tracks (do not duplicate, must compose):**

1. **Full-chain archival storage** (separate, in-progress research track, different agents): a
   content-addressed blob store generalizing `ckpt_chunks` into something like `chain_blobs`, for
   raw block/tx/proof payloads. This design does **not** define that schema. It treats it as "a
   SHA-256 content-addressed blob store, table/column names TBD" and defines a narrow interface
   (§2.1) that either that future store, or a small adapter over today's `CheckpointStore`, can
   satisfy — see §2.1 for the honest scoping of that claim (v1 draft overstated it).
2. **Verifiable wallet-state snapshot** (`feature/verifiable-snapshot`, council-reviewed, referred
   to throughout as **VSD**): the 4-layer L0–L3 architecture for proving a *wallet's* restored
   state is correct without replay. This design's §5 no longer proposes a second L3-shaped Compact
   contract (see Revision history). Instead it composes with VSD one layer **below** L3: it reuses
   VSD **§4's finality machinery unchanged** (the same Tier-0/Tier-1 check VSD uses to trust a
   block's committed root) as the trusted anchor for **direct block-hash-chain recomputation** over
   archive data — the same "recompute locally, compare to a finality-checked on-chain value" shape
   VSD's L0 uses for wallet snapshots (VSD §2), applied to raw chain data instead of a wallet's
   Merkle root.

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

**Note (§2.4 dependency):** `POST /torrents/create` accepting an arbitrary local folder path, and
the Web UI at `GET /web/`, are exactly the surfaces §2.4's sidecar-hardening section constrains —
flagged here so the capability table above is read alongside that section, not in isolation.

**Conclusion on integration shape:** sidecar process + local HTTP calls, as the task's working
hypothesis predicted. No FFI/native-binding path exists to embed `librqbit` directly in a Node
process, and even where a hypothetical binding existed, the HTTP-sidecar shape is preferable here
anyway — it gives process isolation, independent crash/restart handling, and zero ABI coupling to
Node's N-API version, at the cost of one extra process and one loopback HTTP hop (and, per §2.4,
one additional local-privilege boundary to actively defend, not just tolerate).

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
is attractive (the content is public — no confidentiality reason to avoid the public DHT swarm for
node-side archive bootstrap; see §6 point 9 for why the wallet case is different), but the
root-of-trust design in §4–§5 does not depend on DHT for its trust properties: DHT/PEX only affect
*how peers are found*, never *whether downloaded bytes are correct*. **Precise claim (the v1 draft
overstated this):** DHT/PEX involvement is irrelevant to *byte-level transport integrity*, which is
closed by the SHA-256 re-verification gate (§2.2) independent of transport/discovery mechanism —
but byte-level integrity is not the same claim as *chain correctness*, and §5's rewrite is exactly
about not conflating the two. A private/curated tracker or explicit seed list remains available as
a config option if broader DHT exposure is undesirable operationally (e.g., to keep known-good
seeders discoverable without depending on public DHT health, or — per §6 point 9 — to avoid a
wallet leaking its bootstrap activity to the public DHT at all).

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
`src/postgres/*` must never import from, or know about, the network module, torrents, or rqbit —
**and, symmetrically, `src/network/*` must never reach persistence except through the
`ChainBlobSource` interface** (the v1 draft specified only the first direction; a bidirectional
boundary needs a bidirectional guard).

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
  network/          <- NEW, this design; MUST NOT import src/postgres/* directly
    rqbit-sidecar.ts        # process lifecycle + typed HTTP client
    export-snapshot.ts      # blob-store content -> torrent
    import-snapshot.ts      # torrent -> staged, then verified, blob-store content
    root-of-trust.ts        # fetch/parse/verify the root-of-trust list (§4)
    chain-verify.ts         # PKI-trusted -> chain-verified state machine, direct recompute (§5)
    bootstrap.ts            # the "birthday-floor" orchestration flow (§3)
    resource-limits.ts      # ingest bounds — size/count/depth/duration caps (§2.3)
```

`src/network/*` depends on:
- Node's `child_process`/`fetch` (sidecar process + HTTP calls),
- a new, narrow interface in `src/interfaces/` — **not** on `src/postgres/*` directly.

**`ChainBlobSource` — fixed to match what it actually needs to do.** The v1 draft's interface
(`getBlob`/`putBlob`/`listBlobHashes`) had two problems flagged independently by reviewers: (1) it
claimed `CheckpointStore` already satisfies it, which is false — `CheckpointStore` operates at
checkpoint-level `save(walletId, networkId, data)`/`load(...)` granularity
(`src/interfaces/checkpoint-store.ts`), not per-blob `getBlob`/`putBlob`, and has no manifest-scoped
enumeration; (2) it let a caller write directly to the canonical store per-blob, and it claimed you
could "re-verify every blob against `manifestHash`" — but `manifestHash` is a SHA-256 **over the
ordered hash sequence** (unchanged from `checkpoint-store.ts`'s existing `ckpt_manifests` construction:
"SHA-256 over the position-ordered chunk-hash sequence"); a hash cannot reveal its own preimages, so
you can only re-verify each blob against **its own per-blob hash**, and separately verify the
*sequence of those hashes* against `manifestHash` — two different checks, not one:

```ts
// src/interfaces/chain-blob-source.ts (new, narrow — src/network/* codes only to this; satisfied
// natively by the future `chain_blobs` store once that design lands. NOT satisfied by
// CheckpointStore today — no adapter is designed here; that is out of scope until chain_blobs
// exists, and this doc no longer claims otherwise.)

interface ManifestEntry { hash: ContentHash; size: number; }   // position-ordered

interface ArchiveManifest {
  scope: BlobScope;
  entries: ManifestEntry[];        // ordered hash+size pairs — the actual preimage sequence
  manifestHash: ContentHash;       // sha256 over entries.map(e => e.hash), in order
}

interface ChainBlobSource {
  // Canonical store — reads/enumeration only ever see promoted, complete manifests.
  getBlob(hash: ContentHash): Promise<Uint8Array | null>;
  getManifest(scope: BlobScope): Promise<ArchiveManifest | null>;
  listBlobHashes(scope: BlobScope): Promise<ContentHash[]>;

  // Staging — an in-progress import writes here, never to the canonical store directly. Each
  // stageBlob call re-verifies `data`'s SHA-256 against `hash` before accepting it (same
  // discipline as `CheckpointStore.load()`); a hash mismatch is rejected, not silently dropped.
  stageBlob(importId: string, hash: ContentHash, data: Uint8Array): Promise<void>;

  // Atomic, manifest-level promotion — NOT per-blob incremental acceptance. Verifies every entry
  // in `manifest` is present and hash-correct in the `importId` staging area, verifies
  // `manifest.manifestHash` against the ordered entry-hash sequence, and only then moves the
  // entire set into the canonical store as one transaction. On any gap or mismatch, the staging
  // area for `importId` is discarded and the canonical store is left untouched — a
  // malicious/abandoned/partial torrent can pollute only its own quarantined `importId`, never
  // leave orphaned unreferenced blobs in the canonical store.
  promoteManifest(importId: string, manifest: ArchiveManifest): Promise<void>;
  discardStaging(importId: string): Promise<void>;
}
```

This mirrors the existing `TransactionHistoryStorage`/`PgTransactionHistoryStorage` seam (VSD §7.3
notes this pattern needs "zero SDK change" because the interface is unprivileged and injected) —
`src/network/*` is wired to a concrete implementation only at the application's composition root,
never by reaching into `src/postgres/*` internals.

**Two guard tests, fixed to be precise and made symmetric:**

1. **`test/postgres/no-network-import-in-core-guard.test.ts`** — the v1 draft's approach (whole-file
   substring match on `network`/`rqbit`/`torrent`/`bittorrent` across `src/postgres/**`) is buggy as
   specified: `networkId` and the `net` column alias appear throughout legitimate, unrelated code
   (`src/postgres/checkpoint-store.ts`, `errors.ts`, `temporal-kv.ts`, `wallet-state-envelope.ts` all
   match `network` today — confirmed by grep against this exact checkout) — the guard as specified
   would fail on day one against code this design never touches. **Fix:** parse each file's actual
   import/export specifiers (same technique the existing `no-sdk-import-guard` uses for
   `@midnightntwrk` — whole-file check for the specifier substring, not line-anchored — but applied
   to a **specifier string**, not a bare English word): check every `from "..."`/`import(...)`
   argument and re-export specifier under `src/postgres/**` and `src/interfaces/**` (excluding
   `chain-blob-source.ts` itself) for a path containing `/network/`, `rqbit`, or `librqbit` as a
   module-path segment — a specifier check, never a bare-word content scan, so `networkId` cannot
   trip it.
2. **`test/postgres/network-only-imports-via-chain-blob-source.test.ts`** (new — the missing reverse
   direction). Walks `src/network/**` and asserts no file's import/export specifiers reference
   `src/postgres/` (relative or aliased) directly; the only permitted persistence-shaped import is
   `src/interfaces/chain-blob-source.ts` (or `src/interfaces/*` generally, matching the existing
   interfaces boundary). This is the guard that actually enforces §2.1's "codes only to this
   interface" claim — without it, that claim is aspirational prose, not an enforced invariant.

### 2.2 Sidecar lifecycle and the SHA-256 re-verification gate

- **Spawn:** `child_process.spawn('rqbit', ['server', 'start', '--http-api-listen-addr',
  '127.0.0.1:<port>', '--output-folder', stagingDir])` — exact pinned version (§1.6), checksummed
  binary, its own data directory kept separate from Postgres data **and constrained per §2.4**.
  `RqbitSidecarClient` owns: readiness polling (`GET /torrents` returning 200), a single-instance
  lock (avoid double-spawn on process restart races), graceful `SIGTERM` shutdown with a `SIGKILL`
  timeout fallback, and crash-restart with exponential backoff. None of this logic is exposed
  outside `src/network/`.
- **Export (seed a snapshot):** materialize the blob set named by `listBlobHashes(scope)` into a
  local directory under the sidecar's confined staging root (§2.4) (layout choice — one file per
  content hash vs. one concatenated file plus an index — deferred to implementation; one-file-per-
  hash keeps rqbit's own internal piece-size choice fully decoupled from UmbraDB's chunk boundaries
  and simplifies partial reseed, at the cost of more files/inodes for a large snapshot), then
  `POST /torrents/create` against that directory. Capture the resulting `infoHash` + `.torrent`
  metainfo, and build the `ArchiveManifest` (§2.1: ordered `{hash, size}` entries + `manifestHash`)
  alongside it. This `{infoHash, manifestHash, anchor}` triple is exactly the record that later gets
  published into the root-of-trust list (§4).
- **Import (consume a snapshot):** subject to the resource bounds in §2.3 *before* any bytes are
  requested. `POST /torrents` with a magnet URI or infoHash (+ optional explicit tracker/peer list
  if DHT is disabled per §1.4), poll `GET /torrents/{id}` for progress, and as pieces complete
  route each file/chunk through `ChainBlobSource.stageBlob` — **never directly into the canonical
  store.** rqbit's own SHA-1 piece-level "complete" status is used only as a signal "worth
  re-hashing now," never as the security boundary — this is the direct consequence of §1.3's BEP-52
  finding: BitTorrent-level integrity and UmbraDB-level content-addressing are two independent hash
  domains, and only the second one is ever trusted. Only once **every** entry in the expected
  `ArchiveManifest` is staged and hash-correct does `promoteManifest` atomically move the set into
  the canonical store (§2.1) — this exactly extends `CheckpointStore.load()`'s existing "always
  fully rehashes+verifies every chunk on load()" discipline to a new, untrusted transport, and adds
  the manifest-atomicity property the v1 draft was missing.
- **"Expected manifest" for import comes from one of two places**: a root-of-trust list entry
  (bootstrap case, §4 — PKI-TRUSTED only, until §5's direct chain-hash verification runs) or an
  already-established local manifest the caller already trusts (ordinary resync/reseed case, no
  bootstrap-trust question at all).

### 2.3 Resource bounds on ingest (new)

The v1 draft had none — a peer could claim an arbitrarily large file/torrent, and the design only
caught the problem after bandwidth/disk/time were already spent. Before any download begins, the
import path validates the **claimed** manifest (from the `.torrent` metainfo and/or the
root-of-trust entry) against explicit, configurable limits, and aborts before requesting a single
byte if any is exceeded:

- **Total size** — sum of `ManifestEntry.size` across the manifest.
- **File/blob count** — number of entries.
- **Path depth / filename shape** — reject any entry whose staged path would escape the confined
  staging root (§2.4) via traversal (`..`, absolute paths, symlink targets) or exceed a bounded
  depth/length.
- **Per-file size** — a single outsized entry is rejected even if the total is within bounds.
- **Download duration / stall timeout** — a wall-clock ceiling on the whole import, plus a
  no-progress stall timeout that aborts and discards staging (`discardStaging`) if piece-arrival
  rate drops to zero for longer than the configured window.

All limits are configuration, with conservative defaults sized for expected snapshot/archive-chunk
scale (exact numbers deferred to implementation measurement, same spirit as
`checkpoint-store.ts`'s `DEFAULT_CHUNK_SIZE` being flagged for revisit — §8). The point is
structural: **reject before spending**, not merely "eventually notice something was too big."

### 2.4 Sidecar privilege boundary and confinement (revised — was understated as "availability only")

rqbit's HTTP API is **unauthenticated by default on its loopback listener**. The v1 draft treated
the sidecar as "trusted for availability/liveness only" (mirroring VSD §10's framing for the DB) —
that framing is correct for *torrent-transport correctness* (§2.2 already never trusts it for
that) but **incomplete** as a threat model, because the API surface itself is a **local
confidentiality/exfiltration risk**, not merely an availability one: `POST /torrents/create` can
create (and start seeding) a torrent from **any local folder path** the sidecar process can read,
and the API can delete/modify torrent state. Any other local process or user able to reach
`127.0.0.1:<port>` — which, absent auth, is any co-resident process on a shared host, a container
escape, or a misconfigured port-forward — could point the sidecar at the Postgres data directory or
a wallet seed/key file and have it **seeded to the public BitTorrent swarm**. This is a
confidentiality breach, not just a liveness one, and needs to be named as such.

**Concrete hardening, required for v1, not deferred:**

- **API auth token.** Configure/require rqbit's HTTP API bearer-token auth (or, if unsupported by
  the pinned version, front the loopback socket with a minimal authenticating proxy in
  `rqbit-sidecar.ts`) — never rely on "loopback-only" as a substitute for authentication.
- **Confined staging directory the sidecar cannot escape.** The typed HTTP client
  (`rqbit-sidecar.ts`) — not rqbit itself — enforces that every `POST /torrents/create` folder
  argument it issues is a path canonicalized to be strictly inside the dedicated staging root; the
  sidecar process's own filesystem permissions (OS-level, not just application-level) should also
  be restricted to that root wherever the deployment platform supports it, so a compromised or
  misused API surface has nothing sensitive to reach even absent the application-level check.
- **Least-privilege OS identity where feasible.** Run the sidecar under a distinct, unprivileged OS
  user/service identity (e.g., a dedicated `systemd` `DynamicUser` or equivalent on the target
  platform) separate from the identity running Postgres or holding wallet key material — not
  required for correctness of the design, but a real defense-in-depth layer worth specifying rather
  than leaving to whoever implements it.
- **Disable unnecessary admin surfaces.** `GET /web/` (the human debugging UI) should be disabled in
  any non-development deployment — it is unauthenticated read/control surface with no product need
  at runtime.

This section's claims are about **local privilege boundary hardening**, not about BitTorrent
transport trust — §2.2/§6 point 3's "BitTorrent transport is fully untrusted for correctness"
framing is unchanged and orthogonal to this.

---

## 3. Alternative retrieval: the bootstrap flow

"Alternative retrieval" means concretely: a fresh preprod/testnet node or wallet, instead of a full
RPC/indexer resync from genesis, downloads a recent snapshot via BitTorrent — fast, P2P,
load-balanced across seeders, no single RPC/indexer endpoint as a bottleneck or single point of
failure — and then only replays the short tail `[N, tip]` live.

```
1. Fresh node/wallet, zero local state, networkId known.
2. Fetch the root-of-trust list for that networkId (§4). Pick the latest, non-expired,
   highest-monotonic-version entry (§4.4).
3. Verify the entry itself — PKI signature check (§5, "PKI-TRUSTED" path). This is the ONLY
   step that doesn't require the chain to already be reachable/verifiable. Data admitted this
   way is PKI-TRUSTED, not consensus-grade — see §6 for exactly what that does and doesn't mean.
4. Import via §2.2: download via rqbit, SHA-256-re-verify every blob into staging, atomically
   promote only on full-manifest match, subject to §2.3's resource bounds. BitTorrent's own hash
   checks are never the trust boundary (§1.3, §2.2).
5. The imported data, staged at the PKI-TRUSTED level and anchored at {blockHeight N, blockHash,
   manifestHash}, becomes the node/wallet's provisional BIRTHDAY FLOOR — reusing VSD §1's framing,
   one layer up the stack, but explicitly labeled provisional until step 7 upgrades it.
6. From N, sync LIVE via the normal RPC/indexer path for [N, tip] only — a short tail, not a
   from-genesis replay.
7. As soon as the node/wallet can perform VSD §4's finality check (Tier-0 k-of-n or Tier-1
   GRANDPA-justification + state-read-proof — reused unchanged, not redesigned here), it runs
   §5's direct block-hash-chain recomputation: recompute the imported archive's own header hash
   chain locally, and compare its endpoint(s) against the finality-checked on-chain block hash(es)
   just obtained. Only if that recomputation matches does trust in the bootstrap data upgrade from
   PKI-TRUSTED to CHAIN-VERIFIED (§5) — this is a local, no-new-contract check, and it should run
   automatically, by default, the moment it becomes possible, not a manual opt-in step.
```

**Precise relationship to VSD, stated explicitly so the two docs don't get conflated:** VSD's
L0–L3 stack proves a *wallet's derived balance state* is correct without chain replay. This
design's root-of-trust + PKI mechanism is one layer **below** that: it is about bootstrapping the
*chain archive data itself* (blocks/txs/proofs, the substrate VSD's own L1 tail-scan and any
from-genesis path would otherwise have to fetch slowly via RPC/indexer). A wallet can use torrent
bootstrap to fast-forward its local archive copy, then run VSD's normal L0–L3 checks against that
data exactly as if it had synced it slowly. A full node (not just a wallet) gets an even more
direct benefit: skip full historical block download/re-execution entirely, landing at a
sufficiently-verified state to begin normal consensus-following forward. **Revised composition
(the v1 draft's framing here no longer holds after §5's rewrite):** the two designs do not compose
through a shared on-chain contract or a shared `manifestHash` verification. They compose through
**VSD §4's finality-check machinery being reused, unmodified, as the trusted anchor** for this
design's own direct hash-chain recomputation (§5). `manifestHash` remains useful as the
root-of-trust list's own bookkeeping value (§4.2) and as the local blob-store's manifest-integrity
value (§2.1) — it is simply no longer the value CHAIN-VERIFIED checks.

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
  mechanism needs to make (we skip *download and replay*, not just *script verification*) — which
  is exactly why §5's direct block-hash-chain recomputation, not a self-attestation contract, is
  the mechanism that has to earn an equivalent no-forgery property here.
- **Bitcoin Core AssumeUTXO** (26.0+): nodes import a hash-committed UTXO-set snapshot at a
  checkpoint height for near-instant "usable" sync, then **background-validate** against full
  history afterward, upgrading trust once that completes — because a UTXO-set snapshot has no
  independent way to prove its own correctness from itself alone; full replay is the only check.
  **Why this design does better:** UmbraDB's archive-bootstrap scope (§0) is raw block/tx/proof
  data, not a compacted state snapshot — the imported data itself carries real chain structure
  (block hashes chained via parent-hash pointers) that can be directly re-verified against a
  finality-checked on-chain value without ever needing an AssumeUTXO-style "trust now,
  background-validate later" compromise (§5). AssumeUTXO's "cheap-trust-now, upgrade-later, same
  commitment checked both times" *shape* is still the right shape for §5.3's state machine; this
  design just gets to make the upgrade a direct recomputation rather than a background full replay.
- **Ethereum weak-subjectivity checkpoint sync**: a trusted `(blockRoot, epoch)` pair supplied
  out-of-band from a community-maintained, **explicitly-not-single-source-of-truth** list
  (`eth-clients/checkpoint-sync-endpoints` — the repo's own README warns some endpoints "may not be
  up to date," and recommends cross-checking against multiple independent sources/explorers before
  trusting one). This is the most direct precedent for §4.4's quorum-honesty requirement and §6's
  honest-residual framing.

Sources: [Bitcoin Core `assumevalid` behavior](https://github.com/bitcoin/bitcoin/blob/master/src/chainparams.cpp),
[AssumeUTXO overview](https://www.spark.money/research/bitcoin-assumeutxo-fast-sync),
[eth-clients/checkpoint-sync-endpoints](https://github.com/eth-clients/checkpoint-sync-endpoints),
[Ethereum weak subjectivity](https://ethereum.org/developers/docs/consensus-mechanisms/pos/weak-subjectivity/).

### 4.2 Structure

A small, versioned, append-only JSON document, one per network. Fields added in this revision are
marked **(new)**:

```json
{
  "network": "preprod",
  "schemaVersion": 1,
  "listVersion": 42,
  "canonicalization": "JCS-RFC8785",
  "generatedAt": "2026-07-22T00:00:00Z",
  "expiresAt": "2026-08-21T00:00:00Z",
  "entries": [
    {
      "infoHash": "<40-hex BitTorrent v1 info-hash>",
      "manifestHash": "<sha256 hex over the ordered blob-hash sequence, §2.1>",
      "anchor": { "blockHeight": 1234567, "blockHash": "0x...", "finalizedHash": "0x..." },
      "publishedAt": "2026-07-22T00:00:00Z",
      "maxCheckpointAgeSeconds": 2592000,
      "torrentFileUrl": "https://.../<infoHash>.torrent",
      "supersedes": "<prior manifestHash, or null>"
    }
  ],
  "revokedKeyIds": [],
  "signatures": [
    { "keyId": "umbradb-v1-2026", "algorithm": "ed25519", "signature": "<base64>" }
  ]
}
```

- **`canonicalization` (new).** The exact byte sequence that is signed must be reproducible by
  every verifier; without a specified canonicalization, two semantically-identical JSON documents
  with different whitespace/key-order would produce different signatures, or worse, invite
  signature-malleability confusion. Specify a concrete scheme (RFC 8785 JCS, or an equivalent
  deterministic encoding) up front rather than leaving it implicit.
- **`listVersion` (new) — monotonic, independent of `publishedAt`.** A strictly-increasing integer
  across every published list for a given network, checked client-side against the
  highest-ever-seen value in a small local cache (the same "local monotonic counter" shape VSD §3's
  L2 anti-rollback uses) — see §4.4.
- **`expiresAt` / per-entry `maxCheckpointAgeSeconds` (new).** A list, or an individual entry,
  past its freshness window is treated as **absent**, not "old but still fine" — prevents an
  attacker from replaying a stale-but-genuinely-signed list/entry indefinitely.
- **`revokedKeyIds` (promoted from prose to a real field, §4.3/§5.4).**

`torrentFileUrl` is a **convenience mirror only** — never trust-bearing; if unreachable, the
`infoHash` alone plus DHT/PEX (§1.4) is sufficient to locate peers (subject to §6 point 9's wallet
privacy caveat).

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
   narrow trust claim: "the UmbraDB project asserts this torrent's content matched this chain
   anchor at publish time" — a claim §5 no longer treats as anything stronger than
   bootstrap-convenience input, because §5's actual verification never depends on it being true.
2. **v1.x/v2, needs external coordination, the one the task actually asks for:** Shielded Labs or
   the Midnight Foundation signs (ideally via a threshold/multisig committee, §4.4) or endorses
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

### 4.4 Quorum policy, versioning, and key governance (expanded)

- **Quorum policy — stated precisely, not left implicit.** An **m-of-n threshold signature**
  (e.g., 2-of-3 or 3-of-5 over the `signatures` array) is a real quorum: forging an entry requires
  compromising `m` independent keys. **Independently-hosted *mirrors* of a list signed by a single
  key are NOT equivalent** — every mirror agrees trivially with every other mirror even if that one
  signing key is compromised, because they are all serving byte-identical copies of the same
  signature. Mirroring defends against **availability/hosting** failure (one mirror goes down, use
  another) and gives a **cheap, real signal of tampering-in-transit** (if two mirrors disagree on
  content for the same `listVersion`, something is wrong), but it is not a substitute for
  cryptographic threshold signing, and this document must not describe it as one. Recommendation:
  threshold signing for the actual trust property, independent mirroring as an additional
  operational/availability habit on top (borrowing Ethereum's checkpoint-sync-endpoint "don't trust
  one provider" habit, §4.1) — not either/or.
- **Monotonic version, rollback and freeze protection.** A verifier keeps the highest `listVersion`
  it has ever accepted for a given network in a small local cache; a freshly-fetched list with a
  lower `listVersion` is rejected outright (rollback), and a list that has not advanced past a
  configured staleness window despite `expiresAt` claims otherwise is treated as **frozen/stale**
  and not trusted for a fresh bootstrap (distinct from ordinary "no update needed" — the freeze
  check specifically catches an adversary serving a genuinely-signed-but-outdated list indefinitely
  to a victim it can keep isolated from a real update).
- **Rotation.** Each key is versioned (`keyId`, e.g. `"shielded-labs-2026-q3"`); a new key is
  published with an overlap window before the old one stops being honored for *new* entries;
  already-published, already-verified entries remain valid under whichever key signed them (no
  retroactive invalidation from routine rotation).
- **Revocation.** The `revokedKeyIds` field (§4.2) or an equivalent out-of-band channel (matching
  `midnight-node/SECURITY.md`'s existing disclosure/advisory process) — a revoked key's signatures
  must be treated as absent, not merely "old," the moment revocation is known.
- **Compromise blast radius — restated honestly for the post-rewrite design.** A compromised PKI
  key (up to the quorum threshold) can, at most, mislead a node/wallet that is (a) bootstrapping
  from zero prior state, **and** (b) has PKI-bootstrap enabled, **and** (c) has not yet completed
  §5's direct chain-hash recomputation, **and** (d) is not cross-checking multiple independent list
  mirrors. It cannot cause a node/wallet that *has* completed §5's recomputation to accept bad
  data, because that recomputation never reads the PKI signature or any publisher-asserted value at
  all — it is a local recomputation checked only against a finality-checked on-chain block hash.
  This is a **stronger** property than the v1 draft's claim (which rested on an on-chain contract
  that was itself forgeable by the same class of key compromise) — it is stronger precisely because
  there is no longer a second key-gated surface for a compromised key to reach.

---

## 5. PKI-TRUSTED to CHAIN-VERIFIED: direct on-chain verification, not a new attestation contract

### 5.1 What went wrong in the v1 draft, stated precisely

The v1 draft's §5 proposed `attestArchiveSnapshot`, a Compact contract circuit any key-holder could
call to record `{commitment, height}` in a `chainSnapshotAttestations: Map<Bytes<32>,
ArchiveAttestRecord>`, gated only by **per-publisher height-monotonicity** (`prev.height < height`).
Three independent reviewers converged on why this fails: publishing to that map only proves
**someone with a key claimed a value on a finalized chain** — it says nothing about whether the
claimed `manifestRoot` corresponds to real chain data. An attacker holding (or having compromised) a
publisher key can call `attestArchiveSnapshot` with **their own fabricated `manifestRoot`**, and the
call succeeds — the on-chain check "passes" exactly as designed, because self-consistency
(monotonic height under one key) was the only thing being checked, and self-consistency is trivially
satisfiable by a liar. The v1 draft's central claim — "a compromised PKI key cannot, by construction,
forge a passing on-chain check" — was false: it conflated *the on-chain check succeeding* with *the
on-chain check having verified anything about truth*. A victim "upgrading" to CHAIN-VERIFIED via a
matching `chainSnapshotAttestations` record was trusting attacker-supplied data precisely at the
moment the design told them they no longer needed to.

**Why the fix isn't a smarter version of the same contract** (extra co-signers, a bonding/slashing
scheme, reputation-weighted publishers, etc.): every such variant still ultimately roots trust in
*someone's key(s)* being honest, which is exactly the PKI-bootstrap trust class §4 already covers
and §6 already treats as a real, bounded, non-eliminable residual — dressing it up as an on-chain
contract doesn't make it consensus-grade, it just makes a permissioned-trust mechanism *look* like a
chain-verification mechanism, which is the precise mislabeling the reviewers flagged. The genuine
fix is to not need any publisher's honesty for archive verification at all.

### 5.2 The fix: verify imported archive data directly against real on-chain block structure

Unlike wallet-state (which VSD's own L3 discussion notes has no independent way to recompute
correctness without either the DB or a fresh full replay — that's precisely why VSD needs an
on-chain attestation contract at all, VSD §3), **full-chain archive data does not have this
problem**: block hashes are already an intrinsic hash chain — each block header commits to its
parent's hash, and (per VSD §1/§4) GRANDPA finality on a block precludes reverting it or any
ancestor. That means the exact same pattern VSD's L0 layer already uses for wallet snapshots
("recompute locally, then compare against a value obtained from a trusted/finality-checked on-chain
query," VSD §2) applies directly to archive data, one layer up the stack, with **no new contract and
no publisher-key trust surface**:

1. **Recompute locally.** From the imported (still only PKI-TRUSTED, staged-then-promoted per §2.1)
   archive data, recompute each block header's own hash from its raw header fields, and verify that
   each header's declared parent-hash pointer equals the previous block's recomputed hash — an
   unbroken hash-chain walk across the whole imported range. Where the archived data includes
   transaction/proof bodies, additionally recompute the body-level commitment (e.g., an
   extrinsics-root-shaped Merkle root over the block's transactions) and check it against the value
   the already-hash-chain-verified header declares — this is the same header/body-commitment check
   VSD §4/§5 already grounds against real Midnight node internals (`state_getReadProof`,
   `state_root`), reused here for archive bodies instead of wallet state reads. This step is pure
   hashing — no execution, no state replay — the same reason "headers-first" sync is cheap in every
   chain that does it.
2. **Anchor the top of the chain to a finality-checked value.** Obtain the finalized block hash at
   height ≥ N via VSD §4's Tier-0 (k-of-n RPC/indexer cross-check) or Tier-1 (GRANDPA justification +
   `state_getReadProof`) machinery — **reused completely unchanged**, no new finality-verification
   code. Require the locally-recomputed header hash chain to terminate at (or pass through, if N is
   below the current finalized tip) that value.
3. **Anchor the bottom of the chain.** For a from-genesis bootstrap, anchor to the network's
   genesis block hash — the same irreducible weak-subjectivity seed VSD §10 point 1 already accepts
   as the floor of all finality trust ("bootstrapped once from the genesis GRANDPA authority set in
   the public chain spec"); no new trust primitive is introduced. For an incremental resync/reseed
   that already has a prior local CHAIN-VERIFIED point, anchor to that point instead — cheaper, and
   still fully justified by the same chain-of-custody argument.
4. **Result.** If the recomputed chain is internally consistent end-to-end and both endpoints match
   trusted values (genesis-or-prior-anchor at the bottom, finality-checked hash at the top), the
   imported range is provably a contiguous, unmodified segment of the canonical finalized chain —
   **this needs no attestation from anyone**, because forging it requires either breaking SHA-256
   (finding a second preimage that reproduces the same finality-checked hash) or subverting GRANDPA
   finality itself (VSD §10 point 1's already-accepted residual) — not merely holding or compromising
   a publisher key. This is strictly stronger than the self-attestation approach, and needs no new
   Compact contract, no publisher-role key, no new circuit to audit.

### 5.3 The trust-upgrade state machine (revised)

```
PKI-TRUSTED  --[the locally-recomputed archive block-hash chain is internally consistent across
                the imported range AND its top anchor equals a value obtained via VSD §4's
                finality-checked query at height >= N AND its bottom anchor equals genesis (or
                a prior local CHAIN-VERIFIED point)]--> CHAIN-VERIFIED

PKI-TRUSTED  --[the recomputed chain diverges anywhere from a declared parent hash, or its top
                anchor does not match the finality-checked value, or a body-level commitment
                check fails]--> INTEGRITY-FAILURE (hard fail: discard/quarantine the ingested
                                data via ChainBlobSource.discardStaging — do not silently keep it,
                                and do not partially promote)
```

- Every blob ingested via the bootstrap path (§3) is tagged internally with its trust state
  (`trustLevel: 'pki-bootstrap' | 'chain-verified'`) — **never silently presented as fully
  verified** while still in the PKI-TRUSTED state. This is the direct analogue of VSD's own
  discipline never to imply "fully verified, no trust in the feed" when a residual gap remains
  (VSD §12's "biggest risk" framing) — and, per §6, PKI-TRUSTED data should not be used for any
  consequential decision (financial or otherwise) until the upgrade completes.
- The upgrade check runs automatically, by default, as soon as it becomes possible — not an
  opt-in extra step (per the task's explicit instruction). It reuses VSD §4's Tier-0/Tier-1
  finality machinery unchanged, and adds only local hashing over already-downloaded data — no
  network round-trip beyond the finality query VSD §4 already performs.
- **A security-conscious operator can disable the PKI path entirely** (config flag) and fall back
  to (i) full RPC/indexer replay from genesis, or (ii) bootstrapping only from an `infoHash`+
  manifest the operator already trusts out of band, skipping the root-of-trust list. Default
  posture: PKI-bootstrap-on for wallets/light clients (fast start matters, and the auto-upgrade
  bounds the exposure), recommended PKI-bootstrap-off for validator/archival nodes (should sync
  from genesis or verify directly, not lean on a convenience list) — this default split should be
  ratified by whoever reviews this design, not silently assumed.

### 5.4 On "which publisher do I trust" — deliberately not kept as a contract-backed concept

The v1 draft's `publisherSecretKey()`/publisher-role identity existed only to support
`attestArchiveSnapshot`'s per-publisher height-monotonicity CAS. With that contract removed, the
question the task's fix-direction note raises — "if a narrower publisher-trust concept still seems
useful, it needs an out-of-band-pinned identity, not one sourced from the PKI list itself" — was
checked against the redesigned flow and found **not to be needed**: §5.2's verification never asks
"which publisher do I trust," only "does this data's own hash chain match a finality-checked
on-chain value." There is no remaining role for a publisher identity to play in the correctness
check itself. (A publisher identity still appears descriptively in §4's root-of-trust list — who
signed *the list entry pointing at* a manifest — but that is squarely the PKI-bootstrap-convenience
trust class §4/§6 already cover, not a second verification path.) If a future need for out-of-band
publisher reputation emerges (e.g., ranking which mirrors/seeders are more reliable for
availability), that is an availability-tier concern, not a correctness-tier one, and does not need
on-chain or PKI-list-sourced identity — flagged in §8 rather than designed further here.

---

## 6. Honest residual trust

Stated plainly, matching VSD §10's discipline of never overclaiming — extended to cover this
revision's newly-fixed areas, not just the original scope:

1. **Consensus/finality.** Identical to VSD §10 point 1, inherited unchanged: correctness reduces
   to an on-chain root, whose trust reduces to GRANDPA not reverting blocks ≤ N, down to one
   irreducible weak-subjectivity seed (the genesis authority set). This design adds no new
   finality primitive; it reuses VSD §4's, both as the anchor for §5's own recomputation and,
   per VSD, for a wallet's subsequent L0–L3 checks.
2. **The PKI-bootstrap window is a real, not fully eliminable, exposure — shared by every
   bootstrap-trust mechanism that has ever shipped** (Bitcoin `assumevalid`/AssumeUTXO, Ethereum
   weak-subjectivity checkpoint sync, Zcash's *trusted* birthday — VSD §1 already notes ours is
   *stronger* than Zcash's for the wallet case; the PKI-bootstrap path reintroduces a Zcash-like
   trusted-third-party assumption specifically for the pre-upgrade window). **Precisely bounded
   now (§5.4):** the window closes the moment §5's direct recomputation runs, and that
   recomputation depends on zero publisher honesty — the only thing a compromised PKI key can do
   is delay or mislead a victim who has not yet reached CHAIN-VERIFIED and who a real attacker can
   also keep eclipsed from chain connectivity. Mitigation is defense-in-depth (§4.4's threshold +
   mirror cross-check, sane default timeouts that push toward attempting the upgrade promptly,
   §2.3's bounded ingest so a misleading PKI entry cannot also be a resource-exhaustion vector) —
   not elimination, and this document does not claim elimination.
3. **BitTorrent transport is fully untrusted for correctness, always.** Every byte is
   SHA-256-re-verified into staging before promotion (§2.1/§2.2), regardless of rqbit's own SHA-1
   piece-level "complete" status. A malicious or buggy seeder can waste the bootstrapper's
   time/bandwidth (bounded now by §2.3) but cannot get bad data accepted, and per point 2's bound,
   cannot get bad data permanently labeled chain-verified.
4. **BEP-52 gap (§1.3).** Torrent piece hashes and UmbraDB content hashes are two independent hash
   domains, bridged only by our own re-verification step, never by a BitTorrent-native mechanism.
   Revisit if rqbit (or an alternative client) ships BEP-52 — would allow piece hashes to *align
   with* (not replace) content hashes, tightening the transport-level integrity story, but the
   application-level SHA-256 re-verify should remain regardless (defense in depth, not solely
   reliant on a third-party client's hashing correctness).
5. **The rqbit sidecar is trusted for availability/liveness for transport correctness purposes**
   (same framing VSD §10 uses for the DB itself), **but is an active local privilege-boundary risk
   for confidentiality**, not merely a liveness concern — §2.4's hardening (auth token, confined
   staging root, least-privilege OS identity, disabled admin surfaces) is required precisely
   because "trusted for availability only" understates what an unauthenticated local HTTP API that
   can read-and-seed arbitrary folders can do if reachable by an unintended local caller.
6. **Root-of-trust list hosting is a single point of failure for the bootstrap-convenience path
   only**, never for correctness. If unreachable, or if the operator disables it (§5.3), fall back
   to ordinary RPC/indexer sync from genesis — the mechanism degrades to "no faster than today,"
   never to "silently wrong."
7. **The Shielded-Labs/Foundation-endorsed tier (§4.3 tier 2/3) is a coordination dependency this
   design cannot deliver alone.** If that coordination never happens, UmbraDB should ship (and
   keep clearly, permanently labeled as) only its own weaker, self-signed tier-1 list — never
   silently upgrade its own labeling to imply official endorsement it doesn't have.
8. **Independently-hosted mirrors of a single-key-signed list are an availability/tamper-evidence
   habit, not a threshold-security property** (§4.4) — this document does not conflate the two, and
   any implementation claiming "we have N mirrors, so this is threshold-secure" would be repeating
   the exact class of overclaim this revision exists to fix.
9. **Wallet privacy — the DHT/tracker bootstrap-announcement leak (new, previously unaddressed).**
   If PKI-bootstrap defaults to on for wallets (§5.3), and DHT/PEX discovery is enabled (§1.4), a
   wallet announcing itself into the public BitTorrent DHT to find peers for a chain-archive torrent
   **leaks that a Midnight wallet is bootstrapping at a given IP address, at a given time**, to
   anyone monitoring the DHT — a pattern-of-life/deanonymization signal, independent of anything the
   torrent content itself reveals. This is explicitly in scope for this document's threat model —
   VSD treats scanner-privacy (§6 there) as first-class, and this design should match that
   discipline rather than leave the gap unstated as the v1 draft did. **Not resolved here** (fixing
   it well likely means routing wallet bootstrap through a private/curated tracker or an explicit
   seed list instead of the public DHT by default, or proxying discovery traffic — both real
   options already available per §1.4's config flexibility, but neither is designed in depth in this
   revision) — flagged as an open item for whoever reviews this design (§8), with the explicit
   requirement that it not ship silently unaddressed the way the v1 draft left it.
10. **The direct block-hash-chain recomputation (§5) has a real cost, stated honestly, not
    zero-cost magic.** Walking a full header chain from genesis to a current finalized tip is pure
    hashing (no execution/replay) and is the same cost class every "headers-first" sync design
    accepts as cheap relative to full state replay — but it is not free: bandwidth to fetch headers
    for the full range (if not already included in the imported archive data) and CPU time to hash
    them both scale with chain length. This is still strictly cheaper than the from-genesis
    RPC/indexer resync this design exists to avoid, but this document does not claim the
    recomputation itself is instantaneous or resource-free.

---

## 7. Phasing table

| Capability | Buildable now (UmbraDB alone) | Needs Shielded Labs / Foundation coordination | Research-grade / upstream-dependent |
|---|---|---|---|
| rqbit sidecar spawn + typed HTTP client, hardened per §2.4 (auth token, confined staging root) | ✅ §2.2/§2.4 | | |
| Export flow (blobs → torrent, `POST /torrents/create`) | ✅ §2.2 (works today against `CheckpointStore`; consumes `chain_blobs` unchanged once that schema lands) | | |
| Import flow: staging + per-blob SHA-256 re-verification + atomic manifest promotion (§2.1) | ✅ §2.1/§2.2 | | |
| Resource-bounded ingest (size/count/depth/duration caps, §2.3) | ✅ §2.3 | | |
| `src/network/` module + fixed `ChainBlobSource` interface + BOTH-direction guard tests (§2.1) | ✅ §2.1 | | |
| Bootstrap orchestration (birthday-floor flow, §3) | ✅ as design/interface now; full-chain usefulness partially blocked on `chain_blobs` landing (wallet-checkpoint case works today unblocked) | | |
| Root-of-trust list v1, UmbraDB-self-signed, versioned/canonicalized/expiring (§4.2/§4.4), clearly labeled non-official | ✅ §4.3 tier 1 | | |
| Direct block-hash-chain CHAIN-VERIFIED recomputation (§5) reusing VSD §4's finality checks | ✅ (VSD §4 machinery is already designed; this adds only local hashing, no new contract) | | |
| Shielded Labs / Foundation co-signing or GitHub-attestation-based publishing of the list (§4.3 tier 2/3) | | ✅ pure coordination ask | |
| Any official Shielded-Labs-published checkpoint/snapshot cadence or endorsement | | ✅ | |
| BEP-52-aligned piece hashing | | | ✅ upstream-dependent on rqbit (or an alternative client) shipping it |
| Anti-eclipse hardening for the bootstrap window (multi-path root-of-trust fetch, network-diversity checks) | | | ✅ |
| Wallet DHT-announcement privacy fix (§6 point 9) | flagged, not designed in depth this revision | | possibly research-grade depending on chosen fix |

---

## 8. Open questions for whoever reviews this design

Mirroring VSD §12's practice of surfacing genuinely open decisions rather than silently picking one:

- **Default posture for §5.3's PKI-bootstrap on/off split** (wallets default-on, nodes
  default-off, as sketched) — needs ratification, not assumed.
- **File layout for exported torrents** (one file per content hash vs. concatenated blob +
  index, §2.2) — affects reseed granularity and inode overhead; deferred to implementation
  measurement against real snapshot sizes, same spirit as `checkpoint-store.ts`'s own
  `DEFAULT_CHUNK_SIZE` being flagged "revisit under Milestone 4 once real measurements exist."
- **Exact numeric values for §2.3's resource bounds** (total size, file count, path depth,
  per-file size, stall timeout) — deferred to implementation measurement against real archive
  snapshot sizes; this document specifies the mechanism, not the constants.
- **Whether `src/network/` stays in-repo or becomes a separate package** (§2.1) — recommended
  in-repo for v1, revisit once its own dependency footprint is measured.
- **Whether tier-2 signing (§4.3) should be GitHub-attestation-based or classic Ed25519/threshold**
  — proposed GitHub-attestation-based as the lower-friction ask given existing infrastructure, but
  this is Shielded Labs'/the Foundation's call, not this design's to make unilaterally.
- **Wallet DHT-announcement privacy (§6 point 9)** — needs a concrete design (private tracker
  default for wallets? proxied discovery? something else?), not just the flag this revision adds.
- **Whether a full from-genesis header-chain recomputation is required for every v1 bootstrap, or
  whether a periodically-refreshed, still-cryptographically-anchored checkpoint (a trusted "recent
  finalized height" rather than genesis) is an acceptable bottom-anchor shortcut for the common
  case** — §5.2 describes both the from-genesis and prior-local-anchor cases; whether a *first-ever*
  bootstrap should be allowed to anchor to something other than genesis (and under what conditions)
  is a call for whoever reviews this design, not decided unilaterally here.
- **OS-level least-privilege isolation feasibility for the rqbit sidecar (§2.4) across UmbraDB's
  actual target deployment platforms** — sketched as a recommendation, not verified against every
  platform UmbraDB needs to support.
- **Availability-tier publisher/mirror reputation (§5.4's closing note)** — flagged as a possible
  future, deliberately out-of-scope-for-correctness concern; not designed here.

---

*Grounding: rqbit README/Cargo.toml/LICENSE/commits (`github.com/ikatson/rqbit`, fetched
2026-07-22); `design/verifiable-snapshot-design.md` (cited throughout as VSD, §§1,2,3,4,10 in
particular for this revision); `src/postgres/checkpoint-store.ts`,
`src/postgres/migrations/002_checkpoint_store.ts`; `test/postgres/no-sdk-import-guard.test.ts`;
`src/interfaces/checkpoint-store.ts` (grounds §2.1's claim that `CheckpointStore` does not natively
satisfy `ChainBlobSource`); `midnight-node/docs/security/*`,
`midnight-node/docs/operations/release-checklist.md`,
`midnight-node/.github/workflows/release-image.yml` (fetched from local `/root/midnight/midnight-node`
checkout); Bitcoin Core `assumevalid`/AssumeUTXO and Ethereum weak-subjectivity checkpoint-sync
prior art (public sources cited inline, §4.1); this revision additionally grounded against a
3-reviewer design-council audit (Claude Fable 5, Claude Opus, GPT-5.6 Sol) whose unanimous
NEEDS-REWORK finding is summarized in the Revision history above. No Midnight source modified;
nothing committed outside this design doc.*
