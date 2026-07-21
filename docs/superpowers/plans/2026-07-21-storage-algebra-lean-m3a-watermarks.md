# Storage Algebra Lean M3a Watermarks Sprint

**Goal:** Mechanize the executable abstract Watermarks store and prove Law W1, including the
trace-level statement that lookup returns the last value set at an address.

**Architecture:** A watermark address is `(kind, key)`. The store is a total function from
addresses to optional values, so `none` is the unique never-set observation. `set` is
`Function.update` with `some value`; a command trace is interpreted in list order. SQL rows,
JSON validation, timestamps, transactions, and concurrency remain outside this pure kernel.

**Toolchain:** Lean 4.32.0, mathlib v4.32.0, Lake 5, the `lean4` skill, the existing source and
elaborated axiom audits, and `leanchecker`.

## Audited semantic decisions

- Follow the detailed roadmap order: M3 simple stores precede keyed TemporalKV and refinement.
- Scope this sprint to Watermarks W1 only; CheckpointStore C1 is the following sprint.
- Use the exact `(kind, key)` pair as the address; equal keys under different kinds are distinct.
- Keep `none` as absence and `some value` as presence, including null-like abstract values.
- Model `set` as unconditional overwrite with no version, history, CAS, or monotonicity rule.
- Interpret command traces in list order and characterize the final matching command.
- Preserve unrelated addresses and prove distinct-address updates commute.
- Treat the existing API-smoke update theorem as precedent, not as the domain proof.

## Source layout

- `Formal/Lean/UmbraDBFormal/Watermarks/Model.lean`
- `Formal/Lean/UmbraDBFormal/Watermarks/Laws.lean`
- `Formal/Lean/UmbraDBFormal/Watermarks.lean`
- matching model and law contract tests under `UmbraDBFormalTest/Watermarks/`
- production, test, and trust umbrella imports

## Theorem gate

- empty lookup is absent;
- setting an address makes lookup at that address return `some` of the new value;
- setting one address preserves every distinct address;
- a second set at the same address wins;
- repeating the same set is idempotent;
- sets at distinct addresses commute;
- running concatenated traces equals sequentially running each trace;
- an independent `lastMatching` observer returns the value from the final command targeting the
  queried address, or `none` when no command matches;
- lookup after a trace equals `some` of that final matching value, falling back to the initial
  store when no command targets the address;
- an address absent from a trace is unchanged.

## Adversarial examples

- empty lookup;
- one set;
- two different values at the same address;
- repeated identical value;
- equal key under different kinds;
- different keys under one kind;
- interleaved commands where the last matching command is not the final command;
- no matching command fallback to a pre-existing value;
- outer absence `none` remains distinct from a stored null-like abstract value `some none` when
  `Value := Option Nat`; this makes no runtime top-level-JSON-null claim;
- distinct-address commutation.

## Explicit non-goals

- CheckpointStore C1 or C2;
- keyed TemporalKV, transaction handles, rollback, or leases;
- PostgreSQL refinement, upsert/HOT evidence, `updated_at`, or concurrency;
- JSON serialization, top-level-null validation, or bigint conventions;
- progress monotonicity;
- executable cross-language oracle generation;
- dependency or toolchain changes;
- archival of completed implementation sprints.

## Verification matrix

```text
graphify update .
graphify diagnose multigraph --graph graphify-out/graph.json --json

cd Formal/Lean
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/check-trust.ps1
lake env lean UmbraDBFormal/Watermarks/Model.lean
lake env lean UmbraDBFormal/Watermarks/Laws.lean
lake env lean UmbraDBFormalTest/Watermarks/Model.lean
lake env lean UmbraDBFormalTest/Watermarks/Laws.lean
lake build --wfail
lake env leanchecker

cd ../..
openspec validate sprint-5-formal-watermarks --strict
openspec validate --all --strict
npm ci                         # in a fresh worktree
npm run typecheck
npm run docs:storage:check
npm test
actionlint .github/workflows/lean.yml
git diff --exit-code origin/main -- Formal/Lean/lean-toolchain Formal/Lean/lakefile.lean \
  Formal/Lean/lake-manifest.json package.json package-lock.json
git diff --check
git status --short
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/formal/storage-algebra-lean-m3a-watermarks)"
gh run list --commit "$(git rev-parse HEAD)" --workflow lean.yml
```

The planning tranche is committed, pushed, and opened as a draft PR before proof edits. Proof
sources are committed before integrating current `main`; final status and generated artifacts are
then produced from that integrated tree. The sprint is complete only after three independent
persona PASS verdicts on the exact final commit, a clean pushed branch whose local and remote SHAs
match, and a successful GitHub trust run on that same SHA.
