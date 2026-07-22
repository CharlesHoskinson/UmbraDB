import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Dynamically loads the pieces of the real Midnight wallet SDK the LIVE (nightly/labeled) preprod
 * DB-sync + cold-boot tiers need, by ABSOLUTE PATH into an already-built `midnight-wallet`
 * checkout -- NOT via package-name resolution, and deliberately NOT installed as an UmbraDB
 * `package.json` devDependency.
 *
 * Why: (L2) this sprint's own pin list is deliberately just `effect` +
 * `@midnightntwrk/wallet-sdk-abstractions` (both real devDependencies -- the required-gate
 * adapter, `../pg-tx-history-adapter.ts`, needs their real types/schema). The packages THIS
 * loader reaches for -- `@midnightntwrk/wallet-sdk-hd`, `@midnightntwrk/wallet-sdk-unshielded-
 * wallet`, and the native-binding `@midnight-ntwrk/ledger-v8` -- are heavier (ledger-v8 in
 * particular ships a compiled wasm binding) and are used ONLY by the optional, nightly/labeled
 * live tier (`test:live`), never by the required Pg-only conformance gate. Rather than duplicating
 * that footprint into this repo's own `node_modules`, this loader resolves them from the sibling
 * `midnight-wallet` checkout's OWN already-installed `node_modules` -- exactly how they resolve
 * when `midnight-wallet` runs its own tests (verified: `nodeLinker: node-modules` in that repo's
 * `.yarnrc.yml`, a standard hoisted layout, not Plug'n'Play).
 *
 * Every import below is a COMPUTED (non-literal) specifier, so `tsc` treats each `import(...)`
 * call as `Promise<any>` rather than attempting real module resolution against this project's own
 * `node_modules` -- this file (and everything under `test/integration/preprod-db-sync.integration.
 * test.ts` / `cold-boot-recovery.integration.test.ts` that consumes it) still TYPECHECKS cleanly
 * without those packages ever being installed here, satisfying the sprint's "must typecheck and be
 * runnable" bar for the live tier even in an environment where `midnight-wallet` isn't cloned.
 */

/** Root of a BUILT `midnight-wallet` checkout (dist present for hd/unshielded-wallet/abstractions
 *  -- confirmed in this environment at commit `e744d994`, `design/environment/versions.lock.json`).
 *  Overridable via `MIDNIGHT_WALLET_REPO` for a different checkout location. */
export function midnightWalletRepoRoot(): string {
  return process.env.MIDNIGHT_WALLET_REPO ?? path.join(process.env.HOME ?? "", "repos", "midnight-wallet");
}

function packageDistFile(pkgDir: string, ...distSegments: string[]): string {
  return pathToFileURL(path.join(midnightWalletRepoRoot(), "packages", pkgDir, "dist", ...distSegments)).href;
}

function ledgerV8NodeEntry(): string {
  return pathToFileURL(
    path.join(midnightWalletRepoRoot(), "node_modules", "@midnight-ntwrk", "ledger-v8", "midnight_ledger_wasm_fs.js"),
  ).href;
}

/**
 * Every runtime value the live tiers need, loaded from the sibling checkout. Typed `Promise<any>`
 * members throughout -- see the module doc for why that is deliberate here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadMidnightWalletSdk(): Promise<any> {
  const [hd, abstractions, unshielded, ledger] = await Promise.all([
    import(packageDistFile("hd", "index.js")),
    import(packageDistFile("abstractions", "index.js")),
    import(packageDistFile("unshielded-wallet", "index.js")),
    import(ledgerV8NodeEntry()),
  ]);
  return { hd, abstractions, unshielded, ledger };
}

/** Same HD derivation the proven wiring uses (`preprodUnshieldedSync.manual.integration.test.ts`
 *  `getUnshieldedSeed`, identical to `wallet-sdk-testkit/src/seeds.ts#getUnshieldedSeed`):
 *  `HDWallet.fromSeed -> selectAccount(0) -> selectRole(Roles.NightExternal) -> deriveKeyAt(0)`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function deriveUnshieldedSeed(hd: any, seedHex: string): Uint8Array {
  const seedBuffer = Buffer.from(seedHex, "hex");
  const hdWalletResult = hd.HDWallet.fromSeed(seedBuffer);
  if (hdWalletResult.type !== "seedOk") {
    throw new Error(`deriveUnshieldedSeed: HDWallet.fromSeed failed: ${JSON.stringify(hdWalletResult)}`);
  }
  const hdWallet = hdWalletResult.hdWallet;
  const derivationResult = hdWallet.selectAccount(0).selectRole(hd.Roles.NightExternal).deriveKeyAt(0);
  if (derivationResult.type === "keyOutOfBounds") {
    throw new Error("deriveUnshieldedSeed: key derivation out of bounds");
  }
  hdWallet.clear();
  return Buffer.from(derivationResult.key);
}
