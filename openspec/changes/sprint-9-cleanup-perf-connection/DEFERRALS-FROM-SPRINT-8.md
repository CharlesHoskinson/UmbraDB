# Sprint 8 audit deferrals folded into Sprint 9

The Sprint 8 review (4-auditor panel: Opus domain-correctness + adversarial +
release/coverage, plus Codex GPT-5.6 Sol cross-vendor; Fable-aggregated) BLOCKED on
three findings that were fixed in-sprint (F1 merge-seam honesty + first-write guard,
F2 `__lifecycleDetail` reserved-key hardening, F3 reconstruction validated end-to-end
against a real preprod SDK entry). Four lower-priority items were deliberately
deferred to Sprint 9 rather than expanding the Sprint 8 blast radius. They are folded
into this change's existing themes below; Sprint 9 implementation must pick them up.

## → `storage-client-hygiene`

- **D8-1 — `serialize()` emit-shape decision.** `PgTransactionHistoryStorage.serialize()`
  returns UmbraDB-shaped JSON (a diagnostic dump; Postgres is the durable store, and the
  SDK core never calls `serialize()` on the injected storage — verified against the
  `unshielded-wallet`/`facade` checkout). A future Pg→InMemory migration would hit an
  SDK-shape mismatch. Decide and implement: emit SDK-shaped entries, or throw a typed
  `NotSupported` for the migration path. (Sprint 8 F10 — documented there, not decided.)

- **D8-2 — `__lifecycleDetail` boundary defense-in-depth.** Sprint 8 fixed the collision
  hazard adapter-side (reserved prefix `UMBRADB_ADAPTER_RESERVED_KEY_PREFIX` + write-time
  rejection + read-time Zod validation). The deeper, belt-and-suspenders fix lives at the
  Sprint-7 PgTHS boundary: either a second reserved prefix the `SafeObjectKeySchema`
  boundary also protects, or a dedicated lifecycle-detail column instead of a `sections`
  stash. (Sprint 8 F2 defense-in-depth — adapter-side fix shipped; boundary-side deferred.)

- **D8-3 — live SDK-loader hardening.** `test/integration/live-fixtures/midnight-wallet-sdk-loader.ts`
  reaches into the sibling `midnight-wallet` checkout by hard-coded path (including another
  package's `ledger-v8` wasm) and types the surface as `Promise<any>`, masking SDK drift;
  the raw wallet `seedBuffer` is never zeroized (unlike `hdWallet.clear()`). Add an
  env-var path override + a typed loader surface + seed zeroization after use.
  (Sprint 8 F12.)

## → `performance-observability` / test-tiers (nightly, non-gating)

- **D8-4 — cold-boot conflicting-history adversarial test.** The Sprint 8 cold-boot gate
  proves resume-from-cursor (`appliedId>0n`) and continuity via `adapter.getAll()`, but not
  that the Pg store *supersedes* a divergent blob-embedded history. Add a nightly test that
  seeds the Pg store and the serialized envelope blob with deliberately divergent tx
  histories and asserts the restored wallet reads Pg's version through the adapter.
  (Sprint 8 F11 — Codex/adversarial wanted this; ruled beyond Sprint 8's binding gate.)

These do not change Sprint 9's confirmed scope shape (three themes); they are concrete
additions to the cleanup + test-tier work already in `tasks.md`.
