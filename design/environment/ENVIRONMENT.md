# UmbraDB dev environment — master runbook

Authoritative, rebuildable record of the WSL environment used to build the Midnight stack from
source and connect UmbraDB's Sprint 7 work to the public **preprod** network. If the box is lost,
this file + `versions.lock.json` + `CHANGELOG.md` are enough to rebuild and to debug drift.

**Format (decided 2026-07-21):**
- `ENVIRONMENT.md` (this file) — human runbook: host, tooling, repos, build steps, credentials.
- `versions.lock.json` — machine-readable pinned manifest (exact versions + git SHAs). Diff this
  to detect drift; it is the source of truth for "what exact version was it."
- `CHANGELOG.md` — append-only, dated log of every environment change (install/upgrade/fix), so a
  future debugging session can answer "what changed and when."
- Detailed per-component build notes live in `../sprint-7-preprod-toolchain-inventory.md`.

Update rule: whenever a tool/repo version changes or something is built/installed, update
`versions.lock.json` **and** append a dated `CHANGELOG.md` entry in the same commit.

## Host

| | |
|---|---|
| Windows | 11 Home 26200 |
| WSL | WSL2, distro `Ubuntu-26.04` (resolute), kernel `6.18.33.1-microsoft-standard-WSL2` |
| Linux user | `charles` (uid 1000); sudo password = `charles` |
| Repo root | `/home/charles/repos/` (Linux-native, NOT `/mnt/c` — build perf + inode semantics) |
| Resources | 20 CPU / 62 GB RAM / ~490 GB free on `/` |
| GPU | RTX 5090 (host driver, not used by this stack) |

## Shell / PATH persistence

`~/.profile` (login shells) exports, in order: `~/.cargo/bin`, `~/.venvs/graphify/bin`,
`~/.venvs/scrapling/bin`, `~/.npm-global/bin`, plus nvm and `DOCKER_HOST`. `~/.bashrc`'s
interactive-only guard means PATH edits must go in `~/.profile`, not `~/.bashrc`.
Known nuisance: a stray Windows `/mnt/c/Users/charl/.npmrc` (`prefix=/root/.local`) makes `npm`
warn "config prefix cannot be changed from project config" when CWD is under `/mnt/c`; harmless,
avoided by working from `~/repos`.

## Tooling (all rootless / user-space)

| Tool | Version | Install | Notes |
|---|---|---|---|
| rustup + Rust | 1.95.0 | `rustup default 1.95` | node/indexer pin via `rust-toolchain.toml`; ledger edition-2024 |
| rust targets | wasm32v1-none, aarch64-unknown-linux-gnu | auto | |
| Node.js | 24.18.0 | nvm (`nvm install 24`) | wallet needs ≥24 (`lts/krypton`) |
| yarn (project) | 4.17.1 | corepack (via `.yarnrc.yml` `yarnPath`) | global `yarn` is legacy 1.22.22 — ignore it; in-repo is 4.17.1 |
| Docker | 29.6.2, **rootless** | `dockerd-rootless-setuptool.sh install` | daemon runs as `charles`; `DOCKER_HOST=unix:///run/user/1000/docker.sock`; needs `uidmap`; linger enabled |
| protobuf-compiler | 3.21.12 | apt | node build |
| postgresql-client | 18.4 | apt | `psql` |
| clang / libssl-dev / pkg-config / cmake | 21.1.8 / 3.5.x / 2.5.1 / — | apt | native crate builds |
| graphify | 0.9.24 | `~/.venvs/graphify` (git install) | UmbraDB graph tooling |
| scrapling | 0.4.11 (`[all]`) | `~/.venvs/scrapling` | static fetchers only; browser fetchers need `scrapling install` (apt sys-deps) |
| openspec | 1.6.0 | npm global | spec validation |
| gh | 2.96.0 | apt | logged in WSL as CharlesHoskinson; scopes `gist,read:org,read:packages,repo,workflow` |

## Midnight repos (cloned under ~/repos)

| Repo | Pinned at | Role |
|---|---|---|
| midnight-node | see `versions.lock.json` (HEAD, `node-1.0.0-rc.2-226-g…`) | node built from source; ships `res/preprod/` chain-spec |
| midnight-indexer | HEAD (`v4.3.3-56-g…`) | GraphQL WS the wallet syncs against; build `indexer-standalone` **with `--features standalone`** |
| midnight-ledger | tag `ledger-8.1.0` (detached) | contains `midnight-proof-server` crate (== proof-server 8.1.0) |
| midnight-wallet | HEAD | Yarn Berry SDK monorepo; UmbraDB integrates its `TransactionHistoryStorage` |
| midnight-node-docker | HEAD | compose wrapper (qanet/testnet-02 presets only; no preprod preset) |

## Build / run (from source — all public, no ghcr auth)

```bash
# proof-server 8.1.0  (BUILT ✅)
cd ~/repos/midnight-ledger && git checkout ledger-8.1.0
cargo build --release --package midnight-proof-server
# run: ./target/release/midnight-proof-server   (port 6300; no --network flag in 8.1.0)

# indexer-standalone  (MUST use the feature flag)
cd ~/repos/midnight-indexer
cargo build --release -p indexer-standalone --features standalone

# midnight-node  (preprod chain-spec baked in at res/preprod/chain-spec-raw.json)
cd ~/repos/midnight-node
cargo build --release --package midnight-node
```

## Wallet SDK install (public-npm workaround — IMPORTANT)

The wallet's `@midnight-ntwrk` deps (`ledger-v8@8.1.0`, `zkir-v2@2.1.0`) are pinned in
`.yarnrc.yml` to GitHub Packages (`npm.pkg.github.com`), which 403s because the `CharlesHoskinson`
account is **not a member of the `midnightntwrk` org**. Both packages are **also published on
public npm** (`registry.npmjs.org`), byte-identical (yarn checksums matched). Local workaround
applied to the `midnight-wallet` clone (backups: `.yarnrc.yml.orig`, `yarn.lock.orig`):
1. `.yarnrc.yml`: repoint scope `midnight-ntwrk` → `https://registry.npmjs.org`, drop `npmAlwaysAuth`.
2. `yarn.lock`: strip the two `::__archiveUrl=…npm.pkg.github.com…` suffixes from the `ledger-v8`
   and `zkir-v2` resolutions.
3. `yarn install` → both WASM packages fetched from public npm (ledger-v8 11M, zkir-v2 2.1M).

To restore upstream behavior (if org access is later granted): `cp .yarnrc.yml.orig .yarnrc.yml &&
cp yarn.lock.orig yarn.lock` and provide a `read:packages` token from an org member.

## Credentials

| Need | For | Status |
|---|---|---|
| gh token (`repo`) | private repos | ✅ have (CharlesHoskinson) |
| gh token (`read:packages`) | wallet SDK via GH Packages | granted, but **insufficient** — account not in `midnightntwrk` org (403 on download). Bypassed via public npm above. |
| AWS | preprod *genesis rebuild* | not needed — preprod chain-spec ships in node source |
| ghcr.io pull | pinned node/indexer/proof-server images | not needed — all built from public source |
