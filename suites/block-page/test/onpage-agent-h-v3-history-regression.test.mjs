import test from "node:test";
import assert from "node:assert/strict";
import {
  buildObjectRows,
  parseHistorySubject,
  regressionStatus,
  summarizeBatchValidation,
} from "../src/onpage-agent-h-v3-history-core.mjs";
import { loadHistoryRegressionConfig, validatePlan } from "../src/onpage-agent-h-v3-history-regression.mjs";

test("历史失败项任务严格覆盖16页、58对象和74处H", async () => {
  const plan = await validatePlan();
  assert.equal(plan.pages, 16);
  assert.equal(plan.sites, 2);
  assert.equal(plan.preflight_failed_pages, 7);
  assert.equal(plan.preflight_objects, 33);
  assert.equal(plan.preflight_headings, 40);
  assert.equal(plan.origin_mismatch_pages, 9);
  assert.equal(plan.origin_mismatch_objects, 25);
  assert.equal(plan.origin_mismatch_headings, 34);
  assert.equal(plan.objects, 58);
  assert.equal(plan.components, 7);
  assert.equal(plan.blocks, 51);
  assert.equal(plan.historical_headings, 74);
});

test("六组件复核严格限制为2页6个组件6处H", async () => {
  const configPath = "config/onpage-agent-h-v3-six-components-regression.json";
  const plan = await validatePlan(configPath);
  assert.equal(plan.pages, 2);
  assert.equal(plan.sites, 1);
  assert.equal(plan.objects, 6);
  assert.equal(plan.components, 6);
  assert.equal(plan.blocks, 0);
  assert.equal(plan.historical_headings, 6);
  const { config } = await loadHistoryRegressionConfig(configPath);
  const actual = config.targets.flatMap((target) => target.allowedSources.map((source) => `${target.pagePath}|${source.objectType}|${source.objectId}`)).sort();
  assert.deepEqual(actual, [
    "/001.html|组件|002",
    "/001.html|组件|005",
    "/001.html|组件|006",
    "/001.html|组件|008",
    "/001.html|组件|009",
    "/010.html|组件|016",
  ]);
});

test("组件和区块测试文字能解析到对象级", () => {
  assert.deepEqual(parseHistorySubject({ original_text: "组件标题测试-005-分享｜新接口验证批次1第01项" }), {
    objectType: "组件", objectId: "005", objectName: "分享",
  });
  assert.deepEqual(parseHistorySubject({ original_text: "区块标题测试-16974-测试区块-第02项｜新接口验证批次1第01项" }), {
    objectType: "区块", objectId: "16974", objectName: "测试区块",
  });
});

test("批量预检失败与单项结果被严格区分", () => {
  assert.equal(summarizeBatchValidation({ batchPassed: true, individualPassed: 0, individualFailed: 0 }), "batch_validate_passed");
  assert.equal(summarizeBatchValidation({ batchPassed: false, individualPassed: 4, individualFailed: 0 }), "batch_validate_failed_individual_passed");
  assert.equal(summarizeBatchValidation({ batchPassed: false, individualPassed: 3, individualFailed: 1 }), "batch_validate_failed_individual_partial");
  assert.equal(summarizeBatchValidation({ batchPassed: false, individualPassed: 0, individualFailed: 4 }), "batch_validate_failed_individual_failed");
});

test("原值不匹配恢复、仍失败和更新失败状态分别记录", () => {
  assert.equal(regressionStatus({ status: "modified_verified" }, "origin_mismatch"), "fixed_verified");
  assert.equal(regressionStatus({ status: "origin_mismatch" }, "origin_mismatch"), "still_origin_mismatch");
  assert.equal(regressionStatus({ status: "update_failed" }, "origin_mismatch"), "validate_recovered_update_failed");
  assert.equal(regressionStatus({ status: "validate_failed" }, "preflight_validate_failed"), "still_validate_failed");
});

test("区块汇总不会掩盖同一区块中的部分失败", () => {
  const targets = [{
    id: "p1", issueGroup: "origin_mismatch", pageName: "页面", pagePath: "/a", pageUrl: "http://example.test/a", scope: "blocks",
    allowedSources: [
      { itemKey: "a", objectType: "区块", objectId: "1", objectName: "区块1" },
      { itemKey: "b", objectType: "区块", objectId: "1", objectName: "区块1" },
    ],
  }];
  const state = { pages: [{ target_id: "p1", items: [
    { item_key: "a", status: "modified_verified", regression_status: "fixed_verified" },
    { item_key: "b", status: "origin_mismatch", regression_status: "still_origin_mismatch", failure_reason: "H_ORIGIN_NOT_MATCHED" },
  ] }] };
  const [row] = buildObjectRows(state, targets);
  assert.equal(row.historical_h_count, 2);
  assert.equal(row.fixed_h_count, 1);
  assert.equal(row.regression_status, "still_origin_mismatch");
});
