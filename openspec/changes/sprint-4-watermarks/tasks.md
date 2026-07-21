# Tasks — Sprint 4: Watermarks

Each task: implemented by a Sonnet builder, then reviewed in parallel by two Opus auditors
(spec-compliance against this change's `design.md`; code quality/docs/test coverage). A task is
CLOSED only after both auditors approve, or their findings are fixed and re-reviewed. Matches
Sprint 1-3's own review cadence.

## 0. Schema

- [ ] 0.1 Write `src/postgres/migrations/003_watermarks.ts` (`design.md` §1/§9): the single
  `watermarks` table, schema-qualified via `sql(schema)`, with `WITH (fillfactor = 90)` and the
  `updated_at DEFAULT now()` intra-transaction-caveat comment. Add the migration to
  `src/postgres/migrate.ts`'s `migrations` array. **Also do the citation re-verification design.md
  §1 hedges on but this task previously never actually required** (Codex's audit noted the gap
  between the promise and the acceptance criteria): before finalizing this task, confirm the
  Debezium/Sui/Aptos file paths and the Midnight indexer's `spo_stake_refresh_state` table
  (design.md §1) still resolve against freshly-fetched upstream source, and record either "matches
  as cited" or what changed, in this file or a follow-up commit — matching `design/design.md`
  §2's own precedent for this kind of external claim. **Acceptance:** after `runMigrations`, the
  table exists with exactly the columns/PK `design.md` §1 specifies (verified via
  `information_schema`, not just "the migration didn't error"); a test asserts the table's
  `reloptions` (via `pg_class.reloptions` or `SHOW (fillfactor)` equivalent) actually includes
  `fillfactor=90` — a schema-shape regression here would silently drop the HOT-eligibility fix
  `design.md` §1 makes; a test asserts no index exists on `value` or `updated_at` beyond the
  primary key (`design.md` §1's hard invariant), so a future migration can't accidentally violate
  it without at least one existing test needing to change.
- [ ] 0.2 **HOT-update regression smoke test against the real `watermarks` table** (**revised a
  second time, after actually building and running the two-table differential-comparison version
  Codex's audit called for**: that version was implemented exactly as specified — two scratch
  tables, `fillfactor=90` vs. the default `100`, 200 filler rows each, 50 fixed-size `UPDATE`
  iterations on a pinned connection, the bounded `pg_stat_force_next_flush()`-and-poll settle
  step — and it ran successfully against real Postgres, but produced `ratio90 === ratio100 ===
  1` every time: Postgres's HOT pruning reclaims a row's own prior tuple version efficiently once
  a couple of update cycles have run, regardless of how much per-page slack `fillfactor` reserved
  at insert time, so the causal isolation this task originally called for does not reproduce in a
  short, deterministic, single-connection benchmark. Forcing the counterfactual open (e.g. via
  much larger data volumes or genuinely concurrent multi-row page pressure) would stop this being
  a fast, CI-safe test. **Accepted as a documented limitation**, not silently dropped: `fillfactor
  = 90`'s value here rests on Postgres's own cited documentation/guidance (`design.md` §1), not on
  an independently-reproduced differential proof in this suite.). Instead: `set` a single
  `(kind, key)` on the REAL `watermarks` table (its actual `fillfactor=90`, via the ordinary
  `PgWatermarks` adapter, not a scratch table) 50 times in a fixed-size loop, using the same
  bounded `pg_stat_force_next_flush()`-and-poll settle step as before. **Acceptance:** the
  resulting `n_tup_hot_upd`/`n_tup_upd` ratio is at least 0.9 — a meaningful regression check on
  its own (it WOULD catch a future index accidentally added on `value` or `updated_at`,
  `design.md` §1's hard invariant, since any such index defeats HOT entirely regardless of
  `fillfactor`), explicitly NOT claimed to isolate `fillfactor=90`'s own specific causal
  contribution versus the default. The initial insert is excluded from the calculation (never HOT
  by definition).

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
  `(kind, key)` afterward, not two. **Tightened per Codex's audit — "no row written" alone is a
  weaker proxy than spec.md's own promised "before issuing any database statement" and could pass
  even if a query round-trip happened before the rejection:** for both the `bigint`-value and the
  `null`-value cases, additionally assert no statement was issued at all — e.g. via a test-only
  connection wrapper/spy counting queries issued on the pool, asserting the count is unchanged
  across the rejected call. If no such instrumentation point is practical against this project's
  actual `sql`/`postgres.js` usage, that limitation must be recorded explicitly in the test's own
  comment (state which of the two guarantees — "no row persisted" vs. "no statement issued" — is
  actually being verified), not silently treated as equivalent.
- [ ] 1.2 **Non-object JSON root test** (`design.md` §2's `sql.json()` requirement, the spec's
  round-trip requirement): call `set` with a bare number and, separately, a bare string as the
  entire `value`, and confirm `get` returns each exactly. **Acceptance:** both cases pass without a
  type-inference error from the driver (the specific failure mode `design.md` §2 cites,
  `porsager/postgres#386`) — a regression here would mean `sql.json()` was dropped from the
  implementation.
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
- [ ] 1.4 **Large-integer convention pair, made actually diagnostic** (**corrected per Codex's
  audit, which found the original single decimal-string round-trip test redundant with 1.2's
  plain bare-string case — a quoted decimal string never gets numerically coerced regardless of
  its digit count, so that test alone proves nothing specific to the large-integer risk it claims
  to guard**). Two tests, together, not one:
  (a) `set(kind, key, "9007199254740993")` (a decimal-string encoding of a value above
  `Number.MAX_SAFE_INTEGER`) round-trips through `get` digit-for-digit exactly — this establishes
  the recommended mitigation is at least mechanically sound (still redundant with 1.2's string
  case at the driver level, kept here only because it's the artifact a reader of `design.md` §4
  would expect to find tested alongside its neighbor);
  (b) **the actual diagnostic**: `set(kind, key, 9007199254740993)` — the SAME value as a bare
  JSON *number*, not a string — and confirm `get` returns `9007199254740992` (the silently
  corrupted, precision-lost value `design.md` §4 documents), NOT the original value. This is the
  executable proof of the exact failure mode the convention exists to avoid; without it, nothing
  in this test suite demonstrates the risk is real, only that the workaround round-trips (which
  any string does). **Acceptance:** (a) asserts exact string equality, digit for digit; (b)
  asserts the returned number is exactly `9007199254740992`, documenting the real precision loss
  as an executable fact rather than an assumed one — if a future Node.js/postgres.js
  version somehow stopped exhibiting this, this test failing would be a signal worth investigating,
  not a regression to silently paper over.

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
  Milestone 2's four-module checklist) and `design/tasks.md`'s phase-map table (mark the §4 row
  superseded) so the roadmap doesn't drift from what's actually been built. **Corrected per
  Codex's audit, which found the prior wording understated `ROADMAP.md`'s own framing**: the
  differential state-equivalence gate is explicitly tagged "(Milestone 2/3)" in `ROADMAP.md`'s own
  1.0.0 acceptance checklist (not purely a Milestone 3 item), and Milestone 2's own intro prose
  frames that gate as a precondition for considering *any* module in this checklist genuinely
  "done" ("not just 'its own tests pass,' but verified equivalent to the reference behavior it's
  replacing") — do not word this close-out as "Milestone 2 is entirely complete" without also
  noting that the differential gate itself (jointly owned by Milestones 2 and 3, not resolved by
  this or any single sprint) remains open. State plainly: this sprint completes the fourth and
  final module's own implementation; the cross-cutting differential-equivalence gate that
  Milestone 2's own prose ties to "done" is separately tracked and still outstanding.
- [ ] 5.3 Per this repo's `CLAUDE.md`: re-run `graphify --update` against the repo root and commit
  the refreshed `graphify-out/` outputs in this close-out commit, so the knowledge graph doesn't
  silently drift stale behind this sprint's new openspec change and code.
