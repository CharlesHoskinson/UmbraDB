# Final domain-correctness audit — Midnight Express recovery proposal

**Final verdict: PASS.** Targeted read-only re-audit verified the corrected acceptance table; initial finding D1 is resolved. Independent read-only review of final working-tree proposal on `design/midnight-express-recovery`; HEAD and merge-base with fetched `origin/main` are `3c0c68b3d0397ee2e8344b77e9ed715132fef6ca`. No repository edits, runtime certification, Lean changes or Graphify regeneration performed by this auditor.

## Initial finding D1 — MEDIUM / blocking, now RESOLVED: acceptance table links imply unrelated protocol obligations

File: `openspec/changes/midnight-express-recovery/specs/mpe-recovery/spec.md`.

- **Line 10, UDB-MPE-004:** strict local WAL commit durability is linked to MPE-STO-004/017. The authoritative MPE appendix defines STO-004 as Store Node retained-envelope coverage and STO-017 as recognition-independent complete-shard backfill requests. Neither defines backend processing commit policy. Replace these links with MPE-CON-033/MPE-STO-025 as supporting local atomic recovery obligations; state strict WAL enforcement is a new Umbra acceptance obligation.
- **Line 16, UDB-MPE-010:** backend live-manifest GC safety and logical dedup retention are linked to MPE-STO-039/042, which instead define separation of Anchor/storage evidence and Store Node retention receipt responses. Replace with MPE-STO-025/MPE-CON-033 plus the declared local replay policy. Network receipt obligations remain outside Umbra's scope.
- **Line 9, UDB-MPE-003:** MPE-CON-046 is circuit expiry enforcement, not local same-ID/different-intent rejection. Use MPE-CON-033 for local processing support; MPE-CON-043 may be labelled signed-intent context only, not an implemented contract authorisation claim.

Evidence: `/home/hoskinson/Projects/midnight-express/docs/design-document/build/appendix-a.md:884`, `:916`, `:930`, `:1712`, `:1760`, `:1790`, `:1844`, `:1856`. Because this is an acceptance/traceability specification intended to guide future implementation, these misleading mappings should be corrected before the tranche passes.

## Semantics checked and passing

- **No implementation or release claim:** integration summary `docs/integrations/midnight-express-recovery.md:7`, proposal `proposal.md:11`, requirements `specs/mpe-recovery/spec.md:3`, tasks `tasks.md:3` distinguish future additive work from package 0.9.5 and frozen 1.0 scope. README and ROADMAP additions preserve this distinction.
- **Public API and transaction ownership:** `design.md:7`, `:25`, `:29` correctly prohibit nested `saveAndAdvance` and unsupported raw-SQL composition. Existing helper opens its own transaction (`src/postgres/save-and-advance.ts:66`); public primitives join an opaque handle (`src/postgres/temporal-kv.ts:95`, `src/interfaces/checkpoint-store.ts:193`, `src/interfaces/watermarks.ts:63`). `design.md:9` correctly states create-only `expectedVersion:0n`, last-write-wins watermarks and per-key transaction write limits (`src/postgres/temporal-kv.ts:128`, `src/postgres/migrations/001_temporal_kv.ts:123`).
- **Actual transaction durability:** `design.md:33` and UDB-MPE-004 require checks on the effective transaction connection and reconnection. The warning callback cannot enforce strict mode: `src/postgres/migrate.ts:163` catches synchronous exceptions and asynchronous rejections. Current contract warns rather than rejects asynchronous commit (`docs/durability-contract.md:47`).
- **Ownership without HA:** `design.md:35`, UDB-MPE-005 and `tasks.md:7` require future ownership binding while explicitly avoiding distributed takeover. Current lock/transaction separation and missing fencing are correctly identified (`docs/CONTRACT.md:101`). Proposed ownership semantics are requirements, not guarantees inferred from current advisory locks.
- **Outbox and external effect boundary:** `design.md:27`, UDB-MPE-011 and `tasks.md:10` correctly place dispatch after commit, retain expiry/idempotency/uncertain completion, and require destination reconciliation instead of remote exactly-once claims.
- **Privacy, authenticated restore, rollback and retention:** `design.md:39–43`, UDB-MPE-006–010 and `tasks.md:9` correctly leave cipher/key custody, trusted freshness source, replay horizon and erasure policy to future supported design. They do not equate integrity hashes with trusted freshness, claim schemas isolate hostile tenants, or promise erasure from already issued backups. Source model matches `docs/CONTRACT.md:135` and `src/interfaces/checkpoint-store.ts:182`.
- **Architecture and verification boundary:** `design.md:13–15`, `:47–51` retain trusted Node application endpoint versus Rust transport, SQLite fallback, MPE-owned authority/finality, no existing SQL/Lean proof of the integration, and explicit future fault-test gates.

## Targeted re-audit and resolution

Verified final `specs/mpe-recovery/spec.md:9–10` and `:16`: UDB-MPE-003 now separates CON-043 authority context from CON-033 local idempotency; UDB-MPE-004 maps to CON-033/STO-025, labels STO-011 as receipt-after-persistence context, and explicitly states strict power-loss durability is an added local profile gate; UDB-MPE-010 now maps to STO-025/CON-033 plus explicit local replay policy. These resolve D1 without changing architectural scope.

Also verified final `specs/mpe-recovery/spec.md:13–14`, `:17`, `:19`: endpoint custody maps to PRV-007; key erasure maps to CRY-029/030 with the declared backup profile; expired outbox dispatch is explicitly refused; privacy acknowledgement behavior maps to CON-039. Authoritative source checks confirm PRV-007 keeps recognition/decryption secrets inside the trusted endpoint, and STO-011 concerns process-restart recovery rather than power-loss durability. The final table preserves that distinction.

**No remaining domain-correctness blockers. PASS for the design-only proposal**, not certification of an implemented adapter, HA system, or future release.


## Final targeted CI-fix audit — PASS

Independently reviewed the final `.gitleaksignore` diff. The sole addition at `.gitleaksignore:20–24` documents and exempts the exact fingerprint `c80329a40c0c5809940fee75c793d61088aa7250:docs/research/sqlite-migration/graph/graph.html:generic-api-key:281`. There is no path-wide or rule-wide exclusion.

Independently read historical `graph.html:281` at that commit: the detected material is a serialized hyperedge node list, containing symbolic identifiers `l7_precedent_random_hash_key_write_amplification` and `l7_precedent_erigon`. Parsed historical `graph/graph.json` confirms both are declared nodes: respectively the rationale “Random-hash-key B-tree write amplification” with source location B3, and the concept “Erigon”, both attributed to `l7-precedent.md`. This is a graph identifier false positive, not credential material.

Severity: no remaining finding. The exact-fingerprint suppression is justified and does not change recovery requirements or claimed implementation. Parent reports verified Gitleaks 8.28.0 full-history scan over 223 commits PASS and an all-zero seed outside the template detected with expected exit 1; this auditor independently verified classification and suppression scope, not scanner execution. The prior design-only domain PASS remains valid.
