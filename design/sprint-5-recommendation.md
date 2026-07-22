# Sprint 5 Recommendation — Wallet Integration Surface (TransactionHistoryStorage + Live-Sync Conformance)

**Status:** Second post-audit revision. Round 1 (2 Opus reviewers + Codex GPT-5.6 Sol) found and fixed the WalletState-envelope correction (§1) and 14 other items. A final Opus verification + Codex re-audit round then found the CI-gating fix hadn't actually landed correctly (scenario 1 was misclassified as Pg-only when it inherently needs a live wallet sync), a technically-unsound atomicity option, and two overclaims (envelope "consistency for free," a blanket byte-identical-to-origin/main provenance claim) — all fixed in this revision. Recommend one more lightweight verification pass given the CI-gating section changed substantively again, then proceed to openspec drafting.
**Basis:** Live investigation against real, currently-cloned `midnight-wallet`, `midnight-indexer`, and `midnight-node` checkouts, verified byte-identical to origin/main for every file cited **except** `packages/shielded-wallet/src/v1/Sync.ts` and `packages/dust-wallet/src/v1/Sync.ts`, which carry real, separately-tracked uncommitted local modifications unrelated to this recommendation — the architectural claim drawn from those two files (indexer GraphQL WebSocket subscription, not a raw node stream) concerns their unchanged import/subscription structure, not the modified lines, and holds regardless. Supersedes design/design.md §6, §9 (wallet-state rows), §10, and design/tasks.md §6, §8, §9.
**Direction from owner:** UmbraDB is self-contained. Its only external contract is the interface of the Midnight Node stack (node + indexer + proof-server) and the current wallet SDK. No dependency on `midnight-dev-env` legacy code or call sites.

---

## 1. Decisive scope

### Build (one product module + one thin envelope — corrected from the original "exactly two things, zero new code" framing; see finding below)

**1. `PgTransactionHistoryStorage` — the one new storage module.**
The current wallet SDK exposes exactly one pluggable persistence interface: `TransactionHistoryStorage` (`packages/abstractions/src/TransactionHistoryStorage.ts`). Implement it Postgres-backed, following UmbraDB's established module pattern:

- `src/interfaces/transaction-history-storage.ts` — interface + types
- `src/postgres/transaction-history-storage.ts` — implementation
- `src/postgres/migrations/00X_transaction_history.sql` — schema

Surface to implement, keyed by transaction hash: read side `getAll()`, `get(hash)`, `serialize()`; write side `gotPending(entry)`, `gotFinalized(entry)`, `gotRejected(entry)`. Lifecycle-aware writes, not raw upsert/delete. Reference semantics: `InMemoryTransactionHistoryStorage.ts` (Map + pluggable merge + JSON serialize/restore) — but note the reference's atomicity guarantee ("single-threaded JS, no external semaphore needed," per its own doc comment) does **not** carry over to Postgres; see the concurrency requirement below. One storage instance is shared across all three wallet types via the facade (`packages/facade/src/index.ts`), with a merged shielded+unshielded+dust entry schema (`mergeWalletEntries`, `facade/src/index.ts:103-150`) — the Pg schema must accommodate that merged entry, not three per-type tables. `serialize()` is fixed by the interface as `Promise<SerializedTransactionHistory>` (a string) — this is not renegotiable without an upstream SDK change, which is out of this sprint's scope; do not design toward a streaming/export-only variant.

**Two requirements the original draft missed, both mandatory in the EARS spec:**
- **Atomic merge under concurrent writers.** Each of the three wallet types syncs on its own independent subscription and calls `gotFinalized`/`gotPending`/`gotRejected` on the *same shared storage instance*. A single mixed transaction (e.g. touching both shielded and dust sections) has one tx hash, so two wallet types can race a read-modify-write on the same row. Because the merge itself is caller-supplied TypeScript (not reducible to a single atomic SQL statement — see below), the Pg implementation must wrap the read-merge-write cycle in an explicit **row lock** (e.g. `SELECT ... FOR UPDATE` on the target hash inside a transaction, holding the lock across the TS merge call, then writing the merged row before committing) — a bare atomic upsert of an application-computed merge result is **not** sufficient on its own: a second writer can still read the pre-merge row between the first writer's read and write under ordinary read-committed isolation, silently losing that writer's update. Silently losing a section on a race is a real, not hypothetical, failure mode of the shared-instance design this sprint is committing to.
- **Merge semantics match `mergeWalletEntries`, not a "last-state-wins" shorthand.** The real merge is mixed: shared scalar facts are first-writer-wins, `identifiers` are unioned across merges, wallet sections (`shielded`/`unshielded`/`dust`) use section-specific merge functions, and only `lifecycle` is incoming-wins. The EARS spec must require equivalence to `mergeWalletEntries`, not describe this loosely as "last-state-wins." Given this complexity, the merge function must be **caller-supplied in TypeScript, applied inside a DB transaction** (not reimplemented as JSONB-merge-in-SQL — see open question 2's resolution below) — this also settles open question 1: the merge function is injected at construction, so `PgTransactionHistoryStorage` itself never imports wallet-SDK runtime code, keeping it dependency-free.
- **Multi-wallet identity is an API-level binding, not a database column.** `TransactionHistoryStorage`'s methods (`packages/abstractions/src/TransactionHistoryStorage.ts:163-195`) take only hash/entry arguments — there is no `walletId`/namespace parameter anywhere in the six methods. A wallet identity must therefore be bound when **constructing** each `PgTransactionHistoryStorage` instance (one instance per wallet, closed over its own wallet-id filter/tag), not added as an afterthought column the SDK's own calls could never populate. Decide in the EARS spec whether one UmbraDB deployment serves multiple such instances (one per wallet) or is strictly single-wallet-per-deployment.

**2. WalletState blob persistence — one thin envelope module, not zero new code.**
**Correction (Codex-caught, high-severity):** there is no single, facade-wide `WalletState` blob. Each of the three wallet types (`ShieldedWallet`, `UnshieldedWallet`, `DustWallet`) has its **own independent** `serializeState()`/`restore()` pair with its **own distinct** snapshot schema (`shielded-wallet/src/v1/Serialization.ts:66-115`, `unshielded-wallet/src/v1/Serialization.ts:43-86`, `dust-wallet/src/v1/Serialization.ts:62-107`) — confirmed against the wallet SDK's own reference usage (`wallet-sdk-testkit/src/wallet.ts:215-236` calls `wallet.shielded.serializeState()`, `wallet.unshielded.serializeState()`, `wallet.dust.serializeState()` separately and persists three files, and lines 69-131 restore all three independently). UmbraDB's own `CheckpointStore.save` (`src/interfaces/checkpoint-store.ts:142-157`) takes **one** `Uint8Array` per `walletId`/`networkId` per call — it does not natively hold three separate blobs.

Two ways to reconcile this, decide in the EARS spec (do not leave it implicit):
- **(a) One versioned envelope, recommended:** a thin serialization module (new, small — this is the "one new envelope" this section's header now accounts for) that wraps all three wallets' serialized strings plus a schema version tag into one JSON envelope, checkpointed as a single `CheckpointStore.save` call. **What this actually buys, precisely stated:** atomic persistence of the envelope as a unit — either all three sub-wallet strings are saved together or none are (no torn writes), matching `CheckpointStore`'s own `loadAt`-style recovery semantics. It does **not** by itself guarantee the three captured sub-wallet states are mutually consistent as of the same block height, since they sync independently — that is open question 5 below, genuinely unresolved, not something atomicity resolves for free.
- **(b) Three coordinated checkpoints:** one `CheckpointStore.save` per wallet type, same `walletId` namespaced by sub-wallet type. Requires its own explicit atomicity/consistency story — since the three sub-wallets sync independently, what does it mean to "restore all three consistently" if one checkpoint is newer than another? This option is not free of design work despite looking simpler.

Recommend (a) specifically because it sidesteps the cross-checkpoint consistency question (b) would otherwise force onto the EARS spec. Whichever is chosen, the deliverable is a documented integration example (checkpoint the blob(s) per wallet, restore on restart) plus the conformance test below — but this is no longer a claim of "zero new code," just "minimal, well-scoped new code" (a serialization envelope, not a new storage adapter).

**Why this isn't redundant with `PgTransactionHistoryStorage` (module 1):** each wallet's own serialized snapshot (`WalletState`, per `WalletState.ts`'s own docstring) *also* embeds its own internal transaction history alongside local state and block height — so on restore, a wallet's internal notion of its own history and `PgTransactionHistoryStorage`'s rows are two independent, potentially-divergent sources of the "same" facts. **`PgTransactionHistoryStorage` is authoritative for tx-history on restore, not the blob's internal copy** — the blob only needs to carry enough to resume `Sync.ts`'s own subscription (keys, UTXOs, sync-progress cursor), and the EARS spec should say explicitly whether the wallet's internal tx-history embedded in the restored blob is simply ignored/overwritten by what `PgTransactionHistoryStorage.getAll()` returns, or reconciled against it. This is why scenario 2 asserts "tx-history continuity" against the Pg store specifically, not against whatever the restored blob's own internal copy happens to say.

### Architectural boundary (explicit owner directive, confirmed post-consolidation)

**UmbraDB's own module code must be 100% agnostic to how sync data arrived — it must
never depend on, import, or reference the Midnight indexer.** The real current wallet
SDK's sync path (`Sync.ts`) does subscribe to the indexer's GraphQL WebSocket
(`zswapLedgerEvents`) rather than a raw node stream — that is upstream's design choice,
not UmbraDB's, and not something this sprint changes or reimplements. `PgTransactionHistoryStorage`
and the `CheckpointStore`-backed blob store only ever receive already-scanned data handed
to them through the SDK's own `TransactionHistoryStorage` interface and
`serializeState()`/`.restore()` calls; they never touch indexer internals or duplicate its
chain-scanning job. In the conformance test plan below, the indexer container in the local
devnet is exactly the same category of dependency as the Postgres container itself — test
infrastructure needed to exercise a real wallet syncing, not an architectural dependency of
UmbraDB. Building a custom direct-from-node sync path (bypassing the indexer entirely) was
explicitly considered and rejected as a large, novel reimplementation of what the indexer
already does, diverging from how every real Midnight wallet syncs today. The Opus panel and
Codex audit should specifically verify nothing in sections 2–4 below has UmbraDB's own code
reaching into indexer schemas/APIs — only test-infra provisioning may reference it.

### Do not build (obsoleted — confirmed against real source)

- **`PgWalletStateStore` / `PgPrivateStateProvider` and the `wallet_state` table** (design.md §6/§9, tasks.md §6). Those interface names do not exist anywhere in the current SDK. Dead terminology from a prior SDK generation.
- **Differential state-equivalence gate vs. the Mongo store** (design.md §10, tasks.md §8). The Mongo reference it diffs against is not what any current wallet client uses. Replace with the live-sync conformance gate below.
- **`midnight-dev-env` call-site rewiring** (tasks.md §9, `counter-cli-additions/*.ts`, `ballot-preprod.ts`). Interop is proven self-contained instead.

---

## 2. Live-sync conformance test plan

**Stack (fully local, no public network, no faucet):**

- `midnight-wallet`'s `infra/compose/docker-compose-dynamic.yml`: proof-server 8.1.0, midnight-node 1.0.0 (`CFG_PRESET: dev`, pre-funded genesis), indexer-standalone 4.3.2. Proven by upstream's own `walletSync.undeployed.test.ts` (fixed seed → sync → non-zero genesis balances).
- A plain Postgres container for UmbraDB's own storage (UmbraDB's existing test infra pattern).
- Skip `midnight-node/local-environment/` (full Cardano+bridge stack, needs submodule init) — heavier than wallet-storage conformance requires. Note it as the escalation option only.

**Reuse as dependencies (do not reimplement):** `@midnightntwrk/wallet-sdk-testkit` — `createTestContainersEnvironment({ network: 'undeployed' })` (note the config-object argument — a bare string is not the real signature, `testcontainers.ts:30-37,61-70`) for env provisioning, `initWalletWithSeed` + `progress.isStrictlyComplete()` polling for sync completion, `tx-history-asserts.ts` for shape assertions (works against any object with `getAll()`, so it runs against the Pg backend unmodified — but see the `bigint`/`Date` typing note below).

**New harness code (the confirmed gap):** every upstream test path hardcodes `InMemoryTransactionHistoryStorage`. Build a thin storage-backend parameterization: a fixture builder taking a `TransactionHistoryStorage` factory, run once with the in-memory reference and once with `PgTransactionHistoryStorage`.

**Oracle scope, corrected:** the in-memory run is a valid oracle for *sequential, single-writer* functional equivalence only. It is **not** a valid oracle for the concurrent-write path (finding above) — its own doc comment states its atomicity relies on JS being single-threaded, an assumption a real Postgres-backed store cannot inherit. The concurrency scenario (4 below) checks correctness against a Postgres-side invariant directly, not against this oracle.

**Implementation note carried from the panel:** `PgTransactionHistoryStorage.getAll()` must return live `bigint`/`Date`-typed values, not JSON-stringified primitives — `tx-history-asserts.ts`'s entry-level assertions check `typeof value === 'bigint'` and similar, and a naive JSON-round-trip through Postgres would coerce these to strings and fail the existing testkit asserts unmodified.

**What the test must prove — split explicitly by infrastructure need, since this determines the CI gating tier (open question 6):**

**Pg-only (a plain Postgres container, no live wallet, no devnet — required merge gate):**

0. **Sequential-equivalence oracle check:** drive an identical **scripted** sequence of `gotPending`/`gotFinalized`/`gotRejected` calls (fixture data, not a live sync) against both the in-memory reference and `PgTransactionHistoryStorage`; assert identical resulting `getAll()` output. This is the corrected home of what earlier drafts folded into "scenario 1" — it needs no live wallet or devnet at all, only the storage interface itself.
3. **Lifecycle correctness, expanded:** replay `gotPending` → `gotFinalized` (and a `gotRejected` path) including duplicate delivery; assert merge semantics are equivalent to `mergeWalletEntries` (not a "last-state-wins" approximation). Additionally cover: out-of-order delivery (a `gotPending` arriving after its `gotFinalized`/`gotRejected` counterpart), `gotRejected`/`gotFinalized` for an entry that was never `gotPending`, and the identifier-*subset* pending-clear rule (`InMemoryTransactionHistoryStorage.ts`'s `#clearPendingByIdentifiers`: a pending entry clears when its identifiers are a subset of the finalized entry's, not exact-array-equal — and that identifier set grows via union across merges, so subset containment must still hold after several merges).
4. **Concurrency invariant (not oracle-diffed):** two wallet types' `gotFinalized` calls racing on the same tx hash (e.g. a mixed shielded+dust transaction) must not lose either section. Assert directly against Postgres state (both sections present after concurrent writes complete), not against the in-memory reference, which cannot exhibit this race at all.

**Needs the full local devnet (node + indexer + proof-server, per the stack above — nightly/labeled, not a required merge gate):**

1. **Genesis sync:** fresh wallet, fixed seed, `PgTransactionHistoryStorage` injected via `configuration.txHistoryStorage`; sync to strictly-complete against the real local devnet; assert non-zero genesis balances and tx-history shape via testkit asserts. This is an end-to-end interoperability proof (a real wallet, real sync subscription, real proving) — item 0 above already covers the storage-equivalence question this scenario used to also claim to prove, so this scenario's job is narrower than earlier drafts implied: prove real interop, not re-prove sequential equivalence.
2. **Kill/restart/resume:** after a real sync (scenario 1), checkpoint via the chosen envelope design (§1) → `CheckpointStore.save`; destroy the wallet instance; restore via the same envelope → per-sub-wallet `.restore(...)` with the same Pg storage; assert resume without full resync and tx-history continuity. Needs a genuinely synced wallet to restart, so it inherits scenario 1's devnet requirement — it cannot run Pg-only either. Note the envelope choice directly determines what "consistent restore" even means here — resolve §1's (a)/(b) decision before writing this scenario, not while writing it.

---

## 3. Open questions for the design-drafting stage

Questions 1, 2, 4, and 6 are pre-narrowed by the panel/Codex round to a specific recommendation (still need to be written into the EARS spec as binding text, not left as "the recommendation doc said so"). Question 3 is fully resolved (not actually open — kept here only so its resolution is visible alongside the others it was originally grouped with). Question 5 is the one genuinely still-open item.

1. **Type dependency vs. structural mirror — pre-narrowed to structural mirror, at runtime.** `PgTransactionHistoryStorage`'s constructor takes only a Postgres connection/pool, an entry schema, and a caller-supplied merge function — never a wallet-SDK type import at runtime. (Dev-time type-checking against the real interface, e.g. via a type-only import or a conformance test, is still fine and recommended — the constraint is on the runtime dependency graph, not on type-checking.)
2. **Where merge lives — pre-narrowed to caller-supplied TS, applied inside a DB transaction.** JSONB-merge-in-SQL was considered and rejected: `mergeWalletEntries` delegates to three separate SDK packages' own section-merge logic (`mergeShieldedSections`/`mergeUnshieldedSections`/`mergeDustSections`), and reimplementing that in PL/pgSQL would be a divergence-prone rewrite of logic that already exists and is already tested upstream.
3. **`serialize()` semantics — resolved, not open:** the interface fixes this as `Promise<string>` (`TransactionHistoryStorage.ts:163-166`). No streaming/export-only variant is possible without an upstream SDK interface change, which is out of scope. Design the Pg implementation's `serialize()` as a synchronous-equivalent full dump, matching the reference.
4. **Multi-wallet namespacing — the real question is API-level, not schema-level.** Since none of the six `TransactionHistoryStorage` methods carry a wallet identifier, decide explicitly: does one `PgTransactionHistoryStorage` instance always correspond to exactly one wallet (construction-time binding, one Postgres schema/table-set or filter predicate per instance), or can one instance genuinely multiplex several wallets some other way? Recommend the former (one instance per wallet) as the simpler, harder-to-misuse default unless a concrete multi-wallet-per-process use case is named.
5. **Checkpoint cadence, retention, and cross-sub-wallet consistency for the WalletState envelope:** every N blocks vs. shutdown-only; retention policy interaction with `CheckpointStore`'s existing GC; and — new, surfaced by the three-separate-blobs correction in §1 — if the envelope design (a) is chosen, whether the three sub-wallet snapshots captured into one envelope need to be mutually consistent as of the same block height (they sync independently), or whether "each sub-wallet resumes its own sync from its own last-known point, all bundled in one save/load call for operational convenience only" is an acceptable, weaker consistency contract. Settle this explicitly — don't let it default silently to whichever behavior falls out of the implementation.
6. **CI execution, split correctly by actual infrastructure need (§2 restates this precisely — the two sections must stay in sync if either changes):** the Pg-only conformance suite (item 0's sequential-equivalence oracle check, scenario 3, scenario 4 — everything needing only a plain Postgres container, no live wallet or devnet) is a **required merge gate**, matching every other UmbraDB module's existing 155/155-tests-before-merge bar. Scenarios 1 and 2 both need a genuinely synced wallet against the real local devnet (scenario 2 restarts a wallet that scenario 1 already synced) — neither can run Pg-only, so both sit in the nightly/labeled tier (Docker + ghcr image pulls for node/indexer/proof-server). Image-digest pinning (artifact 1) applies regardless of which gate tier a given test sits in.

---

## 4. Prioritized artifacts (dependency order)

Two are product modules (1 storage adapter, 1 thin serialization envelope); the rest are supporting infrastructure and documentation this sprint also needs to land — listed explicitly rather than folded into an "exactly two things" module count, which undercounted total sprint deliverables in the original draft.

1. **Vendor/pin manifest:** record exact `midnight-wallet` commit, SDK package versions, a vendored copy of `docker-compose-dynamic.yml`, and image digests (proof-server 8.1.0, node 1.0.0, indexer-standalone 4.3.2). Everything downstream cites these pins.
2. **Draft openspec change `sprint-5-transaction-history-storage`** with EARS spec: interface surface, merged-entry schema, lifecycle-write semantics (including the atomic-merge-under-concurrency and identifier-subset pending-clear requirements from §1), the WalletState-envelope design decision ((a) vs (b), §1), and explicit resolutions of open questions 1–6 (§3) — questions 1, 2, 4, and 6 are pre-narrowed above, question 3 is already resolved, and question 5 is the one genuinely open item; all still need to be written down as binding spec text, not left as "the recommendation doc said so."
3. **Product module 1 — schema migration + `PgTransactionHistoryStorage` implementation** per the spec, mirroring existing interface/postgres module pairs, including the atomic-merge and per-wallet-instance-binding requirements.
4. **Product module 2 — WalletState envelope + `CheckpointStore` integration** (the envelope serialization module per §1's chosen option, docs, and a runnable example) — no longer "zero new code," but still small and well-scoped.
5. **Storage-swappable conformance harness** (testkit dependency + backend-parameterized fixtures) closing the identified gap; scoped to item 0's sequential-equivalence oracle check (concurrency is scenario 4, checked separately, also Pg-only).
6. **Live-sync conformance suite**, wired as two separately-gated scripts per the corrected CI split (open question 6): a Pg-only `test:conformance` script (item 0, scenario 3, scenario 4) as a **required merge gate** from day one, same as every other UmbraDB module; and a `test:live` script (scenarios 1–2, needing the full local devnet) as nightly/labeled, not required-per-PR.
7. **Supersede notes** in design/design.md and design/tasks.md marking §6/§9/§10 and §6/§8/§9 obsolete, pointing here — so the panel and future agents stop planning against dead interfaces.

*Revised post-audit; word count no longer tracked precisely given the added correction material.*
