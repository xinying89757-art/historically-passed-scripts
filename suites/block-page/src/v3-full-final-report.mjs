import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { toCsv } from "./report.mjs";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function finalClass(record) {
  if (record.heading_status === "configured_verified") return "configured_verified";
  if (record.heading_status === "unsupported_no_h_control") return "unsupported_no_h_control";
  if (record.status === "existing_mapping_missing") return "existing_mapping_missing";
  if (record.status === "not_found" || record.status === "add_failed") return "not_added";
  if (record.heading_status === "heading_failed" || record.heading_status === "save_failed") return "heading_failed";
  return record.heading_status || record.status || "unknown";
}

function reason(record) {
  return record.heading_failure_reason || record.failure_reason || "";
}

const RESULT_COLUMNS = [
  "block_id", "app_name", "template_types", "status", "heading_status", "final_class",
  "page_name", "page_url", "slot_index", "editor_dom_id", "heading_count", "reason", "heading_verified_at",
];

export async function writeV3FullFinalReports(state, reportsDir) {
  await mkdir(reportsDir, { recursive: true });
  const records = state.records.map((record) => ({
    ...record,
    final_class: finalClass(record),
    heading_count: (record.heading_results ?? []).length,
    reason: reason(record),
  }));
  const verified = records.filter((record) => record.final_class === "configured_verified");
  const pageMap = new Map();
  for (const record of verified) {
    if (record.page_url) pageMap.set(record.page_url, record);
  }
  const pageLinks = [...pageMap.keys()].sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  const pageGroups = new Map();
  for (const record of records.filter((item) => ["existing_added", "added_new"].includes(item.status))) {
    if (!record.page_url) continue;
    if (!pageGroups.has(record.page_url)) pageGroups.set(record.page_url, []);
    pageGroups.get(record.page_url).push(record);
  }
  const allSuccessLinks = pageLinks.filter((url) => pageGroups.get(url)?.every((record) => record.final_class === "configured_verified"));
  const failures = records.filter((record) => ["heading_failed", "existing_mapping_missing", "not_added"].includes(record.final_class));
  const unsupported = records.filter((record) => record.final_class === "unsupported_no_h_control");
  const counts = records.reduce((result, record) => {
    result[record.final_class] = (result[record.final_class] ?? 0) + 1;
    return result;
  }, {});
  const failureRows = failures.slice(0, 1000).map((record) => `<tr><td>${escapeHtml(record.block_id)}</td><td>${escapeHtml(record.app_name)}</td><td>${escapeHtml(record.final_class)}</td><td>${escapeHtml(record.page_name)}</td><td>${escapeHtml(record.page_url)}</td><td>${escapeHtml(record.reason)}</td></tr>`).join("");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>3.0全量区块最终结果</title><style>body{font:14px/1.5 system-ui;margin:28px;color:#1f2937}.cards{display:flex;gap:10px;flex-wrap:wrap}.card{border:1px solid #dbe3ee;border-radius:8px;padding:10px 14px}.card b{font-size:22px;display:block}table{border-collapse:collapse;width:100%;margin-top:20px}td,th{padding:7px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top}</style></head><body><h1>3.0全量区块最终结果</h1><p>更新时间：${escapeHtml(state.updated_at)}</p><section class="cards">${Object.entries(counts).map(([key, value]) => `<div class="card"><span>${escapeHtml(key)}</span><b>${value}</b></div>`).join("")}</section><p>成功区块页面：${pageLinks.length}；全部成功页面：${allSuccessLinks.length}</p><table><thead><tr><th>区块ID</th><th>名称</th><th>最终分类</th><th>页面</th><th>页面链接</th><th>原因</th></tr></thead><tbody>${failureRows}</tbody></table></body></html>`;
  const summary = {
    updated_at: state.updated_at,
    source_rows: state.source_rows,
    unique_count: state.unique_count,
    target_count: state.target_count,
    excluded_count: state.excluded_count,
    counts,
    verified_page_count: pageLinks.length,
    all_success_page_count: allSuccessLinks.length,
    verified_block_count: verified.length,
    retried_count: state.retry_mode?.reset_records?.length ?? 0,
  };
  await Promise.all([
    writeFile(path.join(reportsDir, "v3-final-result-list.csv"), toCsv(records, RESULT_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v3-final-success-blocks.csv"), toCsv(verified, RESULT_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v3-final-failures.csv"), toCsv(failures, RESULT_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v3-final-unsupported.csv"), toCsv(unsupported, RESULT_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v3-final-page-links.txt"), `${pageLinks.join("\n")}\n`, "utf8"),
    writeFile(path.join(reportsDir, "v3-final-page-links-all-success.txt"), `${allSuccessLinks.join("\n")}\n`, "utf8"),
    writeFile(path.join(reportsDir, "v3-final-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8"),
    writeFile(path.join(reportsDir, "v3-final-report.html"), html, "utf8"),
  ]);
  return { ...summary, reportsDir, pageLinksPath: path.join(reportsDir, "v3-final-page-links.txt") };
}
