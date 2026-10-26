import test from "node:test";
import assert from "node:assert/strict";
import { loadGrowthEngineConfig } from "../src/growth-engine-h-config.mjs";
import { aggregateBlocks, loadInventory, mapPageControls } from "../src/growth-engine-h-v4-editability-audit.mjs";

test("4.0全量审计输入覆盖24页215个实际添加区块", async () => {
  const config = await loadGrowthEngineConfig("config/growth-engine-h-v4.json");
  const inventory = await loadInventory(config);
  assert.equal(inventory.pages.length, 24);
  assert.equal(inventory.blocks.length, 215);
  assert.equal(inventory.blocks.filter((block) => block.rich_texts.length > 0).length, 192);
  assert.equal(inventory.blocks.filter((block) => block.rich_texts.length === 0).length, 23);
});

test("同一富文本的可编辑项和只读副本全部归属同一区块", () => {
  const page = {
    page_name: "页面", page_path: "/p", blocks: [{
      page_name: "页面", page_path: "/p", page_url: "http://example/p", category: "图片集",
      slot_index: 1, block_id: "100", app_name: "测试区块", editor_dom_id: "node-100",
      rich_texts: [{ editor_index: 1, field_name: "标题", expected_text: "唯一标题", expected_level: "H2" }],
    }],
  };
  const mapped = mapPageControls(page, [
    { index: 0, level: "H2", text: "唯一标题", levelEditable: true, textEditable: true, attrs: {} },
    { index: 1, level: "H2", text: "唯一标题", levelEditable: false, textEditable: false, attrs: {} },
  ]);
  assert.equal(mapped.items.length, 2);
  assert.equal(mapped.unmatched.length, 0);
  assert.equal(mapped.items[0].logical_key, mapped.items[1].logical_key);
  assert.equal(mapped.items[1].copy_index, 2);
  const rows = aggregateBlocks(page, mapped.items, mapped.unmatched, "checked", "");
  assert.equal(rows[0].status, "partially_readonly");
  assert.equal(rows[0].readonly_h_count, 1);
});

test("无富文本区块不因页面存在未归属H项而随机判定只读", () => {
  const page = { page_name: "页面", page_path: "/p", blocks: [{
    page_name: "页面", page_path: "/p", page_url: "http://example/p", category: "图片集",
    slot_index: 1, block_id: "200", app_name: "无富文本区块", editor_dom_id: "node-200", rich_texts: [],
  }] };
  const rows = aggregateBlocks(page, [], [{ entry: { index: 0 }, candidates: [] }], "checked", "");
  assert.equal(rows[0].status, "unresolved_no_source");
});
