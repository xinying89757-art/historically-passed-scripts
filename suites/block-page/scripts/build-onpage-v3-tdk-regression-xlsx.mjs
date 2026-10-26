#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import { projectRoot } from "../src/config.mjs";

const configIndex = process.argv.indexOf("--config");
const configPath = path.resolve(projectRoot, configIndex >= 0 ? process.argv[configIndex + 1] : "config/onpage-agent-tdk-v3-regression.json");
const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const stateFile = path.resolve(projectRoot, config.paths.stateFile);
const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
const outputDir = state.output_dir || path.resolve(projectRoot, config.paths.outputRoot, `onpage-v3-tdk-regression-${state.run_id}`);
const previewDir = path.join(outputDir, "xlsx-preview");
const outputPath = path.join(outputDir, "3.0 TDK成功但未持久化复核结果.xlsx");

function redact(value) {
  const sensitive = /authorization|token|cookie|password|secret/iu;
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive.test(key) ? "***" : redact(item)]));
  return value;
}

async function jsonFile(file) {
  if (!file) return "";
  try { return JSON.stringify(redact(JSON.parse(await fs.readFile(file, "utf8"))), null, 2); } catch { return ""; }
}

const summaryRows = state.attempts.map((attempt) => {
  const finalActual = attempt.fresh_auth_read?.actual ?? attempt.polls.at(-1)?.actual ?? {};
  const actualEmpty = [finalActual.seoTitle, finalActual.seoKeyword, finalActual.seoDesc].every((value) => !value);
  return ({
  run_id: state.run_id,
  page_name: state.target.pageName,
  page_path: state.target.pagePath,
  scheme: attempt.scheme.toUpperCase(),
  requested_url: attempt.requested_url,
  canonical_url: attempt.canonical_url,
  site_setting_id: attempt.site_setting_id,
  expected_title: attempt.expected.seoTitle,
  expected_keyword: attempt.expected.seoKeyword,
  expected_desc: attempt.expected.seoDesc,
  save_http: attempt.save?.http_status ?? "",
  save_code: attempt.save?.business_code ?? "",
  save_success: attempt.save?.success_flag ?? "",
  persistence_status: attempt.status,
  persisted_at_ms: attempt.persisted_at_ms ?? "",
  problem: attempt.status === "success_but_not_persisted" ? `保存接口返回HTTP 200、code=200、success=true，但120秒内及换新授权读取均未返回本批次目标值，${actualEmpty ? "三个字段始终为空。" : "仍返回保存前的TDK值。"}` : attempt.failure_reason ?? "",
  });
});

const baselineRows = state.baseline_reads.map((row) => ({
  scheme: row.scheme.toUpperCase(), requested_url: row.requested_url, canonical_url: row.canonical_url,
  site_setting_id: row.site_setting_id, auth_status: row.auth_status, read_status: row.read_status,
  seo_title: row.values.seoTitle, seo_keyword: row.values.seoKeyword, seo_desc: row.values.seoDesc,
  auth_request: row.auth_request_file, auth_response: row.auth_response_file,
  read_request: row.read_request_file, read_response: row.read_response_file, checked_at: row.checked_at,
}));

const pollRows = state.attempts.flatMap((attempt) => attempt.polls.map((poll) => ({
  scheme: attempt.scheme.toUpperCase(), canonical_url: attempt.canonical_url, offset_seconds: poll.offset_ms / 1000,
  elapsed_ms: poll.elapsed_ms, http_status: poll.http_status, business_code: poll.business_code,
  actual_title: poll.actual.seoTitle, actual_keyword: poll.actual.seoKeyword, actual_desc: poll.actual.seoDesc,
  title_match: poll.comparison.matches.seoTitle, keyword_match: poll.comparison.matches.seoKeyword,
  desc_match: poll.comparison.matches.seoDesc, exact_match: poll.comparison.exact,
  request_file: poll.request_file, response_file: poll.response_file, checked_at: poll.checked_at,
})));
pollRows.push(...state.attempts.filter((attempt) => attempt.fresh_auth_read).map((attempt) => ({
  scheme: `${attempt.scheme.toUpperCase()}（新授权）`, canonical_url: attempt.fresh_auth_read.canonical_url,
  offset_seconds: "fresh-auth", elapsed_ms: attempt.fresh_auth_read.elapsed_ms, http_status: "", business_code: "",
  actual_title: attempt.fresh_auth_read.actual?.seoTitle ?? "", actual_keyword: attempt.fresh_auth_read.actual?.seoKeyword ?? "",
  actual_desc: attempt.fresh_auth_read.actual?.seoDesc ?? "", title_match: attempt.fresh_auth_read.comparison?.matches?.seoTitle ?? false,
  keyword_match: attempt.fresh_auth_read.comparison?.matches?.seoKeyword ?? false, desc_match: attempt.fresh_auth_read.comparison?.matches?.seoDesc ?? false,
  exact_match: attempt.fresh_auth_read.comparison?.exact ?? false, request_file: attempt.fresh_auth_read.request_file,
  response_file: attempt.fresh_auth_read.response_file, checked_at: attempt.fresh_auth_read.checked_at,
})));

const apiRows = [];
for (const call of state.api_calls) {
  apiRows.push({
    stage: call.stage, method: call.method, endpoint: call.url, http_status: call.http_status,
    business_code: call.business_code, duration_ms: call.duration_ms,
    request_json: await jsonFile(call.request_file), response_json: await jsonFile(call.response_file),
    request_file: call.request_file, response_file: call.response_file, checked_at: call.checked_at,
  });
}

const issueRows = summaryRows.filter((row) => !["persisted_verified", "delayed_persisted"].includes(row.persistence_status)).map((row) => ({
  module: "3.0新接口-TDK",
  issue: row.problem || `TDK复核未通过：${row.persistence_status}`,
  page_url: row.canonical_url,
  scheme: row.scheme,
  status: row.persistence_status,
  save_request_json: apiRows.find((item) => item.stage === `${row.scheme.toLowerCase()}-tdk-save`)?.request_json ?? "",
  save_response_json: apiRows.find((item) => item.stage === `${row.scheme.toLowerCase()}-tdk-save`)?.response_json ?? "",
}));

const columns = {
  summary: [["run_id", "批次号"], ["page_name", "页面名称"], ["page_path", "页面路径"], ["scheme", "协议"], ["requested_url", "请求URL"], ["canonical_url", "规范URL"], ["site_setting_id", "siteSettingId"], ["expected_title", "目标标题"], ["expected_keyword", "目标关键词"], ["expected_desc", "目标描述"], ["save_http", "保存HTTP"], ["save_code", "保存code"], ["save_success", "保存success"], ["persistence_status", "持久化状态"], ["persisted_at_ms", "生效延迟ms"], ["problem", "问题描述"]],
  baseline: [["scheme", "协议"], ["requested_url", "请求URL"], ["canonical_url", "规范URL"], ["site_setting_id", "siteSettingId"], ["auth_status", "授权状态"], ["read_status", "读取状态"], ["seo_title", "基线标题"], ["seo_keyword", "基线关键词"], ["seo_desc", "基线描述"], ["auth_request", "授权请求文件"], ["auth_response", "授权响应文件"], ["read_request", "读取请求文件"], ["read_response", "读取响应文件"], ["checked_at", "核查时间"]],
  poll: [["scheme", "协议/阶段"], ["canonical_url", "规范URL"], ["offset_seconds", "轮询秒数"], ["elapsed_ms", "实际耗时ms"], ["http_status", "HTTP"], ["business_code", "code"], ["actual_title", "实际标题"], ["actual_keyword", "实际关键词"], ["actual_desc", "实际描述"], ["title_match", "标题匹配"], ["keyword_match", "关键词匹配"], ["desc_match", "描述匹配"], ["exact_match", "三字段全匹配"], ["request_file", "请求文件"], ["response_file", "响应文件"], ["checked_at", "核查时间"]],
  api: [["stage", "阶段"], ["method", "方法"], ["endpoint", "接口URL"], ["http_status", "HTTP"], ["business_code", "code"], ["duration_ms", "耗时ms"], ["request_json", "请求JSON（已脱敏）"], ["response_json", "响应JSON（已脱敏）"], ["request_file", "请求文件"], ["response_file", "响应文件"], ["checked_at", "请求时间"]],
  issue: [["module", "模块"], ["issue", "缺陷描述"], ["page_url", "页面链接"], ["scheme", "协议"], ["status", "状态"], ["save_request_json", "入参JSON（已脱敏）"], ["save_response_json", "响应JSON（已脱敏）"]],
};

function colName(index) {
  let n = index + 1; let result = "";
  while (n > 0) { const remainder = (n - 1) % 26; result = String.fromCharCode(65 + remainder) + result; n = Math.floor((n - 1) / 26); }
  return result;
}
function width(header) {
  if (/JSON/u.test(header)) return 70;
  if (/问题描述/u.test(header)) return 60;
  if (/标题|关键词|描述/u.test(header)) return 40;
  if (/URL|文件/u.test(header)) return 44;
  return 16;
}

const workbook = Workbook.create();
function addSheet(name, rows, defs, tableName, subtitle) {
  const sheet = workbook.worksheets.add(name);
  sheet.showGridLines = false;
  const last = colName(defs.length - 1);
  sheet.getRange(`A1:${last}1`).merge();
  sheet.getRange("A1").values = [[name]];
  sheet.getRange(`A1:${last}1`).format = { fill: "#16324F", font: { name: "Arial", bold: true, size: 16, color: "#FFFFFF" }, rowHeight: 30 };
  sheet.getRange(`A2:${last}2`).merge();
  sheet.getRange("A2").values = [[subtitle]];
  sheet.getRange(`A2:${last}2`).format = { font: { name: "Arial", italic: true, color: "#52606D" }, rowHeight: 25 };
  const matrix = [defs.map(([, header]) => header), ...rows.map((row) => defs.map(([key]) => row[key] ?? ""))];
  sheet.getRange(`A4:${last}${matrix.length + 3}`).values = matrix;
  sheet.getRange(`A4:${last}4`).format = { fill: "#2563EB", font: { name: "Arial", bold: true, color: "#FFFFFF" }, horizontalAlignment: "center", verticalAlignment: "center", wrapText: true, rowHeight: 32 };
  if (rows.length) {
    sheet.getRange(`A5:${last}${rows.length + 4}`).format = { font: { name: "Arial", size: 10 }, verticalAlignment: "top", wrapText: true, rowHeight: /请求响应|异常/u.test(name) ? 120 : 54 };
    sheet.tables.add(`A4:${last}${rows.length + 4}`, true, tableName).style = "TableStyleMedium2";
  }
  defs.forEach(([, header], i) => {
    const range = sheet.getRange(`${colName(i)}4:${colName(i)}${Math.max(rows.length + 4, 4)}`);
    range.format.columnWidth = width(header);
    if (/ID|URL|链接|文件/u.test(header)) range.format.numberFormat = "@";
  });
  sheet.freezePanes.freezeRows(4);
  return sheet;
}

const subtitle = `批次 ${state.run_id}；最终状态 ${state.final_status}；只测试TDK，不测试结构化数据，不进入编辑器，不发布。`;
addSheet("复核汇总", summaryRows, columns.summary, "TdkSummary", subtitle);
addSheet("协议基线", baselineRows, columns.baseline, "TdkBaseline", subtitle);
addSheet("轮询明细", pollRows, columns.poll, "TdkPolls", subtitle);
addSheet("请求响应", apiRows, columns.api, "TdkApi", subtitle);
addSheet("异常", issueRows, columns.issue, "TdkIssues", subtitle);

await fs.mkdir(previewDir, { recursive: true });
for (const sheet of workbook.worksheets.items) {
  const defs = sheet.name === "复核汇总" ? columns.summary : sheet.name === "协议基线" ? columns.baseline : sheet.name === "轮询明细" ? columns.poll : sheet.name === "请求响应" ? columns.api : columns.issue;
  const rendered = await workbook.render({ sheetName: sheet.name, range: `A1:${colName(defs.length - 1)}${Math.min(18, (sheet.name === "请求响应" ? apiRows.length : sheet.name === "轮询明细" ? pollRows.length : sheet.name === "协议基线" ? baselineRows.length : sheet.name === "异常" ? issueRows.length : summaryRows.length) + 4)}`, scale: 1, format: "png" });
  await fs.writeFile(path.join(previewDir, `${sheet.name}.png`), new Uint8Array(await rendered.arrayBuffer()));
}
const inspection = await workbook.inspect({ kind: "workbook,sheet,table", maxChars: 6000, tableMaxRows: 6, tableMaxCols: 10, tableMaxCellChars: 120 });
await fs.writeFile(path.join(previewDir, "inspection.ndjson"), inspection.ndjson, "utf8");
const errors = await workbook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!", options: { useRegex: true, maxResults: 300 }, summary: "final formula error scan" });
await fs.writeFile(path.join(previewDir, "formula-errors.ndjson"), errors.ndjson, "utf8");
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
const reopened = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));
const reopenCheck = await reopened.inspect({ kind: "sheet", include: "id,name", maxChars: 3000 });
await fs.writeFile(path.join(previewDir, "reopen-check.ndjson"), reopenCheck.ndjson, "utf8");
console.log(JSON.stringify({ outputPath, sheets: workbook.worksheets.items.map((sheet) => sheet.name), previewDir }, null, 2));
