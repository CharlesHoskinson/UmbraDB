# MPE recovery composition

## 1. Existing foundation and reconciliation

Baseline inspected: commit `3c0c68b3d0397ee2e8344b77e9ed715132fef6ca`, package 0.9.5, Node >=24, PostgreSQL 17 tested. The design builds on `design/design.md` §§2–5, `design/design-interfaces.md` §§1.3/3.1–3.4 and `Formal/STORAGE_ALGEBRA.md` §§1–4. It preserves one trusted writer and one Postgres trust domain.

`saveAndAdvance` currently calls checkpoint `save` and watermark `set` in one transaction (`src/postgres/save-and-advance.ts`). Its signature is `(deps, walletId, networkId, data, cursor, opts)`, not the abbreviated README example. It does not accept an outer transaction or acquire a lease. Calling it inside `withTransaction` opens an independent transaction and breaks the intended composition. Existing public adapters support a shared opaque `TransactionHandle`; do not deep-import the private SQL resolver.

Watermarks are last-write-wins, not monotone by themselves. TemporalKV provides `expectedVersion: 0n` create-only insertion, but permits only one write per key per transaction; recorded-time collisions can also reject closely spaced separate writes. MPE-specific storage work must respect these rules and provide typed bounded retry behavior rather than swallow faults or invent clock guarantees.

## 2. Selected deployment and ownership

Rust MPE nodes own transport, admission, recognition and retained-envelope protocol. A trusted Node/TypeScript workflow host owns the UmbraDB recovery adapter and Postgres connection. SQLite remains a minimal standalone Rust/client option. The Node host is an authenticated application endpoint; a central operator never receives every participant's plaintext or session keys by default.

The shared recovery interface is a local application port, not an unauthenticated network service. Workflow domains bind network/genesis, Registry, local principal/application and profile version. External source identity/finality and business authorization are validated by MPE before local effects; encrypted storage does not establish those facts.

## 3. Proposed atomic operation

Proposed public capability (names remain provisional):

- `commitProcessingBatch(domain, lease, expectedCursor, events, effectPlan, checkpoint?, outboxIntent?)`
- `restoreRecoveryBundle(domain, expectedProfile, trustedFreshnessEvidence)`
- `openRecoveryStore({ durability: "strict", cipher, keyProvider, retentionPolicy })`

These are **future APIs**, not current exports. The processing operation performs one transaction that validates writer ownership and expected cursor, creates/reconciles event or logical-action dedup records, applies local Umbra-backed effects, writes optional checkpoint state and outbox intents, and advances the cursor. All become visible at one commit or none do. Replaying a matching committed action returns its prior local result; a conflicting intent under the same action identifier is rejected. Transport envelope identity and logical business action identity remain distinct.

The body stages database effects, not arbitrary remote calls. Outbox dispatch runs after commit with a stable destination idempotency key, explicit expiry and recorded uncertain-completion state; a lost network reply requires destination reconciliation. The default private profile emits no automatic receipt merely because an event was recognized or locally processed.

For a current nonsecret prototype, the same limited composition can use existing `withTransaction`, `PgTemporalKV.put(...,{tx})`, `CheckpointStore.save(...,{tx})` and `Watermarks.set(...,{tx})`. It does not use nested `saveAndAdvance`, extend arbitrary SQL effects or claim the new lease/durability guarantees.

## 4. Strict durability and writer ownership

Current migration startup checks reject `fsync=off`/`full_page_writes=off` but only warn on `synchronous_commit=off`. Exceptions thrown by `onDurabilityWarning` are deliberately swallowed (`src/postgres/migrate.ts`); throwing there cannot enforce strict mode. The new mode must reject unsafe durability before admitting recovery work and enforce/check the effective commit policy on the actual transaction connection, including reconnection. A primary-local WAL-flushing policy is sufficient for the defined single-node durability; replica availability remains outside that guarantee.

Current advisory locks reserve a connection while ordinary `withTransaction` uses the general pool. A loss of the lock connection does not automatically prevent another pooled connection from writing. The future capability must bind protected transactions to writer ownership/connection or an equivalent transaction-checked owner generation. It must reject a stale/lost lease before effects commit. This does not introduce distributed HA or authorization against a hostile writer. Bound reservation, lock and transaction waits. A release/commit response fault can leave completion uncertain; resolve durable state before replaying an effect.

## 5. Private state, restore and retention

Follow `SECURITY.md`: current stores do not encrypt plaintext, and schemas are not tenant boundaries. New recovery bundles authenticate domain/profile/version, checkpoint/cursor association and state bytes. Encrypt secret-bearing payloads before persistence with application-endpoint key custody; protect metadata, Postgres files, WAL, backups and replicas as required by the threat model. Cipher/key rotation failure is explicit, not plaintext fallback. Dedup must not cross mutually distrusting principals; coordinate scoped addressing with its existing future track. Keep isolated databases for distinct trust domains until verified isolation exists.

A manifest hash establishes byte integrity, not trusted provenance or freshness. Restore checks an authenticated checkpoint reference and external trusted freshness/anti-rollback evidence appropriate to the selected profile; define that trust source before implementation. If required evidence, keys or retained data is unavailable, return a typed recovery gap or blocked restore. Never silently reset to zero or mark stale data final.

Application state may have long history; expired ratchet keys may not. Declare which historical payloads are recoverable, which keys must be erased, and what backups retain. A strict erasure profile cannot export old session secrets to indefinite checkpoints. Encryption alone is not secure erasure if a key survives in backups. GC must preserve data needed by a live recovery manifest and retain dedup/nullifier evidence for the complete permitted replay horizon; the 48-hour envelope window is not automatically that horizon. Erasure across already-issued copies/backups is not guaranteed unless the chosen deployment proves it.

## 6. Validation and release boundary

The existing Lean proofs cover abstract store laws, not the SQL adapter or this MPE composition. New composition needs its own model, negative controls and PostgreSQL fault tests. See `Formal/LEAN_FORMALIZATION_PLAN.md` §scope and `Formal/STORAGE_ALGEBRA.md` §4. No Lean edits/proofs occur in this proposal.

Validate RFQ acceptance state, invoice matching and bounded agent approvals against duplicate delivery, mid-transaction process death, unclean Postgres death, reconnect, expired intent, stale cursor, lost lease, corrupted/wrong-domain/wrong-key restore and retained-history gaps. Test both cursor/data ordering and local effect/dedup/outbox atomicity. Measure handler recovery and storage overhead separately from bus transport performance.

Release requires audited supported interfaces, contract docs/error codes, migration/backup procedures and required CI test IDs with no silently skipped recovery cases. Existing checks at the baseline do not certify the future capability.
