# Spec — `model-checking` capability

Requirements are written in **EARS** (Easy Approach to Requirements Syntax). Each is one of:

| Pattern | Form |
|---|---|
| Ubiquitous | `THE <system> SHALL <response>` |
| Event-driven | `WHEN <trigger> THE <system> SHALL <response>` |
| State-driven | `WHILE <state> THE <system> SHALL <response>` |
| Unwanted behaviour | `IF <condition> THEN THE <system> SHALL <response>` |
| Optional feature | `WHERE <feature> THE <system> SHALL <response>` |

`<system>` is the **model-checking capability**: the Quint specification, its CI job, and its
traceability manifest. Requirements are testable — each names an artifact or a command whose
outcome decides it.

---

## 1. Scope and honesty

**MC-1 (ubiquitous).** THE model-checking capability SHALL specify UmbraDB's storage algebra in
Quint, covering exactly the four properties that have no Lean theorem: **C2a** (GC reachability
safety), **C2b** (eventual collection), **L1** (lease mutual exclusion), and **T1-cross-writer**
(gapless monotonicity under concurrent writers).

**MC-2 (ubiquitous).** THE model-checking capability SHALL report every checked property as
`MODEL-CHECKED (bounded)` and SHALL NOT report it as `PROVED`, so that it is never conflated with the
Lean-proved `{T3, T5, W1, C1}` cut-line.

**MC-3 (ubiquitous).** THE model-checking capability SHALL record, for every property, the exact
bounds under which it was checked, in a committed artifact — because a bounded result whose bounds are
unstated is not a result. THE recorded bounds SHALL distinguish the two backends' different bounding:
for **Apalache**, the explicit `--max-steps` value (the tool defaults to 10 and a violation first
reachable beyond it is not found); for **TLC**, the finite domain sizes that make the state space
enumerable, since TLC checks executions of **any length** and is bounded by state-space size rather
than trace length.

**MC-3a (ubiquitous).** THE Apalache-backed properties SHALL pass `--max-steps` **explicitly** and
SHALL NOT rely on the default, so that the bound is a recorded decision rather than a tool default
nobody chose.

**MC-4 (ubiquitous).** THE model-checking capability SHALL state that it does not discharge any
abstract→PostgreSQL refinement obligation, and SHALL NOT be cited in release documentation as
evidence that the adapter is correct.

**MC-5 (unwanted).** IF a Quint property is added, removed, weakened, or renamed THEN THE
traceability manifest SHALL be updated in the same change, and CI SHALL fail while manifest and
specification disagree.

---

## 2. Faithfulness to the algebra

**MC-6 (ubiquitous).** THE Quint specification SHALL bind each property to the law it discharges by
citing the exact `Formal/STORAGE_ALGEBRA.md` law identifier and quoting the law sentence it
formalises, in a comment adjacent to the property.

**MC-7 (event-driven).** WHEN `Formal/STORAGE_ALGEBRA.md` changes a law's statement THE
model-checking capability SHALL be re-reviewed for faithfulness before its CI result is relied on
again, and the re-review SHALL be recorded in the faithfulness ledger.

**MC-8 (unwanted).** IF a property is stated in a form that is true by construction of the model —
so that no reachable state could violate it — THEN it SHALL be rejected in review, because a
property that cannot fail proves nothing about the system.

---

## 3. C2a — GC reachability safety

**MC-9 (ubiquitous).** THE Quint specification SHALL model checkpoint GC with at least: a set of live
manifests, the chunk references each manifest holds, and the set of deleted chunk hashes.

**MC-10 (ubiquitous).** THE Quint specification SHALL define C2a as `deleted` being disjoint from the
union of chunk references over **live manifests only**, and SHALL check it as a state invariant that
holds in every reachable state, not only in terminal states.

**MC-11 (ubiquitous).** THE Quint specification SHALL model chunk reclamation via an **unguarded**
primitive that is capable of deleting any chunk, with the safe collection action defined as that
primitive applied to the unreachable set.

**MC-12 (event-driven).** WHEN the unguarded reclamation primitive is applied to a chunk that is
still referenced by a live manifest THE model checker SHALL report a C2a violation.

> MC-11 and MC-12 exist together for one reason: if the model can only ever express the *safe*
> deletion, then C2a is true by construction and MC-8 rejects it. The unsafe operation must be
> **representable and excluded**, not unrepresentable.

**MC-13 (ubiquitous).** THE C2a model SHALL interleave `save` and `prune` by distinct concurrent
actors, since the sequential case is already covered by the P8 property test and is not where the
risk lies.

**MC-14 (ubiquitous).** THE C2a falsifiability control SHALL be a variant in which the reachability
set is computed over **all** manifests rather than live ones, and the model checker SHALL report a
violation for that variant.

---

## 4. C2b — eventual collection (liveness)

**MC-15 (ubiquitous).** THE Quint specification SHALL express C2b as a **temporal property**: a chunk
that is unreachable and older than the grace window is *eventually* deleted.

**MC-16 (ubiquitous).** THE C2b property SHALL be checked with the **TLC backend**
(`quint verify --backend tlc --temporal C2bEventual`). TLC is documented as checking invariants **and
temporal properties** over executions of any length, whereas Apalache's temporal support is
experimental and prompts for confirmation; a liveness claim decided by an experimental code path is
not evidence. A liveness counterexample is an infinite stuttering run, which a step-bounded symbolic
check is structurally poorly suited to exhibit.

**MC-16a (ubiquitous).** THE C2b model SHALL draw every value from an explicitly constrained finite
set rather than an unbounded type, because TLC enumerates states and cannot pick from an infinite
domain.

**MC-17 (ubiquitous).** THE C2b model SHALL impose **weak fairness** on the GC action, and the
specification SHALL state explicitly that C2b is conditional on a GC pass actually running — matching
the law's own conditionality in `STORAGE_ALGEBRA.md`, which calls this a scheduling concern rather
than an algebraic one.

**MC-18 (unwanted).** IF the fairness assumption on the GC action is removed THEN the model checker
SHALL report a C2b violation, demonstrating that the property depends on fairness and is not
vacuously true.

**MC-19 (ubiquitous).** THE C2b model SHALL represent the grace window as a deliberate delay during
which an unreachable chunk is **not** collected, and SHALL NOT permit immediate collection on
unreachability, because "deleted iff unreachable" was never the claim.

---

## 5. L1 — lease mutual exclusion

**MC-20 (ubiquitous).** THE Quint specification SHALL model lease acquisition at the level of
**attempts with outcomes** — granted or refused — rather than as a global "at most one holder"
predicate over a set.

**MC-21 (state-driven).** WHILE a lease on a key is held by one holder THE model SHALL refuse any
acquire attempt on that key by a different holder.

**MC-22 (ubiquitous).** THE L1 model SHALL admit traces in which two distinct holders issue
**overlapping** acquire attempts on the same key, so that contention is genuinely reachable.

**MC-23 (ubiquitous).** THE L1 model SHALL give each acquisition a **unique token**, so that two
acquisitions by the same holder cannot collapse into one set element and mask a double-hold.

**MC-24 (ubiquitous).** THE L1 property SHALL be that the number of holders of any single key never
exceeds one, checked as an invariant in every reachable state.

**MC-25 (ubiquitous).** THE L1 falsifiability control SHALL be a variant in which an acquire on a
held key succeeds instead of being refused, and the model checker SHALL report a violation for that
variant.

**MC-26 (ubiquitous).** THE L1 model SHALL model connection loss as a distinct event that releases
the lease, since the release contract binds the lease to the life of the connection.

---

## 6. T1 cross-writer

**MC-27 (ubiquitous).** THE Quint specification SHALL model at least two concurrent writers against a
shared key space and SHALL check that the committed version sequence per key is gapless and strictly
monotonic.

**MC-28 (ubiquitous).** THE T1-cross-writer result SHALL be reported as addressing the **OPEN**
cross-writer coordination item in `STORAGE_ALGEBRA.md`, and SHALL NOT be reported as closing the
per-key T1 obligation, which is already Lean-proved.

**MC-29 (unwanted).** IF the model permits two writers to commit the same version for one key THEN
the model checker SHALL report a T1 violation.

---

## 7. CI integration

**MC-30 (ubiquitous).** THE model-checking capability SHALL run in CI as its own workflow, separate
from the conformance gate, so its runtime never competes with the required test gate's clock.

**MC-31 (event-driven).** WHEN a pull request modifies the Quint specification, the traceability
manifest, or `Formal/STORAGE_ALGEBRA.md` THE model-checking CI job SHALL run and SHALL block merge on
failure.

**MC-32 (ubiquitous).** THE model-checking CI job SHALL pin the Quint and backend versions by exact
version and verify each downloaded artifact against a repository-held checksum before execution,
because an unverified checker that always exits zero would silently disarm this gate.

**MC-32a (ubiquitous).** THE model-checking CI job SHALL provision a compatible **OpenJDK**, which
both Apalache and TLC require, and SHALL fail if it is absent rather than skipping the affected
properties.

**MC-33 (unwanted).** IF the model checker cannot run — a missing backend, a timeout, an
out-of-memory, or an unparseable specification — THEN THE CI job SHALL fail, and SHALL NOT report
success on the grounds that no counterexample was produced.

> MC-33 is the single most important requirement here. "No counterexample found" and "the checker
> never ran" are indistinguishable in the exit-code-zero case, and that is precisely how a
> verification gate becomes decorative.

**MC-34 (ubiquitous).** THE model-checking CI job SHALL run every falsifiability control (MC-14,
MC-18, MC-25, MC-29) and SHALL fail if any control **passes**, since a control that does not fire
proves the corresponding property is not being enforced.

**MC-35 (event-driven).** WHEN the model checker reports a counterexample THE CI job SHALL publish
the counterexample trace as a build artifact, so a failure is diagnosable without re-running the
checker locally. THE job SHALL NOT assume Informal Trace Format for every property: `--out-itf` is
**Apalache-only**, so the TLC-backed C2b property captures its console counterexample instead.

**MC-40 (ubiquitous).** THE capability SHALL define a **witness** per property — a predicate
describing the interesting situation, checked with `quint run --witnesses` — and SHALL require each
witness to be observed in at least one sampled trace.

**MC-41 (unwanted).** IF a witness is never observed THEN the corresponding property SHALL be treated
as **not yet meaningful**, because a lease model in which contention never arises satisfies mutual
exclusion trivially, and its falsifiability control would pass too.

> MC-40/41 close the gap a control alone leaves. A control proves the property *can* fail; a witness
> proves the model actually *reaches* the situation the property is about. Both are needed.
> Recorded risk: Quint marks built-in witness support as under design, so this may need the fallback
> of asserting the negation as an invariant and reading the counterexample.

**MC-36 (optional feature).** WHERE the randomized simulator is used for fast feedback
(`quint run`), THE capability SHALL treat simulator runs as **non-authoritative**: a green simulator
run SHALL NOT substitute for `quint verify` on any property.

---

## 8. Documentation

**MC-37 (ubiquitous).** THE `Formal/FORMALIZATION_ROADMAP.md` gap map SHALL be updated so that C2a,
C2b, L1 and T1-cross-writer read `MODEL-CHECKED (bounded)` rather than `ABSENT`, with their bounds
cited.

**MC-38 (ubiquitous).** THE `ROADMAP.md` G20 written deferral SHALL be updated to record that these
four laws moved from *deferred* to *model-checked*, and SHALL continue to name every law that remains
neither proved nor model-checked.

**MC-39 (ubiquitous).** THE release documentation SHALL distinguish three statuses — `PROVED` (Lean,
unbounded), `MODEL-CHECKED (bounded)` (Quint), and `RUNTIME-TESTED` (P1–P10 sampling) — and SHALL NOT
merge them into a single "verified" claim.
