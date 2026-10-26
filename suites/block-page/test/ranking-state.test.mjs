import test from "node:test";
import assert from "node:assert/strict";
import { resetBlockForRetry } from "../src/state.mjs";

test("resetBlockForRetry resets one failed block without touching successful blocks", () => {
  const state = {
    next_csv_index: 9,
    records: [
      { block_id: "1", status: "added", page_name: "已保存页面" },
      {
        block_id: "2",
        status: "add_failed",
        page_name: "失败页面",
        failure_reason: "timeout",
        heading_status: "heading_failed",
      },
    ],
  };

  const reset = resetBlockForRetry(state, "2");

  assert.equal(reset.status, "pending");
  assert.equal(reset.page_name, "");
  assert.equal(reset.heading_status, "");
  assert.equal(state.records[0].page_name, "已保存页面");
  assert.equal(state.next_csv_index, 1);
});

test("resetBlockForRetry refuses to duplicate an added block", () => {
  const state = { next_csv_index: 0, records: [{ block_id: "1", status: "added" }] };
  assert.throws(() => resetBlockForRetry(state, "1"), /拒绝重复添加/);
});
