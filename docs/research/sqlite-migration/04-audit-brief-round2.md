# UmbraDB → SQLite sprint: round-2 audit brief

You are auditing a **seven-change** OpenSpec sprint plan that has already survived one audit round,
three blocking remediation gates, and a Fable adjudication. This is the last review before
implementation begins.

**Read this first: the round-1 panel failed in a specific, documented way, and you are structured
to avoid repeating it.** Two of its three seats were Opus, briefed by the same coordinator who
briefed the authors. They verified the plan was internally consistent while *sharing its premises*.
The finding that mattered came from the cross-vendor seat, and it was that a load-bearing scope
claim — "the chain archive is unwired" — was stale. The Fable adjudicator's diagnosis:

> the panel verified quote fidelity, not premise currency.

Your job is premise currency. Assume the plan is coherent; ask whether it is **true**.

## What you are auditing

Worktree `\\wsl.localhost\Ubuntu-26.04\root\UDB-sqlite-sprint`, branch `sprint/sqlite-migration`,
under `openspec/changes/`. Seven changes, 20,327 lines, 157 requirements, 540 scenarios:

| Change id | Capability | Owns |
|---|---|---|
| `v1.0.0-sqlite-engine-core` | `sqlite-engine` | Driver ruling, shim, pragma bootstrap, worker topology, measurement gate |
| `v1.0.0-sqlite-temporal-event-log` | `temporal-kv` | Event-log redesign, T3/T5, clock, conversion boundary |
| `v1.0.0-sqlite-concurrency-lease` | `transaction-lease` | Lease, transactions, isolation, source guard |
| `v1.0.0-sqlite-schema-parity` | `storage-schema` | Types, constraints, indexes, migration lineage |
| `v1.0.0-sqlite-durability-contract` | `release-contract` | Contracts, error catalog, durability, backup, digests |
| `v1.0.0-sqlite-chain-archive` | `chain-archive` | Archive port, partitioning, snapshots |
| `v1.0.0-sqlite-data-migration` | `data-migration` | PostgreSQL→SQLite export/import for existing deployments |

Baseline: `openspec validate --changes --strict` gives **19 passed / 2 failed**; the two failures
(`v1.1.0-formal-completion`, `v1.1.0-quint-model-checking`) are **pre-existing and not the
authors'**. All seven must pass.

## Context you need

- `\\wsl.localhost\Ubuntu-26.04\root\umbradb-sqlite-research\SYNTHESIS.md` — the adjudicated
  research. **Two of its "verified facts" are retracted in place**; read the retractions, they are
  the clearest statement of how this project's errors happen.
- `.../audit/` — round 1: `opus-compliance.md`, `opus-evidence.md`, `codex-cold.md`,
  `fable-adjudication.md`, plus `fable-r3-ruling.md`.
- `.../council-r3/` — the three seats behind the digest ruling.
- `.../AUTHORING-BRIEF.md` and `.../AUDIT-BRIEF.md` — round 1's instructions.

## What changed since round 1, and what to check about each

**Three blocking gates were closed. Verify closure, do not assume it.**

- **R-1 (archive scope).** The premise "not wired into any runner path" was stale;
  `chain-archive-sync/` wires it. The archive is now **in scope** as change 6, `postgres` is removed
  outright, and the archive ports as a greenfield lineage (owner confirmed `archive:sync` has never
  run). Check: does any change still contain stale "archive is out of scope" wording? Change 1 added
  an enforcement grep for four refuted phrases — verify it actually covers all seven changes now,
  not the original five.
- **R-2 (`-shm` fd-close).** `BEGIN IMMEDIATE` does not hold the WAL write lock across an
  open-then-close of a lock-bearing descriptor *inside the holding process*. Measured across all
  three journal modes: under `wal` the locks are on `-shm`; under `delete`/`truncate` on the main
  database file. A build-failing source guard now covers all three files. Check the guard's scope
  matches every claim that depends on it — change 3 built an **inheritance table** (its design
  §2.6.2) enumerating everything resting on write-lock exclusivity, with a requirement that any
  such claim found without the qualifier is a specification defect. **Audit that table for
  completeness**: find a claim resting on write-lock exclusivity that is not in it.
- **R-3 (digests).** Coverage is column-level, not tier-level; three corruption classes (A: wrong
  bytes → digest; B: wrong row → invariants; C: schema → schema digest). Eight mandatory invariants
  **I-1…I-8**, each with an owner. Check every one has a requirement, an owner, and a scenario that
  fails if the assertion is dropped — and that no two changes specify the same one differently.

**Retracted premises. Any surviving trace is a finding.**

1. "The chain archive is unwired" — false.
2. "The main WAL database survived the fd-close attack" — false; the original test read `main.db`,
   but under `wal` the locks live on `-shm`.
3. **"UmbraDB is losing PostgreSQL page checksums" — false.** The durability probe reads only
   `fsync`, `synchronous_commit`, `full_page_writes`; `data_checksums`/`amcheck` appear nowhere in
   `docs/`, `src/` or `README.md`; and PostgreSQL's own `initdb` defaults checksums off through PG17.
   What is lost is the **operator's option**, never a guarantee UmbraDB made. Any contract sentence
   implying restored parity is false and is a **critical** finding.
4. "SQLite detects nothing" — false. **Structural** corruption is caught (`integrity_check` fires,
   the read throws `SQLITE_CORRUPT`); **payload-byte** corruption in overflow pages is not. The
   two-case wording is mandatory.

**Two live defects were found in *shipped* code, not in the migration.** Both are now specified,
and both are change 7's problem for existing deployments:
- No `UNIQUE (w, net, seq)` on `ckpt_manifests` and no `next_seq > max(seq)` invariant — a corrupted
  counter silently freezes the store at a stale checkpoint while every write reports success.
- `decodeRow` takes lifecycle from the JSON while the `lifecycle` column is never compared — the two
  can already drift undetected.
Check that change 7's reject-vs-quarantine ruling actually handles source rows that violate the
newly-added constraints.

## The failure modes specific to *this* round

**1. Relay-introduced error.** Almost every cross-change fact travelled through the coordinator as
prose. That is a lossy channel and it has already been wrong at least twice — it propagated a
numeric `errcode` discriminator that does not exist on the ruled binding, and it summarised an R-3
ruling omitting two of three invariants (change 6 caught it by reading the source document). **For
any fact one change attributes to another, check the source, not the citation.**

**2. Consistency-by-citation.** Changes now cite each other heavily — "per change 3 §2.6.2", "cited
to change 5". Verify the cited section says what the citing change claims, and that nothing is cited
in a circle with no grounding at either end.

**3. Over-claim of the same shape, in a new place.** Round 2 found the same error class three times:
counting observations of one mechanism as independent mechanisms. Change 2's "closed three
independent ways", change 3's `prune` C2a, change 2's transaction-identity guard. **Look for a
fourth.**

**4. Zero-row / silent-success.** Four instances so far: an `errcode` mapping reading `undefined`
and routing everything to the catch-all; an unseeded `UPDATE` matching zero rows while reporting
success; a deadline ending iteration *normally* so `{done:true}` is indistinguishable from
exhaustion; a schema probe that reports success on a database with no assertions. **Find a fifth.**

**5. Numbers.** No lane performance figure may appear as fact — six of seven research lanes
benchmarked on a tmpfs RAM disk (233× error on commit throughput). Every quantity should be a
measurement obligation under change 1's gate, or a labelled-inadmissible reference. Grep for digits
and trace provenance.

## Mechanical checks

```
cd /root/UDB-sqlite-sprint
/usr/local/bin/openspec validate --changes --strict --no-interactive
git status --porcelain -- src test chain-archive-sync package.json   # must be empty
```

`acceptance.md` is a **repo convention, not an OpenSpec requirement** — strict validation passes
without it, so check the file set by hand. Note `v1.0.0-sqlite-schema-parity` legitimately has 6
files (two delta directories).

## Traps

1. **WSL/Windows paths.** Repo in WSL, tools on Windows. A bare `/root/...` path given to
   Read/Write resolves on the **Windows** drive and silently creates a phantom file. Use
   `\\wsl.localhost\Ubuntu-26.04\root\...`.
2. **Never `wsl -e bash -lc "..."` with double outer quotes** — it eats backticks and corrupts content.
3. Use the Bash tool, not PowerShell, for WSL.
4. **OpenSpec CLI is `/usr/local/bin/openspec`.** `npx openspec` is a broken 0.0.0 stub that has
   fooled three audit agents. Concluding "openspec is not installed" means you hit this trap.
5. **Benchmark in `/root/`, never `/tmp`** — `/tmp` is a 32 GB tmpfs RAM disk.
6. `better-sqlite3@13.0.2` is unpacked at `/tmp/l3-bs3b`. **Do not run `npm install`.**
7. **Never claim "verified" without pasting the command.**
8. **Do not fix what you find.** Report; do not edit.
9. **A green validation is not an approval.** It checks structure, never truth.

## Output

Write to `\\wsl.localhost\Ubuntu-26.04\root\umbradb-sqlite-research\audit2\<YOUR_ID>.md`:

1. **Verdict** — `APPROVE`, `APPROVE WITH FINDINGS`, or `REJECT`, then 3–5 sentences.
2. **Critical findings** — would cause a wrong or unsafe thing to be built.
3. **Major** — would cause rework.
4. **Minor.**
5. **What you verified that held** — name the load-bearing things you checked. An audit reporting
   only defects gives no coverage signal, and round 1 showed that matters.
6. **Coverage gaps** — what the seven changes collectively do not cover.

Rank by impact. If the plan is good, say so plainly — a rubber stamp and a manufactured objection
are equally useless, and this plan has already absorbed four rounds of real correction.
