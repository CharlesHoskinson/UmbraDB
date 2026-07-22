# wallet-state-envelope (implementation)

The WalletState envelope (`src/interfaces/wallet-state-envelope.ts` +
`src/postgres/wallet-state-envelope.ts`), the adapter seam between the Midnight wallet SDK's
`TransactionHistoryStorage` and UmbraDB's `PgTransactionHistoryStorage` (Sprint 7), and the
functional cold-boot recovery contract they jointly satisfy. Requirements below follow EARS (Easy
Approach to Requirements Syntax): each is one of Ubiquitous ("The system SHALL..."), Event-driven
("WHEN \<trigger>, the system SHALL..."), Unwanted-behavior ("IF \<trigger>, THEN the system
SHALL..."), State-driven ("WHILE \<state>, the system SHALL..."), or Optional-feature ("WHERE
\<feature>, the system SHALL...") form — as in Sprint 2's, Sprint 4's, and Sprint 7's spec files.

This capability is the *functional* DB-backed persistence + recovery layer only. The
trust-minimized `verifiable-snapshot-recovery` feature (anchor / finality / completeness /
seed-binding) is a separate capability that sits on top of this one via the `envelopeVersion` seam
(`design.md` §1.1, §6) and is out of scope here.

## ADDED Requirements

### Requirement: the envelope wraps the three sub-wallet strings and a version tag into one versioned object

The WalletState envelope SHALL wrap the three sub-wallets' independent `serializeState()` strings —
`shielded`, `unshielded`, `dust`, each carrying its own distinct SDK snapshot schema
(`shielded-wallet/src/v1/Serialization.ts:66-119`, `unshielded-wallet/src/v1/Serialization.ts:43-90`,
`dust-wallet/src/v1/Serialization.ts:62-114`) — together with an `envelopeVersion` schema-version
tag into ONE JSON object, treating each sub-wallet string as an opaque, never-parsed value. This is
option (a) (one versioned envelope) of `design.md` §1, chosen over (b) three coordinated
checkpoints.

#### Scenario: All three sub-wallet strings plus the version tag round-trip through the envelope

- **WHEN** an envelope is built from three arbitrary opaque sub-wallet strings and the current
  `envelopeVersion`, encoded, and then decoded
- **THEN** the decoded envelope SHALL carry the same `envelopeVersion` and the three sub-wallet
  strings SHALL be identical, byte for byte, to the inputs
- **AND** the envelope SHALL NOT have parsed or altered any sub-wallet string's internal content

### Requirement: encode and decode are lossless inverses

`encode(envelope)` SHALL produce a `Uint8Array` and `decode(bytes)` SHALL reconstruct an equivalent
envelope, such that `decode(encode(x))` is equivalent to `x` for every valid envelope `x`, including
ones in which one or two sub-wallet slots are absent.

#### Scenario: A round-trip over arbitrary envelopes preserves every field

- **WHEN** `decode(encode(x))` is evaluated over arbitrary valid envelopes `x` (varying
  `walletId`, `networkId`, `envelopeVersion`, and any subset of the three sub-wallet strings
  present)
- **THEN** the result SHALL equal `x` in every field
- **AND** SHALL NOT reject for any valid `x`

### Requirement: the envelope is persisted with a single CheckpointStore.save call per (walletId, networkId)

WHEN `PgWalletStateEnvelopeStore.save(walletId, networkId, envelope)` is called, the system SHALL
encode the envelope and persist it via exactly ONE `CheckpointStore.save(walletId, networkId,
bytes)` call (`src/interfaces/checkpoint-store.ts:142`), so the three sub-wallet strings are stored
as one atomic unit — either all durable together or none (no torn write across sub-wallets).

#### Scenario: One save call persists the whole bundle atomically

- **WHEN** `save` is called with an envelope carrying all three sub-wallet strings
- **THEN** the system SHALL issue exactly one `CheckpointStore.save` for `(walletId, networkId)`
- **AND** a subsequent `load` SHALL return either the complete three-string envelope or, if the
  save did not commit, nothing partially written — never a subset of the three strings

### Requirement: load returns the persisted envelope, by latest or explicit sequence

WHEN `PgWalletStateEnvelopeStore.load(walletId, networkId, sequence?)` is called after a successful
`save`, the system SHALL return an envelope equivalent to the one saved — the latest when `sequence`
is omitted, or the envelope at that exact `sequence` when supplied (mirroring
`CheckpointStore.load`'s `sequence?` contract, `src/interfaces/checkpoint-store.ts:154-157`).

#### Scenario: save then load returns the same envelope

- **WHEN** an envelope is saved for `(walletId, networkId)` and then `load(walletId, networkId)` is
  called with no sequence
- **THEN** the returned envelope SHALL be equivalent to the one saved (same version, same three
  sub-wallet strings)

### Requirement: an unrecognized envelopeVersion is rejected, never best-effort restored

IF `decode` (or `load`) encounters an envelope whose `envelopeVersion` is not a version this
implementation recognizes, THEN the system SHALL reject with a typed envelope error and SHALL NOT
attempt a best-effort restore of an unknown shape. This is the forward seam for the future
`verifiable-snapshot-recovery` layer, which adds fields under a bumped version (`design.md` §1.1).

#### Scenario: A future-versioned envelope is rejected cleanly

- **WHEN** `decode` is given a well-formed JSON envelope tagged with an `envelopeVersion` greater
  than the current known version
- **THEN** the call SHALL reject with the typed envelope-version error
- **AND** SHALL NOT return a partially-populated or guessed envelope

### Requirement: a corrupt or non-JSON envelope payload is rejected with a typed error

IF `decode` is given bytes that are not valid JSON, or valid JSON that does not satisfy the envelope
schema (missing `envelopeVersion`, a non-string sub-wallet slot, etc.), THEN the system SHALL reject
with a typed envelope error, not surface a raw `SyntaxError`/parse error and not return a malformed
envelope.

#### Scenario: Non-JSON bytes are rejected as a typed envelope error

- **WHEN** `decode` is given a byte payload that is not valid JSON
- **THEN** the call SHALL reject with the typed envelope error
- **AND** SHALL NOT surface a raw `SyntaxError` to the caller

#### Scenario: Structurally invalid JSON is rejected as a typed envelope error

- **WHEN** `decode` is given valid JSON that lacks `envelopeVersion` or carries a non-string
  sub-wallet slot
- **THEN** the call SHALL reject with the typed envelope error, not return a malformed envelope

### Requirement: loading a never-saved wallet surfaces a typed not-found, not a silent empty result

IF `load(walletId, networkId)` is called for a `(walletId, networkId)` that has never been saved,
THEN the system SHALL reject with `CheckpointNotFoundError` (surfaced from `CheckpointStore.load`,
`src/interfaces/checkpoint-store.ts:148`), not resolve an empty or default envelope — a missing
snapshot is a distinct, observable condition, not an implicitly-empty wallet.

#### Scenario: load before any save rejects with CheckpointNotFoundError

- **WHEN** `load` is called for a `(walletId, networkId)` pair with no prior `save`
- **THEN** the call SHALL reject with `CheckpointNotFoundError`
- **AND** SHALL NOT resolve a default/empty envelope

### Requirement: a sub-wallet absent from the envelope is skipped on restore

WHERE a sub-wallet slot (`shielded`, `unshielded`, or `dust`) is absent/`null` in a saved envelope —
because that sub-wallet was not exercised, as in the preprod unshielded-only live tier
(`design/environment/preprod-connection.md` "Sync cost"; `design.md` §1.1) — the restore path SHALL
skip that sub-wallet, restoring only the sub-wallets whose strings are present, and SHALL NOT fail
for the absent one.

#### Scenario: An unshielded-only envelope restores the unshielded sub-wallet and skips the others

- **WHEN** an envelope with `unshielded` populated and `shielded`/`dust` absent/`null` is loaded and
  restored
- **THEN** the unshielded sub-wallet SHALL be restored from its string
- **AND** the restore SHALL NOT reject or attempt to restore a shielded or dust sub-wallet

### Requirement: the envelope module has no wallet-SDK runtime import

`src/interfaces/wallet-state-envelope.ts` and `src/postgres/wallet-state-envelope.ts` SHALL NOT
import any `@midnightntwrk/*` (wallet-SDK) package at runtime — the sub-wallet strings are handled
as opaque `string` values, exactly as `CheckpointStore` treats its payload as opaque bytes. The
adapter (below) is the only Sprint 8 component that references SDK types, and it lives outside
`src/`.

#### Scenario: The envelope modules' runtime imports resolve to no wallet-SDK package

- **WHEN** the runtime imports of the two envelope modules are inspected
- **THEN** none SHALL resolve to a `@midnightntwrk/*` package

### Requirement: the adapter backs the SDK txHistoryStorage slot with Postgres via PgTransactionHistoryStorage

The adapter SHALL implement the SDK's `TransactionHistoryStorage` surface
(`TransactionHistoryStorage.ts:163-216`) and forward every call to a `PgTransactionHistoryStorage`
instance (Sprint 7) constructed with a caller-supplied merge function — so that the SDK's
`configuration.txHistoryStorage` slot is backed by Postgres, replacing
`InMemoryTransactionHistoryStorage` (`preprodUnshieldedSync.manual.integration.test.ts:94`). No
module under `src/` SHALL import a wallet-SDK package at runtime; the adapter is the seam.

#### Scenario: A got* call through the adapter persists to Postgres and reads back via getAll

- **WHEN** the adapter is installed as `config.txHistoryStorage` and a `gotFinalized` call is made
  through it
- **THEN** the entry SHALL be persisted by the underlying `PgTransactionHistoryStorage` and SHALL
  be returned by a subsequent `getAll()` through the adapter
- **AND** no module under `src/` SHALL have imported a `@midnightntwrk/*` package at runtime to
  achieve this

### Requirement: the adapter round-trips SDK lifecycle detail so getAll yields schema-valid SDK entries

The SDK lifecycle carries per-status detail — `submittedAt` (pending), `finalizedBlock{hash,
height, timestamp}` (finalized), and `rejectedAt`+`reason` (rejected)
(`TransactionHistoryStorage.ts:23-63,135-157`) — whereas UmbraDB's Sprint-7 entry models
`lifecycle` as a bare `{status}` union (`src/interfaces/transaction-history-storage.ts:166-178`). IF
the adapter persisted only `status`, THEN a reconstructed entry could not decode against the SDK's
own schema. The adapter SHALL therefore preserve the per-status lifecycle detail (persisted under a
`sections` key that does NOT start with the reserved `THS_RESERVED_KEY_PREFIX`,
`src/interfaces/transaction-history-storage.ts:57`) and reconstruct a schema-valid SDK lifecycle on
`getAll()` (`design.md` §3.2 decision (i)).

#### Scenario: A finalized entry read back through the adapter carries its finalizedBlock detail

- **WHEN** `gotFinalized` is called through the adapter with a `finalizedBlock` of a given `hash`,
  `height`, and `timestamp`, and the entry is later read back via `getAll()`
- **THEN** the returned entry's `lifecycle` SHALL be a schema-valid SDK finalized lifecycle carrying
  the same `finalizedBlock.hash`, `finalizedBlock.height`, and `finalizedBlock.timestamp`
- **AND** the returned entry SHALL decode against the SDK's `TransactionHistoryEntryCommonSchema`
  (`TransactionHistoryStorage.ts:75-85`) without error

### Requirement: getAll returns live bigint/Date-typed common fields through the adapter

`getAll()` through the adapter SHALL return entries whose `fees` is a real `bigint | null` and whose
`timestamp` is a real `Date` — not strings coerced through a JSON round-trip — inheriting Sprint 7's
"getAll returns live bigint/Date" requirement end-to-end through the adapter and Postgres.

#### Scenario: fees and timestamp survive the adapter+Postgres round-trip as native types

- **WHEN** an entry with a `bigint` `fees` and a `Date` `timestamp` is written through the adapter
  and read back via `getAll()`
- **THEN** `typeof entry.fees` SHALL be `"bigint"` and `entry.timestamp` SHALL be `instanceof Date`
- **AND** neither SHALL be a string

### Requirement: a live-synced transaction materializes as a Postgres row observable via getAll

WHEN the funded preprod wallet is synced against public preprod with the adapter injected as
`config.txHistoryStorage` (`design.md` §4; proven wiring
`preprodUnshieldedSync.manual.integration.test.ts`), the on-chain 1000 tNIGHT transaction SHALL
materialize as a UmbraDB Postgres row readable via `getAll()`. This is the required "verify the DB
syncs" proof and belongs to the nightly/labeled tier, never the required merge gate.

#### Scenario: The 1000 tNIGHT faucet transaction appears as a UmbraDB row after a real preprod sync

- **WHEN** the wallet syncs to a settled state showing `balances[nativeToken] === 1_000_000_000n`
  (1000 tNIGHT, `preprodUnshieldedSync.manual.integration.test.ts:144`)
- **THEN** `getAll()` through the adapter SHALL contain a row for transaction hash `b194e71d…493341`
  carrying the faucet identifier `00ea17cf…20bea` (`AUTONOMOUS_RUN_LOG.md:230-231`)

### Requirement: tx-history on restore is authoritative from the Pg store, not the restored blob

WHILE restoring a wallet from an envelope, the system SHALL treat
`PgTransactionHistoryStorage.getAll()` as the authoritative source of transaction history — NOT the
tx-history copy embedded inside any sub-wallet's own restored snapshot. A restored sub-wallet's
internal history is superseded by whatever `getAll()` returns (recommendation §1 "Why this isn't
redundant"; Sprint 7 `design.md` §5).

#### Scenario: After restore, tx-history reflects the Pg store even where the blob's embedded copy differs

- **WHEN** a wallet is restored from an envelope and its tx-history is queried
- **THEN** the authoritative tx-history SHALL be the set returned by `PgTransactionHistoryStorage.getAll()`
- **AND** SHALL NOT be taken from the restored sub-wallet blob's own embedded tx-history copy where
  the two differ

### Requirement: each sub-wallet resumes from its own last-known point; the envelope bundles for atomicity only

WHILE restoring from an envelope that bundles multiple sub-wallet snapshots, the system SHALL resume
each sub-wallet's sync from that sub-wallet's own last-known point (its own snapshot's progress
cursor), and SHALL NOT assume the three bundled snapshots are mutually consistent as of the same
block height. The envelope's guarantee is atomic bundling (persist/restore as a unit), NOT
same-height consistency across sub-wallets — the accepted weaker contract of `design.md` §5
(recommendation §3 open question 5; Sprint 7 `design.md` §6.2 default (a)).

#### Scenario: A bundled restore resumes each present sub-wallet from its own cursor

- **WHEN** an envelope bundling more than one sub-wallet snapshot is restored
- **THEN** each present sub-wallet SHALL resume from its own snapshot's progress cursor
- **AND** the system SHALL NOT require, nor assert, that the bundled snapshots share one block height

### Requirement: a cold boot resumes without a full resync and preserves tx-history continuity

WHEN a wallet is destroyed after a sync and later reconstructed in a fresh process by loading its
envelope, restoring each present sub-wallet, and reading tx-history from
`PgTransactionHistoryStorage.getAll()` (`design.md` §5), the system SHALL resume WITHOUT a full
resync from genesis and SHALL preserve tx-history continuity across the restart.

#### Scenario: The restored wallet resumes from its snapshot cursor and still sees the prior transaction

- **WHEN** a synced wallet is serialized into an envelope, saved via `PgWalletStateEnvelopeStore`,
  destroyed along with its process, and then reconstructed in a fresh process from the loaded
  envelope
- **THEN** the restored sub-wallet SHALL resume from its snapshot's progress cursor rather than
  rescanning from genesis
- **AND** `getAll()` SHALL still return the transaction row observed before the restart (tx-history
  continuity), with no full resync required to see it
