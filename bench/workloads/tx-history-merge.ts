import type { MergeEntriesFn } from "../../src/interfaces/transaction-history-storage.js";

/**
 * A minimal, bench-local merge function for {@link PgTransactionHistoryStorage} — deliberately NOT
 * imported from `test/` and NEVER from any `@midnightntwrk/*` package (indexer-agnostic boundary,
 * `design.md` §7; roadmap G11). It implements only what the churn workload needs: identifiers are
 * unioned, lifecycle is incoming-wins, sections merge shallowly. It is called only when a stored
 * entry already exists for the hash (both `existing` and `incoming` are defined), mirroring the
 * real SDK's `mergeWalletEntries` both-present contract.
 */
export const benchMerge: MergeEntriesFn = (existing, incoming) => ({
  hash: incoming.hash,
  identifiers: Array.from(new Set([...existing.identifiers, ...incoming.identifiers])),
  lifecycle: incoming.lifecycle,
  sections: { ...existing.sections, ...incoming.sections },
});
