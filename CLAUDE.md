# UmbraDB — project instructions

## Keep the knowledge graph current, sprint by sprint

This repo's code, docs, and openspec sprint changes are graphified (`graphify-out/graph.json`,
`GRAPH_REPORT.md`, `graph.html` — committed to this repo so anyone can query prior context
without rebuilding it). **After any sprint's spec is drafted/revised, or its implementation
lands, re-run graphify against the repo root (`/graphify --update`) and commit the refreshed
`graphify-out/` outputs in the same commit (or the sprint close-out commit) as the change that
prompted it.** Do not let the graph silently drift stale behind several sprints' worth of new
openspec changes and code — a stale graph gives wrong answers to "what does the spec say" /
"where is this called from" queries without any obvious signal that it's stale.

Concretely, add "re-run `graphify --update` and commit `graphify-out/`" as a step in every
sprint's own `tasks.md` close-out section (alongside the existing `ROADMAP.md`-update task), not
just as a one-off manual reminder — each sprint's own task list is the durable place this gets
tracked and reviewed, the same as everything else in this project's process. (`graphify --update`
here means the Claude-Code slash invocation `/graphify --update`; the equivalent direct CLI
subcommand, if invoking `graphify` outside the assistant, is `graphify update .` — the bare form
`graphify --update` is not a real CLI invocation on its own.)

`graphify-out/.graphify_python` and `graphify-out/.graphify_root` are machine-local absolute
paths (the interpreter path and scan root on whichever machine last ran the pipeline) — do not
commit them if they've drifted to a path that isn't this machine's; regenerate them locally
instead (`graphify`'s own interpreter-guard step does this automatically if they're missing).

## Graph-scoped review policy

The committed knowledge graph (`graphify-out/`) exists to cut token cost in this repo's review
pipeline, not just to answer ad-hoc questions. Every review-pipeline role falls into exactly one
of three modes — get this wrong and either tokens are wasted (a role that should be scoped keeps
exploring from scratch) or a role's whole reason for existing is defeated (a role that must stay
independent gets handed someone else's notion of "what's relevant" and anchors on it — see the
confirmation-bias finding below).

**PUSH** (receives a precomputed reading-list manifest before exploring), **PULL** (may query the
graph itself as a first-resort tool; nothing is pre-selected for it), or **NONE** (no graph
contact at all — fully independent exploration):

| Role | Mode | Why |
|---|---|---|
| Fable 5 consolidator | **PUSH** | Already reconciling known findings — anchoring isn't a risk here, it's the job. |
| Impl: spec-compliance Opus auditor | **PUSH** | Checks a diff against a fixed spec; a blast-radius-scoped manifest is exactly this kind of check's best case. |
| Impl: code-quality/test-coverage Opus auditor | **PUSH** | Same as above — shares the identical manifest bytes as spec-compliance for prompt-cache reuse. |
| Final differential-review agent | **PUSH (weak) + full diff + mandatory import backstop** | Gets the manifest *and* the complete diff hunks, but its independence cost is real: this role's whole job is catching breakage in files the diff doesn't touch, which is exactly what the graph can silently under-represent (see the extraction-miss guardrail below). Its manifest is marked advisory-weak, and the import-resolution backstop is mandatory for this role specifically, not optional. |
| Design: fidelity-to-prior-art panelist | **PULL only** | Prior-art lookup is the graph's best query class, but a *pushed* list would pre-select which prior art it compares against — let it query freely instead. |
| Design: requirements-completeness/EARS panelist | **NONE** | Its read set is the spec doc itself; a manifest adds nothing, and a completeness check must not inherit the graph-builder's notion of "relevant." (Every role gets exactly one of the three modes — this one is NONE, full stop, not NONE-with-a-PULL-option.) |
| Design: adversarial-risk panelist | **NONE** | Its entire value is deciding independently what is risk-relevant. |
| Codex GPT-5.6 Sol cold audit | **NONE — hard rule** | Independence is the whole point of running it cold. If cost matters there, optimize via prompt-caching the repo/spec bytes themselves — never by pre-selecting which files it opens. Also: always instruct it to skip `graphify` itself (known ~25-minute auto-trigger stall from a prior incident). |

**Why this split, concretely:** "Measuring and Exploiting Confirmation Bias in LLM-Assisted
Security Code Review" (arXiv 2603.18740) found that supplying a reviewer LLM with contextual
framing — even innocuous PR metadata — dropped vulnerability-detection accuracy by up to **93.5
percentage points**, because the model anchors on the supplied interpretation instead of
independently evaluating; stripping the framing recovered 94% of the lost accuracy. A
graph-computed reading list handed to a cold/adversarial auditor is a form of framing, and risks
anchoring it on the graph-builder's (or a prior agent's) blind spots — exactly the failure mode a
cold or adversarial pass exists to avoid. Anthropic's own multi-agent research writeup reaches the
same conclusion from the other direction: "separate fresh-context verifier sub-agents tend to
outperform self-critique."

**What actually provides the independence guarantee here is the mode split above (which roles get
NONE), not the "no interpretive prose" formatting rule below.** The cited study's framing effect
is triggered by a reviewer being handed a curated relevance signal at all — a file list is if
anything a *stronger* signal than the incidental PR metadata that study tested, so stripping prose
from a manifest is a mild partial mitigation for PUSH roles, not a validated de-biasing measure in
its own right. Don't read "structural facts only" as license to push a manifest to a role this
table marks PULL or NONE.

### The scoping mechanism (PUSH roles only)

Run once per review round, by whichever agent is orchestrating the round — never per-auditor,
since letting each PUSH auditor independently re-query the graph just recreates the redundant-read
problem this exists to solve:

1. **`graphify update .`** against the repo root first (the real CLI subcommand; the
   Claude-Code slash form `/graphify --update` runs the same thing internally — use whichever is
   actually available). Code-only changes cost near-zero LLM tokens (AST-only extraction;
   confirmed against graphify's own upstream docs) and this tool's own clustering step reruns on
   every update — communities do not go stale between runs the way a naive rebuild-only graph tool
   would. Abort scoping (fall back to full independent exploration) if this step fails, **and** if
   it exits 0 without actually advancing `graphify-out/graph.json`'s own `built_at_commit` field to
   the current HEAD (a no-op update, or the shrink-guard refusing to write, both exit cleanly
   without a fresh graph — see the freshness gate below, which is what actually catches this).
2. Take the changed-file set as the seed, where `<base>` is the change's actual merge-base against
   `main` — never a single prior commit, which would miss part of the real diff. **Critically, this
   must span `<base>` through the actual current working tree, not `<base>..HEAD`:** a review round
   very often runs against in-progress, not-yet-committed work (this policy's own drafting round
   is itself an example), and `git diff --name-only <base>..HEAD` silently sees only committed
   history — it omits staged changes, unstaged edits, and untracked new files entirely, with no
   error or warning. Compute the seed set as `git diff --name-only <base>` (base against the
   working tree, which does include staged/unstaged edits to tracked files) unioned with
   `git ls-files --others --exclude-standard` (untracked new files, which plain `git diff` never
   reports at all). Use the same `<base>`-to-working-tree range for the diff text handed to Step 3's
   import backstop and for the manifest's own "diff files" section — never the `<base>..HEAD` form,
   which is the wrong comparison whenever the round reviews anything not yet fully committed.
3. Compute the blast radius **directly against `graphify-out/graph.json`** (load it — after
   asserting it's the plain undirected, non-multigraph shape this mechanism assumes; abort with a
   clear message if `directed`/`multigraph` are ever `true` in a future graph build, since a
   multigraph changes what `G[u][v]` even returns — match nodes by `source_file`, expand 1-2 hops
   via its edges, and separately check `graph.json`'s own `hyperedges` array for membership overlap
   with the seed/radius node set) — not via `graphify query`/`explain`/`path`, which match by
   node-label substring and cannot do a file-seeded expansion at all (that's what
   `fidelity-to-prior-art`'s PULL access is for instead). Discovery itself is **provenance-agnostic**
   — any edge, `EXTRACTED` or `INFERRED`, can add a file to the radius, and that's fine; provenance
   is not a scope *boundary*, only an evidentiary-weight label carried alongside each entry (see the
   confidence-asymmetry guardrail for what it actually gates). Cap the radius at a fixed maximum
   node count, ranked and truncated **by hop distance alone, never by confidence score** — using a
   numeric score to decide which nodes survive a cap is exactly the same mistake as using it to
   decide which nodes get excluded outright, and the cap must not become a backdoor for that. If the
   true radius exceeds the cap, keep the closest-hop entries and record how many were dropped, at
   which hop, in the manifest — an uncapped manifest on a dense graph defeats the whole point of
   scoping, but so does a cap that quietly re-introduces confidence-based exclusion. Separately,
   resolve the diff's own *added* import/require statements to repo-relative paths and union them
   into the radius **unconditionally** — a real, disclosed-scope completeness backstop for
   extraction misses (see guardrails below), not a full solution to them (it only catches new
   outgoing imports the diff itself adds; it does not find unchanged files that consume a changed
   module, nor dynamic/side-effect imports — say so plainly in the manifest rather than implying
   completeness). Any resolved backstop path must be verified to actually live under the repo
   root before it's added — an import specifier is attacker-shapeable diff content (even inside a
   comment, a naive regex will match it), and a path-traversal specifier like `../../.env` must be
   rejected, not silently resolved and pulled into a PUSH agent's reading list.
4. Write a `review-manifest.md` into the change's own directory (e.g.
   `openspec/changes/sprint-N-<module>/review-manifest.md`) containing, in this order: (a) a
   provenance header — the graph's `built_at_commit` sha, the diff's `<base>` sha, whether the
   round is reviewing committed history or an in-progress working tree, and whether the radius was
   capped; (b) the diff's own files (per step 2's base-to-working-tree range), marked "read in full,
   authoritative"; (c) blast-radius files, each with its hop distance and the **provenance**
   (`EXTRACTED` or `INFERRED`, not just a numeric score — see the confidence-asymmetry guardrail) of
   the edge that discovered it; (d) import-backstop files (unconditional, not confidence-gated,
   root-contained), labeled with their real, disclosed scope limits from step 3; (e) prior-art
   anchor nodes from hyperedge membership. Provenance goes first deliberately, so a PUSH agent sees
   whether the manifest is even valid before reading anything it scopes, **immediately followed by**
   the advisory line (see guardrails — the advisory sentence is not itself the opening line, it
   follows provenance). **No interpretive prose in the manifest** — structural reasons ("2-hop
   caller via an EXTRACTED call edge") are the safe format; interpretation is what the
   confirmation-bias mechanism above anchors on.
5. Every PUSH agent's prompt opens with the identical manifest + design.md + spec bytes, in that
   fixed order, so the three implementation-stage PUSH roles can actually share a prompt-cache
   prefix (something caching alone cannot give across roles with different system prompts). If any
   manifest in the round is regenerated (e.g. a late commit lands mid-round), **void and
   re-dispatch every PUSH run in that round** — a round that mixes findings computed against
   different manifest versions can't be trusted, and the prompt-cache benefit is lost on
   regeneration anyway, so there's no cost argument for tolerating the skew.

### Guardrails (this repo's own policy — `graphify` upstream provides none of these)

- **Freshness gate:** check `graphify-out/graph.json`'s own `built_at_commit` field against the
  current HEAD — **not** a sha the manifest stamps on itself, which only proves when the manifest
  was written, not when the graph underneath it was built. These are two different things and both
  must equal HEAD. (Confirmed necessary, not theoretical: this exact drift already exists in this
  repo's own history — a graph committed one sprint-close-out commit behind HEAD would pass a
  manifest-self-stamp check while scoping against stale structure.) A manifest whose graph
  `built_at_commit` doesn't match current HEAD is void — regenerate it, don't use it stale.
- **Confidence asymmetry is about evidentiary weight and exclusion, not about which edges are
  allowed to add a file to the radius.** A file can be discovered via *any* edge, `EXTRACTED` or
  `INFERRED` — discovery itself is provenance-agnostic, and that's correct: an `INFERRED` edge
  should still *widen* scope. What the asymmetry rule actually gates is narrower and absolute: **no
  `INFERRED` or `AMBIGUOUS` edge, at any confidence score, may ever be used to justify excluding a
  file, and no finding may cite one as evidence without the agent actually opening the underlying
  file.** This must not be implemented as a score threshold anywhere in the mechanism — including
  in the radius-size cap, which must rank and truncate by hop distance only (see mechanism step 3).
  A cap that uses confidence score to decide which entries survive truncation silently reintroduces
  score-based exclusion through the back door, which is exactly the failure this rule exists to
  prevent — if you find a truncation/ranking step sorting on `confidence_score`, that's a bug, not
  a reasonable tie-break. `AMBIGUOUS` may not appear at all in a given graph snapshot (this
  extractor emits only `EXTRACTED`/`INFERRED` today) — treat the rule as forward-looking for that
  tag, not evidence it's currently exercised.
- **Extraction-miss is a distinct, unmitigated-by-disclaimer failure class:** the asymmetry rule
  above only governs edges that *exist* with some confidence tag. It says nothing about a real
  dependency the graph's AST/LLM extraction simply never encoded as an edge at all — which means
  the affected file is silently **absent** from the manifest, not present-but-flagged. Given how
  sparse semantic extraction actually is in practice, this is a real gap, not a corner case, and
  the "Advisory scope" line below is not sufficient cover for it on its own — under real token/time
  pressure, "not in the manifest" reads as "not relevant" exactly when a miss matters most. The
  import-resolution backstop (mechanism step 3) is a partial, disclosed-scope mitigation, not a
  complete one: it only catches a real dependency the diff's own *added* lines newly import — it
  does **not** find an unchanged file that consumes a *changed* module (the more common real
  regression shape), nor dynamic/side-effect imports. Don't let the backstop's presence read as
  "extraction misses are handled" — they're only partially handled, and every PUSH role still needs
  the diff-supremacy and advisory-scope guardrails below as real, independent backstops of their
  own, not decoration.
- **Diff supremacy:** every PUSH agent still reads the full current diff hunks directly (per
  mechanism step 2, computed against the actual working tree, not just committed history). The
  manifest scopes *surrounding* context; it is never a substitute for reading the diff, and
  findings must cite file contents, not graph nodes.
- **Advisory labeling:** every manifest's provenance header (mechanism step 4a) is immediately
  followed by the line "Advisory scope, not evidence. You may read beyond this list." — not the
  opening line of the manifest itself (provenance goes first, deliberately, so an agent can tell
  the manifest is even valid before anything else). Treat the advisory line as a courtesy that a
  PUSH agent should feel free to act on, not as the actual completeness guarantee — that guarantee,
  such as it is, is the import backstop above (itself only partial, per the extraction-miss
  guardrail), not this sentence.
- **Do not adopt** `graphify install --strict`'s upstream read-blocking mode repo-wide — it would
  silently violate every NONE-mode role's independence above.

### When not to bother

Skip the manifest step entirely (PULL access is still fine) when a change touches ≤ 2 files *and*
under ~150 changed lines, with no exported/public symbol signature changed, and it's a docs-only
or test-only diff. Measure all four against `<base>` through the actual current working tree (same
range as mechanism step 2), not `<base>..HEAD` — a not-yet-committed change would otherwise measure
as zero-diff-size and always skip regardless of its real size, **and** count any untracked new
files (`git ls-files --others --exclude-standard`) into the file total, treating their presence at
all as disqualifying the line-count condition — plain `git diff` never reports untracked files, so
their real size isn't visible to `--shortstat` and can't be assumed small. The first two conditions
are checkable directly (`git diff --name-only <base> | wc -l` plus the untracked count above,
`git diff --shortstat <base>`); the "no exported/public symbol changed" condition is **not**
derivable from those same commands and needs its own check — e.g. `git diff <base> -- '*.ts' |
grep -E '^[+-][^+-].*\bexport\b'` (the `[^+-]` after the leading marker excludes diff hunk headers
like `+++`/`---` from matching; or equivalent for this repo's actual export idioms) returning
nothing. Don't claim this condition is satisfied without actually running that check; a
diff-stats-only read cannot see it. All four conditions must hold (measured against the branch's
actual divergence point from `main`, not a single latest commit, so splitting a large change into
several small commits doesn't dodge this rule). Building a manifest for a change this small can
cost more than just reading it directly (a caveat the closest analog tool's own authors concede
about themselves). The 150-line threshold is a starting estimate, not a measured constant —
recalibrate it once real per-sprint token measurements exist (see the baseline below). Skipping
the manifest never means skipping the sprint close-out's own
graph update — that still runs regardless of diff size.

See the `scoped-review-manifest` skill for the concrete implementation of the mechanism above.

### Baseline (for measuring whether this actually helps)

Sprint 4 (Watermarks) ran its three post-implementation Opus auditor passes with full,
unscoped independent exploration — no manifest existed yet. Their actual recorded subagent
token totals (input+output combined, as reported by the Agent tool's own usage field):
spec-compliance auditor ~94.6k, code-quality auditor ~108.7k, final differential-review
auditor ~79.1k (~282k total across the three). Treat this as a rough same-repo reference
point, not a clean controlled baseline — the "after" measurement will necessarily come from
a *different* sprint's diff, of different size and shape, possibly under different
reasoning-effort settings, so a lower total doesn't isolate scoping's own contribution the
way an A/B test on the identical diff would. Still record the next sprint's equivalent
totals in that sprint's own close-out notes, normalized per changed-line if the diff sizes
differ meaningfully, rather than comparing raw totals at face value — and compare against
*this* number, not the research round's borrowed 5.5x/82x figures, which measure other tools
on other codebases entirely. If the new total isn't meaningfully lower once that confound is
accounted for, that's a real signal to revisit this policy, not a reason to quietly stop
measuring.
