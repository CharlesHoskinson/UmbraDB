# Tasks — v1.0.0 SQLite Engine Core

Ordered tasks for change `v1.0.0-sqlite-engine-core` (capability `sqlite-engine`). Every task states
concrete acceptance criteria — what test passes, what command succeeds, what artifact is
checkable — per `openspec/config.yaml`'s tasks rule. Each task cites the requirement in
`specs/sqlite-engine/spec.md` it discharges and the `design.md` section that specifies it.

**Ordering.** §0 is a blocking gate: the measurement artifact must exist before any pragma *value*
is chosen, and before change 2 makes its clock decision. §1–§2 are the driver and façade and gate
every adapter port. §3 is the worker. §4 is the bootstrap, which cannot be corrected after the first
write. §5 is the surface. §6 is CI. §7 is the conformance re-execution and is last because it
validates everything above.

**Applies to every task.** Do not weaken a conformance property to make it pass (§7.1). Never record
a performance figure without its conditions (§0.1).

> **Amended — the archive prohibition is lifted.** An earlier version of this line read *"Do not
> modify `src/postgres/migrations/chain_archive/**` — it is an explicit non-goal."* That prohibition
> is **withdrawn**: the owner has asked for archive snapshots and the archive is ported to SQLite by
> **change 6**. This change still authors none of the archive's design — the rule is now
> *"the archive belongs to change 6, so do not author its schema or ingestion here,"* not
> *"do not touch it."* The distinction matters for task 1.1, whose acceptance changes as a result
> (`design.md` §8.1, §10.1 R-1).

---

## 0. The measurement gate (BLOCKING — nothing downstream may cite a number until this closes)

- [ ] 0.1 **Build the re-measurement harness.** A runnable suite that sweeps `journal_mode`,
  `synchronous`, `page_size` and `auto_vacuum` on a real (non-memory-backed) filesystem, records
  commit rate and ingest throughput, and emits a machine-readable artifact in which **every datum**
  carries: filesystem + mount options, `journal_mode`, `synchronous`, `page_size`, `auto_vacuum`,
  dataset size, host RAM, concurrent-writer present/absent, binding version and `sqlite_version()`.
  **Acceptance:** one command produces the artifact; a schema check over the artifact fails if any
  datum is missing any condition field; the harness refuses to run when its target directory is on a
  memory-backed filesystem and says so. Discharges "every performance-dependent decision is blocked
  on measurements taken on a real filesystem under declared conditions" (design §6.2).

- [ ] 0.2 **Run the sweep, including an out-of-cache datum.** The artifact must contain at least one
  `synchronous=FULL` cell, at least one `synchronous=NORMAL` cell, and at least one dataset large
  enough relative to host RAM that per-window throughput is reported across the run rather than as a
  single aggregate. **Acceptance:** the artifact contains all three; the large-dataset cell reports a
  per-window series, and its decay (or absence of decay) is visible in the data rather than inferred.

- [ ] 0.2b **Sweep the stream batch size across the worker boundary (B-8).** For each candidate batch
  size, record time-to-first-row, total drain time, round-trip count, observed abort latency, and WAL
  growth during a long-lived stream — measured **through the worker**, on ext4, at the chosen
  `synchronous`. **Acceptance:** the artifact contains a batch-size series with all five quantities
  per point; a purely in-process measurement is recorded as such and is **not** admissible as
  justification for the chosen value (design §3.5.2, §6.3 B-8).

- [ ] 0.3 **Publish the blocked-decision register.** A checked-in table naming each blocked decision
  (B-1…B-8, with B-3 split into B-3a and B-3b, in design §6.3), its owning capability, the exact datum required to close it, and its
  current status. **Acceptance:** every row is either `BLOCKED` with a named missing datum, or
  `CLOSED` citing the artifact datum id that closed it. Change 2 must be able to read B-1 and see
  what it is waiting for. Discharges "the decisions blocked on the measurement gate are named".

- [ ] 0.4 **Close B-2, B-3a and B-3b — choose `synchronous`, `page_size` and `auto_vacuum` for **each**
  database file from the artifact.** B-3 is **two** decisions: the wallet file (B-3a) and the archive
  file (B-3b), which is a separate file per the contradiction seat's C5 and may take a different
  `auto_vacuum`. The sweep must include space-return behaviour at each `auto_vacuum` value, because
  `DROP TABLE`/`DELETE` reclamation is entirely downstream of it (`design.md` §4.10, N-1).
  **Acceptance:** each chosen value is recorded in the register with the artifact datum id that
  justifies it; no value is justified by a research-phase figure; and the record states, for each
  file, whether space is returned on `DELETE` and on `DROP TABLE` at the chosen setting. Blocks §4,
  and **B-3b unblocks change 6's layout ruling**.

- [ ] 0.5 **Close B-8 — choose the stream batch size and idle deadline from the 0.2b series.**
  **Acceptance:** both values are recorded in the register with the artifact datum ids that justify
  them; the record states the abort-latency consequence of the chosen batch size, since an abort
  arriving mid-batch is not observable until that batch ends.

- [ ] 0.5b **Publish the cross-change correction and dependency register** (`design.md` §10) and route
  it to the other authors. It carries: R-1's corrected wording (the archive **is** wired, with the
  four citations, and is owned by change 6 rather than out of scope), N-1's corrected wording (space
  return is a property of `auto_vacuum`, not of `DROP` vs `DELETE`), N-2's rule (no SQL may depend on
  an un-asserted compile option), R-9's corrected wording (three
  distribution channels, no chokepoint, data migration required and owned by change 7), the change 6
  and change 7 dependency rows, and open questions Q-1…Q-3 with owners.

  **Acceptance — the enforcement sweep, rescoped, marked and controlled (G-2).**

  **The root cause, named precisely (change 7).** *A mechanical text sweep cannot distinguish **use**
  from **mention**.* Three changes hit this independently from three directions, and it is one
  problem:

  - **Change 3:** the gate can never go green — a retraction *mentions* the phrase it withdraws, so
    the change documenting the retraction (this one) scored the most hits.
  - **Change 5:** reworded its incidental matches to zero and refused a carve-out —
    *"a gate that needs an exemption to pass is the pattern this round was called on."*
  - **Change 7:** four of its own criteria asserted a phrase was absent **by quoting it**, and its
    sweep flagged them — *"a checker that fails on itself reads as a real failure and will burn a
    reviewer's time on every run."*

  No phrase list resolves this, because the four legitimate mentions are **required by the work**: a
  retraction record must quote what it withdraws; a criterion must name what it forbids; the gate's
  own pattern must spell the phrases; and a negative control must plant one. Change 5's discipline is
  right where the mention is *incidental and avoidable*, and is adopted as the reword-first rule
  below — but it cannot reach any of those four.

  **Adopted: a use/mention distinction the sweep can see, with classed markers.** The marker does not
  make a line disappear; it re-files it into a list printed in full that a reviewer must read. An
  author who marks a genuine assertion has not silenced the gate — they have signed a visible claim
  next to their name. Four classes, so a mislabelled assertion looks absurd rather than plausible:

  | marker | means |
  |---|---|
  | `MENTION:retraction` | quotes a premise **in order to withdraw it** |
  | `MENTION:criterion` | a criterion or requirement that must **name what it forbids** |
  | `MENTION:pattern` | the gate's own pattern definition, or prose explaining it |
  | `MENTION:control` | a planted negative-control line |

  **Why the inference forms stay in despite raising the marker burden.** Change 2 swept against the
  widened list and caught its own `kv_retention` non-goal justifying itself by inferring from an
  artifact's apparent disuse — the same reasoning form as the archive premise, on an unrelated
  artifact. That is the list working as intended. Narrow enough that correct prose never trips is
  narrow enough to miss the next instance, which is the whole defect class.

  ```sh
  cd /root/UDB-sqlite-sprint/openspec/changes
  # The pattern's defining lines carry a marker so the gate does not match itself.
  P='not wired into any runner path|chain archive is out of scope|no known external consumer'   # MENTION:pattern
  P="$P"'|nothing to migrate|nothing calls|no consumer|no runner|if it is ever wired'           # MENTION:pattern
  P="$P"'|exported array nothing'                                                               # MENTION:pattern
  M='MENTION:(retraction|criterion|pattern|control)'
  printf '%-34s %6s %7s %9s\n' DIRECTORY TOTAL MARKED UNMARKED
  for d in v1.0.0-sqlite-*/; do
    t=$(grep -rniE "$P" "$d" | wc -l); m=$(grep -rniE "$P" "$d" | grep -cE "$M")
    printf '%-34s %6s %7s %9s\n' "${d%/}" "$t" "$m" "$((t-m))"
  done
  echo '--- UNMARKED (these fail the gate) ---'; grep -rniE "$P" v1.0.0-sqlite-*/ | grep -vE "$M"
  echo '--- MARKED (these must each be read) ---'; grep -rniE "$P" v1.0.0-sqlite-*/ | grep -E "$M"
  ```

  It **SHALL** (a) cover all **seven** change directories via the `v1.0.0-sqlite-*/` glob, not the
  five the original criterion named; (b) match the **inference forms**, for the reason above;
  (c) exclude only lines carrying one of the four `MENTION:` classes; (d) report **per-directory
  TOTAL / MARKED / UNMARKED plus both line lists**, never a bare pass/fail, so the ratio is visible;
  and (e) require **UNMARKED = 0** as the hard gate.

  **Reword-first rule (change 5's objection, adopted).** A marker is for a mention the work
  *requires*. Where a match is **incidental and avoidable** — prose that happens to contain an
  inference form while discussing something unrelated — the text is **reworded**, not marked. Marker
  use is minimised by construction, and a reviewer seeing a large MARKED count relative to a change's
  retraction load should suspect the marker is being used to avoid an edit.

  **Negative control 1 — the sweep can fail.** Plant an unmarked assertion; confirm it appears under
  UNMARKED; remove it. A sweep never observed to fail is not evidence that it can.

  **Negative control 2 — the marker re-files rather than suppresses (change 5's objection).** Plant
  an assertion *carrying* a marker; confirm it does **not** appear under UNMARKED but **does** appear
  in the MARKED list, where a reviewer would see it; remove it. This is the difference between an
  exemption and an attribution.

  **Negative control 3 — the control itself passes.** Confirm that a line marked `MENTION:control`
  does not register as a failure, so the apparatus that proves the gate works does not itself break
  it. This is change 7's "a checker that fails on itself" case, made explicit rather than tolerated.

  This is the task that prevents seven independently invented wordings.

- [ ] 0.6 **Notify the downstream changes.** Record in the register that B-1 (change 2), B-4
  (change 3), B-5 (change 4) and B-6/B-7 (change 5) are now decidable, with the datum ids, and that
  changes 6 and 7 exist with the dependencies in `design.md` §10.2. **Acceptance:** the register's
  owner column resolves to a real change id for every open row, including the change 6 and change 7
  rows and the Q-1…Q-3 open questions.

---

## 1. Driver selection and supply-chain visibility

- [ ] 1.1 **Add the pinned binding and remove `postgres` outright.** Add `better-sqlite3` to
  `dependencies`; remove `postgres` when the last adapter has ported (§5.4) **and change 6 has ported
  the archive**. `postgres` is **not** retained scoped to `chain-archive-sync/` — that was the
  adjudication's default resolution of R-1 and it is superseded, because the archive is ported rather
  than stranded (`design.md` §10.1). **Acceptance:** `package-lock.json` records an exact resolved
  version with a `sha512` integrity hash; `npm ci` succeeds with effective `ignore-scripts=true`
  (`npm config get ignore-scripts` → `true`) and **without** compiling — the installed tree contains a
  prebuilt `.node` and no build output; `grep -n '"postgres"' package.json` returns nothing; and the
  three archive-touching commands are coherent at the commit that removes it — `npm run typecheck`
  (which compiles `chain-archive-sync/` per `tsconfig.json`'s `include`), `npm run build` (which does
  not, per `tsconfig.build.json`'s `exclude`), and `npm run archive:sync` (`package.json:46`) — each
  either succeeds or fails for a reason recorded in the register, never with an unresolved import of
  a removed dependency. Discharges "the storage engine is an embedded SQLite database reached through
  a version-pinned, gate-observable binding".

- [ ] 1.2 **Inventory the binding and its vendored engine.** Add a runtime row to
  `docs/supply-chain/inventory.md` §1 recording the binding version, its integrity hash, its license,
  and the SQLite version it vendors. **Acceptance:** the row exists and its SQLite version equals
  the value returned by `select sqlite_version()` from the installed binding, checked by 6.1.

- [ ] 1.3 **Record the driver decision and its consequences.** A decision record covering: the
  ruling and its five reasons; the two capabilities given up (`enableDefensive`, `setAuthorizer` —
  verified absent from the binding's prototype); the integer-truncation trap the choice introduces;
  and what choosing the built-in would have cost (design §1.4). **Acceptance:** the record names both
  candidates, states the ruling, and states the falsifying observation for each reason.

---

## 2. The query façade

- [ ] 2.1 **Implement bind normalisation.** `undefined`/`null` → NULL, `boolean` → `1`/`0`,
  `Date` → **epoch-milliseconds integer**, `Buffer`/`Uint8Array` → bytes, `bigint`/`number`/`string`
  passthrough, everything else **throws**. **Acceptance:** a unit test asserts each mapping; a test
  asserts that binding a plain object throws rather than being interpreted as a named-parameter bag;
  a test writes and reads a timestamp and asserts the stored value is an integer, not text.
  Discharges "every bound parameter is normalised before it reaches the binding" (design §2.2).

- [ ] 2.2 **Property test the point-in-time read across the boundary.** Write N versions of a key at
  distinct instants, then read as of instants that fall *between* stored coordinates.
  **Acceptance:** a `fast-check` property asserts the returned version is the one in force at the
  queried instant for every generated instant — the property that a `Date`→NULL or `Date`→ISO-text
  conversion would falsify (design §5.2).

- [ ] 2.3 **Implement origin-keyed row decoding.** Build the decoder registry keyed on
  `(origin table, origin column)` from the prepared statement's column metadata, with explicit
  entries for derived columns, and **throw** on a column with neither. **Acceptance:** unit tests
  cover a plain select, an aliased select, and a select through a view, asserting each column decodes
  by origin; a test asserts a window-function column with no registry entry throws an error naming
  the column. Discharges "result columns are decoded from origin metadata, never from declared type
  names" (design §2.3).

- [ ] 2.4 **Enable 64-bit integer reads and downcast by registry.** Turn on the binding's safe-integer
  mode at handle construction; downcast only columns whose registered decoder declares `number`.
  **Acceptance:** a test writes the maximum signed 64-bit integer to a version-like column and asserts
  the value read back is exactly equal as a `bigint`; a second test asserts the same value read
  through the binding's *default* mode is **not** equal — the negative control that documents why the
  setting is mandatory (design §1.5).

- [ ] 2.5 **Implement the parameter-ceiling split.** Read `SQLITE_MAX_VARIABLE_NUMBER` from the
  running engine (`pragma_compile_options`) and split batches below it. **Acceptance:** a test
  submits a batch whose naive form would bind 60,000 parameters and asserts it completes, and that no
  prepared statement bound more than the engine's reported maximum; a test asserts the limit is read
  from the engine rather than hard-coded. Discharges "no statement is issued with more bound
  parameters than the engine accepts" (design §2.4).

- [ ] 2.6 **Retune and re-baseline the batch constants.** Bring `CHUNK_INSERT_MAX_ROWS` and
  `JUNCTION_INSERT_MAX_ROWS` (`src/postgres/checkpoint-store.ts:62-63`) under the ceiling and rewrite
  that file's 65,534-based comments. The chosen chunk size comes from B-5 (§0.6). **Acceptance:**
  `test/postgres/perf-batching.test.ts` is re-baselined and passes; a test asserts that the *old*
  constants fail to prepare against the SQLite engine, so the regression cannot silently return.

- [ ] 2.7 **Port the identifier splice and the remaining façade helpers** (`sql(ident)`, `sql.json`,
  `sql.array` shape, `sql.unsafe`, `sql.reserve` as a no-op, cursor batching). **Acceptance:** a test
  passes a hostile identifier containing a quote and a statement terminator through `sql(ident)` and
  asserts no additional statement executes and the target table is intact.

---

## 3. The worker boundary

- [ ] 3.1 **Stand up the worker host and RPC.** One worker owns the single database handle; the main
  thread holds only a proxy. **Acceptance:** an integration test performs a full write/read round trip
  through the worker; a test asserts that no value reachable from the public barrel is, or exposes,
  the binding's `Database` or `Statement`. Discharges "the database handle is owned by a dedicated
  worker thread and never escapes it" (design §3.3).

- [ ] 3.2 **Make the transaction handle an opaque token.** The worker mints tokens and validates them
  against its live-transaction table before executing anything. **Acceptance:** a test constructs a
  structurally identical token without obtaining it from the system and asserts the statement never
  reaches SQLite and a typed error is thrown; a test retains a token past commit and asserts the
  same. Discharges "a transaction handle is an opaque token that cannot be used to reach the
  database" — the enhancement mandate (design §3.3).

- [ ] 3.3 **Batch UmbraDB-authored composites into one round trip.** **Acceptance:** an instrumented
  test asserts the round-trip count for the checkpoint-plus-cursor composite is independent of the
  number of statements it issues; the same test asserts a three-statement caller-supplied transaction
  callback costs three round trips, recording the structural limit rather than hiding it (design §3.4).

- [ ] 3.4 **Implement the per-statement deadline and the main-thread abort.** **Acceptance:** a test
  asserts a statement past its deadline is aborted with a typed timeout error; a test asserts an abort
  signalled from the main thread stops a running row-visiting statement; both tests assert main-thread
  event-loop lag stays within an order of magnitude of the idle baseline while they run.

- [ ] 3.5 **Keep the main thread live under a large read.** Cursor batching yields to the macrotask
  queue between batches. **Acceptance:** a test schedules a main-thread timer, issues a query whose
  in-engine cost is hundreds of milliseconds, and asserts the timer fires while the query is still
  running. Discharges "a long read does not starve the main thread".

- [ ] 3.6 **Implement the batched stream protocol.** The worker holds the statement iterator; the main
  thread pulls one batch per round trip and yields rows individually to its consumer.
  **Acceptance:** a test iterates a large result set and asserts the time to the first yielded row is
  a small fraction of the time the same query takes to materialise in full — the ratio assertion a
  materialise-first implementation fails; a test asserts the round-trip count is approximately
  row-count ÷ batch-size, so neither a whole-set message nor a row-per-message stream passes.
  Discharges "a result set is streamed across the worker boundary in batches" (design §3.5.2).

- [ ] 3.7 **Implement stream release: abort, idle deadline, and shutdown.** An abort message releases
  the iterator; the worker releases it unilaterally when the consumer stops pulling for longer than
  the idle deadline; the worker releases every outstanding iterator before closing the handle.
  **Acceptance:** (a) a test aborts mid-stream and asserts the iteration *rejects* — not a clean
  `break` — and that a write issued afterwards succeeds; (b) a test starts a stream, abandons it
  without aborting or closing, waits past the idle deadline, and asserts a write then succeeds and
  that the abandoned stream fails with a typed error when resumed; (c) a test closes the worker with
  a stream open and asserts a clean shutdown rather than the engine's connection-busy error.
  Discharges the release clauses of that requirement (design §3.5.3, §3.5.4).

- [ ] 3.8 **Assert the write-wedge is real, so the deadline cannot later be deleted as defensive
  programming.** **Acceptance:** a test opens a raw iterator on the handle and asserts a write is
  refused with the engine's connection-busy error while a read still succeeds, then asserts releasing
  the iterator restores writes — the negative control documenting why 3.7's deadline exists
  (design §4.9).

- [ ] 3.9 **Record the seam resolution for change 2.** State that the merged requirement's streaming
  scenario **survives** on measured evidence (contradicting the "no SQLite analogue" premise in
  change 4 `design.md` §16.5 / open question 7), that its abort scenario's "cursor released" clause
  survives in substance with a new mechanism, and that release is now a worker obligation rather than
  a consumer courtesy. **Acceptance:** the record names which of the merged requirement's three
  properties each change owns, and change 2's delta references it.

- [ ] 3.9b **Implement the per-row guard and its injection (G-7).** Register the guard UDF
  non-deterministic; wire the `SharedArrayBuffer` flag; have the **shim** inject the guard term into
  every statement in the guarded classes, with an argument depending on **every** table in the
  statement. Publish the guarded/unguarded class enumeration. **Acceptance:** (a) a join of two
  3,000-row tables with the injected guard invokes it 9,000,000 times, while the same join with a
  constant argument invokes it 3,000 times — both asserted, so the hoisting hazard cannot regress;
  (b) a guard argument naming only one of the two tables also invokes 3,000 times, asserted for
  **both** choices of table; (c) a single-table range scan is asserted **not** to distinguish the two
  forms, documenting why the conformance test must use a join; (d) a statement with no guard slot
  invokes zero times and appears in the unguarded enumeration; (e) a running guarded statement aborts
  within measured milliseconds of the flag being set. Discharges "a cancellable statement carries a
  per-row guard whose argument cannot be hoisted" (design §3.4; adjudication §3.3).

- [ ] 3.9c **Re-scope the deadline implementation guarded/unguarded (G-7).** **Acceptance:** a
  guarded statement past its deadline is aborted in flight; an unguarded statement past its deadline
  runs to completion and surfaces a typed after-the-fact fault; a test asserts the caller can
  distinguish the two outcomes.

- [ ] 3.10 **Document the uncancellable cases.** Enumerate statements issued by caller code inside a
  transaction callback, and any operation with no per-row guard slot (per 3.9b's enumeration).
  **Acceptance:** the enumeration exists and states that neither candidate binding exposes an
  interrupt primitive, and that `OMIT_PROGRESS_CALLBACK` is compiled into the ruled binding so no
  progress handler exists either. **Do not** edit `docs/CONTRACT.md` §3 here — that deletion belongs
  to change 5; record the hand-off instead.

---

## 4. The pragma bootstrap (irreversible — do not start before §0.4 closes)

- [ ] 4.1 **Implement the ordered bootstrap.** `page_size` and `auto_vacuum` before `journal_mode`,
  applied to a newly created file before any write. **Acceptance:** a test bootstraps a fresh file and
  asserts the read-back reports the intended `page_size`, `auto_vacuum` and `journal_mode=wal`.

- [ ] 4.2 **Implement the read-back assertion.** Fail with a typed error if any observed value differs
  from the intended one; never treat a pragma statement's own success as evidence. **Acceptance:** a
  test bootstraps with the WAL-first ordering and asserts the read-back **fails** — the negative
  control; a test opens an existing file whose `page_size` or `auto_vacuum` differs and asserts the
  open is refused with a message naming observed and intended values. Discharges "the pragma bootstrap
  is an ordered, once-only sequence whose effect is verified by read-back" (design §4.6, §5.4).

---

## 5. Client surface and lifecycle

- [ ] 5.1 **Implement the replacement connection factory.** One path, one file, one handle, no pool.
  **Acceptance:** a test opens a database from a path and performs a round trip; a test asserts no
  pool-sizing option exists on the type or at runtime.

- [ ] 5.2 **Reject retired and unknown option keys.** **Acceptance:** a test asserts that passing
  `connectionString`, `maxConnections`, `connectTimeout` or `idleInTxTimeoutMs` throws an error naming
  the key and that no database is opened; a second test asserts the binding itself accepts those keys
  silently — the measured negative control that justifies the rejection rule (design §3.2, §4.7).

- [ ] 5.3 **Retype the exported client types and record the breaks.** `UmbraDBSql` (permanent),
  `UmbraDBConnectionOptions`, `DEFAULT_IDLE_IN_TX_TIMEOUT_MS`. Keep
  `DEFAULT_STATEMENT_TIMEOUT_MS`/`DEFAULT_LOCK_TIMEOUT_MS` exported with their current values.
  **Acceptance:** `npm run typecheck` and `npm run build` succeed; a `CHANGELOG.md` entry lists each
  break, states it lands before the `1.0.0` tag citing `docs/STABILITY.md:46` and `:60-61`, and states
  the post-tag cost (each independently forces a major).

- [ ] 5.4 **Update the published metadata.** `package.json:4`'s "PostgreSQL-backed" description and
  `ROADMAP.md`'s "a single Postgres instance" non-goal become false. **Acceptance:** neither string
  describes the shipped engine; a grep for `PostgreSQL-backed` in published metadata returns nothing.

- [ ] 5.5 **Rename and re-justify the hostile-text guard.** Rename `hasPostgresUnsafeText`
  (`src/interfaces/temporal-kv.ts:35`) and rewrite its message and every call-site message from
  "PostgreSQL cannot store either" to state that SQLite silently corrupts both. **Acceptance:** the
  guard is still applied at namespace, scope, key, recursive JSON values and `listKeys`'s prefix; a
  test asserts an unpaired surrogate and a NUL byte are each rejected at each of those inputs; a test
  documents the corruption the guard prevents by asserting that the raw engine returns U+FFFD for a
  surrogate and `length()=1` for a three-code-unit NUL string. **Deleting the guard is forbidden**
  (design §5.3).

---

## 6. CI and gates

- [ ] 6.1 **Assert the engine version in CI.** Add a step to `.github/workflows/supply-chain.yml`
  asserting the running binding's `sqlite_version()` equals the value in
  `docs/supply-chain/inventory.md`. **Acceptance:** the step fails, with both versions in the message,
  when the inventory row is edited to a wrong version.

- [ ] 6.2 **Assert the measurement artifact in CI.** A step asserting the artifact exists and that its
  declared filesystem is not memory-backed. **Acceptance:** the step fails when the artifact is absent,
  and fails with an "inadmissible figures" message when the artifact declares a memory-backed
  filesystem.

- [ ] 6.3 **Rewire `pack-smoke.yml` off Docker.** The round-trip oracle needs a temporary directory,
  not a PostgreSQL container (`.github/workflows/pack-smoke.yml:14-17` currently fails CI when Docker
  is missing). **Acceptance:** `npm run test:smoke` passes on a runner with no Docker daemon, and the
  deep-import rejection and `.d.ts`-present oracles still run.

---

## 7. Conformance

- [ ] 7.1 **Re-execute the P1–P10 conformance suite against the SQLite build.** **Acceptance:** every
  property passes with its text unchanged apart from fixture wiring; `git diff` over the property
  files shows no weakened predicate, no widened tolerance and no removed case. A property that fails
  is a defect to fix, not a property to edit.

- [ ] 7.2 **Record that the formal layer's survival is not assurance.** **Acceptance:** the record
  states that the mechanised cut-line is untouched because it models an abstract store across a
  trusted, unmechanised refinement bridge, and cites the concrete illustration — a bind-layer
  conversion defect falsifies the temporal-projection law without editing a proof (design §9).
