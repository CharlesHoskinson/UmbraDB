# UmbraDB → SQLite: sprint synthesis

Seven research lanes, four adjudicating council seats, one knowledge graph.
Consolidated 2026-07-31. Corpus: `reports/` (lanes), `council/` (seats), `graphify-out/` (graph).

---

## Verdict

**Migrate. Land it before the 1.0.0 tag. Re-measure almost everything first.**

The migration is feasible, cheaper than it looks, and better-precedented than anyone in the sprint
initially assumed. But the *sprint's own numbers* are largely invalid, and two claims that SQLite
improves on PostgreSQL are actually regressions. The verdict survives; most of the evidence
supporting it does not, and must be re-established on real hardware before anyone commits code.

The right sequence is **migrate → sync → tag**, and that ordering is not a preference. It falls out
of three independently verified facts below.

---

## The five facts that decided it

Each verified by the coordinator against the repository or the live machine, not taken from a lane.

**1. The SemVer commitments are not yet binding.** `docs/STABILITY.md:46`, verbatim:

> **Current version: `0.9.5` — the commitments above are NOT yet in force.**

and at `:60-61`, that "a breaking change between `0.9.5` and `1.0.0` is permitted by SemVer." The
commitments seat confirmed this covers the **error catalog and the exported type surface**, not
merely function signatures. Every G1/G2/G3 break the sprint found — the `UmbraDBSql` frozen type,
`createClient`'s Postgres-shaped option bag, the error-code set, migration `006` — costs a CHANGELOG
entry if it lands pre-tag, and a major version if it lands after. **This is a 1.0.0, not a 2.0.0.**

**2. The tag is already blocked on something else.** `CHANGELOG.md` and `ROADMAP.md:389-398` show
1.0.0 gated on a full local Midnight sync, with step 4 already requiring the tag gate (R1–R12) be
re-run against a new RC. Two consequences: the pre-tag window is **not scarce**, and
`docs/recovery/EVIDENCE.md` re-execution is a **sunk cost of the tag, not a cost of the migration** —
a correction to L6, which billed it as a break. Better still, that mandatory sync **is** the
out-of-cache experiment the sprint could not run.

**3. There are no consumers to migrate.** `registry.npmjs.org/umbradb` returns 404; `docker ps -a`
shows no Postgres container, running or stopped; there is no publish step in CI. The
migrate-existing-user-data problem — which L7 documents as having cost every comparable project
years — is currently **zero work**. *Caveat, and it needs an answer from the owner:* the README
installs from a git tag, and git-tag installs are unobservable from here. "No consumers" is a fact
about the world only if nobody is installing from the tag.

**4. ~~The chain archive is not on the critical path.~~ — RETRACTED 2026-07-31.**

> **This fact was wrong, and the error was mine.** The quotation is accurate; the inference drawn
> from it is not. `001_chain_archive_core.ts` does say **"Not wired into any runner path that would
> execute it"**, and that comment is true *of `src/`* — which is all I checked, grepping
> `src/index.ts` and `src/postgres/migrate.ts` and reporting "(empty = not wired)". I never looked
> at `chain-archive-sync/`, a top-level directory that was in my first inventory of the repo.
> It wires the archive:
>
> - `package.json:46` — `"archive:sync": "tsx chain-archive-sync/sync-cli.ts"`
> - `chain-archive-sync/sync-cli.ts:4` — calls itself *"the production/ops entry point the feature
>   previously lacked"*
> - `chain-archive-sync/bootstrap.ts:21` — `await runMigrations(sql, { schema, migrations: chainArchiveMigrations })`
> - `chain-archive-sync/bootstrap.ts:6` — records that this invocation path *"was missing"*, i.e.
>   it was added **after** the migration file's comment was written
> - `chain-archive-sync/sync-service.ts:1` — constructs `PgChainArchiveStore`
> - `tsconfig.json` — `include` covers `chain-archive-sync/**/*.ts`
>
> Found by the cross-vendor Codex audit lane, whose formulation is exact: **"The quote is accurate;
> the inference is not."** Both Opus audit lanes, all four council seats, and I accepted the stale
> inference. The Fable adjudication diagnosed the shared failure precisely: *the panel verified
> quote fidelity, not premise currency.*
>
> **Consequences.** The archive is a live, wired, production-entry-pointed path. Change 1's
> `tasks.md:68` removes the `postgres` dependency while task 0 forbids touching the archive, so
> `chain-archive-sync/` would break at typecheck **and** at runtime. Every "chain archive is out of
> scope" non-goal across the five changes rests on this retracted premise and must be re-derived or
> replaced.
>
> **Ruling (Fable adjudication, gate R-1).** The archive is in scope **as a decision, not as work**.
> Default is to retain the `postgres` dependency scoped to `chain-archive-sync/`, amend change 1
> task 1.1, and correct every non-goal. A sixth change porting the archive is required **only if the
> owner elects to port it**. Note that L5's separate "no data" claim also predates the CLI and needs
> the owner to re-verify it rather than being inherited.
>
> L5's 4–6 week estimate remains excluded from the *migration* critical path under this ruling, but
> for a different reason than originally given: not because the archive is unshipped, but because
> retaining Postgres for it defers the port rather than performing it.

**5. The shape is already proven upstream.** The Midnight indexer — UmbraDB's own upstream — runs
its content-addressed ledger node store on SQLite:
`CREATE TABLE ledger_db_nodes (key BLOB PRIMARY KEY, object BLOB NOT NULL)`, verified on this
machine under `sqlx` migrations. **The scale claim is not proven.** Both L5 and L7 cite ~88–161 GB
from the in-repo record; the artifact on disk is 53.5 MB and runs `journal_mode=delete`. Shape:
yes. Scale: unverified, by two lanes independently.

---

## What broke under scrutiny

**The measurement environment invalidates most benchmarks.** Six of seven lanes benchmarked against
`/tmp`, which on this host is a **32 GB tmpfs RAM disk** (`df -hT /tmp` → `tmpfs`; `/root` is ext4).
Only L6 caught it mid-run and moved to ext4. Re-measured on real disk:

| Metric | Published (tmpfs) | Real (ext4) | Factor |
|---|---|---|---|
| WAL `synchronous=FULL` commits/s | 88,485 | 379 | 233× |
| L5 ingest throughput | 202.9 MB/s | 120.3 MB/s | 1.7× |
| L5 ingest at `FULL` | 213.4 MB/s | 72.5 MB/s | 2.9× |

Two L5 conclusions **invert**. "Durability is not the throughput lever (~12%)" is really 1.66× on
ingest and ~102× on commits. L5 published `FULL` as *faster* than `NORMAL` — physically impossible,
and a tell it did not act on. This also resolves the L5-vs-L6 "12% vs 27×" conflict: it was never a
workload difference, it was one lane measuring RAM.

**L5's verdict nonetheless survives** — 261–433× headroom over the ~1 GB/hour requirement on real
disk. But at `FULL` on disk, throughput decayed **2.64× over just 2.4 GB and was still falling**:
the out-of-cache onset L5 said it could not see.

**L1's clock crisis is contingent on a pragma it never varied.** The headline "99.2% of same-key
puts rejected" is real at `synchronous=NORMAL` and **0.0% at `FULL`** (5000/5000 accepted — at
7.2 ms/commit, two puts cannot share a millisecond). The monotone logical clock, its 1.8 s drift,
the dead `CLOCK_REGRESSION` code and the coupled `TRANSACTION_KEY_REUSE` weakening are **all
downstream of that one setting**. Recommendation: do not adopt the logical clock until re-measured.

**Three of four "SQLite is better than Postgres" claims fail.**

- **L2's sidecar lock file** is silently voided by a single `fs.readFileSync` of the lock file —
  POSIX record locks drop on *any* fd close in the process, and SQLite's VFS only defends its own
  descriptors. Also defeated by `unlink` (new inode → two simultaneous holders).
- **L6's "torn-page hazard is structurally absent"** covers the WAL only. **Coordinator-verified:**
  corrupting 64 bytes inside a checkpointed main database yields `integrity_check → ok`,
  `quick_check → ok`, and the corrupted row returned as data. SQLite has **no main-database page
  checksums**; PostgreSQL has `data_checksums` and `amcheck`. This is a **durability regression
  recorded as an improvement** — the most serious mis-framing in the sprint.
- **L4's "higher fidelity than `jsonb`"** trades away write-time validation, and lets
  `json_extract` and `JSON.parse` disagree about the same row.

**The feasibility seat's own correction was itself wrong.** Its "fixed ~101 µs per round trip"
grows with payload (114.7 → 503.6 µs at batch 100). Amortisation works for UmbraDB-owned composites
(`saveAndAdvance` ≈ 3×) but is **structurally unreachable for `withTransaction(fn)`** — a frozen G1
export whose body is arbitrary caller code (538.7 µs of transport for a 3-statement callback). The
worker also lengthens the global write-lock hold by ~110 µs per caller statement, which nobody
costed.

---

## What survived a genuine attack

Reported because it is what makes the criticisms above credible.

- **L1's central result is stronger than L1 claimed.** A trigger-based overlap check was attacked
  across 3 journal modes × 2 busy-timeout settings (L1 tested one cell); **T5 held in all six**. WAL
  is not even required — rollback-journal mode blocks the writer outright, a *stronger* exclusion.
  The finding that overturns the stated reason `EXCLUDE` constraints exist is real.
- **`TRANSACTION_KEY_REUSE` forgery failed.** L1 overstated the weakening; credit belongs to
  UmbraDB owning the transaction handle, not to the worker thread.
- ~~**The main WAL database survived the fd-close attack** (its locks live on `-shm`). Only the
  sidecar is exposed.~~ — **RETRACTED 2026-07-31. This was wrong.** The red team's original test
  probed the wrong thing, and I recorded its conclusion as a survival. The evidence-seat audit
  falsified it and the Fable adjudication reproduced it independently with a control arm and a
  mechanism-isolation arm, on ext4:

  ```
  [none]          competitor refused SQLITE_BUSY    acknowledged commit lost? no
  [shm-openkeep]  competitor refused SQLITE_BUSY    acknowledged commit lost? no
  [shm-readclose] competitor COMMITTED (ack ok)     acknowledged commit lost? YES — SILENT LOSS
                  integrity_check ok
  ```

  **`BEGIN IMMEDIATE` does not hold the WAL write lock across an open-then-close of an `-shm`
  descriptor inside the holding process.** A single `fs.readFileSync` of `-shm` voids it: a second
  OS process then commits *inside* the holder's transaction, **both `COMMIT`s return ok, one
  acknowledged commit is silently lost, and `integrity_check` still reports `ok`.** The
  `shm-openkeep` arm — opening the descriptor without closing it — is harmless, which isolates the
  fault to the POSIX close semantics rather than to reading the file at all.

  This is the same class of defect as the sidecar lease it was cited to contrast with, and it is
  more serious, because it applies to the **main database**. It is tracked as blocking gate **R-2**
  with seven sub-items across changes 2, 3 and 5, including a source guard banning in-process
  open+close of `-wal`/`-shm` on UmbraDB paths. The hazard is POSIX-specific; the Windows arm is
  routed separately.
- **Junction-table containment** (L4) and **`DROP TABLE` vs `DELETE`** (L5) were not challenged.

---

## Not closeable

Five items, of which one has real product consequence.

1. **In-process cancellation of a caller-supplied `withTransaction(fn)` body.** `node:sqlite`
   exposes no `sqlite3_interrupt` and no progress handler; the worker thread cannot amortise a
   frozen callback API. `docs/CONTRACT.md` §3's "long read wait is freed" clause must be **deleted,
   not reworded**.
2. **No main-database page checksums.** Either accept a detection gap Postgres does not have, or
   add application-level checksums. This deserves an explicit, written decision.
3. **`node:sqlite` is unpinnable and silently experimental** on the declared `engines` floor —
   RC only at Node 25.7, no `ExperimentalWarning` emitted at all, and no supply-chain gate can
   observe it. *The commitments seat rules against L3 here: prefer a pinnable third-party binding.*
   This is the one item with product consequence.
4. **`auto_vacuum` cannot be retrofitted**; space never returns without a full VACUUM.
5. **No live backup matching `pg_dump`.** L7: CLN warns `VACUUM INTO` locks the database for long
   periods and *retracted* its Litestream recommendation; LND's SQL `Copy` is
   `errors.New("not implemented")`; Zallet's procedure begins "Stop Zallet." G4 §6 must be rewritten.

---

## Plan

**Order: migrate → sync → tag.** Not merely "before the tag" — before the local-sync evidence run,
so `EVIDENCE.md` is executed once against the SQLite build rather than twice.

0. **Re-measure on ext4.** Every pragma, throughput and clock conclusion. Non-negotiable; the sprint
   cannot be implemented from as it stands.
1. **Ask the owner:** is anyone installing from the git tag? That single answer decides whether a
   data-migration path is needed at all.
2. **Driver + shim** (L3, amended by the commitments seat's pinnable-binding ruling). Gates
   everything else. `columns()` origin metadata, not declared type names, so `STRICT` survives (L4).
3. **Event-log schema for TemporalKV** (L1) — makes gap-freedom structural. Re-decide the logical
   clock *after* step 0.
4. **Lease, transactions, error mapping** (L2, L6) — with the sidecar's fd-close vulnerability fixed
   or the mechanism replaced.
5. **Type/query parity + junction table** (L4).
6. **Contracts, catalog, durability probe, evidence** (L6, commitments seat).
7. **Defer the chain archive entirely** until it has a consumer.

**Cost: ~100–150 engineer-days** for the wallet-side migration (two seats converged from
independent decompositions: 94–131 and 100–150). The naive lane sum of 123–176 double-counts the
shim, error translation, migration DDL and the test-fixture rewrite across four to five lanes each.
Archive deferred at +20–30 days whenever it is wanted.

**What the project gains:** test startup from ~2,500–3,300 ms per Postgres container to sub-
millisecond, plus deletion of the per-adapter test *architecture* that exists only to amortise that
cost; durability preconditions moving from deployer-supplied to library-controlled; gap-freedom
becoming structural for the first time; a strictly smaller trusted refinement bridge; and no
database for consumers to install or operate.

**What it loses, and nobody should discover later:** page-level corruption detection; any external
observability of a running engine (`pg_stat_*` has no analogue, and this is a library whose bug
reports read "the wallet is stuck"); `idle_in_transaction_session_timeout` with no backstop, while
`withTransaction` holds a **whole-database** write lock around arbitrary caller code; and encryption
at rest, which SQLite lacks entirely (SEE is commercial, SQLCipher is a fork).

---

## Unowned surfaces

No lane was assigned these, and they remain open: corruption response and field repair; Windows
behaviour; observability; PostgreSQL→SQLite data migration; and behaviour on network filesystems,
where SQLite is known-hazardous.

---

## On the formal layer

The Lean cut-line `{T3, T5, W1, C1}` survives a complete storage-engine replacement **untouched**,
because it models an abstract store and the abstract→concrete refinement was always an explicitly
trusted, unmechanized bridge. L1, L6 and the red team all independently flag this as **trap 8 — a
green gate certifies depth, never breadth** — rather than as reassurance. The honest reading: the
Lean work never constrained the concrete implementation, so it cannot vouch for the new one. Its
genuine merit under the L1 redesign is that the trusted bridge *shrinks* to a single property
(`WellFormed`: strictly increasing `written_at`). The P1–P10 conformance suite, not the proof
assistant, is what must carry the refinement claim — and it must be **re-executed, not amended**.
