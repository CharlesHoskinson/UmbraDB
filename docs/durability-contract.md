# UmbraDB Durability Contract

*Binding deployer precondition (G6, `openspec/changes/v1.0.0-durable-checkpoint-cursor` design.md
§2.4). UmbraDB is a single trusted writer against one local PostgreSQL primary; its crash-safety
guarantees hold only when the server is configured as below. Some items are **enforced** by the
startup durability probe (`src/postgres/durability-probe.ts`, run as a mandatory step of
`runMigrations`) — a violation makes `runMigrations` reject before any migration runs; others are
**applied automatically** by `createClient`; the rest are **documented** requirements the deployer
must satisfy. Each row states which.*

This document is the durability-configuration contract only. The threat model and format-headroom
material live with the API/contract-docs change (G4) and `SECURITY.md` (G15).

---

## Summary

| Setting | Required value | How UmbraDB treats a bad value | Enforcement |
|---|---|---|---|
| `fsync` | `on` | `runMigrations` **rejects** with `DurabilityContractError` | **Probe-enforced** (refuse on `off`) |
| `full_page_writes` | `on` | `runMigrations` **rejects** with `DurabilityContractError`, unless the operator opts out | **Probe-enforced** (refuse on `off`; overridable) |
| `synchronous_commit` | `on` / `local` / `remote_write` / `remote_apply` | `off` → **lost-tail warning**, never a refusal | **Probe-warned** (never refused) |
| transaction pooling | session-mode only | a transaction pooler → `runMigrations` **rejects** with `TransactionPoolerDetectedError` | **Probe-enforced** (detected + refused) |
| `statement_timeout` | non-zero (default 120 000 ms) | set on every connection; overridable | **Applied by `createClient`** (documented) |
| `lock_timeout` | non-zero (default 30 000 ms) | set on every connection; overridable | **Applied by `createClient`** (documented) |
| `idle_in_transaction_session_timeout` | non-zero (default 120 000 ms) | set on every connection; overridable | **Applied by `createClient`** (documented) |

---

## 1. `fsync = on` — probe-enforced

`fsync = off` lets PostgreSQL skip flushing the WAL and data files to disk, so an OS crash or power
loss can leave the database **arbitrarily corrupted** — not merely missing a recent tail. UmbraDB's
whole durability model assumes a crash leaves a consistent (if slightly stale) database, so this is a
hard violation: `probeDurability` throws `DurabilityContractError` and `runMigrations` rejects before
running any migration. There is no override.

## 2. `full_page_writes = on` — probe-enforced (overridable)

`full_page_writes = off` risks **torn pages** on crash recovery: a page half-written across an OS
crash cannot be reconstructed from the WAL, which can corrupt committed data. UmbraDB refuses by
default. An operator whose storage layer guarantees atomic 8 kB page writes (some filesystems /
hardware) may opt out by passing `durability: { allowFullPageWritesOff: true }` to `runMigrations`
(equivalently, `probeDurability(sql, { allowFullPageWritesOff: true })`). This is the **only**
override in the contract; use it only with an external torn-page guarantee.

## 3. `synchronous_commit` — probe-warned, never refused

`synchronous_commit = off` acknowledges a commit **before** its WAL is flushed, so an OS crash or
power loss can silently lose a **bounded tail** of already-acknowledged transactions. It does **not**
corrupt the database — it is a recoverable trade an operator may accept deliberately (e.g. for
throughput). The probe therefore **warns** (a typed `DurabilityWarning` with `kind: "lost-tail"`,
returned from `probeDurability` and surfaced via `runMigrations`'s `onDurabilityWarning` callback)
rather than refusing.

The values `on`, `local`, `remote_write`, and `remote_apply` are all **crash-durable on a primary** —
each flushes this transaction's WAL to local disk before acknowledging the commit — so none forfeits
local crash durability, and the probe raises **no** warning for them. (`remote_write` /
`remote_apply` additionally concern standby acknowledgement, which is outside UmbraDB's single-node
model but does not weaken local durability.)

## 4. Session-mode connection pooling only — probe-enforced (best-effort)

UmbraDB's writer-lease scheme relies on **session-level PostgreSQL advisory locks**: a lock taken on
a connection must remain held, and be visible, across subsequent queries on that same session. A
**transaction-pooling** proxy (e.g. PgBouncer in `transaction` mode) assigns a backend per
transaction and does not support session advisory locks, so a lock silently vanishes between queries
— breaking mutual exclusion. **A transaction pooler is unsupported.**

The probe detects the common case by taking a session advisory lock (keyed uniquely per probe
session, so concurrent probes never collide) and confirming, in a follow-up query on the same
session, that the lock is visible in `pg_locks`. If it is not, `runMigrations` rejects with
`TransactionPoolerDetectedError`. This is a **best-effort** detector, not a guarantee: a degenerate
transaction pooler that happens to route every probe query to one reused backend can pass the check
(and in that instant the lease would in fact work), so the **binding requirement is that the deployer
connect UmbraDB directly to PostgreSQL or use a session-mode pool** — the probe assists, it does not
substitute for that.

**Session-mode pooler configuration (required).** UmbraDB sets `search_path` and the three
server-side timeouts (§5) as PostgreSQL **startup parameters**. A pooler placed in front (session
mode) rejects unknown startup parameters by default, so the connection fails before UmbraDB can run
unless the pooler is configured — and it must be configured to **actually forward** these parameters
to the backend, not merely tolerate them:

- **PgBouncer 1.21+:** add `search_path` and the three timeouts to **`track_extra_parameters`**, which
  tracks each value per client and forwards it to the server.
- **Or set them server-side** (`ALTER DATABASE … SET` / `ALTER ROLE … SET`, or `postgresql.conf`) and
  do not rely on the client startup packet at all.

**`ignore_startup_parameters` is NOT sufficient** — it lets the connection proceed but **silently
drops** the settings, so the timeouts would not actually be applied. A direct connection to
PostgreSQL (the primary supported deployment) needs none of this configuration.

## 5. Server-side timeouts — applied by `createClient` (documented)

Every UmbraDB connection sets three server-side timeouts as PostgreSQL startup parameters, so no
statement, lock wait, or idle-in-transaction session can hang unbounded (a session-mode pooler must
be configured to pass these startup parameters through — see §4):

| GUC | Default | Purpose |
|---|---|---|
| `statement_timeout` | 120 000 ms | bounds any single statement |
| `lock_timeout` | 30 000 ms | bounds how long a statement waits for a lock (incl. the bounded migration-lock acquire) |
| `idle_in_transaction_session_timeout` | 120 000 ms | terminates a session left idle inside an open transaction |

These are **defaults**, each overridable per connection via `UmbraDBConnectionOptions`
(`statementTimeoutMs`, `lockTimeoutMs`, `idleInTxTimeoutMs`) — a heavier legitimate workload raises
the relevant one rather than being wedged by the default. The spec fixes only *non-zero and
overridable*, not these particular numbers; they are tunable against the declared operating envelope
(G14). The probe does **not** check these (they are applied, not asserted) — this row is documented,
not probe-enforced.

The migration advisory-lock acquire is separately bounded (`runMigrations`'s
`migrationLockTimeoutMs`, default 30 000 ms) and fails fast with a typed `MigrationLockTimeoutError`
rather than hanging when another instance holds the lock.

---

*Cross-reference: `Formal/STORAGE_ALGEBRA.md` (W1, the durable-cursor ordering contract) and the
checkpoint-store contract docs. Probe behaviour is defined in `src/postgres/durability-probe.ts`;
this document and that code must not drift (acceptance B8).*
