#!/usr/bin/env node
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchGrowthEngineContext } from "./growth-engine-h-editor.mjs";
import { normalizeLevel, normalizeText, numericRunId } from "./growth-engine-h-core.mjs";
import { readLiveHeadings } from "./onpage-agent-h-v3-live.mjs";
import { verifyLiveItem, verifyUntouchedHeadings } from "./onpage-agent-h-live-core.mjs";
import {
  buildDetailsLoadRequests,
  buildDetailsUpdatePayload,
  detailTypeForPageType,
  isDetailsUpdateSuccess,
  makeDetailText,
  mapDetailHeadingsToLive,
  stripDetailSuffix,
  unwrapDetailContent,
  wrapDetailContent,
} from "./onpage-agent-h-live-details-core.mjs";
import { projectRoot } from "./config.mjs";
import { scheduleChromeMinimize } from "./window-utils.mjs";

const DEFAULT_CONFIG = "config/onpage-agent-h-v3-live-details.json";
const COMPLETE_PAGE_STATUSES = new Set(["complete", "complete_with_issues"]);
const FAILURE_ITEM_STATUSES = new Set(["mapping_ambiguous", "details_load_failed", "details_update_failed", "response_mismatch", "live_missing", "live_duplicate", "live_level_mismatch"]);

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
  config.targets = config.targets.map((target) => ({ ...target, pageUrl: new URL(target.pagePath, target.publicBaseUrl || config.publicBaseUrl).toString() }));
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
    mode: "unified_details",
    run_id: runId,
    phase: "planned",
    created_at: now(),
    updated_at: now(),
    site_host: config.siteHost,
    proxy_server: config.proxyServer,
    note: "产品描述、文章正文和产品分类描述使用onpageOpenApi统一详情读写；旧H接口不参与定位或写入；只验证真实页面。",
    pages: config.targets.map((target) => ({
      run_id: runId,
      target_id: target.id,
      page_type: target.pageType,
      detail_type: detailTypeForPageType(target.pageType),
      page_path: target.pagePath,
      page_url: target.pageUrl,
      status: "pending",
      stage: "pending",
      details_load_count: 0,
      editable_detail_count: 0,
      business_heading_count: 0,
      submitted_count: 0,
      live_heading_count: 0,
      untouched_status: "pending",
      items: [],
      details: [],
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

async function getAuthorization(page, config, target, pageState) {
  const response = await apiCall(page, config, pageState, "get-geo-auth", "/getGeoAuth", {
    userId: config.userId,
    domain: target.siteHost || config.siteHost,
    pageUrl: target.pageUrl,
  });
  const data = response.body?.data;
  if (response.http !== 200 || response.body?.code !== 200 || !data?.authorization || !data?.siteSettingId) {
    throw new Error(`login_expired: getGeoAuth失败，HTTP=${response.http}，code=${response.body?.code ?? "空"}`);
  }
  pageState.site_setting_id = data.siteSettingId;
  return data;
}

async function transformHtml(page, html, { runId, startIndex }) {
  return page.evaluate(({ html, runId, startIndex }) => {
    const normalize = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
    const strip = (value) => {
      let text = normalize(value);
      const pattern = /｜新接口详情验证批次\d+第\d+项$/u;
      while (pattern.test(text)) text = text.replace(pattern, "").trim();
      return text;
    };
    const document = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    const headings = [...document.body.querySelectorAll("h1,h2,h3,h4,h5,h6")];
    const items = headings.map((element, offset) => {
      const itemIndex = startIndex + offset;
      const originalLevel = element.tagName.toUpperCase();
      const originalText = normalize(element.textContent);
      const expectedLevel = `H${(Number(originalLevel.slice(1)) % 6) + 1}`;
      const baseText = strip(originalText) || `空标题第${String(itemIndex).padStart(2, "0")}项`;
      const suffix = `｜新接口详情验证批次${runId}第${String(itemIndex).padStart(2, "0")}项`;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      const lastText = textNodes.at(-1);
      if (lastText) lastText.nodeValue = String(lastText.nodeValue ?? "").replace(/｜新接口详情验证批次\d+第\d+项\s*$/u, "");
      element.append(document.createTextNode(suffix));
      const replacement = document.createElement(expectedLevel.toLowerCase());
      for (const attribute of [...element.attributes]) replacement.setAttribute(attribute.name, attribute.value);
      while (element.firstChild) replacement.append(element.firstChild);
      element.replaceWith(replacement);
      return { itemIndex, originalLevel, originalText, expectedLevel, expectedText: `${baseText}${suffix}` };
    });
    return { html: document.body.innerHTML, items };
  }, { html, runId, startIndex });
}

function makeItemRow(pageState, detailState, transformed, mapping) {
  return {
    run_id: pageState.run_id,
    page_type: pageState.page_type,
    detail_type: pageState.detail_type,
    page_path: pageState.page_path,
    page_url: pageState.page_url,
    detail_slot: detailState.slot,
    resource_id: detailState.resource_id,
    item_index: transformed.itemIndex,
    original_level: normalizeLevel(transformed.originalLevel),
    original_text: normalizeText(transformed.originalText),
    expected_level: normalizeLevel(transformed.expectedLevel),
    expected_text: transformed.expectedText,
    live_heading_index: mapping.liveIndex,
    mapping_source: mapping.mappingSource,
    mapping_status: mapping.mappingStatus,
    level_editable: detailState.editable,
    text_editable: detailState.editable,
    load_status: detailState.load_status,
    update_status: "not_submitted",
    live_level: "",
    live_text: "",
    live_match_count: 0,
    status: mapping.mappingStatus === "mapped" ? "update_pending" : "mapping_ambiguous",
    failure_reason: mapping.mappingStatus === "mapped" ? "" : "详情HTML中的H无法唯一映射到真实页面业务H",
    request_evidence: "",
    response_evidence: "",
    checked_at: now(),
  };
}

function classifyRuntimeError(error) {
  const message = String(error?.message ?? error);
  if (/ERR_PROXY|ERR_TUNNEL|代理|proxy/iu.test(message)) return "proxy_unavailable";
  if (/login_expired|getGeoAuth|Authorization/iu.test(message)) return "login_expired";
  if (/page_not_found/iu.test(message)) return "page_not_found";
  if (/details_load_failed/iu.test(message)) return "details_load_failed";
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
      const submitted = pageState.items.filter((item) => item.update_status === "UPDATED");
      if (submitted.every((item) => verifyLiveItem(item, last.headings).status === "verified")) break;
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
      item.status = result.status === "verified" ? "modified_verified" : result.status;
      item.failure_reason = result.reason;
      item.checked_at = now();
    }
    const untouched = verifyUntouchedHeadings(baselineHeadings, submittedIndexes, last.headings);
    pageState.untouched_status = untouched.status;
    pageState.untouched_differences = untouched.missing;
    await writeEvidence(path.join(config.paths.artifactsDir, pageState.target_id, "live"), "live-headings-final.json", last);
    if (pageState.items.some((item) => /^live_/u.test(item.status))) {
      pageState.screenshot = path.join(config.paths.artifactsDir, pageState.target_id, "live", "live-failure.png");
      await mkdir(path.dirname(pageState.screenshot), { recursive: true });
      await page.screenshot({ path: pageState.screenshot, fullPage: true }).catch(() => { pageState.screenshot = ""; });
    }
  } finally {
    await page.close().catch(() => {});
  }
}

function summarizePage(pageState) {
  if (pageState.items.length === 0) return pageState.details.some((detail) => detail.load_status === "not_editable") ? "complete_with_issues" : "no_h_detected";
  if (pageState.items.some((item) => FAILURE_ITEM_STATUSES.has(item.status)) || pageState.untouched_status !== "verified") return "failed";
  if (pageState.details.some((detail) => detail.load_status === "not_editable")) return "complete_with_issues";
  return "complete";
}

async function processTarget(config, state, target, persist) {
  const pageState = state.pages.find((page) => page.target_id === target.id);
  const artifactDir = path.join(config.paths.artifactsDir, target.id);
  await mkdir(artifactDir, { recursive: true });
  const tracePath = path.join(artifactDir, `trace-${state.run_id}.zip`);
  const context = await launchGrowthEngineContext(config);
  scheduleChromeMinimize();
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const apiPage = context.pages()[0] ?? await context.newPage();
  let baseline;
  try {
    pageState.status = "running";
    pageState.stage = "baseline";
    pageState.failure_reason = "";
    pageState.api_calls = [];
    pageState.items = [];
    pageState.details = [];
    await persist();
    await apiPage.goto(config.growthEngineUrl, { waitUntil: "domcontentloaded", timeout: config.timeouts.navigationMs });
    const livePage = await context.newPage();
    try { baseline = await readLiveHeadings(livePage, target, config); } finally { await livePage.close().catch(() => {}); }
    pageState.baseline_http_status = baseline.httpStatus;
    pageState.baseline_heading_count = baseline.headings.length;
    const businessHeadings = baseline.headings.filter((heading) => heading.business);
    pageState.business_heading_count = businessHeadings.length;
    await writeEvidence(path.join(artifactDir, "mapping"), "live-baseline-headings.json", baseline);

    const auth = await getAuthorization(apiPage, config, target, pageState);
    const loadRequests = buildDetailsLoadRequests(target);
    let globalItemIndex = 1;
    for (const request of loadRequests) {
      const slot = request.type === "PRODUCT" ? request.index : 0;
      const loadPayload = { siteSettingId: auth.siteSettingId, pageUrl: target.pageUrl, ...request };
      const load = await apiCall(apiPage, config, pageState, `details-load-${request.type.toLowerCase()}-${slot}`, "/details/load", loadPayload, auth.authorization);
      pageState.details_load_count += 1;
      const data = load.body?.data ?? {};
      const rawContent = request.type === "PRODUCT" ? data.content : (data.detail ?? data.content);
      const unwrapped = unwrapDetailContent(rawContent);
      const detailState = {
        detail_type: request.type,
        slot,
        resource_id: data.resourceId ?? data.productId ?? "",
        editor_type: data.editorType ?? "",
        editable: data.editable === true,
        version: data.version ?? "",
        content_hash: data.contentHash ?? "",
        heading_count: 0,
        load_status: "loaded",
        update_status: "not_submitted",
        failure_reason: "",
        request_evidence: load.requestFile,
        response_evidence: load.responseFile,
      };
      pageState.details.push(detailState);
      if (load.http !== 200 || load.body?.code !== 200) {
        detailState.load_status = "details_load_failed";
        detailState.failure_reason = load.body?.message || `HTTP_${load.http}`;
        continue;
      }
      if (typeof rawContent !== "string") {
        detailState.load_status = "details_load_failed";
        detailState.failure_reason = "load响应缺少content/detail字符串";
        continue;
      }
      if (!data.editable) {
        detailState.load_status = "not_editable";
        detailState.failure_reason = data.reason || "统一详情读取明确返回editable=false";
        continue;
      }
      pageState.editable_detail_count += 1;
      const transformed = await transformHtml(apiPage, unwrapped.html, { runId: state.run_id, startIndex: globalItemIndex });
      detailState.heading_count = transformed.items.length;
      if (transformed.items.length === 0) {
        detailState.load_status = "no_h_detected";
        continue;
      }
      const mappings = mapDetailHeadingsToLive(transformed.items.map((item) => ({ level: item.originalLevel, text: item.originalText })), businessHeadings);
      const rows = transformed.items.map((item, index) => makeItemRow(pageState, detailState, item, mappings[index]));
      pageState.items.push(...rows);
      globalItemIndex += transformed.items.length;
      if (mappings.some((mapping) => mapping.mappingStatus !== "mapped")) {
        detailState.update_status = "not_submitted_mapping_ambiguous";
        detailState.failure_reason = "详情中的H无法全部唯一映射到真实页面，整段内容禁止写入";
        continue;
      }
      const updatedRaw = wrapDetailContent(transformed.html, unwrapped.wrapper);
      const updatePayload = buildDetailsUpdatePayload({
        siteSettingId: auth.siteSettingId,
        pageUrl: target.pageUrl,
        type: request.type,
        loadRequest: request,
        data,
        content: updatedRaw,
      });
      const updateStage = `details-update-${request.type.toLowerCase()}-${slot}`;
      const update = await apiCall(apiPage, config, pageState, updateStage, "/details/update", updatePayload, auth.authorization);
      const success = isDetailsUpdateSuccess(update.http, update.body);
      detailState.update_status = success ? "UPDATED" : "details_update_failed";
      detailState.failure_reason = success ? "" : (update.body?.data?.reason || update.body?.message || `HTTP_${update.http}`);
      for (const row of rows) {
        row.update_status = detailState.update_status;
        row.request_evidence = update.requestFile;
        row.response_evidence = update.responseFile;
        row.status = success ? "updated_pending_live" : "details_update_failed";
        row.failure_reason = detailState.failure_reason;
      }
      if (success) pageState.submitted_count += rows.length;
      await persist();
    }
    if (pageState.details.some((detail) => detail.load_status === "details_load_failed")) {
      throw new Error("details_load_failed: 至少一个统一详情读取请求失败");
    }
    if (pageState.items.length === 0) {
      pageState.status = pageState.details.some((detail) => detail.load_status === "not_editable") ? "complete_with_issues" : "no_h_detected";
      pageState.stage = "finished";
      return;
    }
    pageState.stage = "live_verification";
    await persist();
    await pollLive(context, target, config, pageState, baseline.headings);
    pageState.status = summarizePage(pageState);
    pageState.stage = "finished";
    pageState.failure_reason = pageState.status === "complete" ? "" : [
      ...pageState.details.filter((detail) => detail.failure_reason).map((detail) => `${detail.detail_type}槽位${detail.slot}：${detail.failure_reason}`),
      ...pageState.items.filter((item) => item.failure_reason).map((item) => `第${item.item_index}项：${item.failure_reason}`),
    ].join("；");
  } catch (error) {
    pageState.status = classifyRuntimeError(error);
    pageState.stage = "failed";
    pageState.failure_reason = String(error?.message ?? error);
    pageState.screenshot = path.join(artifactDir, `failure-${Date.now()}.png`);
    await apiPage.screenshot({ path: pageState.screenshot, fullPage: true }).catch(() => { pageState.screenshot = ""; });
    throw error;
  } finally {
    pageState.checked_at = now();
    pageState.trace = tracePath;
    await context.tracing.stop({ path: tracePath }).catch(() => {});
    await context.close().catch(() => {});
    if (pageState.status === "complete") {
      await unlink(tracePath).catch(() => {});
      pageState.trace = "";
    }
  }
}

const PAGE_COLUMNS = ["run_id", "page_type", "detail_type", "page_path", "page_url", "status", "stage", "details_load_count", "editable_detail_count", "business_heading_count", "submitted_count", "live_heading_count", "untouched_status", "failure_reason", "screenshot", "trace", "checked_at"];
const ITEM_COLUMNS = ["run_id", "page_type", "detail_type", "page_path", "page_url", "detail_slot", "resource_id", "item_index", "original_level", "original_text", "expected_level", "expected_text", "live_heading_index", "mapping_source", "mapping_status", "level_editable", "text_editable", "load_status", "update_status", "live_level", "live_text", "live_match_count", "status", "failure_reason", "request_evidence", "response_evidence", "checked_at"];
const API_COLUMNS = ["run_id", "page_path", "stage", "method", "url", "http_status", "business_code", "duration_ms", "request_json", "response_json", "request_file", "response_file", "checked_at"];

async function writeReports(config, state) {
  await mkdir(config.paths.reportsDir, { recursive: true });
  const pages = state.pages;
  const items = pages.flatMap((page) => page.items ?? []);
  const calls = pages.flatMap((page) => page.api_calls ?? []);
  const readonly = pages.flatMap((page) => (page.details ?? []).filter((detail) => detail.load_status === "not_editable").map((detail) => ({ ...detail, page_path: page.page_path, page_url: page.page_url, page_type: page.page_type })));
  const liveFailures = items.filter((item) => /^live_/u.test(item.status));
  const failures = items.filter((item) => FAILURE_ITEM_STATUSES.has(item.status));
  const summary = {
    run_id: state.run_id,
    phase: state.phase,
    page_count: pages.length,
    completed_pages: pages.filter((page) => COMPLETE_PAGE_STATUSES.has(page.status)).length,
    failed_pages: pages.filter((page) => !["pending", ...COMPLETE_PAGE_STATUSES].includes(page.status)).length,
    detail_items: items.length,
    verified_items: items.filter((item) => item.status === "modified_verified").length,
    readonly_details: readonly.length,
    live_failures: liveFailures.length,
    updated_at: state.updated_at,
  };
  const htmlRows = pages.map((page) => `<tr><td>${escapeHtml(page.page_type)}</td><td><a href="${escapeHtml(page.page_url)}">${escapeHtml(page.page_path)}</a></td><td>${escapeHtml(page.status)}</td><td>${escapeHtml(page.business_heading_count)}</td><td>${escapeHtml(page.submitted_count)}</td><td>${escapeHtml(page.failure_reason)}</td></tr>`).join("");
  await Promise.all([
    writeFile(path.join(config.paths.reportsDir, "3.0统一详情H真实页-页面结果.csv"), csv(pages, PAGE_COLUMNS), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0统一详情H真实页-H设置项明细.csv"), csv(items, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0统一详情H真实页-不可编辑清单.csv"), csv(readonly, ["page_type", "page_path", "page_url", "detail_type", "slot", "resource_id", "editor_type", "editable", "load_status", "failure_reason", "request_evidence", "response_evidence"]), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0统一详情H真实页-真实页面异常.csv"), csv(liveFailures, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0统一详情H真实页-失败清单.csv"), csv(failures, ITEM_COLUMNS), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0统一详情H真实页-请求响应明细.csv"), csv(calls, API_COLUMNS), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0统一详情H真实页-运行状态.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0统一详情H真实页-核查报告.html"), `<!doctype html><meta charset="utf-8"><title>3.0统一详情H真实页面验证</title><style>body{font:14px/1.5 system-ui;margin:28px;color:#172033}table{border-collapse:collapse;width:100%}th,td{padding:8px;border-bottom:1px solid #dfe5ef;text-align:left;vertical-align:top}th{background:#153e75;color:white}.cards{display:flex;gap:12px}.card{background:#edf4ff;padding:12px 18px;border-radius:8px}</style><h1>3.0统一详情H真实页面验证</h1><p>批次：${escapeHtml(state.run_id)}；阶段：${escapeHtml(state.phase)}</p><div class="cards"><div class="card">完成页面：${summary.completed_pages}/${summary.page_count}</div><div class="card">验证成功H：${summary.verified_items}</div><div class="card">不可编辑详情：${summary.readonly_details}</div><div class="card">真实页异常：${summary.live_failures}</div></div><h2>页面结果</h2><table><tr><th>类型</th><th>页面</th><th>状态</th><th>业务H</th><th>提交</th><th>原因</th></tr>${htmlRows}</table>`, "utf8"),
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
  if (!state) throw new Error("没有可恢复的3.0统一详情H真实页面任务状态");
  state.phase = "running";
  await saveState(config, state);
  let processed = 0;
  for (const target of config.targets) {
    if (taskId && target.id !== taskId) continue;
    const pageState = state.pages.find((page) => page.target_id === target.id);
    if (COMPLETE_PAGE_STATUSES.has(pageState.status)) continue;
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
  state.phase = pending > 0 ? "paused_after_poc" : state.pages.every((page) => COMPLETE_PAGE_STATUSES.has(page.status)) ? "complete" : "complete_with_failures";
  await saveState(config, state);
  return state;
}

async function auth(config) {
  const context = await launchGrowthEngineContext(config, { auth: true });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: config.timeouts.navigationMs });
  console.log("已打开统一详情任务登录窗口。登录目标账号后进入增长引擎，完成后关闭浏览器窗口。");
  await new Promise((resolve) => context.on("close", resolve));
}

async function main() {
  const args = parseArgs(process.argv);
  const config = await loadConfig(args.config);
  if (args.command === "plan") {
    console.log(JSON.stringify({ mode: "unified_details", siteHost: config.siteHost, proxy: config.proxyServer, targets: config.targets.map((target) => ({ id: target.id, type: target.pageType, detailType: detailTypeForPageType(target.pageType), path: target.pagePath, url: target.pageUrl })) }, null, 2));
    return;
  }
  if (args.command === "auth") return auth(config);
  if (["run", "resume"].includes(args.command)) {
    if (!args.apply) throw new Error("该命令会调用统一详情新接口修改真实页面H标签，必须显式传入 --apply");
    const state = await run(config, { resume: args.command === "resume", maxPages: args.maxPages, taskId: args.taskId });
    console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, pages: state.pages.map((page) => ({ path: page.page_path, status: page.status, business: page.business_heading_count, submitted: page.submitted_count, reason: page.failure_reason })) }, null, 2));
    return;
  }
  const state = await loadState(config);
  if (!state) throw new Error("尚未生成3.0统一详情H真实页面任务状态");
  if (args.command === "report") {
    console.log(JSON.stringify(await writeReports(config, state), null, 2));
    return;
  }
  if (args.command === "status") {
    console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, pages: state.pages.map((page) => ({ path: page.page_path, status: page.status, stage: page.stage, loads: page.details_load_count, business: page.business_heading_count, submitted: page.submitted_count, reason: page.failure_reason })) }, null, 2));
    return;
  }
  throw new Error(`未知命令：${args.command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

export { createState, loadConfig, processTarget, run, writeReports };
