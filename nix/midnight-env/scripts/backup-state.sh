#!/usr/bin/env bash
# Snapshot cardano-node's chain data + cardano-db-sync's Postgres database to a
# Windows-host-backed location, so state survives a WSL VM loss/rebuild and a
# fresh checkout doesn't have to re-sync from genesis.
set -euo pipefail

BACKUP_ROOT="${MIDNIGHT_ENV_BACKUP_DIR:-/mnt/c/midnight-state-backup}"
PG_DATA_DIR="${PG_DATA_DIR:-/var/lib/postgresql/18/main}"
CARDANO_NODE_DB="${CARDANO_NODE_DB:-/root/cardano-data/db}"
STAGING="${MIDNIGHT_ENV_STAGING_DIR:-/root/backup-staging}"
PGPASSFILE="${PGPASSFILE:-$HOME/.pgpass}"
export PGPASSFILE

echo "==> Backing up to: $BACKUP_ROOT"
mkdir -p "$BACKUP_ROOT" "$STAGING"

echo "==> [1/3] Physical Postgres backup (pg_basebackup, online/consistent)"
rm -rf "$STAGING/pg-basebackup"
pg_basebackup -h localhost -p 5432 -U midnight \
  -D "$STAGING/pg-basebackup" -Ft -z -Xs --checkpoint=fast -P < /dev/null

echo "==> [2/3] cardano-node chain data (safe to copy live -- immutable chunks never change)"
rsync -a "$CARDANO_NODE_DB/" "$STAGING/cardano-node-db/"

echo "==> [3/3] Bulk-copying staged backup to $BACKUP_ROOT"
rsync -a --delete "$STAGING/pg-basebackup/" "$BACKUP_ROOT/pg-basebackup/"
rsync -a --delete "$STAGING/cardano-node-db/" "$BACKUP_ROOT/cardano-node-db/"

date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_ROOT/BACKUP_TIMESTAMP"
grep -oE "Starting epoch [0-9]+" /root/midnight-dev-env/build-logs/cardano-db-sync-run4.log 2>/dev/null | tail -1 > "$BACKUP_ROOT/BACKUP_EPOCH" || true

echo "==> Done. Snapshot at $BACKUP_ROOT, timestamped $(cat "$BACKUP_ROOT/BACKUP_TIMESTAMP")"
