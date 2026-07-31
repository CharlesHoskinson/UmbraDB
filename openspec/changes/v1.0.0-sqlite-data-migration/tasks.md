# Tasks — PostgreSQL→SQLite data migration for the wallet tier

Every task states concrete acceptance criteria — what test passes, what command succeeds, what
artifact is checkable — per `openspec/config.yaml`'s tasks rule. A task is CLOSED only when its
acceptance criteria are demonstrated **with the command that produced the evidence**; "verified"
without a command is not acceptance.

**Ordering.** Section 0 is a blocking gate: this change depends on four siblings and cannot begin
before each has settled the half it owns (`v1.0.0-sqlite-engine-core/design.md` §8's change-7 dependency table). Section 1
(export) and section 3 (import) can proceed in parallel once section 2 (the bundle contract) is
fixed, because the bundle is the interface between them. Section 4 (verification) depends on both.
Section 7's fixtures gate every claim in sections 1–4; **Fixture B is not optional and no section-4
task closes without it** — a migration is precisely the situation in which a re-executed test goes
green for the wrong reason.

**Applies to every task.** No `src/` or `test/` file changes in this OpenSpec change; it is a
specification, and the SQL and procedures in `design.md` are specifications with cited provenance,
not the final files. No task's acceptance is a performance number. Any measurement uses a database
file under a real filesystem, never `/tmp`. Every claim about PostgreSQL behaviour is labelled
`[code]` or `[inference]` per `design.md` §0.2 and is discharged against a fixture before it is
relied on.

---

## 0. Preconditions (block the whole change)

- [ ] 0.1 **Confirm the four sibling dependencies have settled their halves.** Change 1's driver
  ruling, shim contract, bind normalisation and connection factory; change 2's `kv_event` DDL,
  triggers and view; change 4's lineage `000`–`009` (including `008_ckpt_manifests_seq_unique` and
  `009_value_digests`), its prefixing rule and its invariant I-7; change 5's digest
  coverage set and `verifyIntegrity` signature.
  **Acceptance:** each of the four is cited in `design.md` §0.1 at a `file:line` that still resolves;
  `/usr/local/bin/openspec validate <each sibling id> --type change --strict --no-interactive` exits
  zero for all four. If any of the four has not landed, STOP — sections 1 onward are blocked.

- [ ] 0.2 **Re-confirm every `design.md` §13 measurement on the ruled binding.** The six evidence
  items were taken through `node:sqlite` 3.53.1 because `better-sqlite3` is not installed in this
  worktree. Each is a SQLite-core property, but none may be relied on until re-run.
  **Acceptance:** `probe.mjs` re-runs unmodified against `better-sqlite3@13.0.2` (SQLite 3.53.4) with
  the binding swapped, and every one of E1–E4 and E6 reproduces; the output is recorded verbatim in
  `design.md` §13 alongside the original with both bindings named. Any divergence is a blocking
  finding, not a footnote.

- [ ] 0.3 **Record the owner's answer on the container-image inventory (§15 Q-1).** Which images
  exist; whether any bundles PostgreSQL in the same image as the application rather than as a
  sidecar.
  **Acceptance:** the answer is written into `design.md` §12.3 case 5 and §15 Q-1 is closed or
  narrowed. Section 6's container procedure cannot be written as anything better than generic until
  this lands; task 6.2 is blocked on it.

- [x] 0.4 **Obtain change 4's ruling on the `identifiers` read path (§15 Q-2).** **CLOSED.**
  **Acceptance met:** change 4's `design.md` §19.2 rules invariant I-7 — derive `identifiers` from
  `entry`, cross-check the junction **as a set**, and require the `lifecycle` column to equal
  `entry.lifecycle.status`. `design.md` §5.3 records it; task 4.5's `getAll()` comparison is fixed as
  **exact** (order and multiplicity included, since `entry` is transported verbatim); task 6.3's
  disclosure list is **two** items, with lifecycle replacing identifiers.

  > **Builder note (0.4) — the ruling changed which item is on the disclosure list, not how many.**
  > Verified first-hand before folding in: `transaction-history-storage.ts:238` is
  > `identifiers: row.identifiers` (the column) but `:243` is `lifecycle: stored.lifecycle` (the
  > JSON), and `row.lifecycle` is never read in `decodeRow` although the column is selected at
  > `:329`, `:358` and `:462`. The doc comment at `:229-231` claims *both* are read from their
  > denormalised columns; **it is correct for `identifiers` and wrong for `lifecycle`.** That
  > discrepancy is the reason a lifecycle drift can exist today with nothing having ever compared the
  > two representations.

- [ ] 0.4c **Carry row E-10 of change 3's §2.6.2 inheritance table — the whole-import write-lock
  premise — as this change's own qualifier text (gate G-9).** Filed here rather than only in change
  3's design, per that change's rule that a handover obligation lands in the receiving change's
  `tasks.md` at handover time. This is the mechanism that stops an obligation going missing the way
  invariant I-4 did.
  **Acceptance:** this capability's `spec.md` states, in the requirement governing import
  transactions, that the write-lock premise is **absent, not weakened**, when the descriptor
  precondition of `v1.0.0-sqlite-concurrency-lease` requirement *"no UmbraDB code opens and closes a
  descriptor on the database file or its sidecars"* is violated, and carries a scenario asserting the
  void-not-degraded outcome. `grep -rn "absent, not weakened" specs/` hits that requirement.
  Additionally, the shared refuted-phrase sweep finds no instance of process-level exclusivity being
  derived from transaction serialization, and no requirement rests
  exclusivity on `BEGIN IMMEDIATE` alone — `BEGIN IMMEDIATE` serializes transactions and does not make
  a process a single writer, so import exclusivity cites the writer-generation guard and the
  descriptor precondition together.

- [ ] 0.4d **Repoint every cross-change citation to a requirement-title anchor (gate G-16).**
  **Acceptance:** `grep -rnoE "v1\.0\.0-sqlite-[a-z-]+/[a-z]+\.md:[0-9]+" .` returns nothing, and no
  bare `\`spec.md:NNN\`` / `\`design.md:NNN\`` token referring to a sibling change remains; in-repo
  citations into `src/`, `docs/`, `README.md` and `ROADMAP.md` are deliberately retained, since those
  point at stable product files rather than at sibling documents still being edited. Every anchor
  resolves to a live `### Requirement:` heading or a numbered design section. Transcript pasted.

- [ ] 0.4b **Record change 4's §17.4 hand-off and the §4.5 ruling that discharges it.**
  **Acceptance:** `design.md` §4.5 exists, quotes §17.4's assignment verbatim, distinguishes Class 1
  from Class 2, rules refuse-plus-remediation-report for Class 2 and refuse-only for Class 1, and
  rejects quarantine with three stated reasons; the corresponding spec requirement carries a
  quarantine negative-control scenario. A reviewer confirms change 4 §17.4's obligation no longer
  names an undecided question.

- [ ] 0.5 **Reconcile the three sibling statements this change contradicts on its face.**
  **Acceptance:** `v1.0.0-sqlite-durability-contract`'s boundary criterion N7's criterion N7 is re-scoped
  to that change's own deliverables or restated as "change 5 builds none";
  `v1.0.0-sqlite-schema-parity`'s data-migration non-goal, its precondition P3 and its task 0.3 record that
  the owner has answered and name this change; and change 1's `design.md` §8's change-7 dependency table dependency row for
  change 7 still matches this change's §0.1. `grep -rn "No PostgreSQL-to-SQLite data-migration path
  is built or promised" openspec/changes/` returns only text that scopes the claim to change 5.

---

## 1. The export

- [ ] 1.1 **Rule the export mechanism in the implementation, matching `design.md` §7.2.** SQL text
  run by the consumer's own `psql`; no PostgreSQL client library re-enters `package.json`.
  **Acceptance:** `grep -n '"postgres"' package.json` returns nothing at the closing commit, and the
  same is true of `devDependencies`; `docs/supply-chain/inventory.md` gains no PostgreSQL row; the
  export directory contains only `.sql` and shell files.

- [ ] 1.2 **Write the export SQL, one file per source table, all inside one
  `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`.** Pin `bytea_output`, `DateStyle`, `TimeZone`,
  `IntervalStyle`, `client_encoding` and `standard_conforming_strings` at the top of the session.
  **Acceptance:** an automated check over every shipped `.sql` file finds only `SET`, `BEGIN`,
  `SELECT`, `COPY … TO`, `COMMIT` and `ROLLBACK`, and fails the build on anything else; the check is
  wired into CI. Against Fixture A, running the export twice produces byte-identical bundles.

- [ ] 1.3 **Render `jsonb` as the source's own text and `timestamptz` as an exact epoch-millisecond
  integer, both in SQL.** No JavaScript touches a transported value.
  **Acceptance:** `grep -rn "JSON.parse" <export dir>` returns nothing. Against Fixture A, a row whose
  value is `{"fees": 12345678901234567890123}` exports with those digits intact — the assertion
  compares the exported text to the `jsonb::text` PostgreSQL returns, byte for byte. A fixture row
  with a known `updated_at` exports to that instant's exact epoch milliseconds, asserted with `===`,
  not a tolerance.

- [ ] 1.4 **Order every text-keyed table by `COLLATE "C"`.**
  **Acceptance:** against Fixture A seeded with the key set of `design.md` §13 E6, the exported row
  order equals the order the target produces under `BINARY`, compared element by element. A variant
  of the export without `COLLATE "C"`, run against a database created with a non-`C` `lc_collate`,
  produces a different order — recorded as the negative control that shows the clause is load-bearing.

- [ ] 1.5 **Prove the source is untouched.**
  **Acceptance:** Fixture A's per-table row counts and content digests are captured before the
  export and re-captured after, and are equal; `\dt <schema>.*` lists the same relations; the same is
  asserted after an export killed mid-stream.

---

## 2. The bundle

- [ ] 2.1 **Fix the bundle layout and the `manifest.json` schema** to `design.md` §8.1–§8.2, including
  bundle format version, source `server_version_num`, pinned session settings, table set, per-table
  row count and digest, and the timestamp-truncation record.
  **Acceptance:** the manifest is validated by a Zod schema at import time
  (`design/design-interfaces.md` §1.4's idiom); a manifest missing any required field is refused with
  a diagnostic naming the field; a unit test asserts the refusal for each required field in turn.

- [ ] 2.2 **Implement the per-table digest as a fold over change 5's per-value digest**, per
  `design.md` §8.3.
  **Acceptance:** `grep -rn "createHash\|sha256\|blake" <migration tool dir>` shows no hash
  construction of this change's own — every hash call resolves to change 5's digest helper. A test
  asserts that changing change 5's algorithm changes the migration digest without any edit to this
  change's code, and that the bundle format version is what carries the incompatibility.

- [ ] 2.2b **Implement the two integrity artifacts as separate, separately-named objects (gate
  G-11).** The stored-value digest `dg` — change 5's preimage over the exact stored bytes, **no
  canonicalisation**, persisted — and the transport-fidelity comparison — over canonically parsed
  values, not persisted, not a digest.
  **Acceptance:** the two live in separate modules with separate names; no function computes both;
  gate G-11's incoherent single-artifact phrasing appears nowhere in this change, checked through the
  shared refuted-phrase sweep rather than by reproducing the phrase in this task; a test asserts that
  `dg` for an imported row equals the digest the adapter computes for the
  same row on the read path, which is only possible if neither side canonicalises; and a
  negative-control test shows that a canonicalising `dg` makes two byte-sequences differing only in
  whitespace indistinguishable.

- [ ] 2.3 **Detect a truncated or mismatched bundle before any write.**
  **Acceptance:** truncating one data file, deleting one data file, corrupting one byte of one data
  file, and editing one manifest row count each produce a refusal, a non-zero exit and **no file at
  the target path**; four unit tests, one per case.

---

## 3. The import

- [ ] 3.1 **Create the target through change 1's connection factory and run change 4's lineage to
  completion on the empty file, before the first row.**
  **Acceptance:** the lineage runs `000` through `009`, including `008_ckpt_manifests_seq_unique` and
  `009_value_digests`; migration `006` applies (it would fail with `cannot add a STORED column` on a
  populated table); `PRAGMA page_size`, `PRAGMA auto_vacuum` and `PRAGMA journal_mode` read back the
  intended values; a schema dump of the freshly imported database is byte-identical to a schema dump
  of a greenfield database at the same lineage position.

- [ ] 3.2 **Implement the S1–S6 pre-flight pass over the bundle**, running before the first write
  transaction opens, per `design.md` §3.2.
  **Acceptance:** against Fixture B, each of the six preconditions produces a distinct refusal naming
  the precondition id, the `(ns, scope, key)` and the two source rows involved; six tests, one per
  precondition. Against Fixture A, the pass reports clean.

- [ ] 3.3 **Implement the event-log reconstruction** of `design.md` §3.1: history rows in ascending
  version with `written_at := valid_from`, then the current row with `written_at := updated_at`;
  `id`, `valid_to`, `validity` and `updated_xact` not transported.
  **Acceptance:** for a Fixture A key with three versions, the target holds exactly three `kv_event`
  rows, the derived `valid_to` of the newest is `NULL` (not a sentinel), and `get()`,
  `getAt({version: v})` for every `v`, and `getAt({at: T})` for every breakpoint all match the source.
  Two negative-control tests: a current-only import and a history-only import each fail the per-key
  cardinality check `count(kv_event WHERE key=K) = kv_current.version`.

- [ ] 3.4 **Implement the checkpoint import** with explicit manifest ids, chunks-then-manifests-then-
  junction ordering, preserved `position` multiplicity, and no transported generated column.
  **Acceptance:** after import, `PRAGMA foreign_key_check` returns empty; a new
  `CheckpointStore.save()` allocates an id strictly greater than every imported id; a manifest that
  referenced one chunk hash at two positions still does; `size_bytes` equals `octet_length(data)` for
  every chunk without having been transported. A negative-control run with `foreign_keys = OFF` and a
  deliberately omitted chunk shows `integrity_check → ok` while `foreign_key_check` names the
  dangling row.

- [ ] 3.5 **Implement the watermarks and transaction-history imports**, including the identifiers
  explosion to change 4's junction table with distinct-triple semantics.
  **Acceptance:** a source row with `identifiers = ['a','a','b']` yields exactly two junction rows and
  an `entry` still containing `["a","a","b"]`; `getAll().identifiers` returns `["a","a","b"]`
  unchanged across the migration, because I-7 derives it from `entry`; the junction cardinality check
  compares against the distinct-triple count and a test proves that comparing against summed array
  length would fail on this row.

- [ ] 3.5b **Implement the Class 2 detection and the remediation report** of `design.md` §4.5, for
  migration `008`'s `UNIQUE (w, net, seq)`, the `next_seq > max(seq)` invariant, the 32-byte hash
  `CHECK`s and the `lifecycle` enum.
  **Acceptance:** a source with two `ckpt_manifests` rows sharing `(w, net, seq)` is refused, leaves
  no target database, names both rows, and emits source-side remediation statements; a source whose
  `next_seq` is below `max(seq)` for its `(w, net)` — the pruned-gap case change 4's §17.3(b) shows a
  unique constraint alone misses — is refused by the invariant check specifically, proven by a test
  in which the unique constraint would have passed. **No quarantine path exists:**
  `grep -rn "quarantine\|skipped_rows\|rejected_rows" <migration tool dir>` returns nothing.

- [ ] 3.5c **Implement the two I-7 cross-checks as Class 1 refusals on the source side.**
  **Acceptance:** a source row whose `identifiers` column disagrees with `entry.identifiers`, and one
  whose `lifecycle` column disagrees with `entry.lifecycle.status`, are each refused with a
  diagnostic naming `(wallet_id, tx_hash)` and recording that the inconsistency predates the
  migration; two tests. Neither refusal emits a remediation script, per §4.5 part 2.

- [ ] 3.6 **Do not import the lineage's own objects.**
  **Acceptance:** `<schema>_migrations` after import contains exactly change 4's lineage names in
  order and no PostgreSQL migration name; `<schema>_writer_generation` contains exactly the seed row
  change 4's migration `007` writes; `grep -rn "_migrations" <import code>` shows no read of the
  bundle's migration table, and the export does not emit one.

- [ ] 3.7 **Apply change 1's text boundary check to every imported string.**
  **Acceptance:** a bundle containing a NUL byte or a lone surrogate in any text column is refused at
  the boundary with the engine-core diagnostic, not stored; two unit tests.

- [ ] 3.8 **Bound the import in row-count transactions and keep every check on.**
  **Acceptance:** `grep -rn "synchronous\|foreign_keys\s*=\s*OFF\|ignore_check_constraints\|DROP
  TRIGGER\|INSERT OR REPLACE\|REPLACE INTO" <migration tool dir>` returns nothing; the importer's SQL
  is inside change 2's automated `INSERT OR REPLACE` guard and a deliberately introduced
  `INSERT OR REPLACE` **fails the build**; the batch size is read from configuration and its default
  is marked as blocked on change 1's gate (M-1), not hard-coded with a justification.

---

## 4. Verification

- [ ] 4.1 **Implement V1 and V2** — lineage completeness; `PRAGMA integrity_check` **and**
  `PRAGMA foreign_key_check`; change 5's `verifyIntegrity` passing on both halves.
  **Acceptance:** a target with a dangling foreign key fails V2 even though `integrity_check` reports
  `ok`; a target whose lineage stopped one migration short fails V1; a verifier that ran only
  `integrity_check` passes both cases — recorded as the negative control that justifies requiring both.

- [ ] 4.2 **Implement V3** with the derived arithmetic of `design.md` §9.2, including the per-key
  `count(kv_event WHERE key=K) = kv_current.version` check and the exclusions.
  **Acceptance:** dropping a single interior version from one key's chain is detected by the per-key
  check; a test confirms the whole-table total alone does **not** detect it when a row is
  simultaneously added elsewhere, which is why the per-key form is required.

- [ ] 4.3 **Implement V4** as the order-defined fold of task 2.2, compared source-to-target.
  **Acceptance:** flipping one byte of one imported value produces a V4 failure naming the table and
  the row; a run in which the source is ordered without `COLLATE "C"` against a non-`C` database
  produces a spurious V4 failure — recorded as the negative control for task 1.4.

- [ ] 4.4 **Implement V5a exhaustive point-in-time replay** per `design.md` §9.3: every breakpoint,
  one interior instant per gap wider than 1 ms, one instant before the earliest, and every version in
  `1..n` plus `0` and `n+1`.
  **Acceptance:** the probe set for a key with `n` versions has size at most `2|B|+1` and the test
  asserts that bound; the replay detects the gap-manufacture case of `design.md` §13 E3 **when the
  pre-flight pass is disabled for the test**, proving the replay is an independent check and not a
  restatement of §3.2; a thousand-random-instants variant fails to detect a one-millisecond boundary
  shift that the exhaustive form catches, recorded as the sampling negative control.

- [ ] 4.5 **Implement the tier-specific replays** of `design.md` §9.5: `get()` per key; `listKeys` set
  comparison plus a code-point ordering assertion; `WalletStateEnvelopeStore.load()` per
  `(walletId, networkId)`; `getAll()` per wallet compared **exactly** per task 0.4's ruling; and the
  two I-7 cross-checks asserted against the target alone.
  **Acceptance:** the `get()` replay detects the §4.2 version-collision case that the `getAt` replay
  passes — the single most important negative control in this change; a `listKeys` comparison written
  as a sequence comparison fails on a correctly migrated database whose keys are not already in
  code-point order, while the set comparison plus ordering assertion passes; `getAll().identifiers`
  compares byte-identically including order and duplicates; the junction-vs-`entry` cross-check
  compares **as a set** and a sequence comparison is shown to raise a spurious fault on a re-ordered
  `entry` array, per change 4's `design.md` §19.2.

- [ ] 4.6 **Implement V5b** against a live source, and gate it on reachability rather than assuming it.
  **Acceptance:** against Fixture A, V5b issues the same probe set through the 0.9.5 adapter and every
  probe agrees; with the source unreachable the verifier reports V5b as **not run** and the summary
  says so explicitly rather than omitting the rung.

- [ ] 4.6b **Implement the empty-scope rule and prove the fixtures non-empty (gate G-12).**
  **Acceptance:** a bundle with correctly-formed but empty data files produces `n/a — no rows in
  scope` for every content, cardinality and replay check and an overall outcome that is **not**
  `pass`; a seeding defect that empties Fixture A fails the fixture-inventory assertion rather than
  producing a smaller green run; and a database that legitimately has no transaction-history rows
  reports `n/a` for that tier while still permitting an overall pass, with every `n/a` rung named in
  the report. Three tests, one per case.

- [ ] 4.8 **Specify and implement the CLI exit codes and the structured report schema (gate G-14),
  against change 5's ruling** that failures of a process outside the frozen surface are tool
  diagnostics, not catalog entries — which also states that exit codes and report schema belong to
  the owning change, i.e. this one. Do **not** mint a catalog code.
  **Acceptance:** success, bundle-integrity refusal, Class 1 refusal, Class 2 refusal,
  post-import verification failure and internal fault each exit with a distinct documented code; exit
  `0` occurs only for a completed, fully verified migration; a shell-script test branches on the codes
  without reading any message text; the report file alone is sufficient to determine the outcome; and
  `docs/ERROR-CATALOG.md` is unchanged, with the catalog drift test green and the code count
  unchanged.

- [ ] 4.7 **Emit a verification report that states what was checked and what was assumed**, in the
  wording of `spec.md`'s ladder requirement.
  **Acceptance:** the report for a V1–V5a-only run contains the sentence distinguishing "the import
  was faithful to the bundle" from "the export faithfully rendered the source", and names the fixture
  that discharges the latter; a doc test asserts the sentence is present.

---

## 5. Failure, publication and re-run

- [ ] 5.1 **Implement in-progress-path-then-rename publication**, with checkpoint-and-close before the
  rename.
  **Acceptance:** killing the importer at ten different points (a table boundary, mid-table, during
  verification, between verification and rename) leaves **no file at the target path** in all ten
  runs; a variant that renames before checkpointing is shown to produce a database missing its most
  recent commits while reporting `integrity_check → ok`, recorded as the negative control.

- [ ] 5.2 **Prove re-run determinism.**
  **Acceptance:** importing the same bundle twice into two paths yields equal per-table digests for
  every table; a test asserts the importer reads no wall clock on the import path
  (`grep -rn "Date.now\|new Date()\|unixepoch" <import code>` returns nothing outside logging).

- [ ] 5.3 **Record the resumability decision rule and leave it open.**
  **Acceptance:** `design.md` §10.3's rule is reproduced in the migration notes with **D** unmeasured;
  `grep -rn "resume" <migration tool dir>` returns no implementation; the blocked-decision register
  entry M-2 exists and is open. A resume protocol implemented before D is measured is a task-0
  violation, not a head start.

---

## 6. The channels and the migration notes

- [ ] 6.1 **Write the git-tag and clone procedures** with the quiesce/export/upgrade/import/verify/
  restart ordering of `design.md` §12.1–§12.2.
  **Acceptance:** the clone procedure is executed end to end against Fixture A by a reviewer following
  only the written text, and it succeeds without recourse to the source or to this change's documents;
  the transcript is recorded.

- [ ] 6.2 **Write the container procedure and its five hazards** (`design.md` §12.3). Blocked on task
  0.3.
  **Acceptance:** the notes state that UmbraDB builds and publishes no image, and the claim is backed
  by a recorded command showing no `Dockerfile`, compose file or image-publish step in the repository;
  the five hazards each appear with the consequence stated; the filesystem-refusal hazard cites
  change 5's refused-type list and states that a refusal there is expected behaviour.

- [ ] 6.3 **Write the two-item disclosure list** — the `listKeys` reorder with the resume-cursor
  instruction, and the `lifecycle` agreement fault.
  **Acceptance:** `v1.0.0-sqlite-schema-parity` requirement *"listKeys ordering is code-point order and the one-time resume-cursor reorder is disclosed"*'s obligation that the reorder be
  *"stated in the migration notes rather than discovered"* is satisfied by a specific cited paragraph;
  a doc test asserts the resume-cursor instruction is present; the lifecycle item states that the
  previously returned value was the JSON's — the representation I-7 keeps — so no value changes and
  only the visibility of a pre-existing disagreement does; the notes **do not** list `identifiers` as
  a difference, and a doc test asserts that absence so a later edit cannot silently re-add a claim
  that I-7 made false.

- [ ] 6.4 **Write the rollback, mandatoriness and no-reverse-migration section.**
  **Acceptance:** the section cites `docs/STABILITY.md:34-36` for why a required forward migration at
  a major boundary is inside the published policy, cites `:40-42` for the backup guidance and states
  that the untouched source satisfies it without the consumer taking a backup, and states that
  migration is required to run 1.0.0 with the `0.9.5` tag as the stay-put option.

- [ ] 6.5 **Hand change 5 the two `docs/CONTRACT.md` §2 clarifications** of `design.md` §11.3, rather
  than drafting them here.
  **Acceptance:** both are recorded as inbound items on change 5 with this change cited as their
  source, and neither appears as an edit in this change's diff.

---

## 7. Fixtures and conformance

- [ ] 7.1 **Build Fixture A (faithful)**, seeded only through the 0.9.5 public API, containing every
  case listed in `design.md` §14.
  **Acceptance:** `grep -rn "sql\`\|INSERT INTO\|UPDATE " <fixture A>` shows no raw SQL against the
  source schema — every row is produced by `put`, `save`, `set` or a `PgTransactionHistoryStorage`
  method; the fixture's contents are enumerated in a checked-in inventory that the tests assert
  against, so a silently shrinking fixture fails.

- [ ] 7.2 **Build Fixture B (adversarial)**, one raw-SQL case per refusal state of `design.md` §4 and
  §4.5 — six Class 1 temporal cases, the two Class 1 transaction-history disagreements
  (`identifiers` column vs `entry`, `lifecycle` column vs `entry.lifecycle.status`), and the four
  Class 2 cases (colliding `(w, net, seq)`, `next_seq` below `max(seq)` in a pruned gap, a
  non-32-byte hash, an out-of-enum `lifecycle`).
  **Acceptance:** twelve cases, twelve distinct refusals, twelve assertions that **no target database
  exists** afterwards; the four Class 2 cases each additionally emit a remediation report naming the
  offending rows and the source-side statements, and the eight Class 1 cases each emit **no**
  remediation script. Tasks 3.2, 3.5b and 3.5c do not close without this.

- [ ] 7.3 **Decide whether the migration adds a conformance id, and if so add it as a reviewed change
  in its own commit.** `test/integration/required-tests.manifest.json` carries 25 required ids pinned
  by `EXPECTED_REQUIRED_COUNT`.
  **Acceptance:** either a written decision that the migration's tests are not conformance-gated, with
  the reason; or a new id plus a pinned-count change **in a separate commit from any deletion**, per
  the commitments seat's R4(iii)(3). `git log --oneline -- test/integration/` shows the separation.

---

## 8. Closeout

- [ ] 8.1 **Sweep this change for a bare performance number and for an unlabelled PostgreSQL claim.**
  **Acceptance:** every duration/throughput/rate hit across the five documents is inside a decision
  rule naming change 1's gate or inside `design.md` §13 with its command and conditions; every
  PostgreSQL-behaviour statement carries `[code]` with a `file:line` or `[inference]`.

- [ ] 8.2 **Sweep for the four refuted phrases change 1's task 0.5b bans**, and for any statement that
  this change's own premises have gone stale.
  **Acceptance:** running change 1's own task-0.5b sweep — the shared script, so the phrase list lives
  in exactly one place and this change does not reproduce the banned strings and thereby trip its own
  check — over `openspec/changes/v1.0.0-sqlite-data-migration/` returns zero hits; the archive
  non-goal states the reason as the absence of rows, not the absence of a runner; and the non-goal is
  consistent with `v1.0.0-sqlite-chain-archive`'s "Why" section, which states from the other side that
  the archive is not in change 7.

- [ ] 8.3 **Validate.**
  **Acceptance:** `cd /root/UDB-sqlite-sprint && /usr/local/bin/openspec validate
  v1.0.0-sqlite-data-migration --type change --strict --no-interactive` exits zero, output recorded
  verbatim; the two pre-existing failures (`v1.1.0-formal-completion`, `v1.1.0-quint-model-checking`)
  are unchanged and are not this change's.
