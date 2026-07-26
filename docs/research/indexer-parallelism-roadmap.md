# Roadmap: maximizing parallelism in the Midnight chain-indexer

*Target: `midnightntwrk/midnight-indexer` v4.3.3 catch-up throughput. Written against measured
profile data from a live 20-core box, not from reading the code alone.*

## The finding that shapes everything below

A 40-second `perf` profile of the running indexer at 1.67 blocks/s:

| Symbol | Share of CPU |
|---|---|
| `hashbrown::RawTable::clone` | 39.02% |
| `hashbrown::RawTable::drop` | 25.52% |
| `malloc` | 1.59% |
| `sha2` digest | 1.24% |
| `Sp::deserialize` | 1.06% |
| BLS / proof math | **0.28%** |

**64.5% of CPU is cloning and dropping one HashMap.** Proof verification, which would have been the
natural parallelism target on a ZK chain, is a third of one percent.

Cause: `storage-core/src/arena.rs:1160-1166`. `IrLoader::get` recurses once per node in the object
graph and deep-clones `key_to_child_repr: HashMap<ArenaHash, ArenaKey>` at every level. N nodes
produce N clones of an N-entry map. It runs once per transaction, per system transaction, and per
contract action.

**This is not a parallelism problem.** It is a quadratic algorithm, and upstream already fixed it on
the ledger-9 line by making the field `Rc<HashMap<…>>`.

The roadmap therefore starts by removing the quadratic term, and only then asks what parallelism is
left to win. Parallelising a quadratic inner loop across 20 cores would buy a constant factor
against a term that shouldn't exist.

---

## Stage 0 — Experiments: establish what is actually true

*Nothing here changes production. Every later stage is gated on these numbers.*

**E0.1 — Reproduce the profile on a pinned corpus.** Capture a fixed range of ~2,000 blocks
(a dense range, not empty ones) and build a repeatable harness that replays exactly those blocks.
Every experiment after this reports against the same corpus, or the numbers are not comparable.
*Exit:* two consecutive runs within 5% of each other.

**E0.2 — Quantify the quadratic.** Instrument `Sp::deserialize` to record node count and wall time
per call. Plot time against N. Confirm the curve is superlinear and measure the exponent.
*Exit:* a documented N-vs-time curve. If it is linear, the diagnosis is wrong and the roadmap stops
here.

**E0.3 — Backport the `Rc` fix and re-measure.** Vendor `midnight-storage-core`, change
`key_to_child_repr` to `Rc<HashMap<…>>` (three sites: field decl, two constructors, one deref).
*Exit:* a blocks/s number on the E0.1 corpus. Expected ~1.9x. **This is the single highest-value
experiment and it must run first**, because it changes the profile that every parallelism decision
depends on.

**E0.4 — Re-profile after the fix.** The 64.5% disappears; something else becomes the top symbol.
*Exit:* a new ranked profile. Only now do we know what parallelism should target.

**E0.5 — Measure the off-CPU 26%.** 74% of wall is on-CPU, so a quarter is waiting. Suspect: the
redundant `at_block` in `determine_system_parameters_change` (`subxt_node.rs:438`) plus a
`Core_version` RPC per `at_block` from an unconfigured subxt `RangeMap`.
*Exit:* a breakdown of where the off-CPU time goes.

**E0.6 — Establish the serial floor.** With the quadratic gone, measure the irreducible sequential
cost per block: state root computation, `persist()`, `flush_all_changes_to_db`.
*Exit:* a blocks/s ceiling for *any* design that keeps the fold serial. This number decides whether
Stages 3+ are worth building.

---

## Stage 1 — Theory: model what parallelism is admissible

*Before writing concurrent Rust, establish which reorderings are legal. This is a Quint modelling
exercise, using the installed `quint-modeling` skill and the
[quint-llm-kit](https://github.com/quint-co/quint-llm-kit).*

The core obligation: **any parallel pipeline must produce a bit-identical result to the sequential
fold.** An indexer that is fast and subtly wrong is worse than a slow one, especially when its output
is release evidence.

**T1.1 — Model the sequential baseline.** State: `height`, `ledgerState`, `db`. One action
`indexBlock(h)` decomposed into its real phases — `fetch`, `deserialize`, `wellFormed`, `apply`,
`root`, `persist`, `save`. This is the specification everything else is compared against.

**T1.2 — State the correctness property.** `finalState(parallel) == finalState(sequential)` for
every admissible schedule. Express as an invariant over a model that runs both and compares.

**T1.3 — Model pipeline parallelism (Stage 3's design).** `fetch` and `deserialize` for block N+1
run concurrently with `apply` for block N. Check the equivalence invariant. The interesting question
is whether `deserialize` genuinely has no dependency on `ledgerState` — the model forces that
question to be answered precisely rather than assumed.

**T1.4 — Model intra-block transaction parallelism (Stage 4).** Deserialize and `well_formed` all
transactions in a block concurrently, then apply serially. Same invariant.

**T1.5 — Model speculative parallel apply (Stage 5).** Apply blocks optimistically in parallel,
detect conflicts on the arena key set, roll back and retry on conflict. This is the design most
likely to be *wrong*, so it is the one most worth model-checking before implementing.

**T1.6 — Falsifiability controls.** Every property above ships a deliberately-broken variant that
the checker MUST reject: a pipeline that lets `apply` observe a stale `ledgerState`, a speculative
scheduler that misses a write-write conflict. A property whose control never fires proves nothing.

Backend routing follows the existing `v1.1.0-quint-model-checking` change: invariants on Apalache
with an explicit `--max-steps`; anything temporal on TLC, since Apalache's temporal support is
experimental.

**Deliverable:** a ranked list of *provably admissible* parallelisations, and a list of the ones the
model rejects, with counterexample traces. Stages 3-5 are re-scoped against this.

---

## Stage 2 — Cheap serial wins (no concurrency)

Ship these regardless; they are independent of the parallelism work.

| Item | Expected | Confidence |
|---|---|---|
| **2.1** `Rc` backport from E0.3 | ~1.9x | high |
| **2.2** Release profile: `lto = "fat"`, `codegen-units = 1`, `target-cpu=native` | 5-15% | medium |
| **2.3** Remove redundant `at_block` + configure the subxt spec-version `RangeMap` | 10-20% | medium |
| **2.4** Drop `LEDGER_DB__CACHE_SIZE` to `64kiB` | 0% speed, **−13 GB RSS** | high |

2.4 is worth stating plainly: `cache_size` is an **object count**, not bytes. The current `2MiB`
setting means 2,097,152 objects against an upstream default of 1,024, and it is not the bottleneck.
Reclaiming that RAM helps the OS page cache in front of an 88 GB ledger DB.

---

## Stage 3 — Pipeline parallelism

*Gated on T1.3 proving equivalence and E0.4 showing deserialize is still material.*

Split the loop into stages connected by bounded channels: `fetch → deserialize+well_formed → apply →
persist`. Only `apply` stays serial. Depth is bounded to cap memory.

Risk: `deserialize` currently touches the global arena `Storage` behind a mutex with
`block_in_place`+`block_on` per node access (`ledger_db/v1_1.rs:61-82`). If deserialization cannot be
made arena-independent, this stage collapses to nothing. **E0.4 and T1.3 must answer that before any
code is written.**

---

## Stage 4 — Intra-block parallelism

*Gated on Stage 3 landing and on transaction count per block being high enough to matter.*

Measured: 0.66 transactions/block average. **This stage is probably not worth building** — at fewer
than one transaction per block, parallelising within a block wins almost nothing. Included for
completeness and to be explicitly rejected unless E0.1's dense corpus shows otherwise.

---

## Stage 5 — Speculative parallel apply

*Only if Stages 1-3 leave the serial fold as the dominant remaining cost.*

Apply blocks N..N+k optimistically in parallel; track the arena key set each touches; commit in order
if disjoint, roll back and re-apply serially on conflict. This is a real concurrency-control problem
and the place where a subtle bug produces a wrong chain state that looks fine.

Do not start this without T1.5 model-checked, including its falsifiability control. If the model
finds a schedule where a conflict is missed, that is the design failing cheaply, which is the point.

---

## Stage 6 — Validation

No fork output is trusted until it passes all of these:

**V6.1 — Bit-identical replay.** Fork and stock index the same range; compare final ledger-state root
and every block's stored root. Any divergence fails.

**V6.2 — Differential against the hosted indexer.** Query the public indexer for a sample of blocks
and compare against the fork's output.

**V6.3 — Crash consistency.** Kill the fork mid-block; restart; verify it resumes correctly and the
result still matches V6.1.

**V6.4 — Determinism.** Same input, N runs, identical output. A parallel scheduler that is
non-deterministic across runs is disqualified regardless of speed.

---

## What this roadmap does not promise

**It will not reach 20x on 20 cores.** The ledger fold is `state(n+1) = apply(state(n), block(n+1))`,
a sequential dependency that no scheduler removes. Realistic outcome: ~1.9x from Stage 2.1, perhaps
2.5-3x cumulative with Stages 2-3, and Stage 5 is speculative in both senses.

**The first real win is not parallelism at all.** It is deleting a quadratic clone that upstream has
already deleted on a later branch.

**Correctness outranks throughput.** This indexer's output is intended as evidence for a UmbraDB
1.0.0 release. A fork that indexes faster and produces subtly different state does not accelerate the
release, it invalidates it.

---

## Separately: the disk problem is more urgent than the speed problem

v4.3.3 has **no ledger-DB garbage collection** (`indexer-common/Cargo.toml:23` enables `layout-v2`
only; `gc-v1` arrives in 4.3.4). Every block's ledger state is persisted as a permanent GC root and
never reclaimed. Currently 161 GB at height ~900k of ~1.83M, and it should be expected to roughly
double before tip.

No amount of throughput work matters if the disk fills first. Stage 2.4 and the pending 22 TB volume
address this; the 4.3.4 GC feature is the upstream fix, at the cost of migration `008` rebuilding the
largest table.
