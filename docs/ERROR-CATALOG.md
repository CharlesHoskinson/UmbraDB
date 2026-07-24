# UmbraDB Frozen Error-Code Catalog

Every typed error UmbraDB throws is a subclass of `StorageError` and carries two machine-facing
fields that are part of the frozen 1.0.0 public API:

- **`code`** — a stable `string` discriminant (`abstract readonly code`), narrowable without
  `instanceof` and stable across serialization.
- **`retryable`** — a machine-readable `Retryability` value (`"retryable" | "non-retryable" |
  "conditional"`), so a caller decides whether to retry **without parsing a message string**.

This table is the frozen `{code → meaning → retryable}` catalog. It is governed by the
[stability policy](STABILITY.md): within the `1.x` line, no `code` is removed, renamed, or
repurposed, and no `retryable` marking is weakened; new codes may be added additively in a minor.

`Rollback` is **not** in this catalog: it is a control primitive (an `Error` subclass, not a
`StorageError`) that a caller throws to request a deliberate `withTransaction` rollback, and it
deliberately carries no `code`.

## The catalog

| Code | Class | Meaning | Retryable |
|---|---|---|---|
| `VALIDATION_FAILED` | `ValidationError` | Input failed its Zod boundary schema; rejected before any backend work. | non-retryable |
| `SERIALIZATION_FAILED` | `SerializationFailedError` | A value failed to round-trip through the backend encoding (JSONB/bytea). | non-retryable |
| `CONNECTION_ERROR` | `ConnectionError` | Driver-level connection failure (a network code or a Postgres class-08 / auth / shutdown SQLSTATE). | retryable |
| `VERSION_CONFLICT` | `VersionConflictError` | Optimistic-concurrency check failed: the key's current version did not match the expected version. | non-retryable |
| `HISTORY_UNAVAILABLE` | `HistoryUnavailableError` | A point-in-time read addressed a version or time that has been pruned below the retained history horizon. | non-retryable |
| `TRANSACTION_KEY_REUSE` | `TransactionKeyReuseError` | The same transaction wrote the same key twice (the same-transaction key-reuse guard fired). | non-retryable |
| `NOT_FOUND` | `CheckpointNotFoundError` | No checkpoint exists for the requested wallet/network or sequence. | non-retryable |
| `CHUNK_MISSING` | `ChunkMissingError` | A manifest references a chunk that is absent from the chunk store. | non-retryable |
| `CHUNK_INTEGRITY` | `ChunkIntegrityError` | A loaded chunk's content hash did not match its content-address. | non-retryable |
| `MANIFEST_CORRUPT` | `ManifestCorruptError` | A manifest failed its load-time structural / hash re-verification. | non-retryable |
| `TRANSACTION_ROLLED_BACK` | `TransactionRolledBackError` | The transaction was deliberately rolled back (e.g. a `Rollback` thrown in the callback). | non-retryable |
| `TRANSACTION_FAULT` | `TransactionFaultError` | A transient transaction fault: a serialization failure (40001), a deadlock (40P01), or a mid-transaction connection loss. | retryable |
| `LEASE_TIMEOUT` | `LeaseTimeoutError` | Acquiring the writer advisory lock timed out while another holder was active. | retryable |
| `LEASE_NOT_HELD` | `LeaseNotHeldError` | A lease operation was attempted without holding the lease. | non-retryable |
| `LEASE_FAULT` | `LeaseFaultError` | A lease operation failed on an infrastructure fault (e.g. a connection loss during release). | non-retryable |
| `TRANSACTION_HANDLE_INVALID` | `TransactionHandleInvalidError` | A transaction handle passed via `opts.tx` is unknown, stale, or already settled. | non-retryable |
| `VERSION_UNSUPPORTED` | `EnvelopeVersionUnsupportedError` | The wallet-state envelope's version is newer than / unknown to this decoder. | non-retryable |
| `CORRUPT` | `EnvelopeCorruptError` | The wallet-state envelope failed to decode (malformed or corrupt bytes). | non-retryable |
| `EXCLUSION_VIOLATION` | `ExclusionViolationError` | A Postgres exclusion constraint fired (23P01), or a key-reuse conflict arrived with no key context. | non-retryable |
| `CLOCK_REGRESSION` | `ClockRegressionError` | A 23514 check on the temporal-kv history range fired, from one of two causes with different retry characteristics (see below). | conditional |
| `UNRECOGNIZED_POSTGRES_ERROR` | `UnrecognizedPostgresError` | A real driver/database error with a SQLSTATE this adapter does not specifically translate (so no raw driver error escapes). | non-retryable |
| `MIGRATION_LOCK_TIMEOUT` | `MigrationLockTimeoutError` | `runMigrations` timed out acquiring the class-1 migration advisory lock (another instance holds it). | non-retryable |
| `DURABILITY_CONTRACT_VIOLATION` | `DurabilityContractError` | The startup durability probe rejected the server configuration (e.g. `fsync` or `full_page_writes` off). | non-retryable |
| `TRANSACTION_POOLER_DETECTED` | `TransactionPoolerDetectedError` | The startup probe detected a transaction-pooling proxy (session advisory locks are unsupported there). | non-retryable |

## The count is enforced, not asserted

The catalog above is exactly the set of `code` values on the concrete `StorageError` subclasses
re-exported from the package-root barrel. It is currently **24 codes**, but that number is not
hard-coded anywhere as an authority: `test/api-surface/error-catalog-drift.test.ts` cross-checks
**this table against the actually-exported error classes** (table ≡ surface) — it instantiates
every exported concrete `StorageError` subclass, collects its `.code`, and asserts the doc's code
set equals the surface's code set and the doc's class set equals the exported class set, with the
count derived from the surface. If a future minor adds an error class to the barrel, the drift test
fails until this table is updated to match — the table can never silently drift from the surface,
and the count self-corrects.

## The retryable set

Exactly three codes are **retryable** — a transient infrastructure fault an immediate in-process
retry can clear:

- `CONNECTION_ERROR`
- `TRANSACTION_FAULT`
- `LEASE_TIMEOUT`

`CLOCK_REGRESSION` is **conditional**; every other code is **non-retryable**.

### `CLOCK_REGRESSION` is conditional, not uniformly non-retryable

`ClockRegressionError` (`src/postgres/errors.ts`) arises from a SQLSTATE `23514` check on the
temporal-kv history range, from **two distinct causes with different retry characteristics** — a
distinction a fourth-round cross-vendor re-audit added, having found the prior blanket
"non-retryable" wording wrong for one of them:

- **A backward wall-clock STEP** (an NTP correction, not drift) between two writes to the same key —
  **not** caller-fixable by retrying, since the caller cannot know when the clock will move forward
  again.
- **A same-millisecond precision collision** — two writes to the same key, in different
  transactions, whose `clock_timestamp()`-derived, millisecond-truncated instants land in the same
  millisecond — **is** caller-fixable: retrying after the millisecond boundary passes succeeds,
  because the collision is a precision artifact, not a real ordering conflict.

The `retryable` value is therefore `"conditional"`; a caller MUST NOT treat `CLOCK_REGRESSION` as
uniformly non-retryable.

## Reconciliation rationale (why 24, not the design's earlier 21)

`design.md` §3.1 enumerated **21** codes. That grep (`grep -rhoE 'readonly code = "[A-Z_]+"' src/ |
grep -vE 'CHAIN|BLOB|BLOCK'`) was taken **before** the G6 (durability probe) and G7 (migration-lock
hardening) work merged, and the design's own framing says the drift test — not the literal number —
is the authority on the count. Three already-shipped codes join the frozen catalog, bringing it to
24:

- `MIGRATION_LOCK_TIMEOUT` (`MigrationLockTimeoutError`, G7),
- `DURABILITY_CONTRACT_VIOLATION` (`DurabilityContractError`, G6),
- `TRANSACTION_POOLER_DETECTED` (`TransactionPoolerDetectedError`, G6).

**Why they belong in the frozen surface.** All three are thrown from `runMigrations` — a consumer
that calls `runMigrations` (every consumer does, at startup) can already `catch` them today. They
are therefore **already-shipped public error surface**, and their classes are re-exported from the
barrel. Freezing the catalog without them would understate the surface a consumer actually observes.

**Why `MIGRATION_LOCK_TIMEOUT` is non-retryable even though it resembles `LEASE_TIMEOUT`.** Both are
advisory-lock waits that time out, and `LEASE_TIMEOUT` **is** retryable — so the natural question is
why `MIGRATION_LOCK_TIMEOUT` is not. The answer is the operational context, not the mechanism:
`LEASE_TIMEOUT` is an **in-operation** contention signal (another writer holds the lease right now;
retrying the lease acquire shortly is the correct recovery). `MIGRATION_LOCK_TIMEOUT` is a
**startup/migration-time** fault — another instance is running migrations under the class-1
migration lock. The correct recovery is for the orchestrator to back off and restart the process
(or wait for the other instance to finish migrating and start clean), **not** an in-process retry
loop hammering the migration lock. The frozen retryable set was fixed as exactly
`{CONNECTION_ERROR, TRANSACTION_FAULT, LEASE_TIMEOUT}` for this reason; `MIGRATION_LOCK_TIMEOUT` is
non-retryable.

## Excluded: the deferred chain-archive codes

Full-chain archival is deferred to 1.1, so its error codes are **not** part of the frozen 1.0.0
catalog and its classes are **not** re-exported from the barrel:
`CHAIN_ARCHIVE_INVARIANT_VIOLATION`, `CHAIN_ARCHIVE_CHECK_VIOLATION`, `BLOB_INTEGRITY`,
`BLOB_MISSING`, `BLOCK_NOT_FOUND`. `translatePostgresError`'s internal `23514` constraint-name
routing still resolves these classes correctly for the day archival merges (they are marked
`@experimental`/`@internal`), but they are not a 1.0 public promise. See the
[full-chain-storage 1.1 preview](../README.md#full-chain-storage-11-preview-outside-the-frozen-10-surface).
