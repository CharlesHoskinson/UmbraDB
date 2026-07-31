# Proposal — SQLite durability contract, error catalog and evidence

> **Status:** Draft for the 1.0.0 program. Capability: `release-contract`. Change id:
> `v1.0.0-sqlite-durability-contract`. Change **5 of 5** in the PostgreSQL → SQLite migration
> sprint. This change owns the *written* half of the migration: the contract documents, the frozen
> error catalog, the startup durability probe, backup/restore, the corruption-detection decision,
> and the evidence obligations that carry the refinement claim. It authors no adapter code.

## Why

For a storage library the written contracts **are** the product; the TypeScript types are their
shadow (`openspec/changes/v1.0.0-api-surface/proposal.md`, "Why"). A storage-engine replacement is
therefore not finished when the adapters compile — it is finished when every sentence in
`docs/CONTRACT.md`, `docs/ERROR-CATALOG.md`, `docs/durability-contract.md`, `docs/STABILITY.md` and
`docs/recovery/EVIDENCE.md` is true of the new engine, and when the sentences that can no longer be
made true have been *deleted* rather than softened.

Four facts make this change urgent and cheap, in that order.

**1. Two of those documents are currently false in the safe direction, and one is about to become
false in the dangerous direction.** `docs/CONTRACT.md:8-37` (§1) binds a deployer to four PostgreSQL
server settings that will not exist. That is a *simplification*: `fsync`, `full_page_writes`,
`synchronous_commit` and the no-transaction-pooler rule collapse into pragmas the library sets
itself, so the probe moves from asking a server what it was configured to do
(`src/postgres/durability-probe.ts:200-206`, `current_setting(...)` and take the answer on trust) to
asserting what UmbraDB itself applied. That is a genuine gain and this change writes it down. But
`docs/CONTRACT.md:65-67` — *"the in-flight cursor / lock wait is **freed**: the driver's
`query.cancel()` fires"* — rests on `postgres.js` opening a second connection to issue a protocol
`CancelRequest` (`src/postgres/abort.ts:30-36`). There is no second connection to an embedded
engine. That clause must be **deleted, not reworded**, and it is the one permanently broken promise
in the whole migration.

**2. A stored value's bytes can be corrupted, returned to the caller as data, and detected by
nothing — and the research recorded this as an improvement.** Lane L6's finding that per-frame WAL
checksums make the torn-page hazard "structurally absent" is true *of the write-ahead log* and false
of the main database file. Verified by this author on the worktree host (command and verbatim output
in `design.md` §2.1): corrupting 64 bytes inside a checkpointed main database yields
`integrity_check → ok`, `quick_check → ok`, and the corrupted row is returned to the application
**as data**.

The precise claim matters, and the loose version would not survive review. SQLite's checks are
**structural**, and the boundary is two-sided: damage to SQLite's own structures **is** detected and
the read fails; damage confined to a stored value's bytes is **not**. So the honest statement is that
the structural check is sound for *rejection* and not sound for *acceptance* — `ok` means "no
structural fault was found", never "the data is intact."

**And this is not a regression from the PostgreSQL backend, because UmbraDB never had page
checksums.** The startup probe reads exactly `fsync`, `synchronous_commit` and `full_page_writes`
(`src/postgres/durability-probe.ts:204-206`); `grep -rn "data_checksums\|amcheck\|pg_checksums" docs/
src/ README.md` returns nothing; and PostgreSQL initialises the option off by default across
UmbraDB's whole supported range. What the migration removes is the **operator's option** to enable a
protection UmbraDB never required, checked or promised. That is a weaker engineering claim and a
stronger documentation obligation: the gap was undisclosed on **both** backends.

UmbraDB's own SHA-256 content-addressing covers `ckpt_chunks` and `ckpt_manifests`
(`src/postgres/checkpoint-store.ts:65-66,366-368,378`) and the chain-blob store, and covers **nothing
else** — not `kv_event`, not `watermarks`, not `transaction_history`, not the bridge and verifier-key
observations. Those hold wallet state, sync cursors, and the two observation sets with no upstream to
re-derive from. A silent data-corruption detection hole is not something a storage library may leave
undocumented. This change closes it where it bites and writes down what remains open.

**3. The commitments are not yet in force, so every break here is nearly free — but only now.**
`docs/STABILITY.md:46`, verbatim: *"Current version: `0.9.5` — the commitments above are NOT yet in
force."* `:60-63` adds that "a breaking change between `0.9.5` and `1.0.0` is permitted by SemVer."
That suspension covers the exported type surface **and** the machine-facing error-`code` set —
`docs/STABILITY.md:3-6` names both, and `docs/ERROR-CATALOG.md:11-13` delegates upward to it. Pre-tag,
renaming `UNRECOGNIZED_POSTGRES_ERROR`, adding codes, and marking `CONNECTION_ERROR` unreachable each
cost a CHANGELOG entry. Post-tag, the rename alone forces a 2.0.0, and a `CLOCK_REGRESSION` that
narrows from `conditional` to `non-retryable` forces another — `docs/ERROR-CATALOG.md:13` forbids
weakening a `retryable` marking in terms.

**4. The evidence artifacts must be re-executed, and that cost is already sunk.**
`docs/recovery/EVIDENCE.md:10-11` forbids amendment outright ("The run MUST be against the **RC
commit** … MUST NOT be copied in"), and its Run-identity table records `postgres:17-alpine` while
M5-3 reads "a fresh object graph is constructed **from Postgres**". But `ROADMAP.md:389-398` already
requires a fresh RC and a full R1–R12 re-run before the tag, blocked on the local Midnight sync. The
migration's *incremental* cost against EVIDENCE.md is therefore near zero — this corrects L6, which
billed it as a break. Separately: **EVIDENCE.md violates its own binding rule 2 today.** Rule 2
(`:12-13`) says "If a field could not be captured, write `NOT CAPTURED` — do not infer it," and the
entire Cold-boot round-trip table at `:44-53` is six blank cells, neither captured nor marked. That
is a defect in a gate artifact whose only value is scrupulousness, and it is fixed here.

Grounding follows this project's own convention (`openspec/config.yaml`, correctness rule): every
code and document claim below cites `file:line` in this worktree, and every measurement cites the
command that produced it. Claims taken from a lane report or an external project are labelled as
citations, not as findings.

## What changes

1. **`docs/durability-contract.md` is rewritten around library-controlled pragmas.** Four binding
   deployer preconditions become one (*put the file on a local, non-networked filesystem*). The
   startup probe stops reading `current_setting('fsync')` and starts asserting `journal_mode`,
   `synchronous` and `foreign_keys` on the handle UmbraDB itself opened, plus a hard filesystem-type
   refusal that is the transaction-pooler detector's true successor. The `fsync`-latency calibration
   is a **warning heuristic only**, framed with the same "detector, not a guarantee" language the
   pooler check already uses for itself (`docs/durability-contract.md:73-77`).

2. **The `synchronous` default is `FULL`, and the rule for changing it is specified rather than the
   number.** Six of seven research lanes benchmarked against a tmpfs RAM disk; re-measured on ext4
   the `synchronous=FULL` commit rate moved by 233x. No throughput figure from that corpus is
   quotable. This change therefore specifies a **decision rule** with named preconditions —
   change 1's ext4 measurement gate, *and* power-loss evidence — and records that nobody has the
   latter: every crash result in the sprint is SIGKILL, which is a process crash and is precisely
   the guarantee `synchronous=NORMAL` *does* make. L6 is right that `NORMAL` is already
   contract-legal in kind (it maps onto the `synchronous_commit=off` lost-tail the current probe
   warns about at `src/postgres/durability-probe.ts:101-118` rather than refuses); it is wrong to
   treat that as sufficient to spend the lever.

3. **`docs/CONTRACT.md` §3 loses its middle timing.** The cancellation contract narrows to what a
   mechanism can deliver: pre-dispatch abort survives verbatim; mid-quick-write survives (trivially,
   it becomes always "may still complete"); the "freed" clause is deleted. What partially survives
   is stated precisely and conditionally: a wait UmbraDB implements **in JavaScript** observes an
   abort at its next poll boundary; a wait or scan inside one SQLite call does not; and
   `withTransaction(fn)` is structurally uncancellable because `fn` is caller code that cannot be
   shipped to a worker.

4. **`docs/CONTRACT.md` §6 is rewritten, and the backup primitive is established by measurement
   rather than asserted.** The seats disagreed — one measured `VACUUM INTO` freezing the JavaScript
   thread and recommended the online backup call; another called `VACUUM INTO` "the right primitive"
   on a claim that proved to be a citation rather than a finding; a third re-measured and ruled
   against the second. But **every one of those measurements used `node:sqlite`**, and change 1 has
   since ruled for a pinned `better-sqlite3`, whose backup surface differs — change 1 records this as
   blocked decisions **B-6/B-7**. This change therefore specifies the *decision rule*: the conditions
   the re-measurement must be taken under, and both branches, **including the branch in which UmbraDB
   documents that it has no live-backup mechanism** and states the offline quiesce-then-copy
   procedure instead. The `-wal` sidecar footgun, the absence of point-in-time recovery, the
   checkpoint-blocking behaviour, the shipped backup call's actual cancellation behaviour, and
   `integrity_check`'s content-blindness become contract text under either branch.

   One fact survives the driver ruling untouched and is worth stating plainly: no SQLite project has
   a live-backup story matching `pg_dump`. Core Lightning warns that `VACUUM INTO` locks the main
   database for long periods and **retracted** its Litestream recommendation; LND's SQL `Copy` is
   `errors.New("not implemented")`; Zallet's procedure begins "Stop Zallet." Under the second branch
   that ceases to be background and becomes the justification for the text.

5. **The error translator is keyed on the ruled binding's string discriminator, not on a numeric
   result code.** Verified first-hand against the already-installed `better-sqlite3@13.0.2` (command
   and output in `design.md` §0.4): `err.name === "SqliteError"`,
   `err.code === "SQLITE_CONSTRAINT_PRIMARYKEY"`, and `err.errcode` is **`undefined`**. Every
   error-translation sketch in the research corpus keys on the numeric extended result codes, which on
   the ruled binding match nothing and route *every* database failure to the catch-all — no throw, no
   warning, and the drift test stays green because reachability is outside its scope. Most of the
   catalog would go dark at once. This change carries that as a negative control and requires
   per-code reachability assertions. A second hazard the ruling creates: driver errors and
   `StorageError`s now both carry a string `.code`, so the translator's already-typed passthrough
   must key on `instanceof StorageError`, never on the presence of `.code`, or raw driver errors
   escape to the caller.

6. **The detection gap is closed on a three-class model, and the residual is disclosed in six
   channels.** Coverage is assigned by corruption class, not by re-derivability alone: **Class A**
   (wrong bytes) gets a value digest; **Class B** (wrong row, or no row) gets **invariants**, because
   a digest is blind to it — the row it verifies is intact; **Class C** (schema-text damage) gets a
   schema digest verified at `open()`. Re-derivability survives as the obligation test *inside*
   Class A.

   Covered, by explicit column: `kv_event.value`; `watermarks.value` in **both** lineages;
   `transaction_history.entry`; and all non-PK columns of `bridge_observations` and
   `verifier_key_observations`. Uncovered with a *stated mechanism*, not a shrug: the
   content-addressed tables (rehash-on-read, already real in code) and the archive projection tables
   (`blocks`, `transactions`, `chain_blob_roles`), which are projections of verified blobs protected
   by an invariant plus a documented rebuild rather than a digest column on a table whose row count
   scales with the chain. This resolves change 6's open question M-5.

   The digest is SHA-256 over the **stored bytes** — never a logical value, because a digest that
   fires on an encoding change is a digest operators disable — with a versioned, length-prefixed
   preimage binding table, column and primary key, computed adapter-side and guarded by a no-UDF
   trigger. Verification is **mandatory on every read, with no opt-out**. A documented-as-dangerous
   **salvage bypass** ships on day one, off by default: every comparable system was eventually forced
   to add one, and it is not a coverage opt-out. `verifyIntegrity()` runs the structural check **and**
   the digest sweep **and** the schema digest **and** the invariants, reported together and never
   refusing — neither half subsumes the other, and `quick_check` is not an alternative anywhere.
   Recovery is **row-scoped and read-time**, never whole-database refusal, with exactly one deliberate
   exception: a schema-digest mismatch, which refuses at open because it silently weakens the rules
   governing every future write.

7. **The error catalog gains four codes, repurposes none, and keeps `CLOCK_REGRESSION` conditional.**
   `CONNECTION_ERROR` stays exported and becomes documented-unreachable rather than being
   re-pointed at `SQLITE_CANTOPEN`/`READONLY`/`NOTADB`. `UNRECOGNIZED_POSTGRES_ERROR` and its class
   are renamed pre-tag. `docs/STABILITY.md` gains two sentences: one binding the `{situation → code}`
   mapping the catalog never froze, and one stating that "additive-only" does not extend to widening
   the exported string-literal union types.

8. **The evidence obligations are specified as re-execution with negative controls.**
   `docs/recovery/EVIDENCE.md` re-executed (never amended), its rule-2 defect fixed and lint-guarded;
   P1–P10 re-executed against SQLite; new properties P11–P15; the refinement register written
   **before** the port, not after; and the deletion of a pinned conformance id handled as a reviewed
   contract change in its own commit, separate from the `EXPECTED_REQUIRED_COUNT` edit.

9. **An observability answer for "the wallet is stuck."** Nothing can inspect a running embedded
   engine from outside the process — `pg_stat_activity`, `pg_stat_statements`, `EXPLAIN ANALYZE`
   against a live workload and every exporter built on them have no analogue, and with a worker
   owning the only handle the situation is worse, not better. This change requires a documented
   diagnostic surface and a triage procedure, **without** adding a public frozen observability API
   (that deferral is `v1.0.0-api-surface`'s and is not reopened here).

## Non-goals (explicitly out of scope)

- **The chain archive is owned by `v1.0.0-sqlite-chain-archive`, not by this change.** An earlier
  draft justified the exclusion on the archive's then-dormant status in the repository. **That
  premise is retracted sprint-wide**: the archive is a live workstream with its own change, its own
  lineage and a long-running synchronisation CLI, and text asserting its dormancy is prohibited in
  every change. What this change supplies to the archive is
  bounded and named: the archive-lineage rows of the digest coverage set, the anti-latch invariant
  applied to the archive cursor, and the contract text. It specifies no archive schema, no archive
  code and no archive schedule. Archive error codes remain outside the frozen catalog
  (`docs/ERROR-CATALOG.md:139-147`).
- **The PostgreSQL-to-SQLite data migration is owned by `v1.0.0-sqlite-data-migration`.** This change
  supplies the digest regime that migration reuses, and rules on catalog membership for its failures;
  it specifies no exporter, no importer, no verification ladder and no CLI surface.
- **The driver choice, the shim, the worker topology and the pragma bootstrap ordering.** Owned by
  change 1 (`v1.0.0-sqlite-engine-core`), which has **ruled: a pinned `better-sqlite3`, not the
  `node:sqlite` built-in**. This change *consumes* that ruling — and re-verifies its own consequences
  first-hand (`design.md` §0.4) rather than taking them on relay — but does not make it, does not
  decide worker-versus-in-process, and does not fix `page_size` or `auto_vacuum` ordering or the
  measurement gate. It also does not author the supply-chain inventory entry that must record the
  binding's version and its `sqlite_version()`, though it requires that entry to exist.
- **The TemporalKV encoding, the monotone logical clock, and `written_at` semantics.** Owned by
  change 2. This change constrains only the *catalog consequence*: whatever change 2 rules,
  `CLOCK_REGRESSION` may not lose its `conditional` marking.
- **The writer-lease mechanism, `BEGIN IMMEDIATE`, the JS poll loop, sticky-poison emulation, and
  the contention error mapping.** Owned by change 3. This change writes the cancellation sentence
  that depends on the poll loop **conditionally on change 3 shipping it**, and records the
  prohibition on a new contention error code.
- **Schema, DDL, `STRICT` tables, indexes, the junction table and the migration lineage.** Owned by
  change 4. This change requires that every SQLite `CHECK` constraint be explicitly named (the
  routing table depends on it) but does not author DDL.
- **`SECURITY.md`.** The threat model is gate G15's document and `docs/CONTRACT.md:135-143` is a
  reserved pointer by design. This change updates the *pointer* to record that the at-rest menu has
  narrowed (SQLite has no in-engine encryption; SEE is commercial, SQLCipher is a fork) and flags it
  to G15. It does not author `SECURITY.md`.
- **Any public observability or tracing API on the frozen surface.** `v1.0.0-api-surface` deferred
  this deliberately (its acceptance criterion N3). The diagnostic surface required here is a support
  procedure plus an internal RPC, not a new frozen export.
- **The PostgreSQL-to-SQLite data migration itself** — exporter, importer, verification ladder and
  CLI surface — is `v1.0.0-sqlite-data-migration`'s. That path is being built, outside the frozen
  surface; this change supplies only the digest regime it reuses and the catalog-membership ruling
  its failures are specified against.
- **Any performance number as a commitment.** `ROADMAP.md`'s own position is that no perf number
  gates the tag. This change writes requirements to *establish* numbers under stated measurement
  conditions; it asserts none.

## Impact

- **Rewritten documents:** `docs/CONTRACT.md` (§1 durability + the corruption-gap acceptance, §3
  cancellation, §4 the second retry clause, §5 the lock-hold backstop note, §6 backup/restore, §7
  the pointer note); `docs/durability-contract.md` (whole file); `docs/ERROR-CATALOG.md` (four added
  rows, one rename, one documented-unreachable marking, the count rationale re-derived);
  `docs/STABILITY.md` (the `{situation → code}` sentence, the union-widening sentence, and a
  retraction paragraph recording that the "surface at 1.0.0 is expected to be identical" expectation
  was not met and why).
- **Replaced code:** `src/postgres/durability-probe.ts` (234 lines) is replaced by a SQLite probe
  with the same shape — pure classifiers plus a live probe — so its unit tests port rather than being
  rewritten.
- **New test surface:** the corruption-detection property and its negative control; the backup
  closure property; the pragma-persistence property; `foreign_keys=ON`; the re-executed P1–P10 with
  negative controls; a doc lint for EVIDENCE.md rule 2.
- **Conformance-manifest change:** `test/integration/required-tests.manifest.json` has 25 required
  ids structurally pinned by `EXPECTED_REQUIRED_COUNT = 25`
  (`test/integration/check-required-tests.ts:100`); **6 of them are engine-named in the id itself**
  and 4 more live under `test/postgres/` (both counts derived by this author's own script, output in
  `design.md` §2.6). Editing that set is a reviewed contract change, not test maintenance.
- **Risk.** The dominant risk is writing a contract that is *nicer* than the engine. Every
  requirement below is therefore phrased so a reader can name the observation that falsifies it, and
  the two places the research was most confident — "WAL checksums remove the torn-page hazard" and
  "`VACUUM INTO` is the right primitive" — are the two this change reverses.
