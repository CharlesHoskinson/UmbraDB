# UmbraDB software supply-chain directory

This directory is UmbraDB's **software supply-chain inventory**: a security-and-updates-focused
record of *every* third-party component the project depends on, plus an assessment of where
UmbraDB stands against the [SLSA](https://slsa.dev) supply-chain integrity framework.

UmbraDB itself is licensed **Apache-2.0** (`LICENSE`, `NOTICE`; Copyright 2026 Charles Hoskinson).

## Why this exists

UmbraDB is the Postgres persistence layer for a Midnight/Cardano dependency chain. Its trust
surface is not just its own two runtime npm packages — it is the full transitive npm graph used
to build and test it, the pinned Cardano/Midnight release binaries and Docker images the dev
environment runs, and the Lean/mathlib toolchain that checks the formal proofs. This directory
makes that surface explicit so it can be watched, audited, and updated deliberately.

## How the inventory is organized

- **[`inventory.md`](inventory.md)** — the SBOM-style inventory. One table per ecosystem
  (npm-runtime, npm-dev, nix-packages, pinned-binaries, docker-images, lean/mathlib, host-tools),
  with **Component · Version/Pin · Source · Hash/Digest · License · Purpose · Update-watch**.
  Every row records *how* it is pinned — semver range vs exact git rev vs sha256 vs image digest —
  because **pinning quality is the security signal**: an exact rev/sha256/digest is
  tamper-evident, a floating range or ref is not.
- **[`slsa.md`](slsa.md)** — the SLSA examination: the Build-track levels, UmbraDB's current
  posture per track, an estimate of the current SLSA Build level and a realistic target, and the
  concrete gaps mapped to the roadmap items that close them.

Every entry is grounded in a real manifest in this repo. The authoritative sources are:

| Ecosystem | Manifest(s) |
|---|---|
| npm runtime + dev | `package.json`, `package-lock.json` (lockfileVersion 3) |
| Nix dev environment | `nix/midnight-env/flake.nix`, `nix/midnight-env/flake.lock` |
| Lean proofs | `Formal/Lean/lean-toolchain`, `Formal/Lean/lake-manifest.json` |
| CI trust gate | `.github/workflows/conformance.yml` (and the planned `supply-chain.yml`, G18) |

## Update process — how and when to bump each ecosystem

The governing rule differs by ecosystem, because the *security value* of each pin differs.

- **npm runtime deps (`postgres`, `zod`)** — carry caret ranges in `package.json`, but the
  **resolved version + integrity hash in `package-lock.json` is the real pin**. Bump by editing
  the range (or `npm update` within range) and committing the regenerated lockfile. Runtime scope
  is deliberately tiny (2 packages, both zero-dependency) so `npm audit --omit=dev` stays quiet and
  fast. Watch: GitHub advisories / `npm audit` for `postgres` and `zod`.
- **npm dev deps + transitive graph (307 packages total)** — `npm ci` reinstalls the exact locked
  tree; never `npm install` in CI. Bump dev tooling (vitest, tsx, typedoc, typescript,
  Testcontainers, `@types/node`, effect, fast-check, the wallet-sdk canary) deliberately, run the
  conformance suite, and commit the new lockfile. A non-blocking full `npm audit` gives dev-graph
  visibility without gating merges on the large dev tree.
- **Nix pins (`flake.lock`)** — updated **deliberately, never via a blind `nix flake update`**.
  This is a stated design rule (`nix/midnight-env/flake.nix` header comment): the Midnight/Cardano
  component commits and the release-binary sha256s are the exact revisions the environment was
  built and verified against, so a re-lock that silently rolls them forward would break
  reproducibility. Bumping a pin means editing the rev/sha256/digest, re-verifying the stack, and
  committing — reviewed as its own change (see the G18 flake-lock change-control gate below).
- **Pinned release binaries (cardano-node, cardano-db-sync, midnight-node)** — bump the version +
  `fetchurl` URL + `sha256` in `flake.nix` together; a mismatched sha256 hard-fails the build.
  Watch upstream releases: IntersectMBO/cardano-node, IntersectMBO/cardano-db-sync,
  midnightntwrk/midnight-node.
- **Docker images (indexer-standalone, proof-server)** — pinned by `@sha256:` digest. Digest
  pinning gives immutability, **not** freedom from CVEs, so the images are watched by a scheduled
  Trivy scan (G18) rather than by version bumps alone. Bump = replace the digest, re-verify.
- **Lean toolchain + mathlib (`lean-toolchain`, `lake-manifest.json`)** — bump the Lean version
  and re-run `lake update` to a mathlib tag matching that toolchain; the transitive Lake deps
  (batteries, aesop, Qq, …) move with mathlib and are recorded as exact git revs in the manifest.
  Driven by proof needs, not a security cadence, but every rev is exact and reviewable.

## Security process — the CI gates

Today the one merge gate is **`.github/workflows/conformance.yml`**: it already installs with
`npm ci` (enforcing the lockfile + integrity hashes) and pins every GitHub Action by commit SHA,
but it runs *tests only*. The planned **G18 supply-chain gate** (`.github/workflows/supply-chain.yml`,
specified in `openspec/changes/v1.0.0-infosec-signoff/`) adds six blocking/scheduled sub-gates:

1. **`npm ci` everywhere** (never `npm install`) — a tampered tarball fails the integrity check.
2. **Blocking `npm audit --audit-level=high --omit=dev`** on the tiny runtime scope, plus a
   non-blocking full audit for dev-graph visibility.
3. **Committed `.npmrc` with `ignore-scripts=true`**, asserted by CI — a future malicious
   transitive install script cannot execute. (This also suppresses *this* package's own lifecycle
   hooks, so any needed build/typecheck must be an explicit CI step — it already is.)
4. **`gitleaks`** full git-history secret scan, allowlisting exactly the one valueless Preview
   testnet wallet path + its `.example` template.
5. **`trivy image --severity HIGH,CRITICAL`** on **both** digest-pinned images, on a schedule, with
   the scan targets asserted equal to the `flake.nix` digests so a bump cannot silently diverge.
6. **`flake.lock` change-control** — fail any PR that changes `flake.lock` unless it carries an
   explicit `flake-lock-update` label, so an unreviewed `nix flake update` cannot land.

> Note: the G18 config files (`.npmrc`, `.gitleaks.toml`, `SECURITY.md`, `supply-chain.yml`) are
> **specified but not yet committed** on `main`. This directory documents the intended posture and
> the current state honestly; see `slsa.md` for the gap mapping.

## SLSA posture in one paragraph

SLSA v1.0 defines a **Build track** (levels L1–L3) certifying that an artifact's build is
tamper-evident via signed **provenance**. UmbraDB is not yet published as a build artifact, so its
current Build level is effectively **L0–L1**: builds are scripted (`npm`, Nix) and inputs are
strongly pinned (307/307 npm packages with integrity hashes, exact Nix revs, sha256 binaries,
digest-pinned images), which is excellent *input* hygiene but produces no signed provenance yet.
The realistic **target is SLSA Build L2**, reached the moment a release workflow publishes with
GitHub Actions OIDC + npm `--provenance` (Sigstore-signed, transparency-logged provenance tied to
the build platform), with a credible path toward L3. See **[`slsa.md`](slsa.md)** for the full
per-track assessment, level estimate, and gap-to-roadmap mapping.

## Recommended follow-up

The markdown `inventory.md` is the deliverable here. A machine-readable SBOM is a good next step:
`npm sbom --sbom-format cyclonedx` for the npm graph, and/or [`syft`](https://github.com/anchore/syft)
over the built artifact and the two Docker images, emitted as CycloneDX and attached to releases.
