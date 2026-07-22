import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { referenceMergeEntries } from "../postgres/reference-merge.js";
import { startTestDatabase, stopTestDatabase } from "../postgres/setup.js";
import {
  buildUnshieldedConfig, EXPECTED_NIGHT_VALUE, EXPECTED_UNSHIELDED_ADDRESS, FAUCET_IDENTIFIER_PREFIX,
  FAUCET_TX_HASH_PREFIX, firstStateWhere, LIVE_PREPROD_ENABLED, SEED_FILE,
} from "./live-fixtures/preprod-fixtures.js";
import { deriveUnshieldedSeed, loadMidnightWalletSdk } from "./live-fixtures/midnight-wallet-sdk-loader.js";
import { PgWalletSdkTransactionHistoryAdapter } from "./pg-tx-history-adapter.js";

/**
 * Live preprod DB-sync verification (`openspec/changes/sprint-8-wallet-envelope-live-sync/
 * design.md` §4) -- nightly/labeled, gated behind `UMBRADB_LIVE_PREPROD=1` (set by
 * `npm run test:live`), NEVER a required merge gate: real network, real sync, a funded seed that
 * must not be in CI (`design.md` §4's final constraint). This is also, per this sprint's own
 * charge, THE FINAL MERGE GATE the orchestrator runs manually before merging Sprint 7+8 together.
 *
 * Reuses the PROVEN wiring verbatim
 * (`~/repos/midnight-wallet/packages/wallet-integration-tests/test/
 * preprodUnshieldedSync.manual.integration.test.ts`), changing exactly the one thing `design.md`
 * §4 specifies: `config.txHistoryStorage` becomes the UmbraDB-backed adapter instead of
 * `InMemoryTransactionHistoryStorage`. Everything else -- the seed, the derivation, the
 * `availableCoins.length > 0` THEN `waitForSyncedState()` ordering, the expected address/balance
 * -- is identical and already known-good.
 *
 * **F3 fix (audit finding).** The read side now goes through the ADAPTER's own `getAll()`
 * (`adapter.getAll()`), not a second, independently-constructed `PgTransactionHistoryStorage`
 * instance reading the row in UmbraDB's own native shape. This is the objective end-to-end proof
 * that the adapter's OWN reconstruction path (not just the underlying Pg row) works against a
 * real preprod-synced transaction: the returned entry must decode against the SDK's own
 * `TransactionHistoryEntryCommonSchema` with `finalizedBlock.height` intact.
 */
describe.skipIf(!LIVE_PREPROD_ENABLED)("Live preprod DB-sync (nightly/labeled, design.md §4)", () => {
  vi.setConfig({ testTimeout: 10 * 60_000, hookTimeout: 10 * 60_000 });

  it("syncs the funded preprod wallet against public preprod with the adapter injected as txHistoryStorage, and the faucet tx materializes as a UmbraDB Postgres row via getAll()", async () => {
    const sql: UmbraDBSql = await startTestDatabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let wallet: any;
    try {
      const sdk = await loadMidnightWalletSdk();
      const seedHex = readFileSync(SEED_FILE, "utf8").trim();

      // One fresh walletId per run -- this is a real, shared preprod indexer/network, but the
      // Postgres side is our own disposable Testcontainers instance, so a fresh walletId keeps
      // repeated manual runs from ever seeing a stale row from a previous run.
      const walletId = `preprod-live-${randomUUID()}`;
      const adapter = new PgWalletSdkTransactionHistoryAdapter(sql, walletId, referenceMergeEntries);

      const config = buildUnshieldedConfig(sdk, adapter);

      const unshieldedSeed = deriveUnshieldedSeed(sdk.hd, seedHex);
      const keystore = sdk.unshielded.createKeystore(unshieldedSeed, config.networkId);
      const publicKey = sdk.unshielded.PublicKey.fromKeyStore(keystore);

      // eslint-disable-next-line no-console
      console.log("[preprod-db-sync] derived address:", publicKey.address);
      expect(publicKey.address).toBe(EXPECTED_UNSHIELDED_ADDRESS);

      wallet = sdk.unshielded.UnshieldedWallet(config).startWithPublicKey(publicKey);
      await wallet!.start();

      // Mirrors packages/unshielded-wallet/test/UnshieldedWallet.integration.test.ts /
      // preprodUnshieldedSync.manual.integration.test.ts:118-122: waiting for "synced" alone is
      // not sufficient -- a fresh wallet can report strictly-complete before the coin-bearing
      // transaction has actually been applied.
      await firstStateWhere(wallet!.state, (state: { availableCoins: readonly unknown[] }) => state.availableCoins.length > 0);
      const state = await wallet!.waitForSyncedState();

      const nativeTokenType = sdk.ledger.nativeToken().raw;
      const balances = state.balances as Record<string, bigint>;

      // eslint-disable-next-line no-console
      console.log("[preprod-db-sync] FINAL balances:", balances);

      expect(balances[nativeTokenType]).toBe(EXPECTED_NIGHT_VALUE);

      // F3 fix: the new assertion this sprint adds over the proven wiring -- the DB row is the
      // "verify the DB actually syncs" proof (design.md §4) -- now reads through the ADAPTER's own
      // getAll(), proving the adapter's reconstruction path (not just the raw Pg row) works
      // end-to-end: the returned entry must decode against the real SDK schema, with
      // finalizedBlock.height intact.
      const txHistory = await adapter.getAll();
      // eslint-disable-next-line no-console
      console.log("[preprod-db-sync] UmbraDB tx-history row count (via adapter):", txHistory.length);

      const faucetRow = txHistory.find((e) => e.hash.startsWith(FAUCET_TX_HASH_PREFIX));
      expect(faucetRow).toBeDefined();
      expect(faucetRow!.identifiers.some((id) => id.startsWith(FAUCET_IDENTIFIER_PREFIX))).toBe(true);
      expect(faucetRow!.lifecycle.status).toBe("finalized");

      // F3: prove the adapter's reconstruction decodes against the REAL SDK schema, and that the
      // finalizedBlock.height carried through is a genuine, positive block height (the exact pinned
      // value 1,763,274 is recorded in AUTONOMOUS_RUN_LOG.md/proposal.md, but this assertion uses
      // the more robust ">0" form so this test still passes if the chain state is re-synced from a
      // different funding run).
      Schema.validateSync(sdk.abstractions.TransactionHistoryStorage.TransactionHistoryEntryCommonSchema)(faucetRow);
      const faucetLifecycle = faucetRow!.lifecycle as { status: "finalized"; finalizedBlock: { height: number } };
      expect(faucetLifecycle.finalizedBlock.height).toBeGreaterThan(0);

      // eslint-disable-next-line no-console
      console.log("[preprod-db-sync] OBSERVED faucet row (via adapter):", {
        hash: faucetRow!.hash,
        identifiers: faucetRow!.identifiers,
        lifecycle: faucetRow!.lifecycle,
      });
    } finally {
      await wallet?.stop();
      await stopTestDatabase();
    }
  });
});
