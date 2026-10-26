import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSummary, itemIssues } from "../src/growth-engine-h-summary.mjs";

test("问题汇总严格区分不可编辑信息项与真实修改失败", () => {
  const page = { id: "component-003", editor_page_name: "组件标题测试-003", target_page_path: "/003.html" };
  const readonly = itemIssues({
    item_index: 1, source_text: "动态标题", original_level: "H4", original_text: "动态标题",
    level_editable: false, text_editable: false, verification_status: "not_editable",
    editor_backfill_status: "not_applicable", save_status: "not_applicable", sync_status: "not_applicable",
  }, page);
  assert.equal(readonly.length, 1);
  assert.equal(readonly[0].severity, "信息");
  const failed = itemIssues({
    item_index: 2, source_text: "组件标题", original_level: "H2", original_text: "组件标题",
    level_editable: true, text_editable: true, level_edit_status: "edit_not_effective",
    text_edit_status: "edited", verification_status: "edit_failed", editor_backfill_status: "check_failed",
    save_status: "failed", sync_status: "pending", edit_failure_reason: "级别未变化", failure_reason: "级别未变化",
    editor_backfill_failure_reason: "未回填",
  }, page);
  assert.ok(failed.some((issue) => issue.category === "增长引擎修改失败" && issue.severity === "高"));
  assert.ok(failed.some((issue) => issue.category === "3.0编辑器回填不一致"));
});

test("整页预览不一致合并为一个根问题", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "growth-engine-summary-"));
  const runId = "20260821111111";
  const reportDir = path.join(root, "reports/growth-engine-h-batch", runId);
  const stateDir = path.join(root, ".state/growth-engine-h-batch-pages", runId);
  await mkdir(reportDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(reportDir, "growth-engine-h-batch-pages.csv"), [
    "id,scope,editor_page_name,target_page_path,growth_engine_item_count,status,preview_status,editor_backfill_status,failure_reason",
    "block-006,blocks,区块页006,/006,4,failed,failed,verified,数量不一致",
  ].join("\n"));
  await writeFile(path.join(stateDir, "block-006.json"), JSON.stringify({
    items: [
      {
        item_index: 1,
        source_text: "重复标题甲",
        level_editable: true,
        text_editable: true,
        verification_status: "live_text_mismatch",
        failure_reason: "预期文字出现2次",
        editor_backfill_status: "verified",
        save_status: "saved",
        sync_status: "synced",
      },
      {
        item_index: 2,
        source_text: "重复标题乙",
        level_editable: true,
        text_editable: true,
        verification_status: "live_text_mismatch",
        failure_reason: "预期文字出现2次",
        editor_backfill_status: "verified",
        save_status: "saved",
        sync_status: "synced",
      },
    ],
    page_verification: { status: "failed", differences: ["增长引擎4项，预览6项"] },
  }));
  const result = await buildSummary({ root, runIds: [runId], output: path.join(root, "output") });
  assert.equal(result.actualProblems.length, 1);
  assert.equal(result.actualProblems[0].category, "增长引擎与预览整页不一致");
  assert.match(result.actualProblems[0].detail, /重复标题甲/u);
  assert.match(await readFile(path.join(root, "output/3.0-growth-engine-problems-only.csv"), "utf8"), /预期文字出现2次/u);
});
