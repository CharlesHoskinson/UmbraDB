# Audit — seat `unbriefed`

**Scope:** the seven `v1.0.0-sqlite-*` changes on `sprint/sqlite-migration`, read cold against the
repository. Judged on: could a competent engineer who was not part of this work implement from them?

All line references are to files under
`/root/UDB-sqlite-sprint/openspec/changes/` unless otherwise stated. Every "verified" claim below
pastes the command that produced it.

---

## 1. Verdict

**APPROVE WITH FINDINGS.**

This is a genuinely good specification set — the requirement texts are falsifiable, the negative
controls are the best I have read in a plan this size, and the discipline of writing measurement
obligations instead of numbers is applied consistently enough that I could not find a bare research
figure in any spec. A competent outsider could implement roughly 85% of it without asking anyone
anything. But the remaining 15% is not evenly distributed: it is concentrated in the seams that were
created when changes 6 and 7 were added to a five-change sprint, and it contains **one flat
contradiction a builder cannot resolve alone** (the `dg` length `CHECK`), **one mandatory invariant
assigned to a change that has never heard of it** (I-4), and **one safety mechanism that the plan's
own logic requires for the archive database file and that no change specifies** (writer-generation
registration on `umbra-archive.sqlite`). Four acceptance criteria and one normative spec line are
known-false and are still shipped as written, by an explicit decision recorded in change 6's
`design.md` §14.3. None of this is architectural; all of it is edit-level. But an implementer would
hit each of it on day one, and two of the items are the kind that pass every test while being wrong.

---

## 2. The questions an implementer would have to ask, ranked by how much they block

### Q1 (blocking, day one) — Does migration `009` put a length `CHECK` on `dg`, or not?

Three specs describe the same column and two of them forbid what the third mandates.

- `v1.0.0-sqlite-schema-parity/specs/storage-schema/spec.md:766-772`:
  > each SHALL carry a named constraint of the form `CHECK (dg IS NULL OR octet_length(dg) = 32)`

  in the requirement titled *"wallet-tier digest columns are declared under this capability's
  conventions"*, which explicitly governs migration `009_value_digests`.
- `v1.0.0-sqlite-durability-contract/specs/release-contract/spec.md:207-210`:
  > The column ... SHALL NOT carry a length `CHECK` in the same migration that adds it.

  Unconditional, in the requirement that owns the digest.
- `v1.0.0-sqlite-chain-archive/specs/chain-archive/spec.md:836-838, 847-851`: same prohibition again,
  for the archive tables, with a reason (`NULL` is the not-yet-computed marker).

The stated reason in changes 5 and 6 does not actually justify the prohibition against change 4's
form, because change 4's `CHECK` is null-tolerant and forecloses nothing. So the *rationale* is wrong
in one place and the *instruction* is contradictory in another, and a builder writing `009` has to
pick. This is the single clearest defect in the set: two changes' spec text cannot both be satisfied.

### Q2 (blocking) — Who registers a writer generation for the archive database file?

Change 6 rules that the archive lives in its own file (`spec.md:46-49`, "The chain archive SHALL be
stored in a database file distinct from the wallet tier's"). Change 3's cross-process writer guard is
specified for one file, and its own non-goal says so:

`v1.0.0-sqlite-concurrency-lease/proposal.md` non-goals:
> The writer-generation guard is specified for the one database file the wallet tier writes; the
> archive file, **if it is ever wired**, gets its own registration under its own change.

Change 6 *is* that change. It contains no writer-generation requirement, no registration row, and no
migration creating one. Verified:

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint/openspec/changes && grep -rn "writer.generation\|writer_generation" v1.0.0-sqlite-chain-archive/'
(no output)
```

Change 4 creates `007_writer_generation` in the *wallet* lineage only
(`storage-schema/spec.md:499-513`); the archive lineage is `chainArchiveMigrations`, a separate
lineage in a separate file. So today the plan says: start `npm run archive:sync` twice and the second
process is undetected. Given that `archive:sync` is a standalone long-running CLI that an operator
can plausibly start twice, this is the most likely-to-bite gap in the sprint. The implementer must
ask: is the archive file exempt from the guard by decision, or by omission? Nothing in seven changes
says.

### Q3 (blocking) — Who owns invariant I-4, and what exactly is it?

Change 5 distributes eight mandatory Class B invariants and requires (`release-contract/spec.md:420-449`)
that *"each invariant SHALL name exactly one owning change"* and that *"an invariant owned by another
change SHALL be recorded as closed there."* Its `design.md:476` assigns:

> | I-4 | writer registration asserts a single affected row and a defined read-back; failure is a
> startup error, not an undefined generation | **change 3** |

and `v1.0.0-sqlite-schema-parity/design.md:1301` and `v1.0.0-sqlite-chain-archive/design.md:1024`
repeat the assignment. I-4 does not appear anywhere in change 3:

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint/openspec/changes && grep -rn "I-4" v1.0.0-sqlite-concurrency-lease/'
(no output)
```

Change 3's registration requirement (`transaction-lease/spec.md:146-161`) says the system SHALL bump
the generation and SHALL retain the read-back — but never says a zero-row `UPDATE` or an undefined
read-back is a startup error. Change 4 covers the *seed row* half with an excellent negative control
(`storage-schema/spec.md:529-536`), which makes the omission easy to miss: the seed removes the
common cause, not the assertion. Meanwhile change 5's own task 3.7 has as its acceptance criterion
*"changes 2, 3, 4 and 6 have each acknowledged their rows"* — which is currently unsatisfiable.

### Q4 (blocking) — How does an abort or a statement deadline reach a worker that is synchronously blocked inside SQLite?

`v1.0.0-sqlite-engine-core/specs/sqlite-engine/spec.md:509-518` requires:

> The system SHALL enforce a per-statement deadline **inside the worker** ... The system SHALL support
> aborting a running statement from the main thread **for statements whose execution re-invokes a
> per-row guard**.

The term *per-row guard* is used four times across the sprint and defined in no spec. The ruled
binding exposes no interrupt primitive — verified independently:

```
$ wsl -e bash -lc 'grep -n "Database.prototype" /tmp/l3-bs3b/node_modules/better-sqlite3/lib/database.js'
64: prepare  65: transaction  66: pragma  67: explain  68: backup  69: serialize
70: function  71: aggregate  72: table  73: loadExtension  74: exec  75: close
76: defaultSafeIntegers  77: unsafeMode
```

No `interrupt`; and `v1.0.0-sqlite-engine-core/design.md:716` records that `OMIT_PROGRESS_CALLBACK`
is compiled in, so there is no progress handler either. The only mechanism named anywhere is a single
sentence in change 1's *design* (`design.md:365-366`): *"A worker plus a `SharedArrayBuffer` flag
polled by a guard UDF cancels a row-visiting statement."* That is a real answer, but it is a design
aside, not a requirement, and it raises three questions no change answers:

1. Which statements carry the guard UDF? An implementer must decide per call site; the spec is
   written as though the property is universal.
2. If the guard call must appear in the SQL text, the shim's premise — *"the ~190 hand-written
   `sql`…`` call sites port with query text preserved rather than rewritten"* (change 1
   `proposal.md:76`) — is false for every guarded statement. Who rewrites them?
3. Change 3's hold bound (`transaction-lease/spec.md:447-458`) and change 1's stream idle deadline
   (`sqlite-engine/spec.md:431-434`) both depend on the worker's message queue being drainable — the
   very property change 3's own negative control at `:486-495` shows is absent while a synchronous
   call is in flight. The two requirements are consistent only if the guard exists; the guard is
   specified nowhere.

### Q5 (blocking for change 6) — Is reading a snapshot artifact a violation of the descriptor ban?

Change 3 (`transaction-lease/spec.md:254-285`) requires a **build-failing** check banning *"any
file-system operation that opens a descriptor on the database file or either of its `-wal` / `-shm`
sidecars — including reads, opens, copies and read streams"*, and requires that the check *"cover
indirect construction — a helper that takes the database path and derives one of those paths."*

Change 6 puts `src/sqlite/chain-archive-snapshot.ts` inside `src/` and requires it to
(a) derive every manifest field *"by reading the finished snapshot artifact"*
(`chain-archive/spec.md:581-582`), (b) compute a content digest over it (`:627-641`), and (c) run
four checks against a restored file (`:643-650`). A snapshot artifact *is* a SQLite database file, and
the module necessarily takes a database path.

Change 6 never mentions the ban; change 3 never mentions snapshots except to hand the problem away
(`:337-343`, *"the release-contract capability SHALL therefore specify offline copy procedures as
out-of-process or post-quiesce, which is recorded as a handover rather than specified here"*). Change
5 then specifies the procedure as a *document*, not as code (`release-contract/spec.md:672-680`). So
the question lands on nobody: is change 6's snapshot module in-process UmbraDB code that the build
check will reject, or an out-of-process tool? The answer changes where the file lives and what it can
be written in.

### Q6 (blocking for change 7) — Is the migration's content digest over stored bytes, or over a canonicalisation?

Change 5 (`release-contract/spec.md:276-281`): the preimage *"SHALL be computed over the **exact bytes
SQLite stores** and SHALL NOT be computed over a re-serialisation, a normalised form, or a parsed
logical value."*

Change 7 (`data-migration/spec.md:410-418`): after establishing that an imported value and a natively
written value can legitimately differ byte-for-byte,

> the content digest SHALL therefore be computed over the bytes as stored, **through one
> canonicalisation applied identically on both sides**

Change 7 elsewhere (`:582-604`) insists it *"SHALL NOT choose a digest algorithm"* and reuses change
5's `dg`. So either (a) the migration digest is the `dg` value, in which case there is no
canonicalisation and the sentence at `:416-418` is wrong, or (b) there is a canonicalisation, in which
case it is a second mechanism and change 7's own negative control at `:618-624` forbids it. The
implementer cannot write the fold without a ruling.

### Q7 (non-blocking but immediate) — How many database handles and how many workers?

`sqlite-engine/spec.md:169-172` — *"The connection factory SHALL accept a filesystem path identifying
exactly one database file"* — and `:107-111` — *"The database handle SHALL be constructed inside, and
confined to, a single dedicated worker thread"*. Change 6 requires two files in one process
(`chain-archive/spec.md:46-49`). Two clients means two workers, or one worker with two handles; the
lease is process-local per key (change 3 `:20-30`); change 3's write queue
(`proposal.md` Impact, `src/sqlite/transaction-lease.ts`) is described once, unqualified by file. An
implementer must decide whether the write queue, the poison flag, the hold-bound watchdog and the
transaction-token table are per-handle or per-process. Nothing says. It is answerable by a competent
person, but it is a decision nobody in the sprint made.

### Q8 — Is the whole ladder mandatory, or is V5b conditional?

Change 7's `proposal.md` item 4: *"A verification ladder V1–V5, **every rung mandatory**."*
Its spec (`data-migration/spec.md:502-518`) makes V5b conditional — *"where the source is still
reachable"* — and then states the consequence honestly. The spec is right and the proposal is stale;
a builder reading the proposal first will build the wrong thing.

### Q9 — What happens to an existing database when the gate changes `page_size`?

`sqlite-engine/spec.md:231-235` requires refusing to open an existing database whose `page_size` or
`auto_vacuum` differs from *"the intended values"*. The intended values are deferred to the
measurement gate (B-3a/B-3b). If the gate is re-run, or the intended value is ever revised, every
database created under the old value is refused permanently, with no migration path — the spec itself
says neither setting can be corrected in place. Nothing states whether the intended value is pinned
per-lineage, recorded in the file, or version-scoped. This is the one irreversible decision in the
sprint whose *change control* is unspecified.

### Q10 — Which of change 5's four new codes covers change 4's two new non-retryable errors?

`storage-schema/spec.md:569-571` and `:717-718` both say the error code *"belongs to
`v1.0.0-sqlite-durability-contract`'s catalog and is not chosen here"* and that *"a new code SHALL NOT
be minted without first checking the existing catalog."* Change 5 adds exactly four codes
(`release-contract/spec.md:826-829`) and does not route either of change 4's two situations — a
sequence-allocation invariant failure and an I-7 cross-check failure — to any of them. Both are
non-retryable integrity failures; `VALUE_INTEGRITY` is the plausible target but is defined as *"a
re-verified digest does not match its value"* (`:228-232`), which neither situation is.

---

## 3. Contradictions and unowned mechanisms

### 3.1 Specified twice, differently

| # | Subject | Change A | Change B | Status |
|---|---|---|---|---|
| C1 | `dg` length `CHECK` in the introducing migration | change 4 `spec.md:769-770` mandates it | changes 5 `spec.md:210` and 6 `spec.md:848-851` forbid it | **flat contradiction** |
| C2 | Chain-archive scope | change 5 `spec.md:22-24` "The chain archive is out of scope entirely" | change 5's own coverage table `:158-163` assigns mandatory digest coverage to five archive tables; its task 3.1 requires archive-table tests | **self-contradiction inside one change** |
| C3 | Archive physical layout | change 5 `spec.md:163` "`blocks` (and every partition child)"; `design.md:474` "a partial unique index on **every partition child**" | change 6 `spec.md:107-111` prohibits partition children outright | **change 5 written against an abandoned premise** |
| C4 | Change 6's layout ruling | change 1 `design.md:853, 1024, 1044` + `acceptance.md:95 (D5), :159 (J10)` treat it as a two-form ruling whose "Form B" is gated on B-3b | change 6 `design.md:245`: "**None survives. Form B is folded into Form A**, and the layout is unconditional" | **change 1 has an acceptance criterion that cannot be truthfully satisfied** |
| C5 | `lockTimeoutMs` | change 1 `proposal.md:78-79` "`lockTimeoutMs` maps to `busy_timeout`" | change 3 `spec.md:460-463` "`PRAGMA busy_timeout = 0` on **every** handle" | proposal stale; change 1's `design.md:297` already hedges, the proposal was not updated |
| C6 | Data migration | change 5 `acceptance.md:185 (N7)` "No PostgreSQL-to-SQLite data-migration path is built or promised" | change 7 exists and is that path | **unamended; change 7 lists the fix as required and does not make it** |
| C7 | Consumer question | change 4 `acceptance.md:18 (P3)` and `tasks.md:30 (0.3)` treat the git-tag-consumer question as open | change 1 `proposal.md:153-158` records the owner answered it, and change 7 is the consequence | **condition discharged, artifacts not updated** |
| C8 | Migration digest | change 5 `spec.md:276-281` stored bytes, no normalisation | change 7 `spec.md:416-418` "one canonicalisation applied identically on both sides" | wording contradiction (Q6) |
| C9 | Verification ladder | change 7 `proposal.md` item 4 "every rung mandatory" | change 7 `spec.md:502-518` V5b conditional | proposal stale |
| C10 | Archive non-goal wording | changes 2, 3, 4, 5 all cite `001_chain_archive_core.ts:86` as evidence the archive is unwired | changes 1 and 6 establish the comment is stale and the archive **is** wired | **known and deliberately unfixed — see below** |

C10 is the one the plan documents against itself. `v1.0.0-sqlite-chain-archive/design.md` §14.3 lists
seven exact file:line locations still carrying the refuted wording, including a **normative spec
line** (`v1.0.0-sqlite-durability-contract/specs/release-contract/spec.md:23`), and closes:

> Each of those changes owns its own text; this change records the list rather than editing another
> author's spec.

The correction is nominally tracked — change 1 `tasks.md:74-80` and change 6 `tasks.md:333` both
require a later grep — but it is tracked as a *verification by a non-owner*, and the four owning
changes still carry acceptance criteria that assert the false statement as a completion condition
(change 2 `acceptance.md:170` N6, change 3 `acceptance.md:157` N1, change 5 `acceptance.md:178` N1 and
`:185` N7). A reviewer signing those off signs off on a statement two other changes in the same sprint
prove false. That is worse than an unfixed typo: it is a gate that certifies something untrue.

### 3.2 Owned by nobody

1. **The per-row guard** (Q4). Cited by change 1's spec, change 3's hold bound, change 5's
   cancellation contract and change 6's abort-driven iterator release. Defined by no requirement in
   any change.
2. **Writer-generation for the archive file** (Q2). Required by the plan's own logic, specified
   nowhere, and explicitly deferred by change 3 to a change that then didn't do it.
3. **Invariant I-4** (Q3). Assigned by three changes to a fourth that has never referenced it.
4. **The error codes for change 4's two new non-retryable faults** (Q10). Each change defers to the
   other's catalog; the catalog does not contain them.
5. **A single index of the sprint.** There is no document listing all seven changes, their order, and
   their dependencies. Changes 2, 3, 4 and 5 each say "Change N **of 5**"; changes 6 and 7 say "sixth"
   and "Change 7 of the program". The nearest thing to an ordering is a table buried in change 1's
   `design.md:924-930`. A newcomer's first question — "what do I read first?" — has no answer in the
   sprint's own artifacts.

---

## 4. Where the argument does not hold

### 4.1 The citation chain does resolve for reasoning, but not for line numbers

The changes cite each other by `file:line` constantly, and the *reasoning* almost always holds up —
I could follow every substantive claim to a real requirement. But the line numbers themselves have
rotted. Sampling change 7's citations into change 5 and change 1:

```
$ wsl -e bash -lc 'sed -n "145,147p;403,406p;667,671p" .../v1.0.0-sqlite-durability-contract/specs/release-contract/spec.md'
```

- change 7 `spec.md:603` cites `durability-contract/spec.md:145-147` for *"VALUE_INTEGRITY reserved for
  a read-path mismatch"* → lands on the coverage-set preamble. The real text is at `:228-232`.
- change 7 `spec.md:604` cites `:403-420` for *"forbids re-pointing at a different situation"* → lands
  on the `quick_check` negative control. The real requirement is at `:821-846`.
- change 7 `spec.md:710` cites `:667-677` for *"the long-held transaction diagnostic"* → lands on the
  no-live-backup branch. The real requirement is at `:1111-1132`.
- change 7 `spec.md:95` cites `engine-core/spec.md:161-171` for the pragma ordering → lands on the
  transaction-token requirement. The real one is at `:203-235`.

Three of four sampled citations resolve to the wrong requirement. None is a *reasoning* error — the
cited proposition exists — but a builder instructed to "check the cited line" will read something
unrelated, conclude the citation is wrong, and lose confidence in the rest. Given that the house
convention (`openspec/config.yaml`) makes `file:line` citation the correctness discipline of this
project, a systematically stale citation layer is a defect in the discipline itself, not cosmetic.

### 4.2 "Verification on every read, no opt-out" is falsified by the column's own nullability

Change 5 requires (`spec.md:331-341`) that there be *"no configuration flag, option, or environment
variable"* disabling verification, and *"no term whose value could make the coverage set
conditional."* But `dg` is nullable and `NULL` is specified (`:234-236`) to mean *"return the value
with a one-time process-level warning ... it SHALL NOT be an error."* The nullability of the column is
exactly a term whose value makes coverage conditional per row. Two consequences the argument does not
address:

- The drift-guard trigger (`:225-227`, and change 6 `spec.md:840-845`) aborts *"an update of the
  covered column which does not also change `dg`"*. It is one-directional: `UPDATE t SET dg = NULL`
  does not touch the covered column and is not caught. A single statement silently downgrades a row to
  permanently-unverified, and the only signal is a once-per-process warning.
- For the archive, change 6 states both that every row is written with its digest in the same
  statement (`spec.md:853-859`, greenfield, no backfill) **and** that an absent digest is *"the honest
  state of a row whose digest was never computed"* (`:803-808`). In a lineage where "never computed"
  is unreachable, the absent-digest branch is the corruption branch, and it is specified to warn
  rather than raise. Change 7 saw this and closed it for the migration (`:595-598`, a `NULL` after
  import is an import defect). Nobody closed it for the steady state.

### 4.3 The cost of the coverage set is pre-committed against evidence that does not exist

Change 5 (`spec.md:1202-1204`): *"The digest write-cost measurement SHALL **record** and SHALL NOT
**gate**: the coverage set is unconditional, and no measured value changes it."* The supporting
argument (`:343-350`) is that relative percentage is the wrong unit *"against a commit dominated by
`fsync`"*, on *"wallet-state tables and not bulk-scan hot paths."* That argument is sound for
`kv_event`, `watermarks` and `transaction_history`. It is not applied to `bridge_observations` and
`verifier_key_observations`, which are archive-tier ingest tables written in a batch loop, covered by
the more expensive **multi-column** preimage (`:215-217`), and verified on every read. The sprint
simultaneously records (`:1188-1193`) that the verification pass's runtime *"at a representative
archive scale"* is one of five unmeasured quantities. So the one place the cost argument does not
reach is the one place the cost is admitted to be unknown, and the spec forecloses in advance the only
measurement that could inform it.

### 4.4 The single-writer guarantee is honest about its residual, and the residual is then re-entered by two other changes

Change 3 is exemplary about this: the guard is *"conditional on the database write lock being intact"*
and the condition is stated in the requirement text rather than a footnote (`spec.md:163-170`). The
enforcement is a build-failing ban on UmbraDB's own sources plus a documented precondition on the
embedder. Fine. But:

- change 5 requires an out-of-process or post-quiesce copy procedure (`:672-680`) — a *document*, not
  code, so the ban holds; and
- change 6 requires an in-`src/` module that reads database files to derive and verify manifests
  (Q5) — which the ban, as literally written, would fail the build on.

The argument that the residual is contained holds only if change 6's snapshot module is out of
process. Nothing says it is.

### 4.5 An argument that is asserted rather than established, and is load-bearing

Change 6's entire layout ruling rests on the claim that *"reclamation is a property of the
`auto_vacuum` setting and the number of pages freed, and is independent of how they were freed"*
(`spec.md:113-117`). The evidence is two independent measurements that agree on direction and
**disagree by a factor of ~25 on the timing** — change 1 measured `DROP TABLE` ~22× slower than
`DELETE` at `auto_vacuum=FULL`; change 6 measured `DROP` 14% *faster*. Change 6 records the
disagreement and argues the ruling doesn't depend on it, which is correct as far as the *space* claim
goes. But change 1's B-3b (`design.md:853`) still carries the 22× figure as a fact, in the blocked
decision that its own acceptance criterion D5 says gates change 6's layout. One change treats a number
as unreproduced; another treats it as an input to a gate. Somebody has to decide which.

---

## 5. What held up well — and it is a lot

I want to be specific here, because these are transferable strengths, not politeness.

1. **The negative controls are the best feature of this plan.** Nearly every requirement ships a
   scenario describing the wrong implementation and what it would lose. Several are measured rather
   than imagined: the unguarded `INSTEAD OF` trigger that accepts a row and stores it nowhere
   (change 6 `:175-183`); the `@>`/`<@` inversion whose fixture *"agrees on exactly one row out of
   seven"* (change 4 `:253-261`); the numeric-`errcode` translator that routes the whole catalog to
   the catch-all while the drift test stays green (change 5 `:788-797`). This is the discipline that
   makes a green test suite mean something, and it is applied nearly everywhere.

2. **The refusal to quote research numbers is real, not rhetorical.** I grepped for bare throughput
   figures in the seven spec files and found none outside declared measurement obligations. The 233×
   tmpfs error is used as a calibrating example rather than as an excuse, and change 1's spec makes it
   structural: *"No requirement, design decision or contract statement in this migration SHALL cite a
   throughput, latency or rejection-rate figure that is not present in that artifact"*
   (`sqlite-engine/spec.md:553-554`), with CI asserting the artifact's filesystem is not
   memory-backed.

3. **Several requirements state what they do *not* prove, in the requirement itself.** Change 6's
   *"a snapshot makes no completeness claim"* (`:684-708`) enumerates four things the continuity walk
   does not establish. Change 2's I-3 names its own residual — the symmetric primary-key-index hazard
   — as *"deliberate: it is the residual, and it should not be discovered later as an oversight"*
   (`:227-232`). Change 5's two-case integrity wording refuses both the over-claim and the
   under-claim (`:487-504`). This is rare and valuable.

4. **The strongest single piece of reasoning in the sprint** is change 2's treatment of structural
   gap-freedom: it claims the strengthening, then immediately specifies that unrepresentability cuts
   both ways and that a gap-bearing source is therefore a lossy conversion — with a worked example
   showing that row counts, per-row digests and every one of its own assertions pass while
   `getAt({at: 2500})` changes from `null` to version 1 (`temporal-kv/spec.md:119-190`). That is a
   change arguing against its own headline benefit, correctly, and handing the consequence to change
   7, which then verifies it per key. The seam works.

5. **Change 3's Ordering 1/2/3 table** (`:174-215`) is the right way to specify a concurrency
   protocol: three exhaustive interleavings, each with a *different* correct assertion, and an
   explicit statement that a test applying one ordering's assertion to another *"is wrong even when it
   passes."*

6. **Change 4's `007_writer_generation` seed-row requirement** (`:499-536`) is a model of a change
   catching another change's silent failure: an `UPDATE … WHERE id = 1` against an empty table matches
   zero rows, returns no generation, and raises nothing. Finding that, and moving the seed into the
   migration, is exactly the kind of cross-change catch that justifies parallel authoring.

7. **Both corrections that reversed a premise were made loudly.** Change 1's non-goals carry
   *"Corrected: an earlier draft of this proposal said…"* inline rather than quietly editing. That is
   the right instinct; the failure is only that the correction did not propagate to the four changes
   that needed it.

---

## 6. What I would not want to be responsible for building

**The digest regime as currently distributed across changes 4, 5, 6 and 7.** Four changes own
different halves of one column: change 5 owns the algorithm and the preimage, change 4 owns the wallet
DDL, change 6 owns the archive DDL, change 7 owns computing it at import. They already disagree on the
`CHECK` (Q1), the archive tables are in-scope in one change's table and out-of-scope in the same
change's scope statement (C2), the `NULL` branch is a silent verification opt-out nobody closed (4.2),
and the migration fold's relationship to the column is contradictory (Q6). This is the mechanism most
likely to ship subtly wrong and pass every test, because every test is written by the change that owns
its half. I would want one change to own the digest end to end, or a single reconciling document, before
writing a line of it.

**Anything depending on the per-row guard** — the statement deadline, main-thread abort, the
transaction hold bound's actual effect, and stream release under abort. Four requirements in three
changes are written as though a cancellation primitive exists. The binding has none, the compile
options exclude the progress callback, and the only proposal is one sentence in a design document. I
would not accept a task saying "enforce a per-statement deadline inside the worker" without first
being told what the guard is, which statements carry it, and who rewrites the SQL text to include it.

**The archive tier's concurrency story.** Two database files, one process-local lease, one guard
specified for one file, an ingest CLI that is a separate process, and no registration on the archive
file. I would not sign off on "single-writer by contract" for the archive.

**Change 5's acceptance criteria N1 and N7 as written.** I would not tick a box asserting "No
chain-archive code, schema, cost estimate or schedule appears in this change" while implementing its
task 3.1, which requires archive-table digest coverage and archive-table absence tests; nor "No
PostgreSQL-to-SQLite data-migration path is built or promised" in a sprint whose seventh change is
that path.

---

## 7. Smallest set of edits that would clear the blocking findings

1. Rule on the `dg` length `CHECK` and make changes 4, 5, 6 agree (one sentence, three files).
2. Add a writer-generation requirement + archive-lineage migration to change 6, or state in change 6's
   spec that the archive file is exempt and why.
3. Add I-4 to change 3's spec as a requirement, or reassign it.
4. Define the per-row guard as a requirement in change 1 and enumerate the statements that carry it.
5. Perform the seven §14.3 edits and fix change 5's N1/N7, change 2's N6, change 3's N1, change 4's P3
   and task 0.3, and change 1's D5/J10 and B-3b Form-B language.
6. Say whether change 6's snapshot module is in-process or out-of-process.
7. Refresh the cross-change `file:line` citations, or convert them to requirement-title references,
   which do not rot.

Items 1–4 are correctness. Items 5–7 are the difference between a plan an outsider can implement and
one they must first reverse-engineer.
