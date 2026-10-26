import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { toCsv } from "./report.mjs";

const INVENTORY_COLUMNS = ["page_name", "page_path", "slot_index", "block_id", "app_name", "editor_dom_id", "status", "rich_text_count", "prepared_count", "verified_count", "failure_reason"];
const RESULT_COLUMNS = ["page_name", "slot_index", "block_id", "app_name", "editor_dom_id", "editor_index", "field_name", "original_text", "original_level", "expected_text", "expected_level", "actual_text", "actual_level", "status", "failure_reason"];

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function flattenV4RichTextResults(state) {
  return state.records.flatMap((record) => record.editors.map((item) => ({
    page_name: state.page_name,
    slot_index: record.slot_index,
    block_id: record.block_id,
    app_name: record.app_name,
    editor_dom_id: record.editor_dom_id,
    ...item,
  })));
}

export function buildV4RichTextHtml(state) {
  const verified = state.records.filter((item) => item.status === "verified").length;
  const unsupported = state.records.filter((item) => item.status.startsWith("unsupported_")).length;
  const failures = state.records.length - verified - unsupported;
  const results = flattenV4RichTextResults(state);
  const headingVerified = results.filter((item) => item.status === "verified").length;
  const rows = state.records.map((record) => `<tr><td>${record.slot_index}</td><td>${escapeHtml(record.block_id)}</td><td>${escapeHtml(record.app_name)}</td><td>${record.rich_text_count}</td><td>${escapeHtml(record.status)}</td><td>${escapeHtml(record.failure_reason)}</td></tr>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>4.0富文本H2数据准备报告</title><style>body{font:14px/1.55 system-ui,sans-serif;margin:28px;color:#1f2937}.cards{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}.card{border:1px solid #dbe3ee;border-radius:10px;padding:12px 16px;min-width:150px}.card b{display:block;font-size:24px}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top}th{background:#f8fafc}</style></head><body><h1>4.0富文本H2数据准备报告</h1><p>页面：${escapeHtml(state.page_name)}（${escapeHtml(state.page_path)}）。本轮只准备编辑器测试数据，不执行增长引擎、不发布。</p><div class="cards"><div class="card">验证通过区块<b>${verified}</b></div><div class="card">不支持区块<b>${unsupported}</b></div><div class="card">验证通过富文本<b>${headingVerified}</b></div><div class="card">异常区块<b>${failures}</b></div></div><p>页面保存：${escapeHtml(state.page_saved_at || "未保存")}；重开验证：${escapeHtml(state.reopen_verified_at || "未完成")}；增长引擎：按用户要求暂缓。</p><table><thead><tr><th>槽位</th><th>区块ID</th><th>区块名称</th><th>富文本数</th><th>状态</th><th>原因</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

export async function writeV4RichTextReports(state, reportsDir) {
  await mkdir(reportsDir, { recursive: true });
  const inventory = state.records.map((record) => ({ page_name: state.page_name, page_path: state.page_path, ...record }));
  const results = flattenV4RichTextResults(state);
  const unsupported = state.records.filter((record) => record.status.startsWith("unsupported_")).map((record) => ({ page_name: state.page_name, page_path: state.page_path, ...record }));
  const deferredColumns = ["page_name", "page_path", "status", "reason"];
  const deferred = [{ page_name: state.page_name, page_path: state.page_path, status: "deferred_by_user", reason: "本轮仅准备4.0编辑器富文本H2数据" }];
  await Promise.all([
    writeFile(path.join(reportsDir, "v4-rich-text-inventory.csv"), toCsv(inventory, INVENTORY_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-test-data-results.csv"), toCsv(results, RESULT_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-unsupported.csv"), toCsv(unsupported, INVENTORY_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-growth-engine-results.csv"), toCsv(deferred, deferredColumns), "utf8"),
    writeFile(path.join(reportsDir, "v4-editor-backfill-results.csv"), toCsv(deferred, deferredColumns), "utf8"),
    writeFile(path.join(reportsDir, "v4-rich-text-report.html"), buildV4RichTextHtml(state), "utf8"),
  ]);
}

