import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  parseCsvText,
  readBlockCsv,
  rowsToObjects,
} from "../src/csv.mjs";

test("parseCsvText 支持 BOM、逗号、换行和双引号转义", () => {
  const source =
    '\uFEFFblock_id,APP_NAME\r\n40748,"图文, 默认"\r\n40749,"两行\r\n名称"\r\n40750,"含""引号"""\r\n';
  const rows = parseCsvText(source);
  assert.deepEqual(rows[0], ["block_id", "APP_NAME"]);
  assert.deepEqual(rows[1], ["40748", "图文, 默认"]);
  assert.deepEqual(rows[2], ["40749", "两行\r\n名称"]);
  assert.deepEqual(rows[3], ["40750", '含"引号"']);
  assert.equal(rowsToObjects(rows)[0].csv_row, 2);
});

test("readBlockCsv 保留 CSV 行号并报告重复 block_id", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "leadong-csv-"));
  const csvPath = path.join(directory, "blocks.csv");
  await writeFile(
    csvPath,
    "block_id,APP_NAME\n1,普通图文\n2,产品详情\n1,重复\n",
    "utf8",
  );
  const result = await readBlockCsv(csvPath);
  assert.equal(result.sourceRowCount, 3);
  assert.equal(result.blocks.length, 2);
  assert.deepEqual(result.blocks[1], {
    csv_row: 3,
    block_id: "2",
    app_name: "产品详情",
  });
  assert.deepEqual(result.duplicates, [
    {
      block_id: "1",
      first_csv_row: 2,
      duplicate_csv_row: 4,
    },
  ]);
});

