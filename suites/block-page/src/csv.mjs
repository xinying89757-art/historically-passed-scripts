import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Small RFC 4180-compatible parser. It supports BOM, escaped quotes, commas and
 * line breaks inside quoted cells, which is sufficient for the source workbook.
 */
export function parseCsvText(input) {
  const text = input.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (quoted) {
    throw new Error("CSV 格式错误：存在未闭合的引号");
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }

  return rows.filter((values) => values.some((value) => value !== ""));
}

export function rowsToObjects(rows) {
  if (rows.length === 0) {
    return [];
  }
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values, index) => {
    const record = { csv_row: index + 2 };
    for (let column = 0; column < headers.length; column += 1) {
      record[headers[column]] = values[column] ?? "";
    }
    return record;
  });
}

export async function readBlockCsv(path) {
  const buffer = await readFile(path);
  const checksum = createHash("sha256").update(buffer).digest("hex");
  const objects = rowsToObjects(parseCsvText(buffer.toString("utf8")));
  const missingHeaders = ["block_id", "APP_NAME"].filter(
    (header) => objects.length === 0 || !(header in objects[0]),
  );
  if (missingHeaders.length > 0) {
    throw new Error(`CSV 缺少字段：${missingHeaders.join(", ")}`);
  }

  const seen = new Map();
  const duplicates = [];
  const blocks = [];
  for (const object of objects) {
    const blockId = String(object.block_id ?? "").trim();
    if (!blockId) {
      throw new Error(`CSV 第 ${object.csv_row} 行 block_id 为空`);
    }
    if (seen.has(blockId)) {
      duplicates.push({
        block_id: blockId,
        first_csv_row: seen.get(blockId),
        duplicate_csv_row: object.csv_row,
      });
      continue;
    }
    seen.set(blockId, object.csv_row);
    blocks.push({
      csv_row: object.csv_row,
      block_id: blockId,
      app_name: String(object.APP_NAME ?? "").trim(),
    });
  }

  return {
    checksum,
    sourceRowCount: objects.length,
    blocks,
    duplicates,
  };
}

