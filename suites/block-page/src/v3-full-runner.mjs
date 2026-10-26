import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pageDescriptor } from "./config.mjs";
import { LeadongEditor, launchEditorBrowser, stopTrace } from "./editor.mjs";
import { writeV3FullReports } from "./v3-full-report.mjs";

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function nextPending(state) {
  return state.records.find((record) => record.status === "pending") ?? null;
}

function applyAudit(record, audit) {
  Object.assign(record, {
    editor_dom_id: audit.editor_dom_id,
    h1_count: audit.heading_counts.h1,
    h2_count: audit.heading_counts.h2,
    h3_count: audit.heading_counts.h3,
    h4_count: audit.heading_counts.h4,
    h5_count: audit.heading_counts.h5,
    h6_count: audit.heading_counts.h6,
    image_count: audit.image_count,
    image_urls: audit.images.map((image) => image.src).filter(Boolean),
    audit,
  });
}

async function persist(state, store, config) {
  await store.save(state);
  await writeV3FullReports(state, config.paths.v3FullReportsDir);
}

async function screenshot(page, config, label) {
  const directory = path.join(config.paths.v3FullArtifactsDir, "screenshots");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${timestamp()}-${label}.png`);
  await page.screenshot({ path: target, fullPage: true, timeout: 15000 }).catch(() => {});
  return target;
}

async function openOrCreateNewPage(editor, state, store, config) {
  const descriptor = pageDescriptor(config, state.next_page_number);
  if (await editor.customPageExists(descriptor.name)) {
    await editor.openCustomPage(descriptor.name);
    const existing = await editor.listCanvasBlockIds();
    if (existing.length > 0) {
      throw new Error(`${descriptor.name}已存在且含区块${existing.map((item) => item.block_id).join("、")}，拒绝接管`);
    }
  } else {
    await editor.createCustomPage(descriptor);
  }
  state.current_page = {
    ...descriptor,
    block_ids: [],
    created_at: new Date().toISOString(),
    imported: false,
  };
  await persist(state, store, config);
}

async function reconcileCurrentPage(editor, state, store, config) {
  if (!state.current_page) return;
  await editor.openCustomPage(state.current_page.name);
  // A previous run may have stopped after an invalid unsaved insertion whose
  // icon-only delete control was not recognized. Remove that orphan before
  // reconciling the staged records, then safely requeue the block.
  for (const failed of state.records.filter(
    (record) =>
      record.status === "render_failed" &&
      !state.current_page.block_ids.includes(record.block_id),
  )) {
    const roots = await editor.auditBlock(failed.block_id);
    if (roots.length > 0) {
      const removed = await editor.removeBlock(failed.block_id, roots);
      if (!removed) {
        if (state.current_page.block_ids.length === 0) {
          state.abandoned_pages = [
            ...(state.abandoned_pages ?? []),
            {
              ...state.current_page,
              abandoned_at: new Date().toISOString(),
              failed_block_id: failed.block_id,
              reason: failed.failure_reason,
            },
          ];
          state.current_page = null;
          state.next_page_number += 1;
          await persist(state, store, config);
          return;
        }
        throw new Error(`区块${failed.block_id}的异常未保存节点仍存在且无法删除`);
      }
    }
    failed.retry_history = [
      ...(failed.retry_history ?? []),
      {
        at: new Date().toISOString(),
        stage: "render_cleanup",
        status: failed.status,
        reason: failed.failure_reason ?? "",
      },
    ];
    Object.assign(failed, {
      status: "pending",
      failure_reason: "",
      audit: null,
      heading_status: "pending",
      heading_failure_reason: "",
    });
  }
  // If a page save succeeded but one staged block was absent after reopen,
  // keep the persisted blocks and free only that missing slot. This lets the
  // next pending block fill the page without duplicating the five blocks that
  // were already saved successfully.
  for (const failed of state.records.filter(
    (record) =>
      record.status === "save_failed" &&
      record.page_name === state.current_page.name &&
      state.current_page.block_ids.includes(record.block_id),
  )) {
    const roots = await editor.auditBlock(failed.block_id);
    if (roots.length > 1) {
      throw new Error(`区块${failed.block_id}重开后出现${roots.length}个节点，拒绝自动恢复`);
    }
    if (roots.length === 1) {
      failed.status = "staged";
      failed.failure_reason = "";
      applyAudit(failed, roots[0]);
      continue;
    }
    state.current_page.block_ids = state.current_page.block_ids.filter(
      (id) => id !== failed.block_id,
    );
    failed.heading_status = "not_applicable_not_added";
    failed.heading_failure_reason = "区块保存后重开不存在，本阶段无法设置H2";
    failed.retry_history = [
      ...(failed.retry_history ?? []),
      {
        at: new Date().toISOString(),
        stage: "save_reconcile",
        status: failed.status,
        reason: failed.failure_reason ?? "",
      },
    ];
  }
  const staged = state.records
    .filter((record) => record.status === "staged" && record.page_name === state.current_page.name)
    .sort((left, right) => left.slot_index - right.slot_index);
  if (staged.length !== state.current_page.block_ids.length) {
    throw new Error(`${state.current_page.name}暂存记录与页面状态数量不一致，拒绝恢复`);
  }
  const present = [];
  for (const record of staged) {
    const audits = await editor.auditBlock(record.block_id);
    present.push(audits.length === 1);
    if (audits.length === 1) applyAudit(record, audits[0]);
  }
  if (present.every(Boolean)) {
    await persist(state, store, config);
    return;
  }
  if (present.every((value) => !value)) {
    for (const record of staged) {
      Object.assign(record, {
        page_name: "", page_url: "", slot_index: "", editor_dom_id: "",
        status: "pending", failure_reason: "", audit: null,
      });
    }
    state.current_page.block_ids = [];
    await persist(state, store, config);
    return;
  }
  throw new Error(`${state.current_page.name}仅部分暂存区块存在，需人工确认，脚本不会重复添加`);
}

async function saveAndVerifyCurrentPage(editor, state, store, config) {
  const pageState = state.current_page;
  if (!pageState || pageState.block_ids.length === 0) return false;
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await editor.savePage();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt === 1) await editor.page.waitForTimeout(1000);
    }
  }
  const records = state.records
    .filter((record) => record.status === "staged" && record.page_name === pageState.name)
    .sort((left, right) => left.slot_index - right.slot_index);
  if (lastError) {
    for (const record of records) {
      record.status = "save_failed";
      record.failure_reason = lastError.message;
    }
    await persist(state, store, config);
    throw new Error(`${pageState.name}连续两次保存失败：${lastError.message}`);
  }

  await editor.openCustomPage(pageState.name);
  const verifiedAudits = [];
  for (const record of records) {
    const audits = await editor.auditBlock(record.block_id);
    if (audits.length !== 1) {
      record.status = "save_failed";
      record.failure_reason = `保存后重开，目标区块数量为${audits.length}`;
      await persist(state, store, config);
      throw new Error(`${pageState.name}重开验证失败：区块${record.block_id}数量=${audits.length}`);
    }
    verifiedAudits.push(audits[0]);
  }
  const actualOrder = records
    .map((record, index) => ({ record, audit: verifiedAudits[index] }))
    .sort((left, right) => left.audit.dom_index - right.audit.dom_index);
  const expected = records.map((record) => record.block_id);
  const observed = actualOrder.map(({ record }) => record.block_id);
  if (observed.join("\0") !== expected.join("\0")) {
    // Some custom blocks move themselves around the content rows during the
    // save/reload lifecycle. All targets are still unique and present, so the
    // authoritative mapping must follow the persisted DOM order rather than
    // rejecting an otherwise valid page.
    for (let index = 0; index < actualOrder.length; index += 1) {
      actualOrder[index].record.slot_index = index + 1;
      actualOrder[index].record.order_reconciled_at = new Date().toISOString();
    }
    pageState.block_ids = observed;
    pageState.order_reconciled = true;
  }
  const savedAt = new Date().toISOString();
  for (let index = 0; index < records.length; index += 1) {
    applyAudit(records[index], verifiedAudits[index]);
    records[index].status = "added_new";
    records[index].failure_reason = "";
    records[index].saved_at = savedAt;
  }
  state.pages.push({ ...pageState, saved_at: savedAt });
  state.current_page = null;
  state.next_page_number += 1;
  await persist(state, store, config);
  return true;
}

function assignFailure(record, outcome) {
  record.status = outcome.outcome === "not_found" ? "not_found" : outcome.outcome;
  record.failure_reason = outcome.reason ?? (outcome.outcome === "not_found" ? "输入block_id并回车后没有精确结果" : "未提供失败原因");
  record.audit = outcome.audit ?? null;
  record.heading_status = "not_applicable_not_added";
  record.heading_failure_reason = "区块未成功添加，本阶段无法设置H2";
}

export async function runV3FullAdd({ config, state, store, maxPages = 0, maxBlocks = 0, headless = false }) {
  const tracePath = path.join(config.paths.v3FullArtifactsDir, "traces", `add-${timestamp()}.zip`);
  const { context, page } = await launchEditorBrowser(config, { headless, traceName: "3.0本期H区块铺页" });
  const editor = new LeadongEditor(page, config);
  let added = 0;
  let savedPages = 0;
  try {
    await editor.goto();
    await reconcileCurrentPage(editor, state, store, config);
    if (state.current_page?.block_ids.length >= config.blocksPerPage) {
      if (await saveAndVerifyCurrentPage(editor, state, store, config)) {
        savedPages += 1;
      }
    }
    while (nextPending(state)) {
      if (maxPages > 0 && savedPages >= maxPages) break;
      if (maxBlocks > 0 && added >= maxBlocks) break;
      if (!state.current_page) await openOrCreateNewPage(editor, state, store, config);
      const record = nextPending(state);
      record.attempt_count += 1;
      let outcome;
      try {
        outcome = await editor.searchAndAdd(record.block_id);
      } catch (error) {
        if (/登录状态失效|未进入领动编辑器|未找到“添加区块到内容区”/u.test(error.message)) throw error;
        outcome = { outcome: "add_failed", reason: error.message };
      }
      if (outcome.outcome === "added") {
        const slot = state.current_page.block_ids.length + 1;
        Object.assign(record, {
          page_name: state.current_page.name,
          page_url: state.current_page.publicUrl,
          slot_index: slot,
          status: "staged",
          failure_reason: "",
        });
        applyAudit(record, outcome.audit);
        state.current_page.block_ids.push(record.block_id);
        added += 1;
      } else {
        assignFailure(record, outcome);
        const roots = await editor.auditBlock(record.block_id);
        if (roots.length > 0) {
          const removed = await editor.removeBlock(record.block_id, outcome.audit ?? roots);
          if (!removed) {
            // A failed render can leave an unsaved editor node whose hover
            // delete control is not exposed as text.  Reopening the current
            // underfilled page discards that unsaved node safely.  Only use
            // this recovery when no page save could have included the failed
            // block and every previously staged block is still present.
            const activePage = state.current_page;
            if (activePage && activePage.block_ids.length === 0) {
              state.abandoned_pages = [
                ...(state.abandoned_pages ?? []),
                {
                  ...activePage,
                  abandoned_at: new Date().toISOString(),
                  failed_block_id: record.block_id,
                  reason: record.failure_reason,
                },
              ];
              state.current_page = null;
              state.next_page_number += 1;
              await persist(state, store, config);
              continue;
            }
            const canDiscardUnsaved = activePage &&
              activePage.block_ids.length < config.blocksPerPage;
            if (canDiscardUnsaved) {
              await editor.openCustomPage(activePage.name);
              const stagedPresent = await Promise.all(
                activePage.block_ids.map(async (id) => (await editor.auditBlock(id)).length === 1),
              );
              const failedStillPresent = (await editor.auditBlock(record.block_id)).length > 0;
              if (stagedPresent.every(Boolean) && !failedStillPresent) {
                await persist(state, store, config);
                continue;
              }
            }
            throw new Error(`区块${record.block_id}失败后无法安全移除，已停止`);
          }
        }
      }
      await persist(state, store, config);
      if (state.current_page.block_ids.length >= config.blocksPerPage || (maxBlocks > 0 && added >= maxBlocks)) {
        if (await saveAndVerifyCurrentPage(editor, state, store, config)) savedPages += 1;
      }
    }
    const noPending = !nextPending(state);
    if (state.current_page?.block_ids.length > 0 && (noPending || state.current_page.block_ids.length >= config.blocksPerPage) && (maxPages === 0 || savedPages < maxPages)) {
      if (await saveAndVerifyCurrentPage(editor, state, store, config)) savedPages += 1;
    }
    if (noPending && state.current_page?.block_ids.length === 0) {
      state.abandoned_pages = [
        ...(state.abandoned_pages ?? []),
        {
          ...state.current_page,
          abandoned_at: new Date().toISOString(),
          failed_block_id: "",
          reason: "剩余候选均未成功添加，空页面未执行保存",
        },
      ];
      state.current_page = null;
      state.next_page_number += 1;
      await persist(state, store, config);
    }
    return { added, savedPages, tracePath };
  } catch (error) {
    if (/登录|signin|passport/u.test(`${error.message} ${editor.page.url()}`)) {
      const staged = state.records.filter((record) => record.status === "staged");
      for (const record of staged) record.failure_reason = `login_expired: ${error.message}`;
    }
    await screenshot(editor.page, config, "add-error");
    throw error;
  } finally {
    await persist(state, store, config);
    await stopTrace(context, tracePath).catch(() => {});
    await context.close().catch(() => {});
  }
}
