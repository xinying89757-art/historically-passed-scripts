#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [, , stateFile, outputDir = "reports/v3-full-heading"] = process.argv;
if (!stateFile) throw new Error("用法：node scripts/write_online_retry_report.mjs <state.json> [outputDir]");
const state = JSON.parse(await readFile(stateFile, "utf8"));
const batch = state.online_retry?.batch_id;
if (!batch) throw new Error("状态文件没有 online_retry 批次");
const records = state.records.filter((record) => record.online_retry_batch === batch);
const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const headers = [
  "block_id", "app_name", "placement_status", "page_name", "page_url", "slot_index",
  "editor_dom_id", "heading_status", "heading_failure_reason", "heading_warning",
  "heading_count", "heading_results",
];
const lines = [headers.map(csvCell).join(",")];
for (const record of records) {
  const headings = record.heading_results ?? [];
  lines.push([
    record.block_id, record.app_name, record.status, record.page_name, record.page_url,
    record.slot_index, record.editor_dom_id, record.heading_status,
    record.heading_failure_reason, record.heading_warning, headings.length,
    headings.map((item) => `${item.level}:${item.text}`).join(" | "),
  ].map(csvCell).join(","));
}
const summary = {
  batch_id: batch,
  workbook: state.online_retry.workbook,
  total: records.length,
  placement: Object.groupBy(records, (record) => record.status),
  heading: Object.groupBy(records, (record) => record.heading_status || "none"),
  updated_at: new Date().toISOString(),
};
const failures = records.filter((record) =>
  record.status !== "added_new" || record.heading_status !== "configured_verified",
);
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, "v3-online-retry-results.csv"), `\ufeff${lines.join("\n")}\n`, "utf8");
await writeFile(path.join(outputDir, "v3-online-retry-failures.csv"), `\ufeff${[
  lines[0],
  ...lines.slice(1).filter((_, index) => failures.some((record) => record.block_id === records[index].block_id)),
].join("\n")}\n`, "utf8");
await writeFile(path.join(outputDir, "v3-online-retry-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));
