#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "./config.mjs";
import { apiCall, launch } from "./onpage-agent-seo-v3.mjs";

const DEFAULT_CONFIG = "config/onpage-agent-tdk-v3-regression.json";
const SUCCESS_STATES = new Set(["persisted_verified", "delayed_persisted"]);

function resolvePath(value) { return path.isAbsolute(value) ? value : path.resolve(projectRoot, value); }
function now() { return new Date().toISOString(); }
function makeRunId() { return now().replace(/[-:TZ.]/gu, "").slice(0, 14); }
function businessCode(response) { return response?.body?.code ?? null; }
function transportOk(response) { return response?.http >= 200 && response.http < 300 && businessCode(response) === 200; }
function saveAccepted(response) {
  if (!transportOk(response)) return false;
  const data = response.body?.data;
  if (data?.success === true || response.body?.success === true) return true;
  const fields = data?.fieldResults ?? response.body?.fieldResults;
  return Array.isArray(fields) && fields.length > 0 && fields.every((item) => [true, "success", "updated", "ok"].includes(item?.success ?? String(item?.status ?? item?.result ?? "").toLowerCase()));
}
function tdkValues(response) {
  const data = response?.body?.data;
  return {
    seoTitle: typeof data?.seoTitle === "string" ? data.seoTitle : "",
    seoKeyword: typeof data?.seoKeyword === "string" ? data.seoKeyword : "",
    seoDesc: typeof data?.seoDesc === "string" ? data.seoDesc : "",
  };
}
function compareValues(actual, expected) {
  const matches = Object.fromEntries(Object.keys(expected).map((field) => [field, actual[field] === expected[field]]));
  const count = Object.values(matches).filter(Boolean).length;
  return { matches, matchedCount: count, exact: count === 3, partial: count > 0 && count < 3 };
}

export function classifyAttempt({ accepted, polls = [], freshRead = null }) {
  if (!accepted) return { status: "save_failed", persistedAtMs: null };
  const exactPoll = polls.find((item) => item.comparison?.exact);
  if (exactPoll) return { status: exactPoll.offset_ms === 0 ? "persisted_verified" : "delayed_persisted", persistedAtMs: exactPoll.offset_ms };
  if (freshRead?.comparison?.exact) return { status: "delayed_persisted", persistedAtMs: freshRead.elapsed_ms ?? null };
  const last = freshRead ?? polls.at(-1);
  if (last?.comparison?.partial) return { status: "partial_persistence", persistedAtMs: null };
  return { status: "success_but_not_persisted", persistedAtMs: null };
}

export function classifyScheme(primary, fallback) {
  if (!fallback) return primary.status;
  const primaryOk = SUCCESS_STATES.has(primary.status);
  const fallbackOk = SUCCESS_STATES.has(fallback.status);
  return primaryOk !== fallbackOk ? "scheme_inconsistent" : primary.status;
}

async function loadConfig(configFile = DEFAULT_CONFIG) {
  const config = JSON.parse(await readFile(resolvePath(configFile), "utf8"));
  for (const key of ["userDataDir", "stateFile", "artifactsDir", "reportsDir", "outputRoot"]) config.paths[key] = resolvePath(config.paths[key]);
  return config;
}

function parseArgs(argv) {
  const args = { command: argv[2] || "status", apply: false, config: DEFAULT_CONFIG };
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--config") args.config = argv[++i];
  }
  return args;
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

function newState(config) {
  const runId = makeRunId();
  return {
    version: 1,
    run_id: runId,
    target_id: path.join(config.target.id, runId),
    phase: "planned",
    created_at: now(),
    updated_at: now(),
    target: structuredClone(config.target),
    proxy_server: config.proxyServer,
    poll_offsets_ms: config.pollOffsetsMs,
    baseline_reads: [],
    attempts: [],
    api_calls: [],
    final_status: "pending",
    failure_reason: "",
  };
}

async function saveState(config, state) {
  state.updated_at = now();
  await atomicJson(config.paths.stateFile, state);
}

async function readState(config) {
  try { return JSON.parse(await readFile(config.paths.stateFile, "utf8")); } catch { return null; }
}

async function callAuth(page, config, state, stage, pageUrl) {
  const request = { userId: config.userId, domain: new URL(pageUrl).hostname, pageUrl };
  const response = await apiCall(page, config, state, stage, "/getGeoAuth", request);
  const data = response.body?.data ?? {};
  return {
    request_url: pageUrl,
    response,
    ok: transportOk(response) && Boolean(data.authorization) && Boolean(data.siteSettingId),
    authorization: data.authorization ?? "",
    site_setting_id: data.siteSettingId ?? "",
    canonical_url: data.url || pageUrl,
    preview_url: data.previewUrl ?? "",
  };
}

async function readTdk(page, config, state, stage, auth, pageUrl) {
  const request = { siteSettingId: auth.site_setting_id, url: pageUrl };
  const response = await apiCall(page, config, state, stage, "/tdk", request, auth.authorization);
  return { request, response, ok: transportOk(response), actual: tdkValues(response) };
}

async function baselineFor(page, config, state, scheme, pageUrl) {
  const auth = await callAuth(page, config, state, `baseline-${scheme}-auth`, pageUrl);
  let read = null;
  if (auth.ok) read = await readTdk(page, config, state, `baseline-${scheme}-read`, auth, pageUrl);
  const baseline = {
    scheme,
    requested_url: pageUrl,
    canonical_url: auth.canonical_url,
    site_setting_id: auth.site_setting_id,
    auth_status: auth.ok ? "ok" : "auth_failed",
    read_status: read?.ok ? "ok" : "read_failed",
    values: read?.actual ?? { seoTitle: "", seoKeyword: "", seoDesc: "" },
    auth_request_file: auth.response.requestFile,
    auth_response_file: auth.response.responseFile,
    read_request_file: read?.response.requestFile ?? "",
    read_response_file: read?.response.responseFile ?? "",
    checked_at: now(),
  };
  state.baseline_reads.push(baseline);
  await saveState(config, state);
  return { auth, read, baseline };
}

function expectedValues(runId, scheme, target) {
  const tag = `${runId}-${scheme.toUpperCase()}`;
  const pageNumber = String(target?.pagePath ?? "").match(/\/(\d+)\.html$/u)?.[1] ?? String(target?.id ?? "page").replace(/^page-/u, "");
  const pageLabel = `页面${pageNumber}`;
  return {
    seoTitle: `接口TDK复核-${pageLabel}-标题-批次${tag}`,
    seoKeyword: `接口TDK复核-${pageLabel}-关键词-批次${tag}`,
    seoDesc: `接口TDK复核-${pageLabel}-描述-批次${tag}`,
  };
}

async function waitUntil(page, start, offset) {
  const remaining = Math.max(0, offset - (Date.now() - start));
  if (remaining) await page.waitForTimeout(remaining);
}

async function runAttempt(page, config, state, scheme, pageUrl, initialAuth = null) {
  const auth = initialAuth?.ok ? initialAuth : await callAuth(page, config, state, `${scheme}-write-auth`, pageUrl);
  const attempt = {
    scheme,
    requested_url: pageUrl,
    canonical_url: auth.canonical_url,
    site_setting_id: auth.site_setting_id,
    expected: expectedValues(state.run_id, scheme, state.target),
    save: null,
    polls: [],
    fresh_auth_read: null,
    status: "pending",
    persisted_at_ms: null,
    started_at: now(),
  };
  state.attempts.push(attempt);
  if (!auth.ok) {
    attempt.status = "auth_failed";
    attempt.failure_reason = `getGeoAuth失败：HTTP=${auth.response.http}，code=${businessCode(auth.response) ?? "空"}`;
    await saveState(config, state);
    return attempt;
  }

  const savePayload = { siteSettingId: auth.site_setting_id, url: auth.canonical_url, payload: attempt.expected };
  const saveResponse = await apiCall(page, config, state, `${scheme}-tdk-save`, "/tdk/save", savePayload, auth.authorization);
  attempt.save = {
    accepted: saveAccepted(saveResponse),
    http_status: saveResponse.http,
    business_code: businessCode(saveResponse),
    success_flag: saveResponse.body?.data?.success ?? saveResponse.body?.success ?? null,
    request_file: saveResponse.requestFile,
    response_file: saveResponse.responseFile,
  };
  await saveState(config, state);
  if (!attempt.save.accepted) {
    attempt.status = "save_failed";
    attempt.failure_reason = `保存未明确成功：HTTP=${saveResponse.http}，code=${businessCode(saveResponse) ?? "空"}，success=${attempt.save.success_flag ?? "空"}`;
    await saveState(config, state);
    return attempt;
  }

  const started = Date.now();
  for (const offset of config.pollOffsetsMs) {
    await waitUntil(page, started, offset);
    const read = await readTdk(page, config, state, `${scheme}-tdk-read-${Math.round(offset / 1000)}s`, auth, auth.canonical_url);
    const comparison = compareValues(read.actual, attempt.expected);
    attempt.polls.push({
      offset_ms: offset,
      elapsed_ms: Date.now() - started,
      http_status: read.response.http,
      business_code: businessCode(read.response),
      read_ok: read.ok,
      actual: read.actual,
      comparison,
      request_file: read.response.requestFile,
      response_file: read.response.responseFile,
      checked_at: now(),
    });
    await saveState(config, state);
    if (comparison.exact) break;
  }

  const freshAuth = await callAuth(page, config, state, `${scheme}-fresh-auth`, pageUrl);
  if (freshAuth.ok) {
    const freshRead = await readTdk(page, config, state, `${scheme}-fresh-auth-read`, freshAuth, freshAuth.canonical_url);
    attempt.fresh_auth_read = {
      site_setting_id: freshAuth.site_setting_id,
      canonical_url: freshAuth.canonical_url,
      elapsed_ms: Date.now() - started,
      read_ok: freshRead.ok,
      actual: freshRead.actual,
      comparison: compareValues(freshRead.actual, attempt.expected),
      request_file: freshRead.response.requestFile,
      response_file: freshRead.response.responseFile,
      checked_at: now(),
    };
  } else {
    attempt.fresh_auth_read = { read_ok: false, comparison: { exact: false, partial: false, matchedCount: 0 }, checked_at: now() };
  }
  const classification = classifyAttempt({ accepted: attempt.save.accepted, polls: attempt.polls, freshRead: attempt.fresh_auth_read });
  attempt.status = classification.status;
  attempt.persisted_at_ms = classification.persistedAtMs;
  attempt.completed_at = now();
  await saveState(config, state);
  return attempt;
}

function runtimeStatus(error) {
  const message = String(error?.message ?? error);
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_EMPTY_RESPONSE|proxy|代理/iu.test(message)) return "proxy_unavailable";
  if (/auth_failed|登录|login/iu.test(message)) return "auth_failed";
  return "automation_error";
}

async function execute(config, state) {
  const context = await launch(config);
  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(config.timeouts.actionMs);
  state.phase = "running";
  await saveState(config, state);
  try {
    await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: config.timeouts.navigationMs });
    const httpBaseline = await baselineFor(page, config, state, "http", config.target.httpUrl);
    const httpsBaseline = await baselineFor(page, config, state, "https", config.target.httpsUrl);
    if (!httpBaseline.auth.ok && !httpsBaseline.auth.ok) throw new Error("auth_failed: HTTP和HTTPS的getGeoAuth均失败");

    const primaryBaseline = httpsBaseline.auth.ok ? httpsBaseline : httpBaseline;
    const primaryScheme = new URL(primaryBaseline.auth.canonical_url).protocol === "http:" ? "http" : "https";
    const primary = await runAttempt(page, config, state, primaryScheme, primaryBaseline.baseline.requested_url, primaryBaseline.auth);
    let fallback = null;
    if (primaryScheme === "https" && !SUCCESS_STATES.has(primary.status)) {
      fallback = await runAttempt(page, config, state, "http", config.target.httpUrl, httpBaseline.auth);
    }
    state.final_status = classifyScheme(primary, fallback);
    if (primary.status === "success_but_not_persisted") state.failure_reason = "保存接口明确返回成功，但120秒轮询及新授权读取仍未返回目标TDK值";
    if (state.final_status === "scheme_inconsistent") state.failure_reason = "HTTP与HTTPS对同一页面的TDK持久化结果不同";
    if (state.final_status === "partial_persistence") state.failure_reason = "标题、关键词、描述仅部分持久化";
    if (state.final_status === "success_but_not_persisted" && primary.save?.accepted) state.final_status = "save_response_mismatch";
    state.phase = SUCCESS_STATES.has(state.final_status) ? "complete" : "complete_with_failures";
  } catch (error) {
    state.final_status = runtimeStatus(error);
    state.phase = state.final_status === "auth_failed" ? "blocked_login" : "complete_with_failures";
    state.failure_reason = String(error?.message ?? error);
  } finally {
    await saveState(config, state);
    await context.close().catch(() => {});
  }
}

function csvCell(value) {
  const text = value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function csv(rows, columns) { return `\uFEFF${[columns.join(","), ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(","))].join("\r\n")}\r\n`; }
function htmlEscape(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }

function reportRows(state) {
  return state.attempts.flatMap((attempt) => attempt.polls.map((poll) => ({
    run_id: state.run_id, scheme: attempt.scheme, url: attempt.canonical_url, site_setting_id: attempt.site_setting_id,
    offset_seconds: poll.offset_ms / 1000, elapsed_ms: poll.elapsed_ms, http_status: poll.http_status,
    business_code: poll.business_code, actual_title: poll.actual.seoTitle, actual_keyword: poll.actual.seoKeyword,
    actual_desc: poll.actual.seoDesc, matched_fields: poll.comparison.matchedCount, exact_match: poll.comparison.exact,
    request_file: poll.request_file, response_file: poll.response_file, checked_at: poll.checked_at,
  })));
}

async function writeReports(config, state) {
  const reportDir = path.join(config.paths.reportsDir, state.run_id);
  const outputDir = path.join(config.paths.outputRoot, `onpage-v3-tdk-regression-${state.run_id}`);
  await Promise.all([mkdir(reportDir, { recursive: true }), mkdir(outputDir, { recursive: true })]);
  state.report_dir = reportDir;
  state.output_dir = outputDir;
  const summary = state.attempts.map((attempt) => ({
    run_id: state.run_id, page_name: state.target.pageName, page_path: state.target.pagePath, scheme: attempt.scheme,
    requested_url: attempt.requested_url, canonical_url: attempt.canonical_url, site_setting_id: attempt.site_setting_id,
    expected_title: attempt.expected.seoTitle, expected_keyword: attempt.expected.seoKeyword, expected_desc: attempt.expected.seoDesc,
    save_http_status: attempt.save?.http_status, save_business_code: attempt.save?.business_code, save_success: attempt.save?.success_flag,
    status: attempt.status, persisted_at_ms: attempt.persisted_at_ms, failure_reason: attempt.failure_reason ?? "",
  }));
  const baselineColumns = ["scheme", "requested_url", "canonical_url", "site_setting_id", "auth_status", "read_status", "values", "auth_request_file", "auth_response_file", "read_request_file", "read_response_file", "checked_at"];
  const summaryColumns = ["run_id", "page_name", "page_path", "scheme", "requested_url", "canonical_url", "site_setting_id", "expected_title", "expected_keyword", "expected_desc", "save_http_status", "save_business_code", "save_success", "status", "persisted_at_ms", "failure_reason"];
  const pollColumns = ["run_id", "scheme", "url", "site_setting_id", "offset_seconds", "elapsed_ms", "http_status", "business_code", "actual_title", "actual_keyword", "actual_desc", "matched_fields", "exact_match", "request_file", "response_file", "checked_at"];
  const apiRows = state.api_calls.map((call) => ({ run_id: state.run_id, ...call }));
  const apiColumns = ["run_id", "stage", "method", "url", "http_status", "business_code", "duration_ms", "request_file", "response_file", "checked_at"];
  const pollRows = reportRows(state);
  const failureRows = summary.filter((row) => !SUCCESS_STATES.has(row.status));
  await Promise.all([
    writeFile(path.join(reportDir, "3.0TDK持久化复核-汇总.csv"), csv(summary, summaryColumns), "utf8"),
    writeFile(path.join(reportDir, "3.0TDK持久化复核-协议基线.csv"), csv(state.baseline_reads, baselineColumns), "utf8"),
    writeFile(path.join(reportDir, "3.0TDK持久化复核-轮询明细.csv"), csv(pollRows, pollColumns), "utf8"),
    writeFile(path.join(reportDir, "3.0TDK持久化复核-请求响应.csv"), csv(apiRows, apiColumns), "utf8"),
    writeFile(path.join(reportDir, "3.0TDK持久化复核-异常.csv"), csv(failureRows, summaryColumns), "utf8"),
    writeFile(path.join(reportDir, "3.0TDK持久化复核-运行状态.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8"),
    writeFile(path.join(reportDir, "3.0TDK持久化复核-report.html"), `<!doctype html><meta charset="utf-8"><title>3.0 TDK持久化复核</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:28px;color:#172033}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d8dee9;padding:8px;text-align:left}th{background:#eaf2ff}.bad{color:#b42318}</style><h1>3.0 TDK“成功但未持久化”复核</h1><p>页面：${htmlEscape(state.target.pageName)} ${htmlEscape(state.target.pagePath)}</p><p>批次：${state.run_id}　最终状态：<strong class="${SUCCESS_STATES.has(state.final_status) ? "" : "bad"}">${htmlEscape(state.final_status)}</strong></p><p>${htmlEscape(state.failure_reason)}</p><table><tr><th>协议</th><th>规范URL</th><th>保存响应</th><th>持久化状态</th><th>生效延迟(ms)</th></tr>${summary.map((row) => `<tr><td>${row.scheme}</td><td>${htmlEscape(row.canonical_url)}</td><td>HTTP ${row.save_http_status} / code ${row.save_business_code} / success ${row.save_success}</td><td>${row.status}</td><td>${row.persisted_at_ms ?? ""}</td></tr>`).join("")}</table>`, "utf8"),
  ]);
  await saveState(config, state);
  return { reportDir, outputDir };
}

async function auth(config) {
  const context = await launch(config, true);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: config.timeouts.navigationMs });
    console.log("已打开代理浏览器，请完成登录后关闭浏览器窗口。");
    await new Promise((resolve) => context.on("close", resolve));
  } finally { await context.close().catch(() => {}); }
}

async function main() {
  const args = parseArgs(process.argv);
  const config = await loadConfig(args.config);
  if (args.command === "plan") {
    console.log(JSON.stringify({ target: config.target, proxy: config.proxyServer, poll_offsets_seconds: config.pollOffsetsMs.map((value) => value / 1000), writes: ["POST /tdk/save（标题、关键词、描述同一请求）"], excludes: ["结构化数据", "旧接口", "编辑器", "发布"] }, null, 2));
    return;
  }
  if (args.command === "auth") return auth(config);
  if (args.command === "run") {
    if (!args.apply) throw new Error("该命令会写入TDK，必须显式传入 --apply");
    const state = newState(config);
    await saveState(config, state);
    await execute(config, state);
    const locations = await writeReports(config, state);
    console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, final_status: state.final_status, failure_reason: state.failure_reason, ...locations }, null, 2));
    return;
  }
  const state = await readState(config);
  if (!state) throw new Error("尚未生成TDK复核状态，请先运行plan或run");
  if (args.command === "status") {
    console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, final_status: state.final_status, attempts: state.attempts.map(({ scheme, canonical_url, status, persisted_at_ms }) => ({ scheme, canonical_url, status, persisted_at_ms })), failure_reason: state.failure_reason }, null, 2));
    return;
  }
  if (args.command === "report") {
    const locations = await writeReports(config, state);
    console.log(JSON.stringify(locations, null, 2));
    return;
  }
  throw new Error(`未知命令：${args.command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

export { loadConfig, newState, writeReports };
