#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.hcash-regtest.yml"
HASHCASH_DIR="${ROOT_DIR}/../hashcash-core"
COOKIE_FILE="${HASHCASH_DIR}/data/node1/regtest/.cookie"
RPC_URL="http://127.0.0.1:10309/"
API_URL="http://127.0.0.1:3334/api"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command not found: $1" >&2
    exit 1
  }
}

rpc_call() {
  local method="$1"
  local params="${2:-[]}"
  curl -s --user "$(cat "${COOKIE_FILE}")" \
    --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"hcash-pool-validation\",\"method\":\"${method}\",\"params\":${params}}" \
    -H 'content-type: text/plain;' \
    "${RPC_URL}"
}

wait_for_http() {
  local url="$1"
  local seconds="$2"
  local elapsed=0
  until curl -fsS "${url}" >/dev/null 2>&1; do
    sleep 1
    elapsed=$((elapsed + 1))
    if (( elapsed >= seconds )); then
      echo "Timed out waiting for ${url}" >&2
      return 1
    fi
  done
}

wait_for_stratum() {
  local elapsed=0
  local max_wait_seconds="${1}"

  until false; do
    local subscribe_output
    subscribe_output="$(printf '{"id":1,"method":"mining.subscribe","params":["hcash-validator/1.0.0"]}\n' | nc 127.0.0.1 3333 -w 3 || true)"
    if grep -q '"id":1,"error":null' <<<"${subscribe_output}"; then
      return 0
    fi

    sleep 1
    elapsed=$((elapsed + 1))
    if (( elapsed >= max_wait_seconds )); then
      echo "Timed out waiting for stratum server on 127.0.0.1:3333" >&2
      return 1
    fi
  done
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local context="$3"
  if ! grep -q "${needle}" <<<"${haystack}"; then
    echo "Assertion failed: ${context}. Missing pattern: ${needle}" >&2
    echo "Observed output:" >&2
    echo "${haystack}" >&2
    exit 1
  fi
}

require_cmd docker
require_cmd curl
require_cmd jq
require_cmd nc
require_cmd grep

if ! docker ps --format '{{.Names}}' | grep -q '^hashcash-node1$'; then
  echo "hashcash-node1 is not running. Start hashcash-core devnet first." >&2
  exit 1
fi

if [[ ! -f "${COOKIE_FILE}" ]]; then
  echo "RPC cookie file not found: ${COOKIE_FILE}" >&2
  exit 1
fi

node_height="$(rpc_call getblockcount | jq -r '.result')"
if [[ -z "${node_height}" || "${node_height}" == "null" ]]; then
  echo "Failed to read node block height via RPC ${RPC_URL}" >&2
  exit 1
fi

mkdir -p "${ROOT_DIR}/data/hcash-regtest/public-pool"
docker compose -f "${COMPOSE_FILE}" up -d --build

wait_for_http "${API_URL}/network" 60
wait_for_http "${API_URL}/pool" 60
wait_for_stratum 60

pool_height="$(curl -s "${API_URL}/network" | jq -r '.blocks')"
if [[ "${pool_height}" != "${node_height}" ]]; then
  echo "Pool/node block height mismatch. node=${node_height} pool=${pool_height}" >&2
  exit 1
fi

if docker exec hashcash-node1 hashcash-cli -regtest listwallets | jq -e '.[] | select(.=="poolminer")' >/dev/null; then
  :
elif docker exec hashcash-node1 hashcash-cli -regtest loadwallet poolminer >/dev/null 2>&1; then
  :
else
  docker exec hashcash-node1 hashcash-cli -regtest createwallet poolminer >/dev/null
fi

valid_address="$(docker exec hashcash-node1 hashcash-cli -regtest -rpcwallet=poolminer getnewaddress \"\" bech32 | tr -d '\r\n')"
if [[ "${valid_address}" != hcash1* ]]; then
  echo "Expected HCASH bech32 address, got: ${valid_address}" >&2
  exit 1
fi

(
  sleep 2
  docker exec hashcash-node1 hashcash-cli -regtest -rpcwallet=poolminer generatetoaddress 1 "${valid_address}" >/dev/null
) &
mine_trigger_pid=$!

valid_output="$(
  {
    printf '{"id":1,"method":"mining.subscribe","params":["hcash-validator/1.0.0"]}\n'
    printf '{"id":2,"method":"mining.authorize","params":["%s.worker","x"]}\n' "${valid_address}"
    sleep 8
  } | nc 127.0.0.1 3333 -w 15 || true
)"
wait "${mine_trigger_pid}"

assert_contains "${valid_output}" '"id":2,"error":null,"result":true' "valid HCASH authorize"
assert_contains "${valid_output}" '"method":"mining.notify"' "mining job broadcast after authorize"

invalid_payload='{"id":1,"method":"mining.subscribe","params":["hcash-validator/1.0.0"]}
{"id":2,"method":"mining.authorize","params":["invalid-address.worker","x"]}'
invalid_output="$(printf "%s\n" "${invalid_payload}" | nc 127.0.0.1 3333 -w 8 || true)"
assert_contains "${invalid_output}" 'Authorization validation error' "invalid address rejection"

echo "HCASH regtest stratum validation successful:"
echo "  node block height: ${node_height}"
echo "  pool block height: ${pool_height}"
echo "  valid address auth: ok (${valid_address})"
echo "  invalid address rejection: ok"
