# Proposal — Sprint 9: Client cleanup, performance seeding, connection hardening

> **Status:** Draft. This is the "overflow" consolidation sprint: it folds in the non-blocking
> findings the prior sprints deferred, seeds the Milestone 4 performance workstream against
> UmbraDB's *real* workloads, and hardens both connection layers UmbraDB depends on. Per the
> autonomous run's branch discipline (`AUTONOMOUS_RUN_LOG.md:16-25`), **authoring this plan and
> clearing its correctness-audit gate is precisely what unblocks Sprint 8's merge to `main`** (the
> "N+1 planned" precondition). It has **not** yet been through this repo's three-persona
> panel/Codex audit (`AGENTS.md`) — that is Phase 0 of `tasks.md`, unchecked.

## Why this sprint exists, and why it unblocks Sprint 8

The autonomous run's rolling-merge rule (`AUTONOMOUS_RUN_LOG.md:16-25`) merges sprint N only once N
is finished **and** N+1 is planned-and-gate-confirmed, because authoring N+1 can still surface
something that should change N. Sprint 8 (`sprint-8-wallet-envelope-live-sync`, worktree
`~/repos/umbradb-sprint8`) is implemented and audited; it stays on its branch until Sprint 9 is
designed. Sprint 9 is that plan.

Sprint 9 is deliberately **not** a grab-bag. Sprints 1–8 each intentionally deferred non-blocking
work to keep their own scope tight: audit findings rated LOW, code-hygiene items, the whole
Milestone 4 performance program (research-seeded but never built), and two connection-robustness
concerns — one in `src/postgres/client.ts`, one surfaced live this run in the wallet-sync path.
Left to scatter, these become the classic pre-1.0 long tail. Sprint 9 consolidates them into three
coherent themes, each grounded in named files and prior findings, each with its own EARS capability
spec and a test that maps to every requirement.

## The three themes

1. **Client cleanup / tech debt** (`specs/storage-client-hygiene`). Fold in the concrete deferred
   items, not vague "hygiene":
   - **Sprint 7 merge-read regression paths lack *direct* tests.** The row-lock atomic-merge path
     (`src/postgres/transaction-history-storage.ts` `writeRows`) and the defensive stored-envelope
     decode path (`decodeRow`/`assertStoredEntryShape`/`parseStoredBigint`/`parseStoredDate`/
     `rowToEntry`) are today exercised mainly through property tests and the F1 corruption fixtures.
     Codex's LOW findings (`AUTONOMOUS_RUN_LOG.md:287-289`) flagged that neither the empty-set
     vacuous-subset guard nor the concurrent-first-write advisory lock has a *direct* mutation-style
     test — remove the guard/lock and the suite still passes. Add tests that fail when the specific
     guard is removed.
   - **Sprint 8 L-findings never folded into its impl.** (a) status-enum mapping — the adapter maps
     the SDK's lifecycle discriminated union onto UmbraDB's bare `{status}` union
     (`src/interfaces/transaction-history-storage.ts:166-178`); every status
     (`pending`/`finalized`/`rejected`) must have direct round-trip coverage, and an unmapped status
     must be rejected, not silently coerced. (b) the adapter's implicit test-tier dependency on
     `effect` (Effect-Schema) and `@midnightntwrk/wallet-sdk-abstractions` — imported from a built
     on-disk `midnight-wallet` checkout, **absent from `package.json`** (verified: `package.json`
     lists only `postgres`/`zod` + test tooling) — must be recorded in a versioned pin manifest so
     the integration tier is reproducible. (c) multi-sub-wallet envelope coverage — Sprint 8's live
     and cold-boot tiers exercised only the unshielded sub-wallet, yet the envelope spec requires
     all three strings to round-trip and an absent slot to be skipped
     (`sprint-8-.../specs/wallet-state-envelope/spec.md`); add Pg-only conformance for the 2-of-3 and
     3-of-3 cases.
   - **Stray untracked `design/research/` artifacts leaked into a working tree.** The verifiable-
     snapshot research set (`design/research/2026-07-21-snapshot-root-of-trust/`) belongs on
     `feature/verifiable-snapshot`; it is present as **untracked** files in the `main` worktree
     (`~/repos/UmbraDB`, verified `git status --ignored`). Relocate/remove it and add a guard so a
     different feature's drafts cannot silently accumulate in `main`/sprint worktrees.
   - **`src/` debt survey.** Reported honestly: a grep for `TODO`/`FIXME`/`XXX`/`HACK` across `src/`
     finds **none** — the "future"/"belt-and-suspenders" comments are legitimate defense-in-depth,
     not debt markers. The real debt is the coupling and duplication the survey *did* find (the
     cross-module `hasPostgresUnsafeText` import, the twice-defined key-safety/depth-bound checks),
     scoped below.

2. **Performance — Milestone 4 seeding** (`specs/performance-observability`). The research pass the
   ROADMAP says must precede any tooling choice is **already done** (`Performance/DESIGN.md`,
   `Performance/GC_AND_TRACING_RESEARCH.md`); this sprint turns that design into a concrete,
   in-repo, versioned benchmark harness that doubles as a regression gate, plus structured DB-activity
   logging that correlates an app-level call to the SQL and query plan it issued. Metrics cover
   UmbraDB's *real* workloads (`ROADMAP.md:120-138`, `Performance/README.md`): versioned-KV
   throughput/latency, checkpoint save/load + dedup ratio, GC pass duration as the chunk store grows,
   lease contention — **and now** tx-history write/merge under concurrent writers on Sprint 7's
   row-lock path, and envelope save/load (Sprint 8). Tooling is adopted from the research, not from
   memory, with its honest caveats carried through (below).

3. **Connection robustness** (`specs/connection-robustness`). Harden **both** connection layers.
   (a) The DB layer, `src/postgres/client.ts`: generalize pooling config, add bounded
   retry/backoff on *transient* failures, generalize the `connectTimeout` work into an explicit
   connection-health policy, and add a liveness check — all opt-in, none silently changing
   postgres.js defaults (respecting audit finding F2's revert, `client.ts:58-63`). (b) The
   wallet-sync layer: this run surfaced that the wallet SDK judges "synced" against a **single
   indexer's self-reported tip with no finality reconciliation** (filed upstream as
   `midnight-wallet#584`). UmbraDB's sync-integration/adapter tier (Sprint 8's seam) must defend —
   multi-endpoint cross-check and/or a finality-verified-tip check before trusting "synced," plus
   reconnection/failover. This ties directly to the `verifiable-snapshot-recovery` feature's **C1**
   requirement ("offline recompute = on-chain root," `design/verifiable-snapshot-design.md:321`):
   the cross-check is C1's ship-now availability/freshness precursor (its Tier-0 k-of-n cross-check,
   `verifiable-snapshot-design.md:108`), the layer C1's correctness envelope later sits on top of.

## Non-goals (explicitly out of scope for this sprint)

- **Trust-minimized verifiable snapshot recovery** (anchor / finality proof / completeness /
  seed-binding). That is the separate `verifiable-snapshot-recovery` feature
  (`design/verifiable-snapshot-design.md`). Sprint 9 references its **C1** as the correctness layer
  above the connection-robustness/freshness layer it builds; it implements **none** of the ZK/
  attestation machinery. The sync-side defense here is operational cross-checking, not a proof.
- **A schema migration of an already-audited module.** `Performance/DESIGN.md` §3 recommends
  replacing `ckpt_manifests.chunk_hashes bytea[]` + GIN with a normalized `ckpt_manifest_chunks`
  junction table. That mutates Sprint 3's audited CheckpointStore schema; whether it lands here or is
  deferred is flagged as a correctness-gate open question (`design.md` §5), **not** silently done.
- **Changing any core module's contract.** Cleanup adds tests, a build manifest, and working-tree
  hygiene; it does not alter the behavior of `PgTemporalKV`/`PgCheckpointStore`/`PgWatermarks`/
  `PgTransactionLease`/`PgTransactionHistoryStorage`. A regression test that pins current behavior is
  the guard.
- **A wallet-SDK runtime import in any `src/` module.** The sync-side robustness lives in the
  adapter/integration tier only (`src/postgres/*` and `src/interfaces/*` stay SDK-free), exactly as
  Sprint 7 (`design.md` §2) and Sprint 8 require.
- **Fixing `midnight-wallet#584` itself.** UmbraDB cannot change the SDK's internal "synced"
  judgment; it can only cross-check independently and refuse to persist a checkpoint against an
  unverified tip. The upstream fix is tracked, not owned here.
- **Milestone 3 resilience/equivalence** (cold-start survival at scale, the P1–P10 differential
  gate). Those are the separately-planned Sprint 10+ (`AUTONOMOUS_RUN_LOG.md:86-89`); Sprint 9's
  benchmark harness produces the baseline they consume, but does not implement them.
- **Lean formalization** — parallel, independent workstream, as in every prior sprint's proposal.

## Impact

- **New in this repo**: a benchmark harness (`Performance/bench/`, an in-repo versioned regression
  gate), a single tracing wrapper module (`src/postgres/tracing.ts`, isolating the Experimental
  `tracingChannel` surface per `Performance/DESIGN.md` §2), an activity-logging layer, a test-tier
  dependency **pin manifest** (`test/integration/PINNED_DEPENDENCIES.md` or equivalent), direct
  merge-read/status-enum/multi-sub-wallet regression tests, and connection-robustness code in
  `src/postgres/client.ts` + the sync-integration tier.
- **Modified**: `src/postgres/client.ts` (pooling/retry/health, all opt-in); `package.json` gains
  `bench` (and `bench:baseline`) scripts; `.gitignore` and/or a working-tree-hygiene check to stop
  cross-feature research drafts leaking; `Performance/README.md`/`ROADMAP.md` record the harness as
  the recorded baseline for the 1.0.0 no-regression checklist item.
- **Risk**: the two genuinely novel correctness surfaces are (1) **retry-on-transient interacting
  with transaction/lease/merge atomicity** — a naive retry inside a caller `opts.tx`, or of a
  non-idempotent operation (a lease acquire), reintroduces exactly the hazards Sprints 2/7 closed;
  and (2) whether **finality-verified-tip reconciliation** is even the right defense for the *proven*
  unshielded sync model, which follows a per-address transaction-id cursor, **not** a block-height
  scan (`AUTONOMOUS_RUN_LOG.md:245-252`). Both are called out for the correctness gate in `design.md`
  §6.
- **Delivery**: this proposal/design/tasks/spec are a first draft. Per `AGENTS.md` and the
  sprint-authoring pipeline (`AUTONOMOUS_RUN_LOG.md:32-56`), it needs its deep-research/design-council
  pass and its domain-correctness, adversarial, and release-persona review before any implementation
  code — `tasks.md` Phase 0 tracks that and is unchecked. Clearing that correctness-audit gate is the
  event that lets Sprint 8 merge.
