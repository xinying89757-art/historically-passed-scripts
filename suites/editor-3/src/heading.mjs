#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { LeadongEditor, launchEditorBrowser } from "./editor.mjs";
import { StateStore } from "./state.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function normalize(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function chineseTemplateName(record) {
  return record.template_types.join("和").replaceAll("1", "一").replaceAll("2", "二").replaceAll("3", "三").replaceAll("4", "四");
}

function expectedText(record, sequence) {
  return `区块标题测试-${record.block_id}-${chineseTemplateName(record)}-第${sequence}项`;
}

const MODAL_HEADING_TEMPLATES = new Set([
  "多媒体集类型1",
  "多媒体集类型2",
  "图片集类型1",
  "图片集类型2",
  "图片集类型3",
  "图文页签",
]);

async function chooseHeading2(editor) {
  const matches = [];
  for (const scope of editor.contexts()) {
    const option = scope.locator('[role="option"][title="标题 2"]');
    const count = await option.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = option.nth(index);
      if (await candidate.isVisible().catch(() => false)) matches.push(candidate);
    }
  }
  if (matches.length !== 1) {
    throw new Error(`格式菜单中可见“标题 2”的数量为 ${matches.length}`);
  }
  await matches[0].click({ force: true });
  await editor.page.waitForTimeout(700);
}

async function configureInlineEditors(editor, audit, record, startSequence) {
  const frame = editor.canvasContexts().find((candidate) => candidate.url() === audit.frame_url);
  if (!frame) throw new Error("未找到区块所在画布");
  const root = frame.locator(audit.fingerprint).first();
  await root.scrollIntoViewIfNeeded();
  const configured = [];
  const configuredIds = new Set();
  const recordPrefix = `区块标题测试-${record.block_id}-`;
  const existingHeadingTexts = await root.locator("h2").evaluateAll(
    (nodes, prefix) => [...new Set(nodes.map((node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim()).filter((text) => text.startsWith(prefix)))],
    recordPrefix,
  );
  for (const text of existingHeadingTexts) {
    configured.push({ kind: "inline_existing", index: configured.length, id: "", text, level: "h2" });
  }
  const configureEditable = async (editable, index) => {
    if (!(await editable.isVisible().catch(() => false))) return;
    const id = await editable.getAttribute("id");
    if (!id) throw new Error(`第 ${index + 1} 个内嵌富文本没有稳定ID`);
    if (configuredIds.has(id)) return;
    const existingText = normalize(await editable.locator("h2").first().innerText().catch(() => ""));
    if (existingText.startsWith(recordPrefix)) {
      configuredIds.add(id);
      return;
    }
    const text = expectedText(record, startSequence + configured.length);
    await editable.click();
    await editable.fill(text);
    const selectedDirectText = await editable.evaluate((element) => {
      const textNodes = [...element.childNodes].filter(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent || "").trim(),
      );
      if (textNodes.length === 0) return false;
      element.focus();
      const selection = element.ownerDocument.getSelection();
      const range = element.ownerDocument.createRange();
      const first = textNodes[0];
      const last = textNodes[textNodes.length - 1];
      range.setStart(first, 0);
      range.setEnd(last, last.textContent?.length ?? 0);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    });
    if (!selectedDirectText) await editable.selectText();
    const shell = frame.locator(`[id="cke_${id}"]`).first();
    const format = shell.locator(".cke_combo__format .cke_combo_button").first();
    if (!(await format.isVisible().catch(() => false))) {
      throw new Error(`内嵌富文本 ${id} 没有“格式”按钮`);
    }
    await format.click();
    await editor.page.waitForTimeout(450);
    await chooseHeading2(editor);
    const h2 = editable.locator("h2").filter({ hasText: text });
    await h2.first().waitFor({ state: "attached", timeout: 4000 }).catch(() => {});
    if ((await h2.count()) !== 1) {
      const actualHtml = await editable.innerHTML().catch(() => "");
      throw new Error(`内嵌富文本没有生成唯一H2：${text}；实际HTML=${actualHtml.slice(0, 800)}`);
    }
    configuredIds.add(id);
    configured.push({ kind: "inline", index, id, text, level: "h2" });
  };

  let editables = root.locator("[contenteditable='true'],.cke_editable_inline,[role='textbox']");
  let count = await editables.count();
  for (let index = 0; index < count; index += 1) {
    await configureEditable(editables.nth(index), index);
  }

  const needsClickActivation = record.template_types.some((type) => type === "文本编辑" || type === "图片编辑");
  if (needsClickActivation) {
    const candidates = await root.evaluate((rootElement, prefix) => {
      const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const pathFromRoot = (node) => {
        const parts = [];
        let current = node;
        while (current && current !== rootElement) {
          const parent = current.parentElement;
          if (!parent) return "";
          const index = [...parent.children].indexOf(current) + 1;
          parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
          current = parent;
        }
        return current === rootElement ? `:scope > ${parts.join(" > ")}` : "";
      };
      return [...rootElement.querySelectorAll("h1,h2,h3,h4,h5,h6,p,span,div,strong,em")]
        .filter(visible)
        .filter((node) => !node.closest("a,button,[role='button'],[contenteditable='true']"))
        .filter((node) => {
          const text = normalizeText(node.innerText || node.textContent);
          if (text.length < 2 || text.length > 240) return false;
          if (text.startsWith(prefix)) return false;
          return ![...node.children].some((child) => visible(child) && normalizeText(child.innerText || child.textContent));
        })
        .map((node) => ({ selector: pathFromRoot(node), text: normalizeText(node.innerText || node.textContent) }))
        .filter((item) => item.selector)
        .slice(0, 40);
    }, recordPrefix);
    for (const candidate of candidates) {
      const target = root.locator(candidate.selector).first();
      if (!(await target.isVisible().catch(() => false))) continue;
      await target.click().catch(() => {});
      await editor.page.waitForTimeout(500);
      editables = root.locator("[contenteditable='true'],.cke_editable_inline,[role='textbox']");
      count = await editables.count();
      for (let index = 0; index < count; index += 1) {
        await configureEditable(editables.nth(index), index);
      }
    }
  }
  return configured;
}

async function openSettings(editor, audit) {
  const frame = editor.canvasContexts().find((candidate) => candidate.url() === audit.frame_url);
  if (!frame) throw new Error("未找到区块所在画布");
  const root = frame.locator(audit.fingerprint).first();
  await root.scrollIntoViewIfNeeded();
  await root.hover({ force: true });
  await editor.page.waitForTimeout(600);
  const ids = await root.evaluate((element) => {
    const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const found = new Set();
    let current = element;
    for (let depth = 0; depth < 5 && current; depth += 1) {
      for (const node of current.querySelectorAll("a,button,[role='button']")) {
        if (visible(node) && normalizeText(node.innerText || node.textContent) === "设置" && node.id) found.add(node.id);
      }
      current = current.parentElement;
    }
    return [...found];
  });
  if (ids.length === 0) return { opened: false, reason: "没有设置按钮" };
  if (ids.length !== 1) throw new Error(`区块设置按钮数量为 ${ids.length}`);
  await frame.locator(`[id="${ids[0]}"]`).click();
  await editor.page.waitForTimeout(1100);
  return { opened: true, frame, buttonId: ids[0] };
}

async function modalScope(editor) {
  const gallery = editor.page.locator(".pics_gallery_new:visible");
  const galleryCount = await gallery.count().catch(() => 0);
  if (galleryCount === 1) {
    const save = gallery.locator("a.btn_galleryconfirm").first();
    await save.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    if ((await save.count()) !== 1) {
      throw new Error(`图片集/多媒体集弹窗保存按钮数量为 ${await save.count()}`);
    }
    return { scope: editor.page, container: gallery, save: save.first() };
  }
  const matches = [];
  for (const scope of editor.contexts()) {
    const saves = scope.locator("a.backstage-dialog-submit:visible").filter({ hasText: /^保存$/u });
    const count = await saves.count().catch(() => 0);
    if (count === 1) matches.push({ scope, container: scope.locator("body"), save: saves.first() });
  }
  if (matches.length !== 1) {
    throw new Error(`可见设置弹窗保存按钮所在上下文数量为 ${matches.length}`);
  }
  return matches[0];
}

async function visibleModalRichEditors(editor, container) {
  await container.locator(".cke").first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  const shells = container.locator(".cke:visible");
  const found = [];
  const count = await shells.count();
  for (let index = 0; index < count; index += 1) {
    const shell = shells.nth(index);
    const iframe = shell.locator("iframe").first();
    if ((await iframe.count()) !== 1) continue;
    const handle = await iframe.elementHandle();
    const frame = await handle?.contentFrame();
    if (!frame) continue;
    const body = frame.locator("body[contenteditable='true'],body.cke_editable").first();
    if ((await body.count()) !== 1) continue;
    const format = shell.locator(".cke_combo__format .cke_combo_button").first();
    if (!(await format.isVisible().catch(() => false))) continue;
    found.push({ index, shell, frame, body, format });
  }
  return found;
}

async function configureModalEditors(editor, record, startSequence) {
  const modal = await modalScope(editor);
  const richEditors = await visibleModalRichEditors(editor, modal.container);
  const configured = [];
  for (const rich of richEditors) {
    const text = expectedText(record, startSequence + configured.length);
    await rich.body.click();
    await rich.body.fill(text);
    await rich.body.focus();
    await editor.page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await editor.page.waitForTimeout(250);
    await rich.format.click();
    await editor.page.waitForTimeout(450);
    await chooseHeading2(editor);
    const heading = rich.body.locator("h2").filter({ hasText: text });
    await heading.first().waitFor({ state: "attached", timeout: 4000 }).catch(() => {});
    if ((await heading.count()) !== 1) {
      const actualHtml = await rich.body.innerHTML().catch(() => "");
      throw new Error(
        `弹窗第 ${rich.index + 1} 个富文本没有生成唯一H2；实际HTML=${actualHtml.slice(0, 800)}`,
      );
    }
    configured.push({ kind: "modal", index: rich.index, text, level: "h2" });
  }
  if (configured.length > 0) {
    await modal.save.click();
    await editor.page.waitForTimeout(1200);
  }
  return { configured, modalSave: modal.save, scopeUrl: modal.scope.url() };
}

async function saveActivatedInlineSettings(settings, editor) {
  const saves = settings.frame.locator("button.submit:visible,a.submit:visible").filter({ hasText: /^保存$/u });
  if ((await saves.count().catch(() => 0)) !== 1) {
    throw new Error(`激活式富文本组件保存按钮数量为 ${await saves.count().catch(() => 0)}`);
  }
  await saves.first().click();
  await editor.page.waitForTimeout(900);
}

async function verifySettingsBackfill(editor, record, originalVerification) {
  const audits = await editor.auditBlock(record.block_id);
  if (audits.length !== 1) return originalVerification;
  const settings = await openSettings(editor, audits[0]);
  if (!settings.opened) return originalVerification;
  try {
    const modal = await modalScope(editor);
    const richEditors = await visibleModalRichEditors(editor, modal.container);
    const headings = [];
    for (const rich of richEditors) {
      headings.push(...await rich.body.locator("h2").evaluateAll((nodes) => nodes.map((node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim())));
    }
    const expected = (record.heading_poc ?? []).filter((item) => item.kind === "modal").map((item) => item.text);
    const ok = expected.length > 0 && expected.every((text) => headings.includes(text));
    await cancelModal(editor);
    return ok
      ? { ok: true, reason: "", expected, headings, evidence: "settings_backfill" }
      : originalVerification;
  } catch {
    await cancelModal(editor).catch(() => {});
    return originalVerification;
  }
}

async function cancelModal(editor) {
  for (const scope of editor.contexts()) {
    const cancel = scope.locator("a.backstage-dialog-cancel:visible").filter({ hasText: /^取消$/u });
    if ((await cancel.count().catch(() => 0)) === 1) {
      await cancel.click();
      await editor.page.waitForTimeout(600);
      return;
    }
  }
  await editor.page.keyboard.press("Escape").catch(() => {});
}

async function disableHiddenOverlayInterception(editor) {
  for (const scope of editor.contexts()) {
    await scope.evaluate(() => {
      for (const overlay of document.querySelectorAll(".backstage-dialog-overlay.hide")) {
        overlay.style.pointerEvents = "none";
      }
    }).catch(() => {});
  }
}

async function inspectExpectedHeadings(editor, record) {
  const audits = await editor.auditBlock(record.block_id);
  if (audits.length !== 1) return { ok: false, reason: `区块根节点数量=${audits.length}`, headings: [] };
  const audit = audits[0];
  const frame = editor.canvasContexts().find((candidate) => candidate.url() === audit.frame_url);
  if (!frame) return { ok: false, reason: "未找到区块所在画布", headings: [] };
  const expected = (record.heading_poc ?? []).map((item) => item.text);
  if (expected.length > 0) {
    await frame.locator(audit.fingerprint).first().locator("h2").filter({ hasText: expected[0] }).first().waitFor({ state: "attached", timeout: 10000 }).catch(() => {});
  }
  const headings = await frame.locator(audit.fingerprint).first().locator("h2").evaluateAll((nodes) => nodes.map((node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim()));
  return {
    ok: expected.every((text) => headings.includes(text)),
    reason: expected.every((text) => headings.includes(text)) ? "" : "画布H2与预期不一致",
    expected,
    headings,
  };
}

async function reopenCustomPage(editor, pageName) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await editor.goto();
    try {
      await editor.openCustomPage(pageName);
      return;
    } catch (error) {
      lastError = error;
      await editor.page.keyboard.press("Escape").catch(() => {});
      await editor.page.waitForTimeout(900);
    }
  }
  throw new Error(`连续3次无法打开自定义页面“${pageName}”：${lastError?.message ?? "未知错误"}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.apply) {
    throw new Error("设置H标签会修改并保存页面，必须显式传 --apply");
  }
  const config = await loadConfig(options.config ?? "config/run.json");
  const store = new StateStore(config.paths.stateFile);
  const state = JSON.parse(await readFile(config.paths.stateFile, "utf8"));
  const selectedIds = options.blockIds
    ? new Set(String(options.blockIds).split(",").map((value) => value.trim()).filter(Boolean))
    : null;
  const records = state.records.filter((record) =>
    record.status === "added" &&
    (!selectedIds || selectedIds.has(record.block_id)) &&
    !(options.skipComplete && record.heading_status === "configured"),
  );
  const outputDir = path.join(config.paths.artifactsDir, "heading-poc", timestamp());
  await mkdir(outputDir, { recursive: true });
  const { context, page } = await launchEditorBrowser(config, {
    headless: options.headless === true,
    slowMo: Number(options.slowMo ?? 500),
  });
  const results = [];
  try {
    const editor = new LeadongEditor(page, config);
    for (const record of records) {
      const result = { block_id: record.block_id, page_name: record.page_name, template_types: record.template_types, configured: [], errors: [], saves: [] };
      await reopenCustomPage(editor, record.page_name);
      try {
        let audits = await editor.auditBlock(record.block_id);
        if (audits.length !== 1) throw new Error(`区块根节点数量=${audits.length}`);
        const inline = await configureInlineEditors(editor, audits[0], record, 1);
        result.configured.push(...inline);
        if (inline.length > 0) {
          await disableHiddenOverlayInterception(editor);
          result.saves.push({ phase: "inline", ...(await editor.savePage()) });
          await reopenCustomPage(editor, record.page_name);
          audits = await editor.auditBlock(record.block_id);
          if (audits.length !== 1) throw new Error(`内嵌文本保存后区块根节点数量=${audits.length}`);
        }

        const needsModal = record.template_types.some((type) => MODAL_HEADING_TEMPLATES.has(type));
        const settings = needsModal ? await openSettings(editor, audits[0]) : { opened: false };
        if (needsModal && !settings.opened && result.configured.length === 0) {
          result.errors.push("模板需要设置弹窗，但未找到目标区块的设置入口");
        } else if (settings.opened) {
          try {
            const modal = await configureModalEditors(editor, record, result.configured.length + 1);
            result.configured.push(...modal.configured);
            if (modal.configured.length > 0) {
              await disableHiddenOverlayInterception(editor);
              result.saves.push({ phase: "settings", ...(await editor.savePage()) });
            } else {
              result.errors.push("设置弹窗没有支持H标签的富文本输入框");
              await cancelModal(editor);
            }
          } catch (error) {
            if (!/可见设置弹窗保存按钮所在上下文数量为 0/u.test(error.message)) throw error;
            const refreshed = await editor.auditBlock(record.block_id);
            if (refreshed.length !== 1) throw error;
            const activated = await configureInlineEditors(editor, refreshed[0], record, result.configured.length + 1);
            if (activated.length === 0) throw error;
            result.configured.push(...activated);
            await saveActivatedInlineSettings(settings, editor);
            await disableHiddenOverlayInterception(editor);
            result.saves.push({ phase: "activated_inline_settings", ...(await editor.savePage()) });
          }
        }
        if (result.configured.length === 0) result.errors.push("区块没有可设置H标签的文本输入区");
      } catch (error) {
        result.errors.push(error.message);
        await cancelModal(editor).catch(() => {});
      }
      record.heading_poc = result.configured;
      await reopenCustomPage(editor, record.page_name);
      result.verification = await inspectExpectedHeadings(editor, record);
      if (!result.verification.ok && record.template_types.some((type) => MODAL_HEADING_TEMPLATES.has(type))) {
        result.verification = await verifySettingsBackfill(editor, record, result.verification);
      }
      if (!result.verification.ok && !result.errors.includes(result.verification.reason)) {
        result.errors.push(result.verification.reason);
      }
      record.heading_results = result.configured;
      record.heading_failure_reason = result.errors.join("；");
      record.heading_verified_at = new Date().toISOString();
      const blockingErrors = result.errors.filter(
        (message) => !(
          result.configured.length > 0 &&
          result.verification.ok &&
          /可见设置弹窗保存按钮所在上下文数量为 0/u.test(message)
        ),
      );
      if (result.configured.length > 0 && blockingErrors.length === 0 && result.verification.ok) {
        record.heading_status = "configured";
      } else if (
        result.configured.length === 0 &&
        result.errors.some((message) =>
          /设置弹窗没有支持H标签的富文本输入框|没有可设置H标签的文本输入区|未找到目标区块的设置入口/u.test(message),
        )
      ) {
        record.heading_status = "unsupported_no_h_control";
      } else {
        record.heading_status = "heading_failed";
      }
      await store.save(state);
      results.push(result);
    }
    const jsonPath = path.join(outputDir, "result.json");
    await writeFile(jsonPath, `${JSON.stringify(results, null, 2)}\n`);
    await page.screenshot({ path: path.join(outputDir, "final.png"), fullPage: true, timeout: 15000 }).catch(() => {});
    process.stdout.write(`${JSON.stringify({ ok: true, jsonPath, results }, null, 2)}\n`);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  process.stderr.write(`\n失败：${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
