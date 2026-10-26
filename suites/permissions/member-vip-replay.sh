#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PWCLI="${PWCLI:-$HOME/.codex/skills/playwright/scripts/playwright_cli.sh}"
SESSION="${PLAYWRIGHT_SESSION:-bug1004949-member-vip-replay}"
CONFIG="${UI_PLAYWRIGHT_CLI_CONFIG:?请设置本机 CLI 配置文件路径}"
ACCOUNT="${BUG1004949_MEMBER_ACCOUNT:?Set BUG1004949_MEMBER_ACCOUNT at runtime}"
PASSWORD="${BUG1004949_MEMBER_PASSWORD:?Set BUG1004949_MEMBER_PASSWORD at runtime}"
BASE_URL="${UI_BASE_URL:-http://site.example.invalid}"
EVIDENCE_DIR="$ROOT/output/playwright/bug1004949"

mkdir -p "$EVIDENCE_DIR"
"$PWCLI" --session "$SESSION" open "$BASE_URL/bug1004949/member.html?vip=1" --config="$CONFIG"
"$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/member-vip-before-login-replay.yml"
"$PWCLI" --session "$SESSION" fill 'input[placeholder="Email address"]' "$ACCOUNT"
"$PWCLI" --session "$SESSION" fill 'input[placeholder="Password"]' "$PASSWORD"
"$PWCLI" --session "$SESSION" click '#loginSubmit'
"$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/member-vip-after-login-replay.yml"
