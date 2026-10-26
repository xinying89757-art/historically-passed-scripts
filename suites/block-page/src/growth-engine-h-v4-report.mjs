import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ITEM_COLUMNS = [
  "run_id", "page_path", "item_index", "block_id", "app_name", "slot_index",
  "editor_dom_id", "editor_index", "field_name", "source_text", "original_level",
  "original_text", "level_editable", "text_editable", "mapping_status",
  "readonly_copy_count", "expected_level", "expected_text", "level_edit_status",
  "text_edit_status", "save_status", "sync_status", "verification_status",
  "failure_reason", "growth_engine_reentry_status", "growth_engine_actual_level",
  "growth_engine_actual_text", "growth_engine_reentry_failure_reason",
  "editor_actual_level", "editor_actual_text",
  "editor_backfill_status", "editor_backfill_failure_reason",
];

function cell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows, columns) {
  return `\uFEFF${[columns.join(","), ...rows.map((row) => columns.map((column) => cell(row[column])).join(","))].join("\r\n")}\r\n`;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function expandReadonlyCopies(items = []) {
  return items.flatMap((item) => Array.from(
    { length: Number(item.readonly_copy_count || 0) },
    (_, index) => ({
      ...item,
      item_index: `${item.item_index}-只读副本${index + 1}`,
      level_editable: false,
      text_editable: false,
      mapping_status: "readonly_copy",
      readonly_copy_count: 0,
      expected_level: item.original_level,
      expected_text: item.source_text || item.original_text,
      level_edit_status: "not_editable",
      text_edit_status: "not_editable",
      save_status: "not_applicable",
      sync_status: "not_applicable",
      verification_status: "not_editable",
      failure_reason: "增长引擎中的重复设置项为只读，级别和文字均不可编辑",
      editor_actual_level: "",
      editor_actual_text: "",
      editor_backfill_status: "not_applicable",
      editor_backfill_failure_reason: "",
    }),
  ));
}

function nonEditableFieldRecords(items = []) {
  return items
    .filter((item) => item.level_editable === false || item.text_editable === false)
    .map((item) => {
      const fields = [
        item.level_editable === false ? "标题级别" : "",
        item.text_editable === false ? "标题文字" : "",
      ].filter(Boolean);
      return {
        ...item,
        failure_reason: item.failure_reason || `增长引擎不可编辑字段：${fields.join("、")}`,
      };
    });
}

export async function writeV4GrowthEngineReports(state, reportsDir) {
  await mkdir(reportsDir, { recursive: true });
  const nonEditable = [
    ...nonEditableFieldRecords(state.items),
    ...expandReadonlyCopies(state.items),
  ];
  const backfillErrors = state.items.filter((item) => ["mismatch", "check_failed", "not_found", "locator_ambiguous"].includes(item.editor_backfill_status));
  const failures = state.items.filter((item) =>
    (item.growth_engine_reentry_status && !["verified", "not_applicable"].includes(item.growth_engine_reentry_status)) ||
    !["modified_verified", "partially_editable_verified", "not_editable"].includes(item.verification_status) ||
    !["verified", "not_applicable"].includes(item.editor_backfill_status));
  const problems = [
    ...nonEditable.map((item) => ({ ...item, issue_type: "growth_engine_not_editable" })),
    ...failures.map((item) => ({
      ...item,
      issue_type: item.growth_engine_reentry_status === "mismatch"
        ? "growth_engine_reentry_error"
        : ["mismatch", "check_failed", "not_found", "locator_ambiguous"].includes(item.editor_backfill_status)
        ? "editor_backfill_error"
        : "verification_failure",
    })),
  ];
  const issueColumns = ["issue_type", ...ITEM_COLUMNS];
  const unsupportedColumns = ["block_id", "app_name", "slot_index", "editor_dom_id", "editor_index", "field_name", "status", "reason"];
  const counts = {
    targets: state.items.length,
    modified_verified: state.items.filter((item) => item.verification_status === "modified_verified").length,
    non_editable: nonEditable.length,
    unsupported: state.unsupported.length,
    backfill_errors: backfillErrors.length,
    failures: failures.length,
    problems: problems.length,
  };
  const rows = state.items.map((item) => `<tr><td>${item.item_index}</td><td>${escapeHtml(item.block_id)}</td><td>${escapeHtml(item.field_name)}</td><td>${escapeHtml(item.expected_level)}/${escapeHtml(item.expected_text)}</td><td>${escapeHtml(item.verification_status)}</td><td>${escapeHtml(item.editor_backfill_status)}</td><td>${escapeHtml(item.failure_reason || item.editor_backfill_failure_reason)}</td></tr>`).join("");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>4.0增长引擎H标签试跑报告</title><style>body{font:14px/1.55 system-ui,sans-serif;margin:28px;color:#1f2937}.cards{display:flex;gap:12px;flex-wrap:wrap}.card{border:1px solid #dbe3ee;border-radius:10px;padding:12px 16px}.card b{display:block;font-size:24px}.notice{padding:10px 12px;background:#fff7ed;border:1px solid #fdba74;border-radius:8px}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:8px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top}th{background:#f8fafc}</style></head><body><h1>4.0增长引擎H标签试跑报告</h1><p>页面：${escapeHtml(state.page_name)}（${escapeHtml(state.page_path)}）；阶段：${escapeHtml(state.phase)}；首次刷新：${escapeHtml(state.initial_refresh?.status)}；预览整页：${escapeHtml(state.page_verification?.status)}；编辑器回填：${escapeHtml(state.editor_backfill_verification?.status)}</p><p class="notice">判定口径：增长引擎中任一标题级别或文字为只读、无法编辑，均计为测试问题。</p><div class="cards">${Object.entries(counts).map(([key, value]) => `<div class="card">${escapeHtml(key)}<b>${value}</b></div>`).join("")}</div><table><thead><tr><th>序号</th><th>区块</th><th>字段</th><th>预期</th><th>预览</th><th>4.0回填</th><th>原因</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  const outputs = [
    writeFile(path.join(reportsDir, "v4-growth-engine-h-results.csv"), csv(state.items, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-growth-engine-h-non-editable.csv"), csv(nonEditable, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-growth-engine-h-editor-backfill-errors.csv"), csv(backfillErrors, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-growth-engine-h-failures.csv"), csv(failures, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-growth-engine-h-issues.csv"), csv(problems, issueColumns), "utf8"),
    writeFile(path.join(reportsDir, "v4-growth-engine-h-unsupported.csv"), csv(state.unsupported, unsupportedColumns), "utf8"),
    writeFile(path.join(reportsDir, "v4-growth-engine-h-report.html"), html, "utf8"),
  ];
  if (state.no_refresh || state.initial_refresh?.status === "skipped") {
    // Stable, human-readable aliases for the standalone no-refresh batch.
    // Keep the historical English filenames above for backwards compatibility.
    outputs.push(
      writeFile(path.join(reportsDir, "4.0增长引擎按页面结果.csv"), csv([{
        run_id: state.run_id, page_name: state.page_name, page_path: state.page_path,
        preview_url: state.preview_url, preview_url_source: state.preview_url_source,
        preview_open_status: state.preview_open_status, preview_path_status: state.preview_path_status,
        preview_dom_status: state.preview_dom_status, preview_heading_count: state.preview_heading_count,
        scan_wait_status: state.scan_wait?.status,
        phase: state.phase, page_verification: state.page_verification?.status,
        growth_engine_reentry_verification: state.growth_engine_reentry_verification?.status,
        editor_backfill_verification: state.editor_backfill_verification?.status,
      }], ["run_id", "page_name", "page_path", "preview_url", "preview_url_source", "preview_open_status", "preview_path_status", "preview_dom_status", "preview_heading_count", "scan_wait_status", "phase", "growth_engine_reentry_verification", "page_verification", "editor_backfill_verification"]), "utf8"),
      writeFile(path.join(reportsDir, "4.0增长引擎H设置项结果.csv"), csv(state.items, ITEM_COLUMNS), "utf8"),
      writeFile(path.join(reportsDir, "4.0增长引擎不可编辑清单.csv"), csv(nonEditable, ITEM_COLUMNS), "utf8"),
      writeFile(path.join(reportsDir, "4.0增长引擎预览异常.csv"), csv(state.items.filter((item) => ["live_missing", "live_level_mismatch", "live_text_mismatch"].includes(item.verification_status)), ITEM_COLUMNS), "utf8"),
      writeFile(path.join(reportsDir, "4.0增长引擎编辑器回填异常.csv"), csv(backfillErrors, ITEM_COLUMNS), "utf8"),
      writeFile(path.join(reportsDir, "4.0增长引擎运行状态.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8"),
      writeFile(path.join(reportsDir, "4.0增长引擎核查报告.html"), html, "utf8"),
    );
  }
  await Promise.all(outputs);
  return { ...counts, reportsDir };
}

export { ITEM_COLUMNS as V4_GROWTH_ENGINE_REPORT_COLUMNS };
