# Proposal — v1.0.0 API Surface & Release Contract

> **Status:** Draft for the 1.0.0 program. Capability: `release-contract`. Change id:
> `v1.0.0-api-surface`. This change is the **keystone** of the 1.0.0 gate — the roadmap's
> critical path routes the API freeze (Phase 2) *after* the one API-affecting correctness fix
> (G5, a separate change) and *before* the CI/test gates; nothing else in the 1.0.0 program is
> versionable until the surface this change defines exists.

## Why

UmbraDB's five storage primitives — TemporalKV, Transaction/Lease, CheckpointStore, Watermarks,
TransactionHistory — plus the `PgWalletStateEnvelopeStore` capability are all implemented, merged
to `main`, and property-tested against real Postgres. The engineering core is strong. **But there
is nothing to version.** `package.json` is `{"name":"umbradb","version":"0.1.0","private":true}`
with **no `main`, no `module`, no `exports`, no `types`** field, and **there is no `src/index.ts`**
barrel (confirmed: `ls src/index.ts` → does not exist). Consumers today `import` deep internal
paths (`./src/postgres/temporal-kv.js`). A `1.0.0` tag on this state would be a semantic no-op: a
version number is a statement about an interface, and today there is only a directory layout that
happens to be importable (Council A, ruling (a): "YES — it is *the* blocker; nothing else on the
gate list means anything without it").

The consolidated roadmap makes the same call in its headline verdict #1: *"The gating item for
1.0.0 is not a feature — it is freezing a public API surface … 1.0.0 = the five merged primitives
+ wallet-envelope, behind a frozen, documented, versioned surface."* For a storage library the
written **contracts** (errors, durability, migration, cancellation, threat model) *are* the
product; the TypeScript types are their shadow (Council A §4(a)-3). This change delivers that
surface and those contracts.

Grounding follows this project's own established practice: every claim below cites real code at
`/root/UmbraDB` (file:line) and the adjudicated council rulings it must honor, not assumption.

## What changes — the 1.0.0 gate items this change addresses

This change covers gate items **G1, G2, G3, G4, G20** (ROADMAP-v1.0.0-CONSOLIDATED §A + §F).

1. **G1 — Public API surface.** Add `src/index.ts` as the single public barrel; add `exports` /
   `types` / `main` to `package.json`; drop `private:true`; ship emitted `.d.ts` declarations; add
   a packed-tarball install smoke test that imports the public surface and runs against real
   Postgres. The frozen surface is exactly: `createClient`, `runMigrations`, the five adapters
   (`PgTemporalKV`, `PgCheckpointStore`, `PgWatermarks`, `PgTransactionLeaseLayer` — whose
   `withTransaction`/`withLease` methods are the frozen combinator API, *not* standalone exports —
   `PgTransactionHistoryStorage`) + `PgWalletStateEnvelopeStore`, all `src/interfaces/` types, the
   `Rollback` control primitive (an `Error` subclass with no catalog code), and the `StorageError`
   hierarchy (Council A §4(a)-1).

2. **G2 — SemVer stability policy + `CHANGELOG.md`.** A written commitment — no breaking changes
   in minor/patch, deprecate-in-minor-then-remove-in-major — plus a Keep-a-Changelog `CHANGELOG.md`
   carrying the `1.0.0` entry. The stability *promise* is part of what the word "1.0" means, not an
   accessory (Council A gate table G2; report 01 P0-2).

3. **G3 — Frozen, cleaned error-code catalog with a `retryable` field.** Publish the
   `{code → meaning → retryable}` table as public API; promote retryability from prose to a
   machine-readable field on the `StorageError` base; **and strip-or-mark-experimental the
   `chain_archive` error classes currently sitting in the shareable surface**
   (`ChainArchiveInvariantError`/`ChainArchiveCheckViolationError` in `src/postgres/errors.ts:61,67`
   and `ChainArchiveError`/`BlobIntegrityError`/`BlobMissingError`/`BlockNotFoundError` in
   `src/interfaces/chain-archive-store.ts:131-152`). Freezing codes for a feature that only ships
   in 1.1 would poison the freeze — "the worst of both decisions" (Council A critique #6, ruling
   (e) pre-freeze obligation).

4. **G4 — The contract doc set, all *true*.** Written contracts for: durability (+ the startup
   probe G6 will enforce), forward-only / no-downgrade migration, cancellation semantics, the
   `save`-retry caveat (F2 as documentation, per council), the lease limitation (F3 as
   documentation), backup/restore guidance, and a threat-model pointer — **including a
   *format-headroom* paragraph** stating that chunk addressing and envelope encoding are versioned
   so 1.1 can add keyed/encrypted chunk modes additively without a breaking migration (Council A
   critique #7, gate table G4).

5. **G20 — Freeze the Lean cut-line.** Declare the 1.0.0 formal cut-line as exactly
   `{T3, T5, W1, C1}` (already mechanized and trust-gated in CI) with a written deferral of
   C2a/GC, ordered reconstruction, lease traces, keyed-store lifting, and SQL/runtime refinement.
   This converts the unfalsifiable checklist item ("tractable properties proved") into a checkable
   box (report 01 gap table row 1; Council A gate G11/§F).

## Non-goals (explicitly out of scope — honoring the council rulings verbatim)

- **The co-transactional `save()` fix (G5) is NOT in this change.** It changes `save`'s signature
  and therefore MUST land *before* this freeze (roadmap critical path step 1; Council A Phase 1).
  This change consumes its final signature; it does not author it.
- **`save()` idempotency is NOT in scope.** Ruled P1 "with Sprint 9's retry wrapper," a benign
  identical-content duplicate under load-latest-complete semantics, not corruption (roadmap
  "Council rulings" §1; Council A critique #1). 1.0.0 ships only the *documented* save-retry
  caveat (part of G4), not the `idempotency_key` UNIQUE migration.
- **The dedup-oracle fix is DOCUMENTATION only for 1.0.0.** Keyed/per-consumer chunk addressing +
  encryption seam is a 1.1 storage-*format* change; here it is honored solely by the G4
  format-headroom paragraph + the threat-model pointer (roadmap "Council rulings" §3; Council A
  critique #7, §3). No keyed-chunking code.
- **No foreign consumer app is imported.** Wiring the Mongo store / counter-cli consumer to gate
  this release would breach UmbraDB's indexer-agnostic boundary (persistence stays
  consumer-agnostic; consumers are test infra at most, never a dependency) — Council A ruling (b);
  MEMORY "UmbraDB sync architecture boundary".
- **All three unmerged tracks stay OUT of 1.0.0.** Full-chain archival → 1.1 headline;
  verifiable-snapshot and torrent bootstrap → 1.2+ (design-only). This change's G3 explicitly
  *removes* archival's error classes from the frozen surface as the pre-freeze obligation for that
  deferral (roadmap verdict #4, deferral table; Council A ruling (e)).
- **No public observability/tracing API.** Deferred to 1.1 — its foundation (`tracingChannel`) is
  Node Stability-1 Experimental; freezing a 1.0 API around it is the premature commitment 1.0
  exists to avoid (Council A critique #3). G4 documents *how to observe UmbraDB today*
  (auto_explain, pg_stat_statements, pg_stat_activity) instead.
- **No perf-number gate, no test-suite construction, no infra CI here.** Perf baselines (G13/G14),
  crash/soak tests (G9-G12), and supply-chain CI + SECURITY.md (G15-G19) are their own changes;
  perf numbers never gate 1.0.0 (roadmap §D; Council A critique #2). This change only reserves the
  threat-model *pointer* in G4; the threat-model *document itself* (G15) is the InfoSec change.

## Impact

- **New files:** `src/index.ts` (public barrel); `CHANGELOG.md`, `docs/CONTRACT.md` (or the
  README's contract section) covering durability/migration/cancellation/save-retry/lease/backup/
  format-headroom + threat-model pointer; a stability-policy section; `test/smoke/pack-install.*`
  (packed-tarball smoke test).
- **Modified files:** `package.json` — drop `private:true`, add `main`/`types`/`exports` (strict,
  no deep-import wildcard), add a declaration-emitting `build` script (today only
  `"typecheck":"tsc --noEmit"` exists, so nothing emits `.d.ts`); `src/interfaces/storage-errors.ts`
  — add the machine-readable `retryable` field to the `StorageError` base; `src/postgres/errors.ts`
  + `src/interfaces/chain-archive-store.ts` — strip-or-mark-experimental the chain-archive error
  classes so they are not part of the frozen barrel; `README.md` — reframe the front-matter
  "Full-chain storage — validated live against public Preprod (AC-8)" section as a 1.1 *preview*
  outside the frozen 1.0 surface (it currently markets a deferred track); `ROADMAP.md`/`Formal`
  — record the frozen Lean cut-line and deferral (G20).
- **Deliberately NOT in the frozen surface:** Zod schema objects (internal), the observability
  seam (deferred), anything under `chain-archive`/`chain-archive-sync` (unmerged), the
  `nix/midnight-env` dev stack (Council A §4(a) closing paragraph).
- **Risk:** the freeze is irreversible under SemVer — anything shipped in the barrel or the error
  `code` set becomes a compatibility promise breakable only by a major bump. The dominant risk is
  *including* something that should have been excluded (a chain-archive code; a deep-import escape
  hatch; the pre-G5 `save` signature). The mitigations are: the strict `exports` map (deep imports
  become unresolvable — that is the point), the pre-freeze chain-archive strip (G3), and the hard
  ordering dependency on G5 landing first.
- **Delivery cadence:** matches Sprints 1-8 — this proposal/design/tasks/spec drafted and reviewed
  first (Opus panel + Fable-5 consolidation + Codex GPT-5.6 Sol audit), *then* a builder implements
  against it with two parallel Opus auditors per task.
