#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "./config.mjs";
import {
  loadSeoConfig,
  launch,
  apiCall,
  getAuthorization,
  buildStructuredPayload,
  parseStructuredData,
  classifyTdkSave,
  classifyStructuredSave,
  classifyInvalidStructuredSave,
} from "./onpage-agent-seo-v3.mjs";

const SUCCESS = new Set([
  "baseline_captured", "tdk_field_updated", "tdk_persisted_verified",
  "structured_data_updated", "structured_data_persisted_verified",
  "invalid_payload_rejected", "invalid_payload_no_change_verified",
]);

function resolvePath(value) { return path.isAbsolute(value) ? value : path.resolve(projectRoot, value); }
function now() { return new Date().toISOString(); }
function makeRunId() { return now().replace(/[-:TZ.]/gu, "").slice(0, 14); }
function csvCell(value) { const text = value === null || value === undefined ? "" : String(value); return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function csv(rows, columns) { return `\uFEFF${[columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n")}\r\n`; }
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
async function atomicJson(file, value) { await mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(tmp, file); }
function responseCode(r) { return r.body?.code ?? null; }
function transportOk(r) { return r.http >= 200 && r.http < 300 && responseCode(r) === 200; }
function structuredRaw(body) { return body?.data?.structureData ?? body?.data?.schemaContent ?? body?.structureData ?? ""; }
function countMarker(raw, marker) { const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? ""); return (text.match(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu")) ?? []).length; }

export async function loadBatchConfig(configPath = "config/onpage-agent-seo-batch-v3-v4.json") {
  const config = JSON.parse(await readFile(resolvePath(configPath), "utf8"));
  for (const key of ["userDataDir", "stateFile", "artifactsDir", "reportsDir"]) config.paths[key] = resolvePath(config.paths[key]);
  return config;
}

function createBatchState(config) {
  return {
    version: 1,
    kind: "onpage-agent-seo-batch-v3-v4",
    run_id: makeRunId(),
    phase: "planned",
    scope: { v3_count: config.targets.filter((t) => t.platform === "3.0").length, v4_count: config.targets.filter((t) => t.platform === "4.0").length, total: config.targets.length },
    created_at: now(),
    updated_at: now(),
    note: "3.0与4.0页面批量验证新接口TDK和结构化数据；仅保留接口请求、响应和持久化复读证据，不访问预览、编辑器或增长引擎回填。",
    pages: config.targets.map((target) => ({ target_id: target.id, platform: target.platform, site_name: target.siteName, site_host: target.siteHost, page_name: target.pageName, page_path: target.pagePath, page_url: target.pageUrl, status: "pending", phase: "pending", site_setting_id: "", api_calls: [], results: [], failure_reason: "", started_at: "", completed_at: "" })),
  };
}

async function saveState(config, state) { state.updated_at = now(); await atomicJson(config.paths.stateFile, state); }
function result(page, step, values) { page.results.push({ run_id: page.run_id, target_id: page.target_id, platform: page.platform, page_path: page.page_path, page_url: page.page_url, step, ...values, checked_at: now() }); }

async function call(page, config, state, targetState, stage, route, payload, token) {
  const response = await apiCall(page, config, { ...targetState, target_id: targetState.target_id, api_calls: targetState.api_calls }, stage, route, payload, token);
  state.updated_at = now();
  return response;
}

function classifyPageError(error) {
  const message = String(error?.message ?? error);
  if (/ERR_EMPTY_RESPONSE|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|代理|proxy/u.test(message)) return "proxy_unavailable";
  if (/auth_failed|login_expired/u.test(message)) return "auth_failed";
  return "automation_error";
}

async function runTarget(config, state, targetState, page) {
  const target = config.targets.find((entry) => entry.id === targetState.target_id);
  targetState.run_id = state.run_id;
  targetState.started_at = now();
  targetState.phase = "running";
  const base = { siteSettingId: "", url: target.pageUrl };
  try {
    const token = await getAuthorization(page, config, targetState, target);
    base.siteSettingId = targetState.site_setting_id;
    const tdkRead = await call(page, config, state, targetState, "tdk-read", "/tdk", base, token);
    if (!transportOk(tdkRead) || !tdkRead.body?.data || typeof tdkRead.body.data !== "object") {
      result(targetState, "tdk-read", { status: "tdk_read_failed", reason: "TDK读取失败或data不是对象", http_status: tdkRead.http, business_code: responseCode(tdkRead) });
    } else {
      const baseline = tdkRead.body.data;
      result(targetState, "tdk-read", { status: "baseline_captured", seo_title: baseline.seoTitle ?? "", seo_keyword: baseline.seoKeyword ?? "", seo_desc: baseline.seoDesc ?? "", http_status: tdkRead.http, business_code: responseCode(tdkRead) });
      const ordinal = targetState.target_id.replace(/[^0-9]/gu, "") || "000";
      const title = `接口TDK测试-${target.platform}-${ordinal}-标题-批次${state.run_id}`;
      const titleSave = await call(page, config, state, targetState, "tdk-save-title", "/tdk/save", { ...base, payload: { seoTitle: title } }, token);
      const titleClass = classifyTdkSave(titleSave, ["seoTitle"]);
      result(targetState, "tdk-save-title", { ...titleClass, expected_fields: "seoTitle", expected_title: title, response_message: titleSave.body?.message ?? "", http_status: titleSave.http, business_code: responseCode(titleSave) });
      const keyword = `接口TDK测试-${target.platform}-${ordinal}-关键词-批次${state.run_id}`;
      const desc = `接口TDK测试-${target.platform}-${ordinal}-描述-批次${state.run_id}`;
      const allSave = await call(page, config, state, targetState, "tdk-save-keyword-desc", "/tdk/save", { ...base, payload: { seoKeyword: keyword, seoDesc: desc } }, token);
      const allClass = classifyTdkSave(allSave, ["seoKeyword", "seoDesc"]);
      result(targetState, "tdk-save-keyword-desc", { ...allClass, expected_fields: "seoKeyword,seoDesc", expected_keyword: keyword, expected_desc: desc, response_message: allSave.body?.message ?? "", http_status: allSave.http, business_code: responseCode(allSave) });
      const after = await call(page, config, state, targetState, "tdk-read-after-save", "/tdk", base, token);
      const afterData = after.body?.data ?? {};
      const persisted = transportOk(after) && afterData.seoTitle === title && afterData.seoKeyword === keyword && afterData.seoDesc === desc;
      result(targetState, "tdk-read-after-save", { status: persisted ? "tdk_persisted_verified" : "response_mismatch", reason: persisted ? "TDK保存后读取值与测试值一致" : "TDK保存后读取值与测试值不一致", expected_title: title, expected_keyword: keyword, expected_desc: desc, actual_title: afterData.seoTitle ?? "", actual_keyword: afterData.seoKeyword ?? "", actual_desc: afterData.seoDesc ?? "", http_status: after.http, business_code: responseCode(after) });
    }

    const structuredRead = await call(page, config, state, targetState, "structured-read", "/structured-data", base, token);
    if (!transportOk(structuredRead)) {
      result(targetState, "structured-read", { status: "structured_data_read_failed", reason: `HTTP=${structuredRead.http} code=${responseCode(structuredRead) ?? "空"}`, http_status: structuredRead.http, business_code: responseCode(structuredRead) });
    } else {
      const raw = structuredRaw(structuredRead.body);
      const built = buildStructuredPayload(raw, `${targetState.target_id}-${state.run_id}`);
      result(targetState, "structured-read", { status: "baseline_captured", marker: built.marker, baseline_valid_json: Boolean(parseStructuredData(raw)), baseline_length: String(raw ?? "").length, http_status: structuredRead.http, business_code: responseCode(structuredRead) });
      const valid = await call(page, config, state, targetState, "structured-save-valid", "/structured-data/save", { ...base, payload: { status: "1", structureData: built.value } }, token);
      const validClass = classifyStructuredSave(valid, built.marker);
      result(targetState, "structured-save-valid", { ...validClass, marker: built.marker, expected_structure_length: built.value.length, response_message: valid.body?.message ?? "", http_status: valid.http, business_code: responseCode(valid) });
      const after = await call(page, config, state, targetState, "structured-read-after-save", "/structured-data", base, token);
      const afterRaw = structuredRaw(after.body);
      const verified = transportOk(after) && Boolean(parseStructuredData(afterRaw)) && countMarker(afterRaw, built.marker) === 1;
      result(targetState, "structured-read-after-save", { status: verified ? "structured_data_persisted_verified" : "response_mismatch", reason: verified ? "结构化数据保存后读取合法且测试标记唯一" : "结构化数据保存后读取不符合预期", marker: built.marker, actual_structure_length: String(afterRaw ?? "").length, http_status: after.http, business_code: responseCode(after) });
      const invalid = await call(page, config, state, targetState, "structured-save-invalid", "/structured-data/save", { ...base, payload: { status: "1", structureData: "{\"@context\":" } }, token);
      const invalidClass = classifyInvalidStructuredSave(invalid);
      result(targetState, "structured-save-invalid", { ...invalidClass, response_message: invalid.body?.message ?? "", http_status: invalid.http, business_code: responseCode(invalid) });
      const invalidAfter = await call(page, config, state, targetState, "structured-read-after-invalid", "/structured-data", base, token);
      const invalidRaw = structuredRaw(invalidAfter.body);
      const unchanged = transportOk(invalidAfter) && countMarker(invalidRaw, built.marker) === 1;
      result(targetState, "structured-read-after-invalid", { status: unchanged ? "invalid_payload_no_change_verified" : "response_mismatch", reason: unchanged ? "非法JSON被拒绝且原合法数据未被覆盖" : "非法JSON后读取数据异常", marker: built.marker, http_status: invalidAfter.http, business_code: responseCode(invalidAfter) });
    }
    const bad = targetState.results.some((entry) => ["tdk_read_failed", "tdk_field_failed", "response_mismatch", "structured_data_read_failed", "structured_data_save_failed", "invalid_payload_accepted"].includes(entry.status));
    targetState.phase = bad ? "complete_with_failures" : "complete";
    targetState.status = targetState.phase;
  } catch (error) {
    const status = classifyPageError(error);
    targetState.phase = status === "auth_failed" ? "blocked_login" : "complete_with_failures";
    targetState.status = status;
    targetState.failure_reason = String(error?.message ?? error);
    result(targetState, "run", { status, reason: targetState.failure_reason });
    if (status === "auth_failed" || status === "proxy_unavailable") state.stop_reason = status;
  } finally {
    targetState.completed_at = now();
  }
}

export async function runBatch(config, state, { maxPages = null } = {}) {
  const context = await launch(config);
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(config.timeouts.actionMs);
  try {
    await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: config.timeouts.navigationMs });
    const pending = state.pages.filter((entry) => entry.phase !== "complete" && entry.phase !== "complete_with_failures" && entry.phase !== "blocked_login").slice(0, maxPages || state.pages.length);
    for (const targetState of pending) {
      await runTarget(config, state, targetState, page);
      await saveState(config, state);
      if (state.stop_reason) break;
    }
    const completed = state.pages.filter((entry) => ["complete", "complete_with_failures"].includes(entry.phase)).length;
    state.phase = state.stop_reason ? "blocked" : completed === state.pages.length ? "complete" : "partial";
  } finally {
    await saveState(config, state);
    await context.close().catch(() => {});
  }
  return state;
}

async function writeReports(config, state) {
  await mkdir(config.paths.reportsDir, { recursive: true });
  const allResults = state.pages.flatMap((p) => p.results);
  const allCalls = state.pages.flatMap((p) => p.api_calls.map((c) => ({ ...c, target_id: p.target_id, platform: p.platform, page_path: p.page_path, page_url: p.page_url, run_id: state.run_id })));
  const resultCols = ["run_id", "target_id", "platform", "page_path", "page_url", "step", "status", "reason", "response_message", "marker", "expected_fields", "expected_title", "expected_keyword", "expected_desc", "actual_title", "actual_keyword", "actual_desc", "http_status", "business_code", "checked_at"];
  const callCols = ["run_id", "target_id", "platform", "page_path", "page_url", "stage", "method", "url", "http_status", "business_code", "duration_ms", "request_file", "response_file", "checked_at"];
  const failures = allResults.filter((entry) => !SUCCESS.has(entry.status));
  const pageRows = state.pages.map((p) => ({ run_id: state.run_id, target_id: p.target_id, platform: p.platform, site_name: p.site_name, site_host: p.site_host, page_name: p.page_name, page_path: p.page_path, page_url: p.page_url, status: p.status, phase: p.phase, failure_reason: p.failure_reason, result_count: p.results.length, api_call_count: p.api_calls.length, started_at: p.started_at, completed_at: p.completed_at }));
  const pageCols = ["run_id", "target_id", "platform", "site_name", "site_host", "page_name", "page_path", "page_url", "status", "phase", "failure_reason", "result_count", "api_call_count", "started_at", "completed_at"];
  await Promise.all([
    writeFile(path.join(config.paths.reportsDir, "3.0与4.0新接口-页面结果.csv"), csv(pageRows, pageCols), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0与4.0新接口-TDK结果.csv"), csv(allResults.filter((r) => r.step.startsWith("tdk")), resultCols), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0与4.0新接口-结构化数据结果.csv"), csv(allResults.filter((r) => r.step.startsWith("structured")), resultCols), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0与4.0新接口-请求响应明细.csv"), csv(allCalls, callCols), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0与4.0新接口-失败清单.csv"), csv(failures, resultCols), "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0与4.0新接口-运行状态.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8"),
    writeFile(path.join(config.paths.reportsDir, "3.0与4.0新接口-核查报告.html"), `<!doctype html><meta charset="utf-8"><title>3.0与4.0新接口批量核查</title><h1>3.0与4.0新接口批量核查</h1><p>批次：${escapeHtml(state.run_id)}；阶段：${escapeHtml(state.phase)}；页面：${state.pages.length}（3.0=${state.scope.v3_count}，4.0=${state.scope.v4_count}）</p><table border="1" cellspacing="0" cellpadding="6"><tr><th>平台</th><th>页面</th><th>路径</th><th>状态</th><th>失败原因</th></tr>${pageRows.map((r) => `<tr><td>${escapeHtml(r.platform)}</td><td>${escapeHtml(r.page_name)}</td><td>${escapeHtml(r.page_path)}</td><td>${escapeHtml(r.status)}</td><td>${escapeHtml(r.failure_reason)}</td></tr>`).join("")}</table>`, "utf8"),
  ]);
}

function args(argv) { const out = { command: argv[2] || "status", apply: false, config: "config/onpage-agent-seo-batch-v3-v4.json", maxPages: null }; for (let i = 3; i < argv.length; i += 1) { if (argv[i] === "--apply") out.apply = true; else if (argv[i] === "--config") out.config = argv[++i]; else if (argv[i] === "--max-pages") out.maxPages = Number(argv[++i]); } return out; }
async function main() {
  const a = args(process.argv); const config = await loadBatchConfig(a.config);
  if (a.command === "plan") { console.log(JSON.stringify({ scope: { v3: config.targets.filter((t) => t.platform === "3.0").length, v4: config.targets.filter((t) => t.platform === "4.0").length, total: config.targets.length }, targets: config.targets }, null, 2)); return; }
  if (["run", "run:poc", "resume"].includes(a.command)) {
    if (!a.apply) throw new Error("批量接口写入必须显式传入 --apply");
    let state;
    if (a.command === "resume") { try { state = JSON.parse(await readFile(config.paths.stateFile, "utf8")); } catch { throw new Error("尚未生成批量状态，请先执行 run --apply"); } }
    else { state = createBatchState(config); await saveState(config, state); }
    await runBatch(config, state, { maxPages: a.command === "run:poc" ? (a.maxPages || 1) : a.maxPages }); await writeReports(config, state); console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, pages: state.pages.map((p) => ({ target_id: p.target_id, page_path: p.page_path, status: p.status, phase: p.phase })) }, null, 2)); return;
  }
  let state; try { state = JSON.parse(await readFile(config.paths.stateFile, "utf8")); } catch { throw new Error("尚未生成批量状态，请先执行 plan 或 run --apply"); }
  if (a.command === "status") { console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, scope: state.scope, pages: state.pages.map((p) => ({ target_id: p.target_id, platform: p.platform, page_path: p.page_path, status: p.status, phase: p.phase, failure_reason: p.failure_reason, result_count: p.results.length })) }, null, 2)); return; }
  if (a.command === "report") { await writeReports(config, state); console.log(config.paths.reportsDir); return; }
  throw new Error(`未知命令：${a.command}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

export { createBatchState, writeReports };
