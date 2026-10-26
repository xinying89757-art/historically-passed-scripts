import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { readRankingWorkbook } from "../src/ranking-input.mjs";

test("清单排除产品详情和图片集类型4，并按模板代表项排序", async () => {
  const config = await loadConfig("config/run.json");
  const input = await readRankingWorkbook(config.rankingWorkbook, config.rankingSheetName);
  assert.equal(input.includedRows, 73);
  assert.equal(input.blocks.length, 65);
  assert.equal(input.excluded.length, 20);
  assert.deepEqual(input.blocks.slice(0, 8).map((record) => record.block_id), [
    "26074", "27562", "22774", "531", "9484", "16974", "23404", "18444"
  ]);
  assert.deepEqual(input.blocks.find((record) => record.block_id === "25584").template_types, ["文本编辑", "图片集类型3"]);
});
