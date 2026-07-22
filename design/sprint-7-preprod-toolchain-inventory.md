# Sprint 7 — Midnight preprod toolchain inventory & build checklist

Complete, ordered inventory of everything needed to build the Midnight stack **from source** and
connect UmbraDB's Sprint 7 conformance work to the public **preprod** network. Verified against
the real cloned repos on 2026-07-21. All builds are self-serve from public source **except** the
wallet SDK's own npm deps (need a GitHub Packages `read:packages` token — see §D).

Machine: WSL2 Ubuntu-26.04 (`Ubuntu-26.04`), user `charles`, 20 CPU / 62 GB / ~490 GB free.
Rootless Docker running as `charles`. All repos cloned under `~/repos/`.

## Key version decision (resolved)

The wallet SDK's own local-stack pins (`midnight-wallet/infra/compose/docker-compose-dynamic.yml`)
are the source of truth for cross-component compatibility:

| Component | Wallet SDK pin (ghcr, auth-gated) | Built-from-source equivalent (public) |
|---|---|---|
| proof-server | `proof-server:8.1.0` | `midnight-ledger` @ tag `ledger-8.1.0`, crate `midnight-proof-server` |
| indexer | `indexer-standalone:4.3.2` | `midnight-indexer` HEAD (`indexer-standalone`) — verify tag alignment |
| node | `midnight-node:1.0.0` (undeployed local net) | `midnight-node` HEAD (has `res/preprod/`) |

Note the SDK's compose pins are for its **undeployed local devnet**, not preprod. For preprod we
need a node build carrying `res/preprod/chain-spec-raw.json` (HEAD has it; the public Docker Hub
`midnightnetwork/midnight-node:latest` = 0.12.1 does **not**). proof-server 8.1.0 is version-tied
to the ledger/circuit the wallet proves against, so it is pinned exactly to `ledger-8.1.0`.

## A. System / host toolchain (shared)

| # | Item | Pin | Status | Install |
|---|---|---|---|---|
| A1 | rustup + Rust | 1.95.0 (node/indexer `rust-toolchain.toml`; ledger edition-2024 ok on 1.95) | ✅ installed (set as rustup default) | `rustup default 1.95` |
| A2 | rust targets | `wasm32v1-none`, `aarch64-unknown-linux-gnu` | ✅ | auto via `rust-toolchain.toml` |
| A3 | protobuf-compiler | 3.21.12 | ✅ | `apt install protobuf-compiler` |
| A4 | pkg-config | 2.5.1 | ✅ | `apt install pkg-config` |
| A5 | clang / libclang | 21.x | ✅ | `apt install clang` |
| A6 | libssl-dev | 3.5.x | ✅ | `apt install libssl-dev` |
| A7 | cmake, make, gcc, git | baseline | ✅ | baseline |
| A8 | postgresql-client (`psql`) | 18.x | ✅ | `apt install postgresql-client` |
| A9 | Node.js | 24 (`lts/krypton`) | ✅ v24.18.0 (nvm) | nvm |
| A10 | corepack → yarn | yarn 4.17.1 | ⬜ `corepack enable` | `corepack enable` |
| A11 | Docker (rootless) | 29.6.2 | ✅ running as `charles` | done |

## B. midnight-node (from source → preprod)

- **Build:** `cd ~/repos/midnight-node && cargo build --release --package midnight-node`
- **Preprod chain-spec:** shipped at `res/preprod/chain-spec-raw.json` with two real bootnodes
  (`bootnode-1.preprod.midnight.network`, `bootnode-2.preprod.midnight.network`).
- **Run (preprod, RPC on 9944):** `CFG_PRESET=preprod ./target/release/midnight-node \
    --chain res/preprod/chain-spec-raw.json --rpc-external --rpc-cors all` (exact flags TBD once
  built — confirm against `node/bin/entrypoint.sh` and `node/src/cli.rs`).
- **Status:** ⬜ not built.

## C. midnight-indexer (GraphQL WS the wallet syncs against)

- **Build (standalone, SQLite, no external DB) — the `--features standalone` flag is MANDATORY:**
  `cd ~/repos/midnight-indexer && cargo build --release -p indexer-standalone --features standalone`
  (per its own `justfile` line 42). Without the feature, the binary compiles the
  `#[cfg(not(feature = "standalone"))] fn main() { unimplemented!() }` and panics instantly at
  `indexer-standalone/src/main.rs:240` — a real trap I hit on the first build.
- **Cloud mode** (`--features cloud`) additionally needs a Postgres server + NATS (public images
  via its `docker-compose.yaml`) — **not** needed for the standalone path.
- **Status:** 🔄 rebuilding with the correct feature. Verify HEAD's node-version compatibility
  (`NODE_VERSIONS` lists up to `2.0.0-rc.3`) against the node build in §B.

## D. proof-server (from source — corrects earlier "ghcr-only" finding)

- **Source:** crate `midnight-proof-server` inside the `midnight-ledger` monorepo (NOT a
  standalone repo, NOT ghcr-only). Tag `ledger-8.1.0` == wallet SDK's `proof-server:8.1.0` pin.
- **Build:** `cd ~/repos/midnight-ledger && git checkout ledger-8.1.0 && \
    cargo build --release --package midnight-proof-server`
- **Run:** `./target/release/midnight-proof-server` (25M binary). NOTE: the 8.1.0 CLI has **no**
  `--network` flag (older docker images used `--network testnet`; this version dropped it). Real
  flags: `-p/--port` (default 6300, env `MIDNIGHT_PROOF_SERVER_PORT`), `--num-workers` (default 2),
  `--job-capacity`, `--job-timeout`, `--no-fetch-params`. Proving params are fetched on demand
  unless `--no-fetch-params`.
- **Status:** ✅ BUILT (`~/repos/midnight-ledger/target/release/midnight-proof-server`, 25M).

## E. midnight-wallet SDK

- **Setup:** `corepack enable` then `cd ~/repos/midnight-wallet && yarn install`
- **No native build deps** (`.yarnrc.yml` sets `enableScripts: false`; ledger/zkir arrive as
  prebuilt WASM npm packages).
- **BLOCKER (credential — the ONE remaining external blocker):** `.yarnrc.yml` routes scope
  `@midnight-ntwrk` to `https://npm.pkg.github.com` with `npmAlwaysAuth: true`.
  `@midnight-ntwrk/ledger-v8` and `@midnight-ntwrk/zkir-v2` need a GitHub Packages `read:packages`
  token. The `gh` account (CharlesHoskinson) IS now logged into WSL, but its token scopes are
  `repo, read:org, workflow, gist` — **no `read:packages`** (verified: both packages return HTTP
  403, authenticated-but-forbidden, not 401). Fix by either:
  1. `gh auth refresh -s read:packages` (device/browser flow, user-completed), then
     `echo "npmAuthToken: $(gh auth token)" >> ~/.yarnrc.yml` scoped under midnight-ntwrk; or
  2. a classic PAT with `read:packages`, exported as `YARN_NPM_AUTH_TOKEN`.
- **Status:** ⬜ blocked on `read:packages` scope. Everything else (§A–§D) is unblocked.

## Credentials summary

- **Self-serve (public):** everything in §A–§D — node, indexer, AND proof-server all build from
  public source. No ghcr auth required for the from-source path.
- **Needs a token:** §E only — GitHub Packages `read:packages` for the wallet SDK's npm install.
- **Not needed:** AWS (only for preprod *genesis rebuilds*, which we skip — preprod chain-spec is
  already baked into the node source).
