# Lint Report — `ISSUE-FINAL.md`

Run with: `./issue-linter.sh ISSUE-FINAL.md`
Result: **PASS** — 0 errors, 1 warning. Exit code 0.

**State note:** `ISSUE-FINAL.md` was mid-rewrite by another agent during this
session — it changed between the start of this task and this run (the
`**Type:**` line moved, the prior-art section grew explicit source URLs, an
`indexer-api` line reference was corrected, and a `getFinalizedHead` grep
result was added to the Details section). The run below is against whatever
was on disk at report time; re-run the linter if the file changes again.

## Raw output

```
issue-linter.sh — linting: ISSUE-FINAL.md
----------------------------------------------------------------------

== Structure ==
  [OK]    title present (line 1): Sync completion is measured against the indexer's self-reported tip, with no independent finality check
  [OK]    version/context reference found
          4:**Version:** `midnight-wallet` @ `e744d994`, indexer API v4
  [OK]    concrete location/citation found (file:line and/or URL)
          9:On scope: the spec already places the indexer inside the trusted set. `docs/spec/Specification.md:740-745` (this repo) says node-fed sync is the best option for security and privacy, and that using an indexer comes "at the cost of having to trust said service." The trust discussed there is about privacy, though. The completeness and liveness of the tip a wallet uses to decide it is "fully synced" is a different axis, one that can be trust-minimized on its own, and today nothing reconciles it against anything but the indexer itself.
          15:- Shielded and dust: `packages/abstractions/src/SyncProgress.ts:31-33`, `isConnected && |highestRelevantWalletIndex - appliedIndex| <= maxGap` (strict `== 0` for "strictly complete", lines 65-66).
          16:- Unshielded: `packages/unshielded-wallet/src/v1/SyncProgress.ts:29-31`, the same shape over `highestTransactionId - appliedId`.
          ... and 3 more
  [OK]    impact statement present
          22:### Impact
  [OK]    suggested fix / direction present
          32:### Suggested hardening

== Self-referential leakage ==
  [OK]    no internal project/process references found
  [OK]    no extended-list internal references found

== AI-slop tells ==
  [OK]    no rhetorical counting/enumeration found
  [OK]    no hedging filler / AI-tell vocabulary found
  [OK]    em-dash count: 0 (within threshold of 6)
  [OK]    bold-header bullet count: 0 (below listicle threshold of 3)

== Over-claim (hardening issues should not need these) ==
  [WARN]  severity-inflating language found — verify each hit is not an unsupported claim (negated mentions like 'not a vulnerability' are expected and fine)
          5:**Type:** hardening / defense in depth; not a vulnerability report, which is why this is a public issue rather than a private disclosure
----------------------------------------------------------------------
SUMMARY: 0 error(s), 1 warning(s)
RESULT: PASS (review warnings above before filing)
```

## Analysis

**The single warning is expected, not a defect.** Line 5 is the framing
sentence: *"not a vulnerability report, which is why this is a public issue
rather than a private disclosure."* The linter's over-claim check is a bare
grep for `vulnerability`/`exploit`/`critical`/`fund loss`/`CVE`/`RCE` — it
cannot parse the negation ("not a ... report"). This is exactly the
self-aware framing §"State the framing explicitly" in `ISSUE-CHECKLIST.md`
asks for, and it is the only place in the file the word "vulnerability"
appears. No action needed, though if a lint-clean run is wanted, the
sentence could be rephrased to avoid the trigger word entirely (e.g. "this
is a hardening note, filed publicly rather than through private
disclosure" — drop "vulnerability" altogether since the checklist already
requires distinguishing the axis, not the absence of a specific word).

**Everything structural passes cleanly.** Title, version/commit pin,
concrete `file:line` citations spanning two repositories (this repo and
`midnight-indexer`), an `Impact` section, and a `Suggested hardening`
section with both a staged fix (3 numbered steps) and a lighter interim
mitigation are all present — matching checklist §§1, 3, 4, 6, 8.

**No self-referential leakage.** No hits on `UmbraDB`, "our council", "our
design", "sprint", "we investigated", "our project", or the extended list
(our team/repo/codebase, internal doc/spec/wiki). The draft reads as
written for the target repo's own contributors, not for an internal
audience.

**No AI-slop tells fired.** Zero em dashes, zero hedging-vocabulary hits
("delve," "leverage," "robust," "it's worth noting," etc.), zero rhetorical
counting ("there are three reasons"), and the bold-header-bullet count is
0 — the numbered "Suggested hardening" list is plain numbered prose, not a
bolded listicle. This is a case where the *draft* version
(`ISSUE-DRAFT.md`) still had 15 em dashes and would have tripped the
em-dash-overuse warning; the current `ISSUE-FINAL.md` has already had that
pass applied.

**Not caught by the linter (needs a human read):** whether the prior-art
citations are accurate and current (Zcash threat-model doc, Polkadot
light-client docs, smoldot repo — all three now appear as real URLs, an
improvement over the earlier draft's unlinked paraphrase), whether "Happy
to work up a PR" is a commitment the filer actually intends to honor, and
whether the tone reads as a peer's observation rather than a demand — on a
read-through, it does.

## Bottom line

`ISSUE-FINAL.md` is lint-clean for filing as-is. The one warning is a
known, accepted false positive from a negation the linter doesn't parse;
optionally reword line 5 to drop the literal word "vulnerability" if a
zero-warning run is wanted before filing.
