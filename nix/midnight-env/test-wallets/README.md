# Test wallets

This directory holds a **throwaway Midnight Preview testnet wallet** for the dev environment. It is
managed so that **no wallet key with any value is ever committed** to this repository.

- **`preview-test-wallet.example.json`** — a non-secret **template** showing the field shape
  (`network`, `seedHex`, `nightSecretKeyHex`, `address`). Its `seedHex`/`nightSecretKeyHex` are
  all-zero placeholders and its `address` is a `REPLACE_ME` marker — it contains no secret.
- **`generate-test-wallet.sh`** — generates a **fresh, local, untracked** wallet.
- **`preview-test-wallet.json`** — the actual wallet file. It is **git-ignored and NOT tracked**;
  each machine generates its own and funds it from the faucet.

## Generate your local wallet

```bash
cd nix/midnight-env/test-wallets
./generate-test-wallet.sh
```

The generator creates a fresh 32-byte seed and derives `nightSecretKeyHex`/`address` using the
**Midnight wallet SDK HD key-derivation tooling** (`@midnightntwrk/wallet-sdk-hd`). If that tooling
is not resolvable in your tree (the repo carries only `@midnightntwrk/wallet-sdk-abstractions` as a
dev dependency), the generator **fails with an actionable message naming the required tool** and
writes **nothing** — it will never emit a malformed wallet file. Install the derivation tool, or run
the generator from a checkout that has the Midnight wallet SDK, then re-run.

Then fund the wallet's `address` from the Preview faucet:

**https://faucet.preview.midnight.network/**

Preview `tDUST` has **no monetary value**; it exists only to let the dev environment transact on a
throwaway testnet. On a fresh machine, re-generate and re-fund — **do not** commit the wallet.

## Why this is not just a committed key anymore

A live `preview-test-wallet.json` (with a real `seedHex`/`nightSecretKeyHex`) was previously committed
here as a convenience. Even though Preview `tDUST` is valueless, committing **any** key is a habit
this repository refuses to keep (see the repo-root [`SECURITY.md`](../../../SECURITY.md) commit policy).
As of 1.0.0:

- the live file is **untracked** and `.gitignore`d (so a locally generated one is never re-committed);
- the `.example` template + generator replace it;
- **no git-history rewrite was performed.** The old key is verified **valueless** Preview material,
  so rewriting history (`git filter-repo`/BFG) would be disproportionate; its bytes therefore remain
  permanently in git **history**, and that permanence is explicitly **accepted**. The go-forward
  guard is the **full-history `gitleaks` scan** in CI (`.github/workflows/supply-chain.yml`). It
  suppresses **exactly the two historical findings, by fingerprint**, in `.gitleaksignore` — *not*
  by allowlisting these paths, which would exempt them permanently and hide a real key committed
  here later. A real secret introduced anywhere, **including on these two paths**, fails the gate.
  A custom `umbradb-wallet-seed-hex` rule additionally catches `seedHex`, which the stock rules miss
  (they key on the field name containing "SecretKey", so the *seed* — the value everything else is
  derived from — went undetected).

**Never** reuse this pattern for mainnet or any key with real value.
