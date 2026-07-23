#!/usr/bin/env bash
# Launch the full turnkey PREPROD stack:
#   cardano-node -> cardano-db-sync -> midnight-node (compiled 1.0.1 binary, Ledger 8)
#   -> indexer/proof-server (pinned Docker images), using the bundled preprod config.
#
# PREPROD, not Preview (networkMagic 1, k=2160). midnight-node is pinned to 1.0.1 -- the
# Ledger-8 line that Preprod/Mainnet actually run. The 2.x/Ledger-9 line is a binary-only
# fresh-chain dev line and CANNOT join Preprod (it expects ledger-state v18; the preprod
# genesis is v13, with no 8->9 migration) -- see flake.nix.
#
# TLS: the Ledger-8+ midnight-node MANDATES a TLS connection to the cexplorer DB
# (`allow_non_ssl` is deprecated/ignored). Step [0] gives the local Postgres a TLS endpoint
# before anything connects. See design/db-sync-tls-feasibility.md.
set -euo pipefail

FLAKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="$FLAKE_DIR/config"
CARDANO_DATA="${CARDANO_DATA_DIR:-/root/cardano-data}"
MIDNIGHT_NODE_DATA="${MIDNIGHT_NODE_DATA_DIR:-/root/midnight-node-data}"
LOG_DIR="${MIDNIGHT_ENV_LOG_DIR:-/root/midnight-env-logs}"
PG_DATA_DIR="${PG_DATA_DIR:-/var/lib/postgresql/18/main}"
export PGPASSFILE="${PGPASSFILE:-$HOME/.pgpass}"

mkdir -p "$CARDANO_DATA/db" "$MIDNIGHT_NODE_DATA" "$LOG_DIR"

echo "==> [0/4] Ensuring the db-sync Postgres has a TLS endpoint (Ledger-8 node requires it)"
# Self-signed cert + ssl=on for the local cluster. Certs live OUTSIDE PGDATA so initdb on a
# fresh cluster is unaffected. `ssl=on` is permissive (does not force TLS), so cardano-db-sync's
# own plaintext connection keeps working. VerifyFull: sign with a CA and set the node's
# --ssl_root_cert (see design/db-sync-tls-feasibility.md).
SSL_DIR="${DB_TLS_SSL_DIR:-/etc/ssl/postgres}"
if [ ! -f "$SSL_DIR/server.key" ]; then
  mkdir -p "$SSL_DIR"
  openssl req -new -x509 -days 3650 -nodes -text \
    -out "$SSL_DIR/server.crt" -keyout "$SSL_DIR/server.key" \
    -subj "/CN=127.0.0.1" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
  chmod 600 "$SSL_DIR/server.key"
  chown postgres:postgres "$SSL_DIR/server.crt" "$SSL_DIR/server.key" 2>/dev/null || true
  echo "    generated self-signed cert in $SSL_DIR"
fi
CONF="$PG_DATA_DIR/postgresql.conf"
if [ -f "$CONF" ] && ! grep -q '^ssl = on' "$CONF"; then
  {
    echo ""
    echo "# --- db-sync TLS endpoint (feature/db-sync-tls) ---"
    echo "ssl = on"
    echo "ssl_cert_file = '$SSL_DIR/server.crt'"
    echo "ssl_key_file = '$SSL_DIR/server.key'"
  } >> "$CONF"
  echo "    appended ssl config to $CONF"
fi
systemctl restart postgresql 2>/dev/null || pg_ctlcluster 18 main restart 2>/dev/null || true

echo "==> [1/4] Starting cardano-node (Preprod)"
nohup cardano-node run \
  --topology "$CONFIG_DIR/preprod/topology.json" \
  --database-path "$CARDANO_DATA/db" \
  --socket-path "$CARDANO_DATA/db/node.socket" \
  --host-addr 0.0.0.0 --port 3001 \
  --config "$CONFIG_DIR/preprod/config.json" \
  > "$LOG_DIR/cardano-node.log" 2>&1 < /dev/null &
disown -h
echo "    cardano-node started, logging to $LOG_DIR/cardano-node.log"

echo "==> Waiting for node socket..."
for _ in $(seq 1 60); do
  [ -S "$CARDANO_DATA/db/node.socket" ] && break
  sleep 2
done

echo "==> [2/4] Starting cardano-db-sync (Preprod)"
nohup cardano-db-sync \
  --config "$CONFIG_DIR/db-sync-config.json" \
  --socket-path "$CARDANO_DATA/db/node.socket" \
  --state-dir "$CARDANO_DATA/db-sync-state" \
  > "$LOG_DIR/cardano-db-sync.log" 2>&1 < /dev/null &
disown -h
echo "    cardano-db-sync started, logging to $LOG_DIR/cardano-db-sync.log"

echo "==> [3/4] Starting midnight-node 1.0.1 (compiled binary, Ledger 8 / Preprod)"
# midnight-node insists on finding res/cfg/default.toml relative to the current working
# directory, not relative to --chain -- must cd into the package's res/ parent dir first.
MIDNIGHT_NODE_SHARE="$(dirname "$(command -v midnight-node)")/../share/midnight-node"
DBPASS=$(cat "$HOME/.midnight-pg-password")
(
  cd "$MIDNIGHT_NODE_SHARE"
  # No ?sslmode in the URL -- the node ignores it and derives its mode from --ssl_root_cert
  # (unset => PgSslMode::Require; set => VerifyFull). The Postgres TLS endpoint from step [0]
  # satisfies Require.
  export DB_SYNC_POSTGRES_CONNECTION_STRING="postgresql://midnight:${DBPASS}@127.0.0.1:5432/cexplorer"
  export CARDANO_SECURITY_PARAMETER=2160
  export CFG_PRESET=preprod
  nohup midnight-node \
    --chain res/preprod/chain-spec-raw.json \
    --base-path "$MIDNIGHT_NODE_DATA" \
    --name midnight-preprod-node \
    --port 30340 \
    --rpc-port 9950 \
    --pool-limit 35 \
    --bootnodes /dns/bootnode-1.preprod.midnight.network/tcp/30333/ws/p2p/12D3KooWQxxUgq7ndPfAaCFNbAxtcKYxrAzTxDfRGNktF75SxdX5 \
    --bootnodes /dns/bootnode-2.preprod.midnight.network/tcp/30333/ws/p2p/12D3KooWNrUBs22FfmgjqFMa9ZqKED2jnxwsXWw5E4q2XVwN35TJ \
    # Preprod publishes only 2 bootnodes and this host is behind NAT (no inbound peers), so the
    # sync is inherently bursty. Pin both bootnodes as reserved to hold the connections longer
    # and widen the peer slots -- best-effort continuity; a true full sync is still multi-hour.
    --reserved-nodes /dns/bootnode-1.preprod.midnight.network/tcp/30333/ws/p2p/12D3KooWQxxUgq7ndPfAaCFNbAxtcKYxrAzTxDfRGNktF75SxdX5 \
    --reserved-nodes /dns/bootnode-2.preprod.midnight.network/tcp/30333/ws/p2p/12D3KooWNrUBs22FfmgjqFMa9ZqKED2jnxwsXWw5E4q2XVwN35TJ \
    --in-peers 25 --out-peers 25 \
    --no-private-ip \
    > "$LOG_DIR/midnight-node.log" 2>&1 < /dev/null &
  disown -h
)
echo "    midnight-node 1.0.1 started, logging to $LOG_DIR/midnight-node.log"

echo "==> [4/4] Starting Midnight indexer/proof-server (Docker; pinned to the preprod bundle)"
docker run -d --name midnight-proof-server-preprod --network host \
  midnightntwrk/proof-server:8.1.0@sha256:801bbc0340e9e96f16735f77b523f23c7459e3359842f7c79c2c53f4e994d531 || true

docker run -d --name midnight-indexer-preprod --network host \
  midnightntwrk/indexer-standalone:4.3.3@sha256:03afd079b00bcd229df29a24771439c5e7695c339cd89216d0763ce40731cc4b || true

echo "==> Preprod stack launch commands issued. Check midnight-node status: tail -f $LOG_DIR/midnight-node.log"
echo "    Note: indexer will crash-loop until midnight-node produces/serves blocks -- this is expected."
