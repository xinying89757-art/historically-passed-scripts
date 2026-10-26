import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { V4Editor, launchV4Browser } from "./v4-editor.mjs";
import { V4_RICH_TEXT_PAGE, V4RichTextSetupUi } from "./v4-rich-text-setup.mjs";

const FINAL_RECORD_STATUSES = new Set([
  "verified",
  "unsupported_no_rich_text",
  "unsupported_no_media_item",
  "unsupported_no_media_edit",
]);

function now() {
  return new Date().toISOString();
}

async function saveJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

export function selectRemainingV4RichTextPages(sourceState) {
  return sourceState.pages
    .filter((page) => page.name !== V4_RICH_TEXT_PAGE.name)
    .map((page) => {
      const records = sourceState.records
        .filter((record) => record.status === "added" && record.page_name === page.name)
        .sort((left, right) => Number(left.slot_index) - Number(right.slot_index))
        .map((record) => ({
          block_id: String(record.block_id),
          app_name: record.app_name,
          slot_index: Number(record.slot_index),
          editor_dom_id: record.editor_dom_id,
          status: "pending",
          rich_text_count: 0,
          prepared_count: 0,
          verified_count: 0,
          failure_reason: "",
          attempt_count: 0,
          editors: [],
        }));
      if (records.length !== page.block_ids.length) {
        throw new Error(`${page.name}页面映射有${page.block_ids.length}个区块，但added记录为${records.length}个`);
      }
      return {
        name: page.name,
        path: page.path,
        category: page.category,
        status: "pending",
        saved_at: "",
        reopen_verified_at: "",
        failure_reason: "",
        records,
      };
    });
}

export function createV4RichTextBatchState(sourceState) {
  const pages = selectRemainingV4RichTextPages(sourceState);
  return {
    version: 1,
    started_at: now(),
    updated_at: now(),
    source_state_file: "v4-block-run-state-proxy.json",
    excluded_completed_page: V4_RICH_TEXT_PAGE.name,
    growth_engine_status: "deferred_by_user",
    pages,
  };
}

export async function loadV4RichTextBatchState(sourcePath, statePath, reset = false) {
  const source = JSON.parse(await readFile(sourcePath, "utf8"));
  if (!reset) {
    const existing = await readFile(statePath, "utf8").then(JSON.parse).catch(() => null);
    if (existing) return existing;
  }
  const state = createV4RichTextBatchState(source);
  await saveJsonAtomic(statePath, state);
  return state;
}

function pageIsFinal(page) {
  return page.records.every((record) => FINAL_RECORD_STATUSES.has(record.status));
}

async function configureRecordWithRetry(ui, record) {
  let lastResult = null;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    record.attempt_count += 1;
    try {
      const result = await ui.inspectAndConfigure(record, true);
      lastResult = result;
      if (result.status === "unsupported_no_media_item" || result.status === "media_edit_not_found") {
        if (attempt === 0) continue;
        return {
          ...result,
          status: result.status === "unsupported_no_media_item" ? "unsupported_no_media_item" : "unsupported_no_media_edit",
        };
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt === 0 && ["settings_not_found", "media_edit_not_visible", "block_root_not_found"].includes(error.status)) continue;
      throw error;
    }
  }
  if (lastResult) return lastResult;
  throw lastError ?? new Error(`区块${record.block_id}配置失败`);
}

async function verifyRecordWithRetry(ui, record) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await ui.verify(record);
    } catch (error) {
      lastError = error;
      if (attempt === 0 && ["settings_not_found", "media_edit_not_visible", "reopen_count_mismatch", "block_root_not_found"].includes(error.status)) continue;
      throw error;
    }
  }
  throw lastError;
}

export function summarizeV4RichTextBatch(state) {
  const records = state.pages.flatMap((page) => page.records);
  const statuses = {};
  for (const record of records) statuses[record.status] = (statuses[record.status] ?? 0) + 1;
  return {
    pages: state.pages.length,
    completePages: state.pages.filter((page) => page.status === "complete").length,
    pendingPages: state.pages.filter((page) => page.status !== "complete").length,
    blocks: records.length,
    verifiedBlocks: records.filter((record) => record.status === "verified").length,
    unsupportedBlocks: records.filter((record) => record.status.startsWith("unsupported_")).length,
    richTexts: records.reduce((sum, record) => sum + Number(record.rich_text_count || 0), 0),
    verifiedRichTexts: records.reduce((sum, record) => sum + Number(record.verified_count || 0), 0),
    statuses,
  };
}

export async function runV4RichTextBatch({ config, statePath, artifactsDir, reportsWriter, maxPages = 0, reset = false }) {
  const state = await loadV4RichTextBatchState(config.paths.v4StateFile, statePath, reset);
  const candidates = state.pages.filter((page) => page.status !== "complete");
  const pages = maxPages > 0 ? candidates.slice(0, maxPages) : candidates;
  if (pages.length === 0) return state;
  await mkdir(artifactsDir, { recursive: true });
  const { context, page } = await launchV4Browser(config, { headless: false });
  try {
    const editor = new V4Editor(page, config);
    await editor.goto();
    for (const targetPage of pages) {
      const safePageName = targetPage.name.replace(/[^\p{L}\p{N}-]+/gu, "-");
      const tracePath = path.join(artifactsDir, `${safePageName}-${Date.now()}.zip`);
      let traceStarted = false;
      try {
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true, title: targetPage.name });
        traceStarted = true;
        await editor.page.keyboard.press("Escape").catch(() => {});
        await editor.page.waitForTimeout(300);
        await editor.openCustomPage(targetPage.name);
        const ui = new V4RichTextSetupUi(editor);
        let changed = false;

        for (const record of targetPage.records) {
          if (FINAL_RECORD_STATUSES.has(record.status)) continue;
          record.failure_reason = "";
          try {
            const result = await configureRecordWithRetry(ui, record);
            Object.assign(record, result, {
              prepared_count: result.editors.filter((item) => item.status === "configured_pending_page_save").length,
              verified_count: 0,
              updated_at: now(),
            });
            if (result.status === "configured_pending_page_save") changed = true;
          } catch (error) {
            record.status = error.status ?? "configure_failed";
            record.failure_reason = error.message;
            record.updated_at = now();
            await editor.page.screenshot({ path: path.join(artifactsDir, `${safePageName}-failed-${record.slot_index}-${record.block_id}.png`), fullPage: false, timeout: 7000 }).catch(() => {});
          }
          state.updated_at = now();
          await saveJsonAtomic(statePath, state);
          await reportsWriter(state);
        }

        if (changed || targetPage.records.some((record) => record.status === "configured_pending_page_save")) {
          targetPage.save_evidence = await editor.savePage();
          targetPage.saved_at = now();
          for (const record of targetPage.records.filter((item) => item.status === "configured_pending_page_save")) {
            record.status = "configured";
            record.saved_at = targetPage.saved_at;
            for (const item of record.editors) item.status = "configured";
          }
          await saveJsonAtomic(statePath, state);
          await reportsWriter(state);
        }

        const toVerify = targetPage.records.filter((record) => record.status === "configured");
        if (toVerify.length > 0) {
          await editor.reopenCustomPage(targetPage.name);
          const verifier = new V4RichTextSetupUi(editor);
          for (const record of toVerify) {
            try {
              record.editors = await verifyRecordWithRetry(verifier, record);
              record.verified_count = record.editors.length;
              record.status = "verified";
              record.failure_reason = "";
              record.verified_at = now();
            } catch (error) {
              record.status = error.status ?? "reopen_verify_failed";
              record.failure_reason = error.message;
              if (error.details?.editors) record.editors = error.details.editors;
              await editor.page.screenshot({ path: path.join(artifactsDir, `${safePageName}-verify-failed-${record.slot_index}-${record.block_id}.png`), fullPage: false, timeout: 7000 }).catch(() => {});
            }
            state.updated_at = now();
            await saveJsonAtomic(statePath, state);
            await reportsWriter(state);
          }
          targetPage.reopen_verified_at = now();
        }

        targetPage.status = pageIsFinal(targetPage) ? "complete" : "complete_with_failures";
        targetPage.failure_reason = targetPage.status === "complete" ? "" : "存在未验证区块，运行resume重试";
        targetPage.updated_at = now();
        state.updated_at = now();
        await saveJsonAtomic(statePath, state);
        await reportsWriter(state);
        await editor.page.screenshot({ path: path.join(artifactsDir, `${safePageName}-final.png`), fullPage: false, timeout: 7000 }).catch(() => {});
      } catch (error) {
        targetPage.status = "page_failed";
        targetPage.failure_reason = error.message;
        targetPage.updated_at = now();
        state.updated_at = now();
        await saveJsonAtomic(statePath, state);
        await reportsWriter(state);
      } finally {
        if (traceStarted) await context.tracing.stop({ path: tracePath }).catch(() => {});
      }
    }
    return state;
  } finally {
    await context.close();
  }
}

