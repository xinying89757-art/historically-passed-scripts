#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="${PWCLI:?请设置 Playwright CLI 可执行文件路径}"
CONFIG="${UI_PLAYWRIGHT_CLI_CONFIG:?请设置本机 CLI 配置文件路径}"
EVIDENCE="$ROOT/output/playwright/bug1004949"
mkdir -p "$EVIDENCE"
SESSION="bug1004949-employee-replay"
EMPLOYEE_ACCOUNT="${BUG1004949_EMPLOYEE_ACCOUNT:?请设置对应测试角色凭据}"
EMPLOYEE_PASSWORD="${BUG1004949_EMPLOYEE_PASSWORD:?请设置对应测试角色凭据}"
TARGET="http://site.example.invalid/bug1004949/product.html?case=0014&employee=$EMPLOYEE_ACCOUNT"

run() {
  "$CLI" --session "$SESSION" "$@"
}

run open https://admin.example.invalid/login.html --config="$CONFIG"
run fill '#loginName' "$EMPLOYEE_ACCOUNT"
run fill '#password' "$EMPLOYEE_PASSWORD"
run click '#loginSubmit'
run snapshot --filename="$EVIDENCE/case-0014-employee-login-replay.yml"
run open "$TARGET"
run snapshot --filename="$EVIDENCE/case-0014-employee-frontend-replay.yml"
run screenshot --filename="$EVIDENCE/case-0014-employee-frontend-replay.png"
