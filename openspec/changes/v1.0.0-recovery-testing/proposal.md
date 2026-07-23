# Proposal — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)

> **Status:** Proposed for the 1.0.0 program. Change id `v1.0.0-recovery-testing`, capability
> `recovery-testing`. This is the **testing gate** (roadmap gate items **G9–G12**) — the "long
> pole" of the 1.0.0 milestone (`ROADMAP-v1.0.0-CONSOLIDATED.md` §"Critical path", step 4).

## Why

UmbraDB's single most important product guarantee is **"a resumed sync continues from the last
durable checkpoint/watermark with no gap and no divergence"** — and today that guarantee ships
**unverified in the required merge gate**. The only crash-recovery tests that exist
(`test/integration/cold-boot-recovery.integration.test.ts`,
`test/integration/preprod-db-sync.integration.test.ts`) are **live-gated behind
`UMBRADB_LIVE_PREPROD=1`** (`test/integration/live-fixtures/preprod-fixtures.ts`'s
`LIVE_PREPROD_ENABLED`), run
only via `npm run test:live`, and **self-skip via `describe.skipIf`** in the required gate. The
required gate (`.github/workflows/conformance.yml` → `npm run test:conformance` → `vitest run`)
therefore says nothing about durability under failure: it runs the P1–P10 property tests, which
by construction exercise **no faults at all** (`Facet 02` §"Fault-injection test plan": "P1–P10
cover algebraic correctness under *no* faults; T1–T12 are the missing *failure*-path layer"). A
1.0.0 storage library whose core durability guarantee rests entirely on an env-gated test that
never runs in CI is not a 1.0.0 (`council/B` §1: this "elevates the Testcontainers crash-injection
suite from nice-to-have to the release gate itself").

This change is grounded in the two primary evidence reports for the reliability facet —
`02-reliability-hardening.md` (its concrete T1–T12 fault-injection plan) and
`01-feature-completeness.md` (checklist items 3, 4, 6) — as adjudicated by `council/B`
(Engineering Correctness, Reliability & Performance Risk), whose §3 "minimal verification set that
MUST be green for 1.0.0" is the authoritative list this change implements. Every requirement below
maps to a numbered item in `council/B` §3 or a T# in `02` §"Fault-injection test plan".

**Headline framing, stated up front (from `02` bullet 5, endorsed by `council/B` §1):** the
crash-atomicity of each *individual* adapter is already good — migrations are DDL-transactional,
`save` is one transaction with `complete=true` written explicitly, single-object writes are
MVCC-atomic. **The untested surface is the *boundary between adapters* and the recovery/retry
story** — precisely the co-transactional cursor/data ordering (G5, a separate change) and the
lease-under-kill behavior. This change builds the failure-path test layer that proves those
boundaries hold.

## What changes (the 1.0.0 gate items this change addresses)

This change adds a **required, non-live, Testcontainers-based failure-path test layer** and
rescopes two entangled acceptance items. It adds **no `src/` behavior of its own** — it verifies
the behavior that the correctness/durability change (G5–G8) lands, and records the evidence the
release requires.

1. **G9 — Crash-injection / cold-start suite in the REQUIRED (non-live) CI gate.** Four faults,
   each asserting a specific invariant, all running in `test:conformance` (never behind
   `UMBRADB_LIVE_PREPROD`):
   - **process-kill mid-save** (`02`-T1): SIGKILL the writer between chunk writes and COMMIT;
     assert no `complete=true` manifest at the interrupted seq, prior seq still `load`s, no
     orphaned junction rows.
   - **Postgres-kill mid-save + retry-does-not-duplicate** (`02`-T2): kill Postgres mid-`save`;
     assert a typed `ConnectionError` (never a raw driver error), all-or-nothing after restart,
     and the **retry-duplication contract** per `council/B` §3 item 2 — either no duplicate
     (once the idempotency key of a *separate* change ships), or, at the 1.0.0 baseline, the
     documented benign-identical-content-duplicate behavior with the retry wrapper excluding
     `save`.
   - **crash-between-data-and-cursor** (`02`-T5, the release keystone): kill between the data
     commit and the cursor advance (and in the composed/reverse ordering); assert the **durable
     watermark is never ahead of durable data**, and that replay from the durable cursor
     converges on the correct **current state** — run under **`synchronous_commit` ON and OFF**.
   - **lease non-wedge cold start** (`02`-T3): SIGKILL during a `withLease` critical section;
     assert a fresh process re-acquires the lease immediately and `pg_locks` shows the class-2
     advisory lock gone.
2. **G10 — Full-sync soak + load-under-concurrent-prune** (`council/B` §3 items 5 & 6; `01`
   checklist item 3's "full realistic sync run"): a sustained realistic write mix (KV puts +
   checkpoint cadence + watermark ticks + GC passes + lease held) at a **declared data/concurrency
   envelope**, asserting zero sampled invariant violations, a replay-equivalent end state, and a
   **bounded, recorded** GC-pass duration; plus a `load`-during-`prune` retrieval-correctness
   check that never yields `ChunkIntegrityError`/`ChunkMissingError` for a live checkpoint.
3. **G11 — Differential state-equivalence gate, RESCOPED in-repo** (`01` checklist item 4;
   `council/B` §1's replay-idempotence note; `02`-T11): the P3 replay-equivalence property
   (already in the required gate) **plus** a new **fault-schedule-vs-fault-free equivalence**
   check — after a randomized schedule of the G9 faults, a full re-sync from durable state
   produces a **current state** equivalent to a fault-free reference run. **The reference side is
   built entirely in-repo** from UmbraDB's own adapters.
4. **G12 — Milestone-5 live round-trip, RESCOPED as a manual pre-tag Preprod evidence run** (`01`
   §"Cutover"; `ROADMAP` G12): against the release candidate, a **manual** (still
   `UMBRADB_LIVE_PREPROD`-gated) run — sync a funded wallet to live Preprod tip → kill →
   cold-start in a fresh object graph → resume with no resync and no drift — with the evidence
   (logs, cursor values, restored balance/tx-history) **recorded as a release artifact**.

## Non-goals (explicitly out of scope for this change)

These are honored **verbatim** from the council rulings and the consolidated roadmap.

- **The G5–G8 code fixes themselves.** This change *consumes* the co-transactional `save`/`tx`
  path (G5), the durability startup probe (G6), the server-side timeouts (G7), and the
  contract-integrity fixes (G8) — they land in the correctness/durability change(s). G9's T5 and
  G11's fault-schedule check have a **hard dependency on G5**; G9/G10's deterministic termination
  has a hard dependency on G7 (`council/B` §2 P0-4: "every crash-recovery test above needs bounded
  failure to even terminate deterministically"). This change assumes those merged and verifies
  their observable guarantees.
- **`save()` idempotency (`idempotency_key` + UNIQUE).** OUT — `council/B` §5 item 3 and §6: a
  lost-COMMIT-ack retry produces a *benign, identical-content* duplicate under load-latest
  semantics, not corruption; its real deadline is **"with Sprint 9"**, not 1.0.0. Consequently
  G9-T2's "retry-does-not-duplicate" is verified in its **documented-unsafe** form at 1.0.0 (the
  duplicate is benign; the auto-retry wrapper **excludes** `save`), with the no-duplicate
  assertion behind a `WHERE`-gated optional-feature path that activates only if/when the key ships
  (`council/B` §3 item 2).
- **Importing a foreign consumer application** to drive G11 or G12. OUT — `ROADMAP` G11 ("**Do not
  import the consumer app** — that would gate the release on a foreign repo and breach UmbraDB's
  indexer-agnostic boundary") and `MEMORY` "UmbraDB sync architecture boundary". The differential
  gate's reference side is reconstructed **in-repo**; "remove the replaced engine" (M5's third
  clause) moves to the *consumer* project's checklist, not this release's.
- **A performance *number* as a release gate.** OUT — `council/B` §3 "Ruling on the benchmark
  baseline" and `ROADMAP` §D: no perf number gates 1.0.0; only that a baseline is *recorded*
  (that recording is a separate perf change, G13/G14). This change's soak (G10) records GC-pass
  duration as an *artifact*, and asserts only **boundedness within the declared envelope** — not a
  threshold. The CV-aware regression gate is the first *post*-1.0.0 obligation, not wired here.
- **The lease-fencing *code* fix and the fence-violation test (`02`-T4).** OUT of the required
  gate — `council/B` §3 "Negotiable / NOT gating": T4 gates the P1-1(b) routing fix whenever it
  lands and until then exists as a documented known-fail; the single-process 1.0.0 model does not
  make the fence-violation an active corruption path (`council/B` §5 item 2). This change verifies
  only the **lease non-wedge cold start** (T3), which *is* in scope.
- **The startup durability-probe test (`02`-T12).** OUT of *this* change — it belongs with the
  probe it tests (G6, the durability change). G9 as scoped here is exactly {T1, T2, T5, T3}.
- **Pumba / netem chaos tooling; disk-full (`02`-T7); migration-lock-timeout (`02`-T8);
  clock-step (`02`-T9 second half); serialization-storm (`02`-T10).** OUT / deferred —
  `council/B` §3: "pumba-class tooling is a schedule sink; `pg_terminate_backend` + container kill
  covers the essential faults"; T7/T8/clock-step are "nice, not gating" (T8 is covered by G7's own
  unit test). This change's harness deliberately uses **Testcontainers container-kill/restart +
  `pg_terminate_backend` + child-process SIGKILL**, not `netem`.
- **Streaming `save`/`load` (`02`-F11), `kv_history` partitioning, GIN tuning.** OUT — documented
  ceilings, post-1.0 (`council/B` §2 "Defer past 1.0.0").
- **Lean formalization.** Parallel, independent workstream (G20), as in every prior sprint's
  proposal.

## Impact

- **New in this repo (test/infra only — no `src/` behavior change):**
  - `test/integration/crash/` — the crash-injection suite: a `tsx`-launched **child-process
    writer** entrypoint (`tsx` is already a devDependency, `package.json`) with a test-only fault
    hook that pauses at one of four **named program points** (`before-commit`,
    `in-critical-section`, `after-data-commit-before-cursor`, `after-cursor-before-data`), plus the
    four fault tests (T1/T2/T5/T3). These run under the required gate.
  - `test/integration/required-tests.manifest.json` + `test/integration/check-required-tests.ts` —
    the **skip-enforcement mechanism**: a checked-in manifest of required (and separately, deferred
    optional-feature) crash/soak test ids, plus a post-run reconciliation that fails the gate by id
    if any required test did not execute. This is the named mechanism that makes "durability ships
    unverified because a test self-skips" (the failure this change exists to prevent) unable to
    recur silently — `vitest run` does not fail on a skipped test by default (`design.md` §1.1).
  - `test/integration/soak/` — the full-sync soak + load-under-concurrent-prune tests (G10); the
    load-under-prune test carries a **forced-interleave primitive** so the `prune` COMMIT provably
    lands inside `load`'s REPEATABLE READ snapshot window, plus a negative control confirming the
    un-snapshotted ordering would raise (`design.md` §3.2).
  - `test/postgres/differential-equivalence.test.ts` (or `test/integration/`) — the
    fault-schedule-vs-fault-free equivalence check (G11), reusing the existing in-repo reference
    (`test/postgres/reference-merge.ts`) rather than any foreign store.
  - `docs/recovery/EVIDENCE.md` — the recorded G12 Preprod evidence artifact template + the actual
    pre-tag run's captured output.
  - Shared crash-harness helpers extending `test/postgres/setup.ts` (`registerSuiteLifecycle`
    already exposes `connectionUri()` for a dedicated pool; the crash suite needs
    container-restart + `pg_terminate_backend` helpers on top).
- **Modified:**
  - `.github/workflows/conformance.yml` — the required gate gains the crash/soak/differential
    suites (they must **not** self-skip) **and** the post-run skip-enforcement step
    (`check-required-tests.ts`) that fails the gate by id if any required test did not execute; the
    workflow `timeout-minutes: 30` is re-evaluated against the soak's declared duration (the soak's
    envelope is chosen to fit, or split to a labeled required job). A suite-level
    `SUITE_WATCHDOG_MS` backstop guarantees the gate fails fast rather than hanging when Postgres is
    half-dead, independent of G7.
  - `package.json` `scripts` — `test:conformance` continues to be the required gate and now
    includes the new suites (they run without `UMBRADB_LIVE_PREPROD`) followed by the
    skip-enforcement reconciliation; `test:live` (G12) is unchanged in gating but its
    evidence-recording is formalized.
  - `ROADMAP.md` — G9–G12 checkboxes on completion.
- **Risk:** this is a **test-and-evidence** change; its correctness risk is not in `src/` but in
  the tests being **honest** — a crash test that races and passes by luck, or a soak that samples
  too coarsely to catch a violation, is worse than none (it manufactures false confidence in the
  release's keystone guarantee). Every requirement below therefore fixes a **concrete, checkable
  invariant** (a specific SQL-observable post-condition after a specific fault), and the tasks
  carry the two-auditor cadence that has caught exactly this class of "passes for the wrong
  reason" gap in prior sprints. The second, structural risk is **flakiness** in the required gate:
  a genuinely killed process/container is inherently less deterministic than a pure unit test, so
  the harness must make the fault **deterministic** (a fault hook that pauses at a named point,
  not a timing race) and the assertions **fault-agnostic** (they hold whether the kill landed
  before or after the boundary), or the suite gets quarantined and the guarantee ships unverified
  again — the exact failure this change exists to prevent.
- **Delivery:** matches the prior sprints' cadence — this proposal/design/tasks/spec reviewed
  first, then a builder implements against it with two parallel auditors per task (one for
  spec-compliance against this `design.md`, one for test honesty/coverage), per the note at the
  head of `tasks.md`.
