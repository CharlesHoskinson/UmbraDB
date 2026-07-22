import type {
  CheckpointSequence, CheckpointStore, CheckpointSummary, SaveCheckpointOptions,
} from "../interfaces/checkpoint-store.js";
import { decode, encode, EnvelopeCorruptError, type WalletStateEnvelope } from "../interfaces/wallet-state-envelope.js";
import { ValidationError } from "../interfaces/storage-errors.js";

/**
 * Thin wrapper over an injected `CheckpointStore` (`src/interfaces/checkpoint-store.ts`) that
 * persists a {@link WalletStateEnvelope} as a SINGLE `CheckpointStore.save()` call per
 * (walletId, networkId) (`openspec/changes/sprint-8-wallet-envelope-live-sync/design.md` §1/§2).
 * Adds NO new table or migration -- it reuses `CheckpointStore`'s own chunk/manifest storage
 * entirely.
 *
 * No wallet-SDK runtime import (`design.md` §2's boundary rule, extended from Sprint 7's identical
 * rule for `PgTransactionHistoryStorage`) -- the injected `CheckpointStore` is this project's own
 * interface, and the encode/decode helpers this class calls
 * (`src/interfaces/wallet-state-envelope.ts`) treat every sub-wallet string as opaque.
 */
export class PgWalletStateEnvelopeStore {
  constructor(private readonly checkpointStore: CheckpointStore) {}

  /**
   * Encodes `envelope` and persists it via exactly one `CheckpointStore.save(walletId, networkId,
   * bytes)` call, so the three sub-wallet strings are stored as one atomic unit -- either all
   * three are durable together or none are (`design.md` §1, "one save call persists the whole
   * bundle atomically").
   *
   * **F8 fix (audit finding, symmetric with the load-side check):** rejects BEFORE any encode/
   * persist work happens if `envelope`'s own echoed `walletId`/`networkId` do not match the call
   * args -- mirroring {@link load}'s own cross-check of the loaded envelope's echoed identity
   * against the requested key. Without this, a caller could persist an envelope under one key
   * while its own embedded identity silently claims another, and that mismatch would only ever
   * surface later, on `load` (as `EnvelopeCorruptError`) -- this catches it at write time instead.
   *
   * @throws {ValidationError} if `envelope`'s own `walletId`/`networkId` do not match the call
   *   args, or if `envelope` fails its schema (the latter surfaced from `encode`).
   */
  async save(
    walletId: string, networkId: string, envelope: WalletStateEnvelope, opts?: SaveCheckpointOptions,
  ): Promise<CheckpointSummary> {
    if (envelope.walletId !== walletId || envelope.networkId !== networkId) {
      throw new ValidationError(
        `PgWalletStateEnvelopeStore.save: envelope's own (walletId, networkId) = `
        + `(${JSON.stringify(envelope.walletId)}, ${JSON.stringify(envelope.networkId)}) does not match `
        + `the requested (${JSON.stringify(walletId)}, ${JSON.stringify(networkId)})`,
        [
          { path: "walletId", message: `expected ${JSON.stringify(walletId)}, received ${JSON.stringify(envelope.walletId)}` },
          { path: "networkId", message: `expected ${JSON.stringify(networkId)}, received ${JSON.stringify(envelope.networkId)}` },
        ],
      );
    }
    const bytes = encode(envelope);
    return this.checkpointStore.save(walletId, networkId, bytes, opts);
  }

  /**
   * Loads the envelope for (walletId, networkId) -- the latest checkpoint when `sequence` is
   * omitted, or the envelope at that exact sequence (mirroring `CheckpointStore.load`'s own
   * `sequence?` contract) -- decodes it, and cross-checks the envelope's own echoed
   * `walletId`/`networkId` against the requested key (`design.md` §1.1) before returning it.
   *
   * @throws {CheckpointNotFoundError} if nothing has ever been saved for this key (surfaced from
   *   the underlying `CheckpointStore.load`) -- never a default/empty envelope.
   * @throws {EnvelopeVersionUnsupportedError} if the stored envelope's version is unrecognized.
   * @throws {EnvelopeCorruptError} if the stored bytes do not decode to a valid envelope, or the
   *   envelope's echoed (walletId, networkId) does not match the requested key.
   */
  async load(
    walletId: string, networkId: string, sequence?: CheckpointSequence, opts?: { signal?: AbortSignal },
  ): Promise<WalletStateEnvelope> {
    const record = await this.checkpointStore.load(walletId, networkId, sequence, opts);
    const envelope = decode(record.data);
    if (envelope.walletId !== walletId || envelope.networkId !== networkId) {
      throw new EnvelopeCorruptError(
        `PgWalletStateEnvelopeStore.load: envelope's echoed (walletId, networkId) = `
        + `(${JSON.stringify(envelope.walletId)}, ${JSON.stringify(envelope.networkId)}) does not match `
        + `the requested (${JSON.stringify(walletId)}, ${JSON.stringify(networkId)})`,
      );
    }
    return envelope;
  }
}
