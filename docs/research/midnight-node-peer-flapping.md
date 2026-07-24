<!--
Provenance: produced by an autonomous research swarm — live node recon + 5 Sonnet-5 online-research
facets (Midnight/Substrate/libp2p networking, bootnode/NAT/discovery, known issues, version/protocol)
+ 4 Fable-5 adversarial council lenses (upstream-bug, config-version-fix, infra-topology, inherent-testnet)
+ a Fable-5 consolidation, 2026-07. It studies whether the preprod archive node's 0->N->0 libp2p
peer-flapping (which throttles the local full-chain sync) is a network-stack bug or a fixable local
improvement. NOTE: the local full-chain sync is NOT on the UmbraDB v1.0.0 tag critical path (R5 runs
against the cloud indexer); this is research/operational context. Key empirical artifacts referenced
live in the session scratchpad (dualtrace.sh, netdir.sh, mn-src/ source verifications).
-->

# ASSESSMENT — `midnight-node-archive` Peer Flapping (Midnight Preprod, WSL2 Docker Host)

Consolidated verdict of the synthesis plus four adversarial council lenses (upstream-bug, config-version-fix, infra-topology, inherent-testnet). Council source claims were spot-verified against the local checkout (`mn-src/midnight-node/Cargo.toml` lines 254/452: `sc-network` vendored unmodified from `polkadot-stable2606`, private `midnightntwrk/rust-yamux` fork patched in; `res/preprod/bootnodes-config.json` confirms exactly two official bootnodes).

---

## 1. Executive verdict

**MIX, with a specific division of labor — and the synthesis's original #1/#2 ranking must be inverted for the flapping symptom specifically:**

- **The 0→N→0 flapping oscillation is an UPSTREAM NETWORK-STACK BEHAVIOR** (Substrate/polkadot-sdk peer-management eviction — most plausibly the fatal reputation-ban family: `polkadot-sdk#3346`/`#528`; midnight-node `#1391`/`#1490`/`#1824`/`#1531`) **expressed through this node's slow archive-sync regime** (883k blocks / ~61% behind, `--pruning archive`, heavy I/O on a co-tenanted VM). Not fixable by local config; only mitigable. **Confidence: high on "protocol-level eviction above L4," medium on "specifically the reputation-ban cascade"** (mechanism precedented and now strongly indicated, but the confirming `Report <peer>… Banned, disconnecting` log line has still never been captured — logs were at `info` level).
- **The low peer *ceiling* and unreachability is a FIXABLE LOCAL CONFIG GAP** — `30333/tcp` unpublished, no `--public-addr` — a real, docs-contradicting deployment defect that must be fixed regardless. **Confidence: high** that it caps the peer universe; **high** that it is *not* the driver of the collapse cycles (see §2, decisive evidence).
- **A genuine INHERENT-TESTNET component**: preprod's official peer universe is two bootnodes; any churn from any cause is maximally visible and unabsorbable. Residual churn should be expected as an operating condition until the node reaches tip and/or upstream fixes land. **Confidence: high as amplifier, ruled out as sole cause.**

**What changed versus the synthesis:** the infra-topology lens ran a live dual-layer trace (netns `ss -tn` vs RPC `system_health`, 20s cadence) and produced the single most probative fact in the whole investigation — **16 established TCP connections on 30333, including 2 to the reserved sibling over the NAT-free in-VM Docker bridge, at the exact instant the node reported 0 peers** (TCP count and peer count actually anticorrelated: TCP 10→16 while peers 4→0). Established outbound and bridge-local connections *persist through* the peer collapse. An unpublished port has no mechanism to sever an established L4 session, and the bridge path needs no published port at all. This directly falsifies the synthesis's #1 mechanism-as-flapping-driver ("peer set can only persist as long as outbound connections happen to stay up" — empirically, the connections stay up and the peers vanish anyway) and refutes the config lens's strongest form. The config lens's "ceiling is exactly 3" claim is also contradicted by the same trace (peers reached 4 and 6 in-window), so the {0..3} envelope in the original capture was a sampling artifact, not a structural cap.

**Why the config lens still half-wins:** its A/B (identical 1.0.1 image/bootnodes/host; published sibling rock-steady at 10 peers, unpublished archive flapping) remains real evidence — but three lenses independently convicted it as **confounded on sync-state and pruning mode** (sibling synced+pruned, archive 61%-behind+archive-mode), which is exactly the regime every cited upstream issue fires in (`#1490`: mass peer loss "syncing through ~800k blocks"; `#1531`: identical Idle/Syncing oscillation, maintainer-attributed to slow DB queries during sync). The sibling is not a control; it is a node that exited the trigger regime. The A/B proves "synced+published nodes don't flap," which all hypotheses predict.

---

## 2. Ranked root causes, evidence, and council challenges resolved

**#1 — Substrate protocol-level peer eviction in the slow-sync regime (upstream; primary driver of the flapping).**
Evidence: (a) the dual-trace — peers evicted above healthy, established transport, including on the zero-hop bridge path where no infra/config mechanism exists; (b) phenomenological match to `#1531`'s oscillating `Idle(0 peers)`/`Syncing 0.0bps` shape and to `#3346`/`#528`'s "N peers → mass collapse" signature; (c) unmodified vendored Parity `sc-network` (Cargo.toml:254, no peerstore patch in `[patch.crates-io]`) with fatal `i32::MIN` penalties and **no config knob to disable reputation**; (d) Midnight's own triage language ("upstream Substrate sync behavior," `#1824`) and their private yamux fork (Cargo.toml:452) showing the vendor has already been fighting this stack; (e) the node's regime (61% behind, archive I/O, co-tenanted VM with `autoMemoryReclaim=gradual`) is precisely the request-timeout-penalty-maximizing regime on both sides of every connection.
*Council resolution:* upstream-bug and infra-topology lenses jointly promoted this from the synthesis's "plausible, unconfirmed #2" to primary; the config lens's objection ("same binary is stable in the sibling") is answered by the regime confound. **Caveat kept honest: still unconfirmed at the log-line level.** The `#1490` AURA mechanism is documented for validators; applicability to a non-authoring archive node is unverified. `#1472`'s presence in the running 1.0.1 binary is unresolved (git ancestry check returned "diverged").

**#2 — Unpublished 30333 / no `--public-addr` (local config gap; primary driver of the low peer ceiling, amplifier of the flapping's impact).**
Evidence: no `PortBindings` for 30333 on the archive container; maintainers' reference compose publishes it annotated "for node connectivity"; official troubleshooting's only 0-peers remedy is the port; the sibling's netns shows genuine internet inbound (public-IP ephemeral-port connections) once published — proving the WSL2/router path works. Without inbound, every lost peer must be re-earned by outbound dial against a tiny target set, so eviction troughs hit 0 instead of dipping.
*Council resolution:* demoted from "confirmed primary driver of the flapping" (synthesis) to "confirmed primary driver of the ceiling; amplifier of the flapping" — the position three of four lenses converged on.

**#3 — Slow archive sync / heavy I/O feeding the eviction machinery (shared local-environment + upstream performance issue).**
The lag→timeout→ban→lag loop is self-reinforcing and partly bidirectional with #1 (the config lens is right that a 0–3-peer node syncs at a crawl; the inherent lens is right that a 61%-behind node invites bans from inbound peers). Host environment (`autoMemoryReclaim=gradual` + sparseVhd on a 64GB VM co-hosting cardano-node, db-sync, two Postgreses, indexer) plausibly raises the trigger rate; host resources are otherwise acquitted (load 2.44/20 vCPU, 44GB free, no OOM).

**#4 — Two-bootnode preprod universe (inherent; amplifier only).** Verified in-repo. Makes all churn maximally visible; not causal (sibling holds 10).

**#5 — `txpool-background` failure at 14:17:31 (one-off trigger of the window's start, not the oscillation).** Unchanged from synthesis; separate low-priority investigation.

**REFUTED for good:** version/protocol mismatch (identical-build sibling healthy; genesis hashes match); WSL2-NAT/host-saturation as the mechanism (dual-trace acquittal — the infra lens refuted its own strong form); 2.0.x upgrade as a remedy (no ledger-8→9 migration; would fork off preprod).

**Evidence-hygiene flag (new, from infra lens):** `peer-poll2.sh` records a VPN being toggled during the original recon window ("VPN now off"). Some captured 0-drops in the *original* dataset may be VPN artifacts. The dual-trace post-dates this and is clean, but any pre-fix/post-fix comparison must hold the VPN state fixed.

---

## 3. THE recommended action

**One combined arm — ship the config fix and the confirming diagnostic simultaneously** (the upstream and inherent lenses both insisted on this: run separately, the port variable and the ban evidence stay entangled forever).

For `midnight-node-archive` in its compose file (host 30333 is taken by the sibling):

```yaml
services:
  midnight-node-archive:
    ports:
      - "30334:30333"     # host 30334 -> container 30333/tcp
    restart: unless-stopped
    command:
      # ...existing flags, PLUS:
      - --listen-addr=/ip4/0.0.0.0/tcp/30333
      - --public-addr=/ip4/<HOST_WAN_OR_LAN_IP>/tcp/30334   # Substrate autodetect has nothing to detect behind Docker NAT
      - -lpeerset=debug,sub-libp2p=debug,sync=debug
```

Then `docker compose up -d midnight-node-archive`, mirror whatever Windows-firewall/portproxy state the sibling has for 30333 onto 30334 (the sibling proves the path works), keep the VPN state fixed for the whole observation window, and run the existing dual-trace (`scratchpad/dualtrace.sh` via `wsl -u root`) alongside a 15s `system_health` poll for ≥2 hours of the still-syncing regime.

**Expected outcome — mitigates, does not resolve entirely.** Honest prediction reconciling all lenses: average peer count rises well above 3 (inbound strangers appear, as the sibling's netns proves they will); flap *amplitude* shrinks (more redial capacity, shallower troughs); collapse episodes **persist at reduced frequency until the node reaches tip**, because the eviction mechanism fires above L4 on connections the port fix cannot touch. Full resolution requires (a) the node exiting the slow-sync regime and (b) upstream sc-network/peerstore fixes that remain open at both Parity and Midnight.

**Supporting actions, in priority order:**
1. **Watchdog** (the one intervention valid under every hypothesis — inherent lens correctly promoted it): auto-restart on `peers==0` sustained >10 min. `restart: unless-stopped` plus a healthcheck curling `system_health` and failing on prolonged zero-peer.
2. **Close the sync gap.** Note a correction to the inherent lens's proposal: resyncing from the healthy *sibling* is **not available** — the sibling is pruned and cannot seed an archive node's full state. Options are an official archive snapshot (if Midnight publishes one) or organic sync under the stabilized config. This makes the port fix + watchdog more, not less, important.
3. **Confirm `#1472` presence** in the running 1.0.1 by diffing the relevant `sc-network`/sync source inside the image (git ancestry was inconclusive).
4. Deprioritize: extra reserved peers (no documented pool exists — inherent lens is right that this treats scarcity as a knob), in/out-peers tuning (cosmetic).
5. **Do NOT** upgrade to any 2.0.x image (unanimous, all lenses).

**Upstream issue to file** — contingent on the debug capture (attach it either way; post as a comment on `midnight-node#1824` or `#1391` if the signature matches, new issue otherwise):

> **Title:** Archive node in deep sync loses entire peer set cyclically while TCP connections remain established (preprod, 1.0.1, polkadot-stable2606)
>
> **Body:** On preprod with `midnightntwrk/midnight-node:1.0.1` (`--pruning archive`, ~880k blocks behind tip), `system_health` peers oscillate 0→N→0 every few minutes while a simultaneous netns trace shows 14–16 ESTABLISHED TCP connections on 30333 — including to a reserved peer on the same Docker bridge — at the instant peers=0 (`Idle (0 peers)… ⬆ 0.3kiB/s`). Peer count and TCP count are anticorrelated across the window, so this is protocol-level eviction, not transport loss. A sibling container on the same host, same image, same bootnodes, fully synced, holds 10 peers indefinitely — the behavior appears specific to the deep-sync regime, matching #1531's oscillation shape and the #1490/#1824 sync-regime reports. Attached: dual-layer trace, `-lpeerset=debug,sub-libp2p=debug,sync=debug` capture across full flap cycles [showing / not showing] `Report <peer>… Banned, disconnecting` lines. Question for maintainers: does the #1472 mitigation ship in the 1.0.1 release binary, and does the fatal-reputation path in vendored `sc-network` (polkadot-stable2606, unpatched per Cargo.toml) have any operator-side mitigation for archive nodes syncing from deep behind?

---

## 4. Decisive validation experiment

The combined arm above is the experiment. Crisp, pre-registered falsifiers agreed across all four lenses:

| Observation over ≥2h, still-syncing, VPN state fixed | Verdict |
|---|---|
| Peer count sustained ≥5, **zero** 0-peer episodes through the remaining sync | Config lens vindicated; #1/#2 re-invert back; flapping was local after all |
| Collapses persist (especially any drop of the bridge-local sibling connection while its TCP session survives) **with** `Report <peer>: <score> … Banned, disconnecting` in the debug capture | Upstream ban cascade **proven** on a live preprod archive node; attach to upstream issue |
| Collapses persist **without** any ban/Report lines | Novel eviction path — new upstream issue, capture is the evidence |
| Flapping stops only when sync reaches tip | Inherent/regime lens's exact prediction confirmed |

Zero-cost secondary discriminator, available during any flap: check whether the bridge-local sibling connection is among the dropped peers — every such drop is a data point the port hypothesis structurally cannot absorb. (Cross-host cloud-VM replication remains the gold-standard fallback if in-place results are ambiguous.)

---

## 5. Residual risk and confidence

- **Confidence in the composite verdict (upstream eviction primary for flapping, local port gap primary for ceiling, testnet thinness amplifying): high.** It is the only assignment consistent with *all* observations, including the dual-trace that each single-cause story fails.
- **Largest open gap:** the ban-cascade mechanism is inferred, never yet observed in a log line. The debug capture in §3 closes this. Until then, "protocol-level eviction" is certain; "reputation-ban specifically" is the leading but unconfirmed candidate.
- **Residual risks:** (1) `#1472` may or may not be in the binary — if absent, the db-sync co-location (`DB_SYNC_POSTGRES_CONNECTION_STRING`) adds a second live ban trigger; (2) the original recon dataset is VPN-contaminated — do not reuse it as a pre-fix baseline; (3) `#1490` validator-specificity unverified for archive roles; (4) bootnode-side versions never independently probed (small residual hole in the version refutation, strongly covered indirectly by the sibling); (5) the txpool-background crash could recur on multi-day horizons — the watchdog covers the symptom either way; (6) even post-fix, post-tip, some churn is a preprod operating condition on a 2-bootnode network — set expectations accordingly.
- **Commitment honesty:** the port fix is *necessary and immediately shippable*, but anyone reading this should expect **improvement, not silence** — the honest promise is fewer and shallower flaps during the remaining sync, stability at tip, and an upstream paper trail for what config cannot fix.

Key artifacts: `C:\Users\charl\AppData\Local\Temp\claude\C--Users-charl\79b54289-efc0-4827-8cd5-a5e08e5b9503\scratchpad\dualtrace.sh`, `...\scratchpad\netdir.sh` (runnable via `wsl -u root`), VPN confound recorded in `...\scratchpad\peer-poll2.sh`; source verifications in `...\scratchpad\mn-src\midnight-node\Cargo.toml` (lines 254, 451–452) and `...\mn-src\midnight-node\res\preprod\bootnodes-config.json`.