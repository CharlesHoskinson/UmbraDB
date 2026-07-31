# Test plan — lane `migration-traceability`

Covers **change 7 `v1.0.0-sqlite-data-migration`** and the migration-facing half of **change 4
`v1.0.0-sqlite-schema-parity`**, plus the **fleet-wide traceability matrix** over all 168
requirements in the seven-change sprint.

Everything below anchors requirements by **title**, never by line number.

---

## 1. Scope

### 1.1 Traceability headline

Measured over the seven changes' `specs/*/spec.md` and `acceptance.md` files at
`/root/UDB-sqlite-sprint/openspec/changes/`, by title-and-scenario resolution
(`/root/umbradb-tp-trace/final2.py`, `stats.py`; commands in §4.6):

| Quantity | Count |
|---|---|
| Requirements across the seven changes | **168** |
| Acceptance criteria across the seven changes | **829** |
| Requirements with **≥1 acceptance criterion anchored to them** | **164 / 168** |
| Requirements with **no criterion anchored to them at all** | **4** |
| Requirements whose entire criterion set carries **no `[unit]` and no `[prop]`** | **20** |
| Requirements with **no executable criterion at all** (no `[unit]`/`[prop]`/`[CI]`) | **0** — every requirement has at least one mechanisable criterion |
| Criteria whose `Req / Task` column resolves to a **design section, proposal or `—`**, not a requirement or scenario title | **190 / 829 (23%)** |
| Criteria tagged **`[manual]` and nothing else** | **93 / 829 (11%)** |
| Criteria with **no `[unit]`/`[prop]`/`[CI]`** (doc and/or manual only) | **243 / 829 (29%)** |
| Criteria referencing a blocked decision or the measurement gate | **27** |

**Where the gaps cluster.** Not evenly. Three concentrations:

1. **Change 5 `v1.0.0-sqlite-durability-contract`** owns 7 of the 20 requirements with no
   `[unit]`/`[prop]` criterion, and 23 of the 93 manual-only criteria. This is structural, not
   sloppy: change 5 is the change that writes contracts, catalogs and evidence, and its criteria are
   about *documents being true* rather than *code behaving*. It is nonetheless where a regression
   hides best, because a document does not fail a test run.
2. **Change 6 `v1.0.0-sqlite-chain-archive`** owns 4 of the 20, all in the snapshot/backup/durability
   region — the region that is itself blocked on B-6 and B-3b.
3. **Change 7 (my lane)** owns 3 of the 20: `ROLLBACK`, `CHANNELS`, `NONUMBERS` — all three of which
   are *procedures and disclosures a consumer reads*, i.e. exactly the artifacts a wrong migration
   would be excused by.

**The four unanchored requirements**, and the honest distinction between them — two are citation
mis-anchors that the sprint's own gate G-16 would have caught if it ran across changes, and two are
real holes:

| Change | Requirement title | Diagnosis |
|---|---|---|
| 6 chain-archive | *the archive's bounded delete is written in the form that needs no optional compile option* | **Mis-anchor.** Criteria `P5` and `W9` cite *"bulk deletion does not depend on an unpinnable compile option"* and *"does not depend on an unpinnable compile option"* — paraphrases that match no live `### Requirement:` heading. Substance is covered; the anchor is not resolvable. |
| 5 durability | *Class B corruption is answered by named invariants with an owner per change* | **Mis-anchor.** Criterion `C6c` cites *"invariants owned across the sprint"*, again matching no heading. Substance covered by one `[manual]` criterion only. |
| 4 schema-parity | *the forward-only migration framework is preserved with SQLite-native bootstrap detection* | **Real hole with partial substitute.** `MG1`–`MG3` test bootstrap detection and idempotence but are anchored to the **`[tkv]`** requirement *"Migrations are idempotent and ordered"*. Nothing tests "forward-only" as such: no criterion asserts the runner refuses to run a migration whose recorded position is *behind* the file's. |
| **7 data-migration** | ***objects belonging to the target lineage are produced by the lineage and are never imported*** | **Real hole, zero coverage, in my lane.** Short name `NOTMINE` is declared in the acceptance file's short-name table and then **used by no criterion**. Verified: `grep -n "NOTMINE" acceptance.md` returns exactly one hit, the definition row. Its negative control — *"Importing the source's migration rows"*, which would make bootstrap detection mis-decide and a later lineage extension skip or re-apply a migration — has no test at all. |

That last row is the single most consequential traceability finding in this lane and §2 specifies the
tests that close it (`MG-33`, `MG-34`).

**Cross-lane status.** Three of the four sibling lanes had landed by the time this was finished
(`adversarial`, `conformance`, `measurement`) and their §1 scope sections have been read and
reconciled — see §5.4. The **fifth lane is still outstanding**; nine of the twenty
no-`[unit]`/`[prop]` requirements are unclaimed by any landed lane and are listed there. Two further
requirements are claimed by `adversarial` as bare titles with no criterion ids, both of them
requirements whose acceptance criteria are mis-anchored — which is the mis-anchor problem's real
cost: it does not only break the matrix, it stops a lane from claiming work it is actually doing.

### 1.2 Change 7 requirements this lane covers

All 25, by title. Grouped by the test families in §2:

- *the migration reads the source PostgreSQL database and never writes to it*
- *the target database is created by running the SQLite lineage to completion on an empty file before any row is imported*
- *the temporal event log is reconstructed from both source tables and the live version is never dropped*
- *the reconstruction's source preconditions are verified per key rather than inherited from the adapter*
- *a source state the event-log encoding cannot represent is refused, and no target database is produced*
- *checkpoint manifest identifiers are preserved and no generated column is transported*
- *the identifier array is exploded into the junction table and the two I-7 cross-checks hold on the imported data*
- *a source that violates a constraint the target newly adds is refused with a remediation report, and is never quarantined*
- *stored JSON values are transported as the source's own canonical text and never through a JavaScript JSON round trip*
- *timestamps are transported as an exact millisecond integer under pinned session settings*
- *objects belonging to the target lineage are produced by the lineage and are never imported*
- *the export is a single read-only snapshot and the bundle is self-describing*
- *verification is a ladder of five rungs whose pass is their conjunction, and it states what it assumes*
- *point-in-time equivalence is established exhaustively over the breakpoint set*
- *a check with nothing in scope reports n/a and never pass, and the fixtures are proven non-empty*
- *migration-tool failures are tool diagnostics with a stable exit code and a machine-readable report*
- *the stored-value digest and the transport-fidelity comparison are two distinct artifacts and are never conflated*
- *content verification reuses the durability contract's digest regime and introduces no second mechanism*
- *an interrupted migration never leaves a database that presents itself as complete*
- *re-running the migration is safe, and resumability is decided by measurement rather than assumed*
- *the import does not weaken any check in order to go faster*
- *the supported rollback is the untouched source database and no reverse migration is offered*
- *each distribution channel has a written procedure and the container channel's hazards are named*
- *differences that survive a faithful migration are disclosed before the migration runs*
- *no migration duration or throughput figure is asserted, and every PostgreSQL-side claim is labelled*

### 1.3 Change 4 requirements this lane covers (migration-facing subset only)

The rest of change 4 belongs to the schema/type lane.

- *sequence allocation is guarded by a runtime invariant, with uniqueness as defence-in-depth* — source of the Class 2 `008` refusal and of live defect **LD-1**
- *transaction-history reads derive identifiers from entry and cross-check the junction* — invariant I-7, source of the Class 1 lifecycle refusal and of live defect **LD-2**
- *migration 006 replays verbatim, and no future migration adds a STORED generated column to a populated table* — the lineage-before-data constraint
- *domain constraints lost with the PostgreSQL type system are restored as named CHECK constraints* — the 32-byte hash and lifecycle-enum Class 2 members
- *every table is STRICT and a wrong-typed write is rejected, not coerced* — the ISO-string-into-epoch-ms negative control
- *listKeys ordering is code-point order and the one-time resume-cursor reorder is disclosed* — the disclosure whose falsifiability the verifier carries
- *the forward-only migration framework is preserved with SQLite-native bootstrap detection* — the unanchored requirement above; `MG-34` discharges its migration-facing half
- *wallet-tier digest columns are declared under this capability's conventions* — `dg` computed-at-import, never transported

### 1.4 What this lane does not cover

Change 1's driver/worker/pragma internals; change 2's trigger internals and the T3/T5 Lean cut-line
(the temporal lane's); change 3's lease and crash matrix (the concurrency lane's); change 5's digest
algorithm, `verifyIntegrity` and error catalog (the durability lane's); change 6 entirely — the
archive begins with zero rows and has no import step, so the migration's coverage of it is the
assertion that no archive import exists (`N1`).

---

## 2. Test inventory

Type key: **U** unit, **P** property, **I** integration, **C** conformance, **K** crash, **G** CI gate.
Every fixture path is on `/root` (ext4) or in a container volume — never `/tmp`, which is a 32 GB
tmpfs on this host.

### 2.1 The gap-invention failure — the test that catches what everything else misses

This is the flagship. A legal source history can have a hole; `EXCLUDE … WITH &&` forbids overlap and
says nothing about contiguity. Converted through the event log, `LEAD()` closes the hole. Row counts
match. Per-row digests match. Every one of change 2's append-only and strict-increase assertions
holds, because the imported chain *is* well-formed — it is a different function of the query instant,
not a malformed one.

| id | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| **MG-01** | The pre-flight S3 check refuses a gapped key before any write transaction opens. | *a source state the event-log encoding cannot represent is refused…* → `D2`, `D3` | U | Fixture B case `gap-1`: one key, `kv_history` row v1 `[1000,2000)`, `kv_current` v2 `updated_at=3000` | Process exits with the **Class 1** exit code; diagnostic names precondition id `S3`, the `(ns,scope,key)` and both source rows; `fs.existsSync(targetPath) === false` and no `-wal`/`-shm` beside it |
| **MG-02** | **The four blind checks are individually demonstrated blind.** With the S1–S6 pass disabled by a test-only switch, the gapped source imports; then row-count equality, per-row `dg` equality, `PRAGMA integrity_check`, `PRAGMA foreign_key_check` and every change-2 trigger assertion each report **pass**. | *…is refused…* negative-control scenario → `D4`; design §13 E3 | U | same | All five checks return pass **and** the test asserts each one returned pass. A green MG-02 is what proves the other checks cannot substitute for MG-01. If any of the five reports a failure, MG-02 fails — the point is their blindness, not their agreement |
| **MG-03** | On the same imported database, `getAt({at: 2500})` returns **version 1** where the source returned `null`. | same negative-control scenario → `D4` | U | same | `target.getAt({at:2500})` is non-null **and** `source.getAt({at:2500})` is null, asserted in the same run against both live handles. Not against a recorded expectation |
| **MG-04** | The derived intervals are `[1000,3000)` and `[3000,NULL)` — the hole is closed, not preserved as a NULL-valued segment. | design §13 E3 | U | same | `LEAD()`-derived `valid_to` of v1 equals `3000`; no row with a null value exists between them |
| **MG-05** | **V5a catches it independently of the pre-flight pass.** With S1–S6 disabled, the exhaustive replay alone reports a mismatch at instant 2500 and names the key. | *point-in-time equivalence is established exhaustively…* → `H7` | I | same | Verification exits non-zero citing rung **V5a**, key named, instant named. Proves the replay is a second check and not a restatement of S1–S6 |
| **MG-06** | The property generalises: for a random gapped history the pre-flight refuses, and for a random gapless history it admits. | *the reconstruction's source preconditions are verified per key…* | P | `fast-check` generator over version chains with an injected hole at a random position, 200 runs | Refusal iff a hole exists. No false refusal on any gapless chain |

**What a green MG-01…MG-06 proves.** That the only layer able to see gap invention is the pre-flight
pass and the exhaustive replay, that both see it, and that the four checks a reviewer reaches for
first — counts, digests, structural pragmas, trigger assertions — provably do not. Without MG-02 the
suite would assert that MG-01 catches something without establishing that anything else fails to.

### 2.2 Exhaustive point-in-time replay

Change 7 §9.3 establishes the completeness argument: both encodings are piecewise constant in the
query instant; `B` is the union of the source's interval boundaries and the target's `written_at`
values; agreement on `B`, on one interior point of each gap wider than 1 ms, and at one point below
`min(B)` is *equivalent* to agreement at every instant. The domain is discrete because `AsOf.at` is a
millisecond-quantised `Date`.

| id | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| **MG-07** | The probe-set generator emits exactly the specified set: every member of `B`; `b_i + 1` for every consecutive pair with `b_{i+1} − b_i > 1`; `min(B) − 1`. | *point-in-time equivalence…* → `H6` | U | table-driven over hand-written breakpoint sets incl. adjacent-millisecond versions | Set equality against a reference set computed independently in the test, not by calling the generator twice |
| **MG-08** | The **`at`-probe** count is at most `2·|B|`, hence within `2·|B| + 1`. | same → `H6` (corrected, see below) | P | generator over 1…200 versions with random spacing | `atProbes.size <= 2*B.size` for every generated case |
| **MG-09** | The **version-probe** set is exactly `{0} ∪ {1..n} ∪ {n+1}`, size `n + 2`, and `0` and `n+1` both return `null` on both sides. | same → `H6` | U + P | Fixture A keys with 1, 2 and many versions | Exact set equality; both sentinel probes null on source and target |
| **MG-10** | Boundary behaviour: for versions written at 1000/2000/3000 the replay probes at least 999, 1000, 1001, 2000, 2001, 3000, 3001, and at 2000 **both sides return version 2** (source interval half-open, target selects last event at or before). | same, boundary scenario → `H6` | U | Fixture A three-version key | Probe set ⊇ the seven instants; equality of returned version at each |
| **MG-11** | Replay runs over **every key in the fixture**, not a subset, and the harness reports the per-key probe count so the linearity claim is observable. | same | I | Fixture A | `keysProbed === keysInFixture` and the assertion is against the fixture inventory (§4.1), not against a count the harness derived from its own iteration |
| **MG-12** | **Negative control:** a thousand-uniform-random-instants variant misses a 1 ms boundary shift the exhaustive form catches. | same, negative-control scenario → `H8` | U | a key whose target `written_at` is shifted +1 ms from the source boundary | Random variant reports pass in ≥ 95 of 100 seeded runs; exhaustive variant reports fail in 100/100. Both numbers asserted |
| **MG-13** | `get()` replay per key — the probe the `getAt` replay cannot substitute for. | *verification is a ladder of five rungs…* → `H9` | I | Fixture A + Fixture B `collision-1` | For every key `get()` agrees; on the collision fixture the `getAt` replay passes and `get()` fails, both asserted in one run |
| **MG-14** | `listKeys` compared as a **set**, with a **separate** code-point-order assertion on the target. | *…ladder of five rungs…*, *differences that survive a faithful migration…* → `H10`, `K4` | I | Fixture A seeded with `A`, `B`, `a`, `z`, `é`, `Ａ`, `😀` (design §13 E6 key set) | Set equality; target order equals `codePointAt`-sorted order; and a deliberately sequence-comparing variant is shown to **fail** on this correctly migrated fixture |
| **MG-15** | `WalletStateEnvelopeStore.load()` round-trips for every `(walletId, networkId)`. | *checkpoint manifest identifiers are preserved…* → `E4` | I | Fixture A envelopes | Decoded envelope deep-equals source; a single flipped byte in one chunk raises `EnvelopeCorruptError` |
| **MG-16** | `getAll()` per wallet compared **field by field**, with `identifiers` compared **exactly** — order and multiplicity — because it derives from `entry`, transported verbatim. | *the identifier array is exploded into the junction table…* → `E5` | I | Fixture A row with `['a','a','b']` | `["a","a","b"]` returned in that order pre- and post-migration; a set comparison is shown to be strictly weaker by passing on a permuted array |

> **Finding — acceptance criterion `H6` cannot pass as written.** `H6` states *"The V5a probe set has
> size at most `2|B|+1` per key … and covers every breakpoint, one interior instant per gap wider
> than 1 ms, one instant before the earliest, every version in `1..n`, and `0` and `n+1`."* That
> single set cannot satisfy that bound. Measured
> (`node /root/umbradb-tp-trace/probeset.mjs`, output in §4.6):
>
> ```
> n=1, kv_current only @1000             |B|= 1  at= 2  ver= 3  total= 5  bound(2|B|+1)= 3  total<=bound:false
> n=2, contiguous 1000/2000              |B|= 2  at= 4  ver= 4  total= 8  bound(2|B|+1)= 5  total<=bound:false
> n=3, contiguous 1000/2000/3000         |B|= 3  at= 6  ver= 5  total=11  bound(2|B|+1)= 7  total<=bound:false
> n=3, adjacent ms 1000/1001/1002        |B|= 3  at= 4  ver= 5  total= 9  bound(2|B|+1)= 7  total<=bound:false
> n=10 spaced by 1000                    |B|=10  at=20  ver=12  total=32  bound(2|B|+1)=21  total<=bound:false
> ```
>
> The `at`-probe set alone satisfies the bound in every case; the union with the version probes never
> does, for any `n ≥ 1`. Design §9.3 is correct — it states the bound for the `at` probes and
> describes the version probes in a separate paragraph. The acceptance criterion collapsed the two.
> An implementer writing the test as specified either sees it fail on the simplest possible key, or
> silently reinterprets "probe set" to mean the `at` probes and the criterion stops meaning what it
> says. **Recommendation:** split `H6` into `H6a` (`at`-probes ≤ `2|B|+1`, my MG-08) and `H6b`
> (version probes exactly `n+2`, my MG-09). This is a spec-text finding handed back, not a change I
> have made — I have not modified the specs.

### 2.3 Refusal classes 1 and 2, and the quarantine acceptance pair

| id | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| **MG-17** | Each of S1…S6 produces a **distinct** refusal naming its precondition id, the `(ns,scope,key)` and the source rows. Six tests. | *the reconstruction's source preconditions…*, *…is refused…* → `D2` | U ×6 | Fixture B temporal cases | Six distinct precondition ids in six diagnostics; **and** each test asserts the fixture row it seeded is the row named — a refusal for the wrong reason fails |
| **MG-18** | Every Class 1 refusal emits **no** remediation script. | *a source that violates a constraint the target newly adds…* → `M4` | U | Fixture B's 8 Class 1 cases | Report file's `remediation` field is absent (not empty-array); exit code = Class 1 code |
| **MG-19** | Every Class 2 refusal emits a remediation report naming every offending row, the constraint it fails, and **source-side** statements. | same → `M1`, `M3` | U | Fixture B's 4 Class 2 cases | Report contains ≥1 statement per offending row; every statement parses as PostgreSQL DDL/DML; **no** statement targets the SQLite target; exit code = Class 2 code |
| **MG-20** | The remediation statements actually resolve the violation: applied to a **copy** of the source container, the re-export then imports clean. | same | I | Fixture B Class 2 cases, in a throwaway `postgres:17-alpine` container | Second run exits 0 with all five rungs pass. This is what stops the report being decorative |
| **MG-21** | Both classes leave **no file at the target path**, including sidecars. | *…is refused…* → `D3`, `M4` | U ×12 | all Fixture B cases | `readdir(targetDir)` contains no entry matching the target basename or `basename-wal`/`-shm` |
| **MG-22** | The `next_seq > max(seq)` invariant refuses a corrupted counter **that the `008` unique index alone would have admitted** — the pruned-gap case. | change 4 *sequence allocation is guarded by a runtime invariant…* → `M2`, change 4 `SQ4` | U | Fixture B `seq-gap`: store pruned to one manifest at `seq = 34`, `next_seq` corrupted to `5` | Import refuses citing the invariant; and a paired run with the invariant disabled but the unique index present **admits** the row and raises nothing. Both arms asserted in one test |
| **MG-23** | **Negative control — quarantine implemented and shown to report success on a broken database.** A quarantining variant imports conforming rows, sets offending rows aside, exits `0` and reports "migration successful". | same, negative-control scenario → `M6` | U | Fixture B `dup-seq` (two `ckpt_manifests` at one `(w,net,seq)`) | Variant exits `0`; **and** the test then proves the target is not observationally equivalent — `CheckpointStore.history()` on the target omits a manifest the source returned. Both facts asserted. The variant lives in `test/migration/negative-controls/quarantine-variant.ts`, is imported by no production path, and is covered by MG-24 |
| **MG-24** | **The paired assertion:** no quarantine path exists in the shipped tool. | same → `M7` | G | shipped `src/migration/**` | `rg -n "quarantine\|skipped_rows\|rejected_rows" src/migration` returns nothing, **and** the check first asserts its search root exists and contains a known sentinel string, so an empty or moved directory cannot pass it vacuously (see §5.2) |
| **MG-25** | An `entry`/`identifiers`-column disagreement and an `entry`/`lifecycle`-column disagreement are each refused as **Class 1**, with a diagnostic recording that the inconsistency predates the migration. | *a source that violates a constraint…*, change 4 I-7 → `M5` | U ×2 | Fixture B `ident-disagree`, `lifecycle-disagree`, seeded by raw SQL | Class 1 exit code; no remediation; diagnostic contains the pre-existing-inconsistency sentence; and the test asserts the source's own `getAll()` returns the **column's** answer, establishing that the disagreement was invisible before |
| **MG-26** | A version present in both source tables refuses under **S5**, and the diagnostic states that the source's `get()` and `getAt({version:n})` already disagree. | *…is refused…*, collision scenario | U | Fixture B `collision-1` | Refusal under S5; diagnostic asserts both source observations, computed live against the source, not quoted |
| **MG-27** | **Negative control:** an importer applying the source's `priority` tiebreak passes the `getAt` replay and is caught **only** by the `get()` replay. | same, negative-control scenario → `D5` | U | Fixture B `collision-1` | `getAt` replay reports pass; `get()` replay reports fail; row counts and digests report pass. All four asserted |
| **MG-28** | Six failure classes map to six distinct documented exit codes; exit `0` means completed **and** fully verified. | *migration-tool failures are tool diagnostics…* → `Q4`, `Q5` | U + I | one representative per class | Exit codes pairwise distinct and equal to the documented table; a shell-script driver branches on all six with **no** message parsing; the report file alone determines the outcome |
| **MG-29** | No refusal reaches the frozen error catalog. | same → `Q6`, `Q7` | G | repo | `docs/ERROR-CATALOG.md` byte-unchanged; drift test green; code count unchanged; `instanceof StorageError` false for every refusal thrown by the tool |

### 2.4 The two live defects that existing deployments may already violate

Both are confirmed in shipped code in this worktree.

**LD-1 — no `UNIQUE (w, net, seq)` on `ckpt_manifests`.** `src/postgres/migrations/002_checkpoint_store.ts`
creates `ckpt_manifests` with `id bigserial PRIMARY KEY` and a **non-unique** compound index
`ckpt_manifests_lookup ON (w, net, complete, seq DESC)`. There is no unique constraint over
`(w, net, seq)` anywhere in the lineage. Change 4's migration `008` adds one. Every PostgreSQL
deployment in the field is therefore capable of holding a duplicate today.

**LD-2 — `decodeRow` takes `lifecycle` from the JSON and the `lifecycle` column is never compared.**
In `src/postgres/transaction-history-storage.ts`, `decodeRow` builds its candidate with
`identifiers: row.identifiers` (the denormalised **column**) and `lifecycle: stored.lifecycle` (the
**JSONB**). The `lifecycle` column is selected on the read paths and never compared to
`entry.lifecycle.status`. **Additional finding:** `decodeRow`'s own doc comment states
*"`identifiers`/`lifecycle.status` are read from their own denormalized columns"* — which is false of
`lifecycle` in the code directly beneath it. The comment is the reason a reader would not look, and
change 7's disclosure item 2 is right that this migration is the first mechanism that has ever
compared the two representations.

| id | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| **MG-30** | A field-shaped source — seeded **only through the 0.9.5 public API** — can be driven into a duplicate `(w, net, seq)` state, or, if it cannot, that fact is recorded with the mechanism that prevents it. | change 4 *sequence allocation is guarded…* | I | dedicated `postgres:17-alpine` container running the 0.9.5 `PgCheckpointStore` | Either (a) a public-API sequence exists that produces the duplicate, and it is recorded, or (b) the test records `n/a — not reachable through the public API` and the Class 2 fixture is explicitly marked as raw-SQL-seeded. **Never** silently assumed unreachable |
| **MG-31** | A source with a duplicate `(w, net, seq)` is refused as Class 2 with remediation, and the remediation is applied and re-exported successfully. | *a source that violates a constraint…* → `M1` | I | Fixture B `dup-seq` | As MG-19 + MG-20 |
| **MG-32** | A source with `lifecycle` column ≠ `entry.lifecycle.status` is refused as Class 1; and a companion assertion shows the **source's** `getAll()` returns the JSON's value, so no consumer-visible value changes — only its visibility. | *…newly adds…*, *differences that survive a faithful migration…* → `M5`, `K4` | I | Fixture B `lifecycle-disagree` | Refusal is Class 1; source `getAll().lifecycle.status` equals `entry.lifecycle.status`, **not** the column. This is what makes disclosure item 2's "visibility change, not value change" framing falsifiable rather than asserted |

### 2.5 The unanchored requirement — `NOTMINE`

| id | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| **MG-33** | The importer imports **no** `_migrations` row and **no** `<schema>_writer_generation` row. The target's `<schema>_migrations` contains exactly the SQLite lineage `000…009` and nothing else; `<schema>_writer_generation` holds exactly one row, `id = 1`, `generation = 0`, written by migration `007`. | *objects belonging to the target lineage are produced by the lineage and are never imported* — **currently discharged by no criterion** | U | Fixture A (whose source `_migrations` names PostgreSQL migrations `001…006`) | Target `_migrations` name-set equals the SQLite lineage name-set exactly; no source migration name appears; writer-generation row count `= 1` with the seeded values |
| **MG-34** | **Negative control:** an importer that copies `_migrations` makes bootstrap detection mis-decide, and the next lineage extension either skips a migration or re-applies one. | same, negative-control scenario — **currently untested** | U | Fixture A + a synthetic migration `010` | With the source rows copied, running the extended lineage either applies zero migrations (skip) or fails with an `already exists` error on `010`'s first non-idempotent statement (re-apply). One of the two occurs and the test asserts **which**; with the rows not copied, `010` applies cleanly |
| **MG-35** | V3 excludes `<schema>_migrations` and `<schema>_writer_generation` from cardinality comparison entirely — not "compares and tolerates". | *verification is a ladder…* → `H3` | U | Fixture A | The cardinality report contains no entry for either table; a variant that includes them is shown to fail on a correct migration |

`MG-34` also closes the migration-facing half of change 4's other unanchored requirement,
*the forward-only migration framework is preserved with SQLite-native bootstrap detection*.

### 2.6 Transport fidelity, bundle, and the two artifacts

| id | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| **MG-36** | No `JSON.parse` on any transported value: static check over the export and import paths. | *stored JSON values are transported…* → `F1` | G | `src/migration/**` | `rg` returns nothing, with the non-vacuity guard of §5.2 |
| **MG-37** | `{"fees": 12345678901234567890123, "ratio": 0.1000000000000000055511151231257827}` survives byte-for-byte, asserted against `jsonb::text` from the live source. | same → `F2` | I | Fixture A numeric-hazard key | Target's stored bytes `===` the source's `jsonb::text` bytes |
| **MG-38** | **Negative control:** the same value through `JSON.parse`/`JSON.stringify` becomes `{"fees":1.2345678901234568e+22,"ratio":0.1}`, and **none** of a row count, a digest taken after the round trip, or a parsed-value replay detects it. | same, negative-control scenario → `F3`; design §13 E5 | U | same value, no database needed for the round trip | Transformed text asserted exactly; and all three detectors asserted to report pass on the corrupted database |
| **MG-39** | `dg` is computed over the stored bytes with **no canonicalisation**, is persisted, and equals the digest the adapter computes on the read path. | *the stored-value digest and the transport-fidelity comparison…* → `F4`, `F4c` | U | Fixture A jsonb values with `jsonb`-style spacing | Import-time `dg` equals read-path `dg` byte-for-byte for every covered row |
| **MG-40** | The transport-fidelity comparison operates on **canonically parsed** values, is not persisted, and is not called a digest. | same → `F4` | U + G | Fixture A | A value whose `jsonb` rendering differs from `JSON.stringify` only in whitespace compares **equal** under the transport check and **unequal** under a naive byte comparison; no column stores the comparison; a grep confirms no identifier in the transport path is named `*digest*` |
| **MG-41** | **Negative control:** a canonicalising `dg` gives two whitespace-differing byte-sequences the same digest. | same, negative-control scenario → `F4d` | U | two hand-built byte-sequences | Canonicalising variant produces equal digests; shipped variant produces unequal. Both asserted |
| **MG-42** | A `NULL` `dg` on any covered row after import **fails** verification. | *content verification reuses the durability contract's digest regime…* → `H16` | U | Fixture A with one `dg` nulled post-import | Verification exits non-zero naming table and rowid |
| **MG-43** | A known instant exports to exact epoch milliseconds, asserted with `===` not a tolerance; the bundle records `server_version_num`; an uncovered server version is refused. | *timestamps are transported as an exact millisecond integer…* → `F5` | I | Fixture A watermark with a pinned `updated_at` | Exact integer equality; bundle manifest carries `server_version_num`; a bundle stamped with an uncovered version is refused before the write transaction opens |
| **MG-44** | Sub-millisecond truncation on `ckpt_*.created_at` and `watermarks.updated_at` is **recorded in the bundle manifest**, not performed silently. | same → `F7` | U | Fixture A | Manifest contains a truncation record naming both columns and the count of affected rows; the count is non-zero and matches an independent query |
| **MG-45** | The whole export runs in one `REPEATABLE READ READ ONLY` transaction; two exports of an unchanged Fixture A are byte-identical. | *the export is a single read-only snapshot…* → `G1` | I | Fixture A | Isolation level read back from `pg_stat_activity` during the export equals `repeatable read`; bundle bytes identical |
| **MG-46** | Truncating a data file, deleting a data file, corrupting one byte, and editing one manifest row count each refuse with a non-zero exit and no file at the target path. Four tests. | same → `G3` | U ×4 | Fixture A bundle, mutated | Four distinct bundle-integrity refusals; target path empty in all four |
| **MG-47** | The source is byte-identical after a complete export **and** after an export killed mid-stream. | *the migration reads the source PostgreSQL database and never writes to it* → `A2` | I + K | Fixture A container | Per-table row counts and content digests unchanged; `pg_class` relation list unchanged; asserted for both the clean and the killed run |
| **MG-48** | Every shipped export `.sql` contains only `SET`, `BEGIN`, `SELECT`, `COPY … TO`, `COMMIT`, `ROLLBACK`, and the check **fails the build** on anything else. | same → `A1`, `A3` | G | `src/migration/sql/**` | A planted `INSERT INTO progress …` variant fails the check and the failure message states the rollback-property reason |
| **MG-49** | Export ordering is `COLLATE "C"` on every text-keyed table and the resulting order equals the target's `BINARY` order element by element on the E6 key set. | *content verification reuses…* → `G5` | I | Fixture A E6 key set | Element-wise order equality; and a variant ordering by the database's `lc_collate` is shown to differ |

### 2.7 Lineage-before-data, atomicity, re-run, no-weakening

| id | Asserts | Discharges | Type | Fixture | Pass condition |
|---|---|---|---|---|---|
| **MG-50** | Migration `006` applies during import — possible only on a zero-row `ckpt_chunks`. | *the target database is created by running the SQLite lineage to completion…* → `B1` | U | empty target | `006` recorded in `<schema>_migrations`; `size_bytes` present as `STORED` |
| **MG-51** | A schema dump of a freshly imported database is byte-identical to a greenfield dump at the same lineage position. | same → `B2` | U | greenfield + imported | `sqlite_schema` sql-text multiset equality after prefix normalisation |
| **MG-52** | **Negative control:** an importer creating the chunk table itself and loading rows before the lineage fails at `006` with `cannot add a STORED column`. | same, negative-control scenario → `B4` | U | planted variant | Exact error text asserted |
| **MG-53** | Killing the importer at **ten** different points leaves no file at the target path in all ten runs. | *an interrupted migration never leaves a database…* → `J1` | K ×10 | Fixture A, `/root/umbradb-mig-crash/` (ext4) | Ten SIGKILLs at ten instrumented points; target path absent in all ten; **and** each run asserts it reached its intended point before the kill, so a kill landing before any work does not pass vacuously |
| **MG-54** | **Negative control:** renaming before checkpoint-and-close produces a database missing its most recent commits while `integrity_check` reports `ok`. | same → `J2` | K | planted variant | Post-rename row count strictly less than pre-rename; `integrity_check` = `ok`. Both asserted |
| **MG-55** | Importing the same bundle twice into two paths yields equal per-table content digests. | *re-running the migration is safe…* → `J3` | I + P | Fixture A | Digest equality for every table; only file-level artifacts differ |
| **MG-56** | No imported value derives from the wall clock. | same → `C6` | G | `src/migration/**` | `rg "Date\.now\|new Date\(\|unixepoch"` finds nothing outside logging, with the §5.2 non-vacuity guard |
| **MG-57** | **Negative control:** a resume protocol that inspects the target to decide what to skip leaves a key interrupted mid-chain silently truncated while every isolated check on that key passes. | same, negative-control scenario → `J4` | U | planted variant, Fixture A | Truncated key present with fewer versions; per-key cardinality check against the **bundle** catches it, per-key checks against the target alone do not. Both asserted |
| **MG-58** | The importer never lowers `synchronous`, never sets `foreign_keys = OFF`, never sets `ignore_check_constraints`, never drops or defers a trigger, and never issues `INSERT OR REPLACE`/`REPLACE INTO`. | *the import does not weaken any check in order to go faster* → `J6` | G | `src/migration/**` | Static check; §5.2 guard |
| **MG-59** | A deliberately introduced `INSERT OR REPLACE` in the importer **fails the build** under change 2's automated guard — proving the importer is inside that guard's scope. | same → `J7` | G | planted variant | Build fails, and the failure names change 2's guard, not a generic lint |
| **MG-60** | **Negative control:** importing with `foreign_keys = OFF` and one chunk omitted produces a dangling junction row that `integrity_check` reports as `ok` and only `foreign_key_check` names. | *checkpoint manifest identifiers are preserved…* → `E3`; design §13 E4 | U | planted variant | `integrity_check` = `ok`; `foreign_key_check` non-empty. Both asserted, which is why V2 requires both |
| **MG-61** | Manifest ids are preserved and a post-import `save()` allocates an id strictly greater than every imported id, with no manual `sqlite_sequence` seeding. | same → `E1`; design §13 E1 | U | Fixture A manifests with ids `7, 3, 91` | `sqlite_sequence` = 91; next id = 92; no collision |
| **MG-62** | **Negative control:** a single whole-file import transaction trips change 5's long-held-transaction diagnostic. | *…go faster*, negative-control scenario → `J9` | I | planted variant, Fixture A | Diagnostic fires; and the test records that the premise is **conditional on the descriptor precondition** (below) |
| **MG-63** | The write-lock premise is reported as **absent, not weakened**, when any descriptor on the target or its `-wal`/`-shm` is opened and closed. | same, void-not-degraded scenario → `Q8` | I | Fixture A + an in-process open/close of `-shm` | The tool's own exclusivity report changes state to `absent`; the string "absent, not weakened" appears in the spec text (grep) **and** the runtime report distinguishes the two states. A report that only degrades a confidence level fails |

---

## 3. Negative controls

Fifteen, all listed above; here is how each is planted without shipping it, and what its failure
proves. The governing rule for this lane: **a negative control lives in
`test/migration/negative-controls/`, is imported by test files only, and every one of them is paired
with a CI assertion that it is absent from `src/`.** The planting mechanism is a
`MigrationBehaviourOverrides` object the production entry point does not accept — the variants are
constructed by the test, not toggled by a flag the shipped binary can see.

| Control | What it plants | How planted | What its failure proves |
|---|---|---|---|
| MG-02/03/04 gap manufacture | S1–S6 pre-flight disabled | test-only override; `MG-24`-style grep asserts no disable switch in `src/` | That counts, digests, structural pragmas and every change-2 trigger assertion are **all** blind to gap invention, so MG-01 is not redundant with any of them |
| MG-12 sampled replay | 1,000 uniform-random instants per key | alternate probe generator in the test tree | That sampling misses a 1 ms boundary shift — the shape a version-ordering or truncation defect produces |
| MG-23 quarantine | full quarantine implementation | `test/migration/negative-controls/quarantine-variant.ts` | That quarantine reports success on a non-equivalent database. Paired with MG-24 it converts change 4 §17.4's ruling from a preference into a constraint |
| MG-27 priority tiebreak | source's history-wins resolution applied at import | test-only importer variant | That the `getAt` replay, row counts and digests all pass while `get()` returns a different value |
| MG-34 `_migrations` copied | importer copies source `_migrations` | test-only override | That bootstrap detection mis-decides and the next lineage extension skips or re-applies. **This control does not exist today** |
| MG-38 JS round trip | `JSON.parse`/`JSON.stringify` in the transport path | pure-function test, no database | That two stored numbers are permanently destroyed at rest with no detector firing |
| MG-41 canonicalising `dg` | digest over normalised JSON | test-only digest variant | That the digest stops detecting the corruption it exists for |
| MG-52 rows before lineage | chunk table created by the importer | test-only importer variant | That `006` fails with `cannot add a STORED column`, and that the `VIRTUAL` "fix" produces a schema differing from every greenfield database |
| MG-54 rename before checkpoint | rename precedes checkpoint-and-close | test-only publication variant | That the published database silently reverts to an older state while `integrity_check` says `ok` |
| MG-57 target-inspecting resume | resume reads target to decide skips | test-only resume variant | That a key interrupted mid-chain is silently truncated while every isolated check on it passes |
| MG-59 `INSERT OR REPLACE` | one statement rewritten | source-tree mutation reverted by the test harness | That the importer is inside change 2's automated ban's scope — the guard's *reach*, not its existence |
| MG-60 `foreign_keys = OFF` | pragma off, one chunk omitted | test-only override | That `integrity_check` reports `ok` on a dangling reference and only `foreign_key_check` names it |
| MG-62 whole-file transaction | entire import in one transaction | test-only override | That it trips the long-held-transaction diagnostic and buys atomicity already provided more cheaply |
| MG-22 (arm 2) index-without-invariant | `008` unique index present, runtime invariant absent | test-only override | That the constraint alone does not close the pruned-gap case — change 4 §17.3(b) |
| MG-14 (arm 2) sequence-compared `listKeys` | ordered comparison instead of set | alternate comparator in the test | That a sequence comparison fails on a **correctly** migrated database |

**The trap this lane must not fall into.** A negative control that goes red for the wrong reason
proves nothing. Every control above asserts its **specific failure signature** — an exact error
string, an exact returned version, an exact count relationship — never merely `expect(fn).toThrow()`.
A planted variant that fails to compile, or throws a `TypeError` before reaching the behaviour under
test, must fail the control, not satisfy it.

---

## 4. Fixtures and harnesses

### 4.1 Fixture A — faithful

**Shape.** Seeded **only through the 0.9.5 public API** — `PgTemporalKV.put`,
`PgCheckpointStore.save`, `PgWatermarks.set`, `PgTransactionHistoryStorage`,
`PgWalletStateEnvelopeStore.save` — never raw SQL, so the state is one a real consumer could have.
Contents, with volumes:

- **TemporalKV**: 500 keys across 3 `(ns, scope)` pairs. Version distribution: 200 keys × 1 version,
  200 × 2, 90 × 3–10, 10 × 100–500 versions (the linearity claim needs a long chain). At least one
  key with two versions in **adjacent milliseconds** and one pair spaced > 1 s, so both branches of
  the interior-probe rule are exercised.
- **Numeric-hazard key**: value `{"fees": 12345678901234567890123, "ratio": 0.1000000000000000055511151231257827}`.
- **Unicode key set**: `A`, `B`, `a`, `z`, `é`, `Ａ`, `😀` plus one supplementary-plane key and one
  in `U+E000–U+FFFF` (design §13 E6 + change 4 `L6`).
- **CheckpointStore**: 40 manifests over 4 `(w, net)` pairs; non-contiguous ids (`7, 3, 91` among
  them); one manifest referencing **one chunk hash at two positions**; one chunk shared by two
  manifests; ≥ 1 manifest with > 16,383 chunks (change 4 `B2`'s bound, so the import path is
  exercised past the old bind-parameter cap).
- **TransactionHistory**: 300 rows over 5 wallets; one with `identifiers = ['a','a','b']`; one with
  an empty array; one of each `lifecycle` enum value.
- **Watermarks**: one per `(w, net)`, with a sub-millisecond `now()`-derived `updated_at`.
- **Envelope**: ≥ 2 `(walletId, networkId)` pairs.

**Non-emptiness.** A checked-in `fixture-a.inventory.json` records the expected count of every
category above. `MG-11` and the ladder's per-rung scope reporting assert against the inventory, and
the suite fails if any category is short. This is the only mechanism distinguishing "everything
checked out" from "there was nothing to check".

**Host.** `@testcontainers/postgresql` with `postgres:17-alpine`. Verified present locally:

```
$ wsl -e bash -lc 'docker images --format "{{.Repository}}:{{.Tag}}"'
postgres:17-alpine
postgres:16-alpine
testcontainers/ryuk:0.14.0
```

Container data directory must be a Docker volume, **not** the container writable layer and **not**
tmpfs, for the same reason `/tmp` is banned here — and the plan must assert it, because a tmpfs-backed
container volume would silently reproduce the 233× error class on the export side.

### 4.2 Fixture B — adversarial, twelve cases

Seeded by **raw SQL** because the states are unreachable through the public API. Six Class 1
temporal, two Class 1 transaction-history, four Class 2:

| case | class | state |
|---|---|---|
| `gap-1` | 1 | history `[1000,2000)`, current at 3000 — the S3 hole |
| `collision-1` | 1 | a `kv_history` row and `kv_current` at the same `version` (S5) |
| `nondense-1` | 1 | versions `1, 3` in history with current at `4` (S2) |
| `orphan-hist-1` | 1 | `kv_history` rows for a key with no `kv_current` (S1) |
| `nonmono-1` | 1 | `valid_from` non-increasing (S4) |
| `submilli-1` | 1 | a timestamp with sub-millisecond precision in `kv_history.valid_from` (S6) |
| `ident-disagree` | 1 | `identifiers` column disagrees with `entry.identifiers` |
| `lifecycle-disagree` | 1 | `lifecycle` column disagrees with `entry.lifecycle.status` — **LD-2** |
| `dup-seq` | 2 | two `ckpt_manifests` at one `(w, net, seq)` — **LD-1** |
| `seq-gap` | 2 | pruned to one manifest at `seq = 34`, `next_seq` corrupted to `5` |
| `short-hash` | 2 | a 31-byte `manifest_hash` |
| `bad-lifecycle` | 2 | `lifecycle = 'bogus'` |

Each case asserts: a refusal naming its precondition or constraint; the **correct class**; presence
(Class 2) or absence (Class 1) of a remediation report; and **no target database**. Twelve distinct
refusals, twelve absence assertions.

### 4.3 The replay harness

A standalone module, not a test file, so both the shipped verifier and the test suite use the same
code path:

```
buildProbeSet(sourceBoundaries: number[], targetWrittenAt: number[], n: number)
  -> { atProbes: Set<number>, versionProbes: Set<number> }
```

Two sets, deliberately not one — see the `H6` finding in §2.2. The harness takes two live handles
(source `PgTemporalKV`, target `SqliteTemporalKV`) and returns a per-key report:
`{ key, probeCount, mismatches: [{ instant, sourceAnswer, targetAnswer }] }`. It reports
`n/a — no rows in scope` for a key set of size zero and **never** `pass`.

A reference implementation of `buildProbeSet` and the measurement behind the `H6` finding is at
`/root/umbradb-tp-trace/probeset.mjs`.

### 4.4 The crash harness

Reuse `test/integration/crash/crash-harness.smoke.test.ts`'s worker pattern rather than build a new
one. Ten instrumented kill points for `MG-53`: after lineage `000`; after `009`; after the first
chunk batch; mid chunk batch; after manifests; after junction rows; after the first `kv_event` batch;
mid `kv_event` batch for a multi-version key; after the ladder's V4; after checkpoint-and-close but
**before** the rename. All target files under `/root/umbradb-mig-crash/` (ext4). A CI assertion
reads `df -T` for that directory and fails if the type is `tmpfs`, `ramfs` or `overlay`.

### 4.5 What is missing today

- `node_modules` does not exist in the worktree (`ls -d /root/UDB-sqlite-sprint/node_modules` →
  `No such file or directory`) and `npm install` is forbidden by the brief. **No test in this plan
  can be executed today.** Every pass condition above is a specification, not a result.
- `better-sqlite3@13.0.2` is unpacked at `/tmp/l3-bs3b`. Loading the module from a RAM disk is
  harmless; **creating a database file there is not**. Any harness that resolves the binding from
  `/tmp` must still place every database file under `/root`.

### 4.6 Commands run for this plan

```
$ wsl -e bash -lc 'python3 /root/umbradb-tp-trace/final2.py'      # requirement/criterion resolution
$ wsl -e bash -lc 'python3 /root/umbradb-tp-trace/stats.py'       # tag distribution, manual-only, blocked
$ wsl -e bash -lc 'node /root/umbradb-tp-trace/probeset.mjs'      # the H6 arithmetic, measured
$ wsl -e bash -lc 'grep -n "NOTMINE" .../v1.0.0-sqlite-data-migration/acceptance.md'   # one hit: the definition row
$ wsl -e bash -lc 'ss -ltnp | grep :5432'                         # a live PostgreSQL 18.4 IS on this host
$ wsl -e bash -lc 'docker images --format "{{.Repository}}:{{.Tag}}"'                  # postgres:17-alpine present
```

Nothing in this plan has been executed as a test. Every "measured" claim above is one of the six
commands in this block; everything else is specification.

---

## 5. What cannot be tested, and the nearest achievable substitute

### 5.1 The PostgreSQL side — and a correction to the change's own premise

Change 7's `NONUMBERS` requirement and design §0.2 state that *"no PostgreSQL server was run for this
capability, and there is none on the authoring machine."* **That is false on this host today:**

```
$ wsl -e bash -lc 'ss -ltnp | grep :5432'
LISTEN 0 200 127.0.0.1:5432 0.0.0.0:* users:(("postgres",pid=292,fd=6))
$ psql -tAc 'select version()'
PostgreSQL 18.4 (Ubuntu 18.4-0ubuntu0.26.04.1) on x86_64-pc-linux-gnu … 64-bit   [server_version_num 180004]
```

Three consequences, stated carefully:

1. **That server is not the fixture and must not be used as one.** It is a shared instance
   (systemd `postgresql.service`, up 8 h). The migration reads-only, but Fixture B requires raw-SQL
   seeding of corrupt states, and Fixture A requires a controlled empty start. Both need a
   **disposable** container.
2. **The fixture is buildable today.** `@testcontainers/postgresql` is already a devDependency and
   `postgres:17-alpine` is already pulled. Nothing about the Postgres side is architecturally
   unmeasurable; it is unmeasured because `npm install` is unavailable in this worktree.
3. **Criterion `L5` should be re-graded, not merely re-run.** `L5` requires every PostgreSQL-behaviour
   statement to carry `[code]` with a `file:line` or `[inference]` and to be *not* presented as
   measured. That remains correct as a floor. But several inferences in change 7 — the `BEFORE UPDATE`
   trigger's single-`now_ts` behaviour, the `priority` tiebreak's effect on `get()` vs
   `getAt({version})`, the `jsonb::text` rendering, the `lc_collate` ordering — are **cheaply
   convertible from inference to measurement** with a throwaway container. Doing so is the highest
   value-per-hour item in this lane, because §4.1's whole correctness argument (S3 ⇒ Law T3) rests on
   trigger behaviour that has never been observed in this repository.

Until that happens, the honest statement is: **every PostgreSQL-side claim in change 7 is currently
inference from cited code, and this plan's Fixture A/B tests are unexecuted specifications.** No
criterion in section A, E, F or G of change 7's acceptance file has been run.

Also note: the host's `server_version_num` is `180004`, outside the `postgres:17-alpine` fixture's
coverage. Under the `TIME` requirement the tool must **refuse** a bundle from it. That is a free,
concrete test case for `MG-43` and it should be added rather than treated as an obstacle.

### 5.2 Vacuous passes — the ones this suite could add

Five vacuous-pass instances were found in the specs. The test suite is at risk of adding more, in
three families:

**(a) Negative greps over a directory that does not exist.** Change 7 has **twenty** criteria of the
form "grep returns nothing": `A1`, `A4`, `C2`, `C6`, `F1`, `F4b`, `J6`, `J7`, `M7`, `N2`, `N6`, `N9`,
`R1`, `R2`, `R3`, `K4b`, `H13`, `H14`, `Q6`, `Q8`. Every one of them passes trivially before
`src/migration/` exists, and passes trivially again if the directory is later renamed. **Required
guard, applied to all twenty:** each check first asserts (i) its search root exists, (ii) the root
contains at least N files, N pinned in a checked-in manifest, and (iii) a **positive sentinel** — a
known string that *must* be found — is found. Only then is the negative assertion meaningful. Without
(iii) the grep is testing the filesystem, not the code.

**(b) Zero-row and empty-scope states.** `E2` (`foreign_key_check` returns empty) passes on an empty
database. `MG-11`'s per-key replay passes on a fixture with zero keys. `G5`'s collation-order equality
passes on a single-element key set. All are handled by the fixture-inventory assertion (§4.1) plus the
`NASCOPE` rule — but note the rule has its own hole: an overall pass **is** permitted when an `n/a`
rung records that the empty scope was expected. A fixture that shrinks to zero in a category marked
"expected empty" would therefore still go green. **Required guard:** the "expected empty" allowance is
per-tier and checked in, and Fixture A is declared to have **no** expected-empty tier. Only a real
consumer database may use the allowance.

**(c) A negative control that fails for the wrong reason.** Covered in §3.

**(d) A new one, specific to this lane: `MG-53`'s ten kill points.** "No file at the target path"
passes trivially if the kill lands before the importer creates anything. Each of the ten runs must
assert it **reached its instrumented point** — via a marker written outside the target directory —
before the absence assertion is admissible.

### 5.3 Criteria that are only human-checkable today, and what to do about them

**93 criteria are tagged `[manual]` and nothing else**; 243 carry no `[unit]`/`[prop]`/`[CI]` at all.
Distribution of the manual-only set: change 5 (23), change 3 (20), change 6 (18), change 7 (15),
change 1 (7), change 2 (6), change 4 (4).

Automatable now, with the mechanism:

| Criterion | Currently | Automatable as | Mechanism |
|---|---|---|---|
| change 5 `P2` — no criterion assumes `enableDefensive`, `setAuthorizer`, a session extension, an `interrupt` entry or a VFS hook; each verified absent from the ruled binding's prototype | `[manual]` | `[unit]` | Literally `assert(!('interrupt' in Database.prototype))` ×5. This is the clearest single case in the sprint of a manual tag on a one-line assertion |
| change 7 `K2` — the notes state UmbraDB publishes no container image, backed by a recorded command | `[doc][manual]` | `[CI]` | `rg --files -g 'Dockerfile*' -g 'docker-compose*' -g '*.dockerfile'` plus a workflow scan for image-publish steps; fails if any appears |
| change 7 `L5` — every PostgreSQL-behaviour statement carries `[code]` `file:line` or `[inference]` | `[manual]` | `[CI]` | A linter over the change directory: every sentence containing a PostgreSQL-behaviour marker must carry a tag; every `file:line` must resolve **and** the cited line must still contain the cited token. This is the anti-mis-anchor tool and it would also have caught the two mis-anchors in §1.1 |
| change 7 `R4`, `Q10`, `P1`–`P5` — "the obligation is recorded in this change's `tasks.md`, task 0.4c" | `[manual]` | `[CI]` | Assert the named task id exists in `tasks.md` and its body contains the required tokens. Turns a handover from a promise into a gate — which is the mechanism that stops the I-4 failure recurring |
| change 7 `K1` — a reviewer executes the clone procedure end to end from the written text alone | `[manual]` | `[manual]` + `[CI]` | Split it: extract every fenced shell block from the migration notes and execute them in order in a clean container (CI); keep "from the written text alone, without asking the author" as the manual residue. The commands stop rotting; the comprehension check stays human |
| change 1 `P1`, change 4 `P2`, change 6 `P4` — the measurement gate's identity, `df -hT` showing not tmpfs | `[manual]` | `[CI]` | A gate job that reads `df -T` for the harness path and fails on `tmpfs`/`ramfs`/`overlay`. The brief already requires this assertion; it should replace the manual tag, not sit beside it |
| change 5 `E0`–`E11` (backup primitive, 15 criteria, no `[unit]`/`[prop]`) | `[CI][doc][manual]` | partly `[unit]` | The *decision* is blocked on B-6, but "the measurement artifact exists, is schema-valid, and contains the named cells" is a file assertion. Gate on artifact shape now; gate on the choice when B-6 closes |
| change 7 `N1`–`N8` (non-goal criteria) | `[manual]` | `[CI]` | Each is a negative grep over the change directory. Same non-vacuity guard as §5.2(a) |

Genuinely not automatable, and correctly left manual:

- change 7 `P1` — re-running design §13's measurements on `better-sqlite3@13.0.2` and judging whether
  a divergence is blocking. The re-run is mechanical; the *judgement* is not.
- change 7 `P2` — the owner's container-image inventory answer. Nobody but the owner has it.
- change 7 `K4c` — both disclosure items framed as consequences of stricter invariants rather than as
  regressions. Framing is not machine-checkable and pretending otherwise would produce a keyword test
  that a bad rewrite passes.
- change 5 `I1`, `I2` — every external precedent citation re-verified. A link checker proves the URL
  resolves, not that it says what was claimed.

### 5.4 Requirements with no executable criterion in any lane — cross-checked against three of four

**Status.** Three sibling lanes landed while this plan was being written and have been read:
`adversarial.md`, `conformance.md`, `measurement.md`. The **fifth lane has not landed**, so every
"unclaimed" verdict below is provisional against that one plan only. What the three landed lanes
claim, by their own §1 scope sections:

- **`measurement`** owns change 1's *every performance-dependent decision is blocked on measurements
  taken on a real filesystem…* and *the decisions blocked on the measurement gate are named…* in
  full, plus the B-1…B-8 experiments E-01…E-08. It **removes** the second of these from my no-`[unit]`
  list: its M-12 makes every register row a CI-gated object.
- **`conformance`** owns change 2's five Laws (T1–T5) and change 5's *the verification pass runs the
  structural check, the digest sweep, the schema digest and the invariants together, and never
  refuses* (the invariants part) and *Class B corruption is answered by named invariants with an
  owner per change* (C6b, C6c). It **closes** the second of my two durability mis-anchors as a
  coverage question — the anchor is still unresolvable, but a lane is testing the substance.
- **`adversarial`** owns the negative-control column of change 7's acceptance table outright —
  `A3, B4, C3, C4, D4, D5, E3, E9, M6, F3, F4d, F6, G4, H8, J2, J4, J9, Q2, Q7` — plus one control
  each for 9 of my 20 no-`[unit]` requirements.

**The lane boundary with `adversarial`, stated so neither of us assumes the other did it.** They own
the *planting taxonomy* and the arm that must fail; I own the *positive* migration path, the
**pairing** assertions that make a control mean something, and the fixtures both depend on.
Concretely: `MG-23` (quarantine implemented and reporting success) is their `M6`; `MG-24` (quarantine
absent from the shipped tool) is mine and is what converts their control from a demonstration into a
constraint. Same shape for `MG-02` ↔ `D4`, `MG-27` ↔ `D5`, `MG-38` ↔ `F3`. **Neither half is
sufficient alone** and neither lane's plan should be merged without the other's.

Every one of the 168 requirements has **at least one** criterion carrying `[unit]`, `[prop]` or
`[CI]`. The gap is narrower and sharper than "untested": it is the **20 requirements with no
`[unit]`/`[prop]` criterion**, i.e. whose only mechanisation is a CI grep or a doc check. A grep
proves a string is absent; it does not prove a behaviour.

**Of those 20, nine are unclaimed by any landed lane** and are the fleet's residual gap: change 4
*schema emulation SHALL NOT be implemented as one database file per schema*; change 4 *every
performance-dependent property is stated as an obligation to measure, not as a number*; change 5
*the stability policy binds the situation-to-code mapping and bounds additive-only*; change 5 *the
release record prices every break as pre-tag and post-tag*; change 5 *the known verification gaps
are recorded in the catalog rather than left for a green gate to hide*; change 6 *the uncovered
projection tables have a written rebuild path with an executed transcript*; change 6 *the archive
sync entry point remains coherent across typecheck, build and run*; and change 7's *the supported
rollback is the untouched source database…* and *each distribution channel has a written
procedure…*, both of which are mine and are specified in the table below.

**Two further requirements are claimed by `adversarial` with no criterion id attached** — *the
archive's bounded delete is written in the form that needs no optional compile option* and *the lease
limitation stated in writing is exactly what the mechanism delivers*. Both are listed in that lane's
scope as bare titles while every neighbouring entry names criteria. The first is the same requirement
my §1.1 identified as a mis-anchor: the acceptance criteria that cover it (`P5`, `W9`) cite a
paraphrase, so a lane reading the acceptance file cannot find them by title. **This is the
mis-anchor's second-order cost — it does not merely break traceability, it makes a lane unable to
claim the criteria it is in fact covering.**

| Change | Requirement (title) | Only-mechanisation | Nearest achievable executable substitute |
|---|---|---|---|
| 1 | *the storage engine is an embedded SQLite database reached through a version-pinned, gate-observable binding* | `[CI][doc][manual]` | A unit test asserting runtime `sqlite_version()` equals the pinned value and that the five absent prototype members are absent |
| 1 | *the decisions blocked on the measurement gate are named, and none of them is settled by this change* | `[doc]` only | A parser over the B-register asserting each row names an owner and a required datum, and that no requirement text in the sprint states a value for an open B-row |
| 1 | *the conformance suite is re-executed against the new engine rather than amended to suit it* | `[CI][doc][manual]` | A CI diff asserting the property **texts** are byte-unchanged from the PostgreSQL run apart from fixture wiring — mechanisable, and stronger than a reviewer's word |
| 3 | *the lease limitation stated in writing is exactly what the mechanism delivers* | `[CI][doc][manual]` | A doc test extracting the stated limitation and a unit test demonstrating exactly that boundary, both failing if they diverge |
| 4 | *schema emulation SHALL NOT be implemented as one database file per schema* | `[doc]` only | A unit test asserting `SQLITE_MAX_ATTACHED = 10` and that a cross-`ATTACH` `REFERENCES` is a syntax error — the two measured grounds, currently only written down |
| 4 | *every performance-dependent property is stated as an obligation to measure, not as a number* | `[doc][manual]` | A linter: any numeral with a throughput/latency unit in the change directory must be inside a decision rule naming the gate, or inside the evidence section |
| 5 | *the integrity boundary is disclosed using the two-case wording, in every channel a consumer reads* | `[CI][doc]` | A doc test asserting the exact two-case wording appears in each named channel — already close; the gap is that "every channel" is not enumerated machine-readably |
| 5 | *the backup primitive is established by measurement on the ruled binding, not asserted* | 15 criteria, no `[unit]`/`[prop]` | Artifact-shape assertion now; behaviour test when B-6 closes |
| 5 | *the stability policy binds the situation-to-code mapping and bounds additive-only* | `[CI][doc]` | A test that adds a code and asserts the drift gate goes red; a test that narrows a retryability marking and asserts the same. Policy enforcement is testable; policy prose is not |
| 5 | *the release record prices every break as pre-tag and post-tag* | `[doc][manual]` | Schema-check the release record: every break entry carries both prices |
| 5 | *every engine-named contract sentence is re-derived and every external precedent citation is re-verified* | `[doc][manual]` | Partly: a link checker plus an assertion that each citation carries a retrieval date. The claim-matches-source half stays manual |
| 5 | *the known verification gaps are recorded in the catalog rather than left for a green gate to hide* | `[CI][doc][manual]` | A gate asserting the catalog's gap list is non-empty and that every gap names an owner — a green suite with an empty gap list is the failure mode |
| 5 | *the unmeasured integrity quantities are carried as obligations, never as assumptions* | `[CI][doc][manual]` | Same linter as change 4's above |
| 6 | *no live-backup primitive is named for the archive until it has been measured on the ruled binding* | `[CI][doc][manual]` | Grep for the primitive names in archive text, gated on B-6's state — mechanisable as a conditional gate |
| 6 | *the archive's durability setting is not lowered without four stated preconditions* | `[CI][doc][manual]` | A unit test asserting the lowering path refuses when any of the four preconditions is unmet |
| 6 | *the uncovered projection tables have a written rebuild path with an executed transcript* | `[CI][doc][manual]` | Execute the rebuild path in CI against a seeded archive and diff the result — the transcript becomes a test artifact |
| 6 | *the archive sync entry point remains coherent across typecheck, build and run* | `[CI][doc][manual]` | Already nearly there; add a smoke run asserting the entry point executes against a fresh archive file |
| **7** | *the supported rollback is the untouched source database and no reverse migration is offered* | `[CI][doc]` | An integration test: migrate, then point the 0.9.5 tag at the same `connectionString` and assert full function. Currently only a document says this works |
| **7** | *each distribution channel has a written procedure and the container channel's hazards are named* | `[doc][manual]` | The `K1` split above: execute the extracted commands per channel in CI |
| **7** | *no migration duration or throughput figure is asserted, and every PostgreSQL-side claim is labelled* | `[doc][manual]` | The `L5` linter above |

### 5.5 The 190 criteria anchored to a design section rather than a requirement

23% of all criteria point their `Req / Task` column at `design §N`, `proposal non-goals`, a gate id or
`—`. These are not necessarily wrong — a criterion can legitimately discharge a design decision — but
they are **invisible to any requirement-level coverage query**, which is precisely the check the
fleet is performing. Concentrations: change 3 (35), change 4 (32), change 1 (25), change 7 (24),
change 6 (20). The cheap fix, and the one this lane recommends: every criterion carries **both** a
requirement-title anchor and, optionally, a design anchor — never a design anchor alone.

### 5.6 Things genuinely outside reach

- **That the export faithfully rendered the source.** V1–V5a establish that the *import* was faithful
  to the bundle. Only V5b — probes issued against the live source — closes the export assumption, and
  a consumer whose source is already gone cannot run it. The substitute is the builder's Fixture A,
  and change 7 is right to say so in the report. The test that matters is `H12`: the report must
  contain the sentence distinguishing the two, and name the fixture that discharges the latter.
- **Whether any consumer has run `psql` against their own schema** (§15 Q-5). Unknowable. It is why
  S1–S6 is unconditional rather than opt-in, and no test can substitute for that reasoning.
- **Windows behaviour of the descriptor precondition.** Change 3 carries it as a `[doc][manual]`
  requirement; no Windows runner exists in the fleet's CI as far as this lane can see.
- **The container channel with PostgreSQL bundled in the same image.** Blocked on the owner's
  inventory answer (`P2`). Not a specification gap.

---

## 6. Blocked on measurement

Cross-referenced to change 1's blocked-decision register B-1…B-8 (with B-3 split into B-3a wallet /
B-3b archive) and change 7's own register entries M-1 and M-2.

| Test | Blocked on | Datum required | What is testable **now**, before it closes |
|---|---|---|---|
| `MG-50`/`B3` — `page_size`, `auto_vacuum`, `journal_mode` read back the intended values after import | **B-3a** | The wallet file's `page_size` and `auto_vacuum`, chosen by the sweep rule | That the values are **established before any write** and read back, and that the importer exposes no option to change them — both testable against whatever values B-3a picks |
| `J8`/batch-size — the import runs in row-count-bounded transactions | **M-1**, derived from **B-8** (and **B-5**, which closes when B-8's transport figures exist) | Batch size across the worker boundary on ext4 at the chosen `synchronous` | That the bound is a **row count** and not a byte count; that the default is configuration-driven and not hard-coded; that the config key exists and is documented as blocked |
| `J5`/resume — whether a resume protocol ships at all | **M-2** (`D`, the import duration) | Wall-clock duration of a complete import of a representative wallet database, under change 1's declared gate conditions, on non-memory-backed storage | That **no** resume protocol is implemented; that design §10.3's rule is reproduced verbatim in the migration notes; that M-2 is recorded open. `MG-57`'s negative control is testable now and should be, because it is what makes the eventual choice constrained |
| `MG-58`/`J6` — the importer never lowers `synchronous` | **B-2** | Sustained commit throughput at `NORMAL` and `FULL`, in- and out-of-cache | The **absence** of any `synchronous` write in the import path is testable now; only the asserted *value* is blocked |
| Sampling fallback for `MG-07`–`MG-12` | **unregistered** — see below | A wall-clock budget for exhaustive replay on a representative wallet database | Exhaustive replay is the specified behaviour while the measurement does not exist, so every replay test above is testable now. Only the fallback is blocked |
| `MG-20`/`MG-31` remediation round-trip, `MG-30` reachability | none | — | Fully testable once a container fixture exists; blocked only on `npm install` being available, which is a harness constraint and not a B-gate |
| `MG-63`/`Q8` — the write-lock premise | **B-4** (lease poll/timeout) for the diagnostic's timing half | Lease acquisition under contention at B-2's `synchronous` | The **void-not-degraded** distinction is testable now and does not depend on any figure |
| Change 6's archive layout, which change 7 asserts has no import step | **B-3b** | The archive file's `auto_vacuum` | `N1` — that no archive import step exists — is testable now |

**A gap in the register itself, for the measurement lane.** Change 7's `REPLAY` requirement says a
sampling rule becomes admissible *"IF `v1.0.0-sqlite-engine-core`'s measurement gate establishes,
under its declared conditions, that exhaustive replay on a representative wallet database exceeds a
wall-clock budget recorded in the migration notes."* **The B-register contains no entry for replay
cost.** B-1…B-8 cover the clock, `synchronous`, page size and auto-vacuum ×2, lease timing, batch
chunk size, the backup primitive, probe pragmas and streaming batch size — none of them is replay
cost. So the rule references a gate cell that does not exist, and the condition that would open the
sampling branch can never be met by the gate as registered. Either a **B-9** is added, or the rule is
re-pointed at change 7's own M-register. This is handed to the measurement lane; it is not something
this lane can resolve, and it is a cheap fix now and an expensive one after the tag.

**Confirmed against the landed measurement plan.** `measurement.md` ships experiments E-01…E-08 for
B-1…B-8 and no replay-cost experiment; `grep -niE "replay|B-9|exhaustive" measurement.md` returns
one unrelated hit (`dm-log-writes` replaying a write stream). Worse, that lane's **M-12** asserts
*"every register row is `BLOCKED` with a named missing datum, or `CLOSED` citing a datum id that
exists in the artifact"* — which passes cleanly, because there is no row for replay cost to be
blocked or closed. **A register completeness gate cannot detect a row that was never written.**
M-12 needs a companion assertion in the opposite direction: every *decision rule anywhere in the
seven changes* that cites "the measurement gate" resolves to a register row. Running that companion
today would return exactly one failure — change 7's `REPLAY`.

---

## Appendix — resolution method and its limits

Requirement-to-criterion resolution was done by matching each acceptance row's `Req / Task` column
against (a) the change's declared short-name table, (b) quoted requirement-title fragments with
ellipsis expansion, (c) quoted **scenario**-title fragments resolved to their parent requirement, and
(d) a token-overlap fallback at a 0.6 threshold with a uniqueness requirement. `same`/`same
requirement` inherits the previous row's resolution, matching the acceptance files' own convention.

**Limits, stated so the numbers are not over-read.** The token-overlap fallback can mis-assign a
criterion whose quoted fragment is close to two requirements; where it could not choose uniquely it
assigned nothing, which inflates the 190 rather than corrupting the 164. The four unanchored
requirements were each verified by hand with a direct grep before being reported, and two of the four
turned out to be mis-anchors rather than holes — which is itself the measurement of the citation
problem the brief warned about, appearing in the *acceptance* files after gate G-16 swept the *spec*
files.

Scripts: `/root/umbradb-tp-trace/{trace,resolve,final,final2,stats}.py`, `probeset.mjs`.
No file under `src/`, `test/`, or `openspec/` was modified.
