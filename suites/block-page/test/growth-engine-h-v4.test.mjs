import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadGrowthEngineConfig } from "../src/growth-engine-h-config.mjs";
import { expandReadonlyCopies, writeV4GrowthEngineReports } from "../src/growth-engine-h-v4-report.mjs";
import { classifyV4PreviewOpen } from "../src/v4-editor.mjs";
import {
  buildV4GrowthEngineTargets,
  loadV4GrowthEnginePages,
  loadV4GrowthEngineSource,
  mapV4TargetsToControls,
  shouldRunInitialRefresh,
} from "../src/growth-engine-h-v4-source.mjs";
import {
  buildV4GrowthEngineBatchTasks,
  collectV4PageIssues,
  createV4GrowthEngineBatchState,
  makeV4BatchPageConfig,
  reconcileRecordedV4Backfill,
  selectV4GrowthEngineBatchTasks,
  summarizeV4PageState,
} from "../src/growth-engine-h-v4-batch.mjs";

test("4.0页面001生成14条H目标和2个不支持区块", async () => {
  const config = await loadGrowthEngineConfig("config/growth-engine-h-v4.json");
  const page = await loadV4GrowthEngineSource(config);
  const result = buildV4GrowthEngineTargets(page, "20260821120000");
  assert.equal(page.name, "新版图片集区块测试-001");
  assert.equal(result.items.length, 14);
  assert.equal(result.unsupported.length, 2);
  assert.ok(result.items.every((item) => item.original_level === "H2" && item.expected_level === "H3"));
});

test("4.0首次编辑前刷新只在尚未成功时执行", () => {
  assert.equal(shouldRunInitialRefresh({ refreshBeforeEdit: true }, { initial_refresh: { status: "pending" } }), true);
  assert.equal(shouldRunInitialRefresh({ refreshBeforeEdit: true }, { initial_refresh: { status: "verified" } }), false);
  assert.equal(shouldRunInitialRefresh({ refreshBeforeEdit: false }, { initial_refresh: { status: "pending" } }), false);
});

test("4.0无刷新批次只等待扫描并使用编辑器预览按钮", async () => {
  const config = await loadGrowthEngineConfig("config/growth-engine-h-v4-no-refresh.json");
  assert.equal(config.refreshBeforeEdit, false);
  assert.equal(config.refreshButtonOptional, true);
  assert.equal(config.previewResolution.preferDerived, false);
  assert.equal(config.previewResolution.useEditorPreviewButton, true);
  const runner = await readFile("src/growth-engine-h-v4-run.mjs", "utf8");
  assert.doesNotMatch(runner, /resolvePreviewUrl|readPreviewHeadingsAt|readDerivedPreview/u);
});

test("4.0编辑器预览入口和新页签异常分类明确", () => {
  assert.equal(classifyV4PreviewOpen({ buttonCount: 0 }).status, "preview_button_not_found");
  assert.equal(classifyV4PreviewOpen({ buttonCount: 2 }).status, "preview_button_ambiguous");
  assert.equal(classifyV4PreviewOpen({ buttonCount: 1, tabOpened: false }).status, "preview_tab_not_opened");
});

test("4.0编辑器预览严格校验页面路径和H数量", () => {
  assert.equal(classifyV4PreviewOpen({
    buttonCount: 1,
    tabOpened: true,
    expectedPath: "/new-gallery-block-test-001",
    actualUrl: "http://example.test/other-page",
    headingCount: 1,
  }).status, "preview_path_mismatch");
  assert.equal(classifyV4PreviewOpen({
    buttonCount: 1,
    tabOpened: true,
    expectedPath: "/new-gallery-block-test-001",
    actualUrl: "http://example.test/new-gallery-block-test-001?preview=1",
    headingCount: 0,
  }).status, "preview_no_h_detected");
  assert.equal(classifyV4PreviewOpen({
    buttonCount: 1,
    tabOpened: true,
    expectedPath: "/new-gallery-block-test-001/",
    actualUrl: "http://example.test/new-gallery-block-test-001",
    headingCount: 14,
  }).status, "verified");
});

test("4.0目标允许一个可编辑项加只读副本，但拒绝多个可编辑同文字项", () => {
  const items = [{ source_text: "唯一测试标题", expected_text: "唯一测试标题｜同步验证批次20260821120000第01项" }];
  const mapped = mapV4TargetsToControls(items, [
    { level: "H2", text: "唯一测试标题", levelEditable: true, textEditable: true },
    { level: "H2", text: "唯一测试标题", levelEditable: false, textEditable: false },
  ]);
  assert.equal(mapped[0].status, "mapped");
  assert.equal(mapped[0].readonlyCopies, 1);
  const ambiguous = mapV4TargetsToControls(items, [
    { level: "H2", text: "唯一测试标题", levelEditable: true, textEditable: true },
    { level: "H2", text: "唯一测试标题", levelEditable: true, textEditable: true },
  ]);
  assert.equal(ambiguous[0].status, "locator_ambiguous");
});

test("4.0报告分开输出不可编辑和编辑器回填错误", async () => {
  const reportsDir = await mkdtemp(path.join(os.tmpdir(), "growth-engine-v4-report-"));
  const item = {
    run_id: "1", page_path: "/001", item_index: 1, block_id: "100", app_name: "图片集",
    level_editable: false, text_editable: false, verification_status: "not_editable",
    editor_backfill_status: "not_applicable",
  };
  const mismatch = {
    ...item, item_index: 2, block_id: "200", level_editable: true, text_editable: true,
    verification_status: "modified_verified", editor_backfill_status: "mismatch",
    editor_backfill_failure_reason: "级别应为H3，实际H2",
  };
  await writeV4GrowthEngineReports({
    page_name: "页面", page_path: "/001", phase: "failed",
    initial_refresh: { status: "verified" }, page_verification: { status: "verified" },
    editor_backfill_verification: { status: "failed" }, unsupported: [], items: [item, mismatch],
  }, reportsDir);
  assert.match(await readFile(path.join(reportsDir, "v4-growth-engine-h-non-editable.csv"), "utf8"), /,100,/u);
  assert.match(await readFile(path.join(reportsDir, "v4-growth-engine-h-editor-backfill-errors.csv"), "utf8"), /,200,/u);
});

test("4.0报告将每一个只读副本独立计入不可编辑清单", async () => {
  const reportsDir = await mkdtemp(path.join(os.tmpdir(), "growth-engine-v4-readonly-report-"));
  const item = {
    run_id: "1", page_path: "/001", item_index: 10, block_id: "39314", app_name: "图片集",
    field_name: "标题", source_text: "区块标题", original_level: "H2", original_text: "区块标题",
    level_editable: true, text_editable: true, readonly_copy_count: 2,
    verification_status: "modified_verified", editor_backfill_status: "verified",
  };
  assert.equal(expandReadonlyCopies([item]).length, 2);
  const counts = await writeV4GrowthEngineReports({
    page_name: "页面", page_path: "/001", phase: "complete",
    initial_refresh: { status: "verified" }, page_verification: { status: "verified" },
    editor_backfill_verification: { status: "verified" }, unsupported: [], items: [item],
  }, reportsDir);
  assert.equal(counts.non_editable, 2);
  assert.equal(counts.problems, 2);
  const nonEditable = await readFile(path.join(reportsDir, "v4-growth-engine-h-non-editable.csv"), "utf8");
  assert.match(nonEditable, /10-只读副本1/u);
  assert.match(nonEditable, /10-只读副本2/u);
  assert.match(nonEditable, /readonly_copy/u);
  const issues = await readFile(path.join(reportsDir, "v4-growth-engine-h-issues.csv"), "utf8");
  assert.match(issues, /growth_engine_not_editable/u);
});

test("4.0批量计划覆盖除首个试跑页外的23页、348个H目标和21个不支持区块", async () => {
  const config = await loadGrowthEngineConfig("config/growth-engine-h-v4.json");
  const pages = await loadV4GrowthEnginePages(config);
  const tasks = buildV4GrowthEngineBatchTasks(pages);
  assert.equal(pages.length, 24);
  assert.equal(tasks.length, 23);
  assert.equal(tasks.reduce((sum, task) => sum + task.target_count, 0), 348);
  assert.equal(tasks.reduce((sum, task) => sum + task.unsupported_count, 0), 21);
  assert.ok(tasks.every((task) => task.page_path !== "/new-gallery-block-test-001"));
  assert.equal(selectV4GrowthEngineBatchTasks(tasks, { taskId: "gallery-002" }).length, 1);
});

test("4.0批量页面配置隔离状态、报告和编辑器页面名", async () => {
  const config = await loadGrowthEngineConfig("config/growth-engine-h-v4.json");
  const tasks = [{ id: "gallery-002", page_name: "新版图片集区块测试-002", page_path: "/new-gallery-block-test-002" }];
  const state = createV4GrowthEngineBatchState(tasks, "20260821150000");
  const pageConfig = makeV4BatchPageConfig(config, state, tasks[0]);
  assert.equal(pageConfig.targetPagePath, "/new-gallery-block-test-002");
  assert.equal(pageConfig.editorBackfill.pageName, "新版图片集区块测试-002");
  assert.match(pageConfig.paths.stateFile, /20260821150000\/gallery-002\.json$/u);
  assert.match(pageConfig.paths.reportsDir, /20260821150000\/pages\/gallery-002$/u);
});

test("4.0批量无刷新页面的跳过状态仍视为生命周期已完成", () => {
  const pageState = {
    phase: "complete", page_path: "/p", run_id: "1", unsupported: [], items: [],
    initial_refresh: { status: "skipped" },
    page_verification: { status: "verified", differences: [] },
    editor_backfill_verification: { status: "not_applicable" },
  };
  assert.equal(summarizeV4PageState(pageState).status, "complete");
});

test("4.0批量将只读字段和只读副本均判定为问题", () => {
  const pageState = {
    phase: "failed", page_path: "/p", run_id: "1", unsupported: [],
    initial_refresh: { status: "verified" },
    page_verification: { status: "verified", differences: [] },
    editor_backfill_verification: { status: "verified" },
    items: [{
      page_path: "/p", item_index: 1, block_id: "1", editor_index: 1,
      mapping_status: "mapped",
      level_editable: true, text_editable: false, readonly_copy_count: 2,
      verification_status: "partially_editable_verified", editor_backfill_status: "verified",
    }],
  };
  const issues = collectV4PageIssues(pageState);
  assert.equal(issues.filter((issue) => issue.issue_type === "growth_engine_not_editable").length, 3);
  const summary = summarizeV4PageState(pageState);
  assert.equal(summary.issue_count, 3);
  assert.equal(summary.status, "completed_with_issues");
});

test("4.0页面回填或预览验证失败但生命周期跑完时归类为已完成有问题", () => {
  const pageState = {
    phase: "failed", page_path: "/p", run_id: "1", unsupported: [], items: [],
    initial_refresh: { status: "verified" },
    page_verification: { status: "verified", differences: [] },
    editor_backfill_verification: { status: "failed" },
  };
  assert.equal(summarizeV4PageState(pageState).status, "completed_with_issues");
});

test("4.0尚未完成映射即发生页面异常时不把默认false误报为只读", () => {
  const pageState = {
    phase: "failed", page_path: "/missing", run_id: "1", unsupported: [],
    run_failure: "page_not_found: 页面不存在",
    initial_refresh: { status: "pending" },
    page_verification: { status: "pending", differences: [] },
    editor_backfill_verification: { status: "pending" },
    items: [{
      page_path: "/missing", item_index: 1, block_id: "1", editor_index: 1,
      mapping_status: "pending", level_editable: false, text_editable: false,
      readonly_copy_count: 0, verification_status: "pending", editor_backfill_status: "pending",
    }],
  };
  const issues = collectV4PageIssues(pageState);
  assert.deepEqual(issues.map((issue) => issue.issue_type), ["page_not_found"]);
  assert.equal(summarizeV4PageState(pageState).status, "unverifiable_page");
});

test("4.0已记录实际值与预期完全一致时纠正区块级回填误报", () => {
  const pageState = {
    page_name: "页面", items: [{
      block_id: "1", editor_index: 1,
      expected_level: "H3", expected_text: "同步后的标题",
      editor_actual_level: "H3", editor_actual_text: "同步后的标题",
      editor_backfill_status: "mismatch", editor_backfill_failure_reason: "区块重开验证失败",
    }],
    editor_backfill_verification: { status: "failed" },
  };
  assert.equal(reconcileRecordedV4Backfill(pageState), 1);
  assert.equal(pageState.items[0].editor_backfill_status, "verified");
  assert.equal(pageState.editor_backfill_verification.status, "verified");
  assert.equal(pageState.editor_backfill_verification.failed, 0);
});
