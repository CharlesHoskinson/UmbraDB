# UmbraDB → SQLite sprint: audit brief

You are auditing a five-change OpenSpec sprint plan **before any implementation begins**. This is
the last checkpoint at which a mistake is cheap. Your job is to falsify the plan, not to admire it.

## What you are auditing

Five OpenSpec changes in `\\wsl.localhost\Ubuntu-26.04\root\UDB-sqlite-sprint`, branch
`sprint/sqlite-migration`, under `openspec/changes/`:

| Change id | Capability | Owns |
|---|---|---|
| `v1.0.0-sqlite-engine-core` | `sqlite-engine` | Driver ruling, shim, pragma bootstrap, worker topology, the blocking measurement gate |
| `v1.0.0-sqlite-temporal-event-log` | `temporal-kv` | Event-log redesign, T3/T5 enforcement, clock policy |
| `v1.0.0-sqlite-concurrency-lease` | `transaction-lease` | Lease, transactions, isolation, contention error mapping |
| `v1.0.0-sqlite-schema-parity` | `storage-schema` | Types, constraints, indexes, migration framework |
| `v1.0.0-sqlite-durability-contract` | `release-contract` | Written contracts, error catalog, durability probe, backup/restore, evidence |

Each should contain `proposal.md`, `design.md`, `tasks.md`, `acceptance.md`, and
`specs/<capability>/spec.md`.

## The inputs the authors were given

Read these — an author who contradicts them without justification is a finding:

- `\\wsl.localhost\Ubuntu-26.04\root\umbradb-sqlite-research\AUTHORING-BRIEF.md` — what they were told to do.
- `.../SYNTHESIS.md` — the consolidated verdict being implemented.
- `.../council/` — four adjudicating seats (`commitments`, `contradiction`, `feasibility`, `redteam`).
  **Where a council seat contradicts a lane report, the council wins.**
- `.../reports/` — seven lane reports. Detailed, but their measurements are suspect (see below).
- Repo conventions: `openspec/config.yaml`, and the existing changes
  (`v1.0.0-api-surface`, `sprint-7-transaction-history-storage`) as the house style.

## The failure modes most likely to be present

Rank your findings by whether they would change what gets built. These are the specific ways this
plan is most likely to be wrong:

**1. Reversion to a refuted position.** The council overturned several lane conclusions. An author
who read the lane report more closely than the council ruling may have quietly restored the
refuted version. Check each of these:

- **The sidecar lock-file lease was BROKEN.** POSIX record locks drop on *any* fd close in the
  process, so one `fs.readFileSync` of the lock file voids it; `unlink` defeats it too (new inode →
  two simultaneous holders). Change 3 must either specify a mechanism surviving both attacks — with
  those attacks written as scenarios — or specify a different mechanism. If change 3 restates
  L2's design as sound, that is a **critical** finding.
- **The monotone logical clock is CONDITIONAL.** L1's "99.2% of same-key puts rejected" is 0.0% at
  `synchronous=FULL`. Change 2 must gate the clock decision on change 1's measurement, with the
  decision rule written out. If it specifies the logical clock as settled design, that is critical.
- **Adding a new error code for `SQLITE_BUSY` is FORBIDDEN.** `SQLITE_BUSY` already has homes in
  the frozen `faultKind` union at `src/interfaces/transaction-lease.ts:76`. The commitments seat
  ruled that adding a code is the one action that would reproduce LND's P0 fund-loss failure shape.
- **`WITHOUT ROWID` is wrong for the content-addressed tables** despite looking obvious (2.0–3.8×
  slower point reads).
- **`ADD COLUMN ... GENERATED ... STORED` succeeds on a 0-row table** — L6's finding is more
  precise than L4's "refuses outright."
- **`backup()` vs `VACUUM INTO`** — the contradiction seat measured `backup()` non-blocking and
  integrity-clean under 781 concurrent commits and ruled L6 backwards. Check which the plan adopts
  and whether it cites the measurement it relies on.

**1b. A driver ruling that landed mid-authoring.** Change 1 ruled the driver to be **`better-sqlite3`, pinned** — not the `node:sqlite` built-in that most lane reports assumed. This landed *while changes 3, 4 and 5 were being written*, and the coordinator relayed it to them in flight. Two consequences you must check, because a late relay is exactly the kind of thing an author folds in incompletely:

- **Error discriminators must be strings, not numbers.** The ruled binding raises `err.code === "SQLITE_BUSY"` / `"SQLITE_CONSTRAINT_PRIMARYKEY"` with `err.name === "SqliteError"`. The `node:sqlite` numeric `errcode` form (517, 1555, 5) does **not** apply. The coordinator relayed the numeric form earlier in the research phase, so it may be embedded in changes 3 or 5. Grep all five specs for `errcode`, `517`, `1555` and bare numeric result codes.
- **The `backup()` vs `VACUUM INTO` measurement was taken on `node:sqlite`.** The contradiction seat's figures (781 concurrent commits, 1,539 event-loop ticks vs 0) are from the *other* driver. Change 1 records this as blocked decision **B-6/B-7**. Check whether change 5's §6 ruling re-based on the ruled binding, deferred to the measurement gate, or silently kept the stale measurement as fact. If it asserts `backup()` wins citing a `node:sqlite` number, that is a **critical** finding.

**2. Contaminated numbers.** Six of seven research lanes benchmarked against `/tmp`, which was a
32 GB **tmpfs RAM disk**; the error on commit throughput was **233×**. **No lane performance number
may appear in a spec as fact.** Requirements that depend on a performance property must *establish*
it, with measurement conditions stated (filesystem, `journal_mode`, `synchronous`, dataset size
relative to page cache, single vs concurrent writer). Grep the specs for numbers and check each
one's provenance. A number presented as settled that traces to a tmpfs run is a **critical**
finding.

**3. Unfalsifiable requirements.** Every requirement must admit an observation that would prove it
violated. "The system SHALL be robust", "SHALL perform well", "SHALL handle errors appropriately"
are defects. For each requirement ask: *what experiment fails if this is false?* If you cannot
answer, it is a finding.

**4. Cross-change contradictions.** The five authors worked in parallel and could not see each
other's drafts. Specific interfaces to check:
- Change 1's shim decodes from `columns()` **origin metadata**; change 4 mandates `STRICT` tables,
  which reject `JSONB`/`BYTEA`/`TIMESTAMPTZ` as *declared type names*. Do both sides agree?
- Change 2's event-log schema changes the tables change 4 specifies types and constraints for.
- Change 3's `BEGIN IMMEDIATE` is a precondition for safety arguments elsewhere.
- Change 5's contract text must match what changes 1–4 actually promise.
- Do any two changes specify the same requirement differently? Do any leave a gap between them —
  something every author assumed a neighbour owned?

**5. Missing enhancement mandates.** The sprint was explicitly to migrate **and enhance**. Verify
each mandated enhancement is present as a real requirement with a scenario, not a mention:
structural gap-freedom (change 2), `STRICT` type rejection (change 4), the lease strengthening tied
to a surviving mechanism (change 3), and — most important — **the page-checksum gap** (change 5).
SQLite has no main-database page checksums; corrupting 64 bytes in a checkpointed main DB yields
`integrity_check → ok` and returns the corrupted row as data, where PostgreSQL offers
`data_checksums` and `amcheck`. Change 5 must close it or document the acceptance where a consumer
will see it. Silence is a critical finding.

**6. Scope discipline.** The chain archive is out of scope — `001_chain_archive_core.ts` states
"Not wired into any runner path that would execute it." Every change should list it as an explicit
non-goal (`config.yaml` requires explicit non-goals in every proposal). Also check nothing in the
plan assumes the archive migrates.

**7. Citation integrity.** `openspec/config.yaml` binds authors to verify every external API or
library claim against the installed version or real upstream source, cited `file:line`.
**Spot-check at least eight citations across the five changes by opening the cited file at the
cited line.** A citation that does not say what the spec claims is a serious finding — this project
has been burned by exactly that.

## Mechanical checks you must run

```
cd /root/UDB-sqlite-sprint
/usr/local/bin/openspec validate --changes --strict --no-interactive
```

Baseline before this sprint was **12 passed / 2 failed**; the two failures
(`v1.1.0-formal-completion`, `v1.1.0-quint-model-checking`) are **pre-existing and not the
authors' fault**. All five new changes must pass strict. Report the exact output.

Also confirm: no product code was modified (`git status` should show only new files under
`openspec/changes/`), and every change has the full five-file set.

## Traps

1. **WSL/Windows path trap.** The repo is in WSL; your tools run on Windows. A bare `/root/...`
   path given to Read/Write resolves on the **Windows** drive and silently reads or creates a
   phantom file. Use `\\wsl.localhost\Ubuntu-26.04\root\...`.
2. **WSL inline heredoc trap.** Never use `wsl -e bash -lc "..."` with **double** outer quotes.
3. **Use the Bash tool, not PowerShell, for WSL.**
4. **OpenSpec CLI:** `/usr/local/bin/openspec`. **`npx openspec` is a broken 0.0.0 stub** and the
   global `.bin` symlink is missing — this has already fooled three audit agents. If you find
   yourself concluding "openspec is not installed", you have hit this trap.
5. **Never claim "verified" without the command that produced it.**
6. **Do not fix what you find.** You are auditing. Report; do not edit.
7. **A green validation is not an approval.** `validate --strict` checks structure, not truth.

## Output

Write your findings to `\\wsl.localhost\Ubuntu-26.04\root\umbradb-sqlite-research\audit\<YOUR_ID>.md`.

Structure:

1. **Verdict** — `APPROVE`, `APPROVE WITH FINDINGS`, or `REJECT`, in one line, then 3–5 sentences.
2. **Critical findings** — would cause a wrong or unsafe thing to be built. For each: change id,
   file, what is wrong, what the plan should say instead, and the evidence.
3. **Major findings** — would cause rework.
4. **Minor findings** — clarity, consistency, style.
5. **What you verified and it was correct** — name the load-bearing things you checked that held.
   An audit that reports only defects gives no signal about coverage.
6. **Coverage gaps** — what the five changes collectively do not cover that they should.

Rank by impact. A precise critical finding is worth more than twenty style notes. If the plan is
good, say so plainly — a rubber-stamp and a manufactured objection are equally useless.
