#!/usr/bin/env bash
set -euo pipefail

PORTS=(3101 3102 3103)
PIDS=()
TMP_DIR="$(mktemp -d)"

cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]:-}"; do
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

echo "[1/5] Building application..."
bun run build >/dev/null

echo "[2/5] Starting 3 independent Nest processes..."
for port in "${PORTS[@]}"; do
  PORT="$port" bun run start:prod >"$TMP_DIR/app-$port.log" 2>&1 &
  PIDS+=("$!")
done

for port in "${PORTS[@]}"; do
  ready=0
  for _ in $(seq 1 40); do
    if curl -fsS "http://localhost:$port/health/ready" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.25
  done

  if [[ "$ready" -ne 1 ]]; then
    echo "[FAIL] Process on port $port did not become ready."
    cat "$TMP_DIR/app-$port.log" || true
    exit 1
  fi
done

echo "[3/5] Creating wallet..."
PLAYER="$(python3 -c 'import uuid; print(uuid.uuid4())')"

CREATE_BODY="$(
  curl -fsS \
    -X POST http://localhost:3101/wallets \
    -H 'Content-Type: application/json' \
    -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}"
)"

WALLET="$(
  printf '%s' "$CREATE_BODY" |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])'
)"

ROUND="$(python3 -c 'import uuid; print(uuid.uuid4())')"

echo "[4/5] Sending 3 concurrent BETs through 3 processes..."
CURL_PIDS=()

for i in 0 1 2; do
  PORT="${PORTS[$i]}"
  IDEM="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  EXT="$(python3 -c 'import uuid; print(uuid.uuid4())')"

  (
    curl -sS \
      -o "$TMP_DIR/response-$i.json" \
      -w '%{http_code}' \
      -X POST "http://localhost:$PORT/wagering/transactions" \
      -H 'Content-Type: application/json' \
      -H "Idempotency-Key: $IDEM" \
      -d "{\"providerId\":\"multi-process-provider\",\"externalTransactionId\":\"$EXT\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"$ROUND\",\"gameId\":\"multi-process-game\",\"kind\":\"BET\",\"money\":{\"amount\":\"40.00\",\"currency\":\"BRL\"}}" \
      >"$TMP_DIR/status-$i.txt"
  ) &
  CURL_PIDS+=("$!")
done

for pid in "${CURL_PIDS[@]}"; do
  wait "$pid"
done

echo "[5/5] Verifying financial invariants..."
python3 - "$TMP_DIR" "$WALLET" <<'PY'
import json
import pathlib
import sys
import urllib.request

tmp = pathlib.Path(sys.argv[1])
wallet_id = sys.argv[2]

responses = []
http_codes = []

for i in range(3):
    responses.append(json.loads((tmp / f"response-{i}.json").read_text()))
    http_codes.append((tmp / f"status-{i}.txt").read_text().strip())

processed = [r for r in responses if r.get("status") == "PROCESSED"]
rejected = [r for r in responses if r.get("status") == "REJECTED"]

if len(processed) != 2:
    raise SystemExit(f"[FAIL] Expected 2 PROCESSED, got {len(processed)}: {responses}")

if len(rejected) != 1:
    raise SystemExit(f"[FAIL] Expected 1 REJECTED, got {len(rejected)}: {responses}")

if rejected[0].get("failureCode") != "INSUFFICIENT_FUNDS":
    raise SystemExit(f"[FAIL] Unexpected rejection: {rejected[0]}")

with urllib.request.urlopen(f"http://localhost:3101/wallets/{wallet_id}") as response:
    wallet = json.load(response)

if wallet["balance"]["amount"] != "20.00":
    raise SystemExit(f"[FAIL] Expected balance 20.00, got {wallet['balance']}")

if wallet["version"] != 3:
    raise SystemExit(f"[FAIL] Expected version 3, got {wallet['version']}")

with urllib.request.urlopen(
    f"http://localhost:3101/wallets/{wallet_id}/ledger?limit=100"
) as response:
    ledger = json.load(response)

debits = [
    entry for entry in ledger["items"]
    if entry["direction"] == "DEBIT"
]

if len(debits) != 2:
    raise SystemExit(f"[FAIL] Expected exactly 2 debit ledger entries, got {len(debits)}")

print("[PASS] 3 independent Nest processes serialized the hot wallet correctly.")
print(f"       HTTP responses: {http_codes}")
print(f"       Processed: {len(processed)} | Rejected: {len(rejected)}")
print(f"       Final balance: {wallet['balance']['amount']} {wallet['balance']['currency']}")
print(f"       Wallet version: {wallet['version']}")
print(f"       Debit ledger entries: {len(debits)}")
PY
