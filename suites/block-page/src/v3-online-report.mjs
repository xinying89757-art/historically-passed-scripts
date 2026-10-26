import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { toCsv } from "./report.mjs";

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function flattenedHeadings(state) {
  return state.records.flatMap((record) => {
    const headings = record.heading_results ?? [];
    if (headings.length === 0) return [{ ...record, heading_index: "", kind: "", text: "", level: "" }];
    return headings.map((heading, index) => ({
      block_id: record.block_id,
      app_name: record.app_name,
      template_types: (record.template_types ?? []).join("、"),
      page_name: record.page_name,
      page_url: record.page_url,
      heading_index: index + 1,
      kind: heading.kind ?? "",
      text: heading.text ?? "",
      level: heading.level ?? "",
      heading_status: record.heading_status,
      heading_failure_reason: record.heading_failure_reason ?? "",
      heading_verified_at: record.heading_verified_at ?? "",
    }));
  });
}

function summary(state) {
  const count = (predicate) => state.records.filter(predicate).length;
  return {
    phase: state.phase,
    total: state.records.length,
    added: count((record) => ["added_new", "existing_added"].includes(record.status)),
    pending: count((record) => record.status === "pending"),
    notFound: count((record) => record.status === "not_found"),
    addFailed: count((record) => ["add_failed", "render_failed", "save_failed", "locator_ambiguous"].includes(record.status)),
    configured: count((record) => record.heading_status === "configured_verified"),
    unsupported: count((record) => record.heading_status === "unsupported_no_h_control"),
    headingFailed: count((record) => ["heading_failed", "save_failed"].includes(record.heading_status)),
  };
}

export async function writeOnlineReports(state, reportsDir) {
  await mkdir(reportsDir, { recursive: true });
  const mappingColumns = ["block_id", "app_name", "template_types", "source_row", "source_order", "site_name", "site_language", "public_base_url", "page_name", "page_url", "slot_index", "editor_dom_id", "status", "saved_at"];
  const headingColumns = ["block_id", "app_name", "template_types", "page_name", "page_url", "heading_index", "kind", "text", "level", "heading_status", "heading_failure_reason", "heading_verified_at"];
  const unsupportedColumns = ["block_id", "app_name", "template_types", "page_name", "page_url", "heading_status", "heading_warning", "heading_failure_reason"];
  const failureColumns = ["block_id", "app_name", "template_types", "page_name", "page_url", "status", "heading_status", "failure_reason", "heading_failure_reason", "attempt_count"];
  const mapping = state.records.map((record) => ({
    ...record,
    template_types: (record.template_types ?? []).join("、"),
    site_name: state.site?.site_name ?? "",
    site_language: state.site?.site_language ?? "",
    public_base_url: state.site?.public_base_url ?? "",
    source_order: record.first_source_order,
  }));
  const unsupported = state.records.filter((record) => record.heading_status === "unsupported_no_h_control");
  const failures = state.records.filter((record) =>
    ["not_found", "add_failed", "render_failed", "save_failed", "locator_ambiguous", "login_expired", "existing_mapping_missing"].includes(record.status) ||
    ["heading_failed", "save_failed", "login_expired"].includes(record.heading_status),
  );
  const counts = summary(state);
  const cards = Object.entries(counts).map(([key, value]) => `<div><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  const failedRows = failures.slice(0, 500).map((record) => `<tr><td>${escapeHtml(record.block_id)}</td><td>${escapeHtml(record.app_name)}</td><td>${escapeHtml(record.status)}</td><td>${escapeHtml(record.heading_status)}</td><td>${escapeHtml(record.failure_reason || record.heading_failure_reason || record.heading_warning)}</td></tr>`).join("");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>3.0上线区块测试报告</title><style>body{font:14px system-ui;margin:28px;color:#1f2937}.cards{display:flex;flex-wrap:wrap;gap:10px}.cards div{border:1px solid #dbe3ee;border-radius:9px;padding:10px 14px}.cards span{display:block;color:#64748b}.cards strong{font-size:22px}table{border-collapse:collapse;width:100%;margin-top:20px}th,td{padding:8px;border-bottom:1px solid #e5e7eb;text-align:left}</style></head><body><h1>3.0“上线”区块全量添加与H2测试数据</h1><p>网站：${escapeHtml(state.site?.site_name)} / ${escapeHtml(state.site?.site_language)} / ${escapeHtml(state.site?.public_base_url)}</p><p>更新时间：${escapeHtml(state.updated_at)}</p><section class="cards">${cards}</section><table><thead><tr><th>区块ID</th><th>名称</th><th>添加状态</th><th>H2状态</th><th>原因</th></tr></thead><tbody>${failedRows}</tbody></table></body></html>`;
  await Promise.all([
    writeFile(path.join(reportsDir, "v3-online-block-mapping.csv"), toCsv(mapping, mappingColumns), "utf8"),
    writeFile(path.join(reportsDir, "v3-online-heading-results.csv"), toCsv(flattenedHeadings(state), headingColumns), "utf8"),
    writeFile(path.join(reportsDir, "v3-online-unsupported.csv"), toCsv(unsupported, unsupportedColumns), "utf8"),
    writeFile(path.join(reportsDir, "v3-online-failures.csv"), toCsv(failures, failureColumns), "utf8"),
    writeFile(path.join(reportsDir, "v3-online-report.html"), html, "utf8"),
    writeFile(path.join(reportsDir, "v3-online-heading-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8"),
  ]);
  return counts;
}
