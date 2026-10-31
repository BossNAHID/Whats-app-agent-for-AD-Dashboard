#!/bin/bash
set -euo pipefail

# Render (and other PaaS) inject PORT for the public HTTP server (CarryBee Bridge).
# OpenWA runs internally on OPENWA_INTERNAL_PORT (default 2785) so the two
# processes never collide on the same port.
BRIDGE_PORT="${PORT:-3000}"
OPENWA_INTERNAL_PORT="${OPENWA_INTERNAL_PORT:-2785}"

if [ "$BRIDGE_PORT" = "$OPENWA_INTERNAL_PORT" ]; then
  OPENWA_INTERNAL_PORT=2786
fi

echo "[carrybee-start] Starting OpenWA Gateway on :${OPENWA_INTERNAL_PORT} and CarryBee Bridge on :${BRIDGE_PORT}..."

(
  cd /app
  export PORT="$OPENWA_INTERNAL_PORT"
  export NODE_ID="${NODE_ID:-carrybee-openwa-1}"
  export AUTO_START_SESSIONS="${AUTO_START_SESSIONS:-true}"
  export STATUS_SEED_ON_READY="${STATUS_SEED_ON_READY:-false}"
  exec node dist/main
) &
OPENWA_PID=$!

(
  cd /opt/carrybee-bridge
  export PORT="$BRIDGE_PORT"
  export OPENWA_BASE_URL="${OPENWA_BASE_URL:-http://127.0.0.1:${OPENWA_INTERNAL_PORT}}"
  export OPENWA_KEY_FILE="${OPENWA_KEY_FILE:-/app/data/.api-key}"
  export BRIDGE_LOCAL_KV_FILE="${BRIDGE_LOCAL_KV_FILE:-/app/data/carrybee-bridge-kv.json}"
  exec node server.js
) &
BRIDGE_PID=$!

shutdown() {
  echo "[carrybee-start] Shutting down CarryBee Bridge and OpenWA gracefully..."
  kill -TERM "$BRIDGE_PID" 2>/dev/null || true
  kill -TERM "$OPENWA_PID" 2>/dev/null || true
  wait "$BRIDGE_PID" 2>/dev/null || true
  wait "$OPENWA_PID" 2>/dev/null || true
  exit 0
}

trap shutdown SIGTERM SIGINT

# Exit immediately if either OpenWA or CarryBee Bridge terminates unexpectedly,
# so Docker / Render restarts the container cleanly.
set +e
wait -n "$OPENWA_PID" "$BRIDGE_PID"
EXIT_CODE=$?
set -e

echo "[carrybee-start] Process exited with code ${EXIT_CODE} — stopping remaining process..."
kill -TERM "$BRIDGE_PID" 2>/dev/null || true
kill -TERM "$OPENWA_PID" 2>/dev/null || true
wait "$BRIDGE_PID" 2>/dev/null || true
wait "$OPENWA_PID" 2>/dev/null || true
exit "$EXIT_CODE"
