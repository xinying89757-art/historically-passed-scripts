import test from "node:test";
import assert from "node:assert/strict";
import { buildHtmlReport, toCsv } from "../src/report.mjs";

test("toCsv 输出 Excel 兼容 BOM 并正确转义", () => {
  const csv = toCsv(
    [{ block_id: "1", app_name: '图文, "默认"\n第二行' }],
    ["block_id", "app_name"],
  );
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /1,"图文, ""默认""\n第二行"/);
});

test("HTML 报告转义用户数据", () => {
  const html = buildHtmlReport({
    updated_at: "2026-07-29",
    pages: [],
    published: false,
    records: [
      {
        csv_row: 2,
        block_id: "1",
        app_name: "<script>alert(1)</script>",
        page_name: "",
        slot_index: "",
        status: "deferred_detail",
        failure_reason: "",
      },
    ],
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert/);
});

