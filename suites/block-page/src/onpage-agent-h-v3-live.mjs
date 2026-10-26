#!/usr/bin/env node
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GrowthEngineHPage, launchGrowthEngineContext } from "./growth-engine-h-editor.mjs";
import { normalizeLevel, normalizeText, numericRunId } from "./growth-engine-h-core.mjs";
import { validateCapturedHeadingPayload } from "./onpage-agent-h-core.mjs";
import {
  buildEditableTarget,
  mapCapturedItemsToLive,
  verifyLiveItem,
  verifyUntouchedHeadings,
} from "./onpage-agent-h-live-core.mjs";
import { projectRoot } from "./config.mjs";
import { scheduleChromeMinimize } from "./window-utils.mjs";

const DEFAULT_CONFIG = "config/onpage-agent-h-v3-live-pages.json";
const SUCCESS_ITEM_STATUSES = new Set(["modified_verified", "partially_editable_verified", "field_not_editable", "excluded_shared_heading"]);

function resolveProjectPath(value) { return path.isAbsolute(value) ? value : path.resolve(projectRoot, value); }
function now() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function csvCell(value) { const text = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? ""); return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function csv(rows, columns) { return `${[columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n")}\r\n`; }
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

export function parseArgs(argv) {
  const result = { command: argv[2] ?? "status", apply: false, config: DEFAULT_CONFIG, maxPages: Infinity, taskId: "" };
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] === "--apply") result.apply = true;
    else if (argv[index] === "--config") result.config = argv[++index];
    else if (argv[index] === "--max-pages") result.maxPages = Number(argv[++index]);
    else if (argv[index] === "--task-id") result.taskId = argv[++index];
  }
  return result;
}

async function loadConfig(configPath = DEFAULT_CONFIG) {
  const config = JSON.parse(await readFile(resolveProjectPath(configPath), "utf8"));
  for (const key of ["userDataDir", "stateFile", "artifactsDir", "reportsDir"]) config.paths[key] = resolveProjectPath(config.paths[key]);
  config.targets = config.targets.map((target) => ({
    ...target,
    pageUrl: new URL(target.pagePath, config.publicBaseUrl).toString(),
  }));
  return config;
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

async function loadState(config) { try { return JSON.parse(await readFile(config.paths.stateFile, "utf8")); } catch { return null; } }

function createState(config) {
  const runId = numericRunId();
  return {
    version: 1,
    run_id: runId,
    phase: "planned",
    created_at: now(),
    updated_at: now(),
    site_host: config.siteHost,
    proxy_server: config.proxyServer,
    note: "旧接口仅只读捕获定位参数；所有校验和写入使用onpageOpenApi；只验证真实页面，不检查预览或编辑器回填。",
    pages: config.targets.map((target) => ({
      run_id: runId,
      target_id: target.id,
      page_type: target.pageType,
      page_path: target.pagePath,
      page_url: target.pageUrl,
      status: "pending",
      stage: "pending",
      captured_count: 0,
      business_heading_count: 0,
      submitted_count: 0,
      live_heading_count: 0,
      untouched_status: "pending",
      items: [],
      api_calls: [],
      failure_reason: "",
      screenshot: "",
      trace: "",
      checked_at: "",
    })),
  };
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /authorization|editorToken|token|cookie/iu.test(key) ? "[REDACTED]" : redact(item),
  ]));
}

async function writeEvidence(directory, name, value) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, name);
  await writeFile(file, `${JSON.stringify(redact(value), null, 2)}\n`, "utf8");
  return file;
}

async function apiCall(browserPage, config, pageState, stage, route, payload, authorization = "") {
  const directory = path.join(config.paths.artifactsDir, pageState.target_id, "api");
  const requestFile = await writeEvidence(directory, `${stage}-request.json`, payload);
  const started = Date.now();
  const endpoint = `${config.apiBaseUrl}${route}`;
  let result;
  try {
    result = await browserPage.evaluate(async ({ url, body, token }) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) },
        credentials: "include",
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    }, { url: endpoint, body: payload, token: authorization });
  } catch (error) {
    result = { status: 0, text: String(error?.message ?? error) };
  }
  let body;
  try { body = JSON.parse(result.text); } catch { body = { raw: result.text }; }
  const responseFile = await writeEvidence(directory, `${stage}-response.json`, body);
  pageState.api_calls.push({
    run_id: pageState.run_id,
    page_path: pageState.page_path,
    stage,
    method: "POST",
    url: endpoint,
    http_status: result.status,
    business_code: body?.code ?? "",
    duration_ms: Date.now() - started,
    request_json: JSON.stringify(redact(payload)),
    response_json: JSON.stringify(redact(body)),
    request_file: requestFile,
    response_file: responseFile,
    checked_at: now(),
  });
  return { http: result.status, body, requestFile, responseFile };
}

async function captureCurrentItems(editor) {
  const requestPromise = editor.page.waitForRequest(
    (request) => request.method() === "POST" && /\/onpage\/element\/headings\/validate(?:\?|$)/u.test(request.url()),
    { timeout: editor.config.timeouts.syncMs },
  );
  requestPromise.catch(() => {});
  let dialog;
  try {
    dialog = await editor.openEditDialog();
    const request = await requestPromise;
    const payload = request.postDataJSON();
    const controls = await editor.inspectDialog(dialog);
    const items = validateCapturedHeadingPayload(payload);
    // The old preflight intentionally sends only headings for which it can
    // build a locator.  The dialog can therefore contain more read-only rows
    // than the request payload.  Preserve both counts as evidence instead of
    // pretending the extra rows have safe update parameters.
    return { items, controls, oldRequestUrl: request.url() };
  } finally {
    await requestPromise.catch(() => {});
    if (dialog) await editor.cancelDialog(dialog).catch(() => {});
  }
}

function pageConfig(config, target, artifactDir) {
  return {
    ...config,
    targetPagePath: target.pagePath,
    pagePathCandidates: [target.pagePath],
    publicUrl: target.pageUrl,
    growthEngineSite: { host: config.siteHost },
    refreshBeforeEdit: false,
    refreshButtonOptional: true,
    paths: { ...config.paths, artifactsDir: artifactDir },
  };
}

async function readLiveHeadings(page, target, config) {
  const url = new URL(target.pageUrl);
  url.searchParams.set("onpage_h_run", String(Date.now()));
  const response = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: config.timeouts.navigationMs });
  await page.waitForTimeout(config.timeouts.liveRenderMs);
  const body = normalizeText(await page.locator("body").innerText().catch(() => ""));
  if (!response || !response.ok()) throw new Error(`live_http_failed: 真实页面HTTP=${response?.status() ?? 0}`);
  if (/404|page\s+not\s+found|页面不存在/iu.test(body.slice(0, 500))) throw new Error("page_not_found: 真实页面返回不存在页面");
  const headings = await page.locator("h1,h2,h3,h4,h5,h6").evaluateAll((elements, businessSelector) => elements.map((element, index) => {
    const ids = new Set();
    let current = element;
    for (let depth = 0; depth < 12 && current; depth += 1, current = current.parentElement) {
      for (const name of ["id", "settingid", "data-settingid", "data-block-id", "data-blockid", "block-id", "data-module-id", "data-component-id", "data-app-id"]) {
        const value = current.getAttribute?.(name);
        if (value) ids.add(String(value).replace(/^component_/u, ""));
      }
    }
    return {
      index,
      level: element.tagName.toUpperCase(),
      text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
      containerIds: [...ids],
      business: element.matches(businessSelector),
    };
  }), target.businessSelector);
  return { url: page.url(), httpStatus: response.status(), headings };
}

function updateResultMap(response) {
  const results = response?.body?.data?.updateItems;
  return new Map((Array.isArray(results) ? results : []).map((item) => [item.itemKey, item]));
}

function itemRow(pageState, mapped, itemIndex) {
  const item = mapped.captured;
  return {
    run_id: pageState.run_id,
    page_type: pageState.page_type,
    page_path: pageState.page_path,
    page_url: pageState.page_url,
    item_index: itemIndex + 1,
    item_key: item.itemKey ?? `unmapped-live-${itemIndex}`,
    setting_id: item.settingId ?? "",
    node_id: item.nodeId ?? "",
    template_id: item.templateId ?? "",
    position: item.index ?? "",
    original_level: normalizeLevel(item.origin?.tagName),
    original_text: normalizeText(item.origin?.text),
    expected_level: normalizeLevel(item.origin?.tagName),
    expected_text: normalizeText(item.origin?.text),
    live_level: "",
    live_text: "",
    live_match_count: 0,
    level_editable: false,
    text_editable: false,
    mapping_source: mapped.mappingSource,
    live_heading_index: mapped.headingIndex,
    content_scope: mapped.heading?.business ? "business" : "shared_or_non_business",
    validate_status: "pending",
    update_status: "not_submitted",
    status: mapped.mappingStatus === "mapped" ? "pending" : "mapping_ambiguous",
    failure_reason: mapped.mappingStatus === "mapped" ? "" : "无法与真实页面H唯一对应",
    request_evidence: "",
    response_evidence: "",
    checked_at: now(),
  };
}

async function getAuthorization(page, config, target, pageState) {
  const response = await apiCall(page, config, pageState, "get-geo-auth", "/getGeoAuth", {
    userId: config.userId,
    domain: config.siteHost,
    pageUrl: target.pageUrl,
  });
  const data = response.body?.data;
  if (response.http !== 200 || response.body?.code !== 200 || !data?.authorization || !data?.siteSettingId) {
    throw new Error(`login_expired: getGeoAuth失败，HTTP=${response.http}，code=${response.body?.code ?? "空"}`);
  }
  pageState.site_setting_id = data.siteSettingId;
  return data;
}

function classifyRuntimeError(error) {
  const message = String(error?.message ?? error);
  if (/ERR_PROXY|ERR_TUNNEL|代理|proxy/iu.test(message)) return "proxy_unavailable";
  if (/login_expired|getGeoAuth|Authorization/iu.test(message)) return "login_expired";
  if (/page_not_found/iu.test(message)) return "page_not_found";
  if (/site_not_found/iu.test(message)) return "site_not_found";
  if (/locator_ambiguous/iu.test(message)) return "site_ambiguous";
  if (/mapping_ambiguous/iu.test(message)) return "mapping_ambiguous";
  return "automation_error";
}

async function pollLive(context, target, config, pageState, baselineHeadings) {
  const page = await context.newPage();
  const deadline = Date.now() + config.timeouts.liveMs;
  let last = { headings: [], url: target.pageUrl, httpStatus: 0 };
  try {
    while (Date.now() < deadline) {
      last = await readLiveHeadings(page, target, config);
      const updateItems = pageState.items.filter((item) => item.update_status === "UPDATED");
      const results = updateItems.map((item) => ({ item, result: verifyLiveItem(item, last.headings) }));
      if (results.every(({ result }) => result.status === "verified")) break;
      await sleep(config.timeouts.livePollMs);
    }
    pageState.live_heading_count = last.headings.length;
    pageState.live_url = last.url;
    const submittedIndexes = new Set();
    for (const item of pageState.items) {
      if (item.update_status !== "UPDATED") continue;
      submittedIndexes.add(Number(item.live_heading_index));
      const result = verifyLiveItem(item, last.headings);
      item.live_level = result.actualLevel;
      item.live_text = result.actualText;
      item.live_match_count = result.count;
      if (result.status === "verified") {
        item.status = item.level_editable && item.text_editable ? "modified_verified" : "partially_editable_verified";
        item.failure_reason = "";
      } else {
        item.status = result.status;
        item.failure_reason = result.reason;
      }
      item.checked_at = now();
    }
    const untouched = verifyUntouchedHeadings(baselineHeadings, submittedIndexes, last.headings);
    pageState.untouched_status = untouched.status;
    pageState.untouched_differences = untouched.missing;
    await writeEvidence(path.join(config.paths.artifactsDir, pageState.target_id, "live"), "live-headings-final.json", last);
    if (pageState.items.some((item) => ["live_missing", "live_duplicate", "live_level_mismatch"].includes(item.status))) {
      pageState.screenshot = path.join(config.paths.artifactsDir, pageState.target_id, "live", "live-failure.png");
      await mkdir(path.dirname(pageState.screenshot), { recursive: true });
      await page.screenshot({ path: pageState.screenshot, fullPage: true }).catch(() => { pageState.screenshot = ""; });
    }
  } finally {
    await page.close().catch(() => {});
  }
}

function summarizePage(pageState) {
  const substantive = pageState.items.filter((item) => item.content_scope === "business");
  const failures = substantive.filter((item) => !SUCCESS_ITEM_STATUSES.has(item.status));
  const readonly = substantive.filter((item) => item.status === "field_not_editable");
  if (failures.length > 0 || pageState.untouched_status !== "verified") return "failed";
  if (readonly.length > 0) return "complete_with_issues";
  return "complete";
}

async function processTarget(config, state, target, persist) {
  const pageState = state.pages.find((page) => page.target_id === target.id);
  const artifactDir = path.join(config.paths.artifactsDir, target.id);
  const targetConfig = pageConfig(config, target, artifactDir);
  await mkdir(artifactDir, { recursive: true });
  const tracePath = path.join(artifactDir, `trace-${state.run_id}.zip`);
  const context = await launchGrowthEngineContext(targetConfig);
  scheduleChromeMinimize();
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  let ge;
  let baseline;
  try {
    pageState.status = "running";
    pageState.stage = "capturing";
    pageState.failure_reason = "";
    pageState.api_calls = [];
    await persist();
    ge = new GrowthEngineHPage(context, targetConfig);
    await ge.open();
    await ge.waitForScanStable();
    const captured = await captureCurrentItems(ge);
    pageState.captured_count = captured.items.length;
    await writeEvidence(path.join(artifactDir, "mapping"), "captured-old-validate-request.json", {
      requestUrl: captured.oldRequestUrl,
      pageUrl: target.pageUrl,
      items: captured.items,
    });

    const livePage = await context.newPage();
    try { baseline = await readLiveHeadings(livePage, target, config); } finally { await livePage.close().catch(() => {}); }
    pageState.baseline_http_status = baseline.httpStatus;
    pageState.baseline_heading_count = baseline.headings.length;
    pageState.business_heading_count = baseline.headings.filter((heading) => heading.business).length;
    await writeEvidence(path.join(artifactDir, "mapping"), "live-baseline-headings.json", baseline);

    const mapped = mapCapturedItemsToLive(captured.items, baseline.headings);
    pageState.items = mapped.map((entry, index) => itemRow(pageState, entry, index));
    mapped.forEach((entry, index) => {
      if (entry.mappingStatus === "mapped" && !entry.heading.business) {
        pageState.items[index].status = "excluded_shared_heading";
        pageState.items[index].validate_status = "not_applicable";
        pageState.items[index].failure_reason = "公共区域或非业务正文H，不提交修改";
      }
    });
    const mappedHeadingIndexes = new Set(mapped.filter((entry) => entry.mappingStatus === "mapped").map((entry) => entry.headingIndex));
    for (const heading of baseline.headings.filter((entry) => entry.business && !mappedHeadingIndexes.has(entry.index))) {
      pageState.items.push({
        ...itemRow(pageState, { captured: { itemKey: `unmapped-live-${heading.index}`, origin: { tagName: heading.level, text: heading.text } }, mappingStatus: "mapping_ambiguous", mappingSource: "", heading, headingIndex: heading.index }, pageState.items.length),
        content_scope: "business",
        failure_reason: "真实页面业务正文H未出现在旧预检定位参数中",
      });
    }

    const businessMappings = mapped.filter((entry) => entry.mappingStatus === "mapped" && entry.heading.business);
    if (businessMappings.length === 0) throw new Error("mapping_ambiguous: 没有业务正文H能与旧预检参数唯一对应");
    const auth = await getAuthorization(ge.page, config, target, pageState);
    const validatePayload = { siteSettingId: auth.siteSettingId, pageUrl: target.pageUrl, items: businessMappings.map((entry) => entry.captured) };
    const validate = await apiCall(ge.page, config, pageState, "headings-validate", "/headings/validate", validatePayload, auth.authorization);
    if (validate.http !== 200 || validate.body?.code !== 200) throw new Error(`validate_failed: 新接口validate失败，HTTP=${validate.http}，code=${validate.body?.code ?? "空"}`);
    const validateItems = Array.isArray(validate.body?.data?.items) ? validate.body.data.items : [];
    const updateItems = [];
    for (const entry of businessMappings) {
      const row = pageState.items.find((item) => item.item_key === entry.captured.itemKey);
      const capability = validateItems.find((item) => item.itemKey === entry.captured.itemKey);
      if (!capability) {
        row.status = "response_mismatch";
        row.validate_status = "missing_item_result";
        row.failure_reason = "validate响应缺少对应itemKey";
        continue;
      }
      const built = buildEditableTarget(entry.captured, capability, state.run_id, row.item_index);
      row.level_editable = built.levelEditable;
      row.text_editable = built.textEditable;
      row.expected_level = built.expectedLevel;
      row.expected_text = built.expectedText;
      row.validate_status = capability.editable ? "editable" : "not_editable";
      if (!built.levelEditable && !built.textEditable) {
        row.status = "field_not_editable";
        row.failure_reason = capability.reason || "validate明确返回文字和级别均不可编辑";
        continue;
      }
      row.status = "update_pending";
      updateItems.push({ ...entry.captured, target: built.target });
    }
    pageState.submitted_count = updateItems.length;
    let finalResults = new Map();
    if (updateItems.length > 0) {
      const batch = await apiCall(ge.page, config, pageState, "headings-update", "/headings/update", { siteSettingId: auth.siteSettingId, pageUrl: target.pageUrl, items: updateItems }, auth.authorization);
      finalResults = updateResultMap(batch);
      const retryItems = updateItems.filter((item) => finalResults.get(item.itemKey)?.status !== "UPDATED");
      for (const item of retryItems) {
        const single = await apiCall(ge.page, config, pageState, `headings-update-${item.itemKey}`, "/headings/update", { siteSettingId: auth.siteSettingId, pageUrl: target.pageUrl, items: [item] }, auth.authorization);
        const result = updateResultMap(single).get(item.itemKey) ?? { itemKey: item.itemKey, status: "FAILED", reason: single.body?.errorCode || single.body?.message || `HTTP_${single.http}` };
        finalResults.set(item.itemKey, result);
      }
      for (const item of updateItems) {
        const row = pageState.items.find((entry) => entry.item_key === item.itemKey);
        const result = finalResults.get(item.itemKey);
        row.update_status = result?.status ?? "MISSING";
        row.request_evidence = pageState.api_calls.findLast((call) => call.stage === `headings-update-${item.itemKey}` || call.stage === "headings-update")?.request_file ?? "";
        row.response_evidence = pageState.api_calls.findLast((call) => call.stage === `headings-update-${item.itemKey}` || call.stage === "headings-update")?.response_file ?? "";
        if (result?.status === "UPDATED") row.status = "updated_pending_live";
        else {
          row.status = /ORIGIN|MATCH|原值/iu.test(result?.reason ?? "") ? "origin_mismatch" : "update_failed";
          row.failure_reason = result?.reason || "更新响应未返回UPDATED";
        }
      }
    }
    pageState.status = "updated_pending_live";
    pageState.stage = "live_verification";
    await persist();
    await pollLive(context, target, config, pageState, baseline.headings);
    pageState.status = summarizePage(pageState);
    pageState.stage = "finished";
    pageState.failure_reason = pageState.status === "complete" ? "" : pageState.items
      .filter((item) => item.failure_reason && item.status !== "excluded_shared_heading")
      .map((item) => `第${item.item_index}项：${item.failure_reason}`).join("；");
  } catch (error) {
    pageState.status = classifyRuntimeError(error);
    pageState.stage = "failed";
    pageState.failure_reason = String(error?.message ?? error);
    pageState.screenshot = path.join(artifactDir, `failure-${Date.now()}.png`);
    await ge?.page?.screenshot({ path: pageState.screenshot, fullPage: true }).catch(() => { pageState.screenshot = ""; });
    throw error;
  } finally {
    pageState.checked_at = now();
    pageState.trace = tracePath;
    await context.tracing.stop({ path: tracePath }).catch(() => {});
    await context.close().catch(() => {});
    if (["complete"].includes(pageState.status)) {
      await unlink(tracePath).catch(() => {});
      pageState.trace = "";
    }
  }
}

const PAGE_COLUMNS = ["run_id", "page_type", "page_path", "page_url", "status", "stage", "captured_count", "business_heading_count", "submitted_count", "live_heading_count", "untouched_status", "failure_reason", "screenshot", "trace", "checked_at"];
const ITEM_COLUMNS = ["run_id", "page_type", "page_path", "page_url", "item_index", "item_key", "setting_id", "node_id", "template_id", "position", "content_scope", "mapping_source", "original_level", "original_text", "level_editable", "text_editable", "expected_level", "expected_text", "update_status", "live_level", "live_text", "live_match_count", "status", "failure_reason", "request_evidence", "response_evidence", "checked_at"];
const API_COLUMNS = ["run_id", "page_path", "stage", "method", "url", "http_status", "business_code", "duration_ms", "request_json", "response_json", "request_file", "response_file", "checked_at"];

async function writeReports(config, state) {
  await mkdir(config.paths.reportsDir, { recursive: true });
  const pages = state.pages;
  const items = pages.flatMap((page) => page.items ?? []);
  const calls = pages.flatMap((page) => page.api_calls ?? []);
  const readonly = items.filter((item) => item.status === "field_not_editable");
  const liveFailures = items.filter((item) => /^live_/u.test(item.status));
  const excluded = items.filter((item) => item.status === "excluded_shared_heading");
  const summary = {
    run_id: state.run_id,
    phase: state.phase,
    page_count: pages.length,
    completed_pages: pages.filter((page) => ["complete", "complete_with_issues"].includes(page.status)).length,
    failed_pages: pages.filter((page) => !["pending", "complete", "complete_with_issues"].includes(page.status)).length,
    business_items: items.filter((item) => item.content_scope === "business").length,
    verified_items: items.filter((item) => ["modified_verified", "partially_editable_verified"].includes(item.status)).length,
    readonly_items: readonly.length,
    live_failures: liveFailures.length,
    updated_at: state.updated_at,
  };
  const htmlRows = pages.map((page) => `<tr><td>${escapeHtml(page.page_type)}</td><td><a href="${escapeHtml(page.page_url)}">${escapeHtml(page.page_path)}</a></td><td>${escapeHtml(page.status)}</td><td>${escapeHtml(page.business_heading_count)}</td><td>${escapeHtml(page.submitted_count)}</td><td>${escapeHtml(page.failure_reason)}</td></tr>`).join("");
  await Promise.all([
    writeFile(path.join(config.paths.reportsDir, "3.0新接口H真实页-页面结果.csv"), csv(pages, PAGE_COLUMNS), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0新接口H真实页-H设置项明细.csv"), csv(items, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0新接口H真实页-不可编辑清单.csv"), csv(readonly, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0新接口H真实页-真实页面异常.csv"), csv(liveFailures, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0新接口H真实页-请求响应明细.csv"), csv(calls, API_COLUMNS), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0新接口H真实页-排除公共H.csv"), csv(excluded, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0新接口H真实页-运行状态.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0新接口H真实页-核查报告.html"), `<!doctype html><meta charset="utf-8"><title>3.0新接口H真实页面验证</title><style>body{font:14px/1.5 system-ui;margin:28px;color:#172033}table{border-collapse:collapse;width:100%}th,td{padding:8px;border-bottom:1px solid #dfe5ef;text-align:left;vertical-align:top}th{background:#153e75;color:white}.cards{display:flex;gap:12px}.card{background:#edf4ff;padding:12px 18px;border-radius:8px}</style><h1>3.0新接口H真实页面验证</h1><p>批次：${escapeHtml(state.run_id)}；阶段：${escapeHtml(state.phase)}</p><div class="cards"><div class="card">完成页面：${summary.completed_pages}/${summary.page_count}</div><div class="card">验证成功H：${summary.verified_items}</div><div class="card">不可编辑：${summary.readonly_items}</div><div class="card">真实页异常：${summary.live_failures}</div></div><h2>页面结果</h2><table><tr><th>类型</th><th>页面</th><th>状态</th><th>业务H</th><th>提交</th><th>原因</th></tr>${htmlRows}</table>`, "utf8"),
  ]);
  return summary;
}

async function saveState(config, state) {
  state.updated_at = now();
  await atomicJson(config.paths.stateFile, state);
  await writeReports(config, state);
}

async function run(config, { resume = false, maxPages = Infinity, taskId = "" } = {}) {
  const state = resume ? await loadState(config) : createState(config);
  if (!state) throw new Error("没有可恢复的3.0新接口H真实页面任务状态");
  state.phase = "running";
  await saveState(config, state);
  let processed = 0;
  for (const target of config.targets) {
    if (taskId && target.id !== taskId) continue;
    const pageState = state.pages.find((page) => page.target_id === target.id);
    if (["complete", "complete_with_issues", "failed", "page_not_found", "mapping_ambiguous", "site_not_found", "site_ambiguous", "automation_error"].includes(pageState.status)) continue;
    if (processed >= maxPages) break;
    processed += 1;
    try {
      await processTarget(config, state, target, () => saveState(config, state));
    } catch (error) {
      await saveState(config, state);
      if (pageState.status === "login_expired") {
        state.phase = "blocked_login";
        await saveState(config, state);
        throw error;
      }
    }
    await saveState(config, state);
  }
  const pending = state.pages.filter((page) => page.status === "pending").length;
  state.phase = pending > 0 ? "paused_after_poc" : state.pages.every((page) => ["complete", "complete_with_issues"].includes(page.status)) ? "complete" : "complete_with_failures";
  await saveState(config, state);
  return state;
}

async function auth(config) {
  const context = await launchGrowthEngineContext(config, { auth: true });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: config.timeouts.navigationMs });
  console.log("已打开本任务专用登录窗口。请登录目标账号并进入增长引擎，完成后关闭浏览器窗口。");
  await new Promise((resolve) => context.on("close", resolve));
}

async function main() {
  const args = parseArgs(process.argv);
  const config = await loadConfig(args.config);
  if (args.command === "plan") {
    console.log(JSON.stringify({ siteHost: config.siteHost, proxy: config.proxyServer, targets: config.targets.map((target) => ({ id: target.id, type: target.pageType, path: target.pagePath, url: target.pageUrl, businessSelector: target.businessSelector })) }, null, 2));
    return;
  }
  if (args.command === "auth") return auth(config);
  if (["run", "resume"].includes(args.command)) {
    if (!args.apply) throw new Error("该命令会调用新接口修改真实页面H标签，必须显式传入 --apply");
    const state = await run(config, { resume: args.command === "resume", maxPages: args.maxPages, taskId: args.taskId });
    console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, pages: state.pages.map((page) => ({ path: page.page_path, status: page.status, business: page.business_heading_count, submitted: page.submitted_count, reason: page.failure_reason })) }, null, 2));
    return;
  }
  const state = await loadState(config);
  if (!state) throw new Error("尚未生成3.0新接口H真实页面任务状态");
  if (args.command === "report") {
    console.log(JSON.stringify(await writeReports(config, state), null, 2));
    return;
  }
  if (args.command === "status") {
    console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, pages: state.pages.map((page) => ({ path: page.page_path, status: page.status, stage: page.stage, captured: page.captured_count, business: page.business_heading_count, submitted: page.submitted_count, reason: page.failure_reason })) }, null, 2));
    return;
  }
  throw new Error(`未知命令：${args.command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

export { createState, loadConfig, processTarget, readLiveHeadings, run, writeReports };
