import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const COMMON_COLUMNS = [
  "csv_row",
  "block_id",
  "app_name",
  "page_name",
  "page_url",
  "slot_index",
  "editor_dom_id",
  "h1_count",
  "h2_count",
  "h3_count",
  "h4_count",
  "h5_count",
  "h6_count",
  "image_count",
  "image_urls",
  "status",
  "failure_reason",
  "attempt_count",
  "saved_at",
  "published",
];

function csvCell(value) {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(records, columns = COMMON_COLUMNS) {
  const rows = [columns.map(csvCell).join(",")];
  for (const record of records) {
    rows.push(columns.map((column) => csvCell(record[column])).join(","));
  }
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusCounts(records) {
  return records.reduce((counts, record) => {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
    return counts;
  }, {});
}

export function buildHtmlReport(state) {
  const counts = statusCounts(state.records);
  const countCards = Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([status, count]) =>
        `<div class="card"><span>${escapeHtml(status)}</span><strong>${count}</strong></div>`,
    )
    .join("");
  const rows = state.records
    .filter((record) => record.status !== "pending")
    .map(
      (record) => `<tr>
        <td>${record.csv_row}</td>
        <td>${escapeHtml(record.block_id)}</td>
        <td>${escapeHtml(record.app_name)}</td>
        <td>${escapeHtml(record.page_name)}</td>
        <td>${escapeHtml(record.slot_index)}</td>
        <td><code>${escapeHtml(record.status)}</code></td>
        <td>${escapeHtml(record.failure_reason)}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>增长引擎区块铺设报告</title>
  <style>
    body{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#1f2937}
    h1{font-size:24px}.summary{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}
    .card{border:1px solid #dbe3ee;border-radius:10px;padding:12px 16px;min-width:140px}
    .card span{display:block;color:#64748b}.card strong{font-size:24px}
    table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e5e7eb;padding:8px;text-align:left}
    th{position:sticky;top:0;background:#f8fafc}code{font-size:12px}
  </style>
</head>
<body>
  <h1>增长引擎区块铺设报告</h1>
  <p>更新时间：${escapeHtml(state.updated_at)}；页面数：${state.pages.length}；已发布：${state.published ? "是" : "否"}</p>
  <section class="summary">${countCards}</section>
  <table>
    <thead><tr><th>CSV 行</th><th>区块 ID</th><th>名称</th><th>页面</th><th>槽位</th><th>状态</th><th>原因</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

export async function writeReports(state, reportsDir) {
  await mkdir(reportsDir, { recursive: true });
  const mapping = state.records.filter((record) =>
    ["added", "published_verified"].includes(record.status),
  );
  const deferred = state.records.filter(
    (record) => record.status === "deferred_detail",
  );
  const failed = state.records.filter((record) =>
    [
      "not_found",
      "locator_ambiguous",
      "add_failed",
      "render_failed",
      "save_failed",
    ].includes(record.status),
  );
  await Promise.all([
    writeFile(
      path.join(reportsDir, "block-page-mapping.csv"),
      toCsv(mapping),
      "utf8",
    ),
    writeFile(
      path.join(reportsDir, "deferred-blocks.csv"),
      toCsv(deferred),
      "utf8",
    ),
    writeFile(
      path.join(reportsDir, "failed-blocks.csv"),
      toCsv(failed),
      "utf8",
    ),
    writeFile(
      path.join(reportsDir, "report.html"),
      buildHtmlReport(state),
      "utf8",
    ),
  ]);
}

export { COMMON_COLUMNS };
