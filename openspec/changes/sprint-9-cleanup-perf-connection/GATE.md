# Correctness-Audit Gate Record — Sprint 9 (`sprint-9-cleanup-perf-connection`)

**Verdict: CONFIRM** (Opus correctness-audit gate, autonomous run 2026-07-21).

This CONFIRM satisfies the rolling-merge rule's "N+1 planned + gate-confirmed"
precondition. Per branch discipline, **Sprint 8 may merge to `main` once its own
audit gate + a successful live DB-sync pass** — this plan's confirmation is what
unblocks that merge, not this plan's implementation (which is a later run).

## What was verified

- All cited artifacts spot-checked against real files (merge-read guards at
  `transaction-history-storage.ts:498-507` / `:455`, `client.ts` F2 revert
  `:58-63`, status union `interfaces/transaction-history-storage.ts:166-178`,
  `package.json` declares only `postgres`/`zod` + test tooling, the untracked
  `design/research/` leak, `Performance/DESIGN.md` §1–§5, `ROADMAP.md` M4/1.0.0).
- `npx openspec validate sprint-9-cleanup-perf-connection --strict` → exit 0;
  `--all --strict` → 8 passed / 0 failed.
- The three themes cohere; each is a genuine deferred item with a named file and
  prior finding, not a grab-bag.

## The four open questions — resolutions to ADOPT during implementation

1. **Retry/idempotency allow-list (§6.1).**
   ALLOW = reads, watermarks `set`, tx-history merge — **strictly outside a caller
   `opts.tx`**. DENY = any op with `opts.tx` defined, lease acquire, checkpoint
   `prune`/GC, and permanent classes (auth/schema/constraint). **Hard condition:**
   the retry unit MUST be the whole storage operation (for tx-history, re-driving
   `writeOwnTransaction` so the xact-scoped advisory lock is re-taken and state
   re-read) — **never a mid-transaction single-statement replay on a fresh
   connection.** State this explicitly in impl + pin it with the negative test.
2. **Finality vs unshielded per-address cursor (§6.2).**
   Primary defense for the proven unshielded per-address-cursor path =
   **multi-endpoint cross-check of the per-address transaction set** (endpoint B
   reports the same tx-id set for the address as A). The **finality-tip check
   applies to the C1 checkpoint-root anchor path**, not the per-address cursor. Do
   NOT gate the unshielded path on a block-height finality check.
3. **Benchmark threshold/noise floor (§6.3).**
   Relative-with-explicit-noise-floor, median of N warm iterations (discard
   warm-up). The **non-vacuity self-test is the real gate** (an injected synthetic
   regression MUST fail the gate); the absolute regression check stays
   generous/advisory (or pinned-host) until baselines are shown stable on
   Docker/Testcontainers/WSL2. Do not let `npm run bench` become a flaky
   merge-blocker.
4. **GC junction-table migration (§6.4).**
   DEFER to its own audited change — it touches Sprint 3's audited schema and must
   not ride in under "perf work." Sprint 9's harness only produces the evidence.

## Non-blocking findings (LOW/MED) to clean up during implementation

1. LOW — empty-set-guard requirement cites run log `:288`; the empty-set finding is
   line `:287` (`:288-289` is the concurrent-lock finding). Off-by-one; the design's
   range `287-289` is correct.
2. LOW — proposal/design call Sprint 8 "implemented and audited"; the run-log snapshot
   shows no completed Sprint 8 audit panel yet. The "L-findings" are spec-acknowledged
   coverage gaps + a verified dep-hygiene gap, not the output of a finished audit.
   Reword to cite the actual Sprint 8 audit record once it exists.
3. LOW — Sprint 7's advisory-lock-key delimiter-ambiguity + 32-bit-collision LOW
   (run log `285-286`, perf-only over-serialization) is measured by the harness but
   not explicitly folded into hygiene scope. Safe to leave; note it.
4. LOW — task 3.3 health-policy knobs (`statement_timeout` /
   `idle_in_transaction_session_timeout`) have no dedicated EARS requirement, only
   implicitly under the F2 omit-discipline requirement. Add a requirement or fold it.
5. MED — the verify gate lists "`npm run bench` passes against baseline" as a hard
   gate item; on Docker/Testcontainers/WSL2 that is noise-prone. Make the non-vacuity
   self-test the load-bearing gate and keep the absolute check advisory/pinned until
   baselines are stable (see resolution 3).
6. INFO — doc pin-manifest over a `package.json` devDep pin is well-justified (keeps
   `src` SDK-free); `effect` could optionally be a real devDep for reproducibility
   while the on-disk SDK build stays in the manifest.

Scope is on the heavy side for one "overflow" sprint; the two pieces that could
balloon are the benchmark harness and the wallet-sync failover tier. Not
over-scoped to blocking. The perf work does not jump the ROADMAP research gate —
`Performance/DESIGN.md` satisfies it.
