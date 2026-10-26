import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { toCsv } from "./report.mjs";
import { summarizeV4RichTextBatch } from "./v4-rich-text-batch.mjs";

const INVENTORY_COLUMNS = ["page_name", "page_path", "category", "page_status", "slot_index", "block_id", "app_name", "editor_dom_id", "status", "rich_text_count", "prepared_count", "verified_count", "attempt_count", "failure_reason"];
const RESULT_COLUMNS = ["page_name", "page_path", "category", "slot_index", "block_id", "app_name", "editor_dom_id", "editor_index", "field_name", "original_text", "original_level", "expected_text", "expected_level", "actual_text", "actual_level", "status", "failure_reason"];

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function flattenV4RichTextBatch(state) {
  return state.pages.flatMap((page) => page.records.map((record) => ({
    page_name: page.name,
    page_path: page.path,
    category: page.category,
    page_status: page.status,
    ...record,
  })));
}

export function flattenV4RichTextBatchResults(state) {
  return state.pages.flatMap((page) => page.records.flatMap((record) => record.editors.map((editor) => ({
    page_name: page.name,
    page_path: page.path,
    category: page.category,
    slot_index: record.slot_index,
    block_id: record.block_id,
    app_name: record.app_name,
    editor_dom_id: record.editor_dom_id,
    ...editor,
  }))));
}

export function buildV4RichTextBatchHtml(state) {
  const summary = summarizeV4RichTextBatch(state);
  const pageRows = state.pages.map((page) => {
    const verified = page.records.filter((record) => record.status === "verified").length;
    const unsupported = page.records.filter((record) => record.status.startsWith("unsupported_")).length;
    const failed = page.records.length - verified - unsupported;
    return `<tr><td>${escapeHtml(page.name)}</td><td>${escapeHtml(page.category)}</td><td>${page.records.length}</td><td>${verified}</td><td>${unsupported}</td><td>${failed}</td><td>${escapeHtml(page.status)}</td><td>${escapeHtml(page.failure_reason)}</td></tr>`;
  }).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>4.0其余页面富文本H2批量报告</title><style>body{font:14px/1.55 system-ui,sans-serif;margin:28px;color:#1f2937}.cards{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}.card{border:1px solid #dbe3ee;border-radius:10px;padding:12px 16px;min-width:140px}.card b{display:block;font-size:24px}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top}th{background:#f8fafc}</style></head><body><h1>4.0其余页面富文本H2批量报告</h1><p>已排除完成页面：${escapeHtml(state.excluded_completed_page)}。本轮只准备H2测试数据，不执行增长引擎、不发布。</p><div class="cards"><div class="card">完成页面<b>${summary.completePages}/${summary.pages}</b></div><div class="card">验证区块<b>${summary.verifiedBlocks}</b></div><div class="card">不支持区块<b>${summary.unsupportedBlocks}</b></div><div class="card">验证富文本<b>${summary.verifiedRichTexts}</b></div></div><table><thead><tr><th>页面</th><th>分类</th><th>区块</th><th>验证</th><th>不支持</th><th>异常</th><th>状态</th><th>原因</th></tr></thead><tbody>${pageRows}</tbody></table></body></html>`;
}

export async function writeV4RichTextBatchReports(state, reportsDir) {
  await mkdir(reportsDir, { recursive: true });
  const inventory = flattenV4RichTextBatch(state);
  const results = flattenV4RichTextBatchResults(state);
  const unsupported = inventory.filter((record) => record.status.startsWith("unsupported_"));
  const failures = inventory.filter((record) => !["pending", "verified"].includes(record.status) && !record.status.startsWith("unsupported_"));
  await Promise.all([
    writeFile(path.join(reportsDir, "v4-rich-text-inventory.csv"), toCsv(inventory, INVENTORY_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-test-data-results.csv"), toCsv(results, RESULT_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-unsupported.csv"), toCsv(unsupported, INVENTORY_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-failures.csv"), toCsv(failures, INVENTORY_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-rich-text-batch-report.html"), buildV4RichTextBatchHtml(state), "utf8"),
  ]);
}

