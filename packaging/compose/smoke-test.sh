#!/usr/bin/env bash
# Smoke test of packaging/compose: starts the guardian from docker-compose.yml, as a user would, against the regtest
# bitcoind and Electrs of e2e/docker-compose.yml, and checks what a user meets first:
#   - the compose file (and its node profile) is valid;
#   - the guardian comes up healthy, with the web UI on 127.0.0.1 only;
#   - it reaches the Electrum server (the first-run check says "found");
#   - first-run setup is closed without the setup code from the log, and opens with it.
#
# Used by .github/workflows/compose.yml. Locally (Docker running):
#   npm run stack:up -w @trikey/e2e
#   docker build -f packaging/docker/Dockerfile -t trikey-guardian:smoke .
#   bash packaging/compose/smoke-test.sh
#   npm run stack:down -w @trikey/e2e
#
# Settings (environment): TRIKEY_IMAGE (default trikey-guardian:smoke), CHAIN_NETWORK (the Docker network of the
# regtest stack, default trikey-e2e_default), UI_PORT (default 3999). Regtest credentials only.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
image="${TRIKEY_IMAGE:-trikey-guardian:smoke}"
chain_network="${CHAIN_NETWORK:-trikey-e2e_default}"
ui_port="${UI_PORT:-3999}"
work="$(mktemp -d)"
project="trikey-compose-smoke"

fail() {
  echo "::error title=compose smoke test::$*"
  docker compose -p "$project" --project-directory "$work" -f "$work/docker-compose.yml" -f "$work/ci.override.yml" logs --no-color guardian 2>/dev/null | tail -n 60 || true
  exit 1
}

cleanup() {
  docker compose -p "$project" --project-directory "$work" -f "$work/docker-compose.yml" -f "$work/ci.override.yml" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

cp "$here/docker-compose.yml" "$work/docker-compose.yml"
# The user's .env, from the example, pointed at the regtest stack (Electrs and bitcoind by their service names).
sed -e 's/^BITCOIN_NETWORK=.*/BITCOIN_NETWORK=regtest/' \
    -e 's/^ELECTRUM_HOST=.*/ELECTRUM_HOST=electrs/' \
    -e 's/^BITCOIN_RPC_HOST=.*/BITCOIN_RPC_HOST=bitcoind/' \
    -e 's/^BITCOIN_RPC_PORT=.*/BITCOIN_RPC_PORT=18443/' \
    -e 's/^BITCOIN_RPC_USER=.*/BITCOIN_RPC_USER=trikey/' \
    -e 's/^BITCOIN_RPC_PASS=.*/BITCOIN_RPC_PASS=trikey-regtest-only/' \
    -e "s/^TRIKEY_UI_PORT=.*/TRIKEY_UI_PORT=${ui_port}/" \
    "$here/.env.example" > "$work/.env"
echo "TRIKEY_IMAGE=${image}" >> "$work/.env"
# CI only: join the regtest stack's network, so the service names resolve.
cat > "$work/ci.override.yml" <<EOF
services:
  guardian:
    networks: [default, chain]
networks:
  chain:
    external: true
    name: ${chain_network}
EOF

dc() { docker compose -p "$project" --project-directory "$work" -f "$work/docker-compose.yml" -f "$work/ci.override.yml" "$@"; }

echo "== compose config"
# .env.example as it ships (no node credentials yet) must be a valid configuration as it is.
mkdir -p "$work/example"
cp "$here/docker-compose.yml" "$work/example/docker-compose.yml"
cp "$here/.env.example" "$work/example/.env"
docker compose --project-directory "$work/example" -f "$work/example/docker-compose.yml" config -q || fail ".env.example as shipped does not give a valid configuration"
docker compose --project-directory "$work" -f "$work/docker-compose.yml" config -q || fail "docker-compose.yml is not valid"
docker compose --project-directory "$work" -f "$work/docker-compose.yml" --profile node config -q || fail "the node profile is not valid"
[ "$(docker compose --project-directory "$work" -f "$work/docker-compose.yml" config --services | sort | tr '\n' ' ')" = "guardian " ] \
  || fail "without --profile node only the guardian should run"
[ "$(docker compose --project-directory "$work" -f "$work/docker-compose.yml" --profile node config --services | sort | tr '\n' ' ')" = "bitcoind electrs guardian " ] \
  || fail "the node profile should add bitcoind and electrs"

echo "== up"
dc up -d guardian || fail "docker compose up failed"

echo "== healthy"
cid="$(dc ps -q guardian)"
for i in $(seq 1 90); do
  health="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo none)"
  [ "$health" = "healthy" ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$cid")" = "true" ] || fail "the guardian container stopped"
  sleep 1
done
[ "$health" = "healthy" ] || fail "the guardian did not become healthy (last: $health)"

echo "== web UI on loopback only"
published="$(dc port guardian 3000)"
[ "$published" = "127.0.0.1:${ui_port}" ] || fail "the web UI is published on ${published}, not 127.0.0.1:${ui_port}"
base="http://127.0.0.1:${ui_port}/api"

status="$(curl -fsS "$base/status")" || fail "GET /api/status failed"
echo "$status" | jq -e '.setupComplete == false and .network == "regtest"' >/dev/null || fail "unexpected status: $status"

echo "== Electrum server reached"
for i in $(seq 1 60); do
  pre="$(curl -fsS "$base/setup/preflight")" || fail "GET /api/setup/preflight failed"
  echo "$pre" | jq -e '.electrs == "found"' >/dev/null && break
  sleep 1
done
echo "$pre" | jq -e '.electrs == "found" and .node == "found" and .platform == "docker" and .setupCodeRequired == true' >/dev/null \
  || fail "unexpected preflight: $pre"

echo "== setup code gate"
post() { curl -sS -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST --data "$2" "$base$1"; }
entropy="$(printf 'ab%.0s' $(seq 1 32))"
body='{"passphrase":"smoke test passphrase only","relays":["wss://relay.damus.io"],"entropy":"'"$entropy"'"}'
[ "$(post /setup "$body")" = "403" ] || fail "setup without the setup code was not refused with 403"
[ "$(post /setup/code '{"code":"AAAA-AAAA-AAAA-AAAA"}')" = "401" ] || fail "a wrong setup code was not refused with 401"
code="$(dc logs --no-color guardian | sed -n 's/.* setup\.code code=\([0-9A-Z-]*\) .*/\1/p' | tail -n 1)"
[[ "$code" =~ ^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$ ]] || fail "no setup code in the log"
[ "$(post /setup/code '{"code":"'"$code"'"}')" = "200" ] || fail "the setup code from the log was not accepted"
curl -fsS "$base/status" | jq -e '.setupComplete == false' >/dev/null || fail "checking the code must not set the guardian up"

echo "The guardian from packaging/compose came up, reached Electrs and guards its first run with the setup code."
