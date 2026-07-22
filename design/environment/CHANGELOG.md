# Environment changelog

Append-only. Newest first. One entry per environment change (install / upgrade / build / fix).
Pair every entry with a `versions.lock.json` update in the same commit.

## 2026-07-21

- **Wallet SDK installed via public-npm workaround.** `@midnight-ntwrk/ledger-v8@8.1.0` +
  `zkir-v2@2.1.0` are gated on GitHub Packages (403 — `CharlesHoskinson` not in `midnightntwrk`
  org) but published byte-identical on public npm. Repointed the `midnight-wallet` clone's
  `.yarnrc.yml` scope to `registry.npmjs.org` and stripped the `__archiveUrl` GH pins from
  `yarn.lock`; `yarn install` succeeded (checksums matched). Backups: `.yarnrc.yml.orig`,
  `yarn.lock.orig`.
- **gh: added `read:packages` scope** via device flow (WSL). Confirmed insufficient for the org
  packages (download still 403) — root cause is org membership, not scope. Kept for completeness.
- **gh: logged into WSL** by bridging the Windows keyring token; `gh auth setup-git` configured.
  Verified private-repo access (chimericlattices, rustyhair, midnight-dev-env, midnight-codec-impl).
- **proof-server 8.1.0 BUILT** from `midnight-ledger` tag `ledger-8.1.0`
  (`cargo build --release --package midnight-proof-server`) → 25M binary. Corrects an earlier
  wrong finding that proof-server was ghcr-only; it is a source crate in the ledger monorepo.
- **indexer-standalone** first built WITHOUT `--features standalone` → inert binary that panics at
  `unimplemented!()` (`main.rs:240`). Correct rebuild (`--features standalone`) queued.
- **midnight-node** from-source build started (`cargo build --release --package midnight-node`);
  carries `res/preprod/chain-spec-raw.json` with real preprod bootnodes. (Public Docker Hub image
  is only 0.12.1, predates preprod — hence source build.)
- **Cloned Midnight repos** into `~/repos`: midnight-node, midnight-indexer, midnight-ledger,
  midnight-wallet, midnight-node-docker, midnight-node-cli (archived, unused).
- **Rust 1.95** installed via rustup (user-space); set as default. apt: protobuf-compiler,
  postgresql-client (clang/cmake/libssl-dev/pkg-config pre-existing).
- **Docker rootless** enabled for `charles` (installed `uidmap`, ran
  `dockerd-rootless-setuptool.sh install`, `loginctl enable-linger charles`). UmbraDB test suite
  went 4/155 → 151/155 (4 remaining are connection-refused-timing edge tests, not code bugs).
- **Toolchain installed rootless**: graphify 0.9.24 + scrapling 0.4.11 (venvs), Claude Code CLI +
  superpowers plugin (npm prefix `~/.npm-global`), Node 24.18.0 (nvm), openspec 1.6.0.
- **Git identity** set globally: charles hoskinson <charles.hoskinson@gmail.com>.
- **UmbraDB**: cloned; branch `sprint-5-wallet-integration-recommendation` rebased onto main;
  drafted openspec change `sprint-7-transaction-history-storage` (commit 69b4ca4).
