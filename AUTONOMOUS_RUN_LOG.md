# Autonomous run log

Append-only journal of an 8-hour autonomous multi-sprint run started 2026-07-21 ~22:00 MDT while
the owner is AFK. Goal: get the Midnight infra connected to UmbraDB's Postgres storage and verify
it syncs, advancing the sprint roadmap with a full audit gate on every merge.

## Orchestration model (owner-specified)

Per sprint: **plan** (repo openspec/graphify flow) → **Sonnet 5 implements** → **Opus panel audits**
(3 roles: domain-correctness, adversarial, release/test-coverage — AGENTS.md) → **Codex GPT-5.6 Sol
cold audit** (`codex exec`, read-only sandbox, high reasoning, NONE-mode/no-manifest per repo
CLAUDE.md) → **Fable 5 aggregates** findings into blocking/non-blocking → **fix** (Sonnet) →
**verify gate** (`npm test` on rootless Docker, `tsc`, `openspec validate --strict`,
`graphify update`) → **commit on the sprint's feature branch** → **push the feature branch to origin**.

**BRANCH DISCIPLINE (owner directive — rolling merge for good hygiene):** every sprint lives on its own
feature branch, pushed to origin. **Merge sprint N's branch to `main` once BOTH hold:** (a) N is
FINISHED — implemented, full audit chain cleared with no open blocker, and verify gate fully green; AND
(b) N+1 is PLANNED — its design/spec authored and confirmed by the correctness-audit gate. The
"N+1 planned" precondition is deliberate: authoring N+1's design can still surface something that should
change N, so N stays on its branch until N+1's design is settled, then merges. After merging N, branch
N+1 off the freshly-updated `main`. `main` advances one finished-and-superseded-by-a-plan sprint at a
time — never stack the whole run unmerged, never merge a sprint whose successor isn't yet designed.
Merge via a real merge commit (no fast-forward-only rewrite), no force-push, no history rewrite, no
branch deletion. A red gate or an open blocking finding ⇒ no merge, full stop.

Codex Sol invocation (verified working): default model `gpt-5.6-sol`,
`codex exec -c model_reasoning_effort=high --output-schema <schema> -o <out> "<cold audit prompt>"`.

Every phase appends an entry below.

### Sprint-AUTHORING pipeline (owner directive — applies to Sprint 8 onward; Sprint 7's spec already exists)

Before any implementation on a NEW sprint, run this design-time pipeline to prevent design mistakes:

1. **Deep research stage** — fan out parallel research agents + scrapling to gather context: sweep the
   official Midnight docs (docs.midnight.network), the real SDK/node/indexer/ledger source in `~/repos`,
   external best-practice sources (postgres patterns, wallet-sync/checkpoint/recovery prior art), and any
   relevant standards. Each agent reads real sources (not memory) and returns a cited brief. Synthesize
   into one research brief for the sprint. Verify every external claim against the actually-installed
   version or real upstream source (repo's own correctness rule).
2. **Design council** — several design agents propose and critique the design from DISTINCT angles
   (e.g. correctness/algebra, API-shape/interface fidelity to the real SDK, failure-modes/ops,
   testing-strategy). Include a **correctness-audit spec agent** that checks the proposed design against
   the requirements + research brief for soundness, gaps, and vacuous claims, and returns an explicit
   confirm/BLOCK verdict. Iterate until the correctness auditor confirms. Fable 5 consolidates the
   council into the openspec design.
3. **Spec + test strategy** — write the openspec change (`proposal/design/tasks/spec`, EARS format) AND
   an explicit **post-implementation testing strategy** section: unit coverage, property tests (with the
   oracle/reference), integration/live tests (what's exercised against real preprod), failure/recovery
   tests (cold-boot), regression guards, and which EARS requirement each test maps to. `openspec validate
   --strict` must pass; `graphify update` after.
4. Only THEN the implement → Opus panel → Codex Sol → Fable aggregate → fix → verify-gate back-half runs.

The correctness-audit spec is a hard gate: no implementation starts on a design the correctness auditor
has not confirmed.

## Timeline

### Setup (pre-run)
- Env fully stood up: from-source Midnight build (node 2.1.0 / indexer-standalone / proof-server
  8.1.0), wallet SDK via public npm, Compact 0.5.1/compactc 0.31.1, rootless Docker.
- Preprod verified live; wallet funded (1000 tNIGHT confirmed on-chain).
- Codex GPT-5.6 Sol authenticated in WSL (npm codex 0.145.0). Opus/Sonnet/Fable via Agent tool.
- Committed env docs (e1253ce).

## Sprint backlog (repo audit — nothing drafted is missing; broader backlog enumerated)

Reconciled from openspec/changes/, ROADMAP.md milestones, design/tasks.md's phase map, the
sprint-5 recommendation, and Formal/LEAN_FORMALIZATION_PLAN.md. Status verified against `main`.

**Done + merged:** sprint-1 TemporalKV, sprint-2 Transaction/Lease, sprint-3 CheckpointStore,
sprint-4 Watermarks (Milestone 2 core modules, all 4). sprint-5-formal Watermarks W1, sprint-6-formal
Checkpoint C1 (Lean track). Retired design/tasks.md §6/§7 (`PgPrivateStateProvider`/`PgWalletStateStore`)
are SUPERSEDED by the sprint-5 recommendation — those SDK interfaces don't exist; the real surface is
transaction-history-storage + a WalletState envelope.

**Execution sequence for this run (implementation track):**
- **Sprint 7 (IN PROGRESS): transaction-history-storage** — `PgTransactionHistoryStorage` (row-lock
  atomic merge) + migration + Pg-only conformance gate. Self-contained (no wallet-SDK runtime dep).
- **Sprint 8: WalletState envelope + live preprod DB-sync verification** — recommendation module 2
  (envelope over CheckpointStore) PLUS the live-sync tier: drive our funded preprod wallet through the
  SDK, persist tx-history into UmbraDB Postgres, and verify the on-chain 1000 tNIGHT tx materializes as
  a DB row. THIS is the "verify the DB syncs" end-to-end proof. Needs the wallet SDK (built) + our
  node/indexer/proof-server (built) or public preprod.
- **Sprint 9: Milestone 3 resilience** — cold-start survival (kill process / kill Postgres mid-op,
  verify clean recovery) + retrieval-correctness-under-load, against real Postgres.
- **Sprint 10: Milestone 3 equivalence** — the P1–P10 replay/differential-equivalence gate as a
  cohesive suite + a realistic full-sync test.

**Parallel/lower-priority tracks (not blocking the DB-sync goal):**
- Lean formal continuation (Milestone 1 remainder): M3c Checkpoint C2a/GC, ordered reconstruction,
  keyed transactions, lease traces (placeholder branch `formal/storage-algebra-lean-m3c-checkpoint-c2a`
  is empty). Separate AGENTS.md audit flow; interleave if time permits.
- Milestone 4 performance: profiling/benchmark/logging (research-gated).
- Milestone 5 cutover: midnight-dev-env-side, NOT this repo.

## Audit-check guardrails ("don't get this wrong" — owner directive)

Hard rules enforced on every sprint before its feature branch is pushed to origin (and NOTHING
reaches `main` until whole-stack validation):

1. **Verify gate must be fully green** — `npm test` ALL green (incl. the 4 env tests once fixed, and
   the 151 baseline as a regression guard), `tsc --noEmit` clean, `openspec validate --all --strict`
   clean, `graphify update .` clean. Red gate ⇒ no push, no "done" claim.
2. **Every EARS requirement maps to a passing test** — the Fable 5 aggregator explicitly cross-checks
   each requirement in `specs/*/spec.md` against a test that exercises it. A requirement with no test
   is a BLOCKING finding.
3. **Audit chain clears** — 3-role Opus panel (domain-correctness, adversarial, release/test-coverage)
   + Codex gpt-5.6-sol cold audit (read-only, NONE-mode/no-manifest, independent) → Fable 5 aggregates.
   Any unresolved **blocking** finding ⇒ Sonnet fix + targeted re-audit. No merge with an open blocker.
4. **Auditors are read-only and independent** — Codex runs cold (no manifest) per repo CLAUDE.md's
   NONE-mode rule; the Opus panel roles do not share findings before reporting.
5. **Evidence before assertions** — every "passing/done" claim in this log is backed by actual command
   output, not narration. Failures are reported with their output.
6. **No shortcut merges** — no force-push, no `--no-verify`, no skipping the gate to "save time."

## Env test-failure fix (owner: "fix the env failures as well") — diagnosed, fix planned

Root cause of the 4 pre-existing failures (pre-date Sprint 7; on `main`):
- **3 timeouts** (`migrate` / `transaction-lease` / `watermarks` dead-endpoint tests): connecting to
  `127.0.0.1:1` under WSL2's network stack HANGS (no fast ECONNREFUSED) until postgres.js's default
  30s `connect_timeout` fires — measured 30009ms `CONNECT_TIMEOUT` — but the tests' timeout is 5s.
  `createClient`'s `UmbraDBConnectionOptions` exposes no connect-timeout knob. **Fix:** add a bounded
  `connectTimeout` option to `createClient` (a real fail-fast-on-unreachable-DB improvement; default
  ~10s) and set it short (~2s) in the 3 dead-endpoint tests so the ConnectionError/LeaseFaultError
  translation they assert surfaces within the test window. Not test-gaming — the tests assert error
  *translation*, not duration.
- **1 assertion** (`temporal-kv` server-side-cancel, test line ~387): asserts that after aborting a
  blocked SELECT, `pg_stat_activity` shows 0 queries waiting on the lock (i.e. `query.cancel()` reached
  the server). Uses a fixed 50ms sleep before checking; this env's cancel round-trip is slower.
  **Fix:** replace the fixed sleep with a bounded poll (retry until `n==0` or ~2s elapsed) — preserves
  the assertion, tolerates env latency.
- Applied AFTER the Sprint 7 implementer finishes (same working tree — avoid concurrent-edit/test
  contention). Tracked as a prerequisite for Sprint 7's fully-green verify gate.

## Live-sync milestone — feasibility + timing (owner asks)

**Feasible, confirmed.** The wallet SDK runs on TS source via vitest (its own `*.integration.test.ts`
do). Sync path: testkit `initWalletWithSeed` + `PreprodTestEnvironment` (public preprod indexer/node
URLs) + our LOCAL proof-server (built, running on :6300). No extra "make the SDK runnable" blocker —
vitest is the vehicle. The facade injects `TransactionHistoryStorage`, so UmbraDB's Pg store slots in.

**When: Sprint 8** (after Sprint 7's `PgTransactionHistoryStorage` lands as the DB write target).
Sprint 8 deliverables:
1. An adapter mapping the REAL SDK `TransactionHistoryStorage` (Effect-Schema entries: hash,
   identifiers, optional protocolVersion/status/timestamp:Date/fees:bigint, lifecycle union) ↔
   UmbraDB's `PgTransactionHistoryStorage`.
2. A vitest integration test: sync our funded preprod wallet (seed at `~/.midnight-preprod-wallet.seed`)
   with the **birthday hack** (birthday ≈ current tip so it skips ~1.76M blocks), injecting the
   Pg-backed storage; assert the on-chain 1000 tNIGHT tx materializes as a UmbraDB DB row. **This is the
   "verify the DB syncs" proof.**
3. The **WalletState envelope** over `CheckpointStore` (recommendation module 2).
4. **COLD-BOOT RECOVERY TEST (owner-requested milestone):** sync → serialize each sub-wallet state →
   wrap in the envelope → `CheckpointStore.save` into Postgres → destroy the wallet + process → fresh
   process → `CheckpointStore.load` the envelope → restore each sub-wallet → `PgTransactionHistoryStorage
   .getAll()` for tx-history → assert the wallet resumes at the right block WITHOUT full resync and its
   tx-history matches the pre-crash DB state. Template exists:
   `midnight-wallet/.../serializationAndRestoration.integration.test.ts`.

Timing estimate for this 8-hour run: Sprint 7 (implement + full audit + fix + green gate) first;
Sprint 8 (adapter + live preprod sync + cold-boot recovery) is the live-sync milestone — targeted
within the run, contingent on Sprint 7 clearing cleanly. Honestly reported: if Sprint 7's audit surfaces
real blockers, Sprint 8 may start late — the log will show exactly where it got to.

## Architecture confirmation — the SDK is memory-only; UmbraDB is the persistence layer (owner-confirmed, doc-verified)

Verified against BOTH the real SDK source and the official docs:
- **SDK source:** the ONLY `TransactionHistoryStorage` implementation shipped is
  `InMemoryTransactionHistoryStorage` — its own doc comment: *"In-memory implementation…"*, backed by a
  `Map<TransactionHash, T>`, with atomicity that relies on *"the single-threaded nature of JavaScript…
  no external semaphore is needed."* A grep for any Postgres/SQLite/Disk/File/Mongo/Persistent
  `TransactionHistoryStorage` across all SDK packages returns **nothing**. Every wallet construction
  (testkit `wallet.ts`, `environment.ts`) uses `new InMemoryTransactionHistoryStorage(...)`.
- **Docs (`sdks/official/wallet-developer-guide`):** the documented config for BOTH the hosted **Preprod
  testnet** AND the local network sets `txHistoryStorage: new InMemoryTransactionHistoryStorage()`. So
  even against real Preprod, the shipped storage is in-memory.
- **Implication:** `txHistoryStorage` is a pluggable configuration slot; the SDK's only backend is
  volatile (process restart loses all tx-history). The SDK's `serialize()`/`restore()` is a whole-blob
  snapshot mechanism, NOT a live persistent/queryable store. **This is exactly why UmbraDB exists:**
  `PgTransactionHistoryStorage` (Sprint 7) implements the same interface with a persistent, queryable,
  concurrency-safe Postgres backend and slots into `txHistoryStorage` to replace the in-memory default.
  It also validates the **cold-boot recovery** milestone (Sprint 8): the memory-only SDK cannot recover
  state after a restart — UmbraDB's Postgres store + the CheckpointStore WalletState envelope is what
  makes recovery-from-DB possible at all.

## Workstream: snapshot root-of-trust (owner-raised — likely SDK + indexer PRs; enables remote DB)

**The problem, framed:** the SDK's in-memory state is "correct by construction" because it is
REPLAY-derived (scanned from the indexer stream). A persisted UmbraDB snapshot breaks that guarantee —
restoring from it SKIPS the replay, so the restored in-memory state has no intrinsic proof it is
correct. We need a **root of trust**: a cryptographic anchor that lets a restored snapshot verify
"this is the correct wallet state as of block N" against on-chain commitments WITHOUT a full rescan.
This is doubly required for a **remote/untrusted DB** (hosted or shared across devices) — the killer
feature: trustless restore from a DB the wallet does not have to trust (plus client-side encryption for
shielded-state privacy, and anti-rollback/freshness so a stale-but-valid snapshot can't be replayed).

**Grounding (already-existing anchors):** Midnight exposes a block-header `stateRoot`, a zswap
commitment Merkle tree (`zswapMerkleTreeCollapsedUpdate`), and dust commitment/generation trees
(`dustCommitmentMerkleTreeUpdate`, `dustGenerationMerkleTreeUpdate`). A verifiable snapshot most likely
anchors to these (membership proofs for the wallet's notes vs. the committed tree at block N), possibly
with a bounded incremental replay from the snapshot block to tip rather than from genesis.

**Deep-research fan-out (running, per the sprint-authoring pipeline):** four parallel agents, each
scrapling + real source, writing cited briefs to `design/research/2026-07-21-snapshot-root-of-trust/`:
01 Midnight state commitments (what anchors exist + gaps), 02 prior-art checkpoint sync (ETH weak-subj,
Cosmos state-sync, Bitcoin assumeutxo, Mina, Zcash birthday, light-client proofs), 03 authenticated
snapshot integrity (no-replay verification, remote/untrusted + rollback + privacy), 04 SDK+indexer
integration surface (concrete PR sketches for both repos).

Plus a **Fable brainstorm** (angle 05, `05-compact-attestation-brainstorm.md`): the owner's clever idea
— use a **Compact ZK contract** to have the live, correct-by-construction in-memory wallet ATTEST
`hash(snapshot)` on-chain (proving the caller knows the wallet key, binding the hash to the wallet
identity + block N in zero-knowledge). Restore verifies the snapshot hash against the on-chain
attestation instead of replaying; a remote/untrusted DB can't forge a snapshot because it can't produce
the matching attestation. Fable is grounding the design in what Compact can actually express before
proposing variants (on-chain hash attestation, Merkle-committed state w/ membership proofs vs the
existing zswap/dust trees, and the harder proof-of-correct-scan), with trust model + cost + feasibility
for each.

**Next:** design council (distinct-angle design agents + a correctness-audit spec gate) synthesizes the
briefs into a recommended root-of-trust design + the SDK PR and indexer PR proposals. This is its own
feature workstream (a "verifiable snapshot" capability) feeding external PRs — sequenced after the
Sprint 7/8 DB-sync core, but researched now so the design is ready.

## MILESTONE: live preprod wallet sync PROVEN (de-risk agent, SUCCESS)

The wallet SDK **synced our funded wallet against public preprod and observed the full 1000 tNIGHT** —
reproducibly, in ~1.3s. Evidence: balance `{0x00…00: 1000000000n}` (native token, 1000 tNIGHT), the
available UTXO, and a tx-history entry with hash `b194e71d…493341` + identifier `00ea17cf…20bea`
(matches the faucet tx), finalized at block 1,763,274. This de-risks the Sprint 8 live-sync milestone at
the SDK level — remaining Sprint 8 work is wiring `PgTransactionHistoryStorage` in as `txHistoryStorage`
(replacing `InMemoryTransactionHistoryStorage`) + the cold-boot recovery test.

**Reusable Sprint 8 wiring (validated):** only the `UnshieldedWallet` package is needed for the funded
unshielded balance — no facade/shielded/dust wallet, no proof-server, no node RPC; sync is driven
entirely by the indexer WS (`wss://indexer.preprod.midnight.network/api/v4/graphql/ws`). Config:
`networkId: NetworkId.NetworkId.PreProd`, `indexerClientConnection` (http+ws URLs), `txHistoryStorage`.
Key derivation: `HDWallet.fromSeed → selectAccount(0) → selectRole(Roles.NightExternal) → deriveKeyAt(0)`
→ `createKeystore` → `UnshieldedWallet(config).startWithPublicKey(...)`. Sync-completion: wait for
`availableCoins.length > 0` BEFORE `waitForSyncedState()` (a fresh wallet can report strictly-complete
before the coin-bearing tx applies). Reusable test written at
`~/repos/midnight-wallet/packages/wallet-integration-tests/test/preprodUnshieldedSync.manual.integration.test.ts`.

**CORRECTION — no block-height "birthday" for the unshielded wallet.** My earlier "birthday hack"
framing was wrong for this wallet type. The unshielded sync subscribes to `UnshieldedTransactions.run(
{address, transactionId})` — a per-address, transaction-id cursor, NOT a block scan — so the indexer
resolves directly to the handful of txs touching our address with NO genesis-rescan cost regardless of
chain tip. That's why it synced in ~1.3s; no birthday config field exists for it. (A viewing-key/
merkle-scan "birthday-like" concern may still apply to the SHIELDED/DUST wallets, which weren't
exercised since the funded balance is unshielded.) `design/environment/preprod-connection.md`'s birthday
section is corrected accordingly.

**Env note:** the wallet SDK packages were built (`tsc -b` leaf-first; `dist/` is gitignored,
non-destructive) so bare cross-package imports resolve — a prerequisite for running the SDK, recorded in
the env log.

### Sprint 7 — transaction-history-storage
- Sonnet 5 implementer dispatched (self-contained scope: interface + migration + PgTransactionHistoryStorage
  + unit/property tests + in-repo InMemory oracle + Pg-only conformance). Baseline before: 151 pass / 4
  pre-existing env failures (to be fixed post-implement, above).
- Sent implementer a reconciliation with the REAL SDK interface (Effect-Schema entry shape; lifecycle is
  a discriminated union w/ `status` discriminator, not a bare enum; reader/writer split; write methods
  take entry-minus-lifecycle; fees:bigint + timestamp:Date are the round-trip-critical fields; subset-clear
  confirmed) so its in-repo mirror matches and Sprint 8's adapter wires up cleanly.
- **IMPLEMENTED** (Sonnet 5, commit 23e13f3): interface + migration 004 + PgTransactionHistoryStorage
  (row-lock atomic merge w/ pg_advisory_xact_lock covering the phantom-row race — a real gap the
  implementer caught in design.md's pseudocode) + 27 unit + 2 property tests. Typecheck clean.
- **ENV FIX** (commit 71ef9bf): bounded `connectTimeout` (default 10s) in createClient + `connectTimeout:2`
  in the 3 dead-endpoint tests + bounded poll in temporal-kv server-side-cancel. Full suite now
  **184/184 GREEN** (was 180-181/184 with env-flaky failures). Root cause: WSL2 hangs on dead ports →
  postgres.js 30s connect_timeout vs 5s test timeout.
- **AUDIT GATE (running):** 3 Opus auditors (domain-correctness, adversarial, release/coverage) + Codex
  gpt-5.6-sol cold audit.
- **Codex gpt-5.6-sol verdict: BLOCK** (2 blocking, 3 non-blocking; typecheck + `git diff --check` passed;
  it audited statically — read-only sandbox blocked Vitest temp dirs, but the suite is already green here):
  - [HIGH, blocking] `transaction-history-storage.ts` — **sentinel-collision**: `decodeContent` treats
    ANY object shaped `{__umbradb_ths_bigint: ...}` / `{__umbradb_ths_date: ...}` as an encoded primitive,
    so caller data legitimately containing that shape (at any nesting depth) is silently corrupted on read
    (`{metadata:{__umbradb_ths_bigint:"123"}}` → `{metadata:123n}`); malformed tag values can make reads
    throw. Also affects serialize(). REAL bug the tests missed.
  - [MEDIUM, blocking] `transaction-history-storage.ts` interface — `z.record(z.string(),...)` accepts
    PG-unsafe object keys (NUL byte / lone UTF-16 surrogate), which pass the Zod boundary then fail at
    JSONB instead of round-tripping; should mirror temporal-kv's recursive key-safety check.
  - [LOW] advisory-lock key `hashtext(walletId||':'||hash)` has delimiter ambiguity + 32-bit collision →
    over-serializes unrelated rows (correctness-safe, perf only).
  - [LOW] no DIRECT test for either empty-set vacuous-subset guard (removing a guard would pass the suite).
  - [LOW] concurrent-first-write property test doesn't force the critical interleaving (could pass without
    the lock if the scheduler serializes).
- **Opus panel verdicts:** domain-correctness → PASS (all 9 EARS reqs implemented+tested; empirically
  confirmed GIN `<@` acceleration + the phantom-row advisory-lock design; rated the sentinel issue a nit).
  release/coverage → PASS (deterministic 184/184 ×2 runs; TypeDoc + openspec-validate clean; env-fix
  verified sound). adversarial → **BLOCK**, reproduced F1 end-to-end.
- **AGGREGATION → BLOCK** (orchestrator, verdict unambiguous: 2 independent BLOCKs on the same defect):
  - **F1 (CRITICAL, blocking):** JSONB reserved-tag collision. A schema-VALID write of opaque section
    content containing a single-key `{__umbradb_ths_bigint: ...}`/`{__umbradb_ths_date: ...}` object is
    either silently mis-decoded (plain object → bigint/Date) or, with a non-numeric value, throws a raw
    untranslated `SyntaxError` inside `getAll`/`serialize`/merge that **permanently bricks the wallet's
    history reads**. Found independently by Codex (high) + adversarial Opus (critical, reproduced). Domain
    Opus's "nit" overruled — it didn't run the adversarial repro. Slipped because the property oracle only
    generated integer section values (adversarial F3).
  - **PG-unsafe keys (MEDIUM, blocking, Codex):** NUL/lone-surrogate object keys pass the Zod boundary
    then fail at JSONB instead of round-tripping; must reject at the boundary (mirror temporal-kv).
  - Non-blocking (fix same pass): connectTimeout 10s default is an arbitrary prod behavior change (revert
    default, keep option); broaden the property generator (F3); stale test comment (F4); direct
    vacuous-subset tests; runtime non-empty `walletId` guard (F6). Verified SOUND (not fixing): the
    concurrency invariant / advisory-lock keying / class-4 non-collision, SQL injection, opts.tx/signal,
    subset-clear empty-guards, NaN/Infinity rejection.
  - **Fix dispatched** (Sonnet a3093def) with the full consolidated scope; re-verify green + targeted
    re-audit before Sprint 7 is declared finished.

## Root-of-trust design — KEY PRINCIPLE: proof freezes a finalized-checkpoint horizon (owner refinement)

The ZK/attestation proof's purpose is to certify the persisted snapshot is correct **for its declared
time horizon** — "snapshot S is the correct, complete wallet state as of FINALIZED block N" — NOT as of
the tip. Because the chain is append-only and finality means no rollback of blocks ≤ N, a proof anchored
to a finalized N is **permanently valid** for horizon N (the past can't change). On restore: verify the
proof, then catch up [N, tip] LIVE via sync + the ADS (brief 06) — the proof eliminates RE-REPLAY of
[birthday, N], not the live tail. Each proven finalized checkpoint is a **cryptographically-certified
"birthday"** — a floor below which the wallet never rescans again (strictly stronger than Zcash's
*trusted* birthday). Anchor N to a finalized block (Substrate GRANDPA; `chain_getFinalizedHead`), bind
to R_N, and make "finality gadget does not revert ≤ N" an explicit trust assumption. This narrows the
circuit statement (completeness up to N only; tail is live) and is now driving brief 07's design.

## Sprint 7 fix + re-audit (continued)
- Fix pass 1 (Sonnet, commit 96339c5): closed F1 (reserved-namespace boundary rejection + defensive
  decode), broadened property oracle, reverted connectTimeout default, walletId guard, vacuous-subset
  tests. 194/194 green, typecheck clean.
- **Codex gpt-5.6-sol RE-AUDIT of the fix: F1 CONFIRMED CLOSED** (boundary rejects reserved/PG-unsafe
  keys recursively incl. section names; no caller/merge bypass; BigInt/Date failures translate) — but
  found 3 deeper DEFENSIVE-DECODE gaps on the READ path (BLOCK): (1) malformed STORED envelope (null
  entry/sections) throws raw TypeError through all six methods before validation; (2) permissive decode
  normalizes non-canonical tags (BigInt("0x10")->16n, invalid dates) instead of rejecting; (3)
  pathological ~1000-deep caller object overflows the recursive key-check into a raw RangeError instead
  of ValidationError. Real hardening gaps (mostly require out-of-band corruption; #3 reachable by a
  caller; #1 possibly reachable on a normal empty-sections write — fix agent to verify).
- **Fix pass 2 dispatched** (Sonnet ab34f991): strict canonical decode + defensive stored-envelope
  validation (any structural malformation -> SerializationFailedError, no raw error escapes) + depth
  bound on the key-check + deterministic read-path-corruption tests. Re-verify green, then re-audit.

## Design council convened (verifiable-snapshot feature, branch feature/verifiable-snapshot)
- ALL 11 research briefs complete + committed to the design branch (00 plan + 01-11).
- **Synthesis lead (Opus a837d347) running:** rolling all 11 briefs into ONE coherent design doc
  (design/verifiable-snapshot-design.md) with the layered architecture, the L3/finality/completeness/
  privacy decisions + recommendations, the SDK+indexer PR specs + Compact/circuit sketches, a phasing
  table (v1-now vs needs-node-change vs research-grade), residual trust, and the post-impl testing
  strategy. Next: council review (Codex Sol + Opus + Fable) under the correctness-audit gate.

## Design council verdicts (verifiable-snapshot) + revision plan
- **Sprint 7 DONE**: read-path hardening committed (3c1d4d1); npm test 206/206; F1 confirmed closed by
  re-audit + 3 deeper defensive-decode gaps fixed. Holds on its branch until Sprint 8 is planned.
- **Correctness-audit gate: CONFIRM** (every load-bearing claim verified vs Midnight source: collapse
  invariant merkle_tree.rs:921, 3 live finality RPCs, indexer node-cross-check bail). Missed the two
  Codex findings below.
- **Fable feasibility: buildable + honest, but v1 over-scoped.** Independently BACKED the owner
  forward-sync insight (the on-chain pointer proves detectability NOT harm; an older genuine checkpoint
  is a safe base, tail catch-up re-converges). Recommends the HYBRID (offline correctness cert + slim
  consensus pointer for freshness only) and a much leaner v1 (Increment 0 = UmbraDB-side wrapper: stamp
  anchor at save, on restore GCM-decrypt -> L0 on-chain root comparison vs k>=2 indexers -> stock
  restore(); zero upstream approvals). Defer BFT-CRDT + unshielded MB-tree + brief-07 cert to v1.1.
- **Codex gpt-5.6-sol: BLOCK** with 2 sharp findings the others missed: (1) state_getReadProof
  authenticates only pallet_midnight::StateKey (a content-address), NOT R_N directly -> unauthenticated
  hop; (2) chain_getBlock is ALREADY LIVE and returns the block body, so a wallet could verify the
  extrinsics root vs the finalized header and authenticate ciphertexts/nullifiers CLIENT-SIDE -> may
  close the delivery/spend completeness gap with NO node change (contradicts the design residual).
  Also independently CONFIRMED D1 = recency, not correctness (backs the forward-sync insight).
- **Owner refinement (new): seed-binding.** The attestation MUST bind to a secret recoverable on a
  total cold start from ONLY the 24-word BIP39 phrase (signature by a seed-derived sk_attest, OR a ZK
  proof-of-preimage of H(seed)). This is the identity-recovery layer that makes restore-from-untrusted-DB
  safe (only the phrase holder can claim/decrypt/verify their snapshot).
- **Adjudication agent (Opus) running:** definitively verify Q1 (is R_N authenticated from a finalized
  header + how), Q2 (does chain_getBlock close the delivery gap client-side today), and Q3 (design the
  seed-binding: signature vs ZK-preimage + the exact cold-start recovery flow).
- **Design revision (synthesis pass 2) next**, incorporating: the HYBRID (offline proof + slim freshness
  pointer), the SEED-BINDING requirement, the Q1/Q2 verdicts (esp. if chain_getBlock closes the gap ->
  v1 becomes far stronger), the tightened over-claim language, and the slim Increment-0 v1. Then re-gate
  -> openspec change with the testing strategy.

## 2026-07-22 — Sprint 8 COMPLETE and MERGED (autonomous AFK run)

Sprint 8 (WalletState envelope + Pg-backed wallet tx-history adapter + live preprod DB-sync/cold-boot)
was implemented, audited, fixed, re-audited to PASS, and MERGED to main.

- **Merge:** `d17945e` (--no-ff), main pushed to origin. Branch `sprint-8-wallet-envelope-live-sync`
  head `a06be8c` on GitHub. Verify gate on merged main: typecheck clean, `npm test` 281 pass / 2
  env-gated live skips. (main worktree needed `npm ci` after merge to pick up the new devDeps.)
- **Final merge gate = a real live preprod sync (passed):** funding tx
  `b194e71d4d22ed09846cd88aab67c6bb4eec69ea6df5aead3bdb22bfe3493341` materialized via
  `adapter.getAll()` as a reconstructed finalized SDK lifecycle (`finalizedBlock.height=1763274`);
  cold-boot resumed from the envelope snapshot at `appliedId=505701n`. Public preprod endpoints +
  local proof-server (6300); wallet seed at `~/.midnight-preprod-wallet.seed`.
- **Audit trail:** 4-role panel (Opus domain=PASS / adversarial=BLOCK / release-coverage=BLOCK +
  Codex GPT-5.6 Sol=BLOCK) -> Fable aggregate -> Sonnet fix (blockers F1/F2/F3 + must-fix batch) ->
  adversarial-Opus re-audit=PASS + Codex re-audit. Two further residual rounds from Codex cross-vendor:
  (r1) prototype-key fail-closed status maps + doc/record accuracy + loud parity skip; (r2)
  prototype-safe extension keys (Object.create(null) + __proto__/constructor/prototype boundary
  rejection) + write-side stash validation (symmetric with read) + safe status error messages. Final
  Codex verdict: PASS. Commits: 684bade 09398a2 4bd5d84 42a1a19 a06be8c.
- **Key cross-vendor catches:** (1) the Sprint-7 merge seam claimed the real SDK `mergeWalletEntries`
  was injectable, but it TypeErrors on undefined-first-write and takes a different entry shape -> fixed
  (first-write verbatim; UmbraDB-shaped merge; real-SDK runtime-diff parity test after building the
  facade dist). (2) `__lifecycleDetail` sat in the caller-writable namespace (re-opening Sprint 7s
  fixed collision class) -> reserved-prefix + fail-closed guards at write and read. (3) the
  reconstruction surface was only fixture-tested -> live + gate tests now route through `adapter.getAll()`.

## Sprint 9 (overflow) — PLANNED + gate-CONFIRMED (implementation NOT started)

- Branch `sprint-9-cleanup-perf-connection` (off main), pushed. openspec change, 3 EARS specs:
  `storage-client-hygiene`, `performance-observability`, `connection-robustness`. `openspec validate
  --all --strict` = 8/8. Correctness gate (Opus) = CONFIRM (change dir `GATE.md`), satisfying the
  "N+1 planned" precondition for the Sprint 8 merge.
- Folded-in deferrals incl. Sprint 8 audit items D8-1..D8-4 (`DEFERRALS-FROM-SPRINT-8.md`): serialize()
  emit-shape decision, __lifecycleDetail boundary defense-in-depth, live SDK-loader/seed hardening,
  cold-boot conflicting-history nightly test.
- Adjudicated open questions (adopt in impl): retry allow-list EXCLUDES lease-acquire + in-opts.tx ops
  (whole-operation retry granularity); finality-tip check applies to the C1 anchor path, NOT the
  unshielded per-address cursor (multi-endpoint tx-set cross-check there); benchmark non-vacuity
  self-test is the real gate; GC junction-table migration deferred to its own audited change.
- **Per the "plan out sprint 9" instruction, Sprint 9 is PLANNED ONLY; implementation awaits go-ahead.**

## Also on GitHub
- Recovery feature: branch `feature/verifiable-snapshot` (full EARS/openspec design + research).
- Filed upstream: midnight-wallet#584 (sync-freshness hardening).
