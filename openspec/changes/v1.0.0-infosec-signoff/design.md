# Design — v1.0.0-infosec-signoff

Implementation-level detail for gate items **G15–G19** (`ROADMAP-v1.0.0-CONSOLIDATED.md` §E),
grounded in the live tree at `/root/UmbraDB` and the two InfoSec reports' file:line evidence
(`04-infosec-codebase.md`, `05-infosec-infra.md`), adjudicated by `council/C-security.md`. Every
requirement below is either a documentation artifact or a CI/config change; **no `src/` runtime
code changes** (the one interface edit, G16, is doc-comment-only). This is a deliberate
consequence of the council's central ruling — the dedup-oracle and plaintext-key items are
**documentation obligations for 1.0.0, not code changes** (`council/C-security.md` §5).

## 0. Scope boundary and what this change does NOT touch

Per `council/C-security.md` §4 ("Explicitly NOT required for the tag"), the following are P1
fast-follows and are **out of this change**, tracked separately: keyed/scoped chunk-addressing
flag; the `EnvelopeCipher` seam; the de-stubbed VerifyFull flow's *default flip* (we de-stub the
path but keep `Require` default); the two-role Postgres topology; restore-integrity verification;
the checkpoint total-size cap. The application-input hardening (F3 `walletId`/`networkId`
validation; F4 JSON depth bound) is a 1.0.0 sign-off code fix but is **owned by G8** (the
contract-integrity change), not here.

## 1. G15 — `SECURITY.md` / threat-model document

**Approach.** A single `SECURITY.md` at the repo root, linked from `README.md`, is the
authoritative statement of the trust model. It is not a footnote or a `design/` doc — the council
identifies "a deployer over-trusting boundaries the code never enforces" as *the* acute InfoSec
risk, and the doc removing it is the single cheapest, highest-value 1.0.0 action
(`04-infosec-codebase.md` §10 P0; `council/C-security.md` §1, §4).

The document MUST state each of the following as an explicit, binding assumption (source
citations are the reports' verified T-A1…T-A4 and the code lines they rest on):

1. **Single trusted writer (T-A1).** One trusted process holds the connection and drives all
   reads/writes; there is no adversarial *caller*; all API consumers share one trust domain.
   Grounded at `src/postgres/transaction-lease.ts:328` ("single-writer deployment model") and the
   design docs (`04-infosec-codebase.md` §2 T-A1).
2. **Trusted Postgres + operator (T-A2).** The DB role owns every schema it touches; Postgres,
   its disk, backups, and replicas are trusted (`04-infosec-codebase.md` §2 T-A2).
3. **`schema` is namespacing, NOT a security or tenant boundary (T-A3 / F5).** All queries run
   under one role that owns every schema; a caller can point any adapter at any schema — stopped
   only by T-A1, not by the library (`04-infosec-codebase.md` §8, F5;
   `src/postgres/client.ts` schema handling). Real multi-tenancy, if ever needed, must be
   enforced at the Postgres level (role-per-tenant + `GRANT`, or RLS), never in this library.
4. **The chunk pool is ONE global trust domain with an observable side channel.** Chunk storage
   is global and content-addressed (`src/postgres/checkpoint-store.ts:156-162`,
   `ON CONFLICT (hash) DO UPDATE SET created_at = now()`); chunk *existence* is observable via
   `save` latency (first-time 4 MiB `bytea` write vs. metadata-only `ON CONFLICT` no-op) and GC
   behavior is observable via `prune`'s cross-wallet-dependent `reclaimedBytes`
   (`src/postgres/checkpoint-store.ts:397-411`). This is the Harnik–Pinkas–Shulman-Peleg cross-user
   dedup side channel (`04-infosec-codebase.md` §6). The doc MUST state: placing
   mutually-distrusting principals on one store is an **unsupported** deployment; "multiple
   wallets" means one user's wallet app (one trust domain), not multi-tenancy. It MUST also state
   the practical bound the council established: chunking is **fixed-size** (`splitChunks(data,
   chunkSize)`, default 4 MiB), **not** content-defined, so the leak degenerates to
   "confirm a fully-known 4 MiB-aligned chunk exists," not sub-field extraction — a genuine but
   narrow confirmation-of-file leak (`council/C-security.md` §3.2).
5. **NO at-rest encryption — a binding deployer precondition.** The library provides no
   encryption hook; the envelope path stores plaintext (`encode()` =
   `TextEncoder().encode(JSON.stringify(...))`, `src/interfaces/wallet-state-envelope.ts:142`) →
   plaintext `bytea` chunks. For a Midnight shielded wallet these bytes are spending-key /
   coin-secret material (T-A4). The doc MUST state, as a **binding precondition** (not a
   footnote): a deployer persisting secret-bearing payloads MUST provide storage/backup encryption
   (encrypted disk / Postgres TDE / encrypted backups) **or** pass ciphertext to `save`
   (the `Uint8Array` API already accepts ciphertext — `council/C-security.md` §2 notes the
   byte-opaque `save` *is* a seam; the gap is only the envelope path). CWE-312
   (`04-infosec-codebase.md` §7, F2).

The document additionally carries a **commit-policy section** ("what may and may not be committed":
no key with any value, ever; the one allowlisted testnet wallet, with justification; all
password/seed files `chmod 600`, generated not committed) — the `SECURITY.md` half of G18/G19
(`05-infosec-infra.md` §5.3). And a **reporting section** (how to report a vulnerability) so the
file doubles as a conventional GitHub `SECURITY.md`.

**Non-goal restated in the doc.** It MUST name the P1 fast-follows it does *not* implement (keyed
chunk addressing → 1.1; `EnvelopeCipher` seam; VerifyFull default; two-role topology) so a reader
does not mistake a documented precondition for an implemented control.

## 2. G16 — CheckpointStore cross-wallet dedup interface-doc rewrite

**Approach.** Rewrite the doc comments in `src/interfaces/checkpoint-store.ts` — **comments only,
no signature, type, or behavior change** — so the advertised cross-wallet dedup carries the
side-channel caveat. Three doc sites (verified in the live file):

- The `CheckpointStore` interface doc block: currently "chunk storage is a single GLOBAL pool,
  deduplicating against every prior checkpoint for the same wallet+network **and across
  wallets**" and "may physically delete a chunk only when **no manifest anywhere in the store**
  references it." The council's §3 ruling makes this doc rewrite a **1.0.0 BLOCKER**: the doc must
  now state that the pool is one *shared trust domain*, that chunk existence and GC behavior are
  **observable across wallets** (timing + reclaim counts), and that mutually-distrusting
  principals on one store is unsupported — cross-referencing `SECURITY.md`.
- The `PruneResult.reclaimedChunks` doc: it already notes "a chunk still referenced by another
  wallet's manifest is never reclaimed"; extend it to name this as a **cross-wallet reference-state
  side channel** (the return value leaks whether *another* wallet still references the chunk), not
  merely a functional caveat.
- The `prune` method doc ("the chunk reclamation decision never is [wallet+network-scoped]"):
  add the caveat cross-reference.

**Grounding & non-goal.** The *mechanism* is unchanged (`src/postgres/checkpoint-store.ts:156-162`
insert/dedup; `:397-411` grace-window global `DELETE` returning `reclaimedBytes`). No keyed
addressing is introduced — that is the P1/1.1 code fast-follow the council explicitly separates
from this doc obligation (`council/C-security.md` §3, §5). The rewrite MUST NOT weaken any existing
accurate statement — it *adds* the trust-domain framing. The two pre-existing caveats the diff
review MUST confirm survive (enumerated so acceptance B4 is objectively checkable) are: (1) the Law
C2a/C2b grace-window sentence — a chunk is physically deleted only after its post-unreference grace
window elapses; and (2) the `reclaimedChunks` "count can be zero even when many checkpoints were
pruned" sentence. Both must remain present verbatim-in-substance after the rewrite.

## 3. G17 — TLS caveat surfaced + VerifyFull/`--ca` de-stubbed

**Current state (verified).** `nix/midnight-env/scripts/enable-db-sync-tls.sh` provisions a
**self-signed** cert (`openssl req -new -x509 -days 3650 -nodes`, `CN=$DB_TLS_CN` default
`postgres`, SAN `DNS:postgres,DNS:localhost,IP:127.0.0.1`), sets `ssl = on`, and leaves the node's
`ssl_root_cert` unset ⇒ `PgSslMode::Require` (encrypted, **no** cert/hostname validation). The
`--ca`/VerifyFull path exists only as a trailing **echo stub** ("For VerifyFull, sign the cert with
a local CA …"). There is **no** `nix/midnight-env/README.md` today (only `test-wallets/README.md`)
— so surfacing the caveat "in the README" means creating that README.

**Approach — three parts, matching `05-infosec-infra.md` §4.4 and `council/C-security.md` §3
(S3), the council adopting the infra verdict wholesale:**

1. **Surface the caveat at point of use.** Create `nix/midnight-env/README.md` with a prominent
   **Security** note next to the `enable-db-sync-tls.sh` / `start-stack.sh` usage: `Require` +
   self-signed = **encryption only, no server-identity validation**; it does NOT prevent an active
   on-host MITM from impersonating the Postgres endpoint and harvesting the `cexplorer` DB
   credentials; safe **only** when node and Postgres are co-located on one trusted host. For any
   multi-host / untrusted-segment deployment, use **VerifyFull**. State VerifyFull + pinned CA as
   the *recommended* posture for anything non-localhost (CIS PostgreSQL). This lifts the analysis
   already in `design/db-sync-tls-feasibility.md` out of `design/` and into the README at the point
   an operator actually runs the script.
2. **De-stub the real VerifyFull/`--ca` path.** Replace the trailing echo with a real one-flag
   flow in `enable-db-sync-tls.sh`: a `--ca` mode that (a) generates a local CA, (b) signs the
   server cert with SAN = the exact `host=` the node dials (the existing `$DB_TLS_CN`/`$DB_TLS_SANS`
   inputs), (c) emits the CA cert to a known path and prints the exact `--ssl_root_cert` the node
   must be given. It MUST be a single flag switch (e.g. `enable-db-sync-tls.sh --ca <container>`),
   not a manual multi-step recipe. `chmod 600 server.key` / `chown postgres:postgres` discipline
   (already present) is preserved; the CA key gets the same `600` treatment.
3. **KEEP the localhost `Require` default.** No default change. The council and infra report both
   reject forcing VerifyFull as the shipped default — CA-management friction pushes users to
   `rejectUnauthorized:false`-style escapes, which is strictly worse (`05-infosec-infra.md` §4.4,
   §10; `council/C-security.md` §5). The default path (no `--ca`) MUST provision the **same
   artifacts and posture** as before this change — the same self-signed certificate parameters, the
   same `ssl = on` / `Require` server configuration, and the same `server.key` `0600` permissions —
   so an existing localhost user sees no change to what is provisioned. The invariant is scoped to
   *provisioning semantics*, **not** byte-identity of the script's stdout: because the current
   VerifyFull stub is the script's trailing echo on the default path, de-stubbing it necessarily
   changes some *informational* default-path output, and that informational-only delta is the sole
   permitted difference. (A literal "byte-for-byte output" reading would make de-stubbing and
   default-preservation mutually unsatisfiable — the reason acceptance C3 and requirement wording
   are scoped to artifacts + posture, not stdout bytes.)

## 4. G18 — Supply-chain CI gate

**Current state (verified).** The one existing merge gate (`.github/workflows/conformance.yml`)
already uses `npm ci` and pins actions by commit SHA — good, but it runs *tests only*; there is
**no** `npm audit`, no `.npmrc`, no secret scan, no container CVE scan, no flake-lock check
(`05-infosec-infra.md` §2.4, §8 F2). The hygiene is good *by luck of a fresh install* (307/307
registry+integrity, zero install scripts, fully pinned flake); the job is to enforce it.

**Approach.** Add a `.github/workflows/supply-chain.yml` (blocking on `pull_request` + `push` to
`main`, plus a `schedule:` for the image scan), and two committed config files. Six sub-gates,
each mapped to a requirement:

1. **`npm ci` everywhere (never `npm install`)** — enforces the lockfile + integrity hashes; a
   tampered tarball hard-fails. (Reuse the pattern already in `conformance.yml`; the supply-chain
   workflow re-asserts it as an explicit gate step.)
2. **Blocking `npm audit --audit-level=high --omit=dev`** — runtime-scope, blocking; plus a
   *non-blocking* full `npm audit` for dev visibility. Runtime deps are only `postgres` + `zod`
   (`package.json`), so the runtime scope is tiny and stable; the blocking gate will not
   false-positive on the large dev graph (Testcontainers/vitest/etc.).
3. **`.npmrc` with `ignore-scripts=true`** — a committed repo-root `.npmrc`. Since the tree has
   zero install scripts today, this is a cheap lock-in: a *future* malicious transitive install
   script cannot execute (`05-infosec-infra.md` §2.4). The CI gate MUST assert the `.npmrc` is
   present and sets `ignore-scripts=true` (a config-drift guard). **Caveat (Opus audit note 1):** a
   repo-root `ignore-scripts=true` suppresses *this* package's own `prepare`/`postinstall` lifecycle
   hooks too, not only dependencies'. Any build/typecheck the release depends on (e.g. `.d.ts` emit
   from the G1 packaging work) MUST therefore be an **explicit** CI step, never a lifecycle hook —
   the workflow already runs `typecheck` explicitly; task 3.1's dry-run confirms no needed hook is
   silently skipped by the new `.npmrc`.
4. **`gitleaks`** — **full git-history** secret scan (`gitleaks detect`, the default mode),
   blocking. Configured via a committed `.gitleaks.toml` whose **allowlist** is path-scoped to
   exactly **two** artifacts: the historical `preview-test-wallet.json` path and the
   `preview-test-wallet.example.json` placeholder — each with a justification comment. This is the
   scan-mode/allowlist-scope pairing the un-rewritten history forces (Fable audit B2): because G19
   performs **no** history rewrite, the old `seedHex`/`nightSecretKeyHex` remain permanently in
   history, so a full-history scan *will* re-encounter them — the allowlist must therefore cover the
   historical path, not only the `.example`. A working-tree-only scan (`--no-git`) would let the
   allowlist shrink to just the `.example`, but at the cost of never scanning history for *other*
   leaked secrets; the council's intent (`05-infosec-infra.md` §5.1 "this one file explicitly
   allowlisted"; roadmap G18 "committed wallet file allowlisted") is the stronger full-history scan,
   so that is what is specified. Any *real* secret on any other path — working tree or history —
   fails the gate.
5. **`trivy image --severity HIGH,CRITICAL`** on **both** digest-pinned images
   (`midnightntwrk/indexer-standalone:4.3.3@sha256:03afd079b00bcd229df29a24771439c5e7695c339cd89216d0763ce40731cc4b`
   and `midnightntwrk/proof-server:8.1.0@sha256:801bbc0340e9e96f16735f77b523f23c7459e3359842f7c79c2c53f4e994d531`,
   verified in `nix/midnight-env/flake.nix:108-109` and `start-stack.sh:115-119`). Digest-pinning
   guarantees immutability, **not** absence of CVEs — a pinned-but-vulnerable base would otherwise
   never be noticed (`05-infosec-infra.md` §6.1, §8 F5). Run on a `schedule:` (weekly) plus
   `workflow_dispatch` so a newly-disclosed CVE surfaces without a code change; results surfaced in
   the job summary. **The scan targets MUST be derived from — or asserted equal to — the `flake.nix`
   pins** (Fable audit non-blocking 7), so a digest bump in `flake.nix` cannot silently diverge from
   what Trivy actually scans (e.g. read the two references out of `flake.nix`, or assert the
   workflow's hard-coded references match the `flake.nix:108-109` lines in a cheap grep step).
   Whether this job *blocks* or *reports* is a policy choice recorded in the workflow (scheduled scan
   reports; the digests only change on a deliberate bump, so a blocking PR gate would fire only when
   the pins move).
6. **`flake.lock` change-control check** — a CI step that closes the floating-`nixpkgs`-ref window
   (`05-infosec-infra.md` §3, §8 F9). **The property being gated is "an accidental/unreviewed `nix
   flake update` cannot land unreviewed"** — and the naive "no-op re-lock produces no diff" check
   does **not** achieve it (Fable audit B3): an already-committed `nix flake update` yields a
   *self-consistent* lock, so `nix flake lock` produces no diff and the check passes, letting the
   update through. (A no-op re-lock only catches flake.nix-inputs/lock *inconsistency* — floating
   refs that never got locked — not a committed lock roll-forward.) So the check is implemented as
   **lock-change control**: compare the PR's `flake.lock` against the same file on the PR **base
   branch** (`git diff` against the merge base) and fail IF they differ **UNLESS** the PR carries an
   explicit `flake-lock-update` label. This directly meets the acceptance criterion, needs **no Nix
   toolchain** in CI (pure `git diff` + a PR-label read), and makes every lock change a deliberate,
   reviewable event. (A complementary inputs/lock-consistency check — option (i), `nix flake lock`
   no-op — could be added later but requires Nix in CI and gates a different, weaker property; it is
   not what 1.0.0 needs.)

**Grounding.** Exactly the gate the council requires (`council/C-security.md` §4 item 6, §5
"No supply-chain gate: BLOCKER"). No new runtime dependency; all tooling is CI-side.

## 5. G19 — Replace the committed Preview wallet secret

**Current state (verified).** `nix/midnight-env/test-wallets/preview-test-wallet.json` commits
`seedHex` (`7a24a29c…6e65`) and `nightSecretKeyHex` (`d8ba476c…93a8`) for a Preview testnet
wallet; `test-wallets/README.md` documents it as deliberate (tDUST has no monetary value). The
council and infra report both verify it is **valueless** and rule: **replace the pattern, no
history rewrite** (`council/C-security.md` §5 S4; `05-infosec-infra.md` §5.1, §10).

**Approach.**

1. **Untrack the live secret; ship a template + generator.** Remove
   `preview-test-wallet.json` from the tree (via `git rm --cached` + `.gitignore` so a locally
   generated one is never re-committed) and add:
   - `preview-test-wallet.example.json` — the **same field shape** as the committed wallet (the JSON
     keys `network`, `seedHex`, `nightSecretKeyHex`, `address`) with **placeholder**
     `seedHex`/`nightSecretKeyHex` (clearly non-secret, e.g. `"0".repeat(64)` or an explicit
     `REPLACE_ME`-style marker) and a comment field pointing at the generator.
   - `generate-test-wallet.sh` — generates a fresh Preview wallet locally (writing the untracked
     `preview-test-wallet.json`) with a faucet-refund note (`https://faucet.preview.midnight.network/`).
     **Definition of a "valid" produced file** (Fable audit non-blocking 6): it carries the same four
     keys as the `.example` with a freshly generated `seedHex`, and the derived `nightSecretKeyHex`/
     `address` are produced by the Midnight wallet SDK tooling the repo already depends on (named in
     a script comment; the repo carries a `@midnightntwrk/wallet-sdk-*` dev dependency). Deriving
     those fields from a seed is not possible without that tooling, so the generator MUST **fail with
     an actionable message naming the required tool** when it is unavailable in-tree, rather than
     emit a malformed file — the objective, checkable contract, avoiding an over-claim that the
     script can always synthesize a fully-derived wallet in any environment.
   So no live secret is tracked; a fresh machine runs the generator + faucet once.
2. **gitleaks allowlist (pairs with G18).** The `.gitleaks.toml` allowlist is path-scoped to **two**
   paths — the `.example` template AND the historical `preview-test-wallet.json` path — each with a
   comment explaining why (Fable audit B2). The historical path must be allowlisted because the
   full-history scan (§4 item 4) re-encounters the old secret that G19 deliberately does **not**
   rewrite out of history; the `.example` is allowlisted for its placeholder. This converts "we trust
   the README warning" into "a real seed cannot be committed anywhere else" (`05-infosec-infra.md`
   §5.1).
3. **Strengthen the README + `SECURITY.md` policy.** `test-wallets/README.md` gains the
   generator/`.example` instructions and a strengthened warning; the commit-policy section of
   `SECURITY.md` (G15) states "no key with any value, ever, in git" and names this one allowlisted
   testnet artifact with justification.
4. **NO git-history rewrite.** The committed key is valueless; `git filter-repo`/BFG is
   disproportionate and out of scope (`council/C-security.md` §5; `05-infosec-infra.md` §5.1). The
   `.example`+generator change is forward-only.

## 6. Non-goals & boundaries respected (summary)

- **Indexer-agnostic boundary honored.** Nothing here imports or depends on a consumer/indexer app
  (`ROADMAP` G11; the persistence code stays indexer-agnostic).
- **No `src/` runtime behavior change.** G16 is doc-comment-only; G15/G17/G18/G19 are docs, CI,
  Nix scripts, and test-wallet tooling. The frozen public API surface (G1) is unaffected by this
  change.
- **Council rulings honored verbatim:** dedup-oracle → documentation (G15+G16), keyed chunking is
  1.1; plaintext-key → documented binding precondition (G15), `EnvelopeCipher` is P1; TLS →
  surface + de-stub, **keep the localhost default**; committed wallet → `.example`+generator+
  allowlist, **no history rewrite**; supply-chain gate → the six-part blocking gate.

## Audit resolution

Two audits were applied: **Fable** (verdict REVISE — 3 blocking, 8 non-blocking) and **Opus**
(verdict APPROVE — 0 blocking, 3 non-blocking notes). Every blocking finding is resolved; every
non-blocking finding is applied (none rejected). Disposition per finding:

**Fable — blocking (all resolved):**

- **B1 — G17 "byte-for-byte" default contradicts de-stubbing the trailing echo.** Resolved. The
  trailing VerifyFull stub runs on the default path, so replacing it necessarily changes default
  stdout; a literal byte-for-byte-output invariant was unsatisfiable. The G17 localhost-default
  requirement, its scenario, design §3 part 3, task 2.3, and acceptance C3 are all rescoped to
  **provisioning semantics** (same self-signed cert parameters, same `ssl = on`/`Require` config,
  same `0600` key permissions) with informational output as the sole permitted delta. The EARS form
  was also changed from WHERE to WHEN (E1/E5, Opus note 3) in the same edit.
- **B2 — gitleaks allowlist trips on un-rewritten history; scan mode unspecified.** Resolved. The
  gitleaks requirement now pins the scan mode to **full git-history `gitleaks detect`** and sizes the
  allowlist to that scope: it covers **both** the historical `preview-test-wallet.json` path (which
  persists in history because G19 does no rewrite) and the `.example` placeholder — no other path.
  Updated across the requirement + two scenarios, design §4 item 4 and §5 item 2, tasks 3.5/4.1/4.2,
  and acceptance D4/E3. The incorrect design assertion "the removed live file is no longer present to
  match" was deleted.
- **B3 — flake.lock-freeze requirement near-vacuous; sketched check misses its own acceptance.**
  Resolved by choosing property (ii) **lock-change control**: compare the PR's `flake.lock` against
  the base branch and fail on any diff unless a `flake-lock-update` label is present — which actually
  meets "an accidental/unreviewed `nix flake update` cannot land unreviewed," needs no Nix toolchain,
  and is objectively checkable. The requirement, its three scenarios, design §4 item 6, task 3.4, and
  acceptance D6 are aligned, and D6/task 3.4 carry a concrete three-PR dry-run procedure.

**Fable — non-blocking (all applied):**

1. T1: tasks §3 heading corrected from "3.4 depends on 4.1" to "3.5 depends on 4.1".
2. A6 vulnerability-reporting section now traces to a spec requirement — folded into the G15 "commit
   policy and a vulnerability-reporting section" requirement (acceptance A6, task 0.5).
3. Compound requirements split: npm-ci vs `.npmrc`+assert (two G18 requirements); commit-policy vs
   fast-follow disclaimer (two G15 requirements). Also satisfies Opus note 2.
4. The two-case gitleaks scenario is split into two scenarios.
5. D3 (npm audit) no longer asserts an unverified counterfactual: it is met by inspection of the
   blocking `--omit=dev` step + clean-tree pass, with an optional scratch-branch advisory-injection
   procedure documented as the way to evidence the counterfactual (task 3.2, acceptance D3).
6. "Valid Preview wallet file" is defined (four-key field shape matching the `.example`, fresh
   `seedHex`, SDK-derived `nightSecretKeyHex`/`address`) with the generator required to fail with a
   named-tool message when the wallet tooling is unavailable — acknowledging the in-tree feasibility
   limit rather than over-claiming (requirement, task 4.1, acceptance E2, design §5).
7. Docker digests: the spec now carries the full `@sha256` digests, and the Trivy requirement asserts
   the scan targets equal the `flake.nix` pins so a bump cannot silently diverge (design §4 item 5,
   acceptance D5).
8. G16 preserved-caveat strings are enumerated (the Law C2a/C2b grace-window sentence and the "count
   can be zero…" sentence) in the spec scenario, design §2, and acceptance B4, so B4 is objectively
   checkable.

**Opus — non-blocking (all applied):**

1. `.npmrc ignore-scripts=true` also suppresses this package's own lifecycle hooks — design §4 item 3
   and task 3.1 now require any needed build/typecheck to run as an explicit CI step and the dry-run
   to confirm no needed hook is silently skipped.
2. Atomicity split — done (see Fable non-blocking 3).
3. WHERE→WHEN on the localhost-default requirement — done (see B1).

**Rejected: none.** All 3 blocking and all 11 non-blocking findings across both audits were applied.
