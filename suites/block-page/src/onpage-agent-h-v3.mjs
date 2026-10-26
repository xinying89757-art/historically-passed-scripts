#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ComponentEditor } from "./component-editor.mjs";
import { loadConfig, projectRoot } from "./config.mjs";
import { LeadongEditor } from "./editor.mjs";
import { enterTargetEditor, verifyGrowthEngineEditorBackfill } from "./growth-engine-h-editor-backfill.mjs";
import { GrowthEngineHPage, launchGrowthEngineContext } from "./growth-engine-h-editor.mjs";
import { normalizeLevel, normalizeText, numericRunId } from "./growth-engine-h-core.mjs";
import {
  buildScenarioTarget,
  classifyApiItem,
  stripAgentSuffix,
  summarizePage,
  validateCapturedHeadingPayload,
  verifyPreviewItem,
  verifyUnsubmittedHeadings,
  reconcileCurrentOrigins,
} from "./onpage-agent-h-core.mjs";
import { mergeSupplementalRunStates, writeOnPageAgentReports } from "./onpage-agent-h-report.mjs";
import { scheduleChromeMinimize } from "./window-utils.mjs";

function resolveProjectPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

function parseArgs(argv) {
  const result = { command: argv[2] ?? "status", apply: false, maxPages: Infinity, taskId: "", config: "config/onpage-agent-h-v3.json" };
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] === "--apply") result.apply = true;
    else if (argv[index] === "--max-pages") result.maxPages = Number(argv[++index]);
    else if (argv[index] === "--task-id") result.taskId = argv[++index];
    else if (argv[index] === "--config") result.config = argv[++index];
  }
  return result;
}

async function reverifyEditor(config, state, taskId = "") {
  const targets = config.targets.filter((target) => !taskId || target.id === taskId);
  for (const target of targets) {
    const pageState = state.pages.find((page) => page.target_id === target.id);
    if (!pageState?.items?.some((item) => ["updated", "updated_partial"].includes(item.api_status))) continue;
    const artifactDir = path.join(config.paths.artifactsDir, target.id);
    const targetConfig = pageConfig(config, target, artifactDir);
    const context = await launchGrowthEngineContext(targetConfig);
    try {
      const ge = new GrowthEngineHPage(context, targetConfig);
      await ge.open();
      const editorState = { items: pageState.items, editor_backfill_verification: { status: "pending" } };
      await verifyGrowthEngineEditorBackfill({ context, config: targetConfig, state: editorState, persist: async () => {} });
      pageState.editor_backfill_status = editorState.editor_backfill_verification.status;
      for (const item of pageState.items) {
        item.editor_level = item.editor_actual_level;
        item.editor_text = item.editor_actual_text;
        if (!["updated", "updated_partial"].includes(item.api_status) || item.preview_status !== "verified") continue;
        if (item.editor_backfill_status === "verified") {
          item.status = "modified_verified";
          item.failure_reason = "";
        } else {
          item.status = "editor_backfill_mismatch";
          item.failure_reason = item.editor_backfill_failure_reason || `编辑器回填状态：${item.editor_backfill_status}`;
        }
      }
      pageState.status = summarizePage(pageState.items, pageState.unsubmitted_status);
      pageState.failure_reason = pageState.status === "complete" ? "" : pageState.items
        .filter((item) => item.failure_reason)
        .map((item) => `第${item.item_index}项：${item.failure_reason}`)
        .join("；");
      pageState.checked_at = new Date().toISOString();
      await saveState(config, state);
    } finally {
      await context.close().catch(() => {});
    }
  }
  await writeOnPageAgentReports(state, config.paths.reportsDir);
  return state;
}

async function loadAgentConfig(configPath) {
  const absolute = resolveProjectPath(configPath);
  const config = JSON.parse(await readFile(absolute, "utf8"));
  for (const key of ["userDataDir", "stateFile", "artifactsDir", "reportsDir"]) {
    config.paths[key] = resolveProjectPath(config.paths[key]);
  }
  for (const key of ["componentStateFile", "blockStateFile"]) {
    config.sourceFiles[key] = resolveProjectPath(config.sourceFiles[key]);
  }
  config.reportSupplementalStateFiles = (config.reportSupplementalStateFiles ?? []).map(resolveProjectPath);
  return config;
}

async function saveState(config, state) {
  state.updated_at = new Date().toISOString();
  await mkdir(path.dirname(config.paths.stateFile), { recursive: true });
  const temp = `${config.paths.stateFile}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temp, config.paths.stateFile);
  await writeOnPageAgentReports(state, config.paths.reportsDir);
}

async function loadState(config) {
  try { return JSON.parse(await readFile(config.paths.stateFile, "utf8")); } catch { return null; }
}

function pageConfig(base, target, artifactDir) {
  return {
    ...base,
    targetPagePath: target.pagePath,
    pagePathCandidates: [target.pagePath],
    publicUrl: target.pageUrl,
    publicBaseUrl: new URL(target.pageUrl).origin,
    refreshBeforeEdit: false,
    refreshButtonOptional: true,
    growthEngineSite: { name: target.growthEngineSiteName, host: target.growthEngineSiteHost },
    editorBackfill: {
      enabled: true,
      siteName: target.editorSiteName,
      siteHost: target.editorSiteHost || target.growthEngineSiteHost,
      siteLanguage: target.editorSiteLanguage,
      pageName: target.pageName,
      scope: target.scope,
      forceSiteList: Boolean(base.pageConfirmation?.forceSiteList),
    },
    batch: {
      componentStateFile: base.sourceFiles.componentStateFile,
      rankingStateFile: target.blockStateFile || base.sourceFiles.blockStateFile,
    },
    paths: { ...base.paths, artifactsDir: artifactDir },
  };
}

async function writeEvidence(directory, name, value) {
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, name);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}

async function apiCall(browserPage, config, pageState, stage, pathname, body, headers = {}) {
  const directory = path.join(config.paths.artifactsDir, pageState.target_id, "api");
  const requestFile = await writeEvidence(directory, `${stage}-request.json`, body);
  const url = `${config.apiBaseUrl}${pathname}`;
  const result = await browserPage.evaluate(async ({ endpoint, payload, requestHeaders }) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...requestHeaders },
      body: JSON.stringify(payload),
      credentials: "include",
    });
    return { status: response.status, text: await response.text() };
  }, { endpoint: url, payload: body, requestHeaders: headers });
  let json;
  try { json = JSON.parse(result.text); } catch { json = { raw: result.text }; }
  const responseFile = await writeEvidence(directory, `${stage}-response.json`, json);
  pageState.api_calls.push({
    stage, method: "POST", url, http_status: result.status, business_code: json?.code ?? "",
    request_file: requestFile, response_file: responseFile, checked_at: new Date().toISOString(),
  });
  return { http: result.status, body: json, requestFile, responseFile };
}

function validateSucceeded(result) {
  return result.http === 200 && result.body?.code === 200 && Array.isArray(result.body?.data?.items);
}

async function validateHeadings(browserPage, config, pageState, payload, authorization) {
  const batch = await apiCall(
    browserPage,
    config,
    pageState,
    "headings-validate",
    "/headings/validate",
    payload,
    { Authorization: authorization },
  );
  if (validateSucceeded(batch)) {
    return {
      batch,
      items: batch.body.data.items,
      itemEvidence: new Map(),
      batchStatus: "batch_validate_passed",
      individualPassed: 0,
      individualFailed: 0,
    };
  }
  if (!config.validationFallback?.singleItemOnBatchFailure) {
    throw new Error(`validate_failed: 新接口validate失败，HTTP=${batch.http}，code=${batch.body?.code ?? "空"}`);
  }

  const items = [];
  const itemEvidence = new Map();
  let individualPassed = 0;
  let individualFailed = 0;
  for (const item of payload.items) {
    const singlePayload = { ...payload, items: [item] };
    const single = await apiCall(
      browserPage,
      config,
      pageState,
      `headings-validate-${item.itemKey}`,
      "/headings/validate",
      singlePayload,
      { Authorization: authorization },
    );
    itemEvidence.set(item.itemKey, {
      http: single.http,
      code: single.body?.code ?? "",
      requestFile: single.requestFile,
      responseFile: single.responseFile,
    });
    const result = single.body?.data?.items?.find((entry) => entry.itemKey === item.itemKey);
    if (validateSucceeded(single) && result) {
      individualPassed += 1;
      items.push(result);
    } else {
      individualFailed += 1;
      items.push({
        itemKey: item.itemKey,
        editable: false,
        fieldCapabilities: { type: false, text: false },
        reason: single.body?.errorCode || single.body?.message || `HTTP_${single.http}`,
        _validateFailed: true,
      });
    }
  }
  return {
    batch,
    items,
    itemEvidence,
    batchStatus: individualFailed === 0
      ? "batch_validate_failed_individual_passed"
      : individualPassed > 0
        ? "batch_validate_failed_individual_partial"
        : "batch_validate_failed_individual_failed",
    individualPassed,
    individualFailed,
  };
}

async function obtainAuthorization(browserPage, config, target, pageState) {
  const response = await apiCall(browserPage, config, pageState, "get-geo-auth", "/getGeoAuth", {
    userId: config.userId,
    domain: target.apiDomain || target.growthEngineSiteHost,
    pageUrl: target.pageUrl,
  });
  if (response.http !== 200 || response.body?.code !== 200 || !response.body?.data?.authorization) {
    throw new Error(`login_expired: getGeoAuth失败，HTTP=${response.http}，code=${response.body?.code ?? "空"}`);
  }
  return response.body.data;
}

async function captureCurrentItems(editor) {
  const requestPromise = editor.page.waitForRequest(
    (request) => request.method() === "POST" && /\/onpage\/element\/headings\/validate(?:\?|$)/u.test(request.url()),
    { timeout: editor.config.timeouts.syncMs },
  );
  // Attach a handler immediately.  Opening the dialog can itself take longer
  // than the request timeout; in that case the rejection happens before the
  // try/finally cleanup below is reached.  The handler prevents Node from
  // treating that expected timeout as an unhandled rejection while the await
  // below still receives the original error for page-level classification.
  requestPromise.catch(() => {});
  let dialog;
  try {
    dialog = await editor.openEditDialog();
    const request = await requestPromise;
    const payload = request.postDataJSON();
    const controls = await editor.inspectDialog(dialog);
    const items = validateCapturedHeadingPayload(payload);
    if (controls.length !== items.length) {
      throw new Error(`mapping_ambiguous: 弹窗控件 ${controls.length} 项，捕获定位数据 ${items.length} 项`);
    }
    return { items, controls: controls.map(({ level, text, levelEditable, textEditable }) => ({ level, text, levelEditable, textEditable })) };
  } finally {
    // If opening the dialog fails or the page never emits the validation
    // request, consume the pending wait rejection before returning.  Without
    // this cleanup Playwright reports an unhandled TimeoutError and terminates
    // the full multi-page run instead of letting the page be recorded as an
    // isolated automation/mapping failure.
    await requestPromise.catch(() => {});
    if (dialog) await editor.cancelDialog(dialog).catch(() => {});
  }
}

function scenarioMap(target, capturedItems, validateItems) {
  const map = new Map();
  // The page-confirmation batch is intentionally based on the live H list:
  // historical source text may have been changed by an earlier API run.  In
  // that mode every captured H is still sent through validate, while the API
  // decides whether its current origin is editable.
  if (target.pageConfirmationUseAllCapturedItems === true) {
    capturedItems.forEach((item, index) => {
      if ((target.retrySkipItems ?? []).some((completed) => sourceMatchesItem(completed, item))) return;
      map.set(index, "both");
    });
    return map;
  }
  if (Array.isArray(target.allowedSources)) {
    const used = new Set();
    for (const source of target.allowedSources) {
      const candidates = capturedItems
        .map((item, index) => ({ item, index }))
        .filter(({ item, index }) => {
          if (used.has(index)) return false;
          if (source.itemKey && String(item.itemKey ?? "") !== String(source.itemKey)) return false;
          if (source.settingId && String(item.settingId ?? "") !== String(source.settingId)) return false;
          if (source.position !== undefined && String(item.index ?? "") !== String(source.position)) return false;
          if (source.itemKey) return true;
          return stripAgentSuffix(item.origin?.text) === stripAgentSuffix(source.sourceText ?? source.text ?? "");
        });
      if (candidates.length !== 1) continue;
      const [{ index }] = candidates;
      used.add(index);
      map.set(index, source.scenario ?? "both");
    }
    return map;
  }
  for (const scenario of target.scenarios) {
    if (scenario.itemIndex === "all_editable") {
      capturedItems.forEach((_item, index) => map.set(index, scenario.type));
    } else {
      map.set(Number(scenario.itemIndex), scenario.type);
    }
  }
  return map;
}

function sourceMatchesItem(source, item) {
  if (source.itemKey && String(item.item_key ?? item.itemKey ?? "") !== String(source.itemKey)) return false;
  const sourceSettingId = source.settingId ?? source.setting_id;
  if (sourceSettingId && String(item.setting_id ?? item.settingId ?? "") !== String(sourceSettingId)) return false;
  if (source.position !== undefined && String(item.position ?? item.index ?? "") !== String(source.position)) return false;
  if (source.itemKey) return true;
  return stripAgentSuffix(source.sourceText ?? source.source_text ?? source.text ?? source.original_text ?? "") === stripAgentSuffix(item.source_text ?? item.original_text ?? item.origin?.text ?? "");
}

function retryScenarioTarget(target, pageState) {
  if (!Array.isArray(target.allowedSources) || !Array.isArray(pageState.retry_skip_items) || pageState.retry_skip_items.length === 0) return target;
  return {
    ...target,
    allowedSources: target.allowedSources.filter((source) => !pageState.retry_skip_items.some((item) => sourceMatchesItem(source, item))),
  };
}

function createItemState({ runId, target, captured, control, validateItem, updateItem, scenario, built, index, apiResult, requestFile, responseFile, validateEvidence, source }) {
  let classification = classifyApiItem({ validateItem, updateItem, scenario });
  const requiresLevel = ["level_only", "both"].includes(scenario);
  const requiresText = ["text_only", "empty_text", "both"].includes(scenario);
  const partialUpdate = updateItem?.status === "UPDATED" &&
    (requiresLevel !== Boolean(validateItem?.fieldCapabilities?.type) || requiresText !== Boolean(validateItem?.fieldCapabilities?.text));
  if (partialUpdate) classification = { status: "updated_partial", reason: "仅提交validate允许编辑的字段" };
  const updated = ["updated", "updated_partial"].includes(classification.status);
  return {
    run_id: runId, page_name: target.pageName, page_path: target.pagePath, page_url: target.pageUrl,
    item_index: index + 1, item_key: captured.itemKey, scenario,
    setting_id: captured.settingId ?? "", node_id: captured.nodeId ?? "", template_id: captured.templateId ?? "",
    position: captured.index ?? "", rule_id: validateItem?.ruleId ?? "", source_text: stripAgentSuffix(captured.origin.text),
    original_level: normalizeLevel(captured.origin.tagName), original_text: normalizeText(captured.origin.text),
    level_editable: Boolean(validateItem?.editable && validateItem?.fieldCapabilities?.type), text_editable: Boolean(validateItem?.editable && validateItem?.fieldCapabilities?.text),
    expected_level: built.expectedLevel, expected_text: built.expectedText,
    validate_http: apiResult.validateHttp, validate_code: apiResult.validateCode,
    update_http: apiResult.updateHttp, update_code: apiResult.updateCode,
    update_item_status: updateItem?.status ?? "", api_status: classification.status,
    preview_level: "", preview_text: "", preview_status: updated ? "pending" : "not_applicable",
    editor_level: "", editor_text: "", editor_backfill_status: updated ? "pending" : "not_applicable",
    status: classification.status, failure_reason: classification.reason,
    request_evidence: requestFile, response_evidence: responseFile, screenshot: "", checked_at: new Date().toISOString(),
    validate_request_evidence: validateEvidence?.requestFile ?? "",
    validate_response_evidence: validateEvidence?.responseFile ?? "",
    update_request_evidence: requestFile,
    update_response_evidence: responseFile,
    issue_group: target.issueGroup ?? "",
    object_type: source?.objectType ?? (target.scope === "components" ? "组件" : "区块"),
    object_id: source?.objectId ?? "",
    object_name: source?.objectName ?? "",
    level_editable_requested: "tagName" in built.target, text_editable_requested: "text" in built.target,
    // Compatibility fields consumed by the existing 3.0 editor backfill verifier.
    expected_text: built.expectedText, expected_level: built.expectedLevel,
    requested_text: "text" in built.target ? built.target.text : captured.origin.text,
    requested_level: built.target.tagName ? normalizeLevel(built.target.tagName) : normalizeLevel(captured.origin.tagName),
    editor_page_name: target.pageName, editor_element_type: "", editor_setting_id: "",
    editor_canvas_level: "", editor_actual_level: "", editor_actual_text: "",
    editor_backfill_evidence: "", editor_backfill_failure_reason: "",
    _captured: captured, _control: control,
  };
}

async function openEditorPreview(context, config, target) {
  const entered = await enterTargetEditor(context, config);
  const editorConfig = await loadConfig();
  editorConfig.siteName = target.editorSiteName;
  editorConfig.siteLanguage = target.editorSiteLanguage;
  editorConfig.timeouts.actionMs = config.timeouts.actionMs;
  editorConfig.timeouts.navigationMs = config.timeouts.navigationMs;
  const editor = new LeadongEditor(entered.editorPage, editorConfig);
  await editor.openCustomPage(target.pageName);
  const preview = await editor.openPreviewPage(target.pagePath);
  try {
    const headings = await preview.frame.locator("h1,h2,h3,h4,h5,h6").evaluateAll((elements) => elements.map((element) => {
      const ids = new Set();
      let current = element;
      for (let depth = 0; depth < 10 && current; depth += 1, current = current.parentElement) {
        for (const name of ["id", "data-settingid", "settingid", "data-block-id", "data-blockid", "block-id", "data-module-id", "data-component-id", "data-app-id"]) {
          const value = current.getAttribute?.(name);
          if (value) ids.add(value.replace(/^component_/u, ""));
        }
      }
      return { level: element.tagName.toUpperCase(), text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(), containerIds: [...ids] };
    }));
    return { url: preview.url, headings };
  } finally {
    await preview.page.close().catch(() => {});
    await entered.editorPage.close().catch(() => {});
    await entered.sitePage?.close().catch(() => {});
  }
}

async function processTarget(baseConfig, state, target) {
  const pageState = state.pages.find((page) => page.target_id === target.id);
  const artifactDir = path.join(baseConfig.paths.artifactsDir, target.id);
  const config = pageConfig(baseConfig, target, artifactDir);
  const context = await launchGrowthEngineContext(config);
  scheduleChromeMinimize();
  const tracePath = path.join(artifactDir, `trace-${state.run_id}.zip`);
  await mkdir(artifactDir, { recursive: true });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  let editor;
  try {
    pageState.status = "running";
    pageState.issue_group = target.issueGroup ?? "";
    pageState.api_calls = [];
    editor = new GrowthEngineHPage(context, config);
    await editor.open();
    await editor.waitForScanStable();
    const captured = await captureCurrentItems(editor);
    pageState.captured_count = captured.items.length;
    await writeEvidence(path.join(artifactDir, "mapping"), "captured-old-validate-request.json", { pageUrl: target.pageUrl, items: captured.items });
    const baselinePreview = await openEditorPreview(context, config, target);
    const currentItems = reconcileCurrentOrigins(captured.items, baselinePreview.headings);
    captured.items = currentItems;
    pageState.baseline_preview_url = baselinePreview.url;
    pageState.baseline_heading_count = baselinePreview.headings.length;
    await writeEvidence(path.join(artifactDir, "mapping"), "current-preview-origins.json", {
      previewUrl: baselinePreview.url,
      headings: baselinePreview.headings,
      items: currentItems,
    });

    const auth = await obtainAuthorization(editor.page, baseConfig, target, pageState);
    pageState.site_setting_id = auth.siteSettingId;
    const scenarioTarget = baseConfig.pageConfirmation?.useAllCapturedItems
      ? { ...target, pageConfirmationUseAllCapturedItems: true, retrySkipItems: pageState.retry_skip_items ?? [] }
      : retryScenarioTarget(target, pageState);
    const scenarios = scenarioMap(scenarioTarget, captured.items, []);
    if (scenarios.size === 0) throw new Error("mapping_ambiguous: 当前页面没有唯一匹配到任何目标H设置项");
    const targetValidateItems = [...scenarios.keys()].map((index) => captured.items[index]).filter(Boolean);
    pageState.target_match_count = targetValidateItems.length;
    const validatePayload = { siteSettingId: auth.siteSettingId, pageUrl: target.pageUrl, items: targetValidateItems };
    const validation = await validateHeadings(editor.page, baseConfig, pageState, validatePayload, auth.authorization);
    const validate = validation.batch;
    const validateItems = validation.items;
    pageState.batch_validate_status = validation.batchStatus;
    pageState.individual_validate_passed = validation.individualPassed;
    pageState.individual_validate_failed = validation.individualFailed;
    const updateItems = [];
    const builds = new Map();
    for (const [index, scenario] of scenarios) {
      const capturedItem = captured.items[index];
      if (!capturedItem) continue;
      const built = buildScenarioTarget(capturedItem, scenario, state.run_id, index + 1);
      const source = (target.allowedSources ?? []).find((entry) => sourceMatchesItem(entry, capturedItem));
      builds.set(index, { scenario, built, source });
      const capability = validateItems.find((item) => item.itemKey === capturedItem.itemKey);
      const needsLevel = ["level_only", "both"].includes(scenario);
      const needsText = ["text_only", "empty_text", "both"].includes(scenario);
      if (baseConfig.pageConfirmation) {
        const targetPayload = { ...built.target };
        const levelEditable = Boolean(capability?.editable && capability.fieldCapabilities?.type === true);
        const textEditable = Boolean(capability?.editable && capability.fieldCapabilities?.text === true);
        if (!levelEditable) delete targetPayload.tagName;
        if (!textEditable) delete targetPayload.text;
        const hasEditableField = Object.keys(targetPayload).length > 0;
        const partialBuilt = {
          ...built,
          target: targetPayload,
          expectedLevel: levelEditable && needsLevel ? built.expectedLevel : normalizeLevel(capturedItem.origin.tagName),
          expectedText: textEditable && needsText ? built.expectedText : normalizeText(capturedItem.origin.text),
        };
        builds.set(index, { scenario, built: partialBuilt, source });
        if (capability?.editable && hasEditableField) updateItems.push({ ...capturedItem, target: targetPayload });
      } else if (capability?.editable && (!needsLevel || capability.fieldCapabilities?.type === true) && (!needsText || capability.fieldCapabilities?.text === true)) {
        updateItems.push({ ...capturedItem, target: built.target });
      }
    }
    pageState.submitted_count = updateItems.length;
    let update = { http: "", body: {}, requestFile: "", responseFile: "" };
    let updateResults = [];
    const itemEvidence = new Map();
    if (updateItems.length > 0) {
      const updatePayload = { siteSettingId: auth.siteSettingId, pageUrl: target.pageUrl, items: updateItems };
      update = await apiCall(editor.page, baseConfig, pageState, "headings-update", "/headings/update", updatePayload, { Authorization: auth.authorization });
      updateResults = update.body?.data?.updateItems ?? [];
      if (baseConfig.pageConfirmation) {
        const initialResults = new Map(updateResults.map((item) => [item.itemKey, item]));
        const retryItems = updateItems.filter((item) => initialResults.get(item.itemKey)?.status !== "UPDATED");
        updateResults = [...updateResults];
        for (const item of retryItems) {
          const singlePayload = { siteSettingId: auth.siteSettingId, pageUrl: target.pageUrl, items: [item] };
          const single = await apiCall(
            editor.page,
            baseConfig,
            pageState,
            `headings-update-${item.itemKey}`,
            "/headings/update",
            singlePayload,
            { Authorization: auth.authorization },
          );
          itemEvidence.set(item.itemKey, { requestFile: single.requestFile, responseFile: single.responseFile });
          const singleResult = single.body?.data?.updateItems?.find((entry) => entry.itemKey === item.itemKey);
          const replacement = singleResult ?? {
            itemKey: item.itemKey,
            status: "FAILED",
            reason: single.body?.errorCode || single.body?.message || `HTTP_${single.http}`,
          };
          const existingIndex = updateResults.findIndex((entry) => entry.itemKey === item.itemKey);
          if (existingIndex >= 0) updateResults[existingIndex] = replacement;
          else updateResults.push(replacement);
        }
      } else if (update.body?.code !== 200) {
        if (updateItems.length > 1) {
          updateResults = [];
          for (const item of updateItems) {
            const singlePayload = { siteSettingId: auth.siteSettingId, pageUrl: target.pageUrl, items: [item] };
            const single = await apiCall(
              editor.page,
              baseConfig,
              pageState,
              `headings-update-${item.itemKey}`,
              "/headings/update",
              singlePayload,
              { Authorization: auth.authorization },
            );
            itemEvidence.set(item.itemKey, { requestFile: single.requestFile, responseFile: single.responseFile });
            const singleResult = single.body?.data?.updateItems?.find((entry) => entry.itemKey === item.itemKey);
            updateResults.push(singleResult ?? {
              itemKey: item.itemKey,
              status: "FAILED",
              reason: single.body?.errorCode || single.body?.message || `HTTP_${single.http}`,
            });
          }
        } else {
          const reason = update.body?.errorCode || update.body?.message || `HTTP_${update.http}`;
          updateResults = updateItems.map((item) => ({ itemKey: item.itemKey, status: "FAILED", reason }));
        }
      }
    }

    pageState.items = [...builds.entries()].map(([index, { scenario, built, source }]) => {
      const capturedItem = captured.items[index];
      const evidence = itemEvidence.get(capturedItem.itemKey);
      const validateEvidence = validation.itemEvidence.get(capturedItem.itemKey) ?? {
        http: validate.http,
        code: validate.body?.code ?? "",
        requestFile: validate.requestFile,
        responseFile: validate.responseFile,
      };
      return createItemState({
        runId: state.run_id, target, captured: capturedItem, control: captured.controls[index],
        validateItem: validateItems.find((item) => item.itemKey === capturedItem.itemKey),
        updateItem: updateResults.find((item) => item.itemKey === capturedItem.itemKey),
        scenario, built, index,
        apiResult: { validateHttp: validateEvidence.http, validateCode: validateEvidence.code, updateHttp: update.http, updateCode: update.body?.code ?? "" },
        requestFile: evidence?.requestFile || update.requestFile, responseFile: evidence?.responseFile || update.responseFile,
        validateEvidence,
        source,
      });
    });

    const hasUpdatedItem = pageState.items.some((item) => ["updated", "updated_partial"].includes(item.api_status));
    if (!hasUpdatedItem) {
      pageState.unsubmitted_status = "not_checked";
      pageState.status = "failed";
      pageState.failure_reason = pageState.items.map((item) => `第${item.item_index}项：${item.failure_reason}`).filter(Boolean).join("；") || "没有成功更新的H设置项";
      return;
    }

    const preview = await openEditorPreview(context, config, target);
    pageState.preview_url = preview.url;
    pageState.preview_heading_count = preview.headings.length;
    await writeEvidence(path.join(artifactDir, "preview"), "preview-headings.json", preview);
    for (const item of pageState.items) {
      if (! ["updated", "updated_partial"].includes(item.api_status)) continue;
      const result = verifyPreviewItem({ ...item._captured, expected_text: item.expected_text, expected_level: item.expected_level }, preview.headings);
      item.preview_status = result.status;
      item.preview_level = result.actualLevel;
      item.preview_text = result.actualText;
      if (result.status !== "verified") {
        item.status = result.status;
        item.failure_reason = result.reason;
      }
    }
    const submittedKeys = new Set(pageState.items.filter((item) => ["updated", "updated_partial"].includes(item.api_status)).map((item) => item.item_key));
    const unsubmitted = verifyUnsubmittedHeadings(captured.items, submittedKeys, preview.headings);
    pageState.unsubmitted_status = unsubmitted.status;
    pageState.unsubmitted_differences = unsubmitted.missing;

    const editorState = { items: pageState.items, editor_backfill_verification: { status: "pending" } };
    await verifyGrowthEngineEditorBackfill({ context, config, state: editorState, persist: async () => {} });
    pageState.editor_backfill_status = editorState.editor_backfill_verification.status;
    for (const item of pageState.items) {
      item.editor_level = item.editor_actual_level;
      item.editor_text = item.editor_actual_text;
      if (["updated", "updated_partial"].includes(item.api_status) && item.preview_status === "verified") {
        if (item.editor_backfill_status === "verified") {
          item.status = item.level_editable && item.text_editable ? "modified_verified" : "partially_editable_verified";
        }
        else {
          item.status = "editor_backfill_mismatch";
          item.failure_reason = item.editor_backfill_failure_reason || `编辑器回填状态：${item.editor_backfill_status}`;
        }
      }
      delete item._captured;
      delete item._control;
    }
    pageState.status = summarizePage(pageState.items, pageState.unsubmitted_status);
    pageState.failure_reason = pageState.status === "complete" ? "" : pageState.items.filter((item) => item.failure_reason).map((item) => `第${item.item_index}项：${item.failure_reason}`).join("；");
  } catch (error) {
    const message = String(error?.message ?? error);
    const statusByError = [
      ["login_expired", /login_expired|未找到增长引擎 iframe|未找到增长引擎/u],
      ["page_not_found", /page_not_found/u],
      ["mapping_ambiguous", /mapping_ambiguous|locator_ambiguous/u],
      ["preview_failed", /preview_/u],
      ["validate_failed", /validate_failed/u],
      ["update_failed", /update_failed|sync_failed/u],
    ];
    pageState.status = statusByError.find(([, pattern]) => pattern.test(message))?.[0] ?? "automation_error";
    pageState.failure_reason = message;
    pageState.screenshot = await editor?.screenshot(`failure-${Date.now()}.png`).catch(() => "");
    throw error;
  } finally {
    pageState.trace = tracePath;
    pageState.checked_at = new Date().toISOString();
    await context.tracing.stop({ path: tracePath }).catch(() => {});
    await context.close().catch(() => {});
  }
}

function createState(config) {
  const runId = numericRunId();
  return {
    version: 1, run_id: runId, phase: "planned", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    note: "调用新接口后增长引擎不回填属于正常逻辑，不参与断言。",
    pages: config.targets.map((target) => ({
      run_id: runId, target_id: target.id, page_name: target.pageName, page_path: target.pagePath,
      page_url: target.pageUrl, status: "pending", captured_count: 0, submitted_count: 0,
      issue_group: target.issueGroup ?? "", batch_validate_status: "pending", individual_validate_passed: 0, individual_validate_failed: 0,
      preview_url: "", preview_heading_count: 0, unsubmitted_status: "pending",
      editor_backfill_status: "pending", failure_reason: "", trace: "", checked_at: "", items: [], api_calls: [],
    })),
  };
}

async function run(config, { resume = false, maxPages = Infinity, taskId = "" } = {}) {
  let state = resume ? await loadState(config) : createState(config);
  if (!state) throw new Error("没有可恢复的3.0新接口H专项状态");
  state.phase = "running";
  await saveState(config, state);
  let processed = 0;
  for (const target of config.targets) {
    if (taskId && target.id !== taskId) continue;
    const pageState = state.pages.find((page) => page.target_id === target.id);
    // Terminal per-page outcomes are safe to skip on resume.  Login expiry is
    // intentionally excluded so the batch stops for re-authentication instead
    // of silently scanning stale pages.
    if (["complete", "failed", "page_not_found", "mapping_ambiguous", "update_failed", "automation_error", "preview_failed"].includes(pageState.status)) continue;
    if (processed >= maxPages) break;
    processed += 1;
    try {
      await processTarget(config, state, target);
    } catch (error) {
      await saveState(config, state);
      if (/login_expired|getGeoAuth|Authorization/u.test(error.message)) {
        state.phase = "blocked_login";
        await saveState(config, state);
        throw error;
      }
    }
    if (Array.isArray(pageState.retry_carried_items) && pageState.retry_carried_items.length > 0) {
      pageState.items = [...pageState.retry_carried_items, ...(pageState.items ?? [])]
        .sort((left, right) => Number(left.item_index ?? 0) - Number(right.item_index ?? 0));
      pageState.submitted_count = pageState.items.filter((item) => item.api_status === "updated").length;
    }
    delete pageState.retry_carried_items;
    delete pageState.retry_skip_items;
    await saveState(config, state);
  }
  const pending = state.pages.filter((page) => page.status === "pending").length;
  state.phase = pending > 0 ? "paused_after_poc" : state.pages.every((page) => page.status === "complete") ? "complete" : "complete_with_failures";
  await saveState(config, state);
  return state;
}

async function prepareRetry(config, state) {
  const retryRunId = numericRunId();
  const backupFile = config.paths.stateFile.replace(/\.json$/u, `.before-retry-${retryRunId}.json`);
  await writeFile(backupFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  let resetCount = 0;
  for (const pageState of state.pages) {
    if (pageState.status === "complete") continue;
    resetCount += 1;
    pageState.attempt_history = [...(pageState.attempt_history ?? []), {
      run_id: pageState.run_id || state.run_id,
      status: pageState.status,
      captured_count: pageState.captured_count,
      submitted_count: pageState.submitted_count,
      failure_reason: pageState.failure_reason,
      checked_at: pageState.checked_at,
      trace: pageState.trace,
    }];
    const carriedItems = (pageState.items ?? []).filter((item) =>
      item.status === "modified_verified"
      || (item.api_status === "updated" && item.preview_status === "verified" && item.editor_backfill_status === "verified"));
    pageState.run_id = retryRunId;
    pageState.status = "pending";
    pageState.captured_count = 0;
    pageState.submitted_count = 0;
    pageState.preview_url = "";
    pageState.preview_heading_count = 0;
    pageState.unsubmitted_status = "pending";
    pageState.editor_backfill_status = "pending";
    pageState.failure_reason = "";
    pageState.screenshot = "";
    pageState.trace = "";
    pageState.checked_at = "";
    pageState.items = [];
    pageState.api_calls = [];
    pageState.retry_carried_items = carriedItems;
    pageState.retry_skip_items = carriedItems;
  }
  state.previous_run_id = state.run_id;
  state.run_id = retryRunId;
  state.phase = "retry_planned";
  state.retry_started_at = new Date().toISOString();
  state.retry_backup_file = backupFile;
  await saveState(config, state);
  return { state, resetCount, backupFile };
}

async function auth(config) {
  const context = await launchGrowthEngineContext(config, { auth: true });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: config.timeouts.navigationMs });
  console.log("已打开登录页，请完成登录后关闭浏览器窗口。");
  await new Promise((resolve) => context.on("close", resolve));
}

async function main() {
  const args = parseArgs(process.argv);
  const config = await loadAgentConfig(args.config);
  if (args.command === "plan") {
    console.log(JSON.stringify({ targets: config.targets.map((target) => ({ id: target.id, page: target.pageName, path: target.pagePath, scope: target.scope, scenarios: target.scenarios })) }, null, 2));
    return;
  }
  if (args.command === "auth") return auth(config);
  if (args.command === "run" || args.command === "resume" || args.command === "retry-failed") {
    if (!args.apply) throw new Error("该命令会调用新接口修改3.0页面，必须显式传入 --apply");
    let state;
    if (args.command === "retry-failed") {
      const current = await loadState(config);
      if (!current) throw new Error("没有可用于重跑的3.0新接口H专项状态");
      const prepared = await prepareRetry(config, current);
      console.log(JSON.stringify({ retry_run_id: prepared.state.run_id, reset_pages: prepared.resetCount, backup: prepared.backupFile }, null, 2));
      state = await run(config, { resume: true, maxPages: args.maxPages, taskId: args.taskId });
    } else {
      state = await run(config, { resume: args.command === "resume", maxPages: args.maxPages, taskId: args.taskId });
    }
    console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, pages: state.pages.map((page) => ({ path: page.page_path, status: page.status, items: page.items.length, reason: page.failure_reason })) }, null, 2));
    return;
  }
  const state = await loadState(config);
  if (!state) throw new Error("尚未生成3.0新接口H专项状态");
  if (args.command === "reverify-editor") {
    await reverifyEditor(config, state, args.taskId);
    console.log(JSON.stringify({ run_id: state.run_id, pages: state.pages.map((page) => ({ path: page.page_path, status: page.status, reason: page.failure_reason })) }, null, 2));
    return;
  }
  if (args.command === "report") {
    const supplementalStates = [];
    for (const file of config.reportSupplementalStateFiles ?? []) {
      try { supplementalStates.push(JSON.parse(await readFile(file, "utf8"))); } catch {}
    }
    await writeOnPageAgentReports(mergeSupplementalRunStates(state, supplementalStates), config.paths.reportsDir);
    console.log(config.paths.reportsDir);
    return;
  }
  if (args.command === "status") {
    console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, pages: state.pages.map((page) => ({ path: page.page_path, status: page.status, captured: page.captured_count, submitted: page.submitted_count, reason: page.failure_reason })) }, null, 2));
    return;
  }
  throw new Error(`未知命令：${args.command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

export { loadAgentConfig, processTarget, prepareRetry, reverifyEditor, run, validateHeadings };
