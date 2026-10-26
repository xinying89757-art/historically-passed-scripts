#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import { loadGrowthEngineConfig } from "./growth-engine-h-config.mjs";
import { GrowthEngineHPage, launchGrowthEngineContext } from "./growth-engine-h-editor.mjs";
import { numericRunId, normalizeText } from "./growth-engine-h-core.mjs";
import { readReadonlyWorkbook } from "./growth-engine-h-v3-readonly-recheck.mjs";

const PROJECT_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const BLOCK_ATTRS = ["data-block-id", "data-blockid", "block-id", "data-module-id", "data-component-id", "data-app-id", "id"];

function parseArgs(argv) {
  const args = { command: argv[2] ?? "status", config: "config/growth-engine-h-v3-readonly-recheck.json", runId: "", maxPages: Number.POSITIVE_INFINITY, pagePath: "" };
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === "--config") args.config = argv[++i];
    else if (argv[i] === "--run-id") args.runId = String(argv[++i]);
    else if (argv[i] === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (argv[i] === "--page-path") args.pagePath = String(argv[++i]);
    else if (argv[i] === "--help") { console.log("node src/growth-engine-h-v3-supplement-audit.mjs <run|resume|status|report> [--config FILE] [--run-id ID] [--max-pages N] [--page-path PATH]"); process.exit(0); }
  }
  if (!(args.maxPages > 0)) throw new Error("--max-pages 必须大于0");
  return args;
}

function csvCell(value) { const text = String(value ?? ""); return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function csvText(rows, columns) { return `\uFEFF${[columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n")}\r\n`; }
function cleanCell(value) { return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, ""); }
function atomicJson(file, value) { return mkdir(path.dirname(file), { recursive: true }).then(async () => { const tmp = `${file}.${process.pid}.tmp`; await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(tmp, file); }); }
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
function matchesId(value, id) { return new RegExp(`(?:^|\\D)${escapeRegExp(id)}(?:\\D|$)`, "u").test(String(value ?? "")); }
function matchingBlocks(text, blocks) { return blocks.filter((block) => matchesId(text, block.block_id)); }

const pageColumns = ["run_id", "page_path", "page_url", "editor_page_name", "target_block_ids", "target_block_count", "current_h_count", "current_editable_count", "current_readonly_count", "level_readonly_count", "text_readonly_count", "status", "failure_reason", "evidence", "checked_at"];
const blockColumns = ["run_id", "block_id", "block_name", "editor_page_name", "page_path", "page_url", "page_target_block_count", "attribution_scope", "attribution_confidence", "dialog_block_id", "preview_block_id", "current_h_count", "current_editable_count", "current_readonly_count", "level_readonly_count", "text_readonly_count", "status", "failure_reason", "evidence", "checked_at"];
const itemColumns = ["run_id", "page_path", "page_url", "editor_page_name", "block_id", "block_name", "attribution_scope", "attribution_confidence", "dialog_block_id", "preview_block_id", "control_index", "current_level", "current_text", "level_editable", "text_editable", "current_status", "evidence", "checked_at"];
const exceptionColumns = ["run_id", "page_path", "page_url", "editor_page_name", "exception_type", "detail", "evidence", "checked_at"];

function controlSummary(items) {
  return {
    current_h_count: items.length,
    current_editable_count: items.filter((item) => item.current_status === "now_editable").length,
    current_readonly_count: items.filter((item) => item.current_status !== "now_editable").length,
    level_readonly_count: items.filter((item) => item.level_editable === false).length,
    text_readonly_count: items.filter((item) => item.text_editable === false).length,
    status: items.length === 0 ? "current_no_h" : items.every((item) => item.current_status === "now_editable") ? "current_now_editable" : items.every((item) => item.current_status !== "now_editable") ? "current_still_readonly" : "current_partially_readonly",
  };
}

function createState(inventory, runId) {
  const now = new Date().toISOString();
  return {
    version: 1,
    kind: "growth_engine_v3_supplement_attribution_audit",
    run_id: runId,
    phase: "planned",
    target_block_count: inventory.records.length,
    target_page_count: inventory.pages.length,
    pages: inventory.pages.map((page) => ({ page_path: page.page_path, page_url: page.page_url, editor_page_name: page.editor_page_name, block_ids: page.blocks.map((b) => b.block_id), status: "pending" })),
    blocks: inventory.records.map((block) => ({ ...block, status: "pending", attribution_scope: "", attribution_confidence: "", dialog_block_id: "", preview_block_id: "", current_h_count: 0, current_editable_count: 0, current_readonly_count: 0, level_readonly_count: 0, text_readonly_count: 0, failure_reason: "", evidence: "" })),
    items: [],
    exceptions: [],
    created_at: now,
    updated_at: now,
  };
}

function pathsFor(config, runId) {
  const reportsDir = path.join(config.v3ReadonlyRecheck.reportsDir, "supplement-attribution", runId);
  const artifactsDir = path.join(config.v3ReadonlyRecheck.artifactsDir, "supplement-attribution", runId);
  const outputDir = path.join(config.v3ReadonlyRecheck.outputDir, "supplement-attribution", runId);
  const stateFile = path.join(path.dirname(config.v3ReadonlyRecheck.stateFile), `v3-supplement-attribution-${runId}.json`);
  return { reportsDir, artifactsDir, outputDir, stateFile };
}

function pageConfig(config, page, runId, artifactsDir) {
  const out = structuredClone(config);
  out.targetPagePath = page.page_path;
  out.pagePathCandidates = [page.page_path];
  out.publicUrl = page.page_url;
  out.paths.artifactsDir = path.join(artifactsDir, page.page_path.replaceAll("/", "_"));
  return out;
}

function summary(state) {
  const statuses = {};
  for (const row of state.blocks) statuses[row.status] = (statuses[row.status] ?? 0) + 1;
  return { run_id: state.run_id, phase: state.phase, target_pages: state.target_page_count, target_blocks: state.target_block_count, checked_pages: state.pages.filter((p) => p.status === "complete").length, current_item_count: state.items.length, exception_count: state.exceptions.length, statuses };
}

async function readDialogContext(dialog, blockIds) {
  return dialog.evaluate((root, ids) => {
    const exact = (value, id) => new RegExp(`(?:^|\\D)${String(id).replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?:\\D|$)`).test(String(value ?? ""));
    const all = [...root.querySelectorAll("*")];
    const inputs = [...root.querySelectorAll("input.el-input__inner")];
    const markers = [];
    for (let index = 0; index < all.length; index += 1) {
      const element = all[index];
      const text = String(element.textContent ?? "").replace(/\\s+/g, " ").trim();
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

async function readPreviewMappings(context, pageUrl, controls, blocks, artifactsDir, pagePath) {
  const preview = await context.newPage();
  const url = new URL(pageUrl);
  url.searchParams.set("ge_mapping_audit", "1");
  try {
    const response = await preview.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60000 });
    if (!response?.ok()) throw new Error(`preview_http_${response?.status() ?? "unknown"}`);
    await preview.waitForTimeout(800);
    const headings = await preview.locator("h1,h2,h3,h4,h5,h6").evaluateAll((elements, ids) => {
      const matches = (value, id) => new RegExp(`(?:^|\\D)${String(id).replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?:\\D|$)`).test(String(value ?? ""));
      return elements.map((element, index) => {
        const text = String(element.textContent ?? "").replace(/\\s+/g, " ").trim();
        const candidates = new Set();
        let current = element;
        let depth = 0;
        while (current && depth < 24) {
          for (const attr of ["data-block-id", "data-blockid", "block-id", "data-module-id", "data-component-id", "data-app-id", "id"]) {
            const value = current.getAttribute?.(attr) ?? "";
            for (const id of ids) if (matches(value, id)) candidates.add(String(id));
          }
          for (const value of current.getAttributeNames?.().map((name) => current.getAttribute(name)) ?? []) {
            for (const id of ids) if (matches(value, id)) candidates.add(String(id));
          }
          current = current.parentElement;
          depth += 1;
        }
        return { index, level: element.tagName.toUpperCase(), text, candidates: [...candidates] };
      });
    }, blocks.map((block) => block.block_id));
    const mappings = controls.map((control) => {
      const candidates = headings.filter((heading) => normalizeText(heading.text) === normalizeText(control.text) && heading.level === control.level).flatMap((heading) => heading.candidates);
      const unique = [...new Set(candidates)];
      return { controlIndex: control.index, candidates: unique, headingCount: headings.filter((heading) => normalizeText(heading.text) === normalizeText(control.text)).length };
    });
    const evidencePath = path.join(artifactsDir, `${pagePath.replaceAll("/", "_")}-preview-dom.json`);
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify({ url: url.toString(), headings, mappings }, null, 2)}\n`, "utf8");
    const screenshot = path.join(artifactsDir, `${pagePath.replaceAll("/", "_")}-preview.png`);
    await preview.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    return { mappings, evidencePath, screenshot };
  } finally {
    await preview.close().catch(() => {});
  }
}

function snapshot(control, page, runId, mapping) {
  const levelEditable = Boolean(control.levelEditable); const textEditable = Boolean(control.textEditable);
  return {
    run_id: runId, page_path: page.page_path, page_url: page.page_url, editor_page_name: page.editor_page_name,
    block_id: mapping.blockId, block_name: page.blocks.find((b) => String(b.block_id) === String(mapping.blockId))?.block_name ?? "",
    attribution_scope: mapping.scope, attribution_confidence: mapping.confidence, dialog_block_id: mapping.dialogBlockId, preview_block_id: mapping.previewBlockId,
    control_index: control.index + 1, current_level: control.level, current_text: control.text, level_editable: levelEditable, text_editable: textEditable,
    current_status: levelEditable && textEditable ? "now_editable" : (levelEditable || textEditable ? "partially_readonly" : "still_readonly"), evidence: mapping.evidence ?? "", checked_at: new Date().toISOString(),
  };
}

function mapControl(control, directMatches, dialogContext, previewMapping) {
  const direct = directMatches.length === 1 ? String(directMatches[0].block_id) : "";
  const dialogId = direct || dialogContext?.blockId || "";
  const previewIds = previewMapping?.candidates ?? [];
  const previewId = previewIds.length === 1 ? previewIds[0] : "";
  if (previewId && dialogId && previewId !== dialogId) return { blockId: previewId, scope: "mapping_conflict", confidence: "preview_dom_authoritative", dialogBlockId: dialogId, previewBlockId: previewId };
  if (previewId) return { blockId: previewId, scope: "preview_dom_block_id", confidence: "high", dialogBlockId: dialogId, previewBlockId: previewId };
  if (dialogId) return { blockId: dialogId, scope: direct ? "dialog_text_block_id" : "dialog_nearest_block_id", confidence: direct ? "high" : "medium", dialogBlockId: dialogId, previewBlockId: "" };
  return { blockId: "", scope: "mapping_unresolved", confidence: "none", dialogBlockId: "", previewBlockId: "" };
}

function blockResult(block, page, items, evidence) {
  const mapped = items.filter((item) => String(item.block_id) === String(block.block_id));
  const conflicts = mapped.filter((item) => item.attribution_scope === "mapping_conflict");
  const stats = controlSummary(mapped);
  const status = conflicts.length ? "mapping_conflict" : mapped.length ? stats.status : "mapping_unresolved";
  const source = mapped.length ? [...new Set(mapped.map((item) => item.attribution_scope))].join("、") : "mapping_unresolved";
  return { ...block, page_target_block_count: page.blocks.length, attribution_scope: source, attribution_confidence: mapped.length ? [...new Set(mapped.map((item) => item.attribution_confidence))].join("、") : "none", dialog_block_id: [...new Set(mapped.map((item) => item.dialog_block_id).filter(Boolean))].join("、"), preview_block_id: [...new Set(mapped.map((item) => item.preview_block_id).filter(Boolean))].join("、"), ...stats, status, failure_reason: conflicts.length ? "弹窗上下文与预览DOM归属不一致，以预览DOM为准" : mapped.length ? "" : "未能从弹窗上下文或预览DOM唯一归属", evidence: mapped.some((item) => item.current_status !== "now_editable") || conflicts.length ? evidence : "", checked_at: new Date().toISOString() };
}

function tableHtml(rows, columns) { return `<table><thead><tr>${columns.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((c) => `<td>${String(row[c] ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</td>`).join("")}</tr>`).join("\n")}</tbody></table>`; }

function writeXlsx(state, outputDir) {
  return (async () => {
    const workbook = Workbook.create();
    const pages = state.pages.map((row) => ({ ...row, run_id: state.run_id, target_block_ids: row.block_ids.join("、") }));
    const readonly = state.items.filter((row) => row.current_status !== "now_editable");
    const unresolved = state.items.filter((row) => row.attribution_scope === "mapping_unresolved");
    const conflicts = state.items.filter((row) => row.attribution_scope === "mapping_conflict");
    const status = [summary(state)];
    const sheets = [["按区块结果", state.blocks, blockColumns], ["按页面结果", pages, pageColumns], ["H设置项明细", state.items, itemColumns], ["仍不可编辑", readonly, itemColumns], ["无法归属", unresolved, itemColumns], ["归属冲突", conflicts, itemColumns], ["运行状态", status, Object.keys(status[0])]];
    for (const [name, rows, columns] of sheets) {
      const sheet = workbook.worksheets.add(name); const identifierColumns = new Set(["run_id", "block_id", "dialog_block_id", "preview_block_id"]); const matrix = [columns, ...rows.map((row) => columns.map((column) => { const value = cleanCell(row[column]); return identifierColumns.has(column) && value ? `'${value}` : value; }))];
      const range = sheet.getRangeByIndexes(0, 0, Math.max(matrix.length, 1), columns.length); range.values = matrix; sheet.freezePanes.freezeRows(1); sheet.getRangeByIndexes(0, 0, 1, columns.length).format = { fill: "#1F4E78", font: { bold: true, color: "#FFFFFF" }, wrapText: true }; range.format.wrapText = true;
      for (const identifier of ["run_id", "block_id", "dialog_block_id", "preview_block_id"]) {
        const columnIndex = columns.indexOf(identifier);
        if (columnIndex >= 0) sheet.getRangeByIndexes(0, columnIndex, Math.max(matrix.length, 1), 1).format.numberFormat = "@";
      }
      range.format.autofitColumns(); range.format.autofitRows();
    }
    await mkdir(outputDir, { recursive: true }); const file = path.join(outputDir, `3.0补充归属核查-${state.run_id}.xlsx`); const blob = await SpreadsheetFile.exportXlsx(workbook); await blob.save(file); return file;
  })();
}

async function writeReports(config, state) {
  const paths = pathsFor(config, state.run_id); await mkdir(paths.reportsDir, { recursive: true });
  const pages = state.pages.map((row) => ({ ...row, run_id: state.run_id, target_block_ids: row.block_ids.join("、") }));
  const readonly = state.items.filter((row) => row.current_status !== "now_editable"); const unresolved = state.items.filter((row) => row.attribution_scope === "mapping_unresolved"); const conflicts = state.items.filter((row) => row.attribution_scope === "mapping_conflict");
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>3.0补充归属核查</title><style>body{font:14px/1.5 system-ui;margin:24px}table{border-collapse:collapse;width:100%;margin:12px 0 28px}th,td{border:1px solid #ddd;padding:6px;text-align:left;vertical-align:top;word-break:break-word}th{background:#eef4f9}</style><h1>3.0区块H标签归属补充核查</h1><p>批次：${state.run_id}；本次只读，未修改、未保存同步、未发布。预览DOM归属优先于弹窗上下文。</p><h2>按区块结果</h2>${tableHtml(state.blocks, blockColumns)}<h2>仍不可编辑</h2>${tableHtml(readonly, itemColumns)}<h2>无法归属</h2>${tableHtml(unresolved, itemColumns)}<h2>归属冲突</h2>${tableHtml(conflicts, itemColumns)}<h2>异常</h2>${tableHtml(state.exceptions, exceptionColumns)}</html>`;
  await Promise.all([
    writeFile(path.join(paths.reportsDir, "3.0补充归属核查-按区块结果.csv"), csvText(state.blocks, blockColumns)),
    writeFile(path.join(paths.reportsDir, "3.0补充归属核查-按页面结果.csv"), csvText(pages, pageColumns)),
    writeFile(path.join(paths.reportsDir, "3.0补充归属核查-H设置项明细.csv"), csvText(state.items, itemColumns)),
    writeFile(path.join(paths.reportsDir, "3.0补充归属核查-仍不可编辑.csv"), csvText(readonly, itemColumns)),
    writeFile(path.join(paths.reportsDir, "3.0补充归属核查-无法归属.csv"), csvText(unresolved, itemColumns)),
    writeFile(path.join(paths.reportsDir, "3.0补充归属核查-归属冲突.csv"), csvText(conflicts, itemColumns)),
    writeFile(path.join(paths.reportsDir, "3.0补充归属核查-运行状态.json"), `${JSON.stringify(summary(state), null, 2)}\n`),
    writeFile(path.join(paths.reportsDir, "3.0补充归属核查-report.html"), html),
  ]);
  return { reportsDir: paths.reportsDir, excel: await writeXlsx(state, paths.outputDir) };
}

async function run(config, inventory, state, args) {
  const paths = pathsFor(config, state.run_id); await mkdir(paths.artifactsDir, { recursive: true });
  const context = await launchGrowthEngineContext(config); await context.tracing.start({ screenshots: true, snapshots: true, sources: true }); state.phase = "running"; await atomicJson(paths.stateFile, state);
  const selected = (args.pagePath ? state.pages.filter((p) => p.page_path === args.pagePath) : state.pages).slice(0, Number.isFinite(args.maxPages) ? args.maxPages : state.pages.length);
  try {
    for (const pageState of selected) {
      if (pageState.status === "complete" && !args.pagePath) continue;
      const sourcePage = inventory.pages.find((p) => p.page_path === pageState.page_path); const cfg = pageConfig(config, sourcePage, state.run_id, paths.artifactsDir); pageState.status = "running"; state.items = state.items.filter((item) => item.page_path !== sourcePage.page_path); state.exceptions = state.exceptions.filter((e) => e.page_path !== sourcePage.page_path); state.blocks = state.blocks.filter((block) => block.page_path !== sourcePage.page_path); await atomicJson(paths.stateFile, state);
      let editor; let dialog;
      try {
        editor = new GrowthEngineHPage(context, cfg); await editor.open(); await editor.refreshAndWait({ failureStatus: "refresh_failed" }); dialog = await editor.openEditDialog({ allowEmpty: true });
        const controls = await editor.inspectDialog(dialog, { allowEmpty: true });
        const ids = sourcePage.blocks.map((b) => String(b.block_id)); const dialogContext = await readDialogContext(dialog, ids);
        const preview = await readPreviewMappings(context, sourcePage.page_url, controls, sourcePage.blocks, path.join(paths.artifactsDir, sourcePage.page_path.replaceAll("/", "_")), sourcePage.page_path);
        const items = controls.map((control, index) => {
          const direct = matchingBlocks(control.text, sourcePage.blocks); const mapping = mapControl(control, direct, dialogContext[index], preview.mappings.find((item) => item.controlIndex === control.index)); return snapshot(control, sourcePage, state.run_id, { ...mapping, evidence: mapping.scope === "preview_dom_block_id" || mapping.scope === "mapping_conflict" ? preview.evidencePath : "" });
        });
        state.items.push(...items); const pageStats = controlSummary(items); Object.assign(pageState, pageStats, { status: "complete", failure_reason: "", refreshed_at: new Date().toISOString(), evidence: items.some((item) => item.current_status !== "now_editable" || item.attribution_scope !== "dialog_text_block_id") ? path.join(paths.artifactsDir, sourcePage.page_path.replaceAll("/", "_"), `${sourcePage.page_path.replaceAll("/", "_")}-preview.png`) : "" });
        const evidence = pageStats.current_readonly_count || items.some((item) => item.attribution_scope === "mapping_conflict") ? await editor.screenshot(`page-${sourcePage.page_path.replaceAll("/", "_")}-supplement-evidence.png`) : "";
        pageState.evidence = evidence || pageState.evidence;
        for (const block of sourcePage.blocks) state.blocks.push(blockResult(block, sourcePage, items, evidence || pageState.evidence));
        for (const item of items.filter((row) => row.attribution_scope === "mapping_unresolved")) state.exceptions.push({ run_id: state.run_id, page_path: sourcePage.page_path, page_url: sourcePage.page_url, editor_page_name: sourcePage.editor_page_name, exception_type: "mapping_unresolved", detail: `H设置项无法从弹窗上下文或预览DOM唯一归属：${item.current_level}/${item.current_text}`, evidence: preview.evidencePath, checked_at: new Date().toISOString() });
        for (const item of items.filter((row) => row.attribution_scope === "mapping_conflict")) state.exceptions.push({ run_id: state.run_id, page_path: sourcePage.page_path, page_url: sourcePage.page_url, editor_page_name: sourcePage.editor_page_name, exception_type: "mapping_conflict", detail: `弹窗归属${item.dialog_block_id}与预览DOM归属${item.preview_block_id}冲突，以预览DOM为准：${item.current_text}`, evidence: preview.evidencePath, checked_at: new Date().toISOString() });
      } catch (error) {
        const message = String(error?.message ?? error); const status = /page_not_found/u.test(message) ? "page_not_found" : /login_expired|重新登录/u.test(message) ? "login_expired" : /refresh_failed/u.test(message) ? "refresh_failed" : "automation_error"; pageState.status = status; pageState.failure_reason = message; const shot = await editor?.screenshot(`page-${sourcePage.page_path.replaceAll("/", "_")}-${status}.png`).catch(() => "") ?? ""; pageState.evidence = shot; for (const block of sourcePage.blocks) state.blocks.push({ ...block, page_target_block_count: sourcePage.blocks.length, status, attribution_scope: "page_error", attribution_confidence: "none", current_h_count: 0, current_editable_count: 0, current_readonly_count: 0, level_readonly_count: 0, text_readonly_count: 0, failure_reason: message, evidence: shot }); state.exceptions.push({ run_id: state.run_id, page_path: sourcePage.page_path, page_url: sourcePage.page_url, editor_page_name: sourcePage.editor_page_name, exception_type: status, detail: message, evidence: shot, checked_at: new Date().toISOString() }); if (status === "login_expired") { state.phase = status; await atomicJson(paths.stateFile, state); break; }
      } finally { if (dialog) await editor?.cancelDialog(dialog).catch(() => {}); }
      await atomicJson(paths.stateFile, state);
    }
    if (state.phase !== "login_expired") state.phase = state.pages.every((p) => p.status === "complete") ? "complete" : "completed_with_failures";
  } finally {
    const tracePath = path.join(paths.artifactsDir, "3.0-supplement-attribution-trace.zip"); await mkdir(path.dirname(tracePath), { recursive: true }); await context.tracing.stop({ path: tracePath }).catch(() => {}); await context.close().catch(() => {}); state.trace_path = tracePath; await atomicJson(paths.stateFile, state);
  }
  console.log(JSON.stringify({ ...summary(state), report: await writeReports(config, state) }, null, 2));
}

async function loadState(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }

export async function main(argv = process.argv) {
  const args = parseArgs(argv); const config = await loadGrowthEngineConfig(args.config); const inventory = await readReadonlyWorkbook(config.v3ReadonlyRecheck.sourceWorkbook); const runId = args.runId || numericRunId(); const paths = pathsFor(config, runId);
  if (args.command === "status") { if (!args.runId) throw new Error("status需要--run-id"); console.log(JSON.stringify(await loadState(paths.stateFile), null, 2)); return; }
  if (args.command === "report") { const state = await loadState(paths.stateFile); if (!state) throw new Error("没有找到补充归属核查状态"); console.log(JSON.stringify(await writeReports(config, state), null, 2)); return; }
  const state = args.command === "resume" ? await loadState(paths.stateFile) : createState(inventory, runId); if (!state) throw new Error("没有可恢复的补充归属核查状态"); await run(config, inventory, state, args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
