# GC architecture and query-tracing: research findings

Recovered from a workflow run whose final synthesis step returned broken
placeholder output — the underlying 100-agent research/verification pass
completed normally and produced real, cited findings; only the last
summarization step failed. Recovered directly from the run's journal by an
independent pass, refuted claims excluded and logged, not silently dropped.

## Decision: GC architecture

**Use a normalized junction table** (`ckpt_manifest_chunks(manifest_id,
chunk_hash)` with a plain `btree` on `chunk_hash`), **not** an
array-of-hashes column with a GIN index. GIN's `array_ops` operator class
accelerates exactly four operators — `&&`, `@>`, `<@`, `=` — never a scalar
`hash = ANY(chunk_hashes)` membership test, which is the shape the GC's
reachability check actually needs (confirmed directly against Postgres's
own operator-class documentation, independently verified ~10 times). A
2.3M-row blog benchmark found array+GIN beats a junction table by 10-40x
for *single-row-scoped* containment lookups, but performs identically for
*cross-row* queries — and the GC's "is this hash referenced by ANY row" is
structurally a cross-row query, meaning GIN gives it no benefit at all.

**Keep the existing scan-based mark-and-sweep design; do not switch to a
live `ref_count` column.** Incremental reference counting has a
well-documented concurrency race (a reader can hold a reference while
another writer zeroes out all others and reclaims the object) that a
batched reachability scan avoids structurally, by only reclaiming after a
full, discrete reachability determination. Git's own garbage collector —
the closest real precedent, confirmed extensively against git-scm.com's
own docs — uses exactly this mark-and-sweep-from-refs approach, not
reference counting.

**Keep the grace window; it already matches Git's own race-avoidance
mechanism.** Git's default grace period before physically deleting
unreachable objects is 2 weeks (`gc.pruneExpire`), not immediate deletion —
existing specifically to protect objects an in-flight process is using but
hasn't referenced yet. Git's actual mechanism is timestamp-based (an object
newer than the cutoff is retained regardless of computed reachability),
which is exactly what `ckpt_chunks`'s `created_at < now() - interval`
grace window already does.

**For batching, follow the `pg-boss` precedent, with a documented
counter-precedent to weigh.** `pg-boss`'s real cleanup sweep (confirmed
directly against its source) chunks work into groups of ≤100, wraps each
chunk in a transaction with a `lock_timeout`, and optionally holds a
transaction-scoped advisory lock to prevent overlapping runs. But
`graphile-worker`'s GC tasks run as a single, unbatched, whole-table
anti-join `DELETE` with no chunking or lock at all — a legitimate,
production-viable alternative when the referenced table stays small.
Batching is a scaling response to a large/contended table, not a universal
requirement — decide based on measured `ckpt_manifests` size, not by
default.

**Open, unresolved by this research:** no published benchmark numbers exist
anywhere for a `NOT EXISTS`/anti-join reachability-scan query at true
multi-GB/many-millions-of-rows scale, for this or any comparable
content-addressed store. This is a real gap the benchmark harness
(`design/design.md` §8, once built) must close empirically — there is no
shortcut to it in the literature.

## Decision: query tracing

**`postgres.js`'s native `debug` hook is necessary but not sufficient —
layer `diagnostics_channel`/`tracingChannel` on top, not instead of it.**
Confirmed directly against `postgres.js` source (not just docs): `debug`
fires exactly once, synchronously, at query-*build* time, before the query
is sent to Postgres — `(connection_id, query_string, parameters, types)`.
It structurally cannot report duration; a source-level search of the
codebase for any duration/timing keyword returned zero matches. `onnotice`
and `onparameter` are unrelated, non-per-query hooks (server NOTICE
messages; session parameter changes).

Node's `diagnostics_channel` core API is Stable since v19.2.0/v18.13.0, but
the higher-level `tracingChannel()` needed for start/end/duration
correlation remains Experimental — and has sat at that stability level for
several years without promotion. This is a real, live, unresolved gap in
the ecosystem, not just our own project's problem: an open `postgres.js`
GitHub issue (#1171) explicitly requests native `TracingChannel` support,
citing exactly this limitation; a maintainer's 2023 `query-stats` branch
that would have added `result.duration` remains unmerged as of this
research (confirmed via a direct source search — no `onquery` hook exists
in the current codebase).

**Recommendation:** wrap `debug`'s per-query payload (SQL text + params) in
a `diagnostics_channel`/`tracingChannel` span for timing/correlation. This
gets the best of both — `debug`'s zero-effort SQL-text capture plus
`tracingChannel`'s actual duration measurement — while also keeping the
instrumentation surface portable if this project ever falls back to the
`pg` driver (noted as a fallback option in `design/design.md` §7).
`tracingChannel`'s Experimental status is a real, acknowledged risk (API
could change across Node versions) — not a reason to avoid it, since no
better native alternative exists, but a reason to isolate this
instrumentation behind a small wrapper module rather than scattering direct
`tracingChannel` calls throughout the codebase, so an API change has one
place to land.

## What was checked and found NOT to hold up (excluded from the above)

A few claims surfaced during this research were checked and refuted —
noted here so they don't quietly resurface in a later draft as if
confirmed: a specific "verbatim quote" attributed to Postgres's GIN docs
(fabricated — no such sentence exists on that page; the underlying
GIN-doesn't-help-`ANY()` conclusion still holds, just not via that
citation); generalizing Postgres's array-vs-junction-table doc "tip" into
a decisive verdict for this specific design (the tip is deliberately
hedged, doesn't mention GIN or `ANY()` at all); generalizing Git's
mark-and-sweep choice into "the universally correct approach for any
content-addressed store" (Git's docs describe only Git's own mechanism,
never compare against refcounting alternatives); "Git's grace period is a
few months" (the authoritative default is 2 weeks); and a mischaracterization
of `graphile-worker`'s cleanup subquery as "correlated" (it's actually
uncorrelated — a materially different, cheaper query shape, though the
underlying "unbatched, no lock" behavioral claim still stands).
