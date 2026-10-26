import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  LeadongEditor,
  launchEditorBrowser,
  stopTrace,
} from "./editor.mjs";
import { pageDescriptor } from "./config.mjs";
import {
  assertStateComplete,
  FINAL_STATUSES,
  resetStagedFromIndex,
} from "./state.mjs";
import { writeReports } from "./report.mjs";

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function matchesPreDeferred(record, config) {
  return (config.preDeferredNameKeywords ?? []).some((keyword) =>
    record.app_name.includes(keyword),
  );
}

export function preclassifyDeferred(state, config) {
  let count = 0;
  for (const record of state.records) {
    const canSafelyReclassify = [
      "pending",
      "not_found",
      "locator_ambiguous",
      "add_failed",
      "render_failed",
    ].includes(record.status);
    if (canSafelyReclassify && matchesPreDeferred(record, config)) {
      const keyword = config.preDeferredNameKeywords.find((candidate) =>
        record.app_name.includes(candidate),
      );
      record.status = "deferred_detail";
      record.failure_reason = `CSV 名称命中已确认的暂缓关键词：${keyword}`;
      record.attempt_count = 0;
      count += 1;
    }
  }
  return count;
}

export function repairMissingEnterMisclassification(state) {
  const repairedIndexes = [];
  const retryIndexes = [];
  for (let index = 0; index < state.records.length; index += 1) {
    const record = state.records[index];
    const legacyNotFoundReason =
      record.status === "deferred_detail" &&
      /^自定义页面区块面板中两次搜索均无精确 block_id$/.test(
        record.failure_reason,
      );
    const uiCalibrationFailure =
      record.status === "add_failed" &&
      /(请输入区块ID或标签|backstage-creatmodules-addbtn|addIcon|区块侧边栏|结果卡片中没有(?:可见)?“添加”按钮)/.test(
        record.failure_reason,
      );
    if (legacyNotFoundReason) {
      record.failure_reason = "输入 block_id 并按回车后无精确搜索结果";
      repairedIndexes.push(index);
    } else if (uiCalibrationFailure) {
      Object.assign(record, {
        page_name: "",
        page_url: "",
        slot_index: "",
        editor_dom_id: "",
        h1_count: 0,
        h2_count: 0,
        h3_count: 0,
        h4_count: 0,
        h5_count: 0,
        h6_count: 0,
        image_count: 0,
        image_urls: [],
        status: "pending",
        failure_reason: "",
        attempt_count: 0,
        saved_at: "",
        published: false,
        audit: null,
      });
      repairedIndexes.push(index);
      retryIndexes.push(index);
    }
  }
  if (retryIndexes.length > 0) {
    state.next_csv_index = Math.min(...retryIndexes);
  }
  return repairedIndexes.length;
}

export function repairCollapsedPanelFailures(state) {
  const repairedIndexes = [];
  for (let index = 0; index < state.records.length; index += 1) {
    const record = state.records[index];
    const panelMayHaveBeenCollapsed =
      record.status === "render_failed" &&
      /^添加后 .*秒内(未检测到目标 block_id|没有检测到目标 DOM 或加载信号)$/.test(
        record.failure_reason,
      );
    if (!panelMayHaveBeenCollapsed) {
      continue;
    }
    Object.assign(record, {
      page_name: "",
      page_url: "",
      slot_index: "",
      editor_dom_id: "",
      h1_count: 0,
      h2_count: 0,
      h3_count: 0,
      h4_count: 0,
      h5_count: 0,
      h6_count: 0,
      image_count: 0,
      image_urls: [],
      status: "pending",
      failure_reason: "",
      attempt_count: 0,
      saved_at: "",
      published: false,
      audit: null,
    });
    repairedIndexes.push(index);
  }
  if (repairedIndexes.length > 0) {
    state.next_csv_index = Math.min(...repairedIndexes);
  }
  return repairedIndexes.length;
}

export function repairSearchTimingFailures(state) {
  const repairedIndexes = [];
  for (let index = 0; index < state.records.length; index += 1) {
    const record = state.records[index];
    if (
      record.status !== "deferred_detail" ||
      record.failure_reason !==
        "输入 block_id 并按回车后无精确搜索结果"
    ) {
      continue;
    }
    Object.assign(record, {
      page_name: "",
      page_url: "",
      slot_index: "",
      editor_dom_id: "",
      h1_count: 0,
      h2_count: 0,
      h3_count: 0,
      h4_count: 0,
      h5_count: 0,
      h6_count: 0,
      image_count: 0,
      image_urls: [],
      status: "pending",
      failure_reason: "",
      attempt_count: 0,
      saved_at: "",
      published: false,
      audit: null,
    });
    repairedIndexes.push(index);
  }
  if (repairedIndexes.length > 0) {
    state.next_csv_index = Math.min(...repairedIndexes);
  }
  return repairedIndexes.length;
}

function nextPendingIndex(state, from = state.next_csv_index) {
  for (let index = from; index < state.records.length; index += 1) {
    if (state.records[index].status === "pending") {
      return index;
    }
  }
  return -1;
}

async function persist(state, store, config) {
  await store.save(state);
  await writeReports(state, config.paths.reportsDir);
}

async function screenshot(page, config, label) {
  const directory = path.join(config.paths.artifactsDir, "screenshots");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${timestamp()}-${label}.png`);
  await page.screenshot({ path: target, fullPage: true }).catch(() => {});
  return target;
}

async function reconcileCurrentPage(editor, state, store, config) {
  if (!state.current_page) {
    return;
  }
  await editor.openCustomPage(state.current_page.name);
  const saveFailed = state.records.filter(
    (record) =>
      record.status === "save_failed" &&
      record.page_name === state.current_page.name,
  );
  if (saveFailed.length > 0) {
    throw new Error(
      `${state.current_page.name} 上次保存失败，已保留现场；请人工确认页面后再处理状态文件，脚本不会自动继续写入`,
    );
  }
  const staged = state.records.filter(
    (record) =>
      record.status === "staged" &&
      record.page_name === state.current_page.name,
  );
  if (staged.length !== state.current_page.block_ids.length) {
    throw new Error(
      `${state.current_page.name} 的暂存状态与 block_ids 数量不一致，拒绝自动恢复`,
    );
  }
  const missing = [];
  for (const record of staged) {
    const audit = await editor.auditBlock(record.block_id);
    if (audit.length !== 1) {
      missing.push(record);
    } else {
      record.audit = audit[0];
      record.editor_dom_id = audit[0].editor_dom_id;
    }
  }
  if (missing.length > 0) {
    if (missing.length === staged.length) {
      const firstIndex = Math.min(
        ...missing.map((record) => state.records.indexOf(record)),
      );
      resetStagedFromIndex(state, firstIndex);
      state.current_page.block_ids = [];
      await persist(state, store, config);
      return;
    }
    await persist(state, store, config);
    throw new Error(
      `恢复对账发现 ${missing.length} 个暂存区块不在页面中。为避免重复添加或顺序错位，请先人工检查 ${state.current_page.name}。`,
    );
  }
  state.current_page.block_ids = staged
    .sort((left, right) => left.slot_index - right.slot_index)
    .map((record) => record.block_id);
  await persist(state, store, config);
}

async function saveCurrentPage(editor, state, store, config) {
  if (!state.current_page || state.current_page.block_ids.length === 0) {
    return false;
  }

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await editor.savePage();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt === 1) {
        await editor.page.waitForTimeout(1000);
      }
    }
  }

  const page = state.current_page;
  if (lastError) {
    for (const record of state.records) {
      if (record.status === "staged" && record.page_name === page.name) {
        record.status = "save_failed";
        record.failure_reason = lastError.message;
      }
    }
    await persist(state, store, config);
    throw new Error(
      `${page.name} 连续两次保存失败，任务停止：${lastError.message}`,
    );
  }

  const savedAt = new Date().toISOString();
  for (const record of state.records) {
    if (record.status === "staged" && record.page_name === page.name) {
      record.status = "added";
      record.saved_at = savedAt;
    }
  }
  state.pages.push({
    ...page,
    saved_at: savedAt,
  });
  state.current_page = null;
  state.next_page_number += 1;
  await persist(state, store, config);
  return true;
}

function assignFailure(record, outcome) {
  record.status =
    outcome.outcome === "not_found" ? "deferred_detail" : outcome.outcome;
  record.failure_reason =
    outcome.reason ??
    (outcome.outcome === "not_found"
      ? "输入 block_id 并按回车后无精确搜索结果"
      : "未提供失败原因");
  record.audit = outcome.audit ?? null;
}

function clearRecordPlacement(record, status, failureReason) {
  Object.assign(record, {
    page_name: "",
    page_url: "",
    slot_index: "",
    editor_dom_id: "",
    h1_count: 0,
    h2_count: 0,
    h3_count: 0,
    h4_count: 0,
    h5_count: 0,
    h6_count: 0,
    image_count: 0,
    image_urls: [],
    status,
    failure_reason: failureReason,
    attempt_count: 0,
    saved_at: "",
    published: false,
    audit: null,
  });
}

function assignAddedRecord(record, pageState, slot, audit, savedAt) {
  Object.assign(record, {
    page_name: pageState.name,
    page_url: pageState.publicUrl,
    slot_index: slot,
    editor_dom_id: audit.editor_dom_id,
    h1_count: audit.heading_counts.h1,
    h2_count: audit.heading_counts.h2,
    h3_count: audit.heading_counts.h3,
    h4_count: audit.heading_counts.h4,
    h5_count: audit.heading_counts.h5,
    h6_count: audit.heading_counts.h6,
    image_count: audit.image_count,
    image_urls: audit.images.map((image) => image.src).filter(Boolean),
    status: "added",
    failure_reason: "",
    saved_at: savedAt,
    published: false,
    audit,
  });
}

export async function provisionBlocks({
  config,
  input,
  store,
  maxBlocks = 0,
  maxPages = 0,
  headless,
}) {
  const state = await store.loadOrCreate(input, config);
  const preDeferred = preclassifyDeferred(state, config);
  await persist(state, store, config);

  const tracePath = path.join(
    config.paths.artifactsDir,
    "traces",
    `provision-${timestamp()}.zip`,
  );
  const { context, page } = await launchEditorBrowser(config, {
    headless,
    traceName: "领动区块铺页",
  });
  const editor = new LeadongEditor(page, config);
  let successfullyAddedThisRun = 0;
  let savedPagesThisRun = 0;
  let runError;

  try {
    await editor.goto();
    await reconcileCurrentPage(editor, state, store, config);

    while (true) {
      if (maxPages > 0 && savedPagesThisRun >= maxPages) {
        break;
      }
      if (maxBlocks > 0 && successfullyAddedThisRun >= maxBlocks) {
        break;
      }

      const pendingIndex = nextPendingIndex(state);
      if (pendingIndex < 0) {
        break;
      }
      state.next_csv_index = pendingIndex;

      if (!state.current_page) {
        const descriptor = pageDescriptor(config, state.next_page_number);
        if (await editor.customPageExists(descriptor.name)) {
          await editor.openCustomPage(descriptor.name);
          const existingBlockIds = await editor.listCanvasBlockIds();
          if (existingBlockIds.length > 0) {
            throw new Error(
              `页面 ${descriptor.name} 已存在但不在当前状态文件中，且检测到区块 ${existingBlockIds
                .map((item) => item.block_id)
                .join(", ")}；拒绝自动接管`,
            );
          }
          state.current_page = {
            ...descriptor,
            block_ids: [],
            created_at: new Date().toISOString(),
            recovered_existing_empty_page: true,
          };
          await persist(state, store, config);
        } else {
          let recoveredExistingEmptyPage = false;
          try {
            await editor.createCustomPage(descriptor);
          } catch (error) {
            const pageWasCreatedButNotSelected =
              error.message.includes(`页面 ${descriptor.name} 切换超时`) &&
              (await editor.customPageExists(descriptor.name));
            if (!pageWasCreatedButNotSelected) {
              throw error;
            }
            await editor.openCustomPage(descriptor.name);
            const existingBlockIds = await editor.listCanvasBlockIds();
            if (existingBlockIds.length > 0) {
              throw new Error(
                `页面 ${descriptor.name} 创建后未自动切换，重新打开时检测到区块 ${existingBlockIds
                  .map((item) => item.block_id)
                  .join(", ")}；拒绝自动接管`,
              );
            }
            recoveredExistingEmptyPage = true;
          }
          state.current_page = {
            ...descriptor,
            block_ids: [],
            created_at: new Date().toISOString(),
            ...(recoveredExistingEmptyPage
              ? { recovered_existing_empty_page: true }
              : {}),
          };
          await persist(state, store, config);
        }
      }

      const record = state.records[pendingIndex];
      record.attempt_count += 1;
      let outcome;
      try {
        outcome = await editor.searchAndAdd(record.block_id);
      } catch (error) {
        if (
          /未找到“添加区块到内容区”|区块搜索框未出现|登录状态失效/.test(
            error.message,
          )
        ) {
          throw error;
        }
        outcome = {
          outcome: "add_failed",
          reason: error.message,
        };
      }

      if (outcome.outcome === "added") {
        const slot = state.current_page.block_ids.length + 1;
        Object.assign(record, {
          page_name: state.current_page.name,
          page_url: state.current_page.publicUrl,
          slot_index: slot,
          editor_dom_id: outcome.audit.editor_dom_id,
          h1_count: outcome.audit.heading_counts.h1,
          h2_count: outcome.audit.heading_counts.h2,
          h3_count: outcome.audit.heading_counts.h3,
          h4_count: outcome.audit.heading_counts.h4,
          h5_count: outcome.audit.heading_counts.h5,
          h6_count: outcome.audit.heading_counts.h6,
          image_count: outcome.audit.image_count,
          image_urls: outcome.audit.images
            .map((image) => image.src)
            .filter(Boolean),
          status: "staged",
          failure_reason: "",
          audit: outcome.audit,
        });
        state.current_page.block_ids.push(record.block_id);
        successfullyAddedThisRun += 1;
      } else {
        assignFailure(record, outcome);
        const existingRoots = await editor.auditBlock(record.block_id);
        if (existingRoots.length > 0) {
          const removed = await editor.removeBlock(
            record.block_id,
            outcome.audit ?? existingRoots,
          );
          if (!removed) {
            await persist(state, store, config);
            throw new Error(
              `区块 ${record.block_id} 添加/渲染失败且无法安全移除，已停止以避免保存错误页面`,
            );
          }
        }
      }

      state.next_csv_index = pendingIndex + 1;
      await persist(state, store, config);

      if (
        state.current_page.block_ids.length >= config.blocksPerPage ||
        (maxBlocks > 0 && successfullyAddedThisRun >= maxBlocks)
      ) {
        if (await saveCurrentPage(editor, state, store, config)) {
          savedPagesThisRun += 1;
        }
      }
    }

    const hasRemainingPending = nextPendingIndex(state) >= 0;
    if (
      state.current_page?.block_ids.length > 0 &&
      (maxPages === 0 || savedPagesThisRun < maxPages) &&
      (!hasRemainingPending ||
        state.current_page.block_ids.length >= config.blocksPerPage)
    ) {
      if (await saveCurrentPage(editor, state, store, config)) {
        savedPagesThisRun += 1;
      }
    }
  } catch (error) {
    runError = error;
    await screenshot(editor.page, config, "provision-error");
    throw error;
  } finally {
    await persist(state, store, config);
    await stopTrace(context, tracePath).catch(() => {});
    await context.close().catch(() => {});
  }

  return {
    preDeferred,
    successfullyAddedThisRun,
    savedPagesThisRun,
    tracePath,
    state,
    runError,
  };
}

export async function cleanupPreDeferredSavedBlocks({
  config,
  input,
  store,
  maxPages = 0,
  headless,
}) {
  const state = await store.loadOrCreate(input, config);
  const preDeferred = preclassifyDeferred(state, config);
  await persist(state, store, config);

  const targetPages = state.pages.filter((pageState) =>
    state.records.some(
      (record) =>
        record.status === "added" &&
        record.page_name === pageState.name &&
        matchesPreDeferred(record, config),
    ),
  );
  if (targetPages.length === 0) {
    return {
      state,
      tracePath: "",
      preDeferred,
      cleanedPages: 0,
      removedBlocks: 0,
      replacementBlocks: 0,
    };
  }

  const tracePath = path.join(
    config.paths.artifactsDir,
    "traces",
    `cleanup-deferred-${timestamp()}.zip`,
  );
  const { context, page } = await launchEditorBrowser(config, {
    headless,
    traceName: "清理已保存页面中的暂缓区块",
  });
  const editor = new LeadongEditor(page, config);
  let cleanedPages = 0;
  let removedBlocks = 0;
  let replacementBlocks = 0;

  try {
    await editor.goto();
    await reconcileCurrentPage(editor, state, store, config);

    for (const pageState of targetPages) {
      if (maxPages > 0 && cleanedPages >= maxPages) {
        break;
      }
      const pageRecords = state.records
        .filter(
          (record) =>
            record.status === "added" &&
            record.page_name === pageState.name,
        )
        .sort((left, right) => left.slot_index - right.slot_index);
      const deferredRecords = pageRecords.filter((record) =>
        matchesPreDeferred(record, config),
      );
      if (deferredRecords.length === 0) {
        continue;
      }

      await editor.openCustomPage(pageState.name);
      const auditsById = new Map();
      for (const record of pageRecords) {
        const audits = await editor.auditBlock(record.block_id);
        if (audits.length !== 1) {
          throw new Error(
            `${pageState.name} 清理前对账失败：区块 ${record.block_id} 数量为 ${audits.length}，预期 1`,
          );
        }
        auditsById.set(record.block_id, audits[0]);
      }

      for (const record of deferredRecords) {
        const removed = await editor.removeBlock(
          record.block_id,
          auditsById.get(record.block_id),
        );
        if (!removed) {
          throw new Error(
            `${pageState.name} 无法安全移除暂缓区块 ${record.block_id}`,
          );
        }
      }

      const keptRecords = pageRecords.filter(
        (record) => !deferredRecords.includes(record),
      );
      const replacements = [];
      let candidateCursor = 0;
      while (
        keptRecords.length + replacements.length <
        config.blocksPerPage
      ) {
        const pendingIndex = nextPendingIndex(state, candidateCursor);
        if (pendingIndex < 0) {
          break;
        }
        candidateCursor = pendingIndex + 1;
        const record = state.records[pendingIndex];
        record.attempt_count += 1;
        let outcome;
        try {
          outcome = await editor.searchAndAdd(record.block_id);
        } catch (error) {
          if (
            /未找到“添加区块到内容区”|区块搜索框未出现|登录状态失效/.test(
              error.message,
            )
          ) {
            throw error;
          }
          outcome = { outcome: "add_failed", reason: error.message };
        }
        if (outcome.outcome === "added") {
          replacements.push({ record, audit: outcome.audit });
          continue;
        }

        assignFailure(record, outcome);
        const existingRoots = await editor.auditBlock(record.block_id);
        if (existingRoots.length > 0) {
          const removed = await editor.removeBlock(
            record.block_id,
            outcome.audit ?? existingRoots,
          );
          if (!removed) {
            throw new Error(
              `区块 ${record.block_id} 添加/渲染失败且无法安全移除，已停止清理`,
            );
          }
        }
        await persist(state, store, config);
      }

      if (
        keptRecords.length + replacements.length !==
        config.blocksPerPage
      ) {
        throw new Error(
          `${pageState.name} 清理后只找到 ${keptRecords.length + replacements.length} 个可用区块，未执行保存`,
        );
      }

      await editor.savePage();
      const savedAt = new Date().toISOString();
      for (const record of deferredRecords) {
        const keyword = config.preDeferredNameKeywords.find((candidate) =>
          record.app_name.includes(candidate),
        );
        clearRecordPlacement(
          record,
          "deferred_detail",
          `CSV 名称命中已确认的暂缓关键词：${keyword}`,
        );
      }
      const finalRecords = [
        ...keptRecords,
        ...replacements.map(({ record }) => record),
      ];
      for (let index = 0; index < finalRecords.length; index += 1) {
        const record = finalRecords[index];
        const replacement = replacements.find(
          (item) => item.record === record,
        );
        if (replacement) {
          assignAddedRecord(
            record,
            pageState,
            index + 1,
            replacement.audit,
            savedAt,
          );
        } else {
          record.slot_index = index + 1;
          record.saved_at = savedAt;
        }
      }
      pageState.block_ids = finalRecords.map((record) => record.block_id);
      pageState.saved_at = savedAt;
      cleanedPages += 1;
      removedBlocks += deferredRecords.length;
      replacementBlocks += replacements.length;
      await persist(state, store, config);
    }

    return {
      state,
      tracePath,
      preDeferred,
      cleanedPages,
      removedBlocks,
      replacementBlocks,
    };
  } catch (error) {
    await screenshot(editor.page, config, "cleanup-deferred-error");
    throw error;
  } finally {
    await persist(state, store, config);
    await stopTrace(context, tracePath).catch(() => {});
    await context.close().catch(() => {});
  }
}

async function verifyEditorPage(editor, pageState, records) {
  await editor.openCustomPage(pageState.name);
  const audits = [];
  for (const record of records) {
    const matches = await editor.auditBlock(record.block_id);
    if (matches.length !== 1) {
      throw new Error(
        `${pageState.name} 的区块 ${record.block_id} 数量为 ${matches.length}，预期 1`,
      );
    }
    audits.push(matches[0]);
  }
  const ordered = [...audits].sort(
    (left, right) => left.dom_index - right.dom_index,
  );
  const observedOrder = ordered.map((audit) => audit.editor_dom_id);
  const expectedOrder = audits.map((audit) => audit.editor_dom_id);
  if (observedOrder.join("\u0000") !== expectedOrder.join("\u0000")) {
    throw new Error(`${pageState.name} 的区块 DOM 顺序与 slot_index 不一致`);
  }
  return audits;
}

export async function recoverSavedCurrentPage({
  config,
  input,
  store,
  headless,
}) {
  const state = await store.loadOrCreate(input, config);
  const pageState = state.current_page;
  if (!pageState) {
    throw new Error("没有需要恢复确认的当前页面");
  }
  const records = state.records
    .filter(
      (record) =>
        record.status === "save_failed" &&
        record.page_name === pageState.name,
    )
    .sort((left, right) => left.slot_index - right.slot_index);
  if (
    records.length === 0 ||
    records.length !== pageState.block_ids.length ||
    records.map((record) => record.block_id).join("\u0000") !==
      pageState.block_ids.join("\u0000")
  ) {
    throw new Error(
      `${pageState.name} 的 save_failed 记录与当前页面映射不一致，拒绝自动恢复`,
    );
  }

  const tracePath = path.join(
    config.paths.artifactsDir,
    "traces",
    `recover-save-${timestamp()}.zip`,
  );
  const { context, page } = await launchEditorBrowser(config, {
    headless,
    traceName: "已保存页面重新打开校验",
  });
  const editor = new LeadongEditor(page, config);
  try {
    await editor.goto();
    const audits = await verifyEditorPage(editor, pageState, records);
    const savedAt = new Date().toISOString();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const audit = audits[index];
      Object.assign(record, {
        status: "added",
        failure_reason: "",
        saved_at: savedAt,
        editor_dom_id: audit.editor_dom_id,
        audit,
      });
    }
    if (!state.pages.some((item) => item.name === pageState.name)) {
      state.pages.push({ ...pageState, saved_at: savedAt });
    }
    state.current_page = null;
    state.next_page_number = Math.max(
      state.next_page_number,
      pageState.number + 1,
    );
    await persist(state, store, config);
    return { state, tracePath, recoveredBlocks: records.length };
  } catch (error) {
    await screenshot(editor.page, config, "recover-save-error");
    throw error;
  } finally {
    await stopTrace(context, tracePath).catch(() => {});
    await context.close().catch(() => {});
  }
}

export async function publishAndVerify({
  config,
  input,
  store,
  confirmSite,
  headless,
}) {
  if (confirmSite !== config.siteConfirmationHost) {
    throw new Error(
      `发布确认失败：必须传 --confirm-site ${config.siteConfirmationHost}`,
    );
  }
  const state = await store.loadOrCreate(input, config);
  assertStateComplete(state);

  const tracePath = path.join(
    config.paths.artifactsDir,
    "traces",
    `publish-${timestamp()}.zip`,
  );
  const { context, page } = await launchEditorBrowser(config, {
    headless,
    traceName: "领动全站发布与公开页校验",
  });
  const editor = new LeadongEditor(page, config);

  try {
    await editor.goto();
    for (const pageState of state.pages) {
      const records = state.records
        .filter(
          (record) =>
            record.page_name === pageState.name &&
            ["added", "published_verified"].includes(record.status),
        )
        .sort((left, right) => left.slot_index - right.slot_index);
      const isLastPage =
        state.pages.indexOf(pageState) === state.pages.length - 1;
      if (
        (!isLastPage && records.length !== config.blocksPerPage) ||
        (isLastPage &&
          (records.length < 1 || records.length > config.blocksPerPage))
      ) {
        throw new Error(
          `${pageState.name} 映射区块数为 ${records.length}，不符合每页 ${config.blocksPerPage} 个（仅最后一页可不足）的规则`,
        );
      }
      await verifyEditorPage(editor, pageState, records);
    }

    await editor.publishSite();
    const publicPage = await context.newPage();
    publicPage.setDefaultTimeout(config.timeouts.actionMs);
    const publicInspector = new LeadongEditor(publicPage, config);

    for (const pageState of state.pages) {
      const response = await publicPage.goto(pageState.publicUrl, {
        waitUntil: "domcontentloaded",
      });
      if (!response || response.status() >= 400) {
        throw new Error(
          `${pageState.publicUrl} HTTP 状态异常：${response?.status() ?? "无响应"}`,
        );
      }
      const records = state.records.filter(
        (record) => record.page_name === pageState.name,
      );
      for (const record of records) {
        const matches = await publicInspector.auditBlock(record.block_id);
        if (matches.length !== 1) {
          record.failure_reason = `公开页目标 block_id 数量为 ${matches.length}，预期 1`;
          await persist(state, store, config);
          throw new Error(
            `${pageState.publicUrl} 未通过区块 ${record.block_id} 校验`,
          );
        }
        record.status = "published_verified";
        record.published = true;
        record.failure_reason = "";
      }
      await persist(state, store, config);
    }
    state.published = true;
    await persist(state, store, config);
    return { state, tracePath };
  } catch (error) {
    await screenshot(editor.page, config, "publish-error");
    throw error;
  } finally {
    await stopTrace(context, tracePath).catch(() => {});
    await context.close().catch(() => {});
  }
}

export function summarizeState(state) {
  const counts = {};
  for (const record of state.records) {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
  }
  return {
    counts,
    pages: state.pages.length,
    currentPage: state.current_page?.name ?? "",
    complete: state.records.every((record) =>
      FINAL_STATUSES.has(record.status),
    ),
  };
}
