# Adjudication — round 2, Fable tie-break

**Adjudicator:** Fable (Claude, `claude-fable-5`), tie-break seat per the project's audit convention.
**Date:** 2026-07-31.
**Inputs:** all four round-2 seat reports read in full (`codex-cold2.md`, `grok-cold.md`,
`unbriefed.md`, `premise-currency.md`), `AUDIT-BRIEF-2.md`, `SYNTHESIS.md` retractions, round 1
(`audit/fable-adjudication.md`, `audit/fable-r3-ruling.md`), the coordinator's three pre-verified
facts, the seven changes under `/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-*`, and
fresh experiments on the ruled binding (§4; scripts `/root/fable-adj2/t123.cjs`,
`t4-guard.cjs`, `t4b-guard.cjs` — written for this adjudication, on ext4, `better-sqlite3@13.0.2`,
SQLite 3.53.4).

Seat abbreviations: **CX** = codex-cold2 (GPT-5.6 Sol), **GK** = grok-cold (Grok 4.5),
**UB** = unbriefed, **PC** = premise-currency, **CO** = coordinator pre-verification,
**F2** = this adjudication's own re-tests.

---

## 1. Verdict

**APPROVE WITH FINDINGS — seventeen gates (G-1…G-17), eleven of them blocking the area they
govern. The three REJECTs (CX, GK, PC) are overruled; UB's verdict class is adopted, with more
gates than UB asked for.**

The test is the same one applied in round 1, and it must be applied consistently or it is not a
test: REJECT means the plan rests on a premise that must be re-laid and its authors must
re-derive; APPROVE WITH FINDINGS means the defects are enumerable amendments inside the existing
structure. Every confirmed finding in this round — including the four hardest ones, which the
REJECT seats did not find — fails the REJECT test:

- **No design derivation is impeached.** The driver ruling, worker topology, event-log shape,
  lease mechanism, digest regime, archive layout, and migration classes all survive every seat's
  audit. What fails is: text that was ordered corrected and wasn't (G-1/G-2/G-3), one invariant
  lost in prose relay (G-4), one DDL contradiction needing a ruling (G-5, ruled below), and four
  mechanism seams where changes 6 and 7 were bolted onto a five-change sprint without the seams
  being re-swept (G-6…G-11). All are enumerable; all are enumerated below with owners and
  closing conditions.
- **The REJECT votes rest disproportionately on the cheapest defect class.** CX and GK
  each lead with the stale archive text and the mis-scoped grep — real, blocking, and fixable in
  an afternoon of text edits by the owning authors. PC's REJECT adds genuinely new material
  (the second stale comment, the vacuous restore pass, the J9 direction conflict) but its
  blocking core is the same unexecuted-remediation cluster.
- **The panel's own structure is evidence.** The one seat with no brief, no council framing and
  no trap list — the seat with nothing to conform to — judged the plan 85% implementable by an
  outsider and voted APPROVE WITH FINDINGS, *while also finding the four defects that would most
  change what gets built* (the `dg` `CHECK` contradiction, the undefined per-row guard, the
  missing archive writer guard, the snapshot-vs-descriptor-ban collision). When the unanchored
  reader is the most positive and the most productive, the REJECT votes are measuring the
  remediation ledger's execution failures, not the plan's soundness. Both matter; only one is a
  verdict about the plan.

**The teeth, because round 1 earned them:** two round-1 remediation items were declared closed
and are not — R-1's wording adoption (five live stale assertions, one in a delta spec) and R-6's
preordained-233× rewording (`sqlite-engine/spec.md:570`, re-verified §4). Declared closure is
therefore worthless in this project without a pasted transcript. Every gate below closes only on
its stated mechanical condition, run by the coordinator with output pasted into the gate record.
Implementation of a governed area does not begin until its gate's transcript exists.

---

## 2. Deduplicated findings, ranked by whether they change what gets built

One row per defect. "Found by" lists every seat; bold = the seat whose account is the most
complete and should be the fix's reference.

### Tier 1 — would change the built artifact

| # | Defect | Found by | Gate |
|---|---|---|---|
| F-1 | **The per-row guard is cited by four requirements (`engine-core/spec.md:515,534`, `concurrency-lease/spec.md:449`, `design.md:581`) and defined by none.** The ruled binding has no `interrupt` (F2 re-verified), `OMIT_PROGRESS_CALLBACK` is compiled in (F2 re-verified), and the only named mechanism is one design aside (`engine-core/design.md:365-366`). F2's new measurement (§4, T4b): the mechanism works — but **only with a row-dependent argument**; the constant-argument form is hoisted by SQLite (3,000 invocations across 9,000,000 visited rows), so a naively guarded statement is silently unabortable while looking guarded. The guard call must live in the SQL text, falsifying the shim's "query text preserved rather than rewritten" premise (`proposal.md:76`) for every guarded statement. | **UB** (Q4); F2 (hoisting — new) | G-7 |
| F-2 | **The archive database file has no writer-generation guard.** Change 3's non-goal defers registration for the archive file to "its own change"; change 6 is that change and contains no such requirement (F2 re-ran the grep, §4: zero hits). `archive:sync` is a long-running CLI an operator can start twice; the second process is undetected, and every change-6 exclusivity-dependent proof assumes a single writer. | **UB** (Q2); GK (M3.3, as an ownership question) | G-8 |
| F-3 | **The `dg` length `CHECK` flat contradiction.** Change 4 mandates `CHECK (dg IS NULL OR octet_length(dg) = 32)` in migration `009` (`storage-schema/spec.md:766-772`); changes 5 (`release-contract/spec.md:209-210`) and 6 (`chain-archive/spec.md:836-851`) forbid any length `CHECK` in the adding migration. Both cannot hold; a builder must pick. Ruled in §3.1 — F2's T1/T1b decide it empirically. | **UB** (Q1/C1) — sole finder | G-5 |
| F-4 | **"Verified on every read, no opt-out" has a per-row opt-out.** `dg` is nullable, the R-3 drift trigger is one-directional, and `UPDATE t SET dg = NULL` silently and permanently downgrades a row to unverified (F2 T2 demonstrated). The NULL-warn read branch was specified for the backfill world; every v1.0.0 lineage ships with zero backfill, so the branch is dead code that functions only as a corruption-masking path. Ruled in §3.4. | **UB** (§4.2) — sole finder | G-6 |
| F-5 | **Invariant I-4 never reached change 3.** Assigned by `durability-contract/design.md:476` (and repeated by changes 4 and 6), absent from every change-3 artifact; the registration `UPDATE` has no affected-row assertion, recreating the zero-row silent-success class on the guard's own bootstrap. Change 5's task 3.7 acknowledgment criterion is currently unsatisfiable. | CO (verified); **CX** (C1), GK (M1), UB (Q3) | G-4 |
| F-6 | **Change 3's §2.6.2 inheritance table is complete only for the five-change sprint.** Missing rows: change 6's row-lock-removal justification (`chain-archive/spec.md:360-384`) and single-transaction ingest bundle; change 4's cross-process migration lock (`design.md:702-708`); change 7's whole-import write lock (`spec.md:709`). The descriptor precondition string appears in none of those changes; change 3's own spec makes an unqualified claim "a defect in the specification". | **PC** (M-1, the complete enumeration); CX (C2), GK (C3/M4) | G-9 |
| F-7 | **Change 6's snapshot module collides with change 3's build-failing descriptor ban.** `src/sqlite/chain-archive-snapshot.ts` must read snapshot artifacts — which are SQLite database files — from a path-deriving helper inside `src/`, exactly what the ban rejects. Neither change mentions the other. Ruled in §3.3 (part of the archive-exclusivity ruling). | **UB** (Q5) — sole finder | G-10 |
| F-8 | **Change 7's migration digest is contradictory:** change 5 mandates bytes-as-stored, never a re-serialisation; change 7 `spec.md:416-418` mandates "bytes as stored, through one canonicalisation" — an incoherent phrase — while also forbidding a second digest mechanism. Ruled in §3-supplementary (G-11). | **UB** (Q6/C8) — sole finder | G-11 |
| F-9 | **Zero-row/silent-success instance #5: change 6's restore verification passes vacuously on the archive's own stated starting state** (fresh zero-row database; three of four checks assert nothing and report pass). Cousin: change 7's V-ladder has no fixture-non-emptiness scenario. | **PC** (M-3, gap e) — sole finder | G-12 |
| F-10 | **Measurement-gate close rules missing for B-2, B-3a/b, B-4, B-6** — data named, no decision rule that discharges the gate; an implementer cannot tell CLOSED from open. This is the round-1 R-6 pattern in the IDs R-6 did not enumerate. | **GK** (C4/M3); CX (Q1, adjacent) | G-13 |
| F-11 | **Error-code and refusal-contract routing unowned:** change 4's two new non-retryable faults map to none of change 5's four codes; migration-refusal observability (catalog membership, CLI exit code, report schema) is deferred by each of changes 5 and 7 to the other, and both of change 7's supporting citations resolve to unrelated text. | **CX** (Q3.3); UB (Q10) | G-14 |
| F-12 | **Two-file topology undecided:** whether the write queue, poison flag, hold-bound watchdog and transaction-token table are per-handle or per-process is stated nowhere, and change 6 requires two files in one process. | **UB** (Q7); GK (M3.4) | G-15 |

### Tier 2 — truth and process; blocks merge, not design

| # | Defect | Found by | Gate |
|---|---|---|---|
| F-13 | **Five live assertions of the retracted archive premise**, one in a delta spec that would merge false scope text into the spec tree (`durability-contract/specs/release-contract/spec.md:22`), plus change 4's independently false "exported array nothing calls" — while `engine-core/design.md:991` forbids exactly this wording. Includes the known-false acceptance criteria (ch2 N6, ch3 N1, ch5 N1/N7, ch4 P3) and change 6 §14.3's decision to record rather than fix. §14.3 delegation ruled in §3.5. | CO (verified); CX (Q2), **GK (C1)/PC (C-1)** (fullest accounts), UB (C2/C6/C10) | G-1/G-3 |
| F-14 | **The enforcement grep covers changes 1–5 of 7, is already red on the range it covers, has no negative control, and its phrase list misses the inference forms** ("nothing calls", "no consumer", "no runner", "if it is ever wired") that a future author would actually write. | CO (verified); CX, GK (C2), **PC (C-2)** (the phrase-list and negative-control analysis) | G-2 |
| F-15 | **Round-1 R-6 residue:** the preordained "factor of 233" `SHALL` survives verbatim at `sqlite-engine/spec.md:570` (F2 re-verified, §4) despite R-6 ordering its rewording; and change 1's J9 mandates verbatim publication of a 22×/"DROP is slower" directional claim that change 6's second harness measured in the opposite direction and refused to adopt. | **PC** (M-2); GK (M6, the constant, without the ledger link); F2 (the R-6 linkage) | G-13 |
| F-16 | **The cross-change `file:line` citation layer has rotted systemically:** 3 of 4 sampled by UB resolve to the wrong requirement, 2 of 10 by CX, 4 placements by PC (M-5) — and change 6 §14.3's own correction register cites line numbers that no longer match the live hits (`:137/:161` vs live `:148/:176`; F2 observed). Reasoning holds; pointers don't. | **UB** (§4.1); CX (Q3.3), PC (M-5); F2 (§14.3 self-rot) | G-16 |
| F-17 | **Two further stale artifacts no change retires:** the second "not wired" comment at `src/postgres/migrations/chain_archive/index.ts:25-31` (the true origin of change 4's false claim) and `docs/features/full-chain-storage.md:81`. | **PC** (C-3) — sole finder | G-17 |
| F-18 | Minor batch: numeric `(5)`/`(517)` beside normative discriminators (GK M2); "four independent readers" counting one observation four times, one of the four nonexistent (PC M-4; CX minor); change 6's blob negative-control stating the refuted absolute rather than the two-case form (PC m-1); partition-generator deletion attributed to the wrong file (PC m-2); V5b proposal/spec drift (UB Q8/C9); `page_size` change-control unspecified for the one irreversible setting (UB Q9); no sprint index document (UB §3.2.5); `@testcontainers/postgresql` disposition unowned (PC gap c); Windows parity ship/no-ship matrix and "quiesce" undefined (GK M3.5/M3.6); discharged consumer question not propagated (UB C7); brief inventory drift (PC m-3, coordinator's own relay). | various — attribution in each cell | G-17 |

Findings raised and **not sustained**: GK's Q4 "over-engineered ceremony" is noted as advice, not
a defect — its own analysis concedes the ceremony is not where the thin spots are, and no cut it
proposes is load-bearing (do not cut anything before the gates close; ceremony cuts are post-G-1
housekeeping at most). CX's "no distinct fourth stale premise" is a correct null result, not a
finding. UB's §4.3 (coverage-cost pre-commitment vs the unmeasured archive-scale verification
pass) is recorded as a watch item under U-2 of the R-3 ruling, not a gate: the coverage set stays
unconditional per R-3 §1.5(3); if U-2's measurement comes in pathological, that is a new fact for
a new ruling, not a term smuggled back in now.

---

## 3. Rulings on the contested items

### 3.1 The `dg` length `CHECK` — **change 4 is correct; changes 5 and 6 amend; the R-3 ruling's own sentence is amended**

Ruled on fresh evidence (§4, T1/T1b), not on preference:

1. **The stated rationale in changes 5 and 6 is factually wrong.** Their reason — "`NULL` is the
   marker for a digest that has not been computed and a length constraint in the same migration
   would foreclose it" (`chain-archive/spec.md:849-851`) — is false for change 4's form, which is
   explicitly null-tolerant, **and false even for the bare form**: SQL `CHECK` three-valued logic
   passes a NULL result, so `CHECK (octet_length(dg) = 32)` accepts `NULL` too (T1b: measured
   ACCEPTED on this binding). No length `CHECK` of either form forecloses the NULL marker.
2. **Change 4's form is mechanically sound where it must run:** `ALTER TABLE … ADD COLUMN dg BLOB
   CONSTRAINT … CHECK (dg IS NULL OR octet_length(dg) = 32)` is accepted on a populated `STRICT`
   table, rejects a 31-byte digest naming the constraint, accepts 32 bytes and `NULL` (T1).
3. **The constraint earns its place.** A truncated or garbage digest is a real Class-A-adjacent
   defect the constraint makes unrepresentable, which is this sprint's house philosophy, and the
   named-`CHECK` form feeds the single extraction function like every other constraint in
   change 4's regime.
4. **On the R-3 ruling** (mine): its §1.3 sentence "no `CHECK(length(dg)=32)` in the same
   migration as the column" was belt-and-braces protection of the NULL semantics, written without
   the T1b measurement. It is hereby **amended**: the prohibition narrows to *"no constraint that
   rejects a NULL `dg` — no `NOT NULL`, no non-null default"*; the null-tolerant named length
   `CHECK` in change 4's mandated form is **required**, in the adding migration, for both
   lineages. An adjudicator who will not amend his own ruling on new measurement is running the
   panel's anchoring failure at the top of the stack.

**Edits:** change 5 `release-contract/spec.md:209-210` and change 6 `chain-archive/spec.md:836-851`
(requirement + both scenarios) rewritten to the amended rule; change 4 unchanged. → G-5.

### 3.2 The archive writer-generation guard — **genuine safety hole; it is change 6's, by change 3's own words**

Change 3 committed the program to it: *"the archive file, if it is ever wired, gets its own
registration under its own change."* Change 6 is that change; the wiring premise is not
counterfactual (that was G-1's whole lesson); and the grep is empty (§4). The hole is real, not
theoretical: `archive:sync` is a standalone long-running CLI; two instances interleave `BEGIN
IMMEDIATE` transactions legally — SQLite serializes transactions, it does not make a process a
single writer — so every change-6 argument phrased as "single-writer serialization" (including
the row-lock-removal justification at `spec.md:360-384`) silently assumes a property nothing
enforces or detects, and the fd-close attack surface has no source-guard coverage on the archive
paths at all.

**Ruled:** change 6 adds, as normative requirements in its own spec and a migration in its own
lineage: (a) a `writer_generation` table mirroring change 3's mechanism — seeded row, registration
bump, generation check per transaction, **with the I-4 assertions (`changes === 1`, defined
read-back) from day one** so the archive does not re-import the wallet's bootstrap defect; (b) the
change-3 source-guard extended to the archive database file and its `-wal`/`-shm` sidecars,
including indirect path construction. Change 3 adds the corresponding inheritance-table row (part
of G-9) and its non-goal is reworded to a handover-record naming change 6. Ownership is exactly
one change: **change 6 owns the guard; change 3 owns the table row and the mechanism it is
mirrored from.** → G-8.

### 3.3 The per-row guard — **must exist as a change 1 normative requirement; the mechanism is real, and it has a sharp edge nobody knew about**

The mechanism is not vapor: F2's T4b shows a guard UDF polling a `SharedArrayBuffer` flag aborts a
row-visiting statement ~1 ms after the flag flips, matching the L3 figure change 1's design cites.
But two things the sprint does not say are now measured facts:

1. **The guard call must be row-dependent or it does not guard.** With a constant argument,
   SQLite invokes the UDF once per *outer-loop* row — 3,000 invocations across 9,000,000 visited
   rows — even registered non-deterministic. A statement "guarded" with `WHERE udb_guard() = 1`
   is silently unabortable at any useful granularity while every test that uses a row-dependent
   form stays green. This is the sprint's silent-success shape, in the cancellation mechanism
   itself.
2. **The guard call lives in the SQL text.** Therefore the shim premise — "~190 call sites port
   with query text preserved rather than rewritten" (`engine-core/proposal.md:76`) — is false for
   every guarded statement.

**Ruled — what must exist, all owned by change 1:** a requirement defining the guard: UDF name,
non-deterministic registration, the SAB protocol, the **row-dependent-argument rule with the
hoisting measurement as its negative control**, and the enumerated statement classes that carry it
(guard injection is the **shim's** job — call sites still do not rewrite their text; the shim
does, and the proposal's premise is amended to say so). The statement-deadline requirement
(`spec.md:510-512`) is re-scoped honestly: in-flight enforcement for guarded statements;
detection-at-completion with a typed after-the-fact fault for the enumerated unguarded classes —
the current unconditional "SHALL enforce… inside the worker" contradicts its own uncancellable
enumeration two sentences later. Change 3 cross-references (hold bound), change 1's stream idle
deadline cross-references; neither restates. → G-7.

**And the snapshot half (F-7), ruled with it:** change 6's snapshot module is **out-of-process**.
The descriptor ban is the load-bearing remedy for the R-2 attack and takes no exemptions; a
manifest/verification tool that opens database files belongs beside `archive:sync` as a CLI
(outside `src/`, e.g. a `tools/` or `chain-archive-sync/`-style track), operating post-quiesce or
on the finished artifact only — which also makes it consistent with change 5's out-of-process copy
procedure instead of in tension with it. Change 6 states this placement in its spec; the ban's
scope is not weakened. → G-10.

### 3.4 Verify-on-read versus `dg` nullability — **the guarantee is real against configuration and unreal against one UPDATE statement; both halves get fixed, and the R-3 ruling is amended again**

UB is right on both counts and T2 proves the sharp half: with the R-3 drift trigger installed
verbatim, `UPDATE t SET dg = NULL` is ACCEPTED — one statement, no covered-column touch, row
permanently downgraded to unverified, only signal a once-per-process warning at some future read.
The "no opt-out" requirement (`release-contract/spec.md:331-341`) is true of flags and
false per-row, and its own text ("no term whose value could make the coverage set conditional")
indicts the nullable column it coexists with.

**Ruled, amending R-3 §1.3:**

1. **Anti-downgrade trigger, mandatory per covered table, both lineages:** `BEFORE UPDATE OF dg …
   WHEN NEW.dg IS NULL AND OLD.dg IS NOT NULL → RAISE(ABORT, …)`. T2: works with no UDF, does not
   obstruct legitimate recompute, and cannot obstruct backfill (backfill only ever writes
   NULL→value). Owner: change 5 (requirement), change 4 and change 6 (DDL in their lineages).
2. **In a lineage with no backfill — which is every v1.0.0 lineage, by R-3's own statement and
   change 6's greenfield scenario — a NULL `dg` on a covered row is `VALUE_INTEGRITY`, not a
   warning.** The warn branch was specified for a mid-backfill world that v1.0.0 ships without;
   as shipped it is dead code whose only reachable function is masking corruption or the
   downgrade in (1). The warn semantics are reinstated only by a future change that actually
   ships a backfill, as part of that change. Change 7 already ruled NULL-after-import an import
   defect; this makes the steady state consistent with it. → G-6.

### 3.5 Change 6 §14.3's delegation — **not acceptable**

Recording a list of known-false normative statements in four sibling changes, declining to fix
them out of authorial courtesy, and tracking the correction only as a later grep by a non-owner is
a defect-handling pattern this project has already watched fail once: it converts a known defect
into a hoped-for detection, and the detector (J3) is mis-scoped, already red, and blind to the
inference forms (F-14). Worse, the four owning changes still carry the false statements as
**acceptance criteria** — a reviewer ticking ch5's N1/N7 certifies a statement two changes in the
same sprint prove false. A gate that certifies a falsehood is worse than no gate.

**Ruled:** ownership etiquette governs *who edits*, never *whether known-false text ships*. The
four owning changes make their own edits (G-1/G-3 assigns them by name); §14.3 then converts from
open register to closed record; and the general rule is added to change 1's register: **a change
that discovers false text in a sibling files the finding against the sibling's tasks.md — the
owner edits, but the obligation lands in the owner's artifact at discovery time, not in the
discoverer's design notes.** That last clause is the structural fix for how I-4 was lost, and it
is a gate condition, not advice (G-4's closing condition includes it). Note also that §14.3's own
citations have already line-rotted — registers rot; owners' edits are the only stable fix.

---

## 4. What I re-tested, with commands and output

All run on WSL Ubuntu-26.04, `/root` (ext4), Node v24.18, `better-sqlite3@13.0.2` from
`/tmp/l3-bs3b` (no `npm install`), scripts fresh for this adjudication. Coordinator-verified facts
(five stale-archive hits, grep scope, I-4 absence from change 3) were built on, not re-run, per
instruction — except where a ruling needed its own transcript.

**T1/T1b/T2/T3 (`/root/fable-adj2/t123.cjs`):**

```
$ wsl -e bash -lc 'cd /root/fable-adj2 && node t123.cjs'
driver: better-sqlite3 13.0.2 / SQLite 3.53.4

=== T1: ADD COLUMN dg BLOB with null-tolerant named CHECK, populated STRICT table ===
ALTER TABLE ADD COLUMN with named null-tolerant CHECK: ACCEPTED
insert dg=NULL          : ACCEPTED
insert dg=31 bytes      : REJECTED -> CHECK constraint failed: s_kv_dg_len
insert dg=32 bytes      : ACCEPTED
update dg -> NULL       : ACCEPTED

--- T1b: is even the BARE length CHECK null-intolerant? (changes 5/6 stated rationale) ---
bare CHECK, insert NULL : ACCEPTED    [SQL CHECK semantics: NULL result = pass]
bare CHECK, 31 bytes    : REJECTED -> CHECK constraint failed: octet_length(dg) = 32

=== T2: drift guard vs UPDATE t SET dg = NULL (silent verification downgrade) ===
update value, same dg   : REJECTED -> digest not recomputed for updated value
UPDATE kv SET dg = NULL : ACCEPTED    <- row silently downgraded to permanently-unverified
dg after                : null
with anti-downgrade trg : REJECTED -> digest downgrade to NULL forbidden
legit dg recompute      : ACCEPTED

=== T3: interrupt / progress-callback availability ===
Database.prototype: aggregate backup close constructor defaultSafeIntegers exec explain function
loadExtension pragma prepare serialize table transaction unsafeMode
has interrupt: false
OMIT_PROGRESS_CALLBACK compiled: [ 'OMIT_PROGRESS_CALLBACK' ]
```

T1 decides §3.1 (change 4's form is mechanically sound end to end, including on `ADD COLUMN`
against a populated `STRICT` table); T1b falsifies changes 5/6's stated rationale even for the
bare form; T2 proves UB's downgrade attack and validates the anti-downgrade trigger fix; T3
independently confirms UB's binding claims.

**T4/T4b (`t4-guard.cjs`, `t4b-guard.cjs`) — the guard mechanism itself:**

```
$ wsl -e bash -lc 'cd /root/fable-adj2 && node t4-guard.cjs'
worker result: {"outcome":"COMPLETED (not aborted)","c":9000000,"ms":53}
```

9M rows in 53 ms means the row-independent guard was not invoked per row. Instrumented rerun:

```
$ wsl -e bash -lc 'cd /root/fable-adj2 && node t4b-guard.cjs'
P1: {"phase":"P1","form":"udb_guard(0) constant arg","rows":9000000,"invocations":3000}
P2: {"phase":"P2","form":"udb_guard(a.id+b.id) row-dependent","rows":900000,"invocations":900000}
P3: {"phase":"P3","outcome":"ABORTED","err":"UDB_ABORTED","ms":101,"invocations":1168931}
```

P1: constant-argument guard hoisted to once per outer-loop row (3,000 of 9,000,000) despite
non-deterministic registration. P2: row-dependent argument invoked exactly once per visited row.
P3: main-thread flag at +100 ms; statement aborted at 101 ms after 1.17M rows — ~1 ms cancellation
latency, corroborating change 1's L3 citation. Grounds §3.3's row-dependent-argument rule and its
negative control.

**Spec-text confirmations (all pasted from live files this session):**

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint/openspec/changes &&
    sed -n "565,575p" v1.0.0-sqlite-engine-core/specs/sqlite-engine/spec.md'
  ... THEN WAL synchronous=FULL commit throughput SHALL be seen to differ by a factor of 233 ...
```
The round-1 R-6 rewording order is unexecuted (F-15).

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-sprint/openspec/changes &&
    grep -rn "writer.generation\|writer_generation" v1.0.0-sqlite-chain-archive/ ; echo rc=$?'
rc=0        (no output — zero hits)
```
F-2 confirmed against the live tree.

Also read in situ and quoted in §2/§3: `storage-schema/spec.md:760-800` (change 4's `dg`
requirement and ALTER scenario), `release-contract/spec.md:200-240` and `:325-350` (change 5's
prohibition, NULL-warn branch, no-opt-out requirement), `chain-archive/spec.md:830-860` (change
6's prohibition and greenfield scenario), `data-migration/spec.md:405-425` (canonicalisation
sentence), `chain-archive/design.md:1242-1290` (§14.3, whose own citations are line-rotted),
`engine-core/spec.md:505-522`, `design.md:360-370`, `:712-720`, `proposal.md:72-80` (per-row-guard
corpus).

---

## 5. The ordered remediation list

Execution order. **Blocking** = the governed area's implementation does not start until the gate's
closing transcript is pasted into the gate record by the coordinator. **In-flight** = fix during
implementation, before the named dependent task executes. Ownership rule for every row: the
obligation is recorded in the **owner's own tasks.md** at gate-open time — never only in a
neighbour's design document.

| # | Defect | What must change | Owner | Closing condition (mechanical) | Blocks |
|---|---|---|---|---|---|
| **G-1** | Stale archive premise, 5 live locations + ch4's "nothing calls" (F-13) | Each owner rewrites its own text to R-1's wording ("owned by change 6, not by this change"); the delta-spec hit at `release-contract/spec.md:22` first | ch2, ch3, ch4, ch5 (each its own files) | G-2's widened grep returns zero non-correction hits; transcript pasted | **BLOCKING — sprint-wide** (delta spec would merge false text) |
| **G-2** | Enforcement grep mis-scoped, red, uncontrolled (F-14) | J3 + task 0.5b rescoped to all seven directories; phrase list gains the inference forms ("nothing calls", "no consumer", "no runner", "if it is ever wired"); negative-control scenario added (grep demonstrably fires on a planted phrase) | ch1 | Amended J3 text present; control fires; clean run transcript pasted | **BLOCKING — with G-1** |
| **G-3** | Known-false acceptance criteria (F-13) | ch2 N6, ch3 N1, ch5 N1/N7, ch4 P3 + task 0.3, ch1 D5/J10 Form-B language rewritten to true statements; §14.3 converted to closed record | each owning change | No acceptance row asserts a statement refuted elsewhere in the sprint; §14.3 marked closed | **BLOCKING — with G-1** |
| **G-4** | I-4 absent from change 3 (F-5) | Normative requirement in ch3's spec: registration asserts `changes === 1` **and** a read-back matching the written owner/generation; failure = named non-retryable startup error; negative control (either assertion removed → undefined-generation silent success must be demonstrated failing); ch3 tasks.md row added; ch5 task 3.7 acknowledgment then satisfiable. Plus the general relay rule of §3.5 added to ch1's register | ch3 (requirement); ch1 (relay rule) | `grep -rn "I-4" v1.0.0-sqlite-concurrency-lease/` hits a requirement + scenario + tasks row; transcript pasted | **BLOCKING — change 3** |
| **G-5** | `dg` `CHECK` contradiction (F-3) | Per §3.1: ch5 `:209-210` and ch6 `:836-851` rewritten to the amended rule (prohibit only null-rejecting constraints; require the named null-tolerant length `CHECK`); ch4 unchanged; R-3 amendment noted in ch5's design | ch5, ch6 | The three passages agree; ch6's rationale sentence deleted | **BLOCKING — change 4 migration 009** (cheap; do with G-1 batch) |
| **G-6** | NULL downgrade / dead warn branch (F-4) | Per §3.4: anti-downgrade trigger requirement (ch5) + DDL (ch4 `009`, ch6 lineage); NULL-on-covered-row = `VALUE_INTEGRITY` in no-backfill lineages; warn branch re-scoped to future backfill changes | ch5 (lead), ch4, ch6 | Trigger requirement + scenarios exist in all three; no-opt-out requirement's text no longer contradicted by the NULL branch | **BLOCKING — change 5 digest tasks** |
| **G-7** | Per-row guard undefined; hoisting hazard; shim premise; deadline over-claim (F-1) | Per §3.3: guard requirement in ch1 (name, registration, SAB protocol, row-dependent-argument rule + hoisting negative control, statement classes, shim-injects); `proposal.md:76` amended; deadline requirement re-scoped guarded/unguarded; ch3 hold bound + stream idle deadline cross-reference | ch1 (lead), ch3 (cross-ref) | "per-row guard" resolves to exactly one defining requirement; the hoisting negative control cites the P1/P2 transcript; C10 enumeration consistent | **BLOCKING — change 1 worker implementation** |
| **G-8** | No archive writer guard (F-2) | Per §3.2: `writer_generation` in the archive lineage with I-4 assertions from day one; source-guard extended to archive db/`-wal`/`-shm`; ch3 non-goal reworded to a handover record | ch6 (guard + migration), ch3 (handover text) | `grep writer_generation v1.0.0-sqlite-chain-archive/` hits requirement + migration + scenario; dual-`archive:sync` scenario exists | **BLOCKING — change 6** |
| **G-9** | Inheritance table incomplete; precondition unpropagated (F-6) | §2.6.2 gains rows for ch4 migration lock, ch6 row-lock-removal + ingest bundle, ch7 import lock; each listed claim's own spec text carries the descriptor-precondition qualifier; B3h re-scoped | ch3 (table), ch4/ch6/ch7 (their own qualifier text) | Every exclusivity-resting claim PC enumerated carries the qualifier in the owning file; table row count matches | **BLOCKING — before ch4/6/7 concurrency scenarios are implemented** |
| **G-10** | Snapshot module vs descriptor ban (F-7) | Per §3.3: ch6 states the module is out-of-process (outside `src/`), post-quiesce/finished-artifact only; ban unweakened | ch6 | Placement stated in ch6's spec; ch3's ban text untouched | **BLOCKING — change 6 snapshot tasks** |
| **G-11** | Migration digest contradiction (F-8) | Ruled: **two artifacts.** `dg` = change 5's preimage over the exact bytes SQLite stores post-import, no canonicalisation, persisted. The V-ladder source↔target fidelity comparison = a **non-persisted comparison over canonically parsed values**, named distinctly (it is a transport check, not a digest mechanism, so ch7's second-mechanism negative control is not violated); `spec.md:410-418` rewritten to say exactly this | ch7 (text), ch5 (one cross-ref) | The phrase "bytes as stored, through one canonicalisation" no longer exists; both artifacts named and scoped | **BLOCKING — change 7 fold/verification implementation** |
| G-12 | Vacuous restore/verify pass (F-9) | Empty-scope checks report `n/a — no rows in scope`, never `pass`; scenario: zero-row restore does not report overall pass (copy ch5 `:1038`'s pattern); ch7 fixture-non-emptiness scenario | ch6, ch7 | Both scenarios exist; ch6's four checks each state their empty-scope behaviour | In flight — before restore-verification tasks |
| G-13 | Close rules missing; R-6 residue (F-10, F-15) | One-line B-1-shaped decision rules for B-2, B-3a/b, B-4, B-6; `spec.md:570`'s 233 `SHALL` reworded per round-1 R-6 (range or order-of-magnitude); J9 keeps the `auto_vacuum` structural claim, drops/attributes the direction per ch6's M-4 | ch1 | Each named B-id has inputs→exclusive-outcomes rule; no numeric `SHALL` preordains a measurement | In flight — **must close before the measurement suite runs** |
| G-14 | Error/refusal routing unowned; failed citations (F-11) | ch5 routes ch4's two faults (new rows or named existing codes with rationale); ch5 rules catalog membership for migration-tool failures; ch7 then specifies CLI exit code + report schema; the two dangling citations repointed | ch5 (lead), ch4, ch7 | Both ch4 faults resolve to named codes; refusal contract has one owner per layer; citations resolve | In flight — before catalog freeze |
| G-15 | Two-file topology (F-12) | ch1 states the factory/worker is per database file; ch3 states lease, write queue, poison flag, watchdog, token table scope (per-file), ch6 consumes by reference | ch1, ch3 | One requirement answers UB's Q7 list item-by-item | In flight — before ch3 implementation |
| G-16 | Citation rot (F-16) | Cross-change citations converted to requirement-title anchors (titles do not rot) or refreshed with a CI resolution check; §14.3's list corrected in passing | all owners; coordinator (CI check) | Sampled citations (UB's four, CX's two, PC's four) resolve; check runs green | In flight |
| G-17 | Minor batch (F-17, F-18) | Retire `chain_archive/index.ts:25` comment + `full-chain-storage.md:81` (rides ch6 deletion + a doc task with an owner); numeric-code annotations; four-readers sentence corrected; two-case blob scenario fixed (ch6 W5 + tasks); partition-generator attribution; V5b proposal aligned; `page_size` change-control statement (pinned per-lineage, recorded, revision = new lineage decision); sprint index document (reading order + dependency table, promoted from ch1 `design.md:924-930`); testcontainers disposition owner; Windows ship/no-ship matrix; "quiesce" operationalized (ch3 hands ch5 a definition: no open write transaction + all handles closed, or process exit) | respective owners per cell | Text edits landed; strict validation green | In flight |

Estimated blocking-gate cost: G-1/G-2/G-3/G-5 are text-day work; G-4/G-6/G-10/G-11 are
spec-writing days; G-7/G-8/G-9 are the real work — roughly a week of author time total, against a
20,000-line plan whose derivations survived four seats. That asymmetry is the verdict.

---

## 6. What the panel itself missed, and what it implies

**What none of the four seats did:**

1. **Nobody ran a single SQL statement.** Four seats, two vendors, ~40 minutes of aggregate
   wall-clock, and every finding was produced by reading and grepping. The round-1 adjudication's
   central lesson — "the lane that reads challenges premises; the lane that runs falsifies
   them" — was written into this project's record and no round-2 seat acted on it. The three
   contested rulings above (§3.1, §3.3, §3.4) were all decidable only by execution, and all three
   executions produced surprises: the bare `CHECK` passes NULL (falsifying two changes'
   rationale), the guard hoists on constant arguments (a silent-success hole in the cancellation
   mechanism itself), and the downgrade trigger fix works. UB got closest — it read the binding's
   `database.js` — but read it rather than running it.
2. **Nobody audited the remediation ledger against the corpus.** R-6 ordered the 233×
   `SHALL` reworded in round 1; it sits there verbatim. GK flagged the constant as bad practice
   without noticing it was *already-adjudicated, unexecuted remediation* — a much stronger fact.
   The R-1 adoption failure is the same class. The declared-vs-done gap is this project's most
   reliable defect generator and no seat was pointed at it or found it on its own.
3. **Nobody checked the correction registers themselves for rot.** §14.3's line citations are
   already stale. A register that decays is worse than none, because it is trusted.
4. **Nobody priced the anchoring.** The two briefed cross-vendor seats' critical sections are,
   almost line for line, the brief's "verify closure of R-1/R-2/R-3" instructions executed
   competently. Valuable — closure verification failed and they caught it — but between them they
   produced **zero** findings that change a built artifact's shape. All four such findings came
   from the seat that received nothing but the repo. The brief's "failure modes specific to this
   round" section functioned as a findings menu, and three seats ordered from it.

**What it implies for the next review:**

- **Field at least two unbriefed seats, different vendors,** and treat divergence between them as
  signal. Give briefed seats the trap list (paths, CLI stubs, tmpfs — mechanics) but **not** the
  expected-findings frame; closure verification of named gates is a *separate, mechanical,
  coordinator-run check* with pasted transcripts, not an audit seat's creative budget.
- **One seat's entire mandate: the remediation ledger.** Every R-item and G-item from every prior
  round, checked declared-vs-done against the live tree, no other duties.
- **One seat must run things.** Reserve a seat whose report is inadmissible unless it contains
  executed transcripts against the ruled binding. This round that seat would have found the
  hoisting hazard before the adjudicator did.
- **Gate closure discipline (already ordered in §1):** no gate is "closed" by assertion again.
  The G-list above closes on transcripts or not at all.

---

*Re-test artifacts: `/root/fable-adj2/{t123.cjs,t4-guard.cjs,t4b-guard.cjs,t.db,t4.db}`
(disposable). No repository file was modified; `git status --porcelain` in `/root/UDB-sqlite-sprint`
remains the seven untracked change directories. Rulings in §3 amend the R-3 ruling in two named
places (§3.1, §3.4); `audit/fable-r3-ruling.md` stands as amended by this document.*
