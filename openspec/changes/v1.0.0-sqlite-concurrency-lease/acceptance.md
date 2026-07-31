# Acceptance — SQLite concurrency, transactions and the writer lease

Consolidated, objective acceptance criteria for change `v1.0.0-sqlite-concurrency-lease`. Every
criterion is traceable to a requirement in `specs/transaction-lease/spec.md` and a task in
`tasks.md`, and is marked with how it is verified: **[unit]** unit test, **[prop]** property test,
**[CI]** CI gate, **[doc]** checkable doc artifact, **[manual]** manual reviewer evidence.

**Nothing here gates on a performance number.** Requirements that need a quantity are satisfied by
*establishing* it under stated conditions behind `v1.0.0-sqlite-engine-core`'s measurement gate; the
criterion is that the number exists with its measurement conditions and the command that produced
it, never that it has a particular value.

## Preconditions (block the whole change)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| P0 | `v1.0.0-sqlite-engine-core`'s driver and topology ruling is recorded here (version-pinned `better-sqlite3`, handle confined to a worker thread), and every requirement that depends on the binding's error shape is keyed to it rather than to the research corpus's numeric form. | [manual][unit] | design §0 D-1, §7.1 / 0.1 |
| P1 | The ext4 measurement gate exists and is blocking; **decision B-4 is claimed by this change** and answered in writing with its measurement conditions before the poll schedule, retry bound/jitter or default hold bound is written into `src/`. | [manual][CI] | design §0 D-3 / 0.2, 2.2, 5.1, 1.5 |
| P1a | The transaction-hold bound is not conflated with `v1.0.0-sqlite-engine-core`'s per-statement deadline anywhere in this change's artifacts. | [manual] | design §0 D-3a, §4.5 / 1.5, 7.2 |
| P2 | The writer-registration table's prefixed physical name is agreed with `v1.0.0-sqlite-schema-parity` and referenced, not invented. | [manual] | design §0 D-4 / 0.3 |

## A — The lease mechanism

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| A1 | N concurrent in-process `withLease` calls on one key all acquire and complete, with instrumented maximum concurrent holders = 1, for the same N and critical-section shape the existing P10 test uses. | [prop][CI] | "per-key lease mutual exclusion…" / 2.1, 6.1 |
| A2 | With a lease held, `fs.readFileSync` of the database file, its `-wal`, its `-shm` and every other file UmbraDB created under the database directory leaves the lease intact; a second in-process acquisition is still refused. The test enumerates the directory rather than a hardcoded list. | [unit][CI] | "…negative control — red-team attack 1" / 2.1, 6.2 |
| A2a | That test is **quarantined**: throwaway database, no write transaction open, no reliance on the writer-generation guard in its fixture, database discarded afterwards, and an inline note at the read site recording that this act voids the adjacent guarantee. | [unit][manual] | "…does not void a held lease" (quarantine clauses) / 3.7 |
| A2b | The specification states adjacently that the lease's immunity and the write lock's exposure are **separate claims** — the same read is harmless to one mechanism and fatal to the other — rather than leaving a reader to hold two requirements in mind at once. | [doc][manual] | "The lease's immunity and the write lock's exposure are separate claims" / 3.7 |
| A3 | With a lease held, unlinking every UmbraDB-created file under the database directory other than the database itself leaves the lease intact and creates no new file. | [unit][CI] | "…negative control — red-team attack 2" / 2.1, 6.2 |
| A4 | A negative control implementing the per-key sidecar SQLite lock file is shown to grant two simultaneous holders after one `fs.readFileSync`, and again after one `unlink`. Both controls fail against the sidecar and pass against the shipped mechanism. | [unit][CI] | "…forbidden implementation" / 6.2 |
| A5 | An executable check asserts no source file under the SQLite adapter creates a per-key lock file, so the rejected mechanism cannot return silently. | [CI] | "…forbidden implementation" / 2.1 |
| A6 | A `SIGKILL`ed holder's lease is available to a fresh process with no expiry wait, no cleanup step and no residual filesystem artifact. | [unit] | "…killed holder's lease is released with no takeover rule" / 2.1 |
| A7 | Lease mutual exclusion is unaffected on a filesystem with broken advisory locks; the separate startup filesystem probe still rejects the deployment. | [unit][manual] | "…broken advisory locks" / 2.1, design §2.5 |
| A8 | The Sprint 2 lease test file's assertions pass unchanged (fixture only changes): indefinite wait absent `timeoutMs`, `LeaseTimeoutError` on expiry, `null` from `tryAcquireLease`, mid-wait `AbortError`, `LeaseNotHeldError` on double release, `withLease` always releases. | [unit][CI] | "the lease's frozen observable contract is preserved…" / 2.1 |
| A9 | The built `dist/index.d.ts` contains no `pg_advisory_lock` reference; the indefinite-wait behaviour is still documented in the same TSDoc block. | [unit][CI] | "…frozen TSDoc no longer names a PostgreSQL mechanism" / 2.5 |
| A10 | `LeaseFaultError`, `onReleaseFault` and their documented behaviours remain exported and unchanged in shape, and their unreachability is recorded in writing. | [unit][doc] | "…release-fault path survives as API" / 2.1, 7.4 |
| A11 | No file is created under the database directory during acquire / hold / release. | [unit] | "per-key lease mutual exclusion…" / 2.1 |
| A12 | `grep -rn "pg_advisory\|reserveBounded\|raceAgainstAbort" src/` returns nothing outside `src/postgres/`, and `npm run typecheck` passes. | [CI] | — / 2.3 |

## B — Cross-process: the writer-generation guard

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| B1 | Re-opening the database strictly increases `generation`; the read-back happens inside the registering `BEGIN IMMEDIATE`. | [unit] | "a second writer process is detected…" / 3.1 |
| B2 | A code-level check asserts no path reads `pid` or `host` to make a decision. | [CI] | "…SHALL NOT use a process id… or any liveness inference" / 3.1 |
| B3 | **O1** — A holds no open transaction, B registers, A's *next* write transaction rolls back, does not commit, and rejects with a `"non-retryable"` typed error; every subsequent A transaction is rejected identically. | [unit][CI] | "Ordering 1 — B registers between A's transactions" / 3.2 |
| B3a | **O2** — while A holds a write transaction, B's registration observes `SQLITE_BUSY` and waits; **A commits normally and is NOT refused.** A test asserting "A is refused" in this ordering is rejected in review as defective — it could pass only against an already-void write lock. | [unit][manual] | "Ordering 2 — B cannot register while A holds a write transaction" / 3.2 |
| B3b | **O3** — with an in-process `fs.readFileSync` of `-shm` during A's transaction, the test asserts both observables directly: *no two writers both commit*, and *no acknowledged commit is lost*. It FAILS against an implementation permitting the in-process open+close (both `COMMIT`s ok, one acknowledged row absent, `integrity_check` ok), and passes only once the source guard is in place. | [unit][CI] | "Ordering 3 — the interleaving the descriptor attack makes reachable" / 3.2, 3.6 |
| B3c | The guarantee's conditionality is in the requirement text itself, not a footnote: absent the descriptor precondition the guarantee is **absent**, not weakened. | [doc][manual] | "a second writer process is detected…" / design §2.3 |
| B3d | An executable check fails the build on any UmbraDB-source operation that opens a descriptor on **the database path or either sidecar path**, including via a path-building helper; an existence/metadata check on any of them does not fail it. | [CI] | "no UmbraDB code opens and closes a descriptor on the database file or its sidecars" / 3.6 |
| B3f | Per-journal-mode locus test: control arms for `wal`, `delete` and `truncate` each refuse the competing writer; the attack arm is harmless under `wal` and, under `delete`/`truncate`, voids the write lock, lets a competitor commit, and loses an acknowledged commit. | [unit][CI] | "the write lock's locus is journal-mode-dependent…" / 3.8 |
| B3g | The prohibition is unconditional, not journal-mode-conditional, and the recorded rationale names `journal_mode` mutability as why a build-time check cannot be mode-scoped. | [doc][manual] | "…SHALL be unconditional rather than journal-mode-conditional" / 3.6 |
| B3h | Every write-lock-exclusivity claim **this capability owns** carries the descriptor precondition in its requirement text, code comment and contract sentence: E-1 the writer-generation fail-stop, E-2 ordering 2, E-3 the wallet migration lock's **cross-process** exclusion, E-4 `prune`'s C2a argument. A claim found without it is a specification defect, not a prose nit. | [doc][manual] | "every claim resting on write-lock exclusivity carries the precondition" / 3.9 |
| B3h1 | §2.6.2 carries a row for every exclusivity-resting claim across **all seven** changes, with an owner per row: E-5/E-6 (change 2), E-7 (change 4 migration lock), E-8/E-9 (change 6 row-lock removal + ingest bundle), E-10 (change 7 import lock). | [doc][manual] | design §2.6.2 / 3.11 |
| B3h2 | The enumeration is produced by a mechanical sweep across all seven change directories for the exclusivity phrasings; every hit is either a table row with an owner or explicitly recorded as not resting on exclusivity, with no third category; the sweep is re-run when a change is added. | [CI][manual] | "the enumeration is mechanically swept, not authored from recollection" / 3.11 |
| B3h3 | Each listed claim's qualifier appears in **the owning change's own text and tasks.md**, not only in §2.6.2 — the relay failure that lost I-4 is not repeated for the qualifiers. | [manual] | "each claim's qualifier SHALL appear in the owning change's own text" / 3b.4 |
| B3h4 | E-8 and E-9 carry a **second** qualifier — the archive's own writer-generation registration — with the reason stated: `BEGIN IMMEDIATE` serializes transactions, not processes, so two `archive:sync` instances interleave legally and neither is detected. | [doc][manual] | "archive exclusivity claims need the writer guard as well as the descriptor precondition" / 3b.4 |
| B3j | **I-4:** registration asserts exactly one affected row **and** a read-back matching the written owner/generation; either failing is a named non-retryable startup error and the process does not open for writing; no path retains an undefined generation. | [unit][CI] | "invariant I-4" / 3.1a |
| B3k | **I-4 negative controls, run twice — once per assertion.** With either assertion removed, an unseeded (or emptied) registration table yields `changes = 0`, an absent read-back and an undefined generation with nothing thrown, and the resulting guard is demonstrated **inert** (two processes both pass the check), not merely wrong. | [unit][CI] | "without I-4, an unseeded or emptied registration table is silent" / 3.1a |
| B3l | I-4 holds against a row **deleted after seeding**, proving it closes the class rather than the instance change 4's migration seed closes. A seeded row is not accepted as a substitute for the assertions. | [unit] | "I-4 closes the class, not only the seeded instance" / 3.1a |
| B3i | The embedder precondition states the rule over the whole artifact set **and** states that under the shipped `wal` mode only the sidecars are actually exposed, naming `journal_mode` mutability as why the rule is broader than the shipped configuration requires. | [doc] | "Under the default mode only the sidecars are exposed…" / 7.1 |
| B3e | Negative control: an in-process copy of the database together with its `-wal`/`-shm` sidecars voids the write lock exactly as a hostile reader would, with no error raised. | [unit] | "…in-process three-file copy is the attack" / 3.6, 3b.2 |
| B4 | Negative control: a guard read taken on a separate connection, before `BEGIN IMMEDIATE`, or on a timer, permits a displaced process to commit. | [unit] | "…guard evaluated outside the write transaction is insufficient" / 3.2 |
| B5 | An implementation whose safety changes when an out-of-transaction poll is disabled or slowed is rejected in review as a reintroduced TTL. | [manual] | "…guard evaluated outside the write transaction is insufficient" / 3.4 |
| B6 | `SIGKILL` a registered writer; a new process registers and operates with no operator step, no cleanup and no expiry wait, and the registration row is readable and consistent. | [unit] | "…crashed writer does not wedge its successor" / 3.3 |
| B7 | Transactions the displaced process committed before displacement remain committed; the multi-transaction tear is asserted by the test and stated in `docs/CONTRACT.md` §5. | [unit][doc] | "…transaction-granular, not lease-granular" / 3.2, 7.1 |
| B8 | Negative control: routing the displacement fault to `TransactionFaultError` makes a caller's bounded-retry loop spin against a permanent condition. | [unit] | "…fault is not routed to a retryable code" / 5.6 |
| B9 | Either an executed Windows run of all three arms (control, open-and-hold, open-and-close) asserting both observables is recorded with its command and output, or `docs/CONTRACT.md` §5 names the platforms on which the strengthened guarantee holds. | [manual][doc] | "Windows parity…" / 3.5 |
| B9a | The POSIX-specificity of the descriptor hazard is treated as a hypothesis to be tested, never recorded as a result from `LockFileEx` semantics; if confirmed absent on Windows, the contract states the two platforms separately rather than documenting the weaker as universal. The source guard stays in force on every platform regardless. | [manual][doc] | "…hazard is POSIX-specific and its Windows status is measured, not inferred" / 3.5, 3.6 |
| B10 | The per-key lease requirement holds on every platform regardless of B9's state; only the cross-process guarantee is qualified. | [unit][manual] | "…in-process lease is not blocked on this" / 2.1, 3.5 |

## B2 — Per-file scope of concurrency objects (G-15)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| S1 | One requirement answers the scope question item-by-item: write queue per file; lease mutex keyed by `(file, key)`; poison flag and hold watchdog per transaction hence per file; handle registry process-wide as a map with every entry recording its file; registration and migration lock per file; descriptor ban process-wide by construction. | [doc][manual] | "every concurrency object in this capability is scoped per database file" / 3.10 |
| S2 | A wallet-database handle passed to an archive-bound adapter rejects with `TransactionHandleInvalidError` and does not execute; the rejection comes from the handle's recorded file identity, not a caller-side path comparison. | [unit][CI] | "a transaction handle cannot cross the file boundary" / 3.10 |
| S3 | A long write transaction on one file delays neither a write nor a lease acquisition on the other — **including when both callers use the same lease key string**; a hold-bound expiry or poisoned transaction on one file leaves the other unaffected. | [unit][CI] | "work on one file is not serialized behind the other" / 3.10 |
| S4 | Negative control: a process-wide write queue, or a lease map keyed by bare lease key, serializes the two lineages against each other despite independent write locks — archive ingest blocking wallet sync — which is over-serialization, not a safety property. | [unit] | "a process-wide concurrency object is a defect" / 3.10 |
| S5 | Change 1 states the per-file factory/worker scope; this capability references it and does not restate it. | [manual] | design §0 D-1 / 3.10 |

## C — The written contract matches the mechanism

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| C1 | `docs/CONTRACT.md` §5 contains no sentence asserting a second writer process is refused at open, and no paraphrase of one. | [doc][CI] | "the lease limitation stated in writing is exactly what the mechanism delivers" / 7.1 |
| C2 | Every guarantee stated in §5 maps to a scenario in `specs/transaction-lease/spec.md` that asserts it. | [doc][manual] | same / 7.1 |
| C3 | §5 states: detection, transaction-granular fail-stop, non-retryable typed error, and the deleted-or-replaced-file precondition. | [doc] | same / 7.1 |
| C3a | §5 states the **descriptor precondition** as binding on the embedding application, with its consequence written concretely (two writers both commit; an acknowledged commit is silently lost; `integrity_check` reports `ok`) rather than as a general caution about locking — and does **not** claim UmbraDB enforces it against code it does not own. | [doc][CI] | "…precondition on the embedding application is stated with its consequence" / 7.1 |
| C3b | Task 7.1 did not start before **both** 3.2 and 3.6 passed. | [manual] | design §2.6 / 7.1 ordering note |
| C4 | The "does not fence writes against connection death" clause is retired, not reworded, and the reason (the lease has no connection) is stated. | [doc] | "…release-fault path survives as API" / 7.1 |
| C5 | Task 7.1 did not start before task 3.2 passed — the contract text was written after the mechanism was measured, not before. | [manual] | design §3.2 / 7.1 ordering note |

## D — Transactions and the whole-database write lock

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| D1 | An executable check fails the build if any transaction-opening statement preceding a write is not `BEGIN IMMEDIATE`; a deliberately introduced `BEGIN DEFERRED` makes it fail. | [CI] | "every write transaction opens BEGIN IMMEDIATE…" / 1.6 |
| D2 | Negative control: a `DEFERRED` write path surfaces `SQLITE_BUSY_SNAPSHOT` after caller code has run, is not retried by the busy handler, and does not auto-roll-back — recorded with LND #7869 named as the failure shape. | [unit][doc] | "…DEFERRED write path lets contention escape mid-transaction" / 1.6, 5.3 |
| D3 | A transaction held past its bound is rolled back, the write lock is released, an independent writer commits immediately afterwards, and the rejection's `faultKind` is `"timeout"`. | [unit][CI] | "the whole-database write lock… is bounded" / 1.5 |
| D4 | After the bound fires, further use of the handle throws `TransactionHandleInvalidError` and no write from that callback is durable. | [unit] | "…handle is dead after the bound fires" / 1.5 |
| D5 | Negative control: with no bound, an awaiting callback blocks every other writer indefinitely and raises no error to anyone. | [unit] | "…unbounded transaction stalls the whole database" / 1.5 |
| D6 | The synchronously-blocking-callback limit is stated in the contract text, not implied. | [doc] | "…cannot be bounded (stated limit)" / 1.5, 7.2 |
| D6a | The transaction-hold bound and `v1.0.0-sqlite-engine-core`'s per-statement deadline are documented as distinct objects; the docs state which replaces `statement_timeout` and which replaces `idle_in_transaction_session_timeout`, and that an uncancellable statement makes the hold bound fire late by its remaining runtime. | [doc][manual] | "…hold bound fires late by an uncancellable statement's remaining runtime" / 1.5, 7.2 |
| D7 | Two concurrent top-level `withTransaction` calls both complete with no `SQLITE_ERROR` ("cannot start a transaction within a transaction"); a nested call does not enter the write queue. | [unit] | "the whole-database write lock… is bounded" / 1.2 |
| D8 | Nested `withTransaction` uses `SAVEPOINT`, an inner failure rolls back to it and poisons the outer transaction; a negative control using independent transactions deadlocks. | [unit] | "nested withTransaction resolves to a savepoint…" / 1.3 |
| D9 | `docs/durability-contract.md`'s timeout table no longer names a PostgreSQL GUC; `lock_timeout` maps to the acquisition bound, `idle_in_transaction_session_timeout` to the hold bound, and the `statement_timeout` gap is stated in prose. | [doc] | "…statement runtime has no bound at all" / 7.2 |

## E — Waiting, contention and errors

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| E1 | Every handle the adapter opens has `busy_timeout = 0`, asserted by reading the pragma back. | [unit][CI] | "all lock waiting happens outside SQLite…" / 2.1 |
| E2 | Negative control: a non-zero blocking `busy_timeout` fails the concurrent-acquirer assertion (one acquirer succeeds, the rest time out) while the poll loop passes it. | [prop][CI] | "…blocking busy_timeout fails P10" / 6.2 |
| E3 | Negative control (worker topology): a blocking `busy_timeout` inside the worker leaves the release message undelivered in the worker's queue until the contender's wait expires, while the main thread's event loop stays healthy. | [unit] | "…deadlocks inside a worker thread too" / 6.2 |
| E4 | The requirement's recorded reason is topology-independent ("pins the queue that must deliver the release") and does not cite the JS event loop as the mechanism. | [doc][manual] | "…all lock waiting happens outside SQLite…" / design §5.2 |
| E5 | The extended result code `SQLITE_BUSY_TIMEOUT` is never observed under contention, and the defensive mapping row is removed rather than carried. | [unit] | "…SQLITE_BUSY_TIMEOUT is unreachable by construction" / 5.7 |
| E5a | The classifier keys on the result-code **name** plus the situation, never on a numeric extended result code; a test provokes a real contention error and asserts `err.name` identifies the binding's error type and the keyed field is present and not `undefined`. | [unit][CI] | "…discriminator field is asserted to exist on a real thrown error" / 5.2, 5.8 |
| E5b | Negative control: a mapping keyed on a numeric `errcode` matches no arm against the ruled binding, routes every contention error to the unrecognised-error path, and surfaces it non-retryable where a retryable code was contractually due. | [unit] | "…mapping keyed on a numeric extended result code is wrong for the ruled binding" / 5.8 |
| E6 | Every surfaced contention error's `code` is already in `docs/ERROR-CATALOG.md` with an unchanged `retryable` marking, and every `faultKind` used is already a member of the union at `src/interfaces/transaction-lease.ts:76`. The error-catalog drift test stays green with no catalog edit. | [unit][CI] | "contention is retried inside the adapter…" / 5.2 |
| E7 | A transient `SQLITE_BUSY` inside the retry bound surfaces no error to the caller at all. | [unit] | "…never reaches the caller un-retried" / 5.1 |
| E8 | The exported error `code` set contains no `BUSY`/`WRITE_CONTENDED`-shaped member; the test comment names LND #7869 and records that `docs/STABILITY.md` would permit the addition, so the prohibition is a safety ruling. | [unit][doc] | "…adding a contention error code is the forbidden remedy" / 5.3 |
| E9 | Displacement and contention are distinguishable by `code` and `retryable` alone, with no message parsing. | [unit] | "…displacement fault is not a contention outcome" / 5.6 |
| E10 | No adapter path throws `ConnectionError`; file-level faults surface `"non-retryable"` errors. | [unit][CI] | "CONNECTION_ERROR becomes unreachable…" / 5.4 |
| E11 | Negative control: mapping `SQLITE_CANTOPEN` onto `CONNECTION_ERROR` makes a bounded-retry loop spin, and the review records the catalog's own reason (`ERROR-CATALOG.md:8-9`) that editing a Meaning cell cannot change what `retryable` predicts. | [unit][doc] | "…repurposing keeps the marking while inverting the behaviour" / 5.4 |
| E12 | At least one frozen retryable code is demonstrated reachable under SQLite by an executed test, and the record names the pinned Postgres id it replaces. | [unit][CI][manual] | "…retryable code retains empirical evidence of reachability" / 5.5 |
| E13 | The pinned `EXPECTED_REQUIRED_COUNT` change lands in a separate, reviewed commit from any required-id deletion. | [manual] | design §11 / 5.5 |

## F — Poisoning

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| F1 | Swallow a statement error, continue, return normally → zero rows durable, and `withTransaction` rejects with the original error. | [unit][CI] | "a transaction handle is poisoned by any transaction-scoped error…" / 1.4 |
| F2 | Swallow an **adapter-thrown** error that issued no statement, continue → zero rows durable. | [unit][CI] | "…adapter-thrown guard poisons even though no statement reached SQLite" / 1.4 |
| F3 | Negative control: a statement-executor-set flag produces a partial commit on F2's input. | [unit] | "…statement-executor-set flag misses the adapter-thrown case" / 1.4 |
| F4 | A swallowed `RAISE(ABORT)` from a `BEFORE INSERT` trigger leaves no partial history row **with the poison flag disabled**, demonstrating T5's soundness does not depend on the emulation. | [unit] | "…protects caller atomicity and is not what makes T5 sound" / 1.4 |
| F5 | The emulation is documented and tested as a caller-atomicity guarantee only; the design rule that a logical put is never split across two statements is named as what carries T5. | [doc][manual] | same / 1.4 |
| F6 | Poison survives a nested rollback; a poisoned transaction always ends in `ROLLBACK`. | [unit] | "…poison survives a nested rollback" / 1.3, 1.4 |

## G — Isolation, reads and prune

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| G1 | An independent writer commits while a large `load` is in flight. | [unit][CI] | "read paths do not take the database write lock" / 4.1 |
| G2 | The torn-read fixture (a prune committing between the page query and the aggregate) returns one consistent instant, with the guarantee coming from the WAL snapshot rather than an isolation option. | [unit] | "…a read still sees one consistent instant" / 4.1 |
| G3 | Negative control: routing `load` through `withTransaction`'s `BEGIN IMMEDIATE` blocks the writer for the whole reassembly. | [unit] | "…routing reads through withTransaction serialises them" / 4.1 |
| G4 | `TransactionOptions.isolation` accepts every enum value and changes no observable behaviour; the TSDoc says validated-then-ignored. | [unit][doc] | "…isolation SHALL remain on the frozen surface, validated and then ignored" / 4.2 |
| G5 | Negative control: a `DEFERRED` prune reclaims a live chunk against a `save` that re-references it after the snapshot, observable as a surviving checkpoint that no longer loads. | [unit][CI] | "…a DEFERRED prune reclaims a live chunk" / 4.3 |
| G6 | The same fixture under `BEGIN IMMEDIATE` reclaims no live chunk. | [unit][CI] | "prune's C2a justification is re-derived…" / 4.3 |
| G7 | Neither the prune comment nor `Formal/STORAGE_ALGEBRA.md` §2 mentions a READ COMMITTED dependency; both state the `BEGIN IMMEDIATE` derivation **with the descriptor precondition attached**, since a lock voided mid-prune lets a competing `save` re-reference a chunk between the two steps. | [doc][CI] | "…recorded justification names the mechanism that actually holds" / 4.3, 3.9 |
| G8 | Varying the grace window does not change whether C2a holds; the window is documented as serving the backup story. | [unit][doc] | "…grace window is no longer load-bearing for safety" / 4.4 |

## H — Conformance and formal record

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| H1 | P10 is executed against the SQLite build and recorded with the command that produced it; no result is carried over from the Postgres run. | [prop][CI][manual] | "P10 is re-executed with negative controls…" / 6.1 |
| H2 | Each of P10's three negative controls fails against the implementation it targets and passes against the shipped one. | [prop][CI] | "…each negative control fails as designed" / 6.2 |
| H3 | A meta-assertion fails the suite if every negative control passes. | [CI] | same / 6.2 |
| H4 | No risk argument in this change's record cites the unchanged Lean cut-line as evidence of safety. | [manual] | "…property is executed, not amended" / — |
| H5 | `Formal/STORAGE_ALGEBRA.md` §4's L1 mechanism line names the in-process mutex plus the writer-generation guard and its new voiding precondition; the status label is re-derived, not carried over. | [doc][manual] | design §1, §2 / 7.3 |
| H6 | The pool/pooler test family is deleted and `npm test` passes with no test asserting a behaviour the SQLite adapter cannot exhibit. | [CI] | — / 6.3 |
| H7 | The CHANGELOG entry enumerates every surface delta and states that each is free only because `docs/STABILITY.md:46` records the 1.0.0 commitments as not yet in force. | [doc] | proposal "What changes" / 7.4 |
| H8a | The guard-scope answer is returned to `v1.0.0-sqlite-temporal-event-log` (their open question 4b / F7d): **option 1 — guard widened to the database file, so their all-modes T5 soundness claim stands unnarrowed** and gains the descriptor precondition as its qualifier. The knock-on is relayed: their transaction-identity guard's external-forgery scenario inherits the same precondition. Outcome recorded in `tasks.md`. | [manual] | design §2.6.1, §2.6.2 / 3b.3 |
| H8 | Handover **H-2** delivered to `v1.0.0-sqlite-temporal-event-log` with the reproduction: their "closed three **independent** ways" TOCTOU claim (its requirement *"the engine configuration under which trigger-based enforcement is sound is asserted, not assumed"*) is qualified or the word "independent" struck **by their author**, not edited here. Outcome recorded in `tasks.md`. | [manual] | design §0 H-2 / 3b.1 |
| H9 | Handover **H-5** delivered to `v1.0.0-sqlite-durability-contract`: offline copy of the database with its `-wal`/`-shm` sidecars specified out-of-process or post-quiesce, **by their author**. Outcome recorded in `tasks.md`. | [manual] | design §0 H-5 / 3b.2 |
| H10 | No requirement in this capability classifies an error by parsing a message string; anything undecidable from `err.code` plus the situation routes through the single shared parse function with its round-trip test, never an ad-hoc regex at a call site. | [unit][manual] | design §7.1 (containment note) / 5.2 |
| H11 | Qualifier obligations delivered to changes 4, 6 and 7 (E-7…E-10), each recorded in **the owning change's `tasks.md`** at handover time rather than only in this change's design — the relay failure that lost I-4. Outcomes recorded here. | [manual] | design §2.6.2 / 3b.4 |
| H12 | `v1.0.0-sqlite-durability-contract` is handed an operational definition of "quiesce" — no open write transaction on the file and every handle to it closed, or the owning process exited — and its out-of-process copy procedure references the definition rather than the bare word. | [manual][doc] | G-17 / 3b.5 |
| H13 | No stale-archive premise survives in this change: no text asserts the archive is unwired, has no consumer, has no runner, or would get a registration "if it is ever wired". The non-goal is a handover record naming `v1.0.0-sqlite-chain-archive`, and acceptance N1 asserts a division of ownership rather than a refuted fact. | [doc][CI] | G-1/G-3/G-8 / proposal non-goal, N1 |
| H14 | Cross-change citations in this change resolve by **requirement title**, not line number, so they do not rot as sibling files move. | [doc][manual] | G-16 / 3b.1, 3b.4 |

## Negative / boundary criteria (nothing out-of-scope leaked in)

| # | Criterion | Verify | Source ruling |
|---|---|---|---|
| N1 | No chain-archive file, table, migration or error is touched by **this** change; the archive is owned by `v1.0.0-sqlite-chain-archive`, which is porting it. This criterion asserts a division of ownership only. It does **not** assert the archive is unwired, has no consumer, or has no runner — all three are false: `chain-archive-sync/` is a typechecked ops entry point exposed as the `archive:sync` npm script. | [manual] | proposal non-goal + the G-8 handover record |
| N2 | No driver selection, shim, pragma-bootstrap ordering or worker-topology decision is made here. | [manual] | design §0 D-1..D-3 |
| N3 | No edit to `docs/ERROR-CATALOG.md`, no new error code authored here, no `UNRECOGNIZED_POSTGRES_ERROR` rename. | [manual] | design §0 D-5; `council/commitments.md` R3 |
| N4 | No edit to `docs/CONTRACT.md` §3 or §6. | [manual] | design §0 D-5 |
| N5 | No schema DDL, `STRICT` table, name-prefix layer or migration-runner change. | [manual] | design §0 D-4 |
| N6 | No TemporalKV trigger, clock policy or transaction-identity guard is specified here. | [manual] | design §0 D-6 |
| N7 | No performance number is asserted anywhere in this change's requirements; every quantity is a requirement to establish one under stated conditions. | [manual][doc] | `council/redteam.md` §2 #4 (233× tmpfs error) |
| N8 | No TTL, heartbeat, stale-takeover rule or caller-visible fencing token is introduced. | [unit][manual] | `Formal/STORAGE_ALGEBRA.md:303-317`; design §2.4 |
| N9 | Nothing under `src/`, `test/` or any product file is modified by this change — it authors specification only. | [manual] | brief trap 6 |
