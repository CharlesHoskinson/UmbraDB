# Autonomous run log

Append-only journal of an 8-hour autonomous multi-sprint run started 2026-07-21 ~22:00 MDT while
the owner is AFK. Goal: get the Midnight infra connected to UmbraDB's Postgres storage and verify
it syncs, advancing the sprint roadmap with a full audit gate on every merge.

## Orchestration model (owner-specified)

Per sprint: **plan** (repo openspec/graphify flow) → **Sonnet 5 implements** → **Opus panel audits**
(3 roles: domain-correctness, adversarial, release/test-coverage — AGENTS.md) → **Codex GPT-5.6 Sol
cold audit** (`codex exec`, read-only sandbox, high reasoning, NONE-mode/no-manifest per repo
CLAUDE.md) → **Fable 5 aggregates** findings into blocking/non-blocking → **fix** (Sonnet) →
**verify gate** (`npm test` on rootless Docker, `tsc`, `openspec validate --strict`,
`graphify update`) → **commit on the sprint's feature branch** → **push the feature branch to origin**.

**BRANCH DISCIPLINE (owner directive — rolling merge for good hygiene):** every sprint lives on its own
feature branch, pushed to origin. **Merge sprint N's branch to `main` once BOTH hold:** (a) N is
FINISHED — implemented, full audit chain cleared with no open blocker, and verify gate fully green; AND
(b) N+1 is PLANNED — its design/spec authored and confirmed by the correctness-audit gate. The
"N+1 planned" precondition is deliberate: authoring N+1's design can still surface something that should
change N, so N stays on its branch until N+1's design is settled, then merges. After merging N, branch
N+1 off the freshly-updated `main`. `main` advances one finished-and-superseded-by-a-plan sprint at a
time — never stack the whole run unmerged, never merge a sprint whose successor isn't yet designed.
Merge via a real merge commit (no fast-forward-only rewrite), no force-push, no history rewrite, no
branch deletion. A red gate or an open blocking finding ⇒ no merge, full stop.

Codex Sol invocation (verified working): default model `gpt-5.6-sol`,
`codex exec -c model_reasoning_effort=high --output-schema <schema> -o <out> "<cold audit prompt>"`.

Every phase appends an entry below.

### Sprint-AUTHORING pipeline (owner directive — applies to Sprint 8 onward; Sprint 7's spec already exists)

Before any implementation on a NEW sprint, run this design-time pipeline to prevent design mistakes:

1. **Deep research stage** — fan out parallel research agents + scrapling to gather context: sweep the
   official Midnight docs (docs.midnight.network), the real SDK/node/indexer/ledger source in `~/repos`,
   external best-practice sources (postgres patterns, wallet-sync/checkpoint/recovery prior art), and any
   relevant standards. Each agent reads real sources (not memory) and returns a cited brief. Synthesize
   into one research brief for the sprint. Verify every external claim against the actually-installed
   version or real upstream source (repo's own correctness rule).
2. **Design council** — several design agents propose and critique the design from DISTINCT angles
   (e.g. correctness/algebra, API-shape/interface fidelity to the real SDK, failure-modes/ops,
   testing-strategy). Include a **correctness-audit spec agent** that checks the proposed design against
   the requirements + research brief for soundness, gaps, and vacuous claims, and returns an explicit
   confirm/BLOCK verdict. Iterate until the correctness auditor confirms. Fable 5 consolidates the
   council into the openspec design.
3. **Spec + test strategy** — write the openspec change (`proposal/design/tasks/spec`, EARS format) AND
   an explicit **post-implementation testing strategy** section: unit coverage, property tests (with the
   oracle/reference), integration/live tests (what's exercised against real preprod), failure/recovery
   tests (cold-boot), regression guards, and which EARS requirement each test maps to. `openspec validate
   --strict` must pass; `graphify update` after.
4. Only THEN the implement → Opus panel → Codex Sol → Fable aggregate → fix → verify-gate back-half runs.

The correctness-audit spec is a hard gate: no implementation starts on a design the correctness auditor
has not confirmed.

## Timeline

### Setup (pre-run)
- Env fully stood up: from-source Midnight build (node 2.1.0 / indexer-standalone / proof-server
  8.1.0), wallet SDK via public npm, Compact 0.5.1/compactc 0.31.1, rootless Docker.
- Preprod verified live; wallet funded (1000 tNIGHT confirmed on-chain).
- Codex GPT-5.6 Sol authenticated in WSL (npm codex 0.145.0). Opus/Sonnet/Fable via Agent tool.
- Committed env docs (e1253ce).

## Sprint backlog (repo audit — nothing drafted is missing; broader backlog enumerated)

Reconciled from openspec/changes/, ROADMAP.md milestones, design/tasks.md's phase map, the
sprint-5 recommendation, and Formal/LEAN_FORMALIZATION_PLAN.md. Status verified against `main`.

**Done + merged:** sprint-1 TemporalKV, sprint-2 Transaction/Lease, sprint-3 CheckpointStore,
sprint-4 Watermarks (Milestone 2 core modules, all 4). sprint-5-formal Watermarks W1, sprint-6-formal
Checkpoint C1 (Lean track). Retired design/tasks.md §6/§7 (`PgPrivateStateProvider`/`PgWalletStateStore`)
are SUPERSEDED by the sprint-5 recommendation — those SDK interfaces don't exist; the real surface is
transaction-history-storage + a WalletState envelope.

**Execution sequence for this run (implementation track):**
- **Sprint 7 (IN PROGRESS): transaction-history-storage** — `PgTransactionHistoryStorage` (row-lock
  atomic merge) + migration + Pg-only conformance gate. Self-contained (no wallet-SDK runtime dep).
- **Sprint 8: WalletState envelope + live preprod DB-sync verification** — recommendation module 2
  (envelope over CheckpointStore) PLUS the live-sync tier: drive our funded preprod wallet through the
  SDK, persist tx-history into UmbraDB Postgres, and verify the on-chain 1000 tNIGHT tx materializes as
  a DB row. THIS is the "verify the DB syncs" end-to-end proof. Needs the wallet SDK (built) + our
  node/indexer/proof-server (built) or public preprod.
- **Sprint 9: Milestone 3 resilience** — cold-start survival (kill process / kill Postgres mid-op,
  verify clean recovery) + retrieval-correctness-under-load, against real Postgres.
- **Sprint 10: Milestone 3 equivalence** — the P1–P10 replay/differential-equivalence gate as a
  cohesive suite + a realistic full-sync test.

**Parallel/lower-priority tracks (not blocking the DB-sync goal):**
- Lean formal continuation (Milestone 1 remainder): M3c Checkpoint C2a/GC, ordered reconstruction,
  keyed transactions, lease traces (placeholder branch `formal/storage-algebra-lean-m3c-checkpoint-c2a`
  is empty). Separate AGENTS.md audit flow; interleave if time permits.
- Milestone 4 performance: profiling/benchmark/logging (research-gated).
- Milestone 5 cutover: midnight-dev-env-side, NOT this repo.

## Audit-check guardrails ("don't get this wrong" — owner directive)

Hard rules enforced on every sprint before its feature branch is pushed to origin (and NOTHING
reaches `main` until whole-stack validation):

1. **Verify gate must be fully green** — `npm test` ALL green (incl. the 4 env tests once fixed, and
   the 151 baseline as a regression guard), `tsc --noEmit` clean, `openspec validate --all --strict`
   clean, `graphify update .` clean. Red gate ⇒ no push, no "done" claim.
2. **Every EARS requirement maps to a passing test** — the Fable 5 aggregator explicitly cross-checks
   each requirement in `specs/*/spec.md` against a test that exercises it. A requirement with no test
   is a BLOCKING finding.
3. **Audit chain clears** — 3-role Opus panel (domain-correctness, adversarial, release/test-coverage)
   + Codex gpt-5.6-sol cold audit (read-only, NONE-mode/no-manifest, independent) → Fable 5 aggregates.
   Any unresolved **blocking** finding ⇒ Sonnet fix + targeted re-audit. No merge with an open blocker.
4. **Auditors are read-only and independent** — Codex runs cold (no manifest) per repo CLAUDE.md's
   NONE-mode rule; the Opus panel roles do not share findings before reporting.
5. **Evidence before assertions** — every "passing/done" claim in this log is backed by actual command
   output, not narration. Failures are reported with their output.
6. **No shortcut merges** — no force-push, no `--no-verify`, no skipping the gate to "save time."

## Env test-failure fix (owner: "fix the env failures as well") — diagnosed, fix planned

Root cause of the 4 pre-existing failures (pre-date Sprint 7; on `main`):
- **3 timeouts** (`migrate` / `transaction-lease` / `watermarks` dead-endpoint tests): connecting to
  `127.0.0.1:1` under WSL2's network stack HANGS (no fast ECONNREFUSED) until postgres.js's default
  30s `connect_timeout` fires — measured 30009ms `CONNECT_TIMEOUT` — but the tests' timeout is 5s.
  `createClient`'s `UmbraDBConnectionOptions` exposes no connect-timeout knob. **Fix:** add a bounded
  `connectTimeout` option to `createClient` (a real fail-fast-on-unreachable-DB improvement; default
  ~10s) and set it short (~2s) in the 3 dead-endpoint tests so the ConnectionError/LeaseFaultError
  translation they assert surfaces within the test window. Not test-gaming — the tests assert error
  *translation*, not duration.
- **1 assertion** (`temporal-kv` server-side-cancel, test line ~387): asserts that after aborting a
  blocked SELECT, `pg_stat_activity` shows 0 queries waiting on the lock (i.e. `query.cancel()` reached
  the server). Uses a fixed 50ms sleep before checking; this env's cancel round-trip is slower.
  **Fix:** replace the fixed sleep with a bounded poll (retry until `n==0` or ~2s elapsed) — preserves
  the assertion, tolerates env latency.
- Applied AFTER the Sprint 7 implementer finishes (same working tree — avoid concurrent-edit/test
  contention). Tracked as a prerequisite for Sprint 7's fully-green verify gate.

## Live-sync milestone — feasibility + timing (owner asks)

**Feasible, confirmed.** The wallet SDK runs on TS source via vitest (its own `*.integration.test.ts`
do). Sync path: testkit `initWalletWithSeed` + `PreprodTestEnvironment` (public preprod indexer/node
URLs) + our LOCAL proof-server (built, running on :6300). No extra "make the SDK runnable" blocker —
vitest is the vehicle. The facade injects `TransactionHistoryStorage`, so UmbraDB's Pg store slots in.

**When: Sprint 8** (after Sprint 7's `PgTransactionHistoryStorage` lands as the DB write target).
Sprint 8 deliverables:
1. An adapter mapping the REAL SDK `TransactionHistoryStorage` (Effect-Schema entries: hash,
   identifiers, optional protocolVersion/status/timestamp:Date/fees:bigint, lifecycle union) ↔
   UmbraDB's `PgTransactionHistoryStorage`.
2. A vitest integration test: sync our funded preprod wallet (seed at `~/.midnight-preprod-wallet.seed`)
   with the **birthday hack** (birthday ≈ current tip so it skips ~1.76M blocks), injecting the
   Pg-backed storage; assert the on-chain 1000 tNIGHT tx materializes as a UmbraDB DB row. **This is the
   "verify the DB syncs" proof.**
3. The **WalletState envelope** over `CheckpointStore` (recommendation module 2).
4. **COLD-BOOT RECOVERY TEST (owner-requested milestone):** sync → serialize each sub-wallet state →
   wrap in the envelope → `CheckpointStore.save` into Postgres → destroy the wallet + process → fresh
   process → `CheckpointStore.load` the envelope → restore each sub-wallet → `PgTransactionHistoryStorage
   .getAll()` for tx-history → assert the wallet resumes at the right block WITHOUT full resync and its
   tx-history matches the pre-crash DB state. Template exists:
   `midnight-wallet/.../serializationAndRestoration.integration.test.ts`.

Timing estimate for this 8-hour run: Sprint 7 (implement + full audit + fix + green gate) first;
Sprint 8 (adapter + live preprod sync + cold-boot recovery) is the live-sync milestone — targeted
within the run, contingent on Sprint 7 clearing cleanly. Honestly reported: if Sprint 7's audit surfaces
real blockers, Sprint 8 may start late — the log will show exactly where it got to.

### Sprint 7 — transaction-history-storage
- Sonnet 5 implementer dispatched (self-contained scope: interface + migration + PgTransactionHistoryStorage
  + unit/property tests + in-repo InMemory oracle + Pg-only conformance). Baseline before: 151 pass / 4
  pre-existing env failures (to be fixed post-implement, above).
- Sent implementer a reconciliation with the REAL SDK interface (Effect-Schema entry shape; lifecycle is
  a discriminated union w/ `status` discriminator, not a bare enum; reader/writer split; write methods
  take entry-minus-lifecycle; fees:bigint + timestamp:Date are the round-trip-critical fields; subset-clear
  confirmed) so its in-repo mirror matches and Sprint 8's adapter wires up cleanly.
- (further entries appended as phases complete)
