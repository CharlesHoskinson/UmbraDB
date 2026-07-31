# Adjudication — Fable tie-break

**Adjudicator:** Fable (Claude, `claude-fable-5`), tie-break seat per the project's audit convention.
**Date:** 2026-07-31.
**Inputs:** the three lane reports in this directory, `AUDIT-BRIEF.md`, `AUTHORING-BRIEF.md`,
`SYNTHESIS.md`, `council/`, the five changes under
`/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-*`, and independent experiments run on this
host (WSL Ubuntu-26.04, `/root` ext4, Node v24.18.0, `better-sqlite3@13.0.2` at `/tmp/l3-bs3b`,
SQLite 3.53.4). Scripts: `/root/fable-adj/holder.mjs`, `/root/fable-adj/repro.mjs` — written fresh
for this adjudication, not reruns of `opus-evidence`'s.
**Coordinator state folded in (received mid-adjudication):** `opus-compliance` M-1 and M-2 are
CLOSED by their owning authors; the `listKeys` seam is closed; one new open question (dual deadline
on `opts.tx` streams) is assigned below as R-10.

---

## 1. Verdict

**APPROVE WITH FINDINGS — with three named blocking gates (R-1, R-2, R-3) that must close before
the implementation they govern begins. Codex's REJECT is overruled.**

The test I applied is the one the seat was asked to apply: not "are there serious findings" — there
are, and I confirmed the worst of them myself — but whether they are remediable inside this plan or
show the plan is built on a premise that must be re-laid. Every confirmed critical fails the second
test:

- **The archive finding (Codex C1, confirmed)** impeaches a *scope* claim, not a design derivation.
  None of the five changes' technical designs — driver ruling, event-log shape, in-database lease
  mechanism, `STRICT` schema, contract rewrite — depends on the archive being unwired. What depends
  on it is the non-goals wording, one task's acceptance criterion (change 1 task 1.1 "remove
  `postgres`"), and the cost estimate. That is closed by one scoping decision plus text amendments
  (R-1), not by re-laying the plan.
- **The fd-close finding (opus-evidence C1, independently reproduced below)** falsifies the *stated
  safety argument* of change 3's writer-generation guard, not the choice of mechanism. The refuted
  alternative — the sidecar lease — fails the *same* attack plus `unlink`, cross-process, so no
  design decision flips. The fix is spec amendments across changes 2/3/5 plus a SYNTHESIS
  correction (R-2).
- **The digest finding (Codex C2 + opus-evidence C2, merged)** is spec incompleteness on the
  sprint's keystone enhancement. The mechanism is proven (both lanes and the coordinator reproduced
  the detection); what is missing is algorithm, DDL ownership, an exhaustive coverage set, and the
  deletion or definition of an undefined escape hatch (R-3).

A REJECT sends five authors back to re-derive a plan whose derivations were not impeached. The
evidence pattern says the opposite is needed: `opus-compliance` verified 25/25 citations exact,
`opus-evidence` 12/12, Codex 10/11 with the eleventh "text held, inference failed." The plan does
not fabricate or misquote — its weaknesses are stale-premise inference and seam ownership, both of
which are enumerable and now enumerated. Two seam items (M-1, M-2) were closed by authors while
this adjudication was running, which is direct evidence the remediation loop works inside the plan.

This is not a split of the difference: it is the majority verdict class with Codex's confirmed
findings promoted to blocking gates, and Codex's two mis-severitied or mis-sourced claims
explicitly downgraded on the merits (§3, F-3).

---

## 2. Re-tested claims

### 2.1 `opus-evidence` C1 — REPRODUCED. The claim holds exactly as stated.

I wrote my own two-process reproduction (not a rerun of the lane's scripts) with a control arm and
a mechanism-isolation arm, and ran it on ext4:

```
$ wsl -d Ubuntu-26.04 -e bash -lc 'cd /root/fable-adj && node repro.mjs'
node v24.18.0 | sqlite 3.53.4 | fs: /root is ext4

[none] competitor                                    refused SQLITE_BUSY
[none] holder                                        COMMIT-OK
[none] final rows                                    [1]
[none] acknowledged commit lost?                     no

[shm-openkeep] competitor                            refused SQLITE_BUSY
[shm-openkeep] holder                                COMMIT-OK
[shm-openkeep] final rows                            [1]
[shm-openkeep] acknowledged commit lost?             no

[shm-readclose] competitor                           COMMITTED (ack ok)
[shm-readclose] holder                               COMMIT-OK
[shm-readclose] final rows                           [1]
[shm-readclose] integrity_check                      ok
[shm-readclose] acknowledged commit lost?            YES — SILENT LOSS
```

Setup: holder process opens the DB (WAL, `busy_timeout=0`), `BEGIN IMMEDIATE`, inserts `who=1`,
then performs the arm's action; competitor is a separate OS process that attempts
`BEGIN IMMEDIATE; INSERT who=99; COMMIT`; holder then commits. Findings:

- **Control holds:** with no `-shm` action, the competitor is refused `SQLITE_BUSY` — the guard's
  benign-path exclusion is real.
- **Mechanism isolated:** opening a descriptor on `-shm` *without closing it* does not void the
  lock. It is the close — the classic POSIX advisory-lock close bug — exactly as the lane claimed.
- **The attack:** one `fs.readFileSync(db + "-shm")` inside the holding process voids the write
  lock. The competitor's `COMMIT` returns success; the holder's `COMMIT` also returns success; the
  competitor's row is **gone** from the final database; `integrity_check` reports `ok`.

Consequences confirmed: `SYNTHESIS.md`'s "the main WAL database survived the fd-close attack" is
**refuted** — the locks living on `-shm` is why it is exposed, not why it is safe. Change 3
`design.md:221-225` ("no interleaving exists between 'observe the generation' and 'commit' …
once process B's registration commits, no transaction from process A can commit") is directly
falsified by the third arm: B committed, then A's commit succeeded and destroyed B's. And change
3's own red-team scenario (`specs/transaction-lease/spec.md:40-48`) *mandates* the holding process
`readFileSync` the `-shm` — the mandated test performs the destructive act while asserting only the
in-process lease property, which survives.

Limits: Linux/ext4, this binding, WAL. The hazard is POSIX-specific (Windows uses per-handle region
locks and does not have the close bug); the Windows arm belongs in change 3's existing Windows
obligation, not in a new one.

**Ruling: C1 is a confirmed critical. It is also remediable in-plan — see R-2 — because the
mechanism survives; only its stated justification, its test plan, and three neighbouring procedures
must change.**

### 2.2 Codex critical 3 — PARTIALLY SUSTAINED, downgraded to Major. The Opus severity is correct.

I opened every cited line. What is actually at each:

| Codex citation | What is actually there | Load-bearing fact, or labelled reference? |
|---|---|---|
| engine-core `spec.md:525-533` (`233×`) | Negative-control scenario "research-phase figures are invalid and their reuse is prevented": "**THEN** WAL `synchronous=FULL` commit throughput **SHALL be seen to differ by a factor of 233**" | A real defect, but not contamination-as-fact: it **preordains a numeric outcome inside a SHALL**. Any fresh re-measurement yields some other factor (opus-evidence M2: the corpus supports 169×–271× across four runs), so the scenario is unsatisfiable as written. This is M2's defect, Major. |
| engine-core `spec.md:535-540` (`2.64×`) | "a re-measurement **on real disk** showed throughput falling by a factor of 2.64" justifying "record the decay curve" | **Codex mis-sourced this figure.** It is an ext4 figure (`SYNTHESIS.md:84` "at `FULL` **on disk**"; `council/redteam.md:140`), not tmpfs-derived. Citing it without an artifact datum is an M1-class discipline defect (Minor–Major), not contamination. |
| temporal `spec.md:352-361` (`1,441×`) | Negative-control scenario "The whole-history overlap probe is quadratic", describing a design the spec **forbids adopting**, with the tmpfs caveat attached in-line and a companion scenario requiring the shipped path be established on a real filesystem as a shape, not a rate | Labelled-inadmissible reference. The one defect is opus-evidence m3: "it is a floor" is true of the absolute time, dubious of the quoted *ratio*. Minor. |
| schema `spec.md:430-440` (`2.0×–3.8×`, `3.3×`) | "the *factors* SHALL NOT be carried as fact, because both measurements were taken against a tmpfs RAM disk; only the direction is carried, and it SHALL be re-confirmed on ext4" with a reopen condition if the direction inverts | This is the **model** of correct contaminated-figure handling, not a violation of it. Not sustained. |
| schema `spec.md:494-497` (`3.5×`) | "a full table rebuild, whose peak on-disk footprint was measured at **3.5×** the logical data" — advisory alternatives clause, no provenance label | Unlabelled figure in an advisory clause. Minor discipline defect. |

Verified supporting greps: `grep -n "233" schema-parity/specs/storage-schema/spec.md` → `:694-695`
("the calibrating example being … 88,485 commits/s versus 379 re-measured on ext4, a 233× error")
— again a reference to the contamination event itself, but publishing one of four inconsistent
calibrations as *the* number, which is opus-evidence M2's point, in a spec scenario.

**Ruling: both lanes are not equally right, and the Opus lanes are the ones who are right.**
`opus-evidence` traced each figure to its source, re-measured two of them (429/237 ms found
*conservative* on ext4 at 297–410 ms), distinguished labelled negative controls from unattributed
assertions, and severitied accordingly (M1/M2/m3/m5). Codex read the presence of digits as the
presence of contamination, mis-sourced 2.64×, and rated as Critical a set of passages three of
which are explicitly labelled inadmissible. Sustained only as merged into R-6 (Major): fix the
preordained 233× SHALL, quote the calibration as a range or not at all, label the two unlabelled
figures, and add the program-wide provenance lint (opus-evidence M3) that would have caught all of
this mechanically. The second half of Codex's same critical — B-3/B-4/B-5/B-8 name decisions
without decision rules — I verified against engine-core `design.md` §6.3 and it is real: the table
records inputs and required data but no acceptance envelope or selection rule for those four.
Sustained as Major, also in R-6, because the gate structure and blocking behaviour exist; what is
missing is determinism, and it must be added *before* the measurement runs, which is still ahead.

---

## 3. Finding-by-finding adjudication

Every disputed or cross-examined item. "Sustained" means confirmed at the stated severity.

| # | Finding | Lanes | Ruling |
|---|---|---|---|
| F-1 | Archive is wired; "unwired, out of scope" premise false; change 1 `tasks.md:68` removes `postgres` while `chain-archive-sync/` (typechecked, `package.json:46` `archive:sync`, imports `src/postgres/client`, runs `chainArchiveMigrations`, constructs `PgChainArchiveStore`) depends on it | Codex CRITICAL vs. both Opus lanes reporting scope discipline "clean" | **Sustained, CRITICAL (Codex right, both Opus lanes and the coordinator wrong).** Coordinator-confirmed pre-dispatch; I confirmed the breakage chain. The Opus lanes verified quote fidelity of `001_chain_archive_core.ts:86` — which is accurate about `src/` and stale about the repo — instead of premise currency. Council feasibility ruling and SYNTHESIS fact 4 are impeached. → R-1. See §4 for the scope ruling. |
| F-2 | fd-close of `-shm` voids WAL write lock; silent lost commit; guard safety argument false | opus-evidence CRITICAL; unexamined by the other two | **Sustained, CRITICAL — independently reproduced (§2.1).** Codex read the same `design.md` §2.3 sentence and challenged only its benign-case consequence (F-5); it missed the adversarial case entirely. → R-2. |
| F-3 | Contaminated figures survive in specs | Codex CRITICAL vs. opus-evidence M1/M2/m3/m5 vs. opus-compliance m-2 | **Downgraded to MAJOR; Opus severity and characterisation correct (§2.2).** Real defects: preordained 233× SHALL; four-way-inconsistent calibration published as one number in all five changes; two unlabelled figures; no program-wide lint. Not real: "labelled negative controls are load-bearing facts"; "2.64× is tmpfs-derived". → R-6. |
| F-4 | Page-checksum/digest underspecified: no algorithm/encoding/DDL owner/backfill; "operating envelope" fallback undefined; coverage set open-ended ("at minimum"); watermarks sync-cursor leak defeats the re-derivable split | Codex C2 + opus-evidence C2/M7 vs. opus-compliance "closed twice" (praise) | **Sustained, CRITICAL for change 5's implementation start (merged).** Verified: `grep -rn "operating envelope"` → 3 uses (design:300, acceptance:57, tasks:175), zero definitions; `grep -rni "digest" schema-parity/` → 0 hits, so the DDL coordination named in change-5 task 3.1 is one-directional. opus-compliance verified *presence* of the enhancement, which is true, and did not test sufficiency — its praise and the criticals are compatible; the criticals win. The watermarks-cursor observation (corrupted cursor silently poisons the non-re-derivable tier by omission) is the sharpest single insight in the three reports and Codex missed it. → R-3. |
| F-5 | Change 3 task 3.2 requests an impossible interleaving (B registers while A holds the write tx, then A rejected) | Codex MAJOR; unexamined by Opus lanes | **Sustained, MAJOR — verified at `tasks.md:121-126` against `design.md:221-225`.** Under the design's own exclusion claim, B's registration cannot commit while A holds the lock, so the acceptance test is unrunnable as written. **And see §6.3: the one way to realize the requested interleaving is F-2's attack, under which the assertion fails** (my repro: A's COMMIT succeeds after B commits). Fix must specify three orders, not Codex's two. → R-4. |
| F-6 | Writer-displacement error code owned by nobody | Codex MAJOR; adjacent to opus-compliance M-1 but distinct | **Sustained, MAJOR.** Verified: change 3 `design.md` §7.3 "The code itself is D-5's [change 5's] to add", with constraints (non-retryable, not `TRANSACTION_FAULT`); `grep -rni "displac" durability-contract/` → **zero hits**. → R-5. |
| F-7 | Five changes cannot land atomically; registry/naming circularity | Codex MAJOR vs. opus-compliance coverage gap 4 (softer) | **Sustained, MAJOR.** Verified the cycle: c4 task 0.1 "If change 1 has not landed, STOP"; c4 tasks preamble "§1 naming layer … must land before any other lane's DDL"; c4 task 2.4 hands the decoder registry to change 1; c1 task 2.3 builds the decoder registry itself. Whole-change ordering is cyclic; a task-level tranche schedule resolves it (both lanes agree in substance; Codex's framing is the actionable one). → R-8. |
| F-8 | "Pre-tag = cheap/free" overstated; consumers unobservable | Codex MAJOR vs. SYNTHESIS facts 1–3 and both Opus lanes' acceptance | **Partially sustained, downgraded toward the wording fix.** `STABILITY.md:46` legality is real and undisputed. Schema `spec.md:415`'s specific "free pre-tag (there are no shipped SQLite databases)" is *sound* — no SQLite database exists regardless of consumers. The unsound residue is "no consumers" stated as fact (change 5 itself records git-tag installs as unobservable) and "cheap" asserted where cost is unknown. opus-evidence coverage gap 3 already says this. → R-9. |
| F-9 | 429 ms / 237 ms figures in change 1 | opus-evidence M1 (traced to tmpfs via `l3-driver.md` "on disk" mislabel, re-measured conservative) + opus-compliance m-2 (inadmissible as written) | **Both sustained and compatible; opus-evidence's is the complete account.** The figures are directionally safe (conservative) and formally inadmissible under the spec's own `:511` rule. Discipline fix, Minor–Major. → R-6. |
| F-10 | opus-evidence M4 (normalisation untested), M5 (`WITHOUT ROWID` undecidable per-table, event log falls between changes 2/4), M6 ("the bound's grace" undefined) | Single-lane; unexamined elsewhere | **Sustained as MAJOR (rework-grade), in flight.** M6 verified in spirit by the lane's grep; the fix M6 names (`spec.md:298-306` already contains the correct sentence) makes it cheap. → R-11. |
| F-11 | opus-compliance M-1 (`writer_generation` migration unowned), M-2 (orphaned `opts.tx` requirement) | Single-lane | **Sustained — and CLOSED by authors mid-adjudication (coordinator-verified: `007_writer_generation` with prefix/`STRICT`/named constraints; ninth MODIFIED requirement, 9/9 headers byte-exact).** Recorded, not re-derived. The closure of M-1 surfaced a further live defect no auditor caught — change 3's registration was `UPDATE … WHERE id = 1` with no seed row, so on an unseeded table every statement succeeds while `myGeneration` is undefined and the guard admits the second writer. Now seeded in `007` with the unseeded case as a negative control. See §6.5. |
| F-12 | Minor sets: numeric `(5)`/`(517)` prose (all three lanes, m-3/m2/Codex minor 1); stale `full-chain-storage.md:81` (Codex); `ANY` self-contradiction (oe m1); "fixture wiring" escape hatch (oe m4); change-5 exclusivity claim now false (oc m-1); Windows precondition phrasing (oc m-4); tasks.md house style (oc m-5); citation imprecision (oc m-6) | Various, no conflicts | **All sustained as Minor.** Note the convergence: three lanes independently flagged the numeric result codes with three severities and all three agree it is *not* the forbidden discriminator — annotate, don't rewrite. Codex's stale-doc minor is upgraded in significance (not severity): `full-chain-storage.md:81` is the stale record that enabled F-1. → R-12 batch. |
| F-13 | Coverage gaps: corruption-response path (oe 2), data-migration ownership (oe 3), DrvFs refusal list (oe 4), Windows deferral (oe 5), artifact id scheme (oe 7), migration-lock object (oc 3), merged-spec Postgres framing (oc 2), `src/postgres/` disposition (oc 5) | Complementary, no conflicts | **Sustained.** One adjudication note: **oc gap 5 and F-1 are the same decision** — the disposition of `src/postgres/` is decided by the archive ruling, and no lane connected them. Folded into R-1. Artifact id scheme (oe 7) folds into R-6 as the mechanism the lint needs. Rest → R-12/R-13. |

---

## 4. The archive ruling

**The archive comes into scope as a *decision*, not as work. The five-change structure stands; no
sixth change is required unless the owner chooses to port. The scope hold on its previous
justification is dead; it survives on a different and honest one.**

The impeached justification was "unwired, no consumer, no data — therefore out of scope." The first
clause is false (Codex C1, confirmed): `chain-archive-sync/` is a typechecked, npm-scripted,
self-described production/ops entry point that runs `chainArchiveMigrations` and constructs
`PgChainArchiveStore`. The concrete breakage is real: change 1 task 1.1 removes `postgres` from
dependencies "when the last adapter has ported," while task 0 forbids touching the archive — under
which `npm run typecheck` and `npm run archive:sync` both break. Something must give, and I rule
which:

**Default ruling — option 1 (dual-engine, archive explicitly retained on Postgres):**

1. Change 1 task 1.1's acceptance changes from "remove `postgres`" to: *"no module under `src/`
   imports `postgres`; `chain-archive-sync/` is its sole remaining consumer, and this is asserted
   by a source guard."* `postgres` stays in `dependencies`, annotated as archive-track-only.
2. All five changes' non-goals replace "not wired into any runner path / no consumer" with:
   *"the chain archive is deliberately retained on PostgreSQL this sprint; `chain-archive-sync/`
   is its ops entry point; porting it is deferred (+20–30 days when wanted, per SYNTHESIS)."*
3. `SYNTHESIS.md` fact 4 is corrected; the feasibility seat's "not on the critical path" ruling is
   annotated as impeached-in-premise but surviving-in-conclusion (it is still not on the *wallet
   migration's* critical path — nothing in changes 1–5 touches its tables); the stale comment at
   `001_chain_archive_core.ts:86` and `docs/features/full-chain-storage.md:81` are corrected.
4. **Owner question, routed with R-1:** has `archive:sync` ever been run against a real database
   anywhere? "No data" was verified before the CLI existed and is now also unverified. If the
   answer is yes, the data-migration scoping (oe gap 3) changes too.

Why not the alternatives: option 2 (port now) adds 20–30 days of work on a track with no verified
data or consumer to a sprint whose value is the pre-tag wallet migration — it needs an owner's
affirmative choice, not an auditor's default. Option 3 (remove/disable the preview) deletes a
production entry point someone recently and deliberately added ("the production/ops entry point the
feature previously lacked" — its own header), which likewise cannot be an audit default. Option 1
is the only choice that is coherent at typecheck, runtime, and scope without presuming the owner's
intent, and it degrades gracefully into either alternative later. The cost is honest: the sprint's
"single-engine repository" claim is narrowed to "single-engine wallet"; any change text implying
`postgres` fully leaves the tree is amended.

**If the owner instead chooses option 2, a sixth change is required** (archive capability spec,
migration lineage under change 4's naming layer, `STRICT` treatment, and its own measurement
obligations) and the sprint estimate grows accordingly. That choice re-opens scope; option 1 does
not.

---

## 5. Ordered remediation list

Blocking = must close before the implementation it governs begins. In flight = fix during
implementation, before the affected task executes. R-1..R-3 are the verdict's named gates.

| # | Item | Owner | Closed when | Status |
|---|---|---|---|---|
| **R-1** | **Archive scope decision (F-1).** Execute §4's default (or the owner overrides to port/remove): task 1.1 acceptance amended; non-goals wording corrected in all five changes; SYNTHESIS fact 4 and stale docs corrected; owner answers the has-it-ever-run question | Change 1 + repo owner; coordinator routes the owner question | `npm run typecheck`, `npm run build`, `npm run archive:sync` all coherent under the amended plan; no change text claims the archive is unwired; strict validation green | **BLOCKING (sprint kickoff)** |
| **R-2** | **fd-close/`-shm` hazard (F-2).** (a) `design.md` §2.3's "no interleaving exists" qualified with the named voiding precondition; (b) the `-shm` open/close attack added as a scenario against the *writer-generation guard* with observables "no two writers both commit; no acknowledged commit is lost"; (c) source guard banning in-process open+close of `-wal`/`-shm` on UmbraDB paths (the `INSERT OR REPLACE`-ban style), and change 5's offline backup copy specified as out-of-process or post-quiesce; (d) change 3's read-everything red-team scenario reframed so the mandated test doesn't silently void the adjacent guarantee; (e) change 2's "closed three independent ways" TOCTOU claim (temporal `spec.md:377-379`) qualified; (f) SYNTHESIS "survived a genuine attack" entry corrected; (g) Windows arm routed into change 3's existing Windows obligation, noting the hazard is POSIX-specific | Change 3 (lead), changes 2 and 5 (consequences), coordinator (SYNTHESIS) | All six spec/design edits landed and strict-valid; the new scenario exists with both observables; the source guard is a named requirement | **BLOCKING (change 3; items (c)-backup and (e) before changes 5 and 2 respectively)** |
| **R-3** | **Digest specification (F-4).** Algorithm, byte encoding/domain separation, column name and SQLite type, migration number and owner, backfill rule pinned; coverage set enumerated exhaustively — every table named, covered or uncovered with reason, including `transaction_history` and an explicit ruling on the `watermarks` sync cursor (cover it, or add the on-demand cursor-not-ahead-of-data check to the whole-DB verification pass); "operating envelope" defined numerically *before* measurement or the fallback deleted (coverage reduction requires a spec change and consumer acceptance, never an implementation-time choice); change 4 adds the digest column to its lineage/`STRICT`/named-`CHECK` regime; change 2 amends its exhaustive column enumeration | Change 5 (lead), change 4 (DDL), change 2 (columns) | The requirement names one algorithm and a closed coverage set; `grep -rni digest schema-parity/` is non-empty; no undefined term gates mandatory coverage | **BLOCKING (change 5 tasks 3.x; the DDL half before change 4 §12 lands)** |
| **R-4** | **Task 3.2 rewritten (F-5).** Three orders: (i) A holds, B waits, A commits, B registers, A's *next* transaction observes displacement and is rejected; (ii) B registers first, A's next transaction rejected; (iii) negative control — the R-2 attack realizes the previously-impossible interleaving and the guard's observable ("no acknowledged commit lost") is asserted under it | Change 3 | Task 3.2's acceptance matches the spec's own "after B registers" table and names all three orders | In flight (before change-3 test authoring) |
| **R-5** | **Displacement error code (F-6).** Change 5 names the code, class, catalog row, `retryable: "non-retryable"`, situation text per change 3 §7.3's constraints; matching task + acceptance rows in both changes | Change 5 (code), change 3 (consumption) | `grep -rni displac durability-contract/` hits the catalog addition; change 3 task 5.6 references it by name | In flight (before change 3 task 5.6 / change 5 catalog freeze) |
| **R-6** | **Measurement-gate determinism and figure hygiene (F-3, F-9).** Decision rules/acceptance envelopes for B-3, B-4, B-5, B-8 written before the suite runs; the preordained "factor of 233" SHALL reworded to a shape ("two to three orders of magnitude" or the 169×–271× range); the four-way calibration (345/379/411/523 c/s) quoted as a range everywhere or nowhere; 429/237 ms and 3.5× labelled with provenance or moved behind the artifact; the program-wide figure-provenance lint added to change 1 scoped to `openspec/changes/v1.0.0-sqlite-*/**` + `docs/**`, keyed to the artifact id scheme, which change 1 must also define (oe gap 7) | Change 1 (lead); changes 3/4/5 consume the envelopes | Each of B-3/4/5/8 has a written selection rule an implementer can apply mechanically; the lint runs in CI and passes; no spec SHALL preordains a numeric measurement outcome | In flight — **must close before change 1 task 0 (the measurement) executes** |
| R-7 | opus-compliance M-1 and M-2 | Changes 4 and 2 | — | **CLOSED** (coordinator-verified: `007_writer_generation` prefixed/`STRICT`/named constraints + seed row with unseeded negative control; ninth MODIFIED requirement, 9/9 headers byte-exact, `comm -12` empty). Recorded per instruction; not re-derived. |
| R-8 | **Task-level integration schedule (F-7).** One tranche graph: naming layer → engine seam → registry (single owner resolved between c1 task 2.3 and c4 task 2.4) → DDL → dependent tasks; published in change 1's register | Coordinator + change 1 | Every cross-change task dependency appears in the graph; no cycle at task granularity; registry has exactly one building owner | In flight (before any DDL-writing task starts) |
| R-9 | **Wording: consumers and cost (F-8).** "No consumers" → "no known external consumer; git-tag installs unobservable"; "cheap/free pre-tag" → "SemVer-permitted; operational cost unknown" except schema `:415`'s no-shipped-SQLite-databases claim, which stands; c4 task 0.3's consumer question elevated to a named RC gate | All five (text); coordinator (gate) | Grep for "no consumer" as bare fact returns nothing; RC checklist names the consumer answer | In flight |
| **R-10** | **Dual deadline on `opts.tx` streams (new, from change 2's `listKeys` closure).** A `listKeys` under `opts.tx` is subject to both change 3's transaction hold bound and change 1's iterator idle deadline; both fault (silent truncation excluded either way) but the error identity when both could fire is unspecified | **Change 3** (it owns `faultKind` and frozen error identity — coordinator's read, ratified), with a cross-reference from change 1's iterator spec | Change 3 states the precedence rule (hold bound wins when both are exceeded, or whichever fires first — but *named*), the single error identity, and a scenario pinning it; change 1 references rather than restates it | In flight (before either deadline is implemented) |
| R-11 | opus-evidence M4 (one scenario per normalisation class + source guard for no-direct-bind), M5 (`WITHOUT ROWID` per-table assignment enumerated by change 4; event log's rowid-ness stated by change 2), M6 ("the bound's grace" replaced by the correct sentence already at `spec.md:298-306`) | Changes 1, 4+2, 3 respectively | Each named clause has an observing scenario or enumerated assignment | In flight |
| R-12 | Minor batch (F-12): annotate numeric result codes as C-API values in all three flagged spots; fix `full-chain-storage.md:81` (rides R-1); `ANY` contradiction; bound "fixture wiring"; correct change 5's exclusivity claim (now doubly false after R-7's ninth requirement); reconcile the two Windows obligations (rides R-2(g)); citation nit oc m-6 | Respective owners | Text edits landed | In flight |
| R-13 | Remaining coverage gaps: corruption-response/recovery path specified (quiesce-then-copy as the named recovery if Branch B "no live backup" is taken); DrvFs added to the probe refusal list or excluded with reason; migration-lock object named (oc gap 3); merged-spec Postgres-framing retirement requirement (oc gap 2 — the structural fix that would have prevented M-2's class); data-migration ownership decision (rides R-1's owner question) | Change 5 (most), change 3 (lock), coordinator (routing) | Each gap has an owning requirement or a recorded, reasoned exclusion | In flight |

---

## 6. What the audit panel itself got wrong or missed

1. **Both Opus lanes and the coordinator affirmed the archive scope on quote fidelity instead of
   premise currency.** Twenty-five for twenty-five and twelve for twelve citations "correct" —
   including the archive citation — while the inference every one of those citations was deployed
   to support was false. Citation-integrity checking validates that the text exists, not that the
   repository still agrees with it. The cross-vendor cold seat caught it precisely because it owed
   nothing to the council's framing; the tie-break convention and the cross-vendor lane both earned
   their keep here. Corollary for the next audit brief: scope claims must be re-verified against
   repo HEAD (starting from `package.json` scripts, the de facto wiring registry), not against the
   research corpus.
2. **Codex, symmetrically, never ran anything and it shows.** It missed C1 entirely — it read the
   very sentence at `design.md:221-225` that C1 falsifies, and challenged only its benign-case
   consequence (F-5). It mis-sourced 2.64× as tmpfs when it is the redteam's ext4 figure, rated
   labelled negative controls as load-bearing contamination, and its C2, while right, missed the
   watermarks-cursor leak that makes the coverage question sharp. Its REJECT rests on three
   criticals of which one survives at severity, one merges into a lane-mate's finding at Major, and
   one was independently found deeper by the lane that experimented. The lesson is not that the
   cold seat is weak — it found the single most consequential defect — it is that verdicts scale
   with evidence type: the lane that reads challenges premises; the lane that runs falsifies them.
3. **Nobody connected F-5 to F-2, and the connection changes the fix.** The interleaving task 3.2
   demands ("B registers while A holds") is impossible in the benign case — and is *exactly what
   the fd-close attack produces*. When realized that way, my reproduction shows the acceptance's
   assertion failing in the worst direction: A's transaction is not rejected; it commits and
   destroys B's acknowledged commit. Codex's proposed two-order rewrite is therefore incomplete;
   the test needs the attack as its third, negative-control order (R-4(iii)).
4. **Nobody noticed that opus-compliance's coverage gap 5 and Codex's C1 are the same decision.**
   "What happens to `src/postgres/`?" is unanswerable precisely because `chain-archive-sync/`
   still imports it. One ruling (R-1) closes both; treating them separately would have produced two
   half-fixes.
5. **The panel collectively missed a live guard-killing defect that an author found while closing
   M-1:** change 3's registration was `UPDATE … WHERE id = 1` with no seed row — on an unseeded
   table every statement succeeds, `myGeneration` is undefined, and the guard admits the second
   writer with no attack required. Three audits examined that guard (two experimentally) and none
   caught the unseeded path. Now fixed in `007` with a negative control; recorded here because it
   calibrates confidence in "the panel checked the guard": the panel checked the guard's locking
   premise, not its bootstrap.
6. **`opus-evidence`'s C1 consequence list was right but incomplete in one direction it could not
   see:** the Windows non-applicability (POSIX close bug does not exist under the win32 VFS's
   per-handle region locks), which matters because it routes the fix into change 3's *existing*
   Windows obligation rather than widening it — and because it means the source-guard ban (R-2(c))
   is a portability-neutral remedy.
7. **"No data" for the archive was never re-verified after the CLI landed** — every lane inherited
   it from SYNTHESIS, which verified it before `chain-archive-sync/` existed. It is probably still
   true (no Postgres container exists on this host) but it is now an assumption with an ops entry
   point pointed at it; hence the owner question in R-1.

---

*Re-test artifacts: `/root/fable-adj/{holder.mjs,repro.mjs}`, working directories
`/root/fable-adj/wk-*` (disposable). No repository file was modified; `git status` in
`/root/UDB-sqlite-sprint` remains the five untracked change directories plus author closures.*
