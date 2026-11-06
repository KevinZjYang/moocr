#!/usr/bin/env bash
# 兼容旧文档里的 `bash scripts/m0-fetch.sh`，实际逻辑统一在 scripts/fetch.mjs。
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/fetch.mjs "$@"
