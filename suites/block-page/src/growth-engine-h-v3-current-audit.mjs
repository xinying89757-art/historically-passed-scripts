#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import { loadGrowthEngineConfig } from "./growth-engine-h-config.mjs";
import { GrowthEngineHPage, launchGrowthEngineContext } from "./growth-engine-h-editor.mjs";
import { numericRunId, normalizeText } from "./growth-engine-h-core.mjs";
import { readReadonlyWorkbook } from "./growth-engine-h-v3-readonly-recheck.mjs";

const PROJECT_ROOT = path.resolve(new URL("..", import.meta.url).pathname);

function parseArgs(argv) {
  const args = { command: argv[2] ?? "status", config: "config/growth-engine-h-v3-readonly-recheck.json", runId: "", maxPages: Number.POSITIVE_INFINITY, pagePath: "" };
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === "--config") args.config = argv[++i];
    else if (argv[i] === "--run-id") args.runId = String(argv[++i]);
    else if (argv[i] === "--max-pages") args.maxPages = Number(argv[++i]);
    else if (argv[i] === "--page-path") args.pagePath = String(argv[++i]);
    else if (argv[i] === "--help") { console.log("node src/growth-engine-h-v3-current-audit.mjs <run|resume|status|report> [--config FILE] [--run-id ID] [--max-pages N] [--page-path PATH]"); process.exit(0); }
  }
  if (!(args.maxPages > 0)) throw new Error("--max-pages 必须大于0");
  return args;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function csvText(rows, columns) {
  return `\uFEFF${[columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n")}\r\n`;
}
function atomicJson(file, value) {
  return mkdir(path.dirname(file), { recursive: true }).then(async () => {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmp, file);
  });
}
function spreadsheetCellValue(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  // Excel XML rejects C0 control characters that can appear in editor text.
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, "");
}

const pageColumns = ["run_id", "page_path", "page_url", "editor_page_name", "target_block_ids", "target_block_count", "current_h_count", "current_editable_count", "current_readonly_count", "level_readonly_count", "text_readonly_count", "status", "failure_reason", "evidence", "checked_at"];
const blockColumns = ["run_id", "block_id", "block_name", "editor_page_name", "page_path", "page_url", "page_target_block_count", "attribution_scope", "current_h_count", "current_editable_count", "current_readonly_count", "level_readonly_count", "text_readonly_count", "status", "failure_reason", "evidence", "checked_at"];
const itemColumns = ["run_id", "page_path", "page_url", "editor_page_name", "block_id", "block_name", "attribution_scope", "control_index", "current_level", "current_text", "level_editable", "text_editable", "current_status", "checked_at"];
const exceptionColumns = ["run_id", "page_path", "page_url", "editor_page_name", "exception_type", "detail", "evidence", "checked_at"];

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
function matchingBlocks(text, blocks) {
  const value = String(text ?? "");
  return blocks.filter((block) => new RegExp(`(?:^|\\D)${escapeRegExp(block.block_id)}(?:\\D|$)`, "u").test(value));
}
function snapshot(control, runId, page, blockId = "", blockName = "", attributionScope = "unmapped_current_item") {
  const levelEditable = Boolean(control.levelEditable);
  const textEditable = Boolean(control.textEditable);
  return {
    run_id: runId,
    page_path: page.page_path,
    page_url: page.page_url,
    editor_page_name: page.editor_page_name,
    block_id: blockId,
    block_name: blockName,
    attribution_scope: attributionScope,
    control_index: control.index + 1,
    current_level: control.level,
    current_text: control.text,
    level_editable: levelEditable,
    text_editable: textEditable,
    current_status: levelEditable && textEditable ? "now_editable" : (levelEditable || textEditable ? "partially_readonly" : "still_readonly"),
    checked_at: new Date().toISOString(),
  };
}

function summarizeControls(items) {
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
    kind: "growth_engine_v3_current_h_editability_audit",
    run_id: runId,
    phase: "planned",
    target_block_count: inventory.records.length,
    target_page_count: inventory.pages.length,
    pages: inventory.pages.map((page) => ({ page_path: page.page_path, page_url: page.page_url, editor_page_name: page.editor_page_name, block_ids: page.blocks.map((b) => b.block_id), status: "pending" })),
    blocks: inventory.records.map((block) => ({ ...block, status: "pending", current_h_count: 0, current_editable_count: 0, current_readonly_count: 0, level_readonly_count: 0, text_readonly_count: 0, failure_reason: "", evidence: "" })),
    items: [],
    exceptions: [],
    created_at: now,
    updated_at: now,
  };
}

function pageConfig(config, page, runId) {
  const out = structuredClone(config);
  out.targetPagePath = page.page_path;
  out.pagePathCandidates = [page.page_path];
  out.publicUrl = page.page_url;
  out.paths.artifactsDir = path.join(config.v3ReadonlyRecheck.artifactsDir, "current-audit", runId, page.page_path.replaceAll("/", "_"));
  return out;
}

function auditPaths(config, runId) {
  const reportsDir = path.join(config.v3ReadonlyRecheck.reportsDir, "current-audit", runId);
  const outputDir = path.join(config.v3ReadonlyRecheck.outputDir, "current-audit");
  return { reportsDir, outputDir, stateFile: path.join(config.paths.stateFile.replace(/[^/]+$/u, ""), `v3-current-h-audit-${runId}.json`) };
}

function summarize(state) {
  const statuses = {};
  for (const block of state.blocks) statuses[block.status] = (statuses[block.status] ?? 0) + 1;
  return { run_id: state.run_id, phase: state.phase, target_pages: state.target_page_count, target_blocks: state.target_block_count, checked_pages: state.pages.filter((p) => p.status === "complete").length, statuses, current_item_count: state.items.length, exception_count: state.exceptions.length };
}

async function writeExcel(state, outputDir) {
  const workbook = Workbook.create();
  const pageRows = state.pages.map((row) => ({ ...row, run_id: state.run_id }));
  const blockRows = state.blocks.map((row) => ({ ...row, target_block_ids: row.block_ids?.join("、") ?? "" }));
  const readonly = state.items.filter((row) => row.current_status !== "now_editable");
  const statusRows = [summarize(state)];
  const sheets = [["按区块结果", blockRows, blockColumns], ["按页面结果", pageRows, pageColumns], ["当前H设置项", state.items, itemColumns], ["当前只读H设置项", readonly, itemColumns], ["运行状态", statusRows, Object.keys(statusRows[0])]];
  for (const [name, rows, columns] of sheets) {
    const sheet = workbook.worksheets.add(name);
    const matrix = [columns, ...rows.map((row) => columns.map((column) => spreadsheetCellValue(row[column])))];
    const range = sheet.getRangeByIndexes(0, 0, Math.max(matrix.length, 1), columns.length);
    range.values = matrix;
    sheet.freezePanes.freezeRows(1);
    sheet.getRangeByIndexes(0, 0, 1, columns.length).format = { fill: "#1F4E78", font: { bold: true, color: "#FFFFFF" }, wrapText: true };
    range.format.wrapText = true;
    range.format.autofitColumns();
    range.format.autofitRows();
  }
  await mkdir(outputDir, { recursive: true });
  const file = path.join(outputDir, `3.0增长引擎当前H可编辑性审计-${state.run_id}.xlsx`);
  const blob = await SpreadsheetFile.exportXlsx(workbook); await blob.save(file); return file;
}

async function writeReports(config, state) {
  const { reportsDir, outputDir } = auditPaths(config, state.run_id); await mkdir(reportsDir, { recursive: true });
  const blockRows = state.blocks.map((row) => ({ ...row, target_block_ids: row.block_ids?.join("、") ?? "", run_id: state.run_id }));
  const readonly = state.items.filter((row) => row.current_status !== "now_editable");
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>3.0当前H可编辑性审计</title><style>body{font:14px/1.5 system-ui;margin:24px}table{border-collapse:collapse;width:100%;margin:12px 0 28px}th,td{border:1px solid #ddd;padding:6px;text-align:left;vertical-align:top;word-break:break-word}th{background:#eef4f9}</style><h1>3.0增长引擎当前H可编辑性审计</h1><p>批次：${state.run_id}；本次只读取当前H设置项，未修改、未保存同步。</p><h2>按区块结果</h2>${tableHtml(blockRows, blockColumns)}<h2>当前只读H设置项</h2>${tableHtml(readonly, itemColumns)}<h2>异常</h2>${tableHtml(state.exceptions, exceptionColumns)}</html>`;
  await Promise.all([
    writeFile(path.join(reportsDir, "3.0当前H可编辑性-按区块结果.csv"), csvText(blockRows, blockColumns)),
    writeFile(path.join(reportsDir, "3.0当前H可编辑性-按页面结果.csv"), csvText(state.pages, pageColumns)),
    writeFile(path.join(reportsDir, "3.0当前H可编辑性-当前H设置项.csv"), csvText(state.items, itemColumns)),
    writeFile(path.join(reportsDir, "3.0当前H可编辑性-当前只读H设置项.csv"), csvText(readonly, itemColumns)),
    writeFile(path.join(reportsDir, "3.0当前H可编辑性-运行状态.json"), `${JSON.stringify(summarize(state), null, 2)}\n`),
    writeFile(path.join(reportsDir, "3.0当前H可编辑性-report.html"), html),
  ]);
  return { reportsDir, excel: await writeExcel(state, outputDir) };
}

function tableHtml(rows, columns) { return `<table><thead><tr>${columns.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((c) => `<td>${String(row[c] ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</td>`).join("")}</tr>`).join("")}</tbody></table>`; }

async function run(config, inventory, state, { pagePath = "", maxPages = Number.POSITIVE_INFINITY } = {}) {
  const paths = auditPaths(config, state.run_id);
  const context = await launchGrowthEngineContext(config); await context.tracing.start({ screenshots: true, snapshots: true, sources: true }); state.phase = "running"; await atomicJson(paths.stateFile, state);
  const selected = (pagePath ? state.pages.filter((p) => p.page_path === pagePath) : state.pages).slice(0, Number.isFinite(maxPages) ? maxPages : state.pages.length);
  try {
    for (const pageState of selected) {
      if (pageState.status === "complete" && !pagePath) continue;
      const sourcePage = inventory.pages.find((p) => p.page_path === pageState.page_path); const cfg = pageConfig(config, sourcePage, state.run_id); pageState.status = "running"; state.exceptions = state.exceptions.filter((e) => e.page_path !== sourcePage.page_path); await atomicJson(paths.stateFile, state);
      let editor;
      try {
        editor = new GrowthEngineHPage(context, cfg); await editor.open(); await editor.refreshAndWait({ failureStatus: "refresh_failed" });
        const dialog = await editor.openEditDialog({ allowEmpty: true });
        try {
          const controls = await editor.inspectDialog(dialog, { allowEmpty: true });
          const items = controls.map((control) => {
            const matches = matchingBlocks(control.text, sourcePage.blocks);
            if (matches.length === 1) return snapshot(control, state.run_id, sourcePage, matches[0].block_id, matches[0].block_name, "id_in_current_text");
            if (matches.length > 1) return snapshot(control, state.run_id, sourcePage, matches.map((block) => block.block_id).join("、"), matches.map((block) => block.block_name).join("、"), "mapping_ambiguous");
            return snapshot(control, state.run_id, sourcePage);
          });
          state.items = state.items.filter((item) => item.page_path !== sourcePage.page_path); state.items.push(...items);
          const summary = summarizeControls(items); Object.assign(pageState, summary, { status: "complete", refreshed_at: new Date().toISOString() });
          const evidence = summary.current_readonly_count > 0 ? await editor.screenshot(`page-${sourcePage.page_path.replaceAll("/", "_")}-current-readonly.png`) : "";
          pageState.evidence = evidence;
          for (const block of sourcePage.blocks) {
            const target = state.blocks.find((b) => b.block_id === block.block_id && b.page_path === block.page_path); const shared = sourcePage.blocks.length > 1;
            const mapped = items.filter((item) => item.block_id === block.block_id && item.attribution_scope === "id_in_current_text");
            const mappedSummary = summarizeControls(mapped);
            Object.assign(target, mappedSummary, { run_id: state.run_id, page_target_block_count: sourcePage.blocks.length, attribution_scope: mapped.length > 0 ? "id_in_current_text" : "block_id_not_found_in_current_text", status: mapped.length > 0 ? mappedSummary.status : "block_id_not_found", failure_reason: mapped.length > 0 ? "" : "当前H设置项文字中未找到该区块ID", evidence: mappedSummary.current_readonly_count > 0 ? evidence : "" });
          }
          for (const item of items.filter((row) => row.attribution_scope !== "id_in_current_text")) state.exceptions.push({ run_id: state.run_id, page_path: sourcePage.page_path, page_url: sourcePage.page_url, editor_page_name: sourcePage.editor_page_name, exception_type: item.attribution_scope, detail: `当前H设置项未能按区块ID唯一归属：${item.current_level}/${item.current_text}`, evidence: "", checked_at: new Date().toISOString() });
        } finally { await editor.cancelDialog(dialog).catch(() => {}); }
      } catch (error) {
        const message = String(error?.message ?? error); const status = /page_not_found/u.test(message) ? "page_not_found" : /login_expired|重新登录/u.test(message) ? "login_expired" : /refresh_failed/u.test(message) ? "refresh_failed" : "automation_error";
        pageState.status = status; pageState.failure_reason = message; const shot = await editor?.screenshot(`page-${sourcePage.page_path.replaceAll("/", "_")}-${status}.png`).catch(() => ""); pageState.evidence = shot;
        for (const block of sourcePage.blocks) { const target = state.blocks.find((b) => b.block_id === block.block_id && b.page_path === block.page_path); Object.assign(target, { run_id: state.run_id, status, failure_reason: message, evidence: shot }); }
        state.exceptions.push({ run_id: state.run_id, page_path: sourcePage.page_path, page_url: sourcePage.page_url, editor_page_name: sourcePage.editor_page_name, exception_type: status, detail: message, evidence: shot, checked_at: new Date().toISOString() });
        if (status === "login_expired") { state.phase = status; await atomicJson(paths.stateFile, state); break; }
      }
      await atomicJson(paths.stateFile, state);
    }
    if (state.phase !== "login_expired") state.phase = state.pages.every((p) => p.status === "complete") ? "complete" : "completed_with_failures";
  } finally {
    const tracePath = path.join(config.v3ReadonlyRecheck.artifactsDir, "current-audit", state.run_id, "growth-engine-h-v3-current-audit-trace.zip"); await mkdir(path.dirname(tracePath), { recursive: true }); await context.tracing.stop({ path: tracePath }).catch(() => {}); await context.close().catch(() => {}); state.trace_path = tracePath; await atomicJson(paths.stateFile, state);
  }
  console.log(JSON.stringify({ ...summarize(state), report: await writeReports(config, state) }, null, 2));
}

async function loadState(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }

export async function main(argv = process.argv) {
  const args = parseArgs(argv); const config = await loadGrowthEngineConfig(args.config); const inventory = await readReadonlyWorkbook(config.v3ReadonlyRecheck.sourceWorkbook); const stateFile = args.runId ? auditPaths(config, args.runId).stateFile : "";
  if (args.command === "status") { const files = stateFile ? [stateFile] : []; console.log(files.length ? JSON.stringify(await loadState(files[0]), null, 2) : "请使用--run-id查看当前审计状态"); return; }
  if (args.command === "report") { if (!stateFile) throw new Error("report需要--run-id"); const state = await loadState(stateFile); if (!state) throw new Error("没有找到当前审计状态"); console.log(JSON.stringify(await writeReports(config, state), null, 2)); return; }
  const runId = args.runId || numericRunId(); const paths = auditPaths(config, runId); const state = args.command === "resume" ? await loadState(paths.stateFile) : createState(inventory, runId); if (!state) throw new Error("没有可恢复的当前H审计状态"); await run(config, inventory, state, args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
