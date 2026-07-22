import { z } from "zod";
import { hasPostgresUnsafeText } from "./temporal-kv.js";
import { StorageError, ValidationError } from "./storage-errors.js";

/**
 * WalletState envelope (`openspec/changes/sprint-8-wallet-envelope-live-sync/specs/
 * wallet-state-envelope/spec.md`): one versioned JSON object wrapping the three sub-wallets'
 * independent, opaque `serializeState()` strings -- `shielded`, `unshielded`, `dust`, each its own
 * distinct SDK snapshot schema (`shielded-wallet/src/v1/Serialization.ts:66-119`,
 * `unshielded-wallet/src/v1/Serialization.ts:43-90`, `dust-wallet/src/v1/Serialization.ts:62-114`)
 * -- together with an `envelopeVersion` schema-version tag, so `PgWalletStateEnvelopeStore`
 * (`src/postgres/wallet-state-envelope.ts`) can persist the whole bundle as a SINGLE
 * `CheckpointStore.save()` call per (walletId, networkId) (`design.md` §1, decision (a): one
 * versioned envelope, chosen over (b) three coordinated checkpoints).
 *
 * This module has NO wallet-SDK runtime import -- the three sub-wallet strings are handled as
 * opaque `string` values, exactly as `CheckpointStore` treats its own payload as opaque bytes
 * (`design.md` §2; mirrors Sprint 7's identical rule for `PgTransactionHistoryStorage`). The one
 * place SDK types appear anywhere in Sprint 8 is the adapter
 * (`test/integration/pg-tx-history-adapter.ts`), which lives outside `src/` entirely.
 *
 * **Weaker-than-it-looks contract (binding, `design.md` §5).** Bundling three sub-wallet strings
 * into one envelope buys ATOMIC persistence of the bundle as a unit -- either all three are
 * durable together or none are -- but does NOT buy cross-sub-wallet same-height consistency. The
 * three sub-wallets sync on independent subscriptions, so one envelope can legitimately hold three
 * states captured at three different block heights. Restoring bundles them back together for
 * operational atomicity only; each sub-wallet resumes its own sync from its own last-known point
 * (recommendation §3 open question 5; Sprint 7 `design.md` §6.2 default (a)).
 */

const POSTGRES_SAFE_TEXT_MESSAGE = "must not contain a NUL byte or an unpaired UTF-16 surrogate (PostgreSQL cannot store either)";

/** Opaque sub-wallet snapshot string, exactly as returned by that sub-wallet's own
 *  `serializeState()` -- never parsed or altered by this module. */
const SubWalletStringSchema = z.string().refine((s) => !hasPostgresUnsafeText(s), {
  message: `sub-wallet snapshot string ${POSTGRES_SAFE_TEXT_MESSAGE}`,
});

/** `null` (or absent, normalized to `null`) when that sub-wallet was never exercised -- e.g. the
 *  preprod live tier syncs only the `unshielded` sub-wallet, so its envelope carries `unshielded`
 *  populated and `shielded`/`dust` `null` (`design.md` §1.1). The restore path (the adapter/live
 *  tier, outside this module) skips a `null` slot rather than failing on it. */
const SubWalletSlotSchema = z.union([SubWalletStringSchema, z.null()]);

/** The current, and so far only, envelope schema version. Bumped on any breaking shape change; an
 *  envelope tagged with any OTHER value is rejected outright (`decode`'s version guard below),
 *  never best-effort restored. This is the forward seam for the future
 *  `verifiable-snapshot-recovery` hardening layer, which will add anchor/finality fields under a
 *  bumped version rather than mutating v1 (`design.md` §1.1, §6). */
export const ENVELOPE_VERSION = 1 as const;

export interface WalletStateEnvelope {
  readonly envelopeVersion: typeof ENVELOPE_VERSION;
  /** Echoed for a defensive cross-check against the (walletId, networkId) key `load` was
   *  actually called with (`design.md` §1.1) -- `PgWalletStateEnvelopeStore.load` verifies these
   *  match the requested keys, treating a mismatch as envelope corruption rather than silently
   *  trusting whichever key the stored envelope happens to claim. */
  readonly walletId: string;
  readonly networkId: string;
  readonly subWallets: {
    readonly shielded: string | null;
    readonly unshielded: string | null;
    readonly dust: string | null;
  };
}

/** Validates the envelope SHAPE only -- `envelopeVersion` is required to be a positive integer
 *  here, but NOT checked for equaling {@link ENVELOPE_VERSION}. The version-VALUE check is a
 *  deliberately separate step in `decode` (below), so a well-formed envelope tagged with an
 *  unrecognized version can be rejected with the specific
 *  {@link EnvelopeVersionUnsupportedError} rather than lumped in with a generic shape failure. */
const WalletStateEnvelopeShapeSchema = z.object({
  envelopeVersion: z.number().int().positive(),
  walletId: z.string().min(1).refine((s) => !hasPostgresUnsafeText(s), { message: `walletId ${POSTGRES_SAFE_TEXT_MESSAGE}` }),
  networkId: z.string().min(1).refine((s) => !hasPostgresUnsafeText(s), { message: `networkId ${POSTGRES_SAFE_TEXT_MESSAGE}` }),
  subWallets: z.object({
    shielded: SubWalletSlotSchema,
    unshielded: SubWalletSlotSchema,
    dust: SubWalletSlotSchema,
  }),
});

export type WalletStateEnvelopeErrorCode = "VERSION_UNSUPPORTED" | "CORRUPT";

/** Common ancestor for the envelope's own typed DECODE-time errors -- deliberately distinct from
 *  {@link ValidationError} (used by `encode`, an ordinary write-time input-boundary check),
 *  because `decode` reads previously-stored bytes and needs to distinguish "an envelope this
 *  build doesn't understand yet" from "not a valid envelope at all," mirroring
 *  `CheckpointStoreError`'s own reasoning for having a dedicated read-time error family
 *  (`src/interfaces/checkpoint-store.ts`). */
export abstract class WalletStateEnvelopeError extends StorageError {
  abstract readonly code: WalletStateEnvelopeErrorCode;
}

/** `decode`/`load` encountered a well-formed envelope tagged with an `envelopeVersion` this build
 *  does not recognize (`design.md` §1.1's forward seam). Never a best-effort restore of an unknown
 *  shape. */
export class EnvelopeVersionUnsupportedError extends WalletStateEnvelopeError {
  readonly code = "VERSION_UNSUPPORTED" as const;
  constructor(readonly foundVersion: number, readonly supportedVersion: number = ENVELOPE_VERSION) {
    super(`unsupported envelopeVersion ${foundVersion} (this build only understands version ${supportedVersion})`);
  }
}

/** `decode`/`load` was given bytes that are not valid JSON, or valid JSON that does not satisfy
 *  the envelope schema (missing `envelopeVersion`, a non-string sub-wallet slot, an echoed
 *  walletId/networkId that doesn't match the requested load key, etc.). Never surfaces a raw
 *  `SyntaxError`/parse error, and never returns a malformed envelope. */
export class EnvelopeCorruptError extends WalletStateEnvelopeError {
  readonly code = "CORRUPT" as const;
  constructor(message: string, cause?: unknown) { super(message, cause); }
}

/**
 * Encodes a {@link WalletStateEnvelope} to the `Uint8Array` `CheckpointStore.save` expects.
 * Validates `envelope` against the full schema first (ordinary boundary validation -- NOT a
 * decode-time envelope error) so a malformed envelope can never be encoded into stored bytes in
 * the first place.
 *
 * @throws {ValidationError} if `envelope` fails its schema, or its `envelopeVersion` does not
 *   match this build's {@link ENVELOPE_VERSION} (reachable only by bypassing TypeScript, since
 *   `envelope.envelopeVersion` is typed as the literal `typeof ENVELOPE_VERSION`).
 */
export function encode(envelope: WalletStateEnvelope): Uint8Array {
  const parsed = WalletStateEnvelopeShapeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw ValidationError.fromZod("WalletStateEnvelope.encode", parsed.error);
  }
  if (parsed.data.envelopeVersion !== ENVELOPE_VERSION) {
    throw new ValidationError(
      "WalletStateEnvelope.encode: envelopeVersion does not match this build's ENVELOPE_VERSION",
      [{ path: "envelopeVersion", message: `expected ${ENVELOPE_VERSION}, received ${parsed.data.envelopeVersion}` }],
    );
  }
  return new TextEncoder().encode(JSON.stringify(parsed.data));
}

/**
 * Decodes bytes produced by {@link encode} back into a {@link WalletStateEnvelope}, in three
 * strictly ordered steps: (1) valid UTF-8 JSON, (2) a recognized `envelopeVersion`, (3) the full
 * envelope schema. Ordering (2) before (3) is deliberate -- it is what lets an
 * unrecognized-version envelope be rejected with the specific
 * {@link EnvelopeVersionUnsupportedError} even when its shape is otherwise perfectly well-formed
 * (`design.md` §1.1's forward seam), rather than folding that case into the generic
 * {@link EnvelopeCorruptError}.
 *
 * @throws {EnvelopeCorruptError} if `bytes` is not valid UTF-8/JSON, or valid JSON that does not
 *   satisfy the envelope schema (missing/non-numeric `envelopeVersion`, a non-string sub-wallet
 *   slot, etc.).
 * @throws {EnvelopeVersionUnsupportedError} if `envelopeVersion` is a well-formed positive integer
 *   this build does not recognize.
 */
export function decode(bytes: Uint8Array): WalletStateEnvelope {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (err) {
    throw new EnvelopeCorruptError("WalletStateEnvelope.decode: payload is not valid UTF-8", err);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new EnvelopeCorruptError("WalletStateEnvelope.decode: payload is not valid JSON", err);
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EnvelopeCorruptError("WalletStateEnvelope.decode: payload is not a JSON object");
  }
  const versionRaw = (raw as Record<string, unknown>).envelopeVersion;
  if (typeof versionRaw !== "number" || !Number.isInteger(versionRaw) || versionRaw <= 0) {
    throw new EnvelopeCorruptError(
      `WalletStateEnvelope.decode: envelopeVersion is missing or not a positive integer (found ${JSON.stringify(versionRaw)})`,
    );
  }
  if (versionRaw !== ENVELOPE_VERSION) {
    throw new EnvelopeVersionUnsupportedError(versionRaw);
  }

  const parsed = WalletStateEnvelopeShapeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EnvelopeCorruptError(
      `WalletStateEnvelope.decode: payload does not satisfy the envelope schema: `
      + parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; "),
      parsed.error,
    );
  }
  // parsed.data.envelopeVersion is typed as the schema's own `number` (a positive-integer guard,
  // not the literal 1 -- see WalletStateEnvelopeShapeSchema's own doc for why the version VALUE
  // is checked separately, above), but the `versionRaw !== ENVELOPE_VERSION` check already
  // guarantees it equals ENVELOPE_VERSION by this point -- narrow it back to the literal type here
  // rather than widening WalletStateEnvelope.envelopeVersion's own type to `number`.
  return { ...parsed.data, envelopeVersion: ENVELOPE_VERSION };
}
