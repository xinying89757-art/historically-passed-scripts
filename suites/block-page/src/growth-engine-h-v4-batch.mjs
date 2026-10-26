import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeText, numericRunId } from "./growth-engine-h-core.mjs";
import { GrowthEngineBatchStore } from "./growth-engine-h-batch.mjs";
import { GrowthEngineStateStore } from "./growth-engine-h-state.mjs";
import { V4_GROWTH_ENGINE_REPORT_COLUMNS, expandReadonlyCopies } from "./growth-engine-h-v4-report.mjs";
import { buildV4GrowthEngineTargets } from "./growth-engine-h-v4-source.mjs";

function now() {
  return new Date().toISOString();
}

function taskIdFor(page) {
  const gallery = page.path.match(/^\/new-gallery-block-test-(\d+)$/u);
  if (gallery) return `gallery-${gallery[1]}`;
  const imageText = page.path.match(/^\/new-image-text-block-test-(\d+)$/u);
  if (imageText) return `image-text-${imageText[1]}`;
  return page.path.replace(/^\/+|\/+$/gu, "").replace(/[^\p{L}\p{N}-]+/gu, "-");
}

export function buildV4GrowthEngineBatchTasks(pages, {
  excludePaths = ["/new-gallery-block-test-001"],
} = {}) {
  const excluded = new Set(excludePaths);
  return pages.filter((page) => !excluded.has(page.path)).map((page, index) => {
    const { items, unsupported } = buildV4GrowthEngineTargets(page, "批量计划");
    return {
      id: taskIdFor(page),
      sequence: index + 1,
      page_name: page.name,
      page_path: page.path,
      target_count: items.length,
      unsupported_count: unsupported.length,
      status: "planned",
      issue_count: 0,
      non_editable_count: 0,
      preview_failure_count: 0,
      backfill_error_count: 0,
      failure_reason: "",
      started_at: "",
      completed_at: "",
    };
  });
}

export function selectV4GrowthEngineBatchTasks(tasks, {
  taskId = "",
  startTaskId = "",
  maxPages = Number.POSITIVE_INFINITY,
} = {}) {
  if (taskId && startTaskId) throw new Error("--task-id 与 --start-task-id 不能同时使用");
  let selected = tasks;
  if (taskId) {
    selected = tasks.filter((task) => task.id === taskId);
    if (selected.length !== 1) throw new Error(`任务 ${taskId} 匹配数量为 ${selected.length}`);
  }
  if (startTaskId) {
    const index = tasks.findIndex((task) => task.id === startTaskId);
    if (index < 0) throw new Error(`起始任务 ${startTaskId} 不存在`);
    selected = tasks.slice(index);
  }
  return selected.slice(0, Number.isFinite(maxPages) ? maxPages : selected.length);
}

export function createV4GrowthEngineBatchState(tasks, runId = numericRunId()) {
  return {
    version: 1,
    kind: "growth_engine_v4_batch",
    run_id: runId,
    phase: "planned",
    created_at: now(),
    updated_at: now(),
    excluded_prior_page: "/new-gallery-block-test-001",
    tasks,
  };
}

export function makeV4BatchPageConfig(baseConfig, batchState, task) {
  const config = structuredClone(baseConfig);
  config.targetPagePath = task.page_path;
  config.pagePathCandidates = [task.page_path];
  config.publicUrl = new URL(task.page_path, baseConfig.publicUrl).toString();
  config.editorBackfill.pageName = task.page_name;
  const stateRoot = path.join(baseConfig.v4Batch.pagesStateDir, batchState.run_id);
  config.paths.stateFile = path.join(stateRoot, `${task.id}.json`);
  config.paths.artifactsDir = path.join(baseConfig.v4Batch.artifactsDir, batchState.run_id, task.id);
  config.paths.reportsDir = path.join(baseConfig.v4Batch.reportsDir, batchState.run_id, "pages", task.id);
  task.page_state_file = config.paths.stateFile;
  task.page_artifacts_dir = config.paths.artifactsDir;
  task.page_reports_dir = config.paths.reportsDir;
  return config;
}

function itemIdentity(item) {
  return `${item.page_path}|${item.item_index}|${item.block_id}|${item.editor_index}`;
}

export function collectV4PageIssues(pageState) {
  const issues = [];
  for (const item of pageState.items ?? []) {
    const mappingResolved = item.mapping_status && item.mapping_status !== "pending";
    if (mappingResolved && (item.level_editable === false || item.text_editable === false)) {
      const fields = [
        item.level_editable === false ? "标题级别" : "",
        item.text_editable === false ? "标题文字" : "",
      ].filter(Boolean).join("、");
      issues.push({
        ...item,
        issue_type: "growth_engine_not_editable",
        issue_key: `${itemIdentity(item)}|not-editable`,
        failure_reason: item.failure_reason || `增长引擎不可编辑字段：${fields}`,
      });
    }
    for (const copy of expandReadonlyCopies([item])) {
      issues.push({
        ...copy,
        issue_type: "growth_engine_not_editable",
        issue_key: `${itemIdentity(copy)}|readonly-copy`,
      });
    }
    if (item.growth_engine_reentry_status === "mismatch") {
      issues.push({
        ...item,
        issue_type: "growth_engine_reentry_error",
        issue_key: `${itemIdentity(item)}|growth-engine-reentry`,
        failure_reason: item.growth_engine_reentry_failure_reason || "保存同步后重新进入增长引擎，文字或级别回填不一致",
      });
    }
    if (item.verification_status !== "pending" && !["modified_verified", "partially_editable_verified", "not_editable"].includes(item.verification_status)) {
      issues.push({
        ...item,
        issue_type: "verification_failure",
        issue_key: `${itemIdentity(item)}|verification`,
      });
    }
    if (["mismatch", "check_failed", "not_found", "locator_ambiguous"].includes(item.editor_backfill_status)) {
      issues.push({
        ...item,
        issue_type: "editor_backfill_error",
        issue_key: `${itemIdentity(item)}|backfill`,
        failure_reason: item.editor_backfill_failure_reason || item.failure_reason,
      });
    }
  }
  const hasItemPreviewIssue = issues.some((issue) => issue.issue_type === "verification_failure");
  if (pageState.page_verification?.status === "failed" && !hasItemPreviewIssue) {
    issues.push({
      run_id: pageState.run_id,
      page_path: pageState.page_path,
      item_index: "页面",
      issue_type: "page_preview_mismatch",
      issue_key: `${pageState.page_path}|page-preview`,
      failure_reason: (pageState.page_verification.differences ?? []).join("；"),
    });
  }
  if (pageState.initial_refresh?.status === "failed") {
    issues.push({
      run_id: pageState.run_id,
      page_path: pageState.page_path,
      item_index: "页面",
      issue_type: "initial_refresh_failed",
      issue_key: `${pageState.page_path}|initial-refresh`,
      failure_reason: pageState.initial_refresh.failure_reason,
    });
  }
  if (pageState.run_failure) {
    const issueType = /^page_not_found:/u.test(pageState.run_failure)
      ? "page_not_found"
      : /^page_detail_unavailable:/u.test(pageState.run_failure)
        ? "page_detail_unavailable"
        : "automation_failure";
    issues.push({
      run_id: pageState.run_id,
      page_path: pageState.page_path,
      item_index: "页面",
      issue_type: issueType,
      issue_key: `${pageState.page_path}|automation`,
      failure_reason: pageState.run_failure,
    });
  }
  return issues;
}

export function summarizeV4PageState(pageState) {
  const issues = collectV4PageIssues(pageState);
  const growthEngineReentryComplete = !pageState.growth_engine_reentry_verification?.status ||
    ["verified", "failed", "not_applicable"].includes(pageState.growth_engine_reentry_verification.status);
  const completeLifecycle = ["verified", "skipped"].includes(pageState.initial_refresh?.status) &&
    growthEngineReentryComplete &&
    ["verified", "failed", "not_applicable"].includes(pageState.editor_backfill_verification?.status) &&
    ["verified", "failed", "not_applicable"].includes(pageState.page_verification?.status);
  return {
    target_count: pageState.items?.length ?? 0,
    unsupported_count: pageState.unsupported?.length ?? 0,
    issue_count: issues.length,
    non_editable_count: issues.filter((issue) => issue.issue_type === "growth_engine_not_editable").length,
    preview_failure_count: issues.filter((issue) => ["verification_failure", "page_preview_mismatch"].includes(issue.issue_type)).length,
    backfill_error_count: issues.filter((issue) => issue.issue_type === "editor_backfill_error").length,
    status: /^page_(?:not_found|detail_unavailable):/u.test(pageState.run_failure ?? "")
      ? "unverifiable_page"
      : pageState.phase === "complete" || pageState.phase === "complete_no_supported_targets"
      ? "complete"
      : completeLifecycle && !pageState.run_failure
        ? "completed_with_issues"
        : "automation_failed",
  };
}

export function reconcileRecordedV4Backfill(pageState) {
  let corrected = 0;
  for (const item of pageState.items ?? []) {
    if (!["mismatch", "check_failed"].includes(item.editor_backfill_status)) continue;
    const matches = item.editor_actual_level && item.editor_actual_text &&
      String(item.editor_actual_level).toUpperCase() === String(item.expected_level ?? "").toUpperCase() &&
      normalizeText(item.editor_actual_text) === normalizeText(item.expected_text);
    if (!matches) continue;
    item.editor_backfill_status = "verified";
    item.editor_backfill_failure_reason = "";
    corrected += 1;
  }
  const targets = (pageState.items ?? []).filter((item) => item.editor_backfill_status !== "not_applicable" && item.editor_backfill_status !== "pending");
  const failed = targets.filter((item) => item.editor_backfill_status !== "verified");
  if (targets.length > 0) {
    pageState.editor_backfill_verification = {
      status: failed.length === 0 ? "verified" : "failed",
      page_name: pageState.page_name,
      verified: targets.length - failed.length,
      failed: failed.length,
      differences: failed.map((item) => `区块${item.block_id}第${item.editor_index}处：${item.editor_backfill_failure_reason}`),
    };
  }
  return corrected;
}

export function updateV4BatchTask(task, pageState) {
  const summary = summarizeV4PageState(pageState);
  Object.assign(task, summary, {
    initial_refresh_status: pageState.initial_refresh?.status ?? "pending",
    preview_status: pageState.page_verification?.status ?? "pending",
    editor_backfill_status: pageState.editor_backfill_verification?.status ?? "pending",
    failure_reason: pageState.run_failure || collectV4PageIssues(pageState).map((issue) => issue.failure_reason).filter(Boolean).join("；"),
  });
  if (["complete", "completed_with_issues"].includes(task.status)) task.completed_at = now();
  return task;
}

export async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows, columns) {
  return `\uFEFF${[columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n")}\r\n`;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

async function readPageState(file) {
  if (!file) return null;
  return new GrowthEngineStateStore(file).load().catch(() => null);
}

export async function writeV4GrowthEngineBatchReports(state, config) {
  const runDir = path.join(config.v4Batch.reportsDir, state.run_id);
  await mkdir(runDir, { recursive: true });
  const taskStates = [];
  for (const task of state.tasks) {
    const pageState = await readPageState(task.page_state_file);
    if (pageState) taskStates.push({ task, pageState, prior: false });
  }
  const priorState = await readPageState(config.v4Batch.priorPageStateFile);
  if (priorState && priorState.page_path === state.excluded_prior_page) {
    taskStates.unshift({
      task: {
        id: "gallery-001",
        page_name: priorState.page_name,
        page_path: priorState.page_path,
        ...summarizeV4PageState(priorState),
        initial_refresh_status: priorState.initial_refresh?.status,
        preview_status: priorState.page_verification?.status,
        editor_backfill_status: priorState.editor_backfill_verification?.status,
      },
      pageState: priorState,
      prior: true,
    });
  }
  const allItems = taskStates.flatMap(({ task, pageState }) =>
    (pageState.items ?? []).map((item) => ({ page_name: task.page_name, ...item })));
  const allUnsupported = taskStates.flatMap(({ task, pageState }) =>
    (pageState.unsupported ?? []).map((item) => ({ page_name: task.page_name, page_path: pageState.page_path, ...item })));
  const allIssues = taskStates.flatMap(({ task, pageState }) =>
    collectV4PageIssues(pageState).map((issue) => ({ page_name: task.page_name, ...issue })));
  const pageColumns = [
    "id", "page_name", "page_path", "target_count", "unsupported_count", "status",
    "initial_refresh_status", "preview_status", "editor_backfill_status", "issue_count",
    "non_editable_count", "preview_failure_count", "backfill_error_count", "failure_reason",
    "started_at", "completed_at", "page_reports_dir",
  ];
  const issueColumns = ["issue_type", "page_name", ...V4_GROWTH_ENGINE_REPORT_COLUMNS];
  const resultColumns = ["page_name", ...V4_GROWTH_ENGINE_REPORT_COLUMNS];
  const unsupportedColumns = ["page_name", "page_path", "block_id", "app_name", "slot_index", "editor_dom_id", "editor_index", "field_name", "status", "reason"];
  const pageRows = [
    ...taskStates.filter((entry) => entry.prior).map((entry) => entry.task),
    ...state.tasks,
  ];
  const counts = {
    total_pages: pageRows.length,
    batch_pages: state.tasks.length,
    finished_batch_pages: state.tasks.filter((task) => ["complete", "completed_with_issues", "unverifiable_page"].includes(task.status)).length,
    pending_batch_pages: state.tasks.filter((task) => !["complete", "completed_with_issues", "unverifiable_page"].includes(task.status)).length,
    headings: allItems.length,
    unsupported_blocks: allUnsupported.length,
    problems: allIssues.length,
    non_editable: allIssues.filter((issue) => issue.issue_type === "growth_engine_not_editable").length,
    preview_failures: allIssues.filter((issue) => ["verification_failure", "page_preview_mismatch"].includes(issue.issue_type)).length,
    backfill_errors: allIssues.filter((issue) => issue.issue_type === "editor_backfill_error").length,
  };
  const rows = pageRows.map((task) => `<tr><td>${escapeHtml(task.page_name)}</td><td>${escapeHtml(task.page_path)}</td><td>${escapeHtml(task.target_count)}</td><td>${escapeHtml(task.status)}</td><td>${escapeHtml(task.initial_refresh_status)}</td><td>${escapeHtml(task.preview_status)}</td><td>${escapeHtml(task.editor_backfill_status)}</td><td>${escapeHtml(task.issue_count)}</td></tr>`).join("");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>4.0增长引擎H标签批量报告</title><style>body{font:14px/1.55 system-ui,sans-serif;margin:28px;color:#1f2937}.cards{display:flex;gap:12px;flex-wrap:wrap}.card{border:1px solid #dbe3ee;border-radius:10px;padding:12px 16px}.card b{display:block;font-size:24px}.notice{padding:10px;background:#fff7ed;border:1px solid #fdba74;border-radius:8px}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:8px;border-bottom:1px solid #e5e7eb;text-align:left}th{background:#f8fafc}</style></head><body><h1>4.0增长引擎H标签批量报告</h1><p>批次：${escapeHtml(state.run_id)}；阶段：${escapeHtml(state.phase)}</p><p class="notice">增长引擎中任一字段只读或无法编辑均计为测试问题。</p><div class="cards">${Object.entries(counts).map(([key, value]) => `<div class="card">${escapeHtml(key)}<b>${value}</b></div>`).join("")}</div><table><thead><tr><th>页面</th><th>路径</th><th>目标H</th><th>状态</th><th>首次刷新</th><th>预览</th><th>回填</th><th>问题</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  await Promise.all([
    writeFile(path.join(runDir, "v4-growth-engine-h-batch-pages.csv"), toCsv(pageRows, pageColumns), "utf8"),
    writeFile(path.join(runDir, "v4-growth-engine-h-batch-results.csv"), toCsv(allItems, resultColumns), "utf8"),
    writeFile(path.join(runDir, "v4-growth-engine-h-batch-issues.csv"), toCsv(allIssues, issueColumns), "utf8"),
    writeFile(path.join(runDir, "v4-growth-engine-h-batch-non-editable.csv"), toCsv(allIssues.filter((issue) => issue.issue_type === "growth_engine_not_editable"), issueColumns), "utf8"),
    writeFile(path.join(runDir, "v4-growth-engine-h-batch-editor-backfill-errors.csv"), toCsv(allIssues.filter((issue) => issue.issue_type === "editor_backfill_error"), issueColumns), "utf8"),
    writeFile(path.join(runDir, "v4-growth-engine-h-batch-unsupported.csv"), toCsv(allUnsupported, unsupportedColumns), "utf8"),
    writeFile(path.join(runDir, "v4-growth-engine-h-batch-report.html"), html, "utf8"),
  ]);
  return { ...counts, runDir };
}

export { GrowthEngineBatchStore as V4GrowthEngineBatchStore };
