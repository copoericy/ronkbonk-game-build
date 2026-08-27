#!/bin/bash
# Start RonkBonk local game and keep it alive in Terminal.
cd "$(dirname "$0")"
PORT="${RONK_PORT:-8888}"
# Free stale listeners
if command -v lsof >/dev/null 2>&1; then
  lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true
fi
echo "Starting RonkBonk on http://localhost:$PORT ..."
exec node _local_serve.js
