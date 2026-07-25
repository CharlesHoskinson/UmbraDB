# Security policy & threat model

UmbraDB is a single-node, single-writer storage **library** for Midnight clients. It is **not** a
service, not a distributed system, and not a multi-tenant database. Its security properties follow
directly from that shape, and this document states — as **binding assumptions a deployer must
uphold** — the trust boundaries the code relies on but does **not** itself enforce. The single
acute InfoSec risk for a project like this is a deployer over-trusting a boundary the library never
implemented; the purpose of this file is to remove that risk by naming every such boundary
explicitly.

If a statement below is phrased as a **MUST**, it is a precondition for safe operation, not a
recommendation. Where a claim rests on code, the file and line are cited so it can be re-verified
against the tree.

## Trust model (the assumptions the code is built on)

### T-A1 — Single trusted writer, one trust domain

The deployer **MUST** ensure exactly **one trusted process** holds the Postgres connection and
drives all reads and writes. There is **no adversarial API caller**: every consumer of the public
API (`createClient`, the five adapters, `PgWalletStateEnvelopeStore`) MUST be inside one trust
domain. The library performs no authentication, authorization, rate-limiting, or per-caller
isolation of its own — it is a storage engine, and the process embedding it is responsible for who
may call it.

This is the library's explicit design posture, not an accident: the connection-pool and lease code
states it in-line — "this project's single-writer deployment model does not expect callers to probe
for exhaustion" (`src/postgres/transaction-lease.ts:328`). The advisory-lock lease
(`acquireLease`/`withLease`) coordinates a single logical writer against itself across processes;
it is **not** a security mechanism that fences off a hostile writer.

### T-A2 — Trusted Postgres, disk, backups, and operator

The deployer **MUST** ensure the Postgres instance UmbraDB connects to, the disk that instance
writes to, its backups, its replicas, and the operator who administers it are all **trusted**. The
DB role UmbraDB connects as owns every schema it touches and may read and write every byte UmbraDB
stores. UmbraDB provides no defense against a compromised database server, a stolen backup, or a
malicious DBA — protecting those is the deployer's responsibility (see *Data at rest*, below).

## `schema` is namespacing, NOT a security or tenant boundary

Every UmbraDB adapter accepts a Postgres `schema` (defaulting to the client's configured schema).
A `schema` is an **organizational namespacing convenience only**. It is **NOT** a security or
tenant boundary:

- All queries run under **one** DB role that owns every schema it is pointed at.
- A caller can point any adapter at **any** schema; nothing in the library prevents it. Cross-schema
  access is prevented **only** by T-A1 (the single trusted writer chooses which schema to use), not
  by any access control the library enforces.

Therefore, **if you ever need real multi-tenancy** (mutually-distrusting tenants that must not read
or write each other's data), you **MUST** enforce it at the **Postgres level** — a role per tenant
with `GRANT`s scoped to that tenant's schema, and/or row-level security (RLS) — and **never** rely
on the UmbraDB `schema` argument for isolation. UmbraDB will not, and is not designed to, keep two
tenants apart on its own.

## The chunk pool is one global trust domain with an observable cross-wallet side channel

`CheckpointStore` (and `PgWalletStateEnvelopeStore`, which is built on it) stores large snapshots as
content-addressed chunks in a **single global, content-addressed pool that is shared across all
wallets** — not partitioned per wallet or per network. A chunk is written once, keyed by the hash of
its own bytes, and re-used ("deduplicated") by any later checkpoint — for the same wallet or a
**different** one — whose data contains an identical chunk. The dedup upsert is a global
`ON CONFLICT (hash) DO UPDATE SET created_at = now()`
(`src/postgres/checkpoint-store.ts:233`) and garbage collection reclaims a chunk only when **no**
manifest **anywhere in the store** still references it (`src/postgres/checkpoint-store.ts:518-527`).

Because that pool is global, chunk **existence** and garbage-collection **behavior** are
**observable across wallets** through two side channels. Both are the classic cross-user
deduplication oracle (Harnik–Pinkas–Shulman-Peleg):

1. **A `save`-timing existence oracle.** Writing a chunk whose bytes are **not yet** in the pool
   performs a first-time `bytea` write of up to a full 4 MiB chunk; writing a chunk whose bytes are
   **already** present degenerates to a metadata-only `ON CONFLICT` no-op. The latency difference
   lets one wallet **confirm whether a given chunk already exists** in the shared pool — i.e.
   whether some **other** wallet has already stored those exact bytes.
2. **A `prune` reclaim oracle.** `prune` returns `reclaimedBytes`/`reclaimedChunks`
   (`src/postgres/checkpoint-store.ts:527,531`). Whether a chunk this wallet just unreferenced is
   actually reclaimed depends on whether **another** wallet's manifest still references it. The
   return value therefore leaks **cross-wallet reference state** — whether a different wallet is
   still holding the same chunk.

**Consequence — a binding deployment condition.** Placing **mutually-distrusting principals** on one
UmbraDB store is an **UNSUPPORTED** deployment. "Multiple wallets" in UmbraDB means one user's wallet
application managing several of that user's own wallets — **one trust domain** — **not**
multi-tenancy across users who must not learn about each other's data. If you need the latter, give
each principal its **own** database/store (see also T-A1 and the multi-tenancy redirect above).

**Bound on the leak — a known-content confirmation oracle at the configured chunk granularity.**
Chunking is **fixed-size**, not content-defined: `save` splits the payload into fixed `chunkSize`
slices (`splitChunks`, `src/postgres/checkpoint-store.ts:103-107`). `chunkSize` is
**caller-configurable** — any positive value (up to 16 MiB) via `SaveCheckpointOptionsSchema`
(`src/interfaces/checkpoint-store.ts:43`), defaulting to `DEFAULT_CHUNK_SIZE = 4 MiB`
(`src/postgres/checkpoint-store.ts:33`) — and a payload's final slice may be **shorter** than
`chunkSize`. The oracle therefore **confirms the existence of a chunk whose exact bytes the attacker
already possesses**, at the **granularity of the deployment's configured chunk size**: at the 4 MiB
default it confirms a whole 4 MiB-aligned block, but a **smaller** configured `chunkSize` yields
**finer-grained** confirmation — down to sub-field granularity if a deployment configures small
chunks. It is a **known-content confirmation** oracle, **not** an arbitrary-extraction primitive:
the attacker learns only whether bytes they **already hold** are present, never the contents of an
unknown secret revealed to them wholesale. (As with any confirmation oracle, an attacker who can
already enumerate a *small* candidate space could confirm-by-guessing within it; that too is bounded
by the trust model, not by the chunk size.) **What removes the risk is the single-trust-domain
requirement above — not the chunk size:** every principal on one store is mutually trusting, so no
adversary is positioned to run the oracle at any granularity.

## Data at rest — NO encryption is provided (a binding deployer precondition)

**UmbraDB provides NO at-rest encryption and NO encryption hook of its own.** Payloads are persisted
as **plaintext** `bytea`. In particular the wallet-state envelope path encodes state with
`new TextEncoder().encode(JSON.stringify(...))`
(`src/interfaces/wallet-state-envelope.ts:144`) and stores the result directly as plaintext chunks.
For a Midnight **shielded** wallet those bytes include **spending-key / coin-secret material**;
anyone who can read the Postgres data files, a backup, or a replica can read that material in the
clear.

**Therefore a deployer persisting secret-bearing payloads MUST do one of the following** (this is a
requirement, not a suggestion):

- **Encrypt the storage substrate** — encrypt the disk/volume backing Postgres, use Postgres
  transparent data encryption (TDE), and encrypt every backup and replica. This applies to **all**
  users. It is the only mitigation available *without writing code* to callers of the **envelope
  store** (`PgWalletStateEnvelopeStore`), because that path is **NOT** byte-opaque: its
  `save(envelope)` **always** plaintext-`encode()`s the state to `bytea`
  (`src/postgres/wallet-state-envelope.ts:38` → `src/interfaces/wallet-state-envelope.ts:144`), so
  a deployer cannot simply hand it ciphertext.

  *Precision (audit correction): there is **no built-in encryption hook** on that path, which is not
  the same as there being no alternative. `PgWalletStateEnvelopeStore` composes over an **injected**
  `CheckpointStore`, so a caller MAY supply a decorator that encrypts in `save` and decrypts in
  `load` before delegating to `PgCheckpointStore`. That is caller-written code UmbraDB neither ships
  nor validates — and it forfeits cross-wallet dedup, since ciphertext does not collide — but it is
  a real option and this document previously said it did not exist.* **OR**
- **Pass ciphertext to the raw byte-level `CheckpointStore.save` — NOT the envelope store.** Only the
  raw `CheckpointStore.save(id, data)` is byte-opaque: it accepts a `Uint8Array` and stores exactly
  those bytes, returning them verbatim; it neither inspects nor transforms them. A deployer using
  **that** API MAY encrypt the payload **before** handing it to UmbraDB, so only ciphertext ever
  reaches the database. (The envelope store offers no such control today; the `EnvelopeCipher`
  at-rest-encryption seam — a documented 1.1 fast-follow, see *Scope* below — is what will let
  envelope-store users inject encryption.)

If neither mitigation is in place, secret-bearing wallet state is stored in the clear. This is
CWE-312 (cleartext storage of sensitive information) and is an **accepted, documented** property of
the 1.0.0 library — the obligation to close it sits with the deployer.

## Commit policy — what may and may not go into git

- **No key, seed, password, or credential with ANY value may EVER be committed to this repository** —
  not mainnet, not "just testnet with real funds," not "temporarily." Secret-bearing files are
  **generated locally, never committed**, and are created with `chmod 600` (owner read/write only).
- **One allowlisted exception, with justification.** A single Midnight **Preview testnet** wallet
  artifact was historically committed at `nix/midnight-env/test-wallets/preview-test-wallet.json`.
  Preview `tDUST` has **no monetary value** and exists only to let the dev environment transact on a
  throwaway testnet without re-funding on every fresh machine. That specific historical path is the
  **sole** allowlisted entry in `.gitleaks.toml`. As of 1.0.0 that file is **no longer tracked**
  (untracked + `.gitignore`d); it is replaced by `preview-test-wallet.example.json` (non-secret
  placeholders) and a `generate-test-wallet.sh` generator (see
  `nix/midnight-env/test-wallets/README.md`). Its bytes remain in git **history** (no history
  rewrite was performed, because the key is verified valueless); the go-forward guard is the
  **full-history `gitleaks` gate** in CI (`.github/workflows/supply-chain.yml`), which allowlists
  exactly that one historical path and the `.example` placeholder — and fails on a real secret
  anywhere else.
- **CI enforces this.** Every pull request and every push to `main` is scanned by `gitleaks` over
  full git history; a new secret on any non-allowlisted path fails the build.

## Reporting a vulnerability

If you discover a security vulnerability in UmbraDB, please report it **privately** rather than
opening a public issue:

- Use GitHub's **private vulnerability reporting** ("Report a vulnerability" under the repository's
  **Security** tab), or
- Email the maintainers at the contact address listed in the repository's project metadata.

Please include the affected version/commit, a description of the issue and its impact, and
reproduction steps where possible. We will acknowledge the report, investigate, and coordinate a fix
and disclosure timeline with you. Because UmbraDB's trust model assumes a single trusted writer and
a trusted database (T-A1/T-A2), please frame findings against that model — a report that assumes an
adversarial caller or a hostile co-tenant is describing a deployment this library explicitly does
not support (see above), not a library vulnerability.

## Scope — documented preconditions vs. implemented controls (1.0.0)

This document **documents** several security preconditions that the 1.0.0 library does **NOT
implement**. They are the P1 fast-follows tracked for a later release. A reader must **not** mistake
a documented precondition here for an implemented control:

- **Keyed / scoped chunk addressing → 1.1.** The cross-wallet dedup side channel above would be
  closed by keying chunk addresses per trust domain (so chunks never dedup across principals). This
  is a **1.1 code fast-follow**; 1.0.0 addresses it by **documentation only** (this file + the
  `CheckpointStore` interface caveats). **Not implemented in 1.0.0.**
- **`EnvelopeCipher` (at-rest encryption seam).** An injectable encryption seam on the envelope path
  that would let the library encrypt secret-bearing payloads itself. 1.0.0 provides **no** such seam;
  the binding "encrypt the substrate or pass ciphertext" precondition above stands in its place.
  **Not implemented in 1.0.0.**
- **VerifyFull-by-default TLS for the dev stack.** The `nix/midnight-env` db-sync TLS tooling
  defaults to `Require` (encryption, no server-identity validation) and offers an **opt-in** `--ca`
  VerifyFull path; a VerifyFull **default** is **not** shipped (see `nix/midnight-env/README.md` for
  the caveat and the reasoning). **Default not flipped in 1.0.0.**
- **Two-role Postgres topology.** A split between a privileged migration/DDL role and a
  least-privilege runtime role is **not** provided; 1.0.0 assumes one owning role (T-A2). **Not
  implemented in 1.0.0.**

Each of these is a deliberate 1.0.0 scope decision, documented so the boundary is legible.
