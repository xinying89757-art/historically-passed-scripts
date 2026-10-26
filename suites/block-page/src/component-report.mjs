import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { toCsv } from "./report.mjs";

export const COMPONENT_REPORT_COLUMNS = [
  "excel_row",
  "original_name",
  "chinese_name",
  "sequence",
  "page_name",
  "page_path",
  "page_url",
  "slot_index",
  "setting_id",
  "component_kind",
  "expected_title",
  "actual_title",
  "expected_level",
  "actual_level",
  "expected_code",
  "expected_headings",
  "expected_editors",
  "expected_tab_title",
  "expected_heading_count",
  "required_tokens",
  "actual_code",
  "actual_headings",
  "actual_editors",
  "actual_tokens",
  "heading_count",
  "end_date",
  "status",
  "failure_reason",
  "attempt_count",
  "component_saved_at",
  "page_saved_at",
  "screenshot",
];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function buildComponentHtmlReport(state) {
  const counts = {};
  for (const record of state.records) {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
  }
  const cards = Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([status, count]) =>
        `<div class="card"><span>${escapeHtml(status)}</span><strong>${count}</strong></div>`,
    )
    .join("");
  const rows = state.records
    .map(
      (record) => {
        const expected = record.component_kind === "custom_code"
          ? `代码 H2～H6（${record.expected_heading_count ?? 0} 个）`
          : record.component_kind === "rich_text_dialog"
            ? `富文本 H2（${record.expected_heading_count ?? 0} 个）`
            : `${record.expected_title} / ${record.expected_level}`;
        const actual = ["custom_code", "rich_text_dialog"].includes(
          record.component_kind,
        )
          ? `回填 ${record.heading_count ?? 0} 个`
          : `${record.actual_title ?? ""} / ${record.actual_level ?? ""}`;
        return `<tr><td>${record.excel_row}</td><td>${escapeHtml(record.original_name)}</td><td>${escapeHtml(record.component_kind)}</td><td>${escapeHtml(expected)}</td><td>${escapeHtml(actual)}</td><td>${escapeHtml(record.page_name)}</td><td>${escapeHtml(record.slot_index)}</td><td><code>${escapeHtml(record.status)}</code></td><td>${escapeHtml(record.failure_reason)}</td></tr>`;
      },
    )
    .join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>3.0组件 H 标签自动化报告</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#1f2937}h1{font-size:24px}.summary{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}.card{border:1px solid #dbe3ee;border-radius:10px;padding:12px 16px;min-width:150px}.card span{display:block;color:#64748b}.card strong{font-size:24px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e5e7eb;padding:8px;text-align:left}th{position:sticky;top:0;background:#f8fafc}code{font-size:12px}</style></head><body><h1>3.0组件铺页及 H 标签配置报告</h1><p>更新时间：${escapeHtml(state.updated_at)}；已确认页面：${state.pages.length}</p><section class="summary">${cards}</section><table><thead><tr><th>Excel行</th><th>组件</th><th>类型</th><th>预期</th><th>实际</th><th>页面</th><th>位置</th><th>状态</th><th>原因</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

export async function writeComponentReports(state, reportsDir) {
  await mkdir(reportsDir, { recursive: true });
  const mapping = state.records.filter((record) => record.status === "configured");
  const failures = state.records.filter(
    (record) =>
      !["configured", "pending", "staged", "skipped_detail", "skipped_h_unsupported"].includes(
        record.status,
      ),
  );
  await Promise.all([
    writeFile(
      path.join(reportsDir, "component-page-mapping.csv"),
      toCsv(mapping, COMPONENT_REPORT_COLUMNS),
      "utf8",
    ),
    writeFile(
      path.join(reportsDir, "component-failures.csv"),
      toCsv(failures, COMPONENT_REPORT_COLUMNS),
      "utf8",
    ),
    writeFile(
      path.join(reportsDir, "component-report.html"),
      buildComponentHtmlReport(state),
      "utf8",
    ),
  ]);
}
