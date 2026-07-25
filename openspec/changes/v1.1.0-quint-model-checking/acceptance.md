# Acceptance — v1.1.0: Quint model checking

## Definition of done

The change closes when all of:

1. Every task in `tasks.md` is green, with its named acceptance test demonstrated — not asserted.
2. **Every one of the four falsifiability controls has been observed failing.** A control that has
   never been seen to fire is not evidence that its property is enforced.
3. The reach probe (task 0.4) has been observed turning CI **red** and then green on removal, so that
   "no counterexample" is known to be distinguishable from "the checker never ran".
4. `law-manifest.json` and the specification agree, and CI fails when they do not.
5. An independent auditor has confirmed no property is true by construction, and recorded a verdict.

## Status manifest — what this change may and may not claim

| Law | Before | After | Reported as |
|---|---|---|---|
| T3, T5, W1, C1 | Lean-proved (frozen cut-line) | unchanged | `PROVED` (unbounded) |
| T1 per-key, T2, T4 | Lean-proved in-tree | unchanged | `PROVED` (unbounded) |
| **C2a** | ABSENT | Quint invariant | `MODEL-CHECKED (bounded)` |
| **C2b** | ABSENT (and untestable by P-tests) | Quint temporal, TLC + weak fairness | `MODEL-CHECKED (bounded)` |
| **L1** | ABSENT | Quint invariant | `MODEL-CHECKED (bounded)` |
| **T1 cross-writer** | OPEN | Quint invariant | `MODEL-CHECKED (bounded)` |
| abstract → PostgreSQL refinement | unmechanized, sampled by P1–P10 | **model-based testing** via `quint-connect` | `REFINEMENT-TESTED` (never `PROVED`) |

**The last row is the one most likely to be misread.** MBT drives the real adapter with traces the
model generated, which is a stronger check than hand-written sampling — but it is still *testing*,
not proof. A model-checked algebra sitting on a tested-but-unproved refinement is not a verified
system, and no release document may imply otherwise.

## Explicit non-goals

- Not a replacement for P1–P10. Those remain the empirical bridge to the real PostgreSQL adapter.
- Not a replacement for the Lean cut-line. Bounded model checking is strictly weaker than proof and
  is reported separately, never merged into a single "verified" claim.
- Not a SQL/MVCC semantics. The refinement obligations stay in the register.
- Not a release gate. This is post-1.0.0 voluntary hardening; it adds no G-item and blocks no tag.

## The honesty bar

This change exists because three laws were **stated as mechanisms and proved by nothing**. It fails
its own purpose if it replaces that gap with a green check that means less than it appears to.
Concretely, it must not:

- report a bounded result as a proof;
- report a property whose control never fired;
- report C2b from Apalache's experimental temporal path;
- let a checker that failed to execute report success;
- state bounds anywhere other than alongside the result they qualify.
