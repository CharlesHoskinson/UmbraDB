# Roadmap

Tracked in detail per-module as `openspec/changes/sprint-N-<module>/` changes (proposal/design/
tasks/spec, EARS-format requirements, each reviewed by an Opus panel + Fable 5 consolidation and
a Codex GPT-5.6 Sol audit before implementation) — Sprint 1 is archived under
`openspec/changes/archive/`, while the completed and merged Sprint 2 Transaction/Lease, Sprint 3
CheckpointStore, Sprint 4 Watermarks, Sprint 7 TransactionHistory, and Sprint 8 wallet-state
envelope persistence records remain under `openspec/changes/` pending archival. The next work is
the cross-cutting formal, testing, equivalence, and performance program.
[`design/tasks.md`](design/tasks.md) is the
ORIGINAL task breakdown from before this project split into its own repo and is now retired/superseded —
see that file's own supersession note; it is kept only as a historical phase-number map, not a
source of task detail. This page is the public-facing summary, and the target for everything
below is **1.0.0**.

## Milestone 0 — Design (completed baseline)

- [x] Proposal, schema design, and interface contract written and reviewed.
- [x] Interfaces implemented as real, typechecked TypeScript
  (`src/interfaces/`), not just prose.
- [x] Design cross-checked against production precedent from other
  blockchain-Postgres indexers (Sui, Aptos, Solana) and against Midnight's
  own real SDK interfaces and ledger primitives — several real gaps found
  and fixed before implementation started.
- [x] Schema/composition gaps found by that audit fixed and re-reviewed
  (schema isolation, temporal-coherence enforcement, private-state key
  structure, composition notes).

## Milestone 1 — Formal (`Formal/`, in progress)

- [x] Algebraic specification written: TemporalKV as an event-sourced
  monoid action, CheckpointStore as an idempotent join-semilattice with a
  GC reachability-closure invariant, Watermarks as deliberate
  last-write-wins, Transaction/Lease as a trace-based mutual-exclusion
  property — each law marked GUARANTEED (enforced today) or ASPIRATIONAL
  (intended, not yet enforced).
- [x] Lean 4 + mathlib mechanization research reviewed, toolchain pinned, and
  trust/no-placeholder gates integrated into the default build and CI.
- [x] Abstract per-key TemporalKV kernel mechanized: transition preservation,
  replay and addressing laws, extensional T5 validity coverage, executable
  prefix retention, unavailable-history classification, and retention-aware T3.
- [x] Abstract Watermarks W1 mechanized over complete `(kind, key)` addresses:
  overwrite/idempotence, distinct-address commutation and framing, trace
  composition, and final-matching-command lookup with initial fallback.
- [x] M3b CheckpointStore C1: complete (abstract save-side projection only).
  Finite chunk identities form an unconditional join; byte-bearing maps are
  existing-left-biased and commute only under explicit compatibility, with a
  local collision-free-on-bound-values bridge. The runtime position-key fix is
  implemented, while ordered reconstruction remains a future Lean theorem.
- [ ] Extend the mechanized model to Checkpoint C2a/GC, collision handling,
  ordered reconstruction, keyed transactions, lease traces, and concrete
  PostgreSQL/runtime refinement obligations.

### Frozen 1.0.0 Lean cut-line (G20 — `openspec/changes/v1.0.0-api-surface`)

- [x] **The 1.0.0 formal-proof cut-line is frozen as exactly `{T3, T5, W1, C1}`** — the abstract-store
  properties that are mechanized in `Formal/Lean` and covered by the required Lean trust gate
  (`.github/workflows/lean.yml`: it scans the whole `Formal/Lean` tree, rejecting any new
  `sorry`/`admit`/`axiom`/`unsafe`, then builds and independently `leanchecker`s the project). Each of
  the four traces to a Lean declaration under `Formal/Lean/UmbraDBFormal/`:
    - **T3** (temporal-projection / observational equivalence, within retention) and **T5** (temporal
      coherence — interval non-overlap + gap-freedom) — `TemporalKV/Laws.lean`,
      `TemporalKV/Retention/Laws.lean` (M1/M2).
    - **W1** (Watermarks last-write-wins) — `Watermarks/Laws.lean` (M3a).
    - **C1** (CheckpointStore abstract save-side chunk projection — a join-semilattice) —
      `Checkpoint/Projection.lean`, `Checkpoint/ChunkMap.lean` (M3b).
  The Lean trust gate mechanically checks the **entire** `Formal/Lean` tree -- it rejects any
  `sorry`/`admit`/`axiom`/`unsafe` token, then `lake build --wfail`s and independently `leanchecker`s
  every declaration in both libraries -- so it gates more than these four: `TemporalKV/Laws.lean` also
  mechanizes additional T1/T2/T4-flavoured theorems (e.g. `attempt_applied_version`,
  `attempt_conflict_iff_snapshot_mismatch`, `dual_address_agrees`). `{T3, T5, W1, C1}` are the **frozen
  1.0.0 store-property commitments** -- the properties the release depends on and freezes -- while those
  additional in-tree theorems are also gated by CI but are **not** part of the frozen 1.0.0 commitment
  surface. The box is objectively green because every committed property is mechanized and the whole
  tree passes the gate; this does **not** claim `{T3, T5, W1, C1}` is the entire set CI gates.
- [x] **Written deferral of everything outside the cut-line to post-1.0** (decision only, no proof work
  in the api-surface change). The following are explicitly **NOT PROVED** in Lean, are out of the
  1.0.0 cut-line, and remain future Lean milestones (they are the open item immediately above):
    - **C2a — CheckpointStore GC reachability-safety.** Labelled MECHANISM SPECIFIED in
      `Formal/STORAGE_ALGEBRA.md` §C2a; **no** Live/refs/Deleted model exists in Lean. Enforced at
      runtime by the same-transaction reachability scan and tested by P8, not proved.
    - **C2b — eventual collection (grace window).** No liveness/round model; conditional on a GC pass
      actually running.
    - **L1 — lease mutual exclusion.** Labelled MECHANISM SPECIFIED in §L1; **no** Transaction/Lease
      module exists in Lean. Enforced at runtime by the session-scoped advisory lock and tested by
      P10, not proved.
    - **Multi-key / keyed-store lifting** (cross-key framing and the cross-writer coordination that
      T1 leaves OPEN), and **ordered chunk reconstruction** (the `toFinset` projection erases order).
    - **Cross-module composition** — the transaction-envelope law table (§4) and the watermark
      cursor-vs-data ordering contract.
    - **The whole abstract → PostgreSQL / TypeScript refinement.** No theorem relates any Lean
      definition to SQL DDL, a trigger, `clock_timestamp()`, or the adapter; this is a *trusted,
      unmechanized* refinement (the AWS TLA+ stance), bridged empirically by the P1–P10 conformance
      suite.

  This converts the previously-unfalsifiable "tractable properties proved in Lean" checklist item
  into a checkable box. **`0 sorry` certifies depth, never breadth** — the Lean trust gate proves
  that what is stated is proved; it cannot detect a missing or too-weak law. The full gap map is
  `Formal/FORMALIZATION_ROADMAP.md`, the post-1.0.0 workstream that closes C2a/L1 is
  `openspec/changes/v1.1.0-formal-completion/`, and the recorded **Option A** ruling that authorizes
  closing this item on deferral (rather than widening the frozen set) is in that change's
  `proposal.md` and in `docs/releases/v1.0.0.md` §G20.

### Frozen 1.0.0 API surface, SemVer policy, error catalog & contracts (G1-G4 -- `openspec/changes/v1.0.0-api-surface`)

The same `v1.0.0-api-surface` change that froze the Lean cut-line (G20, above) also addresses gate
items **G1-G4**:

- [x] **G1 -- Public API surface.** A single frozen barrel (`src/index.ts` -> `dist/index.js` +
  `dist/index.d.ts`), a strict escape-hatch-free `package.json` `exports` map, a declaration build, and
  a packed-tarball install smoke test that compiles a real TypeScript consumer against the shipped
  `.d.ts`.
- [x] **G2 -- SemVer stability policy + CHANGELOG** (`docs/STABILITY.md`, `CHANGELOG.md`): no
  incompatible change to the exported surface or the error-`code` set in a minor/patch.
- [x] **G3 -- Frozen error catalog with a machine-readable `retryable` field** (`docs/ERROR-CATALOG.md`),
  drift-tested against the exported surface (25 codes; frozen retryable set `{CONNECTION_ERROR,
  TRANSACTION_FAULT, LEASE_TIMEOUT, MIGRATION_LOCK_TIMEOUT}`); the chain-archive classes are excluded.
- [x] **G4 -- The eight written release contracts** (`docs/CONTRACT.md`): durability, forward-only
  migration, cancellation, save-retry, lease limitation, backup/restore, threat-model pointer, and
  format headroom -- each stated true of the code as shipped.

(Task-level check-off in `openspec/changes/v1.0.0-api-surface/tasks.md` is handled at that change's
merge close-out.)

## Milestone 2 — Core implementation (module implementations complete)

Per `design/tasks.md` §§0–8: environment setup, then each module
(TemporalKV, CheckpointStore, Watermarks, Transaction/Lease) implemented
against its interface and design, with a differential state-equivalence
gate before anything is considered done — not just "its own tests pass,"
but verified equivalent to the reference behavior it's replacing.

- [x] TemporalKV (`sprint-1-setup-and-temporal-kv`, archived) — Postgres
  adapter, migrations, and test suite; merged to `main` after a 5-round
  cross-vendor re-audit cycle.
- [x] Transaction/Lease (`sprint-2-transaction-lease`) — `PgTransactionLeaseLayer`
  (`withTransaction`, `acquireLease`/`tryAcquireLease`/`releaseLease`/`withLease`),
  the cross-module transaction-handle registry, and `PgTemporalKV`'s
  `opts.tx` wiring.
- [x] CheckpointStore (`sprint-3-checkpoint-store`) — `PgCheckpointStore`
  (`save`/`load`/`history`/`prune`), content-addressed chunking with global
  cross-wallet dedup, the two-step manifest-prune-then-chunk-reclaim GC
  pass, `manifest_hash` write-time computation and load-time
  re-verification, and REPEATABLE READ-wrapped `load`/`history` reads for
  snapshot consistency against a concurrently-committing `prune`; 133/133
  tests passing (unit + P6-P8 property tests) after a 3-round Opus panel +
  Fable 5 consolidation + 4-round Codex GPT-5.6 Sol audit on the spec, then
  a 2-auditor (spec-compliance + code-quality) review of the implementation.
- [x] Watermarks (`sprint-4-watermarks`) — `PgWatermarks` (`set`/`get`), the
  single `fillfactor = 90` `watermarks` table with no secondary index (a
  hard HOT-eligibility invariant), the top-level-null application-level
  guard, the large-integer-as-decimal-string caller convention, and
  `resolveTransaction`-based `opts.tx` composition (no dedicated lease
  layer needed); 155/155 tests passing project-wide (23 new: 22 unit + P9
  property test) after a research-round-informed draft, 3-round Opus panel
  + Fable 5 consolidation + Codex GPT-5.6 Sol audit on the spec, then a
  2-auditor (spec-compliance + code-quality) review of the implementation
  plus a final whole-sprint differential-review gate. This completes all
  four modules in this milestone's checklist — see the note below on what
  that does and doesn't mean for Milestone 2 as a whole.

**Note:** all four modules above have their own implementation done and
reviewed. Per this milestone's own opening framing ("not just 'its own
tests pass,' but verified equivalent to the reference behavior it's
replacing"), the differential state-equivalence gate was tracked as a
separate cross-cutting item rather than resolved by any single sprint —
**it is now closed, in rescoped form**, by G11 in
`openspec/changes/v1.0.0-recovery-testing` (merged `4e04926`). The oracle is
an in-repo fault-free reference built from UmbraDB's own adapters, not an
imported foreign consumer; see Milestone 3's last item and the Release
Record §G11 for why that rescope was chosen and what it does not claim.

## Milestone 3 — Testing (complete for 1.0.0)

Delivered by `openspec/changes/v1.0.0-recovery-testing` (G9/G10/G11, merged `4e04926`). Every item
below is enforced by id: `test/integration/required-tests.manifest.json` lists 25 required test ids,
and `scripts/conformance-gate.mjs` fails the required CI gate **by id** if any of them did not
execute-and-pass — so a re-introduced `describe.skipIf` turns CI red by name, not by luck.

- [x] The property-based test suite (P1–P10) derived directly from
  `Formal/STORAGE_ALGEBRA.md` §5 — implemented in TypeScript against real
  Postgres (via Testcontainers, `design/design.md` §8), not mocked. All ten
  are live: P1/P10 `save-and-advance.property.test.ts`; P2–P5
  `temporal-kv.property.test.ts`; P6–P8 `checkpoint-store.property.test.ts`;
  P9 `watermarks.property.test.ts`.
- [x] **Full sync test** — `soak.full-sync.invariants-hold`
  (`test/integration/soak/full-sync-soak.integration.test.ts`): a sustained
  concurrent mix (KV puts + checkpoint/watermark cadence + periodic prune +
  a held lease) at a **declared 10^5-chunk envelope**, sampling four
  P1–P10-derived SQL invariants *during* the run, proving a GC pass genuinely
  reclaims backdated chunks, and ending replay-equivalent to a fault-free
  reference. Paired with `soak.load-under-prune.snapshot-isolation-safe`
  for load under a concurrently-committing prune.
- [x] **Retrieval correctness under load** — the `getAt`/`loadAt`
  point-in-time reads are the subject of P2–P5
  (`temporal-kv.property.test.ts`, temporal projection and coherence over
  arbitrary event sequences) and P6–P8
  (`checkpoint-store.property.test.ts`, content-addressed round-trip and
  manifest reconstruction), with the byte-level round-trip asserted in
  `temporal-kv.test.ts` and `wallet-state-envelope.test.ts`.
- [x] **Cold-start survival** — the crash-injection suite kills the process
  *and*, separately, Postgres, mid-operation:
  `crash.process-kill-save.no-partial-checkpoint`,
  `crash.pg-kill-save.typed-connection-error`,
  `crash.pg-kill-save.retry-benign-duplicate`,
  `crash.lease-nonwedge.no-wedge-cold-start`, and the four
  `crash.cursor-durability.*` legs — including
  `synchronous-commit-off` under an **unclean** postmaster kill
  (SIGQUIT/immediate) plus crash recovery, where a lost tail of acked
  commits is acceptable but an inverted durability order is a failure.
- [x] Differential equivalence gate (`design/design.md` §10) — landed
  **rescoped**, per the G11 ruling recorded in `docs/roadmapv1.html` §C: the
  in-repo `differential.fault-schedule.state-equivalent` compares a
  fault-schedule run against a fault-free reference built from UmbraDB's own
  adapters, guarded by `differential.fault-schedule.negative-control-fires`
  (the oracle must be able to fail) and
  `differential.reference.import-clean` (the reference imports no consumer
  code). Importing a foreign consumer as the oracle was **deliberately
  rejected** — it would break the indexer-agnostic boundary this project
  holds. The original cutover-oracle framing is therefore satisfied in
  rescoped form, not literally; see the Release Record §G11.

## Milestone 4 — Performance (`Performance/`)

The last major workstream before 1.0.0. Scope: profiling (where does time
actually go — query-level and storage-module-level), benchmarking
(repeatable, versioned measurements of UmbraDB's actual workloads —
versioned KV throughput/latency, checkpoint save/load/dedup ratio at
realistic scale, GC pass duration as the chunk store grows, lease
contention under concurrent writers), and DB activity logging (structured,
correlatable logs tying an application-level call to the SQL it issued and
how long that took). See `Performance/README.md`; being seeded by a
dedicated research pass before any tooling choice is locked in.

- [ ] Research pass on profiling/benchmarking/logging tooling for a local
  Postgres-backed storage layer, reviewed before adoption. **Post-1.0.0** —
  not a 1.0.0 gate item; G14's rule is that the gate is the baseline
  artifact's existence and structural reproduction, never a number.
- [x] Benchmark suite covering the workloads above, with a baseline
  recorded (G14): the in-repo `bench/` harness drives UmbraDB's own adapters
  against a pinned Testcontainers PG17 and emits the committed
  `bench/baseline.1.0.0-perf-baseline.1.json`. Per the G14 hard rule the GATE
  is the artifact's existence + structural reproduction, not any number; a
  coarse order-of-magnitude smoke guard is wired now (CI `bench-smoke`,
  non-release-gating) and the calibrated CV-aware regression gate is deferred
  post-1.0.0. See `openspec/changes/v1.0.0-perf-baseline` and
  `Performance/CEILINGS.md`.
- [ ] Activity logging wired into all four modules, with a documented way
  to correlate a slow application-level call down to the SQL and query
  plan that caused it. **Post-1.0.0** — deliberately *not* a 1.0.0 gate
  item (observability is not part of the frozen surface; see
  `docs/roadmapv1.html` §05). Tracked with Sprint 9.

**Sprint 9** (`sprint-9-cleanup-perf-connection`) is this milestone's next planned change: retry/
idempotency semantics for transient connection errors, a finality-vs-per-address-cursor
correctness split, a noise-floor-aware benchmark gate, and storage-client hygiene, folding in
Sprint 8's D8-1..D8-4 audit deferrals. Its plan is written and gate-confirmed (Opus
correctness-audit CONFIRM verdict, 2026-07-21); implementation has not started.

## Milestone 5 — Cutover

Per `design/tasks.md` §§9–10: rewire real call sites onto UmbraDB, run a
live round-trip against a real network, then remove the storage engine
UmbraDB replaces from the environment it originated in.

**For 1.0.0 this milestone is scoped to its middle step only.** G12/R5 is
the live round-trip: a funded wallet syncs against **public preprod** with
UmbraDB injected as the tx-history store, then a cold boot resumes from the
durable envelope cursor without a full resync. That is the one gate CI
structurally cannot run, so it is executed manually against the release
candidate and its transcript is pasted into the Release Record.

Rewiring every real call site and *removing* the storage engine UmbraDB
replaces are **not** 1.0.0 gate items — 1.0.0 ships the frozen, importable
library; adopting it everywhere and decommissioning the incumbent are
downstream migrations that follow the tag.

## v1.0.0 program status (2026-07-25)

The 1.0.0 release is driven as a gated, per-item program. The five OpenSpec changes for it are
committed under `openspec/changes/v1.0.0-*` (`api-surface`, `durable-checkpoint-cursor`,
`recovery-testing`, `perf-baseline`, `infosec-signoff`) and governed by
[`docs/v1-implementation-guideline.md`](docs/v1-implementation-guideline.md) (per-gate
verify → red/green/self-verify in an isolated worktree → independent audit including a mandatory
cold cross-vendor lane → merge).

**All 20 gate items G1–G20 are merged to `main`, and all five changes are complete.**

| Change | Gates | Merge |
|---|---|---|
| `durable-checkpoint-cursor` | G5, G6, G7, G8 | `e5fcdaa`, `2cb5d00` |
| `perf-baseline` | G13, G14 | `855fb22` |
| `recovery-testing` | G9, G10, G11 | `4e04926` |
| `api-surface` | G1, G2, G3, G4, G20 | `726f567` |
| `infosec-signoff` | G15, G16, G17, G18, G19 | (this change) |

Per-gate evidence — a CI run, a test id, a doc path, or an auditor verdict for **each** of G1–G20 —
is the Release Record [`docs/releases/v1.0.0.md`](docs/releases/v1.0.0.md) (R1); a gate with no
evidence pointer is not green. The gate-by-gate narrative page is
[`docs/roadmapv1.html`](docs/roadmapv1.html) and the blameless lessons log is
`docs/v1-lessons-learned.md`.

What remains before the tag is the release process itself (guideline §4.2 R1–R12), not gate work:
the Release Record, the manual G12/R5 live-preprod round-trip against the release candidate, an
independent cold release audit (R6), and a recorded Go/No-Go (R9).

**Superseded:** `docs/notes/2026-07-23-resume-checkpoint.md` describes the program at 1-of-20 gates
with the Preprod sync paused at 55%. Both facts are stale — it is kept as a historical record of that
moment and must not be read as current status.

**InfoSec sign-off — G15–G19, merged (`v1.0.0-infosec-signoff`).** The security sign-off
obligations for the tag are delivered as **documentation + CI + dev-environment tooling, with no
`src/` runtime behavior change** (G16 is doc-comment-only). The change also closes **R7**, the
release-publication artifact the guideline assigns here:

- **G15** — root [`SECURITY.md`](SECURITY.md) threat model (single trusted writer; `schema` is
  namespacing, not a tenant boundary; the global chunk pool's cross-wallet dedup side channel; no
  at-rest encryption as a binding precondition; commit policy + vulnerability reporting), linked from
  `README.md`.
- **G16** — the `CheckpointStore` cross-wallet dedup interface-doc caveat in
  `src/interfaces/checkpoint-store.ts` (doc comments only).
- **G17** — the db-sync TLS `Require`/self-signed caveat surfaced in `nix/midnight-env/README.md` and
  the opt-in VerifyFull `--ca` de-stub in `enable-db-sync-tls.sh`, with the **localhost `Require`
  default unchanged**.
- **G18** — the supply-chain CI gate `.github/workflows/supply-chain.yml` (+ `.npmrc`, `.gitleaks.toml`):
  `npm ci` + `ignore-scripts` assertion + blocking runtime `npm audit` + full-history `gitleaks` +
  pinned-digest Trivy scan + `flake.lock` change-control.
- **G19** — the committed Preview wallet-secret remediation (untrack + `.example` + generator),
  **no git-history rewrite** (the valueless key stays in history; the full-history gitleaks gate is
  the go-forward guard). The historical finding is suppressed by **exact fingerprint** in
  `.gitleaksignore`, deliberately **not** by a path allowlist — a path allowlist exempts that path
  forever and would hide a real key committed there later. A custom `umbradb-wallet-seed-hex` rule
  additionally catches `seedHex`, which the stock rules never matched (they trigger on a field name
  containing "SecretKey", so the *seed* — the value the key and address are derived from — was
  undetectable).
- **R7** — `.github/workflows/publish.yml` (tag-triggered, OIDC `id-token: write`, `npm publish
  --provenance`) plus the publish metadata `package.json` lacked: `repository` (**required** for
  provenance) and `license` (undefined despite the Apache-2.0 `LICENSE`).

This change completes the InfoSec **sign-off** (docs + CI) for the 1.0.0 tag. The **P1 code
fast-follows it documents but does NOT implement — keyed/scoped chunk addressing (the cross-wallet
dedup-oracle fix) and the `EnvelopeCipher` at-rest-encryption seam — remain separately tracked for
1.1** and are not part of the tag.

## What blocks 1.0.0 (recorded 2026-07-25)

**All twenty gate items G1–G20 are merged and all five OpenSpec changes are complete.** The release
nevertheless ships as **`0.9.5`**, not `1.0.0`, on one recorded owner decision:

> **1.0.0 requires a full local sync of UmbraDB against Midnight** — archive node → local indexer →
> UmbraDB — demonstrated end to end, not merely a wallet-scoped sync against the hosted indexer.

This is a **deliberate tightening** of the gate, and it is worth recording why, because the program's
own earlier analysis said the opposite. The G12/R5 live-evidence gate was scoped to the **public
cloud** indexer (`indexer.preprod.midnight.network`), and on that basis the local sync was ruled *not*
to gate the tag. That ruling stands on its own terms — R5 is satisfied, and the evidence is real
(`docs/recovery/EVIDENCE.md`, run against the RC). The owner has nonetheless judged that a `1.0.0`
carrying UmbraDB's durability claims should be demonstrated against a **locally synced chain**, where
UmbraDB ingests from infrastructure we run rather than one we call. Under `docs/v1-implementation-
guideline.md` §0.2 an owner MAY add conditions and MUST NOT weaken them; this adds one.

### Why the local sync has not happened yet — and what was actually wrong

It was not slow, it was **broken**, and it had been for days. The archive node
(`midnight-node-archive`) was wedged at block **#1,078,791**, reporting `0 peers`. The peer count was
a symptom, not the fault. Every import of the next block panicked:

```
root should be in the arena (ledger_8):
BackendLoader::get(): key f8d4e689…783edbdb not in storage arena.
Are you sure you persisted this key or one of its ancestors?
```

That is **ParityDB storage-arena corruption**: a block header persisted whose ledger state did not.
The panic killed tokio workers on every attempt, which took networking down with it — hence `0 peers`.
No amount of restarting would have fixed it; the corruption was on disk.

**Root cause:** `.wslconfig` declared `autoMemoryReclaim` and `sparseVhd` under `[wsl2]`, where WSL
rejects them (they belong in `[experimental]`). Both settings were therefore silently inactive, the VM
ran at ~59 GB of 62 GB used, and the resulting OOM kills terminated the Docker stack mid-write.

**Fixed 2026-07-25:** the `.wslconfig` keys were moved to `[experimental]` (WSL now accepts them; the
`Unknown key` warnings are gone), and the node was recovered with `midnight-node revert`, which rolled
back to the last finalized block so the corrupt state is rebuilt on re-import. The node resumed at
**~11 blk/s with zero arena errors**, and the local sync is progressing for the first time in days.

### The remaining path to 1.0.0

1. Archive node reaches Preprod tip.
2. The local indexer catches up to the archive node — it is the slower of the two and is the real
   long pole.
3. UmbraDB ingests from **that** local stack, end to end, with the evidence recorded alongside
   `docs/recovery/EVIDENCE.md`.
4. Then, and only then, `1.0.0` — re-running the tag gate (R1–R12) against the new RC.

Nothing else is outstanding. `0.9.5` ships the identical code today.

## 1.0.0 acceptance checklist

A 1.0.0 tag requires all of:

- [x] Formal spec's tractable properties proved in Lean, not just stated — the 1.0.0 Lean cut-line is
  frozen as exactly `{T3, T5, W1, C1}` (mechanized in `Formal/Lean` and covered by the required Lean
  trust gate), with a written deferral to post-1.0 of **C2a/GC, C2b, L1 (lease traces), multi-key
  lifting, ordered reconstruction, cross-module composition, and the whole SQL/runtime refinement**.
  See *Milestone 1 → Frozen 1.0.0 Lean cut-line* above (G20,
  `openspec/changes/v1.0.0-api-surface`), the recorded **Option A** ruling, and the post-1.0.0
  workstream `openspec/changes/v1.1.0-formal-completion`.
- [x] P1–P10 property tests green against real Postgres — all ten implemented against
  Testcontainers Postgres (not mocked) and enforced by id through the required conformance gate;
  see *Milestone 3* above for the file-by-file mapping.
- [x] Full sync test, retrieval-correctness tests, and cold-start-survival
  tests all green — `soak.full-sync.invariants-hold` at the declared 10^5 envelope,
  the P2–P8 point-in-time/round-trip reads, and the crash-injection suite (process kill **and**
  unclean Postgres kill, both `synchronous_commit` legs). All are required manifest ids, so the
  gate fails by name if any self-skips.
- [x] Differential state-equivalence gate green (Milestone 2/3) — **landed rescoped**:
  an in-repo fault-schedule-vs-fault-free comparison over UmbraDB's own adapters, with a
  negative control proving the oracle can fail and an import-cleanliness test proving the
  reference pulls in no consumer code. Importing a foreign consumer as the oracle was
  deliberately rejected as a violation of the indexer-agnostic boundary. Recorded as a rescope,
  not as the literal original framing — Release Record §G11.
- [x] Performance benchmark baseline recorded (G14): committed as
  `bench/baseline.1.0.0-perf-baseline.1.json` after the G13 perf-correctness
  fixes landed (HP-1 batched save, HP-2 grouped history over the IS-2
  `size_bytes` column, IS-1 `kv_current` fillfactor). No perf NUMBER gates the
  tag; scalability ceilings SC-1..SC-6 are documented in
  `Performance/CEILINGS.md`, and the GC anti-join curve + K/D cliff
  adjudication live in the baseline artifact. The CV-aware regression gate is
  the first post-1.0.0 obligation.
- [x] Live round-trip against a real network (Milestone 5) succeeds — G12/R5, run **against the
  release candidate** `8a684fc` on a clean tree at version 1.0.0: a funded wallet synced against
  public Preprod with UmbraDB injected as the tx-history store, the envelope was persisted, the
  process was killed, and a fresh object graph rebuilt from Postgres resumed from the durable
  cursor (`appliedId = 508261n`) with no full resync and no drift. All five M5 sub-criteria PASS.
  Evidence: [`docs/recovery/EVIDENCE.md`](docs/recovery/EVIDENCE.md).

## Beyond 1.0.0 — additional tracks in progress

These sit outside the 1.0.0 checklist above — they extend scope rather than complete it. Listed here
for visibility; each has its own branch and review history.

**Merge status (corrected 2026-07-25 — the previous blanket "not yet merged into `main`" was stale
for two of these).** Full-chain archival storage and the Nix dev-environment flake **are** merged to
`main`; the verifiable-snapshot and BitTorrent tracks are **not** (13 and 2 unmerged commits
respectively), and per tag precondition R4 they MUST NOT be merged before the 1.0.0 tag.

Chain-archive code being *on `main`* does not put it *on the 1.0.0 surface*, and the distinction is
enforced mechanically rather than by reviewer memory: the built barrel exports **36 symbols, none of
them chain-archive**; the six chain-archive error classes are `@experimental` and excluded from both
the barrel and `docs/ERROR-CATALOG.md`; the error-catalog drift test asserts the published table
equals the exported classes' `code` set with no hard-coded count; and the chain-archive suites report
**SKIPPED, never PASS**, outside a preprod environment. `translatePostgresError`'s internal `23514`
constraint-name routing is deliberately left intact — routing preserved, surface not frozen. The
track ships as the 1.1 headline.

- **Full-chain archival storage** (`design/full-chain-storage-design.md` on
  `feature/full-chain-storage-implementation`, branched from `main` after Sprint 8). A
  content-addressed, indexer-independent archive for raw block/tx/blob payloads — a new
  `chain_archive` schema and migration lineage (`blocks`, `transactions`, `bridge_observations`,
  `chain_blobs`/`chain_blob_roles`, `verifier_key_observations`, height-range partitioning with a
  documented rollover procedure) plus a `chain-archive-sync` ingestion service (node-RPC and
  indexer-GraphQL sources, transaction replay decoding against the real ledger WASM package). The
  design went through four audited revisions (v1–v4) before implementation; the implementation
  itself has been through a 3-reviewer sprint-fix round and a Codex GPT-5.6 Sol audit-fix round
  (most recently closing findings 1–7, with the full test suite passing locally and two
  preprod-gated suites self-skipping outside that environment). **Merged to `main`** (`4d9da43`,
  after 7 audit rounds / 346 tests) but deliberately **excluded from the frozen 1.0.0 surface** —
  it is a scope extension, and freezing it would enlarge what SemVer must then protect. Its
  remaining branch work must stay unmerged until after the tag (R4).
- **Verifiable wallet-state snapshot root-of-trust** (`design/verifiable-snapshot-design.md`, on
  `fix/verifiable-snapshot-v2`, previously `feature/verifiable-snapshot`). A design for
  authenticating wallet-state snapshots against on-chain data (liveness/anti-rollback beacons,
  manifest authentication, historical restore). **Design only — no implementation exists yet.**
  At v9 after eight rounds of adversarial design-council review; the document itself says it is
  "ready for a ninth review pass before implementation begins."
- **BitTorrent-based alternative retrieval / bootstrap trust**
  (`design/network-torrent-bootstrap-design.md`, on `feature/network-torrent`). A design for an
  `rqbit`-based BitTorrent retrieval path plus a PKI-rooted bootstrap-trust scheme, meant to
  compose with full-chain archival storage above rather than define its own blob schema.
  **Design only — no implementation exists yet.** One design-council review round complete (a v1
  draft sent back unanimously for rework, since revised); not yet re-reviewed.
- **Committee-certification research** (`research/mithril-committee-certification`). A research
  note (explicitly not a design-council-ready proposal) evaluating whether a Mithril-style
  threshold-signature committee certification, using Midnight's own consensus committee, could
  fill the cold-bootstrap trust gap between the two designs above. Informational only; identifies
  a real blocker (Midnight does not currently persist per-epoch committee stake weight) and does
  not recommend adoption.
- **Nix dev-environment flake** (`nix/midnight-env/`) — **merged to `main`** (`0e24ca4`, hardened
  in `a3a3c99` which pins nixpkgs to an exact revision and documents the reproducibility contract).
  See [Getting started](README.md#getting-started) in the README for what it provides.

## Non-goals

- Not a general-purpose ORM or query builder — the interfaces are
  intentionally narrow (five modules, not "do anything with Postgres").
- Not a distributed or multi-node store. UmbraDB is designed for a single
  writer against a single Postgres instance; see
  `Formal/STORAGE_ALGEBRA.md` §6 for why a distributed-trust/Merkle layer
  was considered and deliberately left out for now.
