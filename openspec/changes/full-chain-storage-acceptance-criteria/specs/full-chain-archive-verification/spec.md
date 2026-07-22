# full-chain-archive-verification (acceptance gate)

The test plan and acceptance criteria that gate the real full-chain-storage implementation (the
ingestion/sync code that populates whatever schema `fix/full-chain-storage-schema-v2` or a later
revision lands on) before it may merge to `main`. Requirements below follow EARS (Easy Approach to
Requirements Syntax): each is one of Ubiquitous ("The system SHALL..."), Event-driven ("WHEN
\<trigger>, the system SHALL..."), Unwanted-behavior ("IF \<trigger>, THEN the system SHALL..."),
State-driven ("WHILE \<state>, the system SHALL..."), or Optional-feature ("WHERE \<feature>, the
system SHALL...") form — as in Sprint 2's, Sprint 4's, Sprint 7's, Sprint 8's, and Sprint 9's spec
files.

Every requirement is written against an **observable property**, not a v1 table/column name
(`design.md` in this change explains why). Where a v1 identifier is cited, it is the motivating
example, not a required implementation detail — the implementation is free to satisfy the
requirement under a renamed or restructured (v2+) schema.

## ADDED Requirements

### Requirement: AC-1 — competing blocks at the same height, with an overlapping transaction hash, both persist in full

WHEN two independently-arriving, mutually-competing blocks at the same height `H` are each
inserted with their own complete transaction set, including a transaction hash that appears in
**both** blocks' sets, THE SYSTEM SHALL persist both blocks and both blocks' complete transaction
sets without an insert conflict, so that neither fork's data is lost or rejected before canonical
status is even determined. This is the direct regression test for the confirmed v1 defect (a
`transactions` primary key of `(block_height, tx_hash)` with no `block_hash` component,
`design/full-chain-storage-design.md` §4.3) — the schema under test MUST disambiguate transaction
rows by which block they belong to, not merely by height and hash.

#### Scenario: Block A and Block B at height H, sharing a transaction hash, both persist

- **WHEN** block A is inserted at height `H` with transactions `{t1, t2, t3}` (t1's hash shared
  with block B), followed by inserting competing block B at height `H` with transactions
  `{t1, t4}` (same hash as A's `t1`, distinct bytes/position permitted)
- **THEN** both blocks SHALL be retrievable by their respective block hashes at height `H`
- **AND** block A's full transaction set `{t1, t2, t3}` SHALL be retrievable scoped to block A
- **AND** block B's full transaction set `{t1, t4}` SHALL be retrievable scoped to block B
- **AND** neither insert SHALL raise a uniqueness/constraint violation caused by the shared
  transaction hash alone

#### Scenario: A later reorg does not delete the losing fork's transaction rows

- **WHEN** block A (from the prior scenario) is subsequently marked non-canonical after block B's
  fork is chosen as canonical
- **THEN** block A's transaction rows SHALL remain queryable (scoped to block A), not
  cascade-deleted, so the archive retains its "recovery source of last resort" property
  (`design.md` §5)

### Requirement: AC-2 — at most one block per height is canonical, enforced at the data layer, not by application discipline alone

WHILE the archive holds any number of competing blocks at a given height, THE SYSTEM SHALL
guarantee that at most one of them is marked canonical at any time, and THIS GUARANTEE SHALL be
enforced by a mechanism the database itself rejects a violation against — a constraint, exclusion
rule, or equivalent server-side enforcement — not solely by every caller correctly following a
"flip the old one false before flipping the new one true" convention in application code.

#### Scenario: A second canonical row at the same height is rejected, not silently accepted

- **WHEN** block A at height `H` is already marked canonical, and an attempt is made to insert or
  update a second, distinct block B at the same height `H` to also be marked canonical (via
  whatever operation the implementation exposes for this — a raw adversarial insert/update
  bypassing any application-level guard) — while A's canonical flag is left unchanged
- **THEN** the attempt SHALL be rejected by the database (a constraint violation or equivalent
  server-side error), or the operation SHALL succeed only if it atomically un-marks A as part of
  the same operation such that the two-canonical-rows-at-height-H state is never observable to a
  concurrent reader
- **AND** a test that comments out or disables the enforcement mechanism (constraint/exclusion
  rule) MUST cause this scenario to fail (a mutation-style test, not a vacuous one) — proving the
  enforcement is real, not merely that the happy path never triggers the bug

#### Scenario: A correct reorg flip is a single observable state transition

- **WHEN** the canonical chain reorganizes from block A to block B at height `H`
- **THEN** at every point a concurrent reader queries the canonical block at height `H`, it SHALL
  observe exactly one canonical row (A before the flip, B after) — never zero, never both

### Requirement: AC-3 — every archived blob is retrievable and its content hash-matches its key, with corruption caught on read

THE SYSTEM SHALL make every blob in the content-addressed blob store (block header/body bytes,
raw transaction bytes, proof/verifier-key bytes, or whatever categories the final schema stores)
retrievable by its content-addressed key, and WHEN a blob is read, THE SYSTEM SHALL recompute its
hash from the retrieved bytes and reject the read if the recomputed hash does not match the
storage key — mirroring `CheckpointStore.loadImpl`'s proven rehash-on-read behavior
(`src/postgres/checkpoint-store.ts:260-278`, `ChunkIntegrityError`), not merely trusting that the
key was correct at write time.

#### Scenario: A stored blob round-trips and its content matches its key

- **WHEN** a blob is written to the blob store and its key is the content hash algorithm's output
  over the written bytes
- **THEN** reading the blob back by that key SHALL return bytes whose recomputed hash equals the
  key

#### Scenario: Out-of-band corruption of stored bytes is caught on the next read, not silently served

- **WHEN** a blob's stored bytes are mutated directly at the storage layer (out-of-band, not
  through the archive's own write path — e.g. a direct `UPDATE`/file-level byte flip against the
  row/object holding the blob for a given key), bypassing any application-level write guard
- **THEN** the next read of that key SHALL detect that the recomputed hash no longer matches the
  key and SHALL reject with a typed integrity error, never returning the corrupted bytes as if
  they were valid

### Requirement: AC-4 — replay-recoverability for every deferred data category is proven end-to-end, not assumed (hard gate, no exceptions)

FOR EVERY data category that the schema defers building a dedicated table for on the grounds that
it is "replay-recoverable from raw transaction bytes" (`design/full-chain-storage-design.md` §6's
zswap, unshielded-UTXO, and dust judgment calls, and any future category deferred on the same
basis), THE SYSTEM SHALL be proven, by an actual end-to-end test using only the archived raw
block/transaction bytes — no live node, no live indexer, no network call during the
reconstruction step itself — to reconstruct at least one real event of that category, and the
reconstructed value SHALL match what the indexer independently reports for the same event. This
requirement has no partial-credit interpretation:

**IF a deferred category's replay test cannot be made to pass — because the raw bytes do not
in fact contain enough information to reconstruct the event, or the reconstruction logic cannot be
written and verified — THEN that category SHALL NOT remain deferred. It SHALL be reclassified to
"build now" with its own dedicated table, and `design/full-chain-storage-design.md` §6's phasing
table entry for that category SHALL be corrected accordingly.** A design document's stated
intention to defer a category is not sufficient; only a passing reconstruction test is.

#### Scenario: A shielded (zswap) event is reconstructed purely from archived raw bytes and matches the indexer

- **WHEN** at least one real zswap event (e.g. a `ZswapOutput` ledger event, `design.md` §3.5) is
  identified in a synced chain's history, and its containing block/transaction's raw bytes are
  read solely from the archive (`chain_blobs`-equivalent store), with no live node or indexer
  query performed during reconstruction
- **THEN** parsing/decoding those raw bytes SHALL yield a reconstructed zswap event
- **AND** the reconstructed event's fields SHALL match the value the indexer independently
  reports for that same event (queried separately, as the ground truth to compare against — not
  as an input to the reconstruction)

#### Scenario: An unshielded UTXO event is reconstructed purely from archived raw bytes and matches the indexer

- **WHEN** at least one real unshielded UTXO creation or spend (`Utxo{value,owner,type_,
  intent_hash,output_no}`, `design.md` §3.4) is identified, and its transaction's raw bytes are
  read solely from the archive
- **THEN** parsing those raw bytes SHALL yield a reconstructed UTXO event whose fields match the
  indexer's independently-reported value for the same event

#### Scenario: A dust event is reconstructed purely from archived raw bytes and matches the indexer

- **WHEN** at least one real dust event (e.g. `DustInitialUtxo` or `DustGenerationDtimeUpdate`,
  `design.md` §3.5) is identified, and its transaction's raw bytes are read solely from the
  archive
- **THEN** parsing those raw bytes SHALL yield a reconstructed dust event whose fields match the
  indexer's independently-reported value for the same event

#### Scenario: A category that fails its replay test is reclassified, not shipped as deferred anyway

- **WHEN** any of the three scenarios above (or an equivalent test for a future deferred category)
  cannot be made to pass after a genuine implementation attempt
- **THEN** that category SHALL be built as its own dedicated table in the schema before this
  change's implementation is eligible to merge, and it SHALL NOT ship as "deferred, replay-
  recoverable" in the design's phasing table

### Requirement: AC-5 — archived data from different networks is never comingled or queryable across a network boundary

WHILE the archive holds data ingested from more than one Midnight network (e.g. local devnet
`undeployed`, Preview, Preprod), THE SYSTEM SHALL scope every archived row to the network it was
ingested from, and a query issued against one network's scope SHALL NEVER return a row ingested
from a different network — whether by an explicit filter the caller forgot to apply, a shared
height/hash coincidence across networks, or any other accidental comingling path.

#### Scenario: Two networks ingested into one archive remain queryable only within their own scope

- **WHEN** block/transaction data from network `undeployed` and block/transaction data from
  network `preview` are both ingested into the same archive instance (including a case where both
  networks happen to produce a block at the same height, or even the same hash by coincidence)
- **THEN** a query scoped to `undeployed` SHALL return only `undeployed`-ingested rows
- **AND** a query scoped to `preview` SHALL return only `preview`-ingested rows
- **AND** no query path SHALL exist that returns rows from both networks without the caller
  explicitly requesting cross-network data (if such a mode is ever offered, it must be an opt-in,
  clearly distinct code path, not the default)

#### Scenario: A height/hash coincidence across two networks does not cause a row to appear in the wrong network's result set

- **WHEN** two different networks each have a block at the same height with (contrived for the
  test) colliding identifying fields
- **THEN** the network-scope column/key SHALL be sufficient to disambiguate them in every stored
  row and every query, so neither network's query ever returns the other's row

### Requirement: AC-6 — partition/rollover correctness is verified with a real rollover event, not reasoned about only

WHEN data is ingested that spans a partition boundary of whatever range-partitioning scheme the
final schema uses (`design/full-chain-storage-design.md` §4.6's height-range partitioning is the
motivating example), THE SYSTEM SHALL continue to accept inserts and answer queries correctly
across that boundary, with no data loss and no query-correctness regression for rows on either
side of the boundary or for a range query that spans it.

#### Scenario: Ingesting across a partition boundary loses no data

- **WHEN** blocks/transactions are ingested spanning a configured partition boundary (heights
  immediately below and immediately above the boundary, plus a rollover event that creates or
  activates the next partition if the implementation requires an explicit rollover step)
- **THEN** every ingested row on both sides of the boundary SHALL be individually retrievable
  after the rollover
- **AND** none of the ingested rows SHALL be silently dropped, duplicated, or misrouted into the
  wrong partition

#### Scenario: A range query spanning the boundary returns the correct, complete result

- **WHEN** a query for a height range that spans the partition boundary is issued after the
  rollover
- **THEN** the result SHALL include every row in that range from both partitions, in the correct
  order, with none missing and none duplicated

### Requirement: AC-7 — the real ingestion/sync implementation lives outside `src/postgres/*`, enforced by an automated guard

THE SYSTEM'S full-chain-storage ingestion/sync implementation — the code that talks to the node
RPC and/or indexer GraphQL to populate the archive — SHALL live outside `src/postgres/*` (and
outside `src/interfaces/*`), mirroring the proven `TransactionHistoryStorage` adapter-seam pattern
(Sprint 8: `openspec/changes/sprint-8-wallet-envelope-live-sync/specs/wallet-state-envelope/
spec.md` "the adapter... lives outside `src/`"). This SHALL be proven by an automated guard test,
not merely a design intention, mirroring `test/postgres/no-sdk-import-guard.test.ts`'s whole-file
(not per-line) source-text check.

#### Scenario: No module under `src/` imports node-RPC or indexer-GraphQL client code at runtime

- **WHEN** the runtime imports/source text of every module under `src/` is inspected after the
  full-chain-storage implementation lands
- **THEN** none SHALL reference the node RPC client package/module or the indexer GraphQL client
  package/module used to perform ingestion
- **AND** this SHALL be checked by an automated test that scans whole-file source text (not just
  lines beginning with `import`, per the F4 fix already applied to
  `no-sdk-import-guard.test.ts`), so a re-export shape cannot slip through undetected

#### Scenario: The guard fails if ingestion code is added directly under `src/postgres/*`

- **WHEN** a hypothetical future change adds a direct node-RPC or indexer-GraphQL import inside
  `src/postgres/*`
- **THEN** the guard test SHALL fail, demonstrating it is a real, non-vacuous check (verified by
  temporarily introducing such an import during implementation review and confirming the guard
  catches it, then removing it)

### Requirement: AC-8 — live cross-validation against a real, from-source node/indexer/proof-server stack synced to a public testnet

WHEN the from-source, pinned-version node/indexer/proof-server stack (the parallel Midnight-stack
rebuild work) is operational and able to sync against a public testnet (Preview or Preprod), THE
SYSTEM'S full-chain archive SHALL be built by ingesting from that live stack — not merely the
local `undeployed` devnet `design/full-chain-storage-design.md` §3 confirms against — and
cross-validated block-by-block and transaction-by-transaction against values queried directly from
the live public network. This is the final proof the feature works, not merely that it runs
against a synthetic or local fixture; it is a named, standalone gate distinct from every other
requirement above, since none of AC-1 through AC-7 or AC-9/AC-10 exercises a real public network.

#### Scenario: Every archived block in a range matches the live network's own reported value for that block

- **WHEN** the archive has ingested a contiguous height range from the live from-source stack
  synced to Preview or Preprod
- **THEN** for every block in that range, the archive's stored `(height, block_hash, parent_hash,
  state_root, extrinsics_root)` SHALL match the value independently queried from the live network
  for that same height
- **AND** for every transaction in that range, the archive's stored `(tx_hash, block_height,
  raw bytes)` SHALL match the value independently queried from the live network for that same
  transaction

#### Scenario: A cross-validation mismatch is a hard failure, not a logged warning

- **WHEN** any archived block or transaction in the validated range disagrees with the live
  network's independently-queried value
- **THEN** the cross-validation run SHALL fail (non-zero exit / failing test), not merely log a
  discrepancy and continue, since a silent mismatch here would defeat the entire purpose of this
  gate

### Requirement: AC-9 — the feature introduces no regression to any existing passing test

WHEN the full-chain-storage implementation lands, THE SYSTEM SHALL continue to pass every
pre-existing test that passed before this feature was added — the wallet/checkpoint/watermark/
transaction-history migrations (`test/postgres/migrate.test.ts`'s existing 5-migration idempotency
baseline, `000_schema.ts` through `004_transaction_history.ts`), the SDK-import guard
(`test/postgres/no-sdk-import-guard.test.ts`), and every other test in the suite — with no test
modified to accommodate a regression rather than a genuine, reviewed behavior change.

#### Scenario: The full existing test suite remains green after the feature lands

- **WHEN** `npm test` is run against the branch carrying the full-chain-storage implementation
- **THEN** every test that passed on `main` before this feature SHALL still pass
- **AND** `test/postgres/migrate.test.ts`'s migration-count assertion SHALL be updated to reflect
  the new migration(s) added (a deliberate, reviewed count change), not silently broken or skipped

#### Scenario: The SDK-freedom guard still passes with the new modules included

- **WHEN** `test/postgres/no-sdk-import-guard.test.ts` runs after the feature lands
- **THEN** it SHALL still find zero `@midnightntwrk/*` (or equivalent SDK) references anywhere
  under `src/`, including in every new module the feature adds

### Requirement: AC-10 — core archive query patterns use an index, not a sequential scan, at realistic data volume

WHEN a realistic minimum data volume has been ingested into the archive, THE SYSTEM'S query plan
for each of the archive's core access patterns — get block by height, get transaction by hash, and
get the canonical chain within a height range — SHALL use an index scan (or an equivalent
non-sequential access path, e.g. an index-only scan or a partition-pruned scan), not a full
sequential scan of the underlying table(s), so the archive actually serves the query patterns it
exists for at a scale beyond a handful of test rows.

#### Scenario: EXPLAIN confirms an index scan for get-block-by-height

- **WHEN** `EXPLAIN` (or `EXPLAIN ANALYZE`) is run against the query that retrieves a block by a
  given height, after ingesting a realistic minimum volume of blocks (large enough that a
  sequential scan would be the planner's fallback if no usable index/partition-pruning existed)
- **THEN** the plan SHALL show an index scan, index-only scan, or partition-pruned scan targeting
  the height (or height+hash) key — SHALL NOT show a `Seq Scan` over the full table

#### Scenario: EXPLAIN confirms an index scan for get-transaction-by-hash

- **WHEN** `EXPLAIN` is run against the query that retrieves a transaction by its hash, at the
  same realistic data volume
- **THEN** the plan SHALL show an index scan on the transaction-hash key, not a sequential scan

#### Scenario: EXPLAIN confirms an index/partition-pruned scan for the canonical chain within a height range

- **WHEN** `EXPLAIN` is run against the query that retrieves the canonical chain within a bounded
  height range, at the same realistic data volume
- **THEN** the plan SHALL show an index scan and/or partition pruning limiting the scan to the
  requested range and to canonical rows — SHALL NOT show a full sequential scan across every
  partition/row in the table
