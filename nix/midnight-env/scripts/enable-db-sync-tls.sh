#!/usr/bin/env bash
#
# enable-db-sync-tls.sh -- give the Cardano db-sync PostgreSQL a TLS endpoint.
#
# WHY: the Midnight partner-chain node (ledger-8 line, e.g. midnight-node 2.x) mandates a TLS
# connection to the cexplorer DB it reads. `allow_non_ssl` is deprecated and ignored -- plaintext
# connections are refused. With `ssl_root_cert` unset the node uses PgSslMode::Require (encrypted,
# no cert validation); with it set it uses VerifyFull. Enabling `ssl = on` on the server is
# non-forcing, so cardano-db-sync's own (documented, plaintext) connection keeps working.
#
# See design/db-sync-tls-feasibility.md for the full write-up.
#
# Usage:
#   enable-db-sync-tls.sh <postgres-container-name>
#   enable-db-sync-tls.sh cardano-db-sync-preprod-postgres-1
#
# Idempotent: safe to re-run. Requires: docker, an alpine/debian postgres image with apk/apt.
set -euo pipefail

CONTAINER="${1:?usage: enable-db-sync-tls.sh <postgres-container-name>}"
CN="${DB_TLS_CN:-postgres}"          # cert CN + primary SAN; must match the host= the node dials
SANS="${DB_TLS_SANS:-DNS:postgres,DNS:localhost,IP:127.0.0.1}"

echo "==> Enabling TLS on Postgres container '$CONTAINER' (CN=$CN)"

docker exec -e CN="$CN" -e SANS="$SANS" "$CONTAINER" sh -s <<'INNER'
set -e
: "${PGDATA:=/var/lib/postgresql/data}"
# openssl: alpine -> apk, debian -> apt
if ! command -v openssl >/dev/null 2>&1; then
  (apk add --no-cache openssl >/dev/null 2>&1) || (apt-get update >/dev/null 2>&1 && apt-get install -y openssl >/dev/null 2>&1) || true
fi
cd "$PGDATA"
if [ ! -f server.key ]; then
  openssl req -new -x509 -days 3650 -nodes -text \
    -out server.crt -keyout server.key \
    -subj "/CN=${CN}" -addext "subjectAltName=${SANS}" >/dev/null 2>&1
  chmod 600 server.key
  chown postgres:postgres server.crt server.key 2>/dev/null || true
  echo "  generated self-signed cert in $PGDATA"
else
  echo "  cert already present in $PGDATA"
fi
if ! grep -q '^ssl = on' postgresql.conf; then
  {
    echo ""
    echo "# --- db-sync TLS endpoint (feature/db-sync-tls) ---"
    echo "ssl = on"
    echo "ssl_cert_file = 'server.crt'"
    echo "ssl_key_file = 'server.key'"
  } >> postgresql.conf
  echo "  appended ssl config to postgresql.conf"
else
  echo "  ssl already configured"
fi
INNER

echo "==> Restarting Postgres to bring TLS up"
docker restart "$CONTAINER" >/dev/null
sleep 8

echo "==> Verifying the connection is actually encrypted"
docker exec "$CONTAINER" sh -c \
  'psql "host=127.0.0.1 user=${POSTGRES_USER:-postgres} dbname=${POSTGRES_DB:-cexplorer} sslmode=require" \
     -tAc "SELECT '\''ssl_in_use=1 cipher='\''||version FROM pg_stat_ssl WHERE pid = pg_backend_pid();"' \
  2>/dev/null || echo "  (verify manually: set PGPASSWORD and re-run the psql check)"

echo "==> Done. Point the Midnight node's DB_SYNC_POSTGRES_CONNECTION_STRING at this server"
echo "    (no ?sslmode needed -- the node ignores it). For VerifyFull, sign the cert with a local"
echo "    CA whose SAN matches '$CN', mount the CA cert into the node, and set --ssl_root_cert."
