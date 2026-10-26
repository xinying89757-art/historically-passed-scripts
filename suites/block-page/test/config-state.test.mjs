import test from "node:test";
import assert from "node:assert/strict";
import { deepMerge, pageDescriptor } from "../src/config.mjs";
import { createInitialState } from "../src/state.mjs";
import {
  preclassifyDeferred,
  repairCollapsedPanelFailures,
  summarizeState,
} from "../src/runner.mjs";

test("deepMerge 深度合并对象并整体替换数组", () => {
  assert.deepEqual(
    deepMerge(
      { a: { b: 1, c: 2 }, selectors: ["old"] },
      { a: { b: 3 }, selectors: ["new"] },
    ),
    { a: { b: 3, c: 2 }, selectors: ["new"] },
  );
});

test("pageDescriptor 生成稳定的三位页码、路径和公开 URL", () => {
  const descriptor = pageDescriptor(
    {
      pageNamePrefix: "GE-区块测试-",
      pagePathPrefix: "ge-block-test-",
      publicBaseUrl: "http://example.test/root",
    },
    7,
  );
  assert.deepEqual(descriptor, {
    number: 7,
    name: "GE-区块测试-007",
    path: "/ge-block-test-007",
    publicUrl: "http://example.test/ge-block-test-007",
  });
});

test("名称含产品详情或页头时预分类为 deferred_detail 且不分配槽位", () => {
  const input = {
    checksum: "abc",
    blocks: [
      { csv_row: 2, block_id: "1", app_name: "普通图文" },
      { csv_row: 3, block_id: "2", app_name: "产品详情-推荐" },
      { csv_row: 4, block_id: "3", app_name: "悬浮显示详情" },
      { csv_row: 5, block_id: "4", app_name: "透明悬停页头区块" },
    ],
  };
  const config = {
    inputCsv: "/tmp/blocks.csv",
    blocksPerPage: 6,
    preDeferredNameKeywords: ["产品详情", "页头"],
  };
  const state = createInitialState(input, config);
  assert.equal(preclassifyDeferred(state, config), 2);
  assert.equal(state.records[0].status, "pending");
  assert.equal(state.records[1].status, "deferred_detail");
  assert.equal(state.records[1].slot_index, "");
  assert.equal(state.records[2].status, "pending");
  assert.equal(state.records[3].status, "deferred_detail");
  assert.equal(
    state.records[3].failure_reason,
    "CSV 名称命中已确认的暂缓关键词：页头",
  );
  assert.deepEqual(summarizeState(state).counts, {
    pending: 2,
    deferred_detail: 2,
  });
});

test("侧栏折叠期间产生的无 DOM 失败可安全恢复为 pending", () => {
  const input = {
    checksum: "abc",
    blocks: [{ csv_row: 2, block_id: "501", app_name: "图文区块" }],
  };
  const config = { inputCsv: "/tmp/blocks.csv", blocksPerPage: 6 };
  const state = createInitialState(input, config);
  Object.assign(state.records[0], {
    status: "render_failed",
    failure_reason: "添加后 5 秒内没有检测到目标 DOM 或加载信号",
    attempt_count: 1,
  });
  assert.equal(repairCollapsedPanelFailures(state), 1);
  assert.equal(state.records[0].status, "pending");
  assert.equal(state.records[0].failure_reason, "");
  assert.equal(state.records[0].attempt_count, 0);
});
