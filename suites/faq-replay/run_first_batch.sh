#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HERE/output"

PWCLI="${PWCLI:?请设置 Playwright CLI 可执行文件路径}"
OUT="${HERE}/output/first-batch-20260910.json"
CLI_OUT="/tmp/faq-first-batch-run.txt"

"$PWCLI" tab-select 0 >/dev/null

CODE=$(cat <<'EOF'
(page) => (async () => {
  const original = { question: "What is the minimum order quantity?", answer: "The minimum order quantity is 10 pieces." };
  const second = { question: "Do you provide custom packaging?", answer: "Yes, custom packaging is available for qualifying orders." };
  const result = { runAt: new Date().toISOString(), product: "测试", cases: [], finalState: null };
  const wait = (ms = 350) => page.waitForTimeout(ms);
  const outer = () => page.frames().find(f => f.url().includes("website.leadong.com/prod?iframe=1"));
  const editor = async () => {
    const fs = page.frames().filter(f => f.url().includes("tiptapEditor/editor.html"));
    for (let i = fs.length - 1; i >= 0; i--) {
      if (await fs[i].locator("[contenteditable=true]").count().catch(() => 0) && await fs[i].locator(".faq-block").count().catch(() => 0)) return fs[i];
    }
    throw new Error("FAQ 编辑 iframe 未就绪");
  };
  const selectFaq = async () => {
    const f = outer();
    const tabs = f.locator("h3.phoenix_tipTapRichText");
    if (await tabs.count() < 2) throw new Error("FAQ试点页签不存在");
    await tabs.nth(1).dispatchEvent("click");
    await wait(700);
    const ef = await editor();
    await ef.locator(".faq-block").first().waitFor({ state: "visible", timeout: 5000 });
    return ef;
  };
  const openForm = async (ef) => {
    if (!(await ef.locator(".faq-editor-card").count())) {
      const block = ef.locator(".faq-block").first();
      await block.click({ force: true });
      await wait(650);
      const editButton = ef.locator('button.tb-btn[title="FAQ"]:visible');
      if (await editButton.count()) await editButton.click({ force: true });
      else await block.dblclick({ force: true });
      await wait(500);
    }
    await ef.locator(".faq-editor-card").waitFor({ state: "visible", timeout: 5000 });
    return ef;
  };
  const record = async (name, fn) => { const t = Date.now(); try { result.cases.push({ name, status: "passed", durationMs: 0, evidence: await fn() }); result.cases.at(-1).durationMs = Date.now() - t; } catch (e) { result.cases.push({ name, status: "failed", durationMs: Date.now() - t, error: String(e?.message || e) }); } };
  const saveFaq = async ef => { await ef.getByRole("button", { name: "保存", exact: true }).click({ force: true }); await wait(450); };
  const saveProduct = async f => { await f.locator("a.topBts_menu_save").click({ force: true }); await wait(1000); if (!(await f.getByText("产品保存成功！", { exact: true }).count())) throw new Error("产品保存成功提示未出现"); };
  const schema = async () => { const p = page.context().pages().find(p => p.url().includes("site.example.invalid")); await p.reload({ waitUntil: "domcontentloaded" }); await p.waitForTimeout(900); return p.evaluate(() => { const nodes = [...document.querySelectorAll('script[type="application/ld+json"]')]; const parsed = nodes.map(n => { try { return JSON.parse(n.textContent); } catch { return null; } }).filter(Boolean); return { scriptCount: nodes.length, faqPages: parsed.filter(x => x["@type"] === "FAQPage") }; }); };

  await record("FAQ 创建/保存/编辑回显", async () => {
    const ef = await selectFaq();
    const form = await openForm(ef);
    const q = await form.locator('input[placeholder="请输入FAQ标题"]').first().inputValue();
    const a = await form.locator('textarea[placeholder="请输入FAQ内容"]').first().inputValue();
    await form.getByRole("button", { name: "取消", exact: true }).click({ force: true });
    if (q !== original.question || a !== original.answer) throw new Error(`${q} / ${a}`);
    return { question: q, answer: a, editSelector: 'button.tb-btn[title="FAQ"]' };
  });

  await record("多组 FAQ 添加/上移/下移/删除", async () => {
    const f = outer(); const ef = await selectFaq(); const form = await openForm(ef);
    await form.locator(".faq-editor-add").click({ force: true }); await wait(180);
    await form.locator('input[placeholder="请输入FAQ标题"]').last().fill(second.question);
    await form.locator('textarea[placeholder="请输入FAQ内容"]').last().fill(second.answer);
    const afterAdd = await form.locator(".faq-editor-item").count();
    await form.locator(".faq-editor-item").nth(1).locator('[aria-label="上移"]').click({ force: true }); await wait(150);
    const afterUp = await form.locator('input[placeholder="请输入FAQ标题"]').evaluateAll(es => es.map(e => e.value));
    await form.locator(".faq-editor-item").first().locator('[aria-label="下移"]').click({ force: true }); await wait(150);
    const afterDown = await form.locator('input[placeholder="请输入FAQ标题"]').evaluateAll(es => es.map(e => e.value));
    await form.locator(".faq-editor-item").nth(1).locator(".faq-editor-item-remove").click({ force: true }); await wait(180);
    const afterDelete = await form.locator(".faq-editor-item").count();
    await saveFaq(form); await saveProduct(f);
    if (afterAdd !== 2 || afterDelete !== 1 || afterUp[0] !== second.question || afterDown[0] !== original.question) throw new Error(JSON.stringify({ afterAdd, afterUp, afterDown, afterDelete }));
    return { afterAdd, afterUp, afterDown, afterDelete };
  });

  await record("公开页单个 FAQPage", async () => {
    const s = await schema(); const q = s.faqPages[0]?.mainEntity?.[0];
    if (s.faqPages.length !== 1 || q?.name !== original.question || q?.acceptedAnswer?.text !== original.answer) throw new Error(JSON.stringify(s));
    return { scriptCount: s.scriptCount, faqPageCount: s.faqPages.length, question: q.name, answer: q.acceptedAnswer.text };
  });

  const final = await schema();
  result.finalState = { faqPageCount: final.faqPages.length, question: final.faqPages[0]?.mainEntity?.[0]?.name || null, answer: final.faqPages[0]?.mainEntity?.[0]?.acceptedAnswer?.text || null, restored: final.faqPages.length === 1 && final.faqPages[0]?.mainEntity?.[0]?.name === original.question && final.faqPages[0]?.mainEntity?.[0]?.acceptedAnswer?.text === original.answer };
  return result;
})()
EOF
)

"$PWCLI" run-code "$CODE" | tee "$CLI_OUT"
sed -n '/^### Result$/{n;p;}' "$CLI_OUT" > "$OUT"
