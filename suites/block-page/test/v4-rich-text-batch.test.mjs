import test from "node:test";
import assert from "node:assert/strict";
import { createV4RichTextBatchState, selectRemainingV4RichTextPages, summarizeV4RichTextBatch } from "../src/v4-rich-text-batch.mjs";

const source = {
  pages: [
    { name: "新版图片集区块测试-001", path: "/one", category: "图片集", block_ids: ["1"] },
    { name: "新版图片集区块测试-002", path: "/two", category: "图片集", block_ids: ["2"] },
  ],
  records: [
    { block_id: "1", app_name: "完成区块", page_name: "新版图片集区块测试-001", slot_index: 1, editor_dom_id: "n1", status: "added" },
    { block_id: "2", app_name: "待处理区块", page_name: "新版图片集区块测试-002", slot_index: 1, editor_dom_id: "n2", status: "added" },
  ],
};

test("批量任务排除已完成的第一页", () => {
  const pages = selectRemainingV4RichTextPages(source);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].records[0].block_id, "2");
});

test("批量汇总区分验证与不支持", () => {
  const state = createV4RichTextBatchState(source);
  state.pages[0].records[0].status = "verified";
  state.pages[0].records[0].rich_text_count = 2;
  state.pages[0].records[0].verified_count = 2;
  state.pages[0].status = "complete";
  assert.deepEqual(summarizeV4RichTextBatch(state), {
    pages: 1,
    completePages: 1,
    pendingPages: 0,
    blocks: 1,
    verifiedBlocks: 1,
    unsupportedBlocks: 0,
    richTexts: 2,
    verifiedRichTexts: 2,
    statuses: { verified: 1 },
  });
});

