# connection-robustness (implementation)

Hardening of both connection layers UmbraDB depends on: (a) the DB connection layer
(`src/postgres/client.ts`) — generalized pooling, bounded retry/backoff on transient failures, a
generalized connection-health policy, and a liveness check; and (b) the wallet-sync connection — the
sync-integration/adapter tier's defense against trusting a single indexer's self-reported tip with no
finality reconciliation (`midnight-wallet#584`). Requirements below follow EARS (Easy Approach to
Requirements Syntax): each is one of Ubiquitous, Event-driven, Unwanted-behavior, State-driven, or
Optional-feature form — as in Sprint 2's, Sprint 4's, and Sprint 7's spec files.

A standing invariant carried from audit finding F2 (`client.ts:58-63`): every added option is opt-in,
and omitting it changes nothing versus `postgres.js`'s own defaults.

## ADDED Requirements

### Requirement: an omitted pooling option is never passed through as a driver key

WHERE a pooling option (`maxConnections`, `idleTimeout`, `maxLifetime`) is omitted from
`UmbraDBConnectionOptions`, `createClient` SHALL NOT pass that option's key to `postgres()` at all,
so the driver applies its own default — preserving the existing `max` fix's discipline against the
`postgres.js` `k in o` presence-check footgun (`client.ts:49-51`, `design/design.md` §3), which
silently forces a 1-connection pool when a key is present with an `undefined` value.

#### Scenario: Each pooling option, when omitted, is absent from the options object
- **WHEN** `createClient` is called without one of `maxConnections`/`idleTimeout`/`maxLifetime`
- **THEN** the corresponding `postgres.js` key (`max`/`idle_timeout`/`max_lifetime`) SHALL NOT be
  present in the options object passed to `postgres()`
- **AND** when the option IS supplied, that key SHALL be present with the supplied value

### Requirement: transient connection failures are retried with bounded backoff before surfacing

WHEN a retry-eligible operation fails with a transient connection failure (connection refused, reset,
or timeout), the client SHALL retry it with bounded exponential backoff and jitter before surfacing
`ConnectionError`, so a briefly-unavailable local Postgres does not fail an operation that would
succeed a moment later.

#### Scenario: A transient failure is retried and then succeeds
- **WHEN** a retry-eligible read fails once with a transient connection error and the next attempt
  would succeed
- **THEN** the client SHALL retry within the configured bound and resolve successfully

#### Scenario: A persistent transient failure gives up as ConnectionError after the bound
- **WHEN** a retry-eligible operation fails with a transient connection error on every attempt
- **THEN** the client SHALL stop after the configured attempt bound and reject with `ConnectionError`,
  not a raw driver error and not an unbounded retry loop

### Requirement: non-idempotent, in-transaction, and permanent-failure operations are never auto-retried

IF an operation is executing inside a caller-supplied `opts.tx`, or is a lease acquire
(`src/postgres/transaction-lease.ts`, non-idempotent by design), or its failure is a permanent one
(authentication, invalid schema, or a constraint violation), THEN the client SHALL NOT auto-retry it —
retrying inside a caller transaction breaks that transaction's atomicity, retrying a lease acquire
double-acquires, and retrying a permanent failure only delays the inevitable error. This is the
idempotency boundary the correctness gate must confirm (`design.md` §6.1).

#### Scenario: No retry inside a caller transaction
- **WHEN** an operation issued with a non-`undefined` `opts.tx` fails transiently
- **THEN** the client SHALL surface the error without auto-retrying, leaving retry/abort decisions to
  the caller who owns the transaction

#### Scenario: No retry for a lease acquire or a permanent failure
- **WHEN** a lease acquire fails, or any operation fails with a permanent error class (auth / invalid
  schema / constraint violation)
- **THEN** the client SHALL reject without auto-retrying

### Requirement: a liveness check resolves against a reachable DB and fails cleanly against an unreachable one

WHEN `checkLiveness()` is called, it SHALL issue a bounded `SELECT 1` and resolve when the database is
reachable, and reject with `ConnectionError` (via the existing `translatePostgresError` path,
`errors.ts`) — bounded, never a raw driver error and never an unbounded hang — when it is not, so an
orchestrator can probe readiness without issuing a real query.

#### Scenario: Liveness resolves against a live DB and rejects against a dead endpoint
- **WHEN** `checkLiveness()` runs against a reachable database
- **THEN** it SHALL resolve
- **WHEN** `checkLiveness()` runs against an unreachable endpoint
- **THEN** it SHALL reject with `ConnectionError` within the configured bound, not a raw driver error
  and not a hang

### Requirement: a wallet is judged synced only with agreement across independently-operated endpoints

WHILE the sync-integration/adapter tier judges a wallet "synced" before persisting a checkpoint, it
SHALL require agreement on the tip `(blockHash, height)` across at least two independently-operated
indexer endpoints — the Tier-0 k-of-n cross-check of `design/verifiable-snapshot-design.md:108` —
rather than trusting a single indexer's self-reported tip (`midnight-wallet#584`). This is the
availability/freshness precursor of the `verifiable-snapshot-recovery` feature's **C1** requirement
("offline recompute = on-chain root", `verifiable-snapshot-design.md:321`), which pairs the same
k≥2-endpoint cross-check with an offline root recompute; Sprint 9 delivers the cross-check layer C1
later sits on top of.

#### Scenario: Agreeing endpoints allow the wallet to be treated as synced
- **WHEN** at least two independently-operated indexer endpoints report the same tip
- **THEN** the tier MAY treat the wallet as synced and proceed to persist a checkpoint against that
  agreed tip

### Requirement: disagreeing endpoints block checkpoint persistence with a typed error

IF the configured indexer endpoints disagree on the tip, THEN the sync-integration tier SHALL raise a
typed error and SHALL NOT persist a checkpoint against the unverified tip — never silently accepting a
single endpoint's self-reported tip when another disagrees.

#### Scenario: A tip disagreement raises a typed error and persists nothing
- **WHEN** two configured endpoints report different tips for the same wallet
- **THEN** the tier SHALL raise a typed error
- **AND** SHALL NOT persist a checkpoint against either unverified tip

### Requirement: the synced tip is verified against finality (or the decided per-address equivalent) before persistence

WHERE a finalized-head source is available (Substrate GRANDPA `chain_getFinalizedHead`,
`verifiable-snapshot-design.md:275`), the sync-integration tier SHALL verify the synced tip against
finality before persisting a checkpoint — or, per the correctness gate's resolution of `design.md`
§6.2 for the proven unshielded per-address-cursor model (which follows a transaction-id cursor, not a
block scan, `AUTONOMOUS_RUN_LOG.md:245-252`), SHALL apply the decided per-address cross-check
equivalent. Either way it SHALL NOT persist a checkpoint anchored to an unverified or above-finality
tip. This binds to C1's finalized-block anchor (`verifiable-snapshot-design.md:321`).

#### Scenario: A tip above finalized head is not persisted
- **WHEN** a finalized-head source is available and the synced tip is above the finalized head
- **THEN** the tier SHALL NOT persist a checkpoint against that tip
- **AND** where the unshielded per-address model applies instead, the tier SHALL apply the gate-decided
  per-address cross-check before persisting

### Requirement: an endpoint drop triggers failover with bounded backoff

WHEN a configured indexer endpoint drops, times out, or errors, the sync-integration tier SHALL fail
over to another configured endpoint with bounded backoff (the same backoff discipline as the DB
layer's retry), rather than wedging on the failed endpoint or accepting an unverified single-endpoint
result.

#### Scenario: A dropped endpoint fails over to another with backoff
- **WHEN** one configured endpoint drops mid-check
- **THEN** the tier SHALL fail over to another configured endpoint with bounded backoff
- **AND** SHALL NOT mark the wallet synced on the strength of the dropped endpoint alone

### Requirement: no src/ module imports a wallet-SDK package to implement the sync-side defense

The sync-integration/adapter tier SHALL be the only place the sync-side defense (multi-endpoint
cross-check, finality/per-address check, failover) is implemented; no module under `src/` SHALL import
a `@midnightntwrk/*` (wallet-SDK) package at runtime to achieve it — preserving the standing invariant
that UmbraDB's core modules are SDK-free (Sprint 7 `design.md` §2; Sprint 8
`specs/wallet-state-envelope/spec.md` "the envelope module has no wallet-SDK runtime import").

#### Scenario: The core modules remain free of wallet-SDK runtime imports
- **WHEN** the runtime imports of every module under `src/` are inspected after this sprint
- **THEN** none SHALL resolve to a `@midnightntwrk/*` package
- **AND** the sync-side defense SHALL reside entirely in the adapter/integration tier
