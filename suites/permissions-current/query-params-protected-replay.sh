#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PWCLI="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
SESSION="${PLAYWRIGHT_SESSION:-bug1004949-query-replay}"
PASSWORD="${BUG1004949_PAGE_PASSWORD:?Set BUG1004949_PAGE_PASSWORD at runtime}"
BASE_URL="${UI_BASE_URL:-http://site.example.invalid}"
EVIDENCE_DIR="$ROOT/output/playwright/bug1004949"

run_page() {
  local kind="$1"
  local path="$2"
  "$PWCLI" --session "$SESSION" cookie-delete PA >/dev/null || true
  "$PWCLI" --session "$SESSION" tab-new "$BASE_URL$path?case=0003&source=playwright"
  "$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/case-0003-$kind-before-unlock-replay.yml"
  "$PWCLI" --session "$SESSION" fill 'input[placeholder="Please enter a password"]' "$PASSWORD"
  "$PWCLI" --session "$SESSION" click 'button:has-text("OK")'
  "$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/case-0003-$kind-after-unlock-replay.yml"
  "$PWCLI" --session "$SESSION" eval "location.href" --filename "$EVIDENCE_DIR/case-0003-$kind-after-url-replay.txt"
}

run_page product /bug1004949/product.html
run_page article /bug1004949/article.html
