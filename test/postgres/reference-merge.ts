import type { EntryContent, MergeEntriesFn, TransactionHistoryEntry } from "../../src/interfaces/transaction-history-storage.js";

function isPlainObject(v: EntryContent): v is Record<string, EntryContent> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
}

/** Object-valued `sections` keys stand in for the real SDK's per-wallet-type sections
 *  (shielded/unshielded/dust) and are merged shallowly, incoming-wins-per-leaf -- a stand-in for
 *  "each wallet section uses its own section-specific merge function" (`design.md` §3): this is
 *  enough to prove the concurrency invariant (disjoint section KEYS from two racing writers both
 *  survive) without needing the real, SDK-owned per-section merge logic. Scalar-valued keys stand
 *  in for "shared scalar facts" and are first-writer-wins. */
function mergeSections(
  a: Readonly<Record<string, EntryContent>>, b: Readonly<Record<string, EntryContent>>,
): Record<string, EntryContent> {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const result: Record<string, EntryContent> = {};
  for (const k of keys) {
    const av = a[k];
    const bv = b[k];
    if (av === undefined) { result[k] = bv!; continue; }
    if (bv === undefined) { result[k] = av; continue; }
    result[k] = isPlainObject(av) && isPlainObject(bv) ? { ...av, ...bv } : av;
  }
  return result;
}

/**
 * Test-only stand-in for the wallet SDK's `mergeWalletEntries` (`design.md` §2's caller-injected
 * merge function) — never imported from any `@midnightntwrk/*` package. Implements exactly the
 * four merge rules `specs/transaction-history-storage/spec.md` requires:
 * - `identifiers` unioned across merges.
 * - `lifecycle` incoming-wins.
 * - object-valued top-level `sections` keys (standing in for shielded/unshielded/dust) merged
 *   independently, shallow, incoming-wins-per-leaf.
 * - scalar-valued top-level `sections` keys (standing in for shared facts, e.g. a block
 *   timestamp) first-writer-wins.
 * - `hash`/`protocolVersion`/`status`/`timestamp`/`fees`: first-writer-wins when already set,
 *   same "shared scalar fact" rule.
 *
 * Shared, by construction, between `PgTransactionHistoryStorage` and
 * `InMemoryTransactionHistoryStorage` in every test that uses it (both constructed with THIS
 * SAME function), so a sequential-equivalence assertion between the two backends is actually
 * comparing persistence behavior, not two different merge policies.
 *
 * **F1: `existing` is always defined here** — both storage backends call this function ONLY when
 * a stored entry already exists for the hash, and persist a first write verbatim without ever
 * calling this function (mirroring the real SDK's `mergeWalletEntries`' own both-present
 * assumption; see `MergeEntriesFn`'s doc). There is deliberately no `existing === undefined`
 * branch here any more.
 */
export const referenceMergeEntries: MergeEntriesFn = (existing, incoming) => {
  const identifiers = Array.from(new Set([...existing.identifiers, ...incoming.identifiers]));
  const result: TransactionHistoryEntry = {
    hash: incoming.hash,
    identifiers,
    lifecycle: incoming.lifecycle,
    sections: mergeSections(existing.sections, incoming.sections),
    // First-writer-wins for each optional "shared scalar fact": prefer `existing`'s value
    // whenever it set one at all, falling back to `incoming`'s only when `existing` never did.
    ...(existing.protocolVersion !== undefined || incoming.protocolVersion !== undefined
      ? { protocolVersion: existing.protocolVersion ?? incoming.protocolVersion } : {}),
    ...(existing.status !== undefined || incoming.status !== undefined
      ? { status: existing.status ?? incoming.status } : {}),
    ...(existing.timestamp !== undefined || incoming.timestamp !== undefined
      ? { timestamp: existing.timestamp ?? incoming.timestamp } : {}),
    ...(existing.fees !== undefined || incoming.fees !== undefined
      ? { fees: existing.fees !== undefined ? existing.fees : incoming.fees } : {}),
  };
  return result;
};
