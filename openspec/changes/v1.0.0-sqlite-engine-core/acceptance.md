# Acceptance — v1.0.0 SQLite Engine Core

Objective acceptance criteria for change `v1.0.0-sqlite-engine-core` (capability `sqlite-engine`).
Every criterion is traceable to a requirement in `specs/sqlite-engine/spec.md` and a task in
`tasks.md`, and is marked with how it is verified: **[unit]** unit test, **[prop]** property test,
**[CI]** CI gate, **[doc]** checkable doc artifact, **[manual]** manual reviewer evidence.

**No criterion here asserts a performance number.** The gate criteria below require that numbers be
*established under declared conditions and published*; what those numbers turn out to be is not an
acceptance condition of this change. That is deliberate — six of seven research lanes measured
against a RAM disk, and this change exists partly to make sure that class of figure can never again
be cited as fact.

Requirement short names used in the "Req / Task" column map to `specs/sqlite-engine/spec.md`
headers: **PIN** (pinned binding), **WORKER** (handle confined to worker), **TOKEN** (opaque
transaction handle), **OPTS** (factory rejects retired options), **BOOT** (pragma bootstrap),
**BIND** (bind normalisation), **DECODE** (origin-keyed decoding), **INT64** (integer fidelity),
**TEXT** (hostile-text guard), **PARAMS** (parameter ceiling), **LIVE** (event-loop liveness),
**CANCEL** (deadlines and cancellation), **GATE** (measurement artifact), **GUARD** (per-row guard), **BLOCKED** (blocked
decisions named), **STREAM** (batched streaming across the worker boundary), **CONFORM** (suite
re-executed).

## Precondition (blocks the value-choosing half of this change)

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| P0 | The measurement artifact exists on a non-memory-backed filesystem and contains the `synchronous=FULL`, `synchronous=NORMAL` and out-of-cache cells. Until it does, no pragma **value** may be chosen and §4 may not begin. | [CI][manual] | GATE / 0.1–0.2 |
| P1 | The blocked-decision register (B-1…B-8) is published, every row naming its owning capability and the exact datum required to close it. | [doc] | BLOCKED / 0.3 |
| P2 | The artifact contains the across-the-worker-boundary batch-size series (time-to-first-row, drain time, round-trip count, abort latency, WAL growth). Until it does, the streaming batch size and idle deadline may not be chosen (B-8). | [CI][doc] | STREAM / 0.2b, 0.5 |

## A — Driver selection and supply-chain visibility

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| A1 | The binding is in `package.json` `dependencies` and resolved in `package-lock.json` to an exact version with a `sha512` integrity hash. | [CI] | PIN / 1.1 |
| A2 | `npm ci` succeeds with effective `npm config get ignore-scripts` = `true`, installs a prebuilt `.node` from the tarball, and compiles nothing. | [CI] | PIN / 1.1 |
| A3 | `docs/supply-chain/inventory.md` has a runtime row for the binding recording version, integrity hash, license and the SQLite version it vendors. | [doc] | PIN / 1.2 |
| A4 | CI asserts the running binding's `sqlite_version()` equals the inventoried value, and **fails with both versions in the message** when the inventory row is edited to a wrong version. | [CI] | PIN / 6.1 |
| A5 | `npm audit --audit-level=high --omit=dev` includes the binding in its blocking scope. | [CI] | PIN / 1.1 |
| A6 | The decision record names both candidate drivers, states the ruling, and gives the falsifying observation for each of its five reasons — including that the rejected alternative emits **no** process warning at the declared `engines` floor, and that the chosen binding ships the **newer** SQLite. | [doc][manual] | PIN / 1.3 |
| A7 | The decision record states the two capabilities given up (`enableDefensive`, `setAuthorizer`), verified absent from the binding's prototype, and that no requirement in the sprint may depend on them. | [doc] | PIN / 1.3 |

## B — The query façade

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| B1 | Each normalisation mapping holds: `undefined`/`null`→NULL, `boolean`→`1`/`0`, `Date`→epoch-ms **integer**, `Buffer`/`Uint8Array`→bytes, `bigint`/`number`/`string` passthrough. | [unit] | BIND / 2.1 |
| B2 | Binding a plain object **throws** rather than being interpreted as a named-parameter bag. | [unit] | BIND / 2.1 |
| B3 | A timestamp written through the façade is stored with SQL `typeof` = `integer`, not `text`. | [unit] | BIND / 2.1 |
| B4 | For a key with versions at distinct instants, a read as of any instant *between* stored coordinates returns the version in force at that instant. | [prop] | BIND / 2.2 |
| B5 | Negative control: an ISO-8601-text timestamp written into an `INTEGER` column of a `STRICT` table is **rejected** with a datatype-mismatch error; the same write into a non-`STRICT` table is silently accepted. Both asserted, so the `STRICT`↔normalisation coupling cannot be dropped on one side. | [unit] | BIND / 2.1, 2.2 |
| B6 | Decoding resolves by origin for a plain select, an aliased select, and a select through a renaming view. | [unit] | DECODE / 2.3 |
| B7 | A result column with no origin metadata and no explicit registry entry **throws**, naming the column — it does not fall through to a default decoding. | [unit] | DECODE / 2.3 |
| B8 | Negative control: `JSONB`, `BYTEA`, `TIMESTAMPTZ`, `BIGINT` and `INT4` are each rejected as declared types in a `STRICT` table, and under `STRICT` a JSON document and a plain string report the same declared type — establishing that declared-type decoding is structurally impossible, not merely inadvisable. | [unit] | DECODE / 2.3 |
| B9 | The maximum signed 64-bit integer round-trips exactly as a `bigint` through a version-like column. | [unit] | INT64 / 2.4 |
| B10 | Negative control: the same value read through the binding's **default** integer mode is not equal to the value written, and no error is raised. | [unit] | INT64 / 2.4 |
| B11 | A batch whose naive form would bind 60,000 parameters completes, and no prepared statement bound more than the engine's reported maximum. | [unit] | PARAMS / 2.5 |
| B12 | The maximum is read from the running engine, not hard-coded; a test asserts the source. | [unit] | PARAMS / 2.5 |
| B13 | Negative control: the pre-migration constants (`CHUNK_INSERT_MAX_ROWS = 30_000`, `JUNCTION_INSERT_MAX_ROWS = 20_000`, both 60,000 parameters) **fail to prepare** against the SQLite engine. | [unit] | PARAMS / 2.6 |
| B14 | `test/postgres/perf-batching.test.ts` is re-baselined and passes; the chosen chunk size cites the artifact datum that closed B-5. | [unit][doc] | PARAMS / 2.6, 0.6 |
| B15 | A hostile identifier containing a quote and a statement terminator passed through the identifier splice executes no additional statement and leaves the target table intact. | [unit] | (façade) / 2.7 |

## C — The worker boundary

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| C1 | A full write/read round trip completes through the worker. | [unit] | WORKER / 3.1 |
| C2 | No value reachable from the public barrel is, or exposes, the binding's `Database` or `Statement`, including transitively through returned objects. | [unit][CI] | WORKER / 3.1 |
| C3 | A structurally identical but unminted transaction token causes no statement to reach SQLite and produces a typed error. | [unit] | TOKEN / 3.2 |
| C4 | A token retained past commit or rollback executes nothing. | [unit] | TOKEN / 3.2 |
| C5 | Round-trip count for the UmbraDB-authored checkpoint-plus-cursor composite is **independent** of the number of statements it issues. | [unit] | WORKER / 3.3 |
| C6 | A three-statement caller-supplied transaction callback costs three round trips, and this is recorded as a structural limit of a frozen callback export rather than a defect. | [unit][doc] | WORKER / 3.3 |
| C7 | A statement past its deadline is aborted and surfaces a typed timeout error. | [unit] | CANCEL / 3.4 |
| C8 | An abort signalled from the main thread stops a running row-visiting statement before completion. | [unit] | CANCEL / 3.4 |
| C9 | A main-thread timer scheduled before a several-hundred-millisecond query fires while that query is still running; measured event-loop lag stays within an order of magnitude of the idle baseline. | [unit] | LIVE / 3.5 |
| C10 | The uncancellable cases are enumerated (caller statements inside a transaction callback; any statement with no guard slot, per C20d) and the enumeration states that neither candidate binding exposes an interrupt primitive **and** that `OMIT_PROGRESS_CALLBACK` is compiled in, so no progress handler exists either. The enumeration is consistent with the guarded/unguarded split in C20–C21. | [doc] | CANCEL / 3.10 |
| C20 | The guard UDF is registered non-deterministic and reads a `SharedArrayBuffer` flag; the **shim** injects it — no call site writes a guard call. | [unit] | GUARD / 3.9b |
| C20a | A two-table join (3,000 × 3,000) with the injected guard invokes it **9,000,000** times. | [unit] | GUARD / 3.9b |
| C20b | Negative control: the same join with a **constant or absent** argument invokes it **3,000** times — asserted, so the hoisting hazard cannot silently regress. | [unit] | GUARD / 3.9b |
| C20c | Negative control: an argument naming **only one** of the join's two tables also invokes 3,000 times, asserted for **both** choices of table — establishing that "row-dependent" is not the rule and "depends on every table" is. | [unit] | GUARD / 3.9b |
| C20d | A single-table range scan invokes the guard once per row for **both** forms (200,000 of 200,000), documenting why the conformance test uses a join; and a statement with no guard slot invokes it **zero** times and appears in the unguarded enumeration. | [unit] | GUARD / 3.9b |
| C20e | A running guarded statement aborts within measured milliseconds of the flag being set. | [unit] | GUARD / 3.9b |
| C21 | A guarded statement past its deadline is aborted in flight; an unguarded statement past its deadline runs to completion and surfaces a typed after-the-fact fault the caller can distinguish from an abort. | [unit] | CANCEL / 3.9c |
| C22 | `proposal.md`'s shim premise no longer claims query text is preserved; it claims no call-site author rewrites it, and names guard injection as a shim responsibility. | [doc] | GUARD / 3.9b |
| C11 | `docs/CONTRACT.md` §3 is **not** edited by this change; the hand-off to the release-contract capability is recorded instead. | [manual] | CANCEL / 3.10 |
| C12 | Time-to-first-row for a large streamed result set is a small fraction of the time the same query takes to materialise in full, asserted as a **ratio between two measured timings** — the assertion a materialise-first implementation fails. | [unit] | STREAM / 3.6 |
| C13 | Round-trip count for a streamed drain is approximately row-count ÷ batch-size, so neither a whole-result-set message nor a row-per-message stream satisfies it. | [unit] | STREAM / 3.6 |
| C14 | Aborting mid-stream causes the iteration to **reject** (a clean `break` does not satisfy it), and a write issued afterwards succeeds — evidencing that the iterator was released. | [unit] | STREAM / 3.7 |
| C15 | A stream abandoned without abort or close is released by the worker after the idle deadline: a write then succeeds, and resuming the abandoned stream fails with a typed error. | [unit] | STREAM / 3.7 |
| C16 | Closing the worker with a stream still open succeeds, rather than failing with the engine's connection-busy error. | [unit] | STREAM / 3.7 |
| C17 | Negative control: with a raw iterator open on the handle, a write is refused with the engine's connection-busy error while a read still succeeds; releasing the iterator restores writes. This is what makes the idle deadline load-bearing rather than defensive. | [unit] | STREAM / 3.8 |
| C18 | The chosen batch size and idle deadline each cite an artifact datum measured **across the worker boundary**; no in-process figure is accepted as justification, and the abort-latency consequence of the chosen batch size is recorded. | [doc] | STREAM / 0.5 |
| C19 | The seam record states that the merged `listKeys` streaming scenario **survives** on measured evidence, that the abort scenario's "cursor released" clause survives with a new mechanism, and which of the requirement's three properties each of changes 1, 2 and 4 owns. | [doc][manual] | STREAM / 3.9 |

## D — The pragma bootstrap

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| D1 | A freshly bootstrapped file reads back the intended `page_size`, `auto_vacuum` and `journal_mode=wal`. | [unit] | BOOT / 4.1 |
| D2 | Negative control: the WAL-first ordering makes the read-back assertion **fail**, and without that assertion every pragma statement reports success while leaving the file at `page_size=4096`, `auto_vacuum=0`. | [unit] | BOOT / 4.2 |
| D3 | Opening an existing file whose `page_size` or `auto_vacuum` differs from the intended values is refused with a message naming observed and intended values. | [unit] | BOOT / 4.2 |
| D4 | The chosen `page_size` and `auto_vacuum` values each cite the artifact datum that closed B-3a (wallet file) or B-3b (archive file); no value is justified by a research-phase figure. | [doc] | BOOT / 0.4 |
| D5 | B-3 is recorded as **two** decisions, one per database file, each with a close rule (§6.4), and B-3b is marked as gating change 6's layout ruling. The record states the **structural** reclaim fact only; it does **not** assert which of `DROP` or `DELETE` is faster, that direction being disputed between two single trials. | [doc] | BOOT / 0.4, design §6.3, §6.4 |
| D6 | For each file, the register states whether space is returned on `DELETE` and on `DROP TABLE` at the chosen `auto_vacuum` — asserted, not assumed. | [doc] | BOOT / 0.4 |

## E — Client surface and lifecycle

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| E1 | The factory opens one database file from a path; no pool-sizing option exists on the type or at runtime. | [unit] | OPTS / 5.1 |
| E2 | Passing `connectionString`, `maxConnections`, `connectTimeout` or `idleInTxTimeoutMs` throws an error naming the key, and no database is opened. | [unit] | OPTS / 5.2 |
| E3 | Negative control: the binding itself accepts those same keys silently and opens normally — the measured fact that makes forwarding them a durability hazard rather than a compatibility convenience. | [unit] | OPTS / 5.2 |
| E4 | `npm run typecheck` and `npm run build` succeed after the client types are replaced. | [CI] | OPTS / 5.3 |
| E5 | `CHANGELOG.md` lists each frozen-surface break (`UmbraDBSql` — permanent; `UmbraDBConnectionOptions`; `DEFAULT_IDLE_IN_TX_TIMEOUT_MS`), states it lands before the `1.0.0` tag citing `docs/STABILITY.md:46` and `:60-61`, and states that each would independently force a major post-tag. | [doc] | OPTS / 5.3 |
| E6 | `DEFAULT_STATEMENT_TIMEOUT_MS` and `DEFAULT_LOCK_TIMEOUT_MS` remain exported with their current values. | [unit] | OPTS / 5.3 |
| E7 | No published metadata describes the engine as PostgreSQL-backed; a grep for `PostgreSQL-backed` over published metadata returns nothing. | [doc][CI] | OPTS / 5.4 |
| E8 | The hostile-text guard is still applied at namespace, scope, key, recursive JSON values and `listKeys`'s prefix; an unpaired surrogate and a NUL byte are each rejected at each input. | [unit] | TEXT / 5.5 |
| E9 | The guard's message and rationale state that **SQLite silently corrupts** both inputs; no message still reads "PostgreSQL cannot store either". | [doc][unit] | TEXT / 5.5 |
| E10 | Negative control: the raw engine returns U+FFFD for an unpaired surrogate (round trip not equal) and `length()` = 1 for a three-code-unit NUL string — asserted directly, so the consequence of deleting the guard is a failing test rather than a comment. | [unit] | TEXT / 5.5 |

## F — The measurement gate

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| F1 | The harness runs from one command and emits the artifact. | [CI] | GATE / 0.1 |
| F2 | A schema check over the artifact fails if any datum omits any of: filesystem + mount options, `journal_mode`, `synchronous`, `page_size`, `auto_vacuum`, dataset size, host RAM, concurrent-writer flag, binding version, `sqlite_version()`. | [CI] | GATE / 0.1 |
| F3 | The harness refuses to run against a memory-backed filesystem and says so. | [unit] | GATE / 0.1 |
| F4 | The artifact contains at least one `synchronous=FULL` cell, one `synchronous=NORMAL` cell, and one dataset large enough relative to host RAM to report a per-window series rather than a single aggregate. | [CI][doc] | GATE / 0.2 |
| F5 | CI fails when the artifact is absent, and fails with an "inadmissible figures" message when the artifact declares a memory-backed filesystem. | [CI] | GATE / 6.2 |
| F6 | The blocked-decision register's every row is either `BLOCKED` with a named missing datum or `CLOSED` citing an artifact datum id. B-1 (clock) is present and its required datum is the same-key collision rejection rate at the chosen `synchronous` on a real filesystem. | [doc] | BLOCKED / 0.3 |
| F7 | No requirement, design statement or contract text in this change cites a throughput, latency or rejection-rate figure absent from the artifact. Reviewer sweeps the change's four documents and the register. | [manual] | GATE / 0.3 |
| F8 | The register records that narrowing the clock-related error code's retryability marking would be a **forbidden weakening** of a frozen commitment, so B-1 cannot be closed by assertion. | [doc] | BLOCKED / 0.3 |
| F9 | B-8 is present in the register, its required data are the across-the-worker-boundary batch-size series, and it is `CLOSED` only by artifact datum ids — not by the in-process figures recorded in `design.md` §4.9, which are explicitly marked inadmissible for this purpose. | [doc] | BLOCKED / 0.3, 0.5 |

## G — Conformance and the formal layer

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| G1 | The P1–P10 conformance suite passes against the SQLite build. | [CI] | CONFORM / 7.1 |
| G2 | `git diff` over the property files shows no weakened predicate, no widened tolerance and no removed case — only fixture wiring. | [manual][CI] | CONFORM / 7.1 |
| G3 | The record states that the mechanised cut-line's survival is **not** evidence of migration safety, and cites the concrete illustration: a bind-layer conversion defect falsifies the temporal-projection law without editing a proof. | [doc] | CONFORM / 7.2 |

## H — Scope discipline

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| H1 | This change authors none of the chain archive's schema, ingestion, snapshot format or blob strategy — all owned by **change 6**. *(Amended: the former "nothing under `chain_archive/` is modified" prohibition is withdrawn — the archive is in scope for change 6, not out of scope.)* | [manual] | design §8.1, §10.1 |
| H2 | This change authors no DDL, no event-log schema, no clock policy, no lease mechanism and no contract prose; each is delegated by name to changes 2–5 in `design.md` §0. | [manual] | proposal non-goals |
| H3 | No PostgreSQL→SQLite data-migration path is specified here; change 7 owns it, and its dependencies on changes 1, 4 and 5 are recorded with the wallet-tier-only scope note. | [doc] | design §10.2 |
| H4 | `package.json` `engines` remains `">=24"`. | [CI] | proposal non-goals |
| H5 | This change specifies the streaming **mechanism** only. It authors no delta to `openspec/specs/temporal-kv/spec.md:213` — what `listKeys` still promises is change 2's, and the predicate it issues is change 4's §11. | [manual] | design §3.5.6 |
| H6 | This change specifies no content for change 6 or change 7 — only their dependencies, the two engine facts handed to change 6 (`SQLITE_MAX_LENGTH` = 1 GB; no incremental BLOB I/O), and change 7's wallet-tier-only scope. | [manual] | design §10.2 |

## J — The cross-change correction register

| # | Criterion | Verify | Req / Task |
|---|---|---|---|
| J1 | R-1's corrected wording is published with all four citations (`package.json:46`, `sync-cli.ts:38`, `bootstrap.ts:21`, `sync-service.ts:123`) plus the `tsconfig.json` include / `tsconfig.build.json` exclude asymmetry, and states that the in-file "not wired" comment is stale. | [doc] | design §10.1 / 0.5b |
| J2 | R-9's corrected wording is published, stating the three distribution channels (git tag, repo clone, docker images) as fact and that the absence of a registry entry is the absence of a chokepoint, not of consumers. | [doc] | design §10.1 / 0.5b |
| J3 | **The sweep covers all seven change directories** (`v1.0.0-sqlite-*/` glob) and matches the **inference forms as well as the literal ones**, per the pattern in task 0.5b. **UNMARKED = 0** is the hard gate. | [CI] | 0.5b |
| J3a | **The sweep reports the ratio, never a bare pass/fail:** per-directory TOTAL / MARKED / UNMARKED, followed by the UNMARKED lines *and* the MARKED lines in full. A reviewer can see how much of the result rests on markers rather than on edits. | [CI] | 0.5b |
| J3b | **Exclusion is a use/mention distinction the sweep can see, in four classes** — `MENTION:retraction` (quotes a premise to withdraw it), `MENTION:criterion` (a criterion naming what it forbids), `MENTION:pattern` (the gate's own pattern), `MENTION:control` (a planted control line). All are HTML or shell comments: invisible when rendered, greppable in source. No proximity or keyword heuristic is used — a heuristic cannot separate use from mention and would silently re-admit the defect the sweep exists to catch. | [CI][doc] | 0.5b |
| J3c | **Reword-first.** Where a mention is *incidental and avoidable*, the text is reworded, not marked; markers are reserved for mentions the work requires (a retraction record, a criterion, the pattern, a control). A MARKED count out of proportion to a change's retraction load is itself a review signal. | [doc][manual] | 0.5b |
| J3d | **Negative control 1 — the sweep can fail.** A planted unmarked assertion appears under UNMARKED; removing it restores the prior state. Transcript pasted. | [CI] | 0.5b |
| J3e | **Negative control 2 — the marker re-files rather than hides.** A planted assertion *carrying* a marker does **not** appear under UNMARKED but **does** appear in the MARKED list where a reviewer would see it — an attribution, not an exemption. This is the control change 5's objection requires. Transcript pasted. | [CI] | 0.5b |
| J3f | **Negative control 3 — the checker does not fail on itself.** A line marked `MENTION:control` does not register as a failure, so the apparatus proving the gate works does not break it. This is change 7's "a checker that fails on itself" case, made explicit. Transcript pasted. | [CI] | 0.5b |
| J3g | **The use/mention rule is published sprint-wide (N-5), not invented per change** — three changes hit it independently in one round, and a per-change fix would produce three incompatible conventions. | [doc] | design §10.1 / 0.5b |
| J3h | **Citation checks print the resolved requirement's *title* (N-6).** Cross-change citations use title anchors; the check surfaces the resolved title so a human can see whether the cited claim is still the right one. Resolving to *a* requirement is necessary but not sufficient — change 7 found two citations stale in content, not merely mis-anchored, and re-derived rather than re-pointed. | [CI][doc] | design §10.1 / G-16 |
| J4 | `postgres` is removed from `package.json` outright; it is **not** retained scoped to `chain-archive-sync/`. | [CI] | PIN / 1.1 |
| J5 | At the commit removing `postgres`, `npm run typecheck`, `npm run build` and `npm run archive:sync` are each coherent — succeeding, or failing for a reason recorded in the register, never with an unresolved import of a removed dependency. This is R-1's closing condition. | [CI] | PIN / 1.1 |
| J6 | The register carries change 6 and change 7 dependency rows, each naming what it needs from changes 1, 4 and 5, and change 7's wallet-tier-only scope note. | [doc] | design §10.2 / 0.6 |
| J7 | Open questions Q-1 (docker-image upgrade semantics), Q-2 (is the "port the archive" reading of the owner's answer correct), and Q-3 (does repo-clone imply consumers running `archive:sync` from source) are recorded with owners. | [doc] | design §10.3 / 0.5b |
| J8 | The register states that any cost estimate assuming zero data-migration work is understated by whatever change 7 costs. | [doc] | design §10.1 |
| J9 | N-1 publishes the **structural** claim only: reclamation is a function of `auto_vacuum` and pages freed, **orthogonal to `DROP` versus `DELETE`** — at `NONE` and at `INCREMENTAL`-without-explicit-vacuum neither reclaims; at `FULL` both do; the cost lives in the reclaim, not the statement (change 6's `INCREMENTAL` pair: operations 19.9/16.8 ms, reclaims 194.0/188.9 ms — 2.6% apart). J9 **does not** mandate publication of any direction or factor. | [doc] | design §4.10, §10.1 |
| J9a | The `DROP`-versus-`DELETE` **direction** is recorded as **disputed and unresolved** — this change's single trial against change 6's two-scale harness, which found them comparable at 6k rows and `DROP` 14% faster at 120k — attributed to both, adopted from neither, with change 6's M-4 named as the item that settles it. No acceptance criterion, requirement or register entry states a direction as fact. | [doc] | design §4.10 |
| J10 | N-1 is routed to change 6 as a pragma fact, with the layout ruling left explicitly to change 6. The **structural** claim is what change 6 consumes; the disputed direction is flagged as unresolved between two single trials and is **not** a premise change 6 must adopt. Whether change 6's Form B condition remains sufficient is change 6's call. | [manual] | design §10.1, §10.2 |
| J11 | N-2 is published, and the inventory records the binding's compiled option set alongside its version. | [doc] | PIN / 1.2, design §10.1 |
| J12 | The error-object hand-off records that own properties are exactly `{code, message, stack}` with no structured constraint field, that constraint identity (including a `RAISE(ABORT,'<name>')` name) lives only in the message string, and that this is a **regression** against PostgreSQL rather than the opportunity L5 recorded. | [doc] | design §4.11, §4.12 |

> **Reconciliation note — the driver ruling.** Lane L3 recommended the `node:sqlite` built-in; the
> commitments council seat ruled for a pinnable third-party binding. This change adopts the seat's
> ruling, and criteria A2, A6 and B10 are the three places where the adoption is *checked rather
> than asserted*: A2 because L3's own refutation of the `ignore-scripts` objection is what makes the
> binding admissible at all, A6 because L3's "newest SQLite" advantage is inverted by measurement,
> and B10 because the chosen binding introduces a silent integer-truncation trap the rejected one
> does not have. A driver ruling that did not carry its own costs into the acceptance table would
> not be falsifiable.
