# transaction-history-storage (implementation)

The Postgres-backed implementation of the Midnight wallet SDK's `TransactionHistoryStorage`
interface (`packages/abstractions/src/TransactionHistoryStorage.ts` in `midnight-wallet`).
Requirements below follow EARS (Easy Approach to Requirements Syntax), as in Sprint 2's and
Sprint 4's spec files.

## ADDED Requirements

### Requirement: one storage instance is bound to exactly one wallet at construction

`PgTransactionHistoryStorage` SHALL bind its `walletId` at construction time. None of its six
methods SHALL accept a wallet identifier as an argument.

#### Scenario: Two instances constructed for different wallets never see each other's rows
- **WHEN** two `PgTransactionHistoryStorage` instances are constructed with different `walletId`
  values against the same Postgres database
- **THEN** a `gotFinalized` call on one instance SHALL NOT be visible via `getAll()`/`get()` on
  the other instance

### Requirement: the merge function is caller-supplied and never a wallet-SDK runtime import

`PgTransactionHistoryStorage` SHALL accept its entry-merge function as a constructor argument and
SHALL NOT import any `@midnightntwrk/wallet-sdk` package at runtime.

#### Scenario: The module has no runtime dependency on wallet-SDK packages
- **WHEN** `src/postgres/transaction-history-storage.ts`'s runtime imports are inspected
- **THEN** none SHALL resolve to a `@midnightntwrk/*` package
- **AND** the merge function used in production SHALL be supplied by the caller at construction,
  not hardcoded

### Requirement: concurrent writers merging the same tx hash never lose a section

WHEN two calls (`gotPending`/`gotFinalized`/`gotRejected`, in any combination) targeting the same
`(walletId, txHash)` are issued concurrently by different callers, the system SHALL serialize
their read-merge-write cycles such that the final stored entry reflects both callers' sections,
with neither silently overwritten.

#### Scenario: A shielded-only and a dust-only concurrent write on the same hash both survive
- **WHEN** `gotFinalized` is called concurrently by two callers on the same `(walletId, txHash)`
  — one supplying an entry with only a populated `shielded` section, the other supplying an entry
  with only a populated `dust` section, both racing to merge into the same row
- **THEN** the row SHALL, after both calls complete, contain both the `shielded` and `dust`
  sections — neither call's section SHALL be lost
- **AND** this SHALL hold even though a bare atomic upsert of each caller's independently
  computed merge result would not guarantee it (the row lock described in `design.md` §3 is what
  guarantees it)

#### Scenario: A bare upsert without a row lock is insufficient (negative control, implementation note)
- **GIVEN** a hypothetical implementation that computes the merge in application code and issues
  an unconditional `INSERT ... ON CONFLICT DO UPDATE` without first taking `SELECT ... FOR
  UPDATE` on the target row
- **WHEN** two such merges race on the same `(walletId, txHash)`
- **THEN** that hypothetical implementation CAN lose one caller's section (a second writer's read
  can occur between the first writer's read and write) — this is the failure mode
  `PgTransactionHistoryStorage`'s actual row-lock design (§3) exists to prevent, and the positive
  scenario above is what verifies the real implementation does not exhibit it

### Requirement: merge semantics are equivalent to mergeWalletEntries, not last-write-wins

The system SHALL merge an incoming entry with any existing entry for the same `(walletId,
txHash)` such that: shared scalar facts are first-writer-wins, `identifiers` are unioned, each
wallet section (`shielded`/`unshielded`/`dust`) is merged independently via its own
section-specific rule, and `lifecycle` is incoming-wins.

#### Scenario: A shared scalar fact set by the first writer is not overwritten by a later merge
- **WHEN** an entry is first written with a shared scalar fact (e.g. a block timestamp) set, and
  a later merge for the same hash supplies a different value for that same fact
- **THEN** the stored value SHALL remain the first-written value, not the later one

#### Scenario: Identifiers accumulate via union across merges
- **WHEN** an entry is written with identifier set `{a, b}`, and a later merge for the same hash
  supplies identifier set `{b, c}`
- **THEN** the stored `identifiers` SHALL be `{a, b, c}` after the merge

#### Scenario: Lifecycle always reflects the most recent write
- **WHEN** an entry is written as `pending`, and a later merge for the same hash supplies
  `finalized`
- **THEN** the stored `lifecycle` SHALL be `finalized`, regardless of write order otherwise

### Requirement: identifier-subset pending-clear rule survives repeated merges

WHEN a pending entry's identifier set is a subset of a finalized (or rejected) entry's identifier
set for the same tx hash, the system SHALL clear the pending entry — and this subset check SHALL
be re-evaluated correctly after the identifier set has grown through one or more prior merges
(§ identifiers-union requirement above), not only on a single, first merge.

#### Scenario: A pending entry clears against a finalized entry whose identifiers grew via two prior merges
- **WHEN** a pending entry with identifiers `{a}` exists, and the finalized counterpart for the
  same hash is built up via two separate merges reaching identifiers `{a, b, c}`
- **THEN** the pending entry SHALL be cleared, because `{a}` is a subset of `{a, b, c}`

#### Scenario: A pending entry does not clear when its identifiers are not a subset
- **WHEN** a pending entry has identifiers `{a, d}`, and the finalized counterpart for the same
  hash has identifiers `{a, b, c}`
- **THEN** the pending entry SHALL NOT be cleared (`{a, d}` is not a subset of `{a, b, c}`)

### Requirement: getAll returns live bigint/Date-typed values, not JSON-stringified primitives

`PgTransactionHistoryStorage.getAll()` SHALL return entries whose numeric and date-shaped fields
are real `bigint`/`Date` JavaScript values, not strings coerced through a JSON round-trip.

#### Scenario: A bigint field survives the Postgres round-trip as a real bigint
- **WHEN** an entry containing a `bigint`-typed field is written via `gotFinalized` and then read
  back via `getAll()`
- **THEN** `typeof` the corresponding field on the returned entry SHALL be `"bigint"`, not
  `"string"` or `"number"`

#### Scenario: A Date field survives the Postgres round-trip as a real Date instance
- **WHEN** an entry containing a `Date`-typed field is written and read back via `getAll()`
- **THEN** the corresponding field on the returned entry SHALL be `instanceof Date`, not a date
  string

### Requirement: serialize() is a full synchronous-equivalent dump matching the fixed interface contract

`PgTransactionHistoryStorage.serialize()` SHALL resolve `Promise<string>` — a full dump of all
stored entries — matching the wallet SDK's fixed interface contract
(`TransactionHistoryStorage.ts:163-166`). No streaming or export-only variant SHALL be offered.

#### Scenario: serialize() output round-trips through restore-equivalent parsing
- **WHEN** `serialize()` is called after several entries have been written
- **THEN** the resolved string SHALL, when parsed, reconstruct data equivalent to what
  `getAll()` returns at that same point

### Requirement: driver-level failures surface as the shared StorageError hierarchy

All six methods SHALL translate driver-level failures into `src/interfaces/storage-errors.ts`'s
`StorageError` subclasses before they reach the caller.

#### Scenario: A connection failure during any method surfaces as ConnectionError
- **WHEN** any of the six methods is called and the underlying Postgres connection cannot be
  established
- **THEN** the call SHALL reject with `ConnectionError`, not a raw driver-level error

### Requirement: the Pg-backed and in-memory reference are sequentially equivalent for single-writer traces

WHEN driven by an identical scripted sequence of `gotPending`/`gotFinalized`/`gotRejected` calls
with no concurrent writers, `PgTransactionHistoryStorage` and `InMemoryTransactionHistoryStorage`
SHALL produce identical `getAll()` output.

#### Scenario: An identical sequential fixture produces identical getAll() output on both backends
- **WHEN** the same fixture sequence of lifecycle calls is replayed once against
  `InMemoryTransactionHistoryStorage` and once against a fresh `PgTransactionHistoryStorage`
- **THEN** both backends' `getAll()` SHALL return equivalent entries (same hashes, same merged
  content, same lifecycle state) — noting this equivalence claim is scoped to sequential,
  single-writer traces only; it is not a valid oracle for the concurrent-write scenario above,
  which the in-memory reference cannot itself exhibit
