#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PWCLI="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
SESSION="${PLAYWRIGHT_SESSION:-bug1004949-category-custom-url-replay}"
CONFIG="${UI_PLAYWRIGHT_CLI_CONFIG:?请设置本机 CLI 配置文件路径}"
BASE_URL="${UI_BASE_URL:-http://site.example.invalid}"
EVIDENCE_DIR="$ROOT/output/playwright/bug1004949"

# Content Management saves category custom URLs directly; no website publish is required.
mkdir -p "$EVIDENCE_DIR"
"$PWCLI" --session "$SESSION" open "$BASE_URL/bug1004949/product-category.html?case=0030&recheck=20260914" --config="$CONFIG"
"$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/case-0030-product-category-page1-replay.yml"
"$PWCLI" --session "$SESSION" goto "$BASE_URL/bug1004949/product-category-p2.html?case=0030&recheck=20260914"
"$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/case-0030-product-category-page2-replay.yml"

"$PWCLI" --session "$SESSION" goto "$BASE_URL/bug1004949/article-category.html?case=0031&recheck=20260914"
"$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/case-0031-article-category-page1-replay.yml"
"$PWCLI" --session "$SESSION" goto "$BASE_URL/bug1004949/article-category-p2.html?case=0031&recheck=20260914"
"$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/case-0031-article-category-page2-replay.yml"
