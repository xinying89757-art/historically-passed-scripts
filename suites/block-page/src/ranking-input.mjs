import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SpreadsheetFile } from "@oai/artifact-tool";

export const RANKING_EXCLUDED_TEMPLATES = new Set([
  "产品详情",
  "图片集类型4",
]);

export const RANKING_TEMPLATE_REPRESENTATIVES = [
  ["文本编辑", "26074"],
  ["多媒体集类型1", "27562"],
  ["多媒体集类型2", "22774"],
  ["图片编辑", "531"],
  ["图片集类型1", "9484"],
  ["图片集类型2", "16974"],
  ["图片集类型3", "23404"],
  ["图文页签", "18444"],
];

function normalize(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

export async function readRankingWorkbook(workbookPath, sheetName = "Sheet1") {
  const bytes = await readFile(workbookPath);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const workbook = await SpreadsheetFile.importXlsx(bytes);
  const worksheet = workbook.worksheets.getItem(sheetName);
  if (!worksheet || worksheet.isNullObject) {
    throw new Error(`区块排名工作簿中未找到工作表：${sheetName}`);
  }
  const values = worksheet.getRange("A1:D112").values;
  const grouped = new Map();
  const excluded = [];
  let includedRows = 0;

  for (let index = 0; index < values.length; index += 1) {
    const [templateRaw, idRaw, nameRaw, usageRaw] = values[index];
    const templateType = normalize(templateRaw);
    const blockId = normalize(idRaw);
    if (
      !blockId ||
      !/^\d+$/u.test(blockId) ||
      templateType === "区块模板类型"
    ) {
      continue;
    }
    const source = {
      excel_row: index + 1,
      template_type: templateType,
      block_id: blockId,
      block_name: normalize(nameRaw),
      usage: Number(usageRaw ?? 0),
    };
    if (RANKING_EXCLUDED_TEMPLATES.has(templateType)) {
      excluded.push({
        ...source,
        status: "excluded",
        failure_reason: `模板类型“${templateType}”按本批次要求排除`,
      });
      continue;
    }
    includedRows += 1;
    if (!grouped.has(blockId)) {
      grouped.set(blockId, {
        csv_row: index + 1,
        excel_row: index + 1,
        block_id: blockId,
        app_name: normalize(nameRaw),
        block_name: normalize(nameRaw),
        usage: Number(usageRaw ?? 0),
        template_types: [],
      });
    }
    const record = grouped.get(blockId);
    if (!record.template_types.includes(templateType)) {
      record.template_types.push(templateType);
    }
  }

  const ordered = [];
  for (const [templateType, blockId] of RANKING_TEMPLATE_REPRESENTATIVES) {
    const record = grouped.get(blockId);
    if (!record?.template_types.includes(templateType)) {
      throw new Error(`代表区块不存在或模板不匹配：${templateType}/${blockId}`);
    }
    ordered.push(record);
  }
  for (const record of grouped.values()) {
    if (!ordered.includes(record)) {
      ordered.push(record);
    }
  }

  return {
    checksum,
    workbookPath,
    sheetName,
    sourceRowCount: values.length,
    includedRows,
    blocks: ordered,
    duplicates: ordered
      .filter((record) => record.template_types.length > 1)
      .map((record) => ({
        block_id: record.block_id,
        template_types: record.template_types,
      })),
    excluded,
  };
}
