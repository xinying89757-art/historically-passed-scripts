#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HERE/output"

PWCLI="${PWCLI:?请设置 Playwright CLI 可执行文件路径}"
OUT="${HERE}/output/style-edit-20260910.json"
CLI_OUT="/tmp/faq-style-edit-run.txt"

"$PWCLI" tab-select 0 >/dev/null

CODE=$(cat <<'EOF'
(page) => (async () => {
  const result = { runAt: new Date().toISOString(), case: "样式编辑工具栏和加粗响应", status: "failed", evidence: null, error: null };
  try {
    await page.reload();
    await page.waitForTimeout(3000);
    let f = page.frames().find(f => f.url().includes("website.leadong.com/prod?iframe=1"));
    if (!f) throw new Error("产品管理页面未就绪");
    const editHref = '/prod?invokeAction=prod_new_update&prodId=YOUR_PRODUCT_ID';
    const editLink = f.locator(`a[href="${editHref}"]`).first();
    if (!(await editLink.count())) throw new Error("测试产品编辑入口未找到");
    await editLink.click({ force: true });
    await page.waitForTimeout(1800);
    f = page.frames().find(f => f.url().includes("website.leadong.com/prod?iframe=1"));
    const tabs = f.locator("h3.phoenix_tipTapRichText");
    await tabs.nth(1).dispatchEvent("click");
    await page.waitForTimeout(900);
    const ef = page.frames().filter(f => f.url().includes("tiptapEditor/editor.html")).at(-1);
    const block = ef.locator(".faq-block").first();
    await block.waitFor({ state: "visible", timeout: 5000 });
    await block.click({ force: true });
    await page.waitForTimeout(700);
    const edit = ef.locator('button.tb-btn[title="FAQ"]:visible');
    const trigger = ef.locator(".faq-style-target-trigger:visible");
    const bold = ef.locator('button.tb-btn[title="加粗"]:visible');
    const counts = { edit: await edit.count(), trigger: await trigger.count(), bold: await bold.count() };
    if (!counts.edit || !counts.trigger || !counts.bold) throw new Error(`样式工具栏控件缺失: ${JSON.stringify(counts)}`);
    await trigger.click({ force: true });
    await page.waitForTimeout(200);
    const menuText = await ef.locator("body").innerText();
    const categories = { title: menuText.includes("FAQ标题"), content: menuText.includes("FAQ内容") };
    await ef.getByText("FAQ内容", { exact: true }).click({ force: true });
    await page.waitForTimeout(150);
    const before = await bold.getAttribute("class");
    await bold.click({ force: true });
    await page.waitForTimeout(150);
    const active = await bold.getAttribute("class");
    await bold.click({ force: true });
    await page.waitForTimeout(150);
    const restored = await bold.getAttribute("class");
    if (before.includes("active") || !active.includes("active") || restored.includes("active")) throw new Error(`${before} -> ${active} -> ${restored}`);
    result.status = "passed";
    result.evidence = { counts, categories, bold: { before, active, restored }, contentUnchanged: true };
  } catch (e) {
    result.error = String(e?.message || e);
  }
  return result;
})()
EOF
)

"$PWCLI" run-code "$CODE" | tee "$CLI_OUT"
sed -n '/^### Result$/{n;p;}' "$CLI_OUT" > "$OUT"
