# Tasks — v1.1.0: Quint model checking

Each task names its EARS requirements and an acceptance test. Per the implementation guideline, work
happens in an isolated worktree, red-then-green, with an independent audit before merge.

## 0. Toolchain and scaffolding

- [ ] 0.1 Add `Formal/Quint/` with a minimal `umbradb_checkpoint.qnt` that typechecks, plus a
      `README.md` stating what a bounded result does and does not mean (MC-2, MC-4).
      **Acceptance:** `quint typecheck Formal/Quint/umbradb_checkpoint.qnt` exits 0.
- [ ] 0.2 Pin Quint, Apalache and TLC by exact version, record SHA-256 checksums in-repo, provision a
      compatible **OpenJDK** (both backends require it), and add the install-and-verify step (MC-32,
      MC-32a).
      **Acceptance:** the install step fails on a deliberately corrupted checksum, and the job fails
      — rather than skipping — when the JDK is absent.
- [ ] 0.3 Add `law-manifest.json` (property → law id → backend → bounds) and `bounds.json` (MC-3,
      MC-5, MC-6).
      **Acceptance:** a manifest entry naming a property that does not exist fails the manifest check.
- [ ] 0.4 Add the **reach probe**: a temporary always-false invariant that MUST make CI red, proving
      the checker actually runs (MC-33).
      **Acceptance:** with the probe active CI is red; removing it turns CI green. Record both runs.

> 0.4 is not ceremony. The whole gate rests on "no counterexample" being distinguishable from "never
> executed", and the only way to know which one CI is reporting is to have watched it fail once.

> **Sequencing follows Quint's own guidance:** safety properties (C2a, L1, T1) are far easier to
> write and check than liveness, which needs temporal formulas and fairness assumptions. Sections 1,
> 3 and 4 therefore land before section 2.

## 1. C2a — GC reachability safety

- [ ] 1.1 Model `manifests` / `live` / `deleted` / `allChunks` with `save`, `unlink` and the
      **unguarded** `collectHashes` primitive (MC-9, MC-11).
- [ ] 1.2 Define C2a as disjointness of `deleted` from the union over **live** manifests, as a state
      invariant over all reachable states (MC-10).
- [ ] 1.3 Interleave `save` and `prune` as distinct concurrent actors (MC-13).
      **Acceptance:** the state space contains a trace where a prune step is sandwiched between two
      steps of an in-flight save.
- [ ] 1.4 Show the unsafe operation is **representable and excluded**: feeding a live-referenced hash
      to `collectHashes` violates C2a, with the witness reclaiming a chunk that was registered and
      then unlinked (MC-12).
      **Acceptance:** the checker returns a counterexample for that trace.
- [ ] 1.5 Falsifiability control `C2aAllManifests` (MC-14).
      **Acceptance:** control **fails** the invariant; CI fails if it passes.
- [ ] 1.6 Witness `w_chunk_unlinked_then_collected` observed in ≥1 sampled trace (MC-40, MC-41).
      **Acceptance:** `quint run --witnesses w_chunk_unlinked_then_collected` reports a non-zero
      trace count — proving the model actually reaches a reclaim-after-unlink, not just that the
      invariant is unfalsified.

## 2. C2b — eventual collection

- [ ] 2.1 Add a discrete clock, `unreachableSince`, and a grace window during which a chunk is not
      collectable (MC-19).
- [ ] 2.2 State C2b as a temporal property with weak fairness on the GC action (MC-15, MC-17).
- [ ] 2.3 Route C2b to the **TLC** backend and record in the manifest why it is not Apalache
      (MC-16). Constrain every domain to an explicit finite set — TLC enumerates states and cannot
      pick from an infinite type (MC-16a).
      **Acceptance:** `quint verify --backend tlc --temporal C2bEventual` runs to a verdict; the
      manifest's `backend` field for C2b reads `tlc`; no unbounded domain remains in the module.
- [ ] 2.4 Falsifiability control `C2bNoFairness` (MC-18).
      **Acceptance:** with fairness removed the property **fails**, demonstrating C2b depends on a GC
      pass actually running rather than holding vacuously.

## 3. L1 — lease mutual exclusion

- [ ] 3.1 Model acquisition as **attempts with outcomes** (granted / refused), not as a global
      ≤1-holder predicate (MC-20, MC-21).
- [ ] 3.2 Admit traces with two distinct holders issuing **overlapping** acquires on one key
      (MC-22).
      **Acceptance:** a trace exists in which holder B attempts acquire while holder A holds, and B
      is refused — genuine contention, not serial reuse.
- [ ] 3.3 Give every acquisition a unique token so same-holder acquisitions cannot collapse
      (MC-23).
- [ ] 3.4 Model connection loss as a distinct releasing event (MC-26).
- [ ] 3.5 Check `|holders(k)| <= 1` as an invariant in every reachable state (MC-24).
- [ ] 3.6 Falsifiability control `L1AcquireAlwaysGrants` (MC-25).
      **Acceptance:** the counterexample shows two distinct tokens on one key.
- [ ] 3.7 Witness `w_contended_acquire` observed in ≥1 sampled trace (MC-40, MC-41).
      **Acceptance:** a non-zero witness count. Without this, L1 could hold trivially because
      contention never arises — and its control would pass too, so neither would reveal the gap.

## 4. T1 — cross-writer

- [ ] 4.1 Model ≥2 concurrent writers over a shared key space; check per-key gapless strict
      monotonicity (MC-27).
- [ ] 4.2 Falsifiability control `T1DuplicateVersion` (MC-29).
- [ ] 4.3 Record the result as addressing the **OPEN cross-writer** item only, explicitly **not** the
      already-Lean-proved per-key T1 (MC-28).

## 5. CI

- [ ] 5.1 Add `.github/workflows/model-check.yml`, separate from the conformance gate (MC-30),
      triggered by changes to the Quint spec, the manifest, or `STORAGE_ALGEBRA.md`, plus a weekly
      schedule (MC-31).
- [ ] 5.2 Make every failure mode **fail closed** — missing backend, timeout, OOM, parse error
      (MC-33).
      **Acceptance:** each of those four is simulated and each turns CI red.
- [ ] 5.3 Run all four controls and fail if any **passes** (MC-34).
- [ ] 5.4 Upload counterexample traces as build artifacts (MC-35). Use `--out-itf` for the
      Apalache-backed properties; capture the console counterexample for the TLC-backed C2b, since
      ITF output is Apalache-only.
- [ ] 5.6 Run every witness and fail if any is never observed (MC-40, MC-41).
- [ ] 5.5 Mark `quint run` simulator usage non-authoritative (MC-36).

## 7. Model-based conformance (the refinement bridge)

*Runs after sections 1–4. This is what turns "the algebra is model-checked" into "the shipped adapter
was driven by traces the model generated".*

- [ ] 7.1 Stand up MBT with `quint-connect`, driving `PgCheckpointStore` and
      `PgTransactionLeaseLayer` against Testcontainers Postgres from model-generated traces.
      **Acceptance:** a generated trace executes end-to-end against a real database.
- [ ] 7.2 Assert **every** spec event per transition — state changes, refusals, reclamations — not
      only the final state, since a divergence that self-corrects by the end of a trace is exactly
      the bug worth catching.
- [ ] 7.3 Treat a divergence as an **implementation** defect by default, per the kit's doctrine that
      the spec is ground truth — and, when the spec is instead the thing that is wrong, fix the spec
      and record why in the faithfulness ledger.
- [ ] 7.4 Wire MBT into CI as a **non-blocking** job initially, promoted to blocking once it has run
      clean for a full week — a brand-new trace generator that fails intermittently would otherwise
      block unrelated work while nobody trusts it yet.
- [ ] 7.5 Report the adapter's status as `REFINEMENT-TESTED`, never `REFINEMENT-PROVED`.

## 6. Documentation and close-out

- [ ] 6.1 Update `Formal/FORMALIZATION_ROADMAP.md`: C2a, C2b, L1, T1-cross-writer become
      `MODEL-CHECKED (bounded)` with bounds cited (MC-37).
- [ ] 6.2 Update `ROADMAP.md`'s G20 deferral to record the four laws moving from *deferred* to
      *model-checked*, still naming everything that remains neither (MC-38).
- [ ] 6.3 Update `openspec/changes/v1.1.0-formal-completion` to record that C2a and L1 moved to Quint
      and that its remaining scope is the C1 collision-hygiene rider and the refinement register.
- [ ] 6.4 Ensure the three statuses — `PROVED` / `MODEL-CHECKED (bounded)` / `RUNTIME-TESTED` — are
      distinguished wherever verification is claimed (MC-39).
- [ ] 6.5 Whole-change audit: an independent auditor confirms every property has a **firing** control,
      that no property is true by construction (MC-8), that C2b really runs on TLC, and that the
      bounds in the manifest match what CI executed.
      **Acceptance:** a written verdict recorded in the change; blocking findings fixed and
      re-audited before merge.
