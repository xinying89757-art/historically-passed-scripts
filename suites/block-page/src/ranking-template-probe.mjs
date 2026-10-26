#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { LeadongEditor, launchEditorBrowser } from "./editor.mjs";

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

function stamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function inspectRoot(frame, fingerprint) {
  const root = frame.locator(fingerprint).first();
  await root.scrollIntoViewIfNeeded();
  await root.hover({ force: true });
  await frame.page().waitForTimeout(650);
  return root.evaluate((element) => {
    const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const editables = [...element.querySelectorAll("[contenteditable='true'],.cke_editable_inline,[role='textbox']")]
      .filter(visible)
      .map((node, index) => ({
        index,
        id: node.id || "",
        className: typeof node.className === "string" ? node.className : "",
        text: normalize(node.innerText || node.textContent).slice(0, 500),
        html: node.innerHTML.slice(0, 1500),
      }));
    const headings = [...element.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((node) => ({
      level: node.tagName.toLowerCase(),
      text: normalize(node.innerText || node.textContent),
    }));
    const candidates = new Set();
    let current = element;
    for (let depth = 0; depth < 5 && current; depth += 1) {
      for (const node of current.querySelectorAll("a,button,[role='button']")) candidates.add(node);
      current = current.parentElement;
    }
    const buttons = [...candidates]
      .filter(visible)
      .map((node) => ({
        id: node.id || "",
        text: normalize(node.innerText || node.textContent),
        title: node.getAttribute("title") || "",
        className: typeof node.className === "string" ? node.className : "",
      }))
      .filter((item) => /设置|编辑|setting|edit/i.test([item.text, item.title, item.className, item.id].join(" ")))
      .slice(0, 50);
    return { editables, headings, buttons };
  });
}

async function clickUniqueSettings(frame, fingerprint) {
  const root = frame.locator(fingerprint).first();
  const ids = await root.evaluate((element) => {
    const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const found = new Set();
    let current = element;
    for (let depth = 0; depth < 5 && current; depth += 1) {
      for (const node of current.querySelectorAll("a,button,[role='button']")) {
        if (visible(node) && normalize(node.innerText || node.textContent) === "设置" && node.id) found.add(node.id);
      }
      current = current.parentElement;
    }
    return [...found];
  });
  if (ids.length !== 1) return { opened: false, reason: `设置按钮数量=${ids.length}`, ids };
  const button = frame.locator(`[id="${ids[0]}"]`);
  if ((await button.count()) !== 1) return { opened: false, reason: "设置按钮无法唯一重定位", ids };
  await button.click();
  await frame.page().waitForTimeout(1200);
  return { opened: true, id: ids[0] };
}

async function inspectVisibleSettings(editor) {
  const contexts = [];
  for (const scope of editor.contexts()) {
    const data = await scope.evaluate(() => {
      const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < innerWidth;
      };
      const dialogs = [...document.querySelectorAll("[role='dialog'],.ui-dialog,.modal,.dialog,.layui-layer,.pics_gallery_new")]
        .filter(visible)
        .map((node) => ({
          id: node.id || "",
          className: typeof node.className === "string" ? node.className : "",
          text: normalize(node.innerText || node.textContent).slice(0, 5000),
        }));
      const controls = [...document.querySelectorAll("input,textarea,select,button,a,label")]
        .filter(visible)
        .map((node) => ({
          tag: node.tagName.toLowerCase(),
          id: node.id || "",
          name: node.getAttribute("name") || "",
          type: node.getAttribute("type") || "",
          className: typeof node.className === "string" ? node.className : "",
          text: normalize(node.innerText || node.textContent).slice(0, 250),
          value: "value" in node ? String(node.value ?? "").slice(0, 500) : "",
          placeholder: node.getAttribute("placeholder") || "",
          checked: "checked" in node ? Boolean(node.checked) : null,
        }))
        .filter((item) => /保存|取消|标题|描述|内容|文字|文本|格式|h[1-6]|heading|title|desc|content|text|ckeditor|cke_/i.test(Object.values(item).join(" ")))
        .slice(0, 300);
      const editables = [...document.querySelectorAll("[contenteditable='true'],body.cke_editable")]
        .filter(visible)
        .map((node) => ({
          id: node.id || "",
          className: typeof node.className === "string" ? node.className : "",
          text: normalize(node.innerText || node.textContent).slice(0, 1000),
          html: node.innerHTML.slice(0, 2500),
        }));
      return { dialogs, controls, editables };
    }).catch(() => ({ dialogs: [], controls: [], editables: [] }));
    if (data.dialogs.length || data.controls.length || data.editables.length) {
      contexts.push({ url: scope.url(), ...data });
    }
  }
  return contexts;
}

async function closeSettings(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);
  const cancel = page.locator("a:visible,button:visible").filter({ hasText: /^取消$/u }).last();
  if (await cancel.isVisible().catch(() => false)) {
    await cancel.click().catch(() => {});
    await page.waitForTimeout(500);
  }
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
  const config = await loadConfig(options.config ?? "config/ranking-heading.json");
  const state = JSON.parse(await readFile(config.paths.stateFile, "utf8"));
  const selectedIds = options.blockIds
    ? new Set(String(options.blockIds).split(",").map((value) => value.trim()).filter(Boolean))
    : null;
  const added = state.records.filter((record) => record.status === "added" && (!selectedIds || selectedIds.has(record.block_id)));
  const outputDir = path.join(config.paths.artifactsDir, "template-probe", stamp());
  await mkdir(outputDir, { recursive: true });
  const { context, page } = await launchEditorBrowser(config, {
    headless: options.headless === true,
    slowMo: Number(options.slowMo ?? 350),
  });
  const results = [];
  try {
    const editor = new LeadongEditor(page, config);
    for (let index = 0; index < added.length; index += 1) {
      const record = added[index];
      await reopenCustomPage(editor, record.page_name);
      const audits = await editor.auditBlock(record.block_id);
      const result = {
        block_id: record.block_id,
        block_name: record.block_name,
        template_types: record.template_types,
        page_name: record.page_name,
        audit_count: audits.length,
      };
      if (audits.length !== 1) {
        result.error = `区块根节点数量=${audits.length}`;
        results.push(result);
        continue;
      }
      const audit = audits[0];
      const frame = editor.canvasContexts().find((candidate) => candidate.url() === audit.frame_url);
      if (!frame) {
        result.error = "未找到区块所在画布";
        results.push(result);
        continue;
      }
      result.root = await inspectRoot(frame, audit.fingerprint);
      result.settings = await clickUniqueSettings(frame, audit.fingerprint);
      if (result.settings.opened) result.settings_ui = await inspectVisibleSettings(editor);
      await page.screenshot({ path: path.join(outputDir, `${record.block_id}.png`), fullPage: true });
      results.push(result);
      await closeSettings(page);
    }
    const jsonPath = path.join(outputDir, "probe.json");
    await writeFile(jsonPath, `${JSON.stringify(results, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ok: true, jsonPath, results: results.map((item) => ({ block_id: item.block_id, template_types: item.template_types, audit_count: item.audit_count, inline_editors: item.root?.editables?.length ?? 0, settings_opened: item.settings?.opened ?? false, settings_contexts: item.settings_ui?.length ?? 0, error: item.error ?? "" })) }, null, 2)}\n`);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  process.stderr.write(`\n失败：${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
