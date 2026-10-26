#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PWCLI="${PWCLI:-${PWCLI}}"
SESSION="${PLAYWRIGHT_SESSION:-bug1004949-url-regression-replay}"
CONFIG="${UI_PLAYWRIGHT_CLI_CONFIG:?请设置本机 CLI 配置文件路径}"
BASE_URL="${UI_BASE_URL:-http://site.example.invalid}"
EVIDENCE_DIR="$ROOT/output/playwright/bug1004949"

# 用例-0036：同一产品先验证过带目录 URL，之后切换为当前生效的根目录 URL。
mkdir -p "$EVIDENCE_DIR"
"$PWCLI" --session "$SESSION" open "$BASE_URL/product-root.html?case=0036&replay=1" --config="$CONFIG"
"$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/case-0036-root-frontend-replay.yml"

# 用例-0037：原系统 URL 应重定向到 /bug1004949/product.html。
"$PWCLI" --session "$SESSION" goto "$BASE_URL/example-product-example-item.html?case=0037&replay=1"
"$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/case-0037-system-url-redirected-replay.yml"

# 用例-0038：产品、文章分类的带目录/根目录 URL 均验证第 1 页和第 2 页。
for route in \
  bug1004949/product-category.html \
  bug1004949/product-category-p2.html \
  product-category-root.html \
  product-category-root-p2.html \
  bug1004949/article-category.html \
  bug1004949/article-category-p2.html \
  article-category-root.html \
  article-category-root-p2.html; do
  safe_name="${route//\//-}"
  safe_name="${safe_name%.html}"
  "$PWCLI" --session "$SESSION" goto "$BASE_URL/$route?case=0038&replay=1"
  "$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/case-0038-${safe_name}-replay.yml"
done

# 用例-0039：较短、结构更简单的自定义 URL。
"$PWCLI" --session "$SESSION" goto "$BASE_URL/short.html?case=0039&replay=1"
"$PWCLI" --session "$SESSION" snapshot --filename "$EVIDENCE_DIR/case-0039-short-frontend-replay.yml"
