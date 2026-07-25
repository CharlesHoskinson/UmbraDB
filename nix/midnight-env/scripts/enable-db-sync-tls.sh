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
# SECURITY: the default (no --ca) path provisions Require + a self-signed cert -- ENCRYPTION ONLY,
# with NO server-identity validation and NO MITM protection. It is safe ONLY when the node and
# Postgres are co-located on one trusted host. For any off-host / untrusted-segment / hardened
# deployment use the `--ca` mode below (VerifyFull with a pinned local CA). See
# nix/midnight-env/README.md and the repo-root SECURITY.md for the full caveat.
#
# See design/db-sync-tls-feasibility.md for the full write-up.
#
# Usage:
#   enable-db-sync-tls.sh <postgres-container-name>            # Require (encryption only, default)
#   enable-db-sync-tls.sh --ca <postgres-container-name>       # VerifyFull (local CA-signed cert)
#   enable-db-sync-tls.sh cardano-db-sync-preprod-postgres-1
#
# Idempotent: safe to re-run. Requires: docker, an alpine/debian postgres image with apk/apt.
set -euo pipefail

MODE="require"
if [ "${1:-}" = "--ca" ]; then
  MODE="ca"
  shift
fi

CONTAINER="${1:?usage: enable-db-sync-tls.sh [--ca] <postgres-container-name>}"
CN="${DB_TLS_CN:-postgres}"          # cert CN + primary SAN; must match the host= the node dials
SANS="${DB_TLS_SANS:-DNS:localhost,IP:127.0.0.1}"
# VerifyFull matches the DIALED HOST against the certificate's SAN set (a bare CN is ignored when a
# SAN is present), so the dialed host ($CN) MUST appear in the SAN set even when the operator
# overrides DB_TLS_CN or DB_TLS_SANS. Always ensure DNS:$CN is in the set, de-duplicated.
case ",${SANS}," in
  *",DNS:${CN},"*) : ;;               # already present
  *) SANS="DNS:${CN},${SANS}" ;;
esac

if [ "$MODE" = "ca" ]; then
  echo "==> Enabling TLS (VerifyFull / local CA) on Postgres container '$CONTAINER' (CN=$CN)"

  # -i so the heredoc reaches the container's `sh -s` in non-interactive runs.
  docker exec -i -e CN="$CN" -e SANS="$SANS" "$CONTAINER" sh -s <<'INNER_CA'
set -e
: "${PGDATA:=/var/lib/postgresql/data}"
# openssl: alpine -> apk, debian -> apt
if ! command -v openssl >/dev/null 2>&1; then
  (apk add --no-cache openssl >/dev/null 2>&1) || (apt-get update >/dev/null 2>&1 && apt-get install -y openssl >/dev/null 2>&1) || true
fi
cd "$PGDATA"
# A local CA. Reused if already present so re-runs are idempotent; its private key is 0600, the
# same discipline as server.key.
if [ ! -f ca.crt ] || [ ! -f ca.key ]; then
  openssl req -new -x509 -days 3650 -nodes \
    -keyout ca.key -out ca.crt \
    -subj "/CN=${CN}-db-sync-local-ca" >/dev/null 2>&1
  chmod 600 ca.key
  echo "  generated local CA in $PGDATA (ca.crt / ca.key)"
else
  echo "  local CA already present in $PGDATA"
fi
# Server key + CSR, then a CA-signed server cert whose SAN = the host the node dials. Regenerated
# so the served cert is guaranteed CA-signed with the correct SAN (VerifyFull needs both).
openssl req -new -nodes \
  -keyout server.key -out server.csr \
  -subj "/CN=${CN}" >/dev/null 2>&1
printf 'subjectAltName=%s\n' "${SANS}" > san.ext
openssl x509 -req -in server.csr \
  -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 3650 -extfile san.ext \
  -out server.crt >/dev/null 2>&1
rm -f server.csr san.ext
chmod 600 server.key
chown postgres:postgres server.crt server.key ca.crt ca.key 2>/dev/null || true
echo "  signed server cert with the local CA (SAN=${SANS})"
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
echo "CA_CERT_PATH=$PGDATA/ca.crt"
INNER_CA

  echo "==> Restarting Postgres to bring TLS up"
  docker restart "$CONTAINER" >/dev/null
  sleep 8

  echo "==> Verifying VerifyFull works end-to-end (CA + hostname validation, not just encryption)"
  # sslmode=verify-full + sslrootcert=<the generated CA> genuinely proves BOTH that the served cert
  # chains to our CA and that the dialed host (127.0.0.1, in the IP:127.0.0.1 SAN) matches -- i.e.
  # the whole point of the --ca de-stub, not merely that bytes are encrypted.
  docker exec "$CONTAINER" sh -c \
    'psql "host=127.0.0.1 user=${POSTGRES_USER:-postgres} dbname=${POSTGRES_DB:-cexplorer} sslmode=verify-full sslrootcert=/var/lib/postgresql/data/ca.crt" \
       -tAc "SELECT '\''verify_full_ok=1 ssl_in_use=1 cipher='\''||version FROM pg_stat_ssl WHERE pid = pg_backend_pid();"' \
    2>/dev/null && echo "  verify-full succeeded against the generated CA" \
    || echo "  (verify manually: set PGPASSWORD and re-run the sslmode=verify-full psql check with sslrootcert=<the CA>)"

  CA_CONTAINER_PATH="/var/lib/postgresql/data/ca.crt"
  CA_HOST_PATH="./${CONTAINER}-db-sync-ca.crt"
  if docker cp "${CONTAINER}:${CA_CONTAINER_PATH}" "$CA_HOST_PATH" >/dev/null 2>&1; then
    # The Midnight node is a HOST binary (not a container -- nix/midnight-env/flake.nix:149), so
    # --ssl_root_cert MUST name the CA on the HOST filesystem. Resolve to an absolute host path and
    # print THAT as the exact value; the in-container path is meaningless to a host binary.
    CA_HOST_ABS="$(cd "$(dirname "$CA_HOST_PATH")" && pwd)/$(basename "$CA_HOST_PATH")"
    echo "==> Copied CA cert to host: $CA_HOST_ABS"
    echo "==> Done (VerifyFull). The Midnight node is a HOST binary; give it exactly the HOST path:"
    echo "        --ssl_root_cert=${CA_HOST_ABS}"
    echo "    CA cert path (on host): ${CA_HOST_ABS}"
  else
    echo "==> (could not copy CA cert to host; read it from the container at ${CONTAINER}:${CA_CONTAINER_PATH})"
    echo "==> Done (VerifyFull). The Midnight node is a HOST binary; set --ssl_root_cert to the HOST"
    echo "    path where you place that CA cert -- NOT the in-container path ${CA_CONTAINER_PATH}."
  fi
  echo "    The server cert's SAN set is '${SANS}' -- the node's host= MUST match one of those names."
  exit 0
fi

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
echo "    (no ?sslmode needed -- the node ignores it). This is Require: ENCRYPTION ONLY, no"
echo "    server-identity validation, no MITM protection -- safe only when node and Postgres are"
echo "    co-located on one trusted host. For VerifyFull (off-host / hardened), re-run with --ca:"
echo "        enable-db-sync-tls.sh --ca $CONTAINER"
