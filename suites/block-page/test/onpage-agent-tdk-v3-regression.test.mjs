import assert from "node:assert/strict";
import test from "node:test";
import { classifyAttempt, classifyScheme } from "../src/onpage-agent-tdk-v3-regression.mjs";

function comparison(exact = false, partial = false) {
  return { exact, partial, matchedCount: exact ? 3 : partial ? 1 : 0 };
}

test("保存响应未明确成功时归为save_failed", () => {
  assert.deepEqual(classifyAttempt({ accepted: false }), { status: "save_failed", persistedAtMs: null });
});

test("0秒即读取到三字段时归为persisted_verified", () => {
  assert.deepEqual(classifyAttempt({ accepted: true, polls: [{ offset_ms: 0, comparison: comparison(true) }] }), { status: "persisted_verified", persistedAtMs: 0 });
});

test("后续轮询才读取到三字段时归为delayed_persisted", () => {
  assert.deepEqual(classifyAttempt({ accepted: true, polls: [
    { offset_ms: 0, comparison: comparison() },
    { offset_ms: 10000, comparison: comparison(true) },
  ] }), { status: "delayed_persisted", persistedAtMs: 10000 });
});

test("只持久化部分字段时归为partial_persistence", () => {
  assert.deepEqual(classifyAttempt({ accepted: true, polls: [{ offset_ms: 120000, comparison: comparison(false, true) }] }), { status: "partial_persistence", persistedAtMs: null });
});

test("保存成功但所有读取均为空时归为success_but_not_persisted", () => {
  assert.deepEqual(classifyAttempt({ accepted: true, polls: [{ offset_ms: 120000, comparison: comparison() }] }), { status: "success_but_not_persisted", persistedAtMs: null });
});

test("HTTP与HTTPS一边持久化一边未持久化时归为scheme_inconsistent", () => {
  assert.equal(classifyScheme({ status: "success_but_not_persisted" }, { status: "persisted_verified" }), "scheme_inconsistent");
});

test("HTTP与HTTPS都未持久化时保留主协议状态", () => {
  assert.equal(classifyScheme({ status: "success_but_not_persisted" }, { status: "partial_persistence" }), "success_but_not_persisted");
});
