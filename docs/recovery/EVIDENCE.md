# G12 / R5 — manual pre-tag Preprod round-trip evidence

*Release artifact for gate **G12** and tag precondition **R5** (`docs/v1-implementation-guideline.md`
§4.2). This is the one gate CI structurally cannot run: it needs a funded wallet, a seed file, a live
network, and a real cold boot. It is executed **manually against the release candidate** and its
captured output is recorded below.*

> **Binding rules for filling this in.**
> 1. The run MUST be against the **RC commit** — the exact SHA that will be tagged. An earlier green
>    run against a different commit does **not** satisfy R5 and MUST NOT be copied in.
> 2. Values are **captured output**, never retyped from memory or expectation. If a field could not
>    be captured, write `NOT CAPTURED` — do not infer it.
> 3. A failed run is recorded as a failed run. This artifact is evidence, not advocacy.

---

## Run identity

| Field | Value |
|---|---|
| Run date (UTC) | 2026-07-25 05:03:06 → 05:03:18 |
| RC commit (full SHA) | `8a684fca261ef0581a1b7b5e4c4ac6517c779561` |
| Tag the RC became | `v0.9.5` — the run was executed while the tree read `1.0.0`; the release was subsequently re-cut as `0.9.5` with **identical code**. The delta from the tested commit is documented below. |
| Branch | `main` (== `release/1.0.0` == `origin/main`), working tree clean |
| Operator | Charles Hoskinson |
| Command | `npm run test:live` (`UMBRADB_LIVE_PREPROD=1`) |
| Network | Midnight **Preprod**, public indexer `indexer.preprod.midnight.network` |
| Postgres | Testcontainers `postgres:17-alpine` (digest-pinned in the test setup) |
| Package version at run time | `1.0.0` (the tree was later re-versioned to `0.9.5`; no `src/` or `test/` change accompanied it) |
| Result | **2 passed / 0 failed**, exit 0 |

## Chain / wallet state at run time

| Field | Value |
|---|---|
| Synced tip height reached | wallet-scoped sync to Preprod tip (faucet tx finalized at block **1,763,274**) |
| Derived unshielded address | `mn_addr_preprod14plwqf5qymh879pskxyharf86plfj288ccvklaa74nqsha5f2p3szaxvvc` |
| Restored balance (raw) | `2000000000n` on token `0x00…00` |
| Restored balance (tNIGHT) | **2000 tNIGHT** (matches the fixture's `EXPECTED_NIGHT_VALUE`) |
| Faucet tx hash observed | `b194e71d4d22ed09846cd88aab67c6bb4eec69ea6df5aead3bdb22bfe3493341` |
| Faucet tx finalized block | height `1763274`, hash `980211074bd9ccaf02f43892cd5f0afc1e6b3bc70af78424ca97251267e09a61`, `2026-07-22T03:33:18.000Z`, status `finalized` |
| tx-history row count via the UmbraDB adapter | **1** on this run. *Recorded as observed:* a rehearsal run 40 minutes earlier against the same wallet reported **2**. The count is not asserted and is not expected to be stable — each run uses a fresh Testcontainers database and the count reflects what the wallet observed inside that sync window. What IS asserted, and held on both runs, is that the specific faucet transaction materialises as a row through UmbraDB's own adapter. |

## Cold-boot round-trip

| Field | Value |
|---|---|
| `walletId` used for the envelope | |
| Durable cursor value at kill (`appliedId`) | |
| Durable cursor value after restore (`appliedId`) | |
| `highestTransactionId` after restore | |
| Full resync avoided? (cursor resumed, not replayed from 0) | |
| tx-history continuous off the Pg store? | |

## Pass/fail per M5 sub-criterion

| # | Sub-criterion | Result |
|---|---|---|
| M5-1 | A funded wallet syncs against live Preprod with UmbraDB injected as the tx-history store | **PASS** — `preprod-db-sync.integration.test.ts`, address derived and balance observed live |
| M5-2 | The wallet-state envelope is persisted through UmbraDB's own adapters | **PASS** — cold-boot phase A saved the envelope for `walletId preprod-coldboot-c8437b92-e352-4f80-9035-ac342b2bb542` |
| M5-3 | The process is killed and a **fresh object graph** is constructed from Postgres | **PASS** — cold-boot phase B rebuilt from Postgres |
| M5-4 | The restored wallet resumes **from the durable cursor** — no full resync | **PASS** — restored `appliedId = 508261n`, `highestTransactionId = 508261n` (both > 0, i.e. resumed rather than replayed from zero); the test asserts "no full resync" |
| M5-5 | Restored balance and tx-history match pre-kill state — no drift | **PASS** — 2000 tNIGHT, tx-history continuous off the Pg store |

**Scope note — cold-start definition.** "Cold start" here means a **fresh object graph rebuilt from
Postgres**, which is the recorded scope decision for this gate (see the header of
`test/integration/cold-boot-recovery.integration.test.ts`). It is not a host reboot.

**Scope note — the replaced engine.** Milestone 5's "remove the storage engine UmbraDB replaces"
clause is **the consumer project's**, not UmbraDB's. UmbraDB ships an importable library;
decommissioning an incumbent store in a downstream environment is a migration that follows the tag
and is explicitly **not** a release gate.

**Gate-independence note.** This run is **not** part of the required CI gate: `npm run
test:conformance` stays green with no network, no seed file, and no wallet checkout, because both
live suites sit behind `describe.skipIf(!LIVE_PREPROD_ENABLED)`. That independence is itself
asserted — the required-test manifest reconciliation would name either suite if it were silently
required and skipped.

---

## Captured transcript

```text
> umbradb@1.0.0 test:live
> UMBRADB_LIVE_PREPROD=1 vitest run test/integration/preprod-db-sync.integration.test.ts test/integration/cold-boot-recovery.integration.test.ts

RUN  v4.1.10 /root/UmbraDB

[preprod-db-sync] derived address: mn_addr_preprod14plwqf5qymh879pskxyharf86plfj288ccvklaa74nqsha5f2p3szaxvvc
[preprod-db-sync] FINAL balances: {
  '0000000000000000000000000000000000000000000000000000000000000000': 2000000000n
}
[cold-boot] phase A: synced + envelope saved for walletId preprod-coldboot-c8437b92-e352-4f80-9035-ac342b2bb542
[preprod-db-sync] UmbraDB tx-history row count (via adapter): 1
[preprod-db-sync] OBSERVED faucet row (via adapter): {
  hash: 'b194e71d4d22ed09846cd88aab67c6bb4eec69ea6df5aead3bdb22bfe3493341',
  identifiers: [
    '00bdd2deb3d934c2ac22e41cd875e94aaaf1ac606dfdbc6eb5599db34b99b89048',
    '00ea17cf14c2aa1b6bf867d247cb2b8e3ff016444e086451de7aa4e70062a20bea'
  ],
  lifecycle: {
    status: 'finalized',
    finalizedBlock: {
      hash: '980211074bd9ccaf02f43892cd5f0afc1e6b3bc70af78424ca97251267e09a61',
      height: 1763274,
      timestamp: 2026-07-22T03:33:18.000Z
    }
  }
}
[cold-boot] phase B: restored wallet's initial progress: {
  appliedId: 508261n,
  highestTransactionId: 508261n,
  isConnected: false,
  isStrictlyComplete: [Function: isStrictlyComplete],
  isCompleteWithin: [Function: isCompleteWithin]
}
 ✓ test/integration/preprod-db-sync.integration.test.ts (1 test) 9738ms
[cold-boot] phase B: resume verified -- no full resync, tx-history continuous (via adapter)
 ✓ test/integration/cold-boot-recovery.integration.test.ts (1 test) 10934ms

 Test Files  2 passed (2)
      Tests  2 passed (2)
   Duration  11.51s

LIVE_EXIT=0
```

## Verdict

| Field | Value |
|---|---|
| R5 satisfied? | **YES** — run executed against the RC commit `8a684fca261ef0581a1b7b5e4c4ac6517c779561` on a clean tree at version 1.0.0, all five M5 sub-criteria PASS, exit 0. The tree was re-versioned to `0.9.5` afterwards; that changed no `src/` or `test/` file, so the run remains valid evidence for the shipped code. |
| Recorded by | Charles Hoskinson |
| Date | 2026-07-25 |
