import { mkdir } from "node:fs/promises";
import path from "node:path";
import { V4Editor, V4UiError, launchV4Browser, stopV4Trace } from "./v4-editor.mjs";
import {
  categoryProgress,
  ensureV4ReplacementQueue,
  nextV4Category,
  nextV4PendingRecord,
  normalizeV4PendingWindow,
  repairV4DuplicateNodeSnapshotFailures,
  repairV4SearchPlaceholderFailures,
  syncV4PublicUrls,
  isV4AllMode,
  v4PageDescriptor,
} from "./v4-state.mjs";
import { writeV4Reports } from "./v4-report.mjs";

function stamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function persist(state, store, config) {
  await store.save(state);
  await writeV4Reports(state, config.paths.v4ReportsDir);
}

async function screenshot(page, config, label) {
  const directory = path.join(config.paths.v4ArtifactsDir, "screenshots");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${stamp()}-${label}.png`);
  await page.screenshot({ path: target, fullPage: true }).catch(() => {});
  return target;
}

function resetStagedRecord(record) {
  Object.assign(record, {
    status: "pending",
    page_name: "",
    page_url: "",
    slot_index: "",
    editor_dom_id: "",
    failure_reason: "",
    audit: null,
  });
}

async function reconcileCurrentPage(editor, state, store, config) {
  if (!state.current_page) return;
  const current = state.current_page;
  await editor.reopenCustomPage(current.name);
  const staged = state.records
    .filter((record) => record.status === "staged" && record.page_name === current.name)
    .sort((left, right) => Number(left.slot_index) - Number(right.slot_index));
  if (staged.length !== current.block_ids.length) {
    throw new Error(`${current.name} 的暂存区块与状态中的 block_ids 数量不一致，拒绝自动恢复`);
  }
  const present = [];
  for (const record of staged) {
    let audits = await editor.auditBlock(record.block_id);
    if (audits.length === 0 && record.editor_dom_id) {
      audits = await editor.auditCanvasNode(record.editor_dom_id, record.block_id);
    }
    if (audits.length === 1) {
      record.audit = audits[0];
      record.editor_dom_id = audits[0].editor_dom_id;
      present.push(record);
    }
  }
  if (present.length === 0 && staged.length > 0) {
    for (const record of staged) resetStagedRecord(record);
    current.block_ids = [];
    await persist(state, store, config);
    return;
  }
  if (present.length !== staged.length) {
    throw new Error(`${current.name} 恢复对账只找到 ${present.length}/${staged.length} 个暂存区块，请人工检查后再继续`);
  }
  current.block_ids = staged.map((record) => record.block_id);
  normalizeV4PendingWindow(state, current.category);
  await persist(state, store, config);
}

async function saveAndVerify(editor, state, store, config) {
  const current = state.current_page;
  if (!current || current.block_ids.length === 0) return false;
  let saveEvidence = null;
  let saveError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      saveEvidence = await editor.savePage();
      saveError = null;
      break;
    } catch (error) {
      saveError = error;
      if (attempt === 1) await editor.page.waitForTimeout(800);
    }
  }
  if (saveError) {
    for (const record of state.records) {
      if (record.status === "staged" && record.page_name === current.name) {
        record.status = "save_failed";
        record.failure_reason = saveError.message;
      }
    }
    state.last_error = saveError.message;
    await screenshot(editor.page, config, `${current.name}-save-failed`);
    await persist(state, store, config);
    throw saveError;
  }

  await editor.reopenCustomPage(current.name);
  let verified;
  try {
    const expectedRecords = current.block_ids.map((blockId) =>
      state.records.find((record) => record.block_id === blockId),
    );
    verified = await editor.verifyBlocks(expectedRecords);
  } catch (error) {
    state.last_error = error.message;
    await screenshot(editor.page, config, `${current.name}-reopen-verify-failed`);
    await persist(state, store, config);
    throw error;
  }

  const savedAt = new Date().toISOString();
  const byId = new Map(verified.map((item) => [item.blockId, item.audit]));
  for (const record of state.records) {
    if (record.status === "staged" && record.page_name === current.name) {
      record.status = "added";
      record.saved_at = savedAt;
      record.audit = byId.get(record.block_id) ?? record.audit;
      record.editor_dom_id = record.audit?.editor_dom_id ?? record.editor_dom_id;
    }
  }
  state.pages.push({
    ...current,
    saved_at: savedAt,
    reopen_verified_at: new Date().toISOString(),
    save_evidence: saveEvidence,
  });
  state.current_page = null;
  state.last_error = "";
  await persist(state, store, config);
  return true;
}

function recordFailure(record, error) {
  const rawStatus = error instanceof V4UiError ? error.status : "add_failed";
  let status = rawStatus;
  if (rawStatus === "render_failed" && !error.details?.nodeCreated) status = "add_failed";
  record.status = status;
  record.failure_reason = error.message;
  record.audit = error.details?.audit ?? error.details ?? null;
  return status;
}

export async function runV4Blocks({ config, input, store, maxPages = 0 }) {
  const state = await store.loadOrCreate(input, config);
  syncV4PublicUrls(state, config);
  repairV4SearchPlaceholderFailures(state);
  repairV4DuplicateNodeSnapshotFailures(state);
  for (const category of state.categories) normalizeV4PendingWindow(state, category);
  for (const category of state.categories) ensureV4ReplacementQueue(state, category);
  await persist(state, store, config);
  const tracePath = path.join(config.paths.v4ArtifactsDir, "traces", `${stamp()}-v4-block-run.zip`);
  const { context, page } = await launchV4Browser(config, { traceName: "4.0区块铺页" });
  const editor = new V4Editor(page, config);
  let savedPages = 0;
  try {
    await editor.goto();
    await reconcileCurrentPage(editor, state, store, config);
    for (const category of state.categories) normalizeV4PendingWindow(state, category);
    await persist(state, store, config);
    while (true) {
      const category = nextV4Category(state);
      if (!category) break;
      ensureV4ReplacementQueue(state, category);
      const progress = categoryProgress(state, category);
      if (!state.current_page) {
        const pageNumber = state.pages.filter((item) => item.category === category).length + 1;
        const descriptor = v4PageDescriptor(config, category, pageNumber);
        await editor.createCustomPage(descriptor);
        state.current_page = { ...descriptor, block_ids: [] };
        await persist(state, store, config);
      }
      const current = state.current_page;
      if (current.category !== category) {
        throw new Error(`当前未保存页面分类为 ${current.category}，但待处理分类为 ${category}`);
      }

      while (current.block_ids.length < state.blocks_per_page) {
        ensureV4ReplacementQueue(state, category);
        const record = nextV4PendingRecord(state, category);
        if (!record) {
          if (isV4AllMode(state) && current.block_ids.length > 0) break;
          throw new Error(`${category} 候选已耗尽，无法补足第 ${current.number} 页`);
        }
        record.attempt_count += 1;
        record.page_name = current.name;
        record.page_url = current.publicUrl;
        record.slot_index = current.block_ids.length + 1;
        await persist(state, store, config);
        try {
          const audit = await editor.searchAndAdd(record.block_id);
          record.status = "staged";
          record.audit = audit;
          record.editor_dom_id = audit.editor_dom_id;
          record.failure_reason = "";
          current.block_ids.push(record.block_id);
          await persist(state, store, config);
        } catch (error) {
          const status = recordFailure(record, error);
          await screenshot(editor.page, config, `${record.block_id}-${status}`);
          ensureV4ReplacementQueue(state, category);
          await persist(state, store, config);
          if (status === "login_expired") throw error;
          if (status === "render_failed") throw error;
        }
      }

      if (await saveAndVerify(editor, state, store, config)) savedPages += 1;
      if (maxPages && savedPages >= maxPages) break;
      if (!isV4AllMode(state) && progress.added >= progress.target && nextV4Category(state) !== category) continue;
    }
    return state;
  } catch (error) {
    state.last_error = error.message;
    await persist(state, store, config).catch(() => {});
    throw error;
  } finally {
    await stopV4Trace(context, tracePath).catch(() => {});
    await context.close();
  }
}
