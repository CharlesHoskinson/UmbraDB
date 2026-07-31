# Test plan — lane `adversarial`

**Scope of this lane:** every negative control in the seven-change sprint, made executable, plus the
attacks that produced them.

**Governing sentence:** *a negative control that never runs is a comment.*

A count, because the size of the problem is the argument for the method: the seven changes carry
**601 `#### Scenario:` blocks, of which 158 are explicitly titled `(negative control)`**, distributed
chain-archive 22, concurrency-lease 22, data-migration 25, durability-contract 35, engine-core 22,
schema-parity 17+1, temporal-event-log 14. A further ~30 scenarios describe a forbidden construct or
a demonstrated attack without carrying the tag. The `acceptance.md` files already reference **~85** of
them as criteria. None of the 158 executes today. This plan says, for each, how the wrong
implementation is planted without shipping it, what assertion catches it, and what a green run proves.

Everything below marked **[measured]** was run during the authoring of this plan. Conditions are in
§0. Every command that produced a figure is pasted with it.

---

## 0. Measurement conditions for every figure in this document

All prototypes were executed on the sprint host, not inferred:

| Property | Value |
|---|---|
| Filesystem for every database file | `/root/adversarial-scratch/db` on `/dev/sdd`, **ext4** (`df -T /root` → `ext4`). **Never `/tmp`**, which `df -T /tmp` reports as `tmpfs`, 32 GB |
| Runtime | Node `v24.18.0` |
| Binding | `better-sqlite3@13.0.2`, resolved from `/tmp/l3-bs3b/node_modules` via `createRequire`; no `npm install` was run |
| `sqlite_version()` | `3.53.4` |
| Defaults observed on a fresh file | `page_size = 4096`, `auto_vacuum = 0`, `journal_mode = delete`, `synchronous = 2 (FULL)` |
| Host | 62 GiB RAM, 12 cores; every dataset below is far smaller than page cache, which is stated per test where it matters |
| Writer topology | single in-process writer unless a row says "second OS process" |

**None of these figures is proposed as a pass threshold.** They are *expected outcomes of planted
defects* — the class of number this sprint permits, because a negative control's expected value is a
property of the defect, not of the machine. Where a control's assertion would need a *shipped*
threshold (§6), it is marked blocked.

---

## 1. Scope — requirements and criteria this lane covers

By change and **requirement title** (line anchors are not used; the sprint measured a 41% mis-anchor
rate).

### `v1.0.0-sqlite-engine-core` (capability `sqlite-engine`)
- *a cancellable statement carries a per-row guard whose argument cannot be hoisted* — criteria C20b, C20c, and the single-table scenario
- *every bound parameter is normalised before it reaches the binding* — B5
- *result columns are decoded from origin metadata, never from declared type names* — B8
- *64-bit integer values round-trip without precision loss* — B10
- *text that SQLite stores incorrectly is rejected at the boundary* — E10
- *no statement is issued with more bound parameters than the engine accepts* — B13
- *the pragma bootstrap is an ordered, once-only sequence whose effect is verified by read-back* — D2
- *the connection factory opens exactly one database file and rejects options that no longer mean anything* — E3
- *a result set is streamed across the worker boundary in batches, and a stream can never wedge the writer* — C17 and the three stream controls
- *the storage engine is an embedded SQLite database reached through a version-pinned, gate-observable binding* — the three PIN controls
- *every performance-dependent decision is blocked on measurements taken on a real filesystem* — the research-figure control
- *the conformance suite is re-executed against the new engine rather than amended to suit it* — the formal-layer control
- **the cross-change correction register** — J3, J3a–J3h (the use/mention sweep and its three meta-controls). This lane owns making that sweep executable and self-testing.

### `v1.0.0-sqlite-temporal-event-log` (capability `temporal-kv`)
- *gap-freedom is structural* — B2
- *the structural gap-freedom guarantee is a property of the encoding …* — B4b, and the JS-round-trip oracle control
- *getAt asserts the `at` bound through the primary-key index* — I3b (both arms)
- *the adapter never issues INSERT OR REPLACE against the event log* — F2
- *trigger assertions abort the statement and never end the transaction* — F4
- *the naive EXCLUDE transliteration is prohibited* — the quadratic control
- *the engine configuration under which trigger-based enforcement is sound is asserted, not assumed* — F7b, F7d1 (the three-arm descriptor matrix)
- *same-transaction key reuse is adapter-enforced* — E5
- *A second write to the same key within one transaction is rejected at the trigger level* — the clock-resolution-accident control
- *listKeys streams without materializing …* — H6d, H6f
- *A caller-supplied transaction handle is honored or rejected, never silently ignored* — H9c
- *the write-timestamp clock policy is decided by the engine-core measurement gate* — D4
- *getAt satisfies temporal-projection equivalence (Law T3)* — the silent-semantic-repair control

### `v1.0.0-sqlite-concurrency-lease` (capability `transaction-lease`)
- *per-key lease mutual exclusion is enforced in-process and uses no lock file* — A2, A3, A4 (red-team attacks 1 and 2, and the forbidden sidecar lock file)
- *a second writer process is detected and the displaced process is fail-stopped before it can commit* — B3k (run twice, once per assertion), B4, B8, and orderings 1–3
- *no UmbraDB code opens and closes a descriptor on the database file or its sidecars* — B3e and the build-failing guard
- *every concurrency object in this capability is scoped per database file* — S4
- *every write transaction opens BEGIN IMMEDIATE and no write path is DEFERRED* — D2
- *the whole-database write lock held by withTransaction is bounded* — D5
- *all lock waiting happens outside SQLite and busy_timeout is 0 on every handle* — E2, E3
- *contention is retried inside the adapter …* — E5b, and the added-contention-code prohibition
- *CONNECTION_ERROR becomes unreachable and is never repurposed* — E11
- *a transaction handle is poisoned by any transaction-scoped error …* — F3
- *read paths do not take the database write lock* — G3
- *prune's C2a justification is re-derived from BEGIN IMMEDIATE* — G5
- *nested withTransaction resolves to a savepoint rather than deadlocking* — D8
- *P10 is re-executed with negative controls that fail against the implementations they target* — H1, H2, **H3 (the meta-assertion)**
- *the lease limitation stated in writing is exactly what the mechanism delivers*

### `v1.0.0-sqlite-schema-parity` (capabilities `storage-schema`, `temporal-kv`)
- *every object name UmbraDB creates carries the schema prefix, including index and trigger names* — the two unprefixed-name controls
- *every table is STRICT and a wrong-typed write is rejected, not coerced* — S3
- *domain constraints lost with the PostgreSQL type system are restored as named CHECK constraints* — the `length()`/`octet_length()` control
- *identifier containment is a junction table whose predicate is row-subset-of-the-finalizing-set* — J4
- *uniqueness over a nullable key column is emulated by a coalesce expression index with a domain-excluded sentinel* — R3, plus the sentinel-collision sequel
- *listKeys matches a literal prefix with a half-open range scan, not LIKE* — L3
- *migration 006 replays verbatim …* — MG6
- *the writer-generation table is created and seeded by the migration lineage* — W4
- *sequence allocation is guarded by a runtime invariant …* — SQ4, SQ5
- *every migration begins with non-idempotent DDL and runs in one transaction* — I5-5
- *transaction-history reads derive identifiers from entry and cross-check the junction* — I7-7
- *wallet-tier digest columns are declared under this capability's conventions* — DG8
- *bulk inserts have no row cap derived from the bind-parameter ceiling* — B5, and the retune prohibition
- *foreign-key enforcement is a schema precondition that is asserted, not assumed* — C6

### `v1.0.0-sqlite-durability-contract` (capability `release-contract`)
- *the durability probe verifies library-controlled pragmas …* — A6
- *the synchronous default is FULL and is lowered only under a stated decision rule* — B4
- *integrity coverage follows the three-class corruption model …* — the envelope-contradiction and Class-B-digest controls
- *the value digest is a versioned, length-prefixed, row-bound SHA-256 computed adapter-side* — C3a, C4f, and the generated-column and null-rejecting-constraint controls
- *the digest covers the stored bytes and never a logical value* — the encoding-change control
- *a documented-as-dangerous salvage bypass ships from day one* — both controls
- *a covered row cannot be downgraded to unverified …* — C4c, and the default-off control
- *the schema digest is verified at open …* — the value-digest-at-open control
- *the verification pass runs the structural check, the digest sweep, the schema digest and the invariants together* — C2, and both blindness controls
- *Class B corruption is answered by named invariants with an owner per change* — C6b
- *the checksum VFS is considered and declined* — the reserve-bytes control
- *the integrity boundary is disclosed using the two-case wording* — three text-level controls
- *corruption recovery is row-scoped and proportionate* — the whole-database-refusal control
- *the cancellation contract promises only what a mechanism can deliver* — D4
- *the backup primitive is established by measurement on the ruled binding* — E9, and the in-process-copy prohibition
- *driver errors are discriminated by the ruled binding's string code, never by a numeric result code* — F16
- *no frozen error code is repurposed and no contention code is added* — the repurposing and the not-generalised controls
- *every integrity fault raised by a sibling change is routed to a named existing code* — the unnamed-code control
- *failures of a process outside the frozen surface are tool diagnostics* — the tool-onto-library-code control
- *CLOCK_REGRESSION retains its conditional retryability marking* — F8
- *the conformance suite is re-executed with negative controls …* — G5, G8, G10
- *every engine-named contract sentence is re-derived …* — I2
- *the unmeasured integrity quantities are carried as obligations* — the write-cost control

### `v1.0.0-sqlite-chain-archive` (capability `chain-archive`)
- *a second process writing the archive file is detected and fail-stopped before it can commit* — S7, S8
- *height-range separation SHALL NOT be implemented with ATTACH* — the cross-file WAL commit control
- *each archive relation is stored in one table …* — L6, L7
- *a view-routing insert trigger never accepts a row it does not store* — L8
- *a height-qualified read resolves in one index descent* — L7
- *the archive cursor is bounded by its data and its monotonic guard cannot latch* — R15a, R16
- *verifier-key observation identity uses the ruled coalesce expression index* — D6
- *blob content is stored in the database and verified on read by recomputing its address* — W5
- *the ingest cursor advances in the same transaction as the block bundle it passes* — W7
- *constraint identity survives the port …* — E4
- *the archive's bounded delete is written in the form that needs no optional compile option*
- *the snapshot and verification tooling runs outside the library process* — N0a
- *the snapshot manifest is derived from the finished artifact …* — N5
- *restoring a snapshot runs four checks and reports them separately* — N11d
- *a snapshot makes no completeness claim* — N15
- *no live-backup primitive is named for the archive until it has been measured* — N17
- *the archive's durability setting is not lowered without four stated preconditions* — R3
- *each archive table has a stated integrity classification and mechanism* — R6, R7
- *the digest column and its drift guard follow this lineage's DDL conventions* — R8a, R8b, R10

### `v1.0.0-sqlite-data-migration` (capability `data-migration`)
- A3, B4, C3, C4, D4, D5, E3, E9, M6, F3, F4d, F6, G4, H8, J2, J4, J9, Q2, Q7 — the full negative-control column of that change's acceptance table, plus the research-figure control.

### Explicitly **not** this lane
Positive-path conformance (P1–P10 green runs), the `fast-check` property suites' positive
generators, `EVIDENCE.md` regeneration, benchmark authoring, and the Lean gate. This lane consumes
those harnesses and adds the arm that must fail.

---

## 2. The planting taxonomy

The planting mechanism is the design question. "Plant the wrong version" is not a plan. Seven
mechanisms, each with a rule for when it applies and a rule that keeps it out of the shipped artifact.

| # | Mechanism | Applies when | Kept out of the product by |
|---|---|---|---|
| **P1** | **Test-only variant adapter.** `test/negative/variants/*.ts` exports a *defective* implementation of one named seam behind the same interface the shipped adapter implements. The test instantiates both and asserts they diverge. | the defect is in **code the adapter runs** (guard argument, error translator, poison flag, resume protocol, stream shape, discriminator field, decoder key) | (a) an import-graph CI check: no file under `src/` may import from `test/`; (b) `package.json` `files` allowlist excludes `test/`; (c) a pack-smoke assertion that the published tarball contains no `variants/` path. All three, because any one alone is a single point of failure. |
| **P2** | **Defective-DDL fixture.** A builder in `test/negative/ddl/` emits the *wrong* schema directly into a throwaway database, **bypassing the migration lineage entirely**. The lineage is never parameterised by a "wrong" flag. | the defect is in **DDL** (plain `UNIQUE`, drift-guard-only, unseeded singleton, partial index, interval-table design, `IF NOT EXISTS` first statement, non-`STRICT`, unprefixed index/trigger names, `INSTEAD OF` routing without a guard, `UNION ALL` view) | the builders emit raw SQL strings and never call `runMigrations`; a CI check asserts no string in `test/negative/ddl/` appears in `src/**/migrations/`. |
| **P3** | **Mutation on a throwaway copy.** Build the *correct* fixture through the real lineage, `fs.copyFile` it, mutate the copy at rest (page bytes, an index page, a cursor row, a junction row, `next_seq`), reopen the copy. | the defect is **corruption**, not code — Class A payload damage, Class B index/table divergence, corrupted-forward cursor, damaged junction, corrupted counter | the mutation only ever touches a file created inside the test's own temp dir; a `beforeEach` asserts the temp dir is under the configured non-tmpfs root and is empty. |
| **P4** | **Source-level guard that fails the build.** A sweep over `src/` for a forbidden construct. Nothing is planted at runtime at all; what is planted is a *line in a scratch file* used only to prove the sweep can fail. | the requirement is a **prohibition on our own sources** (descriptor operations, `INSERT OR REPLACE`, per-key lock file, `DEFERRED`, non-zero `busy_timeout`, row-cap constants, hard-coded parameter limits, `quick_check`, numeric `errcode` keys, `JSON.parse` on the transport path, literal created-object names) | the sweep runs in CI over `src/` only. Its three meta-controls (§3.9) run over a scratch tree the sweep is pointed at, never over the repo. |
| **P5** | **Adversary process.** A real second OS process (`execFileSync` of a child script) plus a deliberate in-process act inside the holder. | the defect is **concurrency across process boundaries** — the descriptor attack, two-writer orderings, `DEFERRED` prune, the blocking `busy_timeout` P10 arm | the child script is generated into the test's temp dir at run time and deleted afterwards; it imports only the binding, never `src/`. |
| **P6** | **Text-level prohibition check with use/mention markers.** A grep over the change set / shipped docs for a banned formulation, excluding lines carrying `<!--MENTION:{retraction,criterion,pattern,control}-->`, reporting **TOTAL / MARKED / UNMARKED per directory plus both line lists**, gated on `UNMARKED = 0`. | the negative control is about **written text** — a softened rewording, a "SQLite detects nothing" formulation, a restoring-lost-parity claim, an unsourced frequency figure, a research figure re-cited as fact, a green-formal-gate safety argument | the marker **re-files rather than suppresses**: a marked line still prints, in full, in a list a reviewer must read. Three meta-controls, §3.9. |
| **P7** | **Rejected-proposal register.** A checked-in `docs/decisions/rejected.md` table: proposal, the requirement that rejects it, and **the falsifying observation**. A CI check asserts every row has a non-empty falsifying-observation cell and that no text in the change set asserts the rejected premise (via P6). | the control is a **review ruling** whose subject is a proposal, not an artifact — "a layout selected on the retracted argument is rejected", "a blanket exclusion of the archive is rejected", "a stronger completeness claim is rejected" | nothing is planted in code. **State plainly what this proves: that the ruling and its reason are on the record and are not contradicted elsewhere. It does not prove the ruling is right.** That is the honest limit and it is recorded in §5. |

**Rule for every mechanism:** a control is registered in `test/negative/registry.ts` with its expected
outcome (`fails` / `passes-and-that-is-the-finding`). See §3.10 for the two meta-assertions over the
registry.

---

## 3. Negative controls

### 3.1 The cancellation-guard hoisting family — the control that must use a join

**Prototyped and reproduced.** `node /root/adversarial-scratch/guard-hoist.mjs`, conditions §0,
WAL + `synchronous=FULL`, two tables of 3,000 rows joined `ON 1=1` (9,000,000 visited rows), and a
single 200,000-row table:

```
A1 constant arg  udb_guard(0)                  rows=  9000000 guard_calls=     3000    55ms
A2 one-table arg udb_guard(a.id)               rows=  9000000 guard_calls=     3000    57ms
A3 one-table arg udb_guard(b.id)               rows=  9000000 guard_calls=     3000    60ms
A4 all-table arg udb_guard(a.id+b.id)          rows=  9000000 guard_calls=  9000000  1028ms
A5 all-table DETERMINISTIC reg                 rows=  9000000 guard_calls=  9000000   928ms
A6 constant DETERMINISTIC reg                  rows=  9000000 guard_calls=        1    55ms
S1 constant arg  udb_guard(0)  [single table]  rows=   200000 guard_calls=   200000    17ms
S2 row arg       udb_guard(id) [single table]  rows=   200000 guard_calls=   200000    21ms
```

| ID | Control | Planted by | Assertion | What a green run proves |
|---|---|---|---|---|
| ADV-G1 | guard with a **constant or absent** argument | **P1** — `variants/guard-forms.ts` exports the four SQL texts; the shipped adapter's cancellable-statement builder is asked for its text and the test asserts the shipped text is the all-table form | invocations = 3,000 while visited rows = 9,000,000, i.e. **invocations / visited < 10⁻³** | the guard the adapter ships is invoked once per visited row, so an abort request lands within one row rather than within 3,000 |
| ADV-G2 | argument depending on **one** of two joined tables — asserted for **both** choices | same variant table, two arms | invocations = 3,000 for `a.id` **and** for `b.id` | "row-dependent" is not the rule; the shipped rule is "depends on every table in the statement" |
| ADV-G3 | the **single-table** test that catches neither | **P2** — a 200,000-row single-table fixture | the constant form fires 200,000/200,000 and **the naive assertion passes** | that the conformance test for this requirement is required to use a join. ADV-G3's *passing* is the finding, and the registry marks it `passes-and-that-is-the-finding` so the §3.10 meta-assertion does not flag it |
| ADV-G4 | **new — deterministic registration collapses the constant form to one invocation** | same variant table, registered `{deterministic:true}` | invocations = **1** of 9,000,000 | **This is a finding against the spec as written.** Acceptance C20b pins "**3,000**". 3,000 is the *non-deterministic* figure. With `deterministic: true` the constant form is hoisted to a single evaluation. A test that asserts `=== 3000` will therefore fail against the strictly worse defect. The assertion must be `invocations < visitedRows / 1000`, with 3,000 and 1 both recorded as observed values and the registration flag recorded alongside. Recommend C20b be reworded before it is implemented. |

**Fixture:** `a(id,v)` and `b(id,v)`, 3,000 rows each, joined `ON 1=1`; `single(id,v)`, 200,000 rows.
Total 206,000 rows, ~4 MB, built in 2.4 s including the 200k table. Small enough to build per-test.

---

### 3.2 The `-shm` descriptor attack — three arms × three journal modes

**Prototyped and reproduced in full.** `node /root/adversarial-scratch/descriptor-attack.mjs`.
Parent holds `BEGIN IMMEDIATE` with an uncommitted row; **a second OS process** (`execFileSync`) then
attempts `BEGIN IMMEDIATE` + `INSERT` + `COMMIT`; then the parent commits. Lock-bearing file is
`-shm` under `wal` and the **main database file** under `delete`/`truncate`. `timeout: 0` on every
handle. Conditions §0, `synchronous=FULL`.

```
mode     | arm           | child COMMIT | child err    | holder COMMIT              | rows after  | integrity | both ok | SILENT LOSS
wal      | control       | n/a          | SQLITE_BUSY  | ok                         | seed,holder | ok        | false   | false
wal      | open-no-close | n/a          | SQLITE_BUSY  | ok                         | seed,holder | ok        | false   | false
wal      | open-close    | ok           | -            | ok                         | seed,holder | ok        | true    | TRUE
delete   | control       | n/a          | SQLITE_BUSY  | ok                         | seed,holder | ok        | false   | false
delete   | open-no-close | n/a          | SQLITE_BUSY  | ok                         | seed,holder | ok        | false   | false
delete   | open-close    | ok           | -            | SQLITE_IOERR_DELETE_NOENT  | seed,holder | ok        | false   | TRUE
truncate | control       | n/a          | SQLITE_BUSY  | ok                         | seed,holder | ok        | false   | false
truncate | open-no-close | n/a          | SQLITE_BUSY  | ok                         | seed,holder | ok        | false   | false
truncate | open-close    | ok           | -            | ok                         | seed,holder | ok        | true    | TRUE
```

| ID | Control | Planted by | Assertion | What a green run proves |
|---|---|---|---|---|
| ADV-D1 | **control arm** — no descriptor operation | **P5** | the second process is refused with `SQLITE_BUSY`; exactly one writer commits; no acknowledged commit is absent from a subsequent read | the harness can observe exclusion at all. Without this arm the other two prove nothing |
| ADV-D2 | **open-without-close** arm | **P5**, `fs.openSync` on the lock-bearing file, descriptor held until after the parent commits | the second process is **also** refused with `SQLITE_BUSY` | **the fault is POSIX `close`, not `open`.** This is the arm that makes the source guard's shape correct: banning *opens* without banning *closes* would be the wrong ban, and banning metadata operations would be over-broad. Dropping this arm is how a future author concludes "we only need to avoid holding descriptors" |
| ADV-D3 | **open-and-close** arm | **P5**, `fs.openSync` + `fs.closeSync` (a single `fs.readFileSync` is equivalent) | **both `COMMIT`s return ok**, one acknowledged commit is **absent** from the subsequent read, and `PRAGMA integrity_check` returns `ok` | the two observables — *no two writers both commit* and *no acknowledged commit is lost* — are asserted **directly**, not inferred from an error, because there is no error at any layer to infer from |
| ADV-D4 | journal-mode asymmetry | **P5** × 3 modes | under `wal` and `truncate` the loss is **silent** (both commits ok); under `delete` the holder's own `COMMIT` fails with `SQLITE_IOERR_DELETE_NOENT` — **loud** | the prohibition cannot be journal-mode-scoped. `journal_mode` is a persistent, runtime-mutable property of the file, so the only statically expressible rule is the union of the files any mode exposes: `db`, `-wal`, `-shm`. This row is the evidence for that union |
| ADV-D5 | the same act performed by **our own** code — an `src/`-resident snapshot module, or an in-process three-file backup copy | **P4** (build-failing sweep) + **P5** (a variant that does it, run once to show the consequence) | the sweep flags any `fs.open/read/createReadStream/copyFile` whose argument resolves to the database artifact set; the P5 run reproduces ADV-D3 | that an exemption for trusted tooling is the attack with a friendlier name. Chain-archive **N0a** and concurrency-lease **B3e** are both tagged `[manual]` today; ADV-D5 makes them `[unit]` — **a finding**, since the consequence is directly executable |
| ADV-D6 | metadata operations are **not** banned | **P4** | `fs.existsSync` / `fs.statSync` on the artifact set do **not** flag, and a companion P5 run shows they do not void the lock | the sweep distinguishes descriptor-opening from metadata operations, so the ban is enforceable without being unimplementable |

**Quarantine rule (from the spec, and it must be honoured by the harness):** ADV-D3/D5 and the
red-team attack-1 lease test void the process's write lock. They run against a **throwaway database
in their own temp dir, with no write transaction open elsewhere and no reliance on the
writer-generation guard anywhere in their fixture**, and the database is discarded, never reused. The
test file carries the warning comment at the site of the reads, so a later author copying the fixture
is warned at the point of copying. **Enforce this mechanically:** the harness registers voiding tests
in a `VOIDING` set and the runner asserts no `VOIDING` test shares a temp root with a
non-`VOIDING` one.

---

### 3.3 Zero-row / silent-success family — five instances

**Prototyped.** `node /root/adversarial-scratch/quick-controls.mjs`, section [4]:

```
UPDATE ... WHERE id = 1 threw?                             no
  changes reported                                         0
  read-back row                                            undefined
  myGeneration (process A)                                 undefined
  guard comparison A: stored === mine                      true
  guard comparison B: stored === mine                      true
  => two processes both pass the guard                     true
```

| ID | Control | Planted by | Assertion | What a green run proves |
|---|---|---|---|---|
| ADV-Z1 | **unseeded `UPDATE … WHERE id = 1`** registration | **P2** — a fixture with `writer_generation` created but not seeded, plus **P1** variants with (a) the affected-row assertion removed, (b) the read-back assertion removed. **Run twice, once per assertion**, per the spec | for each variant: `changes === 0`, read-back is `undefined`, nothing thrown; **and then the severity assertion** — with `myGeneration` undefined, two simulated processes both pass the guard comparison (`undefined === undefined`) | the failure is not that the guard rejects, it is that **the guard stops existing while reporting healthy**. Asserting only `changes === 0` understates it; the inertness assertion is what makes the control match the requirement. Covers concurrency-lease **B3k**, schema-parity **W4**, chain-archive **S7** |
| ADV-Z2 | **numeric `errcode` discriminator** | **P1** — `variants/error-translate-numeric.ts`, a switch over numeric extended result codes | against the ruled binding the key reads `undefined`, **no arm matches**, every contention error lands on the catch-all, and it surfaces **non-retryable** where a retryable `LEASE_TIMEOUT` / `MIGRATION_LOCK_TIMEOUT` / `TRANSACTION_FAULT` was contractually due; **and the error-catalog drift test stays green throughout** | reachability is outside the drift test's scope, so per-code reachability assertions are required rather than optional. **Measured supporting fact:** the thrown error's own property names are exactly `["stack","message","code"]` — there is no numeric field to key on. Covers durability **F16**, lease **E5b** |
| ADV-Z3 | **worker deadline that ends iteration normally** | **P1** — `variants/stream-deadline-normal.ts` returns `{done:true}` on deadline instead of rejecting | the consumer observes `{done:true}` and **cannot distinguish it from exhaustion**; the assertion is that the yielded key set is a **strict prefix** of the fixture's key inventory while the iteration reported completion | a liveness fix that becomes a correctness bug is caught. Covers temporal **H6f** |
| ADV-Z4 | **schema probe reporting success on a database with no assertions** | **P2** — an empty-but-migrated database | the probe reports `n/a — no rows in scope` for every empty-scope check and the overall result is **not** `pass` | covers chain-archive **N11d** and data-migration **Q2**. See §3.8 for the suite-wide rule |
| ADV-Z5 | **restore checks reporting `pass` on a zero-row archive** | **P2** — the archive's own specified starting state: fresh, greenfield, zero rows | identity, continuity and digest-sweep each report `n/a — no rows in scope`; overall is not a pass; a variant reporting `pass` for all four **fails this test** | an empty artifact is not certified as verified. Covers chain-archive **N11d** |

---

### 3.4 The one-directional drift guard — `UPDATE t SET dg = NULL`

**Prototyped.** `quick-controls.mjs` section [3]:

```
drift guard catches value-without-digest update            true (ck_driftonly_drift)
drift guard ALONE accepts UPDATE ... SET dg = NULL         true
  row now permanently unverified, dg =                     null
with anti-downgrade trigger it is rejected                 true (ck_both_antidowngrade)
legitimate joint recompute still permitted                 true
truncated 16-byte digest rejected by named length CHECK    true
```

| ID | Control | Planted by | Assertion | What a green run proves |
|---|---|---|---|---|
| ADV-N1 | drift-guard trigger **only** | **P2** — two throwaway tables built from the same DDL template, one with both triggers, one with the drift guard alone | on the drift-only table `UPDATE t SET dg = NULL` is **accepted** and `dg IS NULL` afterwards; on the two-trigger table the same statement raises with `RAISE(ABORT)` carrying the **anti-downgrade constraint name** | the drift guard fires on an update of the covered *column* and not on an update of `dg` alone, so the anti-downgrade trigger is **mandatory rather than defence-in-depth**. Covers durability **C4c**, schema-parity **DG8**, chain-archive **R8b** |
| ADV-N2 | the guard must not obstruct a legitimate recompute | **P2**, same fixture | `UPDATE t SET val = ?, dg = ?` with a new 32-byte digest **succeeds** | the guard is not a false-positive machine; without this arm ADV-N1 could be satisfied by a trigger that rejects every update |
| ADV-N3 | **null-rejecting** length constraint | **P2** — a variant DDL with `dg BLOB NOT NULL` / a non-null default | the variant turns every pre-existing row into a permanent verification failure indistinguishable from corruption | why only *null-rejecting* constraints are prohibited. Covers durability's "A null-rejecting constraint is refused" |
| ADV-N4 | the **superseded** rationale — "any length constraint forecloses the NULL marker" | **P2** + **P6** | both forms admit NULL: the null-tolerant form explicitly, and the **bare** `CHECK (octet_length(dg)=32)` form because three-valued logic makes it indeterminate rather than false. Assert both by inserting a NULL row into each | the retraction is checkable, not asserted. Covers durability **C4f** and chain-archive **R8a**. Tagged `[doc][unit]` today; the `[unit]` half is exactly this |
| ADV-N5 | truncated / garbage digest | **P2** | a 16-byte digest is rejected by the **named** length constraint, and the raised message carries the constraint name | a truncated digest is *unrepresentable*, not merely detected, and the name feeds the single extraction function |
| ADV-N6 | **generated-column digest over a UDF** | **P1/P2** — create the column `GENERATED ALWAYS AS (udb_dg(val)) STORED` with the function registered, close, reopen **without registering it** | **[measured]** DDL succeeds; `VACUUM` fails `no such function: udb_dg`; a third-party write fails `unknown function: udb_dg()`; a plain read still succeeds | the schema would permanently depend on the function. Chain-archive **R10** and durability's generated-column control are both `[manual]`; this is executable — **a finding, promote to `[unit]`** |

---

### 3.5 The naive `UNIQUE` and its sentinel sequel

**Prototyped.** `quick-controls.mjs` section [2]:

```
plain UNIQUE accepts exact-duplicate NULL-address row      true   (rows now 2)
coalesce index rejects the duplicate                       true   (UNIQUE constraint failed: index 'ux_ruled')
distinct non-NULL addresses both persist                   3
sentinel '' excluded from the column's real domain         true   (CHECK constraint failed: ck_addr_not_sentinel)
without the CHECK: genuine '' collides with the NULL sentinel  true
```

| ID | Control | Planted by | Assertion | What a green run proves |
|---|---|---|---|---|
| ADV-U1 | plain `UNIQUE (vk_hash, net, scope, contract_address, tag)` | **P2** — a throwaway table with the transliterated constraint | the exact-duplicate NULL-address insert is **accepted**, row count goes to 2 | the v4 audit's data-loss defect is reintroduced by the obvious port. Covers schema-parity **R3**, chain-archive **D6** |
| ADV-U2 | the same port passes every non-NULL test | **P2** | inserting two rows differing only in a **non-NULL** address is accepted by *both* implementations | why the NULL-address scenarios are required rather than optional — a suite whose fixture rows all carry an address is green against the defect |
| ADV-U3 | the **sentinel collision** sequel | **P2** — the coalesce index **without** the domain-excluding `CHECK` | with the `CHECK` absent, a genuine empty-string address **collides** with the NULL sentinel and is wrongly rejected; with the `CHECK` present, the empty string is refused **at the domain**, naming `ck_addr_not_sentinel` | the sentinel is only sound because it is excluded from the column's real domain. Without ADV-U3 the coalesce index looks correct and silently rejects a legitimate value |
| ADV-U4 | static enforcement | **P4** | no `CREATE TABLE` under `src/**/migrations/` declares a `UNIQUE` over a nullable column without the paired expression index and domain `CHECK` | the rule binds tables that do not exist yet, not only today's |

---

### 3.6 `INSERT OR REPLACE`

**Prototyped.** `quick-controls.mjs` section [1]: with a `BEFORE UPDATE` trigger writing a history row,
`ON CONFLICT DO UPDATE` leaves 1 history row; `INSERT OR REPLACE` leaves **1** — the trigger did not
fire and the history row for that update is lost — while the live row is correctly updated to `v3`.

| ID | Control | Planted by | Assertion | What a green run proves |
|---|---|---|---|---|
| ADV-R1 | `INSERT OR REPLACE` against a history-carrying schema | **P2** — a scratch schema with a `BEFORE UPDATE` trigger | after `ON CONFLICT DO UPDATE`: history count increments. After `INSERT OR REPLACE`: history count **does not**, and the live row is nevertheless correct — the loss is invisible from the live row alone | the history-row loss is *demonstrated, not asserted*. Covers temporal **F2** |
| ADV-R2 | the ban is mechanically enforced | **P4** | no SQL string in `src/` or in the migration tool matches `INSERT\s+OR\s+REPLACE` or `^\s*REPLACE\s+INTO`, case-insensitive, and the sweep is shown to flag a planted line in a scratch tree | review alone does not enforce it |

---

### 3.7 The forbidden cursor-first ordering — the shape to imitate

This is the control the brief singles out because it carries a **measured failure rate**: 4/9
violations under SIGKILL against 9/9 for the correct ordering. A control with a measured rate is far
stronger than one asserted to fail, and this lane's crash controls are all written to that shape.

| ID | Control | Planted by | Assertion | What a green run proves |
|---|---|---|---|---|
| ADV-C1 | **watermark-first**, two independently committed transactions | **P1** — `variants/ingest-cursor-first.ts` commits the cursor, then the bundle | over **N ≥ 9** SIGKILL trials with the kill window sampled between the two commits, the variant produces **at least one** reopened archive whose cursor refers to a height whose data was never committed; the shipped co-transactional form produces **zero** in the same N | the invariant is enforced by the transaction boundary, not by ordering luck. Report the rate (`k/N`) rather than a boolean — a control that fails 4/9 tells a reviewer the window exists and is narrow; a boolean does not. Covers chain-archive **W7** |
| ADV-C2 | today's actual ordering (bundle first) | **P1** | the bundle-first variant produces **zero** violations in the same N — it is safe but wasteful | the requirement removes the *ordering dependence*; it does **not** claim the current code is broken. Without ADV-C2 the plan overstates the finding |
| ADV-C3 | `DEFERRED` prune reclaims a live chunk | **P1** + **P5** — a `DEFERRED` prune variant and a concurrent `save` that re-references an otherwise-unreferenced chunk after the prune's read snapshot | the `DEFERRED` variant reclaims the chunk, observable as **a surviving checkpoint that no longer loads**; the `IMMEDIATE` shipped form does not | the C2a justification rests on `BEGIN IMMEDIATE`, not on the carried-over READ-COMMITTED grace-window argument, which is false under WAL. Covers lease **G5** |
| ADV-C4 | cross-file WAL transaction | **P2/P5** — two attached files, a block and its transactions written in one spanning transaction, killed mid-commit | in WAL mode some trials leave the two files disagreeing (reported as `k/N`); with a rollback journal the rate is lower | why the ATTACH prohibition is a **requirement**, not a note: the failure is silent and rare, so it is not caught by a test at implementation time. **State the honest limit** (§5): a small-N run that observes zero torn commits does not refute the hazard, and the test must report `k/N` with N, never `pass` |
| ADV-C5 | rename-before-checkpoint-and-close | **P1** | the variant produces a database missing its most recent commits while `integrity_check` reports `ok` | the WAL sidecars follow the filename. Covers data-migration **J2** |
| ADV-C6 | import straight into the live path | **P1** | a kill mid-import leaves a structurally valid, fully migrated, **partially populated** database that the application starts against, with `integrity_check` `ok` | the in-progress-path-and-rename rule. Covers data-migration's "Importing directly into the live path" |

---

### 3.8 The quadratic `EXCLUDE` transliteration and the blocking `busy_timeout`

**Quadratic control — prototyped.** `node /root/adversarial-scratch/quadratic.mjs`, `/root` ext4, WAL,
`synchronous=NORMAL`, single writer, 6 chunks × 5,000 rows appended to **one** key:

```
unconstrained floor              per-5000-row ms:   5 ->    4 ->    5 ->    5 ->    4 ->    4   last/first =  0.8x
naive EXCLUDE transliteration    per-5000-row ms: 362 -> 1054 -> 1718 -> 2374 -> 3090 -> 3832   last/first = 10.6x
```

| ID | Control | Planted by | Assertion | What a green run proves |
|---|---|---|---|---|
| ADV-Q1 | the whole-history overlap probe `EXISTS (SELECT 1 FROM h x WHERE x.k=new.k AND x.vf<new.vt AND new.vf<x.vt)` | **P2** — a scratch schema carrying the trigger | **the assertion is a shape, not a number**: per-chunk insert time on the shipped path has `last/first ≤ 1.5`; on the transliteration `last/first ≥ 4` over ≥ 6 chunks, i.e. per-chunk time grows monotonically with history length | the prohibition is recorded with an executable demonstration so nobody re-proposes it. **Do not assert 1,441×.** That figure was taken on a RAM disk and the spec itself labels it a *floor*; and my ext4 re-run reaches ~950× per-chunk at only 30k versions. A ratio assertion survives both hosts; an absolute one survives neither |
| ADV-Q2 | blocking `busy_timeout` fails P10 | **P1** + **P5** — a variant setting `PRAGMA busy_timeout = <non-zero>` instead of the external poll loop, run against the **existing** P10 `withLease` workload | the variant produces **1 acquired / 7 `LeaseTimeoutError` out of 8**; the shipped poll loop produces **8/8 acquired** | a green P10 against the shipped implementation demonstrates that the test **detects the failure it is looking for**. Covers lease **E2** |
| ADV-Q3 | blocking `busy_timeout` **inside the worker thread** | **P1** — the same variant with the handle owned by the worker | the contender blocks inside SQLite's busy handler on the worker; the holder's release message **sits undelivered** in the worker's queue until the contender's wait expires; the contender fails `SQLITE_BUSY`; and the **main thread's event loop remains healthy throughout** (assert a timer fires on schedule during the block) | "the worker keeps the event loop turning" does not retire the requirement. The event-loop-health assertion is the point of this arm — without it the control looks like ADV-Q2 run twice. Covers lease **E3** |
| ADV-Q4 | `SQLITE_BUSY_TIMEOUT` unreachable by construction | **P4** | no source sets a non-zero `busy_timeout`, and no handle constructor omits `timeout: 0` | the code is unreachable rather than merely unobserved |

---

### 3.9 Text-level controls and the self-defeating-checker discipline

Change 7 found four of its own criteria asserting a banned phrase was absent **by quoting it**, and
its sweep flagged them. Change 1 (task 0.5b) settled the rule: four classed `MENTION:` markers, a
report of TOTAL / MARKED / UNMARKED **plus both line lists in full**, `UNMARKED = 0` as the gate, and
the marker **re-files rather than suppresses**.

**I ran that sweep verbatim against the sprint tree.** `sh /root/adversarial-scratch/sweep.sh`:

```
DIRECTORY                           TOTAL  MARKED  UNMARKED
v1.0.0-sqlite-chain-archive             3       0         3
v1.0.0-sqlite-concurrency-lease         4       0         4
v1.0.0-sqlite-data-migration            2       0         2
v1.0.0-sqlite-durability-contract       0       0         0
v1.0.0-sqlite-engine-core              12      12         0
v1.0.0-sqlite-schema-parity             2       0         2
v1.0.0-sqlite-temporal-event-log        0       0         0
```

**Finding — J3's hard gate fails today at UNMARKED = 11.** Only change 1, which authored the rule,
has marked its own mentions. And **four of the eleven are precisely the self-defeating shape**:
`concurrency-lease/acceptance.md` H13 and N1 assert the refuted premises are absent by quoting all
five of them; `schema-parity/proposal.md:179-180` quotes the refuted claim in order to retract it;
`chain-archive/{spec,proposal}.md` quote the deferral in order to supersede it. Each is a legitimate
`MENTION:{criterion, retraction}` — the marker just has not been applied. This is a **pre-existing
gate failure**, not something this test plan introduces, and it must be closed before J3 can be a CI
gate at all.

**The three meta-controls, proven.** `sh /root/adversarial-scratch/sweep-selftest.sh` against a
scratch tree (the repo is never modified):

```
=== all three files present ===
DIRECTORY                           TOTAL  MARKED  UNMARKED
v1.0.0-sqlite-fake                      3       2         1
UNMARKED lines:
    v1.0.0-sqlite-fake/plain.md:1:This change asserts the chain archive is out of scope.
MARKED lines:
    v1.0.0-sqlite-fake/marked.md:1:No text asserts "no known external consumer". <!--MENTION:criterion-->
    v1.0.0-sqlite-fake/control.md:1:PLANTED: nothing calls it. <!--MENTION:control-->

=== NC1: remove the unmarked plant -> UNMARKED returns to 0 ===
v1.0.0-sqlite-fake                      2       2         0
```

| ID | Control | Planted by | Assertion | What a green run proves |
|---|---|---|---|---|
| ADV-M1 | **the sweep can fail** | **P6** — plant an unmarked assertion in a scratch tree | it appears under UNMARKED; removing it returns UNMARKED to 0 | a sweep never observed to fail is not evidence that it can. Covers engine-core **J3d** |
| ADV-M2 | **the marker re-files rather than hides** | **P6** — plant an assertion *carrying* a marker | it does **not** appear under UNMARKED and **does** appear in the MARKED list, printed in full | an attribution, not an exemption. Covers **J3e** |
| ADV-M3 | **the checker does not fail on itself** | **P6** — plant a line marked `MENTION:control` | it does not register as a failure | the apparatus proving the gate works does not break it — change 7's case made explicit. Covers **J3f** |
| ADV-M4 | **no heuristic exclusion** | **P6** — a line whose banned phrase is adjacent to the word "negative control" but carries **no** marker | it appears under UNMARKED | proximity/keyword heuristics cannot separate use from mention and would silently re-admit the defect. Covers **J3b** |
| ADV-M5 | the MARKED:UNMARKED **ratio** is reported | **P6** | the report prints per-directory TOTAL/MARKED/UNMARKED and both lists, never a bare pass/fail | a reviewer can see how much of a green result rests on markers rather than on edits, which is the reword-first rule's only enforcement. Covers **J3a**, **J3c** |

**Every text-level control in this lane inherits ADV-M1…M5.** They apply verbatim to the shipped-doc
sweeps: the "SQLite detects nothing" formulation, the restoring-lost-parity claim, the unsourced
frequency figure, the softened cancellation wording, the green-formal-gate safety argument, the
research-figure re-citation, and the six-channel disclosure check. Each such check ships **its own**
three-control transcript, because a sweep proven self-consistent on one pattern is not proven on
another.

| ID | Text-level control | Change / criterion | Assertion |
|---|---|---|---|
| ADV-T1 | "SQLite performs no integrity checking" formulation | durability, two-case wording | zero UNMARKED occurrences across the six disclosure channels; the two-case form is present in each |
| ADV-T2 | "the digests restore parity the PostgreSQL backend provided" | durability | zero UNMARKED occurrences; the operator's-option framing present |
| ADV-T3 | unsourced corruption-frequency figure | durability | no numeric per-unit-time corruption rate appears without an adjacent pinned citation; the "no field base rate obtained" sentence is present |
| ADV-T4 | softened cancellation wording ("best-effort freed", "may be freed") | durability **D4** | zero occurrences; §3 contains two unconditional timings and no freed-wait clause |
| ADV-T5 | green-formal-gate cited as migration evidence | durability **G10** | no document cites the cut-line's survival as safety evidence |
| ADV-T6 | research-phase figure re-cited as fact | engine-core, schema-parity, data-migration, chain-archive | every throughput/latency/duration figure in the change set is either inside a marked measurement block carrying filesystem + `journal_mode` + `synchronous` + dataset-vs-RAM, or flagged |
| ADV-T7 | container-image disclosure channel | durability | the six channels are enumerated and **none of them is a container image** |
| ADV-T8 | a sibling fault whose code is unnamed | durability | every sibling-change fault phrase "SHALL fail with a non-retryable error" resolves to a named catalog code in the routing table |

---

### 3.10 Meta-assertions over the whole control set

| ID | Assertion | Why |
|---|---|---|
| **ADV-META-1** | **A suite in which every negative control passes fails the run.** The registry records each control's expected outcome; a control registered `fails` that passes is a suite failure with the message *"negative control X did not fail — it now proves nothing about the mechanism"* | lease **H3**. This is the single most important row in this plan: it is the mechanism that stops a control from silently decaying into a comment when the implementation it targets is refactored away |
| **ADV-META-2** | **Every property whose enforcement mechanism changed ships a paired negative control.** A CI check cross-references the conformance id list against the registry and fails on any pinned property with no registered control | durability **G5** ("a property with no failing negative control is not accepted"), temporal **J4** |
| **ADV-META-3** | **The whole adversarial suite, run against an empty fixture, fails.** Not "passes with warnings" — fails | §3.11 |
| **ADV-META-4** | **Every control names the requirement title it discharges**, and a check resolves each title against `specs/*/spec.md`, **printing the resolved requirement's title** so a human sees whether the cited claim is still the right one | engine-core **J3h**. Resolving to *a* requirement is necessary but not sufficient — change 7 found two citations stale in content rather than mis-anchored |
| **ADV-META-5** | **Filesystem assertion.** Before any I/O-sensitive control runs, the harness resolves the temp root and asserts its filesystem type is not `tmpfs`/`ramfs`/`overlay`-on-tmpfs, failing with the resolved mount if it is | the brief's hard constraint. A 233× error invalidated a whole research lane |

---

### 3.11 The vacuous-pass rule

Five instances of vacuous passing were found in the specs themselves. The rule for this lane:

1. Every suite that *can* run against an empty fixture calls `assertScopeNonEmpty(name, count)` before
   asserting anything, or reports `n/a — no rows in scope`. **Never `pass`.**
2. An **overall** pass is not reported when any constituent check reported `n/a`, unless the report
   also records, per check, that the empty scope was expected for that database.
3. Every fixture carries a **checked-in inventory** (`fixtures/<name>.inventory.json`: per-table row
   counts and per-case presence flags). The suite asserts the inventory is satisfied **and** that
   every check had rows in scope when it ran. A fixture that silently shrinks — a seeding failure, a
   truncated import, an edit — fails the suite rather than producing a smaller green run.
4. **ADV-META-3** runs the entire suite against a deliberately emptied fixture and requires it to fail.

---

## 4. Test inventory

Type key: U unit · P property · I integration · C conformance · X crash · B benchmark · G CI gate.
"Pass condition" is objective in every row.

| ID | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| ADV-G1 | constant-arg guard fires 3,000 / 9,000,000 | engine-core GUARD / C20b | U | `guard-join` (3k×3k + 200k) | shipped form: `invocations === visitedRows`; constant form: `invocations < visitedRows/1000` |
| ADV-G2 | one-table-arg guard hoisted, both choices | GUARD / C20c | U | same | both arms `invocations < visitedRows/1000` |
| ADV-G3 | single-table test catches neither | GUARD / single-table scenario | U | `guard-single` (200k) | constant form `invocations === 200000`; registered `passes-and-that-is-the-finding` |
| ADV-G4 | deterministic registration collapses to 1 | GUARD (new) | U | same | `invocations === 1`; the registration flag is recorded in the report |
| ADV-D1..D6 | descriptor-attack matrix | lease DESC/B3e, temporal F7b/F7d1, chain-archive N0a | I+X | `atk-<mode>-<arm>` throwaway, quarantined | the 3×3 table in §3.2 reproduces cell-for-cell; `bothCommitted` and `silentLoss` asserted per cell |
| ADV-Z1 | unseeded registration is inert while healthy | lease B3k, schema-parity W4, archive S7 | U | `writer-generation-unseeded` | `changes===0`, read-back `undefined`, nothing thrown, and two simulated processes both pass the guard |
| ADV-Z2 | numeric errcode routes everything to catch-all | durability F16, lease E5b | U | provoked contention error | no arm matches; catch-all reached; surfaced non-retryable; drift test green |
| ADV-Z3 | deadline-normal termination is indistinguishable | temporal H6f | U | `listkeys-100k` | yielded set is a strict prefix of the inventory while iteration reported completion |
| ADV-Z4/Z5 | zero-row scope reports `n/a`, never `pass` | archive N11d, migration Q2 | U+G | `archive-empty`, `fixture-A-emptied` | every empty-scope check reports `n/a`; overall is not `pass`; a `pass`-for-all variant fails |
| ADV-N1..N6 | digest guard family | durability C4c/C4f/C3a, schema DG8, archive R8a/R8b/R10 | U | `dg-driftonly`, `dg-both` | §3.4 assertions |
| ADV-U1..U4 | NULL-address uniqueness family | schema R3, archive D6 | U | `vk-observations` | §3.5 assertions |
| ADV-R1 | `INSERT OR REPLACE` skips `BEFORE UPDATE` | temporal F2 | U | `history-trigger` scratch | history count unchanged after `INSERT OR REPLACE`, incremented after `ON CONFLICT DO UPDATE` |
| ADV-R2 | the ban is mechanically enforced | temporal REP | G | scratch tree | zero matches in `src/`; planted line flagged |
| ADV-C1/C2 | cursor-first vs bundle-first under SIGKILL | archive W7 | X | `archive-ingest` | variant `k ≥ 1` of `N ≥ 9`; shipped and bundle-first `k = 0` of the same N; **`k/N` reported, never a boolean** |
| ADV-C3 | `DEFERRED` prune reclaims a live chunk | lease G5 | I+X | `checkpoint-chunks` | `DEFERRED` variant: a surviving checkpoint fails to load. `IMMEDIATE`: loads |
| ADV-C4 | cross-file WAL commit is not atomic | archive ATTACH | X | two attached files | `k/N` reported with N; **a zero-k run is reported as `inconclusive at N`, not `pass`** |
| ADV-C5/C6 | rename-before-checkpoint; import into live path | migration J2, ATOMIC | X | `migration-target` | missing recent commits with `integrity_check ok`; partially populated DB that the app starts against |
| ADV-Q1 | quadratic overlap probe | temporal EXCLUDE | B | `single-key-30k` | transliteration `last/first ≥ 4`; shipped `≤ 1.5`; conditions block emitted |
| ADV-Q2/Q3 | blocking `busy_timeout` (P10 and worker) | lease E2, E3 | P+U | existing P10 workload | variant 1/8 acquired; shipped 8/8; worker arm additionally asserts a main-thread timer fires on schedule |
| ADV-Q4 | `busy_timeout` is 0 everywhere | lease BUSY | G | `src/` | zero non-zero settings; every handle constructor passes `timeout: 0` |
| ADV-M1..M5 | use/mention sweep meta-controls | engine-core J3a–J3f | G | scratch tree | §3.9 transcripts reproduce |
| ADV-T1..T8 | text-level prohibitions | durability + sprint-wide | G | change set / shipped docs | `UNMARKED = 0` per pattern, each with its own M1–M3 transcript |
| ADV-S1 | non-`STRICT` write silently coerced | schema S3 | U | `strict-vs-not` | non-`STRICT`: stored with `typeof()==='text'`, no error. `STRICT`: `SQLITE_MISMATCH` |
| ADV-S2 | `@>` inversion deletes the wrong rows | schema J4 | U | 7-row identifier fixture `{}, {a}, {a,b}, {a,b,c}, {z}, {b,z}, [a,a]`, finalizing `{a,b}` | inverted predicate selects exactly `{a,b}`,`{a,b,c}`; correct predicate selects exactly `{a}`,`{a,b}`,`[a,a]`; the two agree on 1 of 7 |
| ADV-S3 | `LIKE` matches case-insensitively and drops the range | schema L3 | U | mixed-case key set incl. `Abc`, `aBc` | `LIKE` returns `Abc`/`aBc`; `EXPLAIN QUERY PLAN` shows no key range; range-scan form returns neither and shows the PK range |
| ADV-S4 | `length()` counts characters | schema, CHECK constraints | U | 5-char 6-byte string | `length()===5`, `octet_length()===6` |
| ADV-S5 | unprefixed index/trigger names break the second schema | schema, temporal-kv | U | lineage applied twice under two `schema` values against one file | unprefixed variant fails `index … already exists` / `trigger … already exists`; prefixed applies twice cleanly |
| ADV-S6 | `IF NOT EXISTS` first statement hides the damage | schema I5-5 | U | migrated DB with bookkeeping row deleted | variant silently succeeds and is recorded as freshly applied; shipped form raises |
| ADV-S7 | `next_seq` corrupted down, unique index only | schema SQ4 | U | store pruned to one manifest `seq=34`, `next_seq→5` | variant: insert succeeds, nothing raised, `load()` still returns 34. Shipped: raises at `save()` |
| ADV-S8 | partial `WHERE complete` index | schema SQ5 | U | manifest row with `complete` flipped | row falls outside index coverage; full index covers it |
| ADV-S9 | `foreign_keys=OFF` — prune leaks forever | schema C6, durability G8, migration E3 | U | `prune-fixture` | orphan junction rows survive; chunk reclaim returns **zero**; no error; `integrity_check` `ok`; only `foreign_key_check` names it |
| ADV-S10 | retuned bulk-insert caps | schema B5, engine-core B13 | U | 30,000×2-parameter batch | `too many SQL variables` at 16,384×2; 16,383×2 prepares; façade-split form completes |
| ADV-S11 | `ADD COLUMN … STORED` on 0-row vs ≥1-row | schema MG6 | U | two tables | 0-row succeeds; 1-row fails `cannot add a STORED column` — **[measured]**, refuting the "refused outright" reading |
| ADV-I1 | damaged time-index copy, both arms | temporal I3b | U+P | **P3** copy with an index page mutated | every digest verifies clean; with the assertion the read raises; **without** it the read returns a row violating `written_at ≤ T` |
| ADV-I2 | corrupted-forward cursor latches | archive R16, durability C6b | U | **P3** cursor row set high | plain monotonic guard: **four consecutive** legitimate advances all silently discarded. With I-6: the **first** suppression verifies the incumbent digest and raises |
| ADV-I3 | bare `max(height)` bound does not fire on an empty table | archive R15a | U | zero-row `blocks`, positive cursor | `coalesce(max(height),-1)+1` form raises; bare `max(height)` form evaluates to NULL and neither raises nor passes |
| ADV-I4 | payload corruption invisible to `integrity_check` | durability C2, archive W5 | P | **P3** copy, overflow-page byte overwritten, offset chosen by page role | both-case form: payload damage → `integrity_check` `ok` **and** `quick_check` `ok` **and** the blob returned as data; structural damage → both report and the read throws |
| ADV-I5 | `quick_check` blind to an index omission | durability | U | **P3** copy with an index entry removed | `integrity_check` reports; `quick_check` reports `ok`; an indexed lookup returns nothing a table scan finds |
| ADV-I6 | digest sweep blind to Class B | durability | U | same fixture | sweep reports every row intact; neither check subsumes the other |
| ADV-I7 | bare value hash vs framed preimage | durability C3a | U | whole-row substitution | bare hash verifies clean; framed preimage detects |
| ADV-I8 | canonicalising digest stops detecting | migration F4d | U | two byte-sequences differing only in whitespace | canonicalising variant: equal digests. Byte-exact: unequal |
| ADV-I9 | logical-value digest cries wolf | durability | U | encoding change preserving logical value | logical-value variant fails every pre-existing row; byte digest passes |
| ADV-X1 | gapped source manufactures data | migration D4, temporal B4b | U+P | source key with intervals `[1000,2000)`,`[3000,∞)` | unchecked import: `getAt({at:2500})` returns **version 1** where the source returned `null`, while row counts, per-row digests and every change-2 assertion **pass**. Pre-flight S3: refuses, no target produced |
| ADV-X2 | `kv_current`-only / `kv_history`-only imports | migration C3, C4 | U | 3-version keys | current-only: `get()` agrees everywhere, `kv_current` count passes, `getAt({version:1})` returns `null`. history-only: every `get()` returns the previous value. Both caught **only** by per-key `count(kv_event WHERE key=K) = kv_current.version` |
| ADV-X3 | JS JSON round trip destroys stored numbers | migration F3, temporal | U | `{"fees":12345678901234567890123,"ratio":0.1000000000000000055511151231257827}` | round trip yields `1.2345678901234568e+22` / `0.1`; parsed-value comparison reports **equal**; byte comparison reports unequal |
| ADV-X4 | priority tiebreak instead of refusing | migration D5 | U | version present in both source tables | `getAt` replay passes; `get()` returns a different value; no digest or row count detects it |
| ADV-X5 | sampling a thousand random instants | migration H8 | U | key with a 1 ms boundary shift | exhaustive breakpoint probe detects; 1,000-sample probe misses in ≥ 95% of 100 seeded runs |
| ADV-X6 | quarantining variant | migration M6 | U | source with one constraint-violating manifest | target not observationally equivalent **while reporting success** |
| ADV-X7 | resume that inspects the target | migration J4 | U | interrupted mid-chain key | key skipped with part of its versions present; every isolated check on that key passes |
| ADV-X8 | single whole-file import transaction | migration J9 | U | full fixture import | trips the long-held-transaction diagnostic; the atomicity is already provided by rename |
| ADV-X9 | junction-reading read path | migration E9, schema I7-7 | U | damaged junction | wrong identifiers returned with **every digest passing**; array additionally reordered to code-point order and deduplicated; wrong set propagates into the pending-clear predicate |
| ADV-X10 | importing `_migrations` rows | migration | U | source `_migrations` | bootstrap detection mis-decides; a subsequent lineage extension skips or re-applies |
| ADV-X11 | export in two independently timed passes | migration G4 | U | write landing between passes | bundle violates S3 for a key never inconsistent in the source |
| ADV-E1 | WAL-first pragma ordering | engine-core D2 | U | fresh file | every pragma reports success; file left at `page_size=4096`, `auto_vacuum=0`; the read-back assertion fails |
| ADV-E2 | forwarding the retired option bag | engine-core E3 | U | `{maxConnections, connectTimeout, idleInTxTimeoutMs}` | the binding accepts all three silently and opens normally; the shipped factory rejects each by name |
| ADV-E3 | default integer mode truncates | engine-core B10 | U | `2^63-1`, `2^53+1` | default mode: read ≠ written, no error. 64-bit mode: exact |
| ADV-E4 | hostile text | engine-core E10 | U | unpaired surrogate, embedded NUL | raw engine: surrogate → U+FFFD (round trip unequal), `length()===1` for a 3-code-unit NUL string. Guard: both refused at the boundary |
| ADV-E5 | `Date` bound positionally / normalised to ISO text | engine-core B5 | U | point-in-time read | positional: stored as SQL NULL with no error (or the bind throws). ISO text into `INTEGER` `STRICT`: `SQLITE_MISMATCH`. Non-`STRICT`: silently stored and `written_at <= T` returns the latest row for **every** `T` |
| ADV-E6 | declared-type decoding | engine-core B8 | U | `STRICT` DDL | `JSONB`,`BYTEA`,`TIMESTAMPTZ`,`BIGINT`,`INT4` each rejected at DDL time; a JSON document and a plain string report the same declared type |
| ADV-E7 | incomplete decoder registry | engine-core DECODE | U | view with a window-function column | two columns of one logical type decode to different JS types; fail-closed rule converts it to a named error |
| ADV-E8 | materialise-first stream | engine-core, temporal H6d | B | ≥ 100k rows | materialise-first: time-to-first-row / time-to-drain → 1. Shipped: ratio ≤ 5% |
| ADV-E9 | row-per-message stream | engine-core | B | same | round-trip count equals row count |
| ADV-E10 | abandoned stream wedges the writer | engine-core C17 | U | open raw iterator | a write is refused with the connection-busy error while a read still succeeds; releasing the iterator restores writes |
| ADV-E11 | synchronous binding on the main thread | engine-core LIVE | B | 500k-row materialisation, 64 MiB blob write | event-loop lag during the call exceeds the idle baseline by ≥ two orders of magnitude; the worker topology keeps lag within the declared bound (**bound is B-8-blocked, §6**) |
| ADV-E12 | unpinnable platform module | engine-core PIN | G | scratch project | `node:sqlite`'s version changes across permitted Node versions with **no** lockfile diff, **no** inventory diff, **no** CI signal and **no** runtime warning at the declared `engines` floor |
| ADV-E13 | optional compile option depended upon | engine-core PIN, archive DELETE-form | U+G | pinned binding | the convenient form parses today; a sweep asserts no shipped SQL requires an option absent from the inventoried compile-option set |
| ADV-E14 | lifecycle-scripts-disabled install | engine-core A2 | G | scratch project, `ignore-scripts=true` | install succeeds without compiling; a query returns its result |
| ADV-P1 | interval-table design accepts a gap | temporal B2 | P | interval-table variant with an overlap trigger | `[400,500)` after `[200,300)` accepted; a middle-row `DELETE` opens a gap with no trigger objecting |
| ADV-P2 | `RAISE(ROLLBACK)` vs `RAISE(ABORT)` | temporal F4 | U | scratch trigger | **[measured]** `ROLLBACK`: transaction gone, unaware later write **commits in autocommit**, earlier write **lost**, caller's `COMMIT` fails `cannot commit - no transaction is active`. `ABORT`: transaction intact, both writes commit |
| ADV-P3 | SQL-derived transaction identity | temporal E5 | U | `AUTOINCREMENT` counter-table variant | one extra caller `INSERT` into the counter table defeats the guard and the second same-key write is accepted |
| ADV-P4 | clock-resolution accident is not the enforcement | temporal | U | logical-clock variant | with a monotone logical clock the second same-transaction write is accepted; the adapter write-set rejects it unconditionally |
| ADV-P5 | `opts.tx` accepted but resolved outside | temporal H9c | U | live handle + rollback | the write survives the caller's rollback with no error |
| ADV-P6 | poison flag set only by the statement executor | lease F3 | U | adapter-thrown guard before any statement | variant commits a **partial** result; shipped form poisons the handle |
| ADV-P7 | reads routed through `withTransaction` | lease G3 | U | large `load` + concurrent write | variant holds the write lock for the whole reassembly and blocks the writer |
| ADV-P8 | nested `withTransaction` on an independent transaction | lease D8 | U | nested call | variant self-deadlocks (assert by timeout); `SAVEPOINT` form completes and an inner rollback leaves outer writes intact |
| ADV-P9 | unbounded transaction hold | lease D5 | U | callback awaiting a never-resolving promise | every other writer blocked indefinitely; **no error raised to anyone**; the bounded form rejects with `faultKind:"timeout"` and invalidates the handle |
| ADV-P10 | process-wide concurrency object | lease S4 | U | wallet + archive files | shared queue / bare-key lease map serialises the two lineages despite independent write locks |
| ADV-P11 | guard read outside the write transaction | lease B4 | I | second process registers in the TOCTOU window | variant commits a write from a displaced process |
| ADV-P12 | displacement routed to a retryable code | lease B8 | U | displaced writer | every retry of the bounded-retry policy fails identically; the shipped non-retryable code terminates the loop |
| ADV-P13 | `CONNECTION_ERROR` repurposed | lease E11, durability | U | `SQLITE_CANTOPEN` | mapping it onto `CONNECTION_ERROR` makes a bounded-retry loop spin against a condition that cannot clear |
| ADV-P14 | `DEFERRED` write path | lease D2 | I | concurrent commit between snapshot and first write | `SQLITE_BUSY_SNAPSHOT` **after caller code has run**, not retried by the busy handler, transaction not auto-rolled-back |
| ADV-A1 | `UNION ALL` view over range tables with proving `CHECK`s | archive L7 | U | throwaway range tables | `EXPLAIN QUERY PLAN` shows a search of **every** arm; the single-table form shows one search |
| ADV-A2 | unguarded `INSTEAD OF` routing trigger | archive L8 | U | throwaway view | an out-of-range row: **nothing raised, nothing stored**; the guarded form rejects it naming the guard constraint |
| ADV-A3 | manifest derived from the source | archive N5 | U | ingest committing during the copy | manifest under-reports the artifact; the artifact-derived form matches |
| ADV-A4 | message-matching error translator | archive E4 | U | wording change between patch versions | message-keyed translator mis-routes; code-keyed is unaffected |
| ADV-A5 | serialized transactions offered as single-writer | archive S8 | I | two `archive:sync` processes, no registration | both proceed, transactions interleave **legally**; assert *no two writers both commit* and *no acknowledged commit is lost* |
| ADV-W1..W8 | the review-gate register (P7) | archive L6/N15/N17/R3/R6/R7, durability B4/E9/F8/I2, migration A3/Q7 | G | `docs/decisions/rejected.md` | every row has a non-empty falsifying-observation cell; no text in the change set asserts the rejected premise (via the P6 sweep, each with its own M1–M3 transcript) |

---

## 5. What cannot be tested — and the nearest achievable substitute

| # | Cannot be tested | Why | Nearest achievable substitute | What the substitute does **not** prove |
|---|---|---|---|---|
| 1 | **Power loss.** The `synchronous` decision rule's precondition 2 needs power-loss evidence | SIGKILL is a process crash — exactly the guarantee `NORMAL` **does** make. No amount of SIGKILL corpus speaks to the guarantee `NORMAL` declines | ADV-W-series records the SIGKILL corpus as **inadmissible** for this purpose, with the reason, and the durability default stays `FULL` | that `NORMAL` is unsafe. It proves the corpus does not answer the question |
| 2 | **A coherently wrong file.** A restore from a stale-but-self-consistent backup passes every check UmbraDB can run | there is no internal signal to detect it | the disclosure states it as one of the four named limits, checked by a P6 sweep | that the case is rare |
| 3 | **I/O-fault result codes** (`LEASE_FAULT`, `DISK_FULL`) | cannot be injected without a VFS hook the ruled binding does not expose | catalog rows carry `reachable in principle, untested in practice`, asserted present by a drift-adjacent check; **and a control asserts the label is present**, so a future binding that *does* expose the hook is not silently left untested | that those paths work |
| 4 | **Windows parity** for the writer-generation guard | the descriptor hazard is POSIX-specific; its Windows status is a measurement nobody has taken | the experiment is **specified** (the same 3×3 matrix, run on Windows, with the mode/arm outcomes recorded) and the contract set states whether Windows is supported or explicitly out of scope | anything about Windows until it runs |
| 5 | **Rare cross-file WAL tearing.** ADV-C4 | the failure is silent and rare; the research figure is 1 in 12 WAL trials | report `k/N` with N; a zero-k run is `inconclusive at N`, never `pass`; the ATTACH prohibition stands on the *absence of a super-journal*, a structural argument, not on the trial | that the hazard is absent |
| 6 | **Review rulings** (P7): "a proposal is rejected because its premise is false" | the subject is a proposal, not an artifact | the rejected-proposal register with a mandatory falsifying-observation cell, plus a P6 sweep proving the rejected premise is not asserted anywhere in the change set | **that the ruling is correct.** It proves the ruling and its reason are on the record and uncontradicted. This is stated in the register's own header so a reader does not over-read a green gate |
| 7 | **The abstract→concrete refinement.** The Lean cut-line `{T3,T5,W1,C1}` models an abstract store | the bridge is explicitly trusted and unmechanized | ADV-T5 forbids citing the cut-line's survival as migration evidence; ADV-E5 is the concrete illustration — a bind-layer parameter conversion falsifies T3 without touching a proof | that the refinement holds. The conformance suite carries that claim, not the proof assistant |
| 8 | **The embedding application's descriptor discipline** | UmbraDB cannot enforce it against other code in its process | the precondition is stated as binding on the embedding application with its consequence stated concretely; ADV-D5 shows what happens when it is violated | that consumers will honour it |
| 9 | **Constraint-name recoverability for named table-level `UNIQUE` and `FOREIGN KEY`** — see §7 finding 3 | SQLite does not put the declared constraint name in those messages | a control that *enumerates* the grammars and asserts which constraint kinds are name-recoverable, and a schema rule that every constraint whose name must be recoverable is expressed as a named `CHECK`, a `RAISE(ABORT,'<name>')` trigger, or an expression index | that "every declared constraint name is recoverable", which is **false as written** |

---

## 6. Blocked on measurement

No figure from the research phase may be a pass threshold. These controls have a shape but no
threshold until a B-gate closes. Each is registered `blocked` and the suite **fails** if a blocked
control is silently given a literal.

| ID | Needs | Blocked decision | Interim behaviour |
|---|---|---|---|
| ADV-E11 | the main-thread event-loop lag bound under the worker topology | **B-8** (batch size and idle deadline, across the worker boundary) | assert only the **ratio** (blocked-duration ÷ idle baseline ≥ 100×) against the in-process variant; assert **no** absolute bound for the shipped path |
| ADV-E8/E9 | streaming batch size, idle deadline | **B-8** | assert the time-to-first-row ÷ time-to-drain ratio (≤ 5% at ≥ 100k rows); **no criterion may reference a batch size** |
| ADV-Q1 | archive-realistic row counts and the shipped `journal_mode`/`synchronous` | **B-1/B-2** | ratio assertion only (`last/first`), with a conditions block; the 1,441× research figure is quoted **only** as a retracted RAM-disk floor, marked `MENTION:retraction` |
| ADV-Q2/Q3 | the poll-loop interval and the lease wait budget | **B-4** | assert the acquired/timed-out **counts** (8/8 vs 1/8), which are threshold-free |
| ADV-P9 | the default transaction-hold bound derived from `idleInTxTimeoutMs` | **B-4** | assert that *some* finite bound fires and invalidates the handle; do not assert its value |
| ADV-X5 | whether exhaustive replay fits the wall-clock budget on a representative wallet database | migration RERUN / **B-5** | exhaustive replay is the specified behaviour; the sampling control asserts only that sampling **misses** a 1 ms boundary shift |
| ADV-X7/X8 | **D**, the complete-import duration | migration RERUN | neither resume branch is taken; the control asserts the inspect-the-target shape is wrong **independently of D** |
| ADV-I4 | the verification pass's runtime at representative archive scale | durability, archive gate | the pass is labelled an on-demand diagnostic; no control assumes a scheduled pass is affordable |
| ADV-C1/C4 | N for the SIGKILL and cross-file corpora | archive gate | run at N ≥ 9 and report `k/N`; the N that makes a zero-k run meaningful is itself a measurement obligation |
| ADV-N-series | the digest write cost | durability | recorded, **does not gate** — a measurement that could narrow the coverage set would be the cost-based escape hatch the specification removed |

---

## 7. Findings

Numbered, each with the command that produced it.

1. **The `3,000` figure in acceptance C20b is registration-mode-specific.**
   `node /root/adversarial-scratch/guard-hoist.mjs` — a constant-argument guard registered
   `{deterministic: true}` fires **once** across 9,000,000 visited rows, not 3,000. A control asserting
   `=== 3000` passes against the mild form and **fails against the worse one**. Recommend the criterion
   be reworded to `invocations < visitedRows / 1000`, with both observed values and the registration
   flag recorded.

2. **The use/mention sweep specified in change 1 task 0.5b fails its own gate today at
   UNMARKED = 11.** `sh /root/adversarial-scratch/sweep.sh` — chain-archive 3, concurrency-lease 4,
   data-migration 2, schema-parity 2, engine-core 0 (12 of 12 marked). Four of the eleven are the
   self-defeating shape: criteria and retractions that quote the banned phrase in order to forbid or
   withdraw it. The markers were designed and never applied outside the change that designed them.
   J3 cannot become a CI gate until this is closed.

3. **"Every declared constraint name is recoverable from the error it raises" is false as written, and
   there are more than two message grammars.** `node /root/adversarial-scratch/promote.mjs` and
   `/root/adversarial-scratch/grammars.mjs` produced five:
   ```
   named CHECK              SQLITE_CONSTRAINT_CHECK      :: CHECK constraint failed: ck_t_a
   RAISE(ABORT, name)       SQLITE_CONSTRAINT_TRIGGER    :: ck_u_no_x
   expression UNIQUE index  SQLITE_CONSTRAINT_UNIQUE     :: UNIQUE constraint failed: index 'ux_t_ab'
   named table UNIQUE       SQLITE_CONSTRAINT_UNIQUE     :: UNIQUE constraint failed: t.a, t.b
   FOREIGN KEY              SQLITE_CONSTRAINT_FOREIGNKEY :: FOREIGN KEY constraint failed
   ```
   A named table-level `UNIQUE` reports the **column list**, discarding the declared name; a foreign key
   reports **no identifier at all**. The ruled `coalesce` expression index reports the **index** name — a
   third grammar the requirement does not enumerate. The extraction function needs three grammars, and
   the schema rule needs to say that any constraint whose name must be recoverable is expressed as a
   named `CHECK`, a `RAISE(ABORT,'<name>')` trigger, or a named expression index. Also confirmed:
   the thrown error's own property names are exactly `["stack","message","code"]` — no numeric field,
   which is the mechanism behind ADV-Z2.

4. **Four `[manual]`/`[doc]` criteria are directly executable and should be re-tagged.**
   - chain-archive **N0a** and lease **B3e** (in-process copy voids the write lock) → `[unit]`; reproduced
     by `descriptor-attack.mjs`.
   - chain-archive **R10** / durability's generated-column control → `[unit]`; `promote.mjs` shows
     `VACUUM` failing `no such function: udb_dg` and a third-party write failing `unknown function`,
     while a plain read still succeeds.
   - temporal **F4** (`RAISE(ROLLBACK)`) is tagged "recorded, not run" → `[unit]`; `promote.mjs` shows
     the transaction gone, the unaware later write committing in autocommit, the earlier write **lost**,
     and the caller's `COMMIT` failing `cannot commit - no transaction is active`.

5. **The full 3×3 descriptor matrix reproduces, including the asymmetry.** Under `wal` and `truncate`
   the loss is silent (both `COMMIT`s return ok, `integrity_check` `ok`); under `delete` the holder's own
   `COMMIT` fails `SQLITE_IOERR_DELETE_NOENT` — loud. The open-without-close arm is refused in **all
   three** modes, which is what isolates the fault to POSIX close semantics and is why the source ban
   must cover the union `{db, -wal, -shm}` rather than being journal-mode-scoped.

6. **The `1,441×` quadratic figure should not be a threshold.** `quadratic.mjs` on ext4 reaches ~950×
   per-chunk at only 30k versions with per-chunk time still growing linearly. The number is a function
   of history length and host; the *shape* (`last/first ≥ 4` over ≥ 6 chunks, against `≤ 1.5` for the
   shipped path) is stable and is what the control should assert.

7. **Every prototype in this plan ran on ext4, and the difference is the point.** `/tmp` on this host is
   a 32 GB `tmpfs`. ADV-META-5 makes the filesystem assertion a precondition of the suite rather than a
   convention, because a convention is what failed last time.

---

## Appendix — prototype scripts

Under `/root/adversarial-scratch/` (ext4, never `/tmp`):

| Script | Produces |
|---|---|
| `guard-hoist.mjs` | the 8-row guard-invocation table, §3.1 |
| `descriptor-attack.mjs` | the 3×3 descriptor matrix, §3.2 |
| `quick-controls.mjs` | `INSERT OR REPLACE`, NULL-address uniqueness + sentinel, `dg = NULL`, unseeded registration |
| `quadratic.mjs` | the overlap-trigger growth shape, §3.8 |
| `promote.mjs` | `RAISE(ROLLBACK)`, UDF generated column, `ADD COLUMN … STORED`, constraint grammars |
| `grammars.mjs` | the five constraint message grammars, finding 3 |
| `sweep.sh` | task 0.5b's sweep, run verbatim against the sprint tree |
| `sweep-selftest.sh` | the three sweep meta-controls, against a scratch tree |

None of them writes to `/root/UDB-sqlite-sprint`. The sprint tree was not modified.
