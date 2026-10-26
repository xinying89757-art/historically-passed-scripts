#!/usr/bin/env node

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import { loadGrowthEngineConfig } from "./growth-engine-h-config.mjs";
import { GrowthEngineHPage, launchGrowthEngineContext } from "./growth-engine-h-editor.mjs";
import { loadInventory } from "./growth-engine-h-v4-editability-audit.mjs";
import { numericRunId } from "./growth-engine-h-core.mjs";

const BLOCK_COLUMNS = ["run_id", "page_name", "page_path", "page_url", "block_id", "app_name", "editor_dom_id", "page_target_block_count", "attribution_scope", "current_h_count", "current_editable_count", "current_readonly_count", "level_readonly_count", "text_readonly_count", "status", "reason", "evidence", "checked_at"];
const PAGE_COLUMNS = ["run_id", "page_name", "page_path", "page_url", "target_block_count", "current_h_count", "current_editable_count", "current_readonly_count", "level_readonly_count", "text_readonly_count", "status", "reason", "evidence", "checked_at"];
const ITEM_COLUMNS = ["run_id", "page_name", "page_path", "page_url", "block_id", "block_name", "attribution_scope", "control_index", "level", "text", "level_editable", "text_editable", "current_status", "checked_at"];
const EXCEPTION_COLUMNS = ["run_id", "page_name", "page_path", "page_url", "exception_type", "detail", "evidence", "checked_at"];

function parseArgs(argv) {
  const args = { command: argv[2] ?? "status", config: "config/growth-engine-h-v4.json", runId: "", maxPages: Number.POSITIVE_INFINITY, pagePath: "", userDataDir: "" };
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === "--config") args.config = argv[++i];
    else if (argv[i] === "--run-id") args.runId = String(argv[++i]);
    else if (argv[i] === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (argv[i] === "--page-path") args.pagePath = String(argv[++i]);
    else if (argv[i] === "--user-data-dir") args.userDataDir = String(argv[++i]);
    else if (argv[i] === "--help") { console.log("node src/growth-engine-h-v4-current-audit.mjs <run|resume|status|report> [--config FILE] [--run-id ID] [--max-pages N] [--page-path PATH]"); process.exit(0); }
  }
  if (!(args.maxPages > 0)) throw new Error("--max-pages 必须大于0");
  return args;
}

function csvCell(value) { const text = String(value ?? ""); return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function csvText(rows, columns) { return `\uFEFF${[columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n")}\r\n`; }
function atomicJson(file, value) { return mkdir(path.dirname(file), { recursive: true }).then(async () => { const tmp = `${file}.${process.pid}.tmp`; await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`); await rename(tmp, file); }); }
function cell(value) { if (value === null || value === undefined) return ""; const text = typeof value === "object" ? JSON.stringify(value) : String(value); return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, ""); }
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
function matchingBlocks(text, blocks) { return blocks.filter((block) => new RegExp(`(?:^|\\D)${escapeRegExp(block.block_id)}(?:\\D|$)`, "u").test(String(text ?? ""))); }
function pathsFor(config, runId) {
  const rootState = path.dirname(config.v4Audit.stateFile);
  return { stateFile: path.join(rootState, `growth-engine-h-v4-current-audit-${runId}.json`), reportsDir: path.join(config.v4Audit.reportsDir, "current", runId), artifactsDir: path.join(config.v4Audit.artifactsDir, "current", runId), outputDir: path.join(config.v4Audit.reportsDir, "current", runId) };
}

function snapshot(control, runId, page, blockId = "", blockName = "", attributionScope = "unmapped_current_item") {
  const levelEditable = Boolean(control.levelEditable); const textEditable = Boolean(control.textEditable);
  return { run_id: runId, page_name: page.page_name, page_path: page.page_path, page_url: page.page_url, block_id: blockId, block_name: blockName, attribution_scope: attributionScope, control_index: control.index + 1, level: control.level, text: control.text, level_editable: levelEditable, text_editable: textEditable, current_status: levelEditable && textEditable ? "now_editable" : (levelEditable || textEditable ? "partially_readonly" : "still_readonly"), checked_at: new Date().toISOString() };
}
function controlSummary(items) {
  return { current_h_count: items.length, current_editable_count: items.filter((item) => item.current_status === "now_editable").length, current_readonly_count: items.filter((item) => item.current_status !== "now_editable").length, level_readonly_count: items.filter((item) => item.level_editable === false).length, text_readonly_count: items.filter((item) => item.text_editable === false).length, status: items.length === 0 ? "current_no_h" : items.every((item) => item.current_status === "now_editable") ? "current_now_editable" : items.every((item) => item.current_status !== "now_editable") ? "current_still_readonly" : "current_partially_readonly" };
}
function createState(inventory, runId) {
  const now = new Date().toISOString();
  return { version: 1, kind: "growth_engine_v4_current_h_editability_audit", run_id: runId, phase: "planned", target_page_count: inventory.pages.length, target_block_count: inventory.blocks.length, pages: inventory.pages.map((page) => ({ page_name: page.page_name, page_path: page.page_path, page_url: page.page_url, target_block_count: page.blocks.length, block_ids: page.blocks.map((b) => b.block_id), status: "pending" })), blocks: inventory.blocks.map((block) => ({ page_name: block.page_name, page_path: block.page_path, page_url: block.page_url, block_id: block.block_id, app_name: block.app_name, editor_dom_id: block.editor_dom_id, status: "pending", current_h_count: 0, current_editable_count: 0, current_readonly_count: 0, level_readonly_count: 0, text_readonly_count: 0, failure_reason: "", evidence: "" })), items: [], exceptions: [], created_at: now, updated_at: now };
}

async function readControls(editor, dialog) { return editor.inspectDialog(dialog, { allowEmpty: true }); }
function blockRow(block, items, page, state, evidence, override = {}) {
  const summary = controlSummary(items); return { run_id: state.run_id, page_name: block.page_name, page_path: block.page_path, page_url: block.page_url, block_id: block.block_id, app_name: block.app_name, editor_dom_id: block.editor_dom_id, page_target_block_count: page.blocks.length, attribution_scope: override.attribution_scope ?? (items.length ? "id_in_current_text" : "block_id_not_found_in_current_text"), ...summary, status: override.status ?? (items.length ? summary.status : "block_id_not_found"), reason: override.reason ?? (items.length ? "" : "当前H设置项文字中未找到该区块ID"), evidence: override.status ? evidence : (items.length && summary.current_readonly_count ? evidence : ""), checked_at: new Date().toISOString() };
}

function tableHtml(rows, columns) { return `<table><thead><tr>${columns.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((c) => `<td>${String(row[c] ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</td>`).join("")}</tr>`).join("")}</tbody></table>`; }
function summary(state) { const statuses = {}; for (const row of state.blocks) statuses[row.status] = (statuses[row.status] ?? 0) + 1; return { run_id: state.run_id, phase: state.phase, target_pages: state.target_page_count, target_blocks: state.target_block_count, checked_pages: state.pages.filter((p) => p.status === "complete").length, current_item_count: state.items.length, exception_count: state.exceptions.length, statuses }; }

async function writeExcel(state, outputDir) {
  const workbook = Workbook.create(); const pageRows = state.pages.map((row) => ({ ...row, run_id: state.run_id })); const readonly = state.items.filter((row) => row.current_status !== "now_editable"); const sheets = [["按区块结果", state.blocks, BLOCK_COLUMNS], ["按页面结果", pageRows, PAGE_COLUMNS], ["当前H设置项", state.items, ITEM_COLUMNS], ["当前只读H设置项", readonly, ITEM_COLUMNS], ["运行状态", [summary(state)], Object.keys(summary(state))]];
  for (const [name, rows, columns] of sheets) { const sheet = workbook.worksheets.add(name); const matrix = [columns, ...rows.map((row) => columns.map((column) => cell(row[column])))]; const range = sheet.getRangeByIndexes(0, 0, Math.max(matrix.length, 1), columns.length); range.values = matrix; sheet.freezePanes.freezeRows(1); sheet.getRangeByIndexes(0, 0, 1, columns.length).format = { fill: "#1F4E78", font: { bold: true, color: "#FFFFFF" }, wrapText: true }; range.format.wrapText = true; range.format.autofitColumns(); range.format.autofitRows(); }
  await mkdir(outputDir, { recursive: true }); const file = path.join(outputDir, `4.0增长引擎当前H可编辑性审计-${state.run_id}.xlsx`); const blob = await SpreadsheetFile.exportXlsx(workbook); await blob.save(file); return file;
}
async function writeReports(config, state) {
  const paths = pathsFor(config, state.run_id); await mkdir(paths.reportsDir, { recursive: true }); const readonly = state.items.filter((row) => row.current_status !== "now_editable");
  const html = `<!doctype html><meta charset="utf-8"><title>4.0当前H可编辑性审计</title><style>body{font:14px/1.5 system-ui;margin:24px}table{border-collapse:collapse;width:100%;margin:12px 0 28px}th,td{border:1px solid #ddd;padding:6px;text-align:left;vertical-align:top;word-break:break-word}th{background:#eef4f9}</style><h1>4.0所有已添加区块页面当前H可编辑性审计</h1><p>批次：${state.run_id}；页面：${state.target_page_count}；区块：${state.target_block_count}；本次只读取，没有修改或保存同步。</p><h2>区块结果</h2>${tableHtml(state.blocks, BLOCK_COLUMNS)}<h2>当前只读H设置项</h2>${tableHtml(readonly, ITEM_COLUMNS)}<h2>异常</h2>${tableHtml(state.exceptions, EXCEPTION_COLUMNS)}`;
  await Promise.all([writeFile(path.join(paths.reportsDir, "4.0当前H可编辑性-按区块结果.csv"), csvText(state.blocks, BLOCK_COLUMNS)), writeFile(path.join(paths.reportsDir, "4.0当前H可编辑性-按页面结果.csv"), csvText(state.pages.map((p) => ({ ...p, run_id: state.run_id })), PAGE_COLUMNS)), writeFile(path.join(paths.reportsDir, "4.0当前H可编辑性-当前H设置项.csv"), csvText(state.items, ITEM_COLUMNS)), writeFile(path.join(paths.reportsDir, "4.0当前H可编辑性-当前只读H设置项.csv"), csvText(readonly, ITEM_COLUMNS)), writeFile(path.join(paths.reportsDir, "4.0当前H可编辑性-运行状态.json"), `${JSON.stringify(summary(state), null, 2)}\n`), writeFile(path.join(paths.reportsDir, "4.0当前H可编辑性-report.html"), html)]);
  return { reportsDir: paths.reportsDir, excel: await writeExcel(state, paths.outputDir) };
}

async function run(config, inventory, state, args) {
  const paths = pathsFor(config, state.run_id); const context = await launchGrowthEngineContext({ ...config, browser: { ...config.browser, headless: false, startMinimized: true } }); await context.tracing.start({ screenshots: true, snapshots: true, sources: true }); state.phase = "running"; await atomicJson(paths.stateFile, state); const wanted = args.pagePath ? state.pages.filter((p) => p.page_path === args.pagePath) : state.pages; const selected = wanted.slice(0, Number.isFinite(args.maxPages) ? args.maxPages : wanted.length);
  try {
    for (const pageState of selected) {
      if (pageState.status === "complete" && !args.pagePath) continue; const page = inventory.pages.find((p) => p.page_path === pageState.page_path); pageState.status = "running"; state.items = state.items.filter((item) => item.page_path !== page.page_path); state.blocks = state.blocks.filter((block) => block.page_path !== page.page_path); state.exceptions = state.exceptions.filter((exception) => exception.page_path !== page.page_path); await atomicJson(paths.stateFile, state); const pageConfig = structuredClone(config); pageConfig.targetPagePath = page.page_path; pageConfig.pagePathCandidates = [page.page_path]; pageConfig.publicUrl = page.page_url; pageConfig.paths.artifactsDir = paths.artifactsDir; const editor = new GrowthEngineHPage(context, pageConfig);
      try {
        await editor.open(); await editor.refreshAndWait({ failureStatus: "refresh_failed" }); const dialog = await editor.openEditDialog({ allowEmpty: true });
        try {
          const controls = await readControls(editor, dialog); const items = controls.map((control) => { const matches = matchingBlocks(control.text, page.blocks); if (matches.length === 1) return snapshot(control, state.run_id, page, matches[0].block_id, matches[0].app_name, "id_in_current_text"); if (matches.length > 1) return snapshot(control, state.run_id, page, matches.map((b) => b.block_id).join("、"), matches.map((b) => b.app_name).join("、"), "mapping_ambiguous"); return snapshot(control, state.run_id, page); }); state.items.push(...items); const pageSummary = controlSummary(items); Object.assign(pageState, pageSummary, { status: "complete", checked_at: new Date().toISOString() }); const evidence = pageSummary.current_readonly_count ? await editor.screenshot(`page-${page.page_path.replaceAll("/", "_")}-current-readonly.png`) : ""; pageState.evidence = evidence;
          for (const block of page.blocks) { const mapped = items.filter((item) => item.block_id === block.block_id && item.attribution_scope === "id_in_current_text"); state.blocks.push(blockRow(block, mapped, page, state, evidence)); }
          for (const item of items.filter((row) => row.attribution_scope !== "id_in_current_text")) state.exceptions.push({ run_id: state.run_id, page_name: page.page_name, page_path: page.page_path, page_url: page.page_url, exception_type: item.attribution_scope, detail: `当前H设置项无法按区块ID唯一归属：${item.level}/${item.text}`, evidence: "", checked_at: new Date().toISOString() });
        } finally { await editor.cancelDialog(dialog).catch(() => {}); }
      } catch (error) {
        const message = String(error?.message ?? error); const status = /page_not_found/u.test(message) ? "page_not_found" : /login_expired|重新登录/u.test(message) ? "login_expired" : /refresh_failed/u.test(message) ? "refresh_failed" : "automation_error"; pageState.status = status; pageState.reason = message; const shot = await editor.screenshot(`page-${page.page_path.replaceAll("/", "_")}-${status}.png`).catch(() => ""); pageState.evidence = shot; for (const block of page.blocks) state.blocks.push(blockRow(block, [], page, state, shot, { status, reason: message, attribution_scope: "page_error" })); state.exceptions.push({ run_id: state.run_id, page_name: page.page_name, page_path: page.page_path, page_url: page.page_url, exception_type: status, detail: message, evidence: shot, checked_at: new Date().toISOString() }); if (status === "login_expired") { state.phase = status; await atomicJson(paths.stateFile, state); break; }
      }
      await atomicJson(paths.stateFile, state);
    }
    if (state.phase !== "login_expired") state.phase = state.pages.every((p) => p.status === "complete") ? "complete" : "completed_with_failures";
  } finally { const tracePath = path.join(paths.artifactsDir, "4.0-current-audit-trace.zip"); await mkdir(path.dirname(tracePath), { recursive: true }); await context.tracing.stop({ path: tracePath }).catch(() => {}); await context.close().catch(() => {}); state.trace_path = tracePath; await atomicJson(paths.stateFile, state); }
  console.log(JSON.stringify({ ...summary(state), report: await writeReports(config, state) }, null, 2));
}

async function loadState(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
export async function main(argv = process.argv) { const args = parseArgs(argv); const config = await loadGrowthEngineConfig(args.config); if (args.userDataDir) config.paths.userDataDir = path.resolve(args.userDataDir); const inventory = await loadInventory(config); const runId = args.runId || numericRunId(); const paths = pathsFor(config, runId); if (args.command === "plan") { console.log(JSON.stringify({ pages: inventory.pages.length, blocks: inventory.blocks.length }, null, 2)); return; } if (args.command === "status") { const state = await loadState(paths.stateFile); console.log(state ? JSON.stringify(summary(state), null, 2) : "尚无4.0当前H可编辑性审计状态"); return; } if (args.command === "report") { const state = await loadState(paths.stateFile); if (!state) throw new Error("没有找到4.0当前审计状态"); console.log(JSON.stringify(await writeReports(config, state), null, 2)); return; } const state = args.command === "resume" ? await loadState(paths.stateFile) : createState(inventory, runId); if (!state) throw new Error("没有可恢复的4.0当前审计状态"); await run(config, inventory, state, args); }
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
