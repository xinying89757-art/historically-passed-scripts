#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PWCLI="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
SESSION="${PLAYWRIGHT_SESSION:-bug1004949-gallery-video-replay}"
CONFIG="${UI_PLAYWRIGHT_CLI_CONFIG:?请设置本机 CLI 配置文件路径}"
BASE_URL="${UI_BASE_URL:-http://site.example.invalid}"
EVIDENCE_DIR="$ROOT/output/playwright/bug1004949"

# 0032: gallery detail page.
mkdir -p "$EVIDENCE_DIR"
"$PWCLI" --session "$SESSION" open "$BASE_URL/bug1004949/gallery.html?case=0032&recheck=20260914" --config="$CONFIG"
"$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/case-0032-gallery-page-replay.yml"

# 0033: gallery category page.
"$PWCLI" --session "$SESSION" goto "$BASE_URL/bug1004949/gallery-category.html?case=0033&recheck=20260914"
"$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/case-0033-gallery-category-page-replay.yml"

# 0034: the default video detail page works, while the requested custom route reproduces HTTP 404.
"$PWCLI" --session "$SESSION" goto "$BASE_URL/video-one-example-item.html?case=0034&recheck=20260914"
"$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/case-0034-video-default-page-replay.yml"
"$PWCLI" --session "$SESSION" goto "$BASE_URL/bug1004949/video.html?case=0034&recheck=20260914"
"$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/case-0034-video-custom-url-check-replay.yml"

# 0035: video category page.
"$PWCLI" --session "$SESSION" goto "$BASE_URL/bug1004949/video-category.html?case=0035&recheck=20260914"
"$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/case-0035-video-category-page-replay.yml"
