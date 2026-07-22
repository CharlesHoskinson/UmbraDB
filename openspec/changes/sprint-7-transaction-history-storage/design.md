# Design — Sprint 7: Transaction History Storage

Source of truth for the decisions below is `design/sprint-5-recommendation.md` (twice
independently audited: 2 Opus + Codex GPT-5.6 Sol round 1, Opus + Codex re-audit round 2). This
document restates those decisions in this repo's own design-doc format and adds the schema/DDL
and API-shape detail the recommendation deliberately left to the "EARS spec drafting stage."

## 1. Schema

One table, keyed by transaction hash, holding the merged shielded+unshielded+dust entry produced
by the facade's `mergeWalletEntries`:

```sql
CREATE TABLE transaction_history (
  wallet_id    text        NOT NULL,
  tx_hash      text        NOT NULL,
  entry        jsonb       NOT NULL,
  identifiers  text[]      NOT NULL DEFAULT '{}',
  lifecycle    text        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_id, tx_hash)
);
CREATE INDEX transaction_history_identifiers_gin
  ON transaction_history USING gin (identifiers);
```

- `wallet_id` is a construction-time-bound identifier (§4), not a method parameter — the six
  `TransactionHistoryStorage` methods never carry one (`TransactionHistoryStorage.ts:163-195`).
- `identifiers` is denormalized out of `entry` (rather than only living inside the JSONB) so the
  identifier-subset pending-clear rule (§3) can be checked with a GIN-indexed containment query
  instead of a JSONB path scan on every write.
- `lifecycle` (`pending` / `finalized` / `rejected`) is denormalized similarly, so a caller can
  filter without unpacking `entry` — matching the "only `lifecycle` is incoming-wins" merge rule
  (§3).
- No `serialize()`-specific column: `serialize()` is a full dump per the interface's fixed
  `Promise<string>` contract (§8's non-negotiable point) and is implemented as a `getAll()` +
  `JSON.stringify`, not a stored representation.

## 2. Dependency direction: structural mirror, not a runtime import

`PgTransactionHistoryStorage`'s constructor takes only a Postgres connection/pool, `walletId`,
and a caller-supplied merge function (`(existing: Entry | undefined, incoming: Entry) => Entry`).
It never imports `@midnightntwrk/wallet-sdk` (or any wallet-SDK package) at runtime. The merge
function passed at construction is expected to be `mergeWalletEntries` in production, but this
module has no compile-time or run-time dependency on that symbol — only a structural (shape)
dependency, checked by a dev-time conformance test that imports the real function under a
type-only/test-only dependency.

This is why the merge lives in caller-supplied TypeScript applied inside a DB transaction, not as
JSONB-merge-in-SQL: `mergeWalletEntries` itself delegates to three separate SDK packages'
own section-merge logic (`mergeShieldedSections`/`mergeUnshieldedSections`/`mergeDustSections`).
Reimplementing that in PL/pgSQL would be a divergence-prone duplication of logic that already
exists and is already tested upstream.

## 3. Atomic merge under concurrent writers

Each of the three wallet types syncs on its own independent subscription and calls
`gotFinalized`/`gotPending`/`gotRejected` on the *same shared storage instance*. A single mixed
transaction (touching both a shielded and a dust section, say) has one tx hash, so two wallet
types can race a read-modify-write on the same row.

**Write path** (every `gotPending`/`gotFinalized`/`gotRejected` call):

```sql
BEGIN;
SELECT entry, identifiers, lifecycle FROM transaction_history
  WHERE wallet_id = $1 AND tx_hash = $2 FOR UPDATE;
-- (application code: merge existing (if any) with the incoming entry, in TypeScript,
--  using the caller-supplied merge function — held across this round trip, lock still held)
INSERT INTO transaction_history (wallet_id, tx_hash, entry, identifiers, lifecycle, updated_at)
  VALUES ($1, $2, $3, $4, $5, now())
  ON CONFLICT (wallet_id, tx_hash) DO UPDATE
    SET entry = EXCLUDED.entry, identifiers = EXCLUDED.identifiers,
        lifecycle = EXCLUDED.lifecycle, updated_at = now();
COMMIT;
```

The `SELECT ... FOR UPDATE` inside the transaction is load-bearing: a bare atomic upsert of an
application-computed merge result is not sufficient on its own, because a second writer can read
the pre-merge row between the first writer's read and write under ordinary read-committed
isolation, silently losing that writer's update. The row lock, held across the in-process TS
merge call, is what prevents that — this project's first genuine multi-writer race on a single
logical row (no existing module has this shape: Watermarks has no lease of its own precisely
because it has no such race, and Transaction/Lease's advisory locks are for *cross-module*
composition, not this kind of same-row merge race).

Merge semantics must be equivalent to `mergeWalletEntries`, not a "last-write-wins"
approximation: shared scalar facts are first-writer-wins, `identifiers` are unioned across
merges, wallet sections (`shielded`/`unshielded`/`dust`) use section-specific merge functions, and
only `lifecycle` is incoming-wins. The identifier-subset pending-clear rule
(`InMemoryTransactionHistoryStorage.ts`'s `#clearPendingByIdentifiers`) must also survive several
merges: a pending entry clears when its identifiers are a *subset* of the finalized entry's, not
exact-array-equal, and identifier sets grow via union — so subset containment must still hold
after repeated merges, not just on the first one.

## 4. Multi-wallet identity

None of the six `TransactionHistoryStorage` methods carry a wallet identifier
(`TransactionHistoryStorage.ts:163-195`). Per the recommendation's resolution, `wallet_id` is
bound at **construction time**: one `PgTransactionHistoryStorage` instance per wallet, closed
over its own `walletId`. This repo's default deployment is one instance per wallet, not one
instance multiplexing several wallets — revisit only if a concrete multi-wallet-per-process use
case is named (open question, not blocking this sprint).

## 5. WalletState envelope

Each of the three wallet types (`ShieldedWallet`, `UnshieldedWallet`, `DustWallet`) has its own
independent `serializeState()`/`.restore()` pair with its own distinct snapshot schema — there is
no single facade-wide blob. The envelope module (new file, path
`src/postgres/wallet-state-envelope.ts` + a paired interface in `src/interfaces/`) wraps all
three serialized strings plus a schema version tag into one JSON object, checkpointed as a single
`CheckpointStore.save()` call per `(walletId, networkId)`.

`PgTransactionHistoryStorage` is authoritative for tx-history on restore, not the envelope's
internal copy: each wallet's own serialized snapshot also embeds its own internal transaction
history alongside local state and block height. The envelope only needs to carry enough to
resume `Sync.ts`'s own subscription (keys, UTXOs, sync-progress cursor) — the restored blob's
internal tx-history copy is superseded by whatever `PgTransactionHistoryStorage.getAll()` returns
on restore. `tasks.md` requires this to be stated explicitly in code comments and the module's
TSDoc, not left implicit.

## 6. Open questions carried into this sprint (unresolved, tracked here rather than silently defaulted)

1. **Checkpoint cadence and retention** for the envelope — every N blocks vs. shutdown-only;
   interaction with `CheckpointStore`'s existing GC retention policy.
2. **Cross-sub-wallet consistency** — the three sub-wallet snapshots bundled into one envelope
   sync independently, so they may not be mutually consistent as of the same block height. Two
   options: (a) accept "each sub-wallet resumes its own sync from its own last-known point, all
   bundled in one save/load call for operational convenience only" as a weaker, explicitly-stated
   contract, or (b) add a coordination mechanism forcing consistent capture. This sprint defaults
   to (a) and states it explicitly in the envelope's TSDoc; revisit if a real inconsistency bug
   is ever observed.

## 7. What "live-sync" means for this sprint's non-required test tier

The recommendation doc's original conformance plan scoped its live-sync tier to a **fully local**
devnet (`midnight-wallet`'s `docker-compose-dynamic.yml`: proof-server, midnight-node with
`CFG_PRESET: dev`, indexer-standalone) — explicitly "no public network, no faucet."

**Superseding direction from owner:** the live-sync tier will instead connect against a real node
synced to the public Midnight **preprod** network, not the disposable local devnet. This is a
materially different dependency:

- `midnight-node`'s own `local-environment/` tooling exposes a `preprod` well-known-network
  target, but that tooling **forks** a snapshot and replaces the live authority set with local
  mock validators (`local-environment/README.md`) — it does not itself keep syncing with the real
  live preprod network's own validators. Genesis rebuilds for `preprod` also require AWS-held
  secrets (`midnight-node/README.md`'s "Rebuilding preprod/prod genesis" section) that may not be
  available in this environment.
- A genuine "node connected to preprod" (a real peer joining the live public network over P2P
  and staying in sync) is the other shape this could mean, and is architecturally simpler for
  this sprint's purposes: UmbraDB's own code is already required to be agnostic to how sync data
  arrived (§2's dependency-direction rule covers this), so pointing the same conformance harness
  at a real preprod-connected indexer/node instead of a disposable local one is a **test
  infrastructure** change, not a product-code change.
- **Unresolved as of this draft**: which of the two above (or an existing preprod-connected node
  this project already has access to, from prior related work) is meant, and what
  endpoint/credentials/seed the harness should use. This must be resolved before Phase 2 of
  `tasks.md` (the live-sync scenarios) can be scheduled — it does not block Phase 1 (the Pg-only
  required-gate work, §3's atomic-merge implementation, and the envelope module), which has no
  dependency on any live node at all.
- Whatever is resolved, a preprod-connected tier can never be a required merge gate (real network
  dependency, real sync time, potentially real funds) — it stays nightly/labeled at most, and may
  need its own manual/on-demand tier stricter than "nightly" depending on cost.
