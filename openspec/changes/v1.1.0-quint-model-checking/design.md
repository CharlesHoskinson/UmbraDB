# Design — v1.1.0: Quint model checking

## 1. Module layout

```
Formal/Quint/
  umbradb_checkpoint.qnt      -- C2a, C2b   (chunk store + GC)
  umbradb_lease.qnt           -- L1         (transaction/lease)
  umbradb_temporal_kv.qnt     -- T1-cross-writer
  umbradb_controls.qnt        -- the deliberately-broken variants (MC-14/18/25/29)
  law-manifest.json           -- property -> STORAGE_ALGEBRA law id, bounds, backend
  bounds.json                 -- the configured N per module (MC-3)
  README.md                   -- how to run locally; what the results do and do not mean
```

Four small modules, not one large one. Each law is checkable in isolation, so a slow C2b run never
blocks C2a feedback, and a counterexample names one module rather than a fused state space.

## 2. Backend routing (the one non-obvious constraint)

| Property | Shape | Backend | Command | Bound |
|---|---|---|---|---|
| C2a | invariant | Apalache | `quint verify --invariants C2aSafe --max-steps N` | steps ≤ N |
| L1 | invariant | Apalache | `quint verify --invariants L1AtMostOneHolder --max-steps N` | steps ≤ N |
| T1-cross-writer | invariant | Apalache | `quint verify --invariants T1Gapless --max-steps N` | steps ≤ N |
| **C2b** | **temporal** | **TLC** | `quint verify --backend tlc --temporal C2bEventual` | any length; finite state space |

Three facts from the Quint docs drive this table, and each changes what we may claim:

1. **`--max-steps` is Apalache-only, default 10.** Apalache compiles the model to SMT constraints for
   a *specific* number of steps, so it is genuinely step-bounded — a violation first reachable at step
   11 is invisible at `--max-steps 10`. The value MUST be set explicitly and recorded, never left
   implicit.
2. **TLC checks executions of any length.** It is explicit-state: it enumerates reachable states and
   keeps a reachability graph, so it is bounded by *state-space size*, not trace length. That is why
   C2b — a liveness property, where the counterexample is an infinite stuttering run — belongs here.
   The cost is that every domain must be finite and small: TLC cannot pick from all integers, so the
   model uses constrained sets.
3. **Both backends require a compatible OpenJDK.** This is a hard CI dependency, not an optional
   extra, and its absence must fail the job rather than skip it (MC-33).

Getting the routing wrong is not a performance question. A liveness property decided by an
experimental code path yields a green result that means nothing — the same failure mode as the
fail-open CI gates the infosec change had to fix twice.

## 3. C2a model sketch

State: `manifests: Hash -> Set[ChunkHash]`, `live: Set[Hash]`, `deleted: Set[ChunkHash]`,
`allChunks: Set[ChunkHash]`.

```
val reachable = live.fold(Set(), (acc, m) => acc.union(manifests.get(m)))
val C2aSafe   = deleted.intersect(reachable) == Set()
```

Actions: `save` (register a manifest, add to `live`), `unlink` (remove from `live` — this is what
makes a chunk become unreachable), and `collectHashes(hs)` — the **unguarded** primitive of MC-11.
The safe action is `collectHashes(allChunks.exclude(reachable))`.

The witness required by MC-12 must reclaim a chunk that was **registered and then unlinked**, so that
`unlink` genuinely shrinks `live`; a chunk that was never referenced is a trivial witness and does not
exercise the invariant.

`save` and `prune` are separate actors chosen non-deterministically per step
(`any { saveStep, pruneStep, unlinkStep }`), which is what buys the interleaving Lean's sequential
fold could not express.

## 4. C2b model sketch

Adds a discrete `clock` and a per-chunk `unreachableSince`. A chunk is collectable when
`clock - unreachableSince > GRACE`. The GC action is enabled only for collectable chunks.

```
temporal C2bEventual: bool =
  always(collectable.forall(c => eventually(deleted.contains(c))))
```

Under **weak fairness** on the GC action: if GC stays continuously enabled, it eventually fires.
MC-18's control removes that fairness and the property must then fail — which is the whole point,
since it proves C2b is *conditional on a GC pass running* exactly as the law says, rather than
vacuously true.

The grace window is modelled as a real delay (MC-19): a chunk that just became unreachable is **not**
collectable, so the model cannot accidentally prove the stronger "deleted iff unreachable" claim the
spec explicitly disowns.

## 5. L1 model sketch

State: `holders: Key -> Set[Token]`, `tokens: Token -> Holder`, `connections: Set[Holder]`.

```
action acquire(h, k) = {
  nondet t = freshTokens.oneOf()
  any {
    // granted, only when nobody holds it
    all { holders.get(k) == Set(), holders' = holders.set(k, Set(t)), ... },
    // refused, when someone does
    all { holders.get(k) != Set(), holders' = holders, ... },
  }
}
```

`refused` is an explicit outcome, not an absence — MC-21. Tokens are unique per acquisition (MC-23),
so two acquires by the same holder cannot silently collapse into one set element. `connectionLost(h)`
releases every token held by `h` (MC-26).

The invariant is `holders.keys().forall(k => holders.get(k).size() <= 1)` (MC-24), and the control
(MC-25) flips the refused branch to succeed, which must produce a counterexample with two distinct
tokens on one key.

## 6. Falsifiability controls

Every property ships a deliberately-broken twin in `umbradb_controls.qnt`. CI runs the controls and
**fails if any control passes** (MC-34). This is the same doctrine the recovery-testing change
adopted after its audit: a gate that cannot be observed failing is not known to be a gate.

| Control | Break | Must violate |
|---|---|---|
| `C2aAllManifests` | reachability over all manifests, not live | C2a |
| `C2bNoFairness` | drop weak fairness on GC | C2b |
| `L1AcquireAlwaysGrants` | acquire on a held key succeeds | L1 |
| `T1DuplicateVersion` | two writers commit the same version | T1 |

## 6b. Witnesses — proving the interesting state is reachable

A falsifiability control proves a property *can* fail. It does not prove the model ever reaches the
interesting situation in the first place — a lease model where contention never occurs would pass L1
trivially and pass its control too.

Quint's simulator has a dedicated mechanism for this: `quint run --witnesses <name>` reports in how
many sampled traces a predicate held. So each property also ships a **witness**:

| Witness | Must be observed in ≥1 trace |
|---|---|
| `w_contended_acquire` | two distinct holders with overlapping acquire attempts on one key |
| `w_chunk_unlinked_then_collected` | a chunk registered, unlinked, then reclaimed |
| `w_concurrent_writers_same_key` | two writers committing to one key in the same run |

Caveat to record: Quint's docs mark built-in witness support as **under design** (🚧). If the flag's
behaviour changes, the fallback is an ordinary invariant asserting the negation and reading the
counterexample — cruder, but stable.

## 7. Bounds

Start at 3 writers / 4 chunks / 3 keys / 2 wallets / 12 steps, recorded in `bounds.json` and cited in
every report (MC-3). Concurrency defects overwhelmingly appear at N=2–3; the bound exists to make the
search finish, and stating it is what keeps the claim honest.

Where Apalache's symbolic search allows a larger bound within the CI budget, raise it and record the
raise. Never raise it silently — a result whose bounds moved is a different result.

## 8. CI

`.github/workflows/model-check.yml`, separate from `conformance.yml` (MC-30). Triggers on PRs
touching `Formal/Quint/**`, `Formal/STORAGE_ALGEBRA.md`, or the manifest (MC-31); plus a weekly
schedule so a checker regression surfaces without a code change.

Quint, Apalache and TLC are installed from **version-pinned releases verified against repo-held
SHA-256 checksums** (MC-32) — the same lesson the supply-chain gate learned when its own scanners
turned out to be fetched from mutable tags, and when a pinned Trivy version turned out to have no
release at all.

Job structure:

1. Install + verify checkers.
2. `quint typecheck` every module — a spec that does not parse is a failure, not a skip (MC-33).
3. `quint verify --invariants ...` for C2a, L1, T1.
4. `quint verify --backend tlc --temporal C2bEventual` for C2b.
5. Run all four controls; **fail if any passes** (MC-34).
6. On any violation, upload the counterexample trace as an artifact (MC-35). Note `--out-itf`
   (Informal Trace Format) is **Apalache-only**, so the C2a/L1/T1 jobs emit ITF while the TLC-backed
   C2b job captures its console counterexample — the artifact exists either way, but the format
   differs and the workflow must not assume ITF for all four.

## 9. What this deliberately does not do

- No attempt to model the PostgreSQL adapter, MVCC, the EXCLUDE constraint, `clock_timestamp()`, or
  advisory locks. The refinement gap is unchanged and stays in the register.
- No replacement of P1–P10. The property tests remain the empirical bridge to the real adapter; Quint
  checks the algebra those tests sample.
- No new release gate. Post-1.0.0, voluntary hardening under guideline §0.2.
