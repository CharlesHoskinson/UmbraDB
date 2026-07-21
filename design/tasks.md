# Tasks — superseded by per-sprint openspec changes

**This document's original 11-phase task breakdown is retired as of 2026-07-20 and must not be
used as an implementation guide.** It was written before UmbraDB was split out into its own
standalone repository, while this project was still a module planned inside `midnight-dev-env`
— it references that environment's own paths and tooling directly (`midnight-pg-store` as a
package name inside a larger monorepo, `counter-cli-additions/*.ts` call sites, `flake.nix`,
`systemd/`, `midnight-stack.target`), none of which exist in this repository. It also predates
the Codex-audit rework of the temporal-KV design (§1.1 below still describes the abandoned
`now()`-based same-transaction detection this project's `Formal/STORAGE_ALGEBRA.md` and
`design/design.md` have since replaced) and the `ckpt_manifest_chunks` junction-table fix. Using
it as a live checklist would build the wrong thing.

**Current process:** each module gets its own `openspec/changes/sprint-N-<module>/` change
(`proposal.md`/`design.md`/`tasks.md`/`specs/<capability>/spec.md`, EARS-format requirements),
drafted, reviewed (Opus panel + Fable 5 consolidation, then a Codex GPT-5.6 Sol audit), and only
then implemented — see `openspec/changes/sprint-1-setup-and-temporal-kv/` for the completed,
implemented example, and `ROADMAP.md`'s Milestone 2 for the module ordering. This file is kept
only so old citations (`ROADMAP.md`, prior session notes) resolve to an explanation rather than a
404, and as a historical map from the original phase numbers to what supersedes them — not as a
source of task detail.

## Phase → current status map

| Original phase | Original scope | Status |
|---|---|---|
| §0 Environment setup | Provision Postgres, add `postgres.js`, pick test infra, create schema | Superseded by `sprint-1-setup-and-temporal-kv` §0 (schema is now runtime-configurable, default `umbradb`, not hardcoded `tier1_wallet` — that name was specific to the `midnight-dev-env`-embedded era) — **done**, implemented and tested. |
| §1 TemporalKV | `kv_current`/`kv_history` DDL, trigger, `put`/`get`/`getAt`/`listKeys`, Mongo-test port | Superseded by `sprint-1-setup-and-temporal-kv` §1-2 (this phase's own DDL description — the `now()`-based zero-width-interval skip — was the exact bug the Codex audits found; the shipped design uses `txid_current()`/`TransactionKeyReuseError` instead) — **done**, implemented and tested against real Postgres, 26/26 tests passing. |
| §2 Checkpoint chunker | `ckpt_chunks` DDL, dedup write path | Not yet drafted as its own sprint. When drafted, must incorporate the `ckpt_manifest_chunks` junction-table fix (`design/design.md` §3) — this phase's own DDL sketch (§3.1 below, if read) does not have it, since it predates that fix too. |
| §3 Checkpoint manifests, GC, prune | `ckpt_manifests` DDL, two-step GC, prune | Not yet drafted as its own sprint (likely the same sprint as §2 above — CheckpointStore is one module per `src/interfaces/checkpoint-store.ts`). |
| §4 Watermarks | `watermarks` DDL, `set`/`get` | Not yet drafted as its own sprint (smallest remaining module — `src/interfaces/watermarks.ts`). |
| §5 Commit/transaction layer and writer lease | `sql.begin()` transactions, `sql.reserve()`-pinned advisory-lock writer lease | Superseded by `sprint-2-transaction-lease` — **done**, implemented and tested against real Postgres, 78/78 tests passing (`PgTransactionLeaseLayer`, the cross-module transaction-handle registry, `PgTemporalKV`'s `opts.tx` wiring). |
| §6 Encrypted private-state provider | `PgPrivateStateProvider.ts` against `private_states`/`signing_keys` | **Scope question, not yet resolved**: `PrivateStateProvider` is a *consumer-side* interface (implemented by whatever application embeds UmbraDB, per `design/design.md` §9's correction that production actually uses `CheckpointWalletStateStore` built on `CheckpointStore`+`Watermarks`) — it is not one of UmbraDB's own four modules (`README.md`'s architecture section: TemporalKV, CheckpointStore, Watermarks, Transaction/Lease). Whether a reference `PgPrivateStateProvider` ships inside this repo (as an example/adapter) or is left entirely to consuming applications to build on top of `CheckpointStore`/`Watermarks` needs an explicit decision before this phase is drafted as a sprint — do not assume either answer from this stale file. |
| §7 Wallet state store | `PgWalletStateStore.ts` against a `wallet_state` table | Same scope question as §6, compounded by `design/design.md` §6's own note that the `wallet_state` table path may be dead code entirely (production uses `CheckpointWalletStateStore` on top of `CheckpointStore`/`Watermarks`, not this table) — confirm whether anything needs this before drafting a sprint for it. |
| §8 Differential state-equivalence gate | Mongo-vs-Postgres differential tests, GC differential tests | This phase's specific "diff against the still-installed Mongo store" framing is `midnight-dev-env`-side cutover work, not something inside UmbraDB's own repo — see `ROADMAP.md` Milestone 3's own differential-equivalence-gate item, which reframes this as a gate on UmbraDB's replay-equivalence properties (P1-P10) rather than a live Mongo comparison. |
| §9 Cutover: rewire and live round-trip | Rewire `counter-cli-additions/*.ts`, live preprod round-trip | `midnight-dev-env`-side integration work (that repo's own paths) — tracked at the milestone level in `ROADMAP.md`'s Milestone 5, not owned by this repo's own task list. |
| §10 Remove Mongo | Delete `midnight-mongo-store/`, remove `mongodb` deps/Nix/systemd units | Entirely `midnight-dev-env`-side (its own repo's files) — not applicable to UmbraDB's own repo at all; tracked (if at all) in that repo's own technical-debt backlog, not here. |

## For historical reference only

The original, unedited 11-phase task text (predating the points above) is preserved in this
repo's git history at this file's path — `git log -p -- design/tasks.md` from before the
2026-07-20 supersession commit. Do not resurrect it in place; draft a new sprint change instead.
