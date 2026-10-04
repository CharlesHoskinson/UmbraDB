# Future implementation tasks

Every item remains unchecked. Acceptance commands/test IDs are proposed gates, not tests shipped by this change.

- [ ] Finalize profile and public recovery contracts. Acceptance: approved types/error catalog, domain/source/cursor encodings, anti-rollback trust source, cipher/key policy and required test-ID manifest; design/domain/adversarial audit PASS.
- [ ] Implement strict durability. Acceptance: startup and actual-transaction checks reject unsafe commit policy, including after reconnection; warning callback throwing is a failing negative control, never enforcement.
- [ ] Implement ownership-bound transaction composition. Acceptance: lease-connection death and stale-generation fault schedules cannot commit, while bounded waits preserve ordinary single-writer progress. No HA claim.
- [ ] Implement local effects/dedup/checkpoint/cursor/outbox atomic capability. Acceptance: duplicate and conflicting-action tests, mid-batch failure and unclean Postgres recovery preserve complete state-vector atomicity; public types compile without deep imports or nested transactions.
- [ ] Add protected recovery state and retention policy. Acceptance: wrong-domain/key/corrupt/rolled-back bundles rejected; live-manifest GC safety and history gaps tested; obsolete-key retention and backup policies declared and enforced for the chosen profile.
- [ ] Add outbox reconciliation interface. Acceptance: lost-response test resolves recorded uncertain completion and never asserts once-only remote effect without destination cooperation; expired intent never dispatched.
- [ ] Validate RFQ, invoice and bounded agent fixtures. Acceptance: independent consumer integration runs demonstrate local replay/crash recovery and finality labels without implying real settlement/contract authorization.
- [ ] Record workload baseline. Acceptance: measured recovery latency, checkpoint/GC and processing throughput with reproducible workload/profile/versions; numeric targets agreed before a service commitment.
- [ ] Complete release readiness. Acceptance: all UDB-MPE requirements trace to passing non-skipped CI tests, packaging/contracts/migration/backup evidence, independent three-persona audit and refreshed Graphify. Existing 1.0 scope and package version change only through the normal release process.
