import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseCsvText, rowsToObjects } from "./csv.mjs";

function normalize(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

export function selectV4Candidates(rows, categories = ["图片集", "图文"], options = {}) {
  const categorySet = new Set(categories);
  const ranks = new Map(categories.map((category) => [category, 0]));
  const candidates = [];
  const excluded = [];
  const seen = new Set();
  for (const row of rows) {
    const category = normalize(row.CATE_NAME);
    if (!categorySet.has(category)) continue;
    const blockId = normalize(row.a_APP_ID);
    const name = normalize(row.a_APP_NAME);
    const description = normalize(row.a_APP_DESC);
    if (!/^\d+$/u.test(blockId)) {
      excluded.push({ csv_row: row.csv_row, block_id: blockId, category, name, reason: "区块ID不是纯数字" });
      continue;
    }
    if (!options.includeCustomized && /定制/u.test(`${name} ${description}`)) {
      excluded.push({ csv_row: row.csv_row, block_id: blockId, category, name, reason: "名称或描述包含“定制”" });
      continue;
    }
    if (seen.has(blockId)) {
      excluded.push({ csv_row: row.csv_row, block_id: blockId, category, name, reason: "区块ID重复" });
      continue;
    }
    seen.add(blockId);
    const rank = (ranks.get(category) ?? 0) + 1;
    ranks.set(category, rank);
    candidates.push({
      csv_row: row.csv_row,
      block_id: blockId,
      app_name: name,
      description,
      category,
      candidate_rank: rank,
    });
  }
  return { candidates, excluded };
}

export async function readV4BlockCsv(csvPath, categories = ["图片集", "图文"], options = {}) {
  const bytes = await readFile(csvPath);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const decoded = new TextDecoder("gb18030").decode(bytes);
  const rows = rowsToObjects(parseCsvText(decoded));
  const { candidates, excluded } = selectV4Candidates(rows, categories, options);
  return {
    checksum,
    csvPath,
    sourceRowCount: rows.length,
    categories,
    candidates,
    excluded,
  };
}
