import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { numericRunId } from "./growth-engine-h-core.mjs";
import { GrowthEngineStateStore } from "./growth-engine-h-state.mjs";
import { growthEngineCsv } from "./growth-engine-h-report.mjs";

function normalizePath(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.startsWith("/") ? text : `/${text}`;
}

function componentPathCandidates(page) {
  const suffix = String(page.number).padStart(3, "0");
  const recorded = normalizePath(page.path);
  return [`/${suffix}.html`, recorded, recorded && `${recorded}.html`, `/${suffix}`]
    .filter(Boolean);
}

function blockPathCandidates(page) {
  const recorded = normalizePath(page.path);
  return [recorded, recorded && `${recorded}.html`].filter(Boolean);
}

export function resolveAvailablePagePath(candidates, availablePaths) {
  const available = new Set([...availablePaths].map(normalizePath));
  return candidates.find((candidate) => available.has(normalizePath(candidate))) ?? "";
}

export function buildGrowthEngineBatchTasks({
  componentState,
  rankingState,
  availablePaths = null,
  scope = "all",
}) {
  const tasks = [];
  if (["all", "components"].includes(scope)) {
    for (const page of componentState.pages ?? []) {
      const records = (componentState.records ?? []).filter(
        (record) => record.page_name === page.name && record.status === "configured",
      );
      if (records.length === 0) continue;
      const candidates = componentPathCandidates(page);
      const targetPagePath = availablePaths
        ? resolveAvailablePagePath(candidates, availablePaths)
        : candidates[0];
      tasks.push({
        id: `component-${String(page.number).padStart(3, "0")}`,
        scope: "components",
        sequence: page.number,
        editor_page_name: page.name,
        recorded_page_path: page.path,
        target_page_path: targetPagePath,
        path_candidates: candidates,
        source_item_count: records.length,
        source_names: records.map((record) => record.original_name),
        status: targetPagePath ? "planned" : "page_not_found",
        failure_reason: targetPagePath ? "" : `增长引擎中未找到候选路径：${candidates.join("、")}`,
      });
    }
  }
  if (["all", "blocks"].includes(scope)) {
    for (const page of rankingState.pages ?? []) {
      const records = (rankingState.records ?? []).filter(
        (record) => record.page_name === page.name && record.status === "added",
      );
      if (records.length === 0) continue;
      const candidates = blockPathCandidates(page);
      const targetPagePath = availablePaths
        ? resolveAvailablePagePath(candidates, availablePaths)
        : candidates[0];
      tasks.push({
        id: `block-${String(page.number).padStart(3, "0")}`,
        scope: "blocks",
        sequence: page.number,
        editor_page_name: page.name,
        recorded_page_path: page.path,
        target_page_path: targetPagePath,
        path_candidates: candidates,
        source_item_count: records.length,
        source_names: records.map((record) => `${record.block_id}-${record.app_name}`),
        status: targetPagePath ? "planned" : "page_not_found",
        failure_reason: targetPagePath ? "" : `增长引擎中未找到候选路径：${candidates.join("、")}`,
      });
    }
  }
  return tasks;
}

export function selectGrowthEngineBatchTasks(tasks, {
  taskId = "",
  taskIds = [],
  startTaskId = "",
  maxPages = Number.POSITIVE_INFINITY,
} = {}) {
  const requestedTaskIds = [...new Set([
    ...(taskId ? [taskId] : []),
    ...(Array.isArray(taskIds) ? taskIds : []),
  ])];
  if (requestedTaskIds.length && startTaskId) {
    throw new Error("--task-id/--task-ids 与 --start-task-id 不能同时使用");
  }
  let filtered = requestedTaskIds.length
    ? tasks.filter((task) => requestedTaskIds.includes(task.id))
    : tasks;
  if (taskId && filtered.length !== 1) {
    throw new Error(`任务 ${taskId} 匹配数量为 ${filtered.length}`);
  }
  if (taskIds.length && filtered.length !== requestedTaskIds.length) {
    const found = new Set(filtered.map((task) => task.id));
    const missing = requestedTaskIds.filter((id) => !found.has(id));
    throw new Error(`任务列表存在未匹配项：${missing.join("、")}`);
  }
  if (startTaskId) {
    const startIndex = tasks.findIndex((task) => task.id === startTaskId);
    if (startIndex < 0) throw new Error(`起始任务 ${startTaskId} 不存在`);
    filtered = tasks.slice(startIndex);
  }
  return filtered.slice(0, Number.isFinite(maxPages) ? maxPages : filtered.length);
}

export function classifyGrowthEngineBatchError(message) {
  const text = String(message ?? "");
  if (/page_not_found/u.test(text)) return "page_not_found";
  if (/preview_unavailable/u.test(text)) return "preview_unavailable";
  if (/login_expired|重新登录/u.test(text)) return "login_expired";
  return "failed";
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export class GrowthEngineBatchStore {
  constructor(file) {
    this.file = file;
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(state) {
    state.updated_at = new Date().toISOString();
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, this.file);
  }
}

export function createGrowthEngineBatchState(tasks, { scope, maxPages, runId = numericRunId() }) {
  const selected = tasks.slice(0, Number.isFinite(maxPages) ? maxPages : tasks.length);
  const now = new Date().toISOString();
  return {
    version: 1,
    run_id: runId,
    scope,
    max_pages: Number.isFinite(maxPages) ? maxPages : null,
    phase: "planned",
    created_at: now,
    updated_at: now,
    tasks: selected,
  };
}

export function makePageConfig(baseConfig, batchState, task) {
  const config = structuredClone(baseConfig);
  config.targetPagePath = task.target_page_path;
  config.pagePathCandidates = task.path_candidates;
  config.publicUrl = new URL(task.target_page_path, baseConfig.publicUrl).toString();
  config.editorBackfill.pageName = task.editor_page_name;
  config.editorBackfill.scope = task.scope;
  const pageRoot = path.join(baseConfig.batch.pagesStateDir, batchState.run_id);
  const artifactRoot = path.join(baseConfig.batch.artifactsDir, batchState.run_id, task.id);
  const reportRoot = path.join(baseConfig.batch.reportsDir, batchState.run_id, task.id);
  config.paths.stateFile = path.join(pageRoot, `${task.id}.json`);
  config.paths.artifactsDir = artifactRoot;
  config.paths.reportsDir = reportRoot;
  task.page_state_file = config.paths.stateFile;
  task.page_artifacts_dir = artifactRoot;
  task.page_reports_dir = reportRoot;
  return config;
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function writeGrowthEngineBatchReports(state, reportsRoot) {
  const runDirectory = path.join(reportsRoot, state.run_id);
  await mkdir(runDirectory, { recursive: true });
  const pageColumns = [
    "id", "scope", "editor_page_name", "target_page_path", "source_item_count",
    "growth_engine_item_count", "status", "preview_status", "editor_backfill_status",
    "failure_reason", "started_at", "completed_at", "page_reports_dir",
  ];
  const pageLines = [pageColumns.join(",")];
  const allItems = [];
  for (const task of state.tasks) {
    pageLines.push(pageColumns.map((column) => csvCell(task[column])).join(","));
    if (!task.page_state_file) continue;
    const pageState = await new GrowthEngineStateStore(task.page_state_file).load().catch(() => null);
    if (pageState?.items) allItems.push(...pageState.items);
  }
  const nonEditable = allItems.filter((item) => !item.level_editable || !item.text_editable);
  const editFailures = allItems.filter((item) =>
    ["edit_not_effective", "edit_failed"].includes(item.level_edit_status) ||
    ["edit_not_effective", "edit_failed"].includes(item.text_edit_status) ||
    ["save_not_available", "save_failed", "failed"].includes(item.save_status) ||
    item.sync_status === "failed",
  );
  const rows = state.tasks.map((task) => `<tr>
    <td>${escapeHtml(task.id)}</td><td>${escapeHtml(task.editor_page_name)}</td>
    <td>${escapeHtml(task.target_page_path)}</td><td>${escapeHtml(task.growth_engine_item_count)}</td>
    <td><code>${escapeHtml(task.preview_status)}</code></td>
    <td><code>${escapeHtml(task.editor_backfill_status)}</code></td>
    <td><code>${escapeHtml(task.status)}</code></td><td>${escapeHtml(task.failure_reason)}</td>
  </tr>`).join("");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>增长引擎H标签批量报告</title>
  <style>body{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#1f2937}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e5e7eb;padding:8px;text-align:left}th{background:#f8fafc}</style>
  </head><body><h1>增长引擎H标签批量报告</h1><p>批次：${escapeHtml(state.run_id)}；范围：${escapeHtml(state.scope)}；阶段：${escapeHtml(state.phase)}</p>
  <table><thead><tr><th>任务</th><th>编辑器页面</th><th>增长引擎路径</th><th>H项数</th><th>预览</th><th>编辑器回填</th><th>最终状态</th><th>原因</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  await Promise.all([
    writeFile(path.join(runDirectory, "growth-engine-h-batch-pages.csv"), `\uFEFF${pageLines.join("\r\n")}\r\n`, "utf8"),
    writeFile(path.join(runDirectory, "growth-engine-h-batch-results.csv"), growthEngineCsv(allItems), "utf8"),
    writeFile(path.join(runDirectory, "growth-engine-h-batch-non-editable.csv"), growthEngineCsv(nonEditable), "utf8"),
    writeFile(path.join(runDirectory, "growth-engine-h-batch-edit-failures.csv"), growthEngineCsv(editFailures), "utf8"),
    writeFile(path.join(runDirectory, "growth-engine-h-batch-editor-backfill.csv"), growthEngineCsv(allItems), "utf8"),
    writeFile(path.join(runDirectory, "growth-engine-h-batch-report.html"), html, "utf8"),
  ]);
  return runDirectory;
}
