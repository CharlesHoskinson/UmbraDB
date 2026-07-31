# R-3 — Contract and precedent seat

**Question:** what does UmbraDB owe its consumers regarding silent data corruption, and how must that
be written down?

**Seat:** contract and precedent. I do not rule on which data is at risk (commitments seat) or what a
digest costs (feasibility seat). I rule on the **obligation**, the **written statement**, and what the
**industry actually does**.

---

## The ruling, in nine lines

1. **The premise is wrong.** UmbraDB is not losing page checksums. It never required them, never
   probed them, never documented them, and its own pinned PostgreSQL 17 reference server has
   `data_checksums = off` (measured, §0). What is lost is the *operator's option*, not a guarantee.
   Weaker engineering claim; **stronger documentation obligation**.
2. **A storage library may ship without corruption detection. It may not ship without saying so.**
   Where data is re-derivable, disclosure plus a structural check discharges the duty. Where it is
   **not** re-derivable, the library owes **detection**.
3. **Coverage required:** a stored digest, written co-transactionally and verified on read, on the
   **non-re-derivable tier only** (TemporalKV values, envelope store). Explicitly **not** required on
   the re-derivable tiers — requiring it everywhere is the failure mode. **Two constraints are
   non-optional** (§1.3b): the digest covers *stored bytes*, never the logical value, and every
   value-rewriting migration recomputes it (the Kafka/Cassandra false-positive family); and the
   documented-as-dangerous **bypass ships on day one** (six engines were forced to add one after the
   fact).
3b. **Evidence that cuts against me, recorded rather than filtered** (§1.3a, §2.1, §5.1): Firefox and
   Chromium add **zero** checksums over SQLite and Chromium says so in a source comment; a value digest
   addresses only 2 of the 8 categories in SQLite's own corruption taxonomy; the one published field
   rate is **<1 in 10,000 users** (WeChat); RocksDB ships this feature and defaults it **off** for
   *"non-trivial"* read cost; and Kafka deleted its per-record CRC outright. **What still carries the
   ruling:** the browsers bought the right to skip detection by holding an out-of-band **rebuild
   source**. TemporalKV history has none.
4. **Land it pre-tag.** A digest added later can only certify the bytes it finds — silently signing
   already-corrupt rows. The SQLite backend has no installed base *today* and never will again (§1.4).
5. **Precedent is split, not unanimous** (§1.1, §2.1). Bitcoin Core ships this exact design for this
   exact data class; CLN and LND are real counter-examples. The defensible claim: *no surveyed project
   both omits detection and stays silent — except LND, the cautionary tale.*
6. **`cksumvfs`: declined, not deferred** (§3). Decisive reason is library-specific and permanent — it
   registers a **process-global default VFS**. Its own history includes a transaction-loss bug.
7. **The exact contract text is in §1.5**; it must appear in **six** places (§1.6), and the sixth — a
   raised error plus `verifyIntegrity()` — is mandatory because there is **no registry chokepoint**.
8. **Adding `VALUE_INTEGRITY` is non-breaking.** The commitments seat's "don't add a code" ruling was
   specific to `SQLITE_BUSY` and turns on *transience*; every premise inverts (§1.7).
9. **Detection is not worse than nothing — whole-database refusal is** (§4). Row-scoped errors at read
   time; `verifyIntegrity()` reports and never refuses.

---

## 0. The finding that reframes the question

The brief describes page checksums as "a detection capability the project has today and is about to
lose." **That framing is false as stated, and the council should stop using it.** Three independent
checks:

**(a) UmbraDB's durability probe never read `data_checksums`.** It reads exactly three settings:

```
$ grep -n "readSetting" /root/UDB-sqlite-sprint/src/postgres/durability-probe.ts
204:    const fsync = await readSetting("fsync");
205:    const synchronousCommit = await readSetting("synchronous_commit");
206:    const fullPageWrites = await readSetting("full_page_writes");
```

**(b) No shipped contract document has ever mentioned it.**

```
$ cd /root/UDB-sqlite-sprint && grep -rniE "data_checksums|amcheck|page checksum|silent corrupt|undetected corrupt" \
    README.md CHANGELOG.md SECURITY.md docs/CONTRACT.md docs/durability-contract.md \
    docs/STABILITY.md docs/ERROR-CATALOG.md docs/checkpoint-store-contract.md
$ echo $?
1        # no matches
```

The only occurrences anywhere in the tree are inside `openspec/changes/v1.0.0-sqlite-*` — i.e. the
*proposed* text now under debate, not shipped contract.

**(c) UmbraDB's own pinned reference PostgreSQL has checksums OFF.** Measured on this host against the
exact digest-pinned image that produced the committed performance baseline
(`bench/environment.ts:18`):

```
$ docker run -d --name udb-ck3 -e POSTGRES_PASSWORD=x \
    postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193
$ docker exec -i udb-ck3 psql -U postgres -Atx <<"SQL"
select version() as server;
show fsync;
show full_page_writes;
show synchronous_commit;
show data_checksums;
SQL
server|PostgreSQL 17.10 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit
fsync|on
full_page_writes|on
synchronous_commit|on
data_checksums|off
$ docker exec udb-ck3 pg_controldata /var/lib/postgresql/data | grep -i checksum
Data page checksum version:           0
```

`initdb` does not enable checksums by default through PostgreSQL 17 — the flag is opt-in
([PG17 `initdb -k`](https://www.postgresql.org/docs/17/app-initdb.html): *"Use checksums on data pages
to help detect corruption by the I/O system that would otherwise be silent… If set…"*) — and the
official `docker-library/postgres` entrypoint invokes `initdb` with no `-k` unless the operator sets
`POSTGRES_INITDB_ARGS`
([docker-entrypoint.sh](https://github.com/docker-library/postgres/blob/master/17/bookworm/docker-entrypoint.sh)).
UmbraDB's README supports 15/16/17 only (`README.md:45`); **every one of those defaults to off.**
PostgreSQL 18 flips the default (*"This is enabled by default; use `--no-data-checksums` to disable
checksums"* — [PG18 `initdb`](https://www.postgresql.org/docs/18/app-initdb.html)), but UmbraDB does
not claim 18 support.

### What is actually being lost

Not a guarantee. Not a default. **An operator-electable option, and one half of a verification tool.**

| | PostgreSQL backend (as UmbraDB shipped it) | SQLite backend |
|---|---|---|
| Page checksums **on by default** | No (PG≤17) — measured `off` on the pinned image | No |
| Page checksums **required by UmbraDB** | No — probe never reads the setting | n/a |
| Page checksums **electable by the operator** | **Yes** — `initdb -k`, or `pg_checksums --enable` offline on an existing cluster ([PG17 `pg_checksums`](https://www.postgresql.org/docs/17/app-pgchecksums.html): *"pg_checksums checks, enables or disables data checksums in a PostgreSQL cluster"*, *"The server must be shut down cleanly"*) | **No** at any price without a separately-built native extension (§3) |
| Structural verification tool | `amcheck` / `pg_amcheck` (contrib, independent of `data_checksums`) | `PRAGMA integrity_check` — roughly the analogue, and *free*, no contrib install |
| Failure-visibility on a checksum-off cluster | corrupt page returned as data | corrupt page returned as data |

**Ruling 0.** The honest statement is *not* "we are losing page checksums." It is: **"we discovered
during this migration that UmbraDB never had engine-level page checksums in its tested configuration,
never required them, and never said so."** That is a weaker engineering claim and a **stronger
documentation obligation** — an undisclosed gap that persisted across a whole 1.0 contract program is
exactly the kind of thing a release contract exists to surface. The one genuine loss is the
*operator's option*, and the contract must say the option is gone, not that the guarantee is gone.

This matters to the adjudicator because the two framings imply different remedies. "Restore a lost
capability" argues for parity engineering. "Disclose a gap we never disclosed" argues for **writing it
down first**, and closing it only where the obligation actually bites (§1.3).

---

## 0.5 The gap, measured a third time — and sharpened

The prior two runs were on `node:sqlite`. I re-ran on the **ruled** binding
(`better-sqlite3@13.0.2` / SQLite 3.53.4) and added a control the earlier runs did not have: a second
corruption placed in **structural** bytes rather than payload bytes.

```
$ cd /root/udb-cksum-probe && node corrupt2.cjs
driver: better-sqlite3 13.0.2 / SQLite 3.53.4

--- 22 bytes flipped INSIDE a stored payload value ---
   flipped 22 payload bytes at file offset 21890 (row id=400), file size 28672
   integrity_check : [{"integrity_check":"ok"}]
   quick_check     : [{"quick_check":"ok"}]
   full scan       : 500 rows read, 1 with corrupted payload
   RETURNED AS DATA: id=400 -> "PAYLOAD_�����Π..."

--- 64 bytes flipped at mid-file (hits b-tree structure) ---
   flipped 64 bytes at file offset 14336, file size 28672
   integrity_check : [{"integrity_check":"*** in database main ***\nTree 2 page 4 cell 56: Extends off
                      end of page\nTree 2 page 4 cell 55: Extends off end of page"},
                     {"integrity_check":"database disk image is malformed"}]
   quick_check     : same
   full scan       : THREW SQLITE_CORRUPT (database disk image is malformed)
```

(500 rows, WAL mode, `wal_checkpoint(TRUNCATE)` before corrupting so everything is in the main file.
Script: `/root/udb-cksum-probe/corrupt2.cjs`.)

**The control changes the correct wording of the contract, and the council should adopt the sharper
version.** The claim is *not* "SQLite detects nothing." It is:

> SQLite's structural checks detect **structural** damage reliably — and are **blind to damage
> confined to a stored value's bytes**, which they report as `ok` and return to the caller as data.

That is a narrower and more defensible statement than the one currently in the change-5 proposal, and
it does three things for the council:

1. It **correctly scopes** `verifyIntegrity()`. `integrity_check` is not decoration — it genuinely
   covers the b-tree, and the §1.3 ruling relies on that when it declines to require digests on the
   re-derivable tiers. If `integrity_check` caught nothing, that ruling would be much weaker.
2. It **exactly delimits what the digest buys**: the payload-only blind spot, and nothing else. Any
   claim that the digest is a general corruption defence is overselling it.
3. It pre-empts the obvious reviewer objection — *"surely SQLite notices a mangled file"* — which is
   true, and irrelevant, and would otherwise be raised against the proposal without an answer on
   record.

I recommend the contract and the spec both use this two-case framing rather than the single-case one.

---

## 1. Recommendation

### 1.1 The obligation, stated as a rule

> **A storage library may ship without corruption detection. It may not ship without saying so.**
> Where the consumer can rebuild the data from an external source of truth, disclosure plus a
> structural check discharges the obligation. Where the consumer **cannot** rebuild it, the library
> owes **detection** — because there, undetected corruption is not a degraded read, it is a
> permanent, silent, unattributable loss that the consumer will discover only when acting on wrong
> data.

**The precedent does not cleanly ratify this rule, and I will not pretend it does.** The honest
reading of §2 is that the field is **split**, and the split is instructive:

- **Zcash** stores only state re-derivable by rescan from a seed and birthday height, and ships zero
  payload digests. **Consistent** with the rule.
- **Bitcoin Core** stores one thing that is not re-derivable — private key material — and it is
  *precisely and only that* which carries a stored digest recomputed on read
  (`WriteDescriptorKey` → `Hash(pubkey, privkey)` → `DBErrors::CORRUPT`). Re-derivable transaction
  data instead gets the weaker txid re-check wired to `NEED_RESCAN`. **Strongly consistent** — Core
  independently drew the same line in the same place.
- **Core Lightning and LND** store channel state, which is **not** re-derivable — losing it can lose
  funds — and ship **no payload digests at all.** These are genuine counter-examples and the
  adjudicator should weigh them as such.

Three things distinguish the counter-examples rather than dissolving them, and each is checkable:

1. **CLN discloses; LND does not.** CLN's documentation pushes byte integrity onto the deployment
   (*"A checksumming filesystem, such as BTRFS or ZFS… allows your node to verify the checksum while
   reading your data"*) and states the `integrity_check` asymmetry correctly (§1.2). That is the
   **disclosure limb** of the rule being satisfied, not the rule being violated. LND satisfies
   neither limb — and LND is the project in this set that shipped the P0.
2. **Both are applications; UmbraDB is a library.** CLN and LND can mandate ZFS, ECC RAM and a
   supported deployment, and can enforce a normative plugin contract on their operators. A library
   embedded in someone else's process can make no such demand and cannot verify it was met. Advice
   that discharges an application's duty does not discharge a library's — the same asymmetry
   `docs/durability-contract.md` §4 already reasons about for the pooler check.
3. **CLN's own behaviour undercuts its omission.** In the *same codebase*, where CLN owns the byte
   format it writes a crc32c per record and verifies on read (`gossip_store`); where SQLite owns it,
   nothing. That is the signature of **delegation to an engine assumed to be doing the job** — an
   assumption this council has now measured to be false for payload bytes — rather than a considered
   decision that channel state does not warrant protection.

So the defensible claim is narrower than "everybody does this," and it is this: **no project in the
set both omits detection *and* stays silent about it, except LND — and LND is the cautionary tale, not
the model.** UmbraDB is currently in LND's position, and §1.2 rules that it must not stay there.

### 1.2 Silent undetected corruption may NOT be left undocumented

Ruled: **no.** Three grounds, in descending strength.

1. **UmbraDB's guarantee is already non-uniform, and the non-uniformity is invisible.** The frozen
   catalog ships `CHUNK_INTEGRITY`, `MANIFEST_CORRUPT` and `CORRUPT`
   (`docs/ERROR-CATALOG.md:31,32,40`). A consumer reading that catalog sees a library that detects
   corruption. It detects it on **one tier**. Nothing in the contract set says the other tiers are
   unprotected. A partial guarantee presented without its boundary is the defect here — worse than no
   guarantee, because it is *load-bearing on a reader's mental model*.
2. **The README makes an explicit self-standard.** `README.md:189`: *"This is the part most storage
   layers get quietly wrong, so it's stated explicitly."* A durability section that opens that way and
   omits the one hazard the engine does not cover is not merely incomplete; it is affirmatively
   misleading by its own declared standard.
3. **Field precedent for disclosure exists and is cheap.** Core Lightning's backup doc states the
   asymmetry itself, correctly:
   *"This will result in the string `ok` being printed if the backup is **likely** not corrupted. If
   the result is anything else than `ok`, the backup is **definitely** corrupted"*
   ([advanced-db-backup.md#L354-L361](https://github.com/ElementsProject/lightning/blob/ae53e8775e57ddf8debfd6fc7b8e3cb5e2c93dc6/doc/beginners-guide/backup-and-recovery/advanced-db-backup.md#L354-L361)).
   That is one sentence, and it is the whole disclosure. There is no cost argument against writing it.

### 1.3 The coverage set the obligation requires

Ruled by the §1.1 rule, not by data taxonomy (which is the commitments seat's):

| Coverage | Requirement | Ground |
|---|---|---|
| **Non-re-derivable stored values** (TemporalKV value tables; the wallet-state envelope store) | **Stored digest, written in the same statement as the value, re-verified on read, typed error on mismatch.** Mandatory. | §1.1 — loss is terminal. Bitcoin Core does exactly this for exactly this data class (§2). |
| **Re-derivable tiers** (checkpoints, watermarks, chain archive) | **No new digest required.** Checkpoints already have one (content-addressing). Watermarks/archive need **disclosure + the structural pass** only. | §1.1 — resync repairs it. This is Zcash's, CLN's and LND's whole position, and it is defensible *for this class*. |
| **SQLite's own structures** (b-tree interior pages, indexes, free list) | `PRAGMA integrity_check` exposed through a `verifyIntegrity()` operation, **reported alongside the digest pass, never alone.** | Bitcoin Core runs it once at startup; the measurement shows it is sound-for-rejection only. Reporting it alone is the misleading case. |
| **Engine-level page checksums** | **Not offered in 1.0.** Named as unavailable, with `cksumvfs` recorded as 1.1 headroom (§3). | §3. |

I explicitly **decline** to require a digest on the re-derivable tiers. Requiring one everywhere is
the failure mode that produces the regret cases (§1.3b), it doubles the cost the feasibility seat is
being asked to bear, and no precedent supports it.

### 1.3a What the digest does NOT buy — evidence that weakens my own case

Late evidence obliges me to narrow the claim rather than restate it.

**SQLite's corruption taxonomy is dominated by causes a value digest cannot detect.**
[`howtocorrupt.html`](https://www.sqlite.org/howtocorrupt.html) enumerates eight categories: (1) file
overwrite by a rogue process, (2) file-locking failures, (3) failure to sync, (4) disk/flash failure,
(5) memory corruption, (6) OS problems, (7) SQLite misconfiguration, (8) bugs in SQLite. **A
stored-value digest detects (4) and (5).** It is useless against (1), (2), (3), (6) and (7) — and in
most of those the digest is *written correctly over data that is already wrong*, because the fault is
above the byte layer. Upstream's own weighting: §8 — *"bugs that result in database corruption tend to
be very obscure. **The likelihood of an application encountering an SQLite bug is small.**"*; §4 —
*"**It is very rare, but disks will occasionally flip a bit in the middle of a sector.**"*

SQLite also declines the mechanism explicitly
([`atomiccommit.html`](https://www.sqlite.org/atomiccommit.html)):

> *"**SQLite does not add any redundancy to the database file for the purpose of detecting corruption
> or I/O errors.** SQLite assumes that the data it reads is exactly the same data that it previously
> wrote."*

and its own hardening guidance for untrusted files
([`security.html`](https://www.sqlite.org/security.html)) recommends `integrity_check` + reject,
`cell_size_check=ON`, `mmap_size=0` — **not** a checksum or MAC.

**The only published field rate.** Tencent/WeChat, the largest publicly measured SQLite deployment
([source](https://cloud.tencent.com/developer/article/2271345)): *"统计发现只有万分之一不到的用户会发生
DB损坏"* — **fewer than 1 in 10,000 users** experience DB corruption of *any* cause, with ~78% partial
salvage via B-tree recovery. WCDB itself adds **no** checksums; it invests entirely in repair.

**I am not withdrawing §1.3.** Rarity is an argument about cost, not about obligation, and the
property that decides this ruling — permanent, silent, unattributable loss of non-re-derivable data —
is unchanged. But the council must not oversell the mechanism. The honest benefit statement, which
belongs in `docs/CONTRACT.md` beside the guarantee:

> The digest detects **media and memory faults affecting stored value bytes** — the rarest category of
> an already-rare event — and converts that class from silent to attributable. It does **not** defend
> against the more common causes of SQLite corruption, which are application, OS, locking and
> configuration faults.

This also hands the feasibility seat its missing denominator: **cost must be weighed against ≲0.01% of
deployments, not against a hazard of unknown frequency.** If the measured write-path cost is material,
that ratio is a legitimate basis for the council to overrule me — and I would rather it did so on this
number than on a guess. Relevant precedent for that decision: RocksDB shipped exactly this feature
(`block_protection_bytes_per_key`) and **defaults it to 0**, documenting *"a non-trivial negative
impact on read performance"*
([advanced_options.h](https://raw.githubusercontent.com/facebook/rocksdb/main/include/rocksdb/advanced_options.h)).

### 1.3b Two design constraints the precedent makes non-optional

Both are cheap only if adopted now, and both come from the regret evidence I was asked to find.

**(1) The digest must cover the *stored bytes*, never the logical value.** This is the Kafka lesson and
it is the sharpest negative in the record. Kafka added a per-record CRC, then deleted it —
[KIP-98](https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging),
verbatim:

> *"We have removed the per-message CRC in this format… The problem is that **it is not safe, even
> currently, to assume that the CRC seen by the producer will match that seen by the consumer.** One
> case where it is not preserved is when the topic is configured to use the log append time. Another is
> when messages need to be up-converted prior to appending to the log."*

The shipped javadoc told users depending on it was *"unsafe"*; removal landed as
[KAFKA-12612](https://issues.apache.org/jira/browse/KAFKA-12612)
([commit 89933f21f2](https://github.com/apache/kafka/commit/89933f21f204abf75336464d3ac24a4fdd254628)),
and granularity moved **coarser**, never finer.

The generalisation — *any layer entitled to rewrite the bytes will make your digest lie* — applies
directly, because **UmbraDB's own encoding layer is such a layer.** A JSON/JSONB reserialization, a
change in the TS↔SQLite type mapping, or a value-rewriting migration would each manufacture a
corruption report. Cassandra proves this is not hypothetical: **widening an integer**
([CASSANDRA-19989](https://issues.apache.org/jira/browse/CASSANDRA-19989)) and **changing a column
filter** ([CASSANDRA-15833](https://issues.apache.org/jira/browse/CASSANDRA-15833), titled
*"Unresolvable false digest mismatch"*) each produced false mismatches across rolling upgrades;
ordinary `ALTER TABLE` produced literal `CorruptSSTableException` and nodes that would not start
([13337](https://issues.apache.org/jira/browse/CASSANDRA-13337),
[16735](https://issues.apache.org/jira/browse/CASSANDRA-16735)). Percona's manual documents the same
taxonomy for per-row checksums — float rendering, trailing-space semantics, version skew
([`pt-table-checksum`](https://manpages.debian.org/wheezy/percona-toolkit/pt-table-checksum.1p.en.html)).

**Binding consequence:** the digest domain is the exact byte string SQLite stores and returns —
computed after encoding, verified before decoding — **and every migration that rewrites a value must
recompute the digest in the same statement.** Both belong in `docs/CONTRACT.md` **§2** (the migration
contract) as well as §1, because a future migration author who does not know this will ship a
corruption event.

**(2) Ship the bypass on day one.** Every mature engine that shipped integrity detection was forced to
add an escape hatch, and each documents it as dangerous: PostgreSQL `ignore_checksum_failure` /
`zero_damaged_pages` ([docs](https://www.postgresql.org/docs/current/runtime-config-developer.html) —
*"may cause crashes, propagate or hide corruption"*); Percona `innodb_corrupt_table_action=warn|salvage`
(default `assert` = *"intentionally crash the server"*); btrfs `rescue=ignoredatacsums`, added because
an application mutating an O_DIRECT buffer mid-write produced **permanent** false csum failures on good
files ([commit 882dbe0cec9](https://github.com/torvalds/linux/commit/882dbe0cec9651bf6a6df500178149453726c1e1)
— *"In order to recover the file we need a way to turn off data checksums so you can copy the file
off"*); Redis `rdbchecksum no`; Cassandra `disk_failure_policy=best_effort`. LevelDB states the
mechanism plainly in `options.h`:

> *"This may have unforeseen ramifications: for example, a corruption of one DB entry may cause a large
> number of entries to become unreadable or **for the entire DB to become unopenable**."*

**Binding consequence:** an option that downgrades `ValueIntegrityError` to a warning and returns the
bytes must ship **with** the digest, documented as dangerous. It is the mechanism behind §4.3 step 4 —
how a consumer with no backup extracts what is still good. Adding detection without it reproduces
every case above.

### 1.4 The sequencing argument — this is irreversible if deferred

Nobody else is positioned to make this point and it should decide the timing.

A digest column added **later** can only certify the bytes it finds. A backfill migration over
existing rows computes a digest over data that may already be corrupt, and **signs it as correct**.
Every row written before the digest lands is permanently outside the guarantee, and worse, is
*indistinguishable* from a row inside it. Deferring the digest to 1.1 therefore does not merely defer
the protection — it permanently degrades it for the installed base, and does so silently.

The SQLite backend has **no installed base yet**. Right now, and only right now, the digest can be a
day-one column on freshly created databases with no backfill and no false certification. Post-tag it
becomes a migration that must lie. **This is the strongest reason to land coverage now rather than
declare it 1.1 headroom** — stronger than the cost argument, and orthogonal to it.

### 1.5 The exact written statement for `docs/CONTRACT.md`

To be inserted as a new subsection of §1 (Durability contract), directly after the "Binding
precondition" material:

> ### 1.x Integrity: what UmbraDB detects, and what it does not
>
> **SQLite writes no checksum on main-database pages.** Its integrity checks are **structural**, and
> the coverage boundary matters:
>
> - Damage to SQLite's **own structures** — page headers, cell pointers, the b-tree — *is* detected.
>   `PRAGMA integrity_check` and `PRAGMA quick_check` report the fault and the read fails with
>   `SQLITE_CORRUPT`.
> - Damage confined to a **stored value's bytes** is **not** detected. Both checks report `ok`, and
>   the corrupted value is returned to the caller **as data**.
>
> Both cases are measured on UmbraDB's pinned driver, not asserted — see the durability doc for the
> transcript. The consequence is that **`integrity_check` is sound for *rejection* and not sound for
> *acceptance*:** `ok` means "no structural fault was found", never "the data is intact."
>
> UmbraDB's integrity coverage is consequently **not uniform**, and the boundary is part of this
> contract:
>
> | Tier | What protects it | On detection |
> |---|---|---|
> | Checkpoint chunks and manifests | SHA-256 content-address recomputed on load | `ChunkIntegrityError` (`CHUNK_INTEGRITY`), `ManifestCorruptError` (`MANIFEST_CORRUPT`) |
> | TemporalKV values, wallet-state envelope store | stored digest, written co-transactionally with the value, re-verified on every read | `ValueIntegrityError` (`VALUE_INTEGRITY`) — the corrupted bytes are **not** returned to the caller |
> | Watermarks, transaction history, chain archive | **nothing beyond SQLite.** Corruption here is undetected until it is read and fails a downstream decode | — |
> | SQLite's own b-tree pages, indexes, free list | `PRAGMA integrity_check`, run on demand via `verifyIntegrity()` | reported, not thrown |
>
> **What the digest actually covers — stated narrowly on purpose.** It detects **media and memory
> faults affecting stored value bytes**: categories 4 (disk/flash failure) and 5 (memory corruption) of
> [SQLite's own eight-category corruption taxonomy](https://www.sqlite.org/howtocorrupt.html). It does
> **not** defend against the more common causes — rogue processes overwriting the file, file-locking
> failures, failure to sync, OS defects, or SQLite misconfiguration — because in those the fault is
> above the byte layer and the digest is written correctly over data that is already wrong. Upstream's
> own weighting is that media bit-flips are *"very rare"* and SQLite bugs *"small"* in likelihood.
> SQLite itself declines to add redundancy for this purpose
> ([atomiccommit.html](https://www.sqlite.org/atomiccommit.html)); UmbraDB adds it only where loss
> would be permanent.
>
> **Limits, stated plainly.**
> - **Detection is not repair.** UmbraDB has no `zero_damaged_pages`, no `pg_amcheck`, and does not
>   depend on the SQLite CLI's `.recover`. Recovery from a detected corruption is **restore from
>   backup** (§6), or resynchronise for the tiers derivable from chain. See §1.y.
> - **The digest is defined over the stored bytes, not the logical value.** It is computed after
>   encoding and verified before decoding. Any change to UmbraDB's value encoding, and any migration
>   that rewrites stored values, **must recompute the digest in the same statement** — otherwise a
>   legitimate transformation is reported as corruption. This is a binding rule on migration authors;
>   see §2.
> - **A documented escape hatch exists and is dangerous.** `integrity: { ignoreValueDigestFailure:
>   true }` downgrades `ValueIntegrityError` to a warning and returns the stored bytes, so a consumer
>   with no backup can extract what remains. It may propagate or hide corruption; use it only during
>   deliberate recovery.
> - A digest stored in the same row as its value **can be damaged by the same event** as the value.
>   The digest reduces the probability of an undetected corruption; it does not eliminate it.
> - A digest detects corruption **at rest**. It does not detect a value that was already wrong when
>   UmbraDB was asked to store it.
> - **The digest is not a tamper defence.** It is unkeyed. An attacker able to write the database file
>   can recompute the digest along with the value. It detects accidental corruption, not deliberate
>   modification — consistent with `SECURITY.md`'s single-trusted-writer model.
> - `verifyIntegrity()` reports the structural check and the digest check **together**. A structural
>   `ok` reported on its own would be the misleading result this section exists to prevent.
>
> **No engine-level page checksums are available on this backend.** SQLite ships a first-party
> checksum VFS (`cksumvfs`), but it is a loadable extension that is **not** part of the amalgamation
> and is **not** compiled into UmbraDB's pinned driver build. UmbraDB does not ship it, and does not
> plan to: enabling it registers a **process-global default VFS**, which a library embedded in a
> consumer's process must not do on that consumer's behalf.
>
> ⚠️ **On that build, `PRAGMA checksum_verification = 1` is silently accepted and does nothing.**
> SQLite ignores unknown pragmas without error, so an operator following SQLite's own documentation
> to "turn on checksum verification" receives **no error and no protection**. `PRAGMA
> checksum_verification` returning **no rows** is the correct probe for the shim's absence.
>
> **This is not a regression from the PostgreSQL backend.** PostgreSQL's `data_checksums` is an
> `initdb`-time option that is **off by default** through PostgreSQL 17 — the whole range UmbraDB
> supports — and UmbraDB never required it, never probed it (the durability probe reads `fsync`,
> `full_page_writes` and `synchronous_commit` only) and never documented it. UmbraDB's own pinned
> reference server reports `data_checksums = off`. What the SQLite backend removes is the
> **operator's option** to turn checksums on (`initdb -k`, `pg_checksums --enable`), not a guarantee
> UmbraDB ever made. This subsection exists because that absence was undisclosed on **both**
> backends, and disclosing it is overdue.

### 1.6 Where else it must appear

There is no npm-registry chokepoint — consumers install by **git tag**
(`npm install github:CharlesHoskinson/UmbraDB#v0.9.5`, `README.md:17`), **repository clone**
(`README.md:23`), and container images. A CHANGELOG entry reaches none of them reliably. Ruled: the
statement must land in **six** places, and the sixth is not optional.

| # | Location | Content | Why this reader |
|---|---|---|---|
| 1 | `docs/CONTRACT.md` §1 | the full §1.5 text | normative home; the doc the contract set points at |
| 2 | `README.md` § "Durability and crash semantics" | **four lines** + link to (1) | the **only** document a git-tag / clone / container consumer reliably reads. That section already promises "stated explicitly"; the omission is most acute here |
| 3 | `docs/durability-contract.md` | the measured transcript + a row in the summary table reading "page checksums — **none**, on either backend" | it is the doc that enumerates what the probe enforces; a reader mapping PG settings to SQLite must find the empty cell, not infer it |
| 4 | `docs/ERROR-CATALOG.md` | the `VALUE_INTEGRITY` row | machine-facing surface; drift-tested |
| 5 | `SECURITY.md`, under "Data at rest — NO encryption is provided" (`SECURITY.md:107`) | **one line**: *"and no at-rest integrity — see `docs/CONTRACT.md` §1.x."* Note the digest is **not** a tamper defence: it is unkeyed, and an attacker who can write the value can rewrite the digest | a reader who goes to the **threat model** looking for tamper-detection must not have to infer it from the durability doc. Absence of integrity is the twin of absence of encryption and belongs beside it |
| 6 | **A raised error and a callable operation** — `ValueIntegrityError` + `verifyIntegrity()` | — | **the only channel that reaches a consumer who reads nothing.** With no registry chokepoint this is the sole reliable notification path, which converts it from a nice-to-have API into the delivery mechanism for the disclosure itself |

### 1.7 Is it a breaking change? Is a new code allowed?

**Adding `VALUE_INTEGRITY` is additive and therefore non-breaking.** `docs/STABILITY.md:18-22`: the
frozen sets are *"additive-only: new exports and new error codes may be introduced in a minor."*
`docs/ERROR-CATALOG.md:13`: *"new codes may be added additively in a minor."* The count is derived from
the surface by `test/api-surface/error-catalog-drift.test.ts`, not hard-coded, so the mechanism
already absorbs it.

**The commitments seat's "adding a code reproduces LND's failure shape" ruling does not extend here.**
I checked the reasoning (`council/commitments.md:264-270`). It is Ruling 3 and it is *entirely* about
transience:

> "Adding one would repeat LND's mistake in a new form: it **promotes a transient into the caller's
> decision surface** … Keep `SQLITE_BUSY` **inside** UmbraDB behind a bounded retry layer."

Every premise inverts for corruption:

| | `SQLITE_BUSY` (Ruling 3) | corruption detection |
|---|---|---|
| transient? | yes — clears on retry | **no** — permanent |
| can the library resolve it internally? | yes — bounded retry | **no** — nothing to retry |
| should the caller decide? | no — it is control flow | **yes** — only the caller knows whether to restore, resync, or halt |
| retryable marking | retryable | **non-retryable** |

And the LND record independently confirms the distinction. #7869 was **not** a missing-code failure;
it was an existing, correctly-signalled error being dropped. Roasbeef's own diagnosis:
*"the current logic just sets a value, but then doesn't actually try re-execute the transaction before
reporting the error back to the caller"*
([#7869 comment](https://github.com/lightningnetwork/lnd/issues/7869#issuecomment-1668429114)); fixed
by [PR #7927](https://github.com/lightningnetwork/lnd/pull/7927), which added a retry layer and link
teardown — **no new error code**. Silent corruption produces no engine error code at all, so there is
nothing to swallow and nothing to promote. Ruling 3 is correct and narrow; it is about `SQLITE_BUSY`,
not about the catalog.

**The real breaking-change risk is elsewhere, and the commitments seat already identified it:**
widening the exported string-literal **union types** (`TemporalKVErrorCode` and siblings) breaks a
consumer's exhaustive `switch` that relies on `never` — additive at runtime, breaking at compile
time. `docs/STABILITY.md` does not distinguish these. Two consequences: (i) the widening should land
**pre-1.0**, and (ii) `STABILITY.md` §1 should be amended to say that widening an output-position
union is a **major** change even though adding a runtime code is not. That amendment is independently
correct and is a cheap byproduct of this ruling.

**A schema change adding a digest column is not a downgrade-compatible change** — but that is already
the standing contract (`docs/CONTRACT.md` §2: forward-only, no `down()`, no supported downgrade), so
it introduces no new obligation. And per §1.4, for SQLite there is no installed base to migrate at
all if it lands now.

---

## 2. Precedent table

Every row is primary-source. Commits pinned: bitcoin/bitcoin `67efced1fc83`, zcash/librustzcash
`6487f1f10b55`, ElementsProject/lightning `ae53e8775e57`, lightningnetwork/lnd `f4a444184dd1`.

| Project | What it stores in SQLite | What protects payload bytes | Re-derivable? | Source |
|---|---|---|---|---|
| **Zcash** `zcash_client_sqlite` | shielded notes, shardtree shards + checkpoints, scan queue, nullifier map, raw transactions, UFVKs | **Nothing.** `grep -rni "checksum\|hmac\|integrity_check\|quick_check"` over the whole crate → **zero hits**. Open path is bare `Connection::open` with **no pragmas at all** | **Yes** — everything rebuilds by rescan from seed + birthday height | [lib.rs#L459-L477](https://github.com/zcash/librustzcash/blob/6487f1f10b55b74eedeb9eab4db4d7a24cfdbc9f/zcash_client_sqlite/src/lib.rs#L459-L477) |
| ↳ *incidental* | `accounts.ufvk` | Bech32m checksum + F4Jumble — a **wire-format** side effect, not a storage design | | [unified.rs#L367-L379](https://github.com/zcash/librustzcash/blob/6487f1f10b55b74eedeb9eab4db4d7a24cfdbc9f/components/zcash_address/src/kind/unified.rs#L367-L379) |
| ↳ *the gap* | `transactions.raw` | **No txid re-derivation.** A byte flipped inside `raw` that still parses is returned silently | | [wallet.rs#L3025-L3047](https://github.com/zcash/librustzcash/blob/6487f1f10b55b74eedeb9eab4db4d7a24cfdbc9f/zcash_client_sqlite/src/wallet.rs#L3025-L3047) |
| **Bitcoin Core** descriptor wallet — *SQLite layer* | `CREATE TABLE main(key BLOB PRIMARY KEY, value BLOB)` | **Nothing at this layer.** No checksum column | | [sqlite.cpp#L333](https://github.com/bitcoin/bitcoin/blob/67efced1fc83a0b7215cc1513e7c4754fee0f12f/src/wallet/sqlite.cpp#L333) |
| ↳ *open-time gate* | — | `application_id` == network magic; `user_version` == schema version; **`PRAGMA integrity_check`, every row must be `"ok"`** — once per startup, default on | | [sqlite.cpp#L191-L246](https://github.com/bitcoin/bitcoin/blob/67efced1fc83a0b7215cc1513e7c4754fee0f12f/src/wallet/sqlite.cpp#L191-L246), [db.h#L180](https://github.com/bitcoin/bitcoin/blob/67efced1fc83a0b7215cc1513e7c4754fee0f12f/src/wallet/db.h#L180) |
| ↳ **the decisive row** — descriptor **private keys** | privkey blobs | **A stored per-record digest.** `WriteDescriptorKey` stores `Hash(pubkey, privkey)` (double-SHA256) **alongside the value**; load recomputes and returns `DBErrors::CORRUPT` on mismatch | **No** — key material is not re-derivable | [walletdb.cpp#L217-L224](https://github.com/bitcoin/bitcoin/blob/67efced1fc83a0b7215cc1513e7c4754fee0f12f/src/wallet/walletdb.cpp#L217-L224), [#L840-L874](https://github.com/bitcoin/bitcoin/blob/67efced1fc83a0b7215cc1513e7c4754fee0f12f/src/wallet/walletdb.cpp#L840-L874) |
| ↳ transactions | `CWalletTx` | txid re-derived from payload and compared to the key → `NEED_RESCAN`. **Covers the `CTransaction` only** — `mapValue`, `nOrderPos`, `nTimeSmart` sit in the same blob, uncovered | **Yes** (rescan) | [walletdb.cpp#L1003-L1016](https://github.com/bitcoin/bitcoin/blob/67efced1fc83a0b7215cc1513e7c4754fee0f12f/src/wallet/walletdb.cpp#L1003-L1016) |
| ↳ **the regression** | *encrypted* descriptor keys | **No digest.** Legacy `WriteCryptedKey` stored `Hash(vchCryptedSecret)`; the descriptor rewrite dropped it | **No** | legacy [#L125-L147](https://github.com/bitcoin/bitcoin/blob/67efced1fc83a0b7215cc1513e7c4754fee0f12f/src/wallet/walletdb.cpp#L125-L147) vs descriptor [#L226-L233](https://github.com/bitcoin/bitcoin/blob/67efced1fc83a0b7215cc1513e7c4754fee0f12f/src/wallet/walletdb.cpp#L226-L233) |
| **Core Lightning** wallet DB | channel state, HTLCs, funds | **Nothing.** No `integrity_check` ever run on the live DB. `cell_size_check=ON` is **developer builds only** | **No** (channel state) | [db_sqlite3.c#L200-L221](https://github.com/ElementsProject/lightning/blob/ae53e8775e57ddf8debfd6fc7b8e3cb5e2c93dc6/db/db_sqlite3.c#L200-L221) |
| ↳ *the contrast* | `gossip_store` (CLN's **own** flat file) | **crc32c per record, verified on read, hard fail** — same codebase, opposite reflex | | [gossip_store.c#L64-L70](https://github.com/ElementsProject/lightning/blob/ae53e8775e57ddf8debfd6fc7b8e3cb5e2c93dc6/gossipd/gossip_store.c#L64-L70), [#L540-L551](https://github.com/ElementsProject/lightning/blob/ae53e8775e57ddf8debfd6fc7b8e3cb5e2c93dc6/gossipd/gossip_store.c#L540-L551) |
| ↳ `data_version` | a `u32` in `vars` | **Rollback / lost-write / concurrent-writer detection** via CAS + a normative plugin contract that MUST halt on regression. **Not** content integrity — a bit flip in any row, *including `vars.intval` itself*, is invisible | | [db/exec.c#L127-L153](https://github.com/ElementsProject/lightning/blob/ae53e8775e57ddf8debfd6fc7b8e3cb5e2c93dc6/db/exec.c#L127-L153), [db_write.json#L28-L35](https://github.com/ElementsProject/lightning/blob/ae53e8775e57ddf8debfd6fc7b8e3cb5e2c93dc6/doc/schemas/hook/db_write.json#L28-L35) |
| ↳ dual-DB mirror | `sqlite3://main:backup` | **Replays SQL text to a second file. Never compares the two.** Docs: *"will **not** be identical at every byte"*. On version mismatch it **unconditionally overwrites backup with main** — `!=`, not `>=`, so a stale restore destroys a newer replica | | [db_sqlite3.c#L29-L48](https://github.com/ElementsProject/lightning/blob/ae53e8775e57ddf8debfd6fc7b8e3cb5e2c93dc6/db/db_sqlite3.c#L29-L48), [#L172-L190](https://github.com/ElementsProject/lightning/blob/ae53e8775e57ddf8debfd6fc7b8e3cb5e2c93dc6/db/db_sqlite3.c#L172-L190), [advanced-db-backup.md#L40-L44](https://github.com/ElementsProject/lightning/blob/ae53e8775e57ddf8debfd6fc7b8e3cb5e2c93dc6/doc/beginners-guide/backup-and-recovery/advanced-db-backup.md#L40) |
| **LND** kvdb-on-SQLite | bbolt buckets/values as `BLOB`, incl. channel state | **Nothing.** `grep -in "integrity_check\|quick_check"` across the entire repo → **zero hits.** Schema has no integrity column. `SQLITE_CORRUPT` falls into a default branch wrapped as `"unknown sqlite error"` | **No** (channel state) | [schema.go#L47-L60](https://github.com/lightningnetwork/lnd/blob/f4a444184dd1d85f17dfc91eb2a5e12b248cad65/kvdb/sqlbase/schema.go#L47-L60), [sqlerrors.go#L98-L100](https://github.com/lightningnetwork/lnd/blob/f4a444184dd1d85f17dfc91eb2a5e12b248cad65/sqldb/sqlerrors.go#L98-L100) |
| **UmbraDB today** — checkpoint tier | chunks, manifests | SHA-256 content-address recomputed on load → `CHUNK_INTEGRITY` / `MANIFEST_CORRUPT` | Yes | `src/postgres/checkpoint-store.ts:65-66,366-368,378` |
| **UmbraDB today** — everything else | TemporalKV values, watermarks, tx history | **Nothing, and it is undocumented** | **TemporalKV: no** | this document |

### 2.1 What the table actually says

Four readings, in order of how much they should move the adjudicator.

1. **"Nobody checksums rows" is true as a headcount — and the headcount is worse for me than the wallet
   table alone suggests.** Widening beyond wallets: **Firefox adds zero** checksums over SQLite (a
   searchfox search for `checksum` scoped to `toolkit/components/places` returns **no hits**), and
   **Chromium says so in a source comment** — `sql/sqlite_result_code.cc`: `// Chrome does not use the
   checksum VFS shim.`, classifying `SQLITE_IOERR_DATA` as unreachable. Two of the largest SQLite
   deployments in existence declined this mechanism deliberately. I record that against my own ruling.

   Two things stop it from being decisive. First, the tally mixes situations: Zcash's omission covers
   only **re-derivable** state; CLN's and LND's cover **non-re-derivable channel state** and are
   defended, if at all, by deployment requirements a library cannot make (§1.1). Second, and more
   important — **the browsers have something UmbraDB does not.** Firefox restores bookmarks from
   periodic out-of-band JSON snapshots and simply *discards* history; Chromium razes and rebuilds, and
   its cookie store falls back to RAM with the comment *"This Backend will now be in-memory only… In a
   future run we will recreate the database. Hopefully things go better then!"*. Both bought the right
   to skip detection by holding a **rebuild source**. For UmbraDB's re-derivable tiers that is exactly
   the chain, and §1.3 accordingly requires no digest there. **For TemporalKV history there is no
   rebuild source at all** — which is precisely why the browser precedent does not transfer, and why
   the ruling survives a headcount that otherwise goes against it.

   And note what the tally *cannot* show: none of these projects has published a post-incident analysis
   concluding its omission was safe. Absence of digests is evidence about what teams *chose*, not about
   what the failures *did*.
2. **The one project that deliberately protects non-re-derivable material implements the exact
   proposed design.** Bitcoin Core's `WriteDescriptorKey` is a digest computed over the value, written
   in the same operation, recomputed on read, raising a typed corruption error on mismatch. That is
   `ValueIntegrityError` with a different name, shipping in the most integrity-conscious wallet
   codebase in the ecosystem. The proposal is not novel and should not be argued as if it were.
   *(Caveat against over-claiming: the code comment says the hash exists "to accelerate wallet load",
   so the original motive was avoiding EC re-derivation, not corruption detection. The mechanism and
   the `DBErrors::CORRUPT` outcome are exactly as described — the intent is partly incidental.)*
3. **CLN is the cleanest natural experiment available.** One codebase. Where CLN owns the byte format
   (`gossip_store`) it writes a crc32c per record and verifies on read. Where SQLite owns the byte
   format (the wallet DB — *the file holding the funds*) it writes nothing. The reflex exists; **it is
   delegation to the engine that suppresses it**, on an assumption about the engine that this
   council has measured to be false. That is the mechanism of the gap, demonstrated rather than
   theorised.
4. **Integrity is lost across rewrites unless the storage layer owns it.** Bitcoin Core's legacy
   encrypted keys carried `Hash(vchCryptedSecret)`; the descriptor rewrite dropped it and nobody
   noticed. If even Core loses a per-record digest during a refactor, per-call-site integrity is not
   a durable strategy — which is an argument for putting it *in UmbraDB* rather than advising
   consumers to digest their own values.

**And one caution against over-reading the table:** every project here also ships something UmbraDB
does not, and the adjudicator should weigh it. CLN's `data_version` — a monotonic counter with a
normative MUST-halt-on-regression contract — detects **stale restores, lost commits and concurrent
writers**, which are *more common field failures than bit rot* and which UmbraDB currently detects
via none of the above. If the council has budget for exactly one integrity mechanism, the honest
comparison is digest-vs-`data_version`, not digest-vs-nothing. I still rule for the digest, because
UmbraDB's writer lease and co-transactional `saveAndAdvance` already cover the concurrent-writer and
lost-commit halves of what `data_version` buys, and the rollback half is a backup-hygiene problem the
contract can address in prose. But the comparison should be made rather than skipped.

---

## 3. The `cksumvfs` ruling

**Ruled: not viable for 1.0, and — a stronger claim than I expected to be able to make — not
obviously desirable for a *library* at any version.** It remains worth naming in the contract as the
reason no engine-level option exists, and it is not a substitute for the value digest in either
direction.

### 3.1 What it is (primary source)

From [sqlite.org/cksumvfs.html](https://www.sqlite.org/cksumvfs.html), verbatim:

- *"The checksum VFS extension is a VFS shim that adds an 8-byte checksum to the end of every page in
  an SQLite database."*
- *"Checksumming only works on databases that have a reserve bytes value of exactly 8. The default
  value for reserve-bytes is 0. Hence, newly created database files will omit the checksum by
  default."*
- *"SQLite allows the number of reserve-bytes to be increased but not decreased. So if a database file
  already has a reserve-bytes value greater than 8, there is no way to activate checksumming on that
  database, other than to dump and restore the database file."*
- *"Databases with checksums will return an `SQLITE_IOERR_DATA` error if a page is encountered that
  contains an invalid checksum."* (`SQLITE_IOERR_DATA` = extended code **8202**,
  [rescode.html](https://www.sqlite.org/rescode.html): *"used only by the checksum VFS shim"*.)
- *"If any checksum is incorrect, the `PRAGMA quick_check` command will find it."*
- *"The checksum VFS module is a **loadable extension. It is not included in the amalgamation**."*

With `cksumvfs` active, **`quick_check` stops being merely structural and becomes a real payload
verifier.** That is a materially better property than the application digest offers, and it is why
this deserved a serious look rather than a dismissal.

**Coverage, from source rather than doc** (`ext/misc/cksumvfs.c`) — the doc states no coverage
boundary, and the real one is narrower than the doc implies:

- **Main database file only.** `cksmOpen` returns the un-shimmed handle for anything else:
  `if( (flags & SQLITE_OPEN_MAIN_DB)==0 ){ return pSubVfs->xOpen(...); }`. **The WAL, the rollback
  journal, the super-journal and temp files are not checksummed by the shim** (the WAL has its own
  native per-frame checksums; the others have nothing).
- **Coverage inside the main file is by I/O *shape*, not page role**: `if( iAmt>=512 && (iAmt &
  (iAmt-1))==0 && p->verifyCksm )`. Page 1, freelist, overflow and index pages are treated
  identically — but reads that are not a power-of-two ≥512 are **not verified at all**. That gap is
  acknowledged upstream (§3.5).
- **Not cryptographic.** The algorithm is the same Fletcher-style 64-bit sum SQLite uses for WAL
  frames. drh, [2021-07-09](https://sqlite.org/forum/forumpost/594d85e338b92f3f5deb04256ef4d3eaf307567a772f4b0a5b476ed63202b1d8):
  *"a malicious actor could probably devise some changes that would alter the content of a page
  without changing the checksum… It would take some amount of cleverness to do this, but it is
  doable."* **Anti-bitrot, explicitly not anti-tamper** — which matters because `SECURITY.md`'s threat
  model would otherwise be tempted to claim it.

### 3.2 Why it is not the 1.0 answer — measured, not asserted

The ruled driver is `better-sqlite3@13.0.2`
(`openspec/changes/v1.0.0-sqlite-engine-core/design.md:79,108`). Measured on this host:

```
$ cd /root/udb-cksum-probe && npm install better-sqlite3@13.0.2 && node probe.cjs
better-sqlite3: 13.0.2
sqlite_version: 3.53.4
CKSUMVFS compiled in? -> false
LOAD_EXTENSION omitted? -> false
loadExtension typeof -> function
pragma checksum_verification -> []
set checksum_verification=1 -> accepted (no-op if unknown)
```

(`CKSUMVFS compiled in?` is `pragma compile_options` filtered for `/CKSUM/i`; the full 60-entry
option list contains no `CKSUM` token of any kind.)

Three findings, in order of importance:

1. **It is not there.** Consistent with upstream's own statement that it is not in the amalgamation.
   No build flag in the pinned prebuilt exposes it.
2. **`PRAGMA checksum_verification = 1` is silently accepted and does nothing.** This is the sharp
   edge and it belongs in the contract text. An operator who reads the SQLite docs and "turns on
   checksum verification" gets **no error and no protection** — SQLite's unknown-pragma rule makes
   the misconfiguration invisible. Any doc UmbraDB writes must pre-empt this specific mistake, and
   the §1.5 text does.
3. **`loadExtension` is available** (`OMIT_LOAD_EXTENSION` is absent), so the runtime-extension route
   is technically open — and that is exactly the problem. Taking it means UmbraDB compiles, ships and
   codesigns `cksumvfs.{so,dylib,dll}` per platform-and-architecture, reintroducing precisely the
   native-artifact supply-chain burden the driver decision spent its effort bounding (that design
   chose a pinned prebuilt binding partly on install-script and supply-chain grounds,
   `design.md:99-107`). A 1.0 that ships a hand-built native VFS to close a gap it never previously
   disclosed is a bad trade.

There is a further, **library-specific** disqualifier that an application-level survey would miss.
Registration is **process-global and makes `cksmvfs` the default VFS**, plus installs a global
auto-extension:

```c
rc = sqlite3_vfs_register(&cksm_vfs, 1);          /* 1 = make it the default VFS */
if( rc==SQLITE_OK ) rc = sqlite3_auto_extension((void(*)(void))cksmRegisterFunc);
```

UmbraDB is a **library inside someone else's process**. Loading `cksumvfs` would change the default
VFS and install a `verify_checksum()` SQL function on *every subsequently opened SQLite connection in
the host process*, including databases owned by unrelated code that never consented. That is not a
configuration choice a library gets to make on its consumer's behalf. Bitcoin Core, CLN and LND can
all take this route because they *are* the process; UmbraDB cannot. **This is the ruling's load-bearing
reason, and it does not expire in 1.1.**

Also required, and easy to get wrong: neither `better-sqlite3` nor `node:sqlite` exposes
`sqlite3_file_control`, so `SQLITE_FCNTL_RESERVE_BYTES` is unreachable from Node. The only sanctioned
path is an **undocumented** compile-time hook in `cksumvfs.c`:

> *"This feature is provided (if and only if the `SQLITE_CKSUMVFS_INIT_FUNCNAME` compile-time option
> is set to a string which is the name of the SQL function) so as to provide the ability to invoke the
> file-control in programming languages that lack direct access to the `sqlite3_file_control()`
> interface (ex: Java). **This interface is undocumented, apart from this comment.**"*

A 1.0 durability guarantee resting on an explicitly-undocumented upstream hook is not a guarantee.

### 3.3 The regret case — and it is `cksumvfs`'s own

I was asked to find a project that adopted checksums and regretted it. The best-sourced negative I
found is **first-party, recent, and about this exact mechanism.** It is more probative than a generic
per-row-digest anecdote would have been, and the council should weigh it.

**(a) The integrity feature caused data loss.** Dan Kennedy, SQLite core team,
[2025-08-14](https://sqlite.org/forum/forumpost/25b4f69db46a8d8a2d96ce3c545e4bc25a2084f581cced31efc51b3eda8e7faa):

> *"It turns out that **cksumvfs did not work at all for wal file recovery**. The cksumvfs was
> overwriting the last 8 bytes of each page written to the wal file with its own checksum,
> invalidating the checksum in the wal frame header. So if a process exited without checkpointing
> leaving a wal file in the file-system, **the next process could not recover any transactions from
> it**."*

Check-in [e3bd1feccaee8ff2](https://sqlite.org/src/info/e3bd1feccaee8ff2) (2025-08-13): *"Have cksumvfs
write checksums to the database file only, not the wal file. Writing them to the wal file breaks wal
file recovery."* Shipped in **SQLite 3.51.0 (2025-11-04)**. And the fix is **not wire-compatible** —
Kennedy again: *"if a legacy version of cksumvfs tries to read a wal file written by this new version,
it will expect the frames to include cksumvfs checksums, and will fail with `SQLITE_IOERR_DATA`."*

For a library shipping per-platform prebuilds, a mechanism where **two builds of your own extension
cannot share a WAL** is a support nightmare that no amount of documentation fixes.

**(b) It produced false corruption reports on healthy databases.** A 2024 regression: enabling
`SQLITE_DIRECT_OVERFLOW_READ` by default in 3.45.2 caused spurious `SQLITE_IOERR_DATA`, because
sub-page reads of 1024/2048 bytes on a 4096-byte-page database are also powers of two ≥512 and were
verified as if they were whole pages. Reported symptom included `quick_check` passing while
`integrity_check` failed. The first fix was insufficient; the final fix
([7b7ce5f17f](https://sqlite.org/src/info/7b7ce5f17f), 2025-08-13) masks the capability outright:

```c
return (devchar & ~SQLITE_IOCAP_SUBPAGE_READ);
```

The residual gap, in the reporter's words: *"the plugin may validate checksums on incomplete reads
(the present bug); it may also **not validate some reads (too short or too large), which partially
defeats its purpose**."*

**(c) Enabling it on a populated database has an unresolved failure report.** A
[2021 report](https://sqlite.org/forum/forumpost/e168e116a310dbf3c5049853d0d7786591f88bf628b1b36fd3368c06a330446f)
of `.filectrl reserve_bytes 8; vacuum; vacuum;` producing `Error: disk I/O error` on the second
`VACUUM`, independently reproduced, **never answered by a developer**.

**The lesson I take from (a)–(c) is not "checksums are bad."** It is: *a checksum mechanism that sits
below the storage engine, in the I/O path, on the write side, is a place where a bug costs you the
data it was meant to protect.* An application-level digest written co-transactionally with its value
cannot lose a transaction — its worst failure is a false rejection of one row, which is recoverable
and diagnosable. **That asymmetry is a genuine, evidence-backed argument for the digest over the VFS
shim**, and it is the strongest form of the case I can make for the §1.3 ruling.

### 3.4 The one thing in `cksumvfs`'s favour, now heavily qualified

The usual blocker — *"reserve-bytes must be 8, and you cannot set it on a populated database without a
dump/restore"* — **does not apply to UmbraDB**, whose SQLite databases are created fresh by this
migration. In my first draft I recommended setting reserve-bytes = 8 at creation now, to preserve the
option cheaply.

**I withdraw that recommendation.** Agent-verified constraints make it a worse trade than it looked:
setting reserve-bytes makes `page_size` **permanently immutable** (the shim silently refuses
`PRAGMA page_size` changes), forecloses any other reserve-bytes consumer (e.g. SEE for at-rest
encryption — which `SECURITY.md` already names as 1.1 headroom, so this is a live conflict), costs 8
bytes per page forever, and buys an option that §3.2's process-global-VFS objection says UmbraDB
should probably never exercise. Preserving an option you have ruled against exercising, at the cost of
foreclosing one you have already reserved, is the wrong trade.

Record `cksumvfs` in `docs/CONTRACT.md` §8 as **considered and declined, with reasons** — not as
reserved headroom.

### 3.5 The two mechanisms are complementary, not alternatives

| | application value digest | `cksumvfs` |
|---|---|---|
| corruption of a stored value at rest | detected | detected (if read as a whole page) |
| corruption of b-tree interior pages, indexes, free list | **not detected** | detected |
| corruption in the WAL / rollback journal | not detected | **not detected** — main DB file only (`cksmOpen`); WAL has its own native frame checksums |
| reads that are not a power-of-two ≥512 bytes | detected | **not verified** (upstream-acknowledged gap) |
| corruption between application and page cache (flip before write) | detected on read-back | **not detected** — it checksums what it is handed |
| adversarial modification | detectable with a keyed digest | **no** — drh: *"a malicious actor could probably devise some changes"* |
| granularity of failure | the addressed row | the page — potentially unrelated rows |
| surfaces as | typed `ValueIntegrityError`, row-scoped, non-retryable | `SQLITE_IOERR_DATA` (8202), indistinguishable from disk failure without extended-result-code plumbing |
| worst-case bug in the mechanism | false rejection of one row | **loss of uncheckpointed transactions** (§3.3a) |
| available in 1.0 | yes | **no** |
| published performance data | n/a | **none exists** — sqlite.org publishes no overhead figures at all |

Neither subsumes the other. Even if `cksumvfs` were available today it would not discharge the §1.3
obligation, so the ruling does not rest on the availability finding alone. That last row is also worth
handing to the feasibility seat: any comparison that assumes `cksumvfs` is "the cheap option" is
assuming a number nobody has published.

---

## 4. The recovery story

**The question "is detection without recovery worse than nothing?" has a sharp answer, and it is not
the one the framing implies.** Detection is not what makes an outage worse. **Blast radius** is.

### 4.1 The argument that detection is worse — and why it fails as stated

The strong form: a wallet with one corrupted history row keeps working. Add a digest and it now
refuses, converting a survivable degradation into a hard stop, with no repair path. That is a real
failure shape and there is a real precedent for it: Bitcoin Core maps `DBErrors::CORRUPT` to
*"Error loading %s: Wallet corrupted"* and **the wallet does not load at all**
([wallet.cpp#L2400-L2436](https://github.com/bitcoin/bitcoin/blob/67efced1fc83a0b7215cc1513e7c4754fee0f12f/src/wallet/wallet.cpp#L2400-L2436)) —
while `bitcoin-wallet salvage` was **deleted** in
[commit 56f959d8](https://github.com/bitcoin/bitcoin/commit/56f959d829e90c8495968609eec4169502d6efc2)
(*"Salvage is bdb only which is about to be removed"*, [PR #31250](https://github.com/bitcoin/bitcoin/pull/31250)).
Core today therefore ships **detection that refuses to open, with the repair tool removed.** That is
the exact worse-than-nothing shape, in the most careful wallet codebase in the ecosystem.

But the argument proves the wrong thing. What makes Core's case bad is not that it detects. It is
that detection is **whole-database scoped at open time**, so one bad record denies access to every
good one. Core's *other* branch shows it knew better: the txid mismatch maps to `NEED_RESCAN` —
*"Transaction data may be missing or incorrect. Rescanning wallet."* — a **warning plus automatic
rebuild**, and the wallet opens.

**Ruling: the failure mode is whole-database refusal, not detection.** UmbraDB must take the
`NEED_RESCAN` shape everywhere and the `CORRUPT` shape nowhere.

### 4.2 The binding rules

1. **Row-scoped, read-time, never open-time.** `ValueIntegrityError` is thrown by **the read that
   addressed the damaged row**, and by nothing else. Opening the database, running migrations,
   acquiring the lease and reading every undamaged key all continue to work. A consumer with one
   corrupted history entry retains a working wallet, which is strictly better than today, where it
   retains a working wallet **and acts on a wrong value.**
2. **`verifyIntegrity()` reports, never refuses.** It returns an inventory — the structural result and
   the list of rows failing digest verification — so an operator can scope the damage before
   deciding. It is not wired into startup. Bitcoin Core's once-per-startup `integrity_check` is a
   reasonable *structural* gate and UmbraDB may run it at open; the **digest** pass must not be, both
   because it is O(database) and because a startup digest pass reintroduces exactly the
   whole-database refusal this section forbids.
3. **The error must name the row.** A corruption error that does not identify what was damaged gives
   the operator nothing to act on and forces a full restore for a single-row fault — recreating the
   blast-radius problem through the error surface instead of the open path.

### 4.3 What a consumer actually does — the four paths, in order

This is what `docs/CONTRACT.md` §1.y and a new `docs/recovery/CORRUPTION.md` must state. Today none of
it is written anywhere.

1. **Scope it.** Run `verifyIntegrity()`. Distinguish (a) structural failure — the file is damaged
   beyond individual rows, go to 3; (b) a bounded set of digest failures — continue.
2. **Re-derive, if the tier allows it.** Checkpoints, watermarks and the chain archive are derivable
   from chain: discard and resynchronise. This is Zcash's and Bitcoin Core's entire recovery model and
   it is available to UmbraDB for these tiers. **It is not available for TemporalKV history**, which
   is why the digest is required there and why step 3 is the real answer for it.
3. **Restore from backup.** `docs/CONTRACT.md` §6 must gain a SQLite section, and it must say what CLN
   says: verify the restored file **before** trusting it, and understand what the verification
   proves. CLN's phrasing is the model —
   *"`ok` … if the backup is **likely** not corrupted. If the result is anything else than `ok`, the
   backup is **definitely** corrupted"*
   ([advanced-db-backup.md#L354-L361](https://github.com/ElementsProject/lightning/blob/ae53e8775e57ddf8debfd6fc7b8e3cb5e2c93dc6/doc/beginners-guide/backup-and-recovery/advanced-db-backup.md#L354-L361)).
   For UmbraDB the restore check is `verifyIntegrity()` — structural **and** digest — which is
   strictly stronger than `integrity_check` alone and is the concrete payoff of having the digest at
   all: **the digest is what makes "is my backup good?" answerable.** That is an argument for the
   digest independent of detecting live corruption, and it is the one a consumer will feel first.
4. **If there is no backup: accept a bounded, *known* loss.** With a digest, the consumer knows
   exactly which keys are unrecoverable and can decide per key. Without one, they do not know a loss
   occurred. **This is the whole value proposition and it should be stated in exactly these terms:**
   UmbraDB does not promise to repair corruption. It promises that corruption is never silent, so the
   consumer's response can be proportionate instead of total.
   This step is where §1.3b(2)'s **bypass** lives: the documented-as-dangerous option that downgrades
   `ValueIntegrityError` to a warning and returns the bytes, so the consumer can extract the damaged
   row's remains and everything around it. PostgreSQL's `ignore_checksum_failure` is the exact model,
   including its wording — *"may allow you to get past the error and retrieve undamaged tuples."*

### 4.3a The precedent on recovery models, ranked

Worth recording because the recovery half of R-3 has more usable precedent than the detection half:

| Model | Who | Transfers to UmbraDB? |
|---|---|---|
| **Rebuild from an out-of-band source** | Firefox (bookmarks ← periodic JSON), Chromium (`Raze` + rebuild), Chromium/Firefox cookies (← RAM) | **Only for the re-derivable tiers**, where the chain is the source. Not available for TemporalKV — the fact that decides §1.3 |
| **Alarm, don't halt; resync from a healthy peer** | etcd ([data corruption guide](https://etcd.io/docs/v3.5/op-guide/data_corruption/)) — detection flags default **off**, checks raise an alarm | **Yes, as the shape** — this is §4.2's "report, never refuse", and etcd is the cleanest statement that detection must be paired with a named repair path |
| **Detect, then require a full rebuild** | Bitcoin Core block/undo checksum → *"You need to rebuild the database using -reindex"* | Partially — it is honest, but a multi-hour recovery. Acceptable for re-derivable tiers only |
| **Hard-fail the whole store** | Cassandra `disk_failure_policy=stop` (*"leaving the node effectively dead"*), Percona `innodb_corrupt_table_action=assert` (*"intentionally crash the server"*), Bitcoin Core wallet `DBErrors::CORRUPT` | **No — explicitly rejected by §4.2.** These are applications that can trade availability for correctness; a library cannot make that choice for its host |
| **Detect and crash-loop** | etcd's `applierV3Corrupt` fails **`Range`** too, `/health` goes unhealthy, kubelet restarts the pod ([#13340](https://github.com/etcd-io/etcd/issues/13340), [#15919](https://github.com/etcd-io/etcd/issues/15919) — a false-positive CORRUPT alarm) | **The anti-pattern.** Note reads dying too — the precise mistake §4.2 rule 1 forbids |

### 4.4 One thing the contract must NOT do

It must not recommend the SQLite CLI's `.recover`, ZFS/BTRFS, or ECC RAM as *the* answer and stop
there. CLN does push integrity responsibility down to the filesystem
([hardware-considerations.md#L37-L39](https://github.com/ElementsProject/lightning/blob/ae53e8775e57ddf8debfd6fc7b8e3cb5e2c93dc6/doc/getting-started/getting-started/hardware-considerations.md#L37-L39)),
and that advice is sound as *defence in depth* — it belongs in the doc as a recommendation. It is not
a discharge of the obligation: UmbraDB cannot verify the deployer took it, the probe cannot detect it,
and a library that outsources its stated guarantee to an unverifiable deployer precondition has
written an unenforceable contract. Compare how carefully `docs/durability-contract.md` §4 already
handles this for the pooler check ("the probe assists, it does not substitute").

---

## 5. What I could not source

Marked honestly; none of these should be asserted by the adjudicator.

1. ~~*A regret case for application-level per-row digests.*~~ **Found — see §1.3b.** My earlier draft
   recorded this column as empty; that is now superseded. **Kafka** adopted a per-record CRC, shipped a
   javadoc warning that depending on it was *"unsafe"*, and deleted it (KIP-98 / KAFKA-12612), with
   published reasoning that generalises directly to UmbraDB's encoding layer. **Cassandra** supplies the
   schema-evolution false-positive family, **Percona** the per-row-digest false-positive taxonomy, and
   **btrfs** the "we had to add an off switch" outcome. I have folded all of it into §1.3b as binding
   design constraints rather than as grounds to abandon §1.3, and the adjudicator is entitled to weigh
   it the other way. What I still could **not** source is a project that adopted per-row digests over a
   *database* specifically and later dropped the column — a GitHub commit-search for
   `"remove checksum column"` / `"revert row checksum"` surfaced nothing serious. That sub-column
   remains **empty, not refuted**.
2. **Whether Zcash regards rescan as its answer to disk corruption.** The machinery exists
   (`check_witnesses`, `queue_rescans`, `truncate_to_height`, restore-from-seed) and is used, but every
   documented motivation is **software bugs or chain reorgs** — `truncate_to_height`'s doc comment is
   explicitly about reorgs and does not mention corruption
   ([data_api.rs#L3898-L3918](https://github.com/zcash/librustzcash/blob/6487f1f10b55b74eedeb9eab4db4d7a24cfdbc9f/zcash_client_backend/src/data_api.rs#L3898-L3918)).
   The re-derivability property is real; **attributing it to Zcash as a stated corruption strategy
   would be putting words in their mouth**, and §2 does not.
3. **Field corruption rates — partially sourced now, with a large caveat.** One first-party number
   exists: **WeChat, "fewer than 1 in 10,000 users"** (§1.3a), plus repair success rates (~30% dump,
   ~72% backup, ~78% B-tree salvage). It is a *per-user* rate for a mobile messenger, not a per-database
   rate for a long-lived wallet store on server-class hardware, so transfer it cautiously. What I could
   **not** source: any Chromium or Mozilla field percentage — the Chromium tracker comments
   (`issues.chromium.org/40135574`, "Detect and deal with SQLite corruption in user profiles") are 404
   unauthenticated and `chromium.org/developers/design-documents/sqlite/` is **gone**. **Any
   "~0.02% of profiles per month"-style figure circulating on this council is unsourced and must not be
   used.** The hardware-SDC figures (Meta/Google "cores that don't count", *"one per thousand machines"*)
   are real but measure **datacenter CPU SDC**, not consumer storage corruption — a scope mismatch.
4. **Whether UmbraDB is in fact distributed as container images.** The brief states three install
   paths including docker. I could verify **two** in the sprint worktree — git tag
   (`npm install github:CharlesHoskinson/UmbraDB#v0.9.5`, `README.md:17`) and clone (`README.md:23`),
   plus a local tarball path (`README.md:25`). There is **no Dockerfile in the repo and no `ghcr.io`
   reference in any doc** (`find . -iname "Dockerfile*"` → empty). If images exist they are built
   elsewhere. This does not change the ruling — it strengthens it, since an out-of-tree image is even
   further from any doc a consumer reads, which is precisely why §1.6 makes the raised error a
   mandatory channel. But the docker claim is **unverified by me.**
5. **PostgreSQL's `data_checksums` and `amcheck` behaviour** is cited to version-pinned upstream docs
   and, for the default, **measured** on the pinned image. I did **not** verify `amcheck`'s detection
   behaviour experimentally; the claim that it is independent of `data_checksums` is documentation-level.
6. **`cksumvfs` performance cost — nobody has published one.** sqlite.org's page has no performance
   section and states no overhead figure. Every cost claim about `cksumvfs` on this council is
   therefore unsourced in both directions. (Coverage detail in §3.1 is now read from
   `ext/misc/cksumvfs.c`, not inferred — that caveat is discharged.)
7. **`cksumvfs` production adopters.** I found **none named.** Evidence of use is circumstantial
   (forum posters, an implied Go port). Treat adoption as **thin/unverified** — which cuts both ways:
   it is not evidence the mechanism is unsound, but it does mean UmbraDB would be an early adopter of
   a shim with two integrity bugs fixed in the last twelve months.
8. **libSQL / Turso — now sourced, and it changes nothing.** libSQL's checksums are **replication-log
   scoped** (rolling CRC-64 per WAL frame); a grep of the replica injector path shows the replica does
   **not** verify before injecting. There is **no per-page checksum on the main database file anywhere
   in libSQL.** Turso's Rust rewrite *does* have a per-page path (XxHash3-64, typed
   `ChecksumMismatch{page_id,…}`) but it is a **non-default compile-time feature** and is mutually
   exclusive with its encryption path. "libSQL has checksums" must not be cited as main-DB protection.
9. **The `node:sqlite` / libSQL escape hatch.** Confirmed neither compiles `cksumvfs` and neither
   exposes `fileControl`, so §3.2's conclusion is driver-independent rather than a `better-sqlite3`
   quirk. What I did **not** verify is whether the process-global-VFS objection (§3.2) has a
   published workaround; I read it from the source's `sqlite3_vfs_register(&cksm_vfs, 1)` call and
   found no upstream discussion of scoping it per-connection.

### 5.1 What the final lane changed — recorded against myself

All lanes are in. The last one returned evidence that **cuts against parts of my recommendation**, and
I have folded it in rather than filtering it. For the adjudicator's benefit, the four things that
moved:

1. **The regret case exists** (Kafka), and it generalises to UmbraDB's encoding layer. Folded into
   §1.3b as a binding design constraint. An adjudicator could legitimately weigh it as grounds to
   defer instead.
2. **The headcount got worse for me.** Firefox and Chromium — two of the largest SQLite deployments in
   existence — add **zero** application checksums, and Chromium says so in a source comment. §2.1 now
   records this against my ruling, and explains the one asymmetry that I think still carries it: both
   browsers hold an **out-of-band rebuild source**, and TemporalKV history has none.
3. **The benefit is narrower than the change-5 proposal implies** (§1.3a) — a value digest addresses
   only categories 4 and 5 of SQLite's own eight-category corruption taxonomy, and the one published
   field rate is <1 in 10,000 users. I narrowed the claimed benefit rather than defending the broad
   one.
4. **The bypass switch is now a requirement, not a nicety** (§1.3b(2)) — six engines were forced to add
   one after shipping detection.

**SQLCipher's per-page HMAC is confirmed in source** (HMAC-SHA512 over `ciphertext ‖ IV ‖ pgno`, on by
default, ~80 reserved bytes/page ≈ 2%). It is a widely-deployed existence proof of per-page
authentication under SQLite — **and it carries the warning that matters most for §4**: a MAC failure
surfaces as `SQLITE_NOTADB`, *indistinguishable from a wrong key*, with page identity only in a log
line. Signal-Android's response is the model worth stealing: cross-reference `PRAGMA integrity_check`
against `PRAGMA cipher_integrity_check` and emit **five distinct diagnoses** from the 2×2 outcome
matrix. That is the concrete argument for §4.2's rule 3 (the error must name the row) and for why
`verifyIntegrity()` must report *both* passes rather than one.

**One further constraint this lane surfaced, which independently validates §3.4's withdrawal:**
SQLCipher consumes **80** reserved bytes per page, `cksumvfs` requires **exactly 8**, Turso's AEAD
wants **48** — and reserve-bytes *can be increased but never decreased*. Committing the page reserve
to any one of these permanently forecloses the others, including ever adding SQLCipher to an existing
file. Not setting reserve-bytes = 8 speculatively was the right call.

---

## Summary of rulings

| # | Ruling |
|---|---|
| **0** | The "capability being lost" framing is **false as stated**. UmbraDB never required, probed or documented page checksums, and its own pinned PG17 reference server has `data_checksums = off` (measured). What is lost is the **operator's option**, not a guarantee. Weaker engineering claim, **stronger documentation obligation**. |
| **0.5** | **Adopt the sharper wording.** Re-measured on the ruled driver with a structural control: SQLite's checks *do* reliably catch **structural** damage (`SQLITE_CORRUPT`); they are blind **only** to damage confined to a stored value's bytes. "SQLite detects nothing" is wrong and would not survive review. The narrower claim is more defensible, correctly scopes `verifyIntegrity()`, and exactly delimits what the digest buys. |
| **1** | Silent undetected corruption may **not** be left undocumented. Grounds: UmbraDB's guarantee is already non-uniform and the boundary is invisible; the README declares an explicit "stated explicitly" standard; disclosure costs one sentence. |
| **2** | The obligation attaches to **non-re-derivable data**. Digest mandatory for TemporalKV values and the envelope store; **not required** for re-derivable tiers, which get disclosure plus the structural pass. The discriminator, sharpened by the browser precedent: the duty to detect falls away exactly where an **out-of-band rebuild source** exists. |
| **2b** | **Two binding design constraints** (§1.3b): digest the **stored bytes**, never the logical value, and make every value-rewriting migration recompute it — Kafka deleted its per-record CRC precisely because a lower layer may rewrite bytes, and Cassandra turned integer-widening and `ALTER TABLE` into corruption reports. And **ship the documented-as-dangerous bypass with the digest**, not after it: PostgreSQL, Percona, btrfs, Redis, Cassandra and LevelDB were all forced to add one. |
| **2c** | **Recorded against my own ruling** (§1.3a, §2.1): Firefox/Chromium add zero checksums over SQLite; a value digest covers only 2 of SQLite's 8 corruption categories; published field rate **<1 in 10,000 users**; RocksDB defaults its equivalent **off** for *"non-trivial"* read cost. The council may legitimately overrule me on this ratio — but it should do so on **that number**, not on a guess. |
| **3** | The proposed digest is **not novel** — Bitcoin Core's `WriteDescriptorKey` is the same design (digest written with the value, recomputed on read, typed corruption error), for the same data class, shipping today. But the precedent is **split, not unanimous**: CLN and LND store non-re-derivable channel state with no digests. They are real counter-examples, distinguished by disclosure and by being **applications rather than libraries** — not dismissed. The defensible claim is narrower: **no surveyed project both omits detection and stays silent, except LND, which is the cautionary tale.** |
| **4** | **Land it pre-tag.** A digest added later can only certify the bytes it finds, silently signing already-corrupt rows. The SQLite backend has no installed base *today* and will never be this cheap again. |
| **5** | Adding `VALUE_INTEGRITY` is **additive and non-breaking** (`STABILITY.md:18-22`). The commitments seat's Ruling 3 was specific to `SQLITE_BUSY` and turns on **transience**; every premise inverts for corruption. The real breaking risk is **union widening**, which is a separate, correct, pre-1.0 concern. |
| **6** | `cksumvfs`: **declined, not deferred.** Not in the amalgamation, not compiled into `better-sqlite3@13.0.2` (measured), `PRAGMA checksum_verification` is a **silent no-op** there (measured — the contract must warn about this), no Node binding exposes `fileControl`, and the enabling hook is explicitly undocumented upstream. The decisive objection is **library-specific and does not expire**: registration makes `cksmvfs` the **process-global default VFS**, mutating every unrelated SQLite connection in the host process. Its own history includes a **transaction-loss bug** fixed only in SQLite 3.51.0 and a false-positive class — which is an evidence-backed argument *for* the application digest, whose worst failure is a recoverable single-row false rejection. Complementary to the digest in principle; not a substitute either way. |
| **7** | Recovery: detection is **not** worse than nothing — **whole-database refusal** is. Row-scoped errors at read time, `verifyIntegrity()` reports and never refuses, restore-from-backup is the documented path, and the digest's first felt benefit is making *"is my backup good?"* answerable at all. The recovery half has better precedent than the detection half (§4.3a): **etcd's alarm-don't-halt** is the shape to copy; **etcd's own crash-loop from a false-positive alarm** (reads fail too, `/health` flips, kubelet restarts the pod) is the anti-pattern; Cassandra/Percona/Bitcoin-Core hard-fail is rejected because those are *applications*, and a library cannot trade its host's availability for correctness. |
| **8** | The statement must appear in **five** places, and the fifth — a raised error plus a callable operation — is mandatory **because there is no registry chokepoint**. |
