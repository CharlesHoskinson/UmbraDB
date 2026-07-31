# Round-2 audit — seat `premise-currency`

**Lens:** for every load-bearing claim citing the repository, two questions were asked separately —
(1) does the source say what the change says it says, and (2) *is the inference the change draws
from it still true of the repository as it stands today*. Round 1 asked only (1).

Worktree: `/root/UDB-sqlite-sprint`, branch `sprint/sqlite-migration`, HEAD `3c0c68b` (2026-07-26).
All seven change directories are **untracked** (`git status --porcelain` → `?? openspec/changes/v1.0.0-sqlite-*`).

---

## 1. Verdict

**REJECT.**

Gate R-1 is **not closed**. Change 1 §10.1 rules, in terms, that *"No change may still say 'the chain
archive is out of scope'"* — and four of the seven changes still say exactly that, three of them
quoting the refuted code comment as the justification, one of them in **normative spec text** that
will merge into `openspec/specs/release-contract/`. Change 4 goes further and asserts a repository
fact that is demonstrably false today (`chainArchiveMigrations` "is an exported array nothing calls";
`chain-archive-sync/bootstrap.ts:21` calls it). The enforcement mechanism built to catch precisely
this — change 1's refuted-phrase grep — was never widened past "changes 1–5" as the remediation
required, and, as written, **it already fails against changes 1–5**: I ran it and it returns four
non-correction hits. This is round 1's exact failure, unremediated, in more than half the sprint.

Gate R-3 is not closed either. Invariant **I-4** is assigned to change 3 by three separate changes,
and the string `I-4` appears nowhere in change 3; worse, the assertion I-4 mandates — writer
registration asserting one affected row and a defined read-back — is specified by **no** change, so
the sprint's own signature failure shape sits inside the invariant meant to detect it. And
`PRAGMA foreign_keys=ON` is attributed to change 1's pragma bootstrap by three changes while
appearing nowhere in change 1, even though change 4 makes `runMigrations` **refuse** without it and
SQLite defaults it off on the ruled binding.

Separately: change 3's §2.6.2 inheritance table, which the brief asked me to test for completeness,
enumerates only claims from changes 2 and 3. Changes 4, 6 and 7 each make a claim resting on
write-lock exclusivity, none carries the descriptor precondition, and the string `-shm` does not
appear in change 4 at all. Change 3's own spec makes such a claim "a defect in the specification".

The rest of the plan is, on the evidence I gathered, unusually good, and the findings cluster in a
recognisable place: **the seams between changes, not inside them.** Every change is internally sound
and several are exemplary. What fails is what one change believes about another. Retracted premise 3
(page checksums) is handled correctly and re-verified from source; the two-case corruption wording is
adjudicated and stated; the two live shipped defects are characterised down to the line number;
change 6's measurements carry `/root` ext4 provenance and it refuses a figure it could not reproduce;
change 7's Class 1 / Class 2 refusal ruling is the best-argued section in the sprint. Nothing needs
re-authoring. Five critical findings and seven major ones, all of them seam repairs, most an
afternoon each. The two gates the brief told me to verify rather than assume — R-1 and R-3 — are both
open; that is the verdict.

---

## 2. Critical findings

### C-1. Four of seven changes still carry retracted premise 1 verbatim; the R-1 gate is open

Change 1 `design.md:986-992` publishes the correction and its binding rule:

> **And the scope statement changes too:** the archive is **in scope**, ported to SQLite by
> **change 6**. No change may still say "the chain archive is out of scope"; the correct statement is
> "the chain archive is owned by change 6, not by this change."

Command:

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint/openspec/changes && grep -rn "chain archive is out of scope" v1.0.0-sqlite-*/'
v1.0.0-sqlite-concurrency-lease/proposal.md:176:- **The chain archive is out of scope, entirely.**
v1.0.0-sqlite-durability-contract/specs/release-contract/spec.md:22:The chain archive is out of scope entirely
v1.0.0-sqlite-engine-core/design.md:991:  **change 6**. No change may still say "the chain archive is out of scope"; the correct statement is
v1.0.0-sqlite-engine-core/acceptance.md:152:| J3 | Grepping changes 1–5 for the refuted phrases … | [CI][manual] | 0.5b |
v1.0.0-sqlite-engine-core/tasks.md:81:  for the refuted phrases ("not wired into any runner path", "chain archive is out of scope", "no
v1.0.0-sqlite-schema-parity/design.md:435:The chain archive is out of scope (`proposal.md` non-goals) and **no archive DDL is ported by this
v1.0.0-sqlite-schema-parity/proposal.md:172:- **The chain archive is out of scope.** `src/postgres/migrations/chain_archive/001_chain_archive_core.ts`
v1.0.0-sqlite-temporal-event-log/proposal.md:148:- **The chain archive is out of scope for the entire program.**
```

Four are outside change 1 and none is in a correction note. Each is worse than a wording slip,
because each re-asserts the refuted *inference* as a repository fact:

**(a) Change 2** — `v1.0.0-sqlite-temporal-event-log/proposal.md:148-151`, under `## Non-goals`:

> **The chain archive is out of scope for the entire program.**
> `src/postgres/migrations/chain_archive/001_chain_archive_core.ts` states verbatim: *"Not wired
> into any runner path that would execute it."* It has no data, no consumer and no runner.

"Out of scope for the entire program" is not a per-change scope statement; change 6 *is* the program's
archive change. "No runner" is false: `package.json:46` is the runner.

**(b) Change 3** — `v1.0.0-sqlite-concurrency-lease/proposal.md:175-179`:

> **The chain archive is out of scope, entirely.** `…001_chain_archive_core.ts:86` states verbatim …
> It has no data, no consumer and no runner. … the archive file, **if it is ever wired**, gets its
> own registration under its own change.

"If it is ever wired" is the refuted counterfactual. It is wired.

**(c) Change 4** — `v1.0.0-sqlite-schema-parity/proposal.md:172-177`:

> **The chain archive is out of scope.** `…001_chain_archive_core.ts` states verbatim: *"Not wired
> into any runner path that would execute it."* **`chainArchiveMigrations` is an exported array
> nothing calls**; `src/index.ts:22` calls it "the deferred full-chain-archival track"; it has no
> data and no consumer.

The bolded clause is falsifiable and false:

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && grep -rn "chainArchiveMigrations" --include=*.ts . | grep -v node_modules'
./chain-archive-sync/bootstrap.ts:2:import { chainArchiveMigrations } from "../src/postgres/migrations/chain_archive/index.js";
./chain-archive-sync/bootstrap.ts:21:  await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
[… 6 test files, then the definition site …]
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && sed -n "21p" chain-archive-sync/bootstrap.ts'
  await runMigrations(sql, { schema, migrations: chainArchiveMigrations });
```

This is round 1's failure reproduced exactly: the quotation is accurate, the inference is stale.
The same `src/index.ts` passage change 4 quotes also says, four lines on, *"its live-Preprod ingestion
service lives entirely outside `src/`"* — i.e. the cited source itself contradicts "no consumer".

**(d) Change 5** — `v1.0.0-sqlite-durability-contract/specs/release-contract/spec.md:22-24`, inside
the spec delta's scope-boundary paragraph:

> The chain archive is out of scope entirely
> (`src/postgres/migrations/chain_archive/001_chain_archive_core.ts:86`: "Not wired into any runner
> path that would execute it").

This is the worst placement of the four. It is normative text in the capability that owns the release
contract, and it cites the stale comment as its authority.

**Verification that the R-1 citation chain change 1 *did* publish is itself correct** (all four
verified, so the correction is right and only its adoption failed):

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && grep -n "archive:sync" package.json'
46:    "archive:sync": "tsx chain-archive-sync/sync-cli.ts",
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && sed -n "38p" chain-archive-sync/sync-cli.ts'
await bootstrapChainArchiveSchema(sql, SCHEMA);
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && sed -n "123p" chain-archive-sync/sync-service.ts'
    this.store = new PgChainArchiveStore(opts.sql, opts.schema ?? "chain_archive");
```

### C-2. The enforcement grep was never widened, and fails today against the range it does cover

The brief's remediation item: *"Change 1 added an enforcement grep for four refuted phrases — verify
it actually covers all seven changes now, not the original five."* It does not.

`v1.0.0-sqlite-engine-core/acceptance.md:152` (J3): *"Grepping **changes 1–5** for the refuted
phrases … returns zero hits outside an explicit correction note."*
`v1.0.0-sqlite-engine-core/tasks.md:80-83` (0.5b): *"every one of **changes 2, 3, 4 and 5** has
adopted the R-1 and R-9 wording — verified by grepping **the five changes** …"*

Changes 6 and 7 are outside the sweep. That is the wrong half to exempt: change 6 is the change that
owns the archive and change 7 is the change whose entire scope turns on "there is nothing to migrate".

And the criterion is already violated within its own range — C-1 above is the transcript. J3 as
written is a **failing** acceptance row at the moment implementation starts, in changes 2, 3, 4 and 5.

Two mechanical defects in the phrase list itself:

- The list targets `"chain archive is out of scope"` but change 2 writes *"The chain archive is out
  of scope **for the entire program**"* and change 4 §435 writes *"The chain archive is out of scope
  (`proposal.md` non-goals)"*. Both happen to contain the literal substring, so the grep catches
  them — but the list contains no phrase covering the *inference* forms that carry the actual error:
  `"nothing calls"`, `"no consumer"`, `"no runner"`, `"if it is ever wired"`. Those are what a future
  author will write.
- A grep-based acceptance that passes by returning nothing is itself the zero-row/silent-success
  shape. J3 has no negative control asserting the grep would fire if a refuted phrase were present.

### C-3. A second stale "not wired" comment exists that no change identifies or retires

Change 1's R-1 correction names one stale comment (`001_chain_archive_core.ts:86`). There are two:

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && sed -n "25,31p" src/postgres/migrations/chain_archive/index.ts'
 * **Not wired into any executing path.** Nothing in this repo's application code imports this
 * array and calls `runMigrations(sql, { schema: "chain_archive", migrations:
 * chainArchiveMigrations })` — it is exported for the same reason `005_chain_archive.ts` used
 * to sit unregistered in the migrations directory: a genuine, syntactically-correct migration
 * lineage, design-stage only, gated on design-council ratification before any real wiring or
 * live apply.
```

`chain-archive-sync/bootstrap.ts:2` imports it and `:21` calls it. This is the comment change 4's
"exported array nothing calls" is transcribed from — the relay's true origin. Change 6 owns the port
and should retire both; today it retires neither, because neither the correction register nor J3
knows this one exists.

A third instance, in shipped docs, is likewise unretired and uncited by any change:

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && grep -rn "no CLI entry point" docs/'
docs/features/full-chain-storage.md:81:There is currently **no CLI entry point or npm script** for this feature …
```

`chain-archive-sync/sync-cli.ts`'s own header comment says it was written to close exactly that gap.

### C-4. Gate R-3 is not closed either: invariant I-4 is owned by a change that never received it, and the assertion it mandates is specified by nobody

The brief's R-3 check: *"Check every one has a requirement, an owner, and a scenario that fails if
the assertion is dropped."* I-4 fails all three.

Three changes assign I-4 to change 3:

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint/openspec/changes && grep -rn "I-4" v1.0.0-sqlite-*/'
v1.0.0-sqlite-chain-archive/design.md:1024:| I-4 | writer registration asserts `changes === 1` and a defined read-back | change 3 |
v1.0.0-sqlite-durability-contract/design.md:335:… `_migrations` and `writer_generation` (rules I-5 and I-4).
v1.0.0-sqlite-durability-contract/design.md:476:| I-4 | writer registration asserts a single affected row and a defined read-back; failure is a startup error, not an undefined generation | **change 3** |
v1.0.0-sqlite-durability-contract/specs/release-contract/spec.md:165:| `writer_generation` | all | UNCOVERED — invariant I-4 |
v1.0.0-sqlite-schema-parity/design.md:1301:… I-2/I-8 are change 6's, I-3 change 2's, **I-4 change 3's**, I-6 change 5's.
```

The string `I-4` **does not appear anywhere in `v1.0.0-sqlite-concurrency-lease/`** — not in
`design.md`, `specs/transaction-lease/spec.md`, `tasks.md` or `acceptance.md`. Change 3 does not know
it owns an R-3 invariant. This is the same relay defect the brief records as having already happened
once ("it summarised an R-3 ruling omitting two of three invariants"), recurring on the delivery leg
instead of the summary leg.

Worse, the assertion I-4 mandates is specified by **no** change. Change 3's registration protocol
(`design.md:232-241`) is:

```
BEGIN IMMEDIATE;
UPDATE writer_generation SET generation = generation + 1, owner = :uuid, … WHERE id = 1;
SELECT generation FROM writer_generation WHERE id = 1;
COMMIT;
```

and its requirement text (`specs/transaction-lease/spec.md:147-152`) says only that the system *"SHALL
bump `generation` and record its own `owner` inside a `BEGIN IMMEDIATE` transaction, and SHALL retain
the read-back generation for the life of the process."* There is no obligation to assert the `UPDATE`
affected one row, and no defined behaviour when the read-back returns nothing.

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint/openspec/changes && grep -rni "changes === 1\|affected row\|rows affected\|startup error" v1.0.0-sqlite-concurrency-lease/ v1.0.0-sqlite-schema-parity/'
(zero hits)
```

Change 4 identified the hazard exactly (`design.md:690`: *"the `UPDATE` matches zero rows, the
`SELECT` returns no row, and `myGeneration` is undefined"*) and closed **one** cause — an unseeded
table — by putting the seed row in migration `007`, with a negative-control scenario
(`specs/storage-schema/spec.md:528-536`). That is structural mitigation of the *migration-time* cause.
It is not I-4. If the singleton row is absent at runtime for any other reason — a partial restore, a
`DELETE`, index damage — the `UPDATE` matches zero rows, the `SELECT` returns no row, every statement
reports success, `myGeneration` is undefined, and the cross-process writer guard that R-2 spent an
entire gate hardening **silently guards nothing**. That is the sprint's own signature failure shape,
sitting inside the invariant that was supposed to be its detector.

And the gate's own closure check asserts the opposite. Change 5 `tasks.md:227-230`, task 3.7:

> **Acceptance:** this change's design carries the invariant table with exactly one owning change per
> row; **changes 2, 3, 4 and 6 have each acknowledged their rows**; and no invariant owned elsewhere
> is re-specified as a requirement here.

Change 3 has acknowledged nothing. The acceptance row that was supposed to detect this states the
fact it should have caught, as though already true — the same failure mode as J3 in C-2.

The canonical statement is unambiguous at the source
(`/root/umbradb-sqlite-research/audit/fable-r3-ruling.md:327`):

> | I-4 | Writer registration asserts `changes === 1` and a defined read-back; failure is a startup
> error, not an undefined `myGeneration` | non-retryable startup error | **change 3** (concurrency lease). |

The consequence for the sprint is not one missing scenario. It is that R-3's closure claim — eight
invariants, each with an owner, each with a requirement and a falsifying scenario — is **not true as
of this worktree**, and the panel is being asked to approve on the strength of it.

**Fix shape:** change 3 adds the runtime assertion to its registration requirement (`changes === 1`,
read-back defined, both failures a non-retryable startup error distinct from contention), labels it
I-4, and adds a scenario that fails when the assertion is dropped — with the row deleted at runtime
rather than merely unseeded, so it is not a duplicate of change 4's migration-time control.

### C-5. `PRAGMA foreign_keys=ON` is attributed to change 1's bootstrap, is specified by no change, and change 4 refuses to migrate without it

Change 4 states the dependency twice, as fact:

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint/openspec/changes && sed -n "27p" v1.0.0-sqlite-schema-parity/design.md'
| **Change 1** `v1.0.0-sqlite-engine-core` | Driver selection; the `postgres.js`-shaped shim; pragma
bootstrap **incl. `PRAGMA foreign_keys=ON`**; the blocking ext4 measurement gate | …
$ … sed -n "187p" v1.0.0-sqlite-schema-parity/proposal.md
  `PRAGMA foreign_keys=ON`; it does not specify them.
```

Change 1 does not carry it:

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint/openspec/changes && grep -rn "foreign_keys" v1.0.0-sqlite-engine-core/'
(zero hits — design.md, proposal.md, tasks.md, acceptance.md, specs/sqlite-engine/spec.md)
$ … grep -n "PRAGMA" v1.0.0-sqlite-engine-core/specs/sqlite-engine/spec.md
203: ### Requirement: the pragma bootstrap is an ordered, once-only sequence whose effect is verified by read-back
222-225: … `PRAGMA journal_mode = WAL` first and then `page_size` … left at `page_size=4096`
```

Change 1's bootstrap requirement covers `page_size`, `auto_vacuum` and `journal_mode`. `foreign_keys`
appears nowhere in the change that three other changes say owns it (change 4 `design.md:27`,
`proposal.md:187`; change 6 `design.md:399`, `§5.4:442-444`).

This is not a documentation gap, because change 4 makes the pragma a **hard precondition**:

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint/openspec/changes && sed -n "895,901p" v1.0.0-sqlite-schema-parity/specs/storage-schema/spec.md'
… SQLite's `PRAGMA foreign_keys` defaults **off**. The system SHALL verify that `PRAGMA foreign_keys`
reports 1 before applying any migration and SHALL refuse to proceed …
- **WHEN** `runMigrations` is invoked on a connection where `PRAGMA foreign_keys` reports 0
```

Change 5 refuses on it too, from the other side:

```
$ wsl -e bash -lc 'cd …/v1.0.0-sqlite-durability-contract/specs/release-contract && sed -n "42,44p" spec.md'
Hard refusals (no override): `journal_mode` in `{off, memory}`; `synchronous = OFF`;
`foreign_keys` not `ON`; the database file resident on a filesystem where SQLite's locking or
write-ahead-log shared memory is unsafe.
```

Composed as specified: SQLite defaults the pragma OFF; the ruled binding is `better-sqlite3`, not
`node:sqlite` (change 4 `design.md:592` notes L4 measured `node:sqlite` turning it ON, which is the
binding that was *not* chosen); change 1's bootstrap never turns it on; change 4's `runMigrations`
refuses when it is off. **The migration runner refuses on every fresh database, always.** Change 4
did the right thing by verifying rather than assuming, and the verification is what makes the gap
loud instead of silent — but the setter is owned by nobody, and change 4's acceptance `P1` treats it
as an *observation* to record ("the observed default of `PRAGMA foreign_keys` on a fresh connection")
rather than a value change 1 must establish.

Change 6 has the same exposure with more at stake: its composite FK
`(net, block_height, block_hash) → blocks(net, height, block_hash)` (`design.md:399`) is inert
without the pragma, and change 7 `design.md:492` records that with `foreign_keys = OFF` *"a dangling
junction row inserts happily, `PRAGMA integrity_check` reports `ok`"* — a sixth instance of the
zero-row/silent-success shape, sitting behind an unowned pragma.

**Fix shape:** change 1 adds `foreign_keys` to its bootstrap requirement with a read-back assertion,
or the correction register reassigns it explicitly. Either is cheap; the current state is that four
changes depend on a setting no change sets.

---

## 3. Major findings

### M-0. Change 7's line-range citations into changes 1 and 5 are systematically off-target

Change 7 carries 48 of the sprint's 62 hard `<change>/<file>.md:<range>` citations, and its ranges
into changes 1 and 5 miss far more often than they hit. The two the brief flagged as risky both miss:

```
$ wsl -e bash -lc 'cd …/v1.0.0-sqlite-durability-contract/specs/release-contract && sed -n "138,153p" spec.md'
### Requirement: integrity coverage follows the three-class corruption model with an explicit
column-level coverage set …  ← change 7 design.md:29 calls this "the digest"
$ … sed -n "178,187p" spec.md
…"- AND it SHALL contain no category term…" / "#### Scenario: The envelope contradiction is absent
(negative control)"  ← change 7 calls this "the verification pass"
$ … sed -n "205,206p" spec.md
### Requirement: the value digest is a versioned, length-prefixed, row-bound SHA-256 computed
adapter-side          ← the digest actually lives at 205-243
```

The same pattern repeats for change 7 → change 1 (`spec.md:161-193` cited as the pragma bootstrap;
the bootstrap is 203-236 — `161-193` is the connection-factory reuse guard) and for
`spec.md:498-512` / `:500-512` cited three times as "the gate" (that range is worker shutdown, batch
size and the statement deadline; the measurement gate is 540-583, and the "filesystem and mount
options; `journal_mode`; `synchronous`; `page_size`; `auto_vacuum`; dataset size" string change 7
quotes is at 543).

Two things make this Major rather than Minor. First, several of these ranges appear in change 7's
**normative spec text**, not only its design — `specs/data-migration/spec.md:95`, `:187`, `:603`,
`:710` — so the merged capability will ship pointers that resolve to unrelated requirements. Second,
none of it can be excused as drift: all seven change directories are untracked, so the cited files
have not moved since the citations were written. The ranges were wrong when written.

The *substance* is right in every case I resolved — change 7 knows what change 5's digest regime is,
and its statements about it are accurate. This is a pointer-integrity defect, and the fix is a
mechanical re-anchoring pass, ideally to requirement headings rather than line numbers.

### M-1. Change 3's §2.6.2 inheritance table is complete only for the five-change sprint

Asked by the brief: *find a claim resting on write-lock exclusivity that is not in the table.* There
are at least three, and the pattern is structural — the table (`design.md:412-431`) has six rows,
drawn only from changes 2 and 3. It predates changes 6 and 7 and was never re-swept. Change 3's spec
(`specs/transaction-lease/spec.md:315-328`) makes the omission a defect by its own terms:

> **AND** a claim discovered without the qualifier SHALL be treated as a defect in the specification,
> not merely in the prose

The descriptor precondition has not propagated:

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint/openspec/changes && grep -rn "descriptor precondition\|\-shm" v1.0.0-sqlite-schema-parity/'
(zero hits)
$ … v1.0.0-sqlite-chain-archive/    → 3 hits, all about snapshot file sets; none the precondition
$ … v1.0.0-sqlite-data-migration/   → 1 hit  (design.md:898, the `.importing` sidecar paths)
```

Claims in those three changes that rest on write-lock exclusivity and read as unconditional:

| Claim | Where | In §2.6.2? |
|---|---|---|
| "`BEGIN IMMEDIATE` making two migration transactions mutually exclusive across processes regardless" | ch4 `design.md:708` (and `:702`) | no — the table's migration-lock row is scoped "§2.2 / task 2.4, **this change**" |
| Removal of the archive's row locking "SHALL be justified by single-writer serialization under `BEGIN IMMEDIATE`" | ch6 `specs/chain-archive/spec.md:360`, `:384`; `design.md:432-434` | no |
| The archive bundle's atomicity: "issues them inside **one** `BEGIN IMMEDIATE` transaction" and the co-transactional ingest cursor | ch6 `design.md:579`; `spec.md:460-489` | no |
| "it SHALL hold a whole-database write lock for the whole import" | ch7 `specs/data-migration/spec.md:709` | no |

Change 6's `design.md:1203` even records change 3 as a dependency whose absence means *"§7.1's
single-transaction bundle has no isolation guarantee"* — it knows it inherits, and still states the
claim without the qualifier. Change 5 is the one downstream change that did take the handover
(`tasks.md:340`), which shows the mechanism works when the table names you.

**Fix shape:** extend the table to changes 4, 6, 7 and re-scope acceptance `B3h`
(`v1.0.0-sqlite-concurrency-lease/acceptance.md:54`), which today enumerates exactly four claims, all
change-3-local.

### M-2. Change 1 mandates verbatim adoption of a number change 6 measured in the opposite direction

`v1.0.0-sqlite-engine-core/design.md:1017-1020`, N-1, *"Corrected wording, to be adopted verbatim"*:

> At `FULL`, both return file space and **`DROP TABLE` is the slower of the two** (62.7 ms vs 2.8 ms
> in a 6,000-row × 4 KiB trial).

Acceptance `J9` requires that sentence be published: *"including that at `FULL` **both** reclaim and
`DROP` is the slower."* Change 6 re-measured on its own harness and reports the opposite at one scale
(`v1.0.0-sqlite-chain-archive/design.md:198-212`):

> At `FULL` they are within 3% at 6,000 rows and `DROP` is **14% *faster*** at 120,000 — the opposite
> direction from change 1's harness … I did not reproduce the 22×, and I am not adopting a figure I
> could not reproduce.

Change 6 handles the disagreement exactly right — states it, refuses the unreproduced figure, notes
the ruling is invariant to the direction, and files it as gate obligation M-4. The defect is on
change 1's side: J9 makes an unreproduced 22× ratio a **doc-acceptance criterion**, so satisfying J9
publishes as fact a directional claim the sprint's own second harness contradicts. The brief's rule —
no lane performance figure appears as fact — is violated by the one change that owns the rule.

The corrected wording should keep the `auto_vacuum` structural statement (which both harnesses
support) and drop "`DROP` is the slower", or attribute it as one harness's result under M-4.

### M-3. Zero-row / silent-success instance #5: change 6's four restore checks pass vacuously on the archive's own stated starting state

Change 6 specifies the archive as *"a fresh, **zero-row** database"* (`spec.md:23`; `proposal.md:118`),
and change 7 relies on that (`spec.md:13`). Change 6 then specifies restore verification
(`spec.md:643-651`) as four checks, none of which has a non-emptiness precondition:

1. structural + digest sweep — verifies the rows it is handed; zero rows, zero verifications;
2. identity — "per-table **row counts**" recomputed and compared: `0 == 0`;
3. irreversible pragmas — the only one of the four that is content-independent;
4. continuity walk over the manifest's `heightRange` — an empty range terminates immediately.

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint/openspec/changes && grep -rn "non-empty\|nonempty\|at least one\|empty range" v1.0.0-sqlite-chain-archive/specs/chain-archive/spec.md'
(zero hits)
```

So the first snapshot/restore round trip the project will ever perform — on the greenfield archive —
reports **three of four checks green having asserted nothing**, and an operator reads "restore
verified". The negative control at `spec.md:702` guards against a *stronger claim* being made from a
passing walk; it does not guard against a *vacuous* pass.

This is the shape the sprint has now hit five times, and the reason it survived here is visible:
change 2 wrote an explicit zero-row self-audit and changes 3/4/5 inherited the discipline; changes 6
and 7 have none.

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint/openspec/changes && grep -rln "self-audit" v1.0.0-sqlite-*/'
v1.0.0-sqlite-temporal-event-log/design.md      ← §10.5, the only one
```

**The same change has a second, sharper instance in invariant I-8**, and this one has a zero-row-safe
sibling three changes away to compare against. Change 6 `specs/chain-archive/spec.md:266-276`:

> On read, the system SHALL assert that the archive ingest cursor's height is at most one greater
> than the highest stored block height … (invariant I-8)
> **WHEN** the stored cursor height exceeds the highest stored block height by more than one

On an empty `blocks` table `max(height)` is `NULL`, so `height <= NULL + 1` evaluates to `NULL` —
neither true nor false. The scenario does not say which way the implementation must resolve it, and
`design.md:1077-1090`, `tasks.md:248-249` and `acceptance.md:141` (R15) do not either. Either
resolution is a defect: never firing means a corrupted-forward cursor is undetectable for the entire
window in which the archive is empty — which is *the window ingest starts in* — and always firing
means every fresh archive refuses on open.

Change 4 solved the identical problem in the identical shape and got it right
(`specs/storage-schema/spec.md:560-562`):

> the claimed `seq` is strictly greater than **`coalesce(max(seq), 0)`** over existing manifests

The correct treatment already exists in this sprint, one invariant over, and was not applied.

**Fix shape:** a precondition that each of checks 1, 2 and 4 report `n/a — no rows in scope` rather
than `pass` when its scope is empty; a scenario asserting a zero-row restore does **not** report an
overall pass; and `coalesce(max(height), -1)` (or an explicit empty-archive clause) on I-8. Change 5
already has the pattern to copy (`specs/release-contract/spec.md:1038`: *"that run SHALL fail the
invariant, demonstrating the harness is not vacuously green"*), as does change 2
(`specs/temporal-kv/spec.md:261`: *"it SHALL NOT treat a zero-row re-read as confirmation, since a
re-read matching nothing is evidence of divergence, not agreement"*).

### M-4. Over-claim instance #4: "four independent readers" includes a reader that did not read

`v1.0.0-sqlite-data-migration/design.md:1196` (Q-1):

> **Four independent readers — change 4, change 5, the contract-precedent council seat and this
> change — each searched and found no `Dockerfile` and no registry reference …**

Two problems, both the canonical shape:

- Four readers running the same `find`/`grep` over one worktree is **one observation counted four
  times**, not four independent confirmations. Independent corroboration would require a different
  method (e.g. asking the owner what images exist), which is precisely what Q-1 says is *"still
  open"*.
- One of the four does not exist. Change 4 makes no such claim anywhere:

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint/openspec/changes && grep -rni "Dockerfile\|container image\|docker" v1.0.0-sqlite-schema-parity/'
(zero hits)
$ … v1.0.0-sqlite-durability-contract/  → tasks.md:296 (change 5 — present)
```

The underlying repository fact is **true** (see §5), so nothing unsafe is built on it. The reason
this belongs in Major is that the same sentence is used to close an open owner question — *"so
nothing in the plan asserts a docker artifact the project builds. This is an owner question, not a
specification gap"* — on the strength of a corroboration count that is inflated and partly fictional.

### M-5. Relay instance #3: change 3's H-2 handover cites a line range that no longer holds the claim

Cited four times — `v1.0.0-sqlite-concurrency-lease/design.md:44` (H-2), `design.md:448` (§2.6.2),
`acceptance.md:149` (H8), `tasks.md:197` (3b.1) — as
`specs/temporal-kv/spec.md:377-379`, the location of change 2's "closed three independent ways".

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && sed -n "375,381p" openspec/changes/v1.0.0-sqlite-temporal-event-log/specs/temporal-kv/spec.md'
- **AND** `CLOCK_REGRESSION` SHALL retain both documented causes and its `conditional` marking …
#### Scenario: The gate reports a nonzero rejection rate at the shipped defaults
…
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && wc -l < openspec/specs/temporal-kv/spec.md'
289
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && grep -n "three independent" openspec/changes/v1.0.0-sqlite-temporal-event-log/specs/temporal-kv/spec.md'
566:window was closed "three independent ways": `SQLITE_BUSY` (5) refusing a second simultaneous writer,
573:refused. The distinction is load-bearing: three independent guarantees would survive one of them
618:  are consequences, and SHALL NOT be described as three independent guarantees
```

The **substance** of H-2 is discharged — change 2 corrected it at `design.md:289-303` and
`spec.md:566-618`. Only the pointer is stale, in all four places, and it now resolves to the
clock/measurement-gate scenario. An implementer working H8 or task 3b.1 from the citation will open
unrelated text and either conclude the handover is void or edit the wrong requirement. Note the
citation is also ambiguous between the delta and the merged spec (`openspec/specs/temporal-kv/spec.md`
has only 289 lines, so `:377-379` does not exist there either).

### M-6. Three of the eight R-3 invariants are specified differently by different changes; change 5's version of I-2 names table objects change 6 abolished

This is the "no two changes specify the same one differently" check the brief asked for on I-1…I-8.
I-2 fails it.

Change 5 owns the master table and states (`v1.0.0-sqlite-durability-contract/design.md:474`):

> | I-2 | at most one canonical block per `(network, height)`, **as a partial unique index on every
> partition child** | **change 6** — already in its DDL … |

and repeats it in **normative spec text** (`specs/release-contract/spec.md:163`):

> | **`blocks` (and every partition child)**, `transactions`, `chain_blob_roles` | all | UNCOVERED —
> projections of rehash-verified blobs; invariant I-2 plus a documented rebuild path … |

Change 6, which owns I-2, has **prohibited the partitioned layout**:

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint/openspec/changes && sed -n "228,229p" v1.0.0-sqlite-chain-archive/specs/chain-archive/spec.md'
The system SHALL enforce … that at most one block per `(net, height)` is marked canonical, by a
partial unique index on `(net, height) WHERE is_canonical`.
```
— one index, one table. `proposal.md:130-138`: *"`PARTITION BY RANGE` is replaced by one table per
relation, and a table-per-height-range layout is **prohibited** with four named revival conditions."*
`tasks.md:110` / `acceptance.md:181` delete `chain-archive-rollover.ts` and `createHeightPartitions`.
SQLite has no partitions at all.

So change 5's coverage table — the document a consumer reads to learn what is protected — names
database objects that will not exist in the SQLite archive, and describes the sprint's own mandatory
Class B invariant as being enforced N times where change 6 enforces it once. This is a
**relay-introduced error of exactly the recorded shape**: a PostgreSQL-era description of I-2
travelled into a SQLite-era spec as prose and was never re-checked against the change that owns it.
The substance of the invariant is identical in both; the mechanism statement is not.

It also propagates: `v1.0.0-sqlite-durability-contract/design.md:332` and `spec.md:192` repeat the
`blocks` row, and `v1.0.0-sqlite-schema-parity/design.md:1301` (*"I-2/I-8 are change 6's"*) correctly
defers, so change 4 is clean.

**Two further divergences in the same table, both verified against the ruling source:**

**(i) I-1's `load()` half is dropped by its owner.** The ruling
(`audit/fable-r3-ruling.md:324`) and change 5's relay (`design.md:473`) both say the assertion runs
*"inside the same transaction as every checkpoint `save()` **and** `load()`"*. Change 4's requirement
scopes it to `save()` only:
```
$ wsl -e bash -lc "sed -n '560,562p' …/v1.0.0-sqlite-schema-parity/specs/storage-schema/spec.md"
WHEN `save()` allocates a sequence, the system SHALL assert within the same transaction that the
claimed `seq` is strictly greater than `coalesce(max(seq), 0)` …
```
`design.md` §17.3(a) confirms ("Asserted inside `save()`'s transaction"), and no scenario covers
`load()`. This matters because change 4's own requirement text names the harm as a **read**-path
harm — *"`load()` … returns a stale checkpoint forever while every save reports success"*. If the
store is corrupted and then goes quiet, no `save()` ever runs and the invariant never fires. The
ruling put the assertion on `load()` for exactly that case.

**(ii) Change 5's normative record is short by one invariant** — in the change whose requirement
mandates the record. `specs/release-contract/spec.md:418-422`: *"The change SHALL record the mandatory
Class B invariants and their owning change."* Its coverage table names seven:
```
$ wsl -e bash -lc "grep -on 'I-[1-8]' …/specs/release-contract/spec.md | sort -u -t: -k2"
153:I-3  154:I-6  156:I-7  161:I-1  163:I-2  164:I-5  165:I-4        ← no I-8
```
The archive-watermark row (`:154`) reads *"**COVER**, plus invariant I-6"*, where the ruling assigns
that row **I-6 and I-8**. The full eight-row table exists only in change 5's `design.md:473-480`,
which is not spec-normative. Change 6 does specify I-8, so nothing is lost in implementation — but the
document the gate designated as the register records 7/8, and its own scenario
(*"WHEN the invariant table in this change is read / THEN each invariant SHALL name exactly one
owning change"*) passes on a seven-row table, because it checks per-row ownership and never
completeness. That is the zero-row shape applied to an inventory.

**Fix shape:** strike "(and every partition child)" and "on every partition child" from change 5, add
the I-8 row to its normative table with a completeness assertion in the scenario, restore I-1's
`load()` half in change 4, and
have change 5's table cite change 6 `spec.md:226-229` rather than restating the mechanism — which is
change 5's own stated policy two paragraphs above the table (*"it does not re-specify an invariant
another change owns, because a duplicated invariant is a divergence waiting to happen"*). The policy
is right; this is the case that escaped it.

---

## 4. Minor findings

**m-1. I-1 is stated with two different column vocabularies.** Change 5 `design.md:473` writes the
constraint as `UNIQUE (wallet, network, seq)` and the invariant as `next_seq > max(seq)` per
`(wallet, network)`. Change 4 (`design.md:1232`, `tasks.md:254`) and change 7
(`specs/data-migration/spec.md:322`, `:340-350`) write `UNIQUE (w, net, seq)`. The physical columns
are `w` and `net`:
```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && sed -n "26,35p" src/postgres/migrations/002_checkpoint_store.ts'
CREATE TABLE …ckpt_manifests ( id …, w text NOT NULL, net text NOT NULL, seq bigint NOT NULL, …)
```
Change 4 owns the DDL and uses the real names, so nothing wrong will be built. Recorded because it is
the same divergence mechanism as M-6, one severity band down, in the invariant immediately above it.

**m-2. Sixteen cross-change spec citations use a flattened path that does not exist**, all in
change 7:
```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint/openspec/changes && grep -rnoE "v1[.]0[.]0-sqlite-[a-z-]+/spec[.]md:[0-9]+" v1.0.0-sqlite-*/ | wc -l'
16
$ … ls v1.0.0-sqlite-durability-contract/spec.md
ls: cannot access …: No such file or directory      # real path: <change>/specs/<capability>/spec.md
```
For `v1.0.0-sqlite-schema-parity/spec.md:N` the flattening is genuinely **ambiguous** — change 4 ships
two spec files (`specs/storage-schema/spec.md`, 936 lines; `specs/temporal-kv/spec.md`, 113 lines) —
so a citation like `:465-467` resolves to a real requirement in one and past EOF in the other.

**m-3. Change 3's "specification defect" ruling is cited to §2.6.2, which does not contain it.**
Change 2 cites it three times (`design.md:751`, `specs/temporal-kv/spec.md:441`, `:600`) as change 3's
§2.6.2 ruling. §2.6.2's actual closing sentence is *"Where a scenario in this specification asserts
one, it carries the qualifier explicitly rather than relying on this table"*; the "specification
defect" language lives in change 3's `acceptance.md:54` (B3h) and `tasks.md:169`, and in its spec
scenario at `specs/transaction-lease/spec.md:327`. Change 2 also applies the ruling to all six table
rows while B3h enumerates four. Substance-preserving; pointer wrong. Same class as M-0 and M-5.

**m-4. Checked and *not* a finding — recorded because it looks like one.** Change 4 `design.md:29`
claims D-4 gives it *"the `writer_generation` table's DDL, its seed row and its lineage position"*,
while change 3's D-4 (`design.md:35`) says only *"The writer-registration table's **physical name** is
that change's; its columns and protocol are §2's."* That reads as an ownership escalation, but the
DDL does not diverge: change 4's `design.md:944-953` reproduces change 3 §2.2's six columns exactly,
adds only naming and `STRICT` (its own domain), and its own header comment states the split correctly
(*"Columns and protocol are change 3's … DDL, seeding and lineage position are this change's"*).
Wording drift in one dependency-table cell, no divergence downstream.

**m-5. Change 6's blob negative control states the refuted absolute rather than the two-case form.**
`v1.0.0-sqlite-chain-archive/specs/chain-archive/spec.md:406-413`:

> **WHEN** bytes inside a checkpointed main database file are overwritten and the database reopened
> **THEN** the structural check reports `ok` and the corrupted row is returned as data

Unqualified, this is retracted premise 4. Per the R-3 ruling (change 5 `design.md:252-259`), it holds
for **payload** bytes in overflow pages and is false for **structural** bytes, which `integrity_check`
does catch. Change 5's own requirement (`spec.md:487`) mandates the two-case wording *"in every
channel a consumer reads"*. Context makes the intent clear (it is a blob-payload scenario), but a
test written to the scenario as stated, choosing an offset without regard to page role, is
non-deterministic. Same wording at `acceptance.md:80` (W5) and `tasks.md:143`.

**m-6. Change 6's deletion inventory attributes the partition generator to the wrong file.**
`tasks.md:110` / `acceptance.md:181` (X4): *"`src/postgres/chain-archive-rollover.ts` (353 lines),
`createHeightPartitions` and the `sql.unsafe()` partition-bound path are deleted"*.

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && wc -l < src/postgres/chain-archive-rollover.ts'
353
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && grep -rn "createHeightPartitions" --include=*.ts src/'
src/postgres/migrations/chain_archive/001_chain_archive_core.ts:278,398,459,762
```

The 353 is exact. But `createHeightPartitions` and the `sql.unsafe()` DDL live in
`001_chain_archive_core.ts`, not in the rollover module. Harmless — the migration is replaced
greenfield anyway — but a task written as "delete rollover.ts and its generator" will not find the
generator there.

**m-7. The brief's own inventory has drifted.** Measured:

```
$ requirements 158 (brief: 157) · scenarios 546 (brief: 540) · lines 20,689 (brief: 20,327)
```
Per change: chain-archive 27/88, durability 30/96, schema-parity 26/108, temporal 21/80,
data-migration 22/53, engine-core 16/56, lease 16/65. Not the authors' defect; recorded because a
count in a brief is a relay like any other, and this one is 1.8% stale on line count.

**m-8. A document landed after the plan and is cited by nothing in it.**
`docs/research/indexer-parallelism-roadmap.md` was created and twice rewritten on 2026-07-26 — the
three most recent commits on the branch. It concerns the upstream Rust chain-indexer, not UmbraDB's
storage layer, and I found nothing in it that contradicts the seven changes. Flagged only because it
is the newest thing in the repo and no change references `docs/research/`; a reviewer checking
"has the repo moved" should know it moved here and that it does not bite.

---

## 5. What I verified that held

Round 1 produced no coverage signal. This is mine. Every item below was checked against the current
worktree, not against the plan's account of it.

**The five never-independently-checked claims named in the brief — four hold outright, one holds
narrowly.**

1. **No `Dockerfile` exists.** Holds.
   ```
   $ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && find . -path ./node_modules -prune -o -iname "*dockerfile*" -print'
   (zero hits)
   $ … -iname "*compose*.y*ml"  → (zero hits); .github/workflows/ → 5 files, no image build/publish step
   ```
   `v1.0.0-sqlite-data-migration/design.md:1072` and `proposal.md:234` are correct. (The
   corroboration *count* is the M-4 defect; the fact itself is right.)

2. **`row.lifecycle` is never read in `decodeRow`.** Holds, and the shipped code comment above it is
   wrong exactly as change 7 says.
   ```
   $ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && sed -n "233,249p" src/postgres/transaction-history-storage.ts'
   function decodeRow(row: TxHistoryRow): TransactionHistoryEntry {
     …
       identifiers: row.identifiers,
       …
       lifecycle: stored.lifecycle,      ← from the JSON
   ```
   `identifiers` comes from the column, `lifecycle` from the JSON — while `:229` claims
   *"`identifiers`/`lifecycle.status` are read from their own denormalized columns"*. Change 7's
   citations `:243`, `:329`, `:358`, `:462` are each exact (the column is `SELECT`ed at all three read
   sites and compared nowhere).

3. **`ckpt_manifests` has no unique constraint.** Holds.
   ```
   $ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && sed -n "26,42p" src/postgres/migrations/002_checkpoint_store.ts'
   CREATE TABLE …ckpt_manifests (id bigserial PRIMARY KEY, w text, net text, seq bigint, complete
     boolean, manifest_hash bytea, label text, created_at timestamptz)
   CREATE INDEX ckpt_manifests_lookup ON …ckpt_manifests (w, net, complete, seq DESC)
   ```
   PK on the surrogate `id`; the only index on `(w, net, …)` is non-unique. `ckpt_sequence_counters`
   is PK `(w, net)` with `next_seq DEFAULT 2` and no relation to `max(seq)`. Both halves of the live
   defect confirmed.

4. **Migrations `007`, `008`, `009` collide with nothing.** Holds.
   ```
   $ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && grep -rn "export const name" src/postgres/migrations/ | sort'
   000_schema … 006_ckpt_chunks_size_bytes, plus chain_archive/001_chain_archive_core
   $ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && grep -n "import \* as migration" src/postgres/migrate.ts'
   000 … 006 registered; nothing above 006
   ```
   The archive lineage is separately numbered (`[000_schema, 001_chain_archive_core]`), reusing
   `000_schema` against a different schema by design — so a tier-1 `007/008/009` cannot clash.

5. **`archive:sync` has never run against a real database** — holds as stated about the *script*, and
   I could not falsify it; but the inference chain around it is weaker than the plan reads. The same
   code path *has* run against a real PostgreSQL with real Preprod chain data:
   `test/integration/chain-archive-sync.integration.test.ts` and
   `test/integration/chain-archive-preprod-cloud-crossval.integration.test.ts` (AC-8) call
   `bootstrapChainArchiveSchema` + `ChainArchiveSyncService` and ingest a contiguous multi-block range
   from `rpc.preprod.midnight.network` into a `postgres:17-alpine` container. The load-bearing
   conclusion — *no archive content exists to migrate*, hence greenfield — **survives**, because the
   container is ephemeral and there is no persistent archive deployment. What does not survive is the
   companion claim "no consumer / no runner / nothing calls it" (C-1), and the impression the plan
   gives that the archive schema is untested code.

**Retracted premise 3 (PostgreSQL page checksums) — correctly retracted, and re-derived rather than
relayed.** Change 5 `design.md:261-280` states *"UmbraDB is not losing page checksums, because it
never had them"*, and I reproduced both of its supporting commands:

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && grep -n "fsync\|synchronous_commit\|full_page_writes" src/postgres/durability-probe.ts | sed -n "…"'
204: readSetting("fsync") / 205: readSetting("synchronous_commit") / 206: readSetting("full_page_writes")
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && grep -rni "data_checksums\|amcheck\|page checksum" docs/ src/ README.md'
(zero hits)
```
The `:204-206` citation is exact. **No sentence anywhere in the seven changes implies restored
parity** — I grepped for it. The critical finding the brief anticipated here does not exist.

**Retracted premise 4 (two-case corruption wording) — adjudicated and stated.** Change 5
`design.md:252-259` carries the two-case form and `spec.md:487` makes it a requirement; changes 2 and
7 use case-specific measurements, not the absolute. The one lapse is m-5, in change 6.

**Change 7's reject-vs-quarantine ruling does handle the newly-added constraints.**
`specs/data-migration/spec.md:313-380` splits Class 1 (unrepresentable) from Class 2 (representable
but fails a constraint PostgreSQL never had), and Class 2 explicitly names `008`'s `UNIQUE (w, net,
seq)`, the `next_seq > max(seq)` invariant, the 32-byte hash `CHECK` and the `lifecycle` enum `CHECK`.
Both refuse by default; quarantine is prohibited with a negative-control scenario naming the reason
("reports success" while not observationally equivalent). The `next_seq` scenario correctly reproduces
change 4 §17.3(b)'s point that the unique index alone does not catch a counter landing in a pruned
gap. This is the strongest section in the sprint.

**Cross-change dependency on migration `006` is coherent, which is a non-obvious win.** Change 4
`design.md:735-737` rules `006` replays verbatim including `STORED` *because* `ckpt_chunks` holds zero
rows in a fresh lineage. Change 7 `tasks.md:145-149` correspondingly runs `000`→`009` **on the empty
file before the first row**, and states the failure mode (`cannot add a STORED column`) if that order
were violated. Verified against the real migration
(`006_ckpt_chunks_size_bytes.ts:16-19`, `GENERATED ALWAYS AS (octet_length(data)) STORED`). Two
changes, opposite ends of the sprint, same fact, no drift.

**Spec-delta headers resolve; changes 2 and 4 partition the merged capability without collision.**
```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && grep -c "^### Requirement:" openspec/specs/temporal-kv/spec.md'  → 11
ch2 MODIFIED: 9 requirements   ch4 MODIFIED: 2 ("Migrations are idempotent and ordered",
                                               "Schema isolation is the default, not opt-in")
```
Disjoint, and together exactly the 11 merged requirements. Both of change 4's headers exist verbatim
in the merged spec, so the byte-for-byte claim (`proposal.md:165`) holds. Change 4's `design.md`
§16.5 (the deliberately-not-deltaed requirement) exists.

**Change 3's D-4 boundary, cited by change 4 `design.md:29` as
`v1.0.0-sqlite-concurrency-lease/design.md:35`, is at line 35** (name prefixing + migration runner to
change 4; the table's columns and protocol to change 3), and the `writer_generation` DDL the two
changes state independently does not diverge (m-4).

**Relay coverage, quantified.** 880 lines in the seven changes reference another change; 611 use the
`change N` form; **221** carry an explicit `§N` or `file:line` anchor — the load-bearing set — of
which **62** are hard line-range citations (48 of those in change 7). **41 load-bearing relays were
resolved against their source**, including every one that carries a fact rather than a pointer:
**24 matched, 17 were mis-anchored or dangling**, and the mis-anchors are concentrated exactly where
M-0, M-5, m-2 and m-3 say. Critically, **in every mismatch I resolved, the citing change's
*statement* was substantively correct** — the sprint's cross-change understanding is sound; its
pointers are not. That distinction is what keeps this at Major.

**The numeric `errcode` discriminator — the relay error the brief records as already having happened
once — has been fully purged.** Change 3 `design.md:731-738` and `specs/transaction-lease/spec.md:514,
545-547` refute the numeric form in terms (*"there is no numeric `errcode` field at all"*); change 3
§7.1's mapping keys on the string `err.code`; change 5 `design.md:87, 92-93, 862-865` records
`typeof err.errcode === "undefined"` measured on `better-sqlite3@13.0.2`. No change binds a numeric
discriminator normatively. The one residual is change 7 `design.md:1121-1123`, which shows
`{"code":"ERR_SQLITE_ERROR","errcode":1811}` — but it labels the run as `node:sqlite` at
`design.md:1156-1163` and gates re-confirmation on the ruled binding as blocking task 0.2 /
acceptance P1. Correctly handled.

**Invariant ownership agrees across the three changes that restate it.** Change 6 `design.md:1021-1027`
and change 4 `design.md:1301` both reproduce change 5's master table (`design.md:473-479`) with the
same owner for every one of I-1…I-8, and all three agree with the ruling source
(`audit/fable-r3-ruling.md:322-331`). The R-3 relay defect the brief warned about — a summary dropping
invariants — has not recurred in the *ownership list*. It recurred in the *delivery* (C-4), in one
predicate (I-1's `load()` half), in one mechanism description (I-2), and in change 5's normative
record (I-8) — all in M-6.

**Five of the eight invariants are cleanly closed.** I-3 (change 2, `specs/temporal-kv/spec.md:192`,
scenarios at `:234, :240, :253, :261`) is the best-executed of the eight — labelled, matching the
ruling word for word, with a scenario that fails if the second conjunct is dropped and an explicit
zero-row clause. I-6 is stated normatively in both change 5 (`:420`) and change 6 (`:268`) — a
sanctioned duplication under change 5 `design.md:482` — with a four-consecutive-advance latch test on
the change 6 side. I-5 and I-7 carry real requirements and falsifying scenarios in change 4
(`:655`, `:703`, five scenarios each), and change 7 extends I-7 source-side as a Class 1 refusal
without contradicting it. I-2's *substance* is correct in change 6 (`:226`, four scenarios); only
change 5's description of it is stale.

**No invariant is specified twice with a contradictory predicate.** The three divergences in M-6 are
a dropped conjunct, a stale mechanism description and an omission — not two changes asserting
incompatible things. That distinction is why M-6 is Major and not Critical.

**The superseded R-1 adjudication default has left no trace.** `postgres` is removed outright in
changes 1, 6 and 7 with no surviving "retained scoped to `chain-archive-sync/`" wording outside
explicit statements that it is superseded (change 1 `design.md:915`, `:993`,
`specs/sqlite-engine/spec.md:85-86`, `acceptance.md:153`; change 7 `design.md:661`).

**Number provenance in change 6 is exemplary.** `design.md:157-183` states conditions before the
transcript — *"`better-sqlite3@13.0.2`, SQLite 3.53.4, `/root` on ext4 (`/dev/sdd`),
`journal_mode=WAL`"* — labels L5's crossover figure as tmpfs-taken and re-states it as an obligation
(`proposal.md:148-150`), and refuses to adopt change 1's unreproduced 22×. Change 5 §1.3 names the
233× error and quotes no commit-throughput number at all. The contamination class is, on my sampling,
under control everywhere except M-2.

**Countable claims spot-checked and exact:** `chain-archive-rollover.ts` = 353 lines; `package.json:46`
= `archive:sync`; `sync-cli.ts:38`; `bootstrap.ts:21`; `sync-service.ts:123`;
`durability-probe.ts:204-206`; `transaction-history-storage.ts:243/:329/:358/:462`;
`tsconfig.json` includes `chain-archive-sync/` while `tsconfig.build.json` excludes it.

**Mechanical checks:**
```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && /usr/local/bin/openspec validate --changes --strict --no-interactive'
19 passed, 2 failed  — the two failures are v1.1.0-formal-completion and v1.1.0-quint-model-checking
                       (pre-existing); all seven sqlite changes ✓
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint && git status --porcelain -- src test chain-archive-sync package.json'
(empty)
```
File set by hand: all seven have `proposal.md`, `design.md`, `tasks.md`, `acceptance.md` and a
`specs/<capability>/spec.md`; `v1.0.0-sqlite-schema-parity` has the expected 6 files (second delta
directory `specs/temporal-kv/`). No change is missing `acceptance.md`.

---

## 6. Coverage gaps

**a. Nothing enforces premise currency after this audit.** J3 is a static list of four literal
phrases over five of seven changes. The errors that actually recurred are *inferences*
("nothing calls", "no consumer", "no runner", "if it is ever wired"), and no gate looks for those.
The cheapest durable fix is a check that fails when a change quotes a source file's comment as
evidence for a negative existence claim without a companion command output — the discipline change 5
§2.1 and change 6 §3.2 both already practise voluntarily.

**b. No change owns retiring the stale comments in shipped source and docs.** Three are now known
(`001_chain_archive_core.ts:86`, `chain_archive/index.ts:25`, `docs/features/full-chain-storage.md:81`).
Change 6 deletes the first file, which retires two of them incidentally; the doc is retired by no one.
The next audit will re-find them and re-derive the same wrong scope conclusion, because the comments
are what a reader reaches first.

**c. No change specifies what happens to `@testcontainers/postgresql`.** `package.json:58` is a
devDependency, and every archive and checkpoint test in `test/postgres/` and `test/integration/`
starts a `postgres:17-alpine` container. Change 1 removes `postgres` from `dependencies` outright and
records the three archive-touching commands as its closing condition, but nothing states whether the
PostgreSQL test harness survives the migration, is replaced, or is deleted with its suites. Change 6
`tasks.md:321-323` gets closest ("`chain-archive-store.test.ts` and `chain-archive-rollover.test.ts`
either passes against the ported store or is retired with reason") but scopes it to two files in one
capability. This is a whole-repo question with no owner.

**d. Changes 6 and 7 have no zero-row self-audit.** M-3 is one instance; the absence is the gap.
Change 2 §10.5 is a half-page and found a real defect in its own author's design. The two newest
changes — written after that section existed — did not repeat it.

**e. Change 7's V1–V6 verification is not stated to be non-vacuous on an empty source.** I did not
find a scenario asserting the fixtures are non-empty; a source database with zero rows in a table
satisfies every cardinality and digest comparison as `0 == 0`. Lower risk than M-3 (change 7's
Fixture A/B acceptance rows imply populated fixtures) but unstated, and it is the same shape.

**f. Nothing validates a cross-change citation.** 221 anchored relays, 62 of them hard line ranges,
and the checked sample missed 41% of the time — in a plan whose own diagnosis of round 1 was that
facts mutate in relay. Line numbers into a 1,200-line design document are the wrong anchor for a
document set that is still being edited; requirement headings are stable and greppable. A CI check
that every `<change>/<file>:<range>` resolves, and that every `§N` exists in the cited file, is a few
lines of script and would have caught M-0, M-5, M-6, m-2 and m-3 before the panel saw them.

**g. The pragma set has no single owner and no completeness check.** C-5 is `foreign_keys`; the shape
is general. Change 1 owns "pragma bootstrap", changes 4, 5, 6 and 7 each assert what the bootstrap
contains, and no document enumerates the set. Change 5 hard-refuses on `journal_mode`,
`synchronous`, `foreign_keys` and filesystem class; change 1's bootstrap requirement names
`page_size`, `auto_vacuum` and `journal_mode`. Nobody has diffed the two lists. `foreign_keys` is the
one I found by diffing them; I did not check the rest exhaustively.

**h. The R-3 invariant IDs have no spec-level traceability in the change that owns three of them.**
```
$ wsl -e bash -lc "cd /root/UDB-sqlite-sprint/openspec/changes && grep -rn 'I-[1-8]' v1.0.0-sqlite-schema-parity/specs/"
(zero hits)
```
Change 4 owns I-1, I-5 and I-7. All three have real requirements and falsifying scenarios — and none
carries an `I-n` label in any spec file, so the chain from the ruling to the normative text runs
design→tasks only and cannot be walked by grep. Change 4's `acceptance.md` renumbers them `## I5` /
`## I7` (no hyphen) and change 2 uses `I3a…I3e`. Changes 3 and 1 contain no `I-n` token at all.
A reviewer asking "which requirement discharges I-5?" has no mechanical way to answer, which is
precisely how C-4 survived to this round.

**i. Q-1 (docker images) remains genuinely open and gates a specified deliverable.** Change 7
`design.md:1196` says §12.3 case 5 is "unwritable without the answer" and cases 1–4 "cannot be
validated". Change 1 nevertheless publishes the three-channel statement, docker included, as fact
(J2). Nothing in the repository corroborates that channel — the only evidence is an owner assertion,
and that is fine, but the plan should not read as though a search found it.
