#!/usr/bin/env bash
# Clean-machine onboarding smoke test.
#
# Spins a MySQL container and a clean node:22 (debian-slim) container with NO
# zsh / kubectl / tsh installed, copies this repo in, runs the documented
# install path (`npm ci && npm run build && npm link`), creates a native MySQL
# datasource, stores creds, and runs a real query. Exits non-zero on any
# failure. Tears the containers down at the end.
#
# Usage: bash scripts/smoke-onboard.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NET="taproot-smoke-net"
DB_CT="taproot-smoke-mysql"
APP_CT="taproot-smoke-app"
ROOT_PW="rootpw"
DB_NAME="smoke"
DB_USER="smoke"
DB_PW="smokepw"

cleanup() {
  docker rm -f "$APP_CT" >/dev/null 2>&1 || true
  docker rm -f "$DB_CT" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== smoke: prepare network =="
docker network create "$NET" >/dev/null

echo "== smoke: start MySQL =="
docker run -d --name "$DB_CT" --network "$NET" \
  -e MYSQL_ROOT_PASSWORD="$ROOT_PW" \
  -e MYSQL_DATABASE="$DB_NAME" \
  -e MYSQL_USER="$DB_USER" \
  -e MYSQL_PASSWORD="$DB_PW" \
  mysql:8 >/dev/null

echo "== smoke: wait for MySQL to be ready =="
for i in $(seq 1 60); do
  if docker exec "$DB_CT" mysql -h127.0.0.1 -uroot -p"$ROOT_PW" -e "SELECT 1" >/dev/null 2>&1; then
    echo "   mysql ready after ${i}s"
    break
  fi
  sleep 1
  if [ "$i" -eq 60 ]; then
    echo "!! mysql did not become ready in 60s"; exit 1
  fi
done

echo "== smoke: seed table =="
docker exec -i "$DB_CT" mysql -uroot -p"$ROOT_PW" "$DB_NAME" <<'SQL'
CREATE TABLE IF NOT EXISTS sample_records (id INT PRIMARY KEY, label VARCHAR(64));
INSERT IGNORE INTO sample_records VALUES (1, 'alpha'), (2, 'beta'), (3, 'gamma');
GRANT SELECT ON smoke.* TO 'smoke'@'%';
FLUSH PRIVILEGES;
SQL

echo "== smoke: launch clean node:22 container (no zsh, no kubectl, no tsh) =="
docker run -d --name "$APP_CT" --network "$NET" \
  -v "$REPO_ROOT":/src:ro \
  -w /work \
  node:22-bookworm-slim \
  sleep infinity >/dev/null

echo "== smoke: verify environment is bare =="
docker exec "$APP_CT" bash -c '
  set -e
  command -v zsh && { echo "zsh unexpectedly present"; exit 1; } || echo "   zsh: absent (good)"
  command -v kubectl && { echo "kubectl unexpectedly present"; exit 1; } || echo "   kubectl: absent (good)"
  command -v tsh && { echo "tsh unexpectedly present"; exit 1; } || echo "   tsh: absent (good)"
  echo "   node: $(node --version)"
  echo "   sh:   $(ls -l /bin/sh)"
'

echo "== smoke: copy repo into writable workdir and install =="
docker exec "$APP_CT" bash -lc '
  set -euo pipefail
  cp -a /src/. /work/
  rm -rf /work/node_modules /work/dist
  npm ci --no-audit --no-fund --silent
  npm run build --silent
  npm link --silent
  taproot --version
'

echo "== smoke: taproot init (fresh state) =="
docker exec -e TAPROOT_MASTER_KEY=smoke-key "$APP_CT" bash -lc '
  taproot init | head -c 4000; echo
'

echo "== smoke: add native MySQL datasource =="
docker exec -e TAPROOT_MASTER_KEY=smoke-key "$APP_CT" bash -lc "
  taproot datasource add \
    --name dev-smoke \
    --kind mysql \
    --env dev \
    --service smoke \
    --credential-ref dev:smoke \
    --host $DB_CT \
    --port 3306 \
    --database $DB_NAME
"

echo "== smoke: store credentials =="
docker exec -e TAPROOT_MASTER_KEY=smoke-key "$APP_CT" bash -lc "
  taproot creds set --ref dev:smoke --user $DB_USER --password $DB_PW
"

echo "== smoke: doctor =="
docker exec -e TAPROOT_MASTER_KEY=smoke-key "$APP_CT" bash -lc '
  taproot doctor --datasource dev-smoke --connect | head -c 4000; echo
'

echo "== smoke: run query =="
docker exec -e TAPROOT_MASTER_KEY=smoke-key "$APP_CT" bash -lc '
  taproot query --datasource dev-smoke --sql "SELECT id, label FROM sample_records ORDER BY id"
'

echo "== smoke: PASS =="
