import test from "node:test";
import assert from "node:assert/strict";
import { createV4RichTextState, expectedPreparedHeading, normalizeRichText, preparedHeadingText, readableBlockName } from "../src/v4-rich-text-setup.mjs";

test("4.0富文本测试文字去掉模板标记并保持可追溯", () => {
  const record = { block_id: "33524", app_name: "*[区块] 一行三列中间突出显示的图片集区块" };
  assert.equal(readableBlockName(record.app_name), "一行三列中间突出显示的图片集区块");
  assert.equal(preparedHeadingText(record, 1), "新版区块标题测试-33524-一行三列中间突出显示的图片集区块-第02处");
});

test("4.0富文本空白规范化", () => {
  assert.equal(normalizeRichText("  中文\u00a0 标题\n测试  "), "中文 标题 测试");
});

test("镜像任务优先使用源环境的精确文字、级别和字段名", () => {
  const record = {
    block_id: "33524",
    app_name: "区块",
    expected_editors: [{ field_name: "标题", expected_text: "源环境中文标题", expected_level: "H2" }],
  };
  assert.deepEqual(expectedPreparedHeading(record, 0), {
    text: "源环境中文标题",
    level: "H2",
    fieldName: "标题",
  });
});

test("4.0富文本状态初始化覆盖全部区块", () => {
  const state = createV4RichTextState([{ block_id: "1", app_name: "区块", slot_index: 1, editor_dom_id: "node" }]);
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].status, "pending");
  assert.equal(state.growth_engine_status, "deferred_by_user");
});
