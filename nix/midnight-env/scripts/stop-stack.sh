#!/usr/bin/env bash
set -uo pipefail
echo "==> Stopping cardano-db-sync / cardano-node"
pkill -f 'cardano-db-sync --config' 2>/dev/null || true
pkill -f 'cardano-node run' 2>/dev/null || true
echo "==> Stopping Midnight Docker containers"
docker stop midnight-node-preprod midnight-proof-server-preprod midnight-indexer-preprod 2>/dev/null || true
echo "==> Done."
