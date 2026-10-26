#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import { buildObjectRows } from "../src/onpage-agent-h-v3-history-core.mjs";
import { buildHistoryRows, loadHistoryRegressionConfig } from "../src/onpage-agent-h-v3-history-regression.mjs";
import { projectRoot } from "../src/config.mjs";

const configArgIndex = process.argv.indexOf("--config");
const configPath = configArgIndex >= 0 ? process.argv[configArgIndex + 1] : undefined;
const { config, metadata } = await loadHistoryRegressionConfig(configPath);
const state = JSON.parse(await fs.readFile(config.paths.stateFile, "utf8"));
const objects = buildObjectRows(state, config.targets);
const headings = await buildHistoryRows(state, config.targets);
const pageRows = state.pages.map((page) => ({
  issue_group: page.issue_group,
  page_name: page.page_name,
  page_path: page.page_path,
  page_url: page.page_url,
  batch_validate_status: page.batch_validate_status,
  individual_validate_passed: page.individual_validate_passed,
  individual_validate_failed: page.individual_validate_failed,
  captured_count: page.captured_count,
  submitted_count: page.submitted_count,
  page_status: page.status,
  failure_reason: page.failure_reason,
  trace: page.trace,
  checked_at: page.checked_at,
}));

function redact(value) {
  const sensitive = /authorization|token|cookie|password|secret/u;
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sensitive.test(key.toLowerCase()) ? "***" : redact(entry)]));
  return value;
}

async function evidenceJson(filename) {
  if (!filename) return "";
  try { return JSON.stringify(redact(JSON.parse(await fs.readFile(filename, "utf8"))), null, 2); } catch { return ""; }
}

const apiRows = [];
for (const page of state.pages) {
  for (const call of page.api_calls ?? []) {
    apiRows.push({
      page_path: page.page_path,
      stage: call.stage,
      url: call.url,
      http_status: call.http_status,
      business_code: call.business_code,
      request_json: await evidenceJson(call.request_file),
      response_json: await evidenceJson(call.response_file),
      checked_at: call.checked_at,
    });
  }
}

const objectColumns = [
  ["issue_group", "历史问题组"], ["object_type", "类型"], ["object_id", "组件/区块ID"], ["object_name", "组件/区块名称"],
  ["page_name", "页面名称"], ["page_path", "页面路径"], ["page_url", "页面链接"], ["historical_h_count", "历史目标H数量"],
  ["matched_h_count", "当前匹配H数量"], ["fixed_h_count", "已修复H数量"], ["failed_h_count", "未修复H数量"],
  ["regression_status", "回归状态"], ["problem_description", "问题说明"], ["evidence", "证据路径"],
];
const headingColumns = [
  ["issue_group", "历史问题组"], ["page_name", "页面名称"], ["page_path", "页面路径"], ["page_url", "页面链接"],
  ["object_type", "类型"], ["object_id", "组件/区块ID"], ["object_name", "组件/区块名称"], ["item_key", "itemKey"],
  ["setting_id", "settingId"], ["node_id", "nodeId"], ["template_id", "templateId"], ["position", "位置"],
  ["original_level", "当前原级别"], ["original_text", "当前原文字"], ["expected_level", "目标级别"], ["expected_text", "目标文字"],
  ["level_editable", "级别可编辑"], ["text_editable", "文字可编辑"], ["validate_code", "预检code"], ["update_code", "更新code"],
  ["update_status", "更新状态"], ["preview_status", "预览状态"], ["preview_level", "预览级别"], ["preview_text", "预览文字"],
  ["editor_backfill_status", "编辑器回填状态"], ["editor_level", "编辑器级别"], ["editor_text", "编辑器文字"],
  ["regression_status", "回归状态"], ["failure_reason", "失败原因"], ["validate_request", "validate入参JSON"],
  ["validate_response", "validate响应JSON"], ["update_request", "update入参JSON"], ["update_response", "update响应JSON"], ["evidence", "证据路径"],
];
const pageColumns = [
  ["issue_group", "历史问题组"], ["page_name", "页面名称"], ["page_path", "页面路径"], ["page_url", "页面链接"],
  ["batch_validate_status", "批量预检状态"], ["individual_validate_passed", "单项预检通过"], ["individual_validate_failed", "单项预检失败"],
  ["captured_count", "当前扫描H数量"], ["submitted_count", "提交更新数量"], ["page_status", "页面状态"],
  ["failure_reason", "失败原因"], ["trace", "Trace路径"], ["checked_at", "核查时间"],
];
const apiColumns = [
  ["page_path", "页面路径"], ["stage", "接口阶段"], ["url", "接口URL"], ["http_status", "HTTP状态"],
  ["business_code", "业务code"], ["request_json", "请求JSON"], ["response_json", "响应JSON"], ["checked_at", "请求时间"],
];

function columnName(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function widthFor(header) {
  if (/JSON/u.test(header)) return 62;
  if (/问题说明|失败原因/u.test(header)) return 44;
  if (/文字/u.test(header)) return 38;
  if (/页面链接|证据|Trace|接口URL/u.test(header)) return 42;
  if (/页面名称|页面路径|组件\/区块名称/u.test(header)) return 24;
  if (/状态|问题组/u.test(header)) return 23;
  return 16;
}

const workbook = Workbook.create();
const fontFamily = "Arial";

function addSheet(name, rows, columns, tableName, options = {}) {
  const sheet = workbook.worksheets.add(name);
  sheet.showGridLines = false;
  const title = options.title || name;
  const lastColumn = columnName(columns.length - 1);
  sheet.getRange(`A1:${lastColumn}1`).merge();
  sheet.getRange("A1").values = [[title]];
  sheet.getRange(`A1:${lastColumn}1`).format = { font: { name: fontFamily, bold: true, size: 15, color: "#12304A" }, rowHeight: 28 };
  sheet.getRange(`A2:${lastColumn}2`).merge();
  sheet.getRange("A2").values = [[options.context || `批次 ${state.run_id}；增长引擎不回填新接口结果不参与判断。`]];
  sheet.getRange(`A2:${lastColumn}2`).format = { font: { name: fontFamily, italic: true, color: "#64748B" }, rowHeight: 24 };
  const displayValue = (row, key) => {
    const value = row[key] ?? "";
    if (key === "object_id" && value !== "") {
      const prefix = ["component", "组件"].includes(row.object_type) ? "组件" : ["block", "区块"].includes(row.object_type) ? "区块" : "";
      return `${prefix}${value}`;
    }
    return value;
  };
  const matrix = [columns.map(([, header]) => header), ...rows.map((row) => columns.map(([key]) => displayValue(row, key)))];
  sheet.getRange(`A4:${lastColumn}${matrix.length + 3}`).values = matrix;
  sheet.getRange(`A4:${lastColumn}4`).format = {
    fill: "#12304A",
    font: { name: fontFamily, bold: true, color: "#FFFFFF" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    rowHeight: 34,
  };
  if (rows.length > 0) {
    sheet.getRange(`A5:${lastColumn}${rows.length + 4}`).format = {
      font: { name: fontFamily, size: 10 },
      verticalAlignment: "top",
      wrapText: true,
      rowHeight: options.rowHeight || 64,
    };
    const table = sheet.tables.add(`A4:${lastColumn}${rows.length + 4}`, true, tableName);
    table.style = "TableStyleMedium2";
  }
  columns.forEach(([, header], index) => {
    const range = sheet.getRange(`${columnName(index)}4:${columnName(index)}${Math.max(rows.length + 4, 4)}`);
    range.format.columnWidth = widthFor(header);
    if (/ID|itemKey|settingId|nodeId|templateId|链接|URL|路径/u.test(header)) range.format.numberFormat = "@";
    if (/核查时间|请求时间/u.test(header)) range.format.numberFormat = "yyyy-mm-dd hh:mm:ss";
  });
  sheet.freezePanes.freezeRows(4);
  return sheet;
}

const reportTitle = metadata.reportTitle || "3.0新接口H标签历史失败项回归";
const expected = metadata.expectedContract ?? {};
addSheet("回归汇总", objects, objectColumns, "RegressionSummaryTable", {
  title: `${reportTitle}汇总`,
  context: `批次 ${state.run_id}；${expected.pages ?? state.pages.length}页，${expected.objects ?? objects.length}个组件/区块，${expected.historical_headings ?? headings.length}处历史目标H。修改成功后保留测试值，不发布网站。`,
});
if (!Array.isArray(metadata.targetObjects) || metadata.targetObjects.length === 0) {
  addSheet("7页预检失败结果", objects.filter((row) => row.issue_group === "preflight_validate_failed"), objectColumns, "PreflightResultTable");
  addSheet("25个组件区块结果", objects.filter((row) => row.issue_group === "origin_mismatch"), objectColumns, "OriginResultTable");
}
addSheet("H设置项明细", headings, headingColumns, "HeadingDetailTable", { rowHeight: 118 });
addSheet("已修复", objects.filter((row) => row.regression_status === "fixed_verified"), objectColumns, "FixedTable");
addSheet("仍未修复", objects.filter((row) => row.regression_status !== "fixed_verified"), objectColumns, "UnfixedTable");
addSheet("批量与单项差异", pageRows.filter((row) => String(row.batch_validate_status).startsWith("batch_validate_failed")), pageColumns, "BatchDifferenceTable");
addSheet("请求响应", apiRows, apiColumns, "ApiEvidenceTable", { rowHeight: 120 });
addSheet("自动化异常", pageRows.filter((row) => ["page_not_found", "mapping_ambiguous", "login_expired", "automation_error", "preview_failed"].includes(row.page_status)), pageColumns, "AutomationErrorTable");

const outputRoot = path.resolve(projectRoot, metadata.outputRoot);
const outputDir = path.join(outputRoot, `onpage-v3-history-regression-${state.run_id}`);
const previewDir = path.join(outputDir, "xlsx-preview");
const outputPath = path.join(outputDir, metadata.outputFilename || "3.0新接口H标签历史失败项回归结果.xlsx");
await fs.mkdir(previewDir, { recursive: true });

for (const sheet of workbook.worksheets.items) {
  const rowCount = sheet.name === "请求响应" ? Math.min(apiRows.length + 4, 18) : sheet.name === "H设置项明细" ? Math.min(headings.length + 4, 18) : 22;
  const columns = sheet.name === "H设置项明细" ? headingColumns.length : sheet.name === "请求响应" ? apiColumns.length : sheet.name === "批量与单项差异" || sheet.name === "自动化异常" ? pageColumns.length : objectColumns.length;
  const rendered = await workbook.render({ sheetName: sheet.name, range: `A1:${columnName(columns - 1)}${rowCount}`, scale: 1, format: "png" });
  await fs.writeFile(path.join(previewDir, `${sheet.name}.png`), new Uint8Array(await rendered.arrayBuffer()));
}

const inspection = await workbook.inspect({ kind: "workbook,sheet,table", maxChars: 5000, tableMaxRows: 5, tableMaxCols: 8, tableMaxCellChars: 100 });
await fs.writeFile(path.join(previewDir, "inspection.ndjson"), inspection.ndjson, "utf8");
const errors = await workbook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!", options: { useRegex: true, maxResults: 300 }, summary: "final formula error scan" });
await fs.writeFile(path.join(previewDir, "formula-errors.ndjson"), errors.ndjson, "utf8");

await fs.mkdir(outputDir, { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
const reopened = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));
const reopenCheck = await reopened.inspect({ kind: "sheet", include: "id,name", maxChars: 3000 });
await fs.writeFile(path.join(previewDir, "reopen-check.ndjson"), reopenCheck.ndjson, "utf8");
console.log(JSON.stringify({ outputPath, pages: state.pages.length, objects: objects.length, headings: headings.length }, null, 2));
