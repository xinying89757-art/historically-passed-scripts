import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStructuredPayload,
  classifyInvalidStructuredSave,
  classifyStructuredSave,
  classifyTdkSave,
  parseStructuredData,
} from "../src/onpage-agent-seo-v3.mjs";

test("结构化数据支持script包装并追加唯一测试节点", () => {
  const result = buildStructuredPayload(
    '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"原数据"}</script>',
    "20260902120000",
  );
  assert.equal(Boolean(parseStructuredData(result.value)), true);
  assert.equal(result.value.includes("原数据"), true);
  assert.equal((result.value.match(/接口结构化数据测试-页面001-批次20260902120000/gu) ?? []).length, 1);
});

test("TDK字段结果逐字段判定", () => {
  const response = { http: 200, body: { code: 200, data: { fieldResults: [{ field: "seoTitle", result: "success" }] } } };
  assert.equal(classifyTdkSave(response, ["seoTitle"]).status, "tdk_field_updated");
  assert.equal(classifyTdkSave(response, ["seoTitle", "seoDesc"]).status, "tdk_field_failed");
});

test("结构化数据响应必须包含合法写入后内容和唯一标记", () => {
  const marker = "接口结构化数据测试-页面001-批次x";
  const response = { http: 200, body: { code: 200, data: { structureData: JSON.stringify({ "@context": "https://schema.org", "@type": "Thing", name: marker }) } } };
  assert.equal(classifyStructuredSave(response, marker).status, "structured_data_updated");
  assert.equal(classifyStructuredSave({ http: 200, body: { code: 200, data: { structureData: "{}" } } }, marker).status, "response_mismatch");
});

test("非法JSON必须被拒绝", () => {
  assert.equal(classifyInvalidStructuredSave({ http: 400, body: { code: 400 } }).status, "invalid_payload_rejected");
  assert.equal(classifyInvalidStructuredSave({ http: 200, body: { code: 200 } }).status, "invalid_payload_accepted");
});
