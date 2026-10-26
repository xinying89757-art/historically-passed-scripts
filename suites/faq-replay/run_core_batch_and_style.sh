#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HERE/output"

PWCLI="${PWCLI:?请设置 Playwright CLI 可执行文件路径}"
OUT="${HERE}/output/core-batch-style-20260910.json"
CLI_OUT="/tmp/faq-core-batch-style-run.txt"

"$PWCLI" tab-select 0 >/dev/null
"$PWCLI" tracing-start >/dev/null 2>&1 || true

CODE=$(cat <<'EOF'
(page) => (async () => {
  const original = { question: "What is the minimum order quantity?", answer: "The minimum order quantity is 10 pieces." };
  const second = { question: "Do you provide custom packaging?", answer: "Yes, custom packaging is available for qualifying orders." };
  const result = { runAt: new Date().toISOString(), product: "测试", cases: [], finalState: null };
  const wait = (ms = 350) => page.waitForTimeout(ms);
  const editor = async () => {
    const fs = page.frames().filter(f => f.url().includes("tiptapEditor/editor.html"));
    for (let i = fs.length - 1; i >= 0; i--) {
      if (await fs[i].locator("[contenteditable=true]").count().catch(() => 0) && await fs[i].locator(".faq-block").count().catch(() => 0)) return fs[i];
    }
    return fs[fs.length - 1];
  };
  const outer = () => page.frames().find(f => f.url().includes("website.leadong.com/prod?iframe=1"));
  const publicPage = () => page.context().pages().find(p => p.url().includes("site.example.invalid"));
  const record = async (name, fn) => { const t = Date.now(); try { result.cases.push({ name, status: "passed", durationMs: 0, evidence: await fn() }); result.cases.at(-1).durationMs = Date.now() - t; } catch (e) { result.cases.push({ name, status: "failed", durationMs: Date.now() - t, error: String(e?.message || e) }); } };
  const selectFaq = async () => {
    const f = outer();
    const tabs = f.locator("h3.phoenix_tipTapRichText");
    if (await tabs.count() < 2) throw new Error("FAQ试点页签不存在");
    await tabs.nth(1).dispatchEvent("click");
    await wait(450);
    const ef = await editor();
    await ef.locator(".faq-block").first().waitFor({ state: "visible", timeout: 5000 });
    return ef;
  };
  const openForm = async (ef) => {
    if (!(await ef.locator(".faq-editor-card").count())) {
      const block = ef.locator(".faq-block").first();
      const editButton = ef.locator('button.tb-btn[title="FAQ"]:visible');
      await block.click({ force: true });
      await wait(350);
      if (await editButton.count()) {
        await editButton.click({ force: true });
        await wait(350);
      } else {
        // Some editor states open the same FAQ form on a double click, while
        // the normal selected-block state exposes the recorded FAQ toolbar button.
        await block.dblclick({ force: true });
        await wait(350);
      }
    }
    await ef.locator(".faq-editor-card").waitFor({ state: "visible", timeout: 5000 });
    return ef;
  };
  const saveFaq = async ef => { await ef.getByRole("button", { name: "保存", exact: true }).click({ force: true }); await wait(400); };
  const saveProduct = async f => { await f.locator("a.topBts_menu_save").click({ force: true }); await wait(850); if (!(await f.getByText("产品保存成功！", { exact: true }).count())) throw new Error("产品保存成功提示未出现"); };
  const schema = async () => { const p = publicPage(); await p.reload({ waitUntil: "domcontentloaded" }); await p.waitForTimeout(850); return p.evaluate(() => { const nodes = [...document.querySelectorAll('script[type="application/ld+json"]')]; const parsed = nodes.map(n => { try { return JSON.parse(n.textContent); } catch { return null; } }).filter(Boolean); return { scriptCount: nodes.length, faqPages: parsed.filter(x => x["@type"] === "FAQPage") }; }); };

  await record("FAQ 创建/保存/编辑回显", async () => {
    const f = outer(); const ef = await selectFaq();
    const form = await openForm(ef);
    const q = await form.locator('input[placeholder="请输入FAQ标题"]').first().inputValue();
    const a = await form.locator('textarea[placeholder="请输入FAQ内容"]').first().inputValue();
    if (q !== original.question || a !== original.answer) throw new Error(`${q} / ${a}`);
    return { question: q, answer: a };
  });

  await record("多组 FAQ 添加/上移/下移/删除", async () => {
    const f = outer(); const ef = await selectFaq();
    const form = await openForm(ef);
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
    return { scriptCount: s.scriptCount, faqPageCount: s.faqPages.length, question: q.name };
  });

  await record("1000/1001 字符边界", async () => {
    const f = outer(); let ef = await selectFaq(); let form = await openForm(ef); await form.locator('textarea[placeholder="请输入FAQ内容"]').fill("A".repeat(1000)); await saveFaq(form); await saveProduct(f); let s = await schema(); const len1000 = s.faqPages[0]?.mainEntity?.[0]?.acceptedAnswer?.text?.length;
    ef = await selectFaq(); form = await openForm(ef); await form.locator('textarea[placeholder="请输入FAQ内容"]').fill("B".repeat(1001)); await saveFaq(form); await saveProduct(f); s = await schema(); const text1001 = s.faqPages[0]?.mainEntity?.[0]?.acceptedAnswer?.text || ""; const len1001 = text1001.length;
    ef = await selectFaq(); form = await openForm(ef); await form.locator('textarea[placeholder="请输入FAQ内容"]').fill(original.answer); await saveFaq(form);
    if (len1000 !== 1000 || len1001 !== 1000 || !text1001.startsWith("B")) throw new Error(`${len1000}/${len1001}`);
    return { lengthAt1000: len1000, lengthAt1001Public: len1001, restoredInEditor: true };
  });

  await record("样式编辑工具栏和加粗响应", async () => {
    const f = outer(); const ef = await selectFaq(); const form = await openForm(ef); await saveFaq(form); await wait(200); await ef.locator(".faq-block").dblclick({ force: true }); await wait(250);
    const faqButton = ef.locator('button.tb-btn[title="FAQ"]:visible'); const trigger = ef.locator(".faq-style-target-trigger:visible"); const bold = ef.locator('button.tb-btn[title="加粗"]:visible');
    if (!(await faqButton.count()) || !(await trigger.count()) || !(await bold.count())) throw new Error("样式工具栏控件缺失");
    await trigger.click({ force: true }); await wait(120); const menuText = await ef.locator("body").innerText();
    if (!menuText.includes("FAQ标题") || !menuText.includes("FAQ内容")) throw new Error("FAQ样式类别缺失");
    await ef.getByText("FAQ内容", { exact: true }).click({ force: true }); await wait(120);
    const before = await bold.evaluate(e => e.className); await bold.click({ force: true }); await wait(120); const after = await bold.evaluate(e => e.className); await bold.click({ force: true }); await wait(120); const restored = await bold.evaluate(e => e.className);
    if (before.includes("active") || !after.includes("active") || restored.includes("active")) throw new Error(`${before} -> ${after} -> ${restored}`);
    return { faqEditorButton: true, categories: ["FAQ标题", "FAQ内容"], boldResponse: true, restored: true };
  });

  const finalF = outer();
  await saveProduct(finalF);
  const final = await schema();
  result.finalState = { faqPageCount: final.faqPages.length, question: final.faqPages[0]?.mainEntity?.[0]?.name || null, answer: final.faqPages[0]?.mainEntity?.[0]?.acceptedAnswer?.text || null, restored: final.faqPages.length === 1 && final.faqPages[0]?.mainEntity?.[0]?.name === original.question && final.faqPages[0]?.mainEntity?.[0]?.acceptedAnswer?.text === original.answer };
  return result;
})()
EOF
)

"$PWCLI" run-code "$CODE" | tee "$CLI_OUT"
"$PWCLI" tracing-stop >/dev/null 2>&1 || true
cp "$CLI_OUT" "${OUT%.json}.cli-output.txt"
sed -n '/^### Result$/{n;p;}' "$CLI_OUT" > "$OUT"
