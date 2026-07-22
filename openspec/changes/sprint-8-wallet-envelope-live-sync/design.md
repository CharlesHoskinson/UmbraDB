# Design — Sprint 8: WalletState Envelope + Live Preprod DB-Sync + Cold-Boot Recovery

Source of truth for the decisions below is `design/sprint-5-recommendation.md` (twice independently
audited) and the Sprint 7 change it was translated into
(`openspec/changes/sprint-7-transaction-history-storage/{proposal,design}.md`). This document
restates and *closes* the two deliverables Sprint 7 left as design questions (the envelope, §5;
the live tier, §7), adds the adapter seam Sprint 7 did not specify, and carries the schema/API and
test-tier detail the recommendation left to the EARS-spec stage. Every external SDK claim below is
cited to a real file:line in the currently-cloned `midnight-wallet` (HEAD
`e744d994fc94d7770fbd2c802d7bd4480cce83db`), per this repo's correctness rule
(`openspec/config.yaml`).

## 1. Envelope decision: (a) one versioned envelope — DECIDED

The recommendation (§1 module 2) left two ways to reconcile "three sub-wallets, each with its own
independent `serializeState()`/`.restore()` and its own distinct snapshot schema" against
`CheckpointStore.save`, which takes exactly **one** `Uint8Array` per `(walletId, networkId)` call
(`src/interfaces/checkpoint-store.ts:142`):

- **(a) One versioned envelope [CHOSEN]** — wrap all three sub-wallet serialized strings plus a
  schema-version tag into one JSON object, encode it to a `Uint8Array`, and persist it with a
  single `CheckpointStore.save(walletId, networkId, bytes)` call.
- **(b) Three coordinated checkpoints** — one `CheckpointStore.save` per sub-wallet, namespaced by
  sub-wallet type under the same `walletId`.

**Decision: (a).** Rationale, precisely:

1. **It is one atomic unit of persistence.** `CheckpointStore` is content-addressed and composes
   the Transaction/Lease layer internally so a `save` is all-or-nothing
   (`src/interfaces/checkpoint-store.ts:119-136`). One envelope → one `save` → either all three
   sub-wallet strings are durable together or none are. No torn write can leave shielded persisted
   but dust not.
2. **It sidesteps the cross-checkpoint reconciliation (b) would force.** With (b), three separate
   checkpoint sequences advance independently; "restore all three consistently" then has to define
   what happens when one sub-wallet's newest checkpoint is at a different sequence than another's,
   plus a per-sub-wallet `prune`/GC-retention interaction. (a) collapses that to a single sequence
   per `(walletId, networkId)`, so `load()` of the latest envelope is unambiguous.
3. **It matches the SDK's own reference-usage granularity.** The testkit's `saveState`
   (`wallet-sdk-testkit/src/wallet.ts:215-249`) already treats the three sub-wallet strings as a
   set persisted together (three files, one call site, `wallet.shielded.serializeState()` /
   `wallet.unshielded.serializeState()` / `wallet.dust.serializeState()` at `:223-227`). The
   envelope is the single-blob analogue of that same set.

**What (a) explicitly does NOT buy:** it does not make the three captured sub-wallet states mutually
consistent as of the same block height — they sync on independent subscriptions, so a given
envelope can hold three states at three heights. That is §5's accepted weaker contract, not
something atomicity resolves for free (recommendation §1's explicit correction of the earlier
"consistency for free" overclaim).

### 1.1 Envelope shape

```
WalletStateEnvelope (JSON, then UTF-8 → Uint8Array for CheckpointStore.save):
{
  "envelopeVersion": 1,              // schema-version tag; bumped on any breaking shape change
  "walletId":  "<string>",           // echoed for defensive cross-check against the load key
  "networkId": "<string>",           // e.g. "PreProd"; echoed likewise
  "subWallets": {
    "shielded":   "<serializeState() string>" | null,
    "unshielded": "<serializeState() string>" | null,
    "dust":       "<serializeState() string>" | null
  }
}
```

- The three sub-wallet values are the SDK's **opaque** serialized strings — the envelope never
  parses their internal schema (which is the sub-wallet's own concern:
  `shielded-wallet/src/v1/Serialization.ts:66-119` returns a `JSON.stringify` of a `ZswapLocalState`
  hex snapshot; `unshielded-wallet/src/v1/Serialization.ts:43-90` a UTXO-array snapshot;
  `dust-wallet/src/v1/Serialization.ts:62-114` a `DustLocalState` hex snapshot — three genuinely
  different schemas). The envelope treats each as a length-checked opaque string.
- A sub-wallet value MAY be `null` when that sub-wallet was not exercised — the live preprod
  tier syncs only the **unshielded** wallet (the funded balance is unshielded;
  `preprod-connection.md` "Sync cost"), so its envelope carries `unshielded` populated and
  `shielded`/`dust` `null`. The restore path skips a `null` sub-wallet (spec: WHERE-optional
  requirement). **F7 wording fix:** "absent" here means the JSON VALUE is `null`, never that the
  `shielded`/`unshielded`/`dust` KEY itself is physically omitted from the object — the schema
  (`WalletStateEnvelopeShapeSchema`, now `.strict()`, F7) requires all three keys present on every
  decode, and `encode` always emits all three explicitly. This is deliberately fail-closed: a
  never-exercised sub-wallet is represented, not left ambiguous between "never touched" and "the
  encoder forgot a key."
- `envelopeVersion` is checked on load: an unrecognized version is a typed rejection, never a
  best-effort restore of an unknown shape (spec: IF-unwanted requirement). This is the forward
  seam for the future `verifiable-snapshot-recovery` hardening layer, which will add anchor/finality
  fields under a bumped version rather than mutating v1.

## 2. Module layout and dependency direction

- `src/interfaces/wallet-state-envelope.ts` — the `WalletStateEnvelope` type, its Zod schema, the
  `envelopeVersion` constant, and the encode/decode contract (`encode(envelope) → Uint8Array`,
  `decode(bytes) → WalletStateEnvelope`). **No wallet-SDK import** — the sub-wallet strings are
  typed as opaque `string`, exactly as `CheckpointStore` treats its payload as opaque bytes.
- `src/postgres/wallet-state-envelope.ts` — `PgWalletStateEnvelopeStore`, a thin wrapper over an
  injected `CheckpointStore` (`src/interfaces/checkpoint-store.ts`): `save(walletId, networkId,
  envelope)` encodes and calls `CheckpointStore.save`; `load(walletId, networkId, sequence?)` calls
  `CheckpointStore.load` and decodes + version-checks the result's `.data`
  (`src/interfaces/checkpoint-store.ts:154-157`). It adds **no** new table — it reuses
  CheckpointStore's chunk/manifest storage, so there is no migration in this sprint.
- The **adapter** (§3) lives in the `test/`/integration tier, not `src/`. It is the only Sprint 8
  code that imports SDK types. This keeps the owner's boundary rule intact: `src/postgres/*` and
  `src/interfaces/*` never import `@midnightntwrk/*` at runtime
  (`sprint-7-transaction-history-storage/design.md` §2; enforced for the storage module by
  Sprint 7's own "no wallet-SDK runtime import" requirement, extended here to the envelope module).

## 3. The adapter (the seam)

The SDK's `configuration.txHistoryStorage` slot expects an object implementing the SDK's
`TransactionHistoryStorage<T>` (`TransactionHistoryStorage.ts:215-216`), whose reader is
`getAll()/get(hash)/serialize()` (`:163-167`) and whose writer is
`gotPending/gotFinalized/gotRejected` (`:183-196`). UmbraDB's `PgTransactionHistoryStorage`
(Sprint 7) implements a **structurally mirrored** interface
(`src/interfaces/transaction-history-storage.ts:299-300`) but is deliberately *not* the SDK type.
The adapter is the object handed to the SDK; it forwards to a `PgTransactionHistoryStorage`
instance constructed with the caller-supplied merge function -- an UmbraDB-shaped merge function
mirroring the real SDK's `mergeWalletEntries` documented semantics, **not the raw SDK function
itself** (`referenceMergeEntries`, `test/postgres/reference-merge.ts`, injected by BOTH the
Pg-only conformance tier and the live preprod tier). **Audit correction (F1):** the raw
`mergeWalletEntries` (`~/repos/midnight-wallet/packages/facade/src/index.ts`) cannot be injected
here at all -- it operates on the SDK's own `WalletEntry` shape (top-level
`shielded`/`unshielded`/`dust`), a different shape from UmbraDB's `sections`-container
`TransactionHistoryEntry`, and its first line (`[...existing.identifiers]`) throws a `TypeError`
if ever called with `existing===undefined` (the first write of a hash). `PgTransactionHistoryStorage`
now never calls the injected merge function on a first write (§3.3 below, and
`src/interfaces/transaction-history-storage.ts`'s `MergeEntriesFn` doc) precisely because of this.

The proven wiring the adapter plugs into (`preprodUnshieldedSync.manual.integration.test.ts:88-95`):

```ts
const config: DefaultV1Configuration = {
  networkId: NetworkId.NetworkId.PreProd,
  indexerClientConnection: { indexerHttpUrl: …, indexerWsUrl: … },
  txHistoryStorage: adapter,           // ← was: new InMemoryTransactionHistoryStorage(schema)
};
```

### 3.1 Field mapping (write path)

The SDK writer inputs are the entry **minus** its `lifecycle`, plus a per-status detail field
(`TransactionHistoryStorage.ts:135-157`):

| SDK input                    | extra field                                   | UmbraDB `got*` (`Omit<Entry,'lifecycle'>`) |
|------------------------------|-----------------------------------------------|--------------------------------------------|
| `PendingEntryInput`          | `submittedAt: Date`                           | `gotPending(entry)`                        |
| `FinalizedEntryInput`        | `finalizedBlock: {hash, height, timestamp}`   | `gotFinalized(entry)`                      |
| `RejectedEntryInput`         | `rejectedAt: Date`, `reason?: string`         | `gotRejected(entry)`                       |

The common fields (`hash`, `identifiers`, `protocolVersion?`, `status?`, `timestamp?: Date`,
`fees?: bigint|null`) map one-to-one onto UmbraDB's `TransactionHistoryEntry`
(`src/interfaces/transaction-history-storage.ts:219-228`) — including the round-trip-critical
`timestamp:Date`/`fees:bigint` fields Sprint 7's "getAll returns live bigint/Date" requirement
exists for. The SDK's wallet-specific `sections` (`shielded`/`unshielded`/`dust`, produced by
`extendEntrySchema`, `TransactionHistoryStorage.ts:99-105`) map onto UmbraDB's opaque
`sections: Record<string, EntryContent>` (`:227`).

### 3.2 Lifecycle-detail fidelity — the correctness-gate open question

UmbraDB's Sprint-7 entry models `lifecycle` as a **bare** discriminated union `{status:
"pending"|"finalized"|"rejected"}` (`src/interfaces/transaction-history-storage.ts:166-178`) —
it carries **no** `submittedAt` / `finalizedBlock` / `rejectedAt` / `reason`. The real SDK
lifecycle carries all of them (`TransactionHistoryStorage.ts:23-63`). So on read-back, the adapter
must reconstruct a **schema-valid** SDK lifecycle object, and the per-status detail has to come
from *somewhere* UmbraDB persisted it.

Two mappings, and the choice is a genuine correctness-gate question this sprint surfaces (not
resolves blindly):

- **(i) Preserve full lifecycle detail** — the adapter stashes `submittedAt`/`finalizedBlock`/
  `rejectedAt`/`reason` into a dedicated key inside UmbraDB's opaque `sections`. **(F2 fix)** That
  key is the adapter's OWN reserved key `UMBRADB_ADAPTER_LIFECYCLE_DETAIL_KEY =
  "__umbradb_adapter_lifecycle_detail"` under the reserved prefix `UMBRADB_ADAPTER_RESERVED_KEY_PREFIX
  = "__umbradb_adapter_"`; the adapter REJECTS (typed `ValidationError`, before any DB write) any
  incoming SDK section whose key shares that prefix, so a caller can never collide with or clobber the
  stash — an earlier draft used a bare, unreserved `"__lifecycleDetail"` key that offered no such
  protection (the panel's F2 blocker). On read, the stash is Zod-validated before use and a malformed
  stash raises a typed per-hash `SerializationFailedError`, never a silently invalid SDK lifecycle.
  The adapter reconstructs the SDK lifecycle on `getAll()`. This makes the adapter's `getAll()` yield
  entries that decode cleanly against the SDK's own Effect-Schema — required if any consumer
  re-parses them.
- **(ii) Preserve only `status`** — accept that UmbraDB's authoritative record is `status` +
  common fields, and reconstruct a lifecycle with synthesized/placeholder detail (or none) on
  read-back. Cheaper, but a `getAll()` result may not decode against the SDK's strict schema, and a
  `finalizedBlock.height` a downstream consumer expected would be gone.

**Recommendation: (i)**, because the live-sync and cold-boot tests assert against a real SDK entry
(`b194e71d…493341`, finalized at block 1,763,274 — `finalizedBlock.height` is exactly the sort of
field a real assertion or a future verifiable-recovery anchor would read). The spec makes (i)
binding (the "lifecycle detail must round-trip" unwanted-behavior requirement) and records (ii) as
the rejected alternative. **This is one of the two biggest open questions for the correctness
gate:** whether functional resume genuinely *requires* byte-faithful `finalizedBlock` reconstruction,
or whether UmbraDB's authoritative-`getAll` + `status` is sufficient for the SDK to resume — to be
confirmed against a real cold-boot run, not asserted from the schema alone.

### 3.3 No runtime SDK import in core

The adapter imports SDK types; `PgTransactionHistoryStorage` and `PgWalletStateEnvelopeStore` do
not. The merge function (an UmbraDB-shaped function mirroring `mergeWalletEntries`' documented
semantics -- **not** the raw SDK function itself, per the F1 correction above) is injected into
`PgTransactionHistoryStorage` at construction (`src/interfaces/transaction-history-storage.ts:256-259`,
`sprint-7-transaction-history-storage/design.md` §2), so even the production merge policy reaches
the storage module as an injected function, never as an import -- and never the raw SDK symbol
either way.

**F1 fix (also see `MergeEntriesFn`'s own doc):** `PgTransactionHistoryStorage.writeRows` now
calls the injected merge function ONLY when a row already exists for the hash; a first write is
persisted verbatim, never passed through the merge function at all. This is what makes it safe
for production to inject a merge function whose contract assumes both operands are always
defined (mirroring the real SDK's own `mergeWalletEntries`), without ever risking a call with
`existing===undefined`.

**F1(c) parity test (`test/postgres/reference-merge-parity.test.ts`):** proves
`referenceMergeEntries` mirrors `mergeWalletEntries`' documented semantics on SECOND-write
fixtures (identifier union+dedupe; first-writer-wins scalar facts; incoming-wins lifecycle;
per-section merge-when-both-present, present-side-otherwise). A REAL runtime diff was achieved for
this fix, not just the source-faithful fallback: the facade package (`@midnightntwrk/wallet-sdk-
facade`) has no `build` script, but its `dist` script (`tsc -b ./tsconfig.build.json`) built
cleanly once its then-missing workspace dependencies (`@midnightntwrk/wallet-sdk-dust-wallet`,
`@midnightntwrk/wallet-sdk-shielded`) were built first via the same script — well under the ~10
minute budget. The test's `describe.skipIf(!facadeMergeAvailable())`-gated block dynamically
imports the real `mergeWalletEntries` + `mergeUnshieldedSections` from that now-built dist
(`test/integration/live-fixtures/facade-merge-loader.ts`, mirroring `midnight-wallet-sdk-loader.ts`'s
own absolute-path/computed-specifier pattern) and diffs their output against
`referenceMergeEntries`'s output on translated inputs — an actual equality assertion between the
real SDK function and this project's own stand-in, not merely a resemblance argument. The
UNCONDITIONAL half of the same test file (no external dependency) additionally encodes every rule
as an explicit, source-cited assertion, so the parity claim still has a required-gate-safe
guarantee in any environment where the sibling `midnight-wallet` checkout is not built (a fresh
clone, CI) — that half degrades to being the sole evidence there, exactly as the "fall back to a
source-faithful rule test" instruction anticipates for a facade-no-dist environment, even though in
THIS pass the facade did build.

### 3.4 serialize() is a diagnostic dump, not a migration path (F10)

`PgTransactionHistoryStorage.serialize()` -- forwarded verbatim by the adapter's own `serialize()`
-- returns UmbraDB-shaped JSON (this storage layer's own documented bigint/Date tagging scheme), a
diagnostic dump of `getAll()`'s output, **not** a re-encoding into the SDK's own entry shape.
Postgres (via `PgTransactionHistoryStorage`'s own table) is the durable, authoritative store; this
method exists only to satisfy the SDK's `TransactionHistoryReader.serialize(): Promise<string>`
contract structurally. **The SDK core never calls `serialize()` on the injected storage** -- its
own `TransactionHistoryStorage` consumers call only `get`/`getAll`/`gotPending`/`gotFinalized`/
`gotRejected` (verified ground truth, `unshielded-wallet` + `facade` packages) -- so this method's
specific output shape is never load-bearing for wallet sync itself, only for an operator-invoked
diagnostic dump. Whether a future migration path from this Postgres-backed storage to an
in-memory (or different-backend) `TransactionHistoryStorage` implementation should read this
method's output, or read the table directly, is an explicit **Sprint 9 decision**, not resolved
here.

## 4. Live preprod DB-sync verification (nightly/labeled)

Reuses the **proven** wiring (`preprodUnshieldedSync.manual.integration.test.ts`), changing exactly
one thing: `config.txHistoryStorage` becomes the adapter (over `PgTransactionHistoryStorage`)
instead of `InMemoryTransactionHistoryStorage` (`:94`). The rest is unchanged and known-good:

1. Derive the unshielded key from `~/.midnight-preprod-wallet.seed` — `HDWallet.fromSeed →
   selectAccount(0) → selectRole(Roles.NightExternal) → deriveKeyAt(0)` (`:58-68`).
2. `UnshieldedWallet(config).startWithPublicKey(publicKey)` then `wallet.start()` (`:105,116`).
3. Wait for `availableCoins.length > 0` **then** `waitForSyncedState()` (`:121-122`) — a fresh
   wallet can report strictly-complete before the coin-bearing tx applies (`AUTONOMOUS_RUN_LOG.md:240-242`).
4. Assert `balances[nativeToken] === 1_000_000_000n` (1000 tNIGHT, `:144`) **and** — the new
   assertion this sprint adds — that `await adapter.getAll()` (the read routed through the adapter's
   own reconstruction path, F3 fix, not a raw `PgTransactionHistoryStorage` instance) contains a
   UmbraDB row for tx `b194e71d…493341` with the faucet identifier `00ea17cf…20bea`, reconstructed to
   a real finalized SDK lifecycle (`finalizedBlock.height = 1763274`, confirmed live 2026-07-22).
   **This DB row is the "verify the DB syncs" proof, and it exercises the adapter's reconstruction
   surface end-to-end against a real on-chain entry.**

UmbraDB's own code stays agnostic to how the data arrived (indexer WS): the adapter receives
already-scanned entries via the SDK's `got*` calls, exactly as the boundary rule requires
(`sprint-7-transaction-history-storage/design.md` §2, §7). Only test infrastructure references the
public preprod endpoints (`design/environment/preprod-connection.md`).

Never a required gate: real network, real sync, a funded seed that must not be in CI. Nightly/labeled
at most (`sprint-7-transaction-history-storage/design.md` §7's final constraint).

## 5. Cold-boot recovery, and the cross-sub-wallet consistency contract

The cold-boot test (nightly/labeled, recommendation §2 scenario 2) is the functional-recovery proof:

1. Sync as in §4 (a genuinely synced wallet).
2. Serialize each exercised sub-wallet — for the preprod case, `unshielded.serializeState()`
   (`RunningV1Variant.ts:245`; `shielded`/`dust` `null`).
3. Build the envelope (§1.1), `PgWalletStateEnvelopeStore.save(walletId, "PreProd", envelope)` →
   one `CheckpointStore.save` into Postgres.
4. Destroy the wallet instance and the process.
5. Fresh process: `PgWalletStateEnvelopeStore.load(walletId, "PreProd")` → decode + version-check →
   restore each non-`null` sub-wallet via its `deserializeState`/`.restore` (`V1Builder.ts`).
6. Tx-history is read back **through `adapterAfterRestart.getAll()`** (F3 fix) — the underlying
   `PgTransactionHistoryStorage` remains **authoritative** (below); one deliberately-kept raw
   `pgStorageAfterRestart.getAll()` pre-restore read proves row-presence-without-resync independent of
   the adapter.
7. Assert: (a) resume **without a full resync** (the restored unshielded wallet's progress cursor
   comes from its snapshot, `unshielded-wallet/src/v1/Serialization.ts:81-83`'s `appliedId`, so it
   does not rescan from genesis — confirmed live `appliedId = 505701n`); (b) **tx-history continuity**
   — the `b194e71d…` row is present from `adapterAfterRestart.getAll()` after the cold boot, with no
   resync required to see it.

**Authoritative-tx-history-on-restore rule (binding):** `PgTransactionHistoryStorage.getAll()` is
the authoritative source of tx-history on restore — **not** the tx-history copy embedded inside a
sub-wallet's own restored snapshot. Each sub-wallet's serialized blob also embeds its own internal
notion of history alongside local state and progress; on restore, that embedded copy is superseded
by whatever `getAll()` returns (recommendation §1 "Why this isn't redundant"; Sprint 7 `design.md`
§5). The envelope carries only enough to resume the sub-wallet's *subscription* (keys, UTXOs,
progress cursor). This is why the cold-boot assertion checks continuity against the Pg store
specifically, not against the restored blob's own internal history.

**Cross-sub-wallet consistency — accepted weaker contract (binding):** the three sub-wallet
snapshots in one envelope sync independently and may be captured at different block heights. This
sprint accepts, and the spec states as binding text, the weaker contract: *"each sub-wallet resumes
its own sync from its own last-known point; the three are bundled into one save/load call for
operational atomicity only — the envelope guarantees the bundle is persisted and restored as a unit,
not that its three members are mutually consistent as of one height."* (recommendation §3 open
question 5; Sprint 7 `design.md` §6.2 default (a)). **This is the second of the two biggest open
questions for the correctness gate:** whether that weaker contract is actually safe for a real
three-sub-wallet wallet — i.e. whether restoring three independently-checkpointed states together can
ever surface a transient wrong balance / double-count that the authoritative-`getAll` rule does not
fully paper over. It is safe by construction for the preprod unshielded-only case (one sub-wallet),
which is what this sprint proves; the multi-sub-wallet safety argument is deferred to the
`verifiable-snapshot-recovery` feature that will add same-height anchoring.

## 6. Relationship to the future verifiable-snapshot-recovery feature

Sprint 8 is the **functional** layer: it proves the DB syncs and a wallet resumes off it. The
separate `verifiable-snapshot-recovery` feature (`AUTONOMOUS_RUN_LOG.md:196-224`) is the
**trust-minimized** layer that will sit on top: anchoring a snapshot to on-chain state
(zswap/dust merkle roots, or a Compact ZK attestation of `hash(snapshot)` bound to the wallet key +
block N), verifying finality/completeness/seed-binding on restore instead of trusting the DB. The
envelope's `envelopeVersion` tag (§1.1) is the seam: that feature adds anchor fields under a bumped
version, so Sprint 8's v1 contract is not re-opened. Sprint 8 deliberately does **not** implement
any of it.

## 7. Testing strategy (post-implementation)

Four tiers. The **required merge gate** is Pg-only (a plain Postgres container, no wallet SDK sync,
no devnet), matching every other UmbraDB module's pre-merge bar. The live-sync and cold-boot tiers
are **nightly/labeled** (real preprod, funded seed, built SDK). Each test names the EARS requirement
it maps to (`specs/wallet-state-envelope/spec.md`).

### 7.1 Unit / property (Pg-only, required gate) — `test:conformance`

- **Envelope round-trip (unit).** `encode` then `decode` returns an equivalent envelope; the three
  opaque sub-wallet strings survive byte-for-byte. → *"envelope wraps three strings + version"*,
  *"encode/decode is lossless"*.
- **Envelope property test (fast-check).** For arbitrary `{shielded?, unshielded?, dust?}` opaque
  strings and arbitrary `walletId`/`networkId`, `decode(encode(x)) ≡ x`, and any sub-wallet may be
  absent/`null`. → *"a sub-wallet may be absent"* (WHERE-optional), *"encode/decode is lossless"*.
- **Version guard (unit).** `decode` of an envelope tagged with an unrecognized `envelopeVersion`
  rejects with the typed envelope error; a corrupt/non-JSON payload rejects likewise, never a
  best-effort restore. → *"an unrecognized envelopeVersion is rejected"* (IF-unwanted), *"a corrupt
  envelope is rejected"* (IF-unwanted).
- **Save/load round-trip against real Postgres (integration-lite, Pg container only).**
  `PgWalletStateEnvelopeStore.save` then `load` (latest, and by explicit sequence) returns the same
  envelope; a `load` for a `(walletId, networkId)` never saved rejects with `CheckpointNotFoundError`
  (surfaced from `CheckpointStore.load`, `src/interfaces/checkpoint-store.ts:148`). → *"save then
  load returns the same envelope"* (event-driven), *"load of a never-saved wallet is a typed
  not-found"* (IF-unwanted).
- **Adapter seam round-trip (Pg container only, no live wallet).** Drive a **scripted** sequence of
  SDK-shaped `gotPending`/`gotFinalized`/`gotRejected` inputs (fixture data, carrying real
  `submittedAt`/`finalizedBlock`/`rejectedAt`) through the adapter into `PgTransactionHistoryStorage`,
  then `getAll()`; assert every returned entry is a **schema-valid SDK entry** with its lifecycle
  detail reconstructed (decodes against the SDK's `TransactionHistoryEntryCommonSchema`,
  `TransactionHistoryStorage.ts:75-85`). → *"the adapter backs txHistoryStorage with Postgres"*
  (ubiquitous), *"lifecycle detail round-trips so getAll yields schema-valid SDK entries"*
  (IF-unwanted). Reuses Sprint 7's `referenceMergeEntries` test double
  (`test/postgres/reference-merge.ts`) so no `@midnightntwrk/*` runtime import is needed for the
  merge policy.
- **No-runtime-SDK-import guard (unit).** Inspect `src/postgres/wallet-state-envelope.ts` and
  `src/interfaces/wallet-state-envelope.ts` runtime imports; none resolve to `@midnightntwrk/*`. →
  *"the envelope module has no wallet-SDK runtime import"* (ubiquitous). (Mirrors Sprint 7's
  equivalent guard for the storage module.)

### 7.2 Live preprod DB-sync (nightly/labeled) — `test:live`

- **DB-sync materialization (integration).** §4: sync the funded unshielded wallet against public
  preprod with the adapter injected; assert `balances[nativeToken] === 1_000_000_000n` **and** the
  `b194e71d…493341` row is present via `adapter.getAll()` (F3: routed through the adapter's
  reconstruction path, reconstructed to a real finalized SDK lifecycle). → *"a synced transaction
  materializes as a Postgres row"* (event-driven), *"tx-history reads authoritative from the Pg
  store"* (state-driven).

### 7.3 Cold-boot recovery (nightly/labeled) — `test:live`

- **Cold-boot resume (integration).** §5: sync → serialize → envelope → `save` → destroy → fresh
  process → `load` → restore → `getAll()`. Assert resume **without full resync** and **tx-history
  continuity** off the Pg store. → *"the envelope is persisted with a single CheckpointStore.save"*
  (event-driven), *"restore resumes each sub-wallet from its own last point"* (state-driven, the
  accepted weaker contract), *"tx-history on restore is authoritative from the Pg store, not the
  blob"* (state-driven), *"a sub-wallet absent from the envelope is skipped on restore"*
  (WHERE-optional).

### 7.4 Required-gate vs nightly split (binding)

- **Required merge gate (`npm run test:conformance`):** every §7.1 test — Pg container only, no
  wallet SDK, no devnet, deterministic. Same bar as every other UmbraDB module.
- **Nightly/labeled (`npm run test:live`):** §7.2 and §7.3 — real preprod, funded seed, built SDK
  checkout. Never blocks a PR merge (`sprint-7-transaction-history-storage/design.md` §7's
  constraint). Image/endpoint/commit pins recorded per `tasks.md` Phase 1.
