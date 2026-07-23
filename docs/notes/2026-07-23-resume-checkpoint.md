# UmbraDB v1.0.0 — Resume-From-Home Checkpoint (2026-07-23)

*The single document to read to pick the v1.0.0 release program back up cold. It captures the exact
`main` state, the safely-paused Preprod sync and how to resume it, the reproducible-environment
pointer, the roadmap status, the established per-gate implementation workflow, and the worktree
cleanup list. Everything here was true at write time; verify `git log` and process state on resume.*

---

## 1. Current `main` state

`main` HEAD at write time: **`de48bfc`** (Merge software supply-chain inventory + SLSA assessment).

Lineage of the v1.0.0 work now on `main` (newest first):

| SHA | What it is |
|---|---|
| `de48bfc` | Merge: software supply-chain inventory + SLSA assessment (`bc70f08`) — G18-adjacent, docs |
| `a36c313` | doc-nit: save-accepts-tx comment + version-duplication wording (G5 audit nits) |
| `a3a3c99` | Merge: nix flake reproducibility hardening (`794a5fa` pins nixpkgs to an exact rev + documents the reproducibility contract) |
| `0fdb253` | chore(graph): refresh knowledge graph after G5 merge |
| `e5fcdaa` | **Merge G5: co-transactional `save()`** — the durable-checkpoint-cursor keystone |

Also committed on `main` (v1.0.0 program scaffolding):

- **The 5 v1.0.0 OpenSpec changes** under `openspec/changes/v1.0.0-*` (committed at `88976ab`):
  `v1.0.0-api-surface`, `v1.0.0-durable-checkpoint-cursor`, `v1.0.0-recovery-testing`,
  `v1.0.0-perf-baseline`, `v1.0.0-infosec-signoff`.
- `docs/v1-implementation-guideline.md` — the governing per-gate workflow (see §5 below).
- `docs/v1-lessons-learned.md` — the blameless living log; G5 close-out landed today
  (LL-001…LL-004; G5 marked ☑ CLOSED in the per-gate ledger).
- `docs/roadmapv1.html` — the v1.0.0 roadmap page.

> Note on this handoff branch: `docs/handoff` was cut from `a36c313` (just before the supply-chain
> merge). It is docs-only and does not need rebasing; `main` itself already carries `de48bfc`.

---

## 2. Preprod sync — PAUSED (safely), no progress lost

The Cardano **Preprod** sync that feeds the live-evidence gates is **paused**, not broken. Parked at:

- **block 2,695,828 · epoch 167 · slot 70,829,213 · syncProgress 55.40%**

Preserved on disk (resume loses nothing):

- The **8.4 GB chain DB** at `/root/cardano-data/db`.
- The **`cexplorer` Postgres** database (db-sync target), max block **2,695,828**.
- System **Postgres 18** stays up; the sync **watchdog is stopped**.

### 2a. Resume on THIS machine

The two services run as **transient `systemd-run --collect` units** — a plain `systemctl start` will
**NOT** work (the units are not installed unit files). Re-run these exactly:

**cardano-node:**

```bash
systemd-run --unit=cardano-preprod --collect bash -c "exec /root/UmbraDB/nix/midnight-env/result/bin/cardano-node run --topology /root/UmbraDB/nix/midnight-env/config/preprod/topology.json --database-path /root/cardano-data/db --socket-path /root/cardano-data/db/node.socket --host-addr 0.0.0.0 --port 3001 --config /root/UmbraDB/nix/midnight-env/config/preprod/config.json > /root/midnight-env-logs/cardano-node-preprod.log 2>&1"
```

**db-sync** (start after the node socket exists):

```bash
systemd-run --unit=dbsync-preprod --collect --setenv=PGPASSFILE=/root/.pgpass bash -c "exec /root/UmbraDB/nix/midnight-env/result-1/bin/cardano-db-sync --config /root/UmbraDB/nix/midnight-env/config/db-sync-config.json --socket-path /root/cardano-data/db/node.socket --state-dir /root/cardano-data/db-sync-state --schema-dir /root/UmbraDB/nix/midnight-env/result-1/share/cardano-db-sync/schema > /root/midnight-env-logs/cardano-db-sync-preprod.log 2>&1"
```

Then re-arm a stall-watchdog on the lane (progress = ΔappliedIndex / Δmax-block, not bytes).

### 2b. Resume on a FRESH machine

Chain state is machine-local, so a fresh box first has to rebuild the Nix-provided binaries and satisfy
the host assumptions, then either re-sync from genesis or restore a snapshot:

1. Recreate `result*/bin`:
   ```bash
   cd /root/UmbraDB/nix/midnight-env && nix build .#cardano-node-bin .#cardano-db-sync-bin .#midnight-node-bin
   ```
2. Satisfy the host assumptions documented in `nix/midnight-env/README.md`: Docker, system
   **Postgres 18**, `~/.pgpass`, `~/.midnight-pg-password`, and the data directories.
3. Bring up the chain state — **either** re-sync from genesis (chain state does not transfer between
   machines) **or** `restore-state` from a snapshot if one is available.

---

## 3. Reproducible environment

The full environment contract (what the flake provides, host prerequisites, Postgres/Docker/pgpass
assumptions, the `result*/bin` layout, and the getting-started steps) lives in:

- **`nix/midnight-env/README.md`**

The nixpkgs rev is pinned to an exact revision with a documented reproducibility contract (`794a5fa`,
merged in `a3a3c99`).

---

## 4. Roadmap status — G5 done, 19 to go

20 gate items total. **G5 DONE (1/20). 19 remaining.** Roadmap page: `docs/roadmapv1.html`.

**Critical-path order from here:**

1. **G6** — durability startup probe
2. **G7** — server-side timeouts (statement / lock / idle / migration)
3. **G8** — contract-integrity fixes (id validation, JSON depth bound, `withLease`)

   *(G6–G8 are the remainder of the `durable-checkpoint-cursor` change — G5 was its keystone.)*
4. **Perf** — G13 (perf-correctness: UNNEST HP-1, GROUP BY HP-2, fillfactor IS-1), G14 (benchmark baseline)
5. **Testing** — G9–G12 (crash-injection/cold-start CI, soak + load-under-prune, differential-equivalence, M5 live round-trip)
6. **API-surface freeze** — G1–G4, G20 (public surface, SemVer/CHANGELOG, frozen error-code catalog, contract docs, Lean cut-line freeze)
7. **Infosec** — G15–G19 (SECURITY.md/threat model, dedup caveat, TLS/VerifyFull, supply-chain CI gate, committed-secret remediation)
8. **Then the 1.0.0 tag.**

**Gated on the Preprod sync reaching tip (§2):** two items only —
**G12** (M5 live Preprod round-trip) and **the tag's live-evidence step**. Everything else can proceed
while the sync is paused; resume the sync in time for these two.

---

## 5. Established implementation workflow (follow it for G6–G8)

Per `docs/v1-implementation-guideline.md` §1, each gate runs the same pipeline:

- **Stage 0–1 — verify-first.** Confirm the current state and the frozen acceptance bar before writing code.
- **Stage 2–4 — red / green / self-verify** in an **isolated worktree** (never the main checkout — see
  LL-001 in the lessons log for the path-slip that this rule exists to prevent).
- **Stage 6–9 — independent audit.** Parallel Opus lanes **plus** a **cold cross-vendor Codex**
  adversarial pass in **NONE mode** (no manifest / prior verdict / implementer self-summary /
  severity pre-label), capped at 20 minutes via `timeout 1200 codex exec`, at `reasoning=high`, and
  **skip graphify** (avoids the ~25-min stall). The cross-vendor cold lane is **mandatory for hard
  classes** (co-transactional / durability / crash-ordering) — on G5 it caught what all five
  same-vendor lanes passed (LL-002, LL-003).
- **Fix-to-PASS**, then **merge + graphify close-out**.

The G5 audit trail (evidence pointers for the lessons entries) is in the Windows scratchpad at
`C:\Users\charl\AppData\Local\Temp\claude\C--Users-charl\7b31fa9c-f9d5-4bef-abe1-7b1aa1c2eda9\scratchpad\umbradb-v1-research\`
(`audit/G5/`, `impl/`).

---

## 6. Worktree cleanup

These worktrees are on disk and should be removed once their branches are merged:

| Worktree | Branch / change | State |
|---|---|---|
| `/root/UmbraDB-durable-cursor` | G5 (durable-checkpoint-cursor) | merged (`e5fcdaa`) — remove |
| `/root/UmbraDB-flake` | flake reproducibility | merged (`a3a3c99`) — remove |
| `/root/UmbraDB-supplychain` | supply-chain inventory / SLSA | merged (`de48bfc`) — remove |
| `/root/UmbraDB-handoff` | `docs/handoff` (this doc) | remove after this branch merges |

Remove with `git worktree remove <path>` from `/root/UmbraDB` (then `git worktree prune`). Other
worktrees in the list belong to separate, still-unmerged tracks — leave them.

---

*Written 2026-07-23 on branch `docs/handoff`. Not pushed, not merged.*
