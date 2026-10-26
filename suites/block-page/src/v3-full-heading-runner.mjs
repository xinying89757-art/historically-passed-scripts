import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { LeadongEditor, launchEditorBrowser, stopTrace } from "./editor.mjs";
import {
  MODAL_HEADING_TEMPLATES,
  cancelModal,
  configureInlineEditors,
  configureInlineEditorsFast,
  configureModalEditors,
  configureModalEditorsFast,
  disableHiddenOverlayInterception,
  inspectExpectedHeadings,
  openSettings,
  reopenCustomPage,
  saveActivatedInlineSettings,
  verifySettingsBackfill,
} from "./ranking-heading-poc.mjs";
import { writeV3FullReports } from "./v3-full-report.mjs";

const FINAL_HEADING_STATUSES = new Set([
  "configured_verified",
  "unsupported_no_h_control",
  "heading_failed",
  "save_failed",
]);

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export async function prepareFastV3FullHeadingState(state, store, stateFile) {
  const backupPath = `${stateFile}.before-fast-${timestamp()}.bak`;
  await copyFile(stateFile, backupPath);
  const resetReasons = [];
  const previousFastPreparedAt = state.fast_mode?.prepared_at ?? "";
  for (const record of state.records) {
    const operationalFailure = /Element is not visible|格式菜单中可见“标题 2”的数量为 0|快速写入失败/iu.test(record.heading_failure_reason ?? "");
    const accidentalFastUnsupported = record.heading_status === "unsupported_no_h_control" &&
      previousFastPreparedAt && record.heading_verified_at > previousFastPreparedAt;
    if (record.heading_status === "configured_pending_page_save" || (record.heading_status === "heading_failed" && operationalFailure) || accidentalFastUnsupported) {
      resetReasons.push({ block_id: record.block_id, from: record.heading_status, reason: record.heading_failure_reason ?? "" });
      record.heading_status = "pending";
      record.heading_failure_reason = "";
      record.heading_results = [];
      record.heading_poc = [];
      record.heading_verified_at = "";
      record.fast_mode_reset_at = new Date().toISOString();
    }
  }
  state.fast_mode = {
    enabled: true,
    prepared_at: new Date().toISOString(),
    backup_path: backupPath,
    reset_records: resetReasons,
  };
  await store.save(state);
  return { backupPath, resetReasons };
}

/**
 * Requeue every previously unsuccessful heading attempt whose page/block still
 * exists. Missing legacy ranking pages are intentionally retained as failures:
 * there is no safe editor surface to retry against.
 */
export async function prepareRetryV3FullHeadingState(state, store, stateFile) {
  const backupPath = `${stateFile}.before-retry-${timestamp()}.bak`;
  await copyFile(stateFile, backupPath);
  const resetReasons = [];
  for (const record of state.records) {
    const retryablePlacement = ["existing_added", "added_new"].includes(record.status);
    const retryableHeading = ["heading_failed", "save_failed", "unsupported_no_h_control"].includes(record.heading_status);
    if (!retryablePlacement || !retryableHeading) continue;
    resetReasons.push({ block_id: record.block_id, from: record.heading_status, reason: record.heading_failure_reason ?? "" });
    record.heading_status = "pending";
    record.heading_failure_reason = "";
    record.heading_results = [];
    record.heading_poc = [];
    record.heading_verified_at = "";
    record.retry_reset_at = new Date().toISOString();
  }
  state.retry_mode = {
    enabled: true,
    prepared_at: new Date().toISOString(),
    backup_path: backupPath,
    reset_records: resetReasons,
  };
  await store.save(state);
  return { backupPath, resetReasons };
}

async function persist(state, store, config) {
  await store.save(state);
  await writeV3FullReports(state, config.paths.v3FullReportsDir);
}

async function persistStateOnly(state, store) {
  await store.save(state);
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超过${timeoutMs}毫秒`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function screenshot(page, config, label) {
  const directory = path.join(config.paths.v3FullArtifactsDir, "screenshots");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${timestamp()}-${label}.png`);
  await page.screenshot({ path: target, fullPage: true, timeout: 15000 }).catch(() => {});
  return target;
}

function supportedForHeading(record) {
  return ["existing_added", "added_new"].includes(record.status) && !FINAL_HEADING_STATUSES.has(record.heading_status);
}

function groupsByPage(state, selectedIds = null) {
  const groups = new Map();
  for (const record of state.records.filter(supportedForHeading)) {
    if (selectedIds && !selectedIds.has(record.block_id)) continue;
    if (!record.page_name) continue;
    if (!groups.has(record.page_name)) groups.set(record.page_name, []);
    groups.get(record.page_name).push(record);
  }
  for (const records of groups.values()) records.sort((a, b) => Number(a.slot_index) - Number(b.slot_index));
  return groups;
}

export function selectV3FullHeadingPocRecords(state) {
  const types = ["文本编辑", "多媒体集类型1", "多媒体集类型2", "图片集类型1", "图片集类型2", "图片集类型3", "图文页签"];
  const eligible = state.records.filter(supportedForHeading);
  const selected = [];
  const selectedIds = new Set();
  for (const type of types) {
    const candidates = eligible.filter(
      (record) =>
        record.template_types.includes(type) &&
        !selectedIds.has(record.block_id) &&
        !record.page_name.startsWith("区块排名H测试-"),
    );
    const preferred = candidates.find((record) => record.heading_status === "existing_configured_unverified") ?? candidates[0];
    if (preferred) {
      selected.push(preferred);
      selectedIds.add(preferred.block_id);
    }
  }
  return selected;
}

export function finalizeV3HeadingVerification(record, verification) {
  const wasFullyConfiguredBeforeSave = record.heading_status === "configured_pending_page_save";
  if (verification.ok && wasFullyConfiguredBeforeSave) {
    record.heading_status = "configured_verified";
    record.heading_failure_reason = "";
  } else if (!verification.ok) {
    record.heading_status = "heading_failed";
    record.heading_failure_reason = [record.heading_failure_reason, verification.reason].filter(Boolean).join("；");
  }
  return record;
}

async function verifyRecord(editor, record) {
  let verification = await inspectExpectedHeadings(editor, record);
  if (!verification.ok && record.template_types.some((type) => MODAL_HEADING_TEMPLATES.has(type))) {
    verification = await verifySettingsBackfill(editor, record, verification);
  }
  return verification;
}

async function configureRecord(editor, record) {
  record.heading_text_mode = "v3_full";
  record.heading_poc = [];
  record.heading_results = [];
  const operationalErrors = [];
  const unsupportedReasons = [];
  await disableHiddenOverlayInterception(editor);
  let audits = await editor.auditBlock(record.block_id);
  if (audits.length !== 1) {
    record.status = "existing_mapping_missing";
    record.failure_reason = `页面中目标block_id数量为${audits.length}，不自动重新添加`;
    record.heading_status = "heading_failed";
    record.heading_failure_reason = record.failure_reason;
    return { changed: false, fatal: false };
  }
  record.editor_dom_id = audits[0].editor_dom_id;
  record.audit = audits[0];
  const configured = await configureInlineEditors(editor, audits[0], record, 1);
  operationalErrors.push(...(configured.errors ?? []));

  const needsModal = record.template_types.some((type) => MODAL_HEADING_TEMPLATES.has(type));
  const settings = needsModal ? await openSettings(editor, audits[0]) : { opened: false };
  if (needsModal && !settings.opened && configured.length === 0) {
    unsupportedReasons.push("模板需要设置弹窗，但未找到区块设置入口");
  } else if (settings.opened) {
    try {
      const modal = await configureModalEditors(editor, record, configured.length + 1);
      configured.push(...modal.configured);
      if (modal.configured.length === 0) {
        unsupportedReasons.push("设置弹窗没有支持格式→标题2的富文本输入区");
        await cancelModal(editor);
      }
    } catch (error) {
      if (!/可见设置弹窗保存按钮所在上下文数量为 0/u.test(error.message)) throw error;
      audits = await editor.auditBlock(record.block_id);
      if (audits.length !== 1) throw error;
      const activated = await configureInlineEditors(editor, audits[0], record, configured.length + 1);
      operationalErrors.push(...(activated.errors ?? []));
      if (activated.length === 0) throw error;
      configured.push(...activated);
      await saveActivatedInlineSettings(settings, editor);
    }
  }
  if (configured.length === 0 && operationalErrors.length === 0 && unsupportedReasons.length === 0) {
    unsupportedReasons.push("区块没有可设置H标签的文本输入区");
  }
  record.heading_poc = configured;
  record.heading_results = configured;
  // A mixed template may contain one writable inline editor and another
  // settings panel that simply has no H-capable field.  The writable editor
  // is still a valid success; keep the unsupported part as a warning instead
  // of discarding the successful write.
  record.heading_failure_reason = operationalErrors.join("；");
  record.heading_warning = unsupportedReasons.join("；");
  record.heading_verified_at = new Date().toISOString();
  if (configured.length === 0 && operationalErrors.length === 0 && unsupportedReasons.length > 0) {
    record.heading_status = "unsupported_no_h_control";
    return { changed: false, fatal: false };
  }
  if (configured.length === 0 || operationalErrors.length > 0) {
    record.heading_status = "heading_failed";
    return { changed: configured.length > 0, fatal: false };
  }
  record.heading_status = "configured_pending_page_save";
  return { changed: true, fatal: false };
}

async function configureRecordFast(editor, record, initialAudit = null) {
  record.heading_text_mode = "v3_full";
  record.heading_poc = [];
  record.heading_results = [];
  const operationalErrors = [];
  const unsupportedReasons = [];
  await disableHiddenOverlayInterception(editor);
  let audits = initialAudit ? [initialAudit] : await editor.auditBlock(record.block_id);
  if (audits.length !== 1) {
    record.status = "existing_mapping_missing";
    record.failure_reason = `页面中目标block_id数量为${audits.length}，不自动重新添加`;
    record.heading_status = "heading_failed";
    record.heading_failure_reason = record.failure_reason;
    return { changed: false, fatal: false };
  }
  record.editor_dom_id = audits[0].editor_dom_id;
  record.audit = audits[0];
  const configured = await configureInlineEditorsFast(editor, audits[0], record, 1);
  operationalErrors.push(...(configured.errors ?? []));
  const needsModal = record.template_types.some((type) => MODAL_HEADING_TEMPLATES.has(type));
  const settings = needsModal ? await openSettings(editor, audits[0]) : { opened: false };
  if (needsModal && !settings.opened && configured.length === 0) {
    unsupportedReasons.push("模板需要设置弹窗，但未找到区块设置入口");
  } else if (settings.opened) {
    try {
      const modal = await configureModalEditorsFast(editor, record, configured.length + 1);
      configured.push(...modal.configured);
      operationalErrors.push(...(modal.errors ?? []));
      if (modal.configured.length === 0) {
        unsupportedReasons.push("设置弹窗没有支持格式→标题2的富文本输入区");
        await cancelModal(editor);
      }
    } catch (error) {
      if (!/可见设置弹窗保存按钮所在上下文数量为 0/u.test(error.message)) throw error;
      audits = await editor.auditBlock(record.block_id);
      if (audits.length !== 1) throw error;
      const activated = await configureInlineEditorsFast(editor, audits[0], record, configured.length + 1);
      operationalErrors.push(...(activated.errors ?? []));
      if (activated.length === 0) throw error;
      configured.push(...activated);
      await saveActivatedInlineSettings(settings, editor);
    }
  }
  if (configured.length === 0 && operationalErrors.length === 0 && unsupportedReasons.length === 0) {
    unsupportedReasons.push("区块没有可设置H标签的文本输入区");
  }
  record.heading_poc = configured;
  record.heading_results = configured;
  record.heading_failure_reason = operationalErrors.join("；");
  record.heading_warning = unsupportedReasons.join("；");
  record.heading_verified_at = new Date().toISOString();
  if (configured.length === 0 && operationalErrors.length === 0 && unsupportedReasons.length > 0) {
    record.heading_status = "unsupported_no_h_control";
    return { changed: false, fatal: false };
  }
  if (configured.length === 0 || operationalErrors.length > 0) {
    record.heading_status = "heading_failed";
    return { changed: configured.length > 0, fatal: false };
  }
  record.heading_status = "configured_pending_page_save";
  return { changed: true, fatal: false };
}

async function savePageWithRetry(editor) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await disableHiddenOverlayInterception(editor);
      return await editor.savePage();
    } catch (error) {
      lastError = error;
      if (attempt === 1) await editor.page.waitForTimeout(1000);
    }
  }
  throw lastError;
}

export async function runV3FullHeadings({ config, state, store, maxPages = 0, headless = false, selectedIds = null, pageName = null, writeMode = "ui" }) {
  const tracePath = path.join(config.paths.v3FullArtifactsDir, "traces", `heading-${timestamp()}.zip`);
  const { context, page } = await launchEditorBrowser(config, {
    headless,
    slowMo: selectedIds ? 220 : writeMode === "ckeditor_api" ? 20 : 80,
    traceName: writeMode === "ckeditor_api" ? undefined : "3.0本期区块H2测试数据",
  });
  const fastTracing = writeMode === "ckeditor_api";
  if (fastTracing) {
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
      title: "3.0快速H2测试数据",
    });
  }
  const editor = new LeadongEditor(page, config);
  let processedPages = 0;
  let configured = 0;
  let retained = 0;
  let unsupported = 0;
  let activeChunk = null;
  const finishChunk = async (failed = false) => {
    if (!activeChunk) return;
    const chunkPath = failed
      ? path.join(config.paths.v3FullArtifactsDir, "traces", `heading-${timestamp()}-${activeChunk}.zip`)
      : undefined;
    await context.tracing.stopChunk({ path: chunkPath }).catch(() => {});
    activeChunk = null;
  };
  try {
    await editor.goto();
    const groups = groupsByPage(state, selectedIds);
    if (pageName) {
      for (const name of groups.keys()) {
        if (name !== pageName) groups.delete(name);
      }
    }
    for (const [pageName, pageRecords] of groups) {
      if (maxPages > 0 && processedPages >= maxPages) break;
      if (fastTracing) {
        activeChunk = pageName.replaceAll(/[^\p{L}\p{N}-]+/gu, "-");
        await context.tracing.startChunk({ title: pageName, name: activeChunk });
      }
      try {
        await reopenCustomPage(editor, pageName);
      } catch (error) {
        for (const record of pageRecords) {
          record.status = "existing_mapping_missing";
          record.failure_reason = `旧映射页面无法打开，不自动重新添加：${error.message}`;
          record.heading_status = "heading_failed";
          record.heading_failure_reason = record.failure_reason;
          record.heading_verified_at = new Date().toISOString();
        }
        await screenshot(editor.page, config, `missing-page-${pageName.replaceAll(/[^\p{L}\p{N}-]+/gu, "-")}`);
        await persist(state, store, config);
        await finishChunk(true);
        processedPages += 1;
        continue;
      }
      let pageChanged = false;
      const changedRecords = [];
      const pageAudits = new Map(await Promise.all(pageRecords.map(async (record) => {
        try {
          return [
            record.block_id,
            await withTimeout(
              editor.auditBlock(record.block_id),
              config.timeouts.headingAuditMs ?? 20000,
              `区块${record.block_id}DOM审计`,
            ),
          ];
        } catch (error) {
          return [record.block_id, { audit_error: error.message }];
        }
      })));
      for (const record of pageRecords) {
        try {
          const auditResult = pageAudits.get(record.block_id);
          if (auditResult?.audit_error) throw new Error(auditResult.audit_error);
          const audits = auditResult ?? [];
          if (audits.length !== 1) {
            record.status = "existing_mapping_missing";
            record.failure_reason = `页面中目标block_id数量为${audits.length}，不自动重新添加`;
            record.heading_status = "heading_failed";
            record.heading_failure_reason = record.failure_reason;
            await persistStateOnly(state, store);
            continue;
          }
          record.editor_dom_id = audits[0].editor_dom_id;
          record.audit = audits[0];
          if (record.heading_status === "existing_configured_unverified" && (record.heading_poc ?? []).length > 0) {
            const existingVerification = await withTimeout(
              verifyRecord(editor, record),
              config.timeouts.headingVerifyMs ?? 60000,
              `区块${record.block_id}历史H2回填验证`,
            ).catch((error) => ({ ok: false, reason: error.message }));
            if (existingVerification.ok) {
              record.heading_status = "configured_verified";
              record.heading_failure_reason = "";
              record.heading_verified_at = new Date().toISOString();
              retained += 1;
              await persistStateOnly(state, store);
              continue;
            }
          }
          const outcome = await withTimeout(
            writeMode === "ckeditor_api"
              ? configureRecordFast(editor, record, audits[0])
              : configureRecord(editor, record),
            config.timeouts.headingRecordMs ?? 90000,
            `区块${record.block_id}${writeMode === "ckeditor_api" ? "快速" : "UI"}设置H2`,
          );
          // A prior interrupted run may already have written the rich text
          // and left the record in configured_pending_page_save.  It still
          // must participate in the page-level save/reopen verification even
          // when this retry detects the existing test heading and reports no
          // new change.
          if (outcome.changed || record.heading_status === "configured_pending_page_save") {
            pageChanged = true;
            if (!changedRecords.includes(record)) changedRecords.push(record);
            if (outcome.changed) configured += 1;
          } else if (record.heading_status === "unsupported_no_h_control") {
            unsupported += 1;
          }
        } catch (error) {
          record.heading_status = "heading_failed";
          record.heading_failure_reason = error.message;
          record.heading_verified_at = new Date().toISOString();
          await cancelModal(editor).catch(() => {});
          await screenshot(editor.page, config, `heading-${record.block_id}`);
        }
        await persistStateOnly(state, store);
      }

      if (pageChanged) {
        try {
          await savePageWithRetry(editor);
        } catch (error) {
          for (const record of changedRecords) {
            record.heading_status = "save_failed";
            record.heading_failure_reason = error.message;
          }
          await persistStateOnly(state, store);
          throw new Error(`${pageName}右上角保存连续失败：${error.message}`);
        }
        await reopenCustomPage(editor, pageName);
        const verificationResults = await Promise.all(changedRecords.map(async (record) => ({
          record,
          verification: writeMode === "ckeditor_api"
            ? await withTimeout(
              verifyRecord(editor, record),
              config.timeouts.headingVerifyMs ?? 60000,
              `区块${record.block_id}H2回填验证`,
            ).catch((error) => ({ ok: false, reason: error.message }))
            : await inspectExpectedHeadings(editor, record),
        })));
        for (const item of verificationResults) {
          const record = item.record;
          let verification = item.verification;
          if (writeMode !== "ckeditor_api" &&
              !verification.ok &&
              record.template_types.some((type) => MODAL_HEADING_TEMPLATES.has(type))) {
            verification = await verifySettingsBackfill(editor, record, verification);
          }
          record.heading_verified_at = new Date().toISOString();
          finalizeV3HeadingVerification(record, verification);
          if (!verification.ok) {
            await screenshot(editor.page, config, `verify-${record.block_id}`);
          }
          await persistStateOnly(state, store);
        }
      }
      await persist(state, store, config);
      const pageHasFailure = pageRecords.some((record) =>
        ["heading_failed", "save_failed"].includes(record.heading_status) ||
        record.status === "existing_mapping_missing",
      );
      await finishChunk(pageHasFailure);
      processedPages += 1;
    }
    return { processedPages, configured, retained, unsupported, tracePath };
  } finally {
    await persist(state, store, config);
    await finishChunk(true);
    if (fastTracing) {
      await context.tracing.stop().catch(() => {});
    } else {
      await stopTrace(context, tracePath).catch(() => {});
    }
    await context.close().catch(() => {});
  }
}
