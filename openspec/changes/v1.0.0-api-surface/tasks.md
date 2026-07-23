# Tasks — v1.0.0 API Surface & Release Contract

Each task: implemented by a builder, then reviewed in parallel by two Opus auditors
(spec-compliance against this change's `design.md` + `specs/release-contract/spec.md`; code/docs/test
quality). A task is CLOSED only after both auditors approve, or their findings are fixed and
re-reviewed. Matches Sprint 1-8's own review cadence. Every task states concrete acceptance criteria
(what test passes / what artifact is checkable), per `openspec/config.yaml`'s tasks rule.

**Critical-path ordering (roadmap §"Critical path", Council A §5).** This change is **Phase 2 —
the freeze**. It has a **hard upstream dependency: G5 (co-transactional `save`) MUST have merged
first** — it changes `save`'s signature, and freezing a pre-G5 barrel would ship a contract 1.0
cannot fix without a major bump. Within this change: the chain-archive strip (§3) and the
`retryable` field (§2) are pre-barrel; the barrel + package.json + build (§4) are the freeze moment;
docs (§5) and the Lean cut-line (§6) run in parallel; the smoke test (§7) is last because it
validates the packed result of everything above.

## 0. Preconditions (blocking gate — verify before any freeze work)

- [ ] 0.1 **Confirm G5 has merged and `save`'s signature is final.** Inspect
  `src/interfaces/checkpoint-store.ts` and `src/postgres/checkpoint-store.ts` and confirm the
  co-transactional `save` (accepts a caller `tx`, or the documented `saveAndAdvance` combinator
  exists). **Acceptance:** a written note in this file records the exact final `save` signature the
  barrel will freeze; if G5 has not merged, STOP — this change is blocked (design §0). Satisfies the
  ordering precondition for **G1**.

## 1. Pre-freeze: retryability field (G3)

- [ ] 1.1 Add a machine-readable retryability field to the `StorageError` base
  (`src/interfaces/storage-errors.ts:7`) — `abstract readonly retryable` (boolean, or a small
  `Retryability` enum to express the conditional case) — and set it on every concrete subclass
  across `storage-errors.ts`, `temporal-kv.ts`, `checkpoint-store.ts`, `transaction-lease.ts`,
  `wallet-state-envelope.ts`, `postgres/errors.ts`. Mark `CONNECTION_ERROR`, `TRANSACTION_FAULT`,
  `LEASE_TIMEOUT` retryable; mark `CLOCK_REGRESSION` conditional (retryable same-ms collision vs.
  non-retryable backward step — `errors.ts:33`'s own two documented causes); all others
  non-retryable. **Acceptance:** `tsc --noEmit` passes; a unit test catches one instance of each
  error class and asserts its `retryable` value matches the frozen catalog table (design §3.1);
  `CLOCK_REGRESSION`'s representation distinguishes its two causes and does NOT label it uniformly
  non-retryable. Satisfies **"Retryability is a machine-readable field on every StorageError."**

## 2. Pre-freeze: strip / mark-experimental the chain-archive error classes (G3)

- [ ] 2.1 Ensure the six chain-archive error classes are excluded from the frozen surface:
  `ChainArchiveInvariantError`/`ChainArchiveCheckViolationError` (`src/postgres/errors.ts:61,67`)
  and `ChainArchiveError`/`BlobIntegrityError`/`BlobMissingError`/`BlockNotFoundError`
  (`src/interfaces/chain-archive-store.ts:131-152`). They are NOT re-exported from `src/index.ts`
  (task 4.1) and their codes are NOT in the frozen catalog (task 5.2). Keep the `translatePostgresError`
  23514 constraint-name routing internal and mark those classes `@experimental`/`@internal` in TSDoc.
  **Acceptance:** a test/lint assertion confirms none of the six class names is exported from the
  built barrel and none of `CHAIN_ARCHIVE_INVARIANT_VIOLATION`/`CHAIN_ARCHIVE_CHECK_VIOLATION`/
  `BLOB_INTEGRITY`/`BLOB_MISSING`/`BLOCK_NOT_FOUND` appears in the published catalog; a test confirms
  `translatePostgresError` still routes a chain-archive-named 23514 to the correct internal class
  (routing preserved, surface not frozen); the 23514 fall-through to `ClockRegressionError` for
  unknown constraint names is unchanged. Satisfies **"The chain-archive error classes are excluded
  from the frozen surface."** (`council/A` critique #6, ruling (e).)

## 3. The freeze: build + package.json (G1)

- [ ] 3.1 Add a declaration-emitting build. Add `tsconfig.build.json` (extends the base;
  `declaration: true`, `emitDeclarationMap: true`, `outDir: dist`, no `noEmit`) and a `"build"`
  script (`tsc -p tsconfig.build.json`). Today the only build-ish script is `"typecheck": "tsc
  --noEmit"` — nothing emits `.d.ts`. **Acceptance:** `npm run build` produces `dist/index.js` and
  `dist/index.d.ts` with no errors; a compiled type-assertion file (`tsd` or `expectTypeOf`) run
  under `noImplicitAny` asserts each frozen export resolves to a concrete type with no implicit-`any`
  fallback and no "could not find a declaration file" diagnostic. Satisfies **"The published package
  ships type declarations."**
- [ ] 3.2 Update `package.json`: remove `private: true`; add `main` (`dist/index.js`), `types`
  (`dist/index.d.ts`), a strict `exports` map with a single `"."` entry and **no** wildcard/deep
  subpath; add `"files"` allowlisting `dist/` + `README`/`CHANGELOG`/`LICENSE`; keep `version` at
  `0.1.0` until tag time (bump to `1.0.0` is the tag step, not here). **Acceptance:** a test parses
  the built `package.json` and asserts `private` is absent, `main`/`types`/`exports."."` are present,
  and no `exports` entry resolves a `src/postgres/*`/`src/interfaces/*` deep path. Satisfies
  **"package.json is publishable with a strict exports map and no deep-import escape hatch."**

## 4. The freeze: the public barrel (G1)

- [ ] 4.1 Write `src/index.ts` re-exporting EXACTLY the frozen surface (design §1.1): `createClient`,
  `UmbraDBConnectionOptions`, `UmbraDBSql`, `DEFAULT_SCHEMA`, `runMigrations`, `Migration`,
  `RunMigrationsOptions`; the five adapters + `PgWalletStateEnvelopeStore`; all `src/interfaces/`
  contract + value types (`TemporalKV`, `CheckpointStore`, `Watermarks`, `TransactionLeaseLayer`,
  `TransactionHistoryStorage`, wallet-envelope types, `TransactionHandle`); the `Rollback` control
  primitive (an `Error` subclass with NO catalog `code` — re-export it, but do NOT add a catalog
  entry for it; Fable B3 / Opus F4); the full `StorageError` hierarchy **minus** the six
  chain-archive classes. **`withTransaction`/`withLease` are NOT standalone exports** — they are
  `async` methods of `PgTransactionLeaseLayer` (`transaction-lease.ts:207,403`), frozen as part of
  that exported class/interface; do NOT author free-function wrappers for them (Fable B2). Do NOT
  export Zod schemas, `translatePostgresError`/`isConnectionFailure`/`isStatementTimeout`,
  `resolveTransaction`/`assertValidSchemaName`, `withAbort`/`abortError`, chain-archive symbols, or
  dev-stack code. **Acceptance:** `tsc --noEmit` passes with `src/index.ts`; a test imports each
  frozen name (including `Rollback`) from the built barrel and asserts it resolves; a test confirms
  `withTransaction`/`withLease` are reachable only as methods on a `PgTransactionLeaseLayer` instance
  (no top-level barrel export of either name); a test asserts a representative internal symbol (a Zod
  schema, `translatePostgresError`, `resolveTransaction`, a chain-archive class) is NOT exported from
  the barrel. Satisfies **"A single public barrel exports exactly the frozen 1.0.0 surface."**
  Depends on 0.1 (final `save` signature), 2.1, 3.1/3.2.

## 5. Release contract docs (G2, G4)

- [ ] 5.1 **SemVer stability policy + CHANGELOG (G2).** Add a stability policy (README section or
  `docs/STABILITY.md`) stating: no breaking changes to the exported surface or error-`code` set in
  minor/patch; deprecate-in-minor / remove-in-major; a major may require a forward migration, no
  supported downgrade. Add `CHANGELOG.md` (Keep-a-Changelog) with the `1.0.0` entry enumerating the
  five primitives + `PgWalletStateEnvelopeStore`. **Acceptance:** the stability doc states all three
  commitment clauses verbatim-in-substance; `CHANGELOG.md` exists with a `1.0.0` entry naming the
  frozen surface. Satisfies **"A written SemVer stability policy governs the frozen surface"** +
  **"A CHANGELOG records the 1.0.0 surface."**
- [ ] 5.2 **Frozen error-code catalog table (G3).** Publish the `{code → meaning → retryable}` table
  (design §3.1) covering exactly the 21 frozen codes (the complete set of non-chain-archive
  `StorageError.code` values on `main`), excluding all chain-archive codes, with the retryability
  from task 1.1. **Acceptance:** the catalog lists all 21 codes with meaning + retryable marking;
  `CONNECTION_ERROR`/`TRANSACTION_FAULT`/`LEASE_TIMEOUT` are retryable; no chain-archive code
  appears; a test cross-checks the table's code set against the actually-exported error classes'
  `code` values (table ≡ surface, no drift — this drift test, not the literal number, is the
  authority on the count). Satisfies **"The error-code catalog is frozen and published with a
  retryable field."** Depends on 1.1, 2.1.
- [ ] 5.3 **Contract doc set (G4).** Author `docs/CONTRACT.md` (or README sections) with all eight
  contracts (design §4): durability (+ probe precondition), forward-only/no-downgrade migration
  (link `docs/SCHEMA.md`), cancellation semantics, save-retry caveat, lease limitation, backup/restore
  guidance, threat-model **pointer** (not the doc itself — that is G15), and the format-headroom
  paragraph. **Acceptance:** each of the eight sections exists and states its required content per the
  matching spec requirement's scenario (durability names the ordering guarantee + required PG config;
  migration states forward-only/no-downgrade + schema-doc link; cancellation states the three abort
  timings; save-retry states re-check-`history()` + 1.1 deferral; lease states no-fencing/no-two-writers;
  backup states chunk/manifest consistency under GC; threat-model section is a pointer; format-headroom
  reserves keyed/encrypted chunk modes for 1.1). Satisfies the seven **G4** contract requirements.
- [ ] 5.4 **README consistency (G4 boundary hygiene).** Reframe the README front-matter section
  "Full-chain storage — validated live against public Preprod (AC-8)" as a 1.1 *preview* explicitly
  outside the frozen 1.0 surface (it currently markets a deferred track as a headline). **Acceptance:**
  the README no longer presents full-chain archival as part of the 1.0 public surface; it labels it a
  1.1 preview, consistent with the G3 error-class strip and `council/A` ruling (e). Depends on 2.1.

## 6. Freeze the Lean cut-line (G20)

- [ ] 6.1 Record the frozen 1.0.0 formal cut-line as exactly `{T3, T5, W1, C1}` (mechanized,
  trust-gated in `.github/workflows/lean.yml`) with a written deferral of C2a/GC, ordered
  reconstruction, lease traces, keyed-store lifting, and SQL/runtime refinement — in `ROADMAP.md`'s
  Milestone-1 checklist and/or the `Formal/` plan. **Acceptance:** the record names exactly the four
  proved properties and lists the five deferred workstreams; a reviewer confirms the four are the set
  actually gated by the Lean trust gate (checklist box objectively green). Documentation/decision only;
  no proof work. Satisfies **"The 1.0.0 Lean cut-line is frozen with a written deferral."**

## 7. Packed-tarball install smoke test (G1)

- [ ] 7.1 Add `test/smoke/pack-install.*`: `npm pack` → install the tarball into a throwaway scratch
  project → `import { createClient, runMigrations, PgTemporalKV, StorageError } from "umbradb"` → run
  `runMigrations` + one `PgTemporalKV.put`/`get` round-trip against a Testcontainers Postgres → assert
  it resolves; additionally assert (a) a deep import `umbradb/src/postgres/temporal-kv.js` FAILS to
  resolve, (b) `dist/index.d.ts` is present in the tarball. **Uses a scratch project + Testcontainers
  Postgres, NEVER a real consumer app** (indexer-agnostic boundary, `council/A` ruling (b)).
  **Acceptance:** the smoke test passes end to end in CI: root import + round-trip succeed; the deep
  import fails; the declaration is present. Satisfies **"A packed-tarball install smoke test proves
  the surface resolves for a real consumer"** + the declaration and strict-boundary scenarios. Depends
  on 3.1, 3.2, 4.1.

## 8. Change close-out

- [ ] 8.1 Whole-change differential review: an Opus auditor re-reads this `proposal.md`/`design.md`/
  `spec.md` against the actual committed code + docs and confirms every "Acceptance" criterion above
  was actually checked — a passing CI run is not sufficient evidence on its own, per every prior
  sprint's close-out standard. Confirm specifically: the barrel excludes every internal symbol it
  should (Zod, translate helpers, `resolveTransaction`/`assertValidSchemaName`/`withAbort`,
  chain-archive, dev stack); `Rollback` IS exported but has no catalog code; `withTransaction`/
  `withLease` are methods of the exported class, not standalone symbols; the frozen catalog has
  exactly 21 codes (equal to the exported non-chain-archive `StorageError.code` set — verify via the
  drift test, not a hard-coded number); the `save` signature frozen matches post-G5; no deferred code
  (idempotency, keyed chunking, encryption, observability) leaked in.
- [ ] 8.2 Update `ROADMAP.md`'s 1.0.0 gate checklist to mark G1-G4 and G20 addressed by this change,
  cross-referencing the change id `v1.0.0-api-surface`, so the roadmap doesn't drift from what's built.
- [ ] 8.3 Per this repo's `CLAUDE.md`: re-run `graphify --update` against the repo root and commit the
  refreshed `graphify-out/` outputs in this close-out commit, so the knowledge graph doesn't silently
  drift stale behind this change's new openspec change and code. **Do NOT run graphify while drafting
  this change** (MEMORY: Codex-auditor graphify stall) — this is a close-out-only step.
