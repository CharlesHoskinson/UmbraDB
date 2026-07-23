#!/usr/bin/env bash
# Launch the full turnkey stack: cardano-node -> cardano-db-sync -> midnight-node
# (compiled binary, not Docker -- see flake.nix for why) -> indexer/proof-server
# (still the pinned Docker images), using the bundled config.
set -euo pipefail

FLAKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="$FLAKE_DIR/config"
CARDANO_DATA="${CARDANO_DATA_DIR:-/root/cardano-data}"
MIDNIGHT_NODE_DATA="${MIDNIGHT_NODE_DATA_DIR:-/root/midnight-node-data}"
LOG_DIR="${MIDNIGHT_ENV_LOG_DIR:-/root/midnight-env-logs}"
export PGPASSFILE="${PGPASSFILE:-$HOME/.pgpass}"

mkdir -p "$CARDANO_DATA/db" "$MIDNIGHT_NODE_DATA" "$LOG_DIR"

echo "==> [1/4] Starting cardano-node"
nohup cardano-node run \
  --topology "$CONFIG_DIR/preview/topology.json" \
  --database-path "$CARDANO_DATA/db" \
  --socket-path "$CARDANO_DATA/db/node.socket" \
  --host-addr 0.0.0.0 --port 3001 \
  --config "$CONFIG_DIR/preview/config.json" \
  > "$LOG_DIR/cardano-node.log" 2>&1 < /dev/null &
disown -h
echo "    cardano-node started, logging to $LOG_DIR/cardano-node.log"

echo "==> Waiting for node socket..."
for _ in $(seq 1 60); do
  [ -S "$CARDANO_DATA/db/node.socket" ] && break
  sleep 2
done

echo "==> [2/4] Starting cardano-db-sync"
nohup cardano-db-sync \
  --config "$CONFIG_DIR/db-sync-config.json" \
  --socket-path "$CARDANO_DATA/db/node.socket" \
  --state-dir "$CARDANO_DATA/db-sync-state" \
  > "$LOG_DIR/cardano-db-sync.log" 2>&1 < /dev/null &
disown -h
echo "    cardano-db-sync started, logging to $LOG_DIR/cardano-db-sync.log"

echo "==> [3/4] Starting midnight-node (compiled binary)"
# midnight-node insists on finding res/cfg/default.toml relative to the current
# working directory, not relative to --chain -- must cd into the package's res/
# parent dir before launching. See flake.nix's midnight-node-bin comment for why
# this replaced the Docker image (never got stable peer connectivity here).
MIDNIGHT_NODE_SHARE="$(dirname "$(command -v midnight-node)")/../share/midnight-node"
DBPASS=$(cat "$HOME/.midnight-pg-password")
(
  cd "$MIDNIGHT_NODE_SHARE"
  export DB_SYNC_POSTGRES_CONNECTION_STRING="postgresql://midnight:${DBPASS}@127.0.0.1:5432/cexplorer"
  export CARDANO_SECURITY_PARAMETER=432
  nohup midnight-node \
    --chain res/preview/chain-spec-raw.json \
    --base-path "$MIDNIGHT_NODE_DATA" \
    --name midnight-preview-node \
    --port 30340 \
    --rpc-port 9950 \
    --pool-limit 35 \
    --bootnodes /ip4/34.249.9.161/tcp/30333/ws/p2p/12D3KooWK66i7dtGVNSwDh9tTeqov1q6LSdWsRLJvTyzTCaywYgK \
    --bootnodes /ip4/52.18.160.64/tcp/30333/ws/p2p/12D3KooWHqFfXFwb7WW4jwR8pr4BEf562v5M6c8K3CXAJq4Wx6ym \
    --no-private-ip \
    > "$LOG_DIR/midnight-node.log" 2>&1 < /dev/null &
  disown -h
)
echo "    midnight-node started, logging to $LOG_DIR/midnight-node.log"

echo "==> [4/4] Starting Midnight indexer/proof-server (Docker -- no release binary established as working for these yet)"
docker run -d --name midnight-proof-server-preview --network host \
  midnightntwrk/proof-server:8.1.0@sha256:801bbc0340e9e96f16735f77b523f23c7459e3359842f7c79c2c53f4e994d531 || true

docker run -d --name midnight-indexer-preview --network host \
  midnightntwrk/indexer-standalone:4.3.3@sha256:03afd079b00bcd229df29a24771439c5e7695c339cd89216d0763ce40731cc4b || true

echo "==> Stack launch commands issued. Check midnight-node status: tail -f $LOG_DIR/midnight-node.log"
echo "    Note: indexer will crash-loop until midnight-node produces block 1 -- this is expected."
