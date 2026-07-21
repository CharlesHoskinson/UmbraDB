# Tasks — Sprint 4: Watermarks

Each task: implemented by a Sonnet builder, then reviewed in parallel by two Opus auditors
(spec-compliance against this change's `design.md`; code quality/docs/test coverage). A task is
CLOSED only after both auditors approve, or their findings are fixed and re-reviewed. Matches
Sprint 1-3's own review cadence.

## 0. Schema

- [ ] 0.1 Write `src/postgres/migrations/003_watermarks.ts` (`design.md` §1/§9): the single
  `watermarks` table, schema-qualified via `sql(schema)`, with `WITH (fillfactor = 90)` and the
  `updated_at DEFAULT now()` intra-transaction-caveat comment. Add the migration to
  `src/postgres/migrate.ts`'s `migrations` array. **Acceptance:** after `runMigrations`, the table
  exists with exactly the columns/PK `design.md` §1 specifies (verified via
  `information_schema`, not just "the migration didn't error"); a test asserts the table's
  `reloptions` (via `pg_class.reloptions` or `SHOW (fillfactor)` equivalent) actually includes
  `fillfactor=90` — a schema-shape regression here would silently drop the HOT-eligibility fix
  `design.md` §1 makes; a test asserts no index exists on `value` or `updated_at` beyond the
  primary key (`design.md` §1's hard invariant), so a future migration can't accidentally violate
  it without at least one existing test needing to change.
- [ ] 0.2 **HOT-update regression test, direct SQL level.** Insert a `watermarks` row, then
  `UPDATE` it in place (same `kind`/`key`, different `value`) many times (e.g. 50) in a loop,
  using **fixed-size `value`s across the whole loop** (same serialized byte length every
  iteration — a growing value forces page-growth non-HOT fallbacks that have nothing to do with
  the `fillfactor` setting under test), and assert via `pg_stat_user_tables` (`n_tup_hot_upd` vs
  `n_tup_upd` for this table) that `fillfactor=90` actually delivers HOT updates in practice, not
  just that the reloption is present. Two known non-determinism sources MUST be handled
  explicitly, not assumed away: (a) Postgres's cumulative statistics system does not guarantee
  immediate visibility after commit — the test SHALL call `pg_stat_force_next_flush()` (PG15+,
  which the Testcontainers image satisfies) and then poll `pg_stat_user_tables` until the
  `n_tup_upd` delta reaches the update count issued (bounded retry loop, not a single
  read-after-commit); (b) an individual update can legitimately fall back to non-HOT as a page
  fills, so an exact ratio of 1 is not guaranteed run-to-run even when the fix works.
  **Acceptance:** the test reads `pg_stat_user_tables` before the loop, performs the
  flush-and-poll settle step above after it, and asserts `n_tup_hot_upd` accounts for **at least
  90% of the `n_tup_upd` delta** — tolerance justified explicitly: with fixed-size values and
  `fillfactor=90`'s 10% per-page slack, occasional page-local non-HOT fallbacks are legitimate,
  but a sub-90% ratio at this row count means HOT is not actually engaged. The initial insert is
  excluded from the calculation entirely (it is not an `UPDATE` and is never HOT by definition),
  not folded into an unquantified "tolerance."

- [ ] 0.3 **Interface doc-only change** (`design.md` §4): add a TSDoc note to
  `src/interfaces/watermarks.ts`'s `WatermarkValue`/`WatermarkValueSchema` documenting the
  large-integer-as-decimal-string convention (values that could exceed
  `Number.MAX_SAFE_INTEGER` MUST be encoded as a decimal string, not a bare JSON number),
  cross-referencing this design's §4 rationale. **No type or schema change** — this is
  documentation only, since narrowing the shared `WatermarkValueSchema` itself would also affect
  `TemporalKV`, out of this sprint's scope (`design.md` §4's own reasoning). **Acceptance:** the
  added doc comment states the convention and cites the reasoning (Postgres preserves full
  precision, the JS driver's `JSON.parse` does not); no test needed for a documentation-only
  change, but `tsc --noEmit` must still pass (confirming the comment didn't break anything
  syntactically adjacent).

## 1. `set`

- [ ] 1.1 Implement `PgWatermarks.set` (`design.md` §2) against `src/interfaces/watermarks.ts`
  exactly, composing `resolveTransaction` for `opts.tx` (not `withTransaction` — this module opens
  no transaction of its own, `design.md` §6). **Acceptance:** `tsc --noEmit` passes with
  `PgWatermarks implements Watermarks`; a test calls `set` with an invalid value (e.g. a value
  containing a `bigint`) and confirms `ValidationError` with no row written; a test calls
  `set(kind, key, null)` — `null` as the entire value, which passes `WatermarkValueSchema` but
  would otherwise be bound as a wire-protocol SQL NULL against the `NOT NULL` column — and
  confirms it rejects with `ValidationError`, specifically NOT `UnrecognizedPostgresError` or a
  raw SQLSTATE 23502 error, with no row written (`design.md` §2's top-level-null guard, an
  application-level check, not a schema change); a test calls
  `set(kind, key, v)` twice with the identical `v` and confirms exactly one row exists for
  `(kind, key)` afterward, not two.
- [ ] 1.2 **Non-object JSON root test** (`design.md` §2's `sql.json()` requirement, the spec's
  round-trip requirement): call `set` with a bare number and, separately, a bare string as the
  entire `value`, and confirm `get` returns each exactly. Additionally, exercise `design.md` §4's
  large-integer convention with its recommended encoding: `set(kind, key, "9007199254740993")`
  (a decimal-string encoding of a value above `Number.MAX_SAFE_INTEGER`) must round-trip through
  `get` digit-for-digit exactly — proving the documented mitigation for the proposal's own named
  #1 risk actually works, without re-proving the bare-number precision-loss failure mode itself
  (that is established Node.js `JSON.parse` behavior, not this project's bug). **Acceptance:**
  all three cases pass without
  a type-inference error from the driver (the specific failure mode `design.md` §2 cites,
  `porsager/postgres#386`) — a regression here would mean `sql.json()` was dropped from the
  implementation — and the decimal-string case asserts exact string equality, digit for digit.
- [ ] 1.3 **Transaction participation test** (`design.md` §6, the spec's tx-handle requirement):
  open a transaction via `PgTransactionLeaseLayer.withTransaction`, call `set` with that
  transaction's handle as `opts.tx`, and confirm `get` — called with the SAME handle, before the
  transaction commits — sees the just-set value. Separately, confirm a `set` inside a transaction
  that is then rolled back leaves no trace visible to a `get` outside that transaction afterward.
  **Acceptance:** both the same-handle-visibility and rollback assertions above are made
  explicitly; additionally, a test calls `set` and, separately, `get` with (a) a
  `TransactionHandle` whose transaction has already ended (committed or rolled back) and (b) a
  fabricated handle object that never named a live transaction, and confirms each rejects with
  `TransactionHandleInvalidError` with no statement issued — the contract
  `src/interfaces/transaction-lease.ts` documents for every `opts.tx`-accepting storage-layer
  method, and the spec's stale-or-fabricated-handle scenario.

## 2. `get`

- [ ] 2.1 Implement `PgWatermarks.get` (`design.md` §3) against `src/interfaces/watermarks.ts`
  exactly. **Acceptance:** a test calls `get` for a `(kind, key)` pair that was never `set` and
  confirms the call resolves `undefined`, not an error; a test calls `set` three times in
  sequence for one `(kind, key)` and confirms `get` returns exactly the third (most recent) value;
  a test confirms `get` for one `(kind, key)` is unaffected by `set` calls to a different `kind`
  or a different `key` (three independent pairs, cross-check each resolves only its own value);
  a test writes an object-shaped value under a `kind` and reads it back via `get<T>` with a
  deliberately mismatched `T` (e.g. `get<number>`), confirming the stored value comes back
  exactly as written with no `ValidationError` or other runtime type error — the regression
  guard for the interface's documented "type lie, not a runtime error" caller-assertion contract
  (the spec's mismatched-`T` requirement; `design.md` §3's no-read-side-validation note).

## 3. Cancellation and errors

- [ ] 3.1 **Cancellation (`opts.signal`) coverage** (`design.md` §7, the spec's `AbortError`
  requirement): for both `set` and `get`, calling with an already-aborted signal rejects with
  `AbortError` and issues no statement; separately, aborting the signal after the call has already
  begun does NOT interrupt it — the call completes its ordinary outcome (matching Sprint 3's
  corrected understanding of `withAbort`'s pre-check-only contract, not the mid-flight-cancellation
  claim that sprint's earlier draft made and later corrected). **Acceptance:** both assertions are
  made explicitly for both methods, not just one.
- [ ] 3.2 **Connection-failure translation test** (`design.md` §8): force a connection failure
  (e.g. an invalid connection string, matching the existing pattern in `migrate.test.ts`/
  `temporal-kv.test.ts`) and confirm `set`/`get` reject with `ConnectionError`, not a raw
  `postgres.js` error. **Acceptance:** both methods are asserted separately, not just one; the
  `get` case asserts *rejection* with `ConnectionError` — not resolution with `undefined`, which
  is reserved for a missing cursor on a healthy connection (the spec's get-specific
  connection-failure scenario); and no new SQLSTATE translation is added to `src/postgres/
  errors.ts` — this task only exercises the ALREADY-generic connection-failure path
  `translatePostgresError` provides, per `design.md` §8's conclusion that this module needs no
  new mapping.

## 4. Property test (`Formal/STORAGE_ALGEBRA.md` §5)

- [ ] 4.1 P9 (Law W1): `fast-check` property — `get` after N random `set`s to one key returns the
  last value; `set` of an equal value twice in a row is indistinguishable from `set` once (same
  resulting row, same returned value). **Acceptance:** the property test asserts both halves of
  P9's stated definition explicitly (last-value-wins AND idempotent-repeat-is-indistinguishable),
  not just one, matching `Formal/STORAGE_ALGEBRA.md` §5's own two-part wording for P9. The
  idempotent-repeat assertion MUST be made only on `get`'s return value and the `(kind, key)`
  row count — do NOT assert `updated_at` stability: `updated_at` DOES change on a repeated `set`
  (`design.md` §2's `DO UPDATE SET ... updated_at = now()`), which is unobservable through the
  public interface (nothing exposes `updated_at`) and therefore does not violate Law W1's
  "indistinguishable" claim; a test asserting it freezes would fail against a correct
  implementation.

## 5. Sprint close-out

- [ ] 5.1 Whole-sprint differential review: an Opus auditor re-reads this proposal/design against
  the actual committed code and confirms every "Acceptance" criterion above was actually checked
  — a CI run passing is not sufficient evidence on its own, per every prior sprint's close-out
  standard.
- [ ] 5.2 Update `ROADMAP.md`'s Milestone 2 checklist (mark Watermarks done — this completes
  Milestone 2's module-implementation checklist; the differential state-equivalence gate
  `ROADMAP.md`'s Milestone 2 intro prose mentions is a Milestone 3 checklist item, tracked
  there, and is not claimed here) and `design/tasks.md`'s phase-map table (mark the §4 row
  superseded) so the roadmap doesn't drift from what's actually been built.
- [ ] 5.3 Per this repo's `CLAUDE.md`: re-run `graphify --update` against the repo root and commit
  the refreshed `graphify-out/` outputs in this close-out commit, so the knowledge graph doesn't
  silently drift stale behind this sprint's new openspec change and code.
