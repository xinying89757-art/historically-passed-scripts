import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ComponentEditor } from "./component-editor.mjs";
import { loadConfig } from "./config.mjs";
import { LeadongEditor } from "./editor.mjs";
import { normalizeLevel, normalizeText, stripSyncSuffix } from "./growth-engine-h-core.mjs";
import { scheduleChromeMinimize } from "./window-utils.mjs";

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function screenshot(page, config, label) {
  const directory = path.join(config.paths.artifactsDir, "editor-backfill");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${timestamp()}-${label}.png`);
  await page.screenshot({ path: target, fullPage: true }).catch(() => {});
  return target;
}

export function classifyEditorBackfill({ expectedLevel, expectedText, actualLevel, actualText }) {
  const differences = [];
  if (normalizeLevel(actualLevel) !== normalizeLevel(expectedLevel)) {
    differences.push(`级别应为 ${normalizeLevel(expectedLevel)}，实际为 ${normalizeLevel(actualLevel) || "空"}`);
  }
  if (normalizeText(actualText) !== normalizeText(expectedText)) {
    differences.push(`文字应为“${normalizeText(expectedText)}”，实际为“${normalizeText(actualText)}”`);
  }
  return {
    status: differences.length === 0 ? "verified" : "mismatch",
    differences,
  };
}

export function summarizeEditorBackfill(items, pageName) {
  const targets = items.filter((item) => item.editor_backfill_status !== "not_applicable");
  const verified = targets.filter((item) => item.editor_backfill_status === "verified").length;
  const failedItems = targets.filter((item) => item.editor_backfill_status !== "verified");
  return {
    status: failedItems.length === 0 ? "verified" : "failed",
    page_name: pageName,
    verified,
    failed: failedItems.length,
    differences: failedItems.map(
      (item) => `第 ${item.item_index} 项：${item.editor_backfill_failure_reason || item.editor_backfill_status}`,
    ),
  };
}

export function componentRecordSourceTexts(record) {
  return [
    record.expected_title,
    ...(record.expected_headings ?? []).map((heading) => heading.text),
    ...(record.expected_editors ?? []).map((editor) => editor.text),
  ].map(normalizeText).filter(Boolean);
}

export function buildSyncedComponentRecord(record, items) {
  const clone = structuredClone(record);
  const synced = (text, level = "") => {
    const item = items.find((candidate) =>
      normalizeText(candidate.source_text) === normalizeText(text));
    return item
      ? { text: item.expected_text, level: item.expected_level }
      : { text, level };
  };
  if (clone.expected_title) {
    clone.expected_title = synced(clone.expected_title).text;
  }
  clone.expected_headings = (clone.expected_headings ?? []).map((heading) => ({
    ...heading,
    ...synced(heading.text, heading.level),
  }));
  if (clone.component_kind === "custom_code") {
    clone.expected_code = clone.expected_headings
      .map(({ level, text }) => `<${String(level).toLowerCase()}>${text}</${String(level).toLowerCase()}>`)
      .join("\n");
  }
  clone.expected_editors = (clone.expected_editors ?? []).map((editor) => ({
    ...editor,
    ...synced(editor.text, editor.level),
  }));
  return clone;
}

export function blockRecordSourceTexts(record) {
  return [...(record.heading_poc ?? []), ...(record.heading_results ?? [])]
    .map((heading) => normalizeText(heading.text)).filter(Boolean);
}

async function openBlockSettings(editor, audit) {
  const frame = editor.canvasContexts().find((candidate) => candidate.url() === audit.frame_url);
  if (!frame) throw new Error("未找到区块所在画布");
  const root = frame.locator(audit.fingerprint).first();
  await root.scrollIntoViewIfNeeded();
  await root.hover({ force: true });
  await editor.page.waitForTimeout(600);
  const ids = await root.evaluate((element) => {
    const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const found = new Set();
    let current = element;
    for (let depth = 0; depth < 5 && current; depth += 1) {
      for (const node of current.querySelectorAll("a,button,[role='button']")) {
        if (visible(node) && normalize(node.innerText || node.textContent) === "设置" && node.id) found.add(node.id);
      }
      current = current.parentElement;
    }
    return [...found];
  });
  if (ids.length !== 1) throw new Error(`区块设置按钮数量为 ${ids.length}`);
  await frame.locator(`[id="${ids[0]}"]`).click();
  await editor.page.waitForTimeout(1000);
}

async function cancelBlockDialog(editor) {
  const gallery = editor.page.locator(".pics_gallery_new:visible").first();
  if (await gallery.count().catch(() => 0)) {
    const galleryCancel = gallery.getByText("取消", { exact: true }).and(editor.page.locator(":visible"));
    if (await galleryCancel.count().catch(() => 0) === 1) {
      await galleryCancel.click();
      await gallery.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
      return;
    }
  }
  for (const scope of editor.contexts()) {
    const cancel = scope.locator("a.backstage-dialog-cancel:visible").filter({ hasText: /^(取消|关闭)$/u });
    if ((await cancel.count().catch(() => 0)) === 1) {
      await cancel.click();
      return;
    }
  }
  await editor.page.keyboard.press("Escape").catch(() => {});
}

async function readBlockModalHeadings(editor, audit) {
  await openBlockSettings(editor, audit);
  try {
    const headings = [];
    for (const scope of editor.contexts()) {
      const shells = scope.locator(".cke:visible");
      const count = await shells.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const iframe = shells.nth(index).locator("iframe").first();
        if ((await iframe.count().catch(() => 0)) !== 1) continue;
        const handle = await iframe.elementHandle();
        const frame = await handle?.contentFrame();
        if (!frame) continue;
        const body = frame.locator("body[contenteditable='true'],body.cke_editable").first();
        if ((await body.count().catch(() => 0)) !== 1) continue;
        headings.push(...await body.locator("h1,h2,h3,h4,h5,h6").evaluateAll((elements) =>
          elements.map((element) => ({
            level: element.tagName.toUpperCase(),
            text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
          })),
        ));
      }
    }
    return headings;
  } finally {
    await cancelBlockDialog(editor);
  }
}

async function verifyBlockItem(editor, item, sourceRecord, modalAuditCache = new Map()) {
  const audits = await editor.auditBlock(sourceRecord.block_id);
  if (audits.length !== 1) {
    return { status: "locator_ambiguous", reason: `区块 ${sourceRecord.block_id} 根节点数量=${audits.length}` };
  }
  const headingSource = [...(sourceRecord.heading_poc ?? []), ...(sourceRecord.heading_results ?? [])].find((heading) =>
    normalizeText(heading.text) === normalizeText(item.source_text));
  if (!headingSource) return { status: "not_found", reason: "区块来源清单未找到对应测试H" };
  let headings = [];
  let evidence = "block_canvas_heading";
  if (headingSource.kind === "modal") {
    if (!modalAuditCache.has(sourceRecord.block_id)) {
      modalAuditCache.set(sourceRecord.block_id, await readBlockModalHeadings(editor, audits[0]));
    }
    headings = modalAuditCache.get(sourceRecord.block_id);
    evidence = "block_settings_rich_text";
  } else {
    const frame = editor.canvasContexts().find((candidate) => candidate.url() === audits[0].frame_url);
    if (!frame) return { status: "not_found", reason: "未找到区块画布" };
    const root = frame.locator(audits[0].fingerprint).first();
    const target = root.locator("h1,h2,h3,h4,h5,h6").filter({ hasText: item.expected_text });
    if ((await target.count().catch(() => 0)) === 1) {
      await target.click().catch(() => {});
      await editor.page.waitForTimeout(350);
    }
    headings = await root.locator("h1,h2,h3,h4,h5,h6").evaluateAll((elements) =>
      elements.map((element) => ({
        level: element.tagName.toUpperCase(),
        text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
      })),
    );
    if (await root.locator("[contenteditable='true']").count().catch(() => 0)) {
      evidence = "block_inline_rich_text";
    }
  }
  const matches = headings.filter((heading) => normalizeText(heading.text) === normalizeText(item.expected_text));
  const ok = matches.length === 1 && matches[0].level === item.expected_level;
  return {
    status: ok ? "verified" : "mismatch",
    reason: ok ? "" : `区块设置回填不一致：预期 ${item.expected_level}/${item.expected_text}，匹配数=${matches.length}，实际级别=${matches.map((heading) => heading.level).join("|") || "空"}`,
    actualLevel: matches.map((heading) => heading.level).join("|"),
    actualText: matches.map((heading) => heading.text).join("|"),
    evidence,
  };
}

async function waitForTargetEditor(context, existingPages, timeoutMs, urlIncludes = "/phoenix/pagebuilder") {
  const deadline = Date.now() + timeoutMs;
  let continued = false;
  let confirmed = false;
  while (Date.now() < deadline) {
    const pages = context.pages().filter((page) => !page.isClosed());
    const editor = pages.find(
      (page) => !existingPages.has(page) && page.url().includes(urlIncludes),
    );
    if (editor) return editor;

    for (const page of pages) {
      if (existingPages.has(page) || !page.url().includes("/login/midway")) continue;
      const continueLogin = page
        .locator("a.backstage-dialog-submit:visible")
        .filter({ hasText: /^继续登录$/u });
      if (!continued && (await continueLogin.count().catch(() => 0)) === 1) {
        await continueLogin.click({ force: true });
        continued = true;
        continue;
      }
      const confirm = page
        .locator("a.backstage-dialog-submit:visible")
        .filter({ hasText: /^确定$/u });
      if (continued && !confirmed && (await confirm.count().catch(() => 0)) === 1) {
        await confirm.click({ force: true });
        confirmed = true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("进入3.0编辑器超时：未完成多站点登录或未打开pagebuilder");
}

export function findGrowthEnginePlatformPage(context) {
  return context
    .pages()
    .filter((page) => !page.isClosed())
    .find((page) => page.url().includes("/phoenix2/composite/middle/platform/"));
}

async function enterTargetEditorFromPlatform(context, config, platformPage) {
  const existingPages = new Set(context.pages());
  platformPage.setDefaultTimeout(config.timeouts.actionMs);
  const switcher = platformPage.locator(".wrap-webSite .webSite-show:visible");
  if ((await switcher.count().catch(() => 0)) !== 1) {
    throw new Error("增长引擎顶部未找到唯一的站点切换入口");
  }
  await switcher.click();

  const siteTab = platformPage
    .locator(".wrap-webSite .ant-tabs-tab:visible")
    .filter({ has: platformPage.locator(".webSite-content-tab", { hasText: config.editorBackfill.siteName }) });
  if ((await siteTab.count().catch(() => 0)) !== 1) {
    throw new Error(`增长引擎站点切换器中“${config.editorBackfill.siteName}”不是唯一项`);
  }
  await siteTab.click();

  const language = platformPage
    .locator(".wrap-webSite .ant-tabs-tabpane-active .language-li:visible")
    .filter({ hasText: new RegExp(`^\\s*${config.editorBackfill.siteLanguage}\\s*$`, "u") });
  if ((await language.count().catch(() => 0)) !== 1) {
    throw new Error(`目标站点中“${config.editorBackfill.siteLanguage}”语言不是唯一项`);
  }
  await language.click();

  const targetName = platformPage
    .locator(".wrap-webSite .webSite-show-top p")
    .filter({ hasText: new RegExp(`^\\s*${config.editorBackfill.siteName}\\s*$`, "u") });
  await targetName.waitFor({ state: "visible", timeout: config.timeouts.navigationMs });
  const targetHost = platformPage.locator(".wrap-webSite .webSite-show-bottom p");
  const deadline = Date.now() + config.timeouts.navigationMs;
  while (Date.now() < deadline) {
    const hostText = normalizeText(await targetHost.textContent().catch(() => ""));
    if (hostText.includes(config.editorBackfill.siteHost)) break;
    await platformPage.waitForTimeout(250);
  }
  const hostText = normalizeText(await targetHost.textContent().catch(() => ""));
  if (!hostText.includes(config.editorBackfill.siteHost)) {
    throw new Error(`站点切换后域名不一致：预期 ${config.editorBackfill.siteHost}，实际 ${hostText || "空"}`);
  }

  const edit = platformPage.getByRole("link", { name: "网页编辑", exact: true });
  if ((await edit.count().catch(() => 0)) !== 1) {
    throw new Error("增长引擎顶部“网页编辑”入口不是唯一项");
  }
  await edit.click();
  const editorPage = await waitForTargetEditor(
    context,
    existingPages,
    Math.max(config.timeouts.navigationMs, 90000),
    config.editorBackfill.editorUrlIncludes ?? "/phoenix/pagebuilder",
  );
  await editorPage.waitForLoadState("domcontentloaded").catch(() => {});
  await editorPage.waitForTimeout(2500);
  return { editorPage, route: "platform_header" };
}

async function enterTargetEditorFromSiteList(context, config) {
  const existingPages = new Set(context.pages());
  const sitePage = await context.newPage();
  scheduleChromeMinimize();
  await sitePage.goto(config.loginUrl, {
    waitUntil: "domcontentloaded",
    timeout: config.timeouts.navigationMs,
  });
  await sitePage.waitForTimeout(2500);
  const cards = sitePage
    .locator(".mySiteBox")
    .filter({ hasText: config.editorBackfill.siteName })
    .filter({ hasText: config.editorBackfill.siteHost });
  if ((await cards.count()) !== 1) {
    throw new Error(
      `“我的网站”中目标站点匹配数量为 ${await cards.count()}：${config.editorBackfill.siteName}/${config.editorBackfill.siteHost}`,
    );
  }
  const card = cards.first();
  const language = card
    .locator(".lansSelect .lanItem")
    .filter({ hasText: new RegExp(`^\\s*${config.editorBackfill.siteLanguage}\\s*$`, "u") })
    .first();
  const languageValue = await language.getAttribute("value").catch(() => "");
  if (await language.isVisible().catch(() => false)) await language.click();
  // A site card contains one “编辑网站” anchor per language.  Matching the
  // visible text alone yields several candidates; the language value is also
  // carried by the anchor's `l` attribute and identifies the correct one.
  const edit = languageValue
    ? card.locator(`a.userEditSite[l="${languageValue}"]`).first()
    : card.locator("a.userEditSite").filter({ hasText: "编辑网站" }).first();
  if ((await edit.count()) !== 1) throw new Error("目标站点的“编辑网站”按钮不是唯一项");
  await edit.click();
  const editorPage = await waitForTargetEditor(
    context,
    existingPages,
    Math.max(config.timeouts.navigationMs, 90000),
    config.editorBackfill.editorUrlIncludes ?? "/phoenix/pagebuilder",
  );
  await editorPage.waitForLoadState("domcontentloaded").catch(() => {});
  await editorPage.waitForTimeout(2500);
  return { sitePage, editorPage, route: "site_list" };
}

export async function enterTargetEditor(context, config) {
  // Some page-confirmation batches must use the explicit "我的网站" route.
  // The platform shortcut can land on a different site when multiple site
  // identities share the same account; keep this opt-in so legacy flows are
  // unchanged.
  if (config.editorBackfill?.forceSiteList === true) {
    return enterTargetEditorFromSiteList(context, config);
  }
  const platformPage = findGrowthEnginePlatformPage(context);
  if (!platformPage) return enterTargetEditorFromSiteList(context, config);

  const pagesBeforeAttempt = new Set(context.pages());
  try {
    return await enterTargetEditorFromPlatform(context, config, platformPage);
  } catch (platformError) {
    for (const page of context.pages()) {
      if (!pagesBeforeAttempt.has(page)) await page.close().catch(() => {});
    }
    try {
      return await enterTargetEditorFromSiteList(context, config);
    } catch (siteListError) {
      throw new Error(
        `增长引擎顶部直达编辑器失败：${platformError.message}；备用“我的网站”入口失败：${siteListError.message}`,
      );
    }
  }
}

async function locateComponentByHeading(editor, expectedText) {
  const matches = [];
  for (const frame of editor.canvasContexts()) {
    const roots = frame.locator(editor.config.selectors.componentRootSelector);
    const count = await roots.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const root = roots.nth(index);
      if (!(await root.isVisible().catch(() => false))) continue;
      const headings = await root.locator("h1,h2,h3,h4,h5,h6").evaluateAll(
        (elements, text) => elements
          .map((element) => ({
            level: element.tagName.toUpperCase(),
            text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
          }))
          .filter((heading) => heading.text === text),
        normalizeText(expectedText),
      ).catch(() => []);
      if (headings.length === 0) continue;
      const settingId =
        (await root.getAttribute("settingId")) ||
        (await root.getAttribute("settingid")) ||
        (await root.getAttribute("id"))?.replace(/^component_/u, "") ||
        "";
      matches.push({
        frame,
        root,
        settingId,
        headingCount: headings.length,
        canvasLevel: headings.map((heading) => heading.level).join("|"),
      });
    }
  }
  return matches;
}

async function verifyOneItem(
  componentEditor,
  editor,
  item,
  sourceRecord = null,
  allItems = [],
  specialAuditCache = new Map(),
) {
  if (["custom_code", "rich_text_dialog"].includes(sourceRecord?.component_kind)) {
    const cacheKey = sourceRecord.setting_id;
    let audit = specialAuditCache.get(cacheKey);
    if (!audit) {
      const syncedRecord = buildSyncedComponentRecord(sourceRecord, allItems);
      audit = await componentEditor.auditRecord(sourceRecord.setting_id, syncedRecord);
      specialAuditCache.set(cacheKey, audit);
    }
    item.editor_element_type = sourceRecord.component_kind;
    item.editor_setting_id = sourceRecord.setting_id;
    item.editor_backfill_evidence = audit.evidence ?? sourceRecord.component_kind;
    if (!audit.ok) {
      return {
        status: "mismatch",
        reason: audit.reason || "特殊组件设置项整体回填不一致",
        actualLevel: audit.actual_level,
        actualText: audit.actual_title,
        evidence: audit.evidence,
      };
    }
    const sourceText = normalizeText(item.source_text);
    if (normalizeText(sourceRecord.expected_title) === sourceText) {
      const matches = await locateComponentByHeading(editor, item.expected_text);
      const levels = matches.flatMap((match) => String(match.canvasLevel).split("|").filter(Boolean));
      const ok = matches.length === 1 && levels.length === 1 && levels[0] === item.expected_level;
      return {
        status: ok ? "verified" : "mismatch",
        reason: ok ? "" : `组件标题画布回填不一致：匹配根节点=${matches.length}，级别=${levels.join("|") || "空"}`,
        actualLevel: levels.join("|"),
        actualText: audit.actual_title,
        evidence: `${audit.evidence}+canvas_heading`,
      };
    }
    const headingMatches = (audit.actual_headings ?? []).filter((heading) =>
      normalizeText(heading.text) === normalizeText(item.expected_text));
    const ok = headingMatches.length === 1 && headingMatches[0].level === item.expected_level;
    return {
      status: ok ? "verified" : "mismatch",
      reason: ok ? "" : `特殊组件设置项未找到唯一预期H：${item.expected_level}/${item.expected_text}`,
      actualLevel: headingMatches.map((heading) => heading.level).join("|"),
      actualText: headingMatches.map((heading) => heading.text).join("|"),
      evidence: audit.evidence,
    };
  }
  if (sourceRecord?.setting_id && normalizeText(item.expected_text) === "" && sourceRecord.original_name !== "文本") {
    item.editor_element_type = "component";
    item.editor_setting_id = sourceRecord.setting_id;
    if (!(await componentEditor.openSettings(sourceRecord.setting_id))) {
      return { status: "settings_unavailable", reason: "组件存在，但无法打开设置弹窗核对空标题" };
    }
    try {
      const values = await componentEditor.readAndCloseVisibleDialog();
      if (!values) return { status: "settings_unavailable", reason: "设置弹窗中未找到组件标题或标题级别" };
      const result = classifyEditorBackfill({
        expectedLevel: item.expected_level,
        expectedText: item.expected_text,
        actualLevel: values.actual_level,
        actualText: values.actual_title,
      });
      return {
        status: result.status,
        reason: result.differences.join("；"),
        actualLevel: values.actual_level,
        actualText: values.actual_title,
        evidence: "settings_dialog_empty_text",
      };
    } catch (error) {
      await componentEditor.cancelOpenDialog().catch(() => {});
      return { status: "check_failed", reason: error.message };
    }
  }
  const matches = await locateComponentByHeading(editor, item.expected_text);
  if (matches.length === 0) {
    return { status: "not_found", reason: "编辑器画布未找到预期标题文字" };
  }
  if (matches.length !== 1 || matches[0].headingCount !== 1 || !matches[0].settingId) {
    return {
      status: "locator_ambiguous",
      reason: `预期标题对应 ${matches.length} 个组件根节点，根节点内匹配数=${matches.map((match) => match.headingCount).join("|") || "0"}`,
    };
  }
  const match = matches[0];
  item.editor_element_type = "component";
  item.editor_setting_id = match.settingId;
  item.editor_canvas_level = match.canvasLevel;
  if (sourceRecord?.setting_id && sourceRecord.setting_id !== match.settingId) {
    return {
      status: "locator_ambiguous",
      reason: `组件清单 settingId=${sourceRecord.setting_id}，画布匹配 settingId=${match.settingId}`,
    };
  }
  if (sourceRecord?.original_name === "文本") {
    item.editor_element_type = "component_inline_text";
    const audit = await componentEditor.auditInlineText(
      match.settingId,
      item.expected_text,
      item.expected_level,
    );
    return {
      status: audit.ok ? "verified" : "mismatch",
      reason: audit.reason,
      actualLevel: audit.actual_level,
      actualText: audit.actual_title,
      evidence: audit.evidence,
    };
  }
  if (!(await componentEditor.openSettings(match.settingId))) {
    const canvasVerified = match.canvasLevel === item.expected_level;
    return {
      status: canvasVerified ? "verified" : "settings_unavailable",
      reason: canvasVerified ? "" : "组件存在，但无法打开设置弹窗",
      actualLevel: match.canvasLevel,
      actualText: item.expected_text,
      evidence: canvasVerified ? "canvas_heading_no_settings_button" : "",
    };
  }
  try {
    const values = await componentEditor.readAndCloseVisibleDialog();
    if (!values) {
      await componentEditor.cancelOpenDialog().catch(() => {});
      return { status: "settings_unavailable", reason: "设置弹窗中未找到组件标题或标题级别" };
    }
    const result = classifyEditorBackfill({
      expectedLevel: item.expected_level,
      expectedText: item.expected_text,
      actualLevel: values.actual_level,
      actualText: values.actual_title,
    });
    return {
      status: result.status,
      reason: result.differences.join("；"),
      actualLevel: values.actual_level,
      actualText: values.actual_title,
      evidence: "settings_dialog",
    };
  } catch (error) {
    await componentEditor.cancelOpenDialog().catch(() => {});
    return { status: "check_failed", reason: error.message };
  }
}

async function loadComponentSourceRecords(config) {
  const file = config.batch?.componentStateFile;
  if (!file) return [];
  try {
    const state = JSON.parse(await readFile(file, "utf8"));
    return state.records ?? [];
  } catch {
    return [];
  }
}

async function loadRankingSourceRecords(config) {
  const file = config.batch?.rankingStateFile;
  if (!file) return [];
  try {
    const state = JSON.parse(await readFile(file, "utf8"));
    return state.records ?? [];
  } catch {
    return [];
  }
}

export async function verifyGrowthEngineEditorBackfill({
  context,
  config,
  state,
  persist = async () => {},
}) {
  if (!config.editorBackfill?.enabled) {
    state.editor_backfill_verification = {
      status: "disabled",
      page_name: "",
      verified: 0,
      failed: 0,
      differences: [],
    };
    return state.editor_backfill_verification;
  }

  const existingPages = new Set(context.pages());
  let editorPage;
  try {
    const entered = await enterTargetEditor(context, config);
    editorPage = entered.editorPage;
    const editorConfig = await loadConfig();
    editorConfig.siteName = config.editorBackfill.siteName;
    editorConfig.siteLanguage = config.editorBackfill.siteLanguage;
    editorConfig.timeouts.actionMs = config.timeouts.actionMs;
    editorConfig.timeouts.blockRenderMs = config.timeouts.syncMs;
    const editor = new LeadongEditor(editorPage, editorConfig);
    const componentEditor = new ComponentEditor(editor);
    await editor.openCustomPage(config.editorBackfill.pageName);
    const componentSourceRecords = await loadComponentSourceRecords(config);
    const rankingSourceRecords = await loadRankingSourceRecords(config);
    const specialAuditCache = new Map();
    const blockModalAuditCache = new Map();

    for (const item of state.items) {
      item.editor_page_name = config.editorBackfill.pageName;
      if (!item.level_editable && !item.text_editable) {
        item.editor_backfill_status = "not_applicable";
        item.editor_backfill_failure_reason = "增长引擎中级别和文字均不可编辑";
        await persist();
        continue;
      }
      const sourceText = normalizeText(item.source_text) || stripSyncSuffix(item.expected_text);
      const isBlockPage = config.editorBackfill.scope === "blocks";
      const sourceMatches = (isBlockPage ? rankingSourceRecords : componentSourceRecords).filter(
        (record) => record.page_name === config.editorBackfill.pageName &&
          (isBlockPage ? blockRecordSourceTexts(record) : componentRecordSourceTexts(record))
            .includes(normalizeText(sourceText)),
      );
      if (sourceMatches.length > 1) {
        item.editor_backfill_status = "locator_ambiguous";
        item.editor_backfill_failure_reason = `${isBlockPage ? "区块" : "组件"}来源清单匹配 ${sourceMatches.length} 项：${sourceText}`;
        await persist();
        continue;
      }
      if (isBlockPage && sourceMatches.length === 0) {
        item.editor_element_type = "block";
        item.editor_backfill_status = "not_found";
        item.editor_backfill_failure_reason = `区块来源清单未找到测试文字：${sourceText}`;
        await persist();
        continue;
      }
      if (isBlockPage) {
        item.editor_element_type = "block";
        item.editor_setting_id = sourceMatches[0].block_id;
      }
      const result = isBlockPage
        ? await verifyBlockItem(editor, item, sourceMatches[0], blockModalAuditCache)
        : await verifyOneItem(
            componentEditor,
            editor,
            item,
            sourceMatches[0] ?? null,
            state.items,
            specialAuditCache,
          );
      item.editor_actual_level = result.actualLevel ?? "";
      item.editor_actual_text = result.actualText ?? "";
      item.editor_backfill_status = result.status;
      item.editor_backfill_evidence = result.evidence ?? "";
      item.editor_backfill_failure_reason = result.reason ?? "";
      if (result.status !== "verified") {
        item.editor_backfill_screenshot = await screenshot(
          editorPage,
          config,
          `item-${String(item.item_index).padStart(2, "0")}-${result.status}`,
        );
      }
      await persist();
    }
  } catch (error) {
    for (const item of state.items) {
      if (["verified", "not_applicable"].includes(item.editor_backfill_status)) continue;
      item.editor_backfill_status = "check_failed";
      item.editor_backfill_failure_reason = error.message;
    }
    if (editorPage) {
      const shot = await screenshot(editorPage, config, "editor-backfill-system-failed");
      for (const item of state.items) {
        if (item.editor_backfill_status === "check_failed") item.editor_backfill_screenshot = shot;
      }
    }
  } finally {
    for (const page of context.pages()) {
      if (!existingPages.has(page)) await page.close().catch(() => {});
    }
  }
  state.editor_backfill_verification = summarizeEditorBackfill(
    state.items,
    config.editorBackfill.pageName,
  );
  await persist();
  return state.editor_backfill_verification;
}
