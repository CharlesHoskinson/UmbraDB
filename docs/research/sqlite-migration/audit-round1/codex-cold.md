# Cross-vendor audit — Codex (GPT-5.6 Sol), cold read

**Seat:** cross-vendor / outside reading. **Model:** `gpt-5.6-sol` via OpenAI Codex CLI v0.146.0,
reasoning effort `high`, sandbox `read-only`.
**Subject:** five-change OpenSpec sprint plan, `/root/UDB-sqlite-sprint`, branch `sprint/sqlite-migration`.
**Run:** 2026-07-31T19:51:19Z → 20:00:45Z (566 s), exit 0.

Everything from here to `## Harness notes` is Codex's output, reproduced without edit. The harness
did not add, remove, soften, or reorder any finding. See `## Harness notes` at the end for
provenance and trap observations.

---

## 1. Verdict

Model: OpenAI Codex (GPT-5 family).

REJECT

**Q1 — Implementable as written:** No; an engineer must guess the fate of the active chain-archive path, the checksum representation, several measurement decision rules, and the writer-displacement error code. **Q2 — Decomposition:** No; there are circular task dependencies and handoffs whose receiving change does not accept ownership. **Q3 — Load-bearing claims:** The pre-1.0 citation and blocking gate are real, but “cheap,” “archive out of scope,” and “unambiguous gate” do not follow. **Q4 — Approval:** I would refuse approval until the critical findings below are corrected and strict validation is rerun.

## 2. Critical findings

### CRITICAL — The chain archive is active, so declaring it untouched while removing PostgreSQL breaks the repository

**Change:** `v1.0.0-sqlite-engine-core`, affecting all five changes.

**Defect:** [proposal.md:120](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-engine-core/proposal.md:120) says the archive has “no data and no consumer”; the other proposals repeat that claim. [tasks.md:68](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-engine-core/tasks.md:68) removes the `postgres` dependency, while task 0 forbids touching the archive migrations.

The cited migration comment at [001_chain_archive_core.ts:86](/root/UDB-sqlite-sprint/src/postgres/migrations/chain_archive/001_chain_archive_core.ts:86) does contain the quoted text, but it is stale:

- [package.json:46](/root/UDB-sqlite-sprint/package.json:46) defines `archive:sync`.
- [sync-cli.ts:1](/root/UDB-sqlite-sprint/chain-archive-sync/sync-cli.ts:1) calls itself the production/ops entry point.
- [sync-cli.ts:21](/root/UDB-sqlite-sprint/chain-archive-sync/sync-cli.ts:21) imports the PostgreSQL client and calls the bootstrap at line 38.
- [bootstrap.ts:1](/root/UDB-sqlite-sprint/chain-archive-sync/bootstrap.ts:1) imports the PostgreSQL migration runner; lines 20–21 execute `chainArchiveMigrations`.
- [sync-service.ts:1](/root/UDB-sqlite-sprint/chain-archive-sync/sync-service.ts:1) constructs `PgChainArchiveStore`.
- [tsconfig.json:13](/root/UDB-sqlite-sprint/tsconfig.json:13) includes `src`, tests, and `chain-archive-sync` in typechecking.

I explicitly challenge the council ruling here: its source fact has been invalidated by later repository state. The quote is accurate; the inference is not.

**The plan should say instead:** Choose one explicit path before implementation:

1. retain a dual-engine archive track and keep `postgres` as a dependency;
2. port the archive, CLI, bootstrap, store, migrations, tests, and documentation to SQLite; or
3. deliberately remove/disable the preview in one reviewed compatibility change.

The selected path must make `npm run typecheck`, `npm run build`, and `npm run archive:sync` coherent.

### CRITICAL — The page-checksum mitigation is underspecified and contains an undefined escape hatch

**Change:** `v1.0.0-sqlite-durability-contract`.

The positive requirement correctly mandates digests for TemporalKV and wallet-state envelopes at [spec.md:138](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-durability-contract/specs/release-contract/spec.md:138), but it does not specify:

- the digest algorithm;
- the exact bytes being digested and their encoding/domain separation;
- column names and SQLite types;
- migration ownership and numbering;
- behavior for existing rows;
- how `NULL` or versioned encodings are treated.

Task 3.1 merely says to coordinate DDL with schema parity at [tasks.md:156](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-durability-contract/tasks.md:156), while schema parity explicitly assigns page-checksum coverage to change 5 and contains no digest DDL. More seriously, [tasks.md:171](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-durability-contract/tasks.md:171) permits a “fallback coverage set” if cost exceeds an undefined “operating envelope.” No file defines that envelope, and reducing coverage would contradict the normative minimum in the spec.

An implementer therefore cannot tell whether to use SHA-256 or another algorithm, which migration to edit, or when it is permissible to omit required protection.

**The plan should say instead:** Fix the algorithm, input encoding, columns, migration owner, backfill rule, and mandatory coverage in the spec. Define any cost threshold before measurement. Falling below the mandatory TemporalKV/envelope coverage must require an explicit spec change and consumer acceptance, not an implementation-time fallback.

### CRITICAL — The measurement gate names decisions but does not decide several of them unambiguously

**Changes:** engine core, concurrency lease, schema parity.

The gate is real and now names B-1 through B-8. However, [design.md:752](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-engine-core/design.md:752) mostly records inputs, not decision rules:

- B-3 provides no rule for selecting irreversible `page_size` and `auto_vacuum`.
- B-4 provides no acceptable lock-amplification, retry, or hold-bound threshold.
- B-5 provides no batch-size objective or tie-breaker.
- B-8 measures abort latency and WAL growth but gives no maximum acceptable value for either.

“CLOSED citing an artifact datum” proves provenance, not that a choice follows from evidence. A builder can cite the same datum and choose conflicting values.

The normative specifications also carry the exact contaminated figures they say must not become facts:

- [engine-core spec.md:511](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-engine-core/specs/sqlite-engine/spec.md:511) forbids figures absent from the future artifact, but lines 525–540 prescribe `233×` and `2.64×` as expected outcomes.
- [temporal spec.md:352](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-temporal-event-log/specs/temporal-kv/spec.md:352) embeds the tmpfs `1,441×` result and asserts, without measurement, that real-storage cost must be larger.
- [schema spec.md:430](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-schema-parity/specs/storage-schema/spec.md:430) embeds the `2.0×–3.8×` and `3.3×` tmpfs factors while simultaneously saying they must not be carried as facts.
- [schema spec.md:490](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-schema-parity/specs/storage-schema/spec.md:490) similarly carries the `3.5×` rebuild figure.

**Q3(c):** The gate is blocking rather than decorative, but it is not yet mechanically dischargeable. Measurement-independent work can proceed; value-dependent work must stall or guess.

**The plan should say instead:** Define acceptance envelopes and deterministic selection rules before running the measurement. Keep suspect historical numbers in non-normative provenance notes; specifications should require observable shapes and fresh measurements without preordaining the result.

## 3. Major findings

### MAJOR — The five changes cannot land atomically in their stated order

**Q2/Q3 sequencing:** Schema parity says its naming layer blocks changes 2 and 3 at [tasks.md:9](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-schema-parity/tasks.md:9). Yet its task 0.1 requires engine core to have landed before schema task 2 onward, while task 2.4 builds the decoder registry and hands it back to change 1 at [tasks.md:86](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-schema-parity/tasks.md:86). Engine core itself implements registry-driven decoding at [tasks.md:103](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-engine-core/tasks.md:103).

Change 2 also says its DDL is drafted unprefixed and depends on change 4’s naming layer; change 3 needs that layer for `writer_generation`.

**Required correction:** Extract the naming and registry contracts into an upstream tranche, or publish an explicit task-level integration schedule. There is no schedule in which complete changes 1→2→3→4→5 land without either circularity or rewriting DDL.

### MAJOR — The writer-generation acceptance test requests an impossible interleaving

Change 3 task 3.2 says process B registers while process A holds a write transaction and then A is rejected at [tasks.md:121](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-concurrency-lease/tasks.md:121). Both operations start with `BEGIN IMMEDIATE`; while A holds SQLite’s write lock, B cannot commit its registration. The design’s safety argument at [design.md:221](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-concurrency-lease/design.md:221) actually depends on that impossibility.

**Required correction:** Test both realizable orders:

- A owns the lock, so B waits and A commits before B registers.
- B registers first, so A’s next transaction observes displacement and rejects.

The existing acceptance table’s “after B registers” wording is correct; task 3.2 must match it.

### MAJOR — The writer-displacement error code is owned by nobody

Change 3 says the displacement code belongs to change 5 at [design.md:621](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-concurrency-lease/design.md:621), and task 5.6 says to agree it with change 5. But change 5 never mentions displacement. Its normative code additions at [release-contract spec.md:403](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-durability-contract/specs/release-contract/spec.md:403) list four unrelated codes.

An implementer cannot tell the error string, class, catalog row, or stability treatment.

**Required correction:** Name the displacement code and class in change 5, assign its retryability and situation, and add matching tasks and acceptance criteria in both changes.

### MAJOR — “Pre-tag” means permitted, not operationally cheap

**Q3(a):** [docs/STABILITY.md:46](/root/UDB-sqlite-sprint/docs/STABILITY.md:46) says exactly what is claimed: the commitments are not yet in force. But lines 52–63 also say `0.9.5` is being exercised by real consumers and the expectation was an identical 1.0 surface.

Engine core itself admits at [design.md:781](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-engine-core/design.md:781) that git-tag consumers are unobservable. Schema task 0.3 allows that question to remain unanswered until the tag. That supports SemVer legality, not the repeated claim that changes are “cheap” or “free.”

**Required correction:** Replace “cheap/free pre-tag” with “SemVer-permitted but operational cost unknown.” The consumer answer, upgrade/data-migration decision, and at least one real consumer rehearsal must gate the release candidate.

## 4. Minor findings

- [temporal spec.md:377](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-temporal-event-log/specs/temporal-kv/spec.md:377) uses numeric `(5)` and `(517)` result codes when describing concurrency. It is not itself a translator, so this is not the forbidden numeric mapping, but symbolic names alone would avoid contradicting the otherwise correct better-sqlite3 string-discriminator rule.

- [docs/features/full-chain-storage.md:81](/root/UDB-sqlite-sprint/docs/features/full-chain-storage.md:81) still says there is no CLI or npm script, while `package.json` and `sync-cli.ts` prove both exist. This stale documentation helped make the archive citation failure possible.

- Several proposals state “no consumer” as fact while change 5’s own design correctly says that zero consumers are unobservable. Use “no known external package consumer” only where that is the actual evidence.

## 5. What I verified and it held

The following load-bearing decisions held:

- **Sidecar reversion avoided:** Change 3 uses an in-process lease plus main-database writer-generation guard. Its spec contains both `readFileSync`/descriptor-close and unlink negative controls and forbids the sidecar design.
- **Logical clock remains conditional:** [temporal spec.md:164](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-temporal-event-log/specs/temporal-kv/spec.md:164) gives an explicit R=0/R>0 rule and blocks implementation until the real-filesystem measurement exists.
- **No new contention code:** Change 3 maps contention to existing frozen outcomes and explicitly prohibits `BUSY`/`WRITE_CONTENDED`.
- **Driver discriminator corrected:** Change 3 and change 5 require `err.name === "SqliteError"` and string `err.code`, with numeric `errcode` as a negative control.
- **Backup decision re-based:** Change 5 does not carry the node:sqlite result forward. [release-contract spec.md:266](/root/UDB-sqlite-sprint/openspec/changes/v1.0.0-sqlite-durability-contract/specs/release-contract/spec.md:266) requires remeasurement on the ruled binding and allows an honest no-live-backup result.
- **STRICT/origin-metadata seam agrees:** Schema parity rejects Postgres declared type names and hands an origin-keyed registry to engine core; both fail closed on an unregistered derived column.
- **`WITHOUT ROWID` ruling preserved:** Payload-bearing content-addressed tables remain rowid tables and the direction is reopened if ext4 measurement reverses it.
- **Generated-column correction preserved:** The spec distinguishes successful 0-row `ADD COLUMN … STORED` from failure on a populated table.
- **Page-checksum gap is acknowledged:** Change 5 specifies application digests, a corruption negative control, combined structural/content verification, and consumer-visible residual-risk text. The critical finding is about completing that design, not silence.

Citation spot-checks:

1. **HELD:** `docs/STABILITY.md:46,60-63` says pre-1.0 commitments are not binding but real-consumer testing is intended.
2. **HELD text / FAILED inference:** `001_chain_archive_core.ts:86` contains the quoted “not wired” sentence; current bootstrap and CLI invalidate it.
3. **HELD:** `src/postgres/client.ts:10,44-76` defines the cited `UmbraDBSql` and connection option shapes.
4. **HELD:** `src/postgres/checkpoint-store.ts:62-63` contains the cited 30,000/20,000 batching constants.
5. **HELD:** `src/postgres/temporal-kv.ts:254,257` contains the cited positional `Date`/`timestamptz` binds.
6. **HELD:** `src/postgres/temporal-kv.ts:324-346` uses `cursor(256)` and the cited cancellation path.
7. **HELD:** `src/interfaces/transaction-lease.ts:76` contains the frozen `faultKind` union named by changes 3 and 5.
8. **HELD:** `src/postgres/migrations/006_ckpt_chunks_size_bytes.ts:16-19` contains the cited `ADD COLUMN … STORED`.
9. **HELD:** `src/postgres/checkpoint-store.ts:65-66,366-378` computes and verifies the cited chunk and manifest SHA-256 values.
10. **HELD:** `docs/CONTRACT.md:63-70,114-133` contains the cancellation and PostgreSQL backup promises change 5 says must be rewritten.
11. **HELD:** `docs/ERROR-CATALOG.md:11-13,34-46,73-89` contains the cited freeze, retryability, and conditional-clock rules.

Mandatory validation command:

```text
$ cd /root/UDB-sqlite-sprint && /usr/local/bin/openspec validate --changes --strict --no-interactive
✓ change/sprint-2-transaction-lease
✓ change/sprint-3-checkpoint-store
✓ change/sprint-4-watermarks
✓ change/sprint-5-formal-watermarks
✓ change/sprint-6-formal-checkpoint-c1
✓ change/sprint-7-transaction-history-storage
✓ change/sprint-8-wallet-envelope-live-sync
✓ change/v1.0.0-api-surface
✓ change/v1.0.0-durable-checkpoint-cursor
✓ change/v1.0.0-infosec-signoff
✓ change/v1.0.0-perf-baseline
✓ change/v1.0.0-recovery-testing
✓ change/v1.0.0-sqlite-concurrency-lease
✓ change/v1.0.0-sqlite-durability-contract
✓ change/v1.0.0-sqlite-engine-core
✓ change/v1.0.0-sqlite-schema-parity
✓ change/v1.0.0-sqlite-temporal-event-log
✗ change/v1.1.0-formal-completion
✗ change/v1.1.0-quint-model-checking
Totals: 17 passed, 2 failed (19 items)
Details: openspec validate v1.1.0-formal-completion --type change
```

All five new changes pass strict validation. The two failures are the named pre-existing changes; structural validation is not truth validation.

`git status --short` was exactly:

```text
?? openspec/changes/v1.0.0-sqlite-concurrency-lease/
?? openspec/changes/v1.0.0-sqlite-durability-contract/
?? openspec/changes/v1.0.0-sqlite-engine-core/
?? openspec/changes/v1.0.0-sqlite-schema-parity/
?? openspec/changes/v1.0.0-sqlite-temporal-event-log/
```

No product-code modification appeared. A `test`/`find` check reported all five `COMPLETE`: each has `proposal.md`, `design.md`, `tasks.md`, `acceptance.md`, and at least one `specs/<capability>/spec.md`; schema parity intentionally has a second temporal-kv delta.

## 6. Coverage gaps

### (a) Missing collective coverage

- A binding decision for the existing archive CLI/store/migration path.
- Exact digest algorithm, byte encoding, DDL, migration/backfill ownership, and non-vacuous cost policy.
- The writer-displacement error code and catalog row.
- Deterministic closure rules for B-3, B-4, B-5, and B-8.
- An acyclic, whole-change landing schedule.
- A real answer to the git-tag consumer question and the consequent PostgreSQL-data migration decision.

### (b) Not examined within the audit window

- I did not independently rerun the research benchmarks or corruption experiments.
- I did not exhaustively verify every external SQLite/better-sqlite3 API claim; I spot-checked eleven cited source locations.
- I did not exhaustively test every proposed SQL statement or every requirement for falsifiability.
- I did not execute the Windows writer-generation experiment.
- I used targeted searches of the briefs and council records rather than reading the roughly 200 KB council corpus end to end.
---

## Harness notes

Written by the harness agent (Claude), not by Codex. Nothing in this section is part of the review.

### Command run

Executed inside WSL via `bash /root/umbradb-sqlite-research/run-codex-cold.sh`, whose body is:

```bash
timeout 1200 codex exec \
  --sandbox read-only \
  -C /root/UDB-sqlite-sprint \
  -c model_reasoning_effort="high" \
  -o /root/umbradb-sqlite-research/audit/.codex-last.md \
  'Read the file /root/umbradb-sqlite-research/codex-prompt.txt in full (it is 219 lines) and follow its instructions exactly. It is your complete task brief. Do NOT run graphify and do NOT build or query any knowledge graph.'
```

The full 219-line task brief was written to `/root/umbradb-sqlite-research/codex-prompt.txt` first and
read by Codex from disk, rather than passed inline, to avoid the WSL quoting/heredoc corruption trap.

### Result

| | |
|---|---|
| Exit status | `0` |
| Wall clock | 566 s (9 min 26 s), well inside the 1200 s cap |
| Start / end (UTC) | 2026-07-31T19:51:19Z → 2026-07-31T20:00:45Z |
| Model reported in session header | `model: gpt-5.6-sol`, `provider: openai`, `reasoning effort: high`, `sandbox: read-only`, `approval: never` |
| Model self-reported in §1 | "OpenAI Codex (GPT-5 family)" |
| Session id | `019fb9bb-306a-7861-8f7e-b8cc15eb663f` |
| Retries needed | 0 (one launch-mechanism failure before Codex started; see below) |
| Raw transcript | `/root/umbradb-sqlite-research/audit/.codex-stdout.log` |
| Raw final message | `/root/umbradb-sqlite-research/audit/.codex-last.md` |

Codex named itself less precisely in §1 ("GPT-5 family") than the CLI session header did
(`gpt-5.6-sol`). Both are recorded; neither was edited.

### Traps — observed behaviour

- **graphify (auto-trigger stall).** Not hit. The instruction to skip it was placed in both the
  `codex exec` argument and the brief. Codex acknowledged it in its first turn ("will not run
  Graphify or query any knowledge graph") and went straight to file reads. It also actively excluded
  the stale artifacts, passing `--glob '!graphify-out/**'` to its own ripgrep. No graph was built.
- **OpenSpec CLI stub.** Not hit. Codex used `/usr/local/bin/openspec` as instructed and reported
  real output (17 passed / 2 failed). It never touched `npx openspec` and never claimed openspec was
  missing.
- **20-minute cap.** Not hit; finished in 47% of budget. No narrowed retry was needed.
- **Read-only.** Honoured. `git status --short` after the run showed only the five untracked change
  directories, matching what Codex itself reported.
- **A watchdog false positive, for the record.** The harness liveness watchdog grepped the transcript
  for `graphify|not installed|npx openspec` and fired every cycle. Every match was the harness's own
  prompt text echoed into the log, plus Codex's `!graphify-out/**` exclusion. It was never a real
  trap hit. A future watchdog should grep only the region after the prompt echo.

### Launch-mechanism failure (harness-side, before Codex started)

The first launch used `nohup … &` inside `wsl -e bash -lc`. The process was reaped the instant the
WSL invocation returned — no stdout log, no metadata file, nothing ran. Relaunched via the Bash
tool's own background mode, which keeps the `wsl.exe` process alive; that worked first time. This
cost about one minute and did not affect the review.

### Independent harness verification

The harness independently checked a small number of Codex's load-bearing citations, purely to
confirm Codex was reading the real tree and not hallucinating paths. This is fidelity checking, not
a second review — no harness opinion is expressed on any finding.

- `cd /root/UDB-sqlite-sprint && /usr/local/bin/openspec validate --changes --strict --no-interactive`
  → `Totals: 17 passed, 2 failed (19 items)`, with only `v1.1.0-formal-completion` and
  `v1.1.0-quint-model-checking` failing. Identical to what Codex reported, including the ordering.
- `chain-archive-sync/` exists and contains `sync-cli.ts`, `bootstrap.ts`, `sync-service.ts`.
- `package.json:46` → `"archive:sync": "tsx chain-archive-sync/sync-cli.ts",`
- `src/postgres/migrations/chain_archive/001_chain_archive_core.ts:86` → contains the quoted
  "**Not wired into any runner path that would execute it.**" text.
- `docs/STABILITY.md:46` → "**Current version: `0.9.5` — the commitments above are NOT yet in force.**"

All checked citations resolve to real files at the cited lines saying what Codex says they say.

### Note for the panel

Codex explicitly flags that it is **challenging a council ruling** rather than merely reporting a
drafting defect: its first critical finding accepts that the `001_chain_archive_core.ts` quote is
accurate but argues the repository has moved on since, so the inference drawn from it is invalid.
Per this seat's mandate, that disagreement is recorded as stated and has not been reconciled toward
the briefs.
