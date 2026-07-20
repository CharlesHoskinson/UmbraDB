# Tasks — postgres-jsonb-storage

Each task: implemented by a Sonnet builder, then reviewed in parallel by two
Opus auditors (spec-compliance vs `design.md`; code quality/docs/test
coverage), matching the mongo-store Plan A/B cadence (Opus review per task,
fix rounds before close). A task is CLOSED only after both auditors approve
(or their findings are fixed and re-reviewed).

## 0. Environment setup and open-decision resolution

- [ ] 0.1 Provision a local Postgres instance for development (native
  package, matching how `mongod` was installed natively rather than via the
  slow from-source Nix build — do NOT repeat that mistake for Postgres; if
  `nix develop`'s `postgresql` package has a `cache.nixos.org` binary, that's
  fine to use instead, confirm before assuming).
- [ ] 0.2 Add `postgres` (postgres.js) as a dependency in the new
  `midnight-pg-store` package; verify its actual installed `.d.ts` surface
  covers `sql.reserve()`, `sql.begin()`, and tagged-template generics as
  design.md §5/§7 assume — cite `.d.ts` file:line per
  `openspec/project.md`'s correctness rule. If a needed method is missing,
  stop and re-open §7's driver decision before proceeding.
- [ ] 0.3 Decide and record the §8 test-infrastructure choice
  (Testcontainers recommended) — add `@testcontainers/postgresql` (or the
  chosen alternative) as a devDependency, write one smoke test proving a
  real ephemeral Postgres spins up and JSONB/bytea/advisory-lock operations
  work against it.
- [ ] 0.4 Decide and record the §6 `wallet_state` TTL mechanism (`pg_cron`
  vs lazy check-on-read) — confirm `pg_cron` extension availability in the
  chosen Postgres install before committing to it.
- [ ] 0.4b Decide and record the §2 `kv_history` retention mechanism
  (`pg_cron` rolling-window delete vs monthly range-partitioning) — same
  `pg_cron` availability check as 0.4, plus confirm against the Mongo test
  suite that no `getAt` call needs to reach further back than the chosen
  retention window (added after production-precedent research found this
  was an unhandled gap, not an intentional tradeoff — see design.md §2).
- [ ] 0.5 Create the `tier1_wallet` schema (design.md §0) and run the DDL
  from design.md §2–§4, §6 inside it.

## 1. TemporalKV

- [ ] 1.1 Implement `kv_current`/`kv_history` DDL + the BEFORE UPDATE/DELETE
  trigger exactly as specified in design.md §2 (including the
  `NEW.updated_at = now()` explicit set, the zero-width-interval skip, and
  the `kv_history_range` CHECK).
- [ ] 1.2 Implement `put`/`get`/`getAt`/`listKeys` against this schema,
  matching the Mongo `temporalKv.ts` module's public API exactly (same
  method signatures, same caller-facing behavior) so call sites don't change.
- [ ] 1.3 Port `temporalKv.test.ts` and `temporalKvConformance.test.ts` (19
  tests combined per the Mongo package) — same assertions, `bytea`/`jsonb`
  syntax adjustments only. Add: a same-transaction double-write test (two
  `put`s to one key inside one `sql.begin`) proving no CHECK violation; a
  point-in-time-vs-latest boundary test at `asOf == updated_at`.
- [ ] 1.4 Confirm whether the ported Mongo suite ever exercises point-in-time
  `listKeys` (design.md §2's flagged gap) — if yes, add the history-aware
  prefix index and query; if no, note it as an accepted, documented gap.

## 2. Checkpoint chunker

- [ ] 2.1 Implement `ckpt_chunks` DDL + the
  `INSERT ... ON CONFLICT (hash) DO UPDATE SET created_at = now()` dedup
  write path from design.md §3 (NOT `DO NOTHING` — that reopens the GC race
  the review council found).
- [ ] 2.2 Port `chunker.test.ts` (5 tests) including its chunk-count
  assertions (1 chunk at exactly `CHUNK_RAW_BYTES`, 2 at 2x — carried
  forward from the Mongo package's own Task 2 audit note).

## 3. Checkpoint manifests, GC, and prune

- [ ] 3.1 Implement `ckpt_manifests` DDL + both indexes (compound
  `(w,net,complete,seq DESC)` and the GIN index on `chunk_hashes`) from
  design.md §3.
- [ ] 3.2 Implement the two-step GC (manifest prune, then chunk reclaim) in
  the exact order design.md §3 specifies, porting the real retention
  predicate from the Mongo `prune.ts` (not the `<retain_count>` placeholder
  in the design doc — resolve that placeholder here against the actual
  Mongo policy).
- [ ] 3.3 Port `prune.test.ts` and `checkpointStore.test.ts`/
  `checkpointHistory.test.ts` (4 + 5 + 6 = 15 tests). Add: a dedup-then-GC
  race test — write chunk A in manifest 1, let manifest 1 age past the
  grace window, write chunk A again (same hash) in manifest 2 inside the
  grace window, run GC, assert chunk A survives (this is the exact case the
  `DO UPDATE` fix in 2.1 exists for — a regression to `DO NOTHING` should
  fail this test).

## 4. Watermarks

- [ ] 4.1 Implement `watermarks` DDL + `set`/`get` from design.md §4.
- [ ] 4.2 Port `watermarks.test.ts` (3 tests).

## 5. Commit/transaction layer and writer lease

- [ ] 5.1 Implement `sql.begin()`-based transactions, replacing the
  standalone-vs-replset detection branch entirely (delete it, per design.md
  §5's decision — do not port a no-op version of it).
- [ ] 5.2 Implement the writer lease via `sql.reserve()` +
  `pg_advisory_lock`/`pg_advisory_unlock` on the pinned connection, exactly
  as design.md §5 specifies (this is the fix for the review council's
  BLOCKER — get this one right, it's the task most likely to need a fix
  round).
- [ ] 5.3 Port `commit.test.ts` (3 tests, standalone/replset detection tests
  become N/A — replace with: a transaction commits on success, rolls back on
  error). Add: a lease-acquire-then-release-under-pool test that would FAIL
  if `sql.reserve()` were dropped in favor of plain pooled calls (proves the
  fix is load-bearing, not just present); a concurrent-acquire test (two
  callers race for the same lease key, one blocks until the other releases).

## 6. Encrypted private-state provider

- [ ] 6.1 Implement `PgPrivateStateProvider.ts` against `private_states` +
  `signing_keys` (design.md §6), preserving the existing
  `PrivateStateProvider` interface and the AES-256-GCM +
  `superjson.stringify`/`parse` shape unchanged from `MongoPrivateStateProvider.ts`
  — only the storage sink changes.
- [ ] 6.2 Port `MongoPrivateStateProvider.test.ts` (14 tests, including the
  `conflictStrategy: skip/overwrite/error` import test) to
  `PgPrivateStateProvider.test.ts`.

## 7. Wallet state store

- [ ] 7.1 Implement `PgWalletStateStore.ts` against the NEW `wallet_state`
  table (design.md §6 — this is a distinct table from `signing_keys`, fixed
  after the review council caught the original draft conflating them; verify
  against `MongoWalletStateStore.ts`'s real field list:
  `shieldedState`/`unshieldedState`/`dustState`/`chainGenesisHash`, unencrypted,
  keyed by `(networkId, walletId)`).
- [ ] 7.2 Implement the TTL mechanism chosen in Task 0.4.
- [ ] 7.3 Port `WalletStateStore.conformance.test.ts` (13 tests) to
  `PgWalletStateStore.test.ts`. Add a TTL-expiry test appropriate to the
  chosen mechanism.

## 8. Differential state-equivalence gate

- [ ] 8.1 Implement design.md §10.4's `getAt` differential check: identical
  `put`/`getAt` operation sequence run against both the still-installed
  Mongo `temporalKv` and the new `midnight-pg-store` KV, asserting identical
  results at every shared `asOf` timestamp.
- [ ] 8.2 Implement design.md §10.4's GC differential check: identical
  checkpoint-write + GC-pass sequence against both stores, asserting
  identical surviving chunk-hash sets after each pass.
- [ ] 8.3 Opus spec-compliance auditor for Tasks 1–7 performs the line-by-line
  ported-assertion diff design.md §10.4 requires (this is a review-process
  requirement, not new production code — track it as a task so it isn't
  skipped).

## 9. Cutover: rewire and live round-trip

- [ ] 9.1 Rewire `counter-cli-additions/{ballot-preprod.ts,devnet-smoke-test.ts,
  tx-ledger.ts}` from the Mongo provider/store imports to the Postgres ones.
  `migrate-legacy-checkpoint.ts`/`migrate-legacy-private-state.ts` become
  dead code once this lands (they migrated an even-older legacy format INTO
  Mongo) — confirm and remove them here rather than leaving them stranded.
- [ ] 9.2 Run the live preprod round-trip (design.md §10.3): deploy +
  `castVote` + read back `yesVotes`, using the Postgres-backed provider
  against the funded preprod wallet, and confirm it reaches the same
  outcome the Mongo-backed path did.

## 10. Remove Mongo

Only after Task 9 is green — this is the actual cutover, do it as one
reviewed commit so it's trivially revertible if 9.2 turns out to have missed
something:

- [ ] 10.1 Delete `midnight-mongo-store/`, `examples/storage/Mongo*.ts`,
  `examples/storage/mongoClient.ts`.
- [ ] 10.2 Remove the `mongodb`/`mongodb-memory-server` npm dependencies
  repo-wide (check `midnight-mongo-store/package.json`,
  `examples/package.json`, and any other consumer found via
  `grep -r mongodb --include=package.json`).
- [ ] 10.3 Remove `mongodb` from `flake.nix`'s devShell inputs (this is the
  change that actually removes the from-source Nix build pain point —
  verify a fresh `nix develop` no longer attempts it).
- [ ] 10.4 Remove `mongod.service`/`midnight-mongod-ready.service` from
  `systemd/` and from `midnight-stack.target`'s dependency chain; verify the
  remaining self-healing stack (docker containers + whatever Postgres unit
  Task 0.1 added) still comes up clean after a `wsl --shutdown`.
- [ ] 10.5 Update `README.md`/`TOOLING.md` to describe the Postgres setup in
  place of the MongoDB section.
