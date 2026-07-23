# UmbraDB V1.0.0 Implementation Guideline — the release constitution

*Status: GOVERNING. Authored by the synthesis lead from six facet briefs (spec→code, verification/audit,
QA, usability/DX, security, release/retro), the consolidated roadmap
(`umbradb-v1-research/ROADMAP-v1.0.0-CONSOLIDATED.md`), the three council rulings (A-release-scope,
B-engineering-risk, C-security), and the live repo at `/root/UmbraDB` (`CLAUDE.md`, `AGENTS.md`,
`openspec/config.yaml`, `ROADMAP.md`, `Formal/`, `.github/workflows/{conformance,lean}.yml`).*

*Every MUST / MUST NOT below is a condition a downstream agent is checked against — an entry/exit
criterion, a required artifact, or an objective definition-of-done — not an aspiration. Where a
condition restates a repo rule, it cites it; where it adds one, it says so.*

---

## §0 — Purpose & authority

**§0.1 What this document is.** This is the single governing constitution for the entire UmbraDB
1.0.0 implementation: the custom, high-assurance workflow for turning an OpenSpec/EARS change into
automated, agent-generated code, and the hard conditions every downstream agent — Implementation,
Audit, QA, Usability, Security — MUST follow while implementing the 20-item roadmap (G1–G20) and
tagging `v1.0.0`.

**§0.2 Authority & precedence.** This guideline governs every gate item and every agent for the
1.0.0 release.

1. It **binds on top of** — never overrides — the repo's own standing policy files. On any conflict
   the more specific repo file wins in its own domain: `CLAUDE.md` (graph-scoped PUSH/PULL/NONE
   review policy + confirmation-bias rule) is authoritative on **reviewer independence and manifest
   mechanics**; `AGENTS.md` is authoritative on the **multi-persona audit cadence and Lean workflow**;
   `openspec/config.yaml` is authoritative on **spec/design/tasks drafting rules and the
   verify-against-installed-version correctness rule**. This guideline may add conditions but MUST NOT
   weaken any of those.
2. Each `v1.0.0-*` change's own `spec.md` / `acceptance.md` is authoritative on **what that gate item
   requires**; this guideline is authoritative on **how work is produced, verified, and closed** and
   on the **cross-cutting invariants** (§3).
3. The user's standing directives override the harness default and are binding here: **no
   Co-Authored-By Claude / no AI-attribution** in commits, PR bodies, tag messages, `CHANGELOG.md`, or
   release bodies (MEMORY `no-claude-coauthor`); **persistence stays indexer-agnostic** (MEMORY
   `umbradb-sync-architecture-boundary`).

**§0.3 The three hard project invariants** (restated once, enforced everywhere in §3):
- **Indexer-agnostic boundary.** `src/` persistence code MUST NEVER import or depend on the
  indexer/consumer application. The consumer is test infrastructure at most, never a dependency.
- **Single trusted writer.** The whole trust model is one trusted writer against one local Postgres.
  Multi-writer / lease-fencing / cross-tenant issues are documentation obligations for 1.0.0, not code
  blockers (council C).
- **Not distributed.** UmbraDB is a single-node storage **library**, not a service and not a
  distributed system. Its public API surface, written contracts, and error catalog **are** the product.

**§0.4 The load-bearing meta-condition — reviewer independence.** The confirmation-bias finding
(arXiv 2603.18740: contextual framing dropped a reviewer LLM's vuln-detection accuracy by up to **93.5
percentage points**; stripping the framing recovered ~94%) is a **security control**, not a cost
optimization.
[^cite-2603]

[^cite-2603]: The paper's arXiv title reads *"Measuring and Exploiting **Contextual** Bias in
LLM-Assisted Security Code Review"* (verified against arXiv). This guideline follows the repo-authoritative
`CLAUDE.md`, which names it the "**confirmation** bias" finding; the 93.5pp/~94% result and the
independence rationale are unaffected by the naming.
Independence of cold/adversarial reviewers is **non-negotiable**. Every review role in this release
carries exactly one graph mode from `CLAUDE.md` — **PUSH**, **PULL**, or **NONE** — and no condition
in this document may be read as license to hand a NONE-mode role a manifest, a prior verdict, a prior
agent's findings, an implementer's self-summary, or any severity pre-labeling. See §2 per role and
§3.7.
Source: <https://arxiv.org/abs/2603.18740>.

---

## §1 — The high-assurance spec→code workflow

The ordered pipeline that turns one OpenSpec change into merged, verified code. Each stage has a
**gate**: an objective condition that MUST be green before the next stage may begin. A stage that is
not green blocks; there is no "proceed anyway."

**Gate outcomes are three, not two: `PASS`, `BLOCK`, or `N/A-with-reason`.** `N/A-with-reason` is a
first-class, **recorded** outcome — a stage is `N/A` only when the applicability rule below says it does
not apply to this change, and the recorded line MUST name why (e.g. "Stage 8: N/A — no public-surface
delta"). A stage is **never silently skipped**: it is `PASS`, `BLOCK`, or an explicitly recorded
`N/A-with-reason`. A missing record is treated as `BLOCK`.

**§1.0 — Stage-applicability & phase-in (which gates bind which change).** The five `v1.0.0-*` changes
do not each touch the same surface, and some gates are themselves *introduced* by a later roadmap item.
Two rules make the pipeline executable for all five changes:

- **Applicability matrix.**
  - **Stages 0–7, 10** apply to **every** change (spec-ready, plan, red, green, self-verify, executable
    gates, independent audit, QA, merge).
  - **Stage 8 (Usability)** applies **only** to a change that alters the public API surface, the error
    catalog, or the written contracts — in practice `v1.0.0-api-surface` and the release candidate. Every
    other change records **`Stage 8: N/A — no public-surface delta`**; the api-surface change and the RC
    MUST clear Stage 8 in full (an N/A is impossible for them).
  - **Stage 9 (Security)** **always runs**, but its *depth* is scoped: the injection trace is
    `N/A`-stated when the change touches no frozen-surface `src/postgres/**` file (§2.5); the
    supply-chain gate, threat-model, TLS, secrets, and interface-doc conditions (G15–G19) are owned by
    the `v1.0.0-infosec-signoff` change and the RC; **every** change still passes the minimal security
    DoD (no committed secret, no CWE-532 leak on a value-carrying write path, indexer-agnostic boundary
    intact).
- **Phase-in rule (a later gate is not retroactively required of an earlier change).** The set of
  executable gates a given change MUST satisfy at Stage 5 = **the required gates present on `main` at
  that change's merge-base, PLUS every gate the change itself introduces.** A gate delivered by a later
  roadmap item (crash suite G9, soak/differential G10/G11, StrykerJS mutation, coverage config) is
  **not** required of a change that merges before that item lands. Concretely: the first critical-path
  change (`v1.0.0-durable-checkpoint-cursor`, G5) runs the gates it introduces plus whatever `main`
  already has (`vitest run`, `lean.yml`), and does **not** fail Stage 5 for the absence of a crash/soak/
  mutation gate that G9–G11 will build. Each change's Stage-5 required-gate set is recorded in its PR.
- **Coverage/mutation infrastructure has a named owner and a due point.** The coverage config
  (`perFile`, per-glob durability thresholds) and the StrykerJS mutation gate that §2.3/§3.6 require are
  **not** unowned aspirations: they are a tracked build-out task owned by the `v1.0.0-recovery-testing`
  change (natural home — it owns the crash/soak/differential gate wiring), and they **MUST be merged and
  CI-wired before G9 is declared CLOSED**. From that merge point forward the §2.3/§3.6 thresholds bind
  as required gates; before it, a change is not failed for their absence (phase-in rule). QA is a
  verification role and MUST NOT be the owner that *lands* this infra.

```
STAGE 0  Spec-ready        →  STAGE 1  Plan/verify-first  →  STAGE 2  Red (failing tests)
      →  STAGE 3  Green (implement)  →  STAGE 4  Self-verify  →  STAGE 5  Executable gates
      →  STAGE 6  Independent audit  →  STAGE 7  QA evidence  →  STAGE 8  Usability
      →  STAGE 9  Security sign-off  →  STAGE 10 Merge  →  (per release) STAGE 11 Tag 1.0.0
```

**Stage 0 — Spec-ready (design panel + Fable-5 consolidation).**
The OpenSpec change (`proposal.md`/`design.md`/`specs/*/spec.md`/`tasks.md`/`acceptance.md`) is
authored and reviewed by the design panel in the modes `CLAUDE.md` fixes: requirements-completeness/EARS
panelist = **NONE**; adversarial-risk panelist = **NONE**; fidelity-to-prior-art = **PULL**; Fable-5
consolidator = **PUSH**. Codex GPT-5.6 Sol spec audit = **NONE (cold)**.
**Gate S0:** the change has an EARS `spec.md` and an `acceptance.md` whose criteria are numbered,
individually verifiable, and each carries an explicit verification-method tag **from the change's own
declared legend**. The requirement is that the legend covers, at minimum, the seven canonical semantic
classes — **{automated-CI, crash/fault, property, differential, static-check, doc-artifact,
manual-evidence}** — not that a change use one literal spelling. (The five existing changes legally
differ: api-surface uses `[unit][prop][CI][doc][manual]`; recovery-testing uses `CI + static`,
`CI + crash-test`, `static (import audit)`; perf-baseline uses `bench + manual`, `ci + manual` — each
is S0-valid because every criterion carries a method tag mapping to one of the seven classes. The
canonical list is the required *class* coverage, the authoritative vocabulary for cross-change
reconciliation — never a required literal string.) Every proposal states its explicit non-goals
(`config.yaml` proposal rule). No implementation code may be written against a change that has not
cleared S0.

**Stage 1 — Plan / verify-first.** Before any code, the Implementation agent reads all prior art the
change cites (§2.1 A1) and **verifies every external API/library/SQL claim against the actually
installed dependency version or real upstream source** (`config.yaml` correctness rule; brief
spec-to-code F4/A4). Hallucinated APIs, invalid paths, and architectural mismatches are caught here,
before code depends on them.
**Gate S1:** each external claim the task relies on is cited to `file:line` in the installed dependency
or a version-pinned doc URL, or explicitly flagged "unconfirmed" (and then NOT coded as if true).

**Stage 2 — Red.** For each acceptance scenario, write the `vitest`/`fast-check` test **first**, run
it, and **observe it fail for the intended reason** (behavior absent), not from an import/typo error.
**Gate S2:** an observed red state is recorded for every named scenario; the test set is the exact
named acceptance scenarios (never "add tests"), tied to the task's blast radius (brief spec-to-code
F1/F2/F3).

**Stage 3 — Green.** Implement the one task, minimally, until its named tests pass. Full-output
discipline (§3.2) and SQL discipline (§3, §2.1 C3) apply. One task = one atomic change set.
**Gate S3:** all named tests for the task pass locally; no placeholder/stub/`TODO`/`any`-escape
remains; `src/` byte-unchanged where the task says "keep existing path unchanged."

**Stage 4 — Self-verify (the implementer's own gate — necessary, never sufficient).** Run
`npm run typecheck` (`tsc --noEmit`) and `npm test` (`vitest run`); paste the actual passing output;
produce a criterion-by-criterion checklist mapping each acceptance criterion → the test id that proves
it → its pass line.
**Gate S4:** green-with-evidence; every acceptance criterion individually checked; the handoff is
**structural facts only** (files, tests, criteria→evidence), never persuasive prose that would frame
the downstream independent auditors (§2.1 D7; brief spec-to-code F6).

**Stage 5 — Executable gates run.** The machine oracles run **before** any LLM audit consumes them.
The **required-gate set for this change** is fixed by the §1.0 phase-in rule (gates present on `main` at
the merge-base **plus** the gates this change introduces) — the full end-state gate is
`npm run test:conformance` (unit + P1–P10 property + crash + soak + differential + skip-enforcement +
coverage), the mutation baseline check, and the Lean trust gate (`lean.yml` → `#audit_umbradb_trust`
in `Formal/Lean/UmbraDBFormalTest/Trust.lean`: zero `sorry`, no UmbraDB decl depending on an axiom
outside `{propext, Quot.sound, Classical.choice}`; `lake build --wfail`), but a change is only required
to run the subset that exists at its merge-base plus what it itself lands. Each change's PR records its
Stage-5 required-gate set.
**Gate S5:** every gate in this change's required set is green with negative controls present; no
required test reports `skipped` (verified by the skip-enforcement reconciliation, not by a green badge).
A gate not yet introduced at this change's merge-base is recorded `N/A — introduced by <later gate item>`,
never silently ignored. The LLM auditors verify **that these gates are real and green**, they do not
substitute for them (brief verification-audit F2/D1).

**Stage 6 — Independent audit (the AGENTS.md three-persona panel).** Three independent, read-only
personas — (1) domain-correctness, (2) adversarial (counterexamples, unsound assumptions, security
failures, **vacuous claims**), (3) release (tests, trust gates, reproducibility, docs, artifacts,
GitHub readiness) — plus this repo's real machinery: PUSH-scoped Opus spec-compliance auditor,
PUSH-scoped Opus code-quality/test-coverage auditor, the **final differential-review agent** (PUSH-weak,
full diff, mandatory root-contained import backstop), **NONE-mode Codex GPT-5.6 Sol cold audit**, and
Fable-5 consolidation. Cross-vendor adversarial on the hard classes (§2.2 B2).
**Gate S6:** every distinct `BLOCK` survives consolidation with its origin `file:line` (no
consensus-laundering); all blocking findings fixed and independently re-audited to `PASS`; the audit
ran **after `main` integration**.

**Stage 7 — QA evidence.** QA re-runs the required gate, the skip-enforcement reconciliation, coverage,
and mutation, and confirms each acceptance criterion is a **run-and-passed** test (not a claim), each
fault test has a firing negative control, each concurrency test a forced interleave, with its own
**in-repo** reference oracle (§2.3).
**Gate S7:** the per-change QA definition-of-done (§2.3 DoD) holds.

**Stage 8 — Usability (applies only to a public-surface / error-catalog / contract change — §1.0).**
Two sub-roles (§2.4): contract/surface-conformance (**PUSH**) and cold-consumer ergonomics
(**NONE — published artifacts only, no `src/`, no manifest**).
**Gate S8:** for an in-scope change (api-surface, RC) the DX acceptance report maps every U-condition to
PASS/BLOCK + evidence and publint/attw, surface-snapshot diff, docs-as-tests, and message-quality gates
are green; for every other change the gate is recorded **`N/A — no public-surface delta`** and does not
block.

**Stage 9 — Security sign-off (always runs; depth scoped per §1.0).** Security enforces (does not
re-litigate) the council rulings; the cold adversarial pass runs **NONE-mode** with repo+spec bytes only
and instructed to **skip `graphify`**. The injection trace is `N/A`-stated when the change touches no
frozen-surface `src/postgres/**` file; the G15–G19 supply-chain/threat-model/TLS/secrets/interface-doc
conditions are owned by the `v1.0.0-infosec-signoff` change and the RC; **every** change still clears the
minimal security DoD (§2.5).
**Gate S9:** the per-change security DoD (§2.5) holds; every finding is CWE/OWASP-mapped with a
trust-model precondition.

**Stage 10 — Merge.** Deterministic merge gate: every required CI gate green on the integrated tree;
Lean trust gate green with un-widened axiom allowlist; every `BLOCK` re-audited to `PASS`; persona
verdicts + validation evidence recorded in the PR (`AGENTS.md`); `graphify update .` run and
`graphify-out/` committed in the close-out; audit token cost recorded (§3, brief verification-audit
F5). No force-push, no history rewrite, branch off `main` (never the default branch directly).

**Stage 11 — Tag (per release, once all 20 gate items are GREEN).** §4.

**Manifest-scoping note (applies to Stages 6/8/9 PUSH roles only).** The scoped `review-manifest.md` is
built once per round by the orchestrator against `graphify-out/graph.json` per the `CLAUDE.md`
mechanism (freshness gate: graph `built_at_commit == HEAD`; diff computed `<base>`-through-working-tree,
not `<base>..HEAD`; radius capped by hop distance only, never by confidence score; import backstop
root-contained). It is **advisory scope, not evidence**. It is never handed to a NONE role. If any
manifest is regenerated mid-round, **void and re-dispatch every PUSH run in that round**.

---

## §2 — Role conditions

Each subsection is a contract the named agent is checked against. **Roles that appear in `CLAUDE.md`'s
PUSH/PULL/NONE table keep their modes unchanged — this document does not reassign them.** New roles this
document introduces that `CLAUDE.md` does not list (the usability sub-roles, the security lanes) are each
assigned **exactly one** mode by the *same* criteria `CLAUDE.md` uses ("diff-against-a-fixed-spec" ⇒
PUSH; cold/adversarial fresh-context verification ⇒ NONE), and the iteration-2 intake (§5.5) folds them
into `CLAUDE.md`'s table so the two documents converge.

### §2.0 — Orchestrator (the role that can break independence by mistake)

The orchestrator dispatches every review round and constructs every manifest. It has no verdict of its
own, but its handling of scope and framing is load-bearing for the confirmation-bias control (§0.4), so
it carries a checkable contract:

- **O1 (manifest once per round).** MUST build the scoped `review-manifest.md` **once per round** from
  `graphify-out/graph.json` per the `CLAUDE.md` mechanism (freshness gate, `<base>`-through-working-tree
  diff, hop-distance-only radius, root-contained import backstop), and MUST NOT dispatch a PUSH round
  against a stale graph (`built_at_commit != HEAD`).
- **O2 (NONE isolation, attested BEFORE dispatch).** MUST NOT include a manifest, a prior verdict, a
  prior agent's findings, an implementer self-summary, or PR/commit framing in any NONE-role prompt
  (§2.2 A1). For every NONE run the orchestrator MUST record a prompt-hygiene attestation — that the
  prompt contained none of these — **before** the run is dispatched; the attestation is a required
  artifact and a NONE run without it is void.
- **O3 (mode assignment).** MUST assign each dispatched reviewer exactly one mode, matching `CLAUDE.md`'s
  table for listed roles and §2's criteria for new roles; MUST NOT relabel a role to "save tokens."
- **O4 (stage order & N/A recording).** MUST enforce the §1 stage order and record each stage's outcome
  as `PASS` / `BLOCK` / `N/A-with-reason` (§1.0) — never a silent skip.
- **O5 (void-and-re-dispatch).** If any manifest is regenerated mid-round, MUST void and re-dispatch
  **every PUSH run** in that round (§1 manifest-scoping note); MUST void any Codex Sol run that rebuilt
  the graph (§2.2 A2).

### §2.1 — Implementation agent

**Mandate.** Turn one OpenSpec change into complete, verified code, **one `tasks.md` task at a time**,
each task closed only after the audit cadence approves. "The task's spec" = this change's `design.md`
+ `specs/<capability>/spec.md` + the specific `tasks.md` acceptance block.

**Entry criteria (MUST all hold before writing any implementation code).**
- **A1 — Prior art read first.** MUST read this change's `proposal.md`, `design.md`, `specs/*/spec.md`,
  and the specific `tasks.md` block, plus the cited sections of `design/design.md`,
  `design/design-interfaces.md`, and `Formal/STORAGE_ALGEBRA.md` (`config.yaml` design rule). MUST NOT
  begin a task whose `design.md` citation it has not opened.
- **A2 — Single task, dependencies satisfied, ordering respected.** MUST implement only the one task
  whose `Depends on:` predecessors are all CLOSED, and MUST respect critical-path ordering — the
  signature-changing G5 co-transactional `save` lands **before** the API freeze (G1–G4) and before its
  crash-test dependents (T5, fault-schedule G11).
- **A3 — Acceptance criteria are the contract.** MUST extract this task's concrete acceptance criteria
  verbatim and treat them as the definition of done. An ambiguous/untestable criterion is escalated
  (E), never silently reinterpreted weaker.
- **A4 — External claims verified against installed reality.** For every external API/library/SQL
  behavior relied on, MUST verify against the installed version (`postgres@^3.4.9`, `zod@^4`, Node ≥24)
  or real upstream source and cite `file:line`/version-pinned URL. MUST NOT assert a Postgres/SQL
  semantic (e.g. advisory-lock/`lock_timeout` interaction) without an executed reproduction.

**Hard constraints (MUST / MUST NOT).**
- **B (test-first).** For each acceptance scenario, write the test first, run it, observe it fail for
  the intended reason (behavior absent), record the red state. Tests are the exact named scenarios,
  never generic coverage. Algebra-bearing tasks map to seed-pinned `fast-check` properties (P1–P10).
  DB-touching tests run against Testcontainers Postgres, not mocks. One task = one atomic change set.
- **C1 — Determinism.** No `Date.now()`/wall-clock, no unseeded randomness, no network to non-container
  hosts, no port races; `fast-check` seed pinned and reported.
- **C2 — Full output, no placeholders.** MUST NOT ship `TODO`, `// ...`, "implement later", stubbed
  bodies, `throw new Error("not implemented")`, elided SQL, or `any`-typed escape hatches. Every
  generated file is complete and compiles. If output would exceed a token limit, split at
  file/function boundaries across turns — never abbreviate (repo `full-output-enforcement`).
- **C3 — SQL discipline.** All SQL uses `postgres.js` tagged templates with parameterized values (no
  string-concatenated SQL, no ORM). The **schema name is the only interpolated identifier**, via
  `sql(schema)` and `assertValidSchemaName`. **Within the 1.0.0 frozen-surface modules** — all of
  `src/postgres/**` **excluding** `chain-archive-rollover.ts`, `chain-archive-store.ts`, and
  `migrations/chain_archive/**` — the **only** `sql.unsafe()`/`.unsafe()` sites are the three existing
  `SET [local] …_timeout` calls (`transaction-lease.ts:221,285,347`), whose safety rests on
  `z.number().int().positive()` schemas that MUST NOT be loosened. (The chain-archive files legitimately
  contain identifier-quoted partition-bound DDL `unsafe()` sites — `chain-archive-rollover.ts:297–334`,
  `migrations/chain_archive/001:768,773` — which are **out-of-frozen-surface**, under their own review,
  and never re-exported; the frozen-surface invariant is scoped to exclude them so it is true against
  `main`.) This invariant is enforced **mechanically**, not by prose: a static allowlist test
  (file + exact count of `unsafe(` sites, in the same spirit as the existing import guards) MUST fail CI
  by diff on **any new `unsafe(` site anywhere in `src/`** — including inside the chain-archive files.
  Widening that allowlist is itself a **BLOCKING** security finding (§2.5). Untrusted/off-host inputs
  (`walletId`, `networkId`, JSON values) validated by a shared `zod` schema **before any statement
  issues** (G8).
- **C4 — Typed errors.** New failure modes use the frozen typed error classes / `errors.ts` catalog
  with the `retryable` field; tests assert the **typed** error, never a raw driver error.

**Required artifacts / outputs.**
- The complete diff for exactly one task.
- Passing `tsc --noEmit` and `vitest run` output pasted verbatim.
- A criterion-by-criterion checklist: each acceptance criterion → test id → pass line.
- A traceability note: each new code unit cites the spec heading/requirement it satisfies (never a
  non-existent id — a cited id absent from the spec is a fabricated requirement).
- At change close-out: `graphify update .` run and refreshed `graphify-out/` staged in the same commit;
  Lean skill workflow evidence if the task touches a cut-line law {T3,T5,W1,C1}.

**Definition-of-done.** Green-with-evidence (D1); every acceptance criterion individually checked (D2);
requirement traceability present (D3); the change's explicit **non-goals confirmed not implemented**
(D4 — scope creep is a blocking finding); the indexer-agnostic boundary proven by a static
import-lint test (D5); Lean/graph obligations discharged (D6); handoff is structural-facts-only (D7).

**Forbidden behaviors.**
- MUST NOT audit its own diff or count self-critique as an independent pass.
- MUST NOT hand any NONE-mode role framing, and never sees the auditors'/cold-Codex context.
- MUST NOT weaken or edit an acceptance test to force green; MUST NOT bundle unrelated edits.
- MUST NOT implement a deferred capability (idempotency key, lease fencing, keyed chunking, encryption
  seam, streaming load, observability API) or change a frozen signature/error code to satisfy a
  criterion.
- MUST NOT breach the indexer-agnostic boundary to make a test pass (highest-severity regression).

**Independence rules.** The Implementation agent is the source of the diff and is **never** a reviewer
of it. Its self-verification is the implementer's own gate — necessary, never assurance. The handoff
form is engineered so the diff is **self-evidently checkable**, not pre-argued (arXiv 2603.18740).

**Stop-and-escalate (MUST NOT push through).** An untestable/self-contradictory criterion or one
contradicting `design/design.md`/`STORAGE_ALGEBRA.md` (E1); a green that requires changing the spec, a
public signature, or a frozen error code post-freeze (E2); an external claim unverifiable against
installed source (E3 — flag "unconfirmed"); the bounded repair loop exhausted (**≤3** red→green
attempts on the same failing test, then report state + hypotheses and escalate — never thrash or weaken
the test) (E4); a criterion that can only be met by breaching the boundary (E5).

### §2.2 — Audit agent(s)

**Mandate.** Sit downstream of implementation, upstream of QA/usability/security/merge. Independently
verify a diff (a) satisfies its frozen spec/acceptance, (b) does not break code the diff doesn't touch,
(c) upholds the algebraic laws the Lean gate and property tests encode, (d) carries no un-evidenced
claims. "Auditor" = the Opus spec-compliance auditor (PUSH), the Opus code-quality/test-coverage
auditor (PUSH), the final differential-review agent (PUSH-weak + full diff + mandatory import
backstop), the Fable-5 consolidator (PUSH), and the Codex GPT-5.6 Sol cold persona-panel (NONE).

**Entry criteria.** A green `tsc --noEmit` on the diff; for PUSH rounds, the freshness gate satisfied
(`graphify-out/graph.json` `built_at_commit == HEAD` — a manifest self-stamp is NOT proof); the audit
runs **after the branch is integrated with current `main`** (a late `main` merge triggers re-audit).

**Hard constraints (MUST / MUST NOT).**
- **A1 (NONE-mode integrity — hard rule).** A NONE-mode role (Codex Sol cold panel; design
  adversarial-risk and requirements-completeness/EARS panelists) MUST NOT receive the
  `review-manifest.md`, any prior auditor's findings/verdict, the implementer's self-summary, or
  PR/commit framing beyond the raw diff + frozen spec/acceptance + repo bytes. The orchestrator MUST
  record, per NONE run, that its prompt contained none of these. A violation **voids** that run's
  verdict.
- **A2.** The Codex Sol cold pass MUST be explicitly instructed to **skip `graphify`** (known ~25-min
  auto-trigger stall). A run that rebuilt the graph is void.
- **A3.** At least one auditor per round runs in **true NONE mode** (the fresh-context verifier).
  Self-critique never counts as one of the required independent passes.
- **A4 (PUSH hygiene).** A PUSH manifest carries structural facts only (hop distance + edge provenance
  `EXTRACTED`/`INFERRED`), opens with the provenance header then the exact line "Advisory scope, not
  evidence. You may read beyond this list.", and contains no interpretive prose. This is a partial
  mitigation; the guarantee is the mode split (A1).
- **B1 (required panel).** Every nontrivial tranche passes the three-persona audit
  (domain-correctness, adversarial, release) — independent and read-only (`AGENTS.md`).
- **B2 (cross-vendor on hard classes).** A tranche touching G5 (co-tx save/cursor), G9–G11
  (crash/soak/differential), lease code, or GC/prune concurrency MUST have its adversarial persona run
  by a **different model family** than the implementer and than the spec-compliance auditor. This is a
  **repo-policy rule**, authoritative on its own terms: `CLAUDE.md`'s "cross-vendor adversarial audit on
  the hard classes" and the consolidated roadmap's cross-vendor-adversarial ruling (restated in §3.7).
  It is empirically corroborated — but not derived — by the finding that race conditions, timing side
  channels, and complex authorization logic are inherently difficult vulnerability classes for LLM
  reviewers (arXiv 2602.16741, *"Can Adversarial Code Comments Fool AI Security Reviewers …"*, which
  reports detection failures concentrating on exactly those classes). The cross-vendor *remedy* rests on
  the repo policy, not on that paper; no external citation is load-bearing for this rule.
- **B3 / B4.** Each auditor emits per-finding **severity** and an overall **`PASS`/`BLOCK`** verdict.
  Fable-5 preserves every distinct `BLOCK` with origin `file:line`; MUST NOT down-rank/drop a minority
  `BLOCK` to manufacture agreement. A single unresolved `BLOCK` keeps the tranche blocked.
- **C1 (evidence).** Every finding cites `file:line` in the diff/working tree — a finding citing only
  a graph node/manifest entry/hop-distance is **inadmissible** and re-grounded or dropped.
- **C2 (confidence asymmetry).** No `INFERRED`/`AMBIGUOUS` edge, at any score, may be cited to
  **exclude** a file or justify "no issue here" without the auditor **opening the underlying file**.
- **C3 (external claims).** Any claim about `postgres.js`/Postgres semantics/Node/SDK behavior cites
  `file:line` in the installed dep or a version-pinned URL — never training-data recall.
- **C4 (no vacuous "verified").** The adversarial persona actively hunts vacuous passes: an assertion
  of nothing falsifiable, a "bounded" watchdog with no threshold, a crash test whose kill window is
  unreachable, a differential check whose sides are trivially equal. A finding-of-absence for a
  resilience/differential test MUST identify the **negative control** that proves the test can fail —
  and BLOCK if none exists.
- **D (executable oracles — each individually citable).**
  - **D1.** The claimed invariant MUST be pinned by a **running** test in the required gate, not auditor
    reasoning (auditor reasoning about ordering bugs is advisory only).
  - **D2.** Required crash/soak/differential tests run in `test:conformance` with `UMBRADB_LIVE_PREPROD`
    **unset**, proven executed by the skip-enforcement mechanism (a `skipped` required test turns the
    audit red).
  - **D3.** The differential/equivalence reference is a **fault-free replay of the same in-repo
    harness** — importing the consumer/indexer is a hard BLOCK.
  - **D4.** Property tests derive from `STORAGE_ALGEBRA.md` §5 (P1–P10) and run on real Postgres.
  - **D5.** T5 asserts watermark-never-ahead under `synchronous_commit=on` **and** `=off` with an
    unclean immediate postmaster kill; inverted durability order is a BLOCK, a lost tail is acceptable.
  - **D6.** T5 / fault-schedule G11 MUST be **pending, not green**, until G5 merges.
- **E (Lean gate — each individually citable).**
  - **E1.** The release persona confirms the Lean trust gate green (zero `sorry`; no axiom outside the
    allowlist).
  - **E2.** No tranche widens `permittedProjectAxioms`/`dependencyAxiomDeclarations` to pass a proof —
    the adversarial persona diffs these arrays against merge-base and BLOCKs any unjustified addition.
  - **E3.** The 1.0.0 cut-line is frozen at **{T3,T5,W1,C1}** with a written deferral of the rest; no
    ASPIRATIONAL law is represented as GUARANTEED.
  - **E4.** An abstract theorem MUST NOT be claimed as proof of the runtime Postgres behavior.

**Required artifacts.** Per persona: a findings list (each with `file:line`, severity, CWE/acceptance/
gate id, and `PASS`/`BLOCK`); the Fable-5 consolidation preserving every `BLOCK`; the recorded
NONE-run prompt-hygiene attestation; the recorded audit token totals per auditor (SHOULD, normalized
per changed line, compared to the Sprint-4 baseline ~94.6k / ~108.7k / ~79.1k).

**Definition-of-done.** Zero open `BLOCK`s after targeted re-audit (the fixer MUST NOT self-certify the
fix — every prior `BLOCK` has an independent `PASS`); every `BLOCK` traceable to a spec requirement /
acceptance id / gate `G1–G20`; verdicts + validation evidence recorded in the PR before merge; graph
refreshed at close-out.

**Forbidden behaviors.** Scoping a NONE role "to save tokens"; treating the LLM as the oracle for
race/ordering bugs; counting a self-skipping or vacuous test as green; accepting a differential gate
that reaches into the consumer/indexer; letting axiom-allowlist or `sorry` drift pass; consensus-
laundering a minority BLOCK; severity-inflating an in-model-non-exploitable item (dedup oracle, lease
fencing) into a 1.0 code blocker (miscalibration dilutes the one true correctness blocker, G5).

**Independence rules.** Modes are fixed by `CLAUDE.md` and not reassigned. The Codex Sol cold audit is
**NONE — hard**; design adversarial-risk and EARS-completeness panelists are **NONE**;
fidelity-to-prior-art is **PULL**; the three implementation-stage PUSH roles share the identical
manifest+design+spec prompt prefix for cache reuse.

### §2.3 — QA agent

**Mandate.** Own the objective, executable evidence layer. QA does not duplicate the audits; it makes
"green CI ≠ done" real by checking negative controls, forced interleaves, mid-run sampling, coverage,
and mutation that a green badge cannot show. "The gate" = `npm run test:conformance` in
`conformance.yml`.

**Entry criteria.** A change reaches QA only after the two-Opus cadence + the Codex cold audit have run
(`AGENTS.md`), and it carries, as appropriate to what it touches: unit/example tests for every changed
public behavior incl. the typed-error path; P1–P10 property tests where an algebra-bearing module is
touched; the crash/fault tests for durability/recovery/lease/cursor changes; the soak; the differential
check.

**Hard constraints (MUST / MUST NOT).**
- **QA-1 / QA-2 (evidence-first, independent oracle).** No item is "green" on assertion or a green
  badge — QA points to the specific run-and-passed test id / artifact / reporter output. QA MUST NOT
  accept a reference oracle, "known-good" state, or pass/fail judgment produced by the implementation
  agent for that same change. Differential/soak reference sides are built **in-repo** from UmbraDB's
  own adapters (`test/postgres/reference-merge.ts`), never imported from a consumer/indexer and never
  inherited as "the impl says this is correct." A graph manifest handed to QA is advisory-weak at most;
  QA reads actual test bodies and the diff.
- **QA test-honesty (the dominant risk).** Every crash/fault test kills at a **named program point**
  (`UMBRADB_CRASH_HOOK`: `before-commit`, `in-critical-section`, `after-data-commit-before-cursor`,
  `after-cursor-before-data`) — never on a wall-clock timer. Every crash/fault test carries a **negative
  control** that fires when the fault is removed. Fault hooks live **only** in test entrypoints and read
  an env var — they MUST NOT touch `src/` (QA verifies `src/` unchanged by diff, `tsc --noEmit` clean).
  Concurrency/interleave tests use a **forced, verified** interleave (advisory-lock / `pg_sleep`
  handshake that provably lands the concurrent COMMIT in the target window) — never a wall-clock race.
  The `synchronous_commit=off` durability leg uses an **unclean postmaster kill**, assertions written
  fault-agnostically. Replay/equivalence uses the documented **current-state equality predicate**
  (`kv_current` values + latest complete checkpoint payload + watermark values), explicitly excluding
  `kv_history` rows and `version` columns.
- **QA skip-enforcement.** A named mechanism (`test/integration/required-tests.manifest.json` +
  `test/integration/check-required-tests.ts` reconciled against Vitest's JSON reporter) MUST exist,
  be wired into the gate, and exit non-zero **naming the id** on any missing/skipped required test.
  The only sanctioned skip is a `deferred` optional-feature scenario. QA verifies the mechanism has
  teeth by confirming a deliberately-skipped required test is caught by id. QA MUST NOT count a
  live-gated (`UMBRADB_LIVE_PREPROD=1`) test toward any **per-change CI-required** exit criterion — the
  Pg-only required gate stands on its own. (The **sole** sanctioned live-evidence gate is the tag-level
  G12/R5 Preprod round-trip, recorded as `manual-evidence` in the Release Record; it **supplements,
  never substitutes for**, the CI-required per-change gate, so this rule does not contradict R5.) The
  crash/soak suite
  MUST terminate within a named `SUITE_WATCHDOG_MS` backstop and fail with a typed timeout (a wedged
  gate ships durability unverified).
- **QA coverage & mutation (owned build-out — §1.0; binding once merged).** The coverage/mutation
  infrastructure is a tracked build-out owned by `v1.0.0-recovery-testing` and MUST be merged and
  CI-wired **before G9 is declared CLOSED** (§1.0); QA does not own landing it. Once merged it is a
  `vitest` coverage config with `perFile: true` and per-glob thresholds on the durability-critical
  modules (`checkpoint-store.ts`, `transaction-lease.ts`, `watermarks.ts`, `temporal-kv.ts`,
  `migrate.ts`, `errors.ts`) wired into the gate. The v1.0.0 floors are **binding, not "recommended"**:
  the initial floors MUST be set at **exactly these values or higher** — 90% lines / 85% branches
  per-file on critical globs; 80% lines / 70% branches repo-wide — and MUST NOT be lowered thereafter.
  StrykerJS mutation on **at least the four durability adapters** with a `break` threshold wired as a CI
  check: the score is measured first, then a floor is **committed** at no weaker than `break:60 low:60
  high:80` and the measured score recorded as the baseline. **A committed, CI-wired coverage floor AND a
  committed, CI-wired mutation `break` floor are a precondition of the tag** (R2) — "measure first" MUST
  NOT become "never set." Coverage is a **floor, not a target** (a covered-but-unasserted line is not
  verified — mutation is required on top, not instead). QA MUST NOT lower a coverage/mutation threshold
  to pass a gate.
- **QA property reproducibility.** Every `fast-check` property is reproducible from its emitted seed;
  `numRuns` is set explicitly per property and recorded. Property tests complement, never replace,
  example tests.
- **QA flaky policy.** New/modified crash/soak/property tests MUST run **≥5 times** (5–10× is the
  working range) before their change closes; one failure with a proven-deterministic primitive is a QA
  finding. A flake MAY be quarantined ONLY
  with a filed owner + root-cause note + fix-or-retire deadline, quarantine < 5% of the suite; a
  **durability keystone (T1, T2, T5, T3, soak, differential) is NEVER quarantined** to unblock a merge.
  QA MUST NOT use retry-until-green as a substitute for fixing a flake or as evidence for a required
  criterion.
- **QA perf & regression.** No perf **number** gates the tag: the only perf condition is that
  `bench/baseline.<harness-version>.json` **exists and structurally reproduces** — QA MUST NOT wire a
  failing-on-number perf step into the gate. The baseline is captured only **after** the perf-shape
  fixes (`save` UNNEST batching HP-1, `history` single `GROUP BY` HP-2) merge. The full existing
  conformance suite stays green on every change; a pre-existing green test going red is a blocking
  regression finding regardless of intent.
- **QA boundary/scope.** No test/harness/reference oracle imports a consumer/indexer; QA verifies the
  existing import guards + G11/G14 import audits stay green. QA MUST NOT gate the release on deferred
  behavior (`save` idempotency, T4 lease-fence, T7 disk-full, T8 migration-lock chaos, T9 clock-step,
  T10 serialization-storm, streaming save/load, keyed chunking).

**Required artifacts.** The required-gate result; the skip-enforcement report; the coverage + mutation
baselines; the per-change DoD checklist; the recorded flaky-loop runs.

**Definition-of-done (a gate item is QA-DONE iff all hold).** (1) every acceptance criterion maps to a
run-and-passed (not skipped) test/artifact, verified through skip-enforcement; (2) each fault test's
negative control fires and each concurrency test's forced interleave is verified; (3) coverage +
mutation thresholds pass on touched critical modules with baselines recorded; (4) no new flake, no
keystone quarantined; (5) G5-dependent tests (T5, fault-schedule G11) are **not marked green until G5
merges**; (6) QA's close-out records exactly what this change delivered — **no over-claim** that the
milestone or release is complete when one change closed.

**Forbidden behaviors.** Accepting the impl's oracle; counting a live-gated or retried-green result;
quarantining a keystone; lowering a threshold; smuggling a deferred item into the blocking set; wiring
a perf-number gate; importing a consumer for a "real" oracle.

**Independence rules.** QA sits downstream of the independence-critical (NONE/cold) auditors and MAY
consume their findings, but the one thing QA uniquely produces — the pass/fail oracle — MUST be
independently constructed in-repo (preserving the anchoring guard on QA's own output).

### §2.4 — Usability / DX agent

**Mandate.** For a library, the public API surface, the written contracts, and the error catalog **are**
the product; the types are their shadow. Make the DX dimension of `v1.0.0-api-surface` (G1–G4, G20)
enforceable, and add the DX conditions that change under-specifies (tooling gates, example correctness,
error-message *quality*, API-ergonomics, cold-consumer independence).

**Entry criteria (MUST NOT start until all hold).** G5 has merged and the final `save` signature is
recorded (DX cannot review a surface that will still shift). The barrel `src/index.ts`, the
`package.json` `exports`/`main`/`types`, the declaration-emitting build, `CHANGELOG.md`, the stability
policy, `docs/CONTRACT.md` (or README sections), and the error catalog physically exist. `npm run
build` produces `dist/index.js` + `dist/index.d.ts` with zero errors and the packed-tarball smoke test
passes — the agent reviews the **built, packed** surface, never `src/`, for any consumer-facing
judgment.

**Hard constraints (MUST / MUST NOT).**
- **Surface freeze (G1).** The built barrel exposes *exactly* the frozen set — `createClient`,
  `runMigrations`, the five adapters, `PgWalletStateEnvelopeStore`, all `src/interfaces/` types, the
  `Rollback` primitive, the `StorageError` hierarchy **minus the six chain-archive classes** — no more
  (no accidental widening), no less (`Rollback` and the interface types MUST be present). A deep import
  of an internal path MUST fail with `ERR_PACKAGE_PATH_NOT_EXPORTED` (strict `exports` map, no `./*`).
  `npx publint` and `npx @arethetypeswrong/cli --pack` MUST both pass on the packed tarball as a
  blocking CI job. A committed public-API surface snapshot (API Extractor `.api.md` or equivalent) MUST
  exist and be diff-gated so any future widening/narrowing/re-typing fails as a visible diff. Every
  frozen symbol carries a TSDoc comment; the internal chain-archive routing classes are
  `@internal`/`@experimental`-tagged.
- **SemVer & docs-as-contract (G2, G4).** The stability policy states checkably: no breaking change to
  the exported surface or error-`code` set in minor/patch; deprecate-in-minor/remove-in-major; a major
  MAY require a documented forward migration, downgrade unsupported. `CHANGELOG.md` in Keep-a-Changelog
  format with a `1.0.0` entry enumerating the five primitives + `PgWalletStateEnvelopeStore`. Migration
  UX documented as forward-only (`migrate.ts` is `up()`-only), `docs/SCHEMA.md` exists and is linked
  (a dangling link is a DX defect). MUST NOT accept docs that market a deferred/unmerged capability as
  1.0 surface (the "Full-chain storage — validated live against Preprod" README section is reframed as
  a 1.1 preview outside the frozen surface).
- **Error-message quality (G3, beyond "has a code").** The published `{code → meaning → retryable}`
  catalog lists exactly the 21 frozen non-chain-archive codes (count authoritative via the drift test,
  not a literal); `CONNECTION_ERROR`, `TRANSACTION_FAULT`, `LEASE_TIMEOUT` retryable; no
  `CHAIN_ARCHIVE_*`/`BLOB_*`/`BLOCK_NOT_FOUND` present; `CLOCK_REGRESSION` distinguishes its retryable
  same-millisecond collision from its non-retryable backward wall-clock step. **Added quality bar:** for
  each of the 21 codes, the thrown message (a) names the offending input/entity and (b) states/implies
  the caller's next action, consistent with `retryable`; a bare class name or a raw driver string is a
  DX defect. MUST NOT leak raw postgres.js/driver error text through the public surface.
- **Docs-as-tests (G4).** Every runnable example in `README.md`, `docs/CONTRACT.md`, and the quickstart
  compiles/executes against the **built barrel** in CI; an example importing a deep path, a non-exported
  symbol, or a stale signature fails the build. A minimal quickstart (install → `createClient` →
  `runMigrations` → one adapter round-trip, barrel imports only) is the exact path the packed-tarball
  smoke test exercises.
- **Lean cut-line legibility (G20).** The frozen record names exactly `{T3,T5,W1,C1}` as proved and
  lists the deferred workstreams; the release-doc claim matches what `lean.yml`'s trust gate actually
  covers — no overclaim.

**Required artifacts.** The DX acceptance report mapping every U-condition → PASS/BLOCK + evidence
pointer; the committed surface snapshot; the publint/attw CI job log; the docs-as-tests CI job; the
message-quality table (code → sample message → names-input? / states-action?, all "y" to pass).

**Definition-of-done.** Every MUST checked with a cited artifact (a passing CI run is not sufficient
evidence on its own); the DX acceptance report emitted with a `PASS`/`BLOCK` verdict + exact file refs
+ severity; the surface snapshot, publint/attw job, docs-as-tests job, and message-quality table all
committed so the next release inherits the gates.

**Forbidden behaviors.** Requiring/importing/gating DX checks on any foreign consumer app (all DX
validation uses a throwaway scratch project + Testcontainers) — a boundary breach, not a stronger test.
Letting deferred code into the surface under a DX rationale (no public observability/tracing API — Node
`tracingChannel` is Stability-1 Experimental; no keyed-chunking/encryption; no idempotency-key
migration). Triggering `graphify` during review. Treating "more exports" as better DX — surface
minimalism is the DX virtue under an irreversible SemVer freeze.

**Independence rules (the split is non-negotiable).** The Usability role splits into two sub-roles with
different modes: (a) **contract/surface-conformance → PUSH** (checking the built barrel and
catalog/contracts against the fixed frozen spec is the "diff against a fixed spec" shape); (b)
**cold-consumer ergonomics → NONE (hard)** — no manifest, no `src/` access, inputs are the **published
artifacts only** (packed tarball, built `.d.ts`, README/quickstart, CONTRACT, CHANGELOG, error
catalog). A reviewer who knows `src/postgres/*` will not notice a confusing/mis-named/under-documented
public surface — that is exactly the anchoring failure arXiv 2603.18740 describes. Handing the cold
sub-role a curated file list defeats its reason to exist.

### §2.5 — Security agent

**Mandate.** Enforce (never re-litigate) the council's security rulings (S1–S9, Z1–Z6) while
implementing G15–G19 and signing off the tag. This work is deliberately docs + CI + scripts with **no
`src/` runtime behavior change** (G16 is doc-comment-only; the G8 code fixes are owned by the
reliability/contract-integrity change but confirmed present at the tag).

**Entry criteria.** Every Sxx finding maps to a requirement + an acceptance id, and every acceptance row
states its verification method (`doc-artifact`/`CI gate`/`manual-evidence`/`typecheck`/`diff-review`).
No new security scope is invented past G15–G19 for the tag.

**Hard constraints (MUST / MUST NOT).**
- **Threat-model docs (G15).** `SECURITY.md` exists at repo root, linked from `README.md`, and states
  as binding prose a deployer can act on: T-A1 (single trusted writer, one trust domain) + T-A2
  (trusted Postgres/disk/backups/operator); `schema` is namespacing **NOT** a security/tenant boundary
  (redirect multi-tenancy to Postgres roles/RLS); **both** cross-wallet dedup channels (`save`-timing
  and `prune` `reclaimedBytes`/`reclaimedChunks`) and that mutually-distrusting principals on one store
  is an **unsupported** deployment (fixed-size-chunking bound: whole-known-chunk confirmation only);
  **no at-rest encryption** — secret-bearing payloads are plaintext `bytea`, the deployer MUST encrypt
  disk/backups or pass ciphertext; and the enumerated P1 fast-follows it documents-but-does-not-implement.
- **Injection tripwire (preserve the strong invariant — scoped to be true against `main`).** For any
  frozen-surface `src/postgres/**` diff (all of `src/postgres/**` **excluding** `chain-archive-rollover.ts`,
  `chain-archive-store.ts`, `migrations/chain_archive/**`), re-run the injection trace and confirm the
  schema identifier is the **only** interpolated SQL identifier, still double-protected
  (`assertValidSchemaName` regex + 63-byte bound **and** `sql()` quoting), every value a bound parameter.
  Within the frozen surface the **only** `sql.unsafe()`/`.unsafe()` sites are the three
  `SET [local] statement_timeout` lines (`transaction-lease.ts:221,285,347`). The chain-archive DDL
  `unsafe()` sites (`chain-archive-rollover.ts:297–334`, `migrations/chain_archive/001:768,773`) are
  **out-of-frozen-surface**, identifier-quoted DDL under their own review, and never re-exported — the
  invariant excludes them by scope. The baseline is enforced **mechanically**: a static allowlist test
  (file + exact `unsafe(` count) MUST fail CI by diff on **any new `unsafe(` site anywhere in `src/`**,
  chain-archive files included. Any diff adding a new `unsafe(...)` site, **widening that allowlist**, or
  loosening `TransactionOptionsSchema`/`LeaseAcquireOptionsSchema` toward `z.string()`/coercible is a
  **BLOCKING** security finding. Any newly resolved import/require path is verified to live under the
  repo root before use (reject `../../.env`-style traversal).
- **Supply-chain gate (G18 — the process BLOCKER).** Land `.github/workflows/supply-chain.yml` +
  `.npmrc` + `.gitleaks.toml` such that: install uses `npm ci` (never `npm install`); repo-root
  `.npmrc` sets `ignore-scripts=true` and CI **asserts** its presence/value (and because this
  suppresses UmbraDB's own lifecycle hooks, any build/typecheck the release depends on runs as an
  **explicit** CI step, confirmed by a broken-`.npmrc` dry run); a blocking `npm audit
  --audit-level=high --omit=dev` scoped to the two runtime deps; a full-history blocking `gitleaks
  detect` driven by committed `.gitleaks.toml`, verified by a planted-secret dry run; a `trivy image
  --severity HIGH,CRITICAL` scan of **both** pinned digests on `schedule` + `workflow_dispatch`, the
  scanned refs asserted equal to the `flake.nix` pins; a `flake.lock` **change-control** step (a PR
  modifying `flake.lock` without a `flake-lock-update` label fails) — NOT the near-vacuous "no-op
  re-lock produces no diff" check.
- **Secrets (G19 — replace pattern, no history rewrite).** The committed
  `preview-test-wallet.json` is untracked and `.gitignore`d; a `.example` template + a generator script
  (writes a fresh-seed wallet or fails with an actionable named-tool message) exist; `.gitleaks.toml`
  allowlists **exactly two** paths (the `.example` and the historical secret path), each justified.
  MUST NOT `git filter-repo`/BFG the history (verified valueless Preview material; go-forward guard is
  the full-history gitleaks gate).
- **TLS (G17 — surface + de-stub, keep the default).** `nix/midnight-env/README.md` states the
  `Require`+self-signed caveat (encryption only, no server-identity validation, no MITM protection),
  the co-located-host safety condition, and the off-host VerifyFull + pinned-CA recommendation;
  `enable-db-sync-tls.sh --ca <container>` runs end-to-end (local-CA-signed cert, correct SAN, CA key
  `0600`). MUST NOT flip the localhost default (a forced VerifyFull pushes users to
  `rejectUnauthorized:false`-style escapes — strictly worse); the default path provisions the same
  cert/`ssl=on`/`0600` params as before.
- **Interface-doc caveat (G16 — doc-comment-only BLOCKER).** All three advertised-dedup doc sites in
  `src/interfaces/checkpoint-store.ts` state the single-trust-domain requirement + cross-wallet
  observability, cross-referencing `SECURITY.md`; `git diff` of that file shows **only comment lines**
  changed (no signature/type/exported-symbol/executable line), `tsc --noEmit` passes; the rewrite
  **adds, does not replace** — both pre-existing caveats survive.
- **Scope discipline (Z1–Z6).** MUST NOT ship code that *implements* a boundary the tag only
  *documents*: no keyed/scoped chunk-addressing, no `EnvelopeCipher`/at-rest-encryption seam, no
  two-role Postgres topology, no restore-integrity code, no checkpoint total-size cap, no `save()`
  idempotency, no TLS default flip, no history rewrite, no consumer/indexer import.

**Required artifacts.** `SECURITY.md`; the supply-chain workflow + `.npmrc` + `.gitleaks.toml`; the TLS
README caveat + `--ca` run evidence; the interface-doc diff + `tsc` output; the CWE/OWASP-mapped
findings table (each with `file:line` + trust-model precondition + in-model severity).

**Definition-of-done (per change).** Injection trace re-verified if `src/postgres/**` touched (else N/A
stated); every new off-host input path has a validation bound (G8 confirmed if this is G8); no
secret/key/credential added to tree or logs, gitleaks passes, no raw `err.message` newly logged on a
value-carrying write path (CWE-532); every finding CWE/OWASP-mapped with a trust-model precondition;
the supply-chain gate green; the cold adversarial audit ran **NONE-mode** and its blocking findings
resolved-and-re-audited or explicitly ruled out-of-model by the council's *existing* rulings (the agent
MUST NOT invent new out-of-model dismissals).

**Forbidden behaviors.** Scoping/framing the cold pass ("the impl says this fixes the cursor race" is
the 93.5pp attack); reading "no code-level blocker" as "nothing to do" (the blockers are docs + a
supply-chain gate + an interface-doc rewrite); severity-inflating an in-model item by dropping its
precondition; implementing deferred code "while we're here"; letting a green pipeline substitute for a
documented precondition.

**Independence rules.** Two lanes that MUST NOT be confused: a **PUSH** spec-compliance security check
MAY verify the diff against the fixed G15–G19 acceptance table with a manifest; the **NONE-mode** cold
adversarial security audit (Codex GPT-5.6 Sol) receives no manifest, no findings, no framing, repo+spec
bytes only, and is instructed to skip `graphify`. The Security agent holds a veto on specific
regressions that weaken posture (a "friendlier" TLS default flip, an error message echoing secret
bytes, a new `sql.unsafe()`).

---

## §3 — Cross-cutting gates (apply to every gate item and every agent)

**§3.1 — Evidence before claims.** No agent asserts "passing"/"fixed"/"done" without the actual command
output or the cited artifact. A claim without evidence is a blocked handoff (repo
`verification-before-completion`). A green CI badge is **necessary, not sufficient** — the run-and-passed
test id / negative control / mid-run sample is the evidence.

**§3.2 — No placeholder / full output.** No `TODO`, `// ...`, "implement later", stubbed body,
`throw new Error("not implemented")`, elided SQL, `any`-escape, or truncation reaches audit or ships.
The Formal `trust/no-placeholder` build+CI gate binds shipped artifacts too — a `SECURITY.md` with a
`TODO` section is a failed sign-off. Token-limit splits happen at file/function boundaries, never as
abbreviation.

**§3.3 — TDD as an enforced process constraint.** Red-before-green with an observed failure for the
intended reason; the test set is the exact named acceptance scenarios (never generic "do TDD", which
*raises* regressions — brief spec-to-code F2); bounded repair (≤3) then escalate; atomic single-task
mutation.

**§3.4 — Lean formal gate (where applicable).** Any task touching a cut-line law {T3,T5,W1,C1} uses the
`lean4` skill with its no-`sorry` / axiom-boundary / final-project-gate workflow. `lean.yml`
(forbidden-token scan for `sorry`/`admit`/`axiom`/`unsafe` + `lake build --wfail` + the
`#audit_umbradb_trust` env-elaboration in `Trust.lean`) MUST be green on the tranche. The axiom
allowlist `{propext, Quot.sound, Classical.choice}` MUST NOT be widened to force a proof; an abstract
theorem MUST NOT be represented as proof of the runtime Postgres behavior. The cut-line is frozen at
{T3,T5,W1,C1} with a written deferral of the rest.

**§3.5 — Property + differential + crash testing.** Property tests P1–P10 derive from
`STORAGE_ALGEBRA.md` §5 and run on real Postgres via Testcontainers (not mocks), seed-pinned and
reproducible. The differential-equivalence gate is a **fault-schedule-vs-fault-free** equivalence of the
*same* in-repo harness batch (P3 the fold-equality anchor), judged on the current-state equality
predicate — never a cross-repo comparison. Crash tests kill at named program points with firing
negative controls; T5 runs both `synchronous_commit` legs (the `off` leg with an unclean postmaster
kill); T5 / fault-schedule G11 stay **pending, not green, until G5 merges**.

**§3.6 — Coverage / mutation thresholds.** Coverage (`perFile:true`, stricter per-glob on the four
durability adapters + `migrate.ts`/`errors.ts`) and StrykerJS mutation (`break` threshold on the four
adapters) are wired into the gate with recorded baselines; thresholds are floors that ratchet up and
MUST NOT be lowered to pass. Coverage is a floor, not a target — mutation is the "do the assertions
have teeth" check on agent-generated code.

**§3.7 — Independence (the confirmation-bias control).** Every review role carries exactly one
`CLAUDE.md` mode. NONE-mode roles (Codex Sol cold; design adversarial-risk; EARS-completeness;
cold-consumer usability) receive raw diff + frozen spec/acceptance + repo bytes only — never a manifest,
prior verdict, prior findings, implementer self-summary, or severity pre-label. At least one auditor per
round is true-NONE. The implementer never audits its own diff; a fixer never self-certifies its fix.
Freshness gate: PUSH manifests are void unless `graphify-out/graph.json` `built_at_commit == HEAD`.
Cross-vendor adversarial audit on the hard classes (G5, G9–G11, lease, GC/prune concurrency).

**§3.8 — Security sign-off.** No tranche merges without its security DoD (§2.5) green: injection trace,
input bounds, no committed secret / no CWE-532 leak, CWE/OWASP-mapped findings with trust-model
preconditions, supply-chain gate green, and the NONE-mode cold pass clean-or-council-ruled.

**§3.9 — The three hard invariants (blocking, non-negotiable).**
- **Indexer-agnostic boundary.** No `src/`, test, harness, or reference oracle imports the
  consumer/indexer. Proven by the static import guards
  (`no-sdk-import-guard.test.ts`, `no-chain-sync-import-guard.test.ts`) + the G11/G14 import audits.
  A breach is the highest-severity architectural regression and a hard BLOCK.
- **Single trusted writer.** Multi-writer / lease-fencing / cross-tenant concerns are 1.0.0
  **documentation** obligations (G15–G16), not code blockers; raising them as 1.0 code blockers is a
  severity-miscalibration finding.
- **Not distributed.** No distributed-trust/Merkle/replication code enters 1.0.0; the public surface,
  contracts, and error catalog are the product.

---

## §4 — Gate-item close criteria & the 1.0.0 tag gate

### §4.1 — Closing one roadmap gate item (G-N)

A single gate item G-N is **CLOSED** iff **all** hold:
1. Its owning change's `acceptance.md` criteria are each mapped to a **run-and-passed** (not skipped)
   test / CI job / doc-artifact / manual-evidence item, verified through skip-enforcement — not by a
   green badge.
2. The pipeline reached Stage 10 for that change: three-persona audit clean after `main` integration,
   every `BLOCK` independently re-audited to `PASS`, NONE-mode roles' prompt-hygiene attested, verdicts
   + validation evidence recorded in the PR.
3. The cross-cutting gates that apply to what it touches are green: full-output (§3.2), Lean trust gate
   if a cut-line law is touched (§3.4), property/differential/crash with negative controls (§3.5),
   coverage/mutation with recorded baselines (§3.6), security DoD (§3.8), and the three invariants
   (§3.9).
4. Non-goals confirmed not implemented; no deferred capability or frozen-surface widening landed.
5. `graphify update .` run and `graphify-out/` committed in the close-out; audit token cost recorded.
6. The close-out records exactly what this change delivered — no aggregate over-claim.

**G-item ↔ change granularity.** A single `v1.0.0-*` change bundles several gate items
(`api-surface` = G1–G4 + G20; `infosec-signoff` = G15–G19; `recovery-testing` = G9–G11 + the
coverage/mutation build-out; `perf-baseline` = G13–G14; `durable-checkpoint-cursor` = G5 + G6/G7/G8).
One Stage-10 pass therefore **closes all of that change's constituent G-items together** — each still
requires its own `acceptance.md` criteria mapped to run-and-passed evidence (criterion 1), but the
pipeline-stage conditions (criteria 2–3) are satisfied once for the change.

**G14 close-out amends the stale `ROADMAP.md` perf wording (so the tag entry criterion is consistent
with council B).** `ROADMAP.md`'s "1.0.0 acceptance checklist" perf item currently reads "Performance
benchmark baseline recorded, with **no regression against it** introduced by anything landed after the
baseline was set" (`ROADMAP.md:162–163`) — but council B and `v1.0.0-perf-baseline` B5 rule that **no
latency/throughput number is a required gate** and CI has no failing-on-number perf step (§2.3, §3.6).
G14's close-out **MUST amend** that checklist item to the council-B form — *"benchmark baseline recorded
and structurally reproducing (B4/B5); numeric regression gating is the first post-1.0 obligation"* — and
**MUST correct** `ROADMAP.md`'s stale "not yet merged into `main`" note for the chain-archive track
(`ROADMAP.md:169`), which is false (that code is on `main`; see R4). **Ticking rule** for the perf
checklist item: *baseline exists + structurally reproduces = ticked* (no "no regression" evidence is
required or produced).

Sequencing constraint (critical path, from the consolidated roadmap): **G5 → G6/G7/G8 → G13 → G14 →
G9/G10/G11 → G1–G4 (freeze) → G15–G19 → G20 + G12 → RC → Preprod evidence → tag.** G5 (co-transactional
`save`) MUST close before the API freeze (it changes `save()`'s signature) and before its crash-test
dependents (T5, fault-schedule G11) can be green.

### §4.2 — The 1.0.0 tag gate

**Entry criterion (the release process may begin only when):** all five `v1.0.0-*` changes are
implemented, merged to `main`, and each `acceptance.md` fully green; `ROADMAP.md`'s "1.0.0 acceptance
checklist" all ticked **against its G14-amended wording** (§4.1 — the perf item is ticked on
baseline-exists + structural reproduction, never on "no regression" evidence the guideline forbids
producing; the chain-archive "not yet merged" note has been corrected); `main` is the exact clean tree
to be tagged.

- **R1 — Release Record.** A single committed artifact `docs/releases/v1.0.0.md` lists **each of
  G1–G20** with its status (`GREEN` / `DEFERRED-with-ruling`), an **evidence pointer** (CI run URL,
  test-artifact path, doc path, or auditor verdict block), and a named accountable owner. A gate with
  no evidence pointer is not green.
- **R2 — Both required CI gates green on the exact tagged SHA.** `conformance.yml` (`npm ci` →
  `npm run typecheck` → `npm run test:conformance` on Testcontainers Postgres, including the coverage +
  skip-enforcement steps) and `lean.yml` (forbidden-token scan + `lake build --wfail` + trust
  elaboration). Both run URLs cited against the tag SHA, not an ancestor. **A committed, CI-wired
  coverage floor AND a committed, CI-wired StrykerJS mutation `break` floor (§2.3, §3.6) are a
  precondition of this gate** — "measure first" MUST have become a committed floor by the tag, not
  remained unset.
- **R3 — The frozen public surface is real and installable.** The packed-tarball smoke test (install the
  `npm pack` tarball into a throwaway project, resolve the root import, run `runMigrations` + a
  `PgTemporalKV.put/get` round-trip on Testcontainers, assert a deep internal import fails with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`, assert `dist/index.d.ts` present) passes **from the built tarball**.
  `package.json` has `private:true` removed and `main`/`types`/`exports` (root-only, no `./*`) present.
  publint + attw green.
- **R4 — No unfrozen surface leaks.** The barrel exports no chain-archive symbol/code; the error-code
  catalog equals the exported classes' `code` set with the drift test green. The three feature
  **branches** — `feature/full-chain-storage-implementation*`, `fix/verifiable-snapshot-v2*`,
  `feature/network-torrent` — MUST NOT be merged into `main` before the tag. Chain-archive code **already
  on `main`** (`chain-archive-store.ts`, `chain-archive-rollover.ts`, `chain-archive-sync/`,
  `migrations/chain_archive/**`, the `CHAIN_ARCHIVE_*`/`BLOB_*`/`BLOCK_NOT_FOUND` classes) MUST be
  **absent from the built barrel, the `exports` map, and the error catalog** (verified by api-surface A2
  + the drift test), its symbols `@internal`/`@experimental`-tagged, and its self-skipping CI suites
  reported **SKIPPED, never PASS**. (This is G3's strip-from-*surface* approach — not a rip-out of merged
  code; the G14/G1 close-out corrects `ROADMAP.md`'s stale "not yet merged" sentence, §4.1.)
- **R5 — Live evidence against the RC.** The manual Preprod round-trip (funded wallet sync-to-tip → kill
  → cold-start → resume-from-durable-cursor → identical state, via the `UMBRADB_LIVE_PREPROD` live
  tier) is run against the RC commit and its transcript pasted into the Release Record. This is the one
  gate CI structurally cannot run.
- **R6 — Independent release-audit sign-off, cold.** The `AGENTS.md` release persona issues a `PASS` on
  the RC **after `main` integration**, read-only and independent, in **NONE mode** (no manifest, no
  pushed reading list; skip `graphify`). The implementing agent MUST NOT self-attest the release gate;
  all blocking findings fixed → targeted re-audit → verdicts recorded in the Release Record before tag.
- **R7 — Reproducible, clean-tree, annotated tag, provenance published from CI.** An **annotated** tag
  `v1.0.0` on a clean-tree commit whose `package.json.version` reads `1.0.0`; `dist/` reproducible from
  that commit (`npm ci` + build). MUST NOT tag off a dirty tree, a rebased/force-pushed history, or a
  branch other than `main`. **Provenance cannot be generated from a local machine** — `npm publish
  --provenance` requires a supported cloud CI (GitHub Actions/GitLab CI) with OIDC `id-token` permission
  and a matching public `repository` URL (<https://docs.npmjs.com/generating-provenance-statements/>).
  Therefore a **required artifact** `.github/workflows/publish.yml` MUST exist, triggered by the `v1.0.0`
  tag (or manual dispatch on the tag SHA), with `permissions: { id-token: write, contents: read }`,
  running `npm ci` → build → `npm publish --provenance --access public`; and `package.json.repository`
  MUST match the GitHub repo (a mismatch fails provenance). Landing `publish.yml` is owned by
  `v1.0.0-infosec-signoff` (supply-chain-adjacent, co-located with G18). If for any reason provenance is
  dropped, that is a recorded council-style ruling in the Release Record — **silence is not an option**.
- **R8 — No placeholder / no-`sorry` escape.** The Lean cut-line is exactly {T3,T5,W1,C1}, the trust
  gate rejects any newly introduced forbidden token, and the written deferral of the rest is recorded.
  MUST NOT tag with a red or skipped trust gate, or a `TODO`/placeholder in a shipped artifact.
- **R9 — One recorded Go/No-Go; the waiver obligation attaches to the *Go* branch.** A single Go/No-Go
  decision naming the decision, date, accountable owner, and any conditions. **Any decision that tags
  despite a non-GREEN gate is a `Go-with-waivers`** and MUST enumerate, per waived gate: the gate, the
  **existing** council ruling authorizing the waiver (an agent MUST NOT mint a new ruling), and its 1.1
  tracking item. A gate waived without all three **voids the Go**. A **No-Go** declines to tag and
  requires no waiver machinery (it waives nothing). This closes the silent-waiver hole on the dangerous
  branch — the branch that ships.
- **R10 — SemVer enforced by a drift test.** The surface snapshot + error-code drift test fail CI on any
  accidental surface/code change so SemVer violations are caught mechanically, not by reviewer memory.
- **R11 — Changelog + schema lineage as versioned artifacts.** `CHANGELOG.md` carries the `1.0.0` entry;
  the forward-only migration lineage and `docs/SCHEMA.md` are referenced by the migration contract.
- **R12 — No AI attribution in release metadata.** The tag message, `CHANGELOG.md`, commit trailers, and
  any GitHub release body MUST NOT contain a Co-Authored-By Claude trailer or any AI-attribution
  (standing owner directive). License Apache-2.0.

**Exit / DoD for the tag:** R1–R12 satisfied; Release Record complete and committed; Go/No-Go recorded
(a `Go-with-waivers` enumerates gate + existing-ruling + 1.1 item per R9); annotated tag pushed (no
force); package published via the `publish.yml` CI workflow with `--provenance` (R7) — or the drop
recorded as a ruling; the 1.1 milestone opened seeded with the council A §3 deferral list (full-chain
archival = 1.1 headline; keyed chunking + encryption seam; lease fencing; idempotent `save`; CV-aware
perf regression gate).

---

## §5 — Post-release lessons-learned protocol

**§5.1 — The log exists and is blameless.** `docs/retro/README.md` (standing format + Norm Kerth's
Prime Directive verbatim) and, per release, `docs/retro/v1.0.0.md`. The retro opens by asserting the
Prime Directive and that blamelessness extends to **agent** actors: the unit of analysis is *why a
given output made sense given the context/manifest/prompt the agent had* (the "second story"), never
"the model was wrong." Prefer "how", not "why"; no single-root-cause narratives.

**§5.2 — Rolling capture during the run, not only at the end.** Every gate miss, defect escape,
re-audit round, and workflow-friction event is appended **when it happens** to the **single canonical
intake — the in-repo append-only journal `AUTONOMOUS_RUN_LOG.md`** — and **mirrored** to the owner's
`~/foreman/bugeventlog.md` per the standing memory directive (date, phase, evidence, contributing
factors, impact, enhancement). The in-repo journal is authoritative; the aggregation in §5.3 reads it,
not a scattered union. The retro *aggregates and trend-analyzes* these; it MUST NOT be the first time an
event is written down. **Action-owner convention:** a human owner is named directly; an **agent** owner
is recorded as `role + model + round-id` (e.g. `adversarial-persona / Codex-GPT-5.6-Sol / round-3`) so
ownership never defaults to nobody.

**§5.3 — Four capture classes, each a structured entry** (date; phase
spec/code/verify/audit/QA/usability/security/merge/release; evidence pointer; contributing factors in
second-story form; classification; and an action item that is **specific, owned, due-dated, tracked, and
tagged mitigative vs preventative**):
1. **Defect escapes** — a defect found *after* a gate that should have caught it; the preventative
   action names the gate/test/auditor-persona to strengthen.
2. **Gate misses** — a gate green that should not have been, or skipped-and-counted-as-pass (the known
   `chain-archive-sync`/`replay-decode` self-skip hazard: a skip MUST be reported SKIPPED, never PASS).
3. **Agent-workflow friction** — confirmation-bias incidents (a NONE role handed framing; a
   PUSH/PULL/NONE mode assigned wrong), the Codex graphify ~25-min stall, stale-graph/freshness-gate
   violations, manifest-skew re-dispatch, tooling incompatibilities, wasted-work stalls.
4. **Rework causes** — every re-audit round and its trigger; whether a late finding could have been
   caught one phase earlier (design vs implementation vs audit).

**§5.4 — Reviewed before it counts.** The `v1.0.0.md` retro is reviewed by an independent reviewer (not
the primary author of the run being retro'd) before it is closed ("an unreviewed postmortem might as
well never have existed").

**§5.5 — Iteration-2 cannot start until the retro is consumed.** The entry gate for the next milestone
(iteration-2 spec drafting) includes: read `docs/retro/v1.0.0.md`; for every **preventative** action
item, either land the concrete workflow change or record an explicit, owner-signed re-deferral. Named
consumption targets:
- `CLAUDE.md` — the PUSH/PULL/NONE table, guardrails, and the **recalibratable thresholds** it itself
  flags: the 150-line manifest-skip threshold and the Sprint-4 token baseline (94.6k / 108.7k / 79.1k)
  — updated with the real per-sprint measurements the policy asks for.
- `AGENTS.md` — the audit-persona set and re-audit rule.
- The gate definitions (G1–G20) and each change's `acceptance.md` — tighten any gate a defect escaped.
- The perf regression gate — replace the 1.0 "coarse" gate with the CV-aware gate the council named as
  the first post-1.0 obligation.
- **This guideline** — any condition that failed to catch a defect, or caused friction, is amended for
  iteration 2 and the amendment logged in `v1-lessons-learned.md`'s Iteration-2 intake.

**§5.6 — Cadence.** A retro is MANDATORY at every release tag and every milestone boundary; friction
capture (§5.2) is continuous. The log is append-only and never pruned — it is the trend-analysis
substrate.

---

## Audit resolution

This guideline was audited independently by **Fable** (`audit-fable.md`, verdict REVISE, 8 blocking +
7 non-blocking) and **Opus** (`audit-opus.md`, verdict REVISE, 2 blocking + 4 non-blocking). Every
blocking finding from both auditors is **APPLIED**; every non-blocking finding is applied; **none are
rejected**. Load-bearing repo facts each auditor asserted were re-verified against live `main` before
editing (no `build` script / `test:conformance` = `vitest run` / `private:true` in `package.json`;
chain-archive `unsafe()` sites at `chain-archive-rollover.ts:297–334` and
`migrations/chain_archive/001:768,773`; the three `SET timeout` sites at `transaction-lease.ts:221,285,347`;
chain-archive code + the three feature branches on `main`; `ROADMAP.md:162–163` "no regression" wording
and the stale `:169` "not yet merged" note). Both arXiv citations were re-verified by fetch.

| Finding | Auditor | Class | Resolution |
|---|---|---|---|
| Pipeline stall — stage-applicability, Stage-5 phase-in, coverage/mutation ownership | Fable B1 | blocking | **Applied** — new §1.0 (applicability matrix + phase-in rule + N/A-as-first-class + coverage/mutation owned by `recovery-testing`, due before G9 CLOSED); Stage 5/8/9 reworded. |
| Stage 8/9 not executable for 4 of 5 changes; no N/A path | Opus B2 | blocking | **Applied** — same §1.0 change; Stage 8 = N/A off public surface, Stage 9 always-runs-depth-scoped, `N/A-with-reason` a first-class recorded outcome. |
| Injection tripwire factually false (chain-archive `unsafe()` sites) | Fable B2 | blocking | **Applied** — §2.1 C3 + §2.5 scoped to frozen-surface modules (excl. chain-archive files) + required static allowlist test; widening = BLOCKING. |
| Tag-gate R4 contradicts `main` (chain-archive merged) | Fable B3 | blocking | **Applied** — R4 reworded to the three feature *branches*; merged chain-archive code must be absent from barrel/exports/catalog + SKIPPED suites. |
| R7 `npm publish --provenance` unexecutable locally | Fable B4 | blocking | **Applied** — R7 now requires `.github/workflows/publish.yml` (OIDC `id-token`, `--provenance --access public`), owned by `infosec-signoff`; drop = recorded ruling. |
| R9 waiver attached to No-Go (wrong branch) | Fable B5 | blocking | **Applied** — R9 rewritten as `Go-with-waivers` (gate + existing ruling + 1.1 item, else voids the Go); No-Go needs no waiver machinery. |
| QA live-gated prohibition contradicts R5/G12 | Fable B6 | blocking | **Applied** — §2.3 scoped to "per-change CI-required"; G12/R5 named as the sole sanctioned live-evidence gate that supplements, not substitutes. |
| Gate S0 verification-vocabulary fails all 5 changes | Fable B7 | blocking | **Applied** — S0 now requires a method tag from each change's own legend covering the 7 canonical semantic classes; canonical list ≠ literal spelling. |
| Tag entry imports `ROADMAP.md` perf wording council overrode | Fable B8 | blocking | **Applied** — §4.1 G14 close-out amends the ROADMAP perf item to the council-B form + corrects the stale note; entry criterion + ticking rule aligned. |
| Miscited arXiv 2602.16741 in §2.2 B2 | Opus B1 | blocking | **Applied** — cross-vendor rule now rests on `CLAUDE.md` + roadmap authority; the paper is cited only for the narrow (verified) hard-class-difficulty corroboration, not as the remedy's basis. |
| Orchestrator has no contract | Fable A1 | non-blocking | **Applied** — new §2.0 Orchestrator (O1–O5: manifest-once, NONE-isolation attested pre-dispatch, mode assignment, N/A recording, void-and-re-dispatch). |
| Hedged numbers inside MUSTs | Fable A2 | non-blocking | **Applied** — §2.3 coverage/mutation floors made binding ("exactly these or higher, MUST NOT lower"); flaky loop = "≥5 times". |
| §2 preamble overclaims; "PUSH-eligible" not a mode | Fable A3 | non-blocking | **Applied** — preamble now distinguishes listed vs new roles; "PUSH-eligible" renamed **PUSH** in Stage 8 and §2.4. |
| D1–D6 / E1–E4 not individually enumerable | Fable A4 | non-blocking | **Applied** — split into individually numbered D1–D6 and E1–E4. |
| Lessons log: no canonical intake; owner convention | Fable A5 | non-blocking | **Applied** — §5.2 names `AUTONOMOUS_RUN_LOG.md` canonical (mirrored to bugeventlog) + agent-owner `role+model+round-id` convention; companion log updated to match. |
| Citation hygiene (2602.16741 title, 2603.18740 title) | Fable A6 | non-blocking | **Applied** — folded into Opus B1 (2602 corrected) and Opus N1 (2603 footnote). |
| arXiv 2603.18740 title is "Contextual" not "Confirmation" | Opus N1 | non-blocking | **Applied** — §0.4 footnote records the arXiv title vs `CLAUDE.md`'s "confirmation" naming. |
| Stage 6 omits the differential-review agent | Opus N2 | non-blocking | **Applied** — added to Stage 6's auditor enumeration. |
| G-N vs change granularity ambiguity | Opus N3 | non-blocking | **Applied** — §4.1 note: one Stage-10 pass closes all a change's constituent G-items. |
| Coverage/mutation floor must be a tag precondition | Opus N4 | non-blocking | **Applied** — stated in §2.3 and wired into R2 as a tag precondition. |

**Rejected: none.** Fable A7 was praise (no action). No finding weakened independence, a council ruling,
or an invariant, so no REJECT-class justification is owed.

---

*End of governing guideline. Companion living log: `v1-lessons-learned.md`.*
