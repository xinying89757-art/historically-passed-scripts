import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const COLUMNS = [
  "run_id", "page_path", "item_index", "source_text", "original_level", "original_text",
  "level_editable", "text_editable", "expected_level", "expected_text",
  "requested_level", "requested_text", "level_edit_status", "text_edit_status", "edit_failure_reason",
  "save_status", "sync_status", "live_level", "live_text",
  "verification_status", "failure_reason", "editor_page_name",
  "editor_element_type", "editor_setting_id", "editor_canvas_level",
  "editor_actual_level", "editor_actual_text", "editor_backfill_status",
  "editor_backfill_evidence", "editor_backfill_failure_reason",
];

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function growthEngineCsv(items) {
  const lines = [COLUMNS.join(",")];
  for (const item of items) {
    lines.push(COLUMNS.map((column) => csvCell(item[column])).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function buildGrowthEngineHtml(state) {
  const counts = state.items.reduce((result, item) => {
    const key = item.verification_status;
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
  const cards = Object.entries(counts).map(([status, count]) =>
    `<div class="card"><span>${escapeHtml(status)}</span><strong>${count}</strong></div>`,
  ).join("");
  const rows = state.items.map((item) => `<tr>
    <td>${item.item_index}</td><td>${escapeHtml(item.source_text)}</td><td>${escapeHtml(item.original_level)}</td>
    <td>${escapeHtml(item.original_text)}</td><td>${escapeHtml(item.expected_level)}</td>
    <td>${escapeHtml(item.expected_text)}</td><td>${item.level_editable ? "是" : "否"}/${item.text_editable ? "是" : "否"}</td>
    <td>${escapeHtml(item.editor_actual_level)}</td><td>${escapeHtml(item.editor_actual_text)}</td>
    <td><code>${escapeHtml(item.editor_backfill_status)}</code></td><td>${escapeHtml(item.editor_backfill_failure_reason)}</td>
    <td><code>${escapeHtml(item.verification_status)}</code></td><td>${escapeHtml(item.failure_reason)}</td>
  </tr>`).join("");
  const differences = (state.page_verification?.differences ?? [])
    .map((difference) => `<li>${escapeHtml(difference)}</li>`).join("");
  const baselineDifferences = (state.baseline_comparison?.differences ?? [])
    .map((difference) => `<li>${escapeHtml(difference)}</li>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>增长引擎 H 标签同步报告</title><style>
  body{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#1f2937}h1{font-size:24px}.summary{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}
  .card{border:1px solid #dbe3ee;border-radius:10px;padding:12px 16px;min-width:150px}.card span{display:block;color:#64748b}.card strong{font-size:24px}
  table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e5e7eb;padding:8px;text-align:left;vertical-align:top}th{background:#f8fafc}code{font-size:12px}
  </style></head><body><h1>增长引擎 H 标签同步报告</h1>
  <p>页面：${escapeHtml(state.page_path)}；批次：${escapeHtml(state.run_id)}；阶段：${escapeHtml(state.phase)}；编辑器回填：${escapeHtml(state.editor_backfill_verification?.status)}；预览整页对账：${escapeHtml(state.page_verification?.status)}</p>
  <p>预览地址：${escapeHtml(state.preview_url || state.public_url)}；来源：${escapeHtml(state.preview_source || "unknown")}；HTTP：${escapeHtml(state.preview_http_status || "未知")}；扫描等待：${escapeHtml(state.scan_wait_status || "未知")}</p>
  <section class="summary">${cards}</section>${baselineDifferences ? `<h2>初始基线差异（已记录，未阻断写入）</h2><ul>${baselineDifferences}</ul>` : ""}${differences ? `<h2>整页差异</h2><ul>${differences}</ul>` : ""}
  <table><thead><tr><th>序号</th><th>组件/区块来源文字</th><th>原级别</th><th>原文字</th><th>预期级别</th><th>预期文字</th><th>级别/文字可编辑</th><th>编辑器实际级别</th><th>编辑器实际文字</th><th>编辑器回填</th><th>编辑器原因</th><th>预览结果</th><th>预览原因</th></tr></thead><tbody>${rows}</tbody></table>
  </body></html>`;
}

export async function writeGrowthEngineReports(state, reportsDir) {
  await mkdir(reportsDir, { recursive: true });
  const nonEditable = state.items.filter((item) => !item.level_editable || !item.text_editable);
  const failures = state.items.filter((item) => ![
    "modified_verified", "partially_editable_verified", "not_editable",
  ].includes(item.verification_status) || ![
    "verified", "not_applicable", "disabled",
  ].includes(item.editor_backfill_status));
  const editFailures = state.items.filter((item) =>
    ["edit_not_effective", "edit_failed"].includes(item.level_edit_status) ||
    ["edit_not_effective", "edit_failed"].includes(item.text_edit_status) ||
    ["save_not_available", "save_failed", "failed"].includes(item.save_status) ||
    item.sync_status === "failed",
  );
  await Promise.all([
    writeFile(path.join(reportsDir, "growth-engine-h-results.csv"), growthEngineCsv(state.items), "utf8"),
    writeFile(path.join(reportsDir, "growth-engine-h-non-editable.csv"), growthEngineCsv(nonEditable), "utf8"),
    writeFile(path.join(reportsDir, "growth-engine-h-failures.csv"), growthEngineCsv(failures), "utf8"),
    writeFile(path.join(reportsDir, "growth-engine-h-edit-failures.csv"), growthEngineCsv(editFailures), "utf8"),
    writeFile(path.join(reportsDir, "growth-engine-h-editor-backfill.csv"), growthEngineCsv(state.items), "utf8"),
    writeFile(path.join(reportsDir, "growth-engine-h-report.html"), buildGrowthEngineHtml(state), "utf8"),
  ]);
}

export { COLUMNS as GROWTH_ENGINE_REPORT_COLUMNS };
