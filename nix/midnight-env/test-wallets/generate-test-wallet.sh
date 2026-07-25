#!/usr/bin/env bash
#
# generate-test-wallet.sh -- create a FRESH, untracked Preview testnet wallet locally.
#
# WHY: no wallet key with any value is ever committed to this repo (see ../../../SECURITY.md and
# ./README.md). Instead of committing a shared secret, each machine generates its own throwaway
# Preview wallet with this script and funds it once from the faucet. The generated file
# (preview-test-wallet.json) is git-ignored, must never be committed, and is written mode 0600.
#
# WHAT IT WRITES: nix/midnight-env/test-wallets/preview-test-wallet.json, matching the field shape of
# preview-test-wallet.example.json -- the keys `network`, `seedHex`, `nightSecretKeyHex`, `address`,
# with a freshly generated `seedHex`.
#
# DERIVATION TOOLING (named) -- the REAL Midnight wallet SDK, resolved exactly the way this repo's
# live-fixtures loader resolves it (test/integration/live-fixtures/midnight-wallet-sdk-loader.ts):
#   * @midnightntwrk/wallet-sdk-hd                -- HD key derivation -> nightSecretKeyHex
#   * @midnightntwrk/wallet-sdk-unshielded-wallet -- keystore + PublicKey.address -> address
#   * @midnightntwrk/wallet-sdk-abstractions      -- the NetworkId enum (already a dev dependency)
# The first two are heavier and are deliberately NOT UmbraDB devDependencies (see the loader's
# rationale), so this script resolves them from a BUILT sibling `midnight-wallet` checkout
# ($MIDNIGHT_WALLET_REPO, default ~/repos/midnight-wallet) and falls back to normal package-name
# resolution if they happen to be installed here. If the derivation tooling is NOT resolvable, this
# script FAILS with an actionable, named-tool message rather than emit a malformed wallet file.
#
# AFTER GENERATING: fund the wallet's address at https://faucet.preview.midnight.network/
# (Preview tDUST has NO monetary value). On a fresh machine, re-generate + re-fund -- never commit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$SCRIPT_DIR/preview-test-wallet.json"

command -v node >/dev/null 2>&1 || {
  echo "ERROR: node is required to generate a wallet (it is on PATH in the nix dev shell)." >&2
  exit 1
}

# Fresh 32-byte seed -> 64 lowercase hex chars. Never reuse a seed; never commit the output file.
SEED_HEX="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"

# Derive nightSecretKeyHex + address from the fresh seed using the REAL SDK, via the same API the
# repo's live integration path proves:
#   * key:     midnight-wallet-sdk-loader.ts `deriveUnshieldedSeed`
#              (HDWallet.fromSeed -> selectAccount(0) -> selectRole(Roles.NightExternal) -> deriveKeyAt(0))
#   * address: preprod-db-sync.integration.test.ts
#              (createKeystore(unshieldedSeed, networkId) -> PublicKey.fromKeyStore(keystore).address)
# On missing tooling: named-tool failure, NO file written. On success: writes the four-key file 0600.
node - "$SEED_HEX" "$OUT" <<'NODE'
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const [seedHex, out] = [process.argv[2], process.argv[3]];

// Resolve a package the way test/integration/live-fixtures/midnight-wallet-sdk-loader.ts does:
// prefer a BUILT sibling `midnight-wallet` checkout's dist, else normal package-name resolution.
const repoRoot =
  process.env.MIDNIGHT_WALLET_REPO || path.join(process.env.HOME || "", "repos", "midnight-wallet");

async function loadPkg(distDir, pkgName) {
  const distFile = path.join(repoRoot, "packages", distDir, "dist", "index.js");
  if (fs.existsSync(distFile)) return import(pathToFileURL(distFile).href);
  return import(pkgName); // resolvable only if the package is installed in this tree
}

function namedToolFailure(missing) {
  console.error(
    "ERROR: cannot derive nightSecretKeyHex/address from the seed.\n" +
    "  The real Midnight wallet SDK derivation tooling is not resolvable in this tree:\n" +
    "    " + missing + "\n" +
    "  This repo deliberately does NOT carry these as devDependencies (see\n" +
    "  test/integration/live-fixtures/midnight-wallet-sdk-loader.ts). Resolve them one of two ways:\n" +
    "    * point MIDNIGHT_WALLET_REPO at a BUILT 'midnight-wallet' checkout (default\n" +
    "      ~/repos/midnight-wallet), with packages/hd/dist and packages/unshielded-wallet/dist present; OR\n" +
    "    * install them here (npm i -D @midnightntwrk/wallet-sdk-hd @midnightntwrk/wallet-sdk-unshielded-wallet).\n" +
    "  A fresh seed was generated in memory but intentionally NOT written -- refusing to emit a\n" +
    "  malformed wallet file. No file was created or modified."
  );
  process.exit(2);
}

(async () => {
  let hd, unshielded, abstractions;
  try {
    hd = await loadPkg("hd", "@midnightntwrk/wallet-sdk-hd");
  } catch (_e) {
    namedToolFailure("@midnightntwrk/wallet-sdk-hd (HD key derivation)");
  }
  try {
    unshielded = await loadPkg("unshielded-wallet", "@midnightntwrk/wallet-sdk-unshielded-wallet");
  } catch (_e) {
    namedToolFailure("@midnightntwrk/wallet-sdk-unshielded-wallet (keystore + address derivation)");
  }
  try {
    abstractions = await loadPkg("abstractions", "@midnightntwrk/wallet-sdk-abstractions");
  } catch (_e) {
    namedToolFailure("@midnightntwrk/wallet-sdk-abstractions (NetworkId enum)");
  }

  const HDWallet = hd.HDWallet || (hd.default && hd.default.HDWallet);
  const Roles = hd.Roles || (hd.default && hd.default.Roles);
  if (!HDWallet || !Roles) {
    namedToolFailure("@midnightntwrk/wallet-sdk-hd (no HDWallet/Roles export)");
  }

  // Preview NetworkId ('preview'); mirrors preprod-fixtures.ts `buildUnshieldedConfig` (which uses
  // `NetworkId.NetworkId.PreProd`). Fall back to the literal enum value if the shape differs.
  const NetworkIdNs = abstractions.NetworkId || (abstractions.default && abstractions.default.NetworkId);
  const networkId =
    (NetworkIdNs && NetworkIdNs.NetworkId && NetworkIdNs.NetworkId.Preview) || "preview";

  // (1) HD key derivation -- byte-for-byte the loader's deriveUnshieldedSeed.
  const seedBuffer = Buffer.from(seedHex, "hex");
  const seedResult = HDWallet.fromSeed(seedBuffer);
  if (seedResult.type !== "seedOk") {
    console.error("ERROR: HDWallet.fromSeed failed: " + JSON.stringify(seedResult) + ". Not writing a file.");
    process.exit(3);
  }
  const hdWallet = seedResult.hdWallet;
  const derivation = hdWallet.selectAccount(0).selectRole(Roles.NightExternal).deriveKeyAt(0);
  if (derivation.type === "keyOutOfBounds") {
    console.error("ERROR: HD key derivation out of bounds. Not writing a file.");
    process.exit(3);
  }
  const unshieldedSeed = Buffer.from(derivation.key);
  const nightSecretKeyHex = unshieldedSeed.toString("hex");
  hdWallet.clear();

  // (2) Address -- the proven wiring (preprod-db-sync.integration.test.ts):
  //     createKeystore(unshieldedSeed, networkId) -> PublicKey.fromKeyStore(keystore).address.
  const createKeystore =
    unshielded.createKeystore || (unshielded.default && unshielded.default.createKeystore);
  const PublicKey = unshielded.PublicKey || (unshielded.default && unshielded.default.PublicKey);
  if (typeof createKeystore !== "function" || !PublicKey || typeof PublicKey.fromKeyStore !== "function") {
    namedToolFailure(
      "@midnightntwrk/wallet-sdk-unshielded-wallet (no createKeystore/PublicKey.fromKeyStore export)"
    );
  }
  const keystore = createKeystore(unshieldedSeed, networkId);
  const publicKey = PublicKey.fromKeyStore(keystore);
  const address = publicKey.address;
  if (typeof address !== "string" || address.length === 0) {
    console.error("ERROR: address derivation did not yield a non-empty string. Not writing a file.");
    process.exit(3);
  }

  const wallet = { network: "preview", seedHex, nightSecretKeyHex, address };
  const data = JSON.stringify(wallet, null, 2) + "\n";
  // 0600 at create (mode option) AND an explicit chmod to defeat a permissive umask, honoring the
  // SECURITY.md commit policy ("secret-bearing files are created with chmod 600").
  fs.writeFileSync(out, data, { mode: 0o600 });
  fs.chmodSync(out, 0o600);
  console.log("Wrote " + out + " (mode 0600) with a fresh seed.");
  console.log("Now fund the address at https://faucet.preview.midnight.network/ (Preview tDUST, no value).");
})();
NODE
