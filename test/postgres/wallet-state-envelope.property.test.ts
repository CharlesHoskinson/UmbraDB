import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { hasPostgresUnsafeText } from "../../src/interfaces/temporal-kv.js";
import { decode, encode, ENVELOPE_VERSION, type WalletStateEnvelope } from "../../src/interfaces/wallet-state-envelope.js";

const safeString = (maxLength = 40): fc.Arbitrary<string> =>
  fc.string({ maxLength }).filter((s) => !hasPostgresUnsafeText(s));
const safeNonEmptyString = (maxLength = 40): fc.Arbitrary<string> =>
  safeString(maxLength).filter((s) => s.length > 0);

/** Arbitrary opaque sub-wallet slot: a `null` (absent) or a safe, arbitrary opaque string --
 *  mirrors `design.md` §1.1's "a sub-wallet value MAY be null/absent when not exercised." */
const subWalletSlot: fc.Arbitrary<string | null> = fc.option(safeString(200), { nil: null });

const arbitraryEnvelope: fc.Arbitrary<WalletStateEnvelope> = fc.record({
  envelopeVersion: fc.constant(ENVELOPE_VERSION),
  walletId: safeNonEmptyString(),
  networkId: safeNonEmptyString(),
  subWallets: fc.record({
    shielded: subWalletSlot,
    unshielded: subWalletSlot,
    dust: subWalletSlot,
  }),
});

describe("WalletStateEnvelope properties (specs/wallet-state-envelope/spec.md)", () => {
  it("decode(encode(x)) is equivalent to x for arbitrary valid envelopes, including any subset of sub-wallets absent, and never rejects a valid x", () => {
    fc.assert(
      fc.property(arbitraryEnvelope, (envelope) => {
        const roundTripped = decode(encode(envelope));
        expect(roundTripped).toEqual(envelope);
      }),
      { numRuns: 300 },
    );
  });

  it("each sub-wallet slot's presence/absence is preserved independently across the round-trip", () => {
    fc.assert(
      fc.property(arbitraryEnvelope, (envelope) => {
        const roundTripped = decode(encode(envelope));
        expect(roundTripped.subWallets.shielded === null).toBe(envelope.subWallets.shielded === null);
        expect(roundTripped.subWallets.unshielded === null).toBe(envelope.subWallets.unshielded === null);
        expect(roundTripped.subWallets.dust === null).toBe(envelope.subWallets.dust === null);
      }),
      { numRuns: 300 },
    );
  });
});
