import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { toCsv } from "./report.mjs";
import { summarizeV4Mirror } from "./v4-mirror.mjs";

const BLOCK_COLUMNS = [
  "page_name", "page_path", "category", "page_status", "slot_index", "block_id", "app_name",
  "source_editor_dom_id", "target_editor_dom_id", "block_status", "rich_text_status",
  "expected_rich_text_status", "expected_rich_text_count", "verified_rich_text_count",
  "attempt_count", "failure_reason", "block_saved_at", "rich_text_saved_at", "verified_at",
];

const RICH_COLUMNS = [
  "page_name", "page_path", "category", "slot_index", "block_id", "app_name",
  "target_editor_dom_id", "editor_index", "field_name", "expected_text", "expected_level",
  "actual_text", "actual_level", "status", "failure_reason",
];

const EXTRA_COLUMNS = [
  "page_name", "page_path", "category", "block_id", "app_name", "slot_index",
  "editor_dom_id", "status", "discovered_at",
];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function flattenMirrorBlocks(state) {
  return state.pages.flatMap((page) => page.records.map((record) => ({
    page_name: page.name,
    page_path: page.path,
    category: page.category,
    page_status: page.status,
    ...record,
  })));
}

export function flattenMirrorRichTexts(state) {
  return state.pages.flatMap((page) => page.records.flatMap((record) =>
    (record.editors ?? []).map((editor) => ({
      page_name: page.name,
      page_path: page.path,
      category: page.category,
      slot_index: record.slot_index,
      block_id: record.block_id,
      app_name: record.app_name,
      target_editor_dom_id: record.target_editor_dom_id,
      ...editor,
    })),
  ));
}

export function flattenMirrorExtras(state) {
  return state.pages.flatMap((page) => (page.existing_extra_blocks ?? []).map((record) => ({
    page_name: page.name,
    page_path: page.path,
    category: page.category,
    ...record,
  })));
}

export function buildV4MirrorHtml(state) {
  const summary = summarizeV4Mirror(state);
  const rows = state.pages.map((page) => {
    const verifiedBlocks = page.records.filter((record) => record.block_status === "verified").length;
    const verifiedRich = page.records.reduce((sum, record) => sum + Number(record.verified_rich_text_count || 0), 0);
    const unsupported = page.records.filter((record) => record.rich_text_status === "confirmed_unsupported").length;
    const failed = page.records.filter((record) => record.failure_reason).length;
    const extras = (page.existing_extra_blocks ?? []).map((record) => record.block_id).join(", ");
    return `<tr><td>${escapeHtml(page.name)}</td><td>${escapeHtml(page.category)}</td><td>${page.records.length}</td><td>${verifiedBlocks}</td><td>${verifiedRich}</td><td>${unsupported}</td><td>${escapeHtml(extras)}</td><td>${failed}</td><td><code>${escapeHtml(page.status)}</code></td><td>${escapeHtml(page.failure_reason)}</td></tr>`;
  }).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>4.0无代理镜像报告</title><style>body{font:14px/1.55 system-ui,sans-serif;margin:28px;color:#1f2937}.cards{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}.card{border:1px solid #dbe3ee;border-radius:10px;padding:12px 16px;min-width:145px}.card b{display:block;font-size:24px}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top}th{background:#f8fafc}code{font-size:12px}</style></head><body><h1>4.0无代理环境区块与H2镜像报告</h1><p>入口：${escapeHtml(state.environment.entry_url)}；代理：${state.environment.proxy_server ? escapeHtml(state.environment.proxy_server) : "未使用"}；未新建页面、未发布、未进入增长引擎。历史额外区块按用户要求保留，仅记录不删除。</p><div class="cards"><div class="card">完成页面<b>${summary.completePages}/${summary.pages}</b></div><div class="card">验证区块<b>${summary.verifiedBlocks}/${summary.blocks}</b></div><div class="card">验证富文本<b>${summary.verifiedRichTexts}/${summary.expectedRichTexts}</b></div><div class="card">确认不支持<b>${summary.confirmedUnsupported}/${summary.expectedUnsupported}</b></div><div class="card">保留额外区块<b>${summary.preservedExtras}</b></div><div class="card">异常<b>${summary.failures}</b></div></div><table><thead><tr><th>页面</th><th>分类</th><th>区块</th><th>区块验证</th><th>H2验证</th><th>不支持</th><th>保留额外区块</th><th>异常</th><th>状态</th><th>原因</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

export async function writeV4MirrorReports(state, reportsDir) {
  await mkdir(reportsDir, { recursive: true });
  const blocks = flattenMirrorBlocks(state);
  const richTexts = flattenMirrorRichTexts(state);
  const extras = flattenMirrorExtras(state);
  const unsupported = blocks.filter((record) => record.rich_text_status === "confirmed_unsupported");
  const failures = blocks.filter((record) => record.failure_reason || ["failed", "environment_behavior_mismatch"].includes(record.rich_text_status));
  await Promise.all([
    writeFile(path.join(reportsDir, "v4-mirror-block-mapping.csv"), toCsv(blocks, BLOCK_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-mirror-h2-results.csv"), toCsv(richTexts, RICH_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-mirror-unsupported.csv"), toCsv(unsupported, BLOCK_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-mirror-failures.csv"), toCsv(failures, BLOCK_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-mirror-preserved-extras.csv"), toCsv(extras, EXTRA_COLUMNS), "utf8"),
    writeFile(path.join(reportsDir, "v4-mirror-report.html"), buildV4MirrorHtml(state), "utf8"),
  ]);
}
