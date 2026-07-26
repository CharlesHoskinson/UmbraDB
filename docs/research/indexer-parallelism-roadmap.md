# Roadmap: maximizing throughput in the Midnight chain-indexer

*v2. Rewritten after profiling our own running indexer and researching how Erigon, Reth, Besu,
Aptos, Solana, Sui and Substreams handle the same problem. The research changed the ranking, and it
changed the goal: the win is not parallel execution.*

## Two measurements that decide everything

**1. Where our CPU goes** (40s `perf` on the live container at 1.67 blocks/s):

| Symbol | Share |
|---|---|
| `hashbrown::RawTable::clone` + `::drop` | **64.5%** |
| `sha2` digest | 1.24% |
| BLS / proof math | **0.28%** |

An O(N²) deep clone of `key_to_child_repr` in `storage-core/arena.rs:1160-1166`. Upstream already
fixed it on the ledger-9 line by making the field an `Rc`. Proof verification, the obvious
parallelism target on a ZK chain, is a third of one percent.

**2. Our transaction density: 0.66 transactions per block.**

That single number invalidates most of the parallel-execution literature, as shown below.

---

## The governing insight, from the replay literature

Every technique in the Aptos/Solana/Sui/parallel-EVM canon exists to discover *at runtime* which
transactions conflict. **We already know — we are replaying settled history.**

The technique that exploits this is published and measured. **Ira: Efficient Transaction Replay for
Distributed Systems** (Visa Research, [arXiv:2601.21286](https://arxiv.org/abs/2601.21286)) states
our problem verbatim: *"the primary, having already executed transactions, possesses knowledge of
future access patterns which is exactly the information needed for optimal replay."*

Measured against unmodified reth over 100,800 mainnet blocks:

| Configuration | Wall time | Speedup |
|---|---|---|
| sequential baseline | 22,604 s | 1.0x |
| hints + **1** prefetch thread | 4,366 s | **5.2x** |
| hints + 16 prefetch threads | 956 s | **23.6x** |

**The executor stayed sequential throughout.** All parallelism was in I/O prefetch, and the mechanism
is *sorting*, not threading — 5.2x at a single thread. It is bit-identical by construction rather
than by proof: hints are advisory, and a crash-on-miss cache halts rather than diverging if a hint is
wrong.

This is the shape of the answer. Not "parallelize the fold" but "the fold never waits."

---

## Stage 0 — Experiments (gates everything else)

**E0.1** Pin a dense ~2,000-block corpus and build a repeatable replay harness. Two runs within 5%.

**E0.2** Confirm the quadratic: instrument `Sp::deserialize`, plot node-count vs time. If linear, the
diagnosis is wrong and this roadmap stops.

**E0.3 — The `Rc` backport.** Vendor `midnight-storage-core`, change `key_to_child_repr` to
`Rc<HashMap<…>>` (three sites). Verbatim what upstream did in `ledger-9.1.0.0-rc.3`. Expected ~1.9x.

**E0.4 — RE-PROFILE. This is the gate.** Every ranking below assumes we land **I/O-bound**, as reth
did (67.9% I/O / 32.1% compute). If we land CPU-bound instead, Stage 3 outranks Stages 1–2 and the
roadmap reorders. One afternoon of measurement, and it decides the plan.

**E0.5** Break down the off-CPU 26%: the redundant `at_block` in
`determine_system_parameters_change` plus a `Core_version` RPC per `at_block` from an unconfigured
subxt `RangeMap`.

**E0.6** Establish the serial floor with the quadratic gone: `persist()`, `flush_all_changes_to_db`,
root computation. This is the ceiling for any design keeping the fold serial.

---

## Stage 1 — Config and I/O (hours, provably bit-identical)

**1.1 — SQLite pragmas. None are currently set.** `pool/sqlite.rs` does only `max_connections(1)`.
sqlx sets no journal mode; SQLite's defaults are `DELETE` journal and `synchronous=FULL`. Set
`journal_mode=WAL`, `synchronous=NORMAL`, `cache_size=-8000000`, `temp_store=MEMORY`,
`locking_mode=EXCLUSIVE`. sqlite.org is explicit that this matches our risk bar: *"WAL mode is safe
from corruption with synchronous=NORMAL… A transaction committed in WAL mode with
synchronous=NORMAL might roll back following a power loss."* Lose recent commits, never corrupt.

**1.2 — Keep the trie resident across blocks.** Stop re-reading upper trie nodes every block. Reth's
sparse-trie-as-cache took newPayload 42.9 → 32.4 ms (−25%) and final state-root time to **1–2 ms per
block**. Cheapest item here, zero semantic risk.

**1.3 — `ledger_db.cache_size`: RE-TEST after the `Rc` fix, see R2.** Note for the record: the value is an **object
count**, not bytes, despite byte units. Repo default is 1,024; we run 2 MiB = 2,097,152 objects. This
lever is spent — my earlier 16 MiB experiment (16.7 M objects) gave no sustained gain for 23 GB RSS.

---

## Stage 2 — Write path (days, bit-identical)

**2.1 — ETL-style sorted write staging.** Buffer dirty nodes across 64–512 blocks, sort by key, insert
in sorted order. Erigon's rationale: *"B-tree databases suffer write amplification with random
inserts… loading them in sorted order via heap"* → *"dramatic (orders of magnitude) write speed
improvements."*

This is acute for us specifically: our node store is **content-addressed**, so every key is a
uniformly random 32-byte hash. Random inserts into a B-tree is exactly the pathology ETL was built to
defeat, and we hit it on every node of every block. Measured penalty for random vs sequential keys is
~19x; two ascending passes recover ~94% of sequential speed.

Content-addressed nodes are order-independent by definition, so reordering writes cannot change
output.

**2.2 — Hint-driven prefetch (the Ira technique). DEMOTED — see R1 below.** Measurement shows we
are not I/O-bound, so this technique's premise does not hold for us. Retained for the record and in
case the profile changes after the `Rc` fix. Record the node-hash access set per block during
pass 1; in later passes a prefetcher sorts hashes for blocks n+1…n+32 and walks SQLite with a forward
cursor. Wall time becomes `max(prefetch, fold)` rather than their sum.

Sharpening that matters: because our store is content-addressed, we **cannot** compute a block's
access set analytically — the key *is* the hash of the content, so finding it requires pointer-chasing.
Contrast NOMT, where page locations are computable from key bits. For a hash-keyed store, recording
the access set from a first pass is not an optimization, it is the only way to obtain it.

---

## Stage 3 — Pipeline the state-independent work

Deserialization is a pure function of block bytes and does not read state. Run it on a worker pool
k blocks ahead; the fold thread does only `apply()`. Precedent: Erigon runs senders-recovery on all
cores while *"the execution stage is single threaded"*; Reth computes state root on background
workers while the EVM executes sequentially.

This is the direct heir to our 64.5% finding — even after the `Rc` fix, deserialization is real work,
embarrassingly parallel, and entirely off the critical dependency chain. **This is where our
remaining CPU parallelism lives. Not in `apply()`.**

Risk to settle in E0.4: deserialization currently touches the global arena behind a mutex with
`block_in_place`+`block_on` per node access. If it cannot be made arena-independent, this stage
collapses.

---

## Stage 4 — The decision that needs an owner

**Two of our four per-block roots are computed, compared, and discarded.** In
`chain-indexer/src/application.rs:490-510`, `ledger_state.root()` and `zswap_merkle_tree_root()` are
validated inline and never persisted — neither is a `blocks` column. Only the two dust roots are
stored.

Erigon and Reth both refuse to compute a state root per block during historical sync. Erigon: *"we
don't check root hashes during this execution, we don't even build a merkle trie here"*, with
commitment as its own stage, *"checking commitments once per batch"*, bisecting on mismatch. Reth's
`MERKLE_STAGE_DEFAULT_REBUILD_THRESHOLD = 100_000`. Paradigm puts state root at *">75% of the end to
end time to seal a block."* The measured gap between per-block and batched trie work on Reth's own
engine is ~10x.

**Deferring these two roots to batch boundaries changes no output byte** — they are never persisted.
It changes the *validation model* from "check every block inline" to "check every N blocks, bisect on
mismatch."

Plausibly the single biggest structural win available. It is also a deliberate reduction in
per-block checking, on an artifact intended as release evidence. **That trade is the owner's call,
not mine.**

---

## Explicitly rejected, with reasons

**Block-STM (Aptos).** Its guarantee is real — Lemma 1 proves MVMemory equals the sequential run,
16–18x at 32 threads. But every block size evaluated was **1,000–50,000 transactions**; the paper's
x-axis starts at 10³. We are at **0.66**. Amdahl gives exactly 1.0x, and the paper measures *up to
30% overhead* when the workload is inherently sequential. **We would pay the 30% and collect none of
the 16x.** Real-history numbers corroborate: Saraph & Herlihy measured speculative concurrency
falling from 8.87x (2016) to 1.13x (2017) as traffic concentrated; production deliveries land at
20–50%.

**Solana Sealevel.** Declaring accesses up front is a transaction *format* property. Changing the
format changes consensus bytes, so the history being replayed is no longer the history. Ethereum is
retrofitting it via EIP-7928 — a hard fork. Note what Sealevel's insight actually is, though:
declared access sets. **Stage 2.2 recovers exactly that for free, because replay lets us derive it.**

**Sui.** The owned-object fast path is a *latency* optimization for reaching agreement on ordering.
We replay history that is already ordered and agreed. Nothing to skip. Its object-level parallelism is
intra-block transaction parallelism under another name, and dies on the same 0.66.

**Segmented parallel fold (Substreams).** Works because its store ops are **associative** — a monoid,
so segmented reduction is legal. Our `apply()` is not: block n's new nodes require reading block
n−1's paths, so you cannot start mid-history from nothing. Available only on *re-index*, where a
prior run supplies boundary snapshots. The one item here with genuine bit-identity risk.

**Level-synchronous parallel Merkleization.** Sound (Besu: up to 40% off block processing), but at
0.66 tx/block the per-block dirty set is a few dozen hashes — not enough work to amortize a barrier.
Revisit only if Stage 2.1's batching makes the dirty set large.

**GPU-accelerated MPT.** 19.79x on the isolated operator, but only 1.6–3.4x end-to-end in geth, and
it needs batches of 1,500–320,000 keys. We would need to batch thousands of blocks to warm the GPU.

**Snap sync.** No peer serves our derived state, and importing someone else's would void the evidence.

---

## The question worth asking before any of this

**Is the Merkle root ours to define, or protocol-defined?**

If the indexer must reproduce a *protocol-defined* Midnight state root, we are locked into the trie
and Stages 2 and 4 are the ceiling.

If the content-addressed store is purely our own internal structure serving our own queries, we are
paying for merkleization we may not need — and Sei Giga's replacement of the global state trie with
an incremental, order-independent lattice hash ([arXiv:2505.14914](https://arxiv.org/html/2505.14914))
*deletes* the cost rather than parallelizing it. That would be a larger win than everything above
combined.

---

---

## Experimental results (run 2026-07-26 against the live 4.3.3 indexer)

Three open questions were settled by measurement rather than argument. Two of them reorder the plan.

### R1 — The E0.4 gate is ANSWERED: we are CPU-bound, not I/O-bound

60-second measurement on the running process:

| | |
|---|---|
| CPU | 70% of one core |
| **Physical disk reads** | **27 KB/s** |
| Read syscalls | 3,953/sec |
| Physical writes | 2 MB/s |
| Page cache | 23 GB resident against an 88 GB node store |

**The page cache is already serving essentially every read.** Ira's 5.2–23.6x came from a profile
that was 67.9% I/O; ours has almost no physical read I/O at all.

**Consequence: hint-driven prefetch (was Stage 2.2) is demoted.** It exists to get data off disk
before it is needed. Our data is already in memory. What remains is ~4,000 read *syscalls* per second
plus B-tree traversal — that cost is CPU and syscall overhead, not disk latency, and prefetching
cannot remove it.

**Promoted in its place: Stage 3 (pipelining state-independent work) and anything that reduces the
NUMBER of node lookups**, since each lookup is now a CPU cost rather than an I/O wait.

### R2 — My earlier `cache_size` experiment was confounded and must be re-run

I previously raised `cache_size` from 2 MiB to 16 MiB objects, measured no sustained gain, and
reverted it, concluding the lever was spent.

That conclusion does not survive R1. With 64.5% of CPU inside the quadratic HashMap clone, an
improvement confined to the remaining ~35% would have been close to invisible. And R1 shows the
in-process object cache is exactly what avoids those ~4,000 syscalls/sec.

**`cache_size` must be re-tested after the `Rc` backport, not written off.** Recording the earlier
negative result as unreliable rather than as evidence.

### R3 — The GC disagreement is RESOLVED: our version has no GC

Checked the feature flags at our exact tag rather than at repo HEAD:

```
v4.3.3 (running):  features = [ "layout-v2" ]
HEAD:              features = [ "layout-v2", "gc-v1" ]
```

**Our indexer has no ledger-DB garbage collection.** Every block's ledger state is persisted as a
permanent root and never reclaimed. Corroborated operationally: zero GC-related log lines in 30
minutes of running.

One lane was right for our version; the other had read HEAD. This also explains the disk trajectory
directly — ~1 GB/hour of growth with nothing ever reclaimed, 161 GB at half height.

### R4 — Stage 4's premise is CONFIRMED, and more precisely than stated

Verified at `v4.3.3:chain-indexer/src/application.rs`:

- **line 394** — `ledger_state.root()` is computed, then compared against `block.ledger_state_root`
  and `bail!`s on mismatch.
- **line 404** — `ledger_state.zswap_merkle_tree_root()` is compared against the block's value and
  `bail!`s on mismatch.
- **`ledger_state_root` appears zero times in the SQL migrations.** There is no such column.
- The persisted `zswap_merkle_tree_root` column is populated from `block.zswap_merkle_tree_root`
  (line 403), i.e. the value the *node* supplied, not the value we computed.

So both computed roots are **pure validation**. Deferring them changes no stored byte, exactly as
Erigon does during historical sync. The Stage 4 decision stands as described, now on verified
footing rather than a reported claim.

## What this roadmap does not promise

**Not 20x on 20 cores.** `state(n+1) = apply(state(n), block(n+1))` is a sequential dependency no
scheduler removes. The published replay speedups come from *I/O prefetch and sorted writes around* a
sequential executor, not from parallelizing it.

**The first win is not parallelism at all.** It is deleting a quadratic clone upstream already
deleted, then setting SQLite pragmas that were never set.

**Correctness outranks throughput.** This output is evidence for a UmbraDB 1.0.0 release. A fork that
indexes faster and produces subtly different state does not accelerate the release, it invalidates
it. Validation gates: bit-identical replay against stock, differential against the hosted indexer,
crash consistency, and run-to-run determinism.

---

## Resolved: the GC conflict

Settled by inspection — see R3. Our running v4.3.3 has `features = [ "layout-v2" ]` only, so **no
ledger-DB garbage collection**. HEAD adds `gc-v1`. The lane reporting a 200 ms GC budget had read
HEAD, not our tag. Nothing to tune; the fix is an upgrade, at the cost of migration `008`.

---

## Separately: an incidental correctness finding

`get_root_count` in `indexer-common/src/infra/ledger_db/v1_1.rs` runs
`SELECT count(1) FROM ledger_db_roots WHERE key = $1`, which returns row *existence* (0 or 1), not the
stored `count` column. `storage-core`'s own test asserts `get_root_count(k) == i` for arbitrary `i`,
so the contract is "return the stored refcount." Both the Postgres and SQLite implementations share
the query text. It affects GC root refcounting. Unrelated to performance; worth reporting upstream.
