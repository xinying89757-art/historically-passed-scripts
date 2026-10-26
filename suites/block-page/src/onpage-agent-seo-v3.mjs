#!/usr/bin/env node
import { chromium } from "playwright";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "./config.mjs";
import { scheduleChromeMinimize } from "./window-utils.mjs";

const API_BASE_SUFFIX = "/onpageOpenApi";
const TEST_PREFIX = "接口结构化数据测试-页面001-批次";

function resolvePath(value) { return path.isAbsolute(value) ? value : path.resolve(projectRoot, value); }

export async function loadSeoConfig(configPath = "config/onpage-agent-seo-v3.json") {
  const config = JSON.parse(await readFile(resolvePath(configPath), "utf8"));
  for (const key of ["userDataDir", "stateFile", "artifactsDir", "reportsDir"]) config.paths[key] = resolvePath(config.paths[key]);
  return config;
}

function timestamp() { return new Date().toISOString(); }
function runId() { return timestamp().replace(/[-:TZ.]/gu, "").slice(0, 14); }
function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function csv(rows, columns) { return `\uFEFF${[columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n")}\r\n`; }
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

export function parseArgs(argv) {
  const result = { command: argv[2] || "status", apply: false, config: "config/onpage-agent-seo-v3.json" };
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === "--apply") result.apply = true;
    else if (argv[i] === "--config") result.config = argv[++i];
  }
  return result;
}

function atomicJson(file, value) {
  return mkdir(path.dirname(file), { recursive: true }).then(async () => {
    const temp = `${file}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temp, file);
  });
}

function unwrapScript(value) {
  if (typeof value !== "string") return value;
  const match = value.trim().match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/iu);
  return match ? match[1].trim() : value.trim();
}

export function parseStructuredData(value) {
  if (value && typeof value === "object") return structuredClone(value);
  if (typeof value !== "string" || !value.trim()) return null;
  try { return JSON.parse(unwrapScript(value)); } catch { return null; }
}

function graphParts(value) {
  if (Array.isArray(value)) return { kind: "array", nodes: structuredClone(value) };
  if (value && Array.isArray(value["@graph"])) return { kind: "graph", nodes: structuredClone(value["@graph"]), envelope: structuredClone(value) };
  if (value && typeof value === "object") return { kind: "single", nodes: [structuredClone(value)] };
  return { kind: "graph", nodes: [] };
}

export function buildStructuredPayload(baselineValue, run) {
  const marker = TEST_PREFIX + run;
  const markerId = "https://example.test/#seo-structure-" + run;
  const parts = graphParts(parseStructuredData(baselineValue));
  if (!parts.nodes.some((node) => node && (node.name === marker || node["@id"] === markerId))) {
    parts.nodes.push({ "@type": "Thing", "@id": markerId, name: marker });
  }
  let output;
  if (parts.kind === "array") output = parts.nodes;
  else if (parts.kind === "graph") output = { ...(parts.envelope || { "@context": "https://schema.org" }), "@graph": parts.nodes };
  else output = { "@context": "https://schema.org", "@graph": parts.nodes };
  return { marker, markerId, value: JSON.stringify(output, null, 2) };
}

function responseData(response) { return response.body?.data ?? response.body ?? {}; }
function responseCode(response) { return response.body?.code ?? null; }
function successfulTransport(response) { return response.http >= 200 && response.http < 300 && responseCode(response) === 200; }
function isSuccess(value) { return ["success", "updated", "ok", "UPDATED", "SUCCESS"].includes(String(value ?? "")); }
function getFieldResults(body) { const data = body?.data ?? {}; return Array.isArray(body?.fieldResults) ? body.fieldResults : Array.isArray(data.fieldResults) ? data.fieldResults : []; }

export function classifyTdkSave(response, fields) {
  if (!successfulTransport(response)) return { status: "tdk_field_failed", reason: `HTTP=${response.http} code=${responseCode(response) ?? "空"}` };
  const results = getFieldResults(response.body);
  if (results.length === 0) return { status: "response_shape_unconfirmed", reason: "响应未提供字段级 fieldResults，未猜测业务成功" };
  const failures = fields.map((field) => {
    const item = results.find((entry) => String(entry.field ?? "").toLowerCase() === field.toLowerCase());
    return item && isSuccess(item.result ?? item.status) ? "" : `${field}:${item?.reason ?? item?.result ?? "缺少成功结果"}`;
  }).filter(Boolean);
  return failures.length ? { status: "tdk_field_failed", reason: failures.join("；") } : { status: "tdk_field_updated", reason: "" };
}

export function classifyStructuredSave(response, marker) {
  if (!successfulTransport(response)) return { status: "structured_data_save_failed", reason: `HTTP=${response.http} code=${responseCode(response) ?? "空"}` };
  const data = responseData(response);
  const valueAfter = data.structureData ?? data.valueAfter ?? data.content ?? data.savedContent;
  const result = data.status ?? data.result ?? data.success ?? response.body?.success;
  if (valueAfter === undefined && (isSuccess(result) || result === true)) return { status: "structured_data_updated", reason: "响应仅返回成功状态，未返回写入后内容" };
  if (valueAfter === undefined) return { status: "response_shape_unconfirmed", reason: "响应未提供可识别的写入后内容或成功字段" };
  if (valueAfter !== undefined && !parseStructuredData(valueAfter)) return { status: "response_mismatch", reason: "响应写入后内容不是合法 JSON-LD" };
  const text = typeof valueAfter === "string" ? valueAfter : JSON.stringify(valueAfter ?? "");
  if (!text.includes(marker)) return { status: "response_mismatch", reason: "响应写入后内容缺少唯一测试标记" };
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if ((text.match(new RegExp(escaped, "gu")) ?? []).length !== 1) return { status: "response_mismatch", reason: "响应写入后唯一测试标记出现次数不为1" };
  return { status: "structured_data_updated", reason: "" };
}

export function classifyInvalidStructuredSave(response) {
  return successfulTransport(response) ? { status: "invalid_payload_accepted", reason: "非法 JSON-LD 未被接口拒绝" } : { status: "invalid_payload_rejected", reason: "接口拒绝非法 JSON-LD" };
}

export async function launch(config, auth = false) {
  await mkdir(config.paths.userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(config.paths.userDataDir, {
    channel: config.browser.channel, headless: auth ? false : config.browser.headless,
    slowMo: auth ? 0 : config.browser.slowMo, locale: config.browser.locale, viewport: null,
    args: config.browser.startMinimized ? ["--start-minimized"] : [],
    ...(config.proxyServer ? { proxy: { server: config.proxyServer } } : {}),
  });
  scheduleChromeMinimize();
  return context;
}

export async function apiCall(page, config, state, stage, route, payload, authorization = "") {
  const dir = path.join(config.paths.artifactsDir, state.target_id, "api");
  await mkdir(dir, { recursive: true });
  const requestFile = path.join(dir, `${stage}-request.json`);
  const responseFile = path.join(dir, `${stage}-response.json`);
  await writeFile(requestFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const started = Date.now();
  let result;
  try {
    result = await page.evaluate(async ({ endpoint, body, token }) => {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) }, credentials: "include", body: JSON.stringify(body) });
      return { status: response.status, text: await response.text() };
    }, { endpoint: config.apiBaseUrl + route, body: payload, token: authorization });
  } catch (error) { result = { status: 0, text: String(error?.message ?? error) }; }
  let body;
  try { body = JSON.parse(result.text); } catch { body = { raw: result.text }; }
  await writeFile(responseFile, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  state.api_calls.push({ stage, method: "POST", url: config.apiBaseUrl + route, http_status: result.status, business_code: body?.code ?? "", request_file: requestFile, response_file: responseFile, duration_ms: Date.now() - started, checked_at: timestamp() });
  return { http: result.status, body, requestFile, responseFile };
}

function createState(config) {
  const target = config.targets[0];
  return { version: 1, run_id: runId(), phase: "planned", created_at: timestamp(), updated_at: timestamp(), note: "只验证接口请求与响应；不访问预览、不进入编辑器；增长引擎不回填不计失败。", target_id: target.id, page_name: target.pageName, page_path: target.pagePath, page_url: target.pageUrl, site_setting_id: "", api_calls: [], results: [], failure_reason: "" };
}

async function loadState(config) { try { return JSON.parse(await readFile(config.paths.stateFile, "utf8")); } catch { return null; } }
async function saveState(config, state) { state.updated_at = timestamp(); await atomicJson(config.paths.stateFile, state); }
function addResult(state, step, values) { state.results.push({ run_id: state.run_id, page_path: state.page_path, step, ...values, checked_at: timestamp() }); }

function classifyRuntimeError(error) {
  const message = String(error?.message ?? error);
  if (/ERR_EMPTY_RESPONSE|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|代理|proxy/u.test(message)) return "proxy_unavailable";
  if (/auth_failed|login_expired/u.test(message)) return "auth_failed";
  return "automation_error";
}

export async function getAuthorization(page, config, state, target) {
  const response = await apiCall(page, config, state, "get-geo-auth", "/getGeoAuth", { userId: config.userId, domain: new URL(target.pageUrl).hostname, pageUrl: target.pageUrl });
  if (!successfulTransport(response) || !response.body?.data?.authorization) throw new Error(`auth_failed: getGeoAuth失败，HTTP=${response.http}，code=${responseCode(response) ?? "空"}`);
  state.site_setting_id = response.body.data.siteSettingId ?? "";
  return response.body.data.authorization;
}

async function runOne(config, state, options = {}) {
  const target = config.targets[0];
  const context = await launch(config);
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(config.timeouts.actionMs);
  try {
    await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: config.timeouts.navigationMs });
    const authorization = await getAuthorization(page, config, state, target);
    const base = { siteSettingId: state.site_setting_id, url: target.pageUrl };
    const tdkRead = await apiCall(page, config, state, "tdk-read", "/tdk", base, authorization);
    if (!successfulTransport(tdkRead) || !tdkRead.body?.data || typeof tdkRead.body.data !== "object") {
      addResult(state, "tdk-read", { status: "tdk_read_failed", reason: "TDK读取失败或data不是对象", http_status: tdkRead.http, business_code: responseCode(tdkRead) });
    } else {
      const baseline = tdkRead.body.data;
      addResult(state, "tdk-read", { status: "baseline_captured", seo_title: baseline.seoTitle ?? "", seo_keyword: baseline.seoKeyword ?? "", seo_desc: baseline.seoDesc ?? "", http_status: tdkRead.http, business_code: responseCode(tdkRead) });
      const title = `接口TDK测试-页面001-标题-批次${state.run_id}`;
      const titleSave = await apiCall(page, config, state, "tdk-save-title", "/tdk/save", { ...base, payload: { seoTitle: title } }, authorization);
      const titleClass = classifyTdkSave(titleSave, ["seoTitle"]);
      addResult(state, "tdk-save-title", { ...titleClass, expected_fields: "seoTitle", expected_title: title, http_status: titleSave.http, business_code: responseCode(titleSave) });
      const keyword = `接口TDK测试-页面001-关键词-批次${state.run_id}`;
      const desc = `接口TDK测试-页面001-描述-批次${state.run_id}`;
      const allSave = await apiCall(page, config, state, "tdk-save-keyword-desc", "/tdk/save", { ...base, payload: { seoKeyword: keyword, seoDesc: desc } }, authorization);
      const allClass = classifyTdkSave(allSave, ["seoKeyword", "seoDesc"]);
      addResult(state, "tdk-save-keyword-desc", { ...allClass, expected_fields: "seoKeyword,seoDesc", expected_keyword: keyword, expected_desc: desc, http_status: allSave.http, business_code: responseCode(allSave) });
      const tdkAfter = await apiCall(page, config, state, "tdk-read-after-save", "/tdk", base, authorization);
      const afterData = tdkAfter.body?.data;
      const tdkPersisted = successfulTransport(tdkAfter) && afterData?.seoTitle === title && afterData?.seoKeyword === keyword && afterData?.seoDesc === desc;
      addResult(state, "tdk-read-after-save", { status: tdkPersisted ? "tdk_persisted_verified" : "response_mismatch", reason: tdkPersisted ? "TDK保存后读取值与测试值一致" : "TDK保存后读取值与测试值不一致", expected_title: title, expected_keyword: keyword, expected_desc: desc, http_status: tdkAfter.http, business_code: responseCode(tdkAfter), actual_title: afterData?.seoTitle ?? "", actual_keyword: afterData?.seoKeyword ?? "", actual_desc: afterData?.seoDesc ?? "" });
    }
    if (options.tdkOnly) {
      state.phase = state.results.some((result) => ["tdk_read_failed", "tdk_field_failed", "response_mismatch"].includes(result.status)) ? "complete_with_failures" : "complete";
      return;
    }
    const structuredRead = await apiCall(page, config, state, "structured-read", "/structured-data", base, authorization);
    if (!successfulTransport(structuredRead)) {
      addResult(state, "structured-read", { status: "structured_data_read_failed", reason: `HTTP=${structuredRead.http} code=${responseCode(structuredRead) ?? "空"}`, http_status: structuredRead.http, business_code: responseCode(structuredRead) });
    } else {
      const raw = structuredRead.body?.data?.structureData ?? structuredRead.body?.data?.schemaContent ?? structuredRead.body?.structureData ?? "";
      const built = buildStructuredPayload(raw, state.run_id);
      addResult(state, "structured-read", { status: "baseline_captured", marker: built.marker, baseline_valid_json: Boolean(parseStructuredData(raw)), baseline_length: String(raw ?? "").length, http_status: structuredRead.http, business_code: responseCode(structuredRead) });
      const valid = await apiCall(page, config, state, "structured-save-valid", "/structured-data/save", { ...base, payload: { status: "1", structureData: built.value } }, authorization);
      const validClass = classifyStructuredSave(valid, built.marker);
      addResult(state, "structured-save-valid", { ...validClass, marker: built.marker, expected_structure_length: built.value.length, http_status: valid.http, business_code: responseCode(valid) });
      const structuredAfter = await apiCall(page, config, state, "structured-read-after-save", "/structured-data", base, authorization);
      const afterRaw = structuredAfter.body?.data?.structureData ?? structuredAfter.body?.data?.schemaContent ?? structuredAfter.body?.structureData ?? "";
      const afterText = typeof afterRaw === "string" ? afterRaw : JSON.stringify(afterRaw ?? "");
      const afterCount = (afterText.match(new RegExp(built.marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu")) ?? []).length;
      addResult(state, "structured-read-after-save", { status: successfulTransport(structuredAfter) && Boolean(parseStructuredData(afterRaw)) && afterCount === 1 ? "structured_data_persisted_verified" : "response_mismatch", reason: successfulTransport(structuredAfter) && Boolean(parseStructuredData(afterRaw)) && afterCount === 1 ? "结构化数据保存后读取合法且测试标记唯一" : "结构化数据保存后读取不符合预期", marker: built.marker, http_status: structuredAfter.http, business_code: responseCode(structuredAfter), actual_structure_length: afterText.length });
      const invalid = await apiCall(page, config, state, "structured-save-invalid", "/structured-data/save", { ...base, payload: { status: "1", structureData: "{\"@context\":" } }, authorization);
      const invalidClass = classifyInvalidStructuredSave(invalid);
      addResult(state, "structured-save-invalid", { ...invalidClass, http_status: invalid.http, business_code: responseCode(invalid) });
      const invalidAfter = await apiCall(page, config, state, "structured-read-after-invalid", "/structured-data", base, authorization);
      const invalidRaw = invalidAfter.body?.data?.structureData ?? invalidAfter.body?.data?.schemaContent ?? invalidAfter.body?.structureData ?? "";
      const invalidText = typeof invalidRaw === "string" ? invalidRaw : JSON.stringify(invalidRaw ?? "");
      const invalidCount = (invalidText.match(new RegExp(built.marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu")) ?? []).length;
      addResult(state, "structured-read-after-invalid", { status: successfulTransport(invalidAfter) && invalidCount === 1 ? "invalid_payload_no_change_verified" : "response_mismatch", reason: successfulTransport(invalidAfter) && invalidCount === 1 ? "非法JSON被拒绝且原合法数据未被覆盖" : "非法JSON后读取数据异常", marker: built.marker, http_status: invalidAfter.http, business_code: responseCode(invalidAfter) });
    }
    const bad = ["tdk_read_failed", "tdk_field_failed", "structured_data_read_failed", "structured_data_save_failed", "response_mismatch", "invalid_payload_accepted"].some((status) => state.results.some((result) => result.status === status));
    state.phase = bad ? "complete_with_failures" : "complete";
  } catch (error) {
    const runtimeStatus = classifyRuntimeError(error);
    state.phase = runtimeStatus === "auth_failed" ? "blocked_login" : "complete_with_failures";
    state.failure_reason = String(error?.message ?? error);
    addResult(state, "run", { status: runtimeStatus, reason: state.failure_reason });
  } finally {
    await saveState(config, state);
    await context.close().catch(() => {});
  }
}

async function writeReports(config, state) {
  await mkdir(config.paths.reportsDir, { recursive: true });
  const resultColumns = ["run_id", "page_path", "step", "status", "reason", "expected_fields", "expected_title", "expected_keyword", "expected_desc", "marker", "http_status", "business_code", "checked_at"];
  const apiColumns = ["run_id", "page_path", "stage", "method", "url", "http_status", "business_code", "duration_ms", "request_file", "response_file", "checked_at"];
  const apiRows = state.api_calls.map((call) => ({ run_id: state.run_id, page_path: state.page_path, ...call }));
  const failures = state.results.filter((result) => !["baseline_captured", "tdk_field_updated", "tdk_persisted_verified", "structured_data_updated", "structured_data_persisted_verified", "invalid_payload_rejected", "invalid_payload_no_change_verified"].includes(result.status));
  await Promise.all([
    writeFile(path.join(config.paths.reportsDir, "3.0新接口-TDK结果.csv"), csv(state.results.filter((result) => result.step.startsWith("tdk")), resultColumns), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0新接口-结构化数据结果.csv"), csv(state.results.filter((result) => result.step.startsWith("structured")), resultColumns), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0新接口-请求响应明细.csv"), csv(apiRows, apiColumns), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0新接口-失败清单.csv"), csv(failures, resultColumns), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0新接口-运行状态.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0新接口-核查报告.html"), `<!doctype html><meta charset="utf-8"><title>3.0新接口 TDK 与结构化数据</title><h1>3.0新接口 TDK 与结构化数据</h1><p>批次：${escapeHtml(state.run_id)}；阶段：${escapeHtml(state.phase)}；页面：${escapeHtml(state.page_path)}</p><table border="1" cellspacing="0" cellpadding="6"><tr><th>步骤</th><th>状态</th><th>原因</th><th>HTTP</th><th>业务码</th></tr>${state.results.map((result) => `<tr><td>${escapeHtml(result.step)}</td><td>${escapeHtml(result.status)}</td><td>${escapeHtml(result.reason)}</td><td>${escapeHtml(result.http_status)}</td><td>${escapeHtml(result.business_code)}</td></tr>`).join("")}</table>`, "utf8"),
  ]);
}

async function auth(config) {
  const context = await launch(config, true);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: config.timeouts.navigationMs });
    console.log("已打开登录页，请完成登录后关闭浏览器窗口。");
    await new Promise((resolve) => context.on("close", resolve));
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const config = await loadSeoConfig(args.config);
  if (args.command === "plan") { console.log(JSON.stringify({ apiBaseUrl: config.apiBaseUrl, proxy: config.proxyServer, targets: config.targets }, null, 2)); return; }
  if (args.command === "auth") return auth(config);
  if (args.command === "tdk-only" || args.command === "tdk:retry" || args.command === "run" || args.command === "run:poc") {
    if (!args.apply) throw new Error("该命令会写入 TDK 和结构化数据，必须显式传入 --apply");
    const state = createState(config);
    await saveState(config, state);
    await runOne(config, state, { tdkOnly: args.command === "tdk-only" || args.command === "tdk:retry" });
    await writeReports(config, state);
    console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, results: state.results }, null, 2));
    return;
  }
  const state = await loadState(config);
  if (!state) throw new Error("尚未生成3.0新接口 SEO 状态");
  if (args.command === "status") { console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, page_path: state.page_path, results: state.results.map(({ step, status, reason }) => ({ step, status, reason })) }, null, 2)); return; }
  if (args.command === "report") { await writeReports(config, state); console.log(config.paths.reportsDir); return; }
  throw new Error(`未知命令：${args.command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

export { createState, runOne, writeReports };
