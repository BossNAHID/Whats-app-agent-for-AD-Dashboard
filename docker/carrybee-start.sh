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

KEY_FILE="${OPENWA_KEY_FILE:-/app/data/.api-key}"

RESOLVED_OPENWA_KEY=""
SEED_MASTER_KEY=""

# 1. On warm restart with a persistent /app/data volume, OpenWA's SQLite DB already
#    stores the hashed master key from first boot (mirrored in $KEY_FILE).
if [ -s "$KEY_FILE" ]; then
  RESOLVED_OPENWA_KEY="$(tr -d '\r\n ' < "$KEY_FILE")"
fi

# 2. On first boot (empty /app/data), accept explicit OPENWA_API_KEY / API_MASTER_KEY (>=32 chars)
#    or generate a cryptographically random 71-char `owa_k1_<64-hex>` key, save it to $KEY_FILE,
#    and export API_MASTER_KEY to OpenWA so both processes share the exact same key from ms 0.
if [ -z "$RESOLVED_OPENWA_KEY" ]; then
  CANDIDATE_KEY="${OPENWA_API_KEY:-${API_MASTER_KEY:-}}"
  if [ "${#CANDIDATE_KEY}" -ge 32 ]; then
    RESOLVED_OPENWA_KEY="$CANDIDATE_KEY"
  else
    RESOLVED_OPENWA_KEY="$(node -e "process.stdout.write('owa_k1_' + require('crypto').randomBytes(32).toString('hex'))")"
  fi
  SEED_MASTER_KEY="$RESOLVED_OPENWA_KEY"
  mkdir -p "$(dirname "$KEY_FILE")"
  umask 077
  printf '%s' "$RESOLVED_OPENWA_KEY" > "$KEY_FILE"
fi

# Auto-detect container RAM limit when ENGINE_TYPE is not explicitly set:
# - On < 1400 MB containers (e.g. Render 512 MB Free/Starter), Chromium (whatsapp-web.js)
#   would immediately OOM-kill with 3 WhatsApp accounts, so auto-select ENGINE_TYPE=baileys.
# - On >= 1400 MB hosts (e.g. 2-3 GB KVM VPS or Render Standard), use OpenWA's default
#   whatsapp-web.js (headless Chromium) engine.
DETECTED_MEM_MB="$(node -e "
  const fs = require('fs');
  const os = require('os');
  let bytes = os.totalmem();
  for (const p of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = fs.readFileSync(p, 'utf8').trim();
      if (raw && raw !== 'max') {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0 && n < bytes) bytes = n;
      }
    } catch (_) {}
  }
  process.stdout.write(String(Math.floor(bytes / (1024 * 1024))));
")"

RESOLVED_ENGINE="${ENGINE_TYPE:-}"
OPENWA_NODE_OPTS="${NODE_OPTIONS:-}"
if [ -z "$RESOLVED_ENGINE" ]; then
  if [ "$DETECTED_MEM_MB" -lt 1400 ]; then
    RESOLVED_ENGINE="baileys"
    if [ -z "$OPENWA_NODE_OPTS" ]; then
      OPENWA_NODE_OPTS="--max-old-space-size=256"
    fi
    echo "[carrybee-start] Detected ${DETECTED_MEM_MB} MB RAM (< 1400 MB) — auto-selecting OpenWA ENGINE_TYPE=baileys to prevent OOM on 512 MB Render."
  else
    echo "[carrybee-start] Detected ${DETECTED_MEM_MB} MB RAM — using OpenWA default whatsapp-web.js (Chromium) engine."
  fi
else
  echo "[carrybee-start] Using explicit ENGINE_TYPE=${RESOLVED_ENGINE} (${DETECTED_MEM_MB} MB RAM)."
fi

echo "[carrybee-start] Starting OpenWA Gateway on :${OPENWA_INTERNAL_PORT} and CarryBee Bridge on :${BRIDGE_PORT}..."

(
  cd /app
  export PORT="$OPENWA_INTERNAL_PORT"
  export NODE_ID="${NODE_ID:-carrybee-openwa-1}"
  export AUTO_START_SESSIONS="${AUTO_START_SESSIONS:-true}"
  export STATUS_SEED_ON_READY="${STATUS_SEED_ON_READY:-false}"
  if [ -n "$RESOLVED_ENGINE" ]; then
    export ENGINE_TYPE="$RESOLVED_ENGINE"
  fi
  if [ -n "$OPENWA_NODE_OPTS" ]; then
    export NODE_OPTIONS="$OPENWA_NODE_OPTS"
  fi
  if [ -n "$SEED_MASTER_KEY" ]; then
    export API_MASTER_KEY="$SEED_MASTER_KEY"
  fi
  exec node dist/main
) &
OPENWA_PID=$!

(
  cd /opt/carrybee-bridge
  export PORT="$BRIDGE_PORT"
  export CARRYBEE_BUNDLED_OPENWA="true"
  export OPENWA_BASE_URL="${OPENWA_BASE_URL:-http://127.0.0.1:${OPENWA_INTERNAL_PORT}}"
  export OPENWA_API_KEY="$RESOLVED_OPENWA_KEY"
  export OPENWA_KEY_FILE="$KEY_FILE"
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
