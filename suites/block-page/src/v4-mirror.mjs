import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { V4Editor, V4UiError, launchV4Browser, stopV4Trace } from "./v4-editor.mjs";
import { V4RichTextSetupUi } from "./v4-rich-text-setup.mjs";

const FINAL_SOURCE_RICH_STATUSES = new Set([
  "verified",
  "unsupported_no_rich_text",
  "unsupported_no_media_item",
]);

function now() {
  return new Date().toISOString();
}

async function saveJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function sourceRichPages(firstState, batchState) {
  return [
    {
      name: firstState.page_name,
      path: firstState.page_path,
      records: firstState.records,
    },
    ...batchState.pages.map((page) => ({
      name: page.name,
      path: page.path,
      records: page.records,
    })),
  ];
}

export function createV4MirrorState({
  sourceBlockState,
  sourceFirstRichTextState,
  sourceBatchRichTextState,
  environment,
}) {
  const blockRecords = new Map(
    sourceBlockState.records
      .filter((record) => record.status === "added")
      .map((record) => [String(record.block_id), record]),
  );
  const richPages = new Map(sourceRichPages(sourceFirstRichTextState, sourceBatchRichTextState).map((page) => [page.name, page]));
  const seenIds = new Set();
  const pages = sourceBlockState.pages.map((sourcePage) => {
    const richPage = richPages.get(sourcePage.name);
    if (!richPage) throw new Error(`源富文本状态缺少页面：${sourcePage.name}`);
    const richRecords = new Map(richPage.records.map((record) => [String(record.block_id), record]));
    const records = sourcePage.block_ids.map((rawBlockId, index) => {
      const blockId = String(rawBlockId);
      if (seenIds.has(blockId)) throw new Error(`源区块ID重复：${blockId}`);
      seenIds.add(blockId);
      const block = blockRecords.get(blockId);
      const rich = richRecords.get(blockId);
      if (!block) throw new Error(`${sourcePage.name}的区块${blockId}缺少added来源记录`);
      if (!rich) throw new Error(`${sourcePage.name}的区块${blockId}缺少富文本来源记录`);
      if (!FINAL_SOURCE_RICH_STATUSES.has(rich.status)) {
        throw new Error(`${sourcePage.name}的区块${blockId}源富文本状态不是最终状态：${rich.status}`);
      }
      const expectedEditors = (rich.editors ?? []).map((editor) => ({
        editor_index: Number(editor.editor_index),
        field_name: editor.field_name ?? "",
        expected_text: editor.expected_text,
        expected_level: String(editor.expected_level || "H2").toUpperCase(),
      }));
      if (rich.status === "verified" && expectedEditors.length === 0) {
        throw new Error(`${sourcePage.name}的区块${blockId}已验证但没有源富文本数据`);
      }
      return {
        block_id: blockId,
        app_name: block.app_name,
        slot_index: index + 1,
        source_editor_dom_id: block.editor_dom_id,
        target_editor_dom_id: "",
        block_status: "pending",
        rich_text_status: "pending",
        expected_rich_text_status: rich.status,
        expected_rich_text_count: expectedEditors.length,
        verified_rich_text_count: 0,
        expected_editors: expectedEditors,
        editors: [],
        attempt_count: 0,
        failure_reason: "",
        block_saved_at: "",
        rich_text_saved_at: "",
        verified_at: "",
      };
    });
    if (richRecords.size !== records.length) {
      throw new Error(`${sourcePage.name}区块数${records.length}与源富文本记录数${richRecords.size}不一致`);
    }
    return {
      name: sourcePage.name,
      path: sourcePage.path,
      public_url: sourcePage.publicUrl,
      category: sourcePage.category,
      status: "pending",
      blocks_saved_at: "",
      rich_texts_saved_at: "",
      completed_at: "",
      failure_reason: "",
      records,
    };
  });
  if (blockRecords.size !== seenIds.size) {
    throw new Error(`源added区块${blockRecords.size}个，但页面映射只有${seenIds.size}个`);
  }
  return {
    version: 1,
    created_at: now(),
    updated_at: now(),
    phase: "planned",
    environment: {
      entry_url: environment.entryUrl,
      site_name: environment.siteName,
      site_language: environment.siteLanguage,
      proxy_server: environment.proxyServer || "",
      user_data_dir: environment.userDataDir,
    },
    source: {
      block_state_file: environment.sourceBlockStateFile,
      first_rich_text_state_file: environment.sourceFirstRichTextStateFile,
      batch_rich_text_state_file: environment.sourceBatchRichTextStateFile,
    },
    pages,
  };
}

export function summarizeV4Mirror(state) {
  const records = state.pages.flatMap((page) => page.records);
  const expectedRichTexts = records.reduce((sum, record) => sum + Number(record.expected_rich_text_count || 0), 0);
  const verifiedRichTexts = records.reduce((sum, record) => sum + Number(record.verified_rich_text_count || 0), 0);
  return {
    pages: state.pages.length,
    completePages: state.pages.filter((page) => page.status === "complete").length,
    pendingPages: state.pages.filter((page) => page.status !== "complete").length,
    blocks: records.length,
    verifiedBlocks: records.filter((record) => record.block_status === "verified").length,
    expectedRichTexts,
    verifiedRichTexts,
    expectedUnsupported: records.filter((record) => record.expected_rich_text_status.startsWith("unsupported_")).length,
    confirmedUnsupported: records.filter((record) => record.rich_text_status === "confirmed_unsupported").length,
    preservedExtras: state.pages.reduce((sum, page) => sum + (page.existing_extra_blocks ?? []).length, 0),
    failures: records.filter((record) => record.failure_reason).length,
  };
}

export function adoptExistingV4TargetState(state, targetState, options = {}) {
  if (!targetState) return state;
  const allowExtras = Boolean(options.allowExistingExtraBlocks);
  const existingRecords = (targetState.records ?? [])
    .filter((record) => record.status === "added" && record.page_name && record.editor_dom_id);
  const byPage = new Map();
  for (const record of existingRecords) {
    const pageRecords = byPage.get(record.page_name) ?? [];
    pageRecords.push(record);
    byPage.set(record.page_name, pageRecords);
  }
  for (const page of state.pages) {
    const targetRecords = byPage.get(page.name) ?? [];
    if (targetRecords.length === 0) continue;
    targetRecords.sort((left, right) => Number(left.slot_index) - Number(right.slot_index));
    const targetById = new Map(targetRecords.map((record) => [String(record.block_id), record]));
    const expectedIds = new Set(page.records.map((record) => record.block_id));
    const extras = targetRecords
      .filter((record) => !expectedIds.has(String(record.block_id)))
      .map((record) => ({
        block_id: String(record.block_id),
        app_name: record.app_name ?? "",
        slot_index: Number(record.slot_index),
        editor_dom_id: record.editor_dom_id,
        status: "preserved_existing_extra",
      }));
    if (extras.length > 0 && !allowExtras) {
      throw new Error(`${page.name}存在${extras.length}个源清单外历史区块，配置不允许保留`);
    }
    page.existing_extra_blocks = extras;
    page.existing_target_record_count = targetRecords.length;
    for (const record of page.records) {
      if (record.block_status === "verified" || record.block_saved_at) continue;
      const existing = targetById.get(record.block_id);
      if (!existing) continue;
      record.target_editor_dom_id = existing.editor_dom_id;
      record.block_status = "existing_to_verify";
      record.existing_target_slot_index = Number(existing.slot_index);
    }
    if (page.status === "failed" && /状态外区块|首次镜像前应为空/u.test(page.failure_reason ?? "")) {
      page.status = "pending";
      page.failure_reason = "";
    }
  }
  if (state.phase === "failed" && /状态外区块|首次镜像前应为空/u.test(state.run_failure ?? "")) {
    state.phase = "planned";
    delete state.run_failure;
  }
  state.target_existing_state_adopted_at = now();
  return state;
}

export async function readV4MirrorSources(paths) {
  const [sourceBlockState, sourceFirstRichTextState, sourceBatchRichTextState] = await Promise.all([
    readFile(paths.sourceBlockStateFile, "utf8").then(JSON.parse),
    readFile(paths.sourceFirstRichTextStateFile, "utf8").then(JSON.parse),
    readFile(paths.sourceBatchRichTextStateFile, "utf8").then(JSON.parse),
  ]);
  return { sourceBlockState, sourceFirstRichTextState, sourceBatchRichTextState };
}

export async function loadOrCreateV4MirrorState(paths, environment) {
  const existing = await readFile(paths.stateFile, "utf8").then(JSON.parse).catch(() => null);
  if (existing) {
    if (existing.environment.proxy_server) throw new Error("镜像状态不是无代理环境，拒绝复用");
    const targetState = paths.targetExistingStateFile
      ? await readFile(paths.targetExistingStateFile, "utf8").then(JSON.parse).catch(() => null)
      : null;
    adoptExistingV4TargetState(existing, targetState, {
      allowExistingExtraBlocks: environment.allowExistingExtraBlocks,
    });
    await saveJsonAtomic(paths.stateFile, existing);
    return existing;
  }
  const sources = await readV4MirrorSources(paths);
  const state = createV4MirrorState({ ...sources, environment });
  const targetState = paths.targetExistingStateFile
    ? await readFile(paths.targetExistingStateFile, "utf8").then(JSON.parse).catch(() => null)
    : null;
  adoptExistingV4TargetState(state, targetState, {
    allowExistingExtraBlocks: environment.allowExistingExtraBlocks,
  });
  await saveJsonAtomic(paths.stateFile, state);
  return state;
}

async function firstVisibleExact(editor, text) {
  for (const scope of editor.contexts()) {
    const matches = scope.getByText(text, { exact: true });
    const count = await matches.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const match = matches.nth(index);
      if (await match.isVisible().catch(() => false)) return match;
    }
  }
  return null;
}

export async function openExistingV4Page(editor, pageName) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await editor.page.keyboard.press("Escape").catch(() => {});
    await editor.page.waitForTimeout(attempt === 0 ? 250 : 700);
    await editor.openPageManagement();
    await editor.page.waitForTimeout(350);
    let panel = null;
    for (const scope of editor.contexts()) {
      const candidate = scope.locator(".globalPageManager-container:visible").first();
      if (await candidate.isVisible().catch(() => false)) {
        panel = candidate;
        break;
      }
    }
    const pageSearch = panel?.locator("input[placeholder*='页面名称']:visible").first();
    if (pageSearch && await pageSearch.isVisible().catch(() => false)) {
      await pageSearch.fill(pageName);
      await editor.page.waitForTimeout(350);
    }
    let target = null;
    if (panel) {
      const matches = panel.getByText(pageName, { exact: true });
      const count = await matches.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        if (await matches.nth(index).isVisible().catch(() => false)) {
          target = matches.nth(index);
          break;
        }
      }
    }
    target ??= await firstVisibleExact(editor, pageName);
    if (!target) {
      if (attempt < 2) continue;
      throw new V4UiError("page_not_found", `无代理环境中未找到既有页面：${pageName}`);
    }
    await target.scrollIntoViewIfNeeded().catch(() => {});
    const pageDataResponse = editor.page.waitForResponse(
      (response) => response.request().method() === "GET" && /\/newEditor\/getPage(?:\?|$)/u.test(response.url()) && response.ok(),
      { timeout: Math.min(editor.config.timeouts.blockRenderMs, 15000) },
    ).catch(() => null);
    await target.click();
    const loadedPageResponse = await pageDataResponse;
    if (loadedPageResponse) {
      const loadedUrl = new URL(loadedPageResponse.url());
      editor.currentPageId = loadedUrl.searchParams.get("pageId") ?? "";
      editor.currentPageName = pageName;
    }
    const deadline = Date.now() + Math.min(editor.config.timeouts.blockRenderMs, 20000);
    let selected = false;
    while (Date.now() < deadline) {
      for (const scope of editor.contexts()) {
        const inputs = scope.getByPlaceholder("页面", { exact: true });
        const count = await inputs.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
          if (await inputs.nth(index).inputValue().catch(() => "") === pageName) {
            selected = true;
            break;
          }
        }
        if (selected) break;
      }
      if (!selected && panel) {
        const activeItems = panel.locator(".drag-item.activePage");
        const activeCount = await activeItems.count().catch(() => 0);
        for (let index = 0; index < activeCount; index += 1) {
          const activeText = await activeItems.nth(index).innerText().catch(() => "");
          if (activeText.replace(/\s+/gu, " ").trim() === pageName) {
            selected = true;
            break;
          }
        }
      }
      if (selected) break;
      await editor.page.waitForTimeout(200);
    }
    if (!selected) continue;
    await editor.page.locator(".el-loading-mask:visible").waitFor({ state: "hidden", timeout: editor.config.timeouts.blockRenderMs }).catch(() => {});
    // 页面管理面板会覆盖画布左侧并让 iframe 内的区块在 Playwright 看来不可交互。
    // 人工操作也是先选中页面、再关闭页面列表后进入画布，因此切页成功后显式关闭。
    await editor.closePageManagement();
    // 页面名回填后尽快使用带 data-node-id 的编辑 frame。部分大区块页稍后
    // 会切到不带编辑节点的展示 frame，等待过久反而错过可操作窗口。
    await editor.page.waitForTimeout(650);
    return;
  }
  throw new V4UiError("page_open_failed", `打开${pageName}后页面选择器连续3次未回填`);
}

async function reopenExistingV4Page(editor, pageName) {
  // 4.0单页应用执行浏览器级 reload 时，画布 iframe 偶发只恢复外壳而
  // 不装载节点。重新打开页面管理并选择当前页面同样会从后台读取保存值，
  // 且不会丢失编辑器上下文，因此用它作为“重开验证”。
  // 先切到一个确定的其它页面，再回到目标页，保证触发目标 pageId 的
  // getPage 请求，避免把当前内存画布误当成“重开后后台值”。
  if (pageName !== "Home") await openExistingV4Page(editor, "Home");
  await openExistingV4Page(editor, pageName);
}

async function savePageWithRetry(editor) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await editor.savePage();
    } catch (error) {
      lastError = error;
      if (attempt === 0) await editor.page.waitForTimeout(900);
    }
  }
  throw lastError;
}

async function persist(state, paths, reportWriter) {
  state.updated_at = now();
  await saveJsonAtomic(paths.stateFile, state);
  await reportWriter(state, paths.reportsDir);
}

async function reconcileUnsavedBlocks(editor, targetPage, options = {}) {
  const nodes = await editor.canvasNodeSnapshot();
  const known = targetPage.records.filter((record) => record.target_editor_dom_id);
  if (nodes.length === 0) {
    for (const record of targetPage.records) {
      if (record.block_status === "verified") continue;
      record.block_status = "pending";
      record.target_editor_dom_id = "";
      record.failure_reason = "";
    }
    return;
  }
  const nodeKeys = nodes.map((node) => node.key);
  const knownKeys = known.map((record) => record.target_editor_dom_id);
  const existingExtras = targetPage.existing_extra_blocks ?? [];
  const preservedExtraKeys = existingExtras.map((record) => record.editor_dom_id);
  const unknownNodes = nodes.filter((node) => !knownKeys.includes(node.key) && !preservedExtraKeys.includes(node.key));
  if (unknownNodes.length > 0) {
    if (!options.allowExistingExtraBlocks) {
      throw new V4UiError("unexpected_existing_blocks", `${targetPage.name}存在状态外区块节点，拒绝继续`);
    }
    // 无代理环境的既有页面可能留有历史测试区块。用户要求保留这些内容，
    // 因此把稳定节点登记为额外项，后续补齐目标区块时不删除也不重复接管。
    for (const node of unknownNodes) {
      existingExtras.push({
        block_id: `existing-${String(node.key).slice(0, 12)}`,
        app_name: "无代理环境既有历史区块",
        slot_index: nodeKeys.indexOf(node.key) + 1,
        editor_dom_id: node.key,
        status: "preserved_existing_extra",
        discovered_at: now(),
      });
    }
    targetPage.existing_extra_blocks = existingExtras;
  }
  for (const record of targetPage.records) {
    if (record.target_editor_dom_id && nodeKeys.includes(record.target_editor_dom_id)) {
      record.block_status = "staged";
      record.failure_reason = "";
    } else {
      record.block_status = "pending";
      record.target_editor_dom_id = "";
    }
  }
}

async function addBlockWithRetry(editor, record) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    record.attempt_count += 1;
    try {
      return await editor.searchAndAdd(record.block_id);
    } catch (error) {
      lastError = error;
      if (error.details?.nodeCreated || attempt === 1) throw error;
      await editor.page.keyboard.press("Escape").catch(() => {});
      await editor.page.waitForTimeout(700);
    }
  }
  throw lastError;
}

async function ensurePageBlocks({ editor, targetPage, state, paths, reportWriter, environment }) {
  await openExistingV4Page(editor, targetPage.name);
  if (targetPage.blocks_saved_at) {
    try {
      const verified = await editor.verifyBlocks(targetPage.records.map((record) => ({
        block_id: record.block_id,
        editor_dom_id: record.target_editor_dom_id,
      })), { allowOrderMismatch: true });
      for (const item of verified) {
        const record = targetPage.records.find((candidate) => candidate.block_id === item.blockId);
        record.target_editor_dom_id = item.audit.editor_dom_id;
        record.block_status = "verified";
      }
      return;
    } catch (error) {
      const nodes = await editor.canvasNodeSnapshot();
      if (error.status !== "render_failed" || nodes.length !== 0) throw error;
      // 旧版保存判断可能被 saveHeaderFooter 的响应提前满足。若精确重开后
      // 目标页确认为空，清除这次未落库的暂存映射并从空页安全重建。
      targetPage.blocks_saved_at = "";
      delete targetPage.block_save_evidence;
      targetPage.recovered_empty_page_at = now();
      for (const record of targetPage.records) {
        record.target_editor_dom_id = "";
        record.block_status = "pending";
        record.failure_reason = "";
      }
      await persist(state, paths, reportWriter);
    }
  }
  await reconcileUnsavedBlocks(editor, targetPage, {
    allowExistingExtraBlocks: environment.allowExistingExtraBlocks,
  });
  if (targetPage.records.every((record) => record.block_status === "pending") && !(targetPage.existing_extra_blocks ?? []).length) {
    const nodes = await editor.canvasNodeSnapshot();
    if (nodes.length !== 0) {
      throw new V4UiError("unexpected_existing_blocks", `${targetPage.name}首次镜像前应为空，实际有${nodes.length}个节点`);
    }
  }
  for (const record of targetPage.records) {
    if (record.block_status === "staged") continue;
    record.failure_reason = "";
    try {
      const audit = await addBlockWithRetry(editor, record);
      record.target_editor_dom_id = audit.editor_dom_id;
      record.block_status = "staged";
      record.audit = audit;
    } catch (error) {
      record.block_status = error.status ?? "add_failed";
      record.failure_reason = error.message;
      throw error;
    } finally {
      await persist(state, paths, reportWriter);
    }
  }
  const nodes = await editor.canvasNodeSnapshot();
  const nodeKeys = new Set(nodes.map((node) => node.key));
  const missingNodes = targetPage.records.filter((record) => !nodeKeys.has(record.target_editor_dom_id));
  if (missingNodes.length > 0) {
    throw new V4UiError("block_count_mismatch", `${targetPage.name}添加后仍缺少区块：${missingNodes.map((record) => record.block_id).join(",")}`);
  }
  targetPage.block_save_evidence = await savePageWithRetry(editor);
  targetPage.blocks_saved_at = now();
  await reopenExistingV4Page(editor, targetPage.name);
  const verified = await editor.verifyBlocks(targetPage.records.map((record) => ({
    block_id: record.block_id,
    editor_dom_id: record.target_editor_dom_id,
  })), { allowOrderMismatch: true });
  for (const item of verified) {
    const record = targetPage.records.find((candidate) => candidate.block_id === item.blockId);
    record.target_editor_dom_id = item.audit.editor_dom_id;
    record.block_status = "verified";
    record.block_saved_at = targetPage.blocks_saved_at;
  }
  await persist(state, paths, reportWriter);
}

async function inspectOrConfigureWithRetry(ui, record, apply) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await ui.inspectAndConfigure(record, apply);
    } catch (error) {
      lastError = error;
      if (attempt === 1 || !["settings_not_found", "media_edit_not_visible", "block_root_not_found"].includes(error.status)) throw error;
      await ui.page.waitForTimeout(650);
    }
  }
  throw lastError;
}

async function ensureTargetCanvasReady(editor, targetPage) {
  const expectedKeys = targetPage.records.map((record) => record.target_editor_dom_id).filter(Boolean);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nodes = await editor.canvasNodeSnapshot();
    const keys = new Set(nodes.map((node) => node.key));
    const missing = expectedKeys.filter((key) => !keys.has(key));
    if (missing.length === 0 && expectedKeys.length === targetPage.records.length) return nodes;
    if (attempt < 2) {
      await openExistingV4Page(editor, targetPage.name);
      await editor.page.waitForTimeout(900);
      continue;
    }
    throw new V4UiError(
      "canvas_not_ready",
      `${targetPage.name}页面名已回填，但画布仍缺少${missing.length}个目标节点`,
      { expectedKeys, actualKeys: [...keys], missing },
    );
  }
  return [];
}

async function ensurePageRichTexts({ editor, targetPage, state, paths, reportWriter }) {
  // ensurePageBlocks 已经打开并验证了同一页面。这里继续使用当前稳定画布，
  // 避免紧接着再次选择当前页而触发 iframe 二次重建。
  const richUiOptions = { ensureCanvasReady: () => ensureTargetCanvasReady(editor, targetPage) };
  const ui = new V4RichTextSetupUi(editor, richUiOptions);
  await ensureTargetCanvasReady(editor, targetPage);
  if (!targetPage.rich_texts_saved_at) {
    for (const record of targetPage.records) {
      if (record.rich_text_status === "configured_pending_page_save") {
        record.rich_text_status = "pending";
        record.editors = [];
        record.verified_rich_text_count = 0;
      }
    }
    let changed = false;
    for (const record of targetPage.records) {
      if (["confirmed_unsupported", "verified"].includes(record.rich_text_status)) continue;
      await ensureTargetCanvasReady(editor, targetPage);
      record.failure_reason = "";
      try {
        if (record.expected_rich_text_status.startsWith("unsupported_")) {
          const result = await inspectOrConfigureWithRetry(ui, record, false);
          if (result.status !== record.expected_rich_text_status) {
            record.rich_text_status = "environment_behavior_mismatch";
            throw new V4UiError(
              "environment_behavior_mismatch",
              `区块${record.block_id}源状态为${record.expected_rich_text_status}，无代理环境为${result.status}`,
            );
          }
          record.rich_text_status = "confirmed_unsupported";
          record.editors = [];
          continue;
        }
        const result = await inspectOrConfigureWithRetry(ui, record, true);
        if (result.status !== "configured_pending_page_save") {
          throw new V4UiError("environment_behavior_mismatch", `区块${record.block_id}源环境支持富文本，无代理环境状态为${result.status}`);
        }
        record.editors = result.editors;
        record.rich_text_status = "configured_pending_page_save";
        changed = true;
      } catch (error) {
        record.rich_text_status = record.rich_text_status === "environment_behavior_mismatch" ? record.rich_text_status : (error.status ?? "configure_failed");
        record.failure_reason = error.message;
        throw error;
      } finally {
        await persist(state, paths, reportWriter);
      }
    }
    if (changed) {
      targetPage.rich_text_save_evidence = await savePageWithRetry(editor);
      targetPage.rich_texts_saved_at = now();
      for (const record of targetPage.records.filter((item) => item.rich_text_status === "configured_pending_page_save")) {
        record.rich_text_status = "configured";
        record.rich_text_saved_at = targetPage.rich_texts_saved_at;
      }
      await persist(state, paths, reportWriter);
    } else {
      targetPage.rich_texts_saved_at = now();
      await persist(state, paths, reportWriter);
    }
  }
  await reopenExistingV4Page(editor, targetPage.name);
  let verifier = new V4RichTextSetupUi(editor, richUiOptions);
  for (const record of targetPage.records) {
    if (record.rich_text_status === "confirmed_unsupported") continue;
    if (record.rich_text_status === "verified") continue;
    try {
      await ensureTargetCanvasReady(editor, targetPage);
      let verifiedEditors;
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          verifiedEditors = await verifier.verify(record);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const retryable = /Frame was detached|Execution context was destroyed|Target page, context or browser has been closed/u.test(error.message)
            || ["block_root_not_found", "settings_not_found", "media_edit_not_visible"].includes(error.status);
          if (attempt === 2 || !retryable) throw error;
          await reopenExistingV4Page(editor, targetPage.name);
          await editor.page.waitForTimeout(900);
          verifier = new V4RichTextSetupUi(editor, richUiOptions);
        }
      }
      if (lastError) throw lastError;
      record.editors = verifiedEditors;
      record.verified_rich_text_count = record.editors.length;
      record.rich_text_status = "verified";
      record.verified_at = now();
      record.failure_reason = "";
    } catch (error) {
      record.rich_text_status = error.status ?? "reopen_verify_failed";
      record.failure_reason = error.message;
      if (error.details?.editors) record.editors = error.details.editors;
      throw error;
    } finally {
      await persist(state, paths, reportWriter);
    }
  }
}

export async function runV4Mirror({ config, paths, environment, reportWriter, maxPages = 0 }) {
  if (config.proxyServer) throw new Error(`无代理镜像禁止配置代理：${config.proxyServer}`);
  const state = await loadOrCreateV4MirrorState(paths, environment);
  const candidates = state.pages.filter((page) => page.status !== "complete");
  const selected = maxPages > 0 ? candidates.slice(0, maxPages) : candidates;
  if (selected.length === 0) return state;
  await mkdir(paths.artifactsDir, { recursive: true });
  state.phase = "running";
  await persist(state, paths, reportWriter);
  const tracePath = path.join(paths.artifactsDir, `v4-mirror-${Date.now()}.zip`);
  const { context, page } = await launchV4Browser(config, { headless: false, traceName: "4.0无代理区块与H2镜像" });
  const editor = new V4Editor(page, config);
  try {
    await editor.goto();
    for (const targetPage of selected) {
      targetPage.status = "adding_blocks";
      targetPage.failure_reason = "";
      await persist(state, paths, reportWriter);
      try {
        await ensurePageBlocks({ editor, targetPage, state, paths, reportWriter, environment });
        targetPage.status = "configuring_h2";
        await persist(state, paths, reportWriter);
        await ensurePageRichTexts({ editor, targetPage, state, paths, reportWriter });
        const complete = targetPage.records.every((record) =>
          record.block_status === "verified" && ["verified", "confirmed_unsupported"].includes(record.rich_text_status),
        );
        if (!complete) throw new Error(`${targetPage.name}仍有未完成记录`);
        targetPage.status = "complete";
        targetPage.completed_at = now();
        await persist(state, paths, reportWriter);
        await editor.page.screenshot({
          path: path.join(paths.artifactsDir, `${targetPage.name}-complete.png`),
          fullPage: false,
          timeout: 8000,
        }).catch(() => {});
      } catch (error) {
        targetPage.status = "failed";
        targetPage.failure_reason = error.message;
        state.phase = /login_expired/u.test(error.message) ? "login_expired" : "failed";
        state.run_failure = error.message;
        await editor.page.screenshot({
          path: path.join(paths.artifactsDir, `${targetPage.name}-failed-${Date.now()}.png`),
          fullPage: false,
          timeout: 8000,
        }).catch(() => {});
        await persist(state, paths, reportWriter);
        throw error;
      }
    }
    state.phase = state.pages.every((targetPage) => targetPage.status === "complete") ? "complete" : "partial";
    delete state.run_failure;
    await persist(state, paths, reportWriter);
    return state;
  } finally {
    await stopV4Trace(context, tracePath).catch(() => {});
    await context.close();
  }
}
