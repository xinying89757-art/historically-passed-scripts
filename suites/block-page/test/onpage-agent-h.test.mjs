import test from "node:test";
import assert from "node:assert/strict";
import {
  buildScenarioTarget,
  classifyApiItem,
  makeAgentText,
  stripAgentSuffix,
  verifyPreviewItem,
  verifyUnsubmittedHeadings,
  reconcileCurrentOrigins,
} from "../src/onpage-agent-h-core.mjs";
import { mergeSupplementalRunStates } from "../src/onpage-agent-h-report.mjs";

const source = { itemKey: "heading-0", settingId: "abc", origin: { tagName: "h2", text: "组件标题测试-001-快速导航" } };

test("新接口测试文字保留组件名称且不会叠加旧批次后缀", () => {
  assert.equal(stripAgentSuffix("组件标题｜同步验证批次20260819120000第01项"), "组件标题");
  assert.equal(stripAgentSuffix("组件标题｜新接口验证批次20260901120000第01项"), "组件标题");
  assert.equal(makeAgentText({ sourceText: "组件标题｜同步验证批次20260819120000第01项", runId: "20260901120000", itemIndex: 1 }), "组件标题｜新接口验证批次20260901120000第01项");
});

test("新接口测试文字会清理既有接口同步测试后缀", () => {
  assert.equal(
    stripAgentSuffix("组件标题测试-001-快速导航｜接口同步测试批次20260901第01项"),
    "组件标题测试-001-快速导航",
  );
});

test("四类字段组合只提交目标字段", () => {
  assert.deepEqual(buildScenarioTarget(source, "text_only", "1", 1).target, { text: "组件标题测试-001-快速导航｜新接口验证批次1第01项" });
  assert.deepEqual(buildScenarioTarget(source, "level_only", "1", 1).target, { tagName: "h3" });
  assert.deepEqual(buildScenarioTarget(source, "empty_text", "1", 1).target, { tagName: "h2", text: "" });
  assert.deepEqual(buildScenarioTarget(source, "both", "1", 1).target, { tagName: "h3", text: "组件标题测试-001-快速导航｜新接口验证批次1第01项" });
});

test("只在请求所需字段可编辑时判定可更新", () => {
  const validateItem = { editable: true, fieldCapabilities: { type: false, text: true } };
  assert.equal(classifyApiItem({ validateItem, updateItem: { status: "UPDATED" }, scenario: "text_only" }).status, "updated");
  assert.equal(classifyApiItem({ validateItem, updateItem: { status: "UPDATED" }, scenario: "level_only" }).status, "field_not_editable");
});

test("接口返回UPDATED但预览级别不一致时判定预览失败", () => {
  const result = verifyPreviewItem({ ...source, expected_text: "新文字", expected_level: "H3" }, [{ level: "H2", text: "新文字", containerIds: ["abc"] }]);
  assert.equal(result.status, "preview_level_mismatch");
});

test("空文字通过容器ID匹配", () => {
  const result = verifyPreviewItem({ ...source, expected_text: "", expected_level: "H2" }, [{ level: "H2", text: "", containerIds: ["abc"] }]);
  assert.equal(result.status, "verified");
});

test("未提交标题必须保持原级别和原文字", () => {
  const result = verifyUnsubmittedHeadings([
    source,
    { itemKey: "heading-1", origin: { tagName: "h4", text: "未提交" } },
  ], new Set(["heading-0"]), [{ level: "H4", text: "未提交" }]);
  assert.equal(result.status, "verified");
  assert.equal(verifyUnsubmittedHeadings([
    { itemKey: "heading-1", origin: { tagName: "h4", text: "未提交" } },
  ], new Set(), []).status, "preview_mismatch");
});

test("增长引擎旧快照使用预览DOM当前值替换origin", () => {
  const result = reconcileCurrentOrigins([
    { itemKey: "heading-0", settingId: "abc", origin: { tagName: "h2", text: "旧文字" } },
  ], [
    { level: "H3", text: "当前文字", containerIds: ["abc"] },
  ]);
  assert.equal(result[0].origin.tagName, "h3");
  assert.equal(result[0].origin.text, "当前文字");
  assert.equal("_origin_source" in result[0], false);
});

test("报告用隔离复测结果替换同页面同场景的旧结果", () => {
  const result = mergeSupplementalRunStates({
    run_id: "main",
    phase: "complete_with_failures",
    pages: [{
      page_path: "/003.html", status: "failed", unsubmitted_status: "verified", items: [
        { item_key: "heading-0", scenario: "empty_text", item_index: 1, status: "update_failed", failure_reason: "旧结果", editor_backfill_status: "not_applicable" },
      ], api_calls: [],
    }],
  }, [{
    run_id: "retest",
    pages: [{ page_path: "/003.html", preview_heading_count: 10, checked_at: "later", items: [
      { item_key: "heading-0", scenario: "empty_text", item_index: 1, status: "preview_text_mismatch", failure_reason: "新结果", editor_backfill_status: "settings_unavailable" },
    ], api_calls: [{ stage: "headings-update" }] }],
  }]);
  assert.equal(result.pages[0].items[0].failure_reason, "新结果");
  assert.equal(result.pages[0].api_calls[0].run_id, "retest");
  assert.equal(result.pages[0].preview_heading_count, 10);
});
