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
tracked and reviewed, the same as everything else in this project's process.

`graphify-out/.graphify_python` and `graphify-out/.graphify_root` are machine-local absolute
paths (the interpreter path and scan root on whichever machine last ran the pipeline) — do not
commit them if they've drifted to a path that isn't this machine's; regenerate them locally
instead (`graphify`'s own interpreter-guard step does this automatically if they're missing).
