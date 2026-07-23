# Design — v1.0.0-durable-checkpoint-cursor

Implementation-level detail for the four gate items G5–G8, grounded in the live tree at
`/root/UmbraDB` (read 2026-07-23) and the facet evidence in `02-reliability-hardening.md` +
`council/B-engineering-risk.md`. Every design decision that touches an already-shipped contract cites
the source file:line and the design/algebra section it extends, per `openspec/config.yaml`'s design
rule and correctness rule.

## 0. Package layout

```
src/
  interfaces/
    checkpoint-store.ts              (modified: save gains opts.tx; id-validation + ordering contract docs)
    temporal-kv.ts                   (modified: JsonValueSchema depth bound; hosts hoisted exceedsMaxDepth)
    transaction-lease.ts             (modified: withLease release-fault contract)
    transaction-history-storage.ts   (modified: imports hoisted exceedsMaxDepth instead of defining it)
  postgres/
    checkpoint-store.ts              (modified: save threads opts.tx; four entry points validate ids)
    client.ts                        (modified: connection timeouts; durability probe at bootstrap)
    migrate.ts                       (modified: bounded advisory-lock acquire)
    transaction-lease.ts             (modified: withLease surfaces release faults)
    durability-probe.ts              (new: SHOW-and-verify probe + pooler detection)
    save-and-advance.ts              (new: the co-commit combinator)
test/postgres/
    save-and-advance.test.ts, durability-probe.test.ts, timeouts.test.ts,
    checkpoint-id-validation.test.ts, json-depth.test.ts, with-lease-release-fault.test.ts,
    cursor-never-ahead.property.test.ts
docs/
    durability-contract.md           (new: the binding Postgres-config contract, G6)
```

No new top-level directory, matching every prior sprint's "no abstraction-for-its-own-sake nesting"
rationale (`sprint-4-watermarks/design.md` §0).

---

## 1. G5 — Co-transactional watermark + checkpoint data

### 1.1 The gap, confirmed in source

`PgCheckpointStore.saveImpl` opens its own transaction and resolves it locally
(`checkpoint-store.ts:149-151`: `return await this.txLayer.withTransaction(async (tx) => { const sql
= resolveTransaction(tx); ... })`), and the interface doc states the refusal to accept a caller `tx`
as *deliberate* (`src/interfaces/checkpoint-store.ts:135`). Meanwhile `PgWatermarks.set` and
`PgTemporalKV.put` both accept `opts.tx` (`sprint-4-watermarks/design.md` §2/§6). So KV-data + cursor
*can* co-commit today; **the checkpoint + cursor pair cannot**. `council/B-engineering-risk.md` §1
confirmed this structurally ("Cross-object atomicity with the watermark is structurally impossible
for checkpoints") and §5 ruling 1 keeps it a P0 blocker while narrowing the fix.

### 1.2 Change `save` to accept a caller transaction

Add `tx?: TransactionHandle` to the `save` options. In `saveImpl`, when `opts.tx` is present, resolve
that handle instead of opening a new transaction — exactly the branch `PgWatermarks`/`PgTemporalKV`
already use:

```typescript
// checkpoint-store.ts saveImpl (sketch, mirrors watermarks.ts / temporal-kv.ts's opts.tx branch):
const runOnTx = async (sql: TxSql) => { /* the existing chunk/seq/manifest/junction inserts */ };
if (opts.tx !== undefined) {
  const sql = resolveTransaction(opts.tx);   // src/postgres/transaction-lease.ts
  return await runOnTx(sql);                 // caller owns the transaction lifecycle + commit
}
return await this.txLayer.withTransaction((tx) => runOnTx(resolveTransaction(tx)));
```

- When `opts.tx` is supplied, `save` issues **no** `BEGIN`/`COMMIT` of its own — the caller's
  transaction bounds atomicity, and `save`'s manifest + junction rows commit (or roll back) with
  whatever else the caller wrote in that transaction, including a `watermarks.set`. This is the whole
  fix: it makes the checkpoint + cursor co-committable.
- When `opts.tx` is absent, behaviour is byte-for-byte the existing internal-transaction path — no
  behavioural change for existing callers. A stale/fabricated handle rejects with
  `TransactionHandleInvalidError` before any statement, the same contract every other `opts.tx`
  method documents (`src/interfaces/transaction-lease.ts:117-121`,
  `sprint-4-watermarks/specs/watermarks/spec.md` stale-handle scenario).
- **Scope:** only `save` gains `tx` (the cursor-ahead path is `save` + `watermarks.set`). `prune`,
  `load`, `history` keep their existing internal-transaction composition — G5 needs nothing from
  them, and widening them is out of scope (`ROADMAP` G5 names only `save`).
- **Interface-doc rewrite:** `src/interfaces/checkpoint-store.ts:135`'s "deliberately do NOT accept a
  `tx`" wording is replaced with the new contract. This is an intentional, documented contract change
  made in the pre-freeze phase precisely so it is never a breaking change afterward
  (`council/A-release-scope.md` §5 Phase 1).

### 1.3 The `saveAndAdvance` combinator

`CheckpointStore` has no knowledge of `Watermarks`, so the combinator lives in a small composition
module (`save-and-advance.ts`), not on `PgCheckpointStore` — it takes the checkpoint store, the
watermarks store, and the transaction layer, and composes only these in-repo primitives (no consumer
import; honours the indexer-agnostic boundary, `council/A-release-scope.md` ruling b):

```typescript
// save-and-advance.ts (sketch)
async function saveAndAdvance(
  deps: { checkpoints: CheckpointStore; watermarks: Watermarks; txLayer: TransactionLeaseLayer },
  walletId: string, networkId: string, data: Uint8Array,
  cursor: { kind: WatermarkKind; key: WatermarkKey; value: WatermarkValue },
  opts?: { chunkSize?: number; label?: string; signal?: AbortSignal },
): Promise<CheckpointSummary> {
  return deps.txLayer.withTransaction(async (tx) => {
    const summary = await deps.checkpoints.save(walletId, networkId, data, { ...opts, tx });
    await deps.watermarks.set(cursor.kind, cursor.key, cursor.value, { tx, signal: opts?.signal });
    return summary;
  });
}
```

Manifest + junction + watermark all commit in the one transaction; a crash before that single COMMIT
leaves **neither** the checkpoint nor the cursor — never a cursor pointing past absent data. This is
the API that makes the roadmap's T5 crash test (`02` T5, owned by the testing-gate change) able to
pass honestly.

### 1.4 The ordering contract (for callers composing manually)

Callers who do not use `saveAndAdvance` and do not thread a single `tx` MUST advance the cursor
**strictly after** the data transaction commits. A crash then yields, at worst, a durable
**watermark-behind-data** state (the safe direction): on resume the sync re-applies a bounded window
of already-durable data and converges. It MUST NOT be the reverse ordering (cursor-first), which is
the silent-skip failure. Documented in the checkpoint-store contract doc and cross-referenced from
`Formal/STORAGE_ALGEBRA.md` W1 (which today disclaims watermark-vs-data ordering entirely,
`STORAGE_ALGEBRA.md:280-286`).

**Replay contract (from `council/B-engineering-risk.md` §1):** because `put` without
`expectedVersion` is a version-bumping upsert, watermark-behind replay writes spurious `kv_history`
rows and version gaps versus a fault-free run. Replay convergence is therefore judged on **current
state**, not on history chains — stated in the docs and asserted that way by the (separately owned)
crash tests.

---

## 2. G6 — Durability startup probe + binding contract

### 2.1 Where the probe runs (the one real design decision)

`createClient` is **synchronous** and returns the `Sql` instance directly (`client.ts:119-131`,
verified 2026-07-23), but a `SHOW`-and-verify probe is inherently async. Rather than make
`createClient` async (a wider API change than warranted), the probe is an exported async function
`probeDurability(sql, opts?)` (`durability-probe.ts`). It returns a typed `DurabilityWarning[]` and
**throws** a typed `DurabilityContractError` on a hard violation, matching `02`'s recommendation ("a
`SHOW`-and-verify startup probe returning a typed `DurabilityWarning[]`", `02` "Durability config
contract").

**The probe MUST run from a non-skippable path (not a documented convention).** A probe a consumer
can forget to call provides no guarantee — that is the exact "core guarantee enforceable only by
undocumented caller discipline" anti-pattern this whole change exists to abolish (proposal ¶ "The
single blocking failure mode"). Fixing cursor-durability-by-discipline while shipping
durability-probe-by-discipline would be incoherent. Therefore the probe is invoked as a **mandatory
step of `runMigrations`**: every consumer already must call `runMigrations` before first use (the
`PgCheckpointStore` class doc directs "call `runMigrations` before constructing this against a fresh
database"), so wiring the probe there makes it non-skippable while `probeDurability` remains directly
callable for callers who want it standalone. A hard violation therefore surfaces as **`runMigrations`
rejecting before any migration runs** — a testable, enforced gate, not caller discipline. There is no
"documented pre-first-use step" escape hatch (Fable Finding 3 / Opus B2).

### 2.2 The three durability settings

Query each with `SHOW`:

| Setting | Value | Action | Source |
|---|---|---|---|
| `fsync` | `off` | **Refuse** — throw a typed `DurabilityContractError`; `off` risks arbitrary corruption | `02` F9, contract item 1; PG WAL docs |
| `synchronous_commit` | `off` **only** | **Typed lost-tail warning** in the returned array — a recoverable trade the operator may deliberately accept | `02` F9, contract item 2 |
| `synchronous_commit` | `local` / `remote_write` / `remote_apply` / `on` | **No durability warning** (optional informational note) — all flush WAL to local disk before ack | corrected; see below |
| `full_page_writes` | `off` | **Warn/refuse** (default refuse) — torn-page protection; on unless storage guarantees atomic 8 KB writes | `02` F9, contract item 3 |

`fsync=off` is non-negotiable-refuse; `synchronous_commit=off` is a documented lost-tail warning (a
wallet cache can re-sync a lost tail); `full_page_writes=off` defaults to refuse with a documented
override.

**Grounded correction (Opus audit B1, per `openspec/config.yaml`'s correctness rule).** An earlier
draft warned on *any* `synchronous_commit` other than `on`. That is a false durability claim: on a
primary with no synchronous standbys, only `synchronous_commit=off` forfeits local crash durability.
`local` waits for local WAL flush before acknowledging the commit; `remote_write`/`remote_apply`/`on`
add standby conditions but still flush WAL locally first — so on a standalone primary all four are
byte-for-byte as crash-durable as `on`. Emitting a lost-tail warning for `local`/`remote_write`/
`remote_apply` would bake a false claim into the very durability contract this change makes true. The
lost-tail warning is therefore scoped to `synchronous_commit=off` only; the source facet `02` F9 only
ever cites `off`, so this restores the grounding the earlier draft over-broadened.

### 2.3 Transaction-pooler detection

A transaction-pooling proxy (PgBouncer `transaction` mode) silently breaks the advisory-lease scheme —
the unlock can land on a different backend than the lock (`02` F4). Detect it the way `02` prescribes:
acquire a **session** advisory lock, then in a *follow-up* query on the same logical session confirm
the lock is visible in `pg_locks`. Under a transaction pooler the follow-up query may land on a
different backend and the lock is not visible → **fail fast** with a typed error. This reuses the
class-2 advisory-lock machinery the lease already relies on (`transaction-lease.ts`), so it tests the
exact property the lease depends on.

### 2.4 The binding Durability Contract doc

`docs/durability-contract.md` publishes the required configuration as a binding deployer precondition
(`fsync=on`, `full_page_writes=on`, the `synchronous_commit` semantics — that only `off` forfeits
local crash durability while `local`/`remote_write`/`remote_apply`/`on` are all crash-durable on a
primary, session-mode pooling only, the three server-side timeouts, and the WAL/checkpoint tuning that
affects recovery time not correctness — `02` contract items 1–6). For each setting it states whether
the startup probe enforces it (rejects) or merely documents it, so the doc and the probe cannot drift
(acceptance B8). The format-headroom / threat-model paragraphs are owned by the API/contract-docs
change (`G4`); this doc is the durability-config contract only.

---

## 3. G7 — Server-side timeouts

### 3.1 Connection defaults

`client.ts`'s `options.connection` currently sets only `search_path` (`client.ts:127-128`). Add the
production trinity (`02` F10; Bytebase/CYBERTEC), conservative and **caller-overridable** via
`UmbraDBConnectionOptions`:

```typescript
connection: {
  search_path: schema,
  statement_timeout: String(opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS),
  lock_timeout: String(opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS),
  idle_in_transaction_session_timeout: String(opts.idleInTxTimeoutMs ?? DEFAULT_IDLE_IN_TX_TIMEOUT_MS),
},
```

- **Concrete defaults (design rationale, not a spec-normative bound).** Pick conservative values that
  the declared operating envelope's largest legitimate `withTransaction` and largest `save`/`load`
  fit inside (`checkpoint-store.ts` buffers the whole payload, `02` F11). Proposed starting values:
  `statement_timeout = 120000` (120 s), `lock_timeout = 30000` (30 s),
  `idle_in_transaction_session_timeout = 120000` (120 s). Every one is overridable via
  `UmbraDBConnectionOptions` so a heavier workload is never wedged by the default. The spec deliberately
  does **not** fix these numbers (Fable nonblocking 2 / Opus N1: "generous enough under normal
  operation" is unmeasurable) — the requirement fixes only *non-zero + overridable*; the values live
  here and in the Durability Contract, tunable against G14's declared envelope once it exists.
- **Interaction with the lease path (`statement_timeout`):** the lease sets and resets its *own*
  `statement_timeout` on its reserved connection for the lease TTL (`transaction-lease.ts:183` `reset
  statement_timeout`, and its set/reset helpers). A connection-level default is compatible: the lease
  overrides per-lease and resets to the connection default (not to unset). Task 3.1 verifies the reset
  restores the configured default, not `0`.
- **Interaction with `idle_in_transaction_session_timeout` (Opus N3).** This timeout fires on a
  session left idle *inside* an open transaction — so it can, in principle, terminate a lease that
  holds its reserved connection's transaction open while the caller does slow out-of-band work, or a
  long `withTransaction` that pauses between statements. The default is therefore chosen generous
  enough that legitimate in-transaction work at the declared envelope does not idle past it, and it is
  overridable: a workload that legitimately holds a transaction open longer raises the default via
  `UmbraDBConnectionOptions` (spec scenario "a raised idle-in-transaction default is honoured for a
  long in-transaction workload"). `02` F10 called the lease path out specifically; this records the
  compatibility rather than leaving it implicit.

### 3.2 Bounded migration advisory-lock acquire

`migrate.ts:124` does `select pg_advisory_lock(1, hashtext(${opts.schema}))` with no bound — two
instances starting together, one wedged, hangs the other forever (`02` F6-a). Bound the acquire and
fail fast with a typed timeout.

**Grounded finding (verified live 2026-07-23, per `openspec/config.yaml`'s correctness rule).** An
earlier draft asserted a "grounded correction" that `lock_timeout` does **not** reliably abort a
blocked `pg_advisory_lock()` function call, and mandated recording that in code comments. **That claim
is empirically false and has been removed.** Reproduced on `postgres:16-alpine` (PostgreSQL 16.14):
session A holds `pg_advisory_lock(1,42)`; session B runs `SET lock_timeout='1500ms'; SELECT
pg_advisory_lock(1,42);` → `ERROR: canceling statement due to lock timeout` after ~1.5 s. A blocked
advisory-lock acquisition waits on the ordinary heavyweight-lock path, where the `lock_timeout` timer
is armed, so `lock_timeout` **does** abort it. A scoped `statement_timeout` around the acquire aborts
it too (verified in the same run: `ERROR: canceling statement due to statement timeout`), as does a
`pg_try_advisory_lock` deadline poll.

**All three mechanisms are valid.** The requirement is therefore mechanism-agnostic — the bound must
be *proven by test* (a second `runMigrations` against a held lock fails fast within the window), not
tied to a particular SQL knob. The implementation MAY use `lock_timeout` (simplest — one `SET LOCAL`
scoped to the acquire), a scoped `statement_timeout`, or a `pg_try_advisory_lock` poll; whichever it
uses, it translates the resulting timeout SQLSTATE into a typed migration-lock-timeout error and
restores the prior session-level timeout before the migration DDL runs (so the DDL is not subject to
the short acquire bound). Task 3.2 verifies fail-fast against a lock held by a second session (the
roadmap's T8 maps here). No task or comment may re-assert the removed false claim.

---

## 4. G8 — Contract-integrity fixes

### 4.1 Validate `walletId`/`networkId` at all four entry points

`PgCheckpointStore.save`/`load`/`history`/`prune` take `walletId`/`networkId` as raw `string` and
interpolate them straight into SQL (`checkpoint-store.ts:132,204,293,346`; the ids reach the SQL
builders downstream). None validate — a NUL or lone-surrogate id escapes as a raw, untranslated
driver error, breaching the frozen "no raw driver errors" contract (`04` F3,
`council/A-release-scope.md` G6). Fix: validate both ids at each of the four entry points, **before
any statement**, reusing the wallet-state envelope's pattern for the same two ids
(`src/interfaces/wallet-state-envelope.ts:80-82` — `z.string().min(1).refine(!hasPostgresUnsafeText)`)
**extended with an explicit `.max()` length bound**. The envelope schema itself has **no** `.max()`
(verified `wallet-state-envelope.ts:80-82`), so this is the envelope's pattern plus a length bound,
not a verbatim copy:

```typescript
const MAX_CHECKPOINT_ID_LENGTH = 512; // frozen at G1; bounds a malformed id to a clean rejection
const CheckpointIdSchema = z.string().min(1).max(MAX_CHECKPOINT_ID_LENGTH)
  .refine((s) => !hasPostgresUnsafeText(s), { message: `id ${POSTGRES_SAFE_TEXT_MESSAGE}` });
```

The `512` bound is pinned here (not left "e.g.") because it becomes frozen API surface at G1 — a
walletId/networkId is a wallet/network identifier, not free-form data, so 512 chars is generous while
still bounding a hostile input. Rejection is `ValidationError` before any round-trip. This adds both
the missing NUL/lone-surrogate check *and* the missing length bound (`04` F3 "no length bound").
Defining the schema once in `src/interfaces/checkpoint-store.ts` (alongside the existing
`SaveCheckpointOptionsSchema`) and applying it in the four adapter methods keeps validation at the
interface boundary, matching every other module.

### 4.2 Depth bound on `JsonValueSchema`

`JsonValueSchema = z.json().refine(...)` (`temporal-kv.ts:62`) has **no depth bound**, so a deeply
nested value can overflow the stack — in Zod's own recursive parse of `z.json()` — before any code
runs. The identical guard already exists one module over: `exceedsMaxDepth`, an **iterative** (explicit
stack, non-recursive) walk, wrapped in a `z.preprocess` that runs *before* the inner schema parses
(`transaction-history-storage.ts:131-152`, `MAX_ENTRY_CONTENT_DEPTH = 64`). `04` F4 and
`council/B-engineering-risk.md` P1-4 both prescribe reusing exactly this guard — it is the only finding
with an off-host/chain-derived attacker input path.

- **Reuse, not re-implement.** Hoist `exceedsMaxDepth` and its depth constant out of
  `transaction-history-storage.ts` into `temporal-kv.ts` (where `JsonValueSchema` lives) or a shared
  json-util module, and have `transaction-history-storage.ts` import it — `transaction-history-storage.ts`
  already imports `hasPostgresUnsafeText` from `temporal-kv.ts` (`:2` there), so hoisting to
  `temporal-kv.ts` introduces no new import cycle while letting tx-history keep its behaviour
  unchanged.
- **Apply as a `z.preprocess`, not a `.refine`.** The check MUST run before `z.json()`'s recursive
  parse (a `.refine` runs only after the parse has already recursed — too late to prevent the
  overflow), exactly as `EntrySectionsSchema` already does (`transaction-history-storage.ts:150-162`).
- **Shared-schema ripple, stated deliberately.** `JsonValueSchema` is shared by `TemporalKV` and
  (via `WatermarkValueSchema`, `watermarks.ts:51`) `Watermarks`, and is used inside
  `VersionedEntrySchema` (`temporal-kv.ts:99`). Bounding it therefore also bounds `put`/`set` values
  and read-side validation — which is the intended fix (both are attacker-input paths). Use the same
  `64` bound (or a shared `MAX_JSON_DEPTH` constant equal to it) so there is one number, not two.
  Rejection surfaces as `ValidationError` before any statement — matching the round-trip-safety
  boundary `JsonValueSchema`'s existing `hasPostgresUnsafeText` refinement already enforces.

### 4.3 Stop `withLease` swallowing release failures

`withLease` does `await this.releaseLease(lease).catch(() => {})` (`transaction-lease.ts:412`),
swallowing exactly the `LeaseFaultError("connection-lost")` that `releaseLease` throws when the
reserved connection died (`transaction-lease.ts:398-400` region) — the *only* surfaced hint that
mutual exclusion may have lapsed (`02` F3, `council/B-engineering-risk.md` P1-1(a)). The full fix
(routing writes through the reserved connection) is deferred; this change delivers only the S-effort
surfacing half (`council/B-engineering-risk.md` §5 ruling 2 condition (b)).

Fix: `withLease` no longer discards the release fault. The surfacing behaviour is **pinned here** (not
left as a task-time either/or) because it changes the observable public API — a new
`opts.onReleaseFault` field on `LeaseAcquireOptions` (which has no such field today,
`interfaces/transaction-lease.ts:179`) — and that shape must be frozen at G1 without a later breaking
change (Fable Finding 2 / Opus N5; `council/A-release-scope.md` §5 Phase 1). The pinned contract:

- **New option** `opts.onReleaseFault?: (err: unknown) => void` on `LeaseAcquireOptions`.
- When `fn` **succeeded** and `releaseLease` then fails: **WHERE `onReleaseFault` is supplied**,
  `withLease` invokes it with the `LeaseFaultError` and **resolves with `fn`'s return value**;
  **WHERE it is not supplied (the default)**, `withLease` **rejects with the `LeaseFaultError`**. The
  default is reject — the safe direction: a driver that does not opt into a callback still learns the
  critical section may have lapsed, rather than silently continuing.
- When `fn` **threw**, `fn`'s error remains the primary rejection, but the release fault is still
  surfaced — via `onReleaseFault` if supplied, otherwise attached as the rejection's `cause` / an
  aggregated error — never silently dropped. The original comment's concern ("never mask `fn`'s own
  error") is preserved.

The interface doc for `withLease` (`src/interfaces/transaction-lease.ts`) is updated from the current
"swallowed, no logging infrastructure" wording to this surfacing contract, and `LeaseAcquireOptions`
gains the documented `onReleaseFault` field so G1 exports the final shape.

---

## 5. Boundaries and non-goals respected

- **Indexer-agnostic boundary held.** `saveAndAdvance` composes only CheckpointStore + Watermarks +
  the transaction layer; no consumer/indexer app is imported (`council/A-release-scope.md` ruling b;
  `MEMORY: umbradb-sync-architecture-boundary`).
- **`save` idempotency untouched.** No `idempotency_key` column, no UNIQUE on `(w,net,seq)`, no
  `manifest_hash` dedup — deferred to Sprint 9 (`council/B-engineering-risk.md` §5 ruling 3). The
  save-retry caveat is documentation owned by `G4`.
- **Lease deep-fencing untouched.** Only the swallow is fixed; write-routing and fencing tokens stay
  deferred (`council/B-engineering-risk.md` §5 ruling 2).
- **No perf work, no benchmark.** HP-1/HP-2/IS-1 and the baseline are the perf change's (`G13`/`G14`).
- **No chunk-addressing / encoding change.** Keyed/encrypted chunk modes are 1.1 (`ROADMAP` §Deferred);
  the format-headroom paragraph is `G4`'s.
- **No test harness.** The Testcontainers crash-injection suite is `G9`–`G12`; this change ships the
  API + unit/property coverage and records the T5/T12 dependency.

### 5.1 Archival reconciliation note (Opus N6)

This change files everything under a new `durable-composition` capability as `## ADDED Requirements`,
matching Sprint 4's convention, because the base specs it modifies (`save`'s signature,
`JsonValueSchema`'s depth, `withLease`'s swallow) live in sprint changes that are not yet archived —
there is no archived base spec to `## MODIFIED`-delta against today. **Intended resolution when the
sprint specs are archived:** the three requirements that alter already-shipped contracts — "save
accepts and joins a caller-supplied transaction handle" (checkpoint-store), "JsonValueSchema rejects
values exceeding the maximum nesting depth" (temporal-kv), and "withLease surfaces a lease-release
failure instead of swallowing it" (transaction-lease) — should be re-expressed as `## MODIFIED`
deltas against those base capabilities, while the genuinely new ones (`saveAndAdvance`, the durability
probe, pooler detection, the Durability Contract, server-side timeouts, migration-lock bound,
checkpoint id validation) remain `durable-composition` additions. Recorded here so the spec base does
not silently fork two overlapping requirement sets for `save`/`JsonValueSchema`/`withLease`.

## 6. Audit resolution

Two independent audits (`audit-fable.md`, `audit-opus.md`) both returned **REVISE**. Every blocking
finding from either auditor is applied; the one factual dispute between them was resolved by live
test. Non-blocking findings are applied where they improve the change. No finding is rejected.

### 6.1 The Fable-vs-Opus factual dispute (resolved by live test)

Fable Finding 1 (blocking) and Opus §3/§4-G7 **directly contradict each other** on one fact. The
draft's design §3.2 claimed, as a "grounded correction," that `lock_timeout` does **not** reliably
abort a blocked `pg_advisory_lock()` function call, and tasks/acceptance mandated recording that in
frozen code comments. Fable ran a live PG16 test refuting it; Opus called the same claim "correct"
but did **not** test it (it accepted the draft's assertion).

**Resolution: Fable is right; the claim is false.** Reproduced independently on `postgres:16-alpine`
(PostgreSQL 16.14) 2026-07-23: with session A holding `pg_advisory_lock(1,42)`, session B's `SET
lock_timeout='1500ms'; SELECT pg_advisory_lock(1,42);` returns `ERROR: canceling statement due to
lock timeout` after ~1.5 s. A scoped `statement_timeout` aborts it identically. Per
`openspec/config.yaml`'s correctness rule (verify against real upstream, cite a reproduction), the
false claim is removed everywhere it appeared (spec requirement "migration advisory-lock acquisition
is bounded and fails fast", design §3.2, task 2.2, acceptance C6), and the migration-lock requirement
is made mechanism-agnostic: the bound must be *proven by test*, and MAY use `lock_timeout`, a scoped
`statement_timeout`, or a `pg_try_advisory_lock` poll. Opus's own G7 verdict is otherwise honored
(the bound is real and needed); only its untested acceptance of the specific false mechanism-claim is
overridden by the reproduction.

### 6.2 Blocking findings applied

| Finding | Auditor | Resolution |
|---|---|---|
| lock_timeout claim is empirically false | Fable F1 (CONFIRMED, my re-test) | §6.1 above; claim removed; requirement made mechanism-agnostic; task 2.2 + C6 rewritten. |
| `withLease` no-callback default undefined | Fable F2 / Opus N5 | Pinned: default (no `onReleaseFault`) **rejects** with `LeaseFaultError`; callback path invokes it and resolves. Spec Req + scenarios, design §4.3, task 3.3, acceptance D8. |
| Durability probe is skippable | Fable F3 / Opus B2 | Probe now runs as a **mandatory step of `runMigrations`** (non-skippable), still directly callable. "Client SHALL NOT be used" → "`runMigrations` SHALL reject". Spec Req, design §2.1, task 1.1 (escape hatch removed). |
| `synchronous_commit` local/remote_write/remote_apply are NOT asynchronous | Opus B1 | Lost-tail warning scoped to `synchronous_commit=off` **only**; standby-oriented values treated as durable. Spec Req + new scenario, design §2.2 table, acceptance B2. |
| Manual-composition crash scenario unverified in-change | Fable F4 | (a) Scenario annotated in-spec as crash-verified by T5 (handoff A11); (b) task 0.4 / property extended to also drive the manual safe-ordering composition fault-free (new spec scenario "the fault-free property holds for both composition forms"; acceptance A9). |
| Unconditional cursor-invariant guarantee is untestable | Opus B3 / Fable NB1 | Lead SHALL rewritten to conditional **WHERE** form ("a conforming composition keeps the durable cursor from ever being ahead…"), with an explicit note that the library provides the means, not an unconditional guarantee against a hostile caller. |

### 6.3 Non-blocking findings applied

- **Unmeasurable "generous enough" clause** (Fable NB2 / Opus N1) — removed from the timeouts
  requirement; concrete default values moved to design §3.1 as rationale; requirement fixes only
  *non-zero + overridable*.
- **Poetic non-testable SHALL** ("the doc half of what 'durable' means", Fable NB3 / Opus N7) — dropped
  from the Durability Contract requirement and design §2.4; the enumerated-settings scenario carries
  the acceptance.
- **id-validation false equivalence** (Fable NB4) — requirement + design §4.1 now say the envelope's
  pattern *extended with a `.max()` length bound* (the envelope has none), and pin the bound at `512`
  (frozen at G1) rather than "e.g. 512".
- **`idle_in_transaction_session_timeout` × lease/transaction interaction** (Opus N3) — added a
  requirement clause + design §3.1 note + a spec scenario ("a raised idle-in-transaction default is
  honoured…") covering the lease/`withTransaction` compatibility `02` F10 called out.
- **Implementation prescribed inside requirements** (Opus N4) — the JsonValueSchema requirement now
  states the observable outcome (reject before recursive parse / no stack overflow / one shared `64`
  constant) with the `exceedsMaxDepth`/preprocess mechanism moved to design §4.2; the migration-lock
  requirement is mechanism-agnostic (§6.1).
- **ADDED vs MODIFIED framing** (Opus N6) — kept ADDED (no archived base to delta against, matches
  Sprint 4), with the archival-reconciliation plan recorded in §5.1.
- **Cross-ref typo** (Fable NB7) — the old "settled in task 2.1" pointer is gone (the wiring is now
  pinned in §2.1, not deferred to a task).

### 6.4 Non-blocking findings NOT changed (with reasoning — no finding rejected)

- **Compound requirements** (Fable NB5 / Opus N2) — "save accepts and joins a caller-supplied
  transaction handle" (and two others) bundle several EARS clauses. Both auditors call this
  *convention-consistent* with Sprint 4 (whose "a caller-supplied transaction handle is honored"
  bundles SHALL + IF/THEN) and *acceptable*; each clause is independently well-formed and has its own
  scenario. Left as-is to match the archived-sprint house style; this is an acknowledged
  non-blocking observation, not a rejected fix.
- **`acceptance.md` is a new artifact type** (Fable NB6) — retained as a program-level consolidation
  (E7 guards drift); `tasks.md` remains authoritative for per-task acceptance, and each acceptance row
  traces to a spec requirement. Both auditors judged it useful, not a defect.
