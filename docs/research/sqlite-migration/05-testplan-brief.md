# UmbraDB → SQLite: test-plan authoring brief

You are one lane of a five-lane fleet producing the **verification plan** for a seven-change
OpenSpec sprint that migrates UmbraDB from PostgreSQL to SQLite. The specification work is
finished and audited. Your job is to make it **checkable**.

## The subject

Worktree: `\\wsl.localhost\Ubuntu-26.04\root\UDB-sqlite-sprint`, branch `sprint/sqlite-migration`,
under `openspec/changes/`. Seven changes, **168 requirements, 601 scenarios, 22,452 lines**, all
passing `openspec validate --changes --strict` (the only two failures repo-wide are the
pre-existing `v1.1.0-formal-completion` and `v1.1.0-quint-model-checking`).

| Change | Capability |
|---|---|
| `v1.0.0-sqlite-engine-core` | driver, shim, pragma bootstrap, worker topology, measurement gate |
| `v1.0.0-sqlite-temporal-event-log` | event-log redesign, T3/T5, clock, conversion boundary |
| `v1.0.0-sqlite-concurrency-lease` | lease, transactions, isolation, source guard |
| `v1.0.0-sqlite-schema-parity` | types, constraints, indexes, migration lineage |
| `v1.0.0-sqlite-durability-contract` | contracts, error catalog, durability, digests |
| `v1.0.0-sqlite-chain-archive` | archive port, layout, snapshots |
| `v1.0.0-sqlite-data-migration` | PostgreSQL→SQLite export/import |

Each change carries an `acceptance.md` whose criteria are already tagged by verification method —
`[unit]`, `[prop]`, `[CI]`, `[doc]`, `[manual]`. **That tagging is your starting point, not your
output.** A criterion tagged `[manual]` that could be automated is a finding. A criterion tagged
`[unit]` with no obvious test shape is a finding.

## The governing principle

**A negative control that never runs is a comment.**

This sprint accumulated an unusual number of negative controls — scenarios describing the *wrong*
implementation and what it would lose. They are the plan's best feature and they are worthless
unless they execute and fail. Examples of the shape, all measured during the sprint:

- The forbidden cursor-first ordering that violated the co-transactional invariant 4/9 under SIGKILL.
- The unseeded `UPDATE … WHERE id = 1` matching zero rows while every statement reports success.
- A blocking `busy_timeout` failing P10 at 1 acquired / 7 timeouts.
- A naive `UNIQUE` silently reintroducing a NULL-address duplicate a prior audit already caught.
- `UPDATE t SET dg = NULL` slipping a one-directional drift-guard trigger.
- A cancellation guard hoisted to 3,000 invocations across 9,000,000 rows.
- Restore checks reporting `pass` on a zero-row archive.

For every negative control in your lane: specify the test that makes it fail, and state what a
green run of that test actually proves.

## Existing verification you must build on, not replace

- **The P1–P10 conformance suite** — derived from `Formal/STORAGE_ALGEBRA.md`'s laws. It must be
  **re-executed against SQLite, not amended**. It currently runs against PostgreSQL via
  `@testcontainers/postgresql`.
- **`fast-check` property tests** under `test/postgres/*.property.test.ts`.
- **`docs/recovery/EVIDENCE.md`** — must be regenerated against the SQLite build. Note it already
  violates its own binding rule today: the Cold-boot round-trip table is blank, neither captured
  nor marked `NOT CAPTURED`.
- **The Lean cut-line `{T3, T5, W1, C1}`** under `Formal/Lean/`, gated by `.github/workflows/lean.yml`.
  It models an **abstract** store; the abstract→concrete refinement is explicitly trusted and
  unmechanized. **The conformance suite, not the proof assistant, carries the refinement claim.**
- CI workflows: `conformance.yml`, `bench-smoke.yml`, `pack-smoke.yml`, `supply-chain.yml`, `lean.yml`.

## Hard constraints on any measurement you specify

- **Never `/tmp`.** It is a 32 GB tmpfs RAM disk on this host and it invalidated an entire research
  lane — a 233× error on commit throughput. Every I/O-sensitive measurement runs on `/root` (ext4)
  or a named real filesystem, and the plan must include a CI assertion that the test filesystem is
  not memory-backed.
- **State conditions with every figure**: filesystem, `journal_mode`, `synchronous`, `page_size`,
  `auto_vacuum`, dataset size relative to host RAM, single vs concurrent writer, binding and
  `sqlite_version()`.
- **No figure from the research phase may be a pass threshold.** Change 1's measurement gate
  (blocked decisions **B-1…B-8**) exists to establish them. Where a test needs a threshold that
  does not yet exist, specify the experiment that produces it and mark the test blocked on it.
- Node 24.18 and `better-sqlite3@13.0.2` (unpacked at `/tmp/l3-bs3b`) are available. **Do not run
  `npm install`.**

## Two traps specific to writing tests for this plan

1. **A single-table test cannot catch the cancellation-guard hoisting defect.** Change 1 measured
   that on a single-table scan even the constant-argument form fires 200,000/200,000, while on a
   join the same form fires 3,000/9,000,000 — and that an argument depending on only *one* of two
   joined tables is still hoisted. Any test of that guard must use a join.
2. **Zero-row and empty-scope states pass vacuously.** Five separate instances were found in this
   sprint. Any suite that can run against an empty fixture must assert its fixture is non-empty, or
   report `n/a — no rows in scope` rather than `pass`.

## Your deliverable

Write to `\\wsl.localhost\Ubuntu-26.04\root\umbradb-sqlite-research\testplan\<YOUR_LANE_ID>.md`:

1. **Scope** — which requirements and acceptance criteria your lane covers, by change and
   requirement title (**not line number** — line anchors rot; the sprint measured a 41%
   mis-anchor rate).
2. **The test inventory** — one row per test: what it asserts, which requirement or scenario it
   discharges, its type (unit / property / integration / conformance / crash / benchmark / CI gate),
   its fixture, and its pass condition. Pass conditions must be objective.
3. **Negative controls** — separately listed. For each: the wrong implementation it plants, how it
   is planted without shipping it, and what its failure proves.
4. **Fixtures and harnesses** — what must be built. Be concrete about data volume and shape.
5. **What cannot be tested**, and why — with the nearest achievable substitute. An honest gap is
   worth more than a test that appears to cover something it does not.
6. **Blocked-on-measurement** — tests that cannot get a threshold until a B-gate closes.

## Traps

1. **WSL/Windows paths.** The repo is in WSL; your tools run on Windows. A bare `/root/...` path
   given to Read/Write resolves on the **Windows** drive and silently creates a phantom file. Use
   `\\wsl.localhost\Ubuntu-26.04\root\...`.
2. **Never `wsl -e bash -lc "..."` with double outer quotes** — it eats backticks and corrupts
   content. Single quotes, or write a script file.
3. Use the Bash tool, not PowerShell, for WSL.
4. **OpenSpec CLI is `/usr/local/bin/openspec`**; `npx openspec` is a broken 0.0.0 stub.
5. **Never claim "verified" without pasting the command.**
6. **Do not modify `src/`, `test/`, the specs, or any product code.** You are writing a plan.
7. Prototype a test in `/root/` scratch space if it settles a question — measured beats assumed.
