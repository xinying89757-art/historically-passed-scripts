#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const statePath = path.join(root, ".state/growth-engine-h-v3-page-confirmation-state.json");
const outputPath = path.join(root, "reports/growth-engine-h-v3-page-confirmation/3.0新接口20页-核查汇总.xlsx");

const text = (value) => value == null ? "" : String(value);
const rowsFor = (columns, rows) => [columns, ...rows.map((row) => columns.map((column) => row[column] ?? ""))];

const pageColumns = ["页面名称", "页面路径", "页面链接", "站点", "站点ID", "当前状态", "H数量", "提交数量", "预览链接", "失败原因", "Trace", "核查时间"];
const itemColumns = ["页面名称", "页面路径", "页面链接", "H序号", "H键", "区块/组件设置ID", "原级别", "原文字", "级别可编辑", "文字可编辑", "预期级别", "预期文字", "接口状态", "更新结果", "预览级别", "预览文字", "预览状态", "编辑器级别", "编辑器文字", "编辑器回填", "最终状态", "失败原因", "请求证据", "响应证据"];

const siteLabelFor = (p) => {
  if (p.site_name || p.growth_engine_site_name || p.editor_site_name) {
    return p.site_name ?? p.growth_engine_site_name ?? p.editor_site_name;
  }
  if (String(p.page_path ?? "").startsWith("/block-ranking-heading-test-")) return "3.0区块+组件";
  if (String(p.site_setting_id ?? "") === "993668") return "全量3.0区块";
  if (String(p.site_setting_id ?? "") === "997698") return "测试增长引擎";
  return "";
};

const toPage = (p) => ({
  "页面名称": p.page_name, "页面路径": p.page_path, "页面链接": p.page_url,
  "站点": siteLabelFor(p),
  "站点ID": p.site_setting_id ?? "", "当前状态": p.status,
  "H数量": p.captured_count, "提交数量": p.submitted_count, "预览链接": p.preview_url,
  "失败原因": p.failure_reason, "Trace": p.trace,
  "核查时间": p.checked_at ? `'${p.checked_at}` : "",
});
const toItem = (i) => ({
  "页面名称": i.page_name, "页面路径": i.page_path, "页面链接": i.page_url, "H序号": i.item_index,
  "H键": i.item_key, "区块/组件设置ID": i.setting_id, "原级别": i.original_level, "原文字": i.original_text,
  "级别可编辑": i.level_editable, "文字可编辑": i.text_editable, "预期级别": i.expected_level,
  "预期文字": i.expected_text, "接口状态": i.api_status, "更新结果": i.update_item_status,
  "预览级别": i.preview_level, "预览文字": i.preview_text, "预览状态": i.preview_status,
  "编辑器级别": i.editor_level, "编辑器文字": i.editor_text, "编辑器回填": i.editor_backfill_status,
  "最终状态": i.status, "失败原因": i.failure_reason, "请求证据": i.request_evidence,
  "响应证据": i.response_evidence,
});

const state = JSON.parse(await fs.readFile(statePath, "utf8"));
const pages = state.pages ?? [];
const items = pages.flatMap((page) => page.items ?? []);
const workbook = Workbook.create();
const previewDir = path.join(path.dirname(outputPath), "xlsx-previews");

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

function columnWidth(header) {
  if (/链接|证据|Trace/.test(header)) return 42;
  if (/失败原因|问题描述/.test(header)) return 48;
  if (/文字/.test(header)) return 36;
  if (/页面名称|页面路径/.test(header)) return 28;
  if (/设置ID|H键/.test(header)) return 24;
  return 15;
}

function addSheet(name, columns, rows) {
  const sheet = workbook.worksheets.add(name);
  const matrix = rowsFor(columns, rows);
  const endCol = columnName(columns.length - 1);
  sheet.getRange(`A1:${endCol}${matrix.length}`).values = matrix;
  sheet.showGridLines = false;
  sheet.getRange(`A1:${endCol}1`).format = {
    fill: "#0f2742",
    font: { bold: true, color: "#ffffff" },
    rowHeight: 28,
    verticalAlignment: "center",
  };
  if (matrix.length > 1) {
    sheet.getRange(`A2:${endCol}${matrix.length}`).format = {
      verticalAlignment: "top",
      wrapText: true,
      borders: { preset: "inside", style: "thin", color: "#e5e7eb" },
    };
  }
  columns.forEach((header, index) => {
    const columnRange = sheet.getRange(`${columnName(index)}1:${columnName(index)}${matrix.length}`);
    columnRange.format.columnWidth = columnWidth(header);
    if (/ID|H键|链接|证据|Trace|时间|批次号/.test(header)) columnRange.format.numberFormat = "@";
  });
  sheet.freezePanes.freezeRows(1);
  return sheet;
}

addSheet("页面结果", pageColumns, pages.map(toPage));
addSheet("H设置项明细", itemColumns, items.map(toItem));
addSheet("明确不可编辑", itemColumns, items.filter((i) => i.status === "field_not_editable").map(toItem));
addSheet("H原始值不匹配", itemColumns, items.filter((i) => i.status === "origin_mismatch").map(toItem));
addSheet("其他更新失败", itemColumns, items.filter((i) => ![
  "modified_verified", "partially_editable_verified", "field_not_editable", "origin_mismatch", "editor_backfill_mismatch",
].includes(i.status)).map(toItem));
addSheet("预览异常", itemColumns, items.filter((i) => !["verified", "not_applicable", ""].includes(i.preview_status)).map(toItem));
addSheet("编辑器回填异常", itemColumns, items.filter((i) => !["verified", "not_applicable", ""].includes(i.editor_backfill_status)).map(toItem));
addSheet("页面与归属异常", pageColumns, pages.filter((p) => [
  "mapping_ambiguous", "page_not_found", "site_not_found", "automation_error", "login_expired", "proxy_unavailable",
].includes(p.status)).map(toPage));

const summary = [
  { 指标: "批次号", 值: `'${state.run_id}` },
  { 指标: "阶段", 值: state.phase },
  { 指标: "页面总数", 值: pages.length },
  { 指标: "完整页面", 值: pages.filter((p) => p.status === "complete").length },
  { 指标: "页面失败/异常", 值: pages.filter((p) => p.status !== "complete").length },
  { 指标: "H设置项总数", 值: items.length },
  { 指标: "接口更新成功", 值: items.filter((i) => i.api_status === "updated").length },
  { 指标: "预览验证成功", 值: items.filter((i) => i.preview_status === "verified").length },
  { 指标: "编辑器回填成功", 值: items.filter((i) => i.editor_backfill_status === "verified").length },
  { 指标: "明确不可编辑", 值: items.filter((i) => i.status === "field_not_editable").length },
  { 指标: "H_ORIGIN_NOT_MATCHED", 值: items.filter((i) => i.status === "origin_mismatch").length },
  { 指标: "编辑器回填异常", 值: items.filter((i) => i.status === "editor_backfill_mismatch").length },
  { 指标: "编辑器入口自动化异常", 值: pages.filter((p) => p.status === "automation_error").length },
  { 指标: "增长引擎页面未找到", 值: pages.filter((p) => p.status === "page_not_found").length },
  { 指标: "页面归属异常", 值: pages.filter((p) => p.status === "mapping_ambiguous").length },
  { 指标: "生成时间", 值: `'${new Date().toISOString()}` },
];
addSheet("运行状态", ["指标", "值"], summary);

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.mkdir(previewDir, { recursive: true });

for (const sheet of workbook.worksheets.items) {
  const used = sheet.getUsedRange();
  const rowCount = Math.min(used?.rowCount ?? 1, 25);
  const columnCount = used?.columnCount ?? 1;
  const previewRange = `A1:${columnName(columnCount - 1)}${rowCount}`;
  const preview = await workbook.render({ sheetName: sheet.name, range: previewRange, scale: 1, format: "png" });
  await fs.writeFile(path.join(previewDir, `${sheet.name}.png`), new Uint8Array(await preview.arrayBuffer()));
}

const inspection = await workbook.inspect({
  kind: "workbook,sheet,table",
  maxChars: 4000,
  tableMaxRows: 5,
  tableMaxCols: 8,
  tableMaxCellChars: 80,
});
await fs.writeFile(path.join(previewDir, "inspection.ndjson"), inspection.ndjson, "utf8");

const formulaErrors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "final formula error scan",
});
await fs.writeFile(path.join(previewDir, "formula-errors.ndjson"), formulaErrors.ndjson, "utf8");

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(outputPath);
