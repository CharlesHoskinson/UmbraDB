# Round-2 audit — seat `grok-cold` (cross-vendor, xAI Grok)

**Seat:** `grok-cold` — cross-vendor seat of the four-seat round-2 panel.
**Reviewer:** Grok 4.5 via the official xAI Grok CLI (`/root/.local/bin/grok`, OAuth, grok.com login).
**Verdict:** REJECT.
**Run:** 2026-07-31T22:08:47Z → 22:11:58Z UTC (191 s), exit 0, read-only.

Everything from `## 1. Verdict` to the end of section 6 below is Grok's output, reproduced verbatim
from `audit2/.grok-stdout.log`. The harness did not write, edit, summarise, or reorder any finding.
Harness notes are appended at the end under a separate heading.

---

## 1. Verdict

**REJECT** — Grok (xAI), cross-vendor seat.

The seven changes are structurally valid OpenSpec artifacts with real post–round-1 learning (driver string discriminators, two-case corruption wording, clock decision rule, Class 1/2 migration refusal, source-guard / inheritance-table machinery). That is not enough to approve. Post-remediation still leaves **uncorrected false premises about the chain archive** inside multiple normative/non-goal documents, an **enforcement grep scoped to changes 1–5 that would not even cover changes 6–7 and currently fails its own zero-hit criterion**, an **incomplete inheritance table** that omits change-6 single-writer justifications, and **measurement-gate decisions without written close rules** for several blocked IDs. Implementers and later authors will still inherit stale “out of scope / not wired” framing. Fix the critical and major items below, then re-audit; do not start product code from this corpus as-is.

**Q1:** Not fully implementable as written — named open questions below.  
**Q2:** Yes — fourth-class issue is surviving textual traces of retracted premise (a); citations often quote accurately while conclusions do not follow.  
**Q3:** Yes — remediation defects (grep scope, stale non-goals, inheritance-table hole, I-4 under-specification).  
**Q4:** Over-engineered in ceremony and document volume; under-protected in a few load-bearing tables/rules.  
**Q5:** Refuse approval until critical findings close; refuse any PR that treats tmpfs figures as product facts or adds a BUSY error code.

---

## 2. Critical findings

### C1. Surviving retracted premise (a): “chain archive out of scope / not wired” still asserted as fact
**Q2 / Q3**

| Change | File:line | Problem |
|---|---|---|
| `v1.0.0-sqlite-schema-parity` | `proposal.md:172-176` | Non-goal: “The chain archive is out of scope” + verbatim “Not wired…” as if true |
| `v1.0.0-sqlite-temporal-event-log` | `proposal.md:148-151` | **Worse:** “out of scope **for the entire program**” |
| `v1.0.0-sqlite-concurrency-lease` | `proposal.md:176-180` | “out of scope, entirely” + quote of `:86` |
| `v1.0.0-sqlite-durability-contract` | `proposal.md:196-199`, **`specs/release-contract/spec.md:22-24`** | Same false premise in a **delta spec** |
| `v1.0.0-sqlite-schema-parity` | `design.md:435` | “The chain archive is out of scope (`proposal.md` non-goals)” |

**What is wrong:** Round-2 already retracted “archive unwired.” Wiring is real:

- `package.json:46` — `"archive:sync": "tsx chain-archive-sync/sync-cli.ts"` (**HELD**)
- `chain-archive-sync/sync-cli.ts:38` — `await bootstrapChainArchiveSchema(...)` (**HELD**)
- `chain-archive-sync/bootstrap.ts:21` — `runMigrations(..., chainArchiveMigrations)` (**HELD**)
- `chain-archive-sync/sync-service.ts:123` — `PgChainArchiveStore` (**HELD**)

The quote at `001_chain_archive_core.ts:86` is real (**HELD as quotation**); the **inference that nothing runs it is false**. Change 1’s own register says no change may still say the archive is out of scope (`engine-core/design.md:991`).

**What the plan should say instead:** Non-goals may only say “this change does not port archive DDL/sync; ownership is `v1.0.0-sqlite-chain-archive`.” Correction notes may quote the stale comment *as stale*. Specs must not restate the false program-level non-goal.

**Evidence:** `rg -n 'chain archive is out of scope|Not wired into any runner' openspec/changes/v1.0.0-sqlite-*/` hits the rows above; wiring citations verified by `nl -ba` on the four paths.

---

### C2. Enforcement grep still covers changes 1–5 only — and would fail even on 1–5 today
**Q3**

- `v1.0.0-sqlite-engine-core/tasks.md:81-83` — greps “the five changes”
- `acceptance.md` **J3** — “Grepping **changes 1–5** for the refuted phrases … returns zero hits outside an explicit correction note”

**What is wrong:** There are **seven** changes. Phrase hits in change-6/7 directories would be invisible to J3. Worse, **current hits inside 1–5 are not correction notes** — they are live non-goals (C1). So the gate as written is both too narrow and already red if honestly applied.

**What the plan should say instead:** Grep **all seven** change directories (or the whole `openspec/changes/v1.0.0-sqlite-*` tree); allow hits only under an explicit `CORRECTION:` / “Status: refuted” block; fail CI on any other hit. Fix C1 first so the gate can pass.

---

### C3. Inheritance table incomplete: change-6 single-writer claims not listed
**Q3**

`v1.0.0-sqlite-concurrency-lease/design.md` **§2.6.2** enumerates six claimants (displaced writer, ordering 2, migration lock, prune C2a, T5 concurrent soundness, transaction-identity forgery).  

**Missing load-bearing claim:**  
`v1.0.0-sqlite-chain-archive/specs/chain-archive/spec.md:360-384` — PostgreSQL `FOR SHARE`/`FOR UPDATE` removal is “justified by single-writer serialization under `BEGIN IMMEDIATE`” and depends on write-lock exclusivity discharging the two-session interleaving at `001_chain_archive_core.ts:605-654` (**citation content HELD**).

That is exactly the class §2.6.2 exists for. Omitting it means archive authors (and reviewers) can treat exclusivity as unconditional while change 3’s table pretends to be complete.

**What the plan should say instead:** Add a row: “Archive blob-role / removal / finalized-monotonicity guards without row locks | change 6 | concurrency proof discharged only while `BEGIN IMMEDIATE` exclusivity holds (+ descriptor precondition).” Every change-6 scenario that rests on exclusivity must carry the same qualifier as change 2’s corrected T5 text.

---

### C4. Measurement gate is real for some decisions, decorative for others (no written close rules)
**Q1 / Q3**

Gate structure is genuine: artifact conditions, CI anti-tmpfs, blocked-decision register B-1…B-8 (`engine-core/design.md:809-870`, `specs/sqlite-engine/spec.md:540-610`). Change 2’s clock rule is a model decision rule (`temporal-event-log/design.md:638-665`: **IF R=0 → no clock; IF R>0 → (a) or (b)**).

**What is wrong:** Several blocked decisions name a *datum* but not a *rule that discharges the gate unambiguously*:

| ID | Gap |
|---|---|
| **B-2** | `synchronous` FULL vs NORMAL — no product threshold, latency budget, or durability/throughput decision procedure |
| **B-4** | “acceptability” of ~110 µs/statement amplification — no accept/reject criterion |
| **B-3a/b** | page_size / auto_vacuum — no scoring rule once ext4 numbers exist |
| **B-6** | backup() vs VACUUM INTO — “remeasure and pick” without stated selection criteria |

An implementer cannot tell when B-2/B-4 are **CLOSED** vs still open. That stalls change 3 numbers and change 5 probe expectations even after the artifact exists.

**What the plan should say instead:** For each B-id, a one-line rule of the same shape as B-1/R (inputs from artifact → exclusive outcomes). Until then, label those rows “structure-only; values forbidden,” and forbid shipping defaults by assertion.

---

## 3. Major findings

### M1. I-4 under-specified relative to the global invariant register
**Q3**

Change 5’s register (`durability-contract/design.md:474` area / §2.9 table):  
**I-4** = “writer registration asserts a **single affected row** and a defined read-back; failure is a startup error, not an undefined generation” — owner change 3.

Change 3’s design SQL (`concurrency-lease/design.md:220-250`) is `UPDATE … WHERE id = 1` + `SELECT` with **no** `changes() === 1` / empty-read-back failure path in the normative requirement text. Spec focuses on generation mismatch after successful registration, not on unseeded/zero-row registration.

**Risk:** classic zero-row silent path if the seed row is missing — related to known UPDATE zero-row class, now packaged as a named invariant that the owner change does not fully specify.

**Should say:** Normative scenario: unseeded `writer_generation` → registration fails startup (non-retryable); `UPDATE` with `changes()≠1` is failure; negative control without the check leaves generation undefined and must fail the test.

---

### M2. Residual numeric result-code form in a corrected normative passage
**Q3 / check A**

`v1.0.0-sqlite-temporal-event-log/specs/temporal-kv/spec.md:566-567` still writes  
`SQLITE_BUSY` **(5)** and `SQLITE_BUSY_SNAPSHOT` **(517)** in the correction of the “three independent ways” claim.

Ruled binding is string `err.code` (`concurrency-lease/design.md:1007-1015` measured shape). Parentheticals re-smuggle the `node:sqlite` / coordinator numeric form into a **spec**.

**Should say:** string names only; if historical numerics appear, only inside a labelled “research corpus, inadmissible” note — never beside normative discriminators.

---

### M3. Implementability gaps (concrete questions the plan should have answered)
**Q1**

1. **B-2 close rule** — FULL vs NORMAL: which artifact cells, which max commit latency / min durability claim decides? (`engine-core/design.md:851` names the trade, not the rule.)  
2. **B-4 close rule** — when is worker amplification “acceptable”? (`design.md:854`, change 3 D-3.)  
3. **Archive vs wallet write-lock inheritance** — does change 6’s archive file get its own writer-generation / source-guard instance, or only wallet? Change 3 non-goal says archive “gets its own registration under its own change” (`concurrency-lease/proposal.md:179-180`) while change 6 only cites `BEGIN IMMEDIATE` — which document owns archive-side exclusivity + descriptor ban?  
4. **Worker vs in-process for change 6/7 tools** — migration CLI and `archive:sync` hold long write locks (`data-migration` long-import note); is the engine worker mandatory for CLIs, or is a same-process better-sqlite3 handle allowed with an explicit exception? Not findable as a single ruling.  
5. **Windows I-4 / source-guard** — change 3 requires Windows parity before strengthened contract ships (`transaction-lease/spec.md:786+`) but does not define the ship/no-ship matrix if parity fails.  
6. **Quiesce definition for backup** — change 3 hands change 5 “out-of-process or post-quiesce”; “quiesce” is not operationalized (no open txs? handles closed? process-level?).

---

### M4. Over-claim shape: table completeness claims without coverage of archive
**Q3 / check E (fourth of this shape)**

§2.6.2 presents itself as “everything that inherits this precondition.” Change 2 correctly rewrote “three independent ways” → one mechanism. The **fourth** over-claim is meta: an enumeration sold as complete while change-6 exclusivity-dependent guards are outside it (C3). Same failure class as counting observations as independent mechanisms — **counting listed dependents as all dependents**.

---

### M5. Ceremony can hide thin product decisions
**Q4 (inverse)**

Heavy negative-control culture is good for the zero-row / descriptor-close classes. The thin spots are not more scenarios — they are **missing close rules (C4)** and **stale cross-change premises (C1)**. Ceremony (acceptance matrices mirroring tasks, multi-file restatement of the same corrected TOCTOU paragraph, citation webs to §2.6.2) did not catch C1/C2.

---

### M6. Contaminated numbers — mostly well-labelled; a few edges
**Check C**

Generally strong: specs ban unattributed throughput; 88,485→379 / 233× appear as **calibrating invalidity** examples (`engine-core` §6.1, schema-parity anti-tmpfs scenario).  

**Edge:** `sqlite-engine/spec.md:570` “SHALL be seen to differ by a factor of **233**” makes a research re-measurement magnitude a **normative** scenario outcome. Prefer: “SHALL differ by more than an order of magnitude” or “SHALL match the labeled inadmissible-vs-remeasure pair in the artifact,” not a magic constant as SHALL.

No lane performance number found asserted as a **shipped product guarantee** in the specs sampled; the risk is residual embedding of 233 / 88,485 as if timeless facts.

---

## 4. Minor findings

### m1. Citation line-range looseness
- `release-contract/spec.md:29` cites `durability-probe.ts:200-206` (helper + three settings); acceptance C9 uses `:204-206`. Both contain the three settings (**HELD**); unify the range.

### m2. `index.ts:22` “deferred full-chain-archival track”
**HELD** at `src/index.ts:22-23`, but that comment is itself becoming stale relative to change 6 + wired `archive:sync`. Track as a post-migration doc fix, not a migration blocker.

### m3. Duplicate scenario mass (ceremony)
**Q4:** ~158 requirements / ~546 scenarios across eight spec files (counted via `^### Requirement:` / `^#### Scenario:`). High-value: negative controls for descriptor-close, errcode catch-all, Class 1/2 migration, I-3 dual-path, two-case corruption. Low-value candidates to cut:

- Parallel restatements of the same write-lock precondition in design + tasks + acceptance + spec  
- Acceptance rows that only restate tasks.md checkboxes  
- Multiple “grep returns zero” doc tests for the same phrase list in each change (one shared CI script is enough — change 7 already points at change 1’s script)

**Concrete cuts:** Merge acceptance.md into tasks verification columns for changes that already have EARS scenarios; collapse change-5 observability/catalog narrative that does not add a falsifiable scenario; do **not** delete change 6 or 7 as changes (archive wiring and data migration are load-bearing product scope). Optional: fold pure “register only” prose of change 1’s dependency chapter into a single `MIGRATION-REGISTER.md` instead of re-copying into every proposal non-goal.

**Risk of cutting:** Losing a negative control that pins a known silent-success class. Cut restatement, not the fail-if-dropped scenario.

### m4. Driver / forbidden new code — largely correct
- String discriminators required in change 3/5 specs and tasks (**good**).  
- New BUSY code forbidden; maps to frozen `LEASE_TIMEOUT` / `TRANSACTION_FAULT` / `MIGRATION_LOCK_TIMEOUT` (`transaction-lease.ts:76` faultKind union **HELD**; `ERROR-CATALOG.md:13` no weakening **HELD**).

### m5. Change 7 reject-vs-quarantine for the two live defects — **holds**
**Check G:** Class 2 covers `UNIQUE (w,net,seq)` and `next_seq > max(seq)`; lifecycle JSON/column disagreement is Class 1 refuse; quarantine forbidden (`data-migration/specs/data-migration/spec.md:313-375`). decodeRow lifecycle from JSON at `transaction-history-storage.ts:243` **HELD**; column selected without compare at `:329` **HELD**.

### m6. Two-case corruption / checksum framing — **holds** in change 5
Structural vs payload wording and “UmbraDB never had page checksums” grounded on probe scope `:204-206` (**HELD**). No CRITICAL “restores PG checksum parity” claim found in sampled release-contract text.

---

## 5. What I verified and it held

### Mechanical (verbatim)

**`/usr/local/bin/openspec validate --changes --strict --no-interactive`:**
```
✓ … (17 older changes) …
✓ change/v1.0.0-sqlite-chain-archive
✓ change/v1.0.0-sqlite-concurrency-lease
✓ change/v1.0.0-sqlite-data-migration
✓ change/v1.0.0-sqlite-durability-contract
✓ change/v1.0.0-sqlite-engine-core
✓ change/v1.0.0-sqlite-schema-parity
✓ change/v1.0.0-sqlite-temporal-event-log
✗ change/v1.1.0-formal-completion
✗ change/v1.1.0-quint-model-checking
Totals: 19 passed, 2 failed (21 items)
```
All **seven** new SQLite changes pass strict. The two failures are the expected pre-existing v1.1.0 pair.

**`git status --porcelain -- src test chain-archive-sync package.json`:** empty (no product-tree mutations).

**File set:** each of the seven has `proposal.md`, `design.md`, `tasks.md`, `acceptance.md`, and `specs/<capability>/spec.md`; schema-parity has two deltas (`storage-schema`, `temporal-kv`).

### Citation spot-checks (≥8)

| # | Citation | Verdict | What I saw |
|---|---|---|---|
| 1 | `package.json:46` archive:sync | **HELD** | script present |
| 2 | `sync-cli.ts:38` bootstrap | **HELD** | `await bootstrapChainArchiveSchema` |
| 3 | `bootstrap.ts:21` runMigrations | **HELD** | runs `chainArchiveMigrations` |
| 4 | `sync-service.ts:123` store | **HELD** | `PgChainArchiveStore` |
| 5 | `durability-probe.ts:204-206` | **HELD** | reads fsync, synchronous_commit, full_page_writes only |
| 6 | `ERROR-CATALOG.md:13` | **HELD** | no retryable weakening in 1.x |
| 7 | `transaction-lease.ts:76` faultKind | **HELD** | union includes `timeout`, not a BUSY code |
| 8 | `001_chain_archive_core.ts:86` quote | **HELD as text** | “Not wired…” present (inference stale — C1) |
| 9 | `001_chain_archive_core.ts:605-654` | **HELD** | two-session FOR SHARE/FOR UPDATE concurrency proof |
| 10 | `temporal-kv.ts:254,:257` | **HELD** | `${asOf.at}::timestamptz` binds (engine-core design §1.2) |
| 11 | `transaction-history-storage.ts:243` | **HELD** | lifecycle from JSON `stored.lifecycle` |
| 12 | `docs/CONTRACT.md` §5 lease text | **HELD** | single-writer / no fence vs connection death (lines ~101-112 region) |
| 13 | `src/index.ts:22` deferred archive track | **HELD** | comment names deferred full-chain-archival track |

### Substantive holds

- **Driver binding:** better-sqlite3 string `code` / `SqliteError` is the ruled path; specs/tasks actively ban numeric `errcode` mappings and include negative controls (change 3 E5b, change 5 F15).  
- **No new BUSY catalog code:** forbidden with LND-shaped rationale; maps onto frozen codes.  
- **I-1, I-2, I-3, I-5, I-6, I-7, I-8:** owners assigned in change-5 register; sampled requirements/scenarios exist (I-1 schema-parity seq invariant; I-3 temporal dual-path; I-6 anti-latch; I-7 + change-7 import checks; I-2/I-8 archive).  
- **Source guard scope:** bans descriptors on main db **and** `-wal`/`-shm` with journal-mode locus scenarios (`transaction-lease/spec.md:254-291`).  
- **Digest coverage:** column-level table with Class A/B/C split and explicit UNCOVERED+invariant rows in release-contract spec.  
- **Change-2 TOCTOU independence correction:** rewritten to one mechanism + negative control defeating all three observations (`temporal-kv/spec.md:564-630`).  
- **Change-7** handles newly added constraints without quarantine (see m5).  
- **Two-case corruption / no false checksum parity** in change-5 sampled text.  
- **Clock B-1 decision rule** is written and falsifiable (R=0 / R>0).

---

## 6. Coverage gaps

### (a) What the seven changes collectively under-cover

1. **Operational embedder enforcement** beyond docs: source guard is build-time for UmbraDB sources; embedder `-shm` read remains a documentation precondition — no runtime detection story when an embedder voids the lock.  
2. **Archive-side writer-generation + source-guard** as a first-class twin of the wallet file (only partially sketched).  
3. **CLI/long-running import lock liveness** interaction with lease bounds and user-visible progress/cancel (mentioned, not fully specified as UX/API).  
4. **Multi-version upgrade from partially migrated docker volumes** (change 1 still lists Q-1 docker upgrade as open).  
5. **Concrete disaster-recovery drills** for Class A payload corruption on `kv_event` after digests land (detection yes; operator runbook depth varies).  
6. **Property that shipped pragma defaults remain stable across better-sqlite3 minor bumps** (inventory asserts version; less on behavioral drift of busy/timeout).

### (b) What this seat did not fully examine (time budget)

- Full line-by-line read of all ~20k lines (impossible in wall clock); relied on targeted `rg` + selective `sed`/`nl`.  
- Every acceptance.md row vs matching scenario (sampled).  
- Full change-4 DDL lineage 000–009 statement-by-statement.  
- Full change-6 partitioning/snapshot format details beyond exclusivity and I-2/I-6/I-8.  
- Full change-5 backup API surface and observability catalog.  
- better-sqlite3 unpacked tree at `/tmp/l3-bs3b` beyond plan claims (did not re-run binding probes).  
- Round-1 audit markdown and SYNTHESIS end-to-end (preferenced specs per brief).  
- Formal Lean/`STORAGE_ALGEBRA` consistency beyond cited law names.  
- Whether every cross-citation forms a cycle with no ground (spot-checked §2.6.2 ↔ temporal; not exhaustive graph).

---

### Q1–Q5 (labels for the panel)

**Q1:** Partially implementable for pure DDL/API shape; **not** implementable without return questions for B-2/B-4 close rules, archive exclusivity ownership, CLI/worker topology, and Windows parity ship rule (M3).  

**Q2:** **Yes.** Surviving premise-(a) text is the fourth load-bearing false inference class (C1). Quote-at-`:86` is accurate; “therefore out of program scope” does not follow. No evidence in the seven changes that premise (b) main.db-lock survival is re-asserted as true; (c) page-checksum loss-as-regression is correctly handled in change 5.  

**Q3:** **Yes.** C2 grep scope, C1 uncorrected non-goals, C3 incomplete inheritance table, M1 I-4 gap. Invariants I-1…I-8 have owners in the register; I-4 is the weak link on “fail if assertion dropped.”  

**Q4:** **Over-engineered on document/scenario volume and cross-citation ceremony; not over-engineered on descriptor-close, silent-success, and migration Class 1/2.** Cut restatement and unfalsifiable register prose; keep fail-if-dropped negative controls. Do not merge away change 6 or 7. The inverse: ceremony did **not** prevent C1/C2 — thin coverage is in **registers and greps that claim completeness**, not in missing umpteenth scenarios.  

**Q5:** Refuse to approve until C1–C4 are fixed. Refuse any implementation that: adds a BUSY/`WRITE_CONTENDED` catalog code; keys errors on numeric `errcode`; cites tmpfs throughput as product fact; claims SQLite restores PostgreSQL page-checksum guarantees; or ships “archive out of scope” wording into merged main specs.

---

## Harness notes

Written by the harness (Claude Opus 5), not by Grok. Nothing above this heading was authored,
edited, or paraphrased by the harness.

### Exact command

The seat was driven by `/root/umbradb-sqlite-research/run-grok-cold.sh`, whose payload is:

```
timeout 1200 grok \
  --cwd /root/UDB-sqlite-sprint \
  --model grok-4.5 \
  --effort high \
  --always-approve \
  --no-subagents \
  --no-memory \
  --output-format plain \
  --disallowed-tools "search_replace,write,image_gen,image_edit,image_to_video,reference_to_video,scheduler_create,scheduler_delete,scheduler_list" \
  -p 'Read the file /root/umbradb-sqlite-research/grok-prompt.txt in full (248 lines) with read_file
      and follow its instructions exactly. It is your complete task brief. Do NOT run graphify and do
      NOT build, load or query any knowledge graph. Do NOT modify any file. Print your entire review
      to stdout.'
```

The full task brief is `/root/umbradb-sqlite-research/grok-prompt.txt` (248 lines), written by the
harness and passed by path rather than inline.

### Run record

| Field | Value |
|---|---|
| Exit status | `0` (single run; no retry needed, no timeout) |
| Wall clock | **191 s** (start `2026-07-31T22:08:47Z`, end `2026-07-31T22:11:58Z`) — cap was 1200 s |
| Model reported | **grok-4.5** — self-identified in §1 as "Grok (xAI), cross-vendor seat"; `grok models` reports `grok-4.5` as the only available model, default |
| CLI | `grok 0.2.114 (0c78503879) [stable]`, `/root/.local/bin/grok` → `/root/.grok/bin/grok` |
| Auth | `grok models` → "You are logged in with grok.com." Pre-flight smoke test `grok -p` returned `PING-OK grok-4.5`. |
| Raw stdout | `audit2/.grok-stdout.log` (22,391 bytes) |
| Run metadata | `audit2/.grok-run.meta` |
| Subagents | disabled (`--no-subagents`) to remove the graphify-stall surface |
| Web search | left enabled; Grok did not report using it |

### Read-only confirmation

`git status --porcelain` was captured in `/root/UDB-sqlite-sprint` immediately before and immediately
after the run (`audit2/.grok-gitstatus-before.txt`, `audit2/.grok-gitstatus-after.txt`). They are
byte-identical — seven untracked `openspec/changes/v1.0.0-sqlite-*/` directories, nothing else. No
product code was touched. Write-capable tools (`write`, `search_replace`, image/video, scheduler)
were removed from the tool set at launch.

### Traps

| Trap | Outcome |
|---|---|
| **graphify stall** (25+ min) | **Avoided.** The graphify skill *is* visible to Grok in this repo (`grok inspect` lists 50 skills including `graphify`), and a stale `graphify-out/` exists. The brief forbade it in rule 1 and the launch prompt repeated the ban. `grep -ci graphify` over the full stdout log returns **0**. |
| **`npx openspec` 0.0.0 stub** | **Avoided.** The brief gave `/usr/local/bin/openspec` as an absolute path up front. Grok reported a `19 passed / 2 failed` result, i.e. it reached the real CLI. |
| **`nohup … &` reaped in WSL** | **Hit by the harness, not by Grok.** The first launch via `wsl -e bash -lc 'nohup … &'` was killed when the outer bash exited; no output was produced. Relaunched under `systemd-run --unit=grok-cold-audit`, which survived. The reaped attempt produced no partial review and did not contaminate the run. |
| **`--sandbox` read-only profile** | **Unavailable.** `grok --sandbox <profile>` refuses to start on this host: "this sandbox could not enforce its mount-namespace deny set on Linux (bubblewrap missing/unusable)". Read-only was therefore enforced by tool-set removal plus the before/after `git status` diff above, not by a kernel sandbox. The Codex seat had a real `--sandbox read-only`; this seat did not. Recorded as a difference in enforcement, not in outcome — the diff is clean. |

### Harness spot-checks of Grok's evidence

Run by the harness *after* the review was captured, purely to record whether the seat is grounded.
They did not change a word of the review.

- `openspec validate --changes --strict --no-interactive` re-run independently: `Totals: 19 passed,
  2 failed (21 items)`, with all seven `v1.0.0-sqlite-*` changes green and the two `v1.1.0-*`
  pre-existing failures red. **Matches Grok's quoted block exactly.**
- `rg -n "chain archive is out of scope|Not wired into any runner" openspec/changes/v1.0.0-sqlite-*/`
  reproduces the C1 table, including the delta-spec hit at
  `v1.0.0-sqlite-durability-contract/specs/release-contract/spec.md:22-23` and the
  "for the entire program" wording at `v1.0.0-sqlite-temporal-event-log/proposal.md:148`. It also
  reproduces the self-refutation Grok points at: `v1.0.0-sqlite-engine-core/design.md:991` says *"No
  change may still say 'the chain archive is out of scope'"*.
- C2 confirmed at `v1.0.0-sqlite-engine-core/tasks.md:81` ("grepping **the five changes**") and
  `acceptance.md:152` (J3, "Grepping **changes 1–5**"). Both still say five; there are seven.

### Caveat the panel should weigh

191 seconds is fast for a 20,327-line corpus, and Grok says so itself in §6(b): it worked by targeted
`rg` plus selective `sed`/`nl` rather than reading the changes end to end, and it lists nine areas it
did not examine. Its coverage claims should be read as sampled, not exhaustive. The three findings the
harness independently re-ran all held.
