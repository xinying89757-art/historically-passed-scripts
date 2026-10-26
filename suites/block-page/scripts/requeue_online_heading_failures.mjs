#!/usr/bin/env node
import { copyFile, readFile, writeFile } from "node:fs/promises";

const [, , stateFile, batchId] = process.argv;
if (!stateFile || !batchId) {
  throw new Error("用法：node scripts/requeue_online_heading_failures.mjs <state.json> <batch_id>");
}

const state = JSON.parse(await readFile(stateFile, "utf8"));
if (state.online_retry?.batch_id !== batchId) {
  throw new Error(`状态文件上线批次不匹配：${state.online_retry?.batch_id ?? ""}`);
}

const retryable = new Set(["heading_failed", "unsupported_no_h_control", "save_failed"]);
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const backup = `${stateFile}.before-online-heading-retry-${stamp}.bak`;
await copyFile(stateFile, backup);
const reset = [];
for (const record of state.records) {
  if (record.online_retry_batch !== batchId || !retryable.has(record.heading_status)) continue;
  reset.push({ block_id: record.block_id, from: record.heading_status });
  Object.assign(record, {
    heading_status: "pending",
    heading_failure_reason: "",
    heading_warning: "",
    heading_results: [],
    heading_poc: [],
    heading_verified_at: "",
  });
}
state.online_retry.last_heading_requeue = {
  at: new Date().toISOString(),
  count: reset.length,
  block_ids: reset.map((item) => item.block_id),
  backup,
};
await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ batch_id: batchId, reset, backup }, null, 2));
