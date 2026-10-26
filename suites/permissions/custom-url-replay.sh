#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PWCLI="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
SESSION="${PLAYWRIGHT_SESSION:-bug1004949-custom-url-replay}"
CONFIG="${UI_PLAYWRIGHT_CLI_CONFIG:?请设置本机 CLI 配置文件路径}"
BASE_URL="${UI_BASE_URL:-http://site.example.invalid}"
EVIDENCE_DIR="$ROOT/output/playwright/bug1004949"

mkdir -p "$EVIDENCE_DIR"
"$PWCLI" --session "$SESSION" open "$BASE_URL/bug1004949/product.html?case=0028&recheck=20260914" --config="$CONFIG"
"$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/case-0028-product-replay.yml"

for n in 1 2 3; do
  "$PWCLI" --session "$SESSION" goto "$BASE_URL/bug1004949/article-$n.html?case=0029&recheck=20260914"
  "$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/case-0029-article-$n-replay.yml"
done
