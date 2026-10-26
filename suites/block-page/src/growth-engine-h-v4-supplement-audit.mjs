#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import { loadGrowthEngineConfig } from "./growth-engine-h-config.mjs";
import { GrowthEngineHPage, launchGrowthEngineContext } from "./growth-engine-h-editor.mjs";
import { normalizeLevel, normalizeText, numericRunId } from "./growth-engine-h-core.mjs";

const BLOCK_ATTRS = ["data-block-id", "data-blockid", "block-id", "data-module-id", "data-component-id", "data-app-id", "id"];
const SUPPORTED = "verified";

const PAGE_COLUMNS = ["run_id", "page_name", "page_path", "page_url", "supported_block_count", "unsupported_block_count", "current_h_count", "current_editable_count", "current_readonly_count", "unresolved_count", "status", "failure_reason", "evidence", "checked_at"];
const BLOCK_COLUMNS = ["run_id", "block_id", "block_name", "page_name", "page_path", "page_url", "slot_index", "editor_dom_id", "current_h_count", "current_editable_count", "current_readonly_count", "level_readonly_count", "text_readonly_count", "attribution_scope", "attribution_confidence", "status", "failure_reason", "evidence", "checked_at"];
const ITEM_COLUMNS = ["run_id", "page_name", "page_path", "page_url", "block_id", "block_name", "slot_index", "control_index", "current_level", "current_text", "level_editable", "text_editable", "current_status", "attribution_scope", "attribution_confidence", "dialog_block_id", "preview_block_id", "evidence", "checked_at"];
const UNSUPPORTED_COLUMNS = ["page_name", "page_path", "page_url", "block_id", "block_name", "slot_index", "editor_dom_id", "rich_text_status", "reason"];
const EXCEPTION_COLUMNS = ["run_id", "page_name", "page_path", "page_url", "exception_type", "detail", "evidence", "checked_at"];

function parseArgs(argv) {
  const args = { command: argv[2] ?? "status", config: "config/growth-engine-h-v4.json", runId: "", maxPages: Number.POSITIVE_INFINITY, pagePath: "" };
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === "--config") args.config = argv[++i];
    else if (argv[i] === "--run-id") args.runId = String(argv[++i]);
    else if (argv[i] === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (argv[i] === "--page-path") args.pagePath = String(argv[++i]);
    else if (argv[i] === "--help") { console.log("node src/growth-engine-h-v4-supplement-audit.mjs <plan|run|resume|status|report> [--config FILE] [--run-id ID] [--max-pages N] [--page-path PATH]"); process.exit(0); }
  }
  if (!(args.maxPages > 0)) throw new Error("--max-pages 必须大于0");
  return args;
}

function csvCell(value) { const text = String(value ?? ""); return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function csvText(rows, columns) { return `\uFEFF${[columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n")}\r\n`; }
function safeCell(value) { return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, ""); }
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function atomicJson(file, value) { return mkdir(path.dirname(file), { recursive: true }).then(async () => { const tmp = `${file}.${process.pid}.tmp`; await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(tmp, file); }); }
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
function matchesId(value, id) { return new RegExp(`(?:^|\\D)${escapeRegExp(id)}(?:\\D|$)`, "u").test(String(value ?? "")); }
function normalizePreviewUrl(config, pagePath) {
  const base = new URL(config.publicUrl);
  if (!base.hostname.includes(".preview.")) base.hostname = base.hostname.replace(/\.ldmfyh\.com$/u, ".preview.leadong.com");
  base.pathname = pagePath;
  base.search = "";
  return base.toString();
}
function pageKey(pagePath, blockId) { return `${pagePath}|${blockId}`; }

async function loadInventory(config) {
  const source = JSON.parse(await readFile(config.v4SupplementAudit.sourceBlockStateFile, "utf8"));
  const mirror = JSON.parse(await readFile(config.v4SupplementAudit.sourceMirrorStateFile, "utf8"));
  const mirrorByBlock = new Map();
  for (const page of mirror.pages ?? []) for (const record of page.records ?? []) mirrorByBlock.set(pageKey(page.path, String(record.block_id)), record);
  const sourcePages = source.pages ?? [];
  const recordsByPage = new Map();
  for (const record of source.records ?? []) {
    if (record.status !== "added") continue;
    const pagePath = new URL(record.page_url).pathname;
    const list = recordsByPage.get(pagePath) ?? [];
    list.push(record);
    recordsByPage.set(pagePath, list);
  }
  const pages = sourcePages.map((page) => {
    const allBlocks = (recordsByPage.get(page.path) ?? []).sort((a, b) => Number(a.slot_index) - Number(b.slot_index)).map((record) => {
      const mirrorRecord = mirrorByBlock.get(pageKey(page.path, String(record.block_id)));
      const richTextStatus = mirrorRecord?.rich_text_status ?? mirrorRecord?.expected_rich_text_status ?? "unknown";
      return { page_name: page.name, page_path: page.path, page_url: normalizePreviewUrl(config, page.path), block_id: String(record.block_id), block_name: record.app_name ?? "", slot_index: Number(record.slot_index) || 0, editor_dom_id: record.editor_dom_id ?? "", rich_text_status: richTextStatus, supported: richTextStatus === SUPPORTED };
    });
    return { page_name: page.name, page_path: page.path, page_url: normalizePreviewUrl(config, page.path), blocks: allBlocks.filter((block) => block.supported), allBlocks, unsupported: allBlocks.filter((block) => !block.supported) };
  });
  const blocks = pages.flatMap((page) => page.blocks);
  const unsupported = pages.flatMap((page) => page.unsupported);
  const allBlocks = pages.flatMap((page) => page.allBlocks);
  if (pages.length !== 24 || allBlocks.length !== 215 || blocks.length !== 192 || unsupported.length !== 23) {
    throw new Error(`4.0输入校验失败：页面=${pages.length}、区块=${allBlocks.length}、支持富文本=${blocks.length}、不支持=${unsupported.length}，预期24/215/192/23`);
  }
  return { pages, blocks, unsupported, allBlocks };
}

function pathsFor(config, runId) {
  const base = config.v4SupplementAudit;
  return { stateFile: path.join(path.dirname(base.stateFile), `growth-engine-h-v4-supplement-audit-${runId}.json`), reportsDir: path.join(base.reportsDir, runId), artifactsDir: path.join(base.artifactsDir, runId), outputDir: path.join(base.outputDir, runId) };
}
function pageConfig(config, page, artifactsDir) {
  const out = structuredClone(config);
  out.targetPagePath = page.page_path;
  out.pagePathCandidates = [page.page_path];
  out.publicUrl = page.page_url;
  out.paths.artifactsDir = path.join(artifactsDir, page.page_path.replaceAll("/", "_"));
  return out;
}
function initialState(inventory, runId) {
  const now = new Date().toISOString();
  return { version: 1, kind: "growth_engine_v4_supplement_editability_audit", run_id: runId, phase: "planned", target_page_count: inventory.pages.length, target_block_count: inventory.blocks.length, unsupported_block_count: inventory.unsupported.length, pages: inventory.pages.map((page) => ({ page_name: page.page_name, page_path: page.page_path, page_url: page.page_url, supported_block_count: page.blocks.length, unsupported_block_count: page.unsupported.length, status: "pending", current_h_count: 0, current_editable_count: 0, current_readonly_count: 0, unresolved_count: 0, failure_reason: "", evidence: "", checked_at: "" })), blocks: inventory.blocks.map((block) => ({ ...block, status: "pending", current_h_count: 0, current_editable_count: 0, current_readonly_count: 0, level_readonly_count: 0, text_readonly_count: 0, attribution_scope: "", attribution_confidence: "", failure_reason: "", evidence: "", checked_at: "" })), unsupported: inventory.unsupported.map((block) => ({ ...block, reason: "已有4.0编辑器状态明确标记为不支持富文本" })), items: [], exceptions: [], created_at: now, updated_at: now };
}
function summary(state) {
  const statuses = {}; for (const row of state.blocks) statuses[row.status] = (statuses[row.status] ?? 0) + 1;
  return { run_id: state.run_id, phase: state.phase, target_pages: state.target_page_count, target_blocks: state.target_block_count, unsupported_blocks: state.unsupported_block_count, checked_pages: state.pages.filter((p) => p.status === "complete").length, current_item_count: state.items.length, exception_count: state.exceptions.length, statuses };
}
function controlSummary(items) {
  const supported = items.filter((item) => ["now_editable", "partially_readonly", "still_readonly"].includes(item.current_status));
  return { current_h_count: supported.length, current_editable_count: supported.filter((item) => item.current_status === "now_editable").length, current_readonly_count: supported.filter((item) => item.current_status !== "now_editable").length, level_readonly_count: supported.filter((item) => item.level_editable === false).length, text_readonly_count: supported.filter((item) => item.text_editable === false).length };
}

async function readDialogContext(dialog, blockIds) {
  return dialog.evaluate((root, ids) => {
    const exact = (value, id) => new RegExp(`(?:^|\\D)${String(id).replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?:\\D|$)`, "u").test(String(value ?? ""));
    const all = [...root.querySelectorAll("*")];
    const inputs = [...root.querySelectorAll("input.el-input__inner")];
    const markers = [];
    for (let index = 0; index < all.length; index += 1) {
      const element = all[index];
      const text = String(element.textContent ?? "").replace(/\\s+/gu, " ").trim();
      if (!text || text.length > 300) continue;
      const found = ids.filter((id) => exact(text, id));
      if (found.length !== 1) continue;
      const childHasSame = [...element.children].some((child) => exact(child.textContent, found[0]));
      if (!childHasSame) markers.push({ id: String(found[0]), elementIndex: index, text });
    }
    return inputs.map((input, controlIndex) => {
      const inputIndex = all.indexOf(input);
      const previous = markers.filter((marker) => marker.elementIndex < inputIndex).sort((a, b) => b.elementIndex - a.elementIndex)[0];
      return { controlIndex, blockId: previous?.id ?? "", markerText: previous?.text ?? "" };
    });
  }, blockIds);
}

async function readPreviewMappings(context, page, controls, artifactsDir) {
  const preview = await context.newPage();
  const evidenceDir = path.join(artifactsDir, page.page_path.replaceAll("/", "_"));
  const evidencePath = path.join(evidenceDir, "preview-dom.json");
  const screenshot = path.join(evidenceDir, "preview.png");
  await mkdir(evidenceDir, { recursive: true });
  const ids = page.allBlocks.map((block) => block.block_id);
  try {
    const response = await preview.goto(`${page.page_url}?ge_mapping_audit=1`, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (!response?.ok()) throw new Error(`preview_http_${response?.status() ?? "unknown"}`);
    await preview.waitForTimeout(800);
    const headings = await preview.locator("h1,h2,h3,h4,h5,h6").evaluateAll((elements, blockIds) => {
      const matches = (value, id) => new RegExp(`(?:^|\\D)${String(id).replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?:\\D|$)`, "u").test(String(value ?? ""));
      return elements.map((element, index) => {
        const candidates = new Set(); let current = element;
        for (let depth = 0; current && depth < 24; depth += 1, current = current.parentElement) {
          for (const name of current.getAttributeNames?.() ?? []) {
            const value = current.getAttribute(name) ?? "";
            for (const id of blockIds) if (matches(value, id)) candidates.add(String(id));
          }
        }
        return { index, level: element.tagName.toUpperCase(), text: String(element.textContent ?? "").replace(/\\s+/gu, " ").trim(), candidates: [...candidates] };
      });
    }, ids);
    const mappings = controls.map((control) => {
      const matches = headings.filter((heading) => normalizeText(heading.text) === normalizeText(control.text));
      return { controlIndex: control.index, candidates: [...new Set(matches.flatMap((heading) => heading.candidates))], headingCount: matches.length };
    });
    await writeFile(evidencePath, `${JSON.stringify({ url: preview.url(), headings, mappings }, null, 2)}\n`, "utf8");
    await preview.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    return { mappings, evidencePath, screenshot, error: "" };
  } catch (error) {
    await writeFile(evidencePath, `${JSON.stringify({ url: page.page_url, error: String(error?.message ?? error) }, null, 2)}\n`, "utf8");
    return { mappings: [], evidencePath, screenshot: "", error: String(error?.message ?? error) };
  } finally { await preview.close().catch(() => {}); }
}

function mapControl(control, directMatches, dialogContext, previewMapping) {
  const directIds = [...new Set(directMatches.map((block) => String(block.block_id)))];
  const directId = directIds.length === 1 ? directIds[0] : "";
  const dialogId = directId || dialogContext?.blockId || "";
  const previewIds = [...new Set(previewMapping?.candidates ?? [])];
  const previewId = previewIds.length === 1 ? previewIds[0] : "";
  if (previewId && dialogId && previewId !== dialogId) return { blockId: previewId, scope: "mapping_conflict", confidence: "preview_dom_authoritative", dialogBlockId: dialogId, previewBlockId: previewId };
  if (previewId) return { blockId: previewId, scope: "preview_dom_block_id", confidence: "high", dialogBlockId: dialogId, previewBlockId: previewId };
  if (dialogId) return { blockId: dialogId, scope: directId ? "dialog_text_block_id" : "dialog_nearest_block_id", confidence: directId ? "high" : "medium", dialogBlockId: dialogId, previewBlockId: "" };
  return { blockId: "", scope: previewIds.length > 1 || directIds.length > 1 ? "mapping_ambiguous" : "mapping_unresolved", confidence: "none", dialogBlockId: "", previewBlockId: "" };
}

function itemFromControl(control, page, mapping, state, evidence) {
  const block = page.allBlocks.find((candidate) => String(candidate.block_id) === String(mapping.blockId));
  let currentStatus;
  if (!mapping.blockId) currentStatus = "mapping_unresolved";
  else if (!block?.supported) currentStatus = "unsupported_no_rich_text";
  else currentStatus = control.levelEditable && control.textEditable ? "now_editable" : control.levelEditable || control.textEditable ? "partially_readonly" : "still_readonly";
  return { run_id: state.run_id, page_name: page.page_name, page_path: page.page_path, page_url: page.page_url, block_id: mapping.blockId, block_name: block?.block_name ?? "", slot_index: block?.slot_index ?? "", control_index: control.index + 1, current_level: control.level, current_text: control.text, level_editable: Boolean(control.levelEditable), text_editable: Boolean(control.textEditable), current_status: currentStatus, attribution_scope: mapping.scope, attribution_confidence: mapping.confidence, dialog_block_id: mapping.dialogBlockId, preview_block_id: mapping.previewBlockId, evidence, checked_at: new Date().toISOString() };
}

function blockResult(block, page, items, evidence) {
  const mapped = items.filter((item) => String(item.block_id) === String(block.block_id) && item.current_status !== "unsupported_no_rich_text");
  const conflicts = mapped.filter((item) => item.attribution_scope === "mapping_conflict");
  const stats = controlSummary(mapped);
  const status = conflicts.length ? "mapping_conflict" : mapped.length ? (stats.current_readonly_count === 0 ? "current_now_editable" : stats.current_editable_count === 0 ? "current_still_readonly" : "current_partially_readonly") : "mapping_unresolved";
  return { run_id: page.run_id, block_id: block.block_id, block_name: block.block_name, page_name: page.page_name, page_path: page.page_path, page_url: page.page_url, slot_index: block.slot_index, editor_dom_id: block.editor_dom_id, ...stats, attribution_scope: mapped.length ? [...new Set(mapped.map((item) => item.attribution_scope))].join("、") : "mapping_unresolved", attribution_confidence: mapped.length ? [...new Set(mapped.map((item) => item.attribution_confidence))].join("、") : "none", status, failure_reason: conflicts.length ? "弹窗上下文与预览 DOM 归属冲突，以预览 DOM 为准" : mapped.length ? "" : "当前 H 设置项未能唯一归属到该区块", evidence: mapped.some((item) => item.current_status === "still_readonly" || item.current_status === "partially_readonly") || conflicts.length ? evidence : "", checked_at: new Date().toISOString() };
}

function tableHtml(rows, columns) { return `<table><thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column])}</td>`).join("")}</tr>`).join("\n")}</tbody></table>`; }

async function writeWorkbook(state, outputDir) {
  const workbook = Workbook.create();
  const pages = state.pages.map((row) => ({ ...row, target_block_ids: row.target_block_ids ?? "" }));
  const readonly = state.items.filter((row) => ["still_readonly", "partially_readonly"].includes(row.current_status));
  const unresolved = state.items.filter((row) => ["mapping_unresolved", "mapping_ambiguous"].includes(row.current_status));
  const conflicts = state.items.filter((row) => row.current_status === "mapping_conflict" || row.attribution_scope === "mapping_conflict");
  const sheets = [["按区块结果", state.blocks, BLOCK_COLUMNS], ["按页面结果", pages, PAGE_COLUMNS], ["H设置项明细", state.items, ITEM_COLUMNS], ["仍不可编辑", readonly, ITEM_COLUMNS], ["无法归属", unresolved, ITEM_COLUMNS], ["归属冲突", conflicts, ITEM_COLUMNS], ["不支持富文本", state.unsupported, UNSUPPORTED_COLUMNS], ["异常", state.exceptions, EXCEPTION_COLUMNS], ["运行状态", [summary(state)], Object.keys(summary(state))]];
  for (const [name, rows, columns] of sheets) {
    const sheet = workbook.worksheets.add(name);
    const identifierColumns = new Set(["run_id", "block_id", "dialog_block_id", "preview_block_id"]);
    const matrix = [columns, ...rows.map((row) => columns.map((column) => { const value = safeCell(row[column]); return identifierColumns.has(column) && value ? `'${value}` : value; }))];
    const range = sheet.getRangeByIndexes(0, 0, Math.max(matrix.length, 1), columns.length); range.values = matrix; range.format.wrapText = true; range.format.autofitColumns(); range.format.autofitRows(); sheet.freezePanes.freezeRows(1); sheet.getRangeByIndexes(0, 0, 1, columns.length).format = { fill: "#1F4E78", font: { bold: true, color: "#FFFFFF" }, wrapText: true };
    for (const identifier of identifierColumns) { const columnIndex = columns.indexOf(identifier); if (columnIndex >= 0) sheet.getRangeByIndexes(0, columnIndex, Math.max(matrix.length, 1), 1).format.numberFormat = "@"; }
  }
  await mkdir(outputDir, { recursive: true });
  const file = path.join(outputDir, `4.0补充核查-${state.run_id}.xlsx`);
  const blob = await SpreadsheetFile.exportXlsx(workbook); await blob.save(file); return file;
}

async function writeReports(config, state) {
  const paths = pathsFor(config, state.run_id); await mkdir(paths.reportsDir, { recursive: true });
  const readonly = state.items.filter((row) => ["still_readonly", "partially_readonly"].includes(row.current_status));
  const unresolved = state.items.filter((row) => ["mapping_unresolved", "mapping_ambiguous"].includes(row.current_status));
  const conflicts = state.items.filter((row) => row.current_status === "mapping_conflict" || row.attribution_scope === "mapping_conflict");
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>4.0支持富文本区块H标签可编辑性补充核查</title><style>body{font:14px/1.5 system-ui;margin:24px;color:#1f2937}table{border-collapse:collapse;width:100%;margin:12px 0 28px}th,td{border:1px solid #d9e1ea;padding:6px;text-align:left;vertical-align:top;word-break:break-word}th{background:#eef4f9}.bad{color:#b42318;font-weight:700}</style><h1>4.0支持富文本区块 H 标签可编辑性补充核查</h1><p>批次：${escapeHtml(state.run_id)}；本轮只读核查，不修改、不保存同步、不发布。目标：192 个支持富文本区块；不支持区块：23 个。</p><h2>按区块结果</h2>${tableHtml(state.blocks, BLOCK_COLUMNS)}<h2>仍不可编辑</h2>${tableHtml(readonly, ITEM_COLUMNS)}<h2>无法归属</h2>${tableHtml(unresolved, ITEM_COLUMNS)}<h2>归属冲突</h2>${tableHtml(conflicts, ITEM_COLUMNS)}<h2>不支持富文本</h2>${tableHtml(state.unsupported, UNSUPPORTED_COLUMNS)}<h2>异常</h2>${tableHtml(state.exceptions, EXCEPTION_COLUMNS)}</html>`;
  await Promise.all([
    writeFile(path.join(paths.reportsDir, "4.0补充核查-按区块结果.csv"), csvText(state.blocks, BLOCK_COLUMNS), "utf8"),
    writeFile(path.join(paths.reportsDir, "4.0补充核查-按页面结果.csv"), csvText(state.pages, PAGE_COLUMNS), "utf8"),
    writeFile(path.join(paths.reportsDir, "4.0补充核查-H设置项明细.csv"), csvText(state.items, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(paths.reportsDir, "4.0补充核查-仍不可编辑.csv"), csvText(readonly, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(paths.reportsDir, "4.0补充核查-无法归属.csv"), csvText(unresolved, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(paths.reportsDir, "4.0补充核查-归属冲突.csv"), csvText(conflicts, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(paths.reportsDir, "4.0补充核查-不支持富文本.csv"), csvText(state.unsupported, UNSUPPORTED_COLUMNS), "utf8"),
    writeFile(path.join(paths.reportsDir, "4.0补充核查-异常.csv"), csvText(state.exceptions, EXCEPTION_COLUMNS), "utf8"),
    writeFile(path.join(paths.reportsDir, "4.0补充核查-运行状态.json"), `${JSON.stringify(summary(state), null, 2)}\n`, "utf8"),
    writeFile(path.join(paths.reportsDir, "4.0补充核查-report.html"), html, "utf8"),
  ]);
  return { reportsDir: paths.reportsDir, excel: await writeWorkbook(state, paths.outputDir) };
}

async function run(config, inventory, state, args) {
  const paths = pathsFor(config, state.run_id); await mkdir(paths.artifactsDir, { recursive: true });
  const context = await launchGrowthEngineContext({ ...config, browser: { ...config.browser, headless: false, startMinimized: true } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  state.phase = "running"; await atomicJson(paths.stateFile, state);
  const selected = (args.pagePath ? state.pages.filter((page) => page.page_path === args.pagePath) : state.pages).slice(0, Number.isFinite(args.maxPages) ? args.maxPages : state.pages.length);
  try {
    for (const pageState of selected) {
      if (pageState.status === "complete" && !args.pagePath) continue;
      const page = inventory.pages.find((candidate) => candidate.page_path === pageState.page_path); if (!page) continue;
      const cfg = pageConfig(config, page, paths.artifactsDir); const artifactPageDir = path.join(paths.artifactsDir, page.page_path.replaceAll("/", "_"));
      state.items = state.items.filter((item) => item.page_path !== page.page_path); state.exceptions = state.exceptions.filter((item) => item.page_path !== page.page_path); state.blocks = state.blocks.filter((item) => item.page_path !== page.page_path); pageState.status = "running"; await atomicJson(paths.stateFile, state);
      let editor; let dialog;
      try {
        editor = new GrowthEngineHPage(context, cfg); await editor.open();
        await editor.refreshAndWait({ failureStatus: "refresh_failed" });
        dialog = await editor.openEditDialog({ allowEmpty: true });
        const controls = await editor.inspectDialog(dialog, { allowEmpty: true });
        const dialogContext = await readDialogContext(dialog, page.allBlocks.map((block) => block.block_id));
        const preview = await readPreviewMappings(context, page, controls, paths.artifactsDir);
        if (preview.error) state.exceptions.push({ run_id: state.run_id, page_name: page.page_name, page_path: page.page_path, page_url: page.page_url, exception_type: "preview_unavailable", detail: preview.error, evidence: preview.evidencePath, checked_at: new Date().toISOString() });
        const items = controls.map((control, index) => {
          const direct = page.allBlocks.filter((block) => matchesId(control.text, block.block_id));
          const mapping = mapControl(control, direct, dialogContext[index], preview.mappings.find((entry) => entry.controlIndex === control.index));
          const evidence = ["preview_dom_block_id", "mapping_conflict"].includes(mapping.scope) ? preview.evidencePath : "";
          return itemFromControl(control, page, mapping, state, evidence);
        });
        state.items.push(...items);
        const supportedItems = items.filter((item) => ["now_editable", "partially_readonly", "still_readonly"].includes(item.current_status));
        const pageStats = controlSummary(supportedItems);
        const unresolvedItems = items.filter((item) => ["mapping_unresolved", "mapping_ambiguous"].includes(item.current_status));
        Object.assign(pageState, pageStats, { unresolved_count: unresolvedItems.length, status: "complete", failure_reason: "", evidence: supportedItems.some((item) => item.current_status !== "now_editable") ? await editor.screenshot(`page-${page.page_path.replaceAll("/", "_")}-readonly.png`) : "", checked_at: new Date().toISOString() });
        for (const block of page.blocks) state.blocks.push(blockResult(block, { ...page, run_id: state.run_id }, items, pageState.evidence));
        for (const item of unresolvedItems) state.exceptions.push({ run_id: state.run_id, page_name: page.page_name, page_path: page.page_path, page_url: page.page_url, exception_type: item.current_status, detail: `H设置项无法唯一归属到区块：${item.current_level}/${item.current_text}`, evidence: preview.evidencePath, checked_at: new Date().toISOString() });
        for (const item of items.filter((entry) => entry.current_status === "unsupported_no_rich_text")) state.exceptions.push({ run_id: state.run_id, page_name: page.page_name, page_path: page.page_path, page_url: page.page_url, exception_type: "unsupported_block_h", detail: `当前H设置项归属于已确认不支持富文本的区块 ${item.block_id}：${item.current_text}`, evidence: preview.evidencePath, checked_at: new Date().toISOString() });
        for (const item of items.filter((entry) => entry.attribution_scope === "mapping_conflict")) state.exceptions.push({ run_id: state.run_id, page_name: page.page_name, page_path: page.page_path, page_url: page.page_url, exception_type: "mapping_conflict", detail: `弹窗归属 ${item.dialog_block_id} 与预览DOM归属 ${item.preview_block_id} 冲突，以预览DOM为准`, evidence: preview.evidencePath, checked_at: new Date().toISOString() });
        console.log(`[4.0补充核查] ${page.page_path} 完成：支持区块 ${page.blocks.length}，H设置项 ${controls.length}，可编辑 ${pageStats.current_editable_count}，只读 ${pageStats.current_readonly_count}，未归属 ${unresolvedItems.length}`);
      } catch (error) {
        const message = String(error?.message ?? error); const status = /login_expired|重新登录/u.test(message) ? "login_expired" : /refresh_failed/u.test(message) ? "refresh_failed" : /page_not_found|page_detail_unavailable/u.test(message) ? "page_not_found" : "automation_error";
        const evidence = await editor?.screenshot(`page-${page.page_path.replaceAll("/", "_")}-${status}.png`).catch(() => "") ?? "";
        pageState.status = status; pageState.failure_reason = message; pageState.evidence = evidence; pageState.checked_at = new Date().toISOString();
        for (const block of page.blocks) state.blocks.push({ ...block, status, current_h_count: 0, current_editable_count: 0, current_readonly_count: 0, level_readonly_count: 0, text_readonly_count: 0, attribution_scope: "page_error", attribution_confidence: "none", failure_reason: message, evidence, checked_at: pageState.checked_at });
        state.exceptions.push({ run_id: state.run_id, page_name: page.page_name, page_path: page.page_path, page_url: page.page_url, exception_type: status, detail: message, evidence, checked_at: pageState.checked_at });
        console.error(`[4.0补充核查] ${page.page_path}：${message}`);
        if (status === "login_expired") { state.phase = "login_expired"; await atomicJson(paths.stateFile, state); break; }
      } finally { if (dialog) await editor?.cancelDialog(dialog).catch(() => {}); }
      await atomicJson(paths.stateFile, state);
    }
    if (state.phase !== "login_expired") state.phase = state.pages.every((page) => page.status === "complete") ? "complete" : "completed_with_failures";
  } finally {
    const tracePath = path.join(paths.artifactsDir, "4.0-supplement-audit-trace.zip"); await mkdir(path.dirname(tracePath), { recursive: true }); await context.tracing.stop({ path: tracePath }).catch(() => {}); await context.close().catch(() => {}); state.trace_path = tracePath; await atomicJson(paths.stateFile, state);
  }
  console.log(JSON.stringify({ ...summary(state), report: await writeReports(config, state) }, null, 2));
}

async function loadState(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }

export async function main(argv = process.argv) {
  const args = parseArgs(argv); const config = await loadGrowthEngineConfig(args.config); const inventory = await loadInventory(config); const runId = args.runId || numericRunId(); const paths = pathsFor(config, runId);
  if (args.command === "plan") { console.log(JSON.stringify({ pages: inventory.pages.length, supportedBlocks: inventory.blocks.length, unsupportedBlocks: inventory.unsupported.length }, null, 2)); return; }
  if (args.command === "status") { const state = await loadState(paths.stateFile); console.log(state ? JSON.stringify(summary(state), null, 2) : "尚无4.0补充核查状态"); return; }
  if (args.command === "report") { const state = await loadState(paths.stateFile); if (!state) throw new Error("没有找到4.0补充核查状态"); console.log(JSON.stringify(await writeReports(config, state), null, 2)); return; }
  const state = args.command === "resume" ? await loadState(paths.stateFile) : initialState(inventory, runId); if (!state) throw new Error("没有可恢复的4.0补充核查状态"); await run(config, inventory, state, args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });

export { loadInventory, mapControl, readDialogContext };
