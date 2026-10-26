#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  if (record.heading_text_mode === "v3_full") {
    return `区块标题测试-${record.block_id}-第${String(sequence).padStart(2, "0")}项`;
  }
  return `区块标题测试-${record.block_id}-${chineseTemplateName(record)}-第${sequence}项`;
}

export const MODAL_HEADING_TEMPLATES = new Set([
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
  await matches[0].click({ force: true, timeout: 1000 });
  await editor.page.waitForTimeout(700);
}

export async function configureInlineEditors(editor, audit, record, startSequence) {
  const frame = editor.canvasContexts().find((candidate) => candidate.url() === audit.frame_url);
  if (!frame) throw new Error("未找到区块所在画布");
  const root = frame.locator(audit.fingerprint).first();
  await root.scrollIntoViewIfNeeded();
  const configured = [];
  const configuredIds = new Set();
  const attemptedIds = new Set();
  const errors = [];
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
    if (configuredIds.has(id) || attemptedIds.has(id)) return;
    attemptedIds.add(id);
    const existingText = normalize(await editable.locator("h2").first().innerText().catch(() => ""));
    if (existingText.startsWith(recordPrefix)) {
      configuredIds.add(id);
      return;
    }
    const text = expectedText(record, startSequence + configured.length + errors.length);
    await disableHiddenOverlayInterception(editor);
    await editable.click({ force: true, timeout: 1000 });
    await editable.fill(text, { timeout: 1000 });
    const selectEditableContent = async () => editable.evaluate((element, expected) => {
      const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
      const boundary = [...element.childNodes].findIndex(
        (node) => node.nodeType === Node.ELEMENT_NODE && node.matches?.("[roles='widget-settings'],[contenteditable='false']"),
      );
      const contentNodes = [...element.childNodes].slice(0, boundary < 0 ? undefined : boundary);
      const exactNode = contentNodes.find((node) => normalizeText(node.textContent) === expected);
      if (!exactNode && contentNodes.length === 0) return false;
      element.focus();
      const selection = element.ownerDocument.getSelection();
      const range = element.ownerDocument.createRange();
      if (exactNode) {
        range.selectNodeContents(exactNode);
      } else {
        range.setStart(element, 0);
        range.setEnd(element, contentNodes.length);
      }
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    }, text);
    if (!(await selectEditableContent())) await editable.selectText({ timeout: 1000 });
    const shell = frame.locator(`[id="cke_${id}"]`).first();
    const format = shell.locator(".cke_combo__format .cke_combo_button").first();
    if (!(await format.isVisible().catch(() => false))) {
      throw new Error(`内嵌富文本 ${id} 没有“格式”按钮`);
    }
    const h2 = editable.locator("h2").filter({ hasText: text });
    for (let attempt = 1; attempt <= 2 && (await h2.count()) !== 1; attempt += 1) {
      await selectEditableContent();
      await format.click({ force: true, timeout: 1000 });
      await editor.page.waitForTimeout(450);
      await chooseHeading2(editor);
      await h2.first().waitFor({ state: "attached", timeout: 800 }).catch(() => {});
    }
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
    await configureEditable(editables.nth(index), index).catch((error) => errors.push(error.message));
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
      await disableHiddenOverlayInterception(editor);
      await target.click({ force: true, timeout: 1000 }).catch(() => {});
      await editor.page.waitForTimeout(200);
      editables = root.locator("[contenteditable='true'],.cke_editable_inline,[role='textbox']");
      count = await editables.count();
      for (let index = 0; index < count; index += 1) {
        await configureEditable(editables.nth(index), index).catch((error) => errors.push(error.message));
      }
    }
  }
  configured.errors = errors;
  return configured;
}

function escapeHeadingHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Writes through the CKEditor instance already mounted by the editor UI.
 * This is intentionally not a database/API write: the normal page-save flow
 * still persists the changed editor state afterwards.
 */
export async function setCKEditorHeading(context, instanceName, text) {
  const html = `<h2>${escapeHeadingHtml(text)}</h2>`;
  return context.evaluate(
    ({ instanceName: name, html: data, expected }) => new Promise((resolve) => {
      const registry = globalThis.CKEDITOR?.instances ?? {};
      const instance = registry[name] ?? Object.values(registry).find((candidate) => {
        const elementId = candidate?.element?.$?.id ?? "";
        return candidate?.name === name || elementId === name;
      });
      if (!instance) {
        resolve({ ok: false, reason: `未找到CKEditor实例：${name}` });
        return;
      }
      let settled = false;
      let timer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try {
          instance.fire("change");
          instance.fire("blur");
          const actual = String(instance.getData?.() ?? "");
          resolve({
            ok: /<h2(?:\\s[^>]*)?>/iu.test(actual) && actual.includes(expected),
            actual,
            reason: actual.includes(expected) ? "" : "CKEditor写入后读取不到预期文字",
          });
        } catch (error) {
          resolve({ ok: false, reason: error?.message ?? String(error) });
        }
      };
      try {
        instance.setData(data, { callback: finish });
        // Some legacy CKEditor builds do not invoke the setData callback when
        // the instance is inside a partially hidden dialog. Read it back after
        // a short bounded delay so one editor can never hang the whole worker.
        timer = setTimeout(finish, 1500);
      } catch (error) {
        resolve({ ok: false, reason: error?.message ?? String(error) });
      }
    }),
    { instanceName, html, expected: text },
  );
}

async function firstInlineFastCandidate(root, record) {
  if (!record.template_types.some((type) => type === "文本编辑" || type === "图片编辑")) return null;
  const selector = await root.evaluate((rootElement, prefix) => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const path = (node) => {
      const parts = [];
      let current = node;
      while (current && current !== rootElement) {
        const parent = current.parentElement;
        if (!parent) return "";
        parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${[...parent.children].indexOf(current) + 1})`);
        current = parent;
      }
      return current === rootElement ? `:scope > ${parts.join(" > ")}` : "";
    };
    return [...rootElement.querySelectorAll("h1,h2,h3,h4,h5,h6,p,span,div,strong,em")]
      .filter(visible)
      .filter((node) => !node.closest("a,button,[role='button'],[contenteditable='true']"))
      .filter((node) => {
        const text = String(node.innerText || node.textContent || "").replace(/\\s+/gu, " ").trim();
        return text.length >= 2 && text.length <= 240 && !text.startsWith(prefix) && ![...node.children].some((child) => visible(child) && String(child.innerText || child.textContent || "").trim());
      })
      .map(path)
      .find(Boolean) ?? "";
  }, `区块标题测试-${record.block_id}-`);
  return selector || null;
}

export async function configureInlineEditorsFast(editor, audit, record, startSequence) {
  const frame = editor.canvasContexts().find((candidate) => candidate.url() === audit.frame_url);
  if (!frame) throw new Error("未找到区块所在画布");
  const root = frame.locator(audit.fingerprint).first();
  await root.scrollIntoViewIfNeeded();
  const configured = [];
  const errors = [];
  const configuredIds = new Set();
  let editables = root.locator("[contenteditable='true'],.cke_editable_inline,[role='textbox']");
  let count = await editables.count();
  if (count === 0) {
    const candidate = await firstInlineFastCandidate(root, record);
    if (candidate) {
      await root.locator(candidate).click({ force: true, timeout: 1000 }).catch(() => {});
      await editor.page.waitForTimeout(150);
      editables = root.locator("[contenteditable='true'],.cke_editable_inline,[role='textbox']");
      count = await editables.count();
    }
    if (count === 0 && record.template_types.some((type) => type === "文本编辑" || type === "图片编辑")) {
      // Legacy text blocks often mount CKEditor only after a template-specific
      // activation sequence. Reuse the proven UI adapter for this whole block
      // instead of incorrectly classifying it as unsupported.
      const legacy = await configureInlineEditors(editor, audit, record, startSequence);
      legacy.write_mode = "ui_block_fallback";
      return legacy;
    }
  }
  for (let index = 0; index < count; index += 1) {
    const editable = editables.nth(index);
    const id = await editable.getAttribute("id").catch(() => "");
    if (!id || configuredIds.has(id)) continue;
    const text = expectedText(record, startSequence + configured.length);
    const result = await setCKEditorHeading(frame, id, text).catch((error) => ({ ok: false, reason: error.message }));
    if (result.ok) {
      configuredIds.add(id);
      configured.push({ kind: "inline_fast", index, id, text, level: "h2", write_mode: "ckeditor_api" });
      continue;
    }
    // A small, per-editor fallback keeps fast mode compatible with legacy
    // inline instances that do not expose a CKEDITOR registry entry.
    try {
      await editable.click({ force: true, timeout: 1000 });
      await editable.fill(text, { timeout: 1000 });
      await editable.selectText({ timeout: 1000 });
      const format = frame.locator(`[id="cke_${id}"]`).first().locator(".cke_combo__format .cke_combo_button").first();
      await format.click({ force: true, timeout: 1000 });
      await editor.page.waitForTimeout(250);
      await chooseHeading2(editor);
      if (await editable.locator("h2").filter({ hasText: text }).count() !== 1) throw new Error("UI回退后未生成唯一H2");
      configuredIds.add(id);
      configured.push({ kind: "inline_fast_fallback", index, id, text, level: "h2", write_mode: "ui_fallback" });
    } catch (error) {
      errors.push(`${id}:快速写入失败，UI回退也失败：${error.message}`);
    }
  }
  configured.errors = errors;
  return configured;
}

export async function openSettings(editor, audit) {
  const frame = editor.canvasContexts().find((candidate) => candidate.url() === audit.frame_url);
  if (!frame) throw new Error("未找到区块所在画布");
  const root = frame.locator(audit.fingerprint).first();
  await root.scrollIntoViewIfNeeded().catch(() => {});
  // A few very tall legacy blocks report an out-of-viewport box even after
  // Playwright's scrollIntoViewIfNeeded.  Use the browser's own scrolling and
  // make hovering best-effort; the settings button can still be clicked by
  // force below when the toolbar is already mounted in the DOM.
  await root.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" })).catch(() => {});
  await root.hover({ force: true }).catch(() => {});
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
        if (normalizeText(node.innerText || node.textContent) === "设置" && node.id && (visible(node) || node.offsetParent !== null)) found.add(node.id);
      }
      current = current.parentElement;
    }
    return [...found];
  });
  if (ids.length === 0) {
    // Toolbar visibility can lag behind a frame scroll.  A unique semantic
    // button is still safe to activate even when its hover layer is hidden.
    const hiddenIds = await root.evaluate((element) => {
      const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
      return [...element.querySelectorAll("a,button,[role='button']")]
        .filter((node) => normalizeText(node.innerText || node.textContent) === "设置" && node.id)
        .map((node) => node.id);
    }).catch(() => []);
    if (hiddenIds.length === 1) ids.push(hiddenIds[0]);
  }
  if (ids.length === 0) return { opened: false, reason: "没有设置按钮" };
  if (ids.length !== 1) throw new Error(`区块设置按钮数量为 ${ids.length}`);
  const settingsButton = frame.locator(`[id="${ids[0]}"]`).first();
  await settingsButton.click({ force: true }).catch(async () => {
    // The toolbar may be outside the frame viewport even though its semantic
    // button is mounted.  Native DOM click is the final UI-equivalent fallback
    // and still goes through the editor's normal settings dialog.
    await settingsButton.evaluate((node) => node.click());
  });
  await editor.page.waitForTimeout(1100);
  return { opened: true, frame, buttonId: ids[0] };
}

async function modalScope(editor) {
  const deadline = Date.now() + 10000;
  let gallery = null;
  let matches = [];
  while (Date.now() < deadline) {
    gallery = editor.page.locator(".pics_gallery_new:visible");
    const galleryCount = await gallery.count().catch(() => 0);
    if (galleryCount === 1) {
      const save = gallery.locator("a.btn_galleryconfirm").first();
      if (await save.isVisible().catch(() => false)) return { scope: editor.page, container: gallery, save };
    }
    matches = [];
    for (const scope of editor.contexts()) {
      const saves = scope.locator("a.backstage-dialog-submit:visible").filter({ hasText: /^保存$/u });
      const count = await saves.count().catch(() => 0);
      if (count === 1) matches.push({ scope, container: scope.locator("body"), save: saves.first() });
    }
    if (matches.length === 1) return matches[0];
    await editor.page.waitForTimeout(150);
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

export async function configureModalEditors(editor, record, startSequence) {
  const modal = await modalScope(editor);
  const richEditors = await visibleModalRichEditors(editor, modal.container);
  const configured = [];
  for (const rich of richEditors) {
    const text = expectedText(record, startSequence + configured.length);
    await rich.body.click({ timeout: 1000 });
    await rich.body.fill(text, { timeout: 1000 });
    await rich.body.focus();
    await editor.page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await editor.page.waitForTimeout(250);
    await rich.format.click({ timeout: 1000 });
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

export async function configureModalEditorsFast(editor, record, startSequence) {
  const modal = await modalScope(editor);
  const richEditors = await visibleModalRichEditors(editor, modal.container);
  const configured = [];
  const errors = [];
  for (const rich of richEditors) {
    const text = expectedText(record, startSequence + configured.length);
    const shellId = await rich.shell.getAttribute("id").catch(() => "");
    const instanceName = shellId.startsWith("cke_") ? shellId.slice(4) : "";
    let result = { ok: false, reason: "CKEditor弹窗实例名称为空" };
    if (instanceName) {
      result = await setCKEditorHeading(modal.scope, instanceName, text).catch((error) => ({ ok: false, reason: error.message }));
    }
    if (!result.ok) {
      try {
        await rich.body.click({ timeout: 1000 });
        await rich.body.fill(text, { timeout: 1000 });
        await rich.body.focus();
        await editor.page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await rich.format.click({ force: true, timeout: 1000 });
        await editor.page.waitForTimeout(250);
        await chooseHeading2(editor);
        if (await rich.body.locator("h2").filter({ hasText: text }).count() !== 1) throw new Error("UI回退后未生成唯一H2");
        configured.push({ kind: "modal_fast_fallback", index: rich.index, text, level: "h2", write_mode: "ui_fallback" });
        continue;
      } catch (error) {
        errors.push(`弹窗第${rich.index + 1}个富文本快速写入失败，UI回退也失败：${error.message}`);
        continue;
      }
    }
    const heading = rich.body.locator("h2").filter({ hasText: text });
    await heading.first().waitFor({ state: "attached", timeout: 1500 }).catch(() => {});
    if ((await heading.count()) !== 1) {
      errors.push(`弹窗第${rich.index + 1}个富文本写入后未生成唯一H2`);
      continue;
    }
    configured.push({ kind: "modal_fast", index: rich.index, text, level: "h2", write_mode: "ckeditor_api" });
  }
  if (configured.length > 0) {
    await modal.save.click();
    await modal.container.waitFor({ state: "hidden", timeout: 6000 }).catch(() => {});
  }
  configured.errors = errors;
  return { configured, modalSave: modal.save, scopeUrl: modal.scope.url(), errors };
}

export async function saveActivatedInlineSettings(settings, editor) {
  const saves = settings.frame.locator("button.submit:visible,a.submit:visible").filter({ hasText: /^保存$/u });
  if ((await saves.count().catch(() => 0)) === 1) {
    await saves.first().click();
    await editor.page.waitForTimeout(900);
    return;
  }
  // Some activation flows open the normal settings dialog rather than the
  // inline component panel.  In that case the valid save control is the
  // semantic dialog button on the parent page.
  const dialogSaves = editor.page.locator("a.backstage-dialog-submit:visible").filter({ hasText: /^保存$/u });
  if (await dialogSaves.count().catch(() => 0) === 1) {
    await dialogSaves.first().click({ force: true });
    await editor.page.waitForTimeout(900);
    return;
  }
  const gallerySaves = editor.page.locator(".pics_gallery_new:visible a.btn_galleryconfirm");
  if (await gallerySaves.count().catch(() => 0) === 1) {
    await gallerySaves.first().click({ force: true });
    await editor.page.waitForTimeout(900);
    return;
  }
  throw new Error(`激活式富文本组件保存按钮数量为 ${await saves.count().catch(() => 0)}`);
}

export async function verifySettingsBackfill(editor, record, originalVerification) {
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
    // Fast mode records use `modal_fast` (and the UI fallback uses
    // `modal_fast_fallback`).  Treat all modal editor records as the same
    // logical setting field when checking the value after a page reopen.
    const expected = (record.heading_poc ?? [])
      .filter((item) => String(item.kind ?? "").startsWith("modal"))
      .map((item) => item.text);
    const expectedInline = (record.heading_poc ?? [])
      .filter((item) => !String(item.kind ?? "").startsWith("modal"))
      .map((item) => item.text);
    const inlineOk = expectedInline.every((text) => originalVerification.headings?.includes(text));
    const modalOk = expected.every((text) => headings.includes(text));
    const ok = inlineOk && modalOk && (expected.length > 0 || expectedInline.length > 0);
    await cancelModal(editor);
    return ok
      ? { ok: true, reason: "", expected, headings, evidence: "settings_backfill" }
      : originalVerification;
  } catch {
    await cancelModal(editor).catch(() => {});
    return originalVerification;
  }
}

export async function cancelModal(editor) {
  for (const scope of editor.contexts()) {
    const cancel = scope.locator("a.backstage-dialog-cancel:visible").filter({ hasText: /^取消$/u });
    if ((await cancel.count().catch(() => 0)) === 1) {
      // Legacy dialogs leave a hidden overlay with pointer-events enabled.
      // It must never turn cleanup into a block-level heading failure.
      await disableHiddenOverlayInterception(editor);
      await cancel.click({ force: true }).catch(async () => {
        await cancel.evaluate((node) => node.click()).catch(() => {});
      });
      await editor.page.waitForTimeout(600);
      return;
    }
  }
  await editor.page.keyboard.press("Escape").catch(() => {});
}

export async function disableHiddenOverlayInterception(editor) {
  for (const scope of editor.contexts()) {
    await scope.evaluate(() => {
      for (const overlay of document.querySelectorAll(
        ".backstage-dialog-overlay.hide, .backstage-newuser-helplayer, .backstage-newuser-helplayer *",
      )) {
        overlay.style.pointerEvents = "none";
      }
    }).catch(() => {});
  }
}

export async function inspectExpectedHeadings(editor, record) {
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

export async function reopenCustomPage(editor, pageName) {
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
  const config = await loadConfig(options.config ?? "config/ranking-heading.json");
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
        result.errors.push(...(inline.errors ?? []));
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
            result.errors.push(...(activated.errors ?? []));
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`\n失败：${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
