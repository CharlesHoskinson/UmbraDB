# storage-client-hygiene (implementation)

Consolidation of the non-blocking cleanup and tech-debt items the prior sprints deferred: direct
regression coverage for Sprint 7's merge-read paths, the Sprint 8 adapter L-findings (status-enum
mapping, the test-tier dependency pin manifest, multi-sub-wallet envelope coverage), working-tree
hygiene for stray research artifacts, and a behavior-preserving shared-helper consolidation.
Requirements below follow EARS (Easy Approach to Requirements Syntax): each is one of Ubiquitous
("The system SHALL..."), Event-driven ("WHEN \<trigger>, the system SHALL..."), Unwanted-behavior
("IF \<trigger>, THEN the system SHALL..."), State-driven ("WHILE \<state>, the system SHALL..."),
or Optional-feature ("WHERE \<feature>, the system SHALL...") form — as in Sprint 2's, Sprint 4's,
and Sprint 7's spec files. Several requirements are regression guards in the sense Sprint 4 already
used (`sprint-4-watermarks/specs/watermarks/spec.md`'s "T is a caller assertion" requirement): they
pin an existing behavior so a later change that breaks it is caught.

## ADDED Requirements

### Requirement: a zero-identifier finalize never clears an unrelated pending entry, and a direct test pins it

IF a `gotFinalized`/`gotRejected` entry's identifier set is empty, THEN
`PgTransactionHistoryStorage`'s pending-clear SHALL NOT clear any pending entry — the empty-set
vacuous-subset guard (`src/postgres/transaction-history-storage.ts:498-507`) — and this behavior
SHALL be pinned by a direct regression test that fails if that guard is removed, not only exercised
transitively through the property suite (Codex LOW finding, `AUTONOMOUS_RUN_LOG.md:288`).

#### Scenario: A finalize with no identifiers leaves unrelated pending entries intact
- **WHEN** a pending entry exists for one tx hash, and a *different* tx hash is finalized with an
  empty identifier set
- **THEN** the pending entry SHALL remain present and unchanged after the finalize
- **AND** a test SHALL assert this directly, such that removing the `identifiers.length > 0` /
  `array_length(identifiers, 1) > 0` guard makes that test fail

### Requirement: the concurrent-first-write lock is verified by a forced, not scheduler-dependent, interleaving

WHEN two first-ever writes target the same `(walletId, txHash)` concurrently, the system SHALL
serialize their read-merge-write cycles via the `pg_advisory_xact_lock`
(`transaction-history-storage.ts:455`) such that neither writer's section is lost — and this SHALL
be verified by a test that *forces* the losing interleaving with a deterministic barrier, so the
test would fail if the advisory lock were removed (Codex LOW finding,
`AUTONOMOUS_RUN_LOG.md:289`). The verification SHALL run against real Postgres, never the in-memory
reference (`sprint-7-transaction-history-storage/specs/transaction-history-storage/spec.md`'s own
equivalence caveat: the in-memory reference cannot exhibit this race).

#### Scenario: A forced interleaving of two first-ever writes preserves both sections
- **WHEN** two writers issue a first-ever `gotFinalized` for the same `(walletId, txHash)`, one with
  only a `shielded` section and one with only a `dust` section, with a barrier that releases the
  second writer's read only after the first writer's read has completed
- **THEN** the stored row SHALL contain both sections after both writers complete
- **AND** the test SHALL be constructed so that removing the `pg_advisory_xact_lock` makes it fail

### Requirement: every SDK lifecycle status round-trips through the adapter to a schema-valid SDK lifecycle

WHEN an entry is written through the Sprint 8 adapter with each of the SDK's lifecycle statuses
(`pending`, `finalized`, `rejected`) and read back via `getAll()`, the system SHALL reconstruct a
schema-valid SDK lifecycle object for that status, preserving its per-status detail — mapping the
SDK's discriminated union to and from UmbraDB's bare `{status}` union
(`src/interfaces/transaction-history-storage.ts:166-178`;
`sprint-8-wallet-envelope-live-sync/specs/wallet-state-envelope/spec.md` "adapter round-trips SDK
lifecycle detail"). This closes the Sprint 8 L-finding that the status-enum mapping had no direct
coverage.

#### Scenario: Each of the three statuses reconstructs a schema-valid SDK lifecycle
- **WHEN** a `pending`, a `finalized` (with `finalizedBlock{hash,height,timestamp}`), and a
  `rejected` (with `rejectedAt`+`reason`) entry are each written through the adapter and read back
- **THEN** each returned entry's `lifecycle` SHALL be a schema-valid SDK lifecycle of the matching
  status carrying its per-status detail
- **AND** a table-driven test SHALL assert all three cases directly

### Requirement: an unrecognized lifecycle status is rejected, never silently coerced

IF the adapter encounters a lifecycle status string that is not one of the recognized SDK statuses,
THEN it SHALL reject with a typed error rather than coerce it to a default status — the same
reject-don't-normalize posture Sprint 7's canonical decode already took (`CANONICAL_BIGINT_RE`,
`transaction-history-storage.ts:79`, and `parseStoredDate`'s exact-round-trip requirement).

#### Scenario: An unknown status string is rejected with a typed error
- **WHEN** the adapter is asked to map an entry whose lifecycle status is an unrecognized string
- **THEN** the call SHALL reject with a typed error
- **AND** SHALL NOT return an entry with a defaulted or guessed status

### Requirement: the adapter's implicit test-tier dependencies are recorded in a versioned pin manifest

The system SHALL record the Sprint 8 adapter's implicit test-tier dependencies — `effect`
(Effect-Schema), `@midnightntwrk/wallet-sdk-abstractions`, and the built `midnight-wallet` checkout
plus its ledger-v8 native bindings — in a versioned pin manifest with exact package names and the
resolved versions used in the proven run, since these are imported from an on-disk checkout and are
absent from `package.json` (verified: `package.json` declares only `postgres`/`zod` + test tooling).
The manifest SHALL NOT be satisfied by adding those packages to `package.json` (keeping `src/`
SDK-free is a standing non-goal).

#### Scenario: The pin manifest lists every implicit dependency with a resolved version
- **WHEN** the pin manifest (`test/integration/PINNED_DEPENDENCIES.md`) is inspected
- **THEN** it SHALL list each implicit test-tier dependency with an exact resolved version and the
  checkout/build steps to reproduce it
- **AND** none of those packages SHALL have been added to `package.json`'s `dependencies`

### Requirement: a multi-sub-wallet envelope round-trips every present sub-wallet string byte-for-byte

WHERE an envelope carries two or three of the sub-wallet strings (`shielded`, `unshielded`, `dust`),
`PgWalletStateEnvelopeStore.save` then `load` SHALL round-trip every present string byte-for-byte and
correctly skip any absent slot — extending Sprint 8's coverage beyond the unshielded-only tier it
actually exercised (`AUTONOMOUS_RUN_LOG.md:236-243`) to the 2-of-3 and 3-of-3 cases, as a required
Pg-only conformance test (no SDK sync; the strings are opaque,
`sprint-8-.../specs/wallet-state-envelope/spec.md`).

#### Scenario: A three-sub-wallet envelope round-trips all three strings
- **WHEN** an envelope with arbitrary opaque `shielded`, `unshielded`, and `dust` strings is saved and
  then loaded for a `(walletId, networkId)`
- **THEN** all three strings SHALL be returned byte-for-byte identical to the inputs

#### Scenario: A two-of-three envelope round-trips the present strings and skips the absent one
- **WHEN** an envelope with `unshielded` and `dust` present and `shielded` absent is saved and loaded
- **THEN** the two present strings SHALL round-trip byte-for-byte
- **AND** the restore path SHALL skip the absent `shielded` slot without failing

### Requirement: stray research artifacts do not leak into a working tree that does not own them

IF untracked files appear under `design/research/` on a branch other than the one that owns them
(`feature/verifiable-snapshot`), THEN the verify-gate working-tree-hygiene check SHALL fail — so the
verifiable-snapshot research set (`design/research/2026-07-21-snapshot-root-of-trust/`), currently
present as untracked files in the `main` worktree, cannot silently accumulate or be half-committed by
an unrelated `git add`. The check SHALL be a gate assertion, not a blanket `.gitignore` rule (the
owning branch legitimately tracks those files).

#### Scenario: Untracked research artifacts on a non-owning branch fail the hygiene check
- **WHEN** the working tree of a branch other than `feature/verifiable-snapshot` contains untracked
  files under `design/research/`
- **THEN** the working-tree-hygiene check SHALL report failure
- **AND** on the owning branch, where those files are tracked, the same check SHALL pass

### Requirement: the shared JSON key-safety helper is defined once, with no adapter importing another adapter's interface module

The JSON key-safety helper `hasPostgresUnsafeText` and the recursive key-safety/depth-bound check
SHALL be defined in one neutral shared module, imported by both `PgTemporalKV` and
`PgTransactionHistoryStorage`, so that no adapter imports it from another adapter's interface module
(today `transaction-history-storage.ts:12` imports it from `../interfaces/temporal-kv.js`). This
consolidation SHALL preserve the existing key-rejection behavior exactly.

#### Scenario: Both adapters share one key-safety helper with unchanged behavior
- **WHEN** the runtime imports of `src/postgres/transaction-history-storage.ts` are inspected after
  consolidation
- **THEN** the key-safety helper SHALL be imported from a neutral shared module, not from
  `../interfaces/temporal-kv.js`
- **AND** the identical set of unsafe keys (NUL byte, unpaired UTF-16 surrogate, over-depth objects)
  SHALL still be rejected, as asserted by a pinned regression test
