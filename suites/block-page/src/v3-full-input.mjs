import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const SUPPORTED_TEMPLATE_ORDER = [
  "文本编辑",
  "多媒体集类型1",
  "多媒体集类型2",
  "图片集类型1",
  "图片集类型2",
  "图片集类型3",
  "图文页签",
];

export const EXCLUDED_TEMPLATES = new Set([
  "产品详情",
  "图片集类型4",
  "图片编辑",
]);

export function templateTypeFromFileName(fileName) {
  const name = fileName.replace(/\.json$/iu, "");
  if (/产品详情/u.test(name)) return "产品详情";
  if (/图片编辑/u.test(name)) return "图片编辑";
  if (/图文页签/u.test(name)) return "图文页签";
  if (/文本/u.test(name) && /编辑/u.test(name)) return "文本编辑";
  const gallery = name.match(/图片集[^\d]*(\d)/u);
  if (gallery) return `图片集类型${gallery[1]}`;
  const multimedia = name.match(/多媒体集[^\d]*(\d)/u);
  if (multimedia) return `多媒体集类型${multimedia[1]}`;
  throw new Error(`无法从文件名识别模板类型：${fileName}`);
}

function templateRank(type) {
  const supported = SUPPORTED_TEMPLATE_ORDER.indexOf(type);
  if (supported >= 0) return supported;
  return SUPPORTED_TEMPLATE_ORDER.length + [...EXCLUDED_TEMPLATES].indexOf(type);
}

export async function readV3FullInput(inputDir) {
  const names = (await readdir(inputDir))
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .map((fileName) => ({ fileName, templateType: templateTypeFromFileName(fileName) }))
    .sort((left, right) =>
      templateRank(left.templateType) - templateRank(right.templateType) ||
      left.fileName.localeCompare(right.fileName, "zh-CN"),
    );
  if (names.length !== 10) {
    throw new Error(`输入目录应有10个JSON文件，实际为${names.length}个`);
  }

  const hash = createHash("sha256");
  const byId = new Map();
  let sourceRows = 0;
  for (const { fileName, templateType } of names) {
    const filePath = path.join(inputDir, fileName);
    const raw = await readFile(filePath);
    hash.update(fileName).update("\0").update(raw).update("\0");
    const rows = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/u, ""));
    if (!Array.isArray(rows)) throw new Error(`${fileName} 顶层不是数组`);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      sourceRows += 1;
      const blockId = String(rows[rowIndex].block_id ?? "").trim();
      if (!/^\d+$/u.test(blockId)) {
        throw new Error(`${fileName} 第${rowIndex + 1}条缺少有效block_id`);
      }
      const appName = String(rows[rowIndex].APP_NAME ?? "").trim();
      const record = byId.get(blockId) ?? {
        block_id: blockId,
        app_name: appName,
        app_names: [],
        template_types: [],
        source_files: [],
        source_positions: [],
        first_source_order: sourceRows,
      };
      if (appName && !record.app_names.includes(appName)) record.app_names.push(appName);
      if (!record.app_name && appName) record.app_name = appName;
      if (!record.template_types.includes(templateType)) record.template_types.push(templateType);
      if (!record.source_files.includes(fileName)) record.source_files.push(fileName);
      record.source_positions.push(`${fileName}:${rowIndex + 1}`);
      byId.set(blockId, record);
    }
  }

  const all = [...byId.values()].map((record) => ({
    ...record,
    template_types: record.template_types.sort((a, b) => templateRank(a) - templateRank(b)),
  }));
  const excluded = all
    .filter((record) => record.template_types.some((type) => EXCLUDED_TEMPLATES.has(type)))
    .map((record) => ({
      ...record,
      status: "excluded_template",
      exclusion_reason: `同一block_id命中排除模板：${record.template_types.filter((type) => EXCLUDED_TEMPLATES.has(type)).join("、")}`,
    }));
  const excludedIds = new Set(excluded.map((record) => record.block_id));
  const records = all
    .filter((record) => !excludedIds.has(record.block_id))
    .sort((left, right) => left.first_source_order - right.first_source_order);

  const typeCounts = {};
  for (const type of [...SUPPORTED_TEMPLATE_ORDER, ...EXCLUDED_TEMPLATES]) {
    typeCounts[type] = all.filter((record) => record.template_types.includes(type)).length;
  }
  return {
    checksum: hash.digest("hex"),
    inputDir,
    files: names,
    sourceRows,
    uniqueCount: all.length,
    records,
    excluded,
    typeCounts,
  };
}
