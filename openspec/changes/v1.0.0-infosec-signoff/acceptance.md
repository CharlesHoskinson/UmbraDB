# Acceptance criteria — v1.0.0-infosec-signoff

Consolidated, objective acceptance criteria for the whole change (gate items **G15–G19**). Each
criterion is traceable to a requirement in `specs/security-posture/spec.md` and a task in
`tasks.md`, and is marked by **how it is verified**: `doc-artifact` (a file/section exists and
states X — checkable by inspection), `CI gate` (a CI step passes/fails as specified),
`manual evidence` (an auditor executes a script/dry-run and records the result), or
`unit/typecheck` (`tsc --noEmit` / a build command).

The change is **DONE** when every criterion below is met. This is an InfoSec **sign-off** change:
its deliverables are documentation, CI, and dev-environment tooling — there is no `src/` runtime
behavior to test, so there are no runtime property tests here by design.

## G15 — Threat-model / `SECURITY.md`

| # | Criterion | Requirement | Task | Verified by |
|---|---|---|---|---|
| A1 | `SECURITY.md` exists at the repo root and is linked from `README.md` | single-trusted-writer trust model | 0.1 | doc-artifact |
| A2 | `SECURITY.md` states T-A1 (single trusted writer, no adversarial caller) and T-A2 (trusted Postgres/disk/backups/operator) in actionable prose | single-trusted-writer trust model | 0.1 | doc-artifact |
| A3 | `SECURITY.md` states `schema` is namespacing, NOT a security/tenant boundary; cross-schema prevented only by T-A1; real multi-tenancy → Postgres-level enforcement | schema is namespacing, not a security boundary | 0.2 | doc-artifact |
| A4 | `SECURITY.md` names BOTH cross-wallet dedup channels (`save`-timing, `prune`-reclaim), states mutually-distrusting principals on one store is unsupported, and states the fixed-size-chunking (whole-known-chunk, not sub-field) bound | chunk pool is one trust domain with an observable side channel | 0.3 | doc-artifact |
| A5 | `SECURITY.md` states, as a binding MUST, that no at-rest encryption is provided and the deployer MUST encrypt disk/backups OR pass ciphertext to `save` | no at-rest encryption as a binding deployer precondition | 0.4 | doc-artifact |
| A6 | `SECURITY.md` carries the commit policy ("no key with any value in git" + the one allowlisted testnet artifact + `chmod 600` generated seed/password files) and a vulnerability-reporting section | commit policy and a vulnerability-reporting section | 0.5 | doc-artifact |
| A7 | `SECURITY.md` enumerates the P1 fast-follows (keyed chunking→1.1, `EnvelopeCipher`, VerifyFull default, two-role topology) as documented-but-not-implemented | names the unimplemented P1 fast-follows | 0.6 | doc-artifact |

## G16 — CheckpointStore dedup interface-doc caveat

| # | Criterion | Requirement | Task | Verified by |
|---|---|---|---|---|
| B1 | All three advertised-dedup doc sites in `src/interfaces/checkpoint-store.ts` (interface doc block; `PruneResult.reclaimedChunks`; `prune` method doc) state the single-trust-domain requirement and cross-wallet observability, cross-referencing `SECURITY.md` | interface docs carry the cross-wallet side-channel caveat | 1.1 | doc-artifact |
| B2 | `git diff` of `src/interfaces/checkpoint-store.ts` shows only comment lines changed — no signature, type, exported symbol, or executable line | interface docs carry the caveat (doc-only) | 1.1 | manual evidence (diff review) |
| B3 | `npm run typecheck` (`tsc --noEmit`) passes after the rewrite | interface docs carry the caveat (doc-only) | 1.1 | unit/typecheck |
| B4 | Both named pre-existing caveats remain present verbatim-in-substance: the Law C2a/C2b grace-window sentence (a chunk is physically deleted only after its post-unreference grace window elapses) and the "count can be zero even when many checkpoints were pruned" `reclaimedChunks` sentence | interface docs carry the caveat (adds, does not replace) | 1.1 | doc-artifact |

## G17 — TLS caveat surfaced + VerifyFull de-stubbed, localhost default kept

| # | Criterion | Requirement | Task | Verified by |
|---|---|---|---|---|
| C1 | `nix/midnight-env/README.md` exists and, adjacent to the TLS usage, states the `Require`+self-signed caveat (encryption only, no server-identity validation, no MITM protection), the co-located-single-host safety condition, and the off-host VerifyFull+pinned-CA recommendation | TLS caveat surfaced at the point of use | 2.1 | doc-artifact |
| C2 | `enable-db-sync-tls.sh --ca <container>` runs end-to-end producing a local-CA-signed server cert with the correct SAN, printing the CA cert path and the exact `--ssl_root_cert`; CA key is `0600` | a real VerifyFull/--ca path replaces the stub | 2.2 | manual evidence (containerized/dry run) |
| C3 | The default (no-`--ca`) path provisions the **same** self-signed cert parameters, `ssl = on`/`Require` config, and `0600` key permissions as before this change; the only default-path difference is informational/echoed output; an existing localhost user observes no change to provisioned artifacts | the localhost Require default is unchanged | 2.3 | manual evidence (diff review) |

## G18 — Supply-chain CI gate

| # | Criterion | Requirement | Task | Verified by |
|---|---|---|---|---|
| D1 | The supply-chain workflow installs with `npm ci` (never `npm install`); an install inconsistent with `package-lock.json` fails | CI installs with npm ci | 3.1 | CI gate |
| D2 | A repo-root `.npmrc` exists with `ignore-scripts=true`; the workflow asserts it and fails if missing/incorrect; any build/typecheck the release depends on runs as an **explicit** CI step (not a suppressed lifecycle hook), confirmed by the broken-`.npmrc` dry run | ships an ignore-scripts .npmrc that CI asserts | 3.1 | CI gate + manual evidence (broken-`.npmrc` dry run) |
| D3 | A blocking `npm audit --audit-level=high --omit=dev` step is present, scoped to runtime deps, and passes on the current clean tree; the runtime scope means a dev-only advisory cannot fail it. (Counterfactual "a high-severity runtime advisory fails it" MAY be evidenced by a scratch branch temporarily pinning a known-advisory runtime dep; if not run, the criterion is met by inspection of the blocking `--omit=dev` step + a clean-tree pass) | blocking npm audit on runtime dependencies | 3.2 | CI gate + inspection |
| D4 | A full-history `gitleaks detect` step (blocking), driven by the committed `.gitleaks.toml`, fails on a planted secret outside the allowlist and does NOT fail on either allowlisted path (the historical `preview-test-wallet.json` and the `.example` template) | full-history gitleaks scanning with wallet history and template allowlisted | 3.5 / 4.1 | CI gate + manual evidence (planted-secret dry run) |
| D5 | A `trivy` scan of BOTH pinned digests (indexer-standalone `@sha256:03afd0…1cc4b`, proof-server `@sha256:801bbc…4d531`) at HIGH,CRITICAL runs on `schedule:` + `workflow_dispatch`; the scanned references equal the `flake.nix` pins (asserted, not floating tags); results in the job summary | scans both pinned Docker image digests for CVEs | 3.3 | CI gate + manual evidence (`workflow_dispatch` run) |
| D6 | The `flake.lock` change-control step: a PR that modifies `flake.lock` without the `flake-lock-update` label fails; the same PR with the label passes; a PR that does not touch `flake.lock` passes regardless. Requires no Nix toolchain (git-diff-against-base + label read) | gates any change to flake.lock behind explicit review | 3.4 | CI gate + manual evidence (labeled/unlabeled dry-run PRs) |

## G19 — Committed-secret remediation

| # | Criterion | Requirement | Task | Verified by |
|---|---|---|---|---|
| E1 | `nix/midnight-env/test-wallets/preview-test-wallet.json` is no longer tracked (`git ls-files` omits it) and is `.gitignore`d | committed Preview wallet secret replaced with a generator and example | 4.1 | manual evidence (`git ls-files`) |
| E2 | `preview-test-wallet.example.json` (non-secret placeholders) and `generate-test-wallet.sh` (fresh wallet + faucet-refund note) exist; running the generator writes a `preview-test-wallet.json` matching the `.example` field shape (`network`, `seedHex`, `nightSecretKeyHex`, `address`) with a fresh `seedHex`, OR fails with an actionable message naming the required Midnight wallet tooling when that tooling is unavailable in-tree | replaced with a generator and example | 4.1 | doc-artifact + manual evidence (run generator) |
| E3 | `.gitleaks.toml` allowlists exactly the `.example` template path and the historical `preview-test-wallet.json` path, each with a justification comment, and no other path | replaced with a generator and example (allowlist) | 4.1 | doc-artifact |
| E4 | The remediation is an ordinary forward commit — no `git filter-repo`/BFG history rewrite — with the old key's history permanence noted as accepted and the full-history gitleaks gate named as the go-forward guard | remediation performs no git-history rewrite | 4.2 | manual evidence (change-log/diff review) |

## Cross-cutting council-ruling gates (close-out — Task 5.1)

These are not per-item; they assert the change stayed inside the council's rulings and did not
gold-plate into deferred scope.

| # | Criterion | Source ruling | Verified by |
|---|---|---|---|
| Z1 | No keyed/scoped chunk-addressing code landed — the dedup-oracle obligation was met by documentation only (G15 + G16); keyed chunking remains a 1.1 fast-follow | `council/C-security.md` §3, §5 | manual evidence (diff review — no `src/postgres/checkpoint-store.ts` behavior change) |
| Z2 | No `EnvelopeCipher`/at-rest-encryption seam code landed — the plaintext-key obligation was met by the binding precondition doc only | `council/C-security.md` §2, §5 | manual evidence (diff review — no `src/interfaces/wallet-state-envelope.ts` behavior change) |
| Z3 | The localhost TLS default is unchanged (VerifyFull is strictly opt-in via `--ca`) | `council/C-security.md` §5; `05-infosec-infra.md` §4.4 | manual evidence (overlaps C3) |
| Z4 | No git-history rewrite was performed for the committed wallet secret | `council/C-security.md` §5 | manual evidence (overlaps E4) |
| Z5 | No consumer/indexer app was imported — the indexer-agnostic boundary is intact | `ROADMAP` G11 | manual evidence (dependency/diff review) |
| Z6 | `save()` idempotency, the two-role Postgres topology, restore-integrity verification, and container/network hardening were NOT added here (out of this change's gate scope) | `ROADMAP` §Deferred; `council/C-security.md` §4 | manual evidence (scope review) |
