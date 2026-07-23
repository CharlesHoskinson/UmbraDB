#!/usr/bin/env bash
# Restore cardano-node + cardano-db-sync state from a prior backup-state snapshot,
# so a fresh environment resumes near where the snapshot left off instead of genesis.
set -euo pipefail

BACKUP_ROOT="${MIDNIGHT_ENV_BACKUP_DIR:-/mnt/c/midnight-state-backup}"
PG_DATA_DIR="${PG_DATA_DIR:-/var/lib/postgresql/18/main}"
CARDANO_NODE_DB="${CARDANO_NODE_DB:-/root/cardano-data/db}"

if [ ! -d "$BACKUP_ROOT/pg-basebackup" ] || [ ! -d "$BACKUP_ROOT/cardano-node-db" ]; then
  echo "No backup found at $BACKUP_ROOT -- nothing to restore. A fresh sync from genesis is required." >&2
  exit 1
fi

echo "==> Restoring snapshot from $(cat "$BACKUP_ROOT/BACKUP_TIMESTAMP" 2>/dev/null || echo unknown) (epoch: $(cat "$BACKUP_ROOT/BACKUP_EPOCH" 2>/dev/null || echo unknown))"

echo "==> Stopping any running cardano-node / cardano-db-sync"
pkill -f 'cardano-node run' 2>/dev/null || true
pkill -f 'cardano-db-sync --config' 2>/dev/null || true
sleep 2

echo "==> [1/2] Restoring cardano-node chain data"
mkdir -p "$CARDANO_NODE_DB"
rsync -a --delete "$BACKUP_ROOT/cardano-node-db/" "$CARDANO_NODE_DB/"

echo "==> [2/2] Restoring Postgres from physical backup"
echo "    (stop the postgres service first: sudo systemctl stop postgresql)"
if systemctl is-active --quiet postgresql 2>/dev/null; then
  systemctl stop postgresql
fi
rm -rf "$PG_DATA_DIR"
mkdir -p "$PG_DATA_DIR"
tar -xzf "$BACKUP_ROOT/pg-basebackup/base.tar.gz" -C "$PG_DATA_DIR"
chown -R postgres:postgres "$PG_DATA_DIR"
chmod 700 "$PG_DATA_DIR"
systemctl start postgresql

echo "==> Restore complete. Start the stack with: nix run .#start-stack"
