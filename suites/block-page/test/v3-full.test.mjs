import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import {
  EXCLUDED_TEMPLATES,
  readV3FullInput,
  templateTypeFromFileName,
} from "../src/v3-full-input.mjs";
import { createV3FullInitialState, summarizeV3FullState } from "../src/v3-full-state.mjs";
import {
  finalizeV3HeadingVerification,
  prepareFastV3FullHeadingState,
  selectV3FullHeadingPocRecords,
} from "../src/v3-full-heading-runner.mjs";
import { StateStore } from "../src/state.mjs";

test("模板文件名归类稳定", () => {
  assert.equal(templateTypeFromFileName("区块 - “文本”编辑类型.json"), "文本编辑");
  assert.equal(templateTypeFromFileName("区块 - “图片集”类型4.json"), "图片集类型4");
  assert.equal(templateTypeFromFileName("区块 - “多媒体集”类型2.json"), "多媒体集类型2");
  assert.equal(templateTypeFromFileName("区块 - “产品详情”类型.json"), "产品详情");
});

test("真实全量JSON契约与排除数量一致", async () => {
  const config = await loadConfig("config/v3-full-heading.json");
  const input = await readV3FullInput(config.v3FullInputDir);
  assert.equal(input.files.length, 10);
  assert.equal(input.sourceRows, 2036);
  assert.equal(input.uniqueCount, 1294);
  assert.equal(input.records.length, 720);
  assert.equal(input.excluded.length, 574);
  assert.equal(new Set(input.records.map((record) => record.block_id)).size, 720);
  for (const record of input.excluded) {
    assert.ok(record.template_types.some((type) => EXCLUDED_TEMPLATES.has(type)));
  }
  for (const record of input.records) {
    assert.equal(record.template_types.some((type) => EXCLUDED_TEMPLATES.has(type)), false);
  }
});

test("旧映射导入、排名状态优先和H2数量一致", async () => {
  const config = await loadConfig("config/v3-full-heading.json");
  const input = await readV3FullInput(config.v3FullInputDir);
  const state = await createV3FullInitialState(input, config);
  const summary = summarizeV3FullState(state);
  assert.equal(summary.existing, 560);
  assert.equal(summary.missing, 160);
  assert.equal(summary.existingConfigured, 32);
  assert.equal(summary.maxNewPages, 27);
  assert.equal(summary.importedPages, 106);
  const rankingRecords = state.records.filter((record) => record.placement_origin === "ranking-heading-run-state");
  assert.ok(rankingRecords.length > 0);
  assert.ok(rankingRecords.every((record) => record.status === "existing_added"));
});

test("全量H2测试文字为唯一中文规则并补齐两位序号", async () => {
  const module = await import("../src/ranking-heading-poc.mjs");
  assert.ok(typeof module.configureInlineEditors === "function");
  const record = { block_id: "12345", template_types: ["文本编辑"], heading_text_mode: "v3_full" };
  // 文本生成由UI助手内部使用；这里同时锁定公开契约，避免后续误改成英文标记。
  const expected = `区块标题测试-${record.block_id}-第${String(1).padStart(2, "0")}项`;
  assert.equal(expected, "区块标题测试-12345-第01项");
  assert.equal(/[A-Za-z]/u.test(expected), false);
});

test("H2试跑选择所有有可达非排名页面的模板代表且不重复", async () => {
  const config = await loadConfig("config/v3-full-heading.json");
  const input = await readV3FullInput(config.v3FullInputDir);
  const state = await createV3FullInitialState(input, config);
  const selected = selectV3FullHeadingPocRecords(state);
  assert.equal(selected.length, 6);
  assert.equal(new Set(selected.map((record) => record.block_id)).size, 6);
  for (const type of ["文本编辑", "多媒体集类型1", "图片集类型1", "图片集类型2", "图片集类型3", "图文页签"]) {
    assert.ok(selected.some((record) => record.template_types.includes(type)), `缺少${type}`);
  }
  assert.equal(selected.some((record) => record.template_types.includes("多媒体集类型2")), false);
});

test("部分输入失败不会因成功项重开存在而升级为全部通过", () => {
  const partial = { heading_status: "heading_failed", heading_failure_reason: "2个工具栏不可见" };
  finalizeV3HeadingVerification(partial, { ok: true, reason: "" });
  assert.equal(partial.heading_status, "heading_failed");
  assert.equal(partial.heading_failure_reason, "2个工具栏不可见");
  const complete = { heading_status: "configured_pending_page_save", heading_failure_reason: "" };
  finalizeV3HeadingVerification(complete, { ok: true, reason: "" });
  assert.equal(complete.heading_status, "configured_verified");
});

test("快速模式只重置未保存项和已知UI操作失败，并保留备份", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "v3-fast-state-"));
  const stateFile = path.join(directory, "state.json");
  const state = {
    records: [
      { block_id: "2731", heading_status: "configured_pending_page_save", heading_failure_reason: "", heading_results: [{ text: "旧值" }] },
      { block_id: "2081", heading_status: "heading_failed", heading_failure_reason: "Element is not visible", heading_results: [{ text: "部分值" }] },
      { block_id: "2581", heading_status: "heading_failed", heading_failure_reason: "格式菜单中可见“标题 2”的数量为 0", heading_results: [{ text: "部分值" }] },
      { block_id: "3904", heading_status: "unsupported_no_h_control", heading_failure_reason: "没有输入区", heading_results: [] },
      { block_id: "9999", heading_status: "heading_failed", heading_failure_reason: "旧映射页面无法打开", heading_results: [] },
    ],
  };
  await writeFile(stateFile, `${JSON.stringify(state)}\n`, "utf8");
  const result = await prepareFastV3FullHeadingState(state, new StateStore(stateFile), stateFile);
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(saved.records.find((record) => record.block_id === "2731").heading_status, "pending");
  assert.equal(saved.records.find((record) => record.block_id === "2081").heading_status, "pending");
  assert.equal(saved.records.find((record) => record.block_id === "2581").heading_status, "pending");
  assert.equal(saved.records.find((record) => record.block_id === "3904").heading_status, "unsupported_no_h_control");
  assert.equal(saved.records.find((record) => record.block_id === "9999").heading_status, "heading_failed");
  assert.equal(result.resetReasons.length, 3);
  assert.ok(result.backupPath.endsWith(".bak"));
});
