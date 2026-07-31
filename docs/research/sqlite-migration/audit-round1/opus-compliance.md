# Audit — `opus-compliance` (spec conformance and cross-change consistency)

**Seat:** `opus-compliance`
**Lens:** conformance to repository conventions, OpenSpec delta machinery, and coherence across the five parallel-authored changes.
**Snapshot audited:** `/root/UDB-sqlite-sprint`, branch `sprint/sqlite-migration`, 2026-07-31 13:56 MDT.
Content hash of the five change directories at time of audit:

```
$ find openspec/changes/v1.0.0-sqlite-* -type f | sort | xargs sha256sum | sha256sum
59cae0ab809731fc3d7b943d85944052ef99213cb3ebfcd996bc06dcbca7451f  -
```

*Note:* every file in all five changes has an mtime inside the 30 minutes preceding this audit
(latest `13:55:38`, audit started `13:5x`). One file (`v1.0.0-sqlite-engine-core/specs/sqlite-engine/spec.md`)
grew from 503 to 561 lines mid-audit. All findings below were re-verified against the hash above.

---

## 1. Verdict

**APPROVE WITH FINDINGS.**

From the compliance and cross-change lens this is the strongest sprint plan I have audited in this
repository. The delta machinery is correct: all ten `## MODIFIED Requirements` headers across the two
`temporal-kv` deltas match the merged spec byte-for-byte, the two changes partition the merged
requirements disjointly, and change 4's `design.md` §16 documents the hand-off from change 2 with the
header-resolution hazard named explicitly and the byte-for-byte discipline stated as the reason. All
five changes carry the full five-file set (change 4's `acceptance.md` **did land**), all five state
explicit non-goals naming the chain archive, all 155 tasks carry `**Acceptance:**` criteria, and
`validate --strict` is green on all five with only the two pre-existing failures. I spot-checked
**25** `file:line` citations across all five changes by opening the cited file at the cited line and
found **zero** misrepresentations — the failure mode this project was previously burned by does not
recur here. I found **no critical findings**. The two majors are both *gaps between neighbours* — a
table change 3 needs that change 4's lineage does not create, and the one merged `temporal-kv`
requirement that neither `temporal-kv` delta claims — which is exactly the residue a parallel
authoring setup leaves and exactly what the coordination relays did not reach.

---

## 2. Critical findings

**None.**

For the record, each of the reversion risks the brief flagged was checked and each was handled
correctly; see §5.

---

## 3. Major findings

### M-1. The `writer_generation` table is specified by change 3, deferred to change 4, and created by neither

**Changes:** 3 (`v1.0.0-sqlite-concurrency-lease`) and 4 (`v1.0.0-sqlite-schema-parity`)
**Files:** `openspec/changes/v1.0.0-sqlite-concurrency-lease/design.md:35,177-188`; `.../tasks.md:39-42,116`; `openspec/changes/v1.0.0-sqlite-schema-parity/design.md:29,790-880`

Change 3's requirement *"a second writer process is detected and the displaced process is
fail-stopped before it can commit"* (`specs/transaction-lease/spec.md:127`) mandates "a single-row
writer-registration record **inside the database file itself**". Its `design.md` §2.2 gives the DDL
sketch and immediately disclaims ownership:

```
design.md:177  A single-row registration table in the wallet lineage (physical name and prefixing are D-4's):
design.md:35   | D-4 | v1.0.0-sqlite-schema-parity | … | The writer-registration table's physical
               name is that change's; its columns and protocol are §2's. |
```

Change 4 does not accept the hand-off. Its ownership table pushes the whole mechanism back:

```
design.md:29  | Change 3 … | BEGIN IMMEDIATE; the writer-exclusion mechanism replacing
              pg_advisory_lock; contention error mapping | §9.3 … and §4.4 … both consume
              change 3's mechanism and neither specifies it. |
```

and its §12 DDL — the complete lineage, which explicitly carves out only change 2's tables
(`§12.1: "TemporalKV's tables are change 2's and are not shown"`) — contains no such table:

```
$ grep -n "^CREATE TABLE" openspec/changes/v1.0.0-sqlite-schema-parity/design.md
293:CREATE TABLE <s>_transaction_history_identifiers (
801:CREATE TABLE <s>_migrations (
807:CREATE TABLE <s>_ckpt_chunks (
814:CREATE TABLE <s>_ckpt_manifests (
829:CREATE TABLE <s>_ckpt_manifest_chunks (
838:CREATE TABLE <s>_ckpt_sequence_counters (
844:CREATE TABLE <s>_watermarks (
853:CREATE TABLE <s>_transaction_history (
864:CREATE TABLE <s>_transaction_history_identifiers (

$ grep -rn "writer" openspec/changes/v1.0.0-sqlite-schema-parity/specs/storage-schema/spec.md
72:  *names*: one writer lock, one WAL, no schema-level teardown
```

Change 3's task 0.3 asks the implementer to "confirm the writer-registration table's physical name
with `v1.0.0-sqlite-schema-parity`" and task 3.1 says "add the writer-registration **row**". Neither
change owns the **migration that creates the table**. There is no migration number for it, no `<s>_`
prefix assigned, and no `STRICT` declaration.

This bites three of change 4's own requirements: *"every object name UmbraDB creates carries the
schema prefix"* (`storage-schema/spec.md:16`), *"every table is STRICT"* (`:98`), and *"the
forward-only migration framework is preserved"* (`:499`). Change 3's DDL sketch is unprefixed, not
`STRICT`, and its `CHECK (id = 1)` is unnamed — which also violates change 4's *"domain constraints
… are restored as **named** CHECK constraints"* (`:167`), the very property change 5 declares it
consumes from change 4 (`durability-contract/design.md:36`: "that every `CHECK` is explicitly named,
so `SQLITE_CONSTRAINT_CHECK` routing by name survives").

**What the plan should say instead:** change 4 should add `<s>_writer_generation` to its §12 lineage
with a migration number, `STRICT`, a named `CHECK`, and the column set change 3 fixes; change 3's
§2.2 should reference that object rather than sketch it. Alternatively change 3 takes the DDL
outright and change 4's spec states the exemption — but one of the two must, and today neither does.

### M-2. One merged `temporal-kv` requirement is orphaned, and the change it was handed to cannot reach it

**Changes:** 2 and 3 (with 4 as the delta carrier that did not take it)
**Files:** `openspec/specs/temporal-kv/spec.md:104-117`; `openspec/changes/v1.0.0-sqlite-temporal-event-log/proposal.md:~136` and `acceptance.md` row N3; `openspec/changes/v1.0.0-sqlite-concurrency-lease/specs/transaction-lease/spec.md:277-281`

Mechanical check of merged-requirement coverage:

```
$ comm -23 <(grep "^### Requirement:" openspec/specs/temporal-kv/spec.md | sort) \
           <(cat <(awk '/^## MODIFIED/{m=1;next} /^## (ADDED|REMOVED)/{m=0} m&&/^### Requirement:/{print}' \
                     openspec/changes/v1.0.0-sqlite-temporal-event-log/specs/temporal-kv/spec.md) \
                 <(awk '/^## MODIFIED/{m=1;next} /^## (ADDED|REMOVED)/{m=0} m&&/^### Requirement:/{print}' \
                     openspec/changes/v1.0.0-sqlite-schema-parity/specs/temporal-kv/spec.md) | sort)
### Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored
```

11 merged requirements; change 2 modifies 8, change 4 modifies 2, one is untouched. Change 2 states
this is deliberate and names change 3 as the owner:

> `proposal.md` non-goals: *"Transactions, the lease … and `opts.tx` wiring are
> `v1.0.0-sqlite-concurrency-lease`'s (change 3). The merged spec's requirement "A caller-supplied
> transaction handle is honored or rejected, never silently ignored" is therefore **deliberately not
> deltaed here.**"*
> `acceptance.md` N3: *"…the merged requirement … is deliberately not deltaed."*

Change 3 has no `specs/temporal-kv/` directory — its only delta is `specs/transaction-lease/`, and an
OpenSpec delta resolves against the capability directory it lives in (change 4's `design.md` §16.1
states this rule correctly). So change 3 **cannot** reach it. The hand-off change 2 recorded goes
nowhere.

The content is not merely stale — it is contradicted. The merged text reads:

```
openspec/specs/temporal-kv/spec.md:104
### Requirement: A caller-supplied transaction handle is honored or rejected, never silently ignored
Until the Transaction/Lease module's real wiring lands (a later sprint), every `PgTemporalKV` method
accepting `opts.tx` SHALL throw a dedicated, distinctly-named error when a caller passes a
non-`undefined` `TransactionHandle` …
#### Scenario: Passing a transaction handle throws before any query runs
- **THEN** the call SHALL reject with a dedicated "transaction participation not yet supported" error
```

Change 3 ships that "later sprint" and specifies the opposite disposition for a live handle:

```
concurrency-lease/specs/transaction-lease/spec.md:277
#### Scenario: The handle is dead after the bound fires
- **WHEN** a callback … passes its `TransactionHandle` to any storage-layer method
- **THEN** that method SHALL reject with `TransactionHandleInvalidError`
```

An implementer working from the merged spec makes every `TemporalKV` method throw
"not yet supported" for *any* handle, which defeats change 3's transaction wiring and produces the
wrong error for the dead-handle case change 3 pins.

**What the plan should say instead:** change 4 already demonstrates the fix — it carries a second
delta directory precisely so orphaned `temporal-kv` requirements are updated by their real owner
(`design.md` §16.2), and its §16.5 documents an adjacent requirement it deliberately does *not*
touch. Change 3 should carry a one-requirement `specs/temporal-kv/spec.md` under `## MODIFIED
Requirements` with the header reproduced byte-for-byte from `openspec/specs/temporal-kv/spec.md:104`,
restating the disposition under real transaction support. Change 2's non-goal sentence and
`acceptance.md` N3 then need to point at that delta rather than at a change that has no route to it.

---

## 4. Minor findings

### m-1. Change 5's design asserts a fact about the sprint's delta machinery that is now false

`v1.0.0-sqlite-durability-contract/design.md` §0.3 (line ~57):

> *"Change 2 (`temporal-kv`) is the only change in this sprint that legitimately writes `## MODIFIED
> Requirements`."*

Change 4 also carries `specs/temporal-kv/spec.md` with two `## MODIFIED` headers, added by the late
hand-off from change 2. The reasoning §0.3 uses to justify change 5's own use of `## ADDED` is sound
and unaffected; only the exclusivity claim is wrong. This is a visible artifact of change 5 not
seeing the change-2→change-4 relay.

### m-2. Change 1's spec cites latency figures without the condition set its own requirement mandates

`v1.0.0-sqlite-engine-core/specs/sqlite-engine/spec.md:510` establishes an absolute rule:

> *"No requirement, design decision or contract statement in this migration SHALL cite a throughput,
> latency or rejection-rate figure that is not present in that artifact with its conditions attached."*

At `:367-373`, the same spec's negative control states:

> *"…measured at 429 ms for a 500k-row materialisation and 237 ms for a 64 MiB blob write, against a
> 0.15–0.3 ms idle baseline"*

with no filesystem, `journal_mode`, `synchronous` or dataset-relative-to-cache statement. These are
main-thread-blocking durations, so the *direction* is not tmpfs-sensitive and the negative control's
argument survives; but by the spec's own rule the numbers are inadmissible as written. Compare
change 2 (`temporal-kv/spec.md:358-361`), which quotes its ms figures and then explicitly says *"because
that measurement was taken on a RAM disk it is a **floor**"*, and change 4 (`storage-schema/spec.md:436-438`),
which says *"the **factors** SHALL NOT be carried as fact, because both measurements were taken
against a tmpfs RAM disk; only the direction is carried"*. Change 1 should apply the discipline it
authored.

### m-3. Change 3's proposal restates `SQLITE_BUSY` with the numeric codes the ruled binding does not expose

`concurrency-lease/proposal.md:124-125`:

> *"`SQLITE_BUSY` (5) and `SQLITE_BUSY_SNAPSHOT` (517) map onto codes and union members that are
> already frozen"*

The mapping table in `design.md:568-573` and the spec requirement at `transaction-lease/spec.md:357`
correctly key on `err.code === "SQLITE_BUSY"` with `err.name === "SqliteError"`, and a negative
control at `:398` explicitly fails a numeric-keyed mapping. So the ruling **is** folded in where it
matters. But the parenthetical numerics in the proposal are the exact residue of the superseded
relay, and a reader who skims the proposal is the one who will write `case 517:`. Change 5 states the
same fact without the numeric hazard (`release-contract/spec.md:350-353`). Recommend striking the
parentheses or annotating them as C-API result codes not exposed by the binding.

### m-4. Change 5's residual-risk item 5 describes a precondition in terms of a mechanism change 3 rejected

`durability-contract/design.md:836-838`:

> *"**Windows.** … the new precondition is a local filesystem with **working advisory locks**."*

and the corresponding spec sentence (`release-contract/spec.md:717-719`) requires the contract set to
state whether Windows is supported "for the new **filesystem-locking** precondition". Change 3
rules that the lease *"SHALL NOT create, open, read, write, lock or unlink any file … and SHALL NOT
rely on POSIX record locks (`fcntl`), `flock`, an OS …"* (`transaction-lease/spec.md:24-25`). There
is no UmbraDB-level filesystem-locking precondition after change 3.

This is defensible as written — SQLite's *own* cross-process exclusion still uses filesystem locks,
so a "local filesystem with working locks" precondition genuinely survives — but the phrasing reads
as if it refers to the lease, and change 3 has an independent Windows requirement of its own
(*"Windows parity for the writer-generation guard is established before the strengthened contract
ships"*, `:633`). The two Windows obligations should be reconciled into one, attributed to the
mechanism that actually creates each: SQLite's file locking for change 5's probe, and the
writer-generation protocol for change 3's guard.

### m-5. Change 2's `tasks.md` uses `### N.N` headings where the house style uses `- [ ] N.N` checkboxes

```
$ grep -c "^- \[ \] " openspec/changes/v1.0.0-sqlite-*/tasks.md
engine-core: 33   temporal-event-log: 0   concurrency-lease: 37   schema-parity: 46   durability-contract: 39
```

Change 2's 22 tasks are `### 0.1`-style headings, each with a `**Acceptance:**` block — so it satisfies
`config.yaml`'s tasks rule and passes strict validation. But the house style
(`v1.0.0-api-surface/tasks.md`, and the other four changes in this sprint) is a checkbox list, which
is also what makes progress trackable. Cosmetic, but it is the one place the five diverge on form.

### m-6. Change 5's `src/postgres/checkpoint-store.ts:65-66` citation is imprecise

`release-contract/spec.md:151-153` cites `:65-66,366-368` for *"a loaded chunk's content hash is
recomputed and compared against its content-address"*. Lines 65-66 are the body of the `sha256()`
helper, not the recompute-and-compare site; the comparison is at `:366-368` as cited. Not a
misrepresentation — the helper is genuinely the hashing mechanism — but the pair reads as two halves
of one claim and only one half is where the reader is sent.

---

## 5. What I verified and it was correct

### Delta machinery (the item I was asked to verify myself, with commands)

**Byte-for-byte header match, both deltas, every header.** `openspec/specs/temporal-kv/spec.md` is
confirmed the only merged spec (`find openspec/specs -type f` → one file).

```
$ M=openspec/specs/temporal-kv/spec.md
$ for f in openspec/changes/v1.0.0-sqlite-temporal-event-log/specs/temporal-kv/spec.md \
           openspec/changes/v1.0.0-sqlite-schema-parity/specs/temporal-kv/spec.md; do
    echo "=== $f ==="
    awk '/^## MODIFIED Requirements/{m=1;next} /^## (ADDED|REMOVED|RENAMED)/{m=0} m&&/^### Requirement:/{print}' "$f" \
    | while IFS= read -r h; do grep -Fxq "$h" "$M" && echo "MATCH   : $h" || echo "NO-MATCH: $h"; done
  done

=== v1.0.0-sqlite-temporal-event-log/specs/temporal-kv/spec.md ===
MATCH   : ### Requirement: Postgres errors surface as the shared StorageError hierarchy
MATCH   : ### Requirement: Unconditional writes are gapless and monotonic (Law T1)
MATCH   : ### Requirement: put's CAS guard distinguishes conflict from absence
MATCH   : ### Requirement: A second write to the same key within one transaction is rejected at the trigger level, not silently absorbed
MATCH   : ### Requirement: listKeys streams without materializing the full result set first, and orders results correctly
MATCH   : ### Requirement: getAt satisfies temporal-projection equivalence (Law T3), within the store's retention window
MATCH   : ### Requirement: Dual addressing agrees at recorded write timestamps (Law T4)
MATCH   : ### Requirement: History intervals never overlap for a single key (Law T5)
=== v1.0.0-sqlite-schema-parity/specs/temporal-kv/spec.md ===
MATCH   : ### Requirement: Migrations are idempotent and ordered
MATCH   : ### Requirement: Schema isolation is the default, not opt-in
```

`grep -Fxq` is a fixed-string, whole-line match — this is the exact resolution OpenSpec performs and
that `validate --strict` does not check. **10/10 match. Zero paraphrases.**

**No two changes delta the same requirement.**

```
$ comm -12 <(awk '…MODIFIED…' change2/specs/temporal-kv/spec.md | sort) \
           <(awk '…MODIFIED…' change4/specs/temporal-kv/spec.md | sort)
(empty)
```

The partition is also *principled*, not accidental: change 4 takes exactly the two requirements that
are migration-framework/schema-namespacing (`Migrations are idempotent and ordered`, `Schema
isolation is the default`) and change 2 takes the eight that are TemporalKV semantics. Change 4's
`design.md` §16 states the ruling, the alternatives it rejected (defer to change 5; `REMOVED` instead
of `MODIFIED`), the header-resolution hazard verbatim — *"OpenSpec resolves a modification by header
text; a paraphrased header silently creates a new requirement and leaves the false one standing"* —
and, in §16.4, the one thing it knowingly leaves wrong (the header noun `isolation` now overstates
the property; the rename is deferred rather than taken, because renaming would break resolution).
§16.5 then records an *adjacent* requirement it deliberately does not delta, with the reason. This is
the late hand-off executed correctly and audited by its own author.

Change 5's `design.md` §0.3 additionally establishes, correctly, that `release-contract` has never
been merged into `openspec/specs/`, so `## MODIFIED` there would be a delta against nothing, and
expresses its deletions (notably `docs/CONTRACT.md:65-67`) as positive falsifiable requirements about
the resulting document instead. That is the right call.

### Mechanical checks

```
$ cd /root/UDB-sqlite-sprint && /usr/local/bin/openspec validate --changes --strict --no-interactive
✓ change/v1.0.0-sqlite-concurrency-lease
✓ change/v1.0.0-sqlite-durability-contract
✓ change/v1.0.0-sqlite-engine-core
✓ change/v1.0.0-sqlite-schema-parity
✓ change/v1.0.0-sqlite-temporal-event-log
✗ change/v1.1.0-formal-completion
✗ change/v1.1.0-quint-model-checking
Totals: 17 passed, 2 failed (19 items)
```

All five new changes pass strict. Baseline was 12 passed / 2 failed; it is now 17/2 — the same two
pre-existing failures, exactly as the brief predicted, and none of the five introduces a new one.
(As the brief says: green means structure, not truth. It is reported as a floor, not an approval.)

**No product code modified.**

```
$ git status --short
?? openspec/changes/v1.0.0-sqlite-concurrency-lease/
?? openspec/changes/v1.0.0-sqlite-durability-contract/
?? openspec/changes/v1.0.0-sqlite-engine-core/
?? openspec/changes/v1.0.0-sqlite-schema-parity/
?? openspec/changes/v1.0.0-sqlite-temporal-event-log/
```

Five untracked directories under `openspec/changes/`, nothing else. No tracked file is modified.

**Five-file set — complete in all five, including change 4's `acceptance.md`.**

| Change | proposal | design | tasks | acceptance | specs |
|---|---|---|---|---|---|
| engine-core | ✓ | ✓ | ✓ | ✓ | `sqlite-engine/spec.md` |
| temporal-event-log | ✓ | ✓ | ✓ | ✓ | `temporal-kv/spec.md` |
| concurrency-lease | ✓ | ✓ | ✓ | ✓ | `transaction-lease/spec.md` |
| schema-parity | ✓ | ✓ | ✓ | **✓ (landed)** | `storage-schema/spec.md` + `temporal-kv/spec.md` |
| durability-contract | ✓ | ✓ | ✓ | ✓ | `release-contract/spec.md` |

Change 4's `acceptance.md` (139 lines, 46 tasks referenced) **did land** — I verified by hand rather
than assuming, since `validate --strict` treats `acceptance.md` as a repository convention, not a
schema requirement, and passes without it.

### `openspec/config.yaml`'s three binding rules

**Rule 1 — explicit non-goals in every proposal.** All five have an explicit `## Non-goals` section.
All five list the chain archive as an explicit non-goal, four of them quoting
`001_chain_archive_core.ts:86` verbatim ("Not wired into any runner path that would execute it").
Nothing in any of the five schedules, costs, or migrates the archive. Scope discipline (brief failure
mode 6) is clean.

**Rule 2 — section-number citations to `design/design.md`, `design/design-interfaces.md`,
`Formal/STORAGE_ALGEBRA.md`.** Present and specific in all five designs. Sampled: change 3 cites
`design/design.md` §5, `design/design-interfaces.md` §3.1 (with §1.3 and §1.1 sub-references),
`Formal/STORAGE_ALGEBRA.md` §4 and §2 (with C2a at `:260`), and in each case states whether it
supersedes, preserves, or re-derives — e.g. *"§1 of this document supersedes the mechanism; the
semantics §5 fixed are preserved"* and *"§4's removal of TTL/lease-stealing is **not** reversed"*.
Change 5 cites `design/design.md` §3/§5, `Formal/STORAGE_ALGEBRA.md` §2/§4/§5. No silent duplication
or contradiction found.

**Rule 3 — concrete acceptance criteria on every task.**

```
$ for c in …; do echo "$c: tasks=$(grep -c '^- \[ \] ' $f) acceptance=$(grep -c '\*\*Acceptance:\*\*' $f)"; done
engine-core: 33 / 33      temporal-event-log: 22 (heading-style) / 22
concurrency-lease: 37 / 38   schema-parity: 46 / 46   durability-contract: 39 / 40
```

Every task in all five carries an `**Acceptance:**` block. An awk pass for tasks whose body lacks the
string returned empty for all five. The criteria are concrete — naming the test, the command, or the
artifact and its content (e.g. change 2 task 0.1: *"a checked-in record naming the filesystem (`df -T`
output on the database path), the two pragma values, N, R, the dataset size, and the branch taken"*).

### EARS form and negative controls

| Spec | Requirements | Scenarios | SHALL lines | Negative controls |
|---|---|---|---|---|
| `sqlite-engine` | 15 | 43 | 112 | 14 |
| `temporal-kv` (c2) | 18 | 55 | 149 | 6 |
| `transaction-lease` | 15 | 55 | 189 | 21 |
| `storage-schema` | 18 | 72 | 184 | 11 |
| `temporal-kv` (c4) | 2 | 9 | 30 | 1 |
| `release-contract` | 21 | 58 | 190 | 13 |

An awk pass for `### Requirement:` blocks containing no `SHALL` returned **empty for every spec** —
89 requirements, all normative. A weasel-word sweep across all six spec files
(`SHALL be robust|performant|efficient|reliable|fast`, `appropriately`, `as needed`, `where
appropriate`, `reasonable`, `best effort`, `adequate`) returned **zero hits**. Brief failure mode 3
(unfalsifiable requirements) is clean at the language level, and the requirements I read in full were
falsifiable in substance too — several state the falsifying observation explicitly (change 1
`:411`: *"that ratio is the observation which falsifies this requirement, so it SHALL be asserted as a
ratio between two timings rather than described as a property of the implementation's shape"*).

66 negative-control scenarios across the six specs. They target the right things: the refuted sidecar
lease, a numeric-keyed error mapping, a blocking `busy_timeout`, an out-of-transaction generation
guard, a materialise-first stream, a row-per-message stream, the logical clock adopted pre-gate,
`WITHOUT ROWID` on payload tables, a `STORED` column added to a populated table, and reuse of the
tmpfs figures.

### Citation integrity — 25 checked, 25 correct

The brief required at least eight. I opened each cited file at each cited line.

| Citation | Claimed | Verified |
|---|---|---|
| `chain_archive/001_chain_archive_core.ts:86` | "Not wired into any runner path" | ✓ exact line |
| `chain_archive/001_chain_archive_core.ts:63-70` | v4 audit data-loss fix | ✓ |
| `chain_archive/001_chain_archive_core.ts:570` | `UNIQUE NULLS NOT DISTINCT` | ✓ exact line |
| `src/interfaces/transaction-lease.ts:76` | frozen `faultKind` union | ✓ exact line |
| `src/interfaces/transaction-lease.ts:169-175` | signal is pre-check-only | ✓ |
| `src/interfaces/temporal-kv.ts:153` | `readonly writtenAt: Date` | ✓ exact line |
| `src/interfaces/temporal-kv.ts:156-163` | `AssertExact` compile-time guard | ✓ |
| `src/interfaces/temporal-kv.ts:250-256` | `TransactionKeyReuseError` | ✓ |
| `src/interfaces/temporal-kv.ts:314-322` | non-pattern range comparison permitted | ✓ |
| `package.json:31-33` | `engines: node >=24` | ✓ exact block |
| `docs/ERROR-CATALOG.md:13` | no `retryable` weakening | ✓ exact line |
| `docs/ERROR-CATALOG.md:34` | `TRANSACTION_FAULT` retryable | ✓ exact row |
| `docs/ERROR-CATALOG.md:35` | `LEASE_TIMEOUT` | ✓ exact row |
| `docs/ERROR-CATALOG.md:44` | `MIGRATION_LOCK_TIMEOUT` | ✓ exact row |
| `docs/ERROR-CATALOG.md:73-89` | `CLOCK_REGRESSION` conditional, two causes | ✓ |
| `docs/CONTRACT.md:57-60` | `releaseLease` signal-less, with reason | ✓ |
| `docs/CONTRACT.md:65-67` | the "wait is **freed**" clause change 5 deletes | ✓ exact clause |
| `docs/CONTRACT.md:127-130` | "a mid-GC dump is safe to restore" | ✓ exact line |
| `docs/STABILITY.md:20-22` | additive-only within `1.x` | ✓ |
| `src/postgres/migrate.ts:18` | `DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 30_000` | ✓ exact line |
| `src/postgres/migrate.ts:240-242` | `to_regclass` bootstrap probe | ✓ exact statement |
| `src/postgres/migrations/001_temporal_kv.ts:72-139` | the DDL block reproduced | ✓ exact span |
| `src/postgres/checkpoint-store.ts:340-346` | `load()` is a point join by hash | ✓ |
| `src/postgres/checkpoint-store.ts:366-368` | chunk hash recomputed on load | ✓ |
| `Formal/STORAGE_ALGEBRA.md:332-333` | the two T5 status rows | ✓ exact rows |

The only imprecision found is m-6. Across 25 checks there is not one instance of a citation that does
not say what the spec claims. Given the brief's warning that this project has been burned by exactly
that, this is the single most reassuring result of the audit.

### Reversion checks (brief failure mode 1 / 1b) — all handled

- **Sidecar lock-file lease.** Change 3 §1.1 rejects it outright — *"the per-key sidecar is rejected
  and must not be implemented"* — and its requirement `transaction-lease/spec.md:20` forbids the
  mechanism in normative form (*"SHALL NOT create, open, read, write, lock or unlink any file … SHALL
  NOT rely on POSIX record locks (`fcntl`), `flock`…"*). **Both attacks are written as scenarios**
  (`:56-66`: the `fs.readFileSync` descriptor-close attack and the `unlink` attack, each producing
  two simultaneous holders), plus a second appearance as P10 negative controls at `:616-620`. It also
  rejects the red team's four mitigations with the reason that mitigation (c) is unenforceable
  against consumer code in the same process, and rejects raw `flock(2)` on the verified ground that
  Node exposes no binding (§9(b)).
- **Monotone logical clock.** Change 2 gates it correctly: *"The expression that produces `written_at`
  SHALL NOT be fixed by this change"*, with **R** defined operationally (≥5,000 back-to-back same-key
  puts, own autocommit transaction, no throttle, non-tmpfs filesystem, at the shipped
  `journal_mode`/`synchronous`, dataset-to-cache recorded), both branches written out, a `WHILE the
  gate has not reported R` blocking clause, and a negative control that reproduces the 99.2% / 99.1% /
  **0.0% at `synchronous=FULL`** table. Change 1's spec independently names the clock decision in its
  blocked-decision list. Task 0.1 blocks tasks 2.3 and 5.1–5.3 on it.
- **New error code for `SQLITE_BUSY`.** Not added anywhere. Change 3 maps `SQLITE_BUSY` to three
  *already-frozen* codes by context (`LEASE_TIMEOUT` / `MIGRATION_LOCK_TIMEOUT` /
  `TRANSACTION_FAULT(timeout)`) and `SQLITE_BUSY_SNAPSHOT` to `TRANSACTION_FAULT(serialization-failure)`,
  each with its `docs/ERROR-CATALOG.md` line cited (all three verified above). It downgrades B8 to a
  *conditional*. Change 5 carries an explicit requirement *"no frozen error code is repurposed and no
  contention code is added"* (`release-contract/spec.md:403`).
- **`WITHOUT ROWID`.** Change 4 rules against it for the content-addressed tables
  (`storage-schema/spec.md:418`), assigns `ckpt_chunks` and `ckpt_manifests` as plain rowid tables,
  gives the structural reason (the PK b-tree *is* the table), **refuses to carry the factors as
  fact** because both measurements were tmpfs, records the three conditions under which the negative
  would be meaningless and which of them are refuted against real code, and blocks task 2.1 on an
  ext4 re-confirmation (MS4) if the direction inverts.
- **`ADD COLUMN … GENERATED … STORED`.** Change 4 carries L6's precise version, not L4's: `006`
  succeeds *"because `ckpt_chunks` holds zero rows at that point and SQLite accepts `ADD COLUMN …
  GENERATED … STORED` on a 0-row table"*, with a paired test pinning the failure on a populated
  table.
- **`backup()` vs `VACUUM INTO`.** This is the one I was told to watch hardest and change 5 gets it
  right. Its §4.2 quotes the contradiction seat's figures (781 concurrent commits, 1,539 ticks vs 0)
  and then refuses them: *"**None of that transfers automatically** … Two of the three lines of
  support are therefore about a driver that is not shipping"*. §4.3 rules that *"§6 SHALL NOT name a
  live-backup primitive until the comparison has been re-measured on the ruled binding"*, fixes both
  branches in advance (Branch B = "UmbraDB documents that it has no live-backup mechanism"), and
  enumerates the conditions to record. The corresponding requirement is
  `release-contract/spec.md:266` — *"the backup primitive is established by measurement on the ruled
  binding, not asserted"* — with a review scenario for the pre-measurement state. No stale
  `node:sqlite` number is asserted as fact anywhere.
- **The driver relay (1b).** Both late-relay changes folded it in. Change 3 §7.1 states *"L2 keyed its
  mapping on `err.errcode` … That is correct for `node:sqlite` and **wrong for the binding
  `v1.0.0-sqlite-engine-core` ruled**"*, publishes its own re-measurement against the installed
  `better-sqlite3@13.0.2` / SQLite 3.53.4 showing `name=SqliteError code=SQLITE_CONSTRAINT_PRIMARYKEY
  ownProps=["stack","message","code"]`, and turns the wrong form into a negative control (E5b). Change
  5 §0.4 does the same independently (`typeof err.errcode= undefined`) and writes it into
  `release-contract/spec.md:348`. My grep for `errcode`, `517`, `1555` across all five found **no
  normative use of the numeric form** — every occurrence is either the author's own citation of the
  superseded corpus, or a negative control.

### Anticipated cross-change interfaces (brief failure mode 4)

- **`columns()` origin metadata × `STRICT` — the interface the brief flagged as most likely to
  break — agrees on both sides, and each side knows it is load-bearing.** Change 4 §2.3: *"`STRICT`
  and a decoder keyed on **declared type names** are mutually exclusive … the shim must key its
  decoder on `columns()`'s **origin** metadata (`{database, table, column, …}`)"*. Change 1 §2.3
  independently re-measures the same fact and says so: *"Under `STRICT`, `columns()[i].type` is only
  ever `TEXT` / `INTEGER` / `BLOB` / `REAL` / `ANY`"*, with `JSONB`/`BYTEA`/`TIMESTAMPTZ`/`BIGINT`/`INT4`
  each measured `REJECTED` as a declared type. Change 1 §7 then names the coupling: *"Change 4 —
  `STRICT` is load-bearing for §2.2, not hygiene"*, and its acceptance B5/B8 assert both halves so
  neither can be dropped alone. Two authors who could not see each other converged on the same
  mechanism and each flagged the dependency.
- **Change 2's event-log schema × change 4's types/constraints.** Cleanly partitioned. Change 2 §0.2
  writes its DDL *"unprefixed and without `STRICT`; change 4 supplies both"*; change 4 §12.1 carves
  the same seam from the other side (*"TemporalKV's tables are change 2's and are not shown"*). The
  `listKeys` prefix mechanism is assigned to change 4 by both. No duplicate DDL, no contradictory
  types.
- **Change 3's `BEGIN IMMEDIATE` as a precondition elsewhere.** Change 3 requires it universally
  (`:226`, *"no write path is DEFERRED"*) and re-derives C2a from it rather than carrying the
  Postgres derivation (`:553`). Change 4 §4.4/§9.3 consume it and explicitly do not respecify it.
  Change 5 §0.2 lists it as consumed. Consistent.
- **`busy_timeout` ownership.** Change 1 maps `lockTimeoutMs → busyTimeoutMs` and defers: *"Change 3
  rules on whether it is used at all"*. Change 3 rules `PRAGMA busy_timeout = 0` on every handle with
  all waiting in JS. Change 5 §0.2 lists `busy_timeout` under "what this design does **not** decide".
  No contradiction.
- **`docs/CONTRACT.md` section ownership between changes 3 and 5 — disjoint.** Change 5's spec
  normatively rewrites §1, §3 and §6. Change 3's spec normatively rewrites §5 (*"the lease limitation
  stated in writing is exactly what the mechanism delivers"*). No section is claimed twice, and change
  5's cancellation requirement is written **conditionally** on change 3 shipping the JS poll loop
  (§3.3 item 3) rather than assuming it.
- **Change 5's contract text vs what 1–4 promise.** Change 5's §0.2 dependency table states, per
  change, what it consumes and what it does not decide, and marks three items conditional rather than
  assumed. Its acceptance sheet carries explicit N-rows disclaiming the neighbours' territory (N4:
  *"This change does not define the lease mechanism, `busy_timeout`, the poll loop or sticky-poison
  emulation"*). Its `release-contract/spec.md:690` requires *"every engine-named contract sentence is
  re-derived and every external precedent citation is re-verified before it ships"* — an
  anti-carry-forward rule applied to itself.

### Enhancement mandates (brief failure mode 5)

All four present as real requirements with scenarios, not mentions:

- **Structural gap-freedom (change 2):** `temporal-kv/spec.md:55` — *"gap-freedom is structural — a
  gap in a key's validity chain is unrepresentable"*, plus `:23` making the event log the only stored
  representation with intervals derived, and `:109` append-only at the database level.
- **`STRICT` type rejection (change 4):** `storage-schema/spec.md:98` — *"every table is STRICT and a
  wrong-typed write is rejected, not coerced"*, with the paired non-`STRICT` negative control.
- **Lease strengthening tied to a surviving mechanism (change 3):** `transaction-lease/spec.md:127`,
  the writer-generation guard, with the TOCTOU negative control, the `SIGKILL` scenario, the
  transaction-granular *stated limit*, and `:196` binding the written contract to exactly what the
  mechanism delivers (*"SHALL NOT claim that a second writer process is refused at open"*).
- **The page-checksum gap (change 5) — the one the brief called most important — is closed twice.**
  `release-contract/spec.md:138`: *"stored values in the non-re-derivable tier carry an
  application-level digest verified on read"*, with a `ValueIntegrityError` on mismatch and a
  scenario in which bytes altered in the file after checkpoint are detected on read. And `:202`: *"the
  residual corruption-detection gap is written into the durability contract where a consumer sees
  it"* — stating in the contract, not a design doc or changelog, that SQLite writes no
  main-database page checksums and that PostgreSQL's `data_checksums`/`amcheck` have no equivalent
  here. Plus `:178`, a whole-database verification pass reporting structure and content together.
  Silence would have been critical; this is the opposite of silence.

### Numeric provenance (brief failure mode 2)

I grepped every number in all six spec files and checked each one's provenance. **No lane performance
number is asserted as fact.** Change 1 carries the governing requirement (`:499`, *"every
performance-dependent decision is blocked on measurements taken on a real filesystem under declared
conditions"*), including a CI assertion that the artifact's declared filesystem is not memory-backed
and a blanket prohibition on citing an unattributed figure. Change 4 mirrors it (`:629`). Change 2
prices its own ms figures as a tmpfs floor. Change 3's proposal states that *"no performance number is
fixed here"* and lists each quantity as an obligation to establish. The 233× / 88,485-vs-379 figure
appears three times and is a *negative control about the contamination itself* in every instance. The
only lapse is m-2.

---

## 6. Coverage gaps

1. **The two majors are both coverage gaps, not errors.** M-1 (the `writer_generation` table exists in
   no lineage) and M-2 (one merged `temporal-kv` requirement is owned by nobody who can reach it).
   Both are the residue of parallel authoring, and both are the kind of thing that surfaces at
   implementation as a blocked task rather than as a wrong build — but M-1 in particular blocks change
   3's task 3.1 on a decision change 4 never made.

2. **No change owns retiring `openspec/specs/temporal-kv/spec.md`'s Postgres framing as a whole.**
   Change 4's §16 handled the two it could justify taking, and change 2 handled the eight semantic
   ones, but there is no requirement anywhere asserting that after this sprint the merged spec
   contains no surviving reference to a mechanism SQLite lacks. The merged spec's title, purpose
   section, and remaining prose were outside every author's declared scope. A single requirement in
   change 5's release-contract capability — "the merged capability specs name no engine-specific
   mechanism the shipped engine does not provide" — would close this cheaply. Note that this is the
   gap that produced M-2, so closing it structurally is worth more than fixing M-2 alone.

3. **The `<s>_migrations` table is in change 4's lineage but the *migration lock* has no object.**
   Change 4 §9.2 correctly states `pg_advisory_lock(1, hashtext(schema))` has no analogue and that its
   replacement is change 3's mechanism; change 3 owns "the migration **lock**" and change 4 the
   "migration **runner**". But change 3's spec has no requirement naming the migration lock's
   mechanism — its 15 requirements cover the lease, transactions, `BEGIN IMMEDIATE`, contention
   mapping, poisoning and the generation guard. `MIGRATION_LOCK_TIMEOUT` appears in change 3's mapping
   table as a *destination* code with no requirement establishing what raises it. This is a smaller
   sibling of M-1: an obligation both changes point at each other for.

4. **Ordering between the five changes is stated per-change but nowhere globally.** Each change names
   its dependencies (change 5's §0.2 table is the best of them) and change 1's measurement gate is
   correctly blocking, but no artifact in the sprint states the merge order or which changes may
   proceed in parallel. Change 2's task 0.1, change 4's MS4, change 5's §4.3 and change 3's poll/retry
   numbers all block on change 1's artifact; change 3 additionally blocks on change 4 (M-1) and change
   4 on change 2 (table shapes). A one-page dependency graph would make the critical path visible
   before someone starts change 3 first.

5. **Nothing specifies what happens to the *existing* Postgres implementation.** All five changes
   describe the SQLite target; none states whether `src/postgres/` is deleted, retained behind a
   flag, or kept as a second backend. `postgres` leaving `dependencies` is mentioned in passing in
   change 1's §3 cost accounting (`{postgres, zod}` → `{better-sqlite3, zod}`), which implies deletion,
   but no requirement says so and no change owns the removal. If both backends are meant to coexist,
   change 4's *"every table is STRICT"* and change 2's event-log redesign both need a scoping clause
   they do not have.
