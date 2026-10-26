import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDetailsLoadRequests,
  buildDetailsUpdatePayload,
  detailTypeForPageType,
  extractHeadingTokens,
  isDetailsUpdateSuccess,
  makeDetailText,
  mapDetailHeadingsToLive,
  unwrapDetailContent,
  wrapDetailContent,
} from "../src/onpage-agent-h-live-details-core.mjs";

test("三类页面映射到统一详情type", () => {
  assert.equal(detailTypeForPageType("产品"), "PRODUCT");
  assert.equal(detailTypeForPageType("文章"), "ARTICLE");
  assert.equal(detailTypeForPageType("产品分类描述"), "PRODUCT_GROUP");
  assert.equal(detailTypeForPageType("视频详情"), "VIDEO");
  assert.equal(buildDetailsLoadRequests({ pageType: "产品" }).length, 5);
});

test("新编辑器JSON包装详情可无损拆包和回包", () => {
  const source = JSON.stringify({ type: "7", json: "<h2>标题</h2>", extra: 1 });
  const unwrapped = unwrapDetailContent(source);
  assert.equal(unwrapped.html, "<h2>标题</h2>");
  assert.deepEqual(JSON.parse(wrapDetailContent("<h3>新标题</h3>", unwrapped.wrapper)), { type: "7", json: "<h3>新标题</h3>", extra: 1 });
});

test("详情测试文字替换旧批次后缀", () => {
  assert.equal(makeDetailText({ sourceText: "标题｜新接口详情验证批次1第01项", runId: "2", itemIndex: 3 }), "标题｜新接口详情验证批次2第03项");
});

test("详情更新请求严格携带CAS版本和哈希", () => {
  assert.deepEqual(buildDetailsUpdatePayload({
    siteSettingId: 9,
    pageUrl: "http://example.test/a",
    type: "PRODUCT",
    loadRequest: { index: 0 },
    data: { index: 0, productId: 8, version: 7, contentHash: "hash" },
    content: "<h3>新</h3>",
  }), {
    siteSettingId: 9,
    pageUrl: "http://example.test/a",
    type: "PRODUCT",
    index: 0,
    productId: 8,
    content: "<h3>新</h3>",
    expectedVersion: 7,
    expectedContentHash: "hash",
  });
});

test("详情H按文字和级别唯一映射到真实页面", () => {
  const mapped = mapDetailHeadingsToLive(
    [{ level: "H2", text: "甲" }, { level: "H3", text: "乙" }],
    [{ level: "H1", text: "公共" }, { level: "H2", text: "甲" }, { level: "H3", text: "乙" }],
  );
  assert.deepEqual(mapped.map((row) => row.liveIndex), [1, 2]);
  assert.ok(mapped.every((row) => row.mappingStatus === "mapped"));
});

test("重复详情H无法唯一归属", () => {
  const mapped = mapDetailHeadingsToLive([{ level: "H2", text: "重复" }], [
    { level: "H2", text: "重复" }, { level: "H2", text: "重复" },
  ]);
  assert.equal(mapped[0].mappingStatus, "mapping_ambiguous");
});

test("读取H和更新成功响应形状", () => {
  assert.deepEqual(extractHeadingTokens("<h2 class='a'>标题</h2><p>x</p><h3>说明</h3>"), [
    { level: "H2", text: "标题" }, { level: "H3", text: "说明" },
  ]);
  assert.equal(isDetailsUpdateSuccess(200, { code: 200, data: { status: "UPDATED" } }), true);
  assert.equal(isDetailsUpdateSuccess(200, { code: 200, data: { status: "UPDATED_WITH_PENDING_SIDE_EFFECTS" } }), true);
  assert.equal(isDetailsUpdateSuccess(200, { code: 200, data: {} }), false);
  assert.equal(isDetailsUpdateSuccess(500, { code: 200, data: { status: "UPDATED" } }), false);
});
