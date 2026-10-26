import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { toCsv } from "./report.mjs";
import { summarizeV3FullState } from "./v3-full-state.mjs";

const MAPPING_COLUMNS = ["block_id", "app_name", "template_types", "page_name", "page_url", "slot_index", "editor_dom_id", "status", "placement_origin", "saved_at"];
const EXCLUDED_COLUMNS = ["block_id", "app_name", "template_types", "source_files", "status", "exclusion_reason"];
const HEADING_COLUMNS = ["block_id", "app_name", "template_types", "page_name", "heading_status", "heading_index", "kind", "text", "level", "heading_failure_reason", "heading_verified_at"];
const FAILURE_COLUMNS = ["block_id", "app_name", "template_types", "page_name", "status", "heading_status", "failure_reason", "heading_failure_reason", "attempt_count"];

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function headingRows(state) {
  return state.records.flatMap((record) => {
    const headings = record.heading_results ?? [];
    if (headings.length === 0) return [{ ...record, heading_index: "", kind: "", text: "", level: "" }];
    return headings.map((heading, index) => ({
      ...record,
      heading_index: index + 1,
      kind: heading.kind ?? "",
      text: heading.text ?? "",
      level: heading.level ?? "",
    }));
  });
}

export async function writeV3FullReports(state, reportsDir) {
  await mkdir(reportsDir, { recursive: true });
  const mapping = state.records.filter((record) => ["existing_added", "added_new", "configured_verified", "existing_mapping_missing"].includes(record.status));
  const unsupported = state.records.filter((record) => record.heading_status === "unsupported_no_h_control");
  const failures = state.records.filter((record) =>
    ["existing_mapping_missing", "not_found", "locator_ambiguous", "add_failed", "render_failed", "save_failed", "login_expired"].includes(record.status) ||
    ["heading_failed", "save_failed", "login_expired"].includes(record.heading_status),
  );
  const summary = summarizeV3FullState(state);
  const statusCounts = state.records.reduce((result, record) => {
    result[record.status] = (result[record.status] ?? 0) + 1;
    return result;
  }, {});
  const cards = Object.entries({ ...summary, ...statusCounts }).map(([key, value]) => `<div><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  const rows = failures.slice(0, 500).map((record) => `<tr><td>${escapeHtml(record.block_id)}</td><td>${escapeHtml(record.app_name)}</td><td>${escapeHtml(record.status)}</td><td>${escapeHtml(record.heading_status)}</td><td>${escapeHtml(record.failure_reason || record.heading_failure_reason)}</td></tr>`).join("");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>3.0本期H区块报告</title><style>body{font:14px system-ui;margin:28px;color:#1f2937}.cards{display:flex;flex-wrap:wrap;gap:10px}.cards div{border:1px solid #dbe3ee;border-radius:9px;padding:10px 14px}.cards span{display:block;color:#64748b}.cards strong{font-size:22px}table{border-collapse:collapse;width:100%;margin-top:20px}th,td{padding:8px;border-bottom:1px solid #e5e7eb;text-align:left}</style></head><body><h1>3.0全量支持区块铺页与H2测试数据</h1><p>更新时间：${escapeHtml(state.updated_at)}</p><section class="cards">${cards}</section><table><thead><tr><th>区块ID</th><th>名称</th><th>添加状态</th><th>H状态</th><th>原因</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  await Promise.all([
    writeFile(path.join(reportsDir, "v3-full-block-mapping.csv"), toCsv(mapping, MAPPING_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v3-full-excluded.csv"), toCsv(state.excluded, EXCLUDED_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v3-full-heading-results.csv"), toCsv(headingRows(state), HEADING_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v3-full-unsupported.csv"), toCsv(unsupported, FAILURE_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v3-full-failures.csv"), toCsv(failures, FAILURE_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "report.html"), html, "utf8"),
  ]);
}
