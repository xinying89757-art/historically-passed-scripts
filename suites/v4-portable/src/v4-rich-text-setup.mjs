import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { V4Editor, V4UiError, launchV4Browser, stopV4Trace } from "./v4-editor.mjs";

export const V4_RICH_TEXT_PAGE = {
  name: "新版图片集区块测试-001",
  path: "/new-gallery-block-test-001",
};

export function readableBlockName(value) {
  return String(value ?? "")
    .replaceAll("*", "")
    .replaceAll("[区块]", "")
    .replaceAll("【区块】", "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function preparedHeadingText(record, editorIndex) {
  return `新版区块标题测试-${record.block_id}-${readableBlockName(record.app_name)}-第${String(editorIndex + 1).padStart(2, "0")}处`;
}

export function expectedPreparedHeading(record, editorIndex) {
  const source = record.expected_editors?.[editorIndex];
  return {
    text: source?.expected_text || preparedHeadingText(record, editorIndex),
    level: String(source?.expected_level || "H2").toUpperCase(),
    fieldName: normalizeRichText(source?.field_name || ""),
  };
}

export function normalizeRichText(value) {
  return String(value ?? "").replace(/\u00a0/gu, " ").replace(/\s+/gu, " ").trim();
}

function now() {
  return new Date().toISOString();
}

async function saveJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

export async function loadV4RichTextSource(config) {
  const source = JSON.parse(await readFile(config.paths.v4StateFile, "utf8"));
  const records = source.records
    .filter((record) => record.page_name === V4_RICH_TEXT_PAGE.name && record.status === "added")
    .sort((left, right) => Number(left.slot_index) - Number(right.slot_index));
  if (records.length !== 10) {
    throw new Error(`${V4_RICH_TEXT_PAGE.name} 期望10个已添加区块，实际为${records.length}个`);
  }
  return records.map((record) => ({
    block_id: String(record.block_id),
    app_name: record.app_name,
    slot_index: Number(record.slot_index),
    editor_dom_id: record.editor_dom_id,
  }));
}

export function createV4RichTextState(sourceRecords) {
  return {
    version: 1,
    page_name: V4_RICH_TEXT_PAGE.name,
    page_path: V4_RICH_TEXT_PAGE.path,
    started_at: now(),
    updated_at: now(),
    page_saved_at: "",
    reopen_verified_at: "",
    growth_engine_status: "deferred_by_user",
    records: sourceRecords.map((record) => ({
      ...record,
      status: "pending",
      rich_text_count: 0,
      prepared_count: 0,
      verified_count: 0,
      failure_reason: "",
      editors: [],
    })),
  };
}

export async function loadOrCreateV4RichTextState(statePath, sourceRecords, reset = false) {
  if (!reset) {
    const existing = await readFile(statePath, "utf8").then(JSON.parse).catch(() => null);
    if (existing) {
      const expected = sourceRecords.map((record) => `${record.block_id}:${record.editor_dom_id}`).join("|");
      const actual = existing.records.map((record) => `${record.block_id}:${record.editor_dom_id}`).join("|");
      if (expected !== actual) throw new Error("4.0富文本状态与当前页面区块清单不一致");
      return existing;
    }
  }
  const state = createV4RichTextState(sourceRecords);
  await saveJsonAtomic(statePath, state);
  return state;
}

function visibleCanvasRoot(editor, editorDomId, timeoutMs = editor.config.timeouts.blockRenderMs) {
  return (async () => {
    const selector = `[data-node-id="${String(editorDomId).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let largestFallback = null;
      let largestArea = -1;
      for (const scope of editor.contexts()) {
        const candidates = scope.locator(selector);
        const count = await candidates.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
          const candidate = candidates.nth(index);
          const geometry = await candidate.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
              area: rect.width * rect.height,
              directlyVisible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
            };
          }).catch(() => ({ area: 0, directlyVisible: false }));
          if (geometry.directlyVisible) return candidate;
          if (geometry.area > largestArea) {
            largestArea = geometry.area;
            largestFallback = candidate;
          }
        }
      }
      if (largestFallback) return largestFallback;
      await editor.page.waitForTimeout(200);
    }
    return null;
  })();
}

async function activeDrawer(page) {
  const drawers = page.locator(".el-drawer.open:visible,[role='dialog'].el-drawer:visible");
  const count = await drawers.count().catch(() => 0);
  return count > 0 ? drawers.nth(count - 1) : null;
}

async function waitForActiveDrawer(page, timeoutMs = 4500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const drawer = await activeDrawer(page);
    if (drawer && await drawer.isVisible().catch(() => false)) return drawer;
    await page.waitForTimeout(180);
  }
  return null;
}

async function closeMediaDetail(page) {
  const drawer = await activeDrawer(page);
  if (!drawer) return;
  const back = drawer.locator(".edit-gallery-back:visible");
  if (await back.count()) {
    await back.first().click({ force: true });
    await page.waitForTimeout(300);
  }
}

async function closeBlockSettings(page) {
  await closeMediaDetail(page);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const drawer = await activeDrawer(page);
    if (!drawer) return;
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(360);
  }
}

export class V4RichTextSetupUi {
  constructor(editor, options = {}) {
    this.editor = editor;
    this.page = editor.page;
    this.ensureCanvasReady = options.ensureCanvasReady;
  }

  async openFirstMediaDetail(record) {
    // 4.0右侧设置栏复用同一个抽屉节点。先关闭上一个区块的普通设置栏，
    // 再点击目标区块，避免把抽屉切换动画中的旧内容当成当前区块。
    const editorDomId = record.target_editor_dom_id || record.editor_dom_id;
    const hasTargetNode = (nodes) => nodes.some((node) => node.key === editorDomId);
    let nodesBeforeClose = await this.editor.canvasNodeSnapshot();
    if (!hasTargetNode(nodesBeforeClose) && this.ensureCanvasReady) {
      await this.ensureCanvasReady();
      nodesBeforeClose = await this.editor.canvasNodeSnapshot();
    }
    await closeBlockSettings(this.page);
    let nodesAfterClose = await this.editor.canvasNodeSnapshot();
    if (!hasTargetNode(nodesAfterClose) && this.ensureCanvasReady) {
      await this.ensureCanvasReady();
      nodesAfterClose = await this.editor.canvasNodeSnapshot();
    }
    let drawer = null;
    let lastFrameError = null;
    // 画布会在页面重开后异步替换 iframe。节点刚被定位到时 frame 可能
    // 恰好销毁；在当前页面重新取得 locator 即可，不需要再次刷新整页。
    for (let frameAttempt = 0; frameAttempt < 5 && !drawer; frameAttempt += 1) {
      let root = await visibleCanvasRoot(this.editor, editorDomId, 3500);
      if (!root && this.ensureCanvasReady && frameAttempt < 4) {
        await this.ensureCanvasReady();
        root = await visibleCanvasRoot(this.editor, editorDomId, 3500);
      }
      if (!root) {
        if (frameAttempt < 4) {
          await this.page.waitForTimeout(900);
          continue;
        }
        throw new V4UiError(
          "block_root_not_found",
          `未找到区块${record.block_id}的稳定节点${editorDomId}`,
          { nodesBeforeClose, nodesAfterClose, frames: this.editor.contexts().map((scope) => ({ url: scope.url(), detached: scope.isDetached?.() ?? false })) },
        );
      }
      try {
        await root.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
        const box = await root.boundingBox();
        const positions = [
          { x: 40, y: 40 },
          { x: Math.max(12, Math.min(90, Math.floor((box?.width ?? 180) / 4))), y: Math.max(12, Math.min(90, Math.floor((box?.height ?? 180) / 4))) },
          { x: Math.max(12, Math.floor((box?.width ?? 180) / 2)), y: 24 },
        ];
        for (const position of positions) {
          await root.hover({ force: true });
          await root.click({ position, force: true });
          drawer = await waitForActiveDrawer(this.page, 2200);
          if (drawer) break;
        }
        lastFrameError = null;
      } catch (error) {
        if (!/Frame was detached|Execution context was destroyed/u.test(error.message)) throw error;
        lastFrameError = error;
        await this.page.waitForTimeout(900);
      }
    }
    if (lastFrameError && !drawer) throw lastFrameError;
    if (!drawer) throw new V4UiError("settings_not_found", `区块${record.block_id}点击后未打开右侧设置栏`);

    const firstImage = drawer.locator("li.group-item:visible img:visible").first();
    await firstImage.waitFor({ state: "visible", timeout: 2600 }).catch(() => {});
    if (!(await firstImage.isVisible().catch(() => false))) {
      return { status: "unsupported_no_media_item", drawer, richContainers: drawer.locator(".never-match") };
    }
    const item = firstImage.locator("xpath=ancestor::li[1]");
    // 这些模板的CSS监听图片本身的 :hover，而不是列表项的 :hover。
    // 严格按人工路径悬浮第一张图片，等铅笔图标显示后再点击。
    const edit = item.locator(".el-upload-list__item-preview:visible").first();
    let editVisible = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await firstImage.hover({ force: true });
      await this.page.waitForTimeout(420);
      if (await edit.isVisible().catch(() => false)) {
        editVisible = true;
        break;
      }
    }
    if (!editVisible) throw new V4UiError("media_edit_not_visible", `区块${record.block_id}第一张图片悬浮后编辑按钮未显示`);
    await edit.click();
    const detail = await waitForActiveDrawer(this.page, 3500);
    await this.page.waitForTimeout(320);
    if (!detail) throw new V4UiError("settings_not_found", `区块${record.block_id}第一张图片未打开编辑内容`);
    const richContainers = detail.locator(".edit-text-container:visible").filter({ has: this.page.locator(".ql-editor[contenteditable='true']") });
    const count = await richContainers.count();
    return {
      status: count > 0 ? "rich_text_found" : "unsupported_no_rich_text",
      drawer: detail,
      richContainers,
    };
  }

  async configureContainer(container, record, editorIndex) {
    const editor = container.locator(".ql-editor[contenteditable='true']:visible");
    if (await editor.count() !== 1) {
      throw new V4UiError("rich_text_ambiguous", `区块${record.block_id}第${editorIndex + 1}处富文本输入框数量不是1`);
    }
    const picker = container.locator(".ql-typography.ql-picker:visible");
    if (await picker.count() !== 1) {
      throw new V4UiError("level_control_ambiguous", `区块${record.block_id}第${editorIndex + 1}处级别控件数量不是1`);
    }
    const input = editor.first();
    const originalText = normalizeRichText(await input.innerText());
    const fieldName = normalizeRichText(await container.locator(".name").first().innerText().catch(() => ""));
    const label = picker.locator(".ql-picker-label").first();
    const originalLevel = (await label.getAttribute("data-label")) || (await label.getAttribute("data-value")) || "";
    const expected = expectedPreparedHeading(record, editorIndex);
    if (expected.level !== "H2") {
      throw new V4UiError("source_data_invalid", `区块${record.block_id}第${editorIndex + 1}处源级别不是H2：${expected.level}`);
    }
    if (expected.fieldName && fieldName !== expected.fieldName) {
      throw new V4UiError(
        "rich_text_field_mismatch",
        `区块${record.block_id}第${editorIndex + 1}处字段应为“${expected.fieldName}”，实际为“${fieldName}”`,
      );
    }

    await input.click();
    await input.press("ControlOrMeta+A");
    await input.fill(expected.text);
    await input.press("ControlOrMeta+A");
    await label.click();
    const h2 = picker.locator(".ql-picker-item[data-value='heading2']");
    if (await h2.count() !== 1) {
      throw new V4UiError("level_control_not_found", `区块${record.block_id}第${editorIndex + 1}处未找到H2选项`);
    }
    await h2.click();
    await this.page.waitForTimeout(220);
    const actual = await this.readContainer(container);
    if (actual.text !== expected.text || actual.level !== expected.level) {
      throw new V4UiError(
        "configure_mismatch",
        `区块${record.block_id}第${editorIndex + 1}处设置后不一致：${actual.level}/${actual.text}`,
      );
    }
    return {
      editor_index: editorIndex + 1,
      field_name: fieldName,
      original_text: originalText,
      original_level: String(originalLevel).toUpperCase(),
      expected_text: expected.text,
      expected_level: expected.level,
      actual_text: actual.text,
      actual_level: actual.level,
      status: "configured_pending_page_save",
      failure_reason: "",
    };
  }

  async readContainer(container) {
    const editor = container.locator(".ql-editor[contenteditable='true']:visible").first();
    const text = normalizeRichText(await editor.innerText());
    const direct = editor.locator(":scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6");
    const tag = await direct.count() === 1 ? await direct.first().evaluate((element) => element.tagName) : "";
    const pickerLevel = await container.locator(".ql-typography .ql-picker-label").first().getAttribute("data-value").catch(() => "");
    const level = tag || (/^heading[1-6]$/u.test(pickerLevel ?? "") ? `H${pickerLevel.at(-1)}` : "");
    return { text, level };
  }

  async inspectAndConfigure(record, apply) {
    const opened = await this.openFirstMediaDetail(record);
    const count = await opened.richContainers.count();
    if (opened.status !== "rich_text_found") {
      await closeBlockSettings(this.page);
      return { status: opened.status === "unsupported_no_rich_text" ? "unsupported_no_rich_text" : opened.status, rich_text_count: 0, editors: [] };
    }
    if (record.expected_editors && count !== record.expected_editors.length) {
      await closeBlockSettings(this.page);
      throw new V4UiError(
        "rich_text_count_mismatch",
        `区块${record.block_id}富文本数量应为${record.expected_editors.length}，实际为${count}`,
      );
    }
    const editors = [];
    for (let index = 0; index < count; index += 1) {
      const container = opened.richContainers.nth(index);
      if (apply) editors.push(await this.configureContainer(container, record, index));
      else {
        const actual = await this.readContainer(container);
        editors.push({
          editor_index: index + 1,
          field_name: normalizeRichText(await container.locator(".name").first().innerText().catch(() => "")),
          original_text: actual.text,
          original_level: actual.level,
          expected_text: expectedPreparedHeading(record, index).text,
          expected_level: expectedPreparedHeading(record, index).level,
          actual_text: actual.text,
          actual_level: actual.level,
          status: "inventoried",
          failure_reason: "",
        });
      }
    }
    await closeBlockSettings(this.page);
    return {
      status: apply ? "configured_pending_page_save" : "rich_text_found",
      rich_text_count: count,
      editors,
    };
  }

  async verify(record) {
    const opened = await this.openFirstMediaDetail(record);
    const count = await opened.richContainers.count();
    if (count !== record.editors.length) {
      await closeBlockSettings(this.page);
      throw new V4UiError("reopen_count_mismatch", `区块${record.block_id}重开后富文本数量：期望${record.editors.length}，实际${count}`);
    }
    const verified = [];
    for (let index = 0; index < count; index += 1) {
      const actual = await this.readContainer(opened.richContainers.nth(index));
      const expected = record.editors[index];
      const ok = actual.text === expected.expected_text && actual.level === expected.expected_level;
      verified.push({ ...expected, actual_text: actual.text, actual_level: actual.level, status: ok ? "verified" : "reopen_mismatch", failure_reason: ok ? "" : `期望H2/${expected.expected_text}，实际${actual.level}/${actual.text}` });
    }
    await closeBlockSettings(this.page);
    if (verified.some((item) => item.status !== "verified")) {
      throw new V4UiError("reopen_mismatch", `区块${record.block_id}重开验证失败`, { editors: verified });
    }
    return verified;
  }
}

export async function runV4RichTextSetup({ config, statePath, artifactsDir, apply = false, reset = false, reportWriter }) {
  const source = await loadV4RichTextSource(config);
  const state = await loadOrCreateV4RichTextState(statePath, source, reset);
  await mkdir(artifactsDir, { recursive: true });
  const allFinal = state.records.every((record) => ["verified", "unsupported_no_rich_text"].includes(record.status));
  const latestVerification = state.records.map((record) => record.verified_at ?? "").sort().at(-1) ?? "";
  if (apply && allFinal && (!state.reopen_verified_at || state.reopen_verified_at < latestVerification)) {
    state.reopen_verified_at = latestVerification || now();
    state.updated_at = now();
    await saveJsonAtomic(statePath, state);
    await reportWriter(state);
    return state;
  }
  const tracePath = path.join(artifactsDir, `v4-rich-text-${Date.now()}.zip`);
  const { context, page } = await launchV4Browser(config, { headless: false, traceName: "4.0富文本H2数据准备" });
  try {
    const editor = new V4Editor(page, config);
    await editor.goto();
    await editor.openCustomPage(V4_RICH_TEXT_PAGE.name);
    const ui = new V4RichTextSetupUi(editor);
    let configuredThisRun = 0;

    for (const record of state.records) {
      if (apply && ["verified", "unsupported_no_rich_text"].includes(record.status)) continue;
      record.failure_reason = "";
      try {
        const result = await ui.inspectAndConfigure(record, apply);
        Object.assign(record, result, {
          prepared_count: result.editors.filter((item) => item.status === "configured_pending_page_save").length,
          verified_count: 0,
          updated_at: now(),
        });
        if (result.status === "configured_pending_page_save") configuredThisRun += result.editors.length;
      } catch (error) {
        record.status = error.status ?? "configure_failed";
        record.failure_reason = error.message;
        record.updated_at = now();
        const screenshot = path.join(artifactsDir, `failed-${record.slot_index}-${record.block_id}.png`);
        await editor.page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
      }
      state.updated_at = now();
      await saveJsonAtomic(statePath, state);
      await reportWriter(state);
    }

    if (!apply) return state;
    if (configuredThisRun > 0 || state.records.some((record) => record.status === "configured_pending_page_save")) {
      const saveEvidence = await editor.savePage();
      state.page_saved_at = now();
      state.save_evidence = saveEvidence;
      for (const record of state.records.filter((item) => item.status === "configured_pending_page_save")) {
        record.status = "configured";
        record.saved_at = state.page_saved_at;
        for (const item of record.editors) item.status = "configured";
      }
      await saveJsonAtomic(statePath, state);
      await reportWriter(state);
    }

    await editor.reopenCustomPage(V4_RICH_TEXT_PAGE.name);
    const verifier = new V4RichTextSetupUi(editor);
    for (const record of state.records.filter((item) => ["configured", "verified"].includes(item.status))) {
      try {
        record.editors = await verifier.verify(record);
        record.verified_count = record.editors.length;
        record.status = "verified";
        record.failure_reason = "";
        record.verified_at = now();
      } catch (error) {
        record.status = error.status ?? "reopen_verify_failed";
        record.failure_reason = error.message;
        if (error.details?.editors) record.editors = error.details.editors;
        const screenshot = path.join(artifactsDir, `verify-failed-${record.slot_index}-${record.block_id}.png`);
        await editor.page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
      }
      state.updated_at = now();
      await saveJsonAtomic(statePath, state);
      await reportWriter(state);
    }
    state.reopen_verified_at = now();
    state.updated_at = now();
    await saveJsonAtomic(statePath, state);
    await reportWriter(state);
    // 截图是辅助证据，不能覆盖已经完成的逐项DOM验证结果。4.0页面很长，
    // 全页截图偶发卡在远程字体加载，因此只截当前可见区域并允许超时跳过。
    await editor.page.screenshot({ path: path.join(artifactsDir, "v4-rich-text-final.png"), fullPage: false, timeout: 8000 }).catch(() => {});
    return state;
  } finally {
    await stopV4Trace(context, tracePath).catch(() => {});
    await context.close();
  }
}
