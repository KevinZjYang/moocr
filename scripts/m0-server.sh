#!/usr/bin/env bash
# Start llama-server for M0 probing. Usage: m0-server.sh [port] [extra args]
set -u
cd /e/Github/moocr || exit 1

PORT="${1:-8090}"; shift || true

SERVER=$(find resources/llama/bin -name 'llama-server.exe' | head -1)
if [ -z "$SERVER" ]; then echo "llama-server.exe not found"; exit 1; fi

MODEL=resources/models/Xiaomi-OCR-0.Q4_K_M.gguf
MMPROJ=resources/models/Xiaomi-OCR-0.mmproj-bf16.gguf
[ -f "$MODEL" ]  || { echo "missing $MODEL"; exit 1; }
[ -f "$MMPROJ" ] || { echo "missing $MMPROJ"; exit 1; }

echo "server: $SERVER"
echo "port:   $PORT"

exec "$SERVER" \
  -m "$MODEL" \
  --mmproj "$MMPROJ" \
  -ngl 99 \
  -dev Vulkan0 \
  -c 16384 \
  -np 1 \
  -t 4 \
  --host 127.0.0.1 \
  --port "$PORT" \
  "$@"
