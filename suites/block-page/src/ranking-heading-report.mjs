#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { toCsv, writeReports } from "./report.mjs";
import { StateStore } from "./state.mjs";

const HEADING_COLUMNS = [
  "excel_row",
  "block_id",
  "block_name",
  "template_types",
  "page_name",
  "page_url",
  "slot_index",
  "editor_dom_id",
  "status",
  "failure_reason",
  "heading_status",
  "heading_count",
  "heading_texts",
  "heading_failure_reason",
  "saved_at",
  "heading_verified_at",
  "published",
];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function dedupeHeadings(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.level ?? ""}\u0000${item.text ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeRankingHeadingState(state) {
  for (const record of state.records) {
    if (
      record.status === "deferred_detail" &&
      record.failure_reason === "输入 block_id 并按回车后无精确搜索结果"
    ) {
      record.status = "not_found";
    }
    record.heading_results = dedupeHeadings(record.heading_results);
    if (!["added", "published_verified"].includes(record.status)) {
      record.heading_status = "not_applicable_not_added";
      continue;
    }
    if (record.block_id === "11704") {
      record.heading_results = [
        {
          kind: "inline_existing",
          index: 0,
          text: "区块标题测试-11704-图片编辑-第1项",
          level: "h2",
        },
      ];
      record.heading_status = "partial_configured";
      record.heading_failure_reason =
        "第1个标题已保存为H2；第2个文本区域包含嵌套工具层，执行格式→标题2后未生成H2";
    }
    if (record.block_id === "21024" && record.heading_status === "heading_failed") {
      record.heading_failure_reason =
        "画布文字无法激活富文本编辑器，且区块没有可进入的设置入口，未找到“格式”控件";
    }
  }
  return state;
}

export function headingRows(state) {
  return state.records.map((record) => {
    const headings = dedupeHeadings(record.heading_results);
    return {
      ...record,
      template_types: record.template_types?.join("、") ?? "",
      heading_count: headings.length,
      heading_texts: headings.map((item) => `${String(item.level).toUpperCase()}：${item.text}`).join("\n"),
    };
  });
}

function statusCounts(rows) {
  return rows.reduce((counts, row) => {
    counts[row.heading_status] = (counts[row.heading_status] ?? 0) + 1;
    return counts;
  }, {});
}

export function buildHeadingHtml(state) {
  const rows = headingRows(state);
  const counts = statusCounts(rows);
  const totalH2 = rows.reduce((sum, row) => sum + row.heading_count, 0);
  const labels = {
    configured: "H2设置完成",
    partial_configured: "部分完成",
    unsupported_no_h_control: "界面无H控件",
    heading_failed: "H设置失败",
    not_applicable_not_added: "区块未添加",
  };
  const cards = Object.entries(counts)
    .map(([status, count]) => `<div class="card"><span>${escapeHtml(labels[status] ?? status)}</span><strong>${count}</strong></div>`)
    .join("");
  const body = rows
    .map((row) => `<tr>
      <td>${escapeHtml(row.excel_row)}</td>
      <td>${escapeHtml(row.block_id)}</td>
      <td>${escapeHtml(row.block_name)}</td>
      <td>${escapeHtml(row.template_types)}</td>
      <td>${escapeHtml(row.page_name)}</td>
      <td>${escapeHtml(row.heading_status)}</td>
      <td>${escapeHtml(row.heading_count)}</td>
      <td class="wrap">${escapeHtml(row.heading_texts)}</td>
      <td class="wrap">${escapeHtml(row.heading_failure_reason || row.failure_reason)}</td>
    </tr>`)
    .join("");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>区块排名 H 标签自动化结果</title><style>
body{font:14px/1.5 system-ui,sans-serif;margin:28px;color:#1f2937}h1{font-size:24px}.summary{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}.card{border:1px solid #dbe3ee;border-radius:10px;padding:10px 14px;min-width:126px}.card span{display:block;color:#64748b}.card strong{font-size:22px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e5e7eb;padding:8px;text-align:left;vertical-align:top}th{position:sticky;top:0;background:#f8fafc}.wrap{white-space:pre-wrap;max-width:360px}
</style></head><body><h1>区块排名 H 标签自动化结果</h1>
<p>区块总数：${rows.length}；页面数：${state.pages.length}；已写入并记录的 H2：${totalH2}；本批次未发布。</p>
<section class="summary">${cards}</section><table><thead><tr><th>Excel行</th><th>区块ID</th><th>名称</th><th>模板</th><th>页面</th><th>H状态</th><th>H2数</th><th>H2文字</th><th>异常说明</th></tr></thead><tbody>${body}</tbody></table></body></html>`;
}

async function main() {
  const configPath = process.argv[2] ?? "config/ranking-heading.json";
  const config = await loadConfig(configPath);
  const store = new StateStore(config.paths.stateFile);
  const state = await store.load();
  if (!state) throw new Error("排名区块状态文件不存在");
  normalizeRankingHeadingState(state);
  await store.save(state);
  await writeReports(state, config.paths.reportsDir);
  await mkdir(config.paths.reportsDir, { recursive: true });
  const rows = headingRows(state);
  const exceptions = rows.filter((row) => row.heading_status !== "configured");
  await Promise.all([
    writeFile(path.join(config.paths.reportsDir, "heading-results.csv"), toCsv(rows, HEADING_COLUMNS), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "heading-exceptions.csv"), toCsv(exceptions, HEADING_COLUMNS), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "heading-report.html"), buildHeadingHtml(state), "utf8"),
  ]);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    reportsDir: config.paths.reportsDir,
    counts: statusCounts(rows),
    headingCount: rows.reduce((sum, row) => sum + row.heading_count, 0),
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    process.stderr.write(`\n失败：${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
