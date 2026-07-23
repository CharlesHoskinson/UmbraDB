# Tasks — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)

Each task: implemented by a builder, then reviewed in parallel by two Opus auditors — one for
spec-compliance against this change's `design.md`/`spec.md`, one for **test honesty and coverage**
(does the test actually exercise the fault, or pass by luck / by racing / by asserting a weaker
proxy than the requirement states?). A task is CLOSED only after both auditors approve, or their
findings are fixed and re-reviewed. Matches Sprint 1–4's own review cadence. Test honesty is the
dominant risk in this change (`proposal.md` §Impact), so the second auditor's remit is explicit:
a crash test that would pass even without the fault, or a soak that samples too coarsely to catch a
divergence, is a finding, not a pass.

**Critical-path dependencies (from `ROADMAP-v1.0.0-CONSOLIDATED.md` §"Critical path").** This
change is step 4 (longest pole). It has **hard external dependencies on other 1.0.0 changes**:
- **G5** (co-transactional `save`/cursor path or `saveAndAdvance`) — blocks Tasks 3 (T5) and 6
  (fault-schedule equivalence). These tasks MUST NOT be marked green before G5 is merged; until
  then they exist as known-pending, not as passing.
- **G7** (server-side `statement_timeout`/`lock_timeout`/`idle_in_transaction_session_timeout`) —
  blocks deterministic termination of every crash/soak test (Task 0 onward). The harness assumes
  G7 merged.
- **G12** runs at release step 7 (cut RC → manual Preprod evidence → tag), after this change's
  required-gate work is green.
Sequencing rule honored: the crash-injection suite (Tasks 0–4) outranks the perf harness (a
separate change) — do not let perf work starve T1–T5.

## 0. Crash harness (foundation)

- [ ] 0.1 Extend `test/postgres/setup.ts` with the three fault primitives (`design.md` §1):
  Testcontainers `container.restart()`/`container.stop()` helpers, a `pg_terminate_backend(pid)`
  helper (capturing a target backend's `pg_backend_pid()`), and a child-process spawn+SIGKILL
  helper. Reuse the existing shared session-scoped container and `registerSuiteLifecycle()
  .connectionUri()` (its documented "own dedicated pool against the same database" hook) — do NOT
  spin up a second container. **Acceptance:** a smoke test spawns the worker, kills it, and
  confirms from the parent that the container is still up and a fresh client connects; a
  `pg_terminate_backend` helper test confirms a targeted backend's connection is dropped and the
  pool recovers. **Satisfies:** the harness precondition for every G9/G10 requirement.
- [ ] 0.2 Write `test/integration/crash/crash-worker.ts` — a `tsx`-launched entrypoint that
  performs one `save` (or a co-transactional `save`+cursor advance, or holds one `withLease`)
  against the shared container, honoring a **test-only** `UMBRADB_CRASH_HOOK` env var that pauses
  at a **named program point** and signals readiness to the parent (stdout line or sentinel row),
  then blocks so the parent can SIGKILL deterministically. The full hook set (`design.md` §1) is:
  `before-commit` (T1/T2), `in-critical-section` (T3), `after-data-commit-before-cursor` (T5, safe
  ordering + co-transactional post-data phase), and `after-cursor-before-data` (T5 unsafe reference
  case only). The hook lives ONLY in this worker entrypoint and reads an env var — it MUST NOT
  touch `src/`. **Acceptance:** running the worker with each of the four hook values pauses at the
  documented point and emits its readiness signal; without the env var the worker performs an
  ordinary uninterrupted `save`; `tsc --noEmit` passes and `src/` is unchanged (verified by diff).
  **Satisfies:** the deterministic-fault precondition (`design.md` §1) for Tasks 1–4.
- [ ] 0.3 Add the **suite-level watchdog backstop** (`design.md` §1): a named `SUITE_WATCHDOG_MS`
  constant wrapping every crash/soak operation so a half-dead Postgres (accepting connections, not
  completing queries) fails the pending op with a typed timeout error rather than hanging, even if
  G7's server-side timeouts are absent/misconfigured. **Acceptance:** a fault-injection unit
  (e.g. a query against a deliberately-stalled backend) terminates within `SUITE_WATCHDOG_MS` and
  throws a typed timeout/connection error, not a hang. **Satisfies:** "the crash and soak suites
  terminate within a bounded wall-clock even when Postgres is half-dead".
- [ ] 0.4 Author `test/integration/required-tests.manifest.json` + `check-required-tests.ts` — the
  **skip-enforcement mechanism** (`design.md` §1.1). The manifest's `"required"` section lists the
  stable ids of every non-live crash/soak test that MUST execute (T1; T2 typed-error +
  benign-duplicate; T5 watermark-never-ahead + replay + both `synchronous_commit` legs; T3; soak;
  load-under-prune; P3 anchor); its `"deferred"` section lists the `WHERE`-gated optional-feature
  ids (the no-duplicate-on-retry scenario). `check-required-tests.ts` reads Vitest's JSON reporter
  output and exits non-zero, naming the id, if any `"required"` id is missing or reported skipped;
  `"deferred"` ids are reconciled as `skipped-pending-feature`. **Acceptance:** with all required
  tests green the check passes; with one required test deliberately `describe.skipIf`-skipped the
  check exits non-zero and names it; a `"deferred"` id being skipped does NOT fail the check.
  **Satisfies:** "a skip-enforcement check proves every required crash test executed, none silently
  skipped".

## 1. Process-kill mid-save (G9 / 02-T1)

- [ ] 1.1 `test/integration/crash/process-kill-save.crash.test.ts` (`design.md` §2.1). Spawn the
  worker with `UMBRADB_CRASH_HOOK=before-commit`, SIGKILL at readiness, then from a fresh client
  assert: (a) no `complete = true` manifest at the interrupted seq; (b) the prior committed seq
  still `load`s and hash-verifies; (c) no orphaned junction rows. **Acceptance:** all three
  assertions are made explicitly; the test also asserts (negative control) that WITHOUT the kill
  the same `save` produces a visible `complete = true` manifest — so a passing test proves the
  kill caused the absence, not that `save` was broken. **Satisfies:** "process-kill mid-save leaves
  no partially-visible checkpoint (T1)".

## 2. Postgres-kill mid-save + retry-duplication contract (G9 / 02-T2)

- [ ] 2.1 `test/integration/crash/pg-kill-save.crash.test.ts` (`design.md` §2.2). Worker begins
  `save`; at `before-commit` the parent kills Postgres (`container.restart()` or
  `pg_terminate_backend`). Assert: (a) the in-flight `save` rejects with `ConnectionError` (not a
  raw driver error); (b) after recovery the checkpoint is all-or-nothing; (c) `load(latest)`
  returns correct bytes. **Acceptance:** all three asserted; the `ConnectionError` assertion checks
  the typed class, not a substring. **Satisfies:** "Postgres-kill mid-save surfaces a typed error
  and stays all-or-nothing (T2)".
- [ ] 2.2 Retry-duplication contract, in its 1.0.0 documented-unsafe form (`design.md` §2.2;
  `council/B` §5 item 3). Construct the lost-COMMIT-ack state by the **sanctioned simulation**
  (`design.md` §2.2) — a `save` that provably committed (assert its manifest is present and
  `load`s), then a re-invocation with identical content — NOT a timed kill, since the
  post-commit-pre-ack window is not deterministically hittable. Assert: the retry yields a benign
  identical-content duplicate at the next seq (not corruption); `load(latest)` correct either way;
  and a **static check** that `save` is excluded from any auto-retry allowlist. Add a `WHERE`-gated
  (`it.skipIf`/feature-flag) scenario asserting **no duplicate** when a caller idempotency key is
  present — skipped until that key ships, and enumerated in the manifest's `"deferred"` section
  (Task 0.4). **Acceptance:** the benign-duplicate and wrapper-exclusion assertions run and pass at
  1.0.0; the lost-ack state is built by the documented simulation, not a kill; the no-duplicate
  scenario is present but `skipped-pending-feature`, wired to activate on the idempotency-key
  feature flag (so no spec rewrite is needed when Sprint 9 lands). **Satisfies:** "the save
  retry-duplication contract is verified in its 1.0.0 (documented-unsafe) form".

## 3. Crash between data and cursor — the keystone (G9 / 02-T5)  ⟵ depends on G5

- [ ] 3.1 `test/integration/crash/cursor-durability.crash.test.ts` (`design.md` §2.3). **Blocked on
  G5.** Kill at the `after-data-commit-before-cursor` hook — after the data commit, around the
  cursor advance — exercising the co-transactional path and the **safe** two-transaction ordering
  (data→cursor); the unsafe cursor-before-data ordering is out of scope. Assert: (a) the durable
  watermark is never ahead of durable data (every write batch with cursor ≤ durable watermark is
  present in durable data); (b) replay from the durable cursor converges on the correct **current
  state**, compared against a **fault-free reference** replay of the *same harness write-batch
  sequence* built from UmbraDB's own adapters, using the **current-state equality predicate**
  (`kv_current` values + latest complete checkpoint payload + watermark values; NOT `kv_history`/
  version, per `council/B` §1's replay-idempotence note). **Acceptance:** both (a) and (b) asserted;
  the reference construction and the equality predicate are explicit in the test; the
  current-state-only judgment is explicit (a comment states why history divergence is tolerated);
  the test does not pass before G5 is merged (marked pending, not green, until then). **Satisfies:**
  "a crash between data and cursor never leaves the watermark ahead of durable data (T5)" — the
  watermark-never-ahead and replay-convergence scenarios.
- [ ] 3.2 `synchronous_commit` matrix (`design.md` §2.3; `council/B` §3 item 3) — **two separate
  scenarios**, `on` and `off`. Run 3.1's fault under each. Assert the "watermark never ahead of
  durable data" invariant in both; the `off` leg forces an **unclean postmaster kill**
  (`pg_ctl stop -m immediate` / in-container `kill -9` of the postmaster, NOT a clean container
  stop) so a tail loss is actually reachable and the leg is non-vacuous; treat a lost *tail* of
  acknowledged commits as acceptable but an *inverted* durability order as a failure.
  **Acceptance:** both configurations run as distinct scenarios (not just one); the `off` case uses
  an unclean kill and documents+asserts the tail-loss-acceptable / order-inversion-fails
  distinction. **Satisfies:** "the invariant holds under synchronous_commit = on" and "… = off".

## 4. Lease non-wedge cold start (G9 / 02-T3)

- [ ] 4.1 `test/integration/crash/lease-nonwedge.crash.test.ts` (`design.md` §2.4). Worker holds a
  `withLease` (`UMBRADB_CRASH_HOOK=in-critical-section`); parent SIGKILLs it. From a fresh process
  assert: (a) a fresh `withLease` on the same key acquires immediately (no wedge/timeout);
  (b) `pg_locks` shows the class-2 advisory lock for that key gone. **Acceptance:** both asserted;
  the re-acquire assertion bounds its own wait so a wedge fails fast rather than hanging the suite.
  Explicitly out of scope: the T4 fence-violation test (`council/B` §3 "Negotiable"). **Satisfies:**
  "a killed lease-holder does not wedge the lease (T3)".

## 5. Full-sync soak + load-under-concurrent-prune (G10)

- [ ] 5.1 `test/integration/soak/full-sync-soak.integration.test.ts` (`design.md` §3.1;
  `council/B` §3 item 5). Sustained concurrent mix (KV puts + checkpoint save cadence + watermark
  ticks + periodic `prune` + held lease) for a bounded duration at a **declared envelope**
  (10^5–10^6 chunks, per `council/B` §1 — NOT 10^7). Assert: (a) a **named set of
  P1–P10-derived, SQL-observable invariants** sampled **during** the run never fails — at minimum
  gapless per-key `version` sequences (P1/P2), only `complete = true` manifests `load`able (C1), no
  junction rows to a missing/incomplete manifest (C2a), watermark ≤ max durable data (T5
  invariant); (b) the end state equals a fault-free reference on the **current-state equality
  predicate**; (c) each GC-pass duration is recorded as an artifact and completes within a named
  `GC_PASS_WATCHDOG_MS` **test-termination** constant — **no pass-rate/latency threshold gates the
  release** (`ROADMAP` §D). **Acceptance:** the declared envelope, duration, and
  `GC_PASS_WATCHDOG_MS` are named constants in the test; the sampled-invariant set is enumerated in
  code (not a vague "P1–P10 hold"); mid-run sampling is real (asserted at intervals, not only at
  teardown); the GC-duration artifact is written; the test fits `conformance.yml`'s
  `timeout-minutes` (or is split into a separate **still-required** job — never made live-gated or
  optional). **Satisfies:** "a full-sync soak runs at a declared envelope with GC passes and holds
  every invariant".
- [ ] 5.2 `test/integration/soak/load-under-prune.integration.test.ts` (`design.md` §3.2;
  `council/B` §3 item 6). Drive `load` of a live checkpoint concurrently with `prune`, using the
  **forced-interleave primitive** (`design.md` §3.2): a test-only pause point between `load`'s
  manifest read and its first chunk-byte read, with an advisory-lock/`pg_sleep` handshake that
  provably lands the `prune` COMMIT inside `load`'s open REPEATABLE READ snapshot window — NOT a
  wall-clock race (which could run `prune` entirely before/after the snapshot and pass vacuously).
  Assert `load` returns correct bytes and never raises `ChunkIntegrityError`/`ChunkMissingError`
  for a checkpoint that should survive. **Negative control (mandatory):** the same forced
  interleave applied to an **un-snapshotted** read of a reclaimed chunk DOES raise
  `ChunkMissingError` — proving the clean `load` is attributable to the snapshot, not to a
  non-overlapping `prune`. The clock-step half of 02-T9 is deferred. **Acceptance:** the interleave
  is forced and verified (the `prune` COMMIT provably lands mid-snapshot, not sequential); the
  survive-set is defined explicitly (which seqs must not be pruned); the negative control fires;
  clock-step is documented as deferred, not silently omitted. **Satisfies:** "load during a
  concurrent prune never corrupts a live checkpoint's retrieval".

## 6. Differential state-equivalence gate, rescoped in-repo (G11)  ⟵ fault-schedule half depends on G5

- [ ] 6.1 Record P3 as the differential gate's replay-equivalence anchor (`design.md` §5;
  `01` checklist item 4). No new test code — P3 already runs in the required gate
  (`test/postgres/temporal-kv.property.test.ts`); this task documents (in the change's spec/gate
  notes) that P3 satisfies the fold-equivalence half **without importing the replaced store**.
  **Acceptance:** the gate documentation names P3 explicitly and states the no-import rationale;
  P3 is confirmed green in the required gate. **Satisfies:** "the differential gate is anchored on
  the P3 replay-equivalence property".
- [ ] 6.2 `test/postgres/differential-equivalence.test.ts` (`design.md` §5; `02`-T11). **Fault-
  schedule half — blocked on G5.** Apply a randomized schedule mixing the G9 faults (T1/T2/T5);
  re-sync from durable state; assert the resulting current state is equivalent to a fault-free
  reference run of the same input, using an **in-repo** reference (`test/postgres/
  reference-merge.ts`) — no foreign consumer/indexer import. Judge on current state only.
  **Acceptance:** the reference side imports nothing outside the repo (verified by import audit);
  equivalence is on current state with history-divergence tolerated and commented; the test does
  not pass before G5. A negative control confirms the check would FAIL if a fault genuinely dropped
  a range (inject a deliberately-broken variant and confirm the assertion fires). **Satisfies:**
  "a fault-schedule run is state-equivalent to a fault-free reference (T11)" and "the differential
  gate imports no foreign consumer application".

## 7. CI gate wiring

- [ ] 7.1 Wire the crash, soak, and differential suites into the required gate
  (`.github/workflows/conformance.yml` / `package.json` `test:conformance`) so they run with
  `UMBRADB_LIVE_PREPROD` unset and **do not self-skip** (`design.md` §0; `01` checklist item 3's
  finding that today's recovery test self-skips), and add the `check-required-tests.ts` (Task 0.4)
  post-run reconciliation as a `test:conformance` step. The deliberate-skip check operates over the
  manifest's `"required"` (non-`WHERE`-gated) ids only — the `"deferred"` optional-feature ids
  (idempotency-key no-duplicate scenario) are expected `skipped-pending-feature` and MUST NOT fail
  the gate. Re-evaluate `timeout-minutes: 30` against the soak; split into a separate required job
  if needed. **Acceptance:** a required-gate run shows the new suites as run-and-passed (not
  skipped) with `UMBRADB_LIVE_PREPROD` unset; the workflow's timeout accommodates the soak; a
  deliberately-introduced skip of a **required** crash test is caught by `check-required-tests.ts`
  (the gate goes red naming the id), while a skipped `"deferred"` scenario does NOT fail the gate —
  so the "self-skip = ships unverified" failure mode (`proposal.md` §Why) cannot recur silently and
  the sanctioned optional-feature skip does not turn the gate red on itself. **Satisfies:** "the
  crash-injection suite runs in the required gate and does not self-skip" and "a skip-enforcement
  check proves every required crash test executed, none silently skipped".

## 8. G12 — manual pre-tag Preprod evidence run  ⟵ release step 7, against the RC

- [ ] 8.1 `docs/recovery/EVIDENCE.md` template (`design.md` §6; `01` §"Cutover"): the recorded fields —
  run date, RC commit/tag, synced tip height, durable cursor value at kill, restored
  balance/tx-history, pass/fail per M5 sub-criterion, and the explicit note that "remove the
  replaced engine" is the consumer project's clause. **Acceptance:** the template enumerates every
  field the G12 evidence-artifact requirement lists. **Satisfies:** "the run's evidence is recorded
  as a release artifact".
- [ ] 8.2 Run the manual pre-tag Preprod round-trip against the RC (`design.md` §6;
  `package.json` `test:live`, `UMBRADB_LIVE_PREPROD=1`): sync a funded wallet to live Preprod tip →
  persist envelope → kill → cold-start in a fresh object graph → resume, reusing the existing
  `cold-boot-recovery.integration.test.ts` flow against the RC. Fill in `docs/recovery/EVIDENCE.md`
  with the captured output. **Acceptance:** the run resumes from the durable cursor with no full resync
  and no drift; `EVIDENCE.md` is filled with real captured values; this run is NOT part of the
  required gate (confirmed: `test:conformance` stays green without a network/seed/wallet checkout).
  **Satisfies:** "a manual pre-tag Preprod round-trip is run against the RC with recorded evidence",
  "the pre-tag run resumes from the durable cursor with no resync or drift", and "the evidence run
  is not a required CI gate".

## 9. Change close-out

- [ ] 9.1 Whole-change differential review: an Opus auditor re-reads this proposal/design/spec
  against the actual committed tests and confirms every "Acceptance" criterion above was actually
  checked — a green CI run is not sufficient evidence on its own, per every prior sprint's
  close-out standard, and is *especially* insufficient here where the risk is tests that pass for
  the wrong reason. **Acceptance:** the auditor confirms each crash test has a negative control (it
  would fail without its fault), the load-under-prune and differential negative controls (5.2, 6.2)
  actually fire, the soak samples its enumerated invariants mid-run, the skip-enforcement check
  (0.4/7.1) catches a deliberately-skipped required test while tolerating the `"deferred"` scenario,
  and the G5-dependent tests (3.1, 3.2, 6.2) are correctly gated on G5's merge.
- [ ] 9.2 Update `ROADMAP.md`'s 1.0.0 gate: mark G9, G10, G11 done (required-gate green) and record
  G12 as "evidence run pending RC / recorded at tag". Note that the perf baseline (G13/G14) and the
  API-surface freeze (G1–G4) are separate changes this one does not close. **Acceptance:** the
  roadmap reflects exactly what this change delivered — no over-claim that the whole testing
  milestone or the release is complete.
