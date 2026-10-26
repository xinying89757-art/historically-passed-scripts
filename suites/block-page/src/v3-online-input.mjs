import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

export const ONLINE_EXCLUDED_TEMPLATES = new Set(["产品详情", "图片集类型4", "图片编辑"]);

function text(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function resolveCell(value) {
  return text(value);
}

function parseTypes(value) {
  return [...new Set(resolveCell(value).split(/[、,，;；]+/u).map(text).filter(Boolean))];
}

function rowToRecord(row, sheetRow) {
  const blockId = resolveCell(row[0]);
  const appName = resolveCell(row[1]);
  const status = resolveCell(row[2]);
  const thirdAction = resolveCell(row[3]);
  const templateTypes = parseTypes(row[6]);
  const sourceFiles = resolveCell(row[7]).split(/[；;]+/u).map(text).filter(Boolean);
  const sourcePositions = resolveCell(row[8]).split(/[；;]+/u).map(text).filter(Boolean);
  const sourceOrder = Number(row[9]);
  if (!/^\d+$/u.test(blockId)) throw new Error(`上线工作表第${sheetRow}行区块ID无效：${blockId}`);
  if (status !== "上线" || thirdAction !== "应用下线") {
    throw new Error(`上线工作表第${sheetRow}行状态校验失败：${blockId} / ${status} / ${thirdAction}`);
  }
  if (templateTypes.some((type) => ONLINE_EXCLUDED_TEMPLATES.has(type))) {
    throw new Error(`上线工作表第${sheetRow}行命中排除模板：${blockId} / ${templateTypes.join("、")}`);
  }
  if (!Number.isFinite(sourceOrder)) throw new Error(`上线工作表第${sheetRow}行缺少原始顺序：${blockId}`);
  return {
    block_id: blockId,
    app_name: appName,
    app_names: appName ? [appName] : [],
    template_types: templateTypes,
    source_files: sourceFiles,
    source_positions: sourcePositions,
    source_row: sheetRow,
    first_source_order: sourceOrder,
  };
}

export async function readOnlineWorkbook(workbookPath) {
  const bytes = await FileBlob.load(workbookPath);
  const workbook = await SpreadsheetFile.importXlsx(bytes);
  const sheet = workbook.worksheets.getItem("上线");
  if (!sheet || sheet.isNullObject) throw new Error("输入工作簿缺少“上线”工作表");
  const used = sheet.getUsedRange(true);
  const values = used.values;
  const headerIndex = values.findIndex((row) => resolveCell(row[0]) === "区块ID");
  if (headerIndex < 0) throw new Error("“上线”工作表未找到区块ID表头");
  const records = values.slice(headerIndex + 1)
    .map((row, index) => rowToRecord(row, headerIndex + index + 2))
    .filter((record) => record.block_id);
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.block_id)) throw new Error(`上线工作表存在重复区块ID：${record.block_id}`);
    seen.add(record.block_id);
  }
  records.sort((left, right) => left.first_source_order - right.first_source_order || Number(left.block_id) - Number(right.block_id));
  const checksum = createHash("sha256").update(JSON.stringify(records)).digest("hex");
  return {
    inputWorkbook: workbookPath,
    sourceRows: records.length,
    uniqueCount: records.length,
    targetCount: records.length,
    excludedCount: 0,
    checksum,
    files: [path.basename(workbookPath)],
    records,
    excluded: [],
  };
}

export async function readOnlineWorkbookFromConfig(config) {
  return readOnlineWorkbook(config.v3OnlineWorkbook);
}
