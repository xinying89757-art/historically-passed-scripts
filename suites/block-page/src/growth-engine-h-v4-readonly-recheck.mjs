import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadGrowthEngineConfig } from "./growth-engine-h-config.mjs";
import { GrowthEngineHPage, launchGrowthEngineContext } from "./growth-engine-h-editor.mjs";
import { normalizeText, numericRunId } from "./growth-engine-h-core.mjs";

const PROJECT_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_SOURCE = path.join(
  PROJECT_ROOT,
  "reports/growth-engine-h-v4-batch/20260821123246/v4-growth-engine-h-batch-issues.csv",
);
const DEFAULT_NON_EDITABLE = path.join(
  PROJECT_ROOT,
  "reports/growth-engine-h-v4-batch/20260821123246/v4-growth-engine-h-batch-non-editable.csv",
);

function parseCsv(text) {
  const source = text.replace(/^\uFEFF/u, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/u, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/u, ""));
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((key, index) => [key, values[index] ?? ""])));
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function csvText(rows, columns) {
  return `${columns.join(",")}\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")).join("\n")}\n`;
}

function parseArgs(argv) {
  const args = {
    config: "config/growth-engine-h-v4.json",
    source: DEFAULT_SOURCE,
    nonEditable: DEFAULT_NON_EDITABLE,
    runId: numericRunId(),
    limitPages: Number.POSITIVE_INFINITY,
    dryRun: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--config") args.config = argv[++index];
    else if (value === "--source") args.source = path.resolve(argv[++index]);
    else if (value === "--non-editable") args.nonEditable = path.resolve(argv[++index]);
    else if (value === "--run-id") args.runId = String(argv[++index]);
    else if (value === "--max-pages") args.limitPages = Number(argv[++index]);
    else if (value === "--dry-run") args.dryRun = true;
    else if (value === "--help") {
      console.log("node src/growth-engine-h-v4-readonly-recheck.mjs [--max-pages N] [--run-id ID]");
      process.exit(0);
    }
  }
  if (!(args.limitPages > 0)) throw new Error("--max-pages 必须大于0");
  return args;
}

async function readRows(file) {
  try {
    return parseCsv(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`读取历史问题清单失败：${file}；${error.message}`);
  }
}

function identity(row) {
  return [row.page_path, row.block_id, row.source_text || row.original_text, row.editor_index, row.field_name].join("|");
}

function buildTargets(issueRows, nonEditableRows) {
  const map = new Map();
  // Union the historical issue report and the dedicated non-editable report.
  // This preserves every block previously reported by the 4.0 batch without
  // inventing a new target when the two reports use different row granularity.
  for (const row of [...issueRows, ...nonEditableRows]) {
    if (!row.block_id || !row.page_path) continue;
    const key = identity(row);
    const extraTexts = [row.source_text, row.original_text, row.expected_text, row.editor_actual_text]
      .map((value) => normalizeText(value))
      .filter(Boolean);
    if (!map.has(key)) map.set(key, {
      prior_issue_type: row.issue_type || "growth_engine_not_editable",
      page_name: row.page_name || "",
      page_path: row.page_path,
      block_id: row.block_id,
      app_name: row.app_name || "",
      slot_index: row.slot_index || "",
      editor_dom_id: row.editor_dom_id || "",
      editor_index: row.editor_index || "",
      field_name: row.field_name || "",
      source_text: row.source_text || row.original_text || "",
      original_level: row.original_level || "",
      original_text: row.original_text || row.source_text || "",
      candidate_texts: extraTexts,
    });
    else {
      const existing = map.get(key);
      existing.candidate_texts = [...new Set([...(existing.candidate_texts || []), ...extraTexts])];
    }
  }
  return [...map.values()];
}

function pageConfig(baseConfig, pagePath, runId) {
  const config = structuredClone(baseConfig);
  config.targetPagePath = pagePath;
  config.pagePathCandidates = [pagePath];
  config.publicUrl = new URL(pagePath, baseConfig.publicUrl).toString();
  config.paths.artifactsDir = path.join(baseConfig.paths.artifactsDir, "readonly-recheck", runId);
  config.paths.reportsDir = path.join(baseConfig.paths.reportsDir, "readonly-recheck", runId);
  return config;
}

function makeErrorRow(target, status, reason, runId) {
  return {
    run_id: runId,
    page_path: target.page_path,
    page_name: target.page_name,
    block_id: target.block_id,
    app_name: target.app_name,
    slot_index: target.slot_index,
    editor_dom_id: target.editor_dom_id,
    editor_index: target.editor_index,
    field_name: target.field_name,
    source_text: target.source_text,
    prior_issue_type: target.prior_issue_type,
    current_status: status,
    current_level: "",
    current_text: "",
    level_editable: "",
    text_editable: "",
    mapping_status: "not_checked",
    failure_reason: reason,
    checked_at: new Date().toISOString(),
  };
}

function matchControls(targets, controls, runId) {
  const unused = controls.map((control, index) => ({ control, index, used: false }));
  const result = [];
  for (const target of targets) {
    const expectedTexts = new Set(target.candidate_texts || [normalizeText(target.source_text || target.original_text)]);
    const candidates = unused.filter((entry) => !entry.used && expectedTexts.has(normalizeText(entry.control.text)));
    // A duplicate text is safe to map by the stable dialog order only when
    // the old editor_index identifies the same occurrence. Otherwise report
    // ambiguity and never guess a different control.
    let selected = candidates;
    if (candidates.length > 1 && target.editor_index) {
      const occurrence = Number(target.editor_index) || 0;
      selected = candidates[occurrence - 1] ? [candidates[occurrence - 1]] : [];
    }
    if (selected.length !== 1) {
      result.push(makeErrorRow(target, selected.length > 1 ? "mapping_ambiguous" : "not_found", selected.length > 1
        ? `相同文字匹配到 ${selected.length} 个设置项，无法安全归属`
        : "刷新后的设置列表中未找到历史测试文字", runId));
      continue;
    }
    const entry = selected[0];
    entry.used = true;
    const control = entry.control;
    result.push({
      run_id: runId,
      page_path: target.page_path,
      page_name: target.page_name,
      block_id: target.block_id,
      app_name: target.app_name,
      slot_index: target.slot_index,
      editor_dom_id: target.editor_dom_id,
      editor_index: target.editor_index,
      field_name: target.field_name,
      source_text: target.source_text,
      prior_issue_type: target.prior_issue_type,
      current_status: control.levelEditable && control.textEditable ? "now_editable" : "still_readonly",
      current_level: control.level,
      current_text: control.text,
      level_editable: control.levelEditable,
      text_editable: control.textEditable,
      mapping_status: "mapped",
      failure_reason: "",
      checked_at: new Date().toISOString(),
    });
  }
  return result;
}

function aggregateBlocks(targets, itemRows, runId, pageResults) {
  const grouped = new Map();
  for (const target of targets) {
    const key = `${target.page_path}|${target.block_id}`;
    if (!grouped.has(key)) grouped.set(key, { target, items: [] });
    grouped.get(key).items.push(...itemRows.filter((row) => row.page_path === target.page_path && row.block_id === target.block_id && row.editor_index === target.editor_index && row.field_name === target.field_name));
  }
  return [...grouped.values()].map(({ target, items }) => {
    const statuses = items.map((item) => item.current_status);
    const status = statuses.includes("login_expired") ? "login_expired"
      : statuses.includes("page_not_found") ? "page_not_found"
        : statuses.includes("refresh_failed") ? "refresh_failed"
          : statuses.includes("automation_failed") ? "automation_failed"
            : statuses.includes("mapping_ambiguous") ? "mapping_ambiguous"
              : statuses.includes("not_found") ? "not_found"
                : statuses.includes("still_readonly") ? (statuses.includes("now_editable") ? "partially_readonly" : "still_readonly")
                  : "now_editable";
    const page = pageResults.get(target.page_path) || {};
    return {
      run_id: runId,
      page_path: target.page_path,
      page_name: target.page_name,
      page_url: page.preview_url || "",
      block_id: target.block_id,
      app_name: target.app_name,
      slot_index: target.slot_index,
      editor_dom_id: target.editor_dom_id,
      prior_item_count: items.length,
      still_readonly_count: items.filter((item) => item.current_status === "still_readonly").length,
      now_editable_count: items.filter((item) => item.current_status === "now_editable").length,
      not_found_count: items.filter((item) => ["not_found", "mapping_ambiguous"].includes(item.current_status)).length,
      current_status: status,
      failure_reason: items.map((item) => item.failure_reason).filter(Boolean).join("；"),
      checked_at: new Date().toISOString(),
    };
  });
}

function htmlReport(runId, summary) {
  const esc = (value) => String(value ?? "").replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  const rows = summary.blocks.map((row) => `<tr><td>${esc(row.block_id)}</td><td>${esc(row.app_name)}</td><td>${esc(row.page_path)}</td><td>${esc(row.current_status)}</td><td>${esc(row.still_readonly_count)}</td><td>${esc(row.failure_reason)}</td></tr>`).join("\n");
  return `<!doctype html><meta charset="utf-8"><title>4.0只读复核 ${esc(runId)}</title><style>body{font-family:Arial,"PingFang SC",sans-serif;margin:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px;text-align:left}th{background:#f3f5f7}.still_readonly{color:#b42318}</style><h1>4.0增长引擎不可编辑复核</h1><p>批次：${esc(runId)}；目标区块：${esc(summary.targetBlocks)}；仍只读：${esc(summary.stillReadonlyBlocks)}；已可编辑：${esc(summary.nowEditableBlocks)}；异常/未找到：${esc(summary.exceptionBlocks)}</p><table><thead><tr><th>区块ID</th><th>区块名称</th><th>页面路径</th><th>复核结果</th><th>仍只读项</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function run(args) {
  const baseConfig = await loadGrowthEngineConfig(args.config);
  const issueRows = await readRows(args.source);
  const nonEditableRows = await readRows(args.nonEditable);
  const targets = buildTargets(issueRows, nonEditableRows);
  const pages = [...new Set(targets.map((target) => target.page_path))].slice(0, args.limitPages);
  const selectedTargets = targets.filter((target) => pages.includes(target.page_path));
  if (args.dryRun) {
    console.log(JSON.stringify({
      sourceRows: issueRows.length + nonEditableRows.length,
      sourceUniqueBlocks: new Set(targets.map((target) => target.block_id)).size,
      targetBlocks: new Set(selectedTargets.map((target) => `${target.page_path}|${target.block_id}`)).size,
      targetItems: selectedTargets.length,
      pages,
    }, null, 2));
    return;
  }
  const reportDir = path.join(baseConfig.paths.reportsDir, "readonly-recheck", args.runId);
  const artifactDir = path.join(baseConfig.paths.artifactsDir, "readonly-recheck", args.runId);
  await mkdir(reportDir, { recursive: true });
  await mkdir(artifactDir, { recursive: true });
  const state = { version: 1, kind: "growth_engine_v4_readonly_recheck", run_id: args.runId, phase: "running", source: args.source, target_blocks: new Set(selectedTargets.map((target) => `${target.page_path}|${target.block_id}`)).size, pages, items: [], page_results: [] };
  const context = await launchGrowthEngineContext(baseConfig);
  try {
    for (const pagePath of pages) {
      const pageTargets = selectedTargets.filter((target) => target.page_path === pagePath);
      const config = pageConfig(baseConfig, pagePath, args.runId);
      const pageResult = { page_path: pagePath, page_name: pageTargets[0]?.page_name || "", status: "running", preview_url: "", checked_at: new Date().toISOString() };
      state.page_results.push(pageResult);
      console.log(`[4.0只读复核] ${pagePath}，目标 ${new Set(pageTargets.map((target) => target.block_id)).size} 个区块`);
      try {
        const editor = new GrowthEngineHPage(context, config);
        await editor.open();
        const previewUrl = await editor.readPreviewUrl().catch(() => "");
        pageResult.preview_url = previewUrl;
        await editor.refreshAndWait({ failureStatus: "refresh_failed" });
        const dialog = await editor.openEditDialog();
        const controls = await editor.inspectDialog(dialog);
        const rows = matchControls(pageTargets, controls, args.runId);
        await editor.cancelDialog(dialog);
        state.items.push(...rows);
        pageResult.status = "checked";
        pageResult.control_count = controls.length;
        pageResult.matched_count = rows.filter((row) => row.mapping_status === "mapped").length;
        console.log(`[4.0只读复核] ${pagePath} 完成，设置项 ${controls.length}，已匹配 ${pageResult.matched_count}`);
      } catch (error) {
        const message = error.message || String(error);
        pageResult.status = /login_expired|重新登录/u.test(message) ? "login_expired"
          : /refresh_failed/u.test(message) ? "refresh_failed"
            : /page_not_found|page_detail_unavailable/u.test(message) ? "page_not_found" : "automation_failed";
        pageResult.failure_reason = message;
        state.items.push(...pageTargets.map((target) => makeErrorRow(target, pageResult.status, message, args.runId)));
        console.error(`[4.0只读复核] ${pagePath}：${message}`);
        if (pageResult.status === "login_expired") {
          state.phase = "login_expired";
          break;
        }
      }
      await writeFile(path.join(reportDir, "v4-readonly-recheck-state.json"), JSON.stringify(state, null, 2));
    }
  } finally {
    await context.close().catch(() => {});
  }
  const pageResults = new Map(state.page_results.map((row) => [row.page_path, row]));
  const blocks = aggregateBlocks(selectedTargets, state.items, args.runId, pageResults);
  const itemsColumns = ["run_id", "page_path", "page_name", "block_id", "app_name", "slot_index", "editor_dom_id", "editor_index", "field_name", "source_text", "prior_issue_type", "current_status", "current_level", "current_text", "level_editable", "text_editable", "mapping_status", "failure_reason", "checked_at"];
  const blockColumns = ["run_id", "page_path", "page_name", "page_url", "block_id", "app_name", "slot_index", "editor_dom_id", "prior_item_count", "still_readonly_count", "now_editable_count", "not_found_count", "current_status", "failure_reason", "checked_at"];
  await writeFile(path.join(reportDir, "v4-readonly-recheck-items.csv"), csvText(state.items, itemsColumns));
  await writeFile(path.join(reportDir, "v4-readonly-recheck-blocks.csv"), csvText(blocks, blockColumns));
  const summary = {
    run_id: args.runId,
    phase: state.phase === "running" ? "completed" : state.phase,
    source_unique_blocks: new Set([...issueRows, ...nonEditableRows].map((row) => row.block_id).filter(Boolean)).size,
    targetBlocks: blocks.length,
    stillReadonlyBlocks: blocks.filter((row) => row.current_status === "still_readonly").length,
    nowEditableBlocks: blocks.filter((row) => row.current_status === "now_editable").length,
    exceptionBlocks: blocks.filter((row) => !["still_readonly", "now_editable"].includes(row.current_status)).length,
    checkedPages: state.page_results.filter((row) => row.status === "checked").length,
    failedPages: state.page_results.filter((row) => row.status !== "checked").length,
    blocks,
  };
  if (summary.exceptionBlocks > 0 && summary.phase === "completed") summary.phase = "completed_with_failures";
  await writeFile(path.join(reportDir, "v4-readonly-recheck-summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(path.join(reportDir, "v4-readonly-recheck-report.html"), htmlReport(args.runId, summary));
  state.phase = summary.phase;
  state.blocks = blocks;
  await writeFile(path.join(reportDir, "v4-readonly-recheck-state.json"), JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ ...summary, output: reportDir }, null, 2));
}

run(parseArgs(process.argv)).catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
