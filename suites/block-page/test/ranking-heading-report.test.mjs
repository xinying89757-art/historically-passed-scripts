import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHeadingHtml,
  headingRows,
  normalizeRankingHeadingState,
} from "../src/ranking-heading-report.mjs";

test("ranking H report separates not-found, partial, unsupported and configured", () => {
  const state = {
    pages: [{ name: "测试页" }],
    records: [
      { block_id: "1", status: "deferred_detail", failure_reason: "输入 block_id 并按回车后无精确搜索结果" },
      { block_id: "11704", status: "added", heading_status: "heading_failed", heading_results: [] },
      { block_id: "3", status: "added", heading_status: "configured", heading_results: [{ level: "h2", text: "标题" }, { level: "h2", text: "标题" }] },
    ],
  };

  normalizeRankingHeadingState(state);
  const rows = headingRows(state);

  assert.equal(rows[0].status, "not_found");
  assert.equal(rows[0].heading_status, "not_applicable_not_added");
  assert.equal(rows[1].heading_status, "partial_configured");
  assert.equal(rows[1].heading_count, 1);
  assert.equal(rows[2].heading_count, 1);
  assert.match(buildHeadingHtml(state), /部分完成/);
});
