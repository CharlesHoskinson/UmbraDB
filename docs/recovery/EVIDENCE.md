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
| Run date (UTC) | |
| RC commit (full SHA) | |
| Tag the RC became | |
| Branch | |
| Operator | |
| Command | `npm run test:live` (`UMBRADB_LIVE_PREPROD=1`) |
| Network | Midnight **Preprod**, public indexer `indexer.preprod.midnight.network` |
| Postgres | Testcontainers (pinned digest — record the tag/digest used) |

## Chain / wallet state at run time

| Field | Value |
|---|---|
| Synced tip height reached | |
| Derived unshielded address | |
| Restored balance (raw) | |
| Restored balance (tNIGHT) | |
| Faucet tx hash observed | |
| Faucet tx finalized block height | |
| tx-history row count via the UmbraDB adapter | |

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
| M5-1 | A funded wallet syncs against live Preprod with UmbraDB injected as the tx-history store | |
| M5-2 | The wallet-state envelope is persisted through UmbraDB's own adapters | |
| M5-3 | The process is killed and a **fresh object graph** is constructed from Postgres | |
| M5-4 | The restored wallet resumes **from the durable cursor** — no full resync | |
| M5-5 | Restored balance and tx-history match pre-kill state — no drift | |

**Scope note — cold-start definition.** "Cold start" here means a **fresh object graph rebuilt from
Postgres**, which is the recorded scope decision for this gate (see the header of
`test/integration/cold-boot-recovery.integration.test.ts`). It is not a host reboot.

**Scope note — the replaced engine.** Milestone 5's "remove the storage engine UmbraDB replaces"
clause is **the consumer project's**, not UmbraDB's. UmbraDB 1.0.0 ships a frozen, importable
library; decommissioning an incumbent store in a downstream environment is a migration that follows
the tag and is explicitly **not** a 1.0.0 gate.

**Gate-independence note.** This run is **not** part of the required CI gate: `npm run
test:conformance` stays green with no network, no seed file, and no wallet checkout, because both
live suites sit behind `describe.skipIf(!LIVE_PREPROD_ENABLED)`. That independence is itself
asserted — the required-test manifest reconciliation would name either suite if it were silently
required and skipped.

---

## Captured transcript

```text
(paste the verbatim `npm run test:live` output here — including the printed derived address,
FINAL balances, observed faucet row, and both cold-boot phase lines)
```

## Verdict

| Field | Value |
|---|---|
| R5 satisfied? | |
| Recorded by | |
| Date | |
