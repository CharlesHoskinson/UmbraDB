# Design — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)

Implementation-level detail for the G9–G12 test layer. This change adds **no `src/` behavior**;
it verifies the observable guarantees that the correctness/durability change (G5–G8) lands, and
records the release evidence. Every fault and assertion below is grounded in the real code at
`/root/UmbraDB` (read 2026-07-23) and cites the primary reports (`02`, `01`) and adjudication
(`council/B`) by section/line.

## 0. Test-infrastructure layout

```
test/
  postgres/
    setup.ts                          (existing; extended — see §1)
    reference-merge.ts                (existing; reused as G11's reference — see §5)
    differential-equivalence.test.ts  G11 fault-schedule-vs-fault-free (this change)
  integration/
    crash/
      crash-worker.ts                 tsx child-process writer entrypoint + fault hook (§1)
      crash-harness.ts                container-restart + pg_terminate_backend + spawn/SIGKILL helpers
      process-kill-save.crash.test.ts   G9 / 02-T1
      pg-kill-save.crash.test.ts        G9 / 02-T2
      cursor-durability.crash.test.ts   G9 / 02-T5 (the keystone; synchronous_commit on & off)
      lease-nonwedge.crash.test.ts      G9 / 02-T3
    soak/
      full-sync-soak.integration.test.ts   G10 soak + GC passes (02 council item 5)
      load-under-prune.integration.test.ts  G10 retrieval-under-concurrent-GC (council item 6 / 02-T9a)
  required-tests.manifest.json          the required/deferred crash+soak test-id manifest (§1.1)
  check-required-tests.ts               post-run skip-enforcement reconciliation (§1.1)
docs/
  recovery/
    EVIDENCE.md                       G12 recorded Preprod evidence artifact (this change)
```

No new top-level `src/` directory and no production dependency — the crash worker uses `tsx`,
already a `devDependency` (`package.json` `devDependencies.tsx`), so a literal cross-process
SIGKILL is available without a new pin (unlike Sprint 8's cold-boot test, whose "fresh process"
simplification was constrained by *that sprint's* narrow pin list —
`cold-boot-recovery.integration.test.ts`'s header note — not a repo-wide limitation).

## 1. Crash harness — deterministic faults, not timing races (`council/B` §3 tooling ruling)

`02` §"Fault-injection test plan" proposes **Testcontainers + Pumba**; `council/B` §3 overrides
the Pumba half: "pumba-class tooling is a schedule sink; `pg_terminate_backend` + container kill
covers the essential faults." This design therefore uses three fault primitives only:

1. **Child-process SIGKILL** for "kill the app mid-op" (T1, T3, T5). A `tsx`-launched
   `crash-worker.ts` performs one `save` (or a co-transactional `save`+cursor advance, or holds
   one `withLease`) against the **shared** Testcontainers Postgres, using a **test-only fault
   hook** that pauses at a named point and signals readiness to the parent (a line on stdout / a
   sentinel row), whereupon the parent `SIGKILL`s it. The full hook enumeration
   (`UMBRADB_CRASH_HOOK` values) is:
   - `before-commit` — pause after the manifest INSERT is issued inside the `save` transaction but
     before it returns (T1, T2).
   - `in-critical-section` — pause inside a held `withLease` critical section (T3).
   - `after-data-commit-before-cursor` — pause after the durable data commit has returned but
     before the cursor/watermark advance is issued (T5, the safe two-transaction ordering and the
     kill point for the co-transactional path's post-data phase).
   - `after-cursor-before-data` — pause after the cursor advance but before the (deliberately
     unsafe, out-of-scope) later data commit, used only to construct the negative/reference case;
     the T5 requirement asserts the invariant on the safe ordering, not this one.
   **Determinism is mandatory:** the kill lands at a *named program point*, never on a wall-clock
   timer, so the asserted post-condition is reproducible. The fault hook is compiled only in the
   worker entrypoint and reads an env var — it never touches `src/`. (Note the lost-COMMIT-ack
   retry state of T2 is **not** producible by any timed kill — the post-commit-pre-ack window is
   not deterministically hittable — so it is constructed by a sanctioned simulation instead; see
   §2.2.)
2. **`pg_terminate_backend(pid)`** from a second connection, and **`container.restart()` /
   `container.stop()`** (Testcontainers `StartedPostgreSqlContainer`), for "kill Postgres mid-op"
   (T2) and "backend death" scenarios. The worker's backend pid is captured
   (`SELECT pg_backend_pid()`) at the fault point.
3. **`SET synchronous_commit` per session** (and, where the matrix needs it, the container started
   with `-c synchronous_commit=off`) for the T5 durability matrix.

`test/postgres/setup.ts` is extended with these helpers. It already provides the shared
session-scoped container (`startTestDatabase`/`stopTestDatabase`), `TEST_SCHEMA`, and
`registerSuiteLifecycle().connectionUri()` — the last is exactly the "own dedicated pool against
the same database" hook the crash worker and the concurrent-writer tests need (its own doc:
"a test that needs its OWN dedicated… pool… doesn't have to spin up a second container"). The
crash suite reuses that container; only the restart/terminate/spawn helpers are new.

**Termination bound (hard dependency on G7).** Every crash test must *terminate deterministically*
even when Postgres is half-dead (accepting connections, not completing queries). That requires the
server-side `statement_timeout`/`lock_timeout`/`idle_in_transaction_session_timeout` of G7 to be
set on the connection (`client.ts:125-130` today sets only `search_path` + `types.bigint` — no
timeouts). `council/B` §2 promotes G7 to P0 for exactly this reason ("every crash-recovery test
above needs bounded failure to even terminate deterministically"). This change **assumes G7
merged**. As an *independent backstop* — so a missing or misconfigured G7 timeout surfaces as a
fast typed failure rather than an indefinitely wedged CI job — the harness adds a **suite-level
watchdog timeout** (a named `SUITE_WATCHDOG_MS` constant) that fails the pending operation with a
typed timeout error if it has not completed. This backstop is a spec-level guarantee (spec
requirement "the crash and soak suites terminate within a bounded wall-clock even when Postgres is
half-dead"), not merely an implementation nicety, because a wedged required gate is itself a way
the durability guarantee ships unverified.

## 1.1 Skip-enforcement mechanism — the anti-self-skip guarantee, made a named check

The keystone premise of this change is that durability shipped unverified *because a test
self-skips*. `vitest run` does **not** fail on a skipped/`skipIf`/`todo` test by default, so
"the suite does not self-skip" cannot be left to convention — it needs a **named enforcement
mechanism** (the auditors' BLOCKING-3 / finding 2). The mechanism is a checked-in manifest plus a
post-run reconciliation:

- `test/integration/required-tests.manifest.json` lists, under `"required"`, the stable test ids
  of every non-live crash/soak test that MUST execute in the required gate (T1, T2 typed-error +
  benign-duplicate, T5 watermark-never-ahead + replay + both `synchronous_commit` legs, T3, the
  soak, load-under-prune, and the P3 anchor). Under `"deferred"` it lists the `WHERE`-gated
  optional-feature ids (the no-duplicate-on-retry scenario) that are legitimately
  `skipped-pending-feature` until their feature ships.
- `test/integration/check-required-tests.ts` runs after `vitest run` (as a `test:conformance`
  step), reads Vitest's JSON reporter output, and asserts the reporter's **executed-and-passed**
  set contains every id in `"required"`. If any required id is missing or reported skipped, it
  **exits non-zero and names the id**, failing the gate. Ids in `"deferred"` are reconciled as
  `skipped-pending-feature` and must not appear as unexplained skips; they are exempt from the
  must-execute check while their feature is unshipped.

This makes the self-skip failure mode unable to recur silently: adding a `describe.skipIf` back to
a required test turns the gate red by id, not by luck. The `WHERE`-gated idempotency scenario is
the *only* sanctioned skip, and it is enumerated in the manifest's `"deferred"` section rather than
silently tolerated — resolving the no-self-skip-vs-sanctioned-skip contradiction the auditors
flagged (finding 2 / §5).

## 2. G9 — the four crash tests

### 2.1 Process-kill mid-save (T1) — `02` §"Fault-injection test plan" T1; `council/B` §3 item 1

`saveImpl` writes all chunk rows, then allocates the sequence
(`checkpoint-store.ts:166-172`, `ON CONFLICT … SET next_seq = next_seq + 1`), then inserts the
manifest with **`complete = true` written explicitly** (`checkpoint-store.ts:175-185` — the design
note there: omitting it "would make every subsequent load/history/prune filter on complete see
zero rows"), then the junction rows — all inside **one** `withTransaction`
(`checkpoint-store.ts:149`). SIGKILL between chunk writes and the COMMIT must roll the whole
transaction back (Postgres aborts the in-flight backend's transaction on connection loss).

Fault: `UMBRADB_CRASH_HOOK=before-commit` pauses the worker after the manifest INSERT is issued
inside the transaction but before the block returns (so before COMMIT); parent SIGKILLs.
Assertions after a fresh client connects: (a) **no `complete=true` manifest at the interrupted
seq** (query `ckpt_manifests`); (b) the **prior** committed seq still `load`s and hash-verifies;
(c) **no orphaned junction rows** referencing a non-existent/incomplete manifest. This confirms
the already-good single-adapter crash-atomicity (`02` §"Cold-start": "A killed `save` leaves
nothing visible ✅") *is actually tested*, not merely asserted.

### 2.2 Postgres-kill mid-save + retry-duplication contract (T2) — `02`-T2; `council/B` §3 item 2

Fault: worker begins `save`; at `before-commit` the parent kills Postgres
(`container.restart()`, or `pg_terminate_backend` of the worker's backend pid). Assertions:
(a) the worker's in-flight `save` rejects with a **typed `ConnectionError`** — never a raw
`postgres.js` error (`errors.ts`'s `translatePostgresError` already classifies the `08*`/network
set → `ConnectionError`, `02` §"Retry/idempotency"); (b) after Postgres is back, the checkpoint is
**all-or-nothing** (either the manifest is fully present and `load`s, or fully absent — never
partial).

**Retry-duplication contract — honoring `council/B` §5 item 3 verbatim.** `save` is *not*
idempotent under a lost COMMIT-ack: a blind retry allocates a *new* seq
(`checkpoint-store.ts:166-172`; `(w,net,seq)` is not UNIQUE — `002_checkpoint_store.ts`) and
writes a duplicate manifest of identical content.

**Constructing the lost-ack state (the trigger cannot be timed).** The lost-COMMIT-ack condition
is "the transaction *committed* on the server, but the client never observed the ack." That window
— after the server COMMIT, before the client sees it — cannot be hit deterministically by
`pg_terminate_backend`/`container.restart()`/SIGKILL (`before-commit` kills *pre*-commit, which
rolls back with nothing to duplicate; no enumerated hook names the post-commit-pre-ack point). So
this scenario does **not** use a kill at all. It uses the **sanctioned simulation**: run a `save`
that *provably committed* (assert its manifest is present and `load`s), then re-invoke `save` with
**identical content**, and assert the duplicate-at-next-seq outcome. This reproduces exactly the
observable state a lost-ack retry produces, deterministically, without pretending to hit an
unhittable timing window. The assertions below are unchanged; only the trigger's construction is
specified.

Because the `idempotency_key` fix is **out of scope here** (deferred "with Sprint 9",
`ROADMAP` §Deferred; `council/B` §6), the 1.0.0 assertion is the **documented-unsafe** form:
- assert that a naive retry after the reset produces a **benign, identical-content** duplicate at
  the next seq, that `load(latest)` returns **correct bytes** either way (`council/B` §1: "`load`
  returns correct bytes regardless"), and that the **auto-retry wrapper (Sprint 9) excludes
  `save`** (a static/allowlist check that `save` is not in the retryable set);
- a `WHERE`-gated optional-feature path (spec §G9-T2, "Scenario: with the idempotency key
  present") asserts **no duplicate** — this path is skipped until the key ships, so this suite is
  ready to tighten the moment it does, without a spec rewrite.

This is the precise resolution `council/B` §3 item 2 prescribes ("a retry does not duplicate
(requires P1-2, or the assertion is 'retry is documented-unsafe and the wrapper excludes save')").

### 2.3 Crash between data and cursor — the keystone (T5) — `02`-T5; `council/B` §3 item 3; §5 item 1

This is the test the whole release turns on. `PgWatermarks.set` accepts a caller `tx`
(`watermarks.ts:42-44`), and `PgTemporalKV.put` does too — so **KV-data + cursor can co-commit
today**. `PgCheckpointStore.save` **cannot** (`checkpoint-store.ts:114-124`, class doc: "`save`/
`prune` deliberately do NOT accept a `tx` option"), so checkpoint+cursor atomicity is
**structurally impossible** until G5 (either `save(tx)` or a `saveAndAdvance` combinator) lands.
**T5 has a hard dependency on G5** and cannot pass honestly before it (`council/B` §5 item 1;
`02`-F1).

**Two definitions used by this test and reused by G10/G11 (referenced from the spec preamble):**

- **Write batch.** The harness drives the run as a sequence of numbered *write batches* — one
  harness-generated unit of sync progress, each with an associated cursor value, indexed by a
  monotonic counter the harness owns. "Every state increment up to the watermark `w`" means
  precisely "every harness-generated write batch whose cursor value ≤ `w`." Because the harness
  owns the generating schedule, this is objectively checkable (it is not a vague notion of
  "progress").
- **Current-state equality predicate.** Two databases have equal *current state* iff: (1) their
  `kv_current` rows agree on `(kind, key) → value` for every key; (2) their latest **complete**
  (`complete = true`) checkpoint manifests decode to identical payload bytes; and (3) their
  watermark rows agree on `(kind, key) → value`. The predicate **excludes** `kv_history` rows and
  every `version` column. This is the exact equality every replay-equivalence assertion in this
  change uses (T5 here, the soak in §3.1, the differential gate in §5), so "matches the reference"
  is never left undefined.

**The reference current state (how "the reference" is built).** T5's replay-convergence assertion
compares against a **reference current state** constructed by a *fault-free replay of the same
harness-generated write-batch sequence* using UmbraDB's own adapters — the identical in-repo
reference discipline G11 (§5) uses via `test/postgres/reference-merge.ts`, never an imported store.
The equality tested is the current-state equality predicate above.

Given G5, the test kills at the named `after-data-commit-before-cursor` hook — after the durable
data commit returns, around the cursor advance — exercising the co-transactional path and the
documented **safe** two-transaction ordering (data first, then cursor). A deliberately-unsafe
caller ordering (cursor before data, the `after-cursor-before-data` hook) can produce
watermark-ahead, but that is a *caller* error the storage layer cannot prevent and is **out of
scope**: the invariant is asserted for the co-transactional and safe two-transaction paths only.
The assertions:
- **Watermark is never ahead of durable data.** After the kill + restart, for the durable
  watermark value `w`, every write batch whose cursor value ≤ `w` is present in durable data
  (checkpoint/KV). The safe direction (`council/B` §1: correct data→cursor ordering yields
  watermark-*behind*-data) is the only acceptable outcome; watermark-ahead is the failure.
- **Replay converges on current state.** Resuming from the durable cursor and re-applying the
  window reproduces a current state **equal, on the current-state equality predicate, to the
  reference current state** — judged **on current state, not on history chains** (`council/B` §1's
  replay-idempotence note: `put` without `expectedVersion` is a version-bumping upsert, so replay
  writes *spurious `kv_history` rows and version gaps* versus a fault-free run — the predicate
  excludes exactly those; the history-divergence contract is documented, not asserted as equality).
- **Both `synchronous_commit = on` and `off`** (`02`-F9/T5; `council/B` §3 item 3: "Must run under
  `synchronous_commit` on and off"), as two separate scenarios (spec split). Under `off`, the
  invariant "watermark never ahead of durable data" must still hold for whatever *did* survive
  (async loses a *tail* of acknowledged commits but does not reorder within the WAL — `02`
  Sources, PG async-commit), i.e. a lost tail is acceptable, an *inverted* durability order is not.
  **The off-leg forces an unclean postmaster kill.** Killing the *client* never loses acknowledged
  async commits, and Testcontainers `stop()`/`restart()` performs a *clean*, WAL-flushing shutdown
  — so a naive off-leg would observe zero tail loss every run and never exercise the "lost tail
  acceptable" branch. To make a tail loss actually reachable, the off-leg kills the postmaster
  **uncleanly** (`SIGKILL`/`SIGQUIT`-immediate inside the container, i.e. `pg_ctl stop -m
  immediate` or an in-container `kill -9` of the postmaster), not a clean container stop. The
  invariant-preservation assertions are written fault-agnostically (zero loss also passes), so the
  test does not flake; the unclean kill is what gives the off-leg its non-vacuous claim.

### 2.4 Lease non-wedge cold start (T3) — `02`-T3; `council/B` §3 item 4

`acquireLease` pins the advisory lock to a `sql.reserve()`-reserved connection
(`transaction-lease.ts:277,287`) and records the token in the in-memory `heldLeases` map
(`:311`). A process SIGKILL drops all TCP connections; Postgres auto-releases every session-level
(class-2) advisory lock, and the in-memory map dies with the process (`02`-F4 "Good" half:
"Leases do **not** wedge across a clean process death"). Fault:
`UMBRADB_CRASH_HOOK=in-critical-section` holds a `withLease` open; parent SIGKILLs the worker.
Assertions from a fresh process: (a) a fresh `withLease` on the **same key** re-acquires
**immediately** (no wedge); (b) `pg_locks` shows the class-2 lock for that key **gone**.

**Explicitly not T4.** The fence-*violation* test (reserved connection dies while the pool stays
healthy, second writer co-enters) is **out of the required gate** (`council/B` §3 "Negotiable",
§5 item 2) — it gates the P1-1(b) routing fix, not 1.0.0. T3 verifies only the clean-death
non-wedge property, which *is* the 1.0.0 guarantee.

## 3. G10 — full-sync soak + load-under-concurrent-prune

### 3.1 Full-sync soak (`council/B` §3 item 5; `01` checklist item 3)

A sustained realistic write mix at a **declared data/concurrency envelope**, run for a bounded
duration `N`, exercising all four primitives concurrently: KV `put`s (versioned), checkpoint
`save`s at a realistic cadence, watermark `set` ticks, periodic `prune` (GC passes), and a held
`withLease`. The **envelope is declared and modest** — `council/B` §1 caps it explicitly:
"'multi-GB / 10^7 chunks' exceeds the plausible envelope of a *local wallet datastore*; benchmark
to a *declared supported envelope* (e.g. 10^5–10^6 chunks) and document the ceiling." The soak
runs at that envelope, not the 10^7 matrix that would "eat the schedule."

Assertions (`council/B` §3 item 5):

(a) **Zero invariant violations sampled during the run** (not only at the end — a mid-run sample
catches a transient divergence a final snapshot would miss). P1–P10 are fast-check *property tests*
over generated inputs (`STORAGE_ALGEBRA.md` §5); they are not directly "sampleable" against a live
soak database, so the soak samples a **named set of P1–P10-*derived*, SQL-observable state
invariants** at intervals — at minimum:
- **gapless per-key `version` sequences** (P1/P2): for each `(kind, key)` in `kv_history`, the
  `version` values form a contiguous run with no gap;
- **only `complete = true` manifests are `load`able** (C1): every manifest a `load` returns has
  `complete = true`;
- **no junction rows to a missing/incomplete manifest** (C2a): every `ckpt_manifest_chunks` row
  references a manifest that exists and (for a live checkpoint) is `complete = true`;
- **watermark ≤ max durable data** (the T5 invariant): the durable watermark never exceeds the
  maximum durable cursor value present in checkpoint/KV data.
This enumerated list is what makes "mid-run sampling is real" auditor-verifiable; the soak asserts
each at every sample point and fails on the first violation.

(b) **End state replay-equivalent.** The end state is equal, on the **current-state equality
predicate** (§2.3), to a fault-free reference run of the same input (§5's in-repo reference).

(c) **GC-pass duration recorded and bounded by a test-termination constant.** Each `prune`
(GC-pass) duration is recorded as an artifact. "Bounded" is defined **operationally**, not
vacuously: each pass must complete within a named `GC_PASS_WATCHDOG_MS` constant — a
**test-termination** bound whose only role is to fail a *wedged* pass fast. It is explicitly **not
a performance gate**: the recorded durations are the deliverable artifact, and **no** pass-rate or
latency threshold gates the release (per `ROADMAP` §D / `council/B` §3 baseline ruling). This
resolves the "any finite duration is trivially bounded" vacuity the auditor flagged (finding 4 /
§3): the checkable condition is "no pass exceeded `GC_PASS_WATCHDOG_MS`," and the durations
themselves remain a recorded, ungated artifact. The GC anti-join is the one perf item with
correctness-adjacent stakes (`council/B` §4: "the only perf item that can make a core operation
*unusable*") — the soak measures its curve to the envelope and the number is *recorded*, not gated.

**Fit to the required gate.** The soak's `N` is chosen to fit `conformance.yml`'s `timeout-minutes`
(currently 30) with the crash suite; if it cannot, it is split into a separate **still-required**
job rather than made live-gated or optional (the whole point of this change is that durability is
verified in the required gate).

### 3.2 Load under concurrent prune (`council/B` §3 item 6; `02`-T9 first half)

`load` runs one REPEATABLE READ transaction (`checkpoint-store.ts:218`, and the manifest read at
`:286`), so a concurrently-committing `prune` cannot remove chunks out of its snapshot (`02`-F5
"Safety (C2a) within a single `load` holds"). `prune` reclaims chunks
`WHERE created_at < now() - interval '15 minutes' AND NOT EXISTS (…junction…)`
(`checkpoint-store.ts:397-404`).

**A forced-interleave primitive is required — a timing race would pass vacuously.** The whole point
of this test is the REPEATABLE-READ snapshot race: `prune` must **commit its deletions inside
`load`'s open snapshot window** for the test to prove anything. Left to wall-clock timing, `prune`
may run entirely before or after `load`'s snapshot, and the test passes trivially — the exact
"samples too coarsely to catch a violation" failure this change exists to prevent (auditor
BLOCKING-2 / finding). So the test uses a **deterministic interleave primitive**: a test-only pause
point in the `load` path (between the manifest read at `:286` and the first chunk-byte read) at
which the driver, via an advisory-lock / `pg_sleep` handshake, provably lands the concurrent
`prune`'s COMMIT — i.e. the ordering is *load opens snapshot → prune deletes+commits → load reads
chunk bytes*, forced, not raced. (The pause point is test-only, in the test harness's own
`load`-driving wrapper or a compiled-in-test hook; it does not alter `src/`'s `load`.)

Test: drive `load` of a **live** checkpoint with the forced interleave above; assert `load`
**returns correct bytes** and **never yields `ChunkIntegrityError` or `ChunkMissingError`** for a
checkpoint that should survive (the snapshot protected it). **Negative control (mandatory):** apply
the *same* forced interleave to an **un-snapshotted** read path (a read issued outside `load`'s
REPEATABLE READ snapshot) whose chunk the forced `prune` reclaims, and assert that path **does**
raise `ChunkMissingError` — proving the clean `load` result is attributable to the snapshot, not to
the `prune` never having overlapped. The **clock-step half** of `02`-T9 (backward NTP step vs. the
15-minute wall-clock window) is **deferred** (`council/B` §3 item 6: "clock-step half deferrable";
§2 "Defer past 1.0.0"). The cross-transaction `history()`-then-`load()` >15-min window is a
**documentation** item (`02`-F5, `council/B` §2 P1-5), not tested here.

## 4. Boundary respected — no consumer-app import (G11/G12)

`ROADMAP` G11 and `MEMORY` "UmbraDB sync architecture boundary" forbid importing the foreign
consumer/indexer to drive equivalence — doing so would gate the release on a foreign repo and
breach the indexer-agnostic boundary. Both G11 (§5) and G12 (§6) therefore build their reference
side **from UmbraDB's own code and the live SDK fixtures already in the repo**, never from an
imported store.

## 5. G11 — differential state-equivalence, rescoped in-repo (`01` item 4; `council/B` §1; `02`-T11)

`01` checklist item 4 finds the original §10 differential gate **blocked by a missing subject**
(the Mongo store it diffed against "is not in this repo") and **entangled with M5**. The rescope
(`ROADMAP` G11; `01` item 4's own recommendation: "Given P3 already covers replay-equivalence…
formally re-scope the gate") is two-part, both in-repo:

1. **P3 replay-equivalence property (already green).** P3 (`Formal/STORAGE_ALGEBRA.md` §5,
   ~line 356: "`getAt({at:T})` equals folding the sub-sequence with `writtenAt ≤ T`") is the real
   replay-equivalence check and already runs in the required gate
   (`test/postgres/temporal-kv.property.test.ts`). The rescoped gate **names P3 as its correctness
   anchor** — no new code, but the spec records that P3 *is* the differential gate's fold-equality
   half.
2. **Fault-schedule-vs-fault-free equivalence (new).** A randomized schedule mixing the G9 faults
   (T1/T2/T5) is applied to a run; a full re-sync from durable state must produce a **current
   state equivalent to a fault-free reference run** of the same input. The reference side is a
   plain in-repo replay using UmbraDB's own adapters and the existing
   `test/postgres/reference-merge.ts` (the merge-logic reference `01` item 4 notes already
   exists) — **not** an imported engine. Equivalence is judged **on current state** (`council/B`
   §1: "the soak/differential test must compare *current state*, not history chains", because
   fault-replay legitimately diverges in `kv_history` rows/version numbers). This is `02`-T11,
   which "*depends on* F1/F2 being fixed to ever pass" — hence the **hard dependency on G5**.

## 6. G12 — Milestone-5 live round-trip, rescoped as manual pre-tag Preprod evidence (`01` §Cutover)

`01` §"Cutover" establishes that the M5 "live round-trip" AC's subject — the real consuming app
UmbraDB was extracted from — **is not in this repo**, and recommends running the differential
diff's live side **once, at cutover**, against the actual RC. `ROADMAP` G12 rescopes M5 to exactly
this: a **manual pre-tag Preprod evidence run**, not a CI gate.

Concretely: against the **release candidate** build, and gated behind `UMBRADB_LIVE_PREPROD=1`
(unchanged — real network, funded seed that must not be in CI, `package.json` `test:live`;
`preprod-db-sync.integration.test.ts` / `cold-boot-recovery.integration.test.ts` headers), run:
**sync a funded wallet to live Preprod tip → persist the envelope → kill → cold-start in a fresh,
independently-constructed object graph → `load` → resume with no full resync and no state drift**.
This reuses the **existing** `cold-boot-recovery.integration.test.ts` flow (phase A sync/persist,
phase B fresh-graph restore) against the RC, and its `MEMORY` "On-chain code → Preview/Preprod"
final-verification discipline.

The change here is **evidence recording**, not new test logic: `docs/recovery/EVIDENCE.md` captures the
run's date, RC commit/tag, the synced tip height, the durable cursor value at kill, the restored
balance/tx-history, and a pass/fail against the four M5 sub-criteria `01` §"Cutover" enumerates
(real call sites on UmbraDB — here the SDK adapter path; round-trip outcome equivalence; durability
across a real restart; **the "remove the replaced engine" clause is explicitly the consumer
project's, not this release's**, per §4's boundary). The pre-tag run is a **release checklist
step**, and the artifact is the objective evidence the roadmap's G12 requires
("with recorded evidence").

## 7. What this change deliberately does not verify (traceability of the non-goals)

- **G6 startup-durability-probe test (`02`-T12)** — belongs with G6 (durability change); G9 here
  is exactly {T1, T2, T5, T3}.
- **T4 fence-violation, T7 disk-full, T8 migration-lock-timeout, T9-clock-step, T10
  serialization-storm** — out of the required gate (`council/B` §3 "Negotiable"; §2 "Defer").
- **A perf threshold** — GC-pass duration is *recorded*, never *gated* (`council/B` §3 baseline
  ruling; `ROADMAP` §D).
- **`save` idempotency behavior beyond the documented-unsafe contract** — deferred "with Sprint 9"
  (`council/B` §5 item 3).

## 8. Dependencies and sequencing (from `ROADMAP` §"Critical path")

`ROADMAP` sequences this change as **step 4** ("G9/G10/G11 — the crash-injection + soak +
equivalence suite (**longest pole**, L effort)"), after **G5** (step 1, unblocks T5/G11) and
**G6/G7/G8** (step 2; G7 needed for bounded termination). G12 runs at **step 7** ("→ cut RC →
manual Preprod evidence run → tag 1.0.0"). This change's tasks (`tasks.md`) encode those
dependencies: the T5 and fault-schedule tests are gated behind G5's merge; the whole suite behind
G7's timeouts; G12's evidence run is the last pre-tag step. `council/B` §3's sequencing rule is
honored: **the crash-injection suite outranks the perf harness** ("do not let the L-effort harness
starve T1–T5") — the perf baseline (G13/G14) is a *separate* change and never blocks this one.

## Audit resolution

Both audits (`audit-fable.md`, `audit-opus.md`) were applied. All seven blocking findings are
resolved (none rejected); the clearly-improving non-blocking findings are also applied. The one
non-blocking note deliberately **not** actioned is recorded with its reasoning at the end.

**Blocking findings — all resolved:**

- **Fable #1 — spec heading levels** (`#### Requirement:`/`##### Scenario:` under `### G#` sections
  would not parse). Resolved: `specs/recovery-testing/spec.md` rewritten to `### Requirement:` /
  `#### Scenario:` directly under `## ADDED Requirements`, with each requirement carrying its
  `G#`/`T#` tag inside the requirement name (matching sprint-4's structure exactly).
- **Fable #2 / Opus §5 — no-self-skip vs. sanctioned skip contradiction.** Resolved: the
  suite-level requirement now carves out `WHERE`-gated optional-feature scenarios explicitly
  (reported as `skipped-pending-feature`, enumerated in the gate summary), and the skip-enforcement
  manifest (§1.1) lists them in a separate `deferred` section exempt from the must-execute check.
  Task 7.1's deliberate-skip check is scoped to non-`WHERE`-gated (required) tests only.
- **Fable #3 — missing named fault hooks.** Resolved: §1's `UMBRADB_CRASH_HOOK` enumeration now
  includes `after-data-commit-before-cursor` and `after-cursor-before-data` for T5's boundary
  (both orderings), and §2.2 specifies the sanctioned lost-COMMIT-ack **simulation** (a
  provably-committed `save` re-invoked with identical content) rather than an unhittable timed
  post-commit-pre-ack kill.
- **Fable #4 — vacuous "bounded" GC-duration assertion.** Resolved: §3.1 defines "bounded"
  operationally as a named `GC_PASS_WATCHDOG_MS` test-termination constant (explicitly not a perf
  gate; durations remain a recorded ungated artifact); the spec's soak requirement states the
  checkable condition.
- **Opus BLOCKING-1 — T5 reference current state undefined.** Resolved: §2.3 defines the
  **current-state equality predicate** (`kv_current` values + latest complete checkpoint payload +
  watermark values, excluding `kv_history`/`version`) once and states the reference is a fault-free
  replay of the same harness write-batch sequence via UmbraDB's own adapters; the spec's T5
  replay-convergence scenario names both.
- **Opus BLOCKING-2 — load-under-prune has no deterministic interleave.** Resolved: §3.2 specifies
  a forced-interleave primitive (a test-only pause point between `load`'s manifest read and its
  chunk read, with an advisory-lock/`pg_sleep` handshake landing the `prune` COMMIT inside `load`'s
  snapshot window) and a mandatory negative control confirming the un-snapshotted ordering raises
  `ChunkMissingError`.
- **Opus BLOCKING-3 — anti-self-skip guarantee has no named mechanism.** Resolved: new §1.1 defines
  the `required-tests.manifest.json` + `check-required-tests.ts` post-run reconciliation, elevated
  to a named spec requirement ("a skip-enforcement check proves every required crash test
  executed") and acceptance criterion A3, since `vitest run` does not fail on skips by default.

**Non-blocking findings — applied:**

- Enumerated the P1–P10-derived, SQL-observable soak invariants (Fable) — §3.1, spec soak
  requirement, task 5.1.
- Split the compound `synchronous_commit` on/off scenario into two scenarios (Fable/Opus) — spec T5.
- Recast G12's `WHERE` as event-driven `WHEN … before the tag …` (Fable) — spec G12.
- De-rationaled the retry-contract requirement opener; the "Because…" clause is now follow-on prose
  after the ubiquitous SHALL (Fable) — spec T2 retry requirement.
- Defined "state increment" as a harness-owned **write batch** (Fable) — §2.3, spec preamble.
- Forced an unclean postmaster kill on the `synchronous_commit = off` leg so it is non-vacuous
  (Fable) — §2.3, spec T5 off-leg scenario.
- Added the bounded-termination backstop (Opus N-1) as a named requirement + `SUITE_WATCHDOG_MS`
  constant — §1, spec, acceptance A4.
- Tightened the T5 requirement text to the **safe** (data→cursor) ordering, excluding
  caller-unsafe cursor-before-data (Opus N-2) — spec T5.
- Moved the evidence artifact from a new top-level `Recovery/` to `docs/recovery/EVIDENCE.md`
  (Fable taste note) — §0, §6, spec/tasks/acceptance.
- Cited the live-fixtures path in full (`test/integration/live-fixtures/preprod-fixtures.ts`)
  (Fable) — spec preamble.

**Non-blocking note not actioned (with reasoning):**

- Opus **N-3** ("negative controls B4/G5c live only in tasks/acceptance, not the spec") is itself
  marked by the auditor as "a note, not a defect" — negative controls are test-honesty *meta*, not
  product requirements. We nonetheless **strengthened** the spec beyond N-3's ask where a negative
  control is load-bearing for objectivity: the load-under-prune negative control (Opus BLOCKING-2)
  and the differential dropped-range negative control are now first-class `#### Scenario:` blocks in
  the spec, while the process-kill negative control (B4) remains in the acceptance table as
  honesty-meta. This keeps the spec's product requirements clean while making the two negative
  controls that *prove a requirement is non-vacuous* part of the spec itself. No finding is rejected.
