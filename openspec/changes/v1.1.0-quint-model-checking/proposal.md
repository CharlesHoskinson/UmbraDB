# Proposal — v1.1.0: Quint model checking (`quint-model-checking`)

> **Status:** Proposed. Change id `v1.1.0-quint-model-checking`, capability `model-checking`.
> **Supersedes, for three specific laws,** the Lean-based approach in
> `openspec/changes/v1.1.0-formal-completion` (GF1 C2a, GF3 L1). That change is not withdrawn — its
> C1-hygiene rider, its refinement-obligation register, and its anti-vacuity criteria all still
> apply — but the *method* for C2a and L1 moves from Lean to [Quint](https://quint.sh/), and C2b
> joins them.

## Why: three laws are unproved, and it is not a coincidence which three

`Formal/STORAGE_ALGEBRA.md` states eleven laws. Eight have a Lean theorem. Three do not:

| Law | Spec status | Lean | Property test |
|---|---|---|---|
| **C2a** — GC reachability safety | MECHANISM SPECIFIED | **absent** | P8 (sampled) |
| **C2b** — eventual collection past the grace window | MECHANISM SPECIFIED (conditional) | **absent** | **none** |
| **L1** — lease mutual exclusion | MECHANISM SPECIFIED | **absent** | P10 (sampled) |

Plus one law the spec itself marks **OPEN**: **T1 cross-writer** coordination (per-key T1 is proved;
cross-writer is not).

These are exactly the **concurrency and liveness** laws. The existing Lean mechanization is an
abstract-kernel model over a sequential fold of events, which is an excellent fit for the eight
algebraic laws and a poor one for these four.

That is not speculation — it is what the audit of the proposed Lean approach found. Reviewing the
plan to mechanize L1 in Lean, the auditors objected that `acquire` never blocks, that
`WellFormedTrace` may simply *encode* the ≤1-holder property being proved (circular), that a
`Finset holder` collapses two acquisitions by the same holder, and that the proposed alternation
witness demonstrates *serial reuse* rather than *simultaneity*. Every one of those is an artifact of
expressing contention inside a sequential fold. The formalism is fighting the problem.

**C2b is worse than unproved: it is untestable by the means already in the repo.** It is a *liveness*
property — "an unreachable chunk older than the grace window is *eventually* deleted." A property
test can only ever observe a bounded prefix, so it cannot distinguish "eventually" from "never." The
suite today exercises the grace-window *mechanism* (`load-under-prune` backdates a chunk past the
15-minute window and asserts reclamation) but not the liveness claim, and that file's own header
records the timing dimension as deferred past 1.0.0.

## What changes

A Quint specification of the concurrent core, checked in CI:

- **C2a** as a state invariant under interleaved `save`/`prune`/`unlink`.
- **C2b** as a temporal property under weak fairness on the GC action.
- **L1** as a mutual-exclusion invariant over genuine contention (overlapping acquire attempts,
  where a second acquire on a held key must be *refused*, not silently reordered).
- **T1 cross-writer** gapless monotonicity under concurrent writers.

Plus the machinery that stops any of it passing vacuously: a **falsifiability control per property**
(a deliberately broken variant the checker MUST reject), and a **traceability manifest** binding each
Quint property to the `STORAGE_ALGEBRA.md` law it claims to discharge.

## Why Quint specifically

- It is **TLA-based** — the same Temporal Logic of Actions the repo already invokes as precedent for
  its refinement stance — with modern type checking and tooling on top, so this is consistent with the
  project's existing formal philosophy rather than a new one.
- It targets **two backends**: Apalache (symbolic) and TLC. This matters concretely — see below.
- `quint run` is a randomized simulator, so the same specification yields cheap continuous testing
  *and* exhaustive verification, and can emit a counterexample trace.

**The backend split is a real constraint, not a detail.** Quint's documentation records that TLC
"checks invariants **and temporal properties**" and checks executions of any length, while Apalache's
temporal support is experimental and prompts for confirmation. C2b is the only temporal property
here. Therefore **C2b MUST be checked with `--backend tlc`**, and the invariant-shaped properties
(C2a, L1, T1-cross-writer) use the default Apalache path with an explicit `--max-steps`.

Quint's own guidance also sets the sequencing: *"It is much easier to write and check safety
properties... Liveness properties require temporal formulas, which often rely on assumptions about
fairness... Safety properties go a long way, start with those."* The task order below follows that —
C2a, L1 and T1 (safety) land before C2b (liveness). A design that ignored this would have C2b silently checked by an experimental
code path — precisely the "gate that passes while protecting nothing" class this project has already
been bitten by twice in the infosec change.

## What this does NOT claim

- **Model checking is bounded — and the two backends are bounded differently.** This distinction is
  load-bearing and the docs are explicit about it:
  - **Apalache** is a *symbolic, bounded* checker. It translates the model to SMT constraints for a
    **specific number of steps** and asks Z3 for a satisfying assignment, so it needs `--max-steps`
    (**default 10**). A violation that first appears at step 11 is not found. Its result is always
    "verified up to N steps."
  - **TLC** is an *explicit-state* checker. It enumerates reachable states and **checks executions of
    any length** — so it is not step-bounded — but it requires the state space to be small enough to
    enumerate, and infinite domains must be replaced by constrained sets
    (`Set(1, 2, 100, 999).oneOf()`, not the integers).

  Either way the result is weaker than the Lean proofs for `{T3, T5, W1, C1}` and MUST be reported as
  such. It is chosen because concurrency defects empirically appear at very small N, where exhaustive
  search is both feasible and decisive.
- **It does not *prove* the refinement — but it can narrow it further than expected.** A Quint model
  of the *abstract* algebra says nothing, by itself, about the PostgreSQL adapter, the EXCLUDE
  constraint, `clock_timestamp()`, or advisory locks.

  However, the [`quint-llm-kit`](https://github.com/quint-co/quint-llm-kit) ships **model-based
  testing** built on `quint-connect`: traces generated from the model are replayed against the real
  implementation, asserting the implementation's transitions match the spec's. That is materially
  stronger than the hand-written P1–P10 sampling, because the *model* chooses the interleavings rather
  than a human guessing which ones matter.

  So the honest status becomes three-tier, not two: the algebra is `MODEL-CHECKED`, the adapter's
  conformance to it is `REFINEMENT-TESTED` (systematically, by generated traces), and the refinement
  remains `UNPROVED`. A verified Quint spec plus a tested-but-unproved refinement is still not a
  verified system, and the release documentation MUST NOT say otherwise.
- **It does not renumber the release gates.** This is post-1.0.0 work under guideline §0.2 voluntary
  hardening. It adds no G-item and does not gate any tag.

## Tooling

The [`quint-llm-kit`](https://github.com/quint-co/quint-llm-kit) (Informal Systems, Apache-2.0) is
**already installed locally** as three skills — `quint-modeling` (build/review a model),
`quint-lang` (syntax, CLI, counterexample reading), and `quint-execute-spec` (implement code against
a spec). The sprint uses them rather than reinventing the workflow:

- **`quint-modeling`** drives sections 1–4 (writing the model, and the structural/runtime review
  checklist for auditing it).
- **`quint-lang`** is the reference for syntax, typecheck errors, and reading counterexample traces.
- **`quint-execute-spec`** and the kit's MBT validator drive section 7 (conformance of the real
  adapter to the model).

Carry over the kit's own disclaimer: it is provided as-is, developed for Informal's internal use and
not evaluated for general use. That is a reason to review its output, not to avoid it.

## Dependencies

None on unmerged work. The four laws are specified in `Formal/STORAGE_ALGEBRA.md` (on `main`) and the
runtime behaviours they describe are all implemented and merged. The C1 collision-hygiene rider stays
with `v1.1.0-formal-completion` in Lean, where it belongs — it is a hypothesis-hygiene question, not a
concurrency one.

## Binding constraints

No AI attribution on any commit, PR, tag, CHANGELOG entry or release body. The specification stays
**indexer-agnostic**: it models UmbraDB's own storage algebra, imports no consumer or indexer concept,
and the conformance bridge stays in-repo.
