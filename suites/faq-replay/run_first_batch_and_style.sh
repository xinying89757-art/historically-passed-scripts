#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HERE/output"

PWCLI="${PWCLI:?请设置 Playwright CLI 可执行文件路径}"
OUT="${HERE}/output/first-batch-style-20260910.json"

"$PWCLI" tab-select 0 >/dev/null
"$PWCLI" tracing-start >/dev/null

CODE=$(cat <<'EOF'
(page) => (async () => {
  const output = {
    runAt: new Date().toISOString(),
    product: "测试",
    publicUrl: "http://site.example.invalid/--example-item.html",
    cases: [],
    finalState: null
  };
  const original = {
    question: "What is the minimum order quantity?",
    answer: "The minimum order quantity is 10 pieces."
  };
  const second = {
    question: "Do you provide custom packaging?",
    answer: "Yes, custom packaging is available for qualifying orders."
  };

  const wait = (ms = 500) => page.waitForTimeout(ms);
  const record = async (name, fn) => {
    const started = Date.now();
    try {
      const evidence = await fn();
      output.cases.push({ name, status: evidence?.status || "passed", durationMs: Date.now() - started, evidence });
    } catch (error) {
      output.cases.push({ name, status: "failed", durationMs: Date.now() - started, error: String(error?.message || error) });
    }
  };
  const outer = () => page.frames().find(f => f.url().includes("website.leadong.com/prod?iframe=1"));
  const editor = () => {
    const frames = page.frames().filter(f => f.url().includes("tiptapEditor/editor.html"));
    return frames[frames.length - 1];
  };
  const publicPage = () => page.context().pages().find(p => p.url().includes("site.example.invalid"));
  const ensureEdit = async () => {
    let f = outer();
    if (!f) throw new Error("产品管理 iframe 未找到");
    if (!(await f.locator("a.topBts_menu_save").count())) {
      const back = f.locator("a.back-to-list:visible").last();
      if (await back.count()) {
        await back.click({ force: true });
        await wait(800);
      }
      f = outer();
      const edit = f.locator('a[action="prod_new_update"][prodid="tYpVQvOlCPDd"]').nth(1);
      await edit.click({ force: true });
      await wait(1200);
    }
    f = outer();
    await f.locator("a.topBts_menu_save").waitFor({ state: "attached", timeout: 8000 });
    return f;
  };
  const selectDesc = async (f, name) => {
    const tab = f.getByText(name, { exact: true }).last();
    await tab.click({ force: true });
    await wait(500);
    const ef = editor();
    if (!ef) throw new Error("内容编辑器 iframe 未找到");
    return ef;
  };
  const openFaqForm = async (ef) => {
    if (!(await ef.locator(".faq-editor-card").count())) {
      await ef.locator(".faq-block").dblclick({ force: true });
      await wait(350);
    }
    await ef.locator(".faq-editor-card").waitFor({ state: "visible", timeout: 5000 });
    return ef;
  };
  const saveFaq = async (ef) => {
    await ef.getByRole("button", { name: "保存", exact: true }).click({ force: true });
    await wait(450);
  };
  const saveProduct = async (f) => {
    await f.locator("a.topBts_menu_save").click({ force: true });
    await wait(900);
    if (!(await f.getByText("产品保存成功！", { exact: true }).count())) throw new Error("产品保存成功提示未出现");
  };
  const publicSchema = async () => {
    const p = publicPage();
    if (!p) throw new Error("公开页标签未找到");
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForTimeout(900);
    return await p.evaluate(() => {
      const nodes = [...document.querySelectorAll('script[type="application/ld+json"]')];
      const parsed = nodes.map(n => { try { return JSON.parse(n.textContent); } catch { return null; } }).filter(Boolean);
      return { scriptCount: nodes.length, faqPages: parsed.filter(x => x["@type"] === "FAQPage") };
    });
  };
  const reopenProduct = async () => {
    let f = outer();
    const back = f.locator("a.back-to-list:visible").last();
    if (await back.count()) { await back.click({ force: true }); await wait(800); }
    f = outer();
    await f.locator('a[action="prod_new_update"][prodid="tYpVQvOlCPDd"]').nth(1).click({ force: true });
    await wait(1200);
    return outer();
  };
  const addDescWithFaq = async (name, q, a) => {
    let f = await ensureEdit();
    await f.locator("a.add-desc").click({ force: true });
    const modal = f.locator(".addDesc:visible");
    await modal.locator('input[placeholder="请输入"]').fill(name);
    await modal.getByText("确定", { exact: true }).click({ force: true });
    await wait(750);
    f = outer();
    const ef = await selectDesc(f, name);
    if (!(await ef.locator(".faq-editor-card").count())) {
      await ef.locator(".placeholder-plus").click({ force: true });
      await wait(200);
      const card = ef.locator('.slash-card[data-slash-name="faqBlock"]');
      if (await card.count()) await card.dispatchEvent("click");
      await wait(450);
    }
    await ef.locator('input[placeholder="请输入FAQ标题"]').fill(q);
    await ef.locator('textarea[placeholder="请输入FAQ内容"]').fill(a);
    await saveFaq(ef);
    await saveProduct(f);
  };
  const removeDesc = async (name) => {
    let f = await ensureEdit();
    const title = f.locator("span.descTitle").filter({ hasText: name }).first();
    await title.locator("..").locator(".removeDesc").click({ force: true });
    const popup = f.locator("#popupLayer_sysConfirmPop");
    await popup.getByText("确定", { exact: true }).click({ force: true });
    await wait(500);
    return f;
  };

  await record("第一批｜FAQ 创建、保存和编辑回显", async () => {
    const f = await ensureEdit();
    const ef = await selectDesc(f, "FAQ试点");
    await openFaqForm(ef);
    const q = await ef.locator('input[placeholder="请输入FAQ标题"]').first().inputValue();
    const a = await ef.locator('textarea[placeholder="请输入FAQ内容"]').first().inputValue();
    if (q !== original.question || a !== original.answer) throw new Error(`回显不匹配: ${q} / ${a}`);
    return { question: q, answer: a };
  });

  await record("第一批｜FAQ 多组添加、排序和删除", async () => {
    const f = await ensureEdit();
    const ef = await selectDesc(f, "FAQ试点");
    await openFaqForm(ef);
    await ef.locator('input[placeholder="请输入FAQ标题"]').last().fill(second.question);
    await ef.locator('textarea[placeholder="请输入FAQ内容"]').last().fill(second.answer);
    await ef.locator(".faq-editor-add").click({ force: true });
    await wait(250);
    const countAfterAdd = await ef.locator(".faq-editor-item").count();
    if (countAfterAdd !== 2) throw new Error(`新增后问答组数量=${countAfterAdd}`);
    const secondItem = ef.locator(".faq-editor-item").nth(1);
    await secondItem.locator('.faq-editor-item-move[aria-label="上移"]').click({ force: true });
    await wait(200);
    const afterUp = await ef.locator('input[placeholder="请输入FAQ标题"]').evaluateAll(es => es.map(e => e.value));
    await ef.locator(".faq-editor-item").first().locator('.faq-editor-item-move[aria-label="下移"]').click({ force: true });
    await wait(200);
    const afterDown = await ef.locator('input[placeholder="请输入FAQ标题"]').evaluateAll(es => es.map(e => e.value));
    await ef.locator(".faq-editor-item").nth(1).locator(".faq-editor-item-remove").click({ force: true });
    await wait(200);
    const countAfterDelete = await ef.locator(".faq-editor-item").count();
    if (countAfterDelete !== 1) throw new Error(`删除后问答组数量=${countAfterDelete}`);
    await saveFaq(ef);
    await saveProduct(f);
    return { countAfterAdd, afterUp, afterDown, countAfterDelete };
  });

  await record("第一批｜公开页生成单个 FAQPage", async () => {
    const schema = await publicSchema();
    const q = schema.faqPages[0]?.mainEntity?.[0];
    if (schema.faqPages.length !== 1 || q?.name !== original.question || q?.acceptedAnswer?.text !== original.answer) throw new Error(JSON.stringify(schema));
    return { scriptCount: schema.scriptCount, faqPageCount: schema.faqPages.length, question: q.name };
  });

  await record("第一批｜1000/1001 字符边界", async () => {
    let f = await ensureEdit();
    let ef = await selectDesc(f, "FAQ试点");
    await openFaqForm(ef);
    await ef.locator('textarea[placeholder="请输入FAQ内容"]').fill("A".repeat(1000));
    await saveFaq(ef); await saveProduct(f);
    let schema = await publicSchema();
    const len1000 = schema.faqPages[0]?.mainEntity?.[0]?.acceptedAnswer?.text?.length;
    f = await reopenProduct(); ef = await selectDesc(f, "FAQ试点"); await openFaqForm(ef);
    await ef.locator('textarea[placeholder="请输入FAQ内容"]').fill("B".repeat(1001));
    await saveFaq(ef); await saveProduct(f);
    schema = await publicSchema();
    const text1001 = schema.faqPages[0]?.mainEntity?.[0]?.acceptedAnswer?.text || "";
    const len1001 = text1001.length;
    f = await reopenProduct(); ef = await selectDesc(f, "FAQ试点"); await openFaqForm(ef);
    await ef.locator('textarea[placeholder="请输入FAQ内容"]').fill(original.answer);
    await saveFaq(ef); await saveProduct(f);
    if (len1000 !== 1000 || len1001 !== 1000 || !text1001.startsWith("B")) throw new Error(`长度异常: ${len1000}/${len1001}`);
    return { lengthAt1000: len1000, lengthAt1001Public: len1001, restored: true };
  });

  await record("第一批｜两个 FAQ 板块生成两个独立 FAQPage", async () => {
    await addDescWithFaq("FAQ试点2", second.question, second.answer);
    let schema = await publicSchema();
    const names = schema.faqPages.flatMap(x => x.mainEntity?.map(q => q.name) || []);
    const twoBoards = schema.faqPages.length === 2 && names.includes(original.question) && names.includes(second.question);
    let f = await reopenProduct();
    await removeDesc("FAQ试点2");
    await saveProduct(f);
    if (!twoBoards) throw new Error(JSON.stringify(schema));
    return { scriptCount: schema.scriptCount, faqPageCount: schema.faqPages.length, names, cleanup: true };
  });

  await record("第一批｜无 FAQ 时不生成 FAQPage", async () => {
    let f = await reopenProduct();
    await removeDesc("FAQ试点");
    await saveProduct(f);
    const schema = await publicSchema();
    const passed = schema.faqPages.length === 0;
    f = await reopenProduct();
    await addDescWithFaq("FAQ试点", original.question, original.answer);
    const restored = await publicSchema();
    if (!passed || restored.faqPages.length !== 1) throw new Error(`无FAQ或恢复失败: ${JSON.stringify({ schema, restored })}`);
    return { noFaqScriptCount: schema.scriptCount, noFaqPageCount: schema.faqPages.length, restoredFaqPageCount: restored.faqPages.length };
  });

  await record("样式编辑｜工具栏定位和加粗控件响应", async () => {
    const f = await ensureEdit();
    const ef = await selectDesc(f, "FAQ试点");
    if (await ef.locator(".faq-editor-card").count()) { await saveFaq(ef); }
    await ef.locator(".faq-block").dblclick({ force: true });
    await wait(300);
    const faqButton = ef.locator('button.tb-btn[title="FAQ"]:visible');
    const trigger = ef.locator(".faq-style-target-trigger:visible");
    const bold = ef.locator('button.tb-btn[title="加粗"]:visible');
    if (!(await faqButton.count()) || !(await trigger.count()) || !(await bold.count())) throw new Error("样式工具栏控件缺失");
    await trigger.click({ force: true }); await wait(150);
    const options = await ef.locator("body").innerText();
    if (!options.includes("FAQ标题") || !options.includes("FAQ内容")) throw new Error("样式类别缺失");
    await ef.getByText("FAQ内容", { exact: true }).click({ force: true }); await wait(150);
    const before = await bold.evaluate(e => e.className);
    await bold.click({ force: true }); await wait(180);
    const after = await bold.evaluate(e => e.className);
    await bold.click({ force: true }); await wait(180);
    const restored = await bold.evaluate(e => e.className);
    if (!after.includes("active") || before.includes("active") || restored.includes("active")) throw new Error(`加粗状态异常: ${before} -> ${after} -> ${restored}`);
    return { faqButton: true, categories: ["FAQ标题", "FAQ内容"], boldResponse: true, restored: true };
  });

  const finalSchema = await publicSchema();
  output.finalState = {
    faqPageCount: finalSchema.faqPages.length,
    question: finalSchema.faqPages[0]?.mainEntity?.[0]?.name || null,
    answer: finalSchema.faqPages[0]?.mainEntity?.[0]?.acceptedAnswer?.text || null,
    restored: finalSchema.faqPages.length === 1 && finalSchema.faqPages[0]?.mainEntity?.[0]?.name === original.question
  };
  return output;
})()
EOF
)

CLI_OUT="/tmp/faq-first-batch-style-run.txt"
"$PWCLI" run-code "$CODE" | tee "$CLI_OUT"
"$PWCLI" tracing-stop >/dev/null || true
cp "$CLI_OUT" "${OUT%.json}.cli-output.txt"
sed -n '/^### Result$/{n;p;}' "$CLI_OUT" > "$OUT"
