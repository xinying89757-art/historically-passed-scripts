import { existsSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateBlock,
  mapControlsToTargets,
  readReadonlyWorkbook,
  splitExpectedTexts,
} from "../src/growth-engine-h-v3-readonly-recheck.mjs";

test("3.0只读回归正确拆分历史多H文字", () => {
  assert.deepEqual(splitExpectedTexts("甲；乙；甲"), ["甲", "乙", "甲"]);
});

test("相同历史文字数量一致时按出现顺序安全映射", () => {
  const page = {
    page_path: "/p",
    page_url: "http://example.test/p",
    editor_page_name: "测试页",
    blocks: [
      { page_path: "/p", page_url: "http://example.test/p", editor_page_name: "测试页", block_id: "1", block_name: "甲", historical_readonly_fields: "级别、文字", expected_texts: ["同文", "同文"] },
    ],
  };
  const controls = [
    { index: 0, level: "H2", text: "同文", levelEditable: false, textEditable: false },
    { index: 1, level: "H3", text: "同文", levelEditable: true, textEditable: true },
  ];
  const mapped = mapControlsToTargets(page, controls, "run");
  assert.equal(mapped.items.length, 2);
  assert.equal(mapped.items[0].current_status, "still_readonly");
  assert.equal(mapped.items[1].current_status, "now_editable");
  assert.equal(mapped.unmatched.length, 0);
  assert.equal(aggregateBlock(page.blocks[0], mapped.items).status, "partially_readonly");
});

test("相同文字出现额外副本时拒绝随机归属", () => {
  const page = {
    page_path: "/p",
    page_url: "http://example.test/p",
    editor_page_name: "测试页",
    blocks: [
      { page_path: "/p", page_url: "http://example.test/p", editor_page_name: "测试页", block_id: "1", block_name: "甲", historical_readonly_fields: "级别、文字", expected_texts: ["同文"] },
    ],
  };
  const mapped = mapControlsToTargets(page, [
    { index: 0, level: "H2", text: "同文", levelEditable: true, textEditable: true },
    { index: 1, level: "H2", text: "同文", levelEditable: true, textEditable: true },
  ], "run");
  assert.equal(mapped.items[0].mapping_status, "mapping_ambiguous");
  assert.equal(aggregateBlock(page.blocks[0], mapped.items).status, "mapping_ambiguous");
});

test("历史问题工作簿读取20个区块和17个页面", async (t) => {
  const workbookPath = process.env.READONLY_WORKBOOK || "input/readonly-issues.xlsx";
  if (!existsSync(workbookPath)) {
    t.skip(`未提供只读问题工作簿：${workbookPath}`);
    return;
  }
  const inventory = await readReadonlyWorkbook(
    workbookPath,
  );
  assert.equal(inventory.records.length, 20);
  assert.equal(inventory.pages.length, 17);
});
