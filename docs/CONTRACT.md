# UmbraDB 1.0.0 Release Contracts

The written, checkable contracts that govern the frozen 1.0.0 surface. Each section states a
guarantee (or a binding precondition/limitation) that is **true of the code as shipped** — none of
these is aspirational. The SemVer stability policy is [`docs/STABILITY.md`](STABILITY.md); the frozen
error-code catalog is [`docs/ERROR-CATALOG.md`](ERROR-CATALOG.md).

## 1. Durability contract

**Ordering guarantee.** The durable sync **cursor** (a watermark) is never ahead of the durable
checkpoint **data** it references. A cursor ahead of its data is the silent-skip failure (on resume
the sync believes it persisted data a crash actually lost, and never re-fetches it); a cursor behind
its data is the safe, recoverable direction (on resume the sync re-applies a bounded window of
already-durable writes and converges). The G5 co-transactional `save` fix establishes this: persist
the checkpoint and advance the cursor **in one transaction** — use `saveAndAdvance`, or pass one
shared `opts.tx` to both `CheckpointStore.save` and `Watermarks.set`, so both become durable at the
same commit or neither does. The full composition contract (both conforming compositions and the
invariant) is [`docs/checkpoint-store-contract.md`](checkpoint-store-contract.md).

**Binding Postgres precondition.** "Durable" only means something when the server is configured for
crash safety. UmbraDB requires, as a **binding deployer precondition**:

- `fsync = on`,
- `full_page_writes = on`,
- `synchronous_commit` = one of `on` / `local` / `remote_write` / `remote_apply` (i.e. not `off`),
- **no transaction pooler** — connect UmbraDB directly to PostgreSQL, or use a **session-mode** pool
  (a transaction-pooling proxy silently breaks the session advisory locks the writer lease relies
  on).

**Probe precondition.** These are enforced at startup by the durability probe
(`src/postgres/durability-probe.ts`), which runs as a **mandatory step of `runMigrations`, before
any migration runs**: `fsync = off` or `full_page_writes = off` makes `runMigrations` **reject** with
`DurabilityContractError` (full-page-writes-off is overridable only with an external torn-page
guarantee); a detected transaction pooler makes it **reject** with `TransactionPoolerDetectedError`;
`synchronous_commit = off` raises a typed lost-tail **warning** rather than refusing. The full
configuration contract, including session-mode pooler setup and the applied server-side timeouts, is
[`docs/durability-contract.md`](durability-contract.md).

## 2. Forward-only / no-downgrade migration contract

Migrations are **forward-only**. `src/postgres/migrate.ts`'s `Migration` interface is deliberately
`up()`-only — there is **no `down()` / rollback path**. Consequences, which are binding:

- A new UmbraDB **major** MAY require running a documented forward migration (`runMigrations`)
  against an existing database before it will operate.
- There is **no supported downgrade**: a database migrated to a newer major cannot be migrated back
  to an older UmbraDB major. Take a backup before a major upgrade (§6) if you need a rollback option.
- On an **application rollback** (redeploying older application code without touching the database),
  the schema-version bookkeeping row (`<schema>._migrations`) already records the newer schema
  version; the older application runs against the already-migrated schema. Only run an older app
  major against a schema its own major understands.

The generated schema reference is [`docs/SCHEMA.md`](SCHEMA.md).

## 3. Cancellation semantics

Every method threads an `AbortSignal` (`opts.signal`); the guarantee, as public contract, depends on
**when** the abort lands (three timings):

- **Before dispatch** (an already-aborted signal) — **no query is issued**; the call rejects
  immediately without touching the backend.
- **During a long read** (`listKeys`, lease acquisition) — the in-flight cursor / lock wait is
  **freed**: the driver's `query.cancel()` fires and the wait unwinds, rather than running to
  completion.
- **During a quick write** — the write **may still complete**. Abort is best-effort for a
  short-lived statement already in flight; a caller must not assume a mid-write abort prevented the
  write (re-read to determine the actual state).

## 4. Save-retry caveat

`CheckpointStore.save` is **not blindly retryable**. On a `ConnectionError` (which is marked
`retryable` in the catalog), a lost-`COMMIT`-ack means the save may or may not have landed. A caller
MUST **re-check `history()` before retrying** `save`: a blind retry of an actually-committed save
produces a benign identical-content duplicate at the next sequence, which `retainCount` prunes — but
the re-check is the documented rule so a caller never assumes the first attempt was lost.

Automatic idempotency (an `idempotency_key` `UNIQUE` constraint that would make the retry a no-op
without the `history()` re-check) is a **deferred additive 1.1 migration**, not a 1.0 code change. No
idempotency code ships in 1.0.

## 5. Lease limitation

The writer lease (`acquireLease` / `withLease`, connection-pinned Postgres advisory locks) guards
concurrent acquirers **only within the documented single-process deployment model**. Specifically:

- It does **not fence writes against connection death**: a lease is a session advisory lock, not a
  fencing token, so a paused/partitioned holder whose connection later resumes is not fenced off by a
  monotonic token.
- **Do not run two writer processes.** UmbraDB is designed for a single writer against a single
  Postgres instance; running two writer processes is unsupported in the 1.0 model.

Pinned-connection fencing is a 1.0.x / 1.1 consideration, not a 1.0 guarantee.

## 6. Backup/restore guidance

Back up an UmbraDB schema with a **consistent** dump — `pg_dump` takes a snapshot-consistent dump by
default (a single transaction / consistent snapshot), which is what UmbraDB requires:

```bash
pg_dump --format=custom --schema='my_app' "$DATABASE_URL" > umbradb-my_app.dump
```

- **Chunk/manifest consistency.** `CheckpointStore` is content-addressed: manifests reference chunks
  by content hash across separate tables. Dump the schema **as one consistent unit** (the default
  single-snapshot `pg_dump` above does this) so every manifest's referenced chunks are captured
  together — never dump the chunk tables and manifest tables in separate, independently-timed passes.
- **A mid-GC dump is safe to restore.** Garbage collection is a two-step manifest-prune-then-chunk-
  reclaim pass, and reads run under `REPEATABLE READ`. A single-snapshot `pg_dump` taken **during** a
  GC pass captures one consistent point-in-time: it never sees a manifest whose chunks were already
  reclaimed. The restored schema is therefore internally consistent.

Restore with `pg_restore` into a database at the **same** UmbraDB major (see §2 — there is no
supported downgrade across a major).

## 7. Threat-model pointer

The UmbraDB threat model is authored separately as `SECURITY.md` (gate G15, the InfoSec change) and
is **not** authored by this contract set. It covers: a single trusted writer; the schema is **not** a
security boundary; the global content-addressed chunk pool is one trust domain with an observable
dedup side channel; and no at-rest encryption (a binding deployer precondition). This section is the
reserved pointer so the contract set is complete.

> **See:** [`SECURITY.md`](../SECURITY.md) _(authored by the G15 InfoSec change)._

## 8. Format headroom (reserved for 1.1)

Chunk addressing and the wallet-state envelope encoding are **versioned**: manifests already carry
enough structure, and the envelope already carries a version field (`ENVELOPE_VERSION`), to introduce
a **v2 keyed/encrypted chunk mode additively in 1.1 without a breaking migration**. That reserved
headroom lets 1.1 add per-consumer/keyed chunking (which also closes the dedup-oracle side channel of
§7) and at-rest encryption as an additive format version, not a schema break. This is the
documentation half of the deferred dedup-oracle mitigation; **no keyed-chunking or encryption code
ships in 1.0.**
