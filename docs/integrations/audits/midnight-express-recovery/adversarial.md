# UmbraDB MPE recovery proposal: independent adversarial audit

Baseline: origin/main `3c0c68b3d0397ee2e8344b77e9ed715132fef6ca`; branch `design/midnight-express-recovery`. Reviewed read-only on 2026-10-03. Scope: README.md/ROADMAP.md additions, docs/integrations/midnight-express-recovery.md and openspec/changes/midnight-express-recovery/{proposal.md,design.md,tasks.md,specs/mpe-recovery/spec.md}. AGENTS.md read and followed. No implementation, Lean or generated-artifact changes made by this reviewer.

## Final verdict: PASS

Targeted read-only re-audit verified the corrected final spec table and `git diff --check` on the integrated baseline above. **No unresolved blocking findings.** PASS applies only to this design/documentation tranche, not production capability certification.

**Medium, resolved: requirement traceability.** Initial `openspec/changes/midnight-express-recovery/specs/mpe-recovery/spec.md:10,13,14,16,19` gave misleading or incomplete source mappings. The final table now correctly cites CON-033/STO-025 and STO-011 as context while explicitly labeling stronger power-loss durability an added local profile gate; PRV-007 for endpoint custody; CRY-029/030 for erased/skipped secrets; STO-025/CON-033 plus explicit local replay policy for recovery GC; CON-039 for automatic-message privacy. Row 9 also replaces expiry CON-046 with the relevant authority/idempotency context. Re-read all corrected rows against the canonical MPE appendix and candidate recovery profile. No misleading direct mappings remain in these rows.

**Low, resolved: expiry requirement.** spec.md:17 now expressly requires refusing dispatch after expiry, aligned with tasks.md:10 and its negative acceptance test.

## Counterexamples assessed and appropriately bounded

- Throwing from current onDurabilityWarning fails to enforce strict mode: design.md:33 explicitly acknowledges swallowed exceptions and requires checking the actual transaction connection, including reconnect. It does not claim existing startup probes enforce the future guarantee.
- Killing the advisory-lock connection can leave a pooled transaction alive: design.md:35 explicitly identifies the independent-connection race and requires ownership-bound transactions or a transaction-checked owner generation; spec.md:11 and tasks.md:7 provide a stale-owner negative gate. A future implementation must prevent the race through commit, not merely check an owner generation once before execution. No HA/adversarial-writer guarantee is claimed.
- Nesting saveAndAdvance inside an outer transaction opens another transaction: design.md:7,29 explicitly excludes that composition and prescribes existing opaque handles for a limited prototype.
- A valid hash does not prove provenance or freshness, and AEAD does not detect replay of an older authentic backup by itself: design.md:41 requires separately trusted anti-rollback evidence, with the trust source unresolved before implementation.
- Historical encrypted snapshots can retain obsolete ratchet secrets if usable keys remain: design.md:43 rejects indefinite old-session-secret exports and explicitly includes backups/copies and surviving encryption keys in its limitations. It does not claim SQL deletion/GC supplies secure erasure.
- Schema names or global dedup do not isolate untrusted tenants: design.md:39 explicitly requires isolated trust domains until isolation is verified; proposal.md non-goals exclude shared untrusted tenants.
- A local SQL commit cannot guarantee a remote chain/payment effect occurs once: design.md:27 requires destination idempotency/reconciliation and uncertain-completion state; spec.md:17 and proposal.md explicitly avoid remote exactly-once claims.
- Encryption, recovery and receipt storage do not authorize a business instruction or establish origin/finality: design.md:15 keeps those checks with MPE; spec.md:18 preserves caller-supplied verified source/finality status instead of claiming verification by UmbraDB.
- Durable receipts, Rust node hot-path throughput and existing Lean certification are not silently inherited: integration.md:5,7,14 excludes transport/network storage, labels the tranche design-only and denies existing proofs establish the new integration; design.md:47–51 requires independent models, fault testing and measured overhead.

No other material privacy/cryptography/ownership claim error found in this design tranche. Passing the documentation audit must not be represented as certification of future implementation or of production deployment. Graphify and full release audit are owned by the parent agent.

Final targeted re-audit: PASS. Read-only reviewer made no repository changes. Parent owns Graphify regeneration and consolidated release evidence.

## Additional targeted audit: historical secret-scanner false positive

**PASS.** Reviewed final `.gitleaksignore:20–24` diff independently, without displaying credential values. The sole added suppression is fingerprint `c80329a40c0c5809940fee75c793d61088aa7250:docs/research/sqlite-migration/graph/graph.html:generic-api-key:281`. At that immutable commit, HTML line 281 parses as a hyperedge array; the generic-rule match crosses a serialized `nodes` delimiter into another declared graph node ID. Both symbolic IDs are present in that commit's graph.json, connected in graph data and sourced from l7-precedent.md. This is not credential material. No path/rule/global allowlist or custom-rule weakening is introduced; fresh findings on the same path remain scanned. `git diff --check` passed. Parent reports a verified Gitleaks 8.28 full-history scan of 223 commits PASS and a custom seed-rule negative control detected with expected exit 1; this reviewer did not rerun those scans.

Low-severity nonblocking comment precision at `.gitleaksignore:22`: the write-amplification rationale node explicitly cites B3, while the Erigon concept node has null source_location. Both source_file fields are l7-precedent.md. Suggested precise wording: both IDs source the document, with the rationale node citing B3. This does not alter the false-positive classification or suppression safety.
