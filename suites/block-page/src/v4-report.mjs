import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { v4TargetForCategory } from "./v4-state.mjs";
import { toCsv } from "./report.mjs";

const COLUMNS = ["csv_row", "block_id", "app_name", "category", "candidate_rank", "page_name", "page_url", "slot_index", "editor_dom_id", "status", "failure_reason", "attempt_count", "saved_at"];

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function buildV4HtmlReport(state) {
  const attempted = state.records.filter((record) => record.status !== "standby");
  const counts = attempted.reduce((result, record) => { result[record.status] = (result[record.status] ?? 0) + 1; return result; }, {});
  const cards = Object.entries(counts).map(([status, count]) => `<div class="card"><span>${escapeHtml(status)}</span><strong>${count}</strong></div>`).join("");
  const rows = attempted.map((record) => `<tr><td>${record.csv_row}</td><td>${escapeHtml(record.block_id)}</td><td>${escapeHtml(record.app_name)}</td><td>${escapeHtml(record.category)}</td><td>${escapeHtml(record.candidate_rank)}</td><td>${escapeHtml(record.page_name)}</td><td>${escapeHtml(record.slot_index)}</td><td>${escapeHtml(record.status)}</td><td>${escapeHtml(record.failure_reason)}</td></tr>`).join("");
  const targetText = state.categories.map((category) => `${category}${v4TargetForCategory(state, category)}个`).join("，");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>4.0编辑器区块铺页报告</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:28px;color:#1f2937}.summary{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}.card{border:1px solid #dbe3ee;border-radius:10px;padding:10px 14px;min-width:120px}.card span{display:block;color:#64748b}.card strong{font-size:22px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e5e7eb;padding:8px;text-align:left;vertical-align:top}th{background:#f8fafc;position:sticky;top:0}</style></head><body><h1>4.0编辑器区块铺页报告</h1><p>页面数：${state.pages.length}；每页：${state.blocks_per_page}；分类目标：${targetText}；未发布。</p><section class="summary">${cards}</section><table><thead><tr><th>CSV行</th><th>区块ID</th><th>名称</th><th>分类</th><th>候选顺序</th><th>页面</th><th>槽位</th><th>状态</th><th>原因</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

export async function writeV4Reports(state, reportsDir) {
  await mkdir(reportsDir, { recursive: true });
  const mapping = state.records.filter((record) => record.status === "added");
  const failures = state.records.filter((record) => ["not_found", "add_failed", "render_failed", "save_failed", "locator_ambiguous", "login_expired"].includes(record.status));
  await Promise.all([
    writeFile(path.join(reportsDir, "v4-block-page-mapping.csv"), toCsv(mapping, COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-block-failures.csv"), toCsv(failures, COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-block-report.html"), buildV4HtmlReport(state), "utf8"),
  ]);
}
