import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeComponentReports } from "../src/component-report.mjs";
import {
  ComponentStateStore,
  createInitialComponentState,
  reopenLastComponentPageForAppend,
  resetComponentFailuresByNames,
  resetComponentFailuresByStatuses,
  summarizeComponentState,
} from "../src/component-state.mjs";

const input = {
  checksum: "test-checksum",
  records: [
    {
      excel_row: 5,
      original_name: "快速导航",
      chinese_name: "快速导航",
      sequence: 1,
      expected_title: "组件标题测试-001-快速导航",
      expected_level: "H2",
      initial_status: "pending",
    },
    {
      excel_row: 8,
      original_name: "幻灯片",
      chinese_name: "幻灯片",
      sequence: null,
      expected_title: "",
      expected_level: "",
      initial_status: "skipped_h_unsupported",
    },
  ],
};
const config = {
  componentWorkbook: "/tmp/input.xlsx",
  componentSheetName: "一期清单",
  componentsPerPage: 6,
};

test("组件状态与区块状态互相独立并可原子保存", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "component-state-"));
  const stateFile = path.join(directory, "state.json");
  const store = new ComponentStateStore(stateFile);
  const state = createInitialComponentState(input, config);
  assert.equal(state.records[0].status, "pending");
  assert.equal(state.records[1].status, "skipped_h_unsupported");
  await store.save(state);
  assert.deepEqual(await store.load(), JSON.parse(await readFile(stateFile, "utf8")));
  assert.deepEqual(summarizeComponentState(state).statuses, {
    pending: 1,
    skipped_h_unsupported: 1,
  });
});

test("组件报告只把成功项写入映射，失败项写入失败清单", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "component-report-"));
  const state = createInitialComponentState(input, config);
  state.records[0].status = "configured";
  state.records[0].actual_title = state.records[0].expected_title;
  state.records[0].actual_level = "H2";
  await writeComponentReports(state, directory);
  const mapping = await readFile(path.join(directory, "component-page-mapping.csv"), "utf8");
  const failures = await readFile(path.join(directory, "component-failures.csv"), "utf8");
  const html = await readFile(path.join(directory, "component-report.html"), "utf8");
  assert.match(mapping, /快速导航/);
  assert.doesNotMatch(failures, /快速导航/);
  assert.match(html, /3\.0组件铺页及 H 标签配置报告/);
});

test("可只按名称重置自定义代码组件失败状态", () => {
  const state = createInitialComponentState(input, config);
  state.records[0].status = "level_control_not_found";
  state.records.push({
    ...state.records[0],
    sequence: 50,
    original_name: "插件代码",
    status: "level_control_not_found",
    setting_id: "",
  });
  assert.deepEqual(
    resetComponentFailuresByNames(state, new Set(["插件代码"])),
    [50],
  );
  assert.equal(state.records[0].status, "level_control_not_found");
  assert.equal(state.records[2].status, "pending");
});

test("失败组件可追加到最后一个未满页面而不新建页面", () => {
  const state = createInitialComponentState(input, config);
  state.next_page_number = 11;
  state.pages = [
    {
      number: 10,
      name: "组件标题测试-010",
      path: "/component-heading-test-010",
      setting_ids: ["一", "二", "三"],
      component_names: ["甲", "乙", "丙"],
      saved_at: "已保存",
      verified_at: "已验证",
    },
  ];
  const reopened = reopenLastComponentPageForAppend(state);
  assert.equal(reopened.name, "组件标题测试-010");
  assert.equal(state.pages.length, 0);
  assert.equal(state.next_page_number, 10);
  assert.equal(state.current_page.setting_ids.length, 3);
  assert.equal("saved_at" in state.current_page, false);
});

test("可只重置未找到组件而不重跑其他失败类型", () => {
  const state = createInitialComponentState(input, config);
  state.records[0].status = "component_not_found";
  state.records.push({
    ...state.records[0],
    sequence: 2,
    original_name: "另一个组件",
    status: "level_control_not_found",
  });
  assert.deepEqual(
    resetComponentFailuresByStatuses(state, ["component_not_found"]),
    [1],
  );
  assert.equal(state.records[0].status, "pending");
  assert.equal(state.records[2].status, "level_control_not_found");
});
