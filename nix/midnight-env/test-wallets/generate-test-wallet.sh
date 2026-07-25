#!/usr/bin/env bash
#
# generate-test-wallet.sh -- create a FRESH, untracked Preview testnet wallet locally.
#
# WHY: no wallet key with any value is ever committed to this repo (see ../../SECURITY.md and
# ./README.md). Instead of committing a shared secret, each machine generates its own throwaway
# Preview wallet with this script and funds it once from the faucet. The generated file
# (preview-test-wallet.json) is git-ignored and must never be committed.
#
# WHAT IT WRITES: nix/midnight-env/test-wallets/preview-test-wallet.json, matching the field shape of
# preview-test-wallet.example.json -- the keys `network`, `seedHex`, `nightSecretKeyHex`, `address`,
# with a freshly generated `seedHex`.
#
# DERIVATION TOOLING (named): turning a seed into `nightSecretKeyHex` and `address` requires the
# Midnight wallet SDK HD key-derivation tooling. The repo carries `@midnightntwrk/wallet-sdk-abstractions`
# as a dev dependency; the concrete seed->key derivation lives in the Midnight wallet SDK HD package
# (`@midnightntwrk/wallet-sdk-hd`). If that derivation tooling is NOT resolvable in this tree, this
# script FAILS with an actionable, named-tool message rather than emit a malformed wallet file.
#
# AFTER GENERATING: fund the wallet's address at https://faucet.preview.midnight.network/
# (Preview tDUST has NO monetary value). On a fresh machine, re-generate + re-fund -- never commit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$SCRIPT_DIR/preview-test-wallet.json"
DERIVE_PKG="@midnightntwrk/wallet-sdk-hd"   # Midnight wallet SDK HD key-derivation (the named tool)

command -v node >/dev/null 2>&1 || {
  echo "ERROR: node is required to generate a wallet (it is on PATH in the nix dev shell)." >&2
  exit 1
}

# Fresh 32-byte seed -> 64 lowercase hex chars. Never reuse a seed; never commit the output file.
SEED_HEX="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"

# Require the Midnight wallet SDK HD derivation tool. If it is not installed in this tree we CANNOT
# derive nightSecretKeyHex/address from the seed, so we fail actionably rather than write a partial
# or fabricated file (acceptance E2: named-tool failure is an accepted outcome; a malformed file is not).
if ! node -e "require.resolve('$DERIVE_PKG')" >/dev/null 2>&1; then
  cat >&2 <<EOF
ERROR: cannot derive nightSecretKeyHex/address from the seed.
  The Midnight wallet SDK HD key-derivation tool ('$DERIVE_PKG') is not resolvable in this tree.
  The repo currently carries only '@midnightntwrk/wallet-sdk-abstractions' as a dev dependency, which
  does not itself perform seed->key derivation.
  FIX: install the derivation tool (e.g. \`npm i -D $DERIVE_PKG\`) or run this generator from a
       checkout that has the Midnight wallet SDK available, then re-run this script.
  A fresh seed was generated in memory but intentionally NOT written -- refusing to emit a malformed
  wallet file. No file was created or modified.
EOF
  exit 2
fi

# The derivation tool resolved: derive the two secret-derived fields and write the four-key file.
# NOTE: the exact derivation entry point is provided by your installed @midnightntwrk/wallet-sdk-hd
# version; this guards on a seed-derivation function being present and fails cleanly (without writing
# a file) if the installed version exposes it under a different name -- wire that call here for your
# SDK version. It never emits a partial file.
node - "$SEED_HEX" "$OUT" <<'NODE'
const fs = require("fs");
const sdk = require("@midnightntwrk/wallet-sdk-hd");
const [seedHex, out] = [process.argv[2], process.argv[3]];
const derive =
  (typeof sdk.deriveFromSeedHex === "function" && sdk.deriveFromSeedHex) ||
  (sdk.default && typeof sdk.default.deriveFromSeedHex === "function" && sdk.default.deriveFromSeedHex) ||
  null;
if (!derive) {
  console.error(
    "ERROR: the installed '@midnightntwrk/wallet-sdk-hd' does not expose a recognized seed->key\n" +
    "       derivation entry point. Wire your SDK version's derivation call into generate-test-wallet.sh\n" +
    "       and re-run. Refusing to write a malformed wallet file."
  );
  process.exit(3);
}
const d = derive(seedHex);
if (!d || typeof d.nightSecretKeyHex !== "string" || typeof d.address !== "string") {
  console.error("ERROR: derivation did not return { nightSecretKeyHex, address }. Not writing a file.");
  process.exit(3);
}
const wallet = { network: "preview", seedHex, nightSecretKeyHex: d.nightSecretKeyHex, address: d.address };
fs.writeFileSync(out, JSON.stringify(wallet, null, 2) + "\n");
console.log("Wrote " + out + " with a fresh seed.");
console.log("Now fund the address at https://faucet.preview.midnight.network/ (Preview tDUST, no value).");
NODE
