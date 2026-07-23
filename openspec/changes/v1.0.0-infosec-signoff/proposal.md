# Proposal — v1.0.0-infosec-signoff

> **Status:** Draft for the 1.0.0 program. Capability: `security-posture`. Covers gate items
> **G15–G19** of `ROADMAP-v1.0.0-CONSOLIDATED.md` (the InfoSec sign-off section, §E). Primary
> evidence: `04-infosec-codebase.md`, `05-infosec-infra.md`, adjudicated by `council/C-security.md`.

## Why

UmbraDB is a local, single-writer, PostgreSQL-backed datastore for Midnight clients. The two
independent InfoSec deep-research passes (application/codebase and infrastructure/supply-chain)
and the security council's adjudication reached the same headline verdict: **there is no
code-level security blocker under the stated trust model** (single trusted writer, single local
Postgres). The residual 1.0.0 InfoSec obligations are almost entirely (a) *documentation* that
makes the trust model's load-bearing assumptions explicit and binding, and (b) a *supply-chain CI
gate* that converts today's good-by-default hygiene into an enforced property of the release.

The acute risk this change removes is **a deployer over-trusting a boundary the code never
enforces** (`04-infosec-codebase.md` §10 P0; `council/C-security.md` §4). Three places in the
code and its docs *imply* a stronger per-wallet / per-schema / server-identity boundary than
exists:

1. **The chunk pool is global and content-addressed**, and the interface doc advertises
   "deduplicating … across wallets" (`src/interfaces/checkpoint-store.ts`, the
   `CheckpointStore` doc block) and GC that reclaims a chunk only when "no manifest anywhere in
   the store references it" — language a reasonable reader takes to mean wallets are isolatable
   tenants. They are not: chunk *existence* (via `save` timing: a first-time 4 MiB `bytea` write
   vs. an `ON CONFLICT (hash) DO UPDATE` metadata no-op, `src/postgres/checkpoint-store.ts:156-162`)
   and GC behavior (via `prune`'s cross-wallet-dependent `reclaimedBytes`,
   `src/postgres/checkpoint-store.ts:397-411`) are observable across wallets. This is the textbook
   Harnik–Pinkas–Shulman-Peleg cross-user deduplication side channel.
2. **`schema` is namespacing, not a security boundary** (`04-infosec-codebase.md` §8, F5): all
   queries run under one DB role that owns every schema; nothing in the library stops a caller
   pointing an adapter at any schema.
3. **No at-rest encryption exists anywhere in the library**: the envelope path bakes plaintext
   `JSON.stringify` into `encode()` (`src/interfaces/wallet-state-envelope.ts:142`) → stored as
   plaintext `bytea` chunks. For a Midnight shielded wallet these bytes contain spending-key /
   coin-secret material (`04-infosec-codebase.md` §7, F2; CWE-312).

On the infrastructure side, TLS ships as `Require` + self-signed (encryption without
server-identity validation), which is a defensible localhost default but a real MITM /
credential-theft gap the moment node and DB are not co-located (`05-infosec-infra.md` §4). And
there is **no supply-chain gate** — no `npm audit`/`npm ci` policy, no `ignore-scripts`, no
secret-scan, no container CVE scan — so today's verified-good state (307/307 registry+integrity,
zero install scripts, fully pinned flake) is unenforced (`05-infosec-infra.md` §2.4, §8 F2). A
Preview testnet wallet secret is committed to git (`05-infosec-infra.md` §5.1, F6): valueless
today, but a precedent problem in a repo others fork, and the tracked path invites a future funded
seed to slip in on a routine-looking diff.

## What changes (the 1.0.0 gate items addressed)

- **G15 — `SECURITY.md` / threat-model doc.** Ship a threat-model/security document (linked from
  the root `README.md`) that states, as binding preconditions: the single-trusted-writer model
  (T-A1) and trusted-Postgres/operator model (T-A2); that `schema` is namespacing, **NOT** a
  security or tenant boundary (T-A3 / F5); that the chunk pool is one global trust domain whose
  chunk existence and GC behavior are **observable across wallets** (the dedup side channel), so
  placing mutually-distrusting principals on one store is an **unsupported** deployment; and that
  UmbraDB provides **NO at-rest encryption** — deployers of secret-bearing payloads MUST provide
  disk/backup encryption or persist ciphertext (a binding precondition, not a footnote).
- **G16 — Rewrite the CheckpointStore cross-wallet dedup interface docs.** Rewrite the "single
  GLOBAL pool … across wallets" and "no manifest anywhere" language in
  `src/interfaces/checkpoint-store.ts` (the `CheckpointStore` doc block, the `PruneResult`
  `reclaimedChunks` doc, and `prune`'s method doc) so the advertised cross-wallet dedup carries
  the side-channel caveat and the single-trust-domain requirement explicitly.
- **G17 — Surface the TLS caveat + de-stub VerifyFull.** Surface the `Require`/self-signed caveat
  (encryption only, **no** server-identity validation; use VerifyFull for anything non-localhost)
  in a `nix/midnight-env` README at the point of use, alongside `enable-db-sync-tls.sh`/
  `start-stack.sh`; and replace the current `--ca` *stub* (the trailing echo in
  `enable-db-sync-tls.sh`) with a real one-flag VerifyFull/`--ca` flow (local CA → server cert with
  SAN = the dialed host → node `--ssl_root_cert`). **KEEP the localhost `Require` default** — no
  default change.
- **G18 — Supply-chain CI gate.** Land a blocking supply-chain gate: `npm ci`; blocking
  `npm audit --audit-level=high --omit=dev`; a repo-root `.npmrc` with `ignore-scripts=true` (with
  any needed build/typecheck run as an explicit CI step, since the `.npmrc` also suppresses this
  package's own lifecycle hooks); **full git-history** `gitleaks` secret scanning (with the Preview
  wallet artifact allowlisted at both its historical committed path and its `.example` template,
  since the remediation performs no history rewrite); a scheduled `trivy`
  scan of **both** pinned Docker digests
  (`indexer-standalone:4.3.3@sha256:03afd0…1cc4b`, `proof-server:8.1.0@sha256:801bbc…4d531`,
  asserted equal to the `flake.nix` pins); and a `flake.lock` change-control check (any `flake.lock`
  change on a PR fails unless the PR carries a `flake-lock-update` label — a plain `git diff` against
  the base, no Nix toolchain).
- **G19 — Replace the committed Preview wallet secret.** Replace the tracked live secret
  (`nix/midnight-env/test-wallets/preview-test-wallet.json`, `seedHex` + `nightSecretKeyHex`) with a
  `*.example.json` template (same field shape: `network`, `seedHex`, `nightSecretKeyHex`, `address`)
  + a `generate-test-wallet.sh` generator (+ faucet-refund note; fails with a named-tool message when
  the Midnight wallet SDK tooling needed to derive `nightSecretKeyHex`/`address` is unavailable), and
  add gitleaks allowlist entries (the historical path + the `.example`) so no *other* secret can be
  committed. **No git-history rewrite** — the committed key is verified valueless Preview testnet
  material; the full-history gitleaks gate (with the historical path allowlisted) is the go-forward
  guard.

## Non-goals (explicitly out of scope — per the council rulings)

- **Keyed / per-wallet / per-namespace chunk addressing (the dedup-oracle *code* fix).** The
  council ruling is decisive: the dedup-oracle obligation for 1.0.0 is **documentation** (the
  threat-model doc G15 + the interface-doc rewrite G16), **not** a code change. HMAC/`walletId`-
  salted chunk keying is a **P1 fast-follow, targeted at 1.1**, co-designed with the encryption
  seam (`council/C-security.md` §3, §5). This change adds no chunk-keying code and no
  `CheckpointStore` API change.
- **The `EnvelopeCipher` / at-rest encryption *seam* (the plaintext-key *code* fix).** Also a
  documentation obligation for 1.0.0 (the binding "no at-rest encryption" precondition in G15);
  the injectable cipher hook in `encode()`/`decode()` is a **P1 fast-follow**
  (`council/C-security.md` §2, §5).
- **`save()` idempotency (`idempotency_key` + UNIQUE).** P1 "with Sprint 9's retry wrapper," a
  benign identical-content duplicate under load-latest-complete semantics — **not** in this
  change and not a 1.0.0 blocker (`ROADMAP` §Deferred; council override on `save()` idempotency).
- **Importing a consumer/indexer app for differential testing.** Explicitly forbidden — it would
  gate the release on a foreign repo and breach UmbraDB's indexer-agnostic boundary
  (`ROADMAP` G11). Nothing in this change imports a consumer app.
- **Two-role least-privilege Postgres topology; `restore-state.sh` integrity verification;
  container-bind/network hardening; `~/.midnight-pg-password` perms.** Documented-limitation /
  P1-P2 hardening in the infra report — **out of this change's gate scope** (this change is
  G15–G19 only). They belong to the reliability/ops track, not the InfoSec sign-off tag gate
  (`council/C-security.md` §4 "explicitly NOT required for the tag").
- **All three unmerged tracks** (full-chain archival storage, verifiable-snapshot, torrent
  bootstrap) stay OUT of 1.0.0 (`ROADMAP` §Deferred).
- **The application-code input-hardening items F3/F4** (`walletId`/`networkId` validation; JSON
  depth bound) are 1.0.0 sign-off code fixes but are **owned by the reliability/contract-integrity
  change (G8)**, not this InfoSec-docs+CI change — cross-referenced here for completeness, not
  duplicated as requirements.

## Impact

- **New files:** `SECURITY.md` (root, linked from `README.md`); `.npmrc` (`ignore-scripts=true`);
  `.gitleaks.toml` (allowlist path-scoped to the historical Preview wallet path + the `.example`
  template); a supply-chain CI workflow
  (`.github/workflows/supply-chain.yml`) with the `npm audit`, gitleaks, Trivy, and flake-lock-freeze
  jobs; `nix/midnight-env/README.md` (the TLS caveat surfaced at point of use);
  `nix/midnight-env/test-wallets/preview-test-wallet.example.json` +
  `nix/midnight-env/test-wallets/generate-test-wallet.sh`.
- **Modified:** `src/interfaces/checkpoint-store.ts` (dedup/PruneResult/`prune` doc rewrite, G16 —
  **doc comments only, no signature or behavior change**);
  `nix/midnight-env/scripts/enable-db-sync-tls.sh` (real `--ca`/VerifyFull flow replacing the
  trailing stub, G17); `nix/midnight-env/test-wallets/README.md` (generator/`.example` instructions,
  strengthened warning); root `README.md` (link to `SECURITY.md`); `.gitignore` (ignore the
  generated live `preview-test-wallet.json`).
- **Deleted from the tree (not from history):** `nix/midnight-env/test-wallets/preview-test-wallet.json`
  (the tracked live secret) — untracked, replaced by the `.example` + generator. **No `git filter-repo`
  / history rewrite** (`council/C-security.md` §5; `05-infosec-infra.md` §5.1).
- **Risk:** the lowest-code-risk change in the 1.0.0 program. G15/G16/G19-docs are documentation;
  G18 is CI/config; the only executable behavior changes are the CI gate itself and the
  `enable-db-sync-tls.sh` `--ca` flow (G17), neither of which touches `src/` runtime code. No `src/`
  runtime behavior changes; no new runtime dependency. The one real ongoing risk is a **false sense
  of the gate's reach**: the CI gate enforces hygiene and secret-scanning, not the in-model design
  decisions (dedup pool, plaintext-at-rest) that remain deliberate documented preconditions — this
  is called out in `SECURITY.md` itself, not left implicit.
- **Delivery:** matches the program's cadence — this proposal/design/tasks/spec drafted and
  reviewed first (multi-agent research + council adjudication, already done), then implemented
  against it with the two-auditor per-task review cadence (`tasks.md`).
