#!/usr/bin/env bash
# M0 asset fetch — resumable, with stall detection.
set -u
cd /e/Github/moocr || exit 1
mkdir -p resources/llama resources/models fixtures

BASE=https://huggingface.co/prithivMLmods/Xiaomi-OCR-0-GGUF/resolve/main
LLAMA_URL=https://github.com/ggml-org/llama.cpp/releases/download/b12110/llama-b12110-bin-win-vulkan-x64.zip

# fetch URL -> dest, with expected size check and up to 8 resume attempts
fetch() {
  local url="$1" dest="$2" want="${3:-0}" have i
  for i in $(seq 1 8); do
    have=0
    [ -f "$dest" ] && have=$(stat -c%s "$dest" 2>/dev/null || echo 0)
    if [ "$want" -gt 0 ] && [ "$have" -ge "$want" ]; then
      echo "  ok (complete $have bytes) $dest"
      return 0
    fi
    echo "  [try $i] $dest: $have${want:+/$want} bytes"
    curl -L --retry 2 --retry-delay 3 -C - \
      --speed-time 30 --speed-limit 20000 \
      --connect-timeout 20 \
      -o "$dest" "$url" -w '    http=%{http_code} got=%{size_download} avg=%{speed_download}B/s t=%{time_total}s\n'
    have=0
    [ -f "$dest" ] && have=$(stat -c%s "$dest" 2>/dev/null || echo 0)
    if [ "$want" -gt 0 ] && [ "$have" -ge "$want" ]; then
      echo "  ok (complete $have bytes) $dest"
      return 0
    fi
    sleep 2
  done
  echo "  !!! incomplete after retries: $dest ($have/${want:-?})"
  return 1
}

echo "=== [1/4] llama.cpp vulkan b12110 ==="
fetch "$LLAMA_URL" resources/llama/llama-vulkan.zip 0

echo "=== [2/4] Q4_K_M (529297664) ==="
fetch "$BASE/Xiaomi-OCR-0.Q4_K_M.gguf" resources/models/Xiaomi-OCR-0.Q4_K_M.gguf 529297664

echo "=== [3/4] mmproj bf16 (207346624) ==="
fetch "$BASE/Xiaomi-OCR-0.mmproj-bf16.gguf" resources/models/Xiaomi-OCR-0.mmproj-bf16.gguf 207346624

echo "=== [4/4] example pics + reference outputs ==="
PIC=https://huggingface.co/xiaomi-research/Xiaomi-OCR-0/resolve/main/example_pics
for f in qianziwen.jpeg qianziwen.md dense-equations.jpg dense-equations.md \
         handwrite-formula.jpg handwrite-formula.md receipt.jpg receipt.md; do
  if [ -s "fixtures/$f" ]; then echo "  skip $f"; continue; fi
  curl -sfL --retry 3 --connect-timeout 20 -o "fixtures/$f" "$PIC/$f" && echo "  ok  $f" || echo "  FAIL $f"
done

echo "=== extract llama.cpp ==="
mkdir -p resources/llama/bin
unzip -o -q resources/llama/llama-vulkan.zip -d resources/llama/bin && echo "  unzipped"
ls -1 resources/llama/bin | head -20

echo "=== sizes ==="
find resources fixtures -type f -exec ls -l {} \; 2>/dev/null | awk '{printf "%12s  %s\n", $5, $9}'
echo "=== FETCH DONE ==="
