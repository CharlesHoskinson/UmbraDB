import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ENVELOPE_VERSION, type WalletStateEnvelope } from "../../src/interfaces/wallet-state-envelope.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { PgCheckpointStore } from "../../src/postgres/checkpoint-store.js";
import { PgTransactionHistoryStorage } from "../../src/postgres/transaction-history-storage.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";
import { PgWalletStateEnvelopeStore } from "../../src/postgres/wallet-state-envelope.js";
import { referenceMergeEntries } from "../postgres/reference-merge.js";
import { startTestDatabase, stopTestDatabase } from "../postgres/setup.js";
import {
  buildUnshieldedConfig, EXPECTED_NIGHT_VALUE, EXPECTED_UNSHIELDED_ADDRESS, FAUCET_TX_HASH_PREFIX,
  firstStateWhere, LIVE_PREPROD_ENABLED, SEED_FILE,
} from "./live-fixtures/preprod-fixtures.js";
import { deriveUnshieldedSeed, loadMidnightWalletSdk } from "./live-fixtures/midnight-wallet-sdk-loader.js";
import { PgWalletSdkTransactionHistoryAdapter } from "./pg-tx-history-adapter.js";

const NETWORK_ID = "PreProd";

/**
 * Cold-boot recovery (`openspec/changes/sprint-8-wallet-envelope-live-sync/design.md` §5) --
 * nightly/labeled, gated behind `UMBRADB_LIVE_PREPROD=1`: sync -> serialize the exercised
 * sub-wallet -> envelope -> `PgWalletStateEnvelopeStore.save` -> destroy the wallet -> "fresh
 * process" -> `load` -> restore -> `PgTransactionHistoryStorage.getAll()` for tx-history -> assert
 * resume WITHOUT a full resync AND tx-history continuity.
 *
 * **"Fresh process" simplification (a deliberately recorded scope decision).** The spec's own
 * wording ("destroy the wallet instance and the process... Fresh process: ...") describes a
 * literal cross-process restart. This test simulates that at the level that actually matters for
 * the contract under test -- a fresh, independently-constructed wallet/adapter/storage object
 * graph with NO shared JS reference to phase A's wallet/adapter instances, reloading the envelope
 * and reconstructing everything from Postgres alone -- rather than literally forking a second OS
 * process. A literal fork would need a process-spawning mechanism for this project's un-compiled
 * TypeScript sources (e.g. `tsx`/`ts-node`), which is deliberately NOT part of this sprint's pin
 * list (L2's pin list is exactly `effect` + `@midnightntwrk/wallet-sdk-abstractions`). Phase B
 * below is a plain function with its own local scope that receives only `sql` (a real Postgres
 * connection a genuine fresh process would equally have to open) and `walletId` (the recovery
 * key) -- it never closes over phase A's `wallet`/`config`/`adapter` variables.
 */
describe.skipIf(!LIVE_PREPROD_ENABLED)("Cold-boot recovery (nightly/labeled, design.md §5)", () => {
  vi.setConfig({ testTimeout: 10 * 60_000, hookTimeout: 10 * 60_000 });

  it("resumes from its envelope's snapshot cursor without a full resync, and tx-history is continuous off the Pg store", async () => {
    const sql: UmbraDBSql = await startTestDatabase();
    try {
      const sdk = await loadMidnightWalletSdk();
      const walletId = `preprod-coldboot-${randomUUID()}`;

      const serializedUnshielded = await phaseA_syncAndPersistEnvelope(sql, sdk, walletId);
      await phaseB_freshProcessRestoreAndVerify(sql, sdk, walletId, serializedUnshielded);
    } finally {
      await stopTestDatabase();
    }
  });
});

/** Phase A: sync a fresh wallet against public preprod, persist its envelope, destroy it. Returns
 *  the raw serialized unshielded-wallet string (used ONLY for an out-of-band equality check in
 *  the test below that the round-trip through Postgres was lossless -- phase B does NOT receive
 *  this value directly; it reloads it from Postgres via the envelope store, exactly as a genuine
 *  fresh process would). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function phaseA_syncAndPersistEnvelope(sql: UmbraDBSql, sdk: any, walletId: string): Promise<string> {
  const adapter = new PgWalletSdkTransactionHistoryAdapter(sql, walletId, referenceMergeEntries);
  const config = buildUnshieldedConfig(sdk, adapter);

  const seedHex = readFileSync(SEED_FILE, "utf8").trim();
  const unshieldedSeed = deriveUnshieldedSeed(sdk.hd, seedHex);
  const keystore = sdk.unshielded.createKeystore(unshieldedSeed, config.networkId);
  const publicKey = sdk.unshielded.PublicKey.fromKeyStore(keystore);
  expect(publicKey.address).toBe(EXPECTED_UNSHIELDED_ADDRESS);

  const wallet = sdk.unshielded.UnshieldedWallet(config).startWithPublicKey(publicKey);
  try {
    await wallet.start();
    await firstStateWhere(wallet.state, (state: { availableCoins: readonly unknown[] }) => state.availableCoins.length > 0);
    const state = await wallet.waitForSyncedState();

    const nativeTokenType = sdk.ledger.nativeToken().raw;
    expect((state.balances as Record<string, bigint>)[nativeTokenType]).toBe(EXPECTED_NIGHT_VALUE);

    // Sprint 8 §5 step 2: serialize the exercised sub-wallet (unshielded only, for this preprod
    // wallet -- shielded/dust are never exercised here, `design.md` §1.1's "Sync cost").
    const serializedUnshielded: string = await wallet.serializeState();
    expect(typeof serializedUnshielded).toBe("string");
    expect(serializedUnshielded.length).toBeGreaterThan(0);

    // §5 step 3: build the envelope, one CheckpointStore.save via PgWalletStateEnvelopeStore.
    const envelope: WalletStateEnvelope = {
      envelopeVersion: ENVELOPE_VERSION,
      walletId,
      networkId: NETWORK_ID,
      subWallets: { shielded: null, unshielded: serializedUnshielded, dust: null },
    };
    const envelopeStore = new PgWalletStateEnvelopeStore(new PgCheckpointStore(sql, new PgTransactionLeaseLayer(sql)));
    await envelopeStore.save(walletId, NETWORK_ID, envelope);

    // eslint-disable-next-line no-console
    console.log("[cold-boot] phase A: synced + envelope saved for walletId", walletId);
    return serializedUnshielded;
  } finally {
    // §5 step 4: destroy the wallet instance (see the class doc for why this test does not also
    // fork a literal second OS process).
    await wallet.stop();
  }
}

/** Phase B: a "fresh process" -- receives only `sql` and `walletId`, closes over nothing from
 *  phase A. Loads the envelope, restores the unshielded sub-wallet from it, and asserts both
 *  halves of the binding requirement: resume without a full resync, and tx-history continuity off
 *  the Pg store. */
async function phaseB_freshProcessRestoreAndVerify(
  sql: UmbraDBSql,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sdk: any,
  walletId: string,
  originalSerializedUnshielded: string,
): Promise<void> {
  // §5 step 5: PgWalletStateEnvelopeStore.load -> decode + version-check (throws
  // EnvelopeVersionUnsupportedError/EnvelopeCorruptError/CheckpointNotFoundError otherwise; a
  // clean resolve here already proves decode succeeded and the version was recognized).
  const envelopeStore = new PgWalletStateEnvelopeStore(new PgCheckpointStore(sql, new PgTransactionLeaseLayer(sql)));
  const envelope = await envelopeStore.load(walletId, NETWORK_ID);

  // Lossless round-trip through Postgres (encode -> CheckpointStore chunks -> decode).
  expect(envelope.subWallets.unshielded).toBe(originalSerializedUnshielded);
  // WHERE-optional requirement: the unexercised sub-wallets are absent, and restore (below) skips
  // them rather than failing.
  expect(envelope.subWallets.shielded).toBeNull();
  expect(envelope.subWallets.dust).toBeNull();

  // "tx-history on restore is authoritative from the Pg store" -- checked via a BRAND NEW
  // PgTransactionHistoryStorage instance (no shared reference to phase A's), and BEFORE the
  // sub-wallet is even restored/started below: the row is already there, off Postgres alone, with
  // no resync of any kind required to see it.
  const pgStorageAfterRestart = new PgTransactionHistoryStorage(sql, walletId, referenceMergeEntries);
  const txHistoryBeforeRestore = await pgStorageAfterRestart.getAll();
  const faucetRowBeforeRestore = txHistoryBeforeRestore.find((e) => e.hash.startsWith(FAUCET_TX_HASH_PREFIX));
  expect(faucetRowBeforeRestore).toBeDefined();

  // §5 step 5 (continued): restore the present sub-wallet only (unshielded); shielded/dust are
  // null and are correctly never touched here (WHERE-optional: "skip that sub-wallet... SHALL NOT
  // fail for the absent one").
  const adapterAfterRestart = new PgWalletSdkTransactionHistoryAdapter(sql, walletId, referenceMergeEntries);
  const configAfterRestart = buildUnshieldedConfig(sdk, adapterAfterRestart);
  const restoredWallet = sdk.unshielded.UnshieldedWallet(configAfterRestart).restore(envelope.subWallets.unshielded);

  try {
    // Grab the very first emitted state BEFORE calling start() -- this reflects CoreWallet.restore's
    // own initial progress cursor (`unshielded-wallet/src/v1/Serialization.ts`'s
    // `appliedId: snapshot.appliedId ?? 0n`), not yet touched by any new sync activity. A FRESH
    // (non-restored) wallet's CoreWallet.init always starts this at exactly 0n -- so a strictly
    // positive value here is direct, mechanical proof the restore resumed from the snapshot's own
    // cursor rather than rescanning from genesis (design.md §5 (a): "resume without a full
    // resync").
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const initialState = await firstStateWhere<any>(restoredWallet.state, () => true);
    // eslint-disable-next-line no-console
    console.log("[cold-boot] phase B: restored wallet's initial progress:", initialState.progress);
    expect(initialState.progress.appliedId).toBeGreaterThan(0n);

    // §5 step 5: `.start()` resumes the sync subscription from that cursor.
    await restoredWallet.start();
    const resumedState = await restoredWallet.waitForSyncedState();
    const nativeTokenType = sdk.ledger.nativeToken().raw;
    expect((resumedState.balances as Record<string, bigint>)[nativeTokenType]).toBe(EXPECTED_NIGHT_VALUE);

    // §5 step 6/7(b): tx-history continuity holds AFTER resume too, still off the Pg store, not
    // the restored blob's own embedded copy.
    const txHistoryAfterResume = await pgStorageAfterRestart.getAll();
    expect(txHistoryAfterResume.find((e) => e.hash.startsWith(FAUCET_TX_HASH_PREFIX))).toBeDefined();

    // eslint-disable-next-line no-console
    console.log("[cold-boot] phase B: resume verified -- no full resync, tx-history continuous");
  } finally {
    await restoredWallet.stop();
  }
}
