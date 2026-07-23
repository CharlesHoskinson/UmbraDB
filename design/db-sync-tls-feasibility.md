# Feasibility: TLS for the Cardano db-sync database (Midnight partner-chain follower)

**Branch:** `feature/db-sync-tls`
**Status:** feasibility **CONFIRMED and demonstrated** end-to-end on Preprod.
**Scope:** whether the PostgreSQL database that `cardano-db-sync` populates — and that the
Midnight node reads as its partner-chain "db-sync main chain follower" / "candidates data
source" — can be given a TLS endpoint. It can. This document records the driver, the evidence,
the options, and how to fold it into `nix/midnight-env`.

## 1. Driver — why this is now mandatory

The Midnight node reads Cardano chain state from the `cexplorer` database that `cardano-db-sync`
writes. As of the ledger‑8 line (observed on `midnightntwrk/midnight-node:2.0.0-rc.3`,
`Version: 2.0.0-aa657015`), the node **requires** a TLS connection to that database. Two node
config options make this explicit (dumped by the node at startup):

```
NAME:  allow_non_ssl
HELP:  Deprecated: plaintext database connections are no longer permitted.
       This flag is ignored — all connections use TLS. It will be removed in a future release.

NAME:  ssl_root_cert
HELP:  Path to SSL root certificate for database connections.
       When set, connections use PgSslMode::VerifyFull (certificate + hostname validation).
       When absent, connections use PgSslMode::Require (encrypted but no certificate validation).
```

Against a plaintext Postgres the node aborts at startup:

```
error: Service(Application("Failed to create db-sync main chain follower: Could not connect to
database; error: error occurred while attempting to establish a TLS connection: server does not
support TLS"))
```

There is **no node-side opt-out** — `allow_non_ssl` is explicitly ignored. The only place the
requirement can be satisfied is the database endpoint.

## 2. What the Cardano side does (and does not) provide

Per the official `cardano-db-sync` documentation
(`IntersectMBO/cardano-db-sync`, `doc/docker.md`), db-sync's own connection to Postgres is
configured through `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`POSTGRES_DB`, or a `PGPASSFILE` (preferred with Docker secrets; it takes precedence over the
individual env vars). **The documentation describes no `sslmode`/TLS option** — db-sync connects
with plaintext credentials over a libpq connection and does not itself negotiate TLS in the
documented Docker path.

Consequence for us: the TLS requirement is entirely a **Midnight-node → Postgres** concern, not a
db-sync one. Enabling TLS on the Postgres server is **non-breaking for db-sync** because
`ssl = on` in PostgreSQL is *permissive*, not *forcing*: it makes the server offer TLS to clients
that ask for it (the node, with `PgSslMode::Require`) while still accepting the plaintext
connections db-sync opens (unless `pg_hba.conf` is separately tightened to `hostssl`). This is the
key insight that makes the change safe to apply to an already-synced db-sync stack.

## 3. Feasibility — demonstrated

Target: the running Preprod stack's `postgres:17.2-alpine` container
(`cardano-db-sync-preprod-postgres-1`, `PGDATA=/var/lib/postgresql/data`, volume-backed).

Steps (idempotent; see `nix/midnight-env/scripts/enable-db-sync-tls.sh`):

1. Generate a self-signed server certificate + key in `PGDATA` (`CN=postgres`, SAN
   `DNS:postgres,DNS:localhost,IP:127.0.0.1`), `chmod 600` the key, `chown postgres`.
2. Append to `postgresql.conf`:
   ```
   ssl = on
   ssl_cert_file = 'server.crt'
   ssl_key_file  = 'server.key'
   ```
3. Restart Postgres (a restart, not just reload, to bring SSL up cleanly).

**Evidence — server offers TLS:**
```
$ psql 'host=127.0.0.1 user=postgres dbname=cexplorer sslmode=require' \
       -tAc "SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid();"
ssl_in_use=true | cipher=TLSv1.3
SHOW ssl; -> on
```

**Evidence — the Midnight node now connects over TLS** (previously fatal, now succeeds):
```
Database connection SSL mode: Require
DB-sync startup probe: latest_tip=present (3 ms), block_lookup=confirmed (7 ms).
```

The node advances past the db-sync connection that used to abort it. TLS feasibility is therefore
**not theoretical** — the node's partner-chain follower connected and read the synced Cardano tip
over a TLS 1.3 channel.

> Note: a *separate*, non-TLS blocker remains for actually running the node against current
> Preprod — `2.0.0-rc.3` panics initializing the Preprod genesis
> (`expected 'midnight:ledger-state[v18]', got 'v13'`, self-flagged as a node bug). That is a node
> build / chain-spec versioning issue, orthogonal to this TLS work, and is tracked separately.

## 4. Security postures

| Posture | Node config | Server config | Guarantee | Use when |
|---|---|---|---|---|
| **Require** (this prototype) | `ssl_root_cert` unset → `PgSslMode::Require` | `ssl=on` + self-signed cert | Encryption on the wire; **no** server-identity check (MITM-susceptible) | Node and Postgres on the same trusted Docker network / host; unblocks the node immediately |
| **VerifyFull** | set `ssl_root_cert=/path/rootCA.crt` → `PgSslMode::VerifyFull` | `ssl=on` + cert signed by that root, CN/SAN = the hostname the node dials (`postgres`) | Encryption **and** certificate + hostname validation | Untrusted network segment between node and DB, or production hardening |

For VerifyFull: generate a small local CA, sign the server cert with it (SAN must include the
exact `host=` the node uses — here `postgres`), mount the CA cert into the node container, and set
`ssl_root_cert` to it. The prototype script has a `--ca` mode stub for this.

## 5. Folding into `nix/midnight-env`

- The flake's own db-sync Postgres (whether the Preview `start-stack.sh` local Postgres or a
  Preprod Docker Postgres) should run with `ssl = on` and a cert. Add the cert-generation +
  `postgresql.conf` lines to the Postgres provisioning path.
- The node's `DB_SYNC_POSTGRES_CONNECTION_STRING` needs no `sslmode` parameter — the node ignores
  URL `sslmode` and derives its mode solely from `ssl_root_cert` (present ⇒ VerifyFull, absent ⇒
  Require). Do **not** rely on `?sslmode=disable`; it is silently ignored.
- Keep db-sync's own connection plaintext (documented behavior) unless you also intend to harden
  `pg_hba.conf`; do not switch the server to `hostssl`-only without giving db-sync a TLS client
  config, or you will break ingestion.

## 6. Risks / open items

- **Self-signed = no MITM protection** in Require mode. Acceptable on a single-host Docker network;
  move to VerifyFull for anything else.
- **Cert rotation**: 10-year self-signed cert here for a dev stack; production needs a rotation
  story.
- **`pg_hba.conf` untouched**: server still accepts plaintext (needed by db-sync). If policy
  requires *all* clients to use TLS, split db-sync onto `hostssl` with its own client cert first.
- **Performance**: TLS 1.3 handshake cost is negligible for a long-lived follower connection.

## 7. Verdict

Adding a TLS endpoint to the Cardano db-sync database is **feasible, low-risk, and already
working** for the Require posture that the Midnight node needs, with a clear VerifyFull upgrade
path. The change is non-breaking for `cardano-db-sync` itself. Recommended: land the
`enable-db-sync-tls.sh` prototype into `nix/midnight-env` and wire it into Postgres provisioning,
defaulting to Require on the trusted local network and documenting the VerifyFull steps for
hardened deployments.
