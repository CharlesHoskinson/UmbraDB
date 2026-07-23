# Design — v1.0.0 API Surface & Release Contract

Implementation-level detail for the 1.0.0 keystone change (G1-G4, G20). Every decision below is
grounded in real code at `/root/UmbraDB` (file:line) and honors the three council adjudications
(`council/A-release-scope.md`, `B-engineering-risk.md`, `C-security.md`) and
`ROADMAP-v1.0.0-CONSOLIDATED.md` verbatim. Where a decision touches an existing design doc it
cites it by name, per `openspec/config.yaml`'s design rule.

## 0. Ordering constraint (why this change is Phase 2, not Phase 1)

The roadmap critical path is: **G5 (co-tx `save`, changes the signature) → this freeze → CI
gates → RC → tag** (roadmap §"Critical path", steps 1 and 5; Council A §5 Phases 1-2). This change
therefore has a **hard dependency on G5 having merged**: `src/index.ts` re-exports
`PgCheckpointStore` and the `CheckpointStore` interface, and if it froze the pre-G5 `save()`
signature, 1.0 would ship a contract it cannot fix without a major bump. Nothing in this change
authors the `save` signature; it *consumes* the post-G5 one. Same for G3's `retryable` field
touching the error base: it is additive and does not itself change any method signature, so it is
safe inside Phase 2, but the chain-archive strip (also G3) is a pre-freeze obligation that must be
done *before* the barrel is authored, not after.

## 1. G1 — Public API surface

### 1.1 The barrel: `src/index.ts`

Today there is no `src/index.ts` (verified: `ls src/index.ts` → No such file). Create it as the
single public entry point, re-exporting **exactly** the frozen surface Council A §4(a)-1
enumerates. Concretely (names verified against real exports):

- **Entry points** — `createClient`, `UmbraDBConnectionOptions`, `UmbraDBSql`, `DEFAULT_SCHEMA`
  (`src/postgres/client.ts:119,44,10,14`); `runMigrations`, `Migration`, `RunMigrationsOptions`
  (`src/postgres/migrate.ts:79,13,47`).
- **The five adapters + envelope** — `PgTemporalKV` (`temporal-kv.ts:72`), `PgCheckpointStore`
  (`checkpoint-store.ts:125`), `PgWatermarks` (`watermarks.ts:34`), `PgTransactionLeaseLayer`
  (`transaction-lease.ts:202`), `PgTransactionHistoryStorage`
  (`transaction-history-storage.ts:306`), `PgWalletStateEnvelopeStore`
  (`wallet-state-envelope.ts:19`). **The `withTransaction`/`withLease` combinators are `async`
  *methods* of `PgTransactionLeaseLayer` (`transaction-lease.ts:207,403`), not module-level
  symbols** — verified: there is no standalone `withTransaction`/`withLease` export in `src/` (the
  internal helper at `transaction-lease.ts:37` is explicitly "not exported as public API"). They
  are frozen as part of that class's (and the `TransactionLeaseLayer` interface's) surface; the
  barrel re-exports the class, not phantom free functions. A builder MUST NOT invent standalone
  wrapper functions to satisfy this — that would add new API at the freeze moment (Fable audit B2).
- **All `src/interfaces/` types** — the interface contracts (`TemporalKV`, `CheckpointStore`,
  `Watermarks`, `TransactionLeaseLayer`, `TransactionHistoryStorage`, wallet-envelope types) and
  their associated value/handle types (`TransactionHandle`, versioned-entry types, etc.).
- **The error hierarchy** — `StorageError` and every concrete subclass *except* the chain-archive
  classes (see §3.3): `ValidationError`, `SerializationFailedError`, `ConnectionError`
  (`storage-errors.ts`); `VersionConflictError`, `HistoryUnavailableError`,
  `TransactionKeyReuseError` (`temporal-kv.ts`); `CheckpointNotFoundError`, `ChunkMissingError`,
  `ChunkIntegrityError`, `ManifestCorruptError` (`checkpoint-store.ts`);
  `TransactionRolledBackError`, `TransactionFaultError`, `LeaseTimeoutError`, `LeaseNotHeldError`,
  `LeaseFaultError`, `TransactionHandleInvalidError` (`transaction-lease.ts`);
  `EnvelopeVersionUnsupportedError`, `EnvelopeCorruptError` (`wallet-state-envelope.ts`);
  `ExclusionViolationError`, `ClockRegressionError`, `UnrecognizedPostgresError`
  (`postgres/errors.ts`).
- **The `Rollback` control primitive** — `Rollback` (`transaction-lease.ts:134`) is re-exported
  too, but it is **an `Error` subclass, NOT a `StorageError`**, and deliberately carries **no
  catalog `code`**: a caller constructs and throws it inside a `withTransaction` callback to request
  a deliberate rollback (`transaction-lease.ts:129-131`). It is frozen public API, but it is **not**
  one of the 21 catalog codes — do not "fix" the catalog by inventing a 22nd code for it (Fable
  audit B3 / Opus F4). The spec requirement, task 4.1, and acceptance A1 name it explicitly so an
  "exactly and only" barrel built from the `StorageError`-hierarchy wording does not drop it.

**Deliberately NOT re-exported** (Council A §4(a) closing paragraph; smallest-surface default): the
Zod schema objects (`JsonValueSchema`, `WatermarkValueSchema`, `TransactionOptionsSchema`, etc. —
internal validation detail), the observability seam (deferred to 1.1), anything under
`chain-archive`/`chain-archive-sync`, and the `nix/midnight-env` dev stack. Also explicitly kept
internal (each is currently module-exported in `src/` but is not part of the frozen surface, so the
barrel must simply not re-export it — naming them here closes the question for the builder):
`translatePostgresError`/`isConnectionFailure`/`isStatementTimeout` (`postgres/errors.ts` adapter
plumbing), `resolveTransaction` and `assertValidSchemaName`, and `withAbort`/`abortError`
(`postgres/abort.ts` — the cancellation *behavior* is frozen and documented in G4 §4.3, but the
helper functions are not public symbols). Default to the smallest surface: when in doubt, do not
export.

### 1.2 `package.json` — make it publishable with a strict `exports`

Current state (`package.json`): `"version":"0.1.0"`, `"private":true`, no `main`/`module`/
`exports`/`types`, and the only build-ish script is `"typecheck":"tsc --noEmit"` — so **nothing
emits `.d.ts` today**. Changes:

- **Drop `private:true`**; set `"version":"1.0.0"` at tag time.
- Add a **strict `exports` map** with a single public entry (`"."`) pointing at the built
  `dist/index.js` + `dist/index.d.ts`, plus `"types"` and `"main"` (and `"module"` if dual). **No
  wildcard subpath** (`"./*"`) — deep imports of `./src/postgres/*` become unresolvable, which is
  the enforcement mechanism, not a side effect (Council A §4(a)-1: "deep imports become
  unresolvable, which is the point").
- Add a `build` script that emits JS **and declarations** (`tsc -p tsconfig.build.json` with
  `declaration:true`, `emitDeclarationMap:true`, out to `dist/`) — the missing piece today.
- Add `"files"` allowlisting `dist/` (and `README`, `CHANGELOG`, `LICENSE`) so the packed tarball
  ships built output, not `src/` or `test/`.

### 1.3 Packed-tarball install smoke test

Report 01 P2 and Council A gate G1 both require proving the newly-declared `exports` actually
resolves for a real consumer. A CI/scriptable smoke test: `npm pack` → install the resulting
tarball into a throwaway scratch project → `import { createClient, runMigrations, PgTemporalKV,
StorageError } from "umbradb"` → run `runMigrations` + one `PgTemporalKV.put`/`get` round-trip
against a Testcontainers Postgres → assert (a) the import resolves, (b) a deep import
`umbradb/src/postgres/temporal-kv.js` **fails** to resolve (proving the strict map), (c) the
`.d.ts` is present in the tarball. This is the objective proof the surface is real.

## 2. G2 — SemVer stability policy + CHANGELOG

No `CHANGELOG.md` exists at repo root today (root `.md` files are `AGENTS.md`,
`AUTONOMOUS_RUN_LOG.md`, `CLAUDE.md`, `README.md`, `ROADMAP.md`). Add:

- **`CHANGELOG.md`** in Keep-a-Changelog format with the `## [1.0.0]` entry enumerating the five
  primitives + envelope as the initial public surface.
- **A written stability policy** (a README section or `docs/STABILITY.md`) stating the SemVer
  commitment precisely: *no breaking changes to the exported surface or the error `code` set in
  minor/patch; deprecate-in-a-minor, remove-only-in-a-major; a UmbraDB major may require a
  documented forward migration and there is no supported downgrade* (this last clause ties into
  the G4 migration contract, §4.2). Precedent: ElectricSQL 1.0 GA, SemVer 1.0 practice (report 01
  P0-2 sources).

## 3. G3 — Frozen, cleaned error-code catalog with `retryable`

### 3.1 The frozen catalog (the machine-facing API)

Error `code` discriminants are a machine-facing part of the public API (`StorageError.code` is
`abstract readonly code: string`, `storage-errors.ts:9`, documented "stable across
serialization"). The frozen 1.0.0 catalog is exactly these **21** codes (chain-archive excluded per
§3.3 — verified: `grep -rhoE 'readonly code = "[A-Z_]+"' src/ | grep -vE 'CHAIN|BLOB|BLOCK' | sort
-u | wc -l` → 21), grouped by owning module. The count is not a magic number: it is defined as *the
complete set of non-chain-archive `StorageError.code` values on `main`*, and task 5.2's drift test
(catalog ≡ exported classes) is the guard that keeps it exact:

| code | class | module | retryable |
|---|---|---|---|
| `VALIDATION_FAILED` | ValidationError | shared | no |
| `SERIALIZATION_FAILED` | SerializationFailedError | shared | no |
| `CONNECTION_ERROR` | ConnectionError | shared | **yes** |
| `VERSION_CONFLICT` | VersionConflictError | TemporalKV | no |
| `HISTORY_UNAVAILABLE` | HistoryUnavailableError | TemporalKV | no |
| `TRANSACTION_KEY_REUSE` | TransactionKeyReuseError | TemporalKV | no |
| `NOT_FOUND` | CheckpointNotFoundError | CheckpointStore | no |
| `CHUNK_MISSING` | ChunkMissingError | CheckpointStore | no |
| `CHUNK_INTEGRITY` | ChunkIntegrityError | CheckpointStore | no |
| `MANIFEST_CORRUPT` | ManifestCorruptError | CheckpointStore | no |
| `TRANSACTION_ROLLED_BACK` | TransactionRolledBackError | Transaction/Lease | no |
| `TRANSACTION_FAULT` | TransactionFaultError | Transaction/Lease | **yes** |
| `LEASE_TIMEOUT` | LeaseTimeoutError | Transaction/Lease | **yes** |
| `LEASE_NOT_HELD` | LeaseNotHeldError | Transaction/Lease | no |
| `LEASE_FAULT` | LeaseFaultError | Transaction/Lease | no |
| `TRANSACTION_HANDLE_INVALID` | TransactionHandleInvalidError | Transaction/Lease | no |
| `VERSION_UNSUPPORTED` | EnvelopeVersionUnsupportedError | wallet-envelope | no |
| `CORRUPT` | EnvelopeCorruptError | wallet-envelope | no |
| `EXCLUSION_VIOLATION` | ExclusionViolationError | postgres | no |
| `CLOCK_REGRESSION` | ClockRegressionError | postgres | **conditional** |
| `UNRECOGNIZED_POSTGRES_ERROR` | UnrecognizedPostgresError | postgres | no |

The `retryable` column is the published `{code → meaning → retryable}` table Council A gate G3 and
report 01 item 7 require, living in the G4 contract doc.

### 3.2 Promote retryability to a machine-readable field

Report 01 item 7 and Council A gate G3: retryability is currently prose-only. Add a machine-readable
field to the `StorageError` base (`storage-errors.ts:7`) — `abstract readonly retryable: boolean`
(or a small `Retryability` enum to express `ClockRegressionError`'s split). Each subclass sets it.
The one nuanced case is grounded in real code: `ClockRegressionError` (`errors.ts:33`) already
documents *two* causes with *different* retry characteristics — a backward wall-clock STEP (NOT
retryable) vs. a same-millisecond precision collision (IS retryable). The field must therefore
either mark `CLOCK_REGRESSION` as "conditional" (documented: retry once past the millisecond
boundary; do not retry a sustained backward step) or expose a sub-discriminant — the doc records
the nuance either way so callers do not treat it as uniformly non-retryable (that mischaracterization
is exactly what the fourth-round audit corrected in that class's own docstring). `ConnectionError`,
`TransactionFaultError` (serialization-failure/deadlock, `errors.ts` 40001/40P01 mappings), and
`LeaseTimeoutError` are the unambiguously-retryable codes (report 01 item 9's "retryable set").

### 3.3 Strip / mark-experimental the chain-archive error classes (pre-freeze obligation)

This is the concrete pre-freeze task no facet report listed and Council A critique #6 elevated. The
chain-archive feature is deferred to 1.1 (roadmap verdict #4, ruling (e)), yet its error classes
already sit in the shareable surface:

- `src/postgres/errors.ts:61,67` — `ChainArchiveInvariantError`
  (`CHAIN_ARCHIVE_INVARIANT_VIOLATION`), `ChainArchiveCheckViolationError`
  (`CHAIN_ARCHIVE_CHECK_VIOLATION`).
- `src/interfaces/chain-archive-store.ts:131-152` — `ChainArchiveError` (abstract),
  `BlobIntegrityError` (`BLOB_INTEGRITY`), `BlobMissingError` (`BLOB_MISSING`), `BlockNotFoundError`
  (`BLOCK_NOT_FOUND`).

**Approach:** these classes are **not re-exported from `src/index.ts`** and their codes are **not
in the frozen catalog** (§3.1). Two options for the ones baked into `translatePostgresError`'s
`23514` constraint-name routing (`errors.ts`, the `CHAIN_ARCHIVE_*` sets and switch branch): (a)
keep the routing internal but unexported, or (b) mark the classes explicitly `@experimental` in
TSDoc with a note that they are provisional and may change in 1.1. Preferred: **do not export
them, and mark the routing code `@internal`/`@experimental`** — this keeps `translatePostgresError`
correct for the day archival merges (it still routes a real 23514 to the right internal class)
without freezing `CHAIN_ARCHIVE_*` as a 1.0 public promise. The `23514` fall-through to
`ClockRegressionError` for unknown constraint names (the pre-Fix-4 default, preserved in that
switch) is unaffected. Net: an unshipped 1.1 feature does **not** freeze the 1.0 surface.

## 4. G4 — The contract doc set (all *true*)

Council A gate G4 requires "written contracts that are true." Each is currently implicit, absent,
or overstated in docs. Delivered as `docs/CONTRACT.md` (or dedicated README sections), one section
per contract. None of these are code changes in this document — they are documentation of behavior
that already exists (or, for durability/probe, of the binding precondition G6 enforces):

1. **Durability contract** — state the ordering guarantee the G5 co-tx fix establishes
   (watermark/cursor never commits ahead of the checkpoint data it points at) and the binding
   Postgres precondition the G6 startup probe asserts (`fsync`/`synchronous_commit`/
   `full_page_writes` on; no transaction pooler) — "durable" in the docs must *mean* something
   (Council A §1 F9). This change writes the contract; G6 (separate) ships the probe code.
2. **Forward-only / no-downgrade migration contract** — `src/postgres/migrate.ts`'s `Migration`
   interface (`migrate.ts:13`) is deliberately `up()`-only, no `down()`/rollback. Document: migrations
   are forward-only; a UmbraDB major may require a documented migration; there is no supported
   downgrade; and how the schema-version row behaves on app rollback. Precedent: cardano-db-sync's
   `a.b.c.d` scheme (report 01 P0-3). Publish the generated schema doc (`docs/SCHEMA.md` exists —
   land/reference it).
3. **Cancellation semantics** — `AbortSignal` is threaded through every method; `withAbort`
   (`src/postgres/abort.ts:38`) has a precise "pre-check only" contract; `listKeys` and lease-acquire
   build real `query.cancel()` mid-wait cancellation. Document the *guarantee* as public contract:
   "abort before dispatch = no query; abort mid long-read (listKeys / lease-acquire) = cursor/wait
   freed; abort mid quick write = may complete" (report 01 item 8; sprint-4 spec's own abort
   scenarios are the template).
4. **`save`-retry caveat** — F2 as documentation, per council (roadmap "Council rulings" §1; A
   critique #1): "`save` is not blindly retryable; on `ConnectionError`, re-check `history()`
   before retrying — a lost-COMMIT-ack retry produces a benign identical-content duplicate at seq
   N+1, pruned by `retainCount`. The `idempotency_key` UNIQUE constraint is an additive 1.1
   migration." No code here.
5. **Lease limitation** — F3 as documentation, per council (A critique #4): "the lease guards
   concurrent acquirers within the documented single-process deployment model; it does **not**
   fence writes against connection death; do not run two writer processes." Pinned-connection
   fencing is 1.0.x/1.1.
6. **Backup/restore guidance** — a consumer-facing statement (report 01 P1-6; Council A gate G4):
   how to `pg_dump`/restore an UmbraDB schema, and what content-addressing/GC means for dump
   consistency (CheckpointStore's chunk tables + manifest must be dumped consistently; a mid-GC
   dump must be safe). The `nix/midnight-env/scripts/backup-state.sh` scripts back up the *dev
   stack*, not UmbraDB-as-a-library — this doc fills the gap for embedders.
7. **Threat-model pointer** — a pointer only. The threat-model *document* is G15 (the InfoSec
   change): single trusted writer; schema ≠ security boundary; the global chunk pool is one trust
   domain with an observable dedup side channel; no at-rest encryption (binding deployer
   precondition). G4 reserves the link so the contract set is complete; it does not author the
   doc (roadmap §E; Council A gate G4/G12 boundary).
8. **Format-headroom paragraph** (Council A critique #7, gate G4): state that **chunk addressing
   and the wallet-state envelope encoding are versioned** — manifests already carry enough
   structure to introduce a v2 keyed/encrypted chunk mode *additively*, so 1.1 can add
   per-consumer/keyed chunking (which also kills the dedup oracle) and at-rest encryption **without
   a breaking migration**. "One paragraph now buys the entire deferral." This is the documentation
   half of the dedup-oracle deferral; no keyed-chunking code ships here.

**README consistency (affected file):** the README front-matter section "Full-chain storage —
validated live against public Preprod (AC-8)" currently markets a *deferred* track as a headline
capability. Reframe it as a 1.1 *preview* explicitly outside the frozen 1.0 surface, consistent
with ruling (e) and the G3 error-class strip — otherwise the release docs contradict the frozen
surface.

## 5. G20 — Freeze the Lean cut-line

Report 01's gap table row 1 and Council A gate G11/§F: the checklist item "formal spec's tractable
properties proved in Lean" is unfalsifiable as written ("tractable" has no enumerated set).
**Freeze the 1.0.0 cut-line as exactly `{T3, T5, W1, C1}`** — already mechanized (M1 TemporalKV
T3/T5, M3a Watermarks W1, M3b CheckpointStore C1 save-side projection) and trust-gated in required
CI (`.github/workflows/lean.yml`, the trust gate rejecting new axioms/decls) — **plus a written
deferral** of C2a/GC, ordered reconstruction, lease traces, keyed-store lifting, and SQL/runtime
refinement to post-1.0. Recorded in `ROADMAP.md`'s Milestone-1 checklist and/or the `Formal/`
plan, converting an open-ended aspiration into a checked box. Documentation/decision only; no proof
work in this change (extending proofs to C2a/GC is explicitly a post-1.0 P2, report 01 P2 table).

## 6. Non-goals / boundaries respected (restated for the implementer)

- **G5's `save` signature is consumed, never authored here** (§0). If G5 has not merged, this
  change is blocked — do not freeze a pre-G5 barrel.
- **No idempotency code, no keyed-chunking code, no encryption code** — G4 items #4 and #8 are
  documentation of deferrals, per council.
- **No foreign consumer import** — the smoke test (§1.3) uses a throwaway scratch project + a
  Testcontainers Postgres, not any real consumer app; this respects the indexer-agnostic boundary
  (Council A ruling (b); MEMORY boundary note).
- **The threat-model, supply-chain CI, perf baselines, and crash/soak tests are other changes** —
  this change only reserves the G4 threat-model *pointer* and the format-headroom paragraph.
- **Smallest possible surface** — when in doubt, do not export (Zod schemas, translate helpers,
  chain-archive, dev stack all stay internal).

## Audit resolution

Two independent audits ran against the pre-revision draft: `audit-fable.md` (verdict REVISE, three
blocking findings B1–B3) and `audit-opus.md` (verdict REVISE, one blocking finding F1). Both
verdicts were REVISE, not REJECT — coverage, council-fidelity, grounding, and task ordering all
passed. Every blocking finding is **applied**; no blocking finding is rejected.

**Blocking findings — all applied (verified against live code at `/root/UmbraDB`):**

- **B1 / F1 (both audits) — catalog cardinality "20" was wrong; the frozen set is 21.** Verified:
  `grep -rhoE 'readonly code = "[A-Z_]+"' src/ | grep -vE 'CHAIN|BLOB|BLOCK' | sort -u | wc -l` →
  **21**. The design §3.1 table already enumerated all 21 rows; only the cardinal was wrong, and it
  had propagated to spec.md (requirement + scenario), tasks 5.2/8.1, and acceptance C1 — where it
  collided with the C4 "table ≡ surface" drift test (the two were mutually unsatisfiable). Fixed by
  changing every "20" locus to "21" **and** re-anchoring the number to a non-magic definition ("the
  complete set of non-chain-archive `StorageError.code` values on `main`", guarded by the drift
  test) so it cannot silently drift again. No code was dropped from the frozen set.
- **B2 (Fable) — `withTransaction`/`withLease` are instance methods, not re-exportable symbols.**
  Verified: both are `async` methods of `PgTransactionLeaseLayer` (`transaction-lease.ts:207,403`);
  there is no module-level export of either name (the internal helper at `:37` is annotated "not
  exported as public API"). The prior wording ("re-exports … the `withTransaction`/`withLease`
  combinators") was unimplementable and risked a builder inventing standalone wrappers — new API at
  the freeze moment. Fixed in the spec barrel requirement, its scenario, design §1.1, and task 4.1:
  the combinators are frozen as **methods of the exported class/interface**, and the proposal G1
  bullet now says so explicitly.
- **B3 (Fable) / F4 (Opus, non-blocking) — `Rollback` was excluded by the spec's own wording.**
  Verified: `Rollback` extends `Error`, not `StorageError`, and has no `code`
  (`transaction-lease.ts:134`), yet it is consumer-facing API (thrown to request a deliberate
  `withTransaction` rollback). The spec/task/acceptance defined the frozen error surface as "the
  `StorageError` hierarchy," which — read literally, as this spec demands — dropped `Rollback`.
  Fixed by naming `Rollback` explicitly in the spec barrel requirement + scenario, design §1.1
  (with a note that it is an `Error` subclass with no catalog code — so nobody adds a 22nd code),
  task 4.1, and acceptance A1.

**Non-blocking findings — applied where they clearly improve the change:**

- Fable §3.1 (WHERE→IF/THEN): the retryability requirement's conditional clause was mis-formed as
  EARS `WHERE` (optional-feature form); changed to `IF … THEN …` (unwanted/conditional form).
- Fable §4.1 (operationalize A5's "no `any` fallback"): the type-declarations scenario and
  acceptance A5/task 3.1 now require a compiled type-assertion file under `noImplicitAny` (`tsd` /
  `expectTypeOf`), not eyeballing.
- Fable §4.2 / Opus F3 (G20 CI scenario + barrel negative-import wording): the Lean scenario now
  says "mechanized in `Formal/Lean` and covered by the trust gate" (the workflow does not enumerate
  property names); the barrel negatives are split into two scenarios — an ESM *named-import* link
  error ("does not provide an export named …") vs. a deep-subpath resolution error
  (`ERR_PACKAGE_PATH_NOT_EXPORTED`).
- Fable §"Summary" nit (explicit exclusion list): design §1.1's not-exported list now names
  `resolveTransaction`, `assertValidSchemaName`, and `withAbort`/`abortError` so the builder has no
  open question.

**Non-blocking findings deliberately NOT changed (both auditors concurred these are acceptable):**

- Fable §3.2/§3.3, Opus F2 (mildly compound requirements — the barrel requirement bundles a
  positive export list with a negative exclusion list; the smoke-test requirement chains
  import+migrate+round-trip). **Left as-is.** Both auditors explicitly ruled these tolerable and
  *consistent with the sprint-4 precedent* (whose tx-handle requirement likewise bundles
  set-visibility + rollback + stale-handle rejection); each clause targets a single artifact and
  each is decomposed into separate scenarios, so atomicity is preserved at the scenario level.
  Splitting them would diverge from the repo convention this change is required to mirror. This is
  the only place a finding was not acted on, and it is a concurrence with the auditors, not a
  rejection of a blocking item.
