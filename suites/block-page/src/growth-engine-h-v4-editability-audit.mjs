#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGrowthEngineConfig } from "./growth-engine-h-config.mjs";
import { GrowthEngineHPage, launchGrowthEngineContext } from "./growth-engine-h-editor.mjs";
import { normalizeText, stripSyncSuffix, numericRunId } from "./growth-engine-h-core.mjs";
import { toCsv } from "./report.mjs";

const BLOCK_COLUMNS = [
  "page_name", "page_path", "page_url", "category", "slot_index", "block_id", "app_name",
  "editor_dom_id", "expected_h_count", "matched_h_count", "readonly_h_count", "readonly_fields",
  "status", "reason", "checked_at",
];
const ITEM_COLUMNS = [
  "page_name", "page_path", "block_id", "slot_index", "editor_index", "copy_index", "logical_key", "field_name", "level", "text",
  "level_editable", "text_editable", "control_index", "mapping_status", "mapping_source", "reason",
];
const EXCEPTION_COLUMNS = ["page_name", "page_path", "status", "control_count", "unmatched_count", "reason", "checked_at"];

function parseCsv(text) {
  const source = text.replace(/^\uFEFF/u, "");
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(cell); cell = ""; }
    else if (character === "\n") { row.push(cell.replace(/\r$/u, "")); rows.push(row); row = []; cell = ""; }
    else cell += character;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/u, "")); rows.push(row); }
  if (!rows.length) return [];
  return rows.slice(1).map((values) => Object.fromEntries(rows[0].map((key, index) => [key, values[index] ?? ""])));
}

function key(pagePath, blockId) { return `${pagePath}|${blockId}`; }
function clean(value) { return normalizeText(value); }
function sourceVariants(value) {
  const normalized = clean(value);
  return new Set([normalized, stripSyncSuffix(normalized)].filter(Boolean));
}

async function loadInventory(config) {
  const source = JSON.parse(await readFile(config.v4Audit.sourceBlockStateFile, "utf8"));
  const richRows = parseCsv(await readFile(config.v4Audit.sourceRichTextFile, "utf8"));
  const richByBlock = new Map();
  for (const row of richRows) {
    if (!row.page_path || !row.block_id) continue;
    const blockKey = key(row.page_path, row.block_id);
    const list = richByBlock.get(blockKey) ?? [];
    list.push({
      editor_index: Number(row.editor_index) || list.length + 1,
      field_name: row.field_name || "",
      expected_text: row.expected_text || row.actual_text || "",
      expected_level: row.expected_level || row.actual_level || "",
    });
    richByBlock.set(blockKey, list);
  }
  const recordsByPage = new Map();
  for (const record of source.records ?? []) {
    if (record.status !== "added" || !record.page_url) continue;
    const recordPath = new URL(record.page_url).pathname;
    const list = recordsByPage.get(recordPath) ?? [];
    list.push(record);
    recordsByPage.set(recordPath, list);
  }
  const pages = (source.pages ?? []).map((page) => ({
    page_name: page.name,
    page_path: page.path,
    category: page.category,
    page_url: page.publicUrl || page.records?.[0]?.page_url || "",
    blocks: (recordsByPage.get(page.path) ?? []).map((record) => ({
      page_name: page.name,
      page_path: page.path,
      page_url: record.page_url || page.publicUrl || "",
      category: page.category,
      slot_index: Number(record.slot_index) || 0,
      block_id: String(record.block_id),
      app_name: record.app_name || "",
      editor_dom_id: record.editor_dom_id || "",
      rich_texts: richByBlock.get(key(page.path, record.block_id)) ?? [],
    })),
  }));
  const blocks = pages.flatMap((page) => page.blocks);
  if (blocks.length !== 215 || pages.length !== 24) {
    throw new Error(`4.0审计输入校验失败：页面=${pages.length}、区块=${blocks.length}，预期24/215`);
  }
  return { pages, blocks, richByBlock };
}

function controlAttrs(locator) {
  return locator.evaluate((element) => {
    const attrs = {};
    let node = element;
    for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
      for (const attribute of node.attributes ?? []) {
        if (/block|node|setting|relation|uuid|part|app/iu.test(attribute.name)) attrs[attribute.name] ||= attribute.value;
      }
    }
    return attrs;
  }).catch(() => ({}));
}

function attrMatchesBlock(attrs, block) {
  const values = Object.values(attrs).map(String);
  return values.includes(String(block.block_id)) || values.includes(String(block.editor_dom_id));
}

async function readControls(editor, dialog) {
  const controls = await editor.inspectDialog(dialog, { allowEmpty: true });
  const result = [];
  for (let index = 0; index < controls.length; index += 1) {
    const control = controls[index];
    result.push({
      index,
      level: control.level,
      text: control.text,
      levelEditable: control.levelEditable,
      textEditable: control.textEditable,
      attrs: await controlAttrs(control.textInput),
      control,
    });
  }
  return result;
}

function mapPageControls(page, controls) {
  const items = [];
  const usedControls = new Set();
  const unmatched = [];
  const blocksByText = new Map();
  for (const block of page.blocks) {
    for (const rich of block.rich_texts) {
      for (const text of sourceVariants(rich.expected_text)) {
        const list = blocksByText.get(text) ?? [];
        list.push({ block, rich });
        blocksByText.set(text, list);
      }
    }
  }
  for (const entry of controls) {
    const metadataCandidates = page.blocks.filter((block) => attrMatchesBlock(entry.attrs, block));
    const textCandidates = [...sourceVariants(entry.text)].flatMap((text) => blocksByText.get(text) ?? []);
    const metadataMatches = metadataCandidates.flatMap((block) => block.rich_texts
      .filter((rich) => sourceVariants(rich.expected_text).has(clean(entry.text)))
      .map((rich) => ({ block, rich })));
    const candidates = metadataMatches.length
      ? metadataMatches
      : [...new Map(textCandidates.map((candidate) => [
          `${candidate.block.block_id}|${candidate.rich.editor_index}`, candidate,
        ])).values()];
    if (candidates.length !== 1) {
      unmatched.push({ entry, candidates });
      continue;
    }
    const [{ block, rich }] = candidates;
    const logicalKey = `${block.block_id}|${rich.editor_index}`;
    const copyIndex = items.filter((item) => item.logical_key === logicalKey).length + 1;
    usedControls.add(entry.index);
    items.push({
      page_name: page.page_name,
      page_path: page.page_path,
      block_id: block.block_id,
      slot_index: block.slot_index,
      editor_index: rich.editor_index,
      logical_key: logicalKey,
      copy_index: copyIndex,
      field_name: rich.field_name,
      level: entry.level,
      text: entry.text,
      level_editable: entry.levelEditable,
      text_editable: entry.textEditable,
      control_index: entry.index,
      mapping_status: "mapped",
      mapping_source: metadataCandidates.length ? "control_metadata" : "source_text",
      reason: "",
    });
  }
  return { items, unmatched };
}

function aggregateBlocks(page, mapped, unmatched, status, reason) {
  const itemByBlock = new Map();
  for (const item of mapped) {
    const list = itemByBlock.get(item.block_id) ?? [];
    list.push(item);
    itemByBlock.set(item.block_id, list);
  }
  return page.blocks.map((block) => {
    const items = itemByBlock.get(block.block_id) ?? [];
    const matchedLogical = new Set(items.map((item) => item.logical_key));
    const readonly = items.filter((item) => !item.level_editable || !item.text_editable);
    const readonlyFields = [...new Set(readonly.flatMap((item) => [
      !item.level_editable ? "级别" : "",
      !item.text_editable ? "文字" : "",
    ].filter(Boolean)))];
    let blockStatus;
    let blockReason = "";
    if (status !== "checked") {
      blockStatus = status;
      blockReason = reason;
    } else if (block.rich_texts.length === 0) {
      blockStatus = unmatched.length === 0 ? "no_h_detected" : "unresolved_no_source";
      blockReason = unmatched.length === 0 ? "该页面没有未归属H设置项" : "页面存在未能归属到区块的H设置项，无法安全判断该区块";
    } else if (matchedLogical.size < block.rich_texts.length) {
      blockStatus = "engine_item_missing";
      blockReason = `预期${block.rich_texts.length}个逻辑H项，实际匹配${matchedLogical.size}项`;
    } else if (readonly.length === 0) {
      blockStatus = "editable";
    } else if (readonly.length === items.length) {
      blockStatus = "readonly";
      blockReason = `增长引擎明确只读：${readonlyFields.join("、")}`;
    } else {
      blockStatus = "partially_readonly";
      blockReason = `部分设置项明确只读：${readonlyFields.join("、")}`;
    }
    return {
      page_name: block.page_name,
      page_path: block.page_path,
      page_url: block.page_url,
      category: block.category,
      slot_index: block.slot_index,
      block_id: block.block_id,
      app_name: block.app_name,
      editor_dom_id: block.editor_dom_id,
      expected_h_count: block.rich_texts.length,
      matched_h_count: items.length,
      readonly_h_count: readonly.length,
      readonly_fields: readonlyFields.join("、"),
      status: blockStatus,
      reason: blockReason,
      checked_at: new Date().toISOString(),
    };
  });
}

function makeInitialState(inventory, runId) {
  return {
    version: 1,
    kind: "growth_engine_v4_editability_audit",
    run_id: runId,
    phase: "planned",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    source: "v4-block-run-state-proxy.json",
    pages: inventory.pages.map((page) => ({
      page_name: page.page_name,
      page_path: page.page_path,
      status: "pending",
      preview_url: "",
      control_count: 0,
      matched_count: 0,
      unmatched_count: 0,
      failure_reason: "",
      checked_at: "",
    })),
    blocks: [],
    items: [],
    exceptions: [],
  };
}

async function saveState(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  state.updated_at = new Date().toISOString();
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function closeDialog(editor, dialog) {
  await editor.cancelDialog(dialog).catch(async () => {
    const close = dialog.locator(".el-dialog__headerbtn:visible").last();
    if (await close.count()) await close.click().catch(() => {});
    else await editor.page?.keyboard?.press("Escape").catch(() => {});
  });
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function writeReports(state, config) {
  const reportsDir = config.v4Audit.reportsDir;
  await mkdir(reportsDir, { recursive: true });
  const readonly = state.blocks.filter((row) => ["readonly", "partially_readonly"].includes(row.status));
  await Promise.all([
    writeFile(path.join(reportsDir, "v4-growth-engine-editability-blocks.csv"), toCsv(state.blocks, BLOCK_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-growth-engine-editability-items.csv"), toCsv(state.items, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-growth-engine-readonly-blocks.csv"), toCsv(readonly, BLOCK_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-growth-engine-audit-exceptions.csv"), toCsv(state.exceptions, EXCEPTION_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-growth-engine-editability-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8"),
  ]);
  const counts = state.blocks.reduce((map, row) => { map[row.status] = (map[row.status] ?? 0) + 1; return map; }, {});
  const rows = state.blocks.map((row) => `<tr><td>${escapeHtml(row.page_path)}</td><td>${escapeHtml(row.block_id)}</td><td>${escapeHtml(row.app_name)}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.readonly_fields)}</td><td>${escapeHtml(row.reason)}</td></tr>`).join("\n");
  const html = `<!doctype html><meta charset="utf-8"><title>4.0增长引擎可编辑性审计</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:28px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px;text-align:left}th{background:#f3f5f7}.readonly{color:#b42318}</style><h1>4.0增长引擎全部区块可编辑性审计</h1><p>批次：${escapeHtml(state.run_id)}；页面：${state.pages.length}；区块：${state.blocks.length}；状态：${escapeHtml(JSON.stringify(counts))}</p><table><thead><tr><th>页面</th><th>区块ID</th><th>区块名称</th><th>状态</th><th>只读字段</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table>`;
  await writeFile(path.join(reportsDir, "v4-growth-engine-editability-report.html"), html, "utf8");
  return { reportsDir, counts, readonly: readonly.length };
}

async function authenticate(config) {
  const context = await launchGrowthEngineContext(config, { auth: true });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: config.timeouts.navigationMs });
  console.log("已打开登录页。完成登录并进入网站后关闭浏览器，登录状态会保存在本机。");
  await new Promise((resolve) => context.on("close", resolve));
}

async function runAudit(config, { resume = false, maxPages = Number.POSITIVE_INFINITY } = {}) {
  const inventory = await loadInventory(config);
  const statePath = config.v4Audit.stateFile;
  let state;
  if (resume) {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } else {
    state = makeInitialState(inventory, numericRunId());
    await saveState(statePath, state);
  }
  const pageByPath = new Map(inventory.pages.map((page) => [page.page_path, page]));
  const context = await launchGrowthEngineContext({ ...config, browser: { ...config.browser, headless: false, startMinimized: true } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  state.phase = "running";
  let processed = 0;
  try {
    for (const pageState of state.pages) {
      if (pageState.status === "checked") continue;
      if (processed >= maxPages) break;
      const page = pageByPath.get(pageState.page_path);
      if (!page) continue;
      state.blocks = state.blocks.filter((row) => row.page_path !== page.page_path);
      state.items = state.items.filter((row) => row.page_path !== page.page_path);
      state.exceptions = state.exceptions.filter((row) => row.page_path !== page.page_path);
      const pageConfig = structuredClone(config);
      pageConfig.targetPagePath = page.page_path;
      pageConfig.pagePathCandidates = [page.page_path];
      pageConfig.publicUrl = new URL(page.page_path, config.publicUrl).toString();
      const editor = new GrowthEngineHPage(context, pageConfig);
      console.log(`[4.0可编辑性审计] ${page.page_path}，区块 ${page.blocks.length}`);
      try {
        await editor.open();
        pageState.preview_url = await editor.readPreviewUrl().catch(() => pageConfig.publicUrl);
        await editor.refreshAndWait({ failureStatus: "refresh_failed" });
        const dialog = await editor.openEditDialog({ allowEmpty: true });
        const controls = await readControls(editor, dialog);
        const mapped = mapPageControls(page, controls);
        pageState.control_count = controls.length;
        pageState.matched_count = mapped.items.length;
        pageState.unmatched_count = mapped.unmatched.length;
        pageState.status = "checked";
        pageState.checked_at = new Date().toISOString();
        state.items.push(...mapped.items);
        state.blocks.push(...aggregateBlocks(page, mapped.items, mapped.unmatched, "checked", ""));
        if (mapped.unmatched.length) {
          state.exceptions.push({
            page_name: page.page_name, page_path: page.page_path, status: "unmapped_engine_items",
            control_count: controls.length, unmatched_count: mapped.unmatched.length,
            reason: "存在无法唯一归属到4.0区块的增长引擎H设置项；未将其随机归属到区块",
            checked_at: pageState.checked_at,
          });
        }
        await closeDialog(editor, dialog);
        console.log(`[4.0可编辑性审计] ${page.page_path} 完成，H设置项 ${controls.length}，匹配 ${mapped.items.length}，未归属 ${mapped.unmatched.length}`);
      } catch (error) {
        const message = error.message || String(error);
        pageState.status = /login_expired|重新登录/u.test(message) ? "login_expired"
          : /refresh_failed/u.test(message) ? "refresh_failed"
            : /page_not_found|page_detail_unavailable/u.test(message) ? "page_not_found" : "automation_failed";
        pageState.failure_reason = message;
        pageState.checked_at = new Date().toISOString();
        state.blocks.push(...aggregateBlocks(page, [], [], pageState.status, message));
        state.exceptions.push({ page_name: page.page_name, page_path: page.page_path, status: pageState.status, control_count: 0, unmatched_count: 0, reason: message, checked_at: pageState.checked_at });
        await editor.screenshot(`audit-${page.page_path.replaceAll("/", "_")}-${pageState.status}.png`).catch(() => {});
        console.error(`[4.0可编辑性审计] ${page.page_path}：${message}`);
        if (pageState.status === "login_expired") break;
      }
      processed += 1;
      await saveState(statePath, state);
      await writeReports(state, config);
    }
  } finally {
    const tracePath = path.join(config.v4Audit.artifactsDir, `audit-${state.run_id}.zip`);
    await mkdir(config.v4Audit.artifactsDir, { recursive: true });
    await context.tracing.stop({ path: tracePath }).catch(() => {});
    await context.close();
  }
  const pending = state.pages.some((page) => page.status === "pending");
  state.phase = pending ? "paused" : state.pages.some((page) => page.status !== "checked") ? "completed_with_issues" : "complete";
  await saveState(statePath, state);
  console.log(JSON.stringify(await writeReports(state, config), null, 2));
  return state;
}

function parseArgs(argv) {
  const args = { command: argv[2] ?? "status", config: "config/growth-engine-h-v4.json", resume: false, maxPages: Number.POSITIVE_INFINITY };
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] === "--config") args.config = argv[++index];
    else if (argv[index] === "--max-pages") args.maxPages = Number(argv[++index]);
    else if (argv[index] === "--resume") args.resume = true;
  }
  if (!(args.maxPages > 0)) throw new Error("--max-pages 必须大于0");
  return args;
}

export async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const config = await loadGrowthEngineConfig(args.config);
  if (args.command === "plan") {
    const inventory = await loadInventory(config);
    console.log(JSON.stringify({ pages: inventory.pages.length, blocks: inventory.blocks.length, withRichText: inventory.blocks.filter((block) => block.rich_texts.length).length, withoutRichText: inventory.blocks.filter((block) => !block.rich_texts.length).length }, null, 2));
  } else if (args.command === "auth") await authenticate(config);
  else if (args.command === "run") await runAudit(config, { maxPages: args.maxPages });
  else if (args.command === "resume") await runAudit(config, { resume: true, maxPages: args.maxPages });
  else if (args.command === "status") {
    try {
      const state = JSON.parse(await readFile(config.v4Audit.stateFile, "utf8"));
      console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, pages: state.pages.length, checked: state.pages.filter((page) => page.status === "checked").length, pending: state.pages.filter((page) => page.status === "pending").length, blocks: state.blocks.length, readonly: state.blocks.filter((row) => ["readonly", "partially_readonly"].includes(row.status)).length }, null, 2));
    } catch (error) {
      if (error.code === "ENOENT") console.log("尚无4.0可编辑性审计状态");
      else throw error;
    }
  } else if (args.command === "report") {
    const state = JSON.parse(await readFile(config.v4Audit.stateFile, "utf8"));
    console.log(JSON.stringify(await writeReports(state, config), null, 2));
  } else throw new Error(`未知命令：${args.command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

export { aggregateBlocks, loadInventory, mapPageControls, sourceVariants };
