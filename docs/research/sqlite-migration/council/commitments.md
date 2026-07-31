# Council seat: frozen commitments and versioning

Seat id `commitments`. Repo read at `/root/UDB-sqlite-l6-contracts` @ `3c0c68b` (= `origin/main`,
verified). All seven lane reports read in full. Every quotation below is from the contract documents
themselves, not from a lane's characterisation of them.

---

## 1. Verdict

**L6's decisive claim is true, and it is stronger than L6 stated: `docs/STABILITY.md:46` reads
"Current version: `0.9.5` — the commitments above are NOT yet in force," and the surrounding text
puts the *exported type surface*, the *error-`code` set* and the *`retryable` markings* all inside
that same suspension.** The tag is additionally blocked on an unrelated milestone (a full local
Midnight sync) that will force a fresh RC and a re-run of the whole tag gate R1–R12 anyway, so the
pre-tag window is real, open, and not closing on the migration's schedule. **This is a 1.0.0, not a
2.0.0 — L2 and L3 reasoned correctly from a freeze that is not in force, and L4 reached the right
answer from a premise ("nothing in my lane is a permanent break") that does not generalise.**
Exactly one item in the whole ledger is a *permanent, unavoidable* surface change (`UmbraDBSql`, L3
B3) and exactly one is a *permanent broken promise* regardless of timing (CONTRACT §3's
"during a long read … the wait is **freed**"). Everything else is either free, avoidable by design
choice, or free-before-the-tag. **The pre-tag window's real price is not a CHANGELOG entry — it is a
second release-candidate cycle**, because `0.9.5` exists specifically so "that expectation can be
tested by real consumers before it becomes a promise," and a migration spends exactly that. Two
breaking items nobody in the sprint caught: `CLOCK_REGRESSION` narrowing from `conditional` to
`non-retryable` (a forbidden *weakening* of a `retryable` marking), and the fact that the catalog
freezes `{code → meaning → retryable}` but never freezes `{situation → code}` — which is what a
consumer actually depends on and what no gate can see.

---

## 2. Adjudications

### R1 — The decisive claim, verified, and what it does and does not cover

**Verbatim, `docs/STABILITY.md:44-50`** (my `sed -n '44,50p'`, pasted in §3):

> ## Scope and pre-1.0 note
>
> **Current version: `0.9.5` — the commitments above are NOT yet in force.**
>
> SemVer is explicit that in `0.y.z` "anything MAY change at any time; the public API SHOULD NOT be
> considered stable." This policy therefore describes the contract UmbraDB *will* honour from `1.0.0`
> onward, and `0.9.5` is the release candidate for it.

and at `:60-61`:

> What is **not** yet true at `0.9.5`: the three commitments above are not binding, so a breaking
> change between `0.9.5` and `1.0.0` is permitted by SemVer.

**Does it mean what L6 says?** Yes. **Does it cover the error catalog and the exported type surface
as well as function signatures?** Yes to all three, and the document says so twice more:

- Header, `:3-6`: "This document is the binding stability contract for the **1.0.0 public surface** —
  the single package-root barrel … **and the machine-facing error-`code` set**
  (`docs/ERROR-CATALOG.md`)."
- Commitment 1, `:18-25`: "the set of exported names, **their types**, and the frozen
  `StorageError.code` discriminants … are additive-only … The `code` values are a machine-facing part
  of the public API …, so the catalog is frozen under **exactly the same rule as the type surface**."
- `docs/ERROR-CATALOG.md:11-13` delegates upward: "It is governed by the [stability policy]…"

The suspension at `:46` is of "the commitments above" — all three, therefore both surfaces.
**L6's reading is correct and, if anything, understated.**

**Two facts L6 did not find that make the window larger, not smaller.**

1. `CHANGELOG.md:26-32` publishes an explicit escape hatch: "Treat 0.9.5 as the release candidate for
   that promise: depend on it, report what breaks, and **expect the surface to be identical at 1.0.0
   unless something found in the interim justifies changing it**." A storage-engine migration is
   precisely "something found in the interim". The change is therefore *inside* the published
   expectation, not a violation of a soft promise.
2. **The tag is blocked on something unrelated.** `CHANGELOG.md:15-18` — "**Blocked.** The 1.0.0 tag
   additionally requires a **full local sync of UmbraDB against Midnight** … which is not yet
   complete." `ROADMAP.md:389-398` sets out the remaining path and step 4 is: "Then, and only then,
   `1.0.0` — **re-running the tag gate (R1–R12) against the new RC**." So a new RC commit, a new
   R1–R12 pass and a fresh `docs/recovery/EVIDENCE.md` run were already mandatory before this sprint
   existed. This matters enormously for R4 below.

**Correction to L4:** L4 cites `docs/STABILITY.md:45`. The line is **46**. Content correct, citation
off by one — noted because this seat exists to check exactly that.

**The cost of the sequencing constraint, stated honestly.** It is *not* a CHANGELOG entry. The same
document that suspends the commitments also says (`:50`, `:62-63`) that "`0.9.5` is the release
candidate for it" and that "0.9.5 exists precisely so that expectation can be tested by real
consumers before it becomes a promise." A migration that changes `UmbraDBSql`, `createClient`'s
option bag, six class names and several error codes **retires 0.9.5 as a release candidate**. Tagging
1.0.0 straight off the migrated tree means freezing a surface no consumer has ever exercised, which
is the single thing the 0.9.5 release was built to prevent. **The honest price is one more pre-1.0
RC (call it `0.10.0`) with a soak window.** That is the sequencing cost, and it is worth paying.

### R2 — The break ledger

One row per commitment. "Permanent?" means *unavoidable by any design choice*, independent of when it
lands. "Pre-tag cost / post-tag cost" is the SemVer consequence.

| # | Commitment (as written) | What it promises today | What the migration does | Permanent? | Pre-tag | Post-tag | Found by |
|---|---|---|---|---|---|---|---|
| 1 | **G1** `UmbraDBSql` (`client.ts:10`, `index.ts:81`) — `Sql<{bigint:bigint}> & {readonly umbradbSchema:string}` | a nominal `postgres.js` type on the frozen surface | the type's declaration leaves with the `postgres` dep; no shim reproduces it nominally | **YES — the only one** | free | **major** | L3 B3 |
| 2 | **G1** `UmbraDBConnectionOptions` (`client.ts:44-77`) — 6 fields | `connectionString`, `maxConnections`, `connectTimeout`, `statementTimeoutMs`, `lockTimeoutMs`, `idleInTxTimeoutMs` | 4 removed or renamed; `statementTimeoutMs` recoverable via deadline UDF; `lockTimeoutMs`→`busy_timeout` | no (redesign) | free | major | L3 B4 |
| 3 | **G1** six `Pg*` class names (`PgTemporalKV`, `PgCheckpointStore`, `PgWatermarks`, `PgTransactionLeaseLayer`, `PgTransactionHistoryStorage`, `PgWalletStateEnvelopeStore`) | frozen exported names | become misnomers. Not machine-facing; keeping them is defensible | no | free rename | major rename | **no lane — mine** |
| 4 | **G1** `DEFAULT_SCHEMA` + schema-configurability | exported constant + `schema` ctor params | **survives byte-for-byte** under L4's table-prefix option (a); only the documented *meaning* narrows | no | nothing | nothing | L4 B2 |
| 5 | **G1/G3** `UnrecognizedPostgresError` / `UNRECOGNIZED_POSTGRES_ERROR` | frozen class name **and** frozen `code` string | the identifier contains "POSTGRES" in a product with no Postgres | no (renameable) | free | **major** (rename) or deprecate-and-add | L6 B5 |
| 6 | **G2** SemVer commitments | not in force at 0.9.5 (`STABILITY.md:46`) | — | — | — | — | L6 |
| 7 | **G3** catalog, 24 codes (verified by count) | `{code → meaning → retryable}` frozen; "no code removed, renamed, or repurposed, and no `retryable` marking weakened" | **10 of 24 Meaning cells name a Postgres artifact** (my grep, §3); +1 more (`TRANSACTION_KEY_REUSE`) whose mechanism changes with no text change | no | CHANGELOG | mixed — see R3 | L6 B5 (says ~6) |
| 8 | **G3** frozen retryable set `{CONNECTION_ERROR, TRANSACTION_FAULT, LEASE_TIMEOUT, MIGRATION_LOCK_TIMEOUT}` | four codes, all reachable | **survives as a set**; `CONNECTION_ERROR` becomes unreachable, the other three keep their meanings via `SQLITE_BUSY`/`517` | no | free | free | L2 (correct); L7 B8 (incorrect — see R-relay) |
| 9 | **G3** `CLOCK_REGRESSION` = `conditional` (`ERROR-CATALOG.md:42,73-89`) | two causes, one of which *is* retryable | L1's monotone clock **eliminates the same-millisecond cause**, leaving only the NTP-step cause → the marking narrows to `non-retryable` = **a forbidden weakening** (`ERROR-CATALOG.md:13`) | no (fixable) | free | **major** | **no lane — mine** |
| 10 | **G4 §1** durability, four binding deployer preconditions | `fsync`, `full_page_writes`, `synchronous_commit`, no pooler | collapses to **one** (local non-networked FS); WAL frame checksums make the torn-page hazard structurally absent | improves | doc rewrite | doc rewrite | L6 B6 |
| 11 | **G4 §2** forward-only migration | `up()`-only, no downgrade | *property* preserved; *capability* narrows — `ADD COLUMN … GENERATED … STORED` rejected on any non-empty table | no | **free** (fold 006 into 002) | permanent VIRTUAL workaround | L4 B1, L6 B3 |
| 12 | **G4 §3** cancellation — "**During a long read** … the in-flight cursor / lock wait is **freed**" | three timings, middle one load-bearing | **cannot be delivered.** No `interrupt()`, no progress handler, synchronous API. Worker thread restores it at 32× per-op latency; `backup()`/`VACUUM INTO` cannot be aborted at all | **YES — broken promise** | doc break | doc break | L2 B1, L3 B1, L5 B3, L6 B1 |
| 13 | **G4 §4** save-retry caveat | one hazard: `TransactionFaultError("connection-lost")`, commit outcome uncertain | needs a **second** clause: `faultKind:"timeout"` from a failed `BEGIN IMMEDIATE` is unambiguously "nothing happened" and is safely retryable *without* the `history()` re-check | no | new text | new text | **no lane — mine, prompted by L7 B8** |
| 14 | **G4 §5** lease limitation ("does not fence writes against connection death") | session advisory lock, not a fencing token | **improves**: the lock moves from the connection's failure domain to the process's; 0 ms successor acquisition after SIGKILL | improves | doc | doc | L2, L7 B5 |
| 15 | **G4 §6** backup/restore — the `pg_dump` command is quoted verbatim | one command, zero downtime, mid-GC-safe | every command replaced. Properties survive (`VACUUM INTO` reads one snapshot) but: **freezes the JS thread for the whole copy** (~11 min at 400 GB), `backup()` **accepts an `AbortSignal` and ignores it**, no PITR, and copying `.db` without `-wal` silently restores an arbitrarily old database | no | rewrite | rewrite | L5 B3, L6 B7, L7 B4 |
| 16 | **G4 §7** threat-model pointer / `SECURITY.md` | at-rest menu incl. **Postgres TDE** | TDE option struck; filesystem/volume encryption becomes the only no-code mitigation; file permissions become the access-control mechanism | no | doc | doc | L6 B8 |
| 17 | **G4 §8** format headroom | envelope versioned; chunk addressing not | unaffected | no | — | — | — |
| 18 | **G20** Lean cut-line `{T3,T5,W1,C1}` | 0-sorry, CI-gated | **zero Lean lines change.** T5(2) CALLER-ENFORCED→structural; T5(1) MECHANISM-SPECIFIED→structural; `TRANSACTION_KEY_REUSE` DB→adapter; the `WellFormed` discharge changes character | see R4 | register rewrite | register rewrite | L1 B6, L6 §3.14 |
| 19 | **`docs/recovery/EVIDENCE.md`** | R5 gate evidence, binding rule 1: must be against the RC commit | invalidated (records `postgres:17-alpine`; M5-3 names Postgres) — **but re-execution was already mandatory** per `ROADMAP.md:396` | no | ~zero incremental | ~zero incremental | L6 (as a break); **cost correction mine** |
| 20 | **P1–P10 / conformance gate** | `required-tests.manifest.json`, **25 ids, count pinned** at `check-required-tests.ts:100` | **6 required/deferred ids are engine-named in the id itself**; 3 more live in `test/postgres/` | no | forced-explicit | forced-explicit | **quantified by me** |
| 21 | `package.json:31-33` `engines: node >=24` | declared minimum runtime | `node:sqlite` is experimental there and **emits no warning** (my own run) | no | free raise | major raise | L6 B10 |
| 22 | `docs/supply-chain/inventory.md` + `supply-chain.yml` | `postgres@^3.4.9` locked, hashed (`:26`), gated | a built-in is unpinnable and invisible to lockfile, inventory and gate | no | new section | new section | L6 B10 |
| 23 | `Performance/CEILINGS.md` SC-1…SC-6 + `bench/baseline.1.0.0-perf-baseline.1.json` | recorded ceilings + baseline artifact | SC-2 curve invalidated, SC-3 hardens to *not fixable*, SC-6 moot. **`ROADMAP.md:425-432`: "No perf NUMBER gates the tag"** — so no gate breaks | no | re-baseline | re-baseline | L5 |
| 24 | `package.json:4` description "**PostgreSQL-backed**"; `ROADMAP.md:499-501` Non-goals "a single **Postgres** instance" | published npm metadata + roadmap text | become false | no | free | free | **no lane — mine** |

**Settling L2/L3 versus L4.** They are answering two different questions and both got their own
right. *Permanent break* and *forces a 2.0.0* are different predicates:

- **L3 is right** that a permanent, unavoidable surface change exists. `UmbraDBSql` is nominally the
  `postgres.js` `Sql` type; removing the `postgres` dependency deletes its declaration. No design
  choice preserves it. L4's "there is always a free option" reasoning has no counterpart here.
- **L4 is right** about the conclusion — this need not be a 2.0.0 — but reaches it from the wrong
  premise. L4 argues from the absence of permanent breaks *in L4's lane*, which does not generalise
  (see row 1). The actual argument against a 2.0.0 is R1: the freeze is not in force and the tag is
  blocked on an unrelated milestone.
- **Ruling: this is a 1.0.0.** Land it before the tag and rows 1, 2, 3, 5, 9, 11 and 21 cost a
  CHANGELOG entry and a rewritten `docs/`. Land it after and rows 1, 5, 9 and 21 each independently
  force a major — four separate reasons, any one sufficient.

### R3 — The error catalog specifically

**(a) Is an unreachable code a breaking change? No.** The policy names exactly four forbidden verbs.
`STABILITY.md:18-25`: "nothing already exported is **removed** or **changed incompatibly**, and no
existing `code` string is **renamed** or **repurposed**." `ERROR-CATALOG.md:12-13` adds: "no
`retryable` marking is **weakened**." An unreachable code is none of these. The class stays exported,
the discriminant stays narrowable, and the drift test compares "the doc's code set against the
*exported* class set" (`ERROR-CATALOG.md:50-58`) — reachability is not in scope and the gate stays
correctly green. **I agree with L6 and L2.**

**But the contract has a hole neither lane named, and it is the actual break surface.** The catalog
freezes `{code → meaning → retryable}`. It **never freezes `{situation → code}`**. A consumer's real
dependency is "when the database becomes unreachable I catch `CONNECTION_ERROR`". Making
`CONNECTION_ERROR` unreachable and routing that same situation to a new code satisfies every letter
of the policy, passes the drift test, produces no compile error — and breaks that consumer at
runtime. **Recommendation, pre-tag: either add one sentence to `STABILITY.md` binding the
situation→code mapping for the situations the Meaning column describes, or explicitly disclaim it.**
Today it is silently unpromised, which is the worst of the three states.

**(b) `CONNECTION_ERROR`. L6 is right that repurposing is breaking; L2 is right about the remedy.**

Repurposing is forbidden *by name*. The current meaning (`ERROR-CATALOG.md:25`) is "Driver-level
connection failure — a network code, a Postgres class-08 / shutdown SQLSTATE, or a `28xxx`
authentication failure". Re-pointing that at `SQLITE_CANTOPEN`/`READONLY`/`NOTADB` is repurposing on
its face. L6's deeper argument is the stronger one and I adopt it: `retryable`'s stated purpose is
"so a caller decides whether to retry **without parsing a message string**"
(`ERROR-CATALOG.md:8-9`). A field whose entire point is that the caller need not read the message
**cannot have its meaning changed by editing the message.** Keeping the marking while inverting the
behaviour it predicts is a semantic break the SemVer text does not catch — and the catalog already
documents this exact pathology for persistent `28xxx` auth failures at `:108-120`, where its own
resolution was *a new additive code*, not a repurposing. Precedent is in the document.

**Ruling: do not repurpose. Take L2's route** — leave `CONNECTION_ERROR` in the catalog, mark it
explicitly unreachable, and add non-retryable `DATABASE_UNAVAILABLE` / `DISK_FULL` /
`DATABASE_CORRUPT` (L6's proposal, `DISK_FULL` correctly `conditional`).

**One cost L2 did not price, which I verified.** Making `CONNECTION_ERROR` unreachable **deletes a
pinned required conformance id**: `crash.pg-kill-save.typed-connection-error`, whose assertion is
that an unclean Postgres kill mid-save "rejects with a TYPED ConnectionError … the parent asserts the
TYPED class + its stable `.code`, never a message substring"
(`test/integration/crash/pg-kill-save.crash.test.ts:31-39,369`). `EXPECTED_REQUIRED_COUNT = 25` is
pinned. So "make it unreachable" costs a manifest edit *and a pinned-count change*, and — the part
that matters — **removes the only empirical evidence that a retryable frozen code is reachable at all
under the new engine.** That deletion must be reviewed as a contract change, not as test
maintenance.

**(c) `UNRECOGNIZED_POSTGRES_ERROR`.** Three options; one is correct.

- *Keep the name.* Zero engineering, no SemVer event, permanent published falsehood in the one
  document that exists to be machine-read. Note it is **two** frozen things, not one: the `code`
  string and the exported class `UnrecognizedPostgresError` (`index.ts`, from `./postgres/errors.js`).
- *Rename in place.* Breaks the frozen `code` string (`STABILITY.md:18-25`, "no existing `code` string
  is renamed") **and** removes an exported class name (G1). Post-tag this alone forces a 2.0.0, as L6
  says. Pre-tag it is one commit.
- *Deprecate + add* (L6's table). Works post-tag under commitment 2 — but with a wart: commitment 2
  requires the deprecated export to "continue to work for the remainder of that major line"
  (`:26-32`). A catch-all that is never thrown does not *work*; it *exists*. Defensible, thin.

**Ruling: rename it pre-tag** to `UNRECOGNIZED_DATABASE_ERROR` / `UnrecognizedDatabaseError`. This is
the clearest case in the entire ledger where the pre-tag window buys something unobtainable later at
any price, and it costs one commit. If the tag is cut first, take deprecate-and-add and accept the
wart.

**(d) The item nobody caught: `CLOCK_REGRESSION` cannot silently narrow.** `ERROR-CATALOG.md:42`
marks it **`conditional`**, and `:73-89` explains that the marking is `conditional` *because* one of
its two causes — "a same-millisecond precision collision … **is** caller-fixable" — is genuinely
retryable, a distinction the doc records as having been added by a fourth-round cross-vendor
re-audit that "found the prior blanket 'non-retryable' wording wrong for one of them." **L1's
monotone clock eliminates exactly that cause.** If only the backward-NTP-step cause survives, the
marking narrows to `non-retryable` — and `ERROR-CATALOG.md:13` forbids that in terms: "no `retryable`
marking is **weakened**." No lane noticed. Free pre-tag; a forced major post-tag. The fix is in R6.

### R-relay — `SQLITE_BUSY`, LND #7869, and the frozen retryable set

**Ruling: L7's headline claim is wrong as stated; its underlying warning is right and should be
acted on anyway; and its proposed remedy is the one thing that must not be done.**

**Wrong as stated.** `SQLITE_BUSY` *does* have a home in the frozen set, and L2 found it while L7 was
writing. `TransactionFaultError`'s `faultKind` union already contains `"timeout"` and
`"serialization-failure"` — verbatim, `src/interfaces/transaction-lease.ts:76`:

> `readonly faultKind: "connection-lost" | "serialization-failure" | "deadlock" | "timeout" | "unknown",`

L2's mapping (its "Concurrency-related result-code mapping" table) is: `SQLITE_BUSY` (5) at the lease
acquire → `LEASE_TIMEOUT`; at the migration-lock acquire → `MIGRATION_LOCK_TIMEOUT`; at
`BEGIN IMMEDIATE` inside `withTransaction` → `TRANSACTION_FAULT(faultKind:"timeout")`;
`SQLITE_BUSY_SNAPSHOT` (517) → `TRANSACTION_FAULT(faultKind:"serialization-failure")`. Every one is
an existing frozen code, with an existing retryable marking, using an **existing member** of an
already-frozen union. **Zero surface change.** L7 wrote B8 without L2's mapping in hand and the two
lanes were never reconciled.

**Right anyway, for a different reason.** L7's instinct is sound and the reason is not taxonomy — it
is *frequency and locus*. Postgres blocks inside the server; SQLite returns to the caller. The
retryable set therefore stops describing rare infrastructure faults and starts describing routine
control flow, and the retry policy moves from "an occasional loop the caller might write" to "a
mandatory layer UmbraDB must ship." LND #7869 confirms this reading: the maintainer's own diagnosis
is "the current logic just sets a value, but then doesn't actually try re-execute the transaction
before reporting the error back to the caller" — **a missing retry layer, not a missing code.**

**Ruling 1 — does adding a code count as breaking under G2?** No, and both documents say so
explicitly, *even post-tag, even in a minor*. `STABILITY.md:20-22`: the frozen sets "are
**additive-only**: **new exports and new error codes may be introduced in a minor**, but nothing
already exported is removed or changed incompatibly." `ERROR-CATALOG.md:13`: "new codes may be added
additively in a minor." This is the third case L6 and L2 did not address, and the policy already
addressed it. **Adding a code is the cheapest lever in the entire ledger and it survives the tag.**

Two caveats to record, because neither document does:
- Additive-ness holds cleanly for the *runtime* `code` set. It does **not** hold automatically for the
  exported string-literal **union types** — `TemporalKVErrorCode`, `CheckpointStoreErrorCode`,
  `TransactionLeaseErrorCode`, `WalletStateEnvelopeErrorCode`, `SharedStorageErrorCode`, and
  `faultKind` itself. Widening a union in an output position breaks a consumer's exhaustive `switch`
  that relies on `never`. `STABILITY.md`'s "additive-only" language does not distinguish these and
  should.
- Adding *does* enlarge what SemVer must then protect forever. That is the standing argument for
  restraint, not for avoidance.

**Ruling 2 — does the pre-tag window become a safety argument, not just a cost argument?** Only
weakly here, because adding a code is free either way. The safety argument for landing pre-tag is
real but it lives elsewhere: in row 9 (`CLOCK_REGRESSION`'s forbidden narrowing), row 5 (the
`POSTGRES` name), and row 11 (fold migration 006 into 002 so the `ADD COLUMN … STORED` limitation
never becomes permanent). L4 is right that row 11 is where the window has genuine engineering value.
**However — and no lane made this argument — the strongest sequencing point is that the current tag
blocker is a full local Midnight sync (`ROADMAP.md:352-353,389-398`). If the migration lands first,
that demonstration is performed once, against SQLite, and counts. If it lands after, it is performed
twice.** That is an argument for landing the migration before the *local sync*, not merely before the
tag.

**Ruling 3 — do not add a `BUSY`/`WRITE_CONTENDED` code.** Adding one would repeat LND's mistake in a
new form: it promotes a transient into the caller's decision surface, which is exactly the shape that
produced #7869 (a transient BUSY surfaced to the caller mid-protocol, leaving durable state advanced
while the counterparty was not told). Keep `SQLITE_BUSY` **inside** UmbraDB behind a bounded retry
layer and surface it only when the bound is exhausted — at which point `LEASE_TIMEOUT`,
`MIGRATION_LOCK_TIMEOUT` and `TRANSACTION_FAULT("timeout")` are *precisely* right, because they
already mean "a bounded wait elapsed". Ship LND's four layers (`_txlock=immediate` equivalent
`BEGIN IMMEDIATE`, a busy bound, a jittered bounded retry classifier, a capped connection count) as
UmbraDB's own contract, not as caller advice. On the timeout number: L7's "5 seconds is not a
default, it is a bug" is the right read of the field evidence, and UmbraDB's existing `lock_timeout`
default of **30,000 ms** (`docs/durability-contract.md:103`) is already a far better starting point
than LND's 5 s — preserve it as `busy_timeout`.

**Ruling 4 — does `LEASE_TIMEOUT` still describe what the caller experiences under L2's poll loop?
Yes, and better.** `LeaseTimeoutError`'s frozen doc (`transaction-lease.ts:81-86`) promises exactly
two behaviours: thrown "when `opts.timeoutMs` was given and elapsed before the lock was acquired," and
"If no `timeoutMs` is given, `acquireLease` waits indefinitely (matching `pg_advisory_lock`'s real
blocking semantics) and this error cannot occur." L2's JS poll loop preserves **both** halves and
fixes the failure the naive `busy_timeout` port produced (1 acquired / 7 timeouts → 8/8, maxActive 1,
171 ms). The observable contract is unchanged; only the mechanism moves. **One clause does need
editing**: "matching `pg_advisory_lock`'s real blocking semantics" is a mechanism reference sitting
in the frozen surface's TSDoc, which ships in `dist/index.d.ts`.

**Ruling 5 — CONTRACT §4 needs a new clause, and this is where L7's warning has real teeth.** §4
today names exactly one retry hazard: a `TransactionFaultError` with `faultKind: "connection-lost"`
where "the commit outcome is **uncertain** because the `COMMIT` acknowledgement itself was lost", and
mandates "re-check `history()` before retrying". Under SQLite the *common* faultKind becomes
`"timeout"`, and it has the **opposite** property: a `BEGIN IMMEDIATE` that never acquired is
unambiguously "nothing happened", so it is safely retryable **without** the `history()` re-check.
§4 must say which faultKinds require the re-check and which do not. New text, not a rewrite. No lane
flagged it.

**One caution I adopt from L7 and pass to the performance seat:** do not quote LND's "SQLite beats
Postgres" numbers. They compare a key-value store emulated in SQL, pathological on Postgres; CLN,
running a real relational schema on both, reports the opposite. The honest case here is operational
simplicity and single-process fit, not speed. Nothing in my ledger depends on a speed claim.

### R4 — A frozen commitment that gets *stronger* is still a change

**(i) What the Lean actually proves — read directly, not via a lane.**
`Formal/Lean/UmbraDBFormal/TemporalKV/Model.lean:9-12,42`: `Event := {value, writtenAt : Time}`,
`History := List (Event Value Time)`. Intervals are **not stored** — `validityIntervals` (`:57-62`)
derives them pairwise from consecutive events. `adjacent_intervals_gap_free` (`Laws.lean:283`) is
proved by bare structural induction **with no hypothesis whatsoever**. Non-overlap and the T3/T4
results are conditioned on `WellFormed` (`Model.lean:64-72`) = strictly increasing `writtenAt` along
the per-key chain. `Time` is abstract, carrying only `[LinearOrder Time]`.

Three consequences the sprint should state out loud rather than absorb:

1. **The Lean is immune because it models a derivation.** The concrete store's only job is to supply a
   `WellFormed` event list. The gate certifies the derivation; 100% of the migration risk is in the
   supply. That is trap 8 in its purest available form, and both L1 B6 and L6 §3.14 read it correctly:
   "its greenness across an engine swap is *evidence of the disconnection*, not evidence of
   portability."
2. **L1's SQLite redesign is a strictly closer refinement than today's Postgres schema, and this is
   checkable rather than rhetorical.** L1's `kv_event` table plus the `LEAD()` `kv_validity` view *is*
   `History` plus `validityIntervals`, compiled to SQL. Today's `kv_history` **materialises** the
   intervals, which creates a refinement obligation with no counterpart in the model at all — "no
   stored interval is unrelated to any event" — discharged today only by the GiST `EXCLUDE`. The
   migration therefore **removes an obligation** rather than weakening one. I confirmed this against
   the Lean source. It is the most under-weighted finding in the sprint.
3. **`Time` being abstract is also how the Lean fails to see the drift.** Any linear order satisfies
   it. A `written_at` running 1.8 s ahead of wall time is `WellFormed`. So the Lean's continued
   greenness is, specifically, *silence* about the exact thing R6 is about. That belongs in the
   register in those words.

**(ii) Where the change actually lands: the discharge of `WellFormed`.** Today it is a **database
CHECK** — `CONSTRAINT kv_history_range CHECK (valid_from < valid_to)`
(`src/postgres/migrations/001_temporal_kv.ts:96`), whose SQLSTATE 23514 *is* `CLOCK_REGRESSION`.
Under L1's design it becomes the `kv_event_bi` `BEFORE INSERT` trigger plus
`UNIQUE (ns,scope,key,written_at)`. **L1 deserves credit: that is still database-enforced.** But the
*value* is now computed by `max(unixepoch('now','subsec')*1000, prev+1)` in the same INSERT, so on
the happy path the assertion is vacuous. The trigger stops witnessing "the clock behaved" and starts
witnessing "the adapter emitted the right SQL". That is a real change in what the evidence means and
it is invisible in the status label. **This is a second enforcement demotion L1 did not name** — L1
named only `TRANSACTION_KEY_REUSE` — and unlike that one it touches the frozen cut-line rather than a
G3 code.

**(iii) Must `docs/recovery/EVIDENCE.md` and P1–P10 be re-executed rather than amended? Yes — three
times over, and two of the three reasons are the repo's own rules.**

1. **EVIDENCE.md forbids amendment itself.** Binding rule 1, verbatim (`:19-21`): "The run MUST be
   against the **RC commit** — the exact SHA that will be tagged. An earlier green run against a
   different commit does **not** satisfy R5 and MUST NOT be copied in." Its Run-identity table
   records `Postgres | Testcontainers postgres:17-alpine (digest-pinned in the test setup)`, and
   sub-criterion M5-3 reads "a **fresh object graph** is constructed **from Postgres**". These are
   engine-named rows, not incidental prose.
2. **But the re-execution is already required and already paid for.** `ROADMAP.md:396`, step 4 of the
   path to 1.0.0: "Then, and only then, `1.0.0` — **re-running the tag gate (R1–R12) against the new
   RC**." The tag is blocked on the local-sync milestone, so a new RC and a fresh R5 run were coming
   regardless. **The migration's incremental cost against EVIDENCE.md is close to zero.** This is a
   material correction to L6, which lists EVIDENCE.md under "what it breaks" — it is a sunk cost, not
   a migration cost. (I also verified `git merge-base --is-ancestor 8a684fc 3c0c68b` → YES and
   `git diff --stat 8a684fc 3c0c68b -- src test` → one test file, zero `src/` files, so the artifact's
   own "identical code" claim holds against today's `origin/main`.)
3. **The conformance gate mechanically forbids silent amendment, and the project built that on
   purpose.** `test/integration/required-tests.manifest.json` carries **25** required ids, structurally
   pinned by `EXPECTED_REQUIRED_COUNT = 25` (`check-required-tests.ts:100`) so that "silently deleting
   (or adding) a required entry fails the gate". **Six ids are engine-named in the id itself:**
   `crash-harness.smoke.pg-terminate-backend-drops-and-recovers`,
   `crash.pg-kill-save.typed-connection-error`, `crash.pg-kill-save.retry-benign-duplicate`,
   `crash.cursor-durability.synchronous-commit-on`, `crash.cursor-durability.synchronous-commit-off`,
   plus deferred `crash.pg-kill-save.no-duplicate-with-idempotency-key`. Three more live in
   `test/postgres/`. You cannot amend these and you cannot delete them quietly.
   **Ruling: use that mechanism as designed. Do not edit the pinned count in the same commit as the
   deletions** — that converts a reviewed contract change into a diff nobody reads.

**(iv) What new evidence would justify claiming SQLite refines the same abstract model.** I adopt
L6's four items, add two, and impose a sequencing rule:

1. A **rewritten refinement register** (`openspec/changes/v1.1.0-formal-completion/design.md:50`), row
   by row, old mechanism struck, new mechanism named, and **the status label re-derived rather than
   carried over**: T5(1) MECHANISM SPECIFIED (`EXCLUDE`) → **structural** (overlap unrepresentable);
   T5(2) CALLER-ENFORCED → **structural**; T4 clock → *restated, not re-mechanised* (see R6); C2a →
   easier (single-writer serialisation replaces the two-session `FOR SHARE`/`FOR UPDATE` argument);
   L1 → new mechanism, and a new voiding precondition ("a second process, a network filesystem, or a
   `-shm` on a filesystem without working shared memory") replacing "a transaction pooler".
2. **P1–P10 re-executed** against SQLite — executed, not ported-and-assumed. Conformance-as-refinement
   *is* the entire bridge and it is engine-specific by construction. L7 B7's counter-consideration is
   the right frame: LND and CLN both run their suites against two engines precisely because they do
   not trust one to stand in for the other.
3. **New properties for obligations SQLite creates that Postgres never had.** L6's P11
   (`journal_mode=wal` and `synchronous ≥ 1` at every commit the durability contract covers — the
   pragma is persistent *in the file* and mutable out from under us), P12 (post-crash
   `integrity_check=ok` **and** cursor ≤ data), P13 (a `VACUUM INTO`/`backup()` copy satisfies the
   manifest→chunk closure — today a documented property of `pg_dump`, tomorrow a property of *our own
   code*, so it must be tested rather than asserted). **Add P14: `foreign_keys=ON` on every
   connection.** It is off by default, per-connection and non-persistent, and
   `ckpt_manifest_chunks`' `ON DELETE CASCADE` makes GC a **silent no-op** without it (L6 §4.2). A
   silently-no-op GC is a C2a safety matter, not a config nit.
4. **An explicit statement that C2a and L1 are `MECHANISM SPECIFIED, not proved`, and that the
   mechanism named in that specification no longer exists.** L6's formulation is exactly right and I
   endorse it: "a reviewer who sees 'C2a: MECHANISM SPECIFIED, P8 green' after the migration is
   looking at a different claim wearing the same words."
5. **Mine — a negative control for every crash property that survives.** L6's own §3.5 is the model:
   9/9 held for the co-transactional shape *and* the forbidden cursor-first shape violated the
   invariant 4/9, which is the only reason 9/9 meant anything. A migration is precisely the situation
   in which a re-executed test goes green for the wrong reason.
6. **Mine — sequencing: write the register *before* the port, not after.** Written after, it documents
   what was built. Written before, it constrains it.

**The honest limit.** None of this closes the bridge; it is trusted by design and `ROADMAP.md:404-410`
already records "a written deferral to post-1.0 of … **the whole SQL/runtime refinement**." What the
migration changes is the bridge's *size*, and per (i)(2) the event-log design makes it smaller. That
is a genuine gain and should be claimed as one. It is not mechanisation and must not be written as
if it were.

### R5 — The `engines` floor and the unpinnable dependency

**Facts I re-verified myself.** `package.json:31-33` is `"engines": { "node": ">=24" }`. On this host
(`node v24.18.0`), `require("node:sqlite")`, opening a database and running DDL emits **no process
warning of any kind** — I registered a `process.on("warning")` handler and it fired for nothing
(command and output in §3). `sqlite_version()` → **3.53.1**. The Node stability-index claim
(experimental on 24, "release candidate" at 25.7) is a **citation** in L6 and the coordinator's relay;
I did not verify it and do not treat it as measured.

**The argument is not about risk magnitude; it is about observability.** `postgres@^3.4.9` is locked
in `package-lock.json`, hashed in `docs/supply-chain/inventory.md:26`
(`sha512-GD3qdB0x…KDLnaw==`), and gated by `supply-chain.yml`. `node:sqlite` appears in **none** of
the three. A Node *patch* upgrade can change both the bundled SQLite version and the module's API
shape under a frozen contract, and no lockfile, no inventory row, no CI gate and no runtime warning
will say so. That is not "one fewer dependency"; it is "one dependency relocated outside the
perimeter the project built to watch dependencies." L6 is right that the "zero runtime dependencies"
framing is doubly wrong — `dependencies` is `{postgres, zod}`, so the win is 2→1, and `zod` is
load-bearing for `VALIDATION_FAILED` at every boundary.

**The frame problem, which is my seat's actual objection.** `STABILITY.md:18` commits UmbraDB to "No
breaking changes to the exported surface or the error-`code` set in a minor or patch release." You
cannot make that promise about a surface whose runtime substrate reserves the right to change in a
minor. That is not a risk assessment — it is a contradiction between two documents, and it is why
L6 is right that B10 outranks even the cancellation break: B1 breaks one written clause, B10
undermines the frame in which all eight are written.

**Ruling, four parts.**

- **(a) Prefer a pinnable third-party binding (`better-sqlite3` or equivalent) for the 1.0.0 line.**
  L6's comparison table is the right one and I reach its conclusion more strongly. The supply-chain
  trade is roughly a wash — an auditable, hashed npm package containing a prebuilt binary, versus an
  unpinnable platform API no gate can observe. The **stability** trade is one-sided. Neither fixes
  cancellation (both synchronous). The one thing the built-in uniquely buys — zero new npm entries —
  is the least valuable item on the list for a project whose supply-chain posture is a stated selling
  point. **L3's recommendation is defensible on every axis except the one that decides a 1.0.0.**
  L3's genuine wins should not be lost in the swap: `node:sqlite` ships the newest SQLite of any
  candidate (3.53.1 here, measured) and exposes `enableDefensive()`/`setAuthorizer()`; whichever
  binding is chosen must be checked against those.
- **(b) Do not raise the `engines` floor to `>=25.7` to buy RC status.** Node 25 is the non-LTS
  current line. A 1.0.0 library for wallet clients whose minimum runtime is non-LTS is a worse
  product decision than the one it fixes — and it does not fix it, because "release candidate" is
  still not "stable". If (a) is taken, the floor can stay `>=24` on its own merits and the question
  closes. Record independently that **raising an `engines` floor is itself a breaking change** (it
  removes runtimes the package claims to support) and therefore rides the same pre-tag clock as
  everything else in the ledger.
- **(c) Make the inventory change a tag precondition, not a nice-to-have.** Whichever driver wins,
  `docs/supply-chain/inventory.md` gains a "platform-provided / vendored, version-pinned" section
  naming the module and the bundled SQLite version, and CI gains an assertion that the runtime's
  `sqlite_version()` matches the recorded one. This is mandatory under (a) too — a third-party
  binding also vendors a SQLite build that must be inventoried. Without it, a patch upgrade silently
  swaps the storage engine under a frozen contract, which is exactly the class of event the
  supply-chain gate exists to catch.
- **(d) The published metadata, which no lane mentioned.** `package.json:4`: "A local, single-writer,
  **PostgreSQL-backed** temporal and content-addressed store for Midnight wallet state." That is npm
  registry text, covered by no freeze, and the first thing a consumer reads. `ROADMAP.md:499-501`
  Non-goals: "UmbraDB is designed for a single writer against a single **Postgres** instance."

### R6 — The frozen `writtenAt: Date`

**Correct the framing first.** The frozen things are `readonly writtenAt: Date`
(`src/interfaces/temporal-kv.ts:153`), `VersionedEntrySchema`'s `writtenAt: z.date()` (`:143`) —
pinned to each other by a real `AssertExact` mutual-assignability guard (`:156-163`) — and `AsOf`'s
`{kind:"at"; readonly at: Date}` (`:167`). `Date` is millisecond-quantised and
`getAt({kind:"at", at: writtenAt})` must round-trip. L1's "microsecond storage is ruled out by the
frozen API, not by SQLite" is correct about the field.

**What the sprint missed: the frozen surface already disclaims wall-clock semantics, in TSDoc that
ships in `dist/index.d.ts`.** `src/interfaces/temporal-kv.ts:171-177`, verbatim:

> `{kind: "at"}` addresses the successfully persisted `writtenAt` **coordinate**. Given strict
> same-key timestamp increase and the one-`put`-per-key-per-transaction rule, every committed version
> has a distinct recorded write timestamp, so the two addressing schemes agree there (Law T4). The
> coordinate is `clock_timestamp()` at statement/trigger execution, **not a true transaction commit
> or visibility timestamp; commit-time refinement remains a separate obligation.**

The formal layer is blunter still — `Formal/STORAGE_ALGEBRA_LEAN_RESEARCH.md:729`: "**Time meaning:**
strictly increasing recorded write time (`writtenAt`), not [commit time]". So the promise is a
**strictly increasing per-key coordinate that agrees with version ordering, explicitly not a true
time**. A monotone logical clock satisfies that promise exactly. It falsifies precisely one clause:
"the coordinate is `clock_timestamp()` at statement/trigger execution."

**Is a `written_at` that can run seconds ahead of wall time acceptable for a temporal store?**
**Yes — for point-in-time reads, unambiguously**, because `getAt({at})` compares against the *same*
coordinate. T3, T4 and T5 are all internal to the coordinate and none of them is weakened. The
exposure is entirely external.

**What breaks for a caller comparing `writtenAt` to its own clock.** It can observe a timestamp up to
~1.8 s in the future (L1 E9b, after an unthrottled 2,000-put burst; **0 ms drift measured at 10, 100
and 1,000 puts/s**). Concretely: `Date.now() - entry.writtenAt` goes negative; a TTL keyed on
`writtenAt` expires late by the drift; correlating `writtenAt` against a chain block timestamp or a
log line mis-orders events inside that window. None of these is a UmbraDB-internal failure.
**The honest sentence for the TSDoc is: `writtenAt` is a store coordinate that is usually wall time
and is never behind it; it must not be used as a clock.** That is a narrowing of an
already-hedged documented meaning, not a signature change — cheap before or after the tag.

**Pricing both, as asked.**

*Option A — keep `writtenAt: Date`, accept the drift.* Three costs:
1. Rewrite the TSDoc clause above and document the drift bound in `docs/SCHEMA.md` and CONTRACT.
   Free; docs are not frozen.
2. **Re-point `CLOCK_REGRESSION`** — L1's adapter obligation 5, and the item that is *not* free. Per
   R3(d), the monotone clock removes the same-millisecond cause, which is the sole reason the marking
   is `conditional`; losing it narrows the marking to `non-retryable`, a forbidden weakening.
3. **Bound the drift and make it observable** — the item nobody costed. L1's 1.8 s is what one
   2,000-put burst produced, *not* a bound; the quantity is unbounded in principle above 1 put/ms/key.
   Add a configured maximum-drift threshold, raise a typed warning or `ClockRegressionError` when
   `written_at − wall_clock` exceeds it, and assert it as a conformance property. **This single
   change does three jobs at once:** it converts an unbounded quantity into a bounded, observable
   one; it gives `CLOCK_REGRESSION` a second live cause and so **preserves the `conditional` marking**,
   dissolving the only forced-major in this ruling; and it gives the refinement register something
   concrete to say about T4. ~2 engineer-days.

*Option B — change the frozen field.*
- **B1: `writtenAt: bigint` (microseconds).** Genuinely more faithful, matches how `version` is
  already handled. Costs a hard break of `VersionedEntry`, `AsOf.at`, `VersionedEntrySchema` and the
  `AssertExact` guard; every consumer call site changes. Free pre-tag, a 2.0.0 after.
  **But it does not buy what it appears to buy.** L1 measured SQLite's SQL-layer clock at a hard
  **1.000 ms** resolution with no finer option at the SQL layer (E1.1: 200,000 reads over 150 ms →
  147 distinct values, smallest nonzero gap 1.000 ms). Widening the *field* does nothing unless the
  *source* is finer, and at the SQL layer it is not. **The monotone clock would still be required and
  the drift would still exist.** L1's framing — "microsecond storage is ruled out by the frozen API,
  not by SQLite" — is true of the field and misleading about the outcome. This collapses Option B.
- **B2: add `writtenAtMicros?: bigint` alongside.** Additive, non-breaking even post-tag, and
  pointless given B1's finding — it buys nothing and invites two coordinates that can disagree.

**Ruling: Option A.** Not because changing a frozen field is expensive — pre-tag it is nearly free —
but because it does not fix the thing it looks like it fixes. The collision rate is a property of
SQLite's 1 ms SQL clock, not of the field's width. Spend the pre-tag window on the `CLOCK_REGRESSION`
re-pointing and the drift-bound property; those are the two items that genuinely cost something after
the tag.

### Council question 3 (cancellation) — my seat's narrow ruling

I defer the worker-thread trade to the driver/performance seats. My ruling is on the *text*: **CONTRACT
§3's middle timing must be deleted, not reworded, and this is the one permanently broken promise in
the ledger.** Four lanes reached it independently (L2 B1, L3 B1, L5 B3, L6 B1) with direct
measurement. What the caller loses is stated plainly: a `listKeys` or lease-wait abort no longer frees
the in-flight work; the abort is observed only *between* statements. And note the collision L5 found
that L6 did not: even if the worker thread is bought, `backup()` "accepts an `AbortSignal` and ignores
it" and `VACUUM INTO` freezes the thread for the whole copy — so **G4 §6 needs a stated exception to
G4 §3 regardless of the driver decision**. Whichever way the worker-thread call goes, §3 gets rewritten
to promise less.

### Council question 8 (cost and sequencing) — the ordering constraint only

I do not own the engineering total and will not add the lanes. The ordering constraint my seat owns is
short:

1. **Decide driver + `engines` (R5).** It gates whether 1.0.0 can be tagged honestly at all.
2. **Rename `UNRECOGNIZED_POSTGRES_ERROR`; settle the catalog deltas** (R3). One commit; only free
   before the tag.
3. **Write the refinement register** (R4 iv). Before the port, not after.
4. **Port.**
5. **Cut a new pre-1.0 RC (`0.10.0`) and soak it.** This is what 0.9.5 was for and the migration spends
   it (R1).
6. **Local-sync milestone** — and per R-relay ruling 2, doing this *after* step 4 means performing it
   once instead of twice.
7. **Re-run R1–R12; re-execute `docs/recovery/EVIDENCE.md` against the new RC.** Cost already sunk.
8. **Tag 1.0.0.**

---

## 3. Evidence

**Re-checked myself (commands and output).**

```
$ wsl -e bash -lc 'cd /root/UDB-sqlite-l6-contracts && sed -n "44,50p" docs/STABILITY.md'
## Scope and pre-1.0 note

**Current version: `0.9.5` — the commitments above are NOT yet in force.**

SemVer is explicit that in `0.y.z` "anything MAY change at any time; the public API SHOULD NOT be
considered stable." This policy therefore describes the contract UmbraDB *will* honour from `1.0.0`
onward, and `0.9.5` is the release candidate for it.
```
→ L6's claim confirmed at the cited line. L4's `:45` is off by one.

```
$ # catalog row count, derived not asserted
$ awk '/^\| Code \| Class \| Meaning \| Retryable \|/{f=1;next} f&&/^\|---/{next} f&&!/^\|/{f=0} f' docs/ERROR-CATALOG.md | wc -l
24
$ # rows whose Meaning cell names a Postgres-specific artifact
$ awk '/^\| `/{print}' docs/ERROR-CATALOG.md | grep -icE 'postgres|sqlstate|23P01|23514|40001|40P01|advisory|jsonb|bytea|fsync|full_page_writes|pooler|28xxx|class-08'
10
SERIALIZATION_FAILED  CONNECTION_ERROR  TRANSACTION_FAULT  LEASE_TIMEOUT  EXCLUSION_VIOLATION
CLOCK_REGRESSION  UNRECOGNIZED_POSTGRES_ERROR  MIGRATION_LOCK_TIMEOUT
DURABILITY_CONTRACT_VIOLATION  TRANSACTION_POOLER_DETECTED
```
→ 24 confirmed (L6 correct; the shared `00-BRIEF.md` says 25 and is **wrong**). L6 says "~6 of 24
change meaning or die"; by engine-named text the number is **10**, plus `TRANSACTION_KEY_REUSE` whose
mechanism changes with no text change. L6 was counting caller-observable semantic change, which is
the right unit for G2 — but the *documentation* debt is 11 rows, not 6.

```
$ node -e 'let w=false; process.on("warning",x=>{w=true;console.log("WARNING:",x.name,"|",x.message)});
           const s=require("node:sqlite"); const d=new s.DatabaseSync(":memory:"); d.exec("create table t(a)");
           setTimeout(()=>console.log("node",process.version,"| any process warning emitted?",w),50);'
node v24.18.0 | any process warning emitted? false
$ node -e 'const s=require("node:sqlite");console.log(new s.DatabaseSync(":memory:").prepare("select sqlite_version() v").get().v)'
3.53.1
```
→ Independently reproduces L6 B10's central measurement: **the experimental status is completely
silent at runtime.**

```
$ git merge-base --is-ancestor 8a684fca261ef0581a1b7b5e4c4ac6517c779561 3c0c68b && echo YES
YES
$ git diff --stat 8a684fca... 3c0c68b -- src test
 test/api-surface/package-json-strict.test.ts | 14 ++++++++++----
 1 file changed, 10 insertions(+), 4 deletions(-)
```
→ `EVIDENCE.md`'s claim that the re-version to 0.9.5 "changed no `src/` or `test/` file" is **very
nearly** true against today's `origin/main`: zero `src/` changes, one api-surface test changed.

```
$ node -e 'const m=require(".../test/integration/required-tests.manifest.json");
           console.log("required:",m.required.length)'
required: 25
$ grep -n "EXPECTED_REQUIRED_COUNT" test/integration/check-required-tests.ts
100:export const EXPECTED_REQUIRED_COUNT = 25;
$ # ids engine-named in the id itself
crash-harness.smoke.pg-terminate-backend-drops-and-recovers
crash.pg-kill-save.typed-connection-error
crash.pg-kill-save.retry-benign-duplicate
crash.cursor-durability.synchronous-commit-on
crash.cursor-durability.synchronous-commit-off
crash.pg-kill-save.no-duplicate-with-idempotency-key   (deferred)
```
→ New, and the hardest mechanical interlock in the ledger. Quantified by no lane.

```
$ grep -oE "\bPg[A-Za-z]+|UnrecognizedPostgresError" src/index.ts | sort -u
PgCheckpointStore PgTemporalKV PgTransactionHistoryStorage PgTransactionLeaseLayer
PgWalletStateEnvelopeStore PgWatermarks UnrecognizedPostgresError
$ grep -n "readonly faultKind" src/interfaces/transaction-lease.ts
76:    readonly faultKind: "connection-lost" | "serialization-failure" | "deadlock" | "timeout" | "unknown",
$ grep -n "CHECK (valid_from < valid_to)" src/postgres/migrations/001_temporal_kv.ts
96:      CONSTRAINT kv_history_range CHECK (valid_from < valid_to),
```
→ Line 76 is what refutes L7 B8's headline: `"timeout"` and `"serialization-failure"` are **already**
frozen members. Line 96 is the current database-level discharge of the Lean's `WellFormed`.

Also read directly, not via a lane: `docs/STABILITY.md` (all 66 lines), `docs/CONTRACT.md` (all 8
sections), `docs/ERROR-CATALOG.md` (all 24 rows + all four rationale sections),
`docs/durability-contract.md`, `docs/checkpoint-store-contract.md`, `docs/recovery/EVIDENCE.md`,
`CHANGELOG.md`, `ROADMAP.md` §"What blocks 1.0.0" + the 1.0.0 acceptance checklist + Non-goals,
`src/index.ts` (the barrel), `src/postgres/client.ts:1-115`, `src/interfaces/temporal-kv.ts`,
`src/interfaces/transaction-lease.ts`, `Formal/STORAGE_ALGEBRA.md` §T5,
`Formal/Lean/UmbraDBFormal/TemporalKV/{Model,Laws}.lean`, and
`test/integration/crash/pg-kill-save.crash.test.ts`.

**Taken on a lane's authority, not re-measured.** Every SQLite performance and behaviour number:
L1's 1.000 ms clock resolution and 99.2% rejection rate and 1.8 s drift; L2's 1/8→8/8 P10 result and
0 ms lease successor acquisition; L3's 32× worker hop and the `columns()` declared-type discovery;
L4's junction-table and `WITHOUT ROWID` results; L5's ingest throughput and `backup()`-ignores-signal
finding; L6's `synchronous` throughput table, WAL-damage matrix and `ALTER TABLE` matrix; all of L7's
external citations. I re-derived only what my rulings turn on. **Explicitly not verified by me:**
Node's stability index for `node:sqlite` (a citation in L6 and the coordinator relay, not a
measurement), and L5's 88 GB scale claim — which the coordinator has already shown does not hold as
stated, and on which none of my rulings depends.

---

## 4. What the sprint got wrong or missed

1. **L7 B8's headline is wrong** and it is labelled "the single strongest negative this lane found."
   `SQLITE_BUSY` has three homes in the frozen set and needs no new code (R-relay). Its *remedy* —
   add a code — is the one action that would actually reproduce LND's failure shape.
2. **`CLOCK_REGRESSION`'s `conditional` → `non-retryable` narrowing** is a forbidden weakening of a
   `retryable` marking and no lane caught it. It is one of only four items that independently force a
   major post-tag.
3. **The catalog freezes `{code → meaning → retryable}` but never `{situation → code}`** — which is
   what consumers actually depend on, and the drift test cannot see it by construction.
4. **"Additive-only" is not automatically additive in TypeScript.** Widening the exported
   string-literal unions (`TemporalKVErrorCode`, `CheckpointStoreErrorCode`,
   `TransactionLeaseErrorCode`, `WalletStateEnvelopeErrorCode`, `SharedStorageErrorCode`, `faultKind`)
   breaks exhaustive `switch` narrowing. `STABILITY.md` does not distinguish.
5. **EVIDENCE.md re-execution is a sunk cost, not a migration cost** (`ROADMAP.md:396`). L6 lists it
   under "what it breaks"; it was already mandatory.
6. **The required-tests manifest interlock** — 25 pinned ids, six engine-named — was quantified by
   nobody, and it is the mechanism that makes R4's "re-execute, not amend" self-enforcing.
7. **Six `Pg*` exported class names.** `UnrecognizedPostgresError` absorbed all the attention;
   `PgTemporalKV` and five siblings are the same problem again. Unlike the error code they are not
   machine-facing, so keeping them is defensible — but it must be a decision, not an oversight.
8. **CONTRACT §4 needs a second retry clause** distinguishing `faultKind:"timeout"` (nothing
   happened — safely retryable) from `"connection-lost"` (outcome uncertain — `history()` re-check
   required). Nobody flagged it.
9. **`package.json:4` and `ROADMAP.md:499-501`** both say PostgreSQL in published text.
10. **L4 mis-cites `docs/STABILITY.md:45`** (it is 46) — content right, citation wrong.
11. **`docs/recovery/EVIDENCE.md` already violates its own binding rule 2, today, before any
    migration.** Rule 2 reads: "Values are **captured output**, never retyped from memory or
    expectation. If a field could not be captured, write `NOT CAPTURED` — do not infer it." The entire
    **"Cold-boot round-trip" table at `:44-53` is blank** — six fields, none filled, none marked
    `NOT CAPTURED`. A blank cell is neither captured nor `NOT CAPTURED`. Fix this in the
    re-execution; it is a small thing that undermines a gate artifact whose whole value is
    scrupulousness.
12. **Nobody was assigned the consumer, and every ruling about whether a break is acceptable turns on
    it.** `CHANGELOG.md:31` says "depend on it, report what breaks." Has anyone? `EVIDENCE.md` shows
    exactly one real consumer path (a Midnight wallet, via `preprod-db-sync` and
    `cold-boot-recovery`). **If no external consumer of the published 0.9.5 surface exists, the entire
    pre-tag/post-tag debate is dramatically cheaper than seven lanes assumed** — and the RC soak in
    step 5 becomes theatre rather than protection. This is the single largest unassigned question in
    my seat's area and it should be answered by looking, not by assuming.
13. Minor: L5's verdict re-asserts the 88 GB "existence proof" the coordinator disproved. Nothing in
    my ledger leans on it, but the `Performance/CEILINGS.md` re-derivation must not either.

---

## 5. Recommendation

**Land the migration before the 1.0.0 tag. It is a 1.0.0, not a 2.0.0.** The commitments are not in
force (`STABILITY.md:46`), the CHANGELOG publishes an explicit escape hatch for exactly this
situation (`:30-32`), and the tag is blocked on an unrelated milestone that forces a fresh RC and a
full R1–R12 re-run regardless. Concretely, in order:

1. **Before writing any adapter code**, do the four things that are only free before the tag and that
   each independently force a major after it:
   - rename `UNRECOGNIZED_POSTGRES_ERROR` → `UNRECOGNIZED_DATABASE_ERROR` (and the class);
   - decide the driver (I rule for a **pinnable third-party binding**, not the built-in) and leave
     `engines` at `>=24`;
   - give `CLOCK_REGRESSION` a second live cause via a bounded-drift check, so its `conditional`
     marking is preserved rather than weakened;
   - fold migration `006` into `002` so the `ADD COLUMN … STORED` limitation never becomes permanent
     (L4's point, and the one place the window has real engineering value).
2. **Do not repurpose any code.** `CONNECTION_ERROR` becomes explicitly unreachable and documented as
   such; add `DATABASE_UNAVAILABLE` (non-retryable), `DISK_FULL` (conditional), `DATABASE_CORRUPT`
   (non-retryable). Retain `TRANSACTION_POOLER_DETECTED` as documented-unreachable. **Do not add a
   `BUSY` code** — bound it internally and surface the existing timeout codes.
3. **Write the refinement register before the port**, with each status label re-derived and the
   explicit sentence that C2a and L1's specified mechanisms no longer exist. Claim the real win —
   L1's event-log schema is a *closer* refinement of the Lean model than today's Postgres schema, and
   T5(2) becomes structural — and state, in the same paragraph, that the Lean's abstract `Time` is
   why the gate cannot see the clock drift.
4. **Re-execute, never amend.** `docs/recovery/EVIDENCE.md` against the new RC (its own rule 1;
   incremental cost ≈ zero). P1–P10 executed against SQLite. Every surviving crash property ships its
   negative control. Change the pinned `EXPECTED_REQUIRED_COUNT` in a **separate, reviewed commit**
   from the id deletions. Add P11–P14 (pragma persistence, post-crash integrity + cursor ordering,
   backup manifest→chunk closure, `foreign_keys=ON`).
5. **Rewrite, do not patch, these documents:** `docs/durability-contract.md` (four deployer
   preconditions → one), CONTRACT §1, §3 (delete the middle cancellation timing; add the
   backup/`VACUUM` exception), §4 (the new faultKind clause), §6 (`VACUUM INTO`, the `-wal` footgun,
   no PITR, `integrity_check` and its content-blindness), §5's mechanism note, `SECURITY.md` (strike
   TDE; add file permissions and sidecars), `docs/supply-chain/inventory.md` (the vendored-SQLite
   section + a CI `sqlite_version()` assertion, as a **tag precondition**), and the two
   PostgreSQL-naming strings in `package.json:4` and `ROADMAP.md:499-501`.
6. **Add one sentence to `STABILITY.md`** closing the `{situation → code}` hole — bind it or disclaim
   it, but stop leaving it silently unpromised — and one clarifying that "additive-only" does not
   extend to widening the exported string-literal union types.
7. **Then cut `0.10.0` as a real RC and let it soak.** This is the sequencing cost, it is the honest
   one, and skipping it would mean tagging 1.0.0 on a surface no consumer has ever exercised — the
   exact failure the 0.9.5 release was created to prevent. **First, though, establish whether any
   external consumer exists at all** (§4 item 12); if none does, say so in the release record and
   shorten the soak deliberately rather than by accident.

**The one thing that cannot be bought at any price, before or after the tag:** CONTRACT §3's promise
that a long read's in-flight wait is *freed* on abort. Delete the clause, name what the caller loses,
and do not let the worker-thread debate obscure the fact that `backup()` and `VACUUM INTO` remain
uncancellable either way.
