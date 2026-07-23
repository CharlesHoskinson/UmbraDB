# Acceptance — v1.0.0 API Surface & Release Contract

Consolidated, objective acceptance criteria for change `v1.0.0-api-surface` (gate items G1-G4,
G20). Every criterion is traceable to a requirement in `specs/release-contract/spec.md` and a task
in `tasks.md`, and is marked with how it is verified: **[unit]** unit test, **[prop]** property
test, **[CI]** CI gate, **[doc]** checkable doc artifact, **[manual]** manual reviewer evidence.
Nothing here gates on a performance number (roadmap §D; `council/A` critique #2).

## Precondition (blocks the whole change)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| P0 | G5 (co-transactional `save`) has merged; the exact final `save` signature the barrel will freeze is recorded. If not merged, the change is blocked. | [manual] | design §0 / task 0.1 |

## G1 — Public API surface

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| A1 | Every frozen name (`createClient`, `runMigrations`, the five adapters, `PgWalletStateEnvelopeStore`, the `Rollback` control primitive, all interface types, the `StorageError` hierarchy minus chain-archive) resolves when imported from the built barrel; `withTransaction`/`withLease` are reachable as methods on a `PgTransactionLeaseLayer` instance (NOT as standalone barrel exports). | [unit][CI] | "barrel exports exactly the frozen surface" / 4.1 |
| A2 | A representative internal symbol (a Zod schema, `translatePostgresError`, `resolveTransaction`, a chain-archive class) is NOT re-exported by the barrel: a named import of it fails at link time ("does not provide an export named …"). | [unit][CI] | "barrel exports exactly the frozen surface" / 4.1 |
| A3 | Built `package.json` has no `private:true`; has `main`, `types`, and an `exports` map with a `"."` entry and no wildcard/deep subpath; no `exports` entry resolves a `src/postgres/*` or `src/interfaces/*` path. | [unit][CI] | "publishable with a strict exports map" / 3.2 |
| A4 | A consumer's deep import `umbradb/src/postgres/temporal-kv.js` fails module resolution (`ERR_PACKAGE_PATH_NOT_EXPORTED`) from the installed package. | [unit][CI] | "publishable with a strict exports map" + smoke test / 3.2, 7.1 |
| A5 | `npm run build` emits `dist/index.js` and `dist/index.d.ts` with no errors; a compiled type-assertion file (`tsd`/`expectTypeOf`) under `noImplicitAny` proves each frozen export types with no implicit-`any` fallback and no "could not find a declaration file" diagnostic. | [CI] | "ships type declarations" / 3.1 |
| A6 | The packed tarball (`npm pack`) contains `dist/index.d.ts`. | [unit][CI] | "ships type declarations" / 3.1, 7.1 |
| A7 | Smoke test: tarball installed into a scratch project; root import of the public surface resolves; `runMigrations` + a `PgTemporalKV.put`/`get` round-trip against Testcontainers Postgres returns the written value. Uses NO real consumer app. | [CI] | "packed-tarball install smoke test" / 7.1 |
| A8 | The same smoke test asserts the deep import fails and the declaration is present. | [CI] | "packed-tarball install smoke test" / 7.1 |

## G2 — SemVer stability policy + CHANGELOG

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| B1 | A written stability policy states: no breaking changes to the exported surface or error-`code` set in minor/patch. | [doc] | "written SemVer stability policy" / 5.1 |
| B2 | The policy states the deprecate-in-minor / remove-in-major rule. | [doc] | "written SemVer stability policy" / 5.1 |
| B3 | The policy states a major may require a forward migration and downgrade is unsupported. | [doc] | "written SemVer stability policy" / 5.1 |
| B4 | `CHANGELOG.md` exists (Keep-a-Changelog) with a `1.0.0` entry naming the five primitives + `PgWalletStateEnvelopeStore`. | [doc] | "CHANGELOG records the 1.0.0 surface" / 5.1 |

## G3 — Frozen, cleaned error catalog

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| C1 | The published `{code → meaning → retryable}` table lists exactly the 21 frozen codes (the complete non-chain-archive `StorageError.code` set on `main`, per design §3.1), each with a meaning and a retryable marking; C4's drift test — not the literal number — is the authority the count is checked against. | [doc][unit] | "error-code catalog is frozen" / 5.2 |
| C2 | `CONNECTION_ERROR`, `TRANSACTION_FAULT`, `LEASE_TIMEOUT` are marked retryable in the table. | [doc][unit] | "error-code catalog is frozen" / 5.2 |
| C3 | No `CHAIN_ARCHIVE_INVARIANT_VIOLATION`/`CHAIN_ARCHIVE_CHECK_VIOLATION`/`BLOB_INTEGRITY`/`BLOB_MISSING`/`BLOCK_NOT_FOUND` code appears in the catalog. | [doc][unit] | "chain-archive classes excluded" / 5.2, 2.1 |
| C4 | A test cross-checks the catalog's code set against the actually-exported error classes' `code` values (table ≡ surface, no drift). | [unit][CI] | "error-code catalog is frozen" / 5.2 |
| C5 | Every `StorageError` subclass exposes a machine-readable `retryable` value; a caught instance exposes it without message parsing. | [unit] | "retryability is a machine-readable field" / 1.1 |
| C6 | `CLOCK_REGRESSION` is represented so its retryable same-ms collision and non-retryable backward step are distinguished (marked "conditional"), not labelled uniformly non-retryable. | [unit] | "retryability is a machine-readable field" / 1.1 |
| C7 | None of the six chain-archive error classes is re-exported from the built barrel. | [unit][CI] | "chain-archive classes excluded" / 2.1, 4.1 |
| C8 | `translatePostgresError` still routes a chain-archive-named SQLSTATE 23514 to the correct internal class; those classes are marked experimental/internal. | [unit] | "chain-archive classes excluded" / 2.1 |
| C9 | The 23514 fall-through to `ClockRegressionError` for unknown constraint names is unchanged. | [unit] | "chain-archive classes excluded" / 2.1 |

## G4 — Contract doc set (all true)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| D1 | Durability contract states the cursor never advances past durable checkpoint data AND names the required `fsync`/`synchronous_commit`/`full_page_writes` + no-transaction-pooler precondition. | [doc] | "durability contract" / 5.3 |
| D2 | Migration contract states forward-only, no rollback, no supported downgrade, major-may-require-migration, and links `docs/SCHEMA.md`. | [doc] | "forward-only migration contract" / 5.3 |
| D3 | Cancellation contract states the three abort timings (before dispatch = no query; mid-long-read = cursor/lease freed; mid-quick-write = may complete). | [doc] | "cancellation contract" / 5.3 |
| D4 | Save-retry caveat instructs re-check `history()` before retrying `save` after `ConnectionError`, and states idempotency is a 1.1 fast-follow. | [doc] | "save-retry caveat" / 5.3 |
| D5 | Lease-limitation contract states no fencing against connection death and no two writer processes in the 1.0 model. | [doc] | "lease-limitation contract" / 5.3 |
| D6 | Backup guidance states consistent `pg_dump` of an UmbraDB schema, chunk/manifest consistency, and mid-GC-dump safety. | [doc] | "backup/restore guidance" / 5.3 |
| D7 | The contract set contains a pointer/link to the (separately authored, G15) threat-model document; this change does NOT author that document. | [doc] | "threat-model pointer" / 5.3 |
| D8 | The format-headroom note states chunk addressing + envelope encoding are versioned and a keyed/encrypted chunk mode is additively introducible in 1.1 without a breaking migration; no keyed-chunking/encryption code ships. | [doc][manual] | "format-headroom note" / 5.3 |
| D9 | The README no longer presents full-chain archival as part of the 1.0 public surface; it is labelled a 1.1 preview. | [doc] | boundary hygiene / 5.4 |

## G20 — Lean cut-line

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| E1 | The frozen record names exactly `{T3, T5, W1, C1}` as the 1.0.0 proved set and lists C2a/GC, ordered reconstruction, lease traces, keyed-store lifting, SQL/runtime refinement as deferred. | [doc] | "Lean cut-line frozen" / 6.1 |
| E2 | The four frozen properties are the set actually gated by the Lean trust gate in `.github/workflows/lean.yml` (checklist box objectively green). | [manual][CI] | "Lean cut-line frozen" / 6.1 |

## Negative / boundary criteria (nothing out-of-scope leaked in)

| # | Criterion | Verify | Source ruling |
|---|---|---|---|
| N1 | No `idempotency_key` UNIQUE migration or auto-retry code ships (save-retry is documentation only). | [manual] | roadmap "Council rulings" §1; A critique #1 |
| N2 | No keyed/per-consumer chunk-addressing or at-rest-encryption code ships (dedup-oracle mitigation is documentation only). | [manual] | roadmap "Council rulings" §3; A critique #7 |
| N3 | No public observability/tracing API is added to the frozen surface. | [manual] | A critique #3 |
| N4 | No foreign consumer app is imported or depended on; the smoke test uses a scratch project + Testcontainers only. | [manual][CI] | A ruling (b); MEMORY boundary |
| N5 | No chain-archive symbol, no threat-model document authoring, no supply-chain CI, no perf harness, no crash/soak test is part of this change. | [manual] | roadmap §D/§E; A ruling (e) |
