# midnight-env — reproducible PREPROD dev environment

A Nix flake that provisions the exact, empirically-verified Midnight + Cardano
dependency chain used to sync UmbraDB against **Cardano Preprod**:

```
cardano-node 11.0.1  →  cardano-db-sync 13.7.1.0  →  midnight-node 1.0.1 (Ledger 8)
                     →  midnight indexer 4.3.3  +  proof-server 8.1.0   (Docker)
                     backed by system PostgreSQL 18
```

These versions were verified together as a working stack. **Do not upgrade them**
to "make things newer" — reproducibility here means *freezing what works*. Update a
pin only deliberately, then re-verify the whole stack.

---

## 1. Reproducibility contract — what is pinned, and how

Every flake input is pinned to an immutable identifier. The `flake.lock` is
committed (`git ls-files` shows `nix/midnight-env/flake.lock`), so a checkout
resolves byte-identical inputs.

| Input | Kind | Pinned by | Value |
|---|---|---|---|
| `nixpkgs` | flake input | **exact commit rev** (was rolling `nixos-unstable`) | `241313f4e8e508cb9b13278c2b0fa25b9ca27163` |
| `flake-utils` | flake input | **exact commit rev** (was default branch) | `11707dc2f618dd54ca8739b309ec4fc024de578b` |
| `midnight-node-src` | flake input, `flake = false` | commit rev (tag `node-1.0.1`) | `f92fc29684fc088f4591f04777a58c526f3b3828` |
| `midnight-ledger` | flake input | commit rev | `e1edad2d7019e1520d173f3e22e9991903225cef` |
| `midnight-wallet` | flake input | commit rev | `27c5352d760c2450f04cc08651a49aaba3e4081a` |
| `midnight-dapp-connector-api` | flake input | commit rev | `da90f631d45338d640365fb3d868e095130b4d6d` |
| cardano-node 11.0.1 binary | `fetchurl` release tarball | `sha256` | `40e88a543564251338c4888ef79fde51d2306c18b48ac308c9eab3220e3a13f0` |
| cardano-db-sync 13.7.1.0 binary | `fetchurl` release tarball | `sha256` | `2e35bdfe91490acafa030afa07bb9a504a6ed48d8fa5eeb0ecee65b034975b75` |
| midnight-node 1.0.1 binary | `fetchurl` release tarball | `sha256` | `7c911f64e16436e1005832f85b5438d9cfe38857825c21297902b563534fecd9` |
| indexer-standalone 4.3.3 | Docker image | `@sha256:` digest | `03afd079b00bcd229df29a24771439c5e7695c339cd89216d0763ce40731cc4b` |
| proof-server 8.1.0 | Docker image | `@sha256:` digest | `801bbc0340e9e96f16735f77b523f23c7459e3359842f7c79c2c53f4e994d531` |
| PostgreSQL 18 | nixpkgs attr `postgresql_18` | inherited from pinned `nixpkgs` | (from rev above) |

**Audit result: nothing in the flake is left unpinned.** `nixpkgs` and
`flake-utils` were previously on moving branches (their `flake.lock` `locked` rev
was still deterministic, but the *source* URL was not); both are now rev-pinned in
`flake.nix` so `nix flake update` cannot silently move them. The repin does **not**
change resolved packages — the `flake.lock` `locked` revs/narHashes are unchanged;
only the `original` URL form became explicit.

> Note: `midnight-ledger`, `midnight-wallet`, and `midnight-dapp-connector-api` are
> pinned and passed to `outputs`, but are currently only carried for
> reference/future from-source builds — the running stack uses the pinned release
> **binaries** (cardano-node, cardano-db-sync, midnight-node) and the two Docker
> images, not these source flakes.

---

## 2. Host-state assumptions the flake does NOT capture (the real impurities)

The flake makes the *software artifacts* reproducible. It does **not** capture
host/machine state. On a fresh machine you must provide the following yourself;
these are the true impurities:

| Host assumption | Used by | How to satisfy on a fresh machine |
|---|---|---|
| **Docker daemon** running, current user able to `docker run` | `start-stack` / `stop-stack` (indexer + proof-server containers) | Install Docker; ensure the daemon is up and the user is in the `docker` group. Images are digest-pinned, so `docker run` pulls the exact bytes. |
| **System PostgreSQL 18 cluster** `main` at `/var/lib/postgresql/18/main`, managed by `systemctl`/`pg_ctlcluster 18 main`, with a `postgres` OS user | `start-stack` (TLS setup, restart), `backup-state`, `restore-state` | `apt install postgresql-18` (or distro equivalent) so `pg_ctlcluster 18 main` and the `postgres` user exist. The flake provides the `postgresql_18` *client tools* on PATH but does **not** run the cluster — see §5 for why this is intentional. Override the path with `PG_DATA_DIR=`. |
| **Data dirs** `/root/cardano-data` (chain db) and `/root/midnight-node-data` | `start-stack` (created if missing) | Created automatically; ensure the parent is writable and has room for chain data. Override with `CARDANO_DATA_DIR=` / `MIDNIGHT_NODE_DATA_DIR=`. |
| **`~/.midnight-pg-password`** — the midnight-node → cexplorer DB password | `start-stack` (builds `DB_SYNC_POSTGRES_CONNECTION_STRING`) | Create the file containing the DB password for the `midnight` Postgres role. |
| **`~/.pgpass`** (`PGPASSFILE`) — libpq credentials | `start-stack`, `backup-state` | Create a standard `.pgpass` (`host:port:db:user:password`, mode 600) for the `midnight` role on `cexplorer`. |
| **`/etc/ssl/postgres`** — writable system SSL dir for the self-signed TLS cert | `start-stack` step [0] | Created automatically if writable (needs root or an existing writable dir). Override with `DB_TLS_SSL_DIR=`. The Ledger-8 node *mandates* TLS to the DB, so this step is required. |
| **Chain state is machine-local** — the synced Cardano chain db + cexplorer DB are NOT in the flake and NOT in git | everything | A fresh machine has two options: (a) re-sync from **genesis** (multi-hour), or (b) `nix run .#restore-state` from a prior `backup-state` snapshot at `/mnt/c/midnight-state-backup` (override `MIDNIGHT_ENV_BACKUP_DIR=`). No snapshot ⇒ genesis re-sync is unavoidable. |

Additional host tools the scripts shell out to that are **not** provided by the
flake (they are inherently host/service-level): `systemctl`, `pg_ctlcluster`,
`chown`, and the Docker **daemon**. `openssl` *was* such a host dependency; it is
now provided by the flake (see §5).

---

## 3. How to reproduce (exact steps)

```bash
cd nix/midnight-env

# 1. Enter the pinned toolchain (cardano-node, cardano-db-sync, midnight-node,
#    postgres-18 client tools, docker client, jq, rsync, openssl -- all from the
#    pinned nixpkgs). This also builds the three release-binary derivations from
#    their sha256-pinned tarballs.
nix develop

# 2. (fresh machine, first run) restore chain state from a snapshot, or skip to
#    re-sync from genesis:
nix run .#restore-state          # needs a snapshot at $MIDNIGHT_ENV_BACKUP_DIR

# 3. Launch the full stack. RECOMMENDED reproducible entry point:
nix develop -c bash scripts/start-stack.sh

#    ...then later:
nix develop -c bash scripts/stop-stack.sh
nix develop -c bash scripts/backup-state.sh   # snapshot progress
```

### Why `nix develop -c bash scripts/start-stack.sh` and not `nix run .#start-stack`

Both do the same work. But the `apps` (`nix run .#start-stack` etc.) wrap each
script with `pkgs.writeShellApplication`, which runs **ShellCheck at build time**.
On a machine where ShellCheck is not in the binary cache, that triggers a
**from-source ShellCheck build** (slow/flaky). Running the script through the
dev shell skips that build entirely while using the exact same pinned tools, so it
is the more reproducible entry point.

The **running binaries come from the nix store**: after `nix develop` (or
`nix build .#cardano-node-bin .#cardano-db-sync-bin .#midnight-node-bin`), the
`result*/bin` symlinks and the dev-shell PATH point at the store paths built from
the sha256-pinned tarballs. `result*` symlinks are git-ignored.

---

## 4. Validation performed

- `nix flake metadata` — resolves; all inputs show immutable revs/narHashes.
- `nix eval .#packages.x86_64-linux --apply builtins.attrNames` →
  `[ "cardano-db-sync-bin" "cardano-node-bin" "default" "midnight-node-bin" ]`.
- After the repin, the `flake.lock` `locked` rev for `nixpkgs`
  (`241313f4…`) and `flake-utils` (`11707dc2…`) are **unchanged**; only the
  `original` URL form gained the explicit `rev`. Same rev ⇒ same packages.

(Heavy `nix flake check` / from-source app builds are intentionally not run here —
they would pull ShellCheck from source.)

---

## 5. Impurity reduction vs. documented-as-known

**Reduced (safe, no version change):** `openssl` — used by `start-stack` step [0]
to generate the self-signed Postgres TLS cert — was previously resolved from host
PATH. It is now added to both the dev shell `buildInputs` and the script
`runtimeInputs`, so it resolves from the pinned `nixpkgs`. This changes no verified
version and only affects which `openssl` binary the cert step invokes.

**Documented as known host assumptions (NOT changed — changing them would risk the
verified stack):**

- **System PostgreSQL 18 cluster.** The scripts drive a *system* cluster
  (`pg_ctlcluster 18 main`, `systemctl`, the `postgres` OS user, `/var/lib/postgresql/18/main`).
  Re-pointing them at a flake-managed ephemeral Postgres would change the storage
  layout, socket path, auth, and TLS wiring that the verified sync depends on —
  out of scope for a reproducibility pass. Documented in §2 instead.
- **Docker daemon** (indexer/proof-server) — daemon is host infrastructure; only
  the images are pin-able, and they already carry `@sha256:` digests.
- **`systemctl`, `pg_ctlcluster`, `chown`** — service-manager / OS-user
  operations that have no nix-store equivalent.
- **Chain state** — machine-local synced data; reproduced via `restore-state`
  from a snapshot or a genesis re-sync, not via the flake.
