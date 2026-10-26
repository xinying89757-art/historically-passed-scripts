import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyItemVerification,
  compareHeadingLists,
  compareHeadingSubset,
  makeExpectedText,
  nextHeadingLevel,
  normalizeText,
  resolveSourceText,
  resolveHeadingGroupCount,
  stripSyncSuffix,
} from "../src/growth-engine-h-core.mjs";
import { createGrowthEngineState } from "../src/growth-engine-h-state.mjs";
import {
  classifyEditorBackfill,
  buildSyncedComponentRecord,
  blockRecordSourceTexts,
  componentRecordSourceTexts,
  findGrowthEnginePlatformPage,
  summarizeEditorBackfill,
} from "../src/growth-engine-h-editor-backfill.mjs";

test("H 标签级别按 H1 到 H6 循环", () => {
  assert.equal(nextHeadingLevel("H1"), "H2");
  assert.equal(nextHeadingLevel("h5"), "H6");
  assert.equal(nextHeadingLevel("H6"), "H1");
});

test("编辑标签弹窗按实际配对控件数处理，不写死六组", () => {
  for (const count of [1, 3, 6, 10]) {
    assert.equal(resolveHeadingGroupCount(count, count), count);
  }
  assert.throws(
    () => resolveHeadingGroupCount(3, 2),
    /locator_ambiguous/u,
  );
});

test("测试文字保留组件或区块来源文字并追加唯一批次", () => {
  const text = makeExpectedText({
    sourceText: "组件标题测试-002-图片集",
    pagePath: "/001.html",
    itemIndex: 2,
    runId: "20260819123456",
  });
  assert.equal(text, "组件标题测试-002-图片集｜同步验证批次20260819123456第02项");
  assert.equal(/[A-Za-z]/u.test(text), false);
});

test("再次执行时从上一批次恢复原组件或区块文字且不叠加后缀", () => {
  assert.equal(resolveSourceText({
    currentText: "增长引擎同步测试-页面001-第02项-批次20260819113732",
    previousItem: {
      original_text: "组件标题测试-002-图片集",
      expected_text: "增长引擎同步测试-页面001-第02项-批次20260819113732",
    },
  }), "组件标题测试-002-图片集");
  assert.equal(resolveSourceText({
    currentText: "组件标题测试-002-图片集｜同步验证批次20260819123456第02项",
  }), "组件标题测试-002-图片集");
  assert.equal(stripSyncSuffix(
    "组件标题测试-002-图片集｜新接口验证批次20260901123456第02项",
  ), "组件标题测试-002-图片集");
});

test("空白规范化合并换行和连续空格", () => {
  assert.equal(normalizeText("  中文\n  标题  "), "中文 标题");
});

test("真实网页文字重复会判定失败", () => {
  const item = {
    level_editable: true, text_editable: true,
    original_level: "H2", original_text: "旧值",
    expected_level: "H3", expected_text: "新值",
  };
  const result = classifyItemVerification(item, [
    { level: "H3", text: "新值" }, { level: "H3", text: "新值" },
  ]);
  assert.equal(result.status, "live_text_mismatch");
});

test("部分可编辑项目单独分类", () => {
  const item = {
    level_editable: false, text_editable: true,
    original_level: "H2", original_text: "旧值",
    expected_level: "H2", expected_text: "新值",
  };
  const result = classifyItemVerification(item, [{ level: "H2", text: "新值" }]);
  assert.equal(result.status, "partially_editable_verified");
});

test("完整列表按数量顺序级别和文字对账", () => {
  assert.equal(compareHeadingLists(
    [{ level: "H2", text: "一" }],
    [{ level: "H3", text: "一" }],
  ).matches, false);
  assert.equal(compareHeadingLists(
    [{ level: "H2", text: "一" }],
    [{ level: "H2", text: "一" }],
  ).matches, true);
});

test("公开网页允许轮播副本，但不能缺少增长引擎列出的设置项", () => {
  assert.equal(compareHeadingSubset(
    [{ level: "H2", text: "标题" }, { level: "H3", text: "产品" }],
    [{ level: "H2", text: "标题" }, { level: "H3", text: "产品" }, { level: "H3", text: "产品" }],
  ).matches, true);
  assert.equal(compareHeadingSubset(
    [{ level: "H2", text: "标题" }, { level: "H3", text: "产品" }],
    [{ level: "H2", text: "标题" }],
  ).matches, false);
});

test("状态为每个界面项生成独立预期值", () => {
  const state = createGrowthEngineState(
    { targetPagePath: "/001.html", publicUrl: "http://example.test/001.html" },
    [
      { level: "H4", text: "一", levelEditable: true, textEditable: true },
      { level: "H2", text: "二", levelEditable: false, textEditable: true },
    ],
    [{ level: "H4", text: "一" }, { level: "H2", text: "二" }],
    "20260819123456",
  );
  assert.equal(state.items[0].expected_level, "H5");
  assert.equal(state.items[1].expected_level, "H2");
  assert.equal(state.items[0].source_text, "一");
  assert.notEqual(state.items[0].expected_text, state.items[1].expected_text);
});

test("新批次可从已完成状态恢复首次修改前的组件名称", () => {
  const state = createGrowthEngineState(
    { targetPagePath: "/001.html", publicUrl: "http://example.test/001.html" },
    [{
      level: "H3",
      text: "增长引擎同步测试-页面001-第01项-批次20260819113732",
      levelEditable: true,
      textEditable: true,
    }],
    [{ level: "H3", text: "增长引擎同步测试-页面001-第01项-批次20260819113732" }],
    "20260819123456",
    {
      page_path: "/001.html",
      items: [{
        original_text: "组件标题测试-001-快速导航",
        expected_text: "增长引擎同步测试-页面001-第01项-批次20260819113732",
      }],
    },
  );
  assert.equal(state.items[0].source_text, "组件标题测试-001-快速导航");
  assert.equal(
    state.items[0].expected_text,
    "组件标题测试-001-快速导航｜同步验证批次20260819123456第01项",
  );
});

test("编辑器回填必须同时匹配标题级别和文字", () => {
  assert.equal(classifyEditorBackfill({
    expectedLevel: "H3",
    expectedText: "图片集｜同步验证批次1第01项",
    actualLevel: "H3",
    actualText: "图片集｜同步验证批次1第01项",
  }).status, "verified");
  const mismatch = classifyEditorBackfill({
    expectedLevel: "H3",
    expectedText: "图片集",
    actualLevel: "H2",
    actualText: "图片集旧值",
  });
  assert.equal(mismatch.status, "mismatch");
  assert.equal(mismatch.differences.length, 2);
});

test("编辑器单项失败不阻断汇总但整页判定失败", () => {
  const summary = summarizeEditorBackfill([
    { item_index: 1, editor_backfill_status: "verified" },
    { item_index: 2, editor_backfill_status: "mismatch", editor_backfill_failure_reason: "文字不一致" },
    { item_index: 3, editor_backfill_status: "verified" },
  ], "组件标题测试-001");
  assert.equal(summary.status, "failed");
  assert.equal(summary.verified, 2);
  assert.equal(summary.failed, 1);
  assert.match(summary.differences[0], /第 2 项/u);
});

test("新状态默认要求执行3.0编辑器回填验证", () => {
  const state = createGrowthEngineState(
    {
      targetPagePath: "/001.html",
      publicUrl: "http://example.test/001.html",
      editorBackfill: { enabled: true, pageName: "组件标题测试-001" },
    },
    [{ level: "H2", text: "图片集", levelEditable: true, textEditable: true }],
    [{ level: "H2", text: "图片集" }],
    "20260819123456",
  );
  assert.equal(state.version, 3);
  assert.equal(state.editor_backfill_verification.status, "pending");
  assert.equal(state.items[0].editor_page_name, "组件标题测试-001");
  assert.equal(state.items[0].editor_backfill_status, "pending");
  assert.equal(state.items[0].level_edit_status, "pending");
  assert.equal(state.items[0].text_edit_status, "pending");
});

test("明确只读字段与待修改字段使用不同状态", () => {
  const state = createGrowthEngineState(
    { targetPagePath: "/003.html", publicUrl: "http://example.test/003.html" },
    [{ level: "H2", text: "产品分类", levelEditable: false, textEditable: true }],
    [{ level: "H2", text: "产品分类" }],
    "20260821120000",
  );
  assert.equal(state.items[0].level_edit_status, "field_not_editable");
  assert.equal(state.items[0].text_edit_status, "pending");
  assert.equal(state.items[0].requested_level, "H2");
  assert.match(state.items[0].requested_text, /^产品分类｜同步验证批次/u);
});

test("优先识别增长引擎平台页作为3.0编辑器入口", () => {
  const platform = { isClosed: () => false, url: () => "https://admin.example.invalid/phoenix2/composite/middle/platform/index.html#/other" };
  const other = { isClosed: () => false, url: () => "https://admin.example.invalid/website.html" };
  assert.equal(findGrowthEnginePlatformPage({ pages: () => [other, platform] }), platform);
  assert.equal(findGrowthEnginePlatformPage({ pages: () => [other] }), undefined);
});

test("同步后缀可用于把增长引擎标题还原为组件清单标题", () => {
  assert.equal(
    stripSyncSuffix("组件标题测试-003-文本｜同步验证批次20260819144057第01项"),
    "组件标题测试-003-文本",
  );
});

test("自定义代码和富文本组件可按原始文字映射同步后的设置项预期值", () => {
  const items = [
    { source_text: "代码二级标题", expected_level: "H3", expected_text: "代码二级标题｜批次" },
    { source_text: "公告正文", expected_level: "H4", expected_text: "公告正文｜批次" },
  ];
  const code = buildSyncedComponentRecord({
    component_kind: "custom_code",
    expected_title: "",
    expected_headings: [{ level: "H2", text: "代码二级标题" }],
  }, items);
  assert.equal(code.expected_code, "<h3>代码二级标题｜批次</h3>");
  assert.deepEqual(componentRecordSourceTexts({
    expected_title: "公告标题",
    expected_editors: [{ text: "公告正文" }],
  }), ["公告标题", "公告正文"]);
  const rich = buildSyncedComponentRecord({
    component_kind: "rich_text_dialog",
    expected_title: "公告标题",
    expected_editors: [{ key: "正文", level: "H2", text: "公告正文" }],
  }, items);
  assert.equal(rich.expected_editors[0].level, "H4");
  assert.equal(rich.expected_editors[0].text, "公告正文｜批次");
});

test("区块回填按heading_poc中的唯一测试文字映射", () => {
  assert.deepEqual(blockRecordSourceTexts({
    heading_poc: [
      { kind: "inline", text: "区块标题测试-26074-文本编辑-第1项" },
      { kind: "modal", text: "区块标题测试-26074-文本编辑-第2项" },
    ],
  }), [
    "区块标题测试-26074-文本编辑-第1项",
    "区块标题测试-26074-文本编辑-第2项",
  ]);
});

test("部分配置区块可从heading_results恢复已成功的测试标题映射", () => {
  assert.deepEqual(blockRecordSourceTexts({
    heading_poc: [],
    heading_results: [{ kind: "inline_existing", text: "区块标题测试-11704-图片编辑-第1项" }],
  }), ["区块标题测试-11704-图片编辑-第1项"]);
});
