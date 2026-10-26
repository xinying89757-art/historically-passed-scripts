import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeV4Reports } from "../src/v4-report.mjs";
import {
  createInitialV4State,
  mergeV4AllCandidates,
  ensureV4ReplacementQueue,
  repairV4DuplicateNodeSnapshotFailures,
  repairV4SearchPlaceholderFailures,
  resetV4RecordsForRetry,
  adoptV4ExistingBlock,
  syncV4PublicUrls,
  v4PageDescriptor,
} from "../src/v4-state.mjs";

const config = {
  v4Categories: ["图片集", "图文"],
  v4TargetPerCategory: 2,
  v4TargetMode: "fixed",
  blocksPerPage: 1,
  publicBaseUrl: "https://example.test/",
  v4PageDescriptors: {
    图片集: { namePrefix: "图-", pathPrefix: "gallery-" },
    图文: { namePrefix: "文-", pathPrefix: "image-text-" },
  },
};

const input = {
  checksum: "checksum",
  csvPath: "/tmp/input.csv",
  excluded: [],
  candidates: [
    { csv_row: 2, block_id: "1", app_name: "一", description: "", category: "图片集", candidate_rank: 1 },
    { csv_row: 3, block_id: "2", app_name: "二", description: "", category: "图片集", candidate_rank: 2 },
    { csv_row: 4, block_id: "3", app_name: "三", description: "", category: "图片集", candidate_rank: 3 },
    { csv_row: 5, block_id: "4", app_name: "四", description: "", category: "图文", candidate_rank: 1 },
  ],
};

test("失败后将下一候选从standby提升为pending", () => {
  const state = createInitialV4State(input, config);
  assert.deepEqual(state.records.slice(0, 3).map((item) => item.status), ["pending", "pending", "standby"]);
  state.records[0].status = "not_found";
  ensureV4ReplacementQueue(state, "图片集");
  assert.equal(state.records[2].status, "pending");
});

test("全量模式会处理所有候选并支持分类不同目标数", () => {
  const allConfig = { ...config, v4TargetMode: "all", v4TargetPerCategory: undefined };
  const state = createInitialV4State(input, allConfig);
  assert.deepEqual(state.targets_by_category, { 图片集: 3, 图文: 1 });
  assert.equal(state.target_mode, "all");
  assert.equal(state.records.every((record) => record.status === "pending"), true);
});

test("全量状态可无损合并后来纳入的候选", () => {
  const allConfig = { ...config, v4TargetMode: "all", v4TargetPerCategory: undefined };
  const initialInput = { ...input, candidates: input.candidates.slice(0, 3) };
  const state = createInitialV4State(initialInput, allConfig);
  state.records[0].status = "added";
  const added = mergeV4AllCandidates(state, input, allConfig);
  assert.equal(added, 1);
  assert.equal(state.records.find((record) => record.block_id === "1").status, "added");
  assert.equal(state.records.find((record) => record.block_id === "4").status, "pending");
  assert.deepEqual(state.targets_by_category, { 图片集: 3, 图文: 1 });
});

test("失败区块可定向重置且已添加区块拒绝重复", () => {
  const state = createInitialV4State(input, config);
  state.records[0].status = "add_failed";
  state.records[0].failure_reason = "侧栏未打开";
  assert.equal(resetV4RecordsForRetry(state, ["1"])[0].status, "pending");
  state.records[0].status = "added";
  assert.throws(() => resetV4RecordsForRetry(state, ["1"]), /拒绝重复添加/u);
});

test("已存在的唯一画布节点可纳入映射并修正后续槽位", () => {
  const state = createInitialV4State(input, config);
  state.pages.push({ name: "图-001", publicUrl: "https://example.test/gallery-001", saved_at: "now", block_ids: ["1", "2"] });
  Object.assign(state.records[0], { status: "added", page_name: "图-001", slot_index: 1, editor_dom_id: "node-1" });
  Object.assign(state.records[1], { status: "added", page_name: "图-001", slot_index: 2, editor_dom_id: "node-2" });
  state.records[2].status = "locator_ambiguous";
  const adopted = adoptV4ExistingBlock(state, {
    blockId: "3", pageName: "图-001", slotIndex: 2, editorDomId: "node-3",
    audit: { width: 100, height: 100, has_default_content: true },
  });
  assert.equal(adopted.status, "added");
  assert.deepEqual(state.pages[0].block_ids, ["1", "3", "2"]);
  assert.equal(state.records[1].slot_index, 3);
});

test("分类页面名称和路径独立生成", () => {
  assert.deepEqual(v4PageDescriptor(config, "图片集", 2), {
    category: "图片集",
    number: 2,
    name: "图-002",
    path: "/gallery-002",
    publicUrl: "https://example.test/gallery-002",
  });
});

test("已有页面报告可同步到4.0站点域名", () => {
  const state = createInitialV4State(input, config);
  state.pages.push({ name: "图-001", path: "/gallery-001", publicUrl: "https://old.test/gallery-001" });
  Object.assign(state.records[0], { page_name: "图-001", page_url: "https://old.test/gallery-001" });
  assert.equal(syncV4PublicUrls(state, config), 2);
  assert.equal(state.pages[0].publicUrl, "https://example.test/gallery-001");
  assert.equal(state.records[0].page_url, "https://example.test/gallery-001");
});

test("搜索框定位校准失败可恢复且不消耗候选", () => {
  const state = createInitialV4State(input, config);
  state.current_page = { name: "图-001", block_ids: [] };
  Object.assign(state.records[0], {
    status: "add_failed",
    failure_reason: "点击新区块入口后未出现区块搜索框",
    attempt_count: 1,
    page_name: "图-001",
  });
  assert.equal(repairV4SearchPlaceholderFailures(state), 1);
  assert.equal(state.records[0].status, "pending");
  assert.equal(state.records[0].attempt_count, 0);
});

test("共用node id造成的历史误判可定向恢复", () => {
  const state = createInitialV4State(input, config);
  Object.assign(state.records[0], {
    status: "render_failed",
    failure_reason: "添加后60秒内未能唯一确认区块 1 完成渲染",
    attempt_count: 1,
    audit: { beforeNodeCount: 5, afterNodeCount: 9, nodeCreated: true },
  });
  assert.equal(repairV4DuplicateNodeSnapshotFailures(state), 1);
  assert.equal(state.records[0].status, "pending");
  assert.equal(state.records[0].attempt_count, 0);
  assert.equal(repairV4DuplicateNodeSnapshotFailures(state), 0);
});

test("报告只把added写入映射、失败写入异常", async () => {
  const state = createInitialV4State(input, config);
  state.records[0].status = "added";
  state.records[1].status = "not_found";
  state.records[1].failure_reason = "无结果";
  const directory = await mkdtemp(path.join(os.tmpdir(), "v4-report-"));
  await writeV4Reports(state, directory);
  const mapping = await readFile(path.join(directory, "v4-block-page-mapping.csv"), "utf8");
  const failures = await readFile(path.join(directory, "v4-block-failures.csv"), "utf8");
  assert.match(mapping, /,1,/u);
  assert.doesNotMatch(mapping, /,2,/u);
  assert.match(failures, /,2,/u);
});
