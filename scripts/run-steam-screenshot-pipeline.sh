#!/bin/bash
# Capture + curate Steam store screenshots (1920×1080).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[steam] starting local server on :8888…"
node _local_serve.js &
SRV=$!
cleanup() { kill "$SRV" 2>/dev/null || true; }
trap cleanup EXIT

for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:8888/" >/dev/null; then break; fi
  sleep 0.25
done

echo "[steam] capturing…"
npm run capture:steam-page
echo "[steam] curating store-ready set…"
npm run curate:screenshots
echo "[steam] done → $ROOT/steam-screenshots/store-ready/"
ls -la "$ROOT/steam-screenshots/store-ready/"
