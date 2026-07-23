# security-posture

The InfoSec sign-off surface for UmbraDB 1.0.0: the security-model documentation, the
cross-wallet-dedup interface-doc caveat, the TLS-caveat surfacing + VerifyFull de-stub, the
supply-chain CI gate, and the committed-secret remediation. Covers gate items **G15–G19** of
`ROADMAP-v1.0.0-CONSOLIDATED.md` §E, adjudicated by `council/C-security.md`.

Requirements below follow EARS (Easy Approach to Requirements Syntax): each is one of Ubiquitous
("The system SHALL…"), Event-driven ("WHEN \<trigger>, the system SHALL…"), Unwanted-behavior
("IF \<trigger>, THEN the system SHALL…"), State-driven ("WHILE \<state>, the system SHALL…"), or
Optional-feature ("WHERE \<feature>, the system SHALL…") form — as in Sprint 4's
`specs/watermarks/spec.md`. "The system" here is the UmbraDB **repository** (its shipped
documentation, interface contracts, CI configuration, and dev-environment tooling), not a runtime
process — this change ships no `src/` runtime behavior.

## ADDED Requirements

### Requirement: A shipped threat-model document states the single-trusted-writer trust model (G15)

The repository SHALL ship a security/threat-model document (`SECURITY.md`), linked from the root
`README.md`, that states — as explicit, binding assumptions — the single-trusted-writer model
(T-A1: one trusted process drives all reads/writes; there is no adversarial API caller; all
consumers share one trust domain) and the trusted-Postgres/trusted-operator model (T-A2: the DB
role owns every schema it touches; Postgres, its disk, backups, and replicas are trusted). The
statement SHALL be grounded in the code that embodies it (`src/postgres/transaction-lease.ts`'s
single-writer deployment model).

#### Scenario: SECURITY.md exists, is linked, and states T-A1 and T-A2
- **WHEN** the repository is inspected at the 1.0.0 tag
- **THEN** a `SECURITY.md` file SHALL exist at the repository root
- **AND** the root `README.md` SHALL contain a link to it
- **AND** `SECURITY.md` SHALL state, in prose a deployer can act on, that UmbraDB assumes a single
  trusted writer (no adversarial caller) and a trusted local Postgres, disk, backups, and operator

### Requirement: The threat-model document states that schema is namespacing, not a security boundary (G15 / F5)

`SECURITY.md` SHALL state that a Postgres `schema` in UmbraDB is an organizational namespacing
convenience and is **NOT** a security or tenant boundary: all queries run under one DB role that
owns every schema, any caller can point an adapter at any schema, and this is prevented only by the
single-trusted-writer assumption (T-A1), not by the library. It SHALL state that real
multi-tenancy, if ever required, must be enforced at the Postgres level (role-per-tenant + `GRANT`,
or row-level security), never in this library.

#### Scenario: SECURITY.md denies that schema is an isolation boundary
- **WHEN** `SECURITY.md` is read for its statement on `schema`
- **THEN** it SHALL explicitly state that `schema` is namespacing, not a security/tenant boundary
- **AND** it SHALL state that cross-schema access is prevented only by T-A1, not by library-enforced
  access control
- **AND** it SHALL direct any real multi-tenancy requirement to Postgres-level enforcement

### Requirement: The threat-model document states that the chunk pool is one trust domain with an observable side channel (G15 / F1)

`SECURITY.md` SHALL state that CheckpointStore chunk storage is a single global content-addressed
pool shared across wallets, that chunk *existence* and garbage-collection behavior are **observable
across wallets** (a `save`-latency timing channel between a first-time write and a deduplicating
no-op, and a `prune` `reclaimedBytes`/`reclaimedChunks` channel that depends on other wallets'
references), and that therefore placing mutually-distrusting principals on one store is an
**unsupported** deployment. It SHALL also state the bound on the leak: chunking is fixed-size (not
content-defined), so the side channel is a whole-known-chunk confirmation-of-file leak, not a
sub-field extraction primitive.

#### Scenario: SECURITY.md names the dedup side channel and the single-trust-domain requirement
- **WHEN** `SECURITY.md` is read for its statement on cross-wallet dedup
- **THEN** it SHALL state that the chunk pool is global/shared and that chunk existence and GC
  behavior are observable across wallets (naming both the `save`-timing and `prune`-reclaim channels)
- **AND** it SHALL state that a deployment with mutually-distrusting principals sharing one store is
  unsupported
- **AND** it SHALL state that chunking is fixed-size, bounding the leak to whole-known-chunk
  confirmation rather than sub-field extraction

### Requirement: The threat-model document states no at-rest encryption as a binding deployer precondition (G15 / F2)

`SECURITY.md` SHALL state, as a **binding deployment precondition** (not a footnote), that UmbraDB
provides **no** at-rest encryption: secret-bearing payloads (for Midnight, the shielded-wallet
spending-key / coin-secret material carried by the wallet-state envelope) are persisted in
plaintext, and a deployer persisting such payloads MUST either provide storage/backup encryption
(encrypted disk, Postgres TDE, or encrypted backups) OR pass ciphertext to `CheckpointStore.save`.

#### Scenario: SECURITY.md makes at-rest encryption a binding deployer obligation
- **WHEN** `SECURITY.md` is read for its statement on data-at-rest
- **THEN** it SHALL state that UmbraDB stores secret-bearing payloads in plaintext and provides no
  encryption hook
- **AND** it SHALL state, as a binding precondition, that the deployer MUST provide at-rest
  encryption of disk/backups OR pass ciphertext — phrased as a requirement, not a suggestion

### Requirement: The threat-model document carries a commit policy and a vulnerability-reporting section (G15)

`SECURITY.md` SHALL include a commit-policy section stating that no key with any value may ever be
committed to git, that the one Preview testnet wallet artifact is the sole allowlisted exception
(with justification), and that all password/seed files are generated (not committed) and `chmod
600`. `SECURITY.md` SHALL also include a vulnerability-reporting section (how to report a
vulnerability) so the file doubles as a conventional GitHub `SECURITY.md`.

#### Scenario: SECURITY.md states the commit policy and a reporting channel
- **WHEN** `SECURITY.md` is read for its commit policy and reporting section
- **THEN** it SHALL state "no key with any value in git" and name the one allowlisted testnet
  artifact with its justification
- **AND** it SHALL state that password/seed files are generated (not committed) and `chmod 600`
- **AND** it SHALL provide a vulnerability-reporting channel

### Requirement: The threat-model document names the unimplemented P1 fast-follows it documents (G15)

`SECURITY.md` SHALL name the P1 fast-follows it documents but does **not** implement (keyed/scoped
chunk addressing → 1.1; the injectable `EnvelopeCipher` seam; the VerifyFull default; the two-role
Postgres topology), so a reader does not mistake a documented precondition for an implemented
control.

#### Scenario: SECURITY.md distinguishes documented preconditions from implemented controls
- **WHEN** `SECURITY.md` is read for its scope disclaimer
- **THEN** it SHALL enumerate the P1 fast-follows (keyed chunk addressing, `EnvelopeCipher`,
  VerifyFull default, two-role topology) as documented-but-not-implemented for 1.0.0

### Requirement: The CheckpointStore interface docs carry the cross-wallet side-channel caveat (G16)

The `CheckpointStore` interface documentation in `src/interfaces/checkpoint-store.ts` SHALL, at
each place it advertises cross-wallet deduplication or global garbage collection (the
`CheckpointStore` interface doc block's "single GLOBAL pool … across wallets" / "no manifest
anywhere in the store" language, the `PruneResult.reclaimedChunks` doc, and the `prune` method
doc), state that the shared chunk pool requires a single trust domain and that chunk existence and
reclamation behavior are observable across wallets (a side channel), cross-referencing
`SECURITY.md`. This SHALL be a **documentation-only** change — no interface signature, type,
exported name, or runtime behavior SHALL change — and it SHALL NOT weaken any existing accurate
statement.

#### Scenario: The dedup and prune docs state the trust-domain requirement and the side channel
- **WHEN** `src/interfaces/checkpoint-store.ts` is read at the three advertised-dedup doc sites
- **THEN** each SHALL state that the global pool is one shared trust domain and that cross-wallet
  chunk existence / reclamation state is observable
- **AND** the `PruneResult.reclaimedChunks` doc SHALL frame the "referenced by another wallet's
  manifest" behavior as a cross-wallet reference-state side channel, cross-referencing `SECURITY.md`

#### Scenario: The rewrite changes no contract and preserves existing accurate caveats
- **WHEN** the change to `src/interfaces/checkpoint-store.ts` is diffed
- **THEN** only doc comments SHALL have changed — no signature, type, exported symbol, or executable
  line
- **AND** `npm run typecheck` (`tsc --noEmit`) SHALL still pass
- **AND** the pre-existing grace-window caveat (the Law C2a/C2b sentence stating a chunk is
  physically deleted only after its post-unreference grace window elapses) SHALL remain present
- **AND** the pre-existing "count can be zero even when many checkpoints were pruned"
  `reclaimedChunks` caveat sentence SHALL remain present

### Requirement: The TLS Require/self-signed caveat is surfaced at the point of use (G17)

The `nix/midnight-env` README SHALL carry a prominent security note, adjacent to the
`enable-db-sync-tls.sh` / `start-stack.sh` usage, stating that the default TLS posture (`Require` +
self-signed certificate) provides **encryption only, with no server-identity validation**; that it
does NOT prevent an active on-host MITM from impersonating the Postgres endpoint and harvesting the
DB credentials; that it is safe **only** when the Midnight node and Postgres are co-located on a
single trusted host; and that VerifyFull (with a pinned CA) is the recommended posture for any
multi-host or untrusted-segment deployment.

#### Scenario: The nix/midnight-env README states the Require caveat and recommends VerifyFull off-host
- **WHEN** the `nix/midnight-env` README is read next to the TLS-enabling instructions
- **THEN** it SHALL state that `Require` + self-signed is encryption without server-identity
  validation and gives no MITM protection
- **AND** it SHALL state the co-located-single-host safety condition
- **AND** it SHALL recommend VerifyFull + pinned CA for any non-localhost deployment

### Requirement: A real VerifyFull/--ca path is provided, replacing the stub (G17)

`nix/midnight-env/scripts/enable-db-sync-tls.sh` SHALL provide a real, single-flag VerifyFull/`--ca`
mode (replacing the current trailing echo-only stub) that generates a local CA, signs the server
certificate with a SAN equal to the host the node dials, and emits the CA certificate path and the
exact `--ssl_root_cert` value the node must be given. The CA private key SHALL be created with
`0600` permissions, matching the existing `server.key` handling.

#### Scenario: enable-db-sync-tls.sh --ca produces a VerifyFull-capable trust chain in one flag
- **WHEN** `enable-db-sync-tls.sh` is invoked in its `--ca` mode against a Postgres container
- **THEN** it SHALL generate a local CA and sign the server certificate with the correct SAN in a
  single invocation (not a manual multi-step recipe)
- **AND** it SHALL output the CA certificate location and the exact `--ssl_root_cert` value for the
  node
- **AND** the generated CA private key SHALL have `0600` permissions

### Requirement: The localhost Require default is unchanged (G17)

WHEN `enable-db-sync-tls.sh` is invoked without the `--ca` flag, the script SHALL provision the same
TLS posture as before this change — the same self-signed certificate parameters, the same `ssl =
on` / `Require` server configuration, and the same `server.key` `0600` permissions — so the
localhost default SHALL NOT change. Any difference from prior behavior on the default path SHALL be
limited to informational/echoed output (the removed VerifyFull-stub echo). The VerifyFull path SHALL
be strictly opt-in via `--ca`.

#### Scenario: The default (no --ca) path provisions the pre-existing Require posture
- **WHEN** `enable-db-sync-tls.sh` is invoked without `--ca` (the default path)
- **THEN** it SHALL provision the same self-signed certificate parameters, the same `ssl = on` /
  `Require` configuration, and the same `0600` key permissions as before this change
- **AND** any difference from prior behavior SHALL be limited to informational output — the
  certificate, server-config, and key-permission artifacts SHALL be unchanged

### Requirement: CI installs dependencies with npm ci (G18)

The supply-chain CI workflow SHALL install dependencies with `npm ci` (never `npm install`),
enforcing the committed `package-lock.json` and its per-package integrity hashes, so that a tampered
or lockfile-inconsistent tarball hard-fails the install.

#### Scenario: CI installs with npm ci
- **WHEN** the supply-chain CI workflow runs on a pull request
- **THEN** dependency installation SHALL use `npm ci`
- **AND** an install that does not match the committed `package-lock.json` SHALL fail the workflow

### Requirement: The repository ships an ignore-scripts .npmrc that CI asserts (G18)

The repository SHALL ship a repository-root `.npmrc` setting `ignore-scripts=true`, so that no
dependency install/preinstall/postinstall lifecycle script can execute. The supply-chain gate SHALL
assert that `.npmrc` is present and sets `ignore-scripts=true` (a config-drift guard). Because a
repo-root `ignore-scripts=true` also suppresses *this* package's own lifecycle hooks, any build or
typecheck step CI relies on SHALL be invoked as an explicit CI step rather than via a lifecycle hook.

#### Scenario: The ignore-scripts posture is present and enforced, and needed build steps are explicit
- **WHEN** the supply-chain CI workflow runs on a pull request
- **THEN** a repository-root `.npmrc` SHALL exist with `ignore-scripts=true`
- **AND** the workflow SHALL fail if the `.npmrc` is missing or does not set `ignore-scripts=true`
- **AND** any build/typecheck the release depends on SHALL run as an explicit CI step, not a
  suppressed lifecycle hook

### Requirement: CI runs a blocking npm audit on runtime dependencies (G18)

The supply-chain CI workflow SHALL run `npm audit --audit-level=high --omit=dev` as a **blocking**
step (failing the build on any high or critical advisory in the runtime dependency scope), and MAY
additionally run a non-blocking full `npm audit` for developer visibility.

#### Scenario: The blocking runtime-scoped audit step is present, scoped, and passes clean
- **WHEN** the supply-chain workflow is inspected and run on the current clean tree
- **THEN** a blocking `npm audit --audit-level=high --omit=dev` step SHALL be present and scoped to
  runtime dependencies (`--omit=dev`)
- **AND** it SHALL pass on the current clean tree
- **AND** by construction (`--omit=dev`) a dev-scope-only advisory SHALL NOT fail this blocking step

### Requirement: CI runs full-history gitleaks secret scanning with the wallet history and template allowlisted (G18)

The supply-chain CI workflow SHALL run `gitleaks` in **full git-history** mode (`gitleaks detect`)
as a blocking secret-scanning step, configured by a committed `.gitleaks.toml`. Because the
wallet-secret remediation performs **no history rewrite** (G19), the previously committed
`nix/midnight-env/test-wallets/preview-test-wallet.json` remains permanently in history; the
`.gitleaks.toml` allowlist SHALL therefore be path-scoped to cover exactly two artifacts — the
historical `preview-test-wallet.json` path (the pre-existing valueless Preview secret) and the
`preview-test-wallet.example.json` template placeholder — each with a justification comment, and no
other path. Any secret introduced on any other path SHALL cause the gate to fail.

#### Scenario: A newly introduced secret outside the allowlist fails the scan
- **WHEN** a commit introduces a high-entropy secret on any path other than the two allowlisted
  wallet artifacts
- **THEN** the full-history gitleaks step SHALL fail the workflow

#### Scenario: The historical wallet secret and the template placeholder do not fail the scan
- **WHEN** the full-history gitleaks scan encounters the historical `preview-test-wallet.json`
  secret and the `preview-test-wallet.example.json` placeholder
- **THEN** the gitleaks step SHALL NOT fail on either allowlisted path

### Requirement: CI scans both pinned Docker image digests for CVEs (G18)

The supply-chain CI workflow SHALL scan **both** digest-pinned Docker images used by the dev stack
(`midnightntwrk/indexer-standalone:4.3.3@sha256:03afd079b00bcd229df29a24771439c5e7695c339cd89216d0763ce40731cc4b`
and
`midnightntwrk/proof-server:8.1.0@sha256:801bbc0340e9e96f16735f77b523f23c7459e3359842f7c79c2c53f4e994d531`,
the exact pins in `nix/midnight-env/flake.nix:108-109`, mirrored in `start-stack.sh:115-119`) with
`trivy` (or an equivalent scanner) at `HIGH,CRITICAL` severity, on a schedule (so a newly-disclosed
CVE against a pinned digest surfaces without a repository change) and on demand, surfacing results in
the job summary. The scan targets SHALL be the pinned digest references, and the workflow SHALL
derive or assert them against the `flake.nix` pins so a digest bump cannot silently diverge from
what is scanned.

#### Scenario: Both pinned digests are scanned on a schedule
- **WHEN** the scheduled supply-chain scan runs
- **THEN** it SHALL run a `HIGH,CRITICAL` image scan against both the indexer-standalone and
  proof-server digest-pinned references
- **AND** the scanned references SHALL equal the digest pins in `nix/midnight-env/flake.nix` (not
  floating tags)
- **AND** the results SHALL be recorded in the job summary

### Requirement: CI gates any change to flake.lock behind explicit review (G18)

The supply-chain CI workflow SHALL include a `flake.lock` change-control check that compares the
pull request's `flake.lock` against the same file on the pull request's base branch and, IF they
differ, SHALL fail the workflow unless the pull request carries an explicit `flake-lock-update`
label — so that an accidental or unreviewed `nix flake update` (rolling the floating
`nixpkgs`/`flake-utils` refs forward) cannot land unreviewed. The check SHALL require no Nix
toolchain in CI (it is a `git diff` against the base branch plus a label read).

#### Scenario: An unlabeled flake.lock change fails the gate
- **WHEN** a pull request modifies `flake.lock` relative to its base branch and carries no
  `flake-lock-update` label
- **THEN** the flake.lock change-control step SHALL fail the workflow

#### Scenario: A labeled flake.lock change is allowed
- **WHEN** a pull request modifies `flake.lock` relative to its base branch and carries the
  `flake-lock-update` label
- **THEN** the flake.lock change-control step SHALL pass

#### Scenario: A pull request that does not touch flake.lock passes
- **WHEN** a pull request does not modify `flake.lock` relative to its base branch
- **THEN** the flake.lock change-control step SHALL pass regardless of label

### Requirement: The committed Preview wallet secret is replaced with a generator and example (G19)

The repository SHALL NOT track a live wallet secret: the previously committed
`nix/midnight-env/test-wallets/preview-test-wallet.json` (its `seedHex` and `nightSecretKeyHex`)
SHALL be untracked (and `.gitignore`d), replaced by a `preview-test-wallet.example.json` template
carrying only non-secret placeholder values and a `generate-test-wallet.sh` generator that produces
a fresh local wallet plus a faucet-refund note. A produced wallet file SHALL match the
`.example` field shape (the same JSON keys the committed wallet used: `network`, `seedHex`,
`nightSecretKeyHex`, `address`) with a freshly generated `seedHex`; where the Midnight wallet tooling
needed to derive `nightSecretKeyHex`/`address` from the seed is unavailable in-tree, the generator
SHALL fail with an actionable message naming the required tool rather than emit a malformed file. The
`.gitleaks.toml` allowlist (G18) SHALL cover the `.example` template path and the historical wallet
path, and no other.

#### Scenario: No live secret is tracked; a template and generator replace it
- **WHEN** the repository tree is inspected at the 1.0.0 tag
- **THEN** `nix/midnight-env/test-wallets/preview-test-wallet.json` SHALL NOT be a tracked file
- **AND** a `preview-test-wallet.example.json` with non-secret placeholder values SHALL be present
- **AND** a `generate-test-wallet.sh` generator (with a faucet-refund note) SHALL be present
- **AND** `.gitignore` SHALL exclude a locally generated `preview-test-wallet.json`

#### Scenario: The generator produces a wallet file matching the example field shape
- **WHEN** `generate-test-wallet.sh` is run in an environment with the Midnight wallet tooling it
  names available
- **THEN** it SHALL write a `preview-test-wallet.json` carrying the same JSON keys as the `.example`
  (`network`, `seedHex`, `nightSecretKeyHex`, `address`) with a freshly generated `seedHex`
- **WHEN** the required wallet tooling is not available
- **THEN** the generator SHALL fail with an actionable message naming the required tool rather than
  emit a malformed wallet file

### Requirement: The wallet-secret remediation performs no git-history rewrite (G19)

The wallet-secret remediation SHALL be forward-only: it SHALL NOT rewrite git history (no `git
filter-repo` / BFG), because the committed key is verified valueless Preview testnet material. The
remaining permanence of the old key in history SHALL be accepted and noted, with the go-forward
guard being the full-history gitleaks gate (G18, with the historical path allowlisted) rather than a
history rewrite.

#### Scenario: The remediation is a forward-only commit, not a history rewrite
- **WHEN** the remediation change is applied
- **THEN** it SHALL be an ordinary forward commit (untrack + `.example` + generator + allowlist)
- **AND** no git-history-rewriting operation SHALL be performed
- **AND** the gitleaks gate SHALL be the mechanism preventing any *future* secret commit
