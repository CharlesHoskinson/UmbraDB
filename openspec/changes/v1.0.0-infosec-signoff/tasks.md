# Tasks — v1.0.0-infosec-signoff

Each task: implemented by a builder, then reviewed in parallel by two auditors (spec-compliance
against this change's `design.md`/`spec.md`; content/security-accuracy and — for the CI and script
tasks — a real execution/dry-run). A task is CLOSED only after both auditors approve, or their
findings are fixed and re-reviewed. Matches the program's per-task review cadence.

Each task states its acceptance criteria concretely (what artifact exists, what CI step passes,
what command succeeds) and the requirement(s) it satisfies.

**Critical-path note (`ROADMAP` §Critical path, step 6).** These InfoSec items (G15–G19) are step
6 of the roadmap sequence — after the G5 co-transactional `save` and the G1–G4 API freeze — and
are internally **parallelizable, mostly S effort** (docs + CI). Within this change: G15
(`SECURITY.md`) is the hub — G16, the G17 README, and the G19 policy all cross-reference it, so
draft G15 first (or in lockstep). G18's `.gitleaks.toml` and G19's `.example`/untrack are
mutually dependent (the allowlist path must match the surviving template), so land them together.
Everything else is independent.

## 0. Threat-model documentation hub (G15)

- [ ] 0.1 Write `SECURITY.md` at the repo root and link it from `README.md` (`design.md` §1).
  State T-A1 (single trusted writer, no adversarial caller) and T-A2 (trusted Postgres/disk/
  backups/operator), grounded in `src/postgres/transaction-lease.ts`'s single-writer model.
  **Satisfies:** "A shipped threat-model document states the single-trusted-writer trust model."
  **Acceptance:** `SECURITY.md` exists at the root; `README.md` links to it; the T-A1/T-A2 prose is
  present and actionable (a reviewer can point to the sentence stating each).
- [ ] 0.2 In `SECURITY.md`, state that `schema` is namespacing, NOT a security/tenant boundary,
  prevented cross-schema only by T-A1; direct real multi-tenancy to Postgres-level enforcement
  (`design.md` §1 item 3; `04-infosec-codebase.md` F5). **Satisfies:** "…schema is namespacing, not
  a security boundary." **Acceptance:** the schema-is-not-a-boundary statement and the
  Postgres-level-enforcement redirect are both present.
- [ ] 0.3 In `SECURITY.md`, state the global chunk-pool trust-domain requirement and the
  cross-wallet dedup side channel (both the `save`-timing and `prune`-reclaim channels), that
  mutually-distrusting principals on one store is unsupported, and the fixed-size-chunking bound on
  the leak (`design.md` §1 item 4; `04-infosec-codebase.md` §6; `council/C-security.md` §3).
  **Satisfies:** "…the chunk pool is one trust domain with an observable side channel."
  **Acceptance:** both channels are named; the "unsupported deployment" statement and the
  fixed-size-chunking (whole-known-chunk, not sub-field) bound are present.
- [ ] 0.4 In `SECURITY.md`, state the **binding** no-at-rest-encryption precondition: secret-bearing
  payloads are plaintext (`src/interfaces/wallet-state-envelope.ts:142`); the deployer MUST encrypt
  disk/backups OR pass ciphertext to `save` (`design.md` §1 item 5; `04-infosec-codebase.md` F2;
  `council/C-security.md` §2). **Satisfies:** "…no at-rest encryption as a binding deployer
  precondition." **Acceptance:** the precondition is phrased as a requirement (MUST), not a
  suggestion; the two acceptable deployer mitigations are both stated.
- [ ] 0.5 In `SECURITY.md`, add the commit-policy section ("no key with any value in git"; the one
  allowlisted testnet artifact + justification; seed/password files generated + `chmod 600`) and a
  vulnerability-reporting section so the file doubles as a conventional GitHub `SECURITY.md`
  (`design.md` §1; `05-infosec-infra.md` §5.3). **Satisfies:** "…carries a commit policy and a
  vulnerability-reporting section." **Acceptance:** commit policy, allowlist mention, `chmod 600`
  generated-not-committed statement, and a vulnerability-reporting channel are all present (a
  reviewer can point to each).
- [ ] 0.6 In `SECURITY.md`, add the scope disclaimer naming the P1 fast-follows this doc documents
  but does NOT implement (keyed chunk addressing → 1.1; `EnvelopeCipher`; VerifyFull default;
  two-role topology) (`design.md` §1; `council/C-security.md` §5). **Satisfies:** "…names the
  unimplemented P1 fast-follows." **Acceptance:** all four fast-follows are enumerated and each is
  explicitly marked documented-but-not-implemented for 1.0.0, so a reader cannot mistake a
  documented precondition for an implemented control.

## 1. CheckpointStore interface-doc rewrite (G16) — depends on 0.3

- [ ] 1.1 Rewrite the three advertised-dedup doc sites in `src/interfaces/checkpoint-store.ts`
  (the `CheckpointStore` interface doc block's "single GLOBAL pool … across wallets"/"no manifest
  anywhere" language; the `PruneResult.reclaimedChunks` doc; the `prune` method doc) to carry the
  single-trust-domain requirement and the cross-wallet side-channel caveat, cross-referencing
  `SECURITY.md` (`design.md` §2; `council/C-security.md` §3 — this doc rewrite is a **1.0.0
  BLOCKER**). **Doc comments only.** **Satisfies:** "The CheckpointStore interface docs carry the
  cross-wallet side-channel caveat." **Acceptance:** each of the three sites states the shared-
  trust-domain requirement and cross-wallet observability; `git diff` shows only comment lines
  changed (no signature/type/exported-symbol/executable line); `npm run typecheck` (`tsc --noEmit`)
  still passes; the pre-existing grace-window (Law C2a/C2b) and "count can be zero even when many
  checkpoints were pruned" caveats remain present (a diff-review check, so the rewrite adds rather
  than replaces).

## 2. TLS caveat + VerifyFull de-stub (G17) — independent

- [ ] 2.1 Create `nix/midnight-env/README.md` (none exists today — only `test-wallets/README.md`)
  with a prominent Security note at the point of use, next to the `enable-db-sync-tls.sh`/
  `start-stack.sh` instructions, stating the `Require` + self-signed caveat (encryption only, no
  server-identity validation, no MITM protection), the co-located-single-host safety condition, and
  the VerifyFull + pinned-CA recommendation for non-localhost (`design.md` §3 part 1;
  `05-infosec-infra.md` §4.4). Lift the analysis from `design/db-sync-tls-feasibility.md` into the
  README. **Satisfies:** "The TLS Require/self-signed caveat is surfaced at the point of use."
  **Acceptance:** the README states the caveat, the safety condition, and the off-host VerifyFull
  recommendation, adjacent to the TLS usage.
- [ ] 2.2 De-stub the VerifyFull/`--ca` path in `nix/midnight-env/scripts/enable-db-sync-tls.sh`:
  replace the trailing echo-only stub with a real single-flag `--ca` mode that generates a local CA,
  signs the server cert with SAN = the dialed host (`$DB_TLS_CN`/`$DB_TLS_SANS`), emits the CA cert
  path, and prints the exact `--ssl_root_cert` for the node; CA key `chmod 600` (`design.md` §3
  part 2; `05-infosec-infra.md` §4.4 recommendation 2). **Satisfies:** "A real VerifyFull/--ca path
  is provided, replacing the stub." **Acceptance:** `enable-db-sync-tls.sh --ca <container>` runs
  end-to-end (a dry-run or containerized execution by an auditor) producing a CA-signed server cert
  with the correct SAN and printing the CA path + `--ssl_root_cert`; the CA key is `0600`.
- [ ] 2.3 Verify the default (no-`--ca`) path provisions the **same** self-signed cert parameters,
  `ssl = on`/`Require` configuration, and `0600` key permissions as before this change — the only
  permitted default-path difference is informational/echoed output (the removed VerifyFull-stub
  echo) (`design.md` §3 part 3; `council/C-security.md` §5). **Satisfies:** "The localhost Require
  default is unchanged." **Acceptance:** a diff of the default provisioning path shows the
  cert-generation parameters, the `ssl = on`/`Require` server config, and the `server.key` `0600`
  step all unchanged; the only default-path diff lines are informational/echo output; an auditor
  confirms an existing localhost invocation produces the same provisioned artifacts (cert + server
  config + key permissions), a diff scoped to provisioning semantics rather than byte-identity.

## 3. Supply-chain CI gate (G18) — 3.5 depends on 4.1

- [ ] 3.1 Add a repo-root `.npmrc` with `ignore-scripts=true`, and add a `.github/workflows/
  supply-chain.yml` job that installs with `npm ci` and asserts `.npmrc` sets `ignore-scripts=true`
  (`design.md` §4 items 1, 3; `05-infosec-infra.md` §2.4). **Satisfies:** "CI installs dependencies
  with npm ci" AND "The repository ships an ignore-scripts .npmrc that CI asserts." **Acceptance:**
  `.npmrc` exists with `ignore-scripts=true`; the workflow uses `npm ci`; the workflow fails if
  `.npmrc` is missing/incorrect (verified by a deliberately-broken-`.npmrc` dry run). **Because a
  repo-root `ignore-scripts=true` also suppresses this package's own `prepare`/`postinstall`
  lifecycle hooks, confirm any build/typecheck the release relies on runs as an EXPLICIT CI step
  (the workflow already runs `typecheck` explicitly — assert this holds and that no needed lifecycle
  hook is silently skipped by the new `.npmrc`)** — Opus audit note 1.
- [ ] 3.2 Add the blocking `npm audit --audit-level=high --omit=dev` step (plus an optional
  non-blocking full `npm audit`) to `supply-chain.yml` (`design.md` §4 item 2). **Satisfies:** "CI
  runs a blocking npm audit on runtime dependencies." **Acceptance:** the blocking step is present
  and scoped `--omit=dev`; on the current clean tree it passes; the runtime scope (`--omit=dev`,
  runtime deps = `postgres` + `zod` only) means a dev-only advisory cannot fail it. The
  "high-severity runtime advisory fails it" counterfactual MAY be evidenced by a scratch branch that
  temporarily pins a known-advisory runtime dependency and shows the step failing; if that procedure
  is not run, the criterion is met by inspection of the blocking `--omit=dev` step plus the
  clean-tree pass (do not assert an unverified counterfactual).
- [ ] 3.3 Add the `trivy` image scan of BOTH digest-pinned images (indexer-standalone
  `@sha256:03afd0…1cc4b`, proof-server `@sha256:801bbc…4d531`, verified in `flake.nix:108-109` /
  `start-stack.sh:115-119`) at `HIGH,CRITICAL`, on a `schedule:` + `workflow_dispatch`, surfacing
  results in the job summary (`design.md` §4 item 5; `05-infosec-infra.md` §6.1). **Satisfies:** "CI
  scans both pinned Docker image digests for CVEs." **Acceptance:** the scheduled job scans both
  pinned references (not floating tags) at HIGH,CRITICAL and writes results to the summary; a manual
  `workflow_dispatch` run completes against both digests.
- [ ] 3.4 Add the `flake.lock` **change-control** check to `supply-chain.yml`: compare the PR's
  `flake.lock` against the same file on the PR base branch and fail IF they differ UNLESS the PR
  carries the `flake-lock-update` label — implemented as a `git diff` against the base plus a PR
  label read, so it needs no Nix toolchain in CI (`design.md` §4 item 6; `05-infosec-infra.md` §3).
  This gates the property the design actually needs — "an accidental/unreviewed `nix flake update`
  cannot land unreviewed" — which a no-op re-lock diff would NOT catch (a self-consistent updated
  lock produces no re-lock diff). **Satisfies:** "CI gates any change to flake.lock behind explicit
  review." **Acceptance:** three dry-run PRs: (a) a PR editing one line of `flake.lock` with no
  `flake-lock-update` label FAILS the step; (b) the same PR with the label added PASSES; (c) a PR
  that does not touch `flake.lock` PASSES regardless of label.
- [ ] 3.5 Add the **full-history** gitleaks secret-scan step (`gitleaks detect`) to
  `supply-chain.yml`, driven by the committed `.gitleaks.toml` from task 4.1 (`design.md` §4 item 4).
  **Depends on 4.1** (the allowlist config). Full-history mode is required because the old wallet
  secret remains permanently in history (no history rewrite, G19), so the scan must both catch it and
  allowlist it. **Satisfies:** "CI runs full-history gitleaks secret scanning with the wallet history
  and template allowlisted." **Acceptance:** the gitleaks step is blocking and scans full git
  history; a planted test secret outside the allowlisted paths fails it (dry run); NEITHER the
  historical `preview-test-wallet.json` path NOR the `.example` template path fails it.

## 4. Committed-secret remediation (G19) — mutually dependent with 3.5

- [ ] 4.1 Untrack the live secret and add the allowlist + template + generator: `git rm --cached
  nix/midnight-env/test-wallets/preview-test-wallet.json`; add it to `.gitignore`; add
  `preview-test-wallet.example.json` (non-secret placeholders + generator pointer, carrying the same
  JSON keys the committed wallet used: `network`, `seedHex`, `nightSecretKeyHex`, `address`); add
  `generate-test-wallet.sh` (fresh local wallet + faucet-refund note); add `.gitleaks.toml` with the
  allowlist path-scoped to **both** the `.example` template path AND the historical
  `preview-test-wallet.json` path (which persists in history since there is no rewrite), each with a
  justification comment (`design.md` §5 items 1, 2; `05-infosec-infra.md` §5.1; `council/C-security.md`
  §5). **Name the derivation tooling the generator shells out to** in a script comment (the same
  Midnight wallet SDK dependency the repo already carries as a dev dep); deriving
  `nightSecretKeyHex`/`address` from a seed requires that tooling, so the generator MUST fail with an
  actionable message naming the required tool if it is unavailable rather than emit a malformed
  file. **Satisfies:** "The committed Preview wallet secret is replaced with a generator and
  example." **Acceptance:** `preview-test-wallet.json` is no longer tracked (`git ls-files` omits it)
  and is `.gitignore`d; `.example` (with the four keys) and `generate-test-wallet.sh` exist;
  `.gitleaks.toml` allowlists exactly the `.example` path and the historical `preview-test-wallet.json`
  path and no other; running `generate-test-wallet.sh` either writes a `preview-test-wallet.json`
  matching the `.example` field shape with a fresh `seedHex`, or fails with the named-tool message
  when the wallet tooling is unavailable in-tree (both outcomes are acceptable; a malformed file is
  not).
- [ ] 4.2 Strengthen `nix/midnight-env/test-wallets/README.md` with the generator/`.example`
  instructions and a strengthened warning; confirm NO git-history rewrite is performed (`design.md`
  §5 items 3, 4; `council/C-security.md` §5). **Satisfies:** "The wallet-secret remediation performs
  no git-history rewrite." **Acceptance:** the README documents the generator flow; the change is an
  ordinary forward commit (no `git filter-repo`/BFG in the task's steps); an auditor confirms the
  go-forward guard is the full-history gitleaks gate (with the historical path allowlisted), and the
  old key's history permanence is explicitly noted as accepted.

## 5. Change close-out

- [ ] 5.1 Whole-change differential review: an auditor re-reads this `proposal.md`/`design.md`/
  `spec.md` against the actually-committed artifacts and confirms every "Acceptance" criterion above
  was actually checked — a green CI run is not sufficient evidence on its own, per every prior
  sprint's close-out standard. Explicitly re-verify the council rulings were honored: no keyed-chunk
  code landed (docs only for the dedup oracle); no `EnvelopeCipher` code (binding precondition doc
  only); the localhost TLS default is unchanged; no git-history rewrite; no consumer/indexer app was
  imported.
- [ ] 5.2 Update `ROADMAP.md` §E to mark G15–G19 complete (and cross-reference that the
  keyed-chunk-addressing and `EnvelopeCipher` P1 fast-follows remain separately tracked for 1.1), so
  the roadmap does not drift from what was built. State plainly: this change completes the InfoSec
  **sign-off** obligations (docs + CI) for the 1.0.0 tag; the P1 code fast-follows it documents are
  not part of the tag.
