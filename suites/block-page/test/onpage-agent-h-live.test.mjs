import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEditableTarget,
  makeLiveText,
  mapCapturedItemsToLive,
  stripLiveSuffix,
  verifyLiveItem,
  verifyUntouchedHeadings,
} from "../src/onpage-agent-h-live-core.mjs";

test("真实页面测试文字保留原文且清理旧批次后缀", () => {
  assert.equal(stripLiveSuffix("正文标题｜新接口真实页验证批次20260903120000第01项"), "正文标题");
  assert.equal(makeLiveText({ sourceText: "正文标题｜新接口验证批次20260901120000第01项", runId: "20260903120000", itemIndex: 2 }), "正文标题｜新接口真实页验证批次20260903120000第02项");
});

test("只提交validate允许编辑的字段", () => {
  const item = { origin: { tagName: "h2", text: "正文标题" } };
  assert.deepEqual(buildEditableTarget(item, { editable: true, fieldCapabilities: { type: true, text: false } }, "1", 1), {
    target: { tagName: "h3" }, levelEditable: true, textEditable: false, expectedLevel: "H3", expectedText: "正文标题",
  });
  assert.deepEqual(buildEditableTarget(item, { editable: true, fieldCapabilities: { type: false, text: true } }, "1", 1), {
    target: { text: "正文标题｜新接口真实页验证批次1第01项" }, levelEditable: false, textEditable: true, expectedLevel: "H2", expectedText: "正文标题｜新接口真实页验证批次1第01项",
  });
});

test("优先按容器ID将旧预检项映射到真实页面", () => {
  const mapped = mapCapturedItemsToLive([
    { itemKey: "a", settingId: "s1", origin: { tagName: "h2", text: "旧文字" } },
  ], [
    { index: 0, level: "H3", text: "当前文字", containerIds: ["s1"], business: true },
  ]);
  assert.equal(mapped[0].mappingStatus, "mapped");
  assert.equal(mapped[0].mappingSource, "live_container_id");
  assert.deepEqual(mapped[0].captured.origin, { tagName: "h3", text: "当前文字" });
});

test("重复文字无法唯一归属时拒绝映射", () => {
  const mapped = mapCapturedItemsToLive([
    { itemKey: "a", origin: { tagName: "h2", text: "重复" } },
  ], [
    { index: 0, level: "H2", text: "重复", containerIds: [], business: true },
    { index: 1, level: "H2", text: "重复", containerIds: [], business: true },
  ]);
  assert.equal(mapped[0].mappingStatus, "mapping_ambiguous");
});

test("真实页文字缺失、重复和级别错误分别分类", () => {
  const item = { expected_text: "新文字", expected_level: "H3" };
  assert.equal(verifyLiveItem(item, []).status, "live_missing");
  assert.equal(verifyLiveItem(item, [{ text: "新文字", level: "H3" }, { text: "新文字", level: "H3" }]).status, "live_duplicate");
  assert.equal(verifyLiveItem(item, [{ text: "新文字", level: "H2" }]).status, "live_level_mismatch");
  assert.equal(verifyLiveItem(item, [{ text: "新文字", level: "H3" }]).status, "verified");
});

test("未提交的公共H和业务H都必须保持不变", () => {
  const baseline = [
    { level: "H2", text: "会修改" },
    { level: "H3", text: "公共标题" },
  ];
  assert.equal(verifyUntouchedHeadings(baseline, new Set([0]), [{ level: "H4", text: "新文字" }, { level: "H3", text: "公共标题" }]).status, "verified");
  assert.equal(verifyUntouchedHeadings(baseline, new Set([0]), [{ level: "H4", text: "新文字" }]).status, "live_text_mismatch");
});

