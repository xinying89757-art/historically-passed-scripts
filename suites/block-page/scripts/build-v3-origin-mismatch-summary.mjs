#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const outputDir = path.resolve(root, "../outputs/019fa755-5d3d-7792-8740-e4786e04a2f7/onpage-v3-origin-mismatch-summary-20260903");
const outputPath = path.join(outputDir, "3.0组件与区块-H_ORIGIN_NOT_MATCHED问题汇总.xlsx");
const previewDir = path.join(outputDir, "xlsx-previews");
const globalStatePath = path.join(root, ".state/growth-engine-h-v3-page-confirmation-state.json");
const retryStatePath = path.join(root, ".state/growth-engine-h-v3-page-confirmation-001-retry-state.json");

const readJson = async (filename) => JSON.parse(await fs.readFile(filename, "utf8"));
const exists = async (filename) => fs.access(filename).then(() => true).catch(() => false);
const text = (value) => value == null ? "" : String(value);

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

function parseSubject(item) {
  const value = text(item.original_text);
  const component = value.match(/^组件(标题|内容)测试-(\d+)-([^｜]+)/u);
  if (component) {
    return {
      type: "组件",
      id: component[2],
      name: component[3].replace(/-+$/u, "").trim(),
    };
  }
  const block = value.match(/^区块标题测试-(\d+)-(.+?)(?:-第\d+项)?(?:｜|$)/u);
  if (block) {
    return {
      type: "区块",
      id: block[1],
      name: block[2].replace(/-第\d+项$/u, "").trim(),
    };
  }
  return { type: "待确认", id: item.setting_id || item.item_key, name: value };
}

function taskArtifactDir(page) {
  if (!page.trace) return "";
  return path.dirname(page.trace);
}

async function filteredEvidence(page, itemKeys) {
  const dir = taskArtifactDir(page);
  const requestPath = path.join(dir, "api/headings-validate-request.json");
  const responsePath = path.join(dir, "api/headings-validate-response.json");
  const keys = new Set(itemKeys);
  const request = await exists(requestPath) ? await readJson(requestPath) : {};
  const response = await exists(responsePath) ? await readJson(responsePath) : {};
  const filteredRequest = {
    ...request,
    items: (request.items ?? []).filter((item) => keys.has(item.itemKey)),
  };
  const filteredResponse = {
    ...response,
    data: response.data ? {
      ...response.data,
      items: (response.data.items ?? []).filter((item) => keys.has(item.itemKey)),
    } : response.data,
  };
  return {
    request: filteredRequest,
    response: filteredResponse,
    requestPath,
    responsePath,
  };
}

const globalState = await readJson(globalStatePath);
const retryState = await readJson(retryStatePath);
const sources = [];
for (const page of globalState.pages ?? []) {
  if (page.page_path === "/001.html") continue;
  sources.push({ state: globalState, page });
}
for (const page of retryState.pages ?? []) sources.push({ state: retryState, page });

const groups = new Map();
for (const { state, page } of sources) {
  for (const item of page.items ?? []) {
    if (item.status !== "origin_mismatch") continue;
    const subject = parseSubject(item);
    const key = `${subject.type}|${subject.id}|${page.page_url}`;
    if (!groups.has(key)) groups.set(key, { subject, state, page, items: [] });
    groups.get(key).items.push(item);
  }
}

const records = [];
for (const group of groups.values()) {
  const { subject, state, page, items } = group;
  const evidence = await filteredEvidence(page, items.map((item) => item.item_key));
  const hItems = items.map((item) => `${item.item_key}（${item.original_level}：${item.original_text}）`).join("\n");
  records.push({
    "类型": subject.type,
    "组件/区块ID": `${subject.type}${subject.id}`,
    "组件/区块名称": subject.name,
    "问题描述": `${subject.type}${subject.id}的${items.length}处H标签调用新接口 /onpageOpenApi/headings/validate 后返回 H_ORIGIN_NOT_MATCHED，fieldCapabilities.type=false、fieldCapabilities.text=false，导致级别和文字均不可编辑；本次脚本未对这些失败项调用更新接口。`,
    "异常H数量": items.length,
    "页面名称": page.page_name,
    "页面路径": page.page_path,
    "页面链接": page.page_url,
    "H设置项": hItems,
    "validate入参JSON": JSON.stringify(evidence.request, null, 2),
    "validate响应JSON": JSON.stringify(evidence.response, null, 2),
    "接口状态": "H_ORIGIN_NOT_MATCHED",
    "请求证据": evidence.requestPath,
    "响应证据": evidence.responsePath,
    "复测批次": `批次${state.run_id}`,
  });
}

records.sort((a, b) => {
  if (a["类型"] !== b["类型"]) return a["类型"] === "组件" ? -1 : 1;
  const pageCompare = a["页面路径"].localeCompare(b["页面路径"], "zh-CN");
  if (pageCompare) return pageCompare;
  return Number(String(a["组件/区块ID"]).replace(/\D/gu, "")) - Number(String(b["组件/区块ID"]).replace(/\D/gu, ""));
});

const componentRows = records.filter((row) => row["类型"] === "组件");
const blockRows = records.filter((row) => row["类型"] === "区块");
const columns = [
  "类型", "组件/区块ID", "组件/区块名称", "问题描述", "异常H数量", "页面名称", "页面路径", "页面链接",
  "H设置项", "validate入参JSON", "validate响应JSON", "接口状态", "请求证据", "响应证据", "复测批次",
];

const workbook = Workbook.create();

function widthFor(header) {
  if (/入参|响应/.test(header)) return 58;
  if (/问题描述/.test(header)) return 52;
  if (/H设置项/.test(header)) return 46;
  if (/页面链接|证据/.test(header)) return 45;
  if (/名称|页面路径|页面名称/.test(header)) return 24;
  return 15;
}

function addDataSheet(name, rows, tableName) {
  const sheet = workbook.worksheets.add(name);
  const matrix = [columns, ...rows.map((row) => columns.map((column) => row[column] ?? ""))];
  const endCol = columnName(columns.length - 1);
  sheet.getRange(`B1:B${matrix.length}`).format.numberFormat = "@";
  sheet.getRange(`O1:O${matrix.length}`).format.numberFormat = "@";
  sheet.getRange(`A1:${endCol}${matrix.length}`).values = matrix;
  sheet.showGridLines = false;
  sheet.freezePanes.freezeRows(1);
  sheet.getRange(`A1:${endCol}1`).format = {
    fill: "#12304A",
    font: { bold: true, color: "#FFFFFF" },
    verticalAlignment: "center",
    rowHeight: 30,
  };
  if (matrix.length > 1) {
    sheet.getRange(`A2:${endCol}${matrix.length}`).format = {
      verticalAlignment: "top",
      wrapText: true,
      borders: { preset: "inside", style: "thin", color: "#DCE3EA" },
      rowHeight: 126,
    };
    sheet.getRange(`L2:L${matrix.length}`).conditionalFormats.add("containsText", {
      text: "H_ORIGIN_NOT_MATCHED",
      format: { fill: "#FDECEC", font: { color: "#B42318", bold: true } },
    });
  }
  columns.forEach((header, index) => {
    const range = sheet.getRange(`${columnName(index)}1:${columnName(index)}${matrix.length}`);
    range.format.columnWidth = widthFor(header);
    if (/ID|链接|证据|批次/.test(header)) range.format.numberFormat = "@";
  });
  if (matrix.length > 1) {
    const table = sheet.tables.add(`A1:${endCol}${matrix.length}`, true, tableName);
    table.style = "TableStyleMedium2";
  }
  return sheet;
}

const summary = workbook.worksheets.add("汇总");
addDataSheet("组件问题", componentRows, "ComponentOriginMismatchTable");
addDataSheet("区块问题", blockRows, "BlockOriginMismatchTable");
summary.showGridLines = false;
summary.getRange("A1:D1").merge();
summary.getRange("A1").values = [["3.0组件与区块 H_ORIGIN_NOT_MATCHED 问题汇总"]];
summary.getRange("A1:D1").format = { fill: "#12304A", font: { bold: true, color: "#FFFFFF", size: 16 }, rowHeight: 34 };
summary.getRange("A3:B6").values = [
  ["指标", "数量"],
  ["涉及组件", null],
  ["涉及区块", null],
  ["异常H总数", null],
];
summary.getRange("B4").formulas = [[`=COUNTA('组件问题'!B2:B${componentRows.length + 1})`]];
summary.getRange("B5").formulas = [[`=COUNTA('区块问题'!B2:B${blockRows.length + 1})`]];
summary.getRange("B6").formulas = [[`=SUM('组件问题'!E2:E${componentRows.length + 1})+SUM('区块问题'!E2:E${blockRows.length + 1})`]];
summary.getRange("A3:B3").format = { fill: "#DCEAF7", font: { bold: true, color: "#12304A" } };
summary.getRange("A3:B6").format.borders = { preset: "all", style: "thin", color: "#CBD5E1" };
summary.getRange("A8:D10").values = [
  ["结论", "H_ORIGIN_NOT_MATCHED 表示新接口认为请求中的原始H文字或级别与接口侧记录不一致。", "", ""],
  ["验证口径", "旧接口仅用于读取定位参数；失败项未调用 headings/update。", "", ""],
  ["数据版本", `组件/区块结果取最新复测批次：${retryState.run_id} / ${globalState.run_id}`, "", ""],
];
summary.getRange("B8:D8").merge();
summary.getRange("B9:D9").merge();
summary.getRange("B10:D10").merge();
summary.getRange("A8:D10").format = { wrapText: true, verticalAlignment: "top" };
summary.getRange("A1:D10").format.columnWidth = 24;
summary.getRange("B1:D10").format.columnWidth = 35;

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(previewDir, { recursive: true });

for (const [sheetName, range] of [["汇总", "A1:D10"], ["组件问题", `A1:O${componentRows.length + 1}`], ["区块问题", "A1:O10"]]) {
  const preview = await workbook.render({ sheetName, range, scale: 1, format: "png" });
  await fs.writeFile(path.join(previewDir, `${sheetName}.png`), new Uint8Array(await preview.arrayBuffer()));
}

const inspection = await workbook.inspect({
  kind: "workbook,sheet,table",
  maxChars: 5000,
  tableMaxRows: 8,
  tableMaxCols: 8,
  tableMaxCellChars: 100,
});
await fs.writeFile(path.join(previewDir, "inspection.ndjson"), inspection.ndjson, "utf8");
const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "formula error scan",
});
await fs.writeFile(path.join(previewDir, "formula-errors.ndjson"), errors.ndjson, "utf8");

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

const imported = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));
const check = await imported.inspect({ kind: "sheet", include: "id,name", maxChars: 2000 });
await fs.writeFile(path.join(previewDir, "reopen-check.ndjson"), check.ndjson, "utf8");

console.log(JSON.stringify({ outputPath, componentCount: componentRows.length, blockCount: blockRows.length, headingCount: records.reduce((sum, row) => sum + row["异常H数量"], 0) }, null, 2));
