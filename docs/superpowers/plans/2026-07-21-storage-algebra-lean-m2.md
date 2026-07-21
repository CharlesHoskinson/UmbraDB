# Storage Algebra Lean M2 Retention Sprint

**Goal:** Close extensional T5 coverage and extend the completed M1 TemporalKV kernel with
executable prefix retention and retention-transparent per-key T3.

**Architecture:** The complete M1 history remains the reference semantics. A retained state is
either a certified complete history (with `complete []` uniquely representing never written) or a
nonempty suffix carrying the positive number of original events pruned. Both availability-floor
coordinates are derived from that suffix. Lookup below the corresponding floor is unavailable;
lookup throughout the retained horizon agrees with M1 and preserves original one-based versions.

**Toolchain:** Lean 4.32.0, mathlib v4.32.0, Lake 5, the existing source/axiom trust audits, and
the bundled `leanchecker` CI gate.

## Completed baseline

- M1 transitions, lookup characterization, replay, ordering preservation, and dual addressing.
- T5 validity projection with bounded half-open intervals and one live half-infinite tail.
- Pairwise interval disjointness and structural adjacency/gap-freedom.
- No-placeholder source scan, elaborated axiom audit, warning-as-error build, and `leanchecker`.

## Approved semantic decisions

- Preserve all M1 definitions and theorem signatures.
- Use `complete []` as the sole per-key never-written state; do not add a duplicate constructor.
- A pruned state contains a positive `prunedCount` and a structurally nonempty suffix.
- Derive `oldestAvailableAt` from the suffix head timestamp.
- Derive `oldestAvailableVersion` as `prunedCount + 1`.
- Retention deletes prefixes only and may not delete the live final event.
- Time selection remains predecessor lookup; version selection remains exact lookup.
- Selectors strictly below their corresponding floor are unavailable; equality is available.
- Future time selects the live event; a future exact version is absent.
- Retention-layer version queries use a positive subtype, making version zero unrepresentable.
- Treat every pre-floor time as unavailable: a pruned suffix does not retain a birth certificate.
- Keep `WellFormed` as a separate predicate so malformed histories remain executable.

## Implemented source layout

- `Formal/Lean/UmbraDBFormal/TemporalKV/Retention/Model.lean`
- `Formal/Lean/UmbraDBFormal/TemporalKV/Retention/Laws.lean`
- `Formal/Lean/UmbraDBFormal/TemporalKV/Retention.lean`
- matching retention model/law test modules under `UmbraDBFormalTest`
- default library, test, and elaborated trust-audit imports

## Theorem gate

### Extensional T5

- validity interval count equals event count;
- dropping a prefix preserves `WellFormed`;
- for a nonempty well-formed history, membership in some validity interval is equivalent to being
  at or after the first event timestamp.

### Executable pruning

- pruning zero events returns a complete history;
- positive successful pruning exposes exactly `history.drop prunedCount`;
- pruning the whole history or more is rejected;
- successful pruning preserves `WellFormed` and the original live final event.

### Lookup classification

- complete time/version results agree with M1;
- time lookup is unavailable iff the query is below `oldestAvailableAt`;
- exact-version lookup is unavailable iff the selector is below `oldestAvailableVersion`;
- lookup at either floor returns the retained head with its original version;
- retained time lookup at or above the floor is never absent;
- exact versions above the live version are absent;
- every found exact-version result reports the queried original version.

### Retention-transparent T3

For every well-formed complete history and successful positive prefix pruning:

- time lookup at or above the retained timestamp floor equals M1 lookup on the original history;
- positive exact-version lookup at or above the version floor equals M1 lookup;
- found entries retain original one-based versions rather than restarting at one.

## Adversarial test matrix

- never-written complete history;
- complete history queried before birth;
- whole-history pruning rejection;
- strict below-floor unavailable classification for both selectors;
- equality at both floors;
- between-event, exact-boundary, and live-tail time lookup;
- future exact-version absence;
- pruning 40 events produces original version 41;
- version zero is unconstructable;
- the same local list has distinct complete versus pruned pre-head outcomes;
- malformed histories remain executable while proofs require `WellFormed`;
- a found null-like value remains distinct from absence.

## Explicit non-goals

- keyed-store or transaction lifting;
- PostgreSQL rows, retention jobs, floor metadata, or concurrency refinement;
- TypeScript runtime-selector validation and error wiring;
- serialized oracle generation;
- Graphify refresh;
- JavaScript/PostgreSQL timestamp precision and signed-`bigint` bounds;
- full-key eviction, checkpoints, watermarks, GC, leases, and liveness.

## Verification matrix

```text
cd Formal/Lean
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/check-trust.ps1
lake build --wfail
lake env lean UmbraDBFormalTest/TemporalKV/Retention/Model.lean
lake env lean UmbraDBFormalTest/TemporalKV/Retention/Laws.lean
lake env leanchecker

cd ../..
npm run typecheck
npm run docs:storage:check
npm test
actionlint .github/workflows/lean.yml
git diff --check
```

Every command must exit zero, new modules must remain reachable from the default trust roots, and
the pushed GitHub Actions run must be green before the sprint is declared complete.
