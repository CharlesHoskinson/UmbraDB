# Midnight infra verification checklist

The canonical "things to do on Midnight" (scraped from docs.midnight.network getting-started +
guides) mapped to our infra, with live status. This is the TODO for confirming the whole stack.
Updated 2026-07-21.

Legend: ✅ done/verified · 🔄 in progress · ⬜ not started

## A. Toolchain & binaries (all self-serve from public source)

- ✅ Rust 1.95, Node 24.18, Docker rootless, protoc/psql/clang
- ✅ **midnight-node 2.1.0** — built from source (1.6G binary); ships `res/preprod` chain-spec
- ✅ **indexer-standalone** — built from source with `--features standalone` (120M)
- ✅ **proof-server 8.1.0** — built from source (25M); on first run fetches+verifies ZK proving
  keys from `https://srs.midnight.network/` (one-time warm-up), then serves on `:6300`.
  Correct invocation: `midnight-proof-server -p 6300 --num-workers 2` (NO `--network` flag in 8.1.0)
- ✅ **Compact compiler** — CLI `compact` 0.5.1 (`~/.local/bin`) + backend `compactc` 0.31.1
  (via `compact update`)
- ✅ **Wallet SDK** — installed from public npm (ledger-v8 8.1.0, zkir-v2 2.1.0)

## B. Preprod connectivity (public endpoints, verified live)

- ✅ Node RPC `https://rpc.preprod.midnight.network/` — `system_chain` → "Midnight Preprod"
- ✅ Indexer `https://indexer.preprod.midnight.network/api/v4/graphql` (+ WS for sync)
- ✅ **Faucet: 1000 tNIGHT received & confirmed on-chain** — tx
  `00ea17cf…a20bea`, `transactionResult.status = SUCCESS`, output to our address for
  `1000000000` of token `0x00…00` (native tNIGHT, 6 decimals = 1000). Verified via indexer query.

## C. Our wallet

- Unshielded preprod address: `mn_addr_preprod14plwqf5qymh879pskxyharf86plfj288ccvklaa74nqsha5f2p3szaxvvc`
- Seed: `~/.midnight-preprod-wallet.seed` (600). Birthday reference block: 1,763,259.

## D. Operations to verify (the requested end-to-end)

Strategy: run these against **public preprod** (live node + indexer) with our **local
proof-server**. Our own node build is verified to *run* separately (E). Wallet syncs via the
public indexer WS with the birthday hack (fast).

- ⬜ **Wallet sync** — drive the wallet SDK to sync our address against public preprod; confirm it
  observes the 1000 tNIGHT UTXO. (Needs the wallet SDK runnable — build packages or use testkit.)
- ⬜ **Generate tDUST** — delegate tNIGHT → DUST (fee token). Guide:
  `/guides/generating-dust-programmatically`. Confirm via `dustGenerationStatus` /
  `dustGenerations` indexer queries.
- ⬜ **Spend on preprod** — build+prove+submit a transfer tx (proof-server generates the ZK proof);
  confirm inclusion + status SUCCESS via indexer.
- ⬜ **Deploy a smart contract** — `compact compile` a contract (bboard tutorial), deploy via
  midnight-js against preprod; confirm the contract action indexes. Guide: `/guides/deploy-mn-app`,
  `/tutorials/bboard`.
- ⬜ **Run test suites** — wallet SDK vitest (`yarn verify:test`), indexer tests, node e2e where
  applicable.

## E. Our from-source node (prove the build works as a real node)

- ⬜ Start `midnight-node` with `res/preprod/chain-spec-raw.json`, confirm it dials the preprod
  bootnodes (`bootnode-1/2.preprod.midnight.network`), gets peers, and begins importing blocks.
  (Full sync takes hours — proving it peers + imports is the "node works" bar; we don't need full
  sync for the ops in D, which use the public node.)
