# UmbraDB V1.0.0 — Lessons-Learned Living Log

*Companion to `v1-implementation-guideline.md` §5. This is the durable, append-only, blameless log for
the entire 1.0.0 release. It is seeded empty but ready to fill during the run. Governed by
guideline §5.1–§5.6; the eventual canonical home is `docs/retro/v1.0.0.md` (+ the standing format in
`docs/retro/README.md`).*

---

## Prime Directive (assert before reading or writing any entry)

> "Regardless of what we discover, we understand and truly believe that everyone did the best job they
> could, given what was known at the time, their skills and abilities, the resources available, and the
> situation at hand." — Norm Kerth

Blamelessness extends to **agent** actors. The unit of analysis is the **second story** — *why a given
output made sense given the context / manifest / prompt the agent had* — never "the model was wrong."
Write in "how", not "why". No single-root-cause narratives. This log is never pruned.

---

## Purpose

1. Capture every gate miss, defect escape, re-audit round, and workflow-friction event **when it
   happens** (guideline §5.2) — not reconstructed from memory at release end.
2. Aggregate and trend-analyze those events across the four capture classes (§5.3).
3. Feed iteration 2: no next-milestone spec drafting begins until every **preventative** action item
   here is either landed as a concrete workflow change or explicitly, owner-signed, re-deferred
   (guideline §5.5).

## Capture rules

- **Rolling, not retrospective.** Append an entry the moment an event occurs, in the same commit-cadence
  as the work. The **single canonical intake is this in-repo journal** (`AUTONOMOUS_RUN_LOG.md`, whose
  release home is `docs/retro/v1.0.0.md`), **mirrored** to `~/foreman/bugeventlog.md` per the standing
  memory directive — the in-repo journal is authoritative and is what the retro aggregates (guideline
  §5.2). The end-of-release retro *aggregates*; it is never the first record of an event.
- **Every entry is structured** per the template below and carries an **action item that is specific,
  owned, due-dated, tracked, and tagged `mitigative` (this gap) vs `preventative` (this class of
  failure)**. A preventative action MUST name the guideline condition / gate / test / auditor-persona
  to strengthen. **Owner convention:** a human owner is named directly; an **agent** owner is recorded as
  `role + model + round-id` (e.g. `adversarial-persona / Codex-GPT-5.6-Sol / round-3`) so ownership never
  defaults to nobody (guideline §5.2).
- **Four classes, always classified** (§5.3): `defect-escape` · `gate-miss` · `agent-workflow-friction`
  · `rework-cause`.
- **A skip is SKIPPED, never PASS.** Any required test reported skipped is a `gate-miss`, logged by id.
- **Independence incidents are first-class friction.** A NONE-mode role handed a manifest / prior
  verdict / implementer self-summary / severity pre-label, a wrong PUSH/PULL/NONE mode assignment, the
  Codex graphify ~25-min stall, a stale-graph / freshness-gate violation, or a manifest-skew
  re-dispatch — each is logged as `agent-workflow-friction` with the guideline §3.7 / `CLAUDE.md`
  condition implicated.
- **Reviewed before it counts** (§5.4): the aggregated release retro is reviewed by an independent
  reviewer (not the primary author of the run being retro'd) before closure.

---

## Entry template (copy per event)

```
### LL-NNN — <one-line title>
- Date:            YYYY-MM-DD
- Phase:           spec | code | verify | audit | QA | usability | security | merge | release
- Class:           defect-escape | gate-miss | agent-workflow-friction | rework-cause
- Gate item(s):    G1–G20 (and/or acceptance id A#/B#/…, test id T#/P#, persona)
- What happened:   <observable facts; "how", not "why"; link the evidence pointer>
- Evidence:        <CI run URL | test-artifact path | diff file:line | auditor verdict block>
- Second story:    <why the output/decision made sense given the context/manifest/prompt at the time>
- Contributing factors: <multiple; not a single root cause>
- Gate/condition implicated: <guideline §/condition id, CLAUDE.md rule, AGENTS.md rule, acceptance id>
- Impact:          <what shipped-unverified / was reworked / was wasted; severity under the trust model>
- Fix (mitigative):    <the concrete fix for THIS gap — owned, due-dated>
- Prevention (preventative): <the workflow/gate change for THIS CLASS — names the condition to strengthen>
- Action owner:    <name | role+model+round-id>   Due: YYYY-MM-DD     Tracking: <issue/PR>
- Guideline change for iteration 2: <exact §/condition edit, or "none — mitigative only">
```

---

## Per-gate-item event ledger (stub — fill as the release runs)

*One row per gate item; append the LL-IDs of every event touching it. "Retro-relevant events" is the
count of `defect-escape` + `gate-miss` + `rework-cause` entries — the trend-analysis substrate.*

| Gate | Item (short) | Owner | Status | Retro-relevant events (LL-IDs) |
|---|---|---|---|---|
| G1  | Public API surface / barrel / exports / tarball smoke |  | ☐ open | — |
| G2  | SemVer stability policy + CHANGELOG |  | ☐ open | — |
| G3  | Frozen error-code catalog (retryable); strip chain_archive |  | ☐ open | — |
| G4  | Contract docs (durability/migration/cancellation/lease/…) |  | ☐ open | — |
| G5  | Co-transactional watermark+data (THE blocker) | release run | ☑ CLOSED (merged `e5fcdaa`) | LL-002, LL-003 |
| G6  | Durability startup probe |  | ☐ open | — |
| G7  | Server-side timeouts (statement/lock/idle/migration) |  | ☐ open | — |
| G8  | Contract-integrity fixes (id validation, JSON depth bound, withLease) |  | ☐ open | — |
| G9  | Crash-injection / cold-start suite in REQUIRED CI |  | ☐ open | — |
| G10 | Full-sync soak + load-under-concurrent-prune |  | ☐ open | — |
| G11 | Differential-equivalence gate (in-repo, fault-schedule) |  | ☐ open | — |
| G12 | M5 live Preprod round-trip (manual pre-tag evidence) |  | ☐ open | — |
| G13 | Perf-correctness fixes (UNNEST HP-1, GROUP BY HP-2, fillfactor IS-1) |  | ☐ open | — |
| G14 | Benchmark baseline recorded (GC anti-join envelope) |  | ☐ open | — |
| G15 | SECURITY.md / threat-model doc |  | ☐ open | — |
| G16 | CheckpointStore dedup interface-doc caveat |  | ☐ open | — |
| G17 | TLS caveat + de-stub VerifyFull/--ca (keep default) |  | ☐ open | — |
| G18 | Supply-chain CI gate (npm ci / audit / ignore-scripts / gitleaks / trivy / flake.lock) |  | ☐ open | — |
| G19 | Committed Preview wallet secret → generator + .example + allowlist |  | ☐ open | — |
| G20 | Freeze Lean cut-line {T3,T5,W1,C1} + written deferral |  | ☐ open | — |

**Cross-cutting friction tally (fill as events land):**

| Friction class | Count | LL-IDs |
|---|---|---|
| Independence / confirmation-bias (NONE role framed, wrong mode) | 2 | LL-002, LL-003 |
| Stale-graph / freshness-gate / manifest-skew | 0 | — |
| Codex graphify ~25-min stall | 0 | — |
| Self-skip counted as pass | 0 | — |
| Vacuous / negative-control-missing test caught | 1 | LL-002 |
| Boundary breach attempt (indexer-agnostic) | 0 | — |
| Scope creep / deferred-code / frozen-surface widening caught | 0 | — |
| Bounded-repair exhaustion (≤3) / thrash | 0 | — |
| Tooling incompatibility (typescript-eslint+TS7, Bun+mongodb, WSL path trap, …) | 1 | LL-001 |
| Codex audit-lane reasoning-effort latency (xhigh default) | 1 | LL-004 |

---

## Event log (append-only; newest at bottom)

*First events land here from the G5 (co-transactional `save()`) close-out. Do not delete or rewrite
prior entries.*

### LL-001 — Implementer wrote G5 test files into the main checkout instead of the isolated worktree
- Date:            2026-07-23
- Phase:           code
- Class:           agent-workflow-friction
- Gate item(s):    G5 (durable-checkpoint-cursor); Stage 2–4 worktree isolation (guideline §1)
- What happened:   During G5 green-phase, the implementer lane created test files against the shared
  main checkout `/root/UmbraDB` rather than its assigned isolated worktree
  `/root/UmbraDB-durable-cursor`. Caught in the same session; the files were relocated into the
  worktree and the main checkout was confirmed clean and untouched (left at `46b6011`, with the
  Preprod sync still running against it). Net effect on `main`: none.
- Evidence:        `impl/G5-stage4-selfverify.md` Handoff note ("Main checkout /root/UmbraDB left clean
  at 46b6011 (untouched; a Preprod sync runs against it)"); the G5 work landed only on
  `impl/v1.0.0-durable-checkpoint-cursor`.
- Second story:    the run drives several parallel lanes across many similarly-named `/root/UmbraDB-*`
  worktrees plus a live main checkout hosting the Preprod sync; agent shells reset cwd between calls
  so writes use absolute paths, and the canonical `/root/UmbraDB` path is the low-friction default
  when the worktree cwd is not reasserted per command. Writing there was the sensible default given
  that context, not a disregard of the isolation rule.
- Contributing factors: many near-identical worktree paths; agent shell cwd resets between calls
  (absolute paths required); a live canonical main checkout that reads as "the" repo; no pre-write
  guard asserting the destination resolves under the assigned worktree.
- Gate/condition implicated: guideline §1 Stage 2–4 (red/green/self-verify in an isolated worktree);
  memory notes "Write tool WSL path trap" and "Agent fleets: worktrees + file reports".
- Impact:          no shipped-unverified code, no main contamination — self-corrected same session;
  minor rework to relocate the files. Severity: low.
- Fix (mitigative):    moved the stray test files into `/root/UmbraDB-durable-cursor`; verified main
  clean at `46b6011`; G5 completed entirely within the worktree.
- Prevention (preventative): add a Stage-2 pre-write precondition to the implementer manifest that the
  destination path's realpath must resolve under the assigned worktree (reject writes that land in the
  shared main checkout), and reassert `cd <worktree>` at the head of each lane command. Strengthens
  guideline §1 Stage 2–4 worktree-isolation.
- Action owner:    implementer-lane / release-run / G5-green   Due: 2026-07-24 (before G6 green)     Tracking: LL-001
- Guideline change for iteration 2: add to §1 Stage 2 a "destination realpath must be under the
  assigned worktree" write-precondition.

### LL-002 — A7 watermark-participation negative control did not fire; survived fix-round-1, caught by round-2 cold cross-vendor Codex
- Date:            2026-07-23
- Phase:           audit
- Class:           rework-cause
- Gate item(s):    G5; acceptance A6/A7; `test/postgres/save-and-advance.test.ts:57-63,73-85` guarding
  `src/postgres/save-and-advance.ts:66` (`watermarks.set(..., tx)`)
- What happened:   A7's injected failure (an out-of-range `1n` cursor) is rejected client-side by
  `WatermarkValueSchema` in `PgWatermarks.set` before any SQL is issued, so the same
  `ValidationError`/rollback observable occurs whether or not `watermarks.set` rides the combinator's
  shared tx — the negative control could not detect loss of watermark participation. Five
  Claude-family audit lanes (spec-compliance, code-quality, security, release-differential, QA) all
  returned PASS; the gap survived fix-round-1 and was caught only by the round-2 cold cross-vendor
  Codex lane (gpt-5.6-sol, NONE-mode) via an independent mutation trace (dropping `tx` at
  `save-and-advance.ts:66`).
- Evidence:        `audit/G5/CONSOLIDATED.md` finding B2; `audit/G5/codex-cold.md` finding #2
  (independently re-derived mutation trace).
- Second story:    each Claude-family lane correctly verified that the production code was sound (`tx`
  IS passed to both writes) and that A7 observably failed-and-rolled-back exactly as the acceptance
  text asks; the subtle point — that the failure fires client-side before SQL, making the control
  vacuous w.r.t. tx participation — needs a specific mutation the same-vendor lanes, sharing priors and
  reading the same acceptance wording, did not independently run (QA's mutation probe patched a
  different line, `checkpoint-store.ts:215`).
- Contributing factors: same-vendor monoculture across five lanes; the test's rollback observable is
  correct-but-insufficient; the injected fault is client-side, not server-side after SQL.
- Gate/condition implicated: guideline §1 Stage 6–9 independent audit + mandatory cross-vendor cold
  lane; acceptance A6/A7 wording.
- Impact:          one extra fix + re-audit round (rework); no shipped defect — caught pre-merge and
  the production code was already correct. Severity: medium (evidentiary gap on a durability-critical
  gate).
- Fix (mitigative):    strengthened A6/A7 per B2 — a mid-transaction external-connection assertion that
  the watermark row is not visible before the combinator commit (mirrors the proven A2 pattern), the
  chosen strongest/cheapest option; landed with the G5 test tightening (`03ebf0e` region).
- Prevention (preventative): keep the mandatory cross-vendor cold (Codex NONE-mode) lane
  **non-optional for hard classes** (co-transactional / durability / crash-ordering). The systemic
  signal is that all five same-vendor lanes PASSed while the one independent cross-vendor lane caught
  it — independence pays off. Strengthens guideline §1 Stage 6–9 cross-vendor-cold-lane condition.
- Action owner:    adversarial-persona / Codex-GPT-5.6-Sol / round-2   Due: 2026-07-23 (closed at G5 merge)     Tracking: LL-002
- Guideline change for iteration 2: none — mitigative fix; reaffirm the existing mandatory
  cross-vendor cold lane and record in §5.5 that it was load-bearing on G5.

### LL-003 — Two contract-doc statements contradicting Laws T1/W1 shipped past the same-vendor lanes, caught cold cross-vendor
- Date:            2026-07-23
- Phase:           audit
- Class:           defect-escape
- Gate item(s):    G5; A10 deliverable (`docs/checkpoint-store-contract.md`);
  `Formal/STORAGE_ALGEBRA.md` Laws T1, W1
- What happened:   two normative statements in the A10 contract doc contradicted the formal storage
  algebra: (1) a W1 claim that "watermarks.set / TemporalKV.put upserts are version-bumping"
  (`docs/checkpoint-store-contract.md:64`), contradicted by `watermarks.ts:76-81` (last-write-wins,
  no version column) and Law W1 ("no version, no history, no fold... keeps only last"); and (2) a
  parallel T1 misstatement. Both passed the doc-accuracy checks of the five Claude-family lanes and
  were caught by the cold cross-vendor Codex lane, which re-derived each claim against the source and
  the formal laws.
- Evidence:        `audit/G5/CONSOLIDATED.md` finding B3 + `audit/G5/codex-cold.md` finding #5 (W1);
  fix commits `9bd7e88` ("fix contract-doc T1 claim") and `03ebf0e` ("fix contract-doc W1 claim");
  wording nit `a36c313`.
- Second story:    the A10 doc test (`checkpoint-store-contract-doc.test.ts`) checks for the presence
  of the right tokens/cross-references, not the truth of each sentence against the algebra; the
  same-vendor lanes treated the token-level A10 test passing plus a plausible reading of the prose as
  sufficient, whereas the independent lane re-derived each factual claim against `watermarks.ts` and
  `STORAGE_ALGEBRA.md`.
- Contributing factors: A10 test is presence-based, not truth-based; the false claims are individually
  plausible and locally consistent; same-vendor lanes shared the doc-centric reading of the acceptance
  wording.
- Gate/condition implicated: guideline §1 Stage 6–9 independent audit; A10 acceptance; the doc-accuracy
  check class.
- Impact:          two factually-wrong statements would have shipped in a durability-critical gate's own
  deliverable; caught pre-merge, one-line fixes each. Severity: medium (doc defect-escape past five
  lanes).
- Fix (mitigative):    corrected both statements (T1 in `9bd7e88`, W1 in `03ebf0e`), version-duplication
  wording tidied in `a36c313`; A10 doc test re-run green.
- Prevention (preventative): strengthen the doc-accuracy audit-persona brief to require every
  normative claim in a contract doc be checked-and-verified against the cited formal law / source line
  (truth check, not token-presence), and keep the cross-vendor cold lane for the same reason as LL-002.
- Action owner:    adversarial-persona / Codex-GPT-5.6-Sol / round-2   Due: 2026-07-23 (closed at G5 merge)     Tracking: LL-003
- Guideline change for iteration 2: add to the doc-accuracy check a "every normative claim
  cited-and-verified against source/formal-law line" requirement.

### LL-004 — Codex audit-lane default `xhigh` reasoning slowed the cold cross-vendor pass
- Date:            2026-07-23
- Phase:           audit
- Class:           agent-workflow-friction
- Gate item(s):    G5; guideline §1 Stage 6–9 cross-vendor cold lane
- What happened:   the cold cross-vendor Codex lane, at its default `xhigh` reasoning effort, ran
  slower than the audit-lane budget allowed. Mitigated by lowering the reasoning effort to `high` and
  capping the run at 20 minutes (`timeout 1200 codex exec`). The lane then completed and returned its
  BLOCKED verdict, still catching B1/B2/B3.
- Evidence:        `audit/G5/codex-cold.md` header ("MODEL: gpt-5.6-sol (reasoning effort: high)");
  guideline §1 Stage 6–9 cap ("`timeout 1200 codex exec`").
- Second story:    `xhigh` is Codex's thorough default and reasonable for adversarial depth, but on a
  delta-scoped single-gate audit it over-invests time relative to the marginal findings; `high` plus a
  hard 20-min cap preserved the independent findings at a workable latency.
- Contributing factors: Codex default reasoning effort is `xhigh`; no per-lane time budget pinned at
  first dispatch; single-gate delta scope does not need `xhigh` depth.
- Gate/condition implicated: guideline §1 Stage 6–9 (cold cross-vendor lane, 20-min cap); memory
  "Codex auditor graphify stall" (adjacent Codex-lane latency class).
- Impact:          audit-lane latency only; no correctness impact — the `high`-effort run still caught
  all three blockers. Severity: low.
- Fix (mitigative):    set Codex reasoning effort to `high` and cap at 20 min via
  `timeout 1200 codex exec` for the G5 cold lane.
- Prevention (preventative): bake "`reasoning=high` + `timeout 1200`" as the standing
  cross-vendor-cold-lane default in the audit brief (already the guideline §1 cap), and carry the
  standing "skip graphify" directive per memory to avoid the ~25-min stall class.
- Action owner:    adversarial-persona / Codex-GPT-5.6-Sol / round-2   Due: 2026-07-23 (applied for G5; standing for G6–G8)     Tracking: LL-004
- Guideline change for iteration 2: none — codifies the existing §1 cap as the lane default.

---

## Iteration-2 intake

*The entry gate for iteration-2 spec drafting. Iteration 2 MUST NOT begin until every `preventative`
action item below is either LANDED (a concrete workflow change committed) or RE-DEFERRED
(explicit, owner-signed, with a tracking item). Seeded empty; populated by aggregating the event log at
release close-out.*

### A. Preventative actions to land or re-defer before iteration 2 begins

| # | Source LL-ID | Preventative action | Consumption target (by name) | Status | Owner | Decision |
|---|---|---|---|---|---|---|
| — | — | — | — | ☐ | — | LAND / RE-DEFER |

### B. Named consumption targets (guideline §5.5) — record the actual edit made

- **`CLAUDE.md`** — PUSH/PULL/NONE table + guardrails; recalibrate the **150-line manifest-skip
  threshold** and the **Sprint-4 token baseline (94.6k / 108.7k / 79.1k)** with the real per-sprint
  measurements recorded during this release. Edit made: _______
- **`AGENTS.md`** — audit-persona set + re-audit rule. Edit made: _______
- **Gate definitions G1–G20 + each `acceptance.md`** — tighten any gate a defect escaped through. Edit
  made: _______
- **Perf regression gate** — replace the 1.0 "coarse" gate with the **CV-aware calibrated regression
  gate** (the council's first post-1.0 obligation). Edit made: _______
- **`v1-implementation-guideline.md`** — amend any condition that failed to catch a defect or caused
  friction; log the amendment here. Edit made: _______

### C. Trend analysis (across events, not per-incident)

*Fill at close-out: which phase produced the most escapes? which class of bug recurred? was any defect
catchable one phase earlier (design vs implementation vs audit)? did the PUSH-scoping token bet pay off
against the Sprint-4 baseline once normalized per changed line? Record the systemic signal, not just the
per-event fixes.*

- Phase with most defect-escapes: _______
- Recurring bug class: _______
- Earliest catchable phase for the worst escape: _______
- PUSH-scoping token outcome vs Sprint-4 baseline (per changed line): _______
- Systemic guideline change recommended for iteration 2: _______

### D. Retro review sign-off

- Independent reviewer (not the run's primary author): _______   Date: _______   Verdict: ☐ closed

---

*Append-only. Never pruned. This log is the substrate that makes the workflow itself improve across
iterations.*
