# UmbraDB → SQLite: OpenSpec authoring brief

You are one of five authors writing the OpenSpec change that will govern UmbraDB's migration from
PostgreSQL to SQLite. The research is finished and adjudicated; **you are not researching, you are
specifying.** Your output is a change proposal a builder can implement from and an auditor can
falsify against.

## Mission

Two things at once, and the second is not optional:

1. **Migrate** UmbraDB from PostgreSQL to SQLite — full replacement, not a second backend.
2. **Enhance the design while doing it.** A pure transliteration is the wrong deliverable. The
   research found places where SQLite lets UmbraDB make guarantees Postgres could not, and places
   where a naive port would *lose* a guarantee Postgres gave for free. Both must be addressed in
   the spec. Each change below names its mandated enhancements.

## Authoritative inputs — read in this order

All under `\\wsl.localhost\Ubuntu-26.04\root\umbradb-sqlite-research\`:

1. **`SYNTHESIS.md`** — the consolidated verdict. This is the decision you are implementing.
2. **`council/`** — four adjudicating seats: `commitments.md`, `contradiction.md`,
   `feasibility.md`, `redteam.md`. **Where a council seat contradicts a lane report, the council
   wins.** Where two seats contradict each other, say so in your design and rule with reasons.
3. **`reports/`** — the seven lane reports (`l1-temporal` … `l7-precedent`). Rich detail, but
   **their measurements are suspect** — see the tmpfs finding below.
4. **`corpus/00-BRIEF.md`** — the original research brief; states the frozen 1.0.0 commitments.

The repo itself is the ground truth for code. Your worktree is
`\\wsl.localhost\Ubuntu-26.04\root\UDB-sqlite-sprint` (branch `sprint/sqlite-migration`, cut from
`origin/main`). **Read the real code before you cite it.** `openspec/config.yaml`'s correctness
rule is binding on you: every external API or library claim must be verified against the installed
version or real upstream source, cited `file:line` — not asserted from memory.

## The decisions already made — do not re-litigate

- **Full replacement of PostgreSQL.** `src/postgres/` is eventually deleted.
- **This lands BEFORE the 1.0.0 tag.** `docs/STABILITY.md:46` states verbatim: *"Current version:
  `0.9.5` — the commitments above are NOT yet in force."* Breaking changes between 0.9.5 and 1.0.0
  are permitted. Every break your change makes is therefore **cheap if and only if it lands
  pre-tag** — say so explicitly, and state what it would cost post-tag.
- **Sequence is migrate → sync → tag.** 1.0.0 is already blocked on a full local Midnight sync
  (`CHANGELOG.md`, `ROADMAP.md:389-398`); that sync is also the out-of-cache experiment the research
  could not run. `docs/recovery/EVIDENCE.md` re-execution is therefore a **sunk cost of the tag**,
  not a cost of this migration.
- **The chain archive is OUT OF SCOPE.**
  `src/postgres/migrations/chain_archive/001_chain_archive_core.ts` states verbatim: *"Not wired
  into any runner path that would execute it."* It has no data and no consumer. Every change must
  list it as an explicit non-goal.

## The measurement caveat that governs every performance claim you write

**Six of seven research lanes benchmarked against `/tmp`, which on the research host is a 32 GB
tmpfs RAM disk.** Re-measured on ext4, WAL `synchronous=FULL` went from a published 88,485
commits/s to **379** — a 233× error. Consequences you must honor:

- **Do not carry any lane's throughput, latency or pragma number into a spec as fact.** If a
  requirement depends on a performance property, write it as a requirement to *establish* the
  number, with the measurement conditions specified (filesystem, `synchronous`, `journal_mode`,
  dataset size relative to page cache), not as an assertion of the number.
- **Change 1 owns a blocking measurement gate.** Everything downstream that depends on a
  performance property must reference it.
- One specific inversion you must not miss: **L1's "99.2% of same-key puts rejected" is 0.0% at
  `synchronous=FULL`.** The entire clock crisis — the monotone logical clock, its 1.8 s drift, the
  `CLOCK_REGRESSION` implications — is downstream of a pragma L1 never varied. Change 2 must treat
  the logical clock as *conditional on re-measurement*, not as a settled design.

## The five changes

One author per change. Stay inside your boundary; where you depend on another change, state the
dependency explicitly in `design.md` rather than specifying its content.

### 1. `v1.0.0-sqlite-engine-core` — capability `sqlite-engine`
The keystone; everything else depends on it. Driver selection and the `postgres.js`-shaped
tagged-template shim; connection/handle lifecycle replacing `createClient`'s pooled semantics;
pragma bootstrap ordering; the worker-thread topology; and **the blocking ext4 measurement gate**.

Mandated content: resolve the **driver disagreement** — L3 recommends the `node:sqlite` built-in,
the commitments seat rules for a pinnable third-party binding because `docs/STABILITY.md:18` cannot
promise no-breaking-changes-in-a-minor about a substrate whose platform reserves that right
(`node:sqlite` is RC only at Node 25.7, is *silently* experimental at the declared `engines: >=24`
floor, and cannot be lockfile-pinned). Rule, with reasons, and specify the consequence either way.
Specify that pragma order is **irreversible** (`page_size`/`auto_vacuum` are silently ignored if
WAL is set first). Specify the shim's decoding as keyed on `columns()` **origin metadata**, not
declared type names, because `STRICT` rejects `JSONB`/`BYTEA`/`TIMESTAMPTZ` as declared types.
Capture the three silent-corruption traps: a `Date` bound positionally is stored as **NULL**; lone
surrogates become U+FFFD; NUL bytes desynchronise `length()`.

**Enhancement mandate:** the worker boundary should make the transaction-identity guard
*unforgeable* (the caller never holds a DB handle). Note the limit the red team established:
round-trip transport grows with payload and is **structurally unreachable for `withTransaction(fn)`**,
a frozen export whose body is caller code.

### 2. `v1.0.0-sqlite-temporal-event-log` — capability `temporal-kv` (MODIFIED)
TemporalKV's redesign. The event-log schema deriving `[valid_from, valid_to)` via `LEAD()`; T3/T5
enforcement; the transaction-identity guard; the clock policy.

Note: `openspec/specs/temporal-kv/spec.md` is the **only merged spec in the repo** — yours is the
only change that legitimately writes `## MODIFIED Requirements`. Read it first and delta against
its actual requirement headers.

**Enhancement mandate:** gap-freedom (T5(2)) is **caller-enforced today** and becomes
**structural** under the event-log encoding. That is a genuine strengthening of a frozen formal
commitment and must be specified as such, with a scenario proving a gap is now unrepresentable.
Also specify: `INSERT OR REPLACE` must be **banned in the adapter** (it silently skips BEFORE
UPDATE triggers and would lose history rows), and record that the naive `EXCLUDE` transliteration
is quadratic (1,441× slower) so nobody re-proposes it.

### 3. `v1.0.0-sqlite-concurrency-lease` — capability `transaction-lease` (MODIFIED-style)
Transactions, the lease, cancellation, isolation, error-to-code mapping for contention.

**The single most important thing in your change:** the red team **broke** L2's sidecar-lock-file
lease. POSIX record locks drop on *any* fd close in the process, so one `fs.readFileSync` of the
lock file silently voids it; `unlink` defeats it too (new inode → two simultaneous holders). You
must either specify a mechanism that survives both attacks, with scenarios that *are* those
attacks, or specify a different mechanism. Do not restate L2's design as though it held.

Also: `BEGIN IMMEDIATE`; the JS poll loop rather than a blocking `busy_timeout` (the blocking form
fails P10 — 1 acquired / 7 timeouts — because it pins the single JS thread, and the red team showed
it deadlocks *inside the worker too*); sticky-poison emulation, since SQLite does **not** poison a
transaction after a failed statement; and the ruling that `SQLITE_BUSY` already has homes in the
frozen `faultKind` union (`"timeout"`, `"serialization-failure"`) — **adding a new error code is
the one action that would reproduce LND's P0 fund-loss failure shape**.

**Enhancement mandate:** `docs/CONTRACT.md` §5 can be **strengthened** from "don't run two writer
processes" to "a second writer process is *refused*" — if and only if your mechanism survives the
fd-close and unlink attacks. Tie the strengthening to the mechanism.

### 4. `v1.0.0-sqlite-schema-parity` — capability `storage-schema`
The data model: types, constraints, indexes, the migration framework.

Content: table-name prefixing to preserve `DEFAULT_SCHEMA` (index and trigger names are **global
per database file** and need prefixing too); `STRICT` tables; the junction table replacing
`text[]` + GIN `<@` containment (state the containment direction precisely — it is easy to invert);
`listKeys` must use a range scan because SQLite's `LIKE` is case-insensitive by default *and* does
not use the index; `UNIQUE NULLS NOT DISTINCT` has no SQLite equivalent and a naive port silently
reintroduces a bug a prior audit already caught — specify the `coalesce(...)` expression-index fix
with the audit's own scenario as a negative control. Migration `006`'s
`ADD COLUMN ... GENERATED ... STORED` is rejected on any non-empty table but **succeeds on a 0-row
table**, so a fresh lineage replays it unchanged.

**Enhancement mandate:** `STRICT` tables give UmbraDB type enforcement that SQLite's dynamic typing
otherwise removes — specify it as a positive requirement with a scenario proving a wrong-typed
write is *rejected*, not coerced.

### 5. `v1.0.0-sqlite-durability-contract` — capability `release-contract` (MODIFIED)
The written contracts, the error catalog, the durability probe, backup/restore, and the evidence
obligations.

Content: `docs/CONTRACT.md` §3's cancellation clause ("the long read wait is freed") must be
**deleted, not reworded** — `node:sqlite` exposes no `sqlite3_interrupt` and no progress handler.
§6 backup/restore must be **rewritten**: no SQLite project has a live-backup story matching
`pg_dump` (CLN warns `VACUUM INTO` locks the database for long periods and *retracted* its
Litestream recommendation; LND's SQL `Copy` is `errors.New("not implemented")`). Note the seats
**disagree** on `VACUUM INTO` vs `backup()` — the contradiction seat measured `backup()`
non-blocking and integrity-clean under 781 concurrent commits while `VACUUM INTO` froze the thread;
rule, and cite the measurement. The durability probe moves from verifying *deployer* preconditions
to verifying *library-controlled* pragmas.

**Enhancement mandate — the most important one in the sprint.** SQLite has **no main-database page
checksums**. Verified by the coordinator: corrupting 64 bytes in a checkpointed main database
yields `integrity_check → ok`, `quick_check → ok`, and the corrupted row is returned as data.
PostgreSQL offers `data_checksums` and `amcheck`. L6 recorded this as a durability *improvement*;
it is a **regression**. Specify how UmbraDB closes it — application-level checksums over stored
values, a verification pass, or an explicit written acceptance of the gap. A silent data-corruption
detection hole is not something a storage library may leave undocumented.

Also specify the **observability** gap the feasibility seat raised: nothing can inspect a running
embedded engine from outside the process (`pg_stat_*` has no analogue), and this is a library whose
bug reports read "the wallet is stuck."

## Deliverable — exact file set

Create `openspec/changes/<your-change-id>/` in the worktree containing:

- **`proposal.md`** — Why / What changes / **explicit non-goals** (required by
  `openspec/config.yaml`'s proposal rule). Follow the voice of
  `openspec/changes/v1.0.0-api-surface/proposal.md`.
- **`design.md`** — the technical design. `config.yaml`'s design rule is binding: cite
  `design/design.md`, `design/design-interfaces.md` and `Formal/STORAGE_ALGEBRA.md` **by section
  number** wherever you touch an existing decision; never silently duplicate or contradict them.
- **`tasks.md`** — ordered tasks, each with **concrete acceptance criteria** (what test passes,
  what command succeeds), per `config.yaml`'s tasks rule.
- **`acceptance.md`** — the traceability table: criterion | verify method (`[unit]` `[prop]` `[CI]`
  `[doc]` `[manual]`) | requirement / task. Model on `v1.0.0-api-surface/acceptance.md`.
- **`specs/<capability>/spec.md`** — EARS requirements.

### EARS format — match the repo exactly

Read `openspec/changes/sprint-7-transaction-history-storage/specs/transaction-history-storage/spec.md`
before writing a line. The house style:

- `## ADDED Requirements` (or `## MODIFIED Requirements` / `## REMOVED Requirements`)
- `### Requirement: <lowercase statement of the property>`
- Body uses **SHALL** / **SHALL NOT**, with the EARS preamble where applicable (`WHEN <trigger>,
  the system SHALL …`, `WHILE <state>`, `IF <condition> THEN`).
- `#### Scenario: <concrete situation>` with `- **WHEN** …` / `- **THEN** …` / `- **AND** …`.
- **Negative-control scenarios are house style and you are expected to write them.** Sprint 7's
  spec includes a scenario describing the *hypothetical wrong implementation* and what it would
  lose. Where the research produced a real negative control — the forbidden cursor-first ordering
  that violated the invariant 4/9 times, the naive `UNIQUE` that reintroduces the NULL-address
  duplicate, the blocking `busy_timeout` that fails P10 — write it as a scenario.

Validate before you finish:

```
cd /root/UDB-sqlite-sprint && /usr/local/bin/openspec validate <your-change-id> --type change --strict --no-interactive
```

Baseline is 12 passed / 2 failed; the two failures (`v1.1.0-formal-completion`,
`v1.1.0-quint-model-checking`) are **pre-existing and not yours**. Your change must pass strict.

## Traps — the complete recorded list

1. **WSL/Windows path trap.** The repo is in WSL; your tools run on Windows. A bare `/root/...`
   path given to Read/Write/Edit resolves on the **Windows** drive and silently creates a phantom
   file. Use `\\wsl.localhost\Ubuntu-26.04\root\...`. Verified working.
2. **WSL inline heredoc trap.** Never build scripts or prompts via `wsl -e bash -lc "..."` with
   **double** outer quotes — the quoting eats backticks and silently deletes content. Single quotes.
3. **Use the Bash tool, not PowerShell, for WSL.** PowerShell expands `$(...)` and `$VAR` first.
4. **OpenSpec CLI:** use `/usr/local/bin/openspec`. **`npx openspec` resolves to a broken 0.0.0
   stub** and the global `.bin` symlink is missing — this has already fooled three audit agents.
5. **Never claim "verified" without the command that produced it.**
6. **Do not modify `src/`, `test/`, or any product code.** You are writing specs. The only files
   you create are under `openspec/changes/<your-change-id>/`.
7. **Do not run `npm install`.**
8. **Don't trust a lane's number.** See the tmpfs section above.
9. **A green gate certifies depth, never breadth.** The Lean cut-line `{T3,T5,W1,C1}` survives this
   migration *untouched* because it models an abstract store and the abstract→concrete refinement
   was always a trusted, unmechanized bridge. Do not cite that survival as evidence the migration
   is safe; the P1–P10 conformance suite carries the refinement claim, and it must be
   **re-executed, not amended**.

## Standard

Write for a hostile auditor. Every requirement should be **falsifiable** — a reader must be able to
say what observation would prove it violated. Where the research is uncertain, specify the
experiment that resolves it rather than guessing; an explicit "this is unresolved, here is how to
resolve it" requirement is worth far more than a confident invention. State what you are NOT
covering. Cite `file:line` for every code claim.
