import { describe, expect, it } from "vitest";
import type { TransactionHistoryEntry } from "../../src/interfaces/transaction-history-storage.js";
import { facadeMergeAvailable, loadFacadeMerge } from "../integration/live-fixtures/facade-merge-loader.js";
import { referenceMergeEntries } from "./reference-merge.js";

/**
 * F1(c) parity test (`openspec/changes/sprint-8-wallet-envelope-live-sync/design.md`'s F1
 * correction, cross-vendor audit BLOCK finding): proves `referenceMergeEntries`
 * (`test/postgres/reference-merge.ts`) mirrors the real wallet SDK's `mergeWalletEntries`
 * (`~/repos/midnight-wallet/packages/facade/src/index.ts:128-151`) documented merge semantics --
 * identifier union+dedupe; first-writer-wins for `protocolVersion`/`status`/`timestamp`/`fees`;
 * incoming-wins `lifecycle`; per-section merge-when-both-present, present-side-otherwise.
 *
 * Two tiers, per the sprint brief's own instruction:
 *
 * 1. **Source-faithful rule test (unconditional, no external dependency, required-gate-safe).**
 *    Encodes each documented rule as an explicit assertion against `referenceMergeEntries` alone,
 *    citing the exact SDK source lines each assertion mirrors. This ALWAYS runs -- it needs no
 *    sibling checkout, so it is the guaranteed baseline this parity claim rests on even in an
 *    environment (a fresh clone, CI) where `~/repos/midnight-wallet` is not cloned at all.
 * 2. **Real runtime diff (preferred when available, `describe.skipIf`-gated).** This sprint
 *    successfully built the real facade in a few minutes
 *    (`cd ~/repos/midnight-wallet && npm run dist -w @midnightntwrk/wallet-sdk-facade` -- its
 *    package.json has no `build` script, but does have a `dist` script running `tsc -b`; building
 *    also required first building its two then-missing workspace dependencies,
 *    `@midnightntwrk/wallet-sdk-dust-wallet` and `@midnightntwrk/wallet-sdk-shielded`, via the same
 *    `dist` script -- total elapsed well under the ~10 minute budget), so this block dynamically
 *    imports the REAL `mergeWalletEntries` + `mergeUnshieldedSections` from that now-built dist
 *    (`facade-merge-loader.ts`) and diffs their output against `referenceMergeEntries`' output on
 *    translated inputs -- an actual runtime diff, not merely a structural resemblance argument.
 *    Gated on `facadeMergeAvailable()` (a synchronous dist-file existence check) rather than an env
 *    var, so it degrades to skipped (not failing) in any environment where the sibling checkout is
 *    not built -- exactly the same tiering discipline the live/cold-boot tests use for
 *    `UMBRADB_LIVE_PREPROD`.
 *
 * **Known, deliberate translation gaps between the two systems (not bugs, footnoted so the
 * re-audit does not mistake them for parity failures):**
 * - The real `TransactionHistoryStatus` vocabulary is uppercase (`"SUCCESS"`/`"FAILURE"`/
 *   `"PARTIAL_SUCCESS"`); UmbraDB's own is lowercase-camel (`"success"`/`"failure"`/
 *   `"partialSuccess"`) -- exactly the adapter's own F6 status-map concern, orthogonal to the core
 *   merge RULE (which is agnostic to which concrete string value is stored, only THAT the
 *   first-set value wins). This test uses each system's own native vocabulary and asserts the RULE
 *   (first-writer-wins) holds in each, rather than asserting the raw strings are identical.
 * - The real `mergeWalletEntries`'s output keeps `hash: existing.hash`; `referenceMergeEntries`
 *   keeps `hash: incoming.hash`. Immaterial in practice (a legitimate merge only ever runs on two
 *   entries that share one hash by construction -- `PgTransactionHistoryStorage.writeRows` itself
 *   throws if a merge result's hash ever differs from the incoming entry's), and this test's own
 *   fixtures use one identical hash on both sides, so this difference never surfaces here.
 * - The real SDK's full `lifecycle` carries per-status detail (`submittedAt`/`finalizedBlock`/
 *   `rejectedAt`+`reason`); UmbraDB's Sprint-7 `EntryLifecycle` is a bare `{status}`. This test
 *   compares only the `status` discriminant (the "incoming wins" rule itself) -- the DETAIL
 *   round-trip is a separate, already-covered concern (F2/design.md §3.2,
 *   `test/integration/pg-tx-history-adapter.test.ts`'s lifecycle-detail-round-trip block).
 */
describe("F1(c) parity: referenceMergeEntries mirrors mergeWalletEntries' documented merge semantics", () => {
  describe("source-faithful rule test (unconditional -- no external dependency, required-gate-safe)", () => {
    function umbraEntry(overrides: Partial<TransactionHistoryEntry>): TransactionHistoryEntry {
      return {
        hash: "parity-hash-1",
        identifiers: ["a", "b"],
        lifecycle: { status: "pending" },
        sections: {},
        ...overrides,
      };
    }

    // Mirrors facade/src/index.ts:130: "const identifiers = Array.from(new Set([...existing.identifiers, ...incoming.identifiers]));"
    it("identifiers are unioned and deduplicated (facade/src/index.ts:130)", () => {
      const existing = umbraEntry({ identifiers: ["a", "b"] });
      const incoming = umbraEntry({ identifiers: ["b", "c"] });
      const merged = referenceMergeEntries(existing, incoming);
      expect([...merged.identifiers].sort()).toEqual(["a", "b", "c"]);
    });

    // Mirrors facade/src/index.ts:141-144: "protocolVersion: existing.protocolVersion ?? incoming.protocolVersion" (and status/timestamp/fees, same pattern).
    it("protocolVersion/status/timestamp/fees are first-writer-wins (facade/src/index.ts:141-144)", () => {
      const t1 = new Date("2026-01-01T00:00:00.000Z");
      const t2 = new Date("2026-02-01T00:00:00.000Z");
      const existing = umbraEntry({ protocolVersion: 1, status: "success", timestamp: t1, fees: 10n });
      const incoming = umbraEntry({ protocolVersion: 2, status: "failure", timestamp: t2, fees: 20n });
      const merged = referenceMergeEntries(existing, incoming);
      expect(merged.protocolVersion).toBe(1);
      expect(merged.status).toBe("success");
      expect(merged.timestamp!.getTime()).toBe(t1.getTime());
      expect(merged.fees).toBe(10n);
    });

    it("a scalar fact absent on existing but present on incoming is taken from incoming (first EVER writer of that field wins, not necessarily the first merge call)", () => {
      const existing = umbraEntry({}); // no protocolVersion/status/timestamp/fees set at all
      const incoming = umbraEntry({ protocolVersion: 9, fees: 99n });
      const merged = referenceMergeEntries(existing, incoming);
      expect(merged.protocolVersion).toBe(9);
      expect(merged.fees).toBe(99n);
    });

    // Mirrors facade/src/index.ts:146: "lifecycle: incoming.lifecycle, // lifecycle: incoming wins".
    it("lifecycle is incoming-wins (facade/src/index.ts:146)", () => {
      const existing = umbraEntry({ lifecycle: { status: "pending" } });
      const incoming = umbraEntry({ lifecycle: { status: "finalized" } });
      const merged = referenceMergeEntries(existing, incoming);
      expect(merged.lifecycle).toEqual({ status: "finalized" });
    });

    // Mirrors facade/src/index.ts:119-126,133-135 (mergeOptionalSection): "if (existing !== undefined && incoming !== undefined) return merge(existing, incoming); return existing ?? incoming;"
    it("a section present on BOTH sides is merged (shallow, incoming-wins-per-leaf, standing in for a section-specific merge)", () => {
      const existing = umbraEntry({ sections: { unshielded: { id: 1, note: "existing-note", keepMe: "existing-only" } } });
      const incoming = umbraEntry({ sections: { unshielded: { id: 1, note: "incoming-note" } } });
      const merged = referenceMergeEntries(existing, incoming);
      // shallow spread {...existing, ...incoming}: incoming's "note" wins, existing's "keepMe" (not present incoming) survives.
      expect(merged.sections.unshielded).toEqual({ id: 1, note: "incoming-note", keepMe: "existing-only" });
    });

    it("a section present on only ONE side is taken from that side verbatim, no merge attempted (facade/src/index.ts:125 'existing ?? incoming')", () => {
      const onlyExisting = referenceMergeEntries(
        umbraEntry({ sections: { unshielded: { id: 1 } } }),
        umbraEntry({ sections: {} }),
      );
      expect(onlyExisting.sections.unshielded).toEqual({ id: 1 });

      const onlyIncoming = referenceMergeEntries(
        umbraEntry({ sections: {} }),
        umbraEntry({ sections: { unshielded: { id: 2 } } }),
      );
      expect(onlyIncoming.sections.unshielded).toEqual({ id: 2 });
    });
  });

  // Visibility guard (Codex re-audit): the real-runtime-diff tier below is describe.skipIf-gated on
  // the facade dist existing, so it silently no-ops in a fresh clone / CI. This always-running test
  // makes that state LOUD in the output so a skipped diff is never mistaken for a passed diff. The
  // source-cited rule-assertion tier above always runs and is the required-gate-safe baseline.
  it("real-SDK runtime diff availability is reported (loud skip, not silent)", () => {
    if (!facadeMergeAvailable()) {
      // eslint-disable-next-line no-console
      console.warn(
        "[reference-merge-parity] real-SDK runtime diff SKIPPED: facade/unshielded-wallet dist not "
        + "present (fresh clone / CI). The rule-assertion tier above still ran (required-gate-safe "
        + "baseline); the runtime diff runs only where the sibling midnight-wallet checkout is built.",
      );
    }
    expect(typeof facadeMergeAvailable()).toBe("boolean");
  });

  describe.skipIf(!facadeMergeAvailable())(
    "real runtime diff against the SDK's own mergeWalletEntries (preferred tier -- facade dist was built for this pass)",
    () => {
      it("SECOND-write fixture: identifiers union, first-writer-wins scalars, incoming-wins lifecycle, and per-section merge-when-both-present all agree between mergeWalletEntries and referenceMergeEntries on translated inputs", async () => {
        const { mergeWalletEntries } = await loadFacadeMerge();

        const t1 = new Date("2026-03-01T00:00:00.000Z");
        const t2 = new Date("2026-04-01T00:00:00.000Z");
        const existingUnshielded = {
          id: 1,
          createdUtxos: [{ value: 5n, owner: "owner-a", tokenType: "token-a", intentHash: "intent-a", outputIndex: 0 }],
          spentUtxos: [],
        };
        const incomingUnshielded = {
          id: 1,
          createdUtxos: [{ value: 7n, owner: "owner-b", tokenType: "token-b", intentHash: "intent-b", outputIndex: 1 }],
          spentUtxos: [{ value: 3n, owner: "owner-c", tokenType: "token-c", intentHash: "intent-c", outputIndex: 2 }],
        };

        // Real SDK's own WalletEntry-shaped fixtures (facade/src/index.ts:83-89's WalletEntrySchema).
        const existingWalletEntry = {
          hash: "parity-hash-1",
          identifiers: ["a", "b"],
          protocolVersion: 1,
          status: "SUCCESS",
          timestamp: t1,
          fees: 10n,
          lifecycle: { status: "pending", submittedAt: t1 },
          unshielded: existingUnshielded,
        };
        const incomingWalletEntry = {
          hash: "parity-hash-1",
          identifiers: ["b", "c"],
          protocolVersion: 2,
          status: "FAILURE",
          timestamp: t2,
          fees: 20n,
          lifecycle: { status: "finalized", finalizedBlock: { hash: "block-1", height: 1, timestamp: t2 } },
          unshielded: incomingUnshielded,
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const realMerged: any = mergeWalletEntries(existingWalletEntry, incomingWalletEntry);

        // UmbraDB-shaped equivalents -- same identifiers/protocolVersion/timestamp/fees/section
        // values, lifecycle DISCRIMINANT only (Sprint 7's bare {status} model; the SDK's per-status
        // detail is a separate, already-covered concern -- see this file's own doc), status in
        // UmbraDB's own lowercase-camel vocabulary (the F6 mapping is orthogonal to the merge RULE
        // under test here).
        const existingUmbra: TransactionHistoryEntry = {
          hash: "parity-hash-1",
          identifiers: ["a", "b"],
          protocolVersion: 1,
          status: "success",
          timestamp: t1,
          fees: 10n,
          lifecycle: { status: "pending" },
          sections: { unshielded: existingUnshielded },
        };
        const incomingUmbra: TransactionHistoryEntry = {
          hash: "parity-hash-1",
          identifiers: ["b", "c"],
          protocolVersion: 2,
          status: "failure",
          timestamp: t2,
          fees: 20n,
          lifecycle: { status: "finalized" },
          sections: { unshielded: incomingUnshielded },
        };
        const refMerged = referenceMergeEntries(existingUmbra, incomingUmbra);

        // identifiers: union+dedupe, agreeing between both systems.
        expect([...realMerged.identifiers].sort()).toEqual(["a", "b", "c"]);
        expect([...refMerged.identifiers].sort()).toEqual(["a", "b", "c"]);

        // scalar facts: first-writer-wins, agreeing between both systems (existing's values survive).
        expect(realMerged.protocolVersion).toBe(1);
        expect(refMerged.protocolVersion).toBe(1);
        expect(realMerged.timestamp.getTime()).toBe(t1.getTime());
        expect(refMerged.timestamp!.getTime()).toBe(t1.getTime());
        expect(realMerged.fees).toBe(10n);
        expect(refMerged.fees).toBe(10n);
        // status: each system's own native vocabulary, same RULE (first-writer-wins existing's value).
        expect(realMerged.status).toBe("SUCCESS");
        expect(refMerged.status).toBe("success");

        // lifecycle: incoming-wins, agreeing between both systems (the discriminant only).
        expect(realMerged.lifecycle.status).toBe("finalized");
        expect(refMerged.lifecycle.status).toBe("finalized");

        // per-section merge-when-both-present: the REAL mergeUnshieldedSections is a shallow
        // {...existing, ...incoming} spread (packages/unshielded-wallet/src/v1/TransactionHistory.ts:38-41),
        // structurally IDENTICAL to referenceMergeEntries' own object-valued-section stand-in rule
        // -- so both outputs must be deep-equal to incomingUnshielded verbatim (incoming's own three
        // keys fully overwrite existing's).
        expect(realMerged.unshielded).toEqual(incomingUnshielded);
        expect(refMerged.sections.unshielded).toEqual(incomingUnshielded);
        expect(realMerged.unshielded).toEqual(refMerged.sections.unshielded);
      });

      it("a section present on only ONE side is taken from that side verbatim in BOTH systems (present-otherwise rule)", async () => {
        const { mergeWalletEntries } = await loadFacadeMerge();
        const onlyExistingUnshielded = { id: 5, createdUtxos: [], spentUtxos: [] };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const realMerged: any = mergeWalletEntries(
          { hash: "h", identifiers: ["a"], lifecycle: { status: "pending", submittedAt: new Date() }, unshielded: onlyExistingUnshielded },
          { hash: "h", identifiers: ["a"], lifecycle: { status: "pending", submittedAt: new Date() } },
        );
        const refMerged = referenceMergeEntries(
          { hash: "h", identifiers: ["a"], lifecycle: { status: "pending" }, sections: { unshielded: onlyExistingUnshielded } },
          { hash: "h", identifiers: ["a"], lifecycle: { status: "pending" }, sections: {} },
        );

        expect(realMerged.unshielded).toEqual(onlyExistingUnshielded);
        expect(refMerged.sections.unshielded).toEqual(onlyExistingUnshielded);
      });
    },
  );
});
