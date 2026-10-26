import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";
import { readV4BlockCsv, selectV4Candidates } from "../src/v4-input.mjs";

test("GB18030真实CSV按分类筛选并保持原顺序", async () => {
  const config = await loadConfig("config/v4-blocks.json");
  const input = await readV4BlockCsv(config.v4Csv, config.v4Categories, {
    includeCustomized: config.v4IncludeCustomized === true,
  });
  assert.equal(input.sourceRowCount, 307);
  assert.equal(input.candidates.filter((item) => item.category === "图片集").length, 157);
  assert.equal(input.candidates.filter((item) => item.category === "图文").length, 58);
  assert.equal(input.excluded.filter((item) => item.reason.includes("定制")).length, 0);
  assert.deepEqual(
    input.candidates.filter((item) => item.category === "图片集").slice(0, 20).map((item) => item.block_id),
    ["45364", "38664", "37654", "33524", "34314", "32584", "33424", "39934", "34544", "39944", "39314", "33294", "39924", "39634", "30514", "37274", "32514", "39114", "33214", "33454"],
  );
  assert.deepEqual(
    input.candidates.filter((item) => item.category === "图文").slice(0, 20).map((item) => item.block_id),
    ["32784", "32194", "39444", "32154", "37354", "33664", "33604", "32504", "33274", "37304", "32614", "32984", "30404", "32474", "30804", "32524", "32034", "32204", "32744", "33554"],
  );
});

test("带星号保留、定制排除、重复ID排除", () => {
  const { candidates, excluded } = selectV4Candidates([
    { csv_row: 2, a_APP_ID: "1", a_APP_NAME: "*普通区块", a_APP_DESC: "", CATE_NAME: "图片集" },
    { csv_row: 3, a_APP_ID: "2", a_APP_NAME: "定制区块", a_APP_DESC: "", CATE_NAME: "图片集" },
    { csv_row: 4, a_APP_ID: "1", a_APP_NAME: "重复区块", a_APP_DESC: "", CATE_NAME: "图文" },
  ]);
  assert.deepEqual(candidates.map((item) => item.block_id), ["1"]);
  assert.deepEqual(excluded.map((item) => item.reason), ["名称或描述包含“定制”", "区块ID重复"]);
});

test("全量配置可包含定制区块", () => {
  const { candidates, excluded } = selectV4Candidates([
    { csv_row: 2, a_APP_ID: "1", a_APP_NAME: "定制图片集", a_APP_DESC: "", CATE_NAME: "图片集" },
  ], ["图片集", "图文"], { includeCustomized: true });
  assert.deepEqual(candidates.map((item) => item.block_id), ["1"]);
  assert.equal(excluded.length, 0);
});
