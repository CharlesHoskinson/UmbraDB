# Acceptance criteria — v1.0.0: Recovery, Crash-Injection & Soak Testing (`recovery-testing`)

Consolidated, objective, traceable acceptance list for the whole change. Every criterion is
verifiable (a test asserts it, a CI gate enforces it, or a checkable artifact records it) and
traces to a requirement in `specs/recovery-testing/spec.md` and a roadmap gate item (G9–G12).

**Verification legend:** `CI` = enforced in the required non-live gate (`npm run test:conformance`);
`crash-test` = a Testcontainers crash-injection test; `soak-test`; `property` = the P3 fast-check
property; `diff-test` = the fault-schedule differential test; `static` = a static/import/allowlist
check; `doc` = a checkable documentation artifact; `manual-evidence` = the recorded G12 Preprod run.

## Suite-level (G9)

| # | Criterion | Verified by | Requirement / gate |
|---|-----------|-------------|--------------------|
| A1 | The crash-injection suite runs in the required gate with `UMBRADB_LIVE_PREPROD` unset and does not self-skip; a skipped **required** crash test turns the gate red / is flagged, never silently counted as passed; a `WHERE`-gated optional-feature scenario is reported as `skipped-pending-feature`, not a silent skip | CI + static | "the crash-injection suite runs in the required gate and does not self-skip" / G9 |
| A2 | A green `test:conformance` run reports the process-kill, Postgres-kill, cursor-durability, and lease-non-wedge tests as run-and-passed (not skipped) | CI | same / G9 |
| A3 | A **named** skip-enforcement mechanism (`required-tests.manifest.json` + post-run `check-required-tests.ts` reconciliation against Vitest's reporter output) fails the gate by id if any `"required"` test did not execute; `vitest run` alone does not fail on skips, so this is the enforcement, not convention. `"deferred"` optional-feature ids are exempt while unshipped | CI + static | "a skip-enforcement check proves every required crash test executed, none silently skipped" / G9 |
| A4 | The crash and soak suites terminate within a bounded wall-clock (a named `SUITE_WATCHDOG_MS` backstop, independent of G7) and fail with a typed error rather than hang when Postgres is half-dead | CI + crash-test | "the crash and soak suites terminate within a bounded wall-clock even when Postgres is half-dead" / G9 |

## Process-kill mid-save (G9 / T1)

| # | Criterion | Verified by | Requirement |
|---|-----------|-------------|-------------|
| B1 | After SIGKILL at `before-commit`, no `complete = true` manifest exists at the interrupted sequence | crash-test | "process-kill mid-save leaves no partially-visible checkpoint (T1)" |
| B2 | The most recent previously-committed checkpoint still `load`s and passes manifest+chunk hash verification | crash-test | same |
| B3 | No junction (`ckpt_manifest_chunks`) rows reference a non-existent/incomplete manifest | crash-test | same |
| B4 | Negative control: without the kill, the same `save` produces a visible `complete = true` manifest (proving the kill caused the absence) | crash-test | same (test-honesty) |

## Postgres-kill mid-save + retry contract (G9 / T2)

| # | Criterion | Verified by | Requirement |
|---|-----------|-------------|-------------|
| C1 | The in-flight `save` rejects with a typed `ConnectionError`, never a raw `postgres.js` error | crash-test | "Postgres-kill mid-save surfaces a typed error and stays all-or-nothing (T2)" |
| C2 | After recovery the checkpoint is all-or-nothing (fully present & `load`able, or fully absent) | crash-test | same |
| C3 | `load(latest)` returns correct bytes after recovery | crash-test | same |
| C4 | The lost-ack state is built by the sanctioned simulation (a provably-committed `save` re-invoked with identical content — not a timed kill of the unhittable post-commit-pre-ack window); the retry yields a benign identical-content duplicate at the next seq (not corruption); `load(latest)` correct either way | crash-test | "the save retry-duplication contract is verified in its 1.0.0 (documented-unsafe) form" |
| C5 | `save` is excluded from any auto-retry allowlist | static | same |
| C6 | The no-duplicate-on-retry scenario exists but is skipped until a caller idempotency key ships (wired to activate on that feature flag, no spec rewrite needed) | crash-test (skipped) | same (`WHERE` optional-feature) |

## Crash between data and cursor — keystone (G9 / T5, depends on G5)

| # | Criterion | Verified by | Requirement |
|---|-----------|-------------|-------------|
| D1 | For the durable watermark observed on restart, every write batch whose cursor value ≤ it is present in durable data; the watermark is never observed ahead of unpersisted data; the kill uses the named `after-data-commit-before-cursor` hook on the co-transactional/safe (data→cursor) ordering only | crash-test | "a crash between data and cursor never leaves the watermark ahead of durable data (T5)" |
| D2 | Replay from the durable cursor produces a current state equal (on the current-state equality predicate) to the reference current state, where the reference is a fault-free replay of the **same** harness write-batch sequence built from UmbraDB's own adapters | crash-test | same |
| D3 | The equality predicate is `kv_current` values + latest complete checkpoint payload + watermark values, **excluding** `kv_history` rows and `version` columns (which legitimately diverge on replay); this exclusion is explicit in the test | crash-test + doc | same |
| D4 | The invariant "watermark never ahead of durable data" holds under `synchronous_commit = on` and, as a **separate scenario**, under `= off` | crash-test | "the invariant holds under synchronous_commit = on" / "… = off" |
| D5 | The `off` leg forces an **unclean postmaster kill** (`pg_ctl stop -m immediate` / in-container `kill -9`, not a clean container stop) so a tail loss is reachable and the leg is non-vacuous; a lost tail is acceptable, an inverted durability order (cursor durable, data not) is a failure | crash-test | "the invariant holds under synchronous_commit = off" |
| D6 | Tests D1–D5 are gated on G5's merge — marked pending, not green, until the co-transactional save/cursor path exists | static | G9 dependency (`design.md` §2.3) |

## Lease non-wedge cold start (G9 / T3)

| # | Criterion | Verified by | Requirement |
|---|-----------|-------------|-------------|
| E1 | After a lease-holder is SIGKILLed, a fresh process's `withLease` on the same key acquires immediately with no wedge (bounded wait, fails fast if wedged) | crash-test | "a killed lease-holder does not wedge the lease (T3)" |
| E2 | `pg_locks` shows the class-2 advisory lock for that key gone after the kill | crash-test | same |

## Full-sync soak + load-under-prune (G10)

| # | Criterion | Verified by | Requirement |
|---|-----------|-------------|-------------|
| F1 | The soak runs a sustained concurrent mix (KV puts + checkpoint cadence + watermark ticks + prune passes + held lease) at a declared envelope (10^5–10^6 chunks, not 10^7) for a bounded, named duration | soak-test | "a full-sync soak runs at a declared envelope with GC passes and holds every invariant" |
| F2 | A **named, enumerated** set of P1–P10-derived, SQL-observable invariants — at minimum gapless per-key `version` (P1/P2), only `complete = true` manifests `load`able (C1), no junction rows to a missing/incomplete manifest (C2a), watermark ≤ max durable data (T5) — sampled during the run (not only at the end) never fails | soak-test | same |
| F3 | The end state is equal (on the current-state equality predicate) to a fault-free reference run | soak-test | same |
| F4 | Each GC-pass duration is recorded as an artifact and completes within a named `GC_PASS_WATCHDOG_MS` test-termination constant; the durations are the artifact and **no** pass-rate/latency threshold gates the release (resolves the vacuous-"bounded" finding) | soak-test + doc | same |
| F5 | The soak fits the required-gate timeout (or is a separate still-required job — never live-gated or optional) | CI | same |
| F6 | `load` of a live checkpoint concurrent with `prune` returns correct bytes and never raises `ChunkIntegrityError`/`ChunkMissingError`, with the `prune` COMMIT **forced** (interleave primitive) to land inside `load`'s REPEATABLE READ snapshot window | soak-test | "load during a concurrent prune never corrupts a live checkpoint's retrieval" |
| F7 | The prune concurrency is a **forced, verified** interleave (the `prune` COMMIT provably lands mid-snapshot, not a wall-clock race that could pass vacuously); the survive-set is defined explicitly; clock-step is documented as deferred | soak-test + doc | same (test-honesty) |
| F8 | Negative control: the same forced interleave applied to an un-snapshotted read of a reclaimed chunk DOES raise `ChunkMissingError` — proving the clean `load` is attributable to the snapshot, not to a non-overlapping prune | soak-test | same (test-honesty) |

## Differential state-equivalence, in-repo (G11, fault-schedule half depends on G5)

| # | Criterion | Verified by | Requirement |
|---|-----------|-------------|-------------|
| G1 | P3 runs and passes in the required gate and is documented as the differential gate's fold-equivalence anchor | property + doc | "the differential gate is anchored on the P3 replay-equivalence property" |
| G2 | A randomized G9-fault schedule + re-sync from durable state yields a current state equal (on the current-state equality predicate) to a fault-free reference run of the same input | diff-test | "a fault-schedule run is state-equivalent to a fault-free reference (T11)" |
| G3 | The reference side is built entirely in-repo (`test/postgres/reference-merge.ts` + UmbraDB adapters); it imports no foreign consumer/indexer application | static (import audit) | "the differential gate imports no foreign consumer application" |
| G4 | Equivalence is on current state (`kv_current` + latest complete checkpoint payload + watermark values); `kv_history`/version divergence tolerated | diff-test + doc | G2's requirement |
| G5c | Negative control: a deliberately-broken variant that drops a range makes the equivalence assertion fire (the check has teeth) | diff-test | G2's requirement (test-honesty) |
| G6c | The fault-schedule test is gated on G5's merge | static | G11 dependency (`design.md` §5) |

## Manual pre-tag Preprod evidence run (G12, release step 7, against the RC)

| # | Criterion | Verified by | Requirement |
|---|-----------|-------------|-------------|
| H1 | Against the RC, a live round-trip (sync to Preprod tip → persist → kill → cold-start fresh graph → resume) runs under `UMBRADB_LIVE_PREPROD=1` before tagging | manual-evidence | "a manual pre-tag Preprod round-trip is run against the RC with recorded evidence" |
| H2 | The run resumes from the durable cursor with no full resync; restored balance/tx-history matches pre-kill state with no drift | manual-evidence | "the pre-tag run resumes from the durable cursor with no resync or drift" |
| H3 | `docs/recovery/EVIDENCE.md` records run date, RC commit/tag, synced tip height, durable cursor at kill, restored balance/tx-history, and pass/fail per M5 sub-criterion | doc + manual-evidence | "the run's evidence is recorded as a release artifact" |
| H4 | The evidence artifact records that "remove the replaced engine" belongs to the consumer project, not this release | doc | same |
| H5 | The evidence run is not part of the required gate; `test:conformance` stays green with no network/seed/wallet checkout | CI | "the evidence run is not a required CI gate" |

## Boundary / scope guardrails (council rulings honored)

| # | Criterion | Verified by | Source ruling |
|---|-----------|-------------|---------------|
| I1 | No performance number gates the release; only that the soak's GC-duration baseline is recorded | doc | `council/B` §3 baseline ruling; `ROADMAP` §D |
| I2 | `save`-idempotency (idempotency key) is NOT implemented here; C4/C5 verify only the documented-unsafe contract with the wrapper excluding `save` | static + doc | `council/B` §5 item 3; `ROADMAP` §Deferred |
| I3 | No foreign consumer/indexer app is imported anywhere in this change (G11 & G12) | static (import audit) | `ROADMAP` G11; `MEMORY` sync-architecture-boundary |
| I4 | The dedup-oracle/keyed-chunking is untouched (documentation-only for 1.0.0, keyed chunking is 1.1) — out of this change entirely | static | `council/B` §Perf/InfoSec rulings; `ROADMAP` §Deferred |
| I5 | The G6 startup-durability-probe test (T12), the T4 fence-violation test, T7 disk-full, T8 migration-lock, T9 clock-step, and T10 serialization-storm are NOT in this change | static | `council/B` §3 "Negotiable"; `design.md` §7 |
| I6 | All three unmerged tracks (full-chain archival, verifiable-snapshot, torrent bootstrap) remain out of 1.0.0 and untouched here | static | `ROADMAP` §Deferred; `01` §"Unmerged-track" |
