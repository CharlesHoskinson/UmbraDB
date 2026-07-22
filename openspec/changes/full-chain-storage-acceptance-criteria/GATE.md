# Correctness-Audit Gate Record — Full-Chain Storage Acceptance Criteria (`full-chain-storage-acceptance-criteria`)

**Verdict: NOT YET RUN.**

This file is a template. No audit has been performed against this change yet — do not treat any
verdict below as real until an actual three-persona review (`AGENTS.md`: domain-correctness,
adversarial, release/coverage) plus a Codex gpt-5.6-sol cold audit has been run and its findings
recorded here.

## What this gate covers

This is the gate for **this change's own specification** (`tasks.md` §0) — whether the ten
acceptance criteria in `specs/full-chain-archive-verification/spec.md` are falsifiable, complete
against the ten review areas in the task brief, and correctly schema-agnostic (do not silently
assume a v1-specific table/column shape). It is a separate, later event from the eventual
implementation's own verify gate (`tasks.md` §11), which audits whether the real ingestion/sync
code actually satisfies these criteria.

## Fields to fill in when the audit runs

- **Auditor(s) and date:**
- **Artifacts spot-checked:** (cite file:line for each AC's grounding — this template's own
  `design.md` §1 table is the starting point)
- **`npx openspec validate full-chain-storage-acceptance-criteria --strict` result:**
- **`npx openspec validate --all --strict` result:**
- **Per-AC falsifiability check** (does each AC-N have a concrete WHEN/THEN scenario with an
  unambiguous pass/fail condition? does AC-4 in particular leave no wiggle room for a category
  that fails its replay test to stay deferred anyway?):
  - AC-1:
  - AC-2:
  - AC-3:
  - AC-4:
  - AC-5:
  - AC-6:
  - AC-7:
  - AC-8:
  - AC-9:
  - AC-10:
- **Open findings (LOW/MED/BLOCK):**
- **Final verdict (CONFIRM / BLOCK):**

## Non-blocking notes for whoever runs this audit

- This spec was authored without access to the v2 schema revision's own findings document (it did
  not exist yet at authoring time — `fix/full-chain-storage-schema-v2` was at the same commit as
  this branch's base, `cb80f96`, with no new commits). If v2's own audit surfaces a property this
  spec did not anticipate, that is a legitimate finding against this change, not a v2-only concern.
- AC-8 (live cross-validation) cannot itself be executed until the from-source node/indexer/
  proof-server stack is operational against a public testnet. Do not block this change's own gate
  on running AC-8 — block the *eventual implementation's* merge on it, per `tasks.md` §8's note.
