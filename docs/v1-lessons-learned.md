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
| G5  | Co-transactional watermark+data (THE blocker) |  | ☐ open | — |
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
| Independence / confirmation-bias (NONE role framed, wrong mode) | 0 | — |
| Stale-graph / freshness-gate / manifest-skew | 0 | — |
| Codex graphify ~25-min stall | 0 | — |
| Self-skip counted as pass | 0 | — |
| Vacuous / negative-control-missing test caught | 0 | — |
| Boundary breach attempt (indexer-agnostic) | 0 | — |
| Scope creep / deferred-code / frozen-surface widening caught | 0 | — |
| Bounded-repair exhaustion (≤3) / thrash | 0 | — |
| Tooling incompatibility (typescript-eslint+TS7, Bun+mongodb, WSL path trap, …) | 0 | — |

---

## Event log (append-only; newest at bottom)

*No events yet. First entry begins LL-001. Do not delete or rewrite prior entries.*

<!-- LL-001 — <title>
   (copy the entry template above)
-->

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
