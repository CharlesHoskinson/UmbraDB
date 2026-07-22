import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { midnightWalletRepoRoot } from "./midnight-wallet-sdk-loader.js";

/**
 * Loader for the REAL wallet SDK's `mergeWalletEntries` (`packages/facade/src/index.ts`) and
 * `mergeUnshieldedSections` (`packages/unshielded-wallet/src/v1/TransactionHistory.ts`), used ONLY
 * by `test/postgres/reference-merge-parity.test.ts`'s F1(c) parity test -- the preferred "real
 * runtime diff" proving `referenceMergeEntries` mirrors `mergeWalletEntries`' documented semantics
 * (`openspec/changes/sprint-8-wallet-envelope-live-sync/design.md` §2/§3.3's F1 correction).
 *
 * Mirrors `midnight-wallet-sdk-loader.ts`'s own pattern exactly: resolves by ABSOLUTE PATH into an
 * already-built `midnight-wallet` checkout's OWN `dist/` output, via a COMPUTED (non-literal)
 * import specifier so `tsc` treats every `import(...)` call as `Promise<any>` rather than
 * attempting real module resolution against this project's own `node_modules` -- neither
 * `@midnightntwrk/wallet-sdk-facade` nor `@midnightntwrk/wallet-sdk-unshielded-wallet` is (or
 * should become) a devDependency of this repo; this sprint's pin list is deliberately just
 * `effect` + `@midnightntwrk/wallet-sdk-abstractions` (`design/environment/versions.lock.json`).
 *
 * **Unlike the live/cold-boot tiers, this is NOT gated behind `UMBRADB_LIVE_PREPROD`** -- it needs
 * no network, no funded seed, no indexer. It is gated on `facadeMergeAvailable()`, which is `true`
 * only when the sibling checkout's `packages/facade/dist/index.js` and
 * `packages/unshielded-wallet/dist/index.js` already exist (i.e. someone has already run
 * `npm run dist -w @midnightntwrk/wallet-sdk-facade` -w `@midnightntwrk/wallet-sdk-unshielded-wallet`
 * there). `reference-merge-parity.test.ts` uses this to `describe.skipIf` its real-runtime-diff
 * block, falling back to its unconditional, dependency-free source-faithful rule assertions when
 * the dist is not present (a fresh clone, or CI, where `~/repos/midnight-wallet` is not cloned at
 * all) -- exactly the two-tier design `design.md`'s F1(c) note documents.
 */

function facadeDistIndexPath(): string {
  return path.join(midnightWalletRepoRoot(), "packages", "facade", "dist", "index.js");
}

function unshieldedWalletDistIndexPath(): string {
  return path.join(midnightWalletRepoRoot(), "packages", "unshielded-wallet", "dist", "index.js");
}

/** `true` only when both dist files this loader needs already exist on disk -- a fast,
 *  synchronous, side-effect-free check (no import attempted) so the test file can use it directly
 *  inside `describe.skipIf` at collection time. */
export function facadeMergeAvailable(): boolean {
  return existsSync(facadeDistIndexPath()) && existsSync(unshieldedWalletDistIndexPath());
}

/** Loads the two real functions this parity test diffs against. Typed `Promise<any>` throughout
 *  (see the module doc for why) -- only called after `facadeMergeAvailable()` has already
 *  confirmed both dist files exist. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadFacadeMerge(): Promise<any> {
  const [facade, unshieldedWallet] = await Promise.all([
    import(pathToFileURL(facadeDistIndexPath()).href),
    import(pathToFileURL(unshieldedWalletDistIndexPath()).href),
  ]);
  return {
    mergeWalletEntries: facade.mergeWalletEntries,
    mergeUnshieldedSections: unshieldedWallet.mergeUnshieldedSections,
  };
}
