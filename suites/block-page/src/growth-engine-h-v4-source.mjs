import { readFile } from "node:fs/promises";
import {
  makeExpectedText,
  nextHeadingLevel,
  normalizeText,
  numericRunId,
  stripSyncSuffix,
} from "./growth-engine-h-core.mjs";

function pageFromFirstState(state) {
  return {
    name: state.page_name,
    path: state.page_path,
    status: state.reopen_verified_at ? "complete" : "incomplete",
    records: state.records ?? [],
  };
}

export function mergeV4RichTextPages(firstState, batchState) {
  const pages = [pageFromFirstState(firstState), ...(batchState.pages ?? [])];
  const seen = new Set();
  for (const page of pages) {
    if (!page.name || !page.path) throw new Error("4.0富文本页面缺少名称或路径");
    if (seen.has(page.path)) throw new Error(`4.0富文本页面路径重复：${page.path}`);
    seen.add(page.path);
  }
  return pages;
}

export async function loadV4GrowthEnginePages(config) {
  const [firstState, batchState] = await Promise.all([
    readFile(config.v4Source.firstPageStateFile, "utf8").then(JSON.parse),
    readFile(config.v4Source.batchStateFile, "utf8").then(JSON.parse),
  ]);
  return mergeV4RichTextPages(firstState, batchState);
}

export async function loadV4GrowthEngineSource(config) {
  const pages = await loadV4GrowthEnginePages(config);
  const page = pages.find((candidate) => candidate.path === config.targetPagePath);
  if (!page) throw new Error(`4.0富文本状态中未找到页面：${config.targetPagePath}`);
  if (page.status !== "complete") throw new Error(`4.0页面尚未完成测试数据准备：${page.name}/${page.status}`);
  return page;
}

export function buildV4GrowthEngineTargets(page, runId = numericRunId()) {
  const items = [];
  const unsupported = [];
  for (const record of [...(page.records ?? [])].sort((left, right) => Number(left.slot_index) - Number(right.slot_index))) {
    if (record.status === "unsupported_no_rich_text") {
      unsupported.push({
        block_id: String(record.block_id),
        app_name: record.app_name,
        slot_index: Number(record.slot_index),
        editor_dom_id: record.editor_dom_id,
        status: "unsupported_no_rich_text",
        reason: "第一张图片设置中没有目标富文本编辑器",
      });
      continue;
    }
    if (record.status !== "verified") {
      unsupported.push({
        block_id: String(record.block_id),
        app_name: record.app_name,
        slot_index: Number(record.slot_index),
        editor_dom_id: record.editor_dom_id,
        status: "source_not_verified",
        reason: record.failure_reason || `测试数据状态为${record.status}`,
      });
      continue;
    }
    for (let index = 0; index < (record.editors ?? []).length; index += 1) {
      const editor = record.editors[index];
      if (editor.status !== "verified") {
        unsupported.push({
          block_id: String(record.block_id), app_name: record.app_name,
          slot_index: Number(record.slot_index), editor_dom_id: record.editor_dom_id,
          editor_index: index + 1, field_name: editor.field_name,
          status: "source_not_verified", reason: editor.failure_reason || `富文本状态为${editor.status}`,
        });
        continue;
      }
      const itemIndex = items.length + 1;
      const sourceText = normalizeText(editor.expected_text);
      items.push({
        run_id: runId,
        page_path: page.path,
        item_index: itemIndex,
        block_id: String(record.block_id),
        app_name: record.app_name,
        slot_index: Number(record.slot_index),
        editor_dom_id: record.editor_dom_id,
        editor_index: index + 1,
        field_name: editor.field_name,
        source_text: sourceText,
        original_level: String(editor.expected_level).toUpperCase(),
        original_text: sourceText,
        level_editable: false,
        text_editable: false,
        expected_level: nextHeadingLevel(editor.expected_level),
        expected_text: makeExpectedText({ sourceText, pagePath: page.path, itemIndex, runId }),
        requested_level: nextHeadingLevel(editor.expected_level),
        requested_text: makeExpectedText({ sourceText, pagePath: page.path, itemIndex, runId }),
        control_index: -1,
        mapping_status: "pending",
        level_edit_status: "pending",
        text_edit_status: "pending",
        edit_failure_reason: "",
        save_status: "pending",
        sync_status: "pending",
        live_level: "",
        live_text: "",
        verification_status: "pending",
        failure_reason: "",
        editor_page_name: page.name,
        editor_element_type: "v4_media_rich_text",
        editor_setting_id: String(record.block_id),
        editor_canvas_level: "",
        editor_actual_level: "",
        editor_actual_text: "",
        editor_backfill_status: "pending",
        editor_backfill_evidence: "",
        editor_backfill_failure_reason: "",
      });
    }
  }
  const duplicateTexts = items.map((item) => item.source_text).filter((text, index, all) => all.indexOf(text) !== index);
  if (duplicateTexts.length) throw new Error(`4.0测试文字不唯一：${[...new Set(duplicateTexts)].join("、")}`);
  return { items, unsupported };
}

export function mapV4TargetsToControls(items, controls) {
  return items.map((item) => {
    const matches = controls
      .map((control, index) => ({ ...control, index }))
      .filter((control) => [item.source_text, item.expected_text].some(
        (text) => normalizeText(control.text) === normalizeText(text),
      ) || normalizeText(stripSyncSuffix(control.text)) === normalizeText(item.source_text),
      );
    const editable = matches.filter((control) => control.levelEditable || control.textEditable);
    if (editable.length === 1) {
      return { status: "mapped", controlIndex: editable[0].index, control: editable[0], readonlyCopies: matches.length - 1 };
    }
    if (editable.length > 1) {
      return { status: "locator_ambiguous", controlIndex: -1, reason: `增长引擎中存在${editable.length}个可编辑同文字设置项` };
    }
    if (matches.length > 0) {
      return { status: "field_not_editable", controlIndex: matches[0].index, control: matches[0], readonlyCopies: matches.length };
    }
    return { status: "not_found", controlIndex: -1, reason: "增长引擎刷新后未找到测试文字" };
  });
}

export function shouldRunInitialRefresh(config, state) {
  return Boolean(config.refreshBeforeEdit) && state.initial_refresh?.status !== "verified";
}
