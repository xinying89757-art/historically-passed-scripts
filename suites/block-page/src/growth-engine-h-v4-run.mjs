import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import {
  classifyItemVerification,
  compareHeadingLists,
  normalizeText,
  numericRunId,
} from "./growth-engine-h-core.mjs";
import { enterTargetEditor } from "./growth-engine-h-editor-backfill.mjs";
import { GrowthEngineHPage, launchGrowthEngineContext } from "./growth-engine-h-editor.mjs";
import { writeV4GrowthEngineReports } from "./growth-engine-h-v4-report.mjs";
import {
  buildV4GrowthEngineTargets,
  loadV4GrowthEngineSource,
  mapV4TargetsToControls,
  shouldRunInitialRefresh,
} from "./growth-engine-h-v4-source.mjs";
import { GrowthEngineStateStore } from "./growth-engine-h-state.mjs";
import { V4Editor } from "./v4-editor.mjs";
import { V4RichTextSetupUi } from "./v4-rich-text-setup.mjs";

function now() {
  return new Date().toISOString();
}

async function preservePreviousV4Run(config, store) {
  const previous = await store.load();
  if (!previous?.run_id) return;
  const stateHistory = path.join(path.dirname(config.paths.stateFile), "history");
  await mkdir(stateHistory, { recursive: true });
  await writeFile(
    path.join(stateHistory, `${path.basename(config.paths.stateFile, path.extname(config.paths.stateFile))}-${previous.run_id}.json`),
    `${JSON.stringify(previous, null, 2)}\n`,
    "utf8",
  );
  const reportFiles = await readdir(config.paths.reportsDir, { withFileTypes: true }).catch(() => []);
  const reportHistory = path.join(config.paths.reportsDir, "history", previous.run_id);
  await mkdir(reportHistory, { recursive: true });
  await Promise.all(reportFiles
    .filter((entry) => entry.isFile())
    .map((entry) => copyFile(path.join(config.paths.reportsDir, entry.name), path.join(reportHistory, entry.name))));
}

export async function createV4GrowthEngineState(config, runId = numericRunId()) {
  const sourcePage = await loadV4GrowthEngineSource(config);
  const { items, unsupported } = buildV4GrowthEngineTargets(sourcePage, runId);
  return {
    version: 4,
    kind: "growth_engine_v4",
    no_refresh: config.refreshBeforeEdit === false,
    run_id: runId,
    page_name: sourcePage.name,
    page_path: sourcePage.path,
    public_url: config.publicUrl,
    phase: "planned",
    created_at: now(),
    updated_at: now(),
    initial_refresh: config.refreshBeforeEdit === false
      ? { status: "skipped", started_at: "", completed_at: now(), failure_reason: "增长引擎已移除刷新按钮，本批次只等待扫描结果稳定" }
      : { status: "pending", started_at: "", completed_at: "", failure_reason: "" },
    scan_wait: { status: "pending", started_at: "", completed_at: "", failure_reason: "" },
    preview_url: "",
    preview_url_source: "editor_preview_button",
    preview_resolution_status: "pending_editor_preview",
    preview_open_status: "pending",
    preview_path_status: "pending",
    preview_dom_status: "pending",
    preview_heading_count: 0,
    preview_http_status: 0,
    baseline_live_headings: [],
    initial_engine_headings: [],
    refreshed_engine_headings: [],
    final_live_headings: [],
    growth_engine_reentry_verification: { status: "pending", verified: 0, failed: 0, differences: [] },
    page_verification: { status: "pending", differences: [] },
    editor_backfill_verification: { status: "pending", page_name: sourcePage.name, verified: 0, failed: 0, differences: [] },
    unsupported,
    items,
  };
}

async function waitForScan(editor, state) {
  const startedAt = now();
  const scan = await editor.waitForScanStable();
  state.scan_wait = {
    status: scan.status,
    started_at: startedAt,
    completed_at: now(),
    failure_reason: "",
    empty: Boolean(scan.empty),
  };
  return scan;
}

async function scanReportsNoH(editor, scan) {
  if (scan?.empty) return true;
  const bodyText = normalizeText(await editor.frame.locator("body").innerText().catch(() => ""));
  if (/当前页面未检测到\s*H\s*标签|未检测到\s*H\s*标签/u.test(bodyText)) return true;
  const counts = [1, 2, 3, 4, 5, 6].map((level) => {
    const match = bodyText.match(new RegExp(`H${level}\\s*(\\d+)`, "u"));
    return match ? Number(match[1]) : null;
  });
  return counts.every((count) => count === 0);
}

function previewFailureStatus(error) {
  return error?.status || String(error?.message ?? "").match(/^(preview_[a-z_]+):/u)?.[1] || "preview_mismatch";
}

function verifyGrowthEngineReentry(state, controls) {
  const differences = [];
  let verified = 0;
  let failed = 0;
  const mappings = mapV4TargetsToControls(state.items, controls);
  for (let index = 0; index < state.items.length; index += 1) {
    const item = state.items[index];
    if (item.mapping_status !== "mapped" || item.save_status !== "saved") {
      item.growth_engine_reentry_status = "not_applicable";
      continue;
    }
    const mapping = mappings[index];
    const actual = mapping.control;
    const matches = mapping.status === "mapped" && actual &&
      String(actual.level).toUpperCase() === String(item.expected_level).toUpperCase() &&
      normalizeText(actual.text) === normalizeText(item.expected_text);
    item.growth_engine_reentry_status = matches ? "verified" : "mismatch";
    item.growth_engine_actual_level = actual?.level ?? "";
    item.growth_engine_actual_text = actual?.text ?? "";
    item.growth_engine_reentry_failure_reason = matches
      ? ""
      : mapping.reason || `重新进入增长引擎后应为 ${item.expected_level}/${item.expected_text}，实际为 ${actual?.level || "空"}/${actual?.text || "空"}`;
    if (item.growth_engine_reentry_status === "verified") verified += 1;
    else {
      failed += 1;
      differences.push(`区块${item.block_id}第${item.editor_index}处：${item.growth_engine_reentry_failure_reason}`);
    }
  }
  state.growth_engine_reentry_verification = {
    status: failed === 0 ? "verified" : "failed",
    verified,
    failed,
    differences,
  };
}

async function backfillSourceRecords(config, sourcePage) {
  const remapFile = config.editorBackfill?.recordRemapStateFile;
  if (!remapFile) return sourcePage.records;
  const remapState = JSON.parse(await readFile(remapFile, "utf8"));
  const remapPage = (remapState.pages ?? []).find((page) => page.path === sourcePage.path);
  if (!remapPage) throw new Error(`4.0编辑器回填映射状态中未找到页面：${sourcePage.path}`);
  const byBlock = new Map((remapPage.records ?? []).map((record) => [String(record.block_id), record]));
  return sourcePage.records.map((record) => {
    const remap = byBlock.get(String(record.block_id));
    if (!remap) return record;
    return {
      ...record,
      slot_index: remap.existing_target_slot_index ?? remap.slot_index ?? record.slot_index,
      target_editor_dom_id: remap.target_editor_dom_id ?? remap.editor_dom_id ?? record.editor_dom_id,
    };
  });
}

function applyMappings(state, controls) {
  const mappings = mapV4TargetsToControls(state.items, controls);
  for (let index = 0; index < state.items.length; index += 1) {
    const item = state.items[index];
    const mapping = mappings[index];
    item.mapping_status = mapping.status;
    item.control_index = mapping.controlIndex;
    item.readonly_copy_count = mapping.readonlyCopies ?? 0;
    if (mapping.control) {
      item.original_level = mapping.control.level;
      item.original_text = mapping.control.text;
      item.level_editable = Boolean(mapping.control.levelEditable);
      item.text_editable = Boolean(mapping.control.textEditable);
      if (!item.level_editable) {
        item.expected_level = item.original_level;
        item.requested_level = item.original_level;
        item.level_edit_status = "field_not_editable";
      }
      if (!item.text_editable) {
        item.expected_text = item.original_text;
        item.requested_text = item.original_text;
        item.text_edit_status = "field_not_editable";
      }
    }
    if (mapping.status === "field_not_editable") {
      item.level_editable = false;
      item.text_editable = false;
      item.expected_level = item.original_level;
      item.expected_text = item.original_text;
      item.level_edit_status = "field_not_editable";
      item.text_edit_status = "field_not_editable";
      item.save_status = "not_applicable";
      item.sync_status = "not_applicable";
      item.verification_status = "not_editable";
      item.editor_backfill_status = "not_applicable";
      item.failure_reason = "增长引擎中的级别和文字均为只读";
    } else if (mapping.status !== "mapped") {
      item.save_status = "not_applicable";
      item.sync_status = "not_applicable";
      item.verification_status = mapping.status;
      item.editor_backfill_status = "not_applicable";
      item.failure_reason = mapping.reason;
    }
  }
}

async function editMappedItems(editor, dialog, controls, state, persist) {
  const staged = [];
  for (const item of state.items) {
    if (item.mapping_status !== "mapped") continue;
    const control = controls[item.control_index];
    if (control.level === item.expected_level && normalizeText(control.text) === normalizeText(item.expected_text)) {
      item.level_edit_status = item.level_editable ? "edited" : "field_not_editable";
      item.text_edit_status = item.text_editable ? "edited" : "field_not_editable";
      item.save_status = "saved";
      item.sync_status = "succeeded";
      await persist();
      continue;
    }
    const failures = [];
    if (item.level_editable) {
      try {
        await editor.chooseLevel(control, item.requested_level);
        const actual = await editor.readSelectedLevel(control);
        if (actual !== item.requested_level) throw new Error(`edit_not_effective: 界面级别仍为${actual}`);
        item.expected_level = actual;
        item.level_edit_status = "edited";
      } catch (error) {
        item.level_edit_status = /edit_not_effective/u.test(error.message) ? "edit_not_effective" : "edit_failed";
        item.expected_level = item.original_level;
        failures.push(`级别：${error.message}`);
      }
    }
    if (item.text_editable) {
      try {
        await control.textInput.fill(item.requested_text);
        const actual = normalizeText(await control.textInput.inputValue());
        if (actual !== normalizeText(item.requested_text)) throw new Error(`edit_not_effective: 界面文字仍为“${actual}”`);
        item.expected_text = item.requested_text;
        item.text_edit_status = "edited";
      } catch (error) {
        item.text_edit_status = /edit_not_effective/u.test(error.message) ? "edit_not_effective" : "edit_failed";
        item.expected_text = item.original_text;
        failures.push(`文字：${error.message}`);
      }
    }
    item.edit_failure_reason = failures.join("；");
    if ([item.level_edit_status, item.text_edit_status].includes("edited")) {
      item.save_status = "staged";
      staged.push(item);
    } else {
      item.save_status = "failed";
      item.verification_status = "edit_failed";
      item.failure_reason = item.edit_failure_reason || "可编辑字段均未修改成功";
    }
    await persist();
  }
  if (staged.length === 0) {
    await editor.cancelDialog(dialog);
    return;
  }
  try {
    await editor.saveAndSync(dialog);
    for (const item of staged) {
      item.save_status = "saved";
      item.sync_status = "succeeded";
    }
  } catch (error) {
    for (const item of staged) {
      item.save_status = /save/u.test(error.message) ? "save_failed" : item.save_status;
      item.sync_status = /sync/u.test(error.message) ? "failed" : item.sync_status;
      item.verification_status = /sync/u.test(error.message) ? "sync_failed" : "edit_failed";
      item.failure_reason = error.message;
    }
    throw error;
  } finally {
    await persist();
  }
}

function syncedRecord(record, items) {
  const clone = structuredClone(record);
  clone.editors = (clone.editors ?? []).map((editor, index) => {
    const item = items.find((candidate) => candidate.block_id === String(record.block_id) && candidate.editor_index === index + 1);
    return item ? { ...editor, expected_text: item.expected_text, expected_level: item.expected_level } : editor;
  });
  return clone;
}

async function verifyV4PreviewAndBackfill({ context, config, state, sourcePage, persist }) {
  let editorPage;
  let previewPage;
  const existingPages = new Set(context.pages());
  try {
    const entered = await enterTargetEditor(context, config);
    editorPage = entered.editorPage;
    const v4Config = await loadConfig(config.v4Source.editorConfigFile);
    v4Config.siteName = config.editorBackfill.siteName;
    v4Config.siteLanguage = config.editorBackfill.siteLanguage;
    v4Config.timeouts.actionMs = config.timeouts.actionMs;
    v4Config.timeouts.blockRenderMs = config.timeouts.syncMs;
    const v4Editor = new V4Editor(editorPage, v4Config);
    await v4Editor.openCustomPage(state.page_name);
    state.preview_url_source = "editor_preview_button";
    state.preview_resolution_status = "opening_from_editor";
    await persist();
    try {
      const preview = await v4Editor.openPreviewPage(state.page_path);
      previewPage = preview.page;
      state.preview_url = preview.url;
      state.public_url = preview.url;
      state.preview_open_status = "verified";
      state.preview_path_status = preview.pathStatus;
      state.preview_dom_status = "verified";
      state.preview_heading_count = preview.headings.length;
      state.preview_resolution_status = "verified";
      state.preview_verified_at = now();
      state.final_live_headings = preview.headings;
      for (const item of state.items) {
        if (item.mapping_status !== "mapped" || ["edit_failed", "sync_failed"].includes(item.verification_status)) continue;
        const result = classifyItemVerification(item, state.final_live_headings);
        item.verification_status = result.status;
        item.live_level = result.live_level;
        item.live_text = result.live_text;
        item.failure_reason = result.failure_reason;
      }
      // 4.0 预览会为轮播、分页等区块生成额外的可见 H 副本，不能用整页
      // H 列表数量/顺序直接判定同步失败。这里严格核对本批次修改目标：
      // 每个预期文字必须只出现一次且级别一致；目标重复仍会被判为失败。
      const targetFailures = state.items.filter((item) =>
        item.mapping_status === "mapped" &&
        item.save_status === "saved" &&
        item.verification_status !== "modified_verified",
      );
      const inventoryComparison = compareHeadingLists(state.refreshed_engine_headings, state.final_live_headings);
      state.page_heading_inventory_comparison = {
        status: inventoryComparison.matches ? "matched" : "different_dynamic_rendering",
        differences: inventoryComparison.differences,
      };
      state.page_verification = {
        status: targetFailures.length === 0 ? "verified" : "failed",
        differences: targetFailures.map((item) =>
          `区块${item.block_id}第${item.editor_index}处：${item.failure_reason || item.verification_status}`,
        ),
      };
    } catch (error) {
      const status = previewFailureStatus(error);
      state.preview_open_status = ["preview_button_not_found", "preview_button_ambiguous", "preview_tab_not_opened"].includes(status)
        ? status
        : state.preview_open_status === "pending" ? "failed" : state.preview_open_status;
      state.preview_path_status = status === "preview_path_mismatch" ? status : state.preview_path_status;
      state.preview_dom_status = ["preview_no_h_detected", "preview_mismatch"].includes(status) ? status : "failed";
      state.preview_resolution_status = status;
      state.preview_failure_reason = error.message;
      state.page_verification = { status: "failed", differences: [error.message] };
      for (const item of state.items) {
        if (item.mapping_status !== "mapped" || item.save_status !== "saved") continue;
        item.verification_status = status;
        item.failure_reason = error.message;
      }
    } finally {
      await previewPage?.close().catch(() => {});
      previewPage = null;
      await editorPage.bringToFront().catch(() => {});
      await persist();
    }

    const ui = new V4RichTextSetupUi(v4Editor);
    const sourceRecords = await backfillSourceRecords(config, sourcePage);
    for (const record of sourceRecords.filter((candidate) => candidate.status === "verified")) {
      const recordItems = state.items.filter((item) => item.block_id === String(record.block_id));
      if (recordItems.length === 0) continue;
      try {
        const actualEditors = await ui.verify(syncedRecord(record, state.items));
        for (let index = 0; index < recordItems.length; index += 1) {
          const item = recordItems[index];
          const actual = actualEditors[item.editor_index - 1];
          item.editor_actual_level = actual?.actual_level ?? "";
          item.editor_actual_text = actual?.actual_text ?? "";
          item.editor_backfill_evidence = "v4_first_media_rich_text";
          if (item.verification_status === "not_editable" || item.mapping_status !== "mapped") {
            item.editor_backfill_status = "not_applicable";
          } else {
            item.editor_backfill_status = actual?.status === "verified" ? "verified" : "mismatch";
            item.editor_backfill_failure_reason = actual?.failure_reason ?? "";
          }
        }
      } catch (error) {
        const actualEditors = error.details?.editors ?? [];
        for (const item of recordItems) {
          if (item.verification_status === "not_editable" || item.mapping_status !== "mapped") continue;
          const actual = actualEditors[item.editor_index - 1];
          item.editor_actual_level = actual?.actual_level ?? "";
          item.editor_actual_text = actual?.actual_text ?? "";
          const matches = actual &&
            String(actual.actual_level ?? "").toUpperCase() === String(item.expected_level ?? "").toUpperCase() &&
            normalizeText(actual.actual_text) === normalizeText(item.expected_text);
          item.editor_backfill_status = matches ? "verified" : actual ? "mismatch" : "check_failed";
          item.editor_backfill_failure_reason = matches ? "" : actual?.failure_reason || error.message;
        }
        const shot = path.join(config.paths.artifactsDir, `backfill-${record.block_id}-${Date.now()}.png`);
        await editorPage.screenshot({ path: shot, fullPage: false }).catch(() => {});
      }
      await persist();
    }
  } finally {
    await previewPage?.close().catch(() => {});
    for (const page of context.pages()) if (!existingPages.has(page)) await page.close().catch(() => {});
  }
  const targets = state.items.filter((item) => item.editor_backfill_status !== "not_applicable");
  const failed = targets.filter((item) => item.editor_backfill_status !== "verified");
  state.editor_backfill_verification = {
    status: failed.length === 0 ? "verified" : "failed",
    page_name: state.page_name,
    verified: targets.length - failed.length,
    failed: failed.length,
    differences: failed.map((item) => `区块${item.block_id}第${item.editor_index}处：${item.editor_backfill_failure_reason}`),
  };
  await persist();
}

export async function inspectV4GrowthEngine(config) {
  const sourcePage = await loadV4GrowthEngineSource(config);
  const { items, unsupported } = buildV4GrowthEngineTargets(sourcePage, "只读检查");
  const context = await launchGrowthEngineContext(config);
  try {
    const editor = new GrowthEngineHPage(context, config);
    await editor.open();
    const scan = await editor.waitForScanStable();
    // A stable empty scan is a valid diagnostic result. Do not open the edit
    // dialog or probe the preview page when Growth Engine reports no H tags;
    // doing so would turn a data/scan issue into a misleading edit failure.
    if (await scanReportsNoH(editor, scan)) {
      return {
        sourcePage,
        items,
        unsupported,
        controls: [],
        mappings: items.map(() => ({ status: "no_h_detected", controlIndex: -1, reason: "增长引擎扫描结果稳定，但当前页面未检测到H标签" })),
        preview: { source: "editor_preview_button", status: "not_applicable_no_h_detected", headings: [], skipped: true },
        scan,
      };
    }
    const dialog = await editor.openEditDialog();
    const controls = await editor.inspectDialog(dialog);
    const mappings = mapV4TargetsToControls(items, controls);
    await editor.cancelDialog(dialog);
    return {
      sourcePage,
      items,
      unsupported,
      controls: controls.map(({ level, text, levelEditable, textEditable }) => ({ level, text, levelEditable, textEditable })),
      mappings,
      preview: { source: "editor_preview_button", status: "deferred_until_write_flow", headings: [] },
      scan,
    };
  } finally {
    await context.close();
  }
}

export async function runV4GrowthEngine(config, { resume = false } = {}) {
  const store = new GrowthEngineStateStore(config.paths.stateFile);
  if (!resume) await preservePreviousV4Run(config, store);
  let state = resume ? await store.load() : await createV4GrowthEngineState(config);
  if (resume && !state) throw new Error("没有可恢复的4.0增长引擎状态");
  if (resume) delete state.run_failure;
  const sourcePage = await loadV4GrowthEngineSource(config);
  await mkdir(config.paths.artifactsDir, { recursive: true });
  const context = await launchGrowthEngineContext(config);
  const tracePath = path.join(config.paths.artifactsDir, `v4-growth-engine-${state.run_id}.zip`);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const persist = async () => store.save(state);
  let editor;
  try {
    editor = new GrowthEngineHPage(context, config);
    await editor.open();
    try {
      await waitForScan(editor, state);
    } catch (error) {
      state.scan_wait = { status: "failed", started_at: state.scan_wait?.started_at || now(), completed_at: now(), failure_reason: error.message };
      throw error;
    }
    if (await scanReportsNoH(editor, state.scan_wait)) {
      state.scan_wait.empty = true;
      state.preview_url = "";
      state.preview_url_source = "editor_preview_button";
      state.preview_resolution_status = "not_applicable_no_h_detected";
      state.preview_open_status = "not_applicable";
      state.preview_path_status = "not_applicable";
      state.preview_dom_status = "not_applicable";
      state.preview_http_status = 0;
      for (const item of state.items) {
        item.mapping_status = "no_h_detected";
        item.save_status = "not_applicable";
        item.sync_status = "not_applicable";
        item.verification_status = "no_h_detected";
        item.editor_backfill_status = "not_applicable";
        item.failure_reason = "增长引擎扫描结果稳定，但当前页面未检测到H标签；未执行编辑或同步";
      }
      state.page_verification = { status: "not_applicable", differences: ["增长引擎未检测到H标签，跳过预览和写入验证"] };
      state.growth_engine_reentry_verification = { status: "not_applicable", verified: 0, failed: 0, differences: [] };
      state.editor_backfill_verification = {
        status: "not_applicable",
        page_name: state.page_name,
        verified: 0,
        failed: 0,
        differences: [],
      };
      state.phase = "complete_no_h_detected";
      await persist();
      return state;
    }
    if (shouldRunInitialRefresh(config, state)) {
      state.phase = "initial_refreshing";
      state.initial_refresh = { status: "running", started_at: now(), completed_at: "", failure_reason: "" };
      await persist();
      try {
        const refresh = await editor.refreshAndWait({ failureStatus: "initial_refresh_failed" });
        state.initial_refresh = { status: "verified", started_at: refresh.startedAt, completed_at: refresh.completedAt, failure_reason: "" };
      } catch (error) {
        state.initial_refresh.status = "failed";
        state.initial_refresh.failure_reason = error.message;
        throw error;
      }
      await persist();
    }
    if (state.items.length === 0) {
      state.page_verification = { status: "not_applicable", differences: [] };
      state.growth_engine_reentry_verification = { status: "not_applicable", verified: 0, failed: 0, differences: [] };
      state.editor_backfill_verification = {
        status: "not_applicable",
        page_name: state.page_name,
        verified: 0,
        failed: 0,
        differences: [],
      };
      state.phase = "complete_no_supported_targets";
      await persist();
      return state;
    }
    state.preview_url_source = "editor_preview_button";
    state.preview_resolution_status = "deferred_until_after_sync";
    state.baseline_live_headings = [];
    await persist();
    const dialog = await editor.openEditDialog();
    const controls = await editor.inspectDialog(dialog);
    state.initial_engine_headings = controls.map(({ level, text }) => ({ level, text }));
    applyMappings(state, controls);
    state.phase = "editing";
    await persist();
    await editMappedItems(editor, dialog, controls, state, persist);

    state.phase = "verifying";
    await persist();
    editor = new GrowthEngineHPage(context, config);
    await editor.open();
    await waitForScan(editor, state);
    const refreshedDialog = await editor.openEditDialog();
    const refreshedControls = await editor.inspectDialog(refreshedDialog);
    state.refreshed_engine_headings = refreshedControls.map(({ level, text }) => ({ level, text }));
    await editor.cancelDialog(refreshedDialog);
    verifyGrowthEngineReentry(state, refreshedControls);
    await persist();

    state.phase = "editor_verifying";
    await persist();
    await verifyV4PreviewAndBackfill({ context, config, state, sourcePage, persist });
    const terminalItems = state.items.every((item) => item.verification_status === "modified_verified");
    const hasReadonlyProblem = state.items.some((item) =>
      item.level_editable === false || item.text_editable === false || Number(item.readonly_copy_count || 0) > 0);
    state.phase = terminalItems && !hasReadonlyProblem &&
      state.growth_engine_reentry_verification.status === "verified" &&
      state.page_verification.status === "verified" && state.editor_backfill_verification.status === "verified"
      ? "complete"
      : "failed";
    await persist();
  } catch (error) {
    state.phase = "failed";
    state.run_failure = error.message;
    await persist();
    if (editor) await editor.screenshot(`failure-${Date.now()}.png`).catch(() => {});
    throw error;
  } finally {
    await context.tracing.stop({ path: tracePath }).catch(() => {});
    await context.close();
    await writeV4GrowthEngineReports(state, config.paths.reportsDir);
    await writeV4GrowthEngineReports(state, path.join(config.paths.reportsDir, state.run_id));
  }
  return state;
}
