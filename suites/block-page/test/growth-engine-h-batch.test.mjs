import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGrowthEngineBatchTasks,
  classifyGrowthEngineBatchError,
  createGrowthEngineBatchState,
  resolveAvailablePagePath,
  selectGrowthEngineBatchTasks,
} from "../src/growth-engine-h-batch.mjs";

test("组件页优先使用实际存在的记录路径，否则使用三位数字html路径", () => {
  assert.equal(resolveAvailablePagePath(
    ["/component-heading-test-001", "/001.html"],
    ["/001.html", "/aboutus.html"],
  ), "/001.html");
  assert.equal(resolveAvailablePagePath(
    ["/004.html", "/component-heading-test-004"],
    ["/component-heading-test-004", "/004.html"],
  ), "/004.html");
});

test("未枚举整站页面时组件任务优先按三位数字路径搜索", () => {
  const [task] = buildGrowthEngineBatchTasks({
    componentState: {
      pages: [{ number: 3, name: "组件标题测试-003", path: "/component-heading-test-003" }],
      records: [{ page_name: "组件标题测试-003", original_name: "产品分类", status: "configured" }],
    },
    rankingState: { pages: [], records: [] },
    scope: "components",
  });
  assert.equal(task.target_page_path, "/003.html");
  assert.deepEqual(task.path_candidates, [
    "/003.html", "/component-heading-test-003", "/component-heading-test-003.html", "/003",
  ]);
});

test("可通过task-id只选择组件003且不重跑前两页", () => {
  const selected = selectGrowthEngineBatchTasks([
    { id: "component-001" }, { id: "component-002" }, { id: "component-003" },
  ], { taskId: "component-003", maxPages: 1 });
  assert.deepEqual(selected, [{ id: "component-003" }]);
  assert.throws(
    () => selectGrowthEngineBatchTasks([{ id: "component-001" }], { taskId: "component-003" }),
    /匹配数量为 0/u,
  );
});

test("可从指定任务开始批量执行剩余页面", () => {
  const selected = selectGrowthEngineBatchTasks([
    { id: "component-001" }, { id: "component-002" }, { id: "component-003" },
    { id: "component-004" }, { id: "component-005" },
  ], { startTaskId: "component-004" });
  assert.deepEqual(selected.map((task) => task.id), ["component-004", "component-005"]);
  assert.throws(
    () => selectGrowthEngineBatchTasks([{ id: "component-001" }], { startTaskId: "component-004" }),
    /起始任务 component-004 不存在/u,
  );
});

test("可一次选择多个非连续任务并保持源清单顺序", () => {
  const selected = selectGrowthEngineBatchTasks([
    { id: "block-008" }, { id: "block-017" }, { id: "block-025" }, { id: "block-045" },
  ], { taskIds: ["block-045", "block-008", "block-025"] });
  assert.deepEqual(selected.map((task) => task.id), ["block-008", "block-025", "block-045"]);
  assert.throws(
    () => selectGrowthEngineBatchTasks([{ id: "block-008" }], { taskIds: ["block-008", "block-999"] }),
    /未匹配项：block-999/u,
  );
});

test("预览404与页面未找到、登录失效和字段修改失败分开分类", () => {
  assert.equal(classifyGrowthEngineBatchError("preview_unavailable: 预览地址返回不存在页面"), "preview_unavailable");
  assert.equal(classifyGrowthEngineBatchError("page_not_found: 没有结果"), "page_not_found");
  assert.equal(classifyGrowthEngineBatchError("login_expired: 请重新登录"), "login_expired");
  assert.equal(classifyGrowthEngineBatchError("edit_not_effective: 字段未变化"), "failed");
});

test("从组件和区块状态生成可追溯批量任务", () => {
  const tasks = buildGrowthEngineBatchTasks({
    componentState: {
      pages: [{ number: 1, name: "组件标题测试-001", path: "/component-heading-test-001" }],
      records: [{ page_name: "组件标题测试-001", original_name: "图片集", status: "configured" }],
    },
    rankingState: {
      pages: [{ number: 1, name: "区块排名H测试-001", path: "/block-ranking-heading-test-001" }],
      records: [{ page_name: "区块排名H测试-001", block_id: "26074", app_name: "纯文本", status: "added" }],
    },
    availablePaths: ["/001.html", "/block-ranking-heading-test-001"],
    scope: "all",
  });
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].target_page_path, "/001.html");
  assert.equal(tasks[1].target_page_path, "/block-ranking-heading-test-001");
  assert.deepEqual(tasks[1].source_names, ["26074-纯文本"]);
});

test("试跑状态只选择前两个页面", () => {
  const state = createGrowthEngineBatchState([
    { id: "component-001" },
    { id: "component-002" },
    { id: "component-003" },
  ], { scope: "components", maxPages: 2, runId: "20260819150000" });
  assert.equal(state.tasks.length, 2);
  assert.equal(state.run_id, "20260819150000");
});
