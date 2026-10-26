import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ITEM_COLUMNS = [
  "run_id", "page_name", "page_path", "page_url", "item_index", "item_key", "scenario",
  "setting_id", "node_id", "template_id", "position", "rule_id", "source_text",
  "original_level", "original_text", "level_editable", "text_editable", "expected_level",
  "expected_text", "validate_http", "validate_code", "update_http", "update_code",
  "update_item_status", "api_status", "preview_level", "preview_text", "preview_status",
  "editor_level", "editor_text", "editor_backfill_status", "status", "failure_reason",
  "request_evidence", "response_evidence", "screenshot", "checked_at",
];

function cell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csv(rows, columns) {
  return `\uFEFF${[columns.join(","), ...rows.map((row) => columns.map((column) => cell(row[column])).join(","))].join("\r\n")}\r\n`;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function buildOnPageAgentHtml(state) {
  const items = state.pages.flatMap((page) => page.items ?? []);
  const counts = items.reduce((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1;
    return result;
  }, {});
  const cards = Object.entries(counts).map(([status, count]) => `<div class="card"><span>${escapeHtml(status)}</span><strong>${count}</strong></div>`).join("");
  const rows = items.map((item) => `<tr><td>${escapeHtml(item.page_path)}</td><td>${item.item_index}</td><td>${escapeHtml(item.scenario)}</td><td>${escapeHtml(item.original_level)}</td><td>${escapeHtml(item.original_text)}</td><td>${escapeHtml(item.expected_level)}</td><td>${escapeHtml(item.expected_text)}</td><td>${escapeHtml(item.update_item_status)}</td><td>${escapeHtml(item.preview_level)}</td><td>${escapeHtml(item.preview_status)}</td><td>${escapeHtml(item.editor_backfill_status)}</td><td><code>${escapeHtml(item.status)}</code></td><td>${escapeHtml(item.failure_reason)}</td></tr>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>3.0新接口H标签专项报告</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#1f2937}.summary{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}.card{border:1px solid #dbe3ee;border-radius:10px;padding:12px 16px;min-width:150px}.card span{display:block;color:#64748b}.card strong{font-size:24px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e5e7eb;padding:8px;text-align:left;vertical-align:top}th{background:#f8fafc}code{font-size:12px}</style></head><body><h1>3.0新接口H标签专项报告</h1><p>批次：${escapeHtml(state.run_id)}；阶段：${escapeHtml(state.phase)}；增长引擎不回填最新值属于正常逻辑，本报告不对增长引擎回填做断言。</p><section class="summary">${cards}</section><table><thead><tr><th>页面</th><th>序号</th><th>场景</th><th>原级别</th><th>原文字</th><th>预期级别</th><th>预期文字</th><th>接口结果</th><th>预览级别</th><th>预览</th><th>编辑器回填</th><th>结论</th><th>原因</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

export function mergeSupplementalRunStates(primaryState, supplementalStates = []) {
  const result = structuredClone(primaryState);
  for (const supplemental of supplementalStates) {
    for (const supplementalPage of supplemental?.pages ?? []) {
      const page = result.pages.find((entry) => entry.page_path === supplementalPage.page_path);
      if (!page) {
        result.pages.push(structuredClone(supplementalPage));
        continue;
      }
      page.retest_run_ids = [...new Set([...(page.retest_run_ids ?? []), supplemental.run_id].filter(Boolean))];
      for (const supplementalItem of supplementalPage.items ?? []) {
        const index = page.items.findIndex((item) => item.item_key === supplementalItem.item_key && item.scenario === supplementalItem.scenario);
        if (index >= 0) page.items[index] = structuredClone(supplementalItem);
        else page.items.push(structuredClone(supplementalItem));
      }
      page.api_calls = [
        ...(page.api_calls ?? []),
        ...(supplementalPage.api_calls ?? []).map((call) => ({ ...structuredClone(call), run_id: supplemental.run_id })),
      ];
      page.preview_url = supplementalPage.preview_url || page.preview_url;
      page.preview_heading_count = supplementalPage.preview_heading_count ?? page.preview_heading_count;
      page.editor_backfill_status = page.items.some((item) => !["verified", "not_applicable", "disabled"].includes(item.editor_backfill_status)) ? "failed" : "verified";
      const failures = page.items.filter((item) => !["modified_verified", "partially_editable_verified", "field_not_editable"].includes(item.status));
      page.status = failures.length === 0 && page.unsubmitted_status === "verified" ? "complete" : "failed";
      page.failure_reason = failures.map((item) => `第${item.item_index}项：${item.failure_reason}`).join("；");
      page.checked_at = supplementalPage.checked_at || page.checked_at;
    }
  }
  result.phase = result.pages.every((page) => page.status === "complete") ? "complete" : "complete_with_failures";
  return result;
}

export async function writeOnPageAgentReports(state, reportsDir) {
  await mkdir(reportsDir, { recursive: true });
  const items = state.pages.flatMap((page) => page.items ?? []);
  const requests = state.pages.flatMap((page) => (page.api_calls ?? []).map((call) => ({
    run_id: call.run_id ?? page.run_id ?? state.run_id, page_path: page.page_path, stage: call.stage, method: call.method,
    url: call.url, http_status: call.http_status, business_code: call.business_code,
    request_file: call.request_file, response_file: call.response_file, checked_at: call.checked_at,
  })));
  const pageColumns = ["run_id", "page_name", "page_path", "page_url", "status", "captured_count", "submitted_count", "preview_url", "preview_heading_count", "unsubmitted_status", "editor_backfill_status", "failure_reason", "trace", "checked_at"];
  const requestColumns = ["run_id", "page_path", "stage", "method", "url", "http_status", "business_code", "request_file", "response_file", "checked_at"];
  const failures = items.filter((item) => !["modified_verified", "partially_editable_verified", "field_not_editable"].includes(item.status));
  const nonEditable = items.filter((item) => item.status === "field_not_editable");
  const previewFailures = items.filter((item) => !["verified", "not_applicable"].includes(item.preview_status));
  const editorFailures = items.filter((item) => !["verified", "not_applicable", "disabled"].includes(item.editor_backfill_status));
  await Promise.all([
    writeFile(path.join(reportsDir, "onpage-agent-v3-pages.csv"), csv(state.pages, pageColumns), "utf8"),
    writeFile(path.join(reportsDir, "onpage-agent-v3-items.csv"), csv(items, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "onpage-agent-v3-api-calls.csv"), csv(requests, requestColumns), "utf8"),
    writeFile(path.join(reportsDir, "onpage-agent-v3-non-editable.csv"), csv(nonEditable, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "onpage-agent-v3-failures.csv"), csv(failures, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "onpage-agent-v3-preview-failures.csv"), csv(previewFailures, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "onpage-agent-v3-editor-backfill-failures.csv"), csv(editorFailures, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "onpage-agent-v3-report.html"), buildOnPageAgentHtml(state), "utf8"),
    writeFile(path.join(reportsDir, "onpage-agent-v3-run-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8"),
  ]);
}

export { ITEM_COLUMNS as ONPAGE_AGENT_ITEM_COLUMNS };
