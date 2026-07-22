import * as os from "node:os";

/**
 * Shared constants + tiny helpers for the two nightly/labeled live tiers
 * (`preprod-db-sync.integration.test.ts`, `cold-boot-recovery.integration.test.ts`). Facts sourced
 * from `design/environment/preprod-connection.md` and `design/environment/verification-checklist.md`
 * (verified live 2026-07-21), reused verbatim from the proven wiring
 * (`~/repos/midnight-wallet/packages/wallet-integration-tests/test/
 * preprodUnshieldedSync.manual.integration.test.ts`).
 */

export const SEED_FILE = `${os.homedir()}/.midnight-preprod-wallet.seed`;
export const EXPECTED_UNSHIELDED_ADDRESS = "mn_addr_preprod14plwqf5qymh879pskxyharf86plfj288ccvklaa74nqsha5f2p3szaxvvc";
export const EXPECTED_NIGHT_VALUE = 1_000_000_000n; // 1000 tNIGHT at 6 decimals

/** The faucet transaction's hash/identifier are recorded truncated-with-an-ellipsis in the sprint
 *  brief and `AUTONOMOUS_RUN_LOG.md` (`b194e71d…493341`, identifier `00ea17cf…20bea`) -- the tests
 *  below match on these confirmed PREFIXES rather than guessing the elided middle bytes. */
export const FAUCET_TX_HASH_PREFIX = "b194e71d";
export const FAUCET_IDENTIFIER_PREFIX = "00ea17cf";

export const PREPROD_INDEXER_HTTP = "https://indexer.preprod.midnight.network/api/v4/graphql";
export const PREPROD_INDEXER_WS = "wss://indexer.preprod.midnight.network/api/v4/graphql/ws";

/** Both live tiers are gated behind this env var so they never run as part of the default
 *  `npm test`/`npm run test:conformance` (the required merge gate) -- only via the explicit
 *  `npm run test:live` script, which sets it. */
export const LIVE_PREPROD_ENABLED = process.env.UMBRADB_LIVE_PREPROD === "1";

/**
 * Awaits `observable` (an rxjs `Observable`-shaped object, as returned by the wallet SDK's
 * `wallet.state`) until `predicate` first holds -- using only the bare Observer/Subscription
 * shape every rxjs `Observable` satisfies (`.subscribe({next, error}) -> {unsubscribe()}`), so
 * this project does not need its own `rxjs` import (see `midnight-wallet-sdk-loader.ts`'s module
 * doc for why the live tier's SDK dependencies are deliberately NOT installed as UmbraDB
 * devDependencies).
 */
export function firstStateWhere<S>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  observable: any, predicate: (state: S) => boolean,
): Promise<S> {
  return new Promise((resolve, reject) => {
    const subscription = observable.subscribe({
      next: (state: S) => {
        if (predicate(state)) {
          subscription.unsubscribe();
          resolve(state);
        }
      },
      error: (err: unknown) => reject(err),
    });
  });
}

/** Builds the SDK's `DefaultV1Configuration` shape (proven wiring
 *  `preprodUnshieldedSync.manual.integration.test.ts:88-95`), with `txHistoryStorage` as the ONE
 *  thing this sprint changes -- an UmbraDB-backed adapter, replacing
 *  `InMemoryTransactionHistoryStorage`. Untyped (`any`) -- see `midnight-wallet-sdk-loader.ts`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildUnshieldedConfig(sdk: any, txHistoryStorage: unknown): any {
  return {
    networkId: sdk.abstractions.NetworkId.NetworkId.PreProd,
    indexerClientConnection: { indexerHttpUrl: PREPROD_INDEXER_HTTP, indexerWsUrl: PREPROD_INDEXER_WS },
    txHistoryStorage,
  };
}
