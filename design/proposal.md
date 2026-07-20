# Proposal — Postgres+JSONB storage rebuild (remove the MongoDB dependency)

## Why

This environment's storage layer is entirely MongoDB-backed today, across two
subsystems: `midnight-mongo-store` (TemporalKV, content-addressed chunked
checkpoint store, watermarks, a standalone-vs-replset transaction-detection
commit layer — 51/51 tests, Plans A+B merge-ready) and
`examples/storage/{MongoPrivateStateProvider,MongoWalletStateStore}.ts` (the
SDK's real `PrivateStateProvider`/wallet-state-store interfaces, AES-256-GCM +
superjson-encrypted blobs).

MongoDB is SSPL-licensed, so `cache.nixos.org` serves no prebuilt binary for
it — every `nix develop` on a cold Nix store compiles MongoDB from source
(confirmed: this has never actually finished in this environment; both a
boot-time cron job and an interactive `nix develop` were killed mid-build).
Beyond the build-time cost, running a real `mongod` adds a systemd unit, a
replset-detection branch nothing else in this Node/TypeScript-only project
needs, and a second database technology to reason about.

Deep research (this change; see `design.md`) confirms Postgres+JSONB can
replace Mongo for this workload with no capability loss that matters here:
this is a pre-production rebuild of a small, fully custom, hand-rolled Mongo
surface — not a large legacy deployment — so a straight rewrite onto native
Postgres+JSONB beats introducing a Mongo-compatibility shim (FerretDB was
evaluated and rejected: its transaction/change-stream semantics are still
immature, weakest in exactly the areas — multi-doc atomicity, GridFS-like
blob patterns — this project's checkpoint/blob store stresses).

## What changes

Build a new `midnight-pg-store` package that is a functional replacement for
`midnight-mongo-store`, plus `Pg{PrivateStateProvider,WalletStateStore}`
replacements for the two `examples/storage/Mongo*.ts` classes, backed by
PostgreSQL + JSONB instead of MongoDB. Once the new package passes the same
conformance test suites the Mongo ones do (and clears the state-equivalence
bar in `design.md` §10), rewire `counter-cli-additions/*.ts` to the new
provider, then remove: `midnight-mongo-store`, `examples/storage/Mongo*.ts`,
the `mongodb`/`mongodb-memory-server` npm dependencies, `mongod` from
`flake.nix`, the `mongod`/`midnight-mongod-ready` systemd units, and the
already-decided-but-not-yet-built Tier-2 indexer's Postgres usage stays as
planned (this change is scoped to Tier 1 only; see `design.md` §0 for how the
two reconcile — they will end up sharing one Postgres instance, separate
schemas).

Explicitly NOT in this change: any change to the not-yet-built Tier 2
(chain-indexer/analytics) design, which already targets Postgres+TimescaleDB
by forking the official indexer schema — that decision stands unmodified.
Not a FerretDB or any other Mongo-wire-protocol compatibility layer (evaluated
and rejected, see `design.md` §1). Not a data migration (no real data
exists yet to migrate — this is a from-scratch rebuild, run side-by-side with
the Mongo package until cutover).

## Impact

- **Affected code (new):** `midnight-pg-store/` (mirrors
  `midnight-mongo-store/`'s module layout), `examples/storage/PgPrivateStateProvider.ts`,
  `examples/storage/PgWalletStateStore.ts`, `examples/storage/pgClient.ts`.
- **Affected code (removed, on cutover):** `midnight-mongo-store/`,
  `examples/storage/Mongo*.ts`, `examples/storage/mongoClient.ts`, the `mongodb`
  and `mongodb-memory-server` npm dependencies repo-wide, `mongodb` from
  `flake.nix`'s devShell inputs, `mongod.service`/`midnight-mongod-ready.service`
  from `systemd/`.
- **Affected code (rewired):** `counter-cli-additions/ballot-preprod.ts`,
  `devnet-smoke-test.ts`, `tx-ledger.ts`, `migrate-legacy-checkpoint.ts`,
  `migrate-legacy-private-state.ts` — swap the Mongo provider/store imports for
  the Postgres ones once the new package is proven equivalent.
- **Expected win:** removes the from-source MongoDB Nix build entirely (the
  actual, currently-blocking pain point); one fewer runtime service
  (`mongod.service`) in the self-healing systemd stack; native ACID
  transactions remove the standalone-vs-replset detection branch; Postgres is
  already required for the Tier-2 indexer, so this converges the environment
  onto a single database technology.
- **Risk:** `TemporalKV.getAt` (point-in-time reads) has no native Postgres
  analogue — the current-table + trigger-populated history-table design is
  new implementation surface, not a mechanical port (design.md §2). Content
  hash / dedup / GC-with-grace-window logic is being re-derived, not copied,
  and needs the same rigor the Mongo version got (Plans A+B: multiple fix
  rounds, Opus-audited). Mitigated by an explicit state-equivalence test gate
  (design.md §10) before cutover, mirroring the mongo-store Plan A/B merge
  gate.
- **Delivery:** implemented by a Sonnet builder against `tasks.md`, with two
  parallel Opus auditors per task (spec-compliance; code quality/docs/test
  coverage) — same review cadence the Mongo store used (Plans A+B, Opus
  review each task, fix rounds before close).
