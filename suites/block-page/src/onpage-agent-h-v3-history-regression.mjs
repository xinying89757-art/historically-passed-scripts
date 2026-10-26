#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { launchGrowthEngineContext } from "./growth-engine-h-editor.mjs";
import { projectRoot } from "./config.mjs";
import { loadAgentConfig as loadBaseConfig, run as runBase } from "./onpage-agent-h-v3.mjs";
import {
  buildObjectRows,
  itemMatchesSource,
  parseHistorySubject,
  regressionStatus,
} from "./onpage-agent-h-v3-history-core.mjs";

const DEFAULT_CONFIG = "config/onpage-agent-h-v3-history-regression.json";
const execFileAsync = promisify(execFile);

function resolveProjectPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

function parseArgs(argv) {
  const result = { command: argv[2] ?? "status", apply: false, maxPages: Infinity, taskId: "", config: DEFAULT_CONFIG };
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] === "--apply") result.apply = true;
    else if (argv[index] === "--max-pages") result.maxPages = Number(argv[++index]);
    else if (argv[index] === "--task-id") result.taskId = argv[++index];
    else if (argv[index] === "--config") result.config = argv[++index];
    else if (argv[index] === "--help") {
      console.log("node src/onpage-agent-h-v3-history-regression.mjs <plan|auth|run|resume|status|report> [--apply] [--max-pages N] [--task-id ID]");
      process.exit(0);
    }
  }
  return result;
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

function buildOriginTargets(base, states) {
  const latestPages = new Map();
  for (const state of states) {
    for (const page of state.pages ?? []) {
      const originItems = (page.items ?? []).filter((item) => item.status === "origin_mismatch" && parseHistorySubject(item));
      if (originItems.length > 0) latestPages.set(page.page_path, { page, items: originItems });
    }
  }
  return [...latestPages.values()].map(({ page, items }) => {
    const subjects = items.map(parseHistorySubject);
    const host = new URL(page.page_url).host;
    const sourceTarget = base.targets.find((target) => target.id === page.target_id || target.pageName === page.page_name);
    return {
      ...(sourceTarget ?? {}),
      id: `history-origin-${page.target_id}`,
      pageName: page.page_name,
      pagePath: page.page_path,
      pageUrl: page.page_url,
      apiDomain: host,
      growthEngineSiteName: "3.0区块+组件",
      growthEngineSiteHost: host,
      editorSiteName: "测试增长引擎",
      editorSiteHost: host,
      editorSiteLanguage: "英语",
      scope: subjects.every((subject) => subject.objectType === "组件") ? "components" : "blocks",
      blockStateFile: sourceTarget?.blockStateFile || base.sourceFiles.blockStateFile,
      issueGroup: "origin_mismatch",
      scenarios: [],
      allowedSources: items.map((item, index) => {
        const subject = subjects[index];
        return {
          sourceText: item.original_text,
          scenario: "both",
          itemKey: item.item_key,
          settingId: item.setting_id || undefined,
          position: item.position === "" ? undefined : item.position,
          objectType: subject.objectType,
          objectId: subject.objectId,
          objectName: subject.objectName,
          historicalStatus: "H_ORIGIN_NOT_MATCHED",
        };
      }),
    };
  });
}

function filterTargetObjects(targets, targetObjects = []) {
  if (!Array.isArray(targetObjects) || targetObjects.length === 0) return targets;
  const selected = new Set(targetObjects.map((item) => `${item.pagePath}|${item.objectType}|${item.objectId}`));
  return targets
    .map((target) => ({
      ...target,
      allowedSources: target.allowedSources.filter((source) => selected.has(`${target.pagePath}|${source.objectType}|${source.objectId}`)),
    }))
    .filter((target) => target.allowedSources.length > 0);
}

export async function loadHistoryRegressionConfig(configPath = DEFAULT_CONFIG) {
  const metadata = await readJson(resolveProjectPath(configPath));
  const base = await loadBaseConfig(metadata.baseConfig);
  const preflightIds = new Set(metadata.preflightTargetIds);
  const preflightTargets = base.targets
    .filter((target) => preflightIds.has(target.id))
    .map((target) => ({
      ...target,
      issueGroup: "preflight_validate_failed",
      allowedSources: target.allowedSources.map((source) => ({ ...source, objectType: "区块", historicalStatus: "HEADING_VALIDATE_FAILED" })),
    }));
  const states = await Promise.all(metadata.originMismatchStates.map((filename) => readJson(resolveProjectPath(filename))));
  const originTargets = filterTargetObjects(buildOriginTargets(base, states), metadata.targetObjects);
  const paths = metadata.paths;
  base.paths = {
    ...base.paths,
    userDataDir: resolveProjectPath(paths.userDataDir),
    stateFile: resolveProjectPath(paths.stateFile),
    artifactsDir: resolveProjectPath(paths.artifactsDir),
    reportsDir: resolveProjectPath(paths.reportsDir),
  };
  base.targets = [...preflightTargets, ...originTargets];
  base.validationFallback = metadata.validationFallback;
  base.pageConfirmation = metadata.pageConfirmation;
  base.reportSupplementalStateFiles = [];
  return { config: base, metadata };
}

export async function validatePlan(configPath = DEFAULT_CONFIG) {
  const { config, metadata } = await loadHistoryRegressionConfig(configPath);
  const preflight = config.targets.filter((target) => target.issueGroup === "preflight_validate_failed");
  const origin = config.targets.filter((target) => target.issueGroup === "origin_mismatch");
  const allSources = config.targets.flatMap((target) => target.allowedSources.map((source) => ({ target, source })));
  const objectKeys = new Set(allSources.map(({ target, source }) => `${target.pagePath}|${source.objectType || (target.scope === "components" ? "组件" : "区块")}|${source.objectId}`));
  const componentKeys = new Set(allSources.filter(({ target, source }) => (source.objectType || (target.scope === "components" ? "组件" : "区块")) === "组件").map(({ target, source }) => `${target.pagePath}|${source.objectId}`));
  const blockKeys = new Set(allSources.filter(({ target, source }) => (source.objectType || (target.scope === "components" ? "组件" : "区块")) === "区块").map(({ target, source }) => `${target.pagePath}|${source.objectId}`));
  const result = {
    pages: config.targets.length,
    sites: new Set(config.targets.map((target) => target.growthEngineSiteHost)).size,
    preflight_failed_pages: preflight.length,
    preflight_objects: new Set(preflight.flatMap((target) => target.allowedSources.map((source) => source.objectId))).size,
    preflight_headings: preflight.reduce((sum, target) => sum + target.allowedSources.length, 0),
    origin_mismatch_pages: origin.length,
    origin_mismatch_objects: new Set(origin.flatMap((target) => target.allowedSources.map((source) => `${target.pagePath}|${source.objectType}|${source.objectId}`))).size,
    origin_mismatch_headings: origin.reduce((sum, target) => sum + target.allowedSources.length, 0),
    objects: objectKeys.size,
    components: componentKeys.size,
    blocks: blockKeys.size,
    historical_headings: allSources.length,
    targets: config.targets.map((target) => ({ id: target.id, issue_group: target.issueGroup, page_name: target.pageName, page_path: target.pagePath, page_url: target.pageUrl, target_h: target.allowedSources.length })),
  };
  const expected = metadata.expectedContract ?? {
    pages: 16, sites: 2, preflight_failed_pages: 7, preflight_objects: 33, preflight_headings: 40,
    origin_mismatch_pages: 9, origin_mismatch_objects: 25, origin_mismatch_headings: 34,
    objects: 58, components: 7, blocks: 51, historical_headings: 74,
  };
  const mismatches = Object.entries(expected).filter(([key, value]) => result[key] !== value);
  if (mismatches.length > 0) {
    throw new Error(`history_regression_contract_failed: ${JSON.stringify({ expected, actual: result })}`);
  }
  return result;
}

function redact(value) {
  const sensitive = /authorization|token|cookie|password|secret/u;
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sensitive.test(key.toLowerCase()) ? "***" : redact(entry)]));
  return value;
}

async function readEvidence(filename) {
  if (!filename) return "";
  try { return JSON.stringify(redact(await readJson(filename)), null, 2); } catch { return ""; }
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function writeCsv(filename, rows, columns) {
  const body = [columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n");
  await writeFile(filename, `\uFEFF${body}\r\n`, "utf8");
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export async function buildHistoryRows(state, targets) {
  const headingRows = [];
  for (const target of targets) {
    const page = state.pages.find((entry) => entry.target_id === target.id);
    for (const source of target.allowedSources) {
      const item = (page?.items ?? []).find((entry) => itemMatchesSource(entry, source));
      headingRows.push({
        issue_group: target.issueGroup,
        page_name: target.pageName,
        page_path: target.pagePath,
        page_url: target.pageUrl,
        object_type: source.objectType || (target.scope === "components" ? "组件" : "区块"),
        object_id: source.objectId,
        object_name: source.objectName,
        item_key: item?.item_key || source.itemKey || "",
        setting_id: item?.setting_id || source.settingId || "",
        node_id: item?.node_id || "",
        template_id: item?.template_id || "",
        position: item?.position ?? source.position ?? "",
        original_level: item?.original_level || "",
        original_text: item?.original_text || source.sourceText,
        expected_level: item?.expected_level || "",
        expected_text: item?.expected_text || "",
        level_editable: item?.level_editable ?? "",
        text_editable: item?.text_editable ?? "",
        validate_code: item?.validate_code ?? "",
        update_code: item?.update_code ?? "",
        update_status: item?.update_item_status ?? "",
        preview_status: item?.preview_status ?? "",
        preview_level: item?.preview_level ?? "",
        preview_text: item?.preview_text ?? "",
        editor_backfill_status: item?.editor_backfill_status ?? "",
        editor_level: item?.editor_level ?? "",
        editor_text: item?.editor_text ?? "",
        regression_status: item?.regression_status || "historical_target_missing",
        failure_reason: item?.failure_reason || "当前页面未唯一匹配到该历史H设置项",
        validate_request: await readEvidence(item?.validate_request_evidence),
        validate_response: await readEvidence(item?.validate_response_evidence),
        update_request: await readEvidence(item?.update_request_evidence),
        update_response: await readEvidence(item?.update_response_evidence),
        evidence: [item?.validate_response_evidence, item?.update_response_evidence, item?.screenshot].filter(Boolean).join("\n"),
      });
    }
  }
  return headingRows;
}

async function postprocess(state, targets) {
  for (const target of targets) {
    const page = state.pages.find((entry) => entry.target_id === target.id);
    if (!page) continue;
    page.issue_group = target.issueGroup;
    for (const item of page.items ?? []) item.regression_status = regressionStatus(item, target.issueGroup);
  }
  return state;
}

async function saveState(config, state) {
  state.updated_at = new Date().toISOString();
  await mkdir(path.dirname(config.paths.stateFile), { recursive: true });
  const temporary = `${config.paths.stateFile}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, config.paths.stateFile);
}

async function loadState(config) {
  try { return await readJson(config.paths.stateFile); } catch { return null; }
}

export async function writeHistoryReports(state, config) {
  await mkdir(config.paths.reportsDir, { recursive: true });
  await postprocess(state, config.targets);
  await saveState(config, state);
  const objects = buildObjectRows(state, config.targets);
  const headings = await buildHistoryRows(state, config.targets);
  const pageRows = state.pages.map((page) => ({
    issue_group: page.issue_group,
    page_name: page.page_name,
    page_path: page.page_path,
    page_url: page.page_url,
    batch_validate_status: page.batch_validate_status,
    individual_validate_passed: page.individual_validate_passed,
    individual_validate_failed: page.individual_validate_failed,
    captured_count: page.captured_count,
    submitted_count: page.submitted_count,
    page_status: page.status,
    failure_reason: page.failure_reason,
    trace: page.trace,
    checked_at: page.checked_at,
  }));
  const apiRows = [];
  for (const page of state.pages) {
    for (const call of page.api_calls ?? []) {
      apiRows.push({
        page_path: page.page_path,
        stage: call.stage,
        url: call.url,
        http_status: call.http_status,
        business_code: call.business_code,
        request_json: await readEvidence(call.request_file),
        response_json: await readEvidence(call.response_file),
        request_file: call.request_file,
        response_file: call.response_file,
        checked_at: call.checked_at,
      });
    }
  }
  const objectColumns = ["issue_group", "object_type", "object_id", "object_name", "page_name", "page_path", "page_url", "historical_h_count", "matched_h_count", "fixed_h_count", "failed_h_count", "regression_status", "problem_description", "evidence"];
  const headingColumns = Object.keys(headings[0] ?? {});
  const pageColumns = Object.keys(pageRows[0] ?? {});
  const apiColumns = Object.keys(apiRows[0] ?? { page_path: "", stage: "", url: "", http_status: "", business_code: "", request_json: "", response_json: "", request_file: "", response_file: "", checked_at: "" });
  const fixed = objects.filter((row) => row.regression_status === "fixed_verified");
  const unresolved = objects.filter((row) => row.regression_status !== "fixed_verified");
  const differences = pageRows.filter((row) => String(row.batch_validate_status).startsWith("batch_validate_failed"));
  const automation = pageRows.filter((row) => ["page_not_found", "mapping_ambiguous", "login_expired", "automation_error", "preview_failed"].includes(row.page_status));
  await Promise.all([
    writeCsv(path.join(config.paths.reportsDir, "3.0新接口历史失败项-回归汇总.csv"), objects, objectColumns),
    writeCsv(path.join(config.paths.reportsDir, "3.0新接口历史失败项-7页预检失败结果.csv"), objects.filter((row) => row.issue_group === "preflight_validate_failed"), objectColumns),
    writeCsv(path.join(config.paths.reportsDir, "3.0新接口历史失败项-25个组件区块结果.csv"), objects.filter((row) => row.issue_group === "origin_mismatch"), objectColumns),
    writeCsv(path.join(config.paths.reportsDir, "3.0新接口历史失败项-H设置项明细.csv"), headings, headingColumns),
    writeCsv(path.join(config.paths.reportsDir, "3.0新接口历史失败项-已修复.csv"), fixed, objectColumns),
    writeCsv(path.join(config.paths.reportsDir, "3.0新接口历史失败项-仍未修复.csv"), unresolved, objectColumns),
    writeCsv(path.join(config.paths.reportsDir, "3.0新接口历史失败项-批量与单项差异.csv"), differences, pageColumns),
    writeCsv(path.join(config.paths.reportsDir, "3.0新接口历史失败项-请求响应.csv"), apiRows, apiColumns),
    writeCsv(path.join(config.paths.reportsDir, "3.0新接口历史失败项-自动化异常.csv"), automation, pageColumns),
    writeFile(path.join(config.paths.reportsDir, "3.0新接口历史失败项-运行状态.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8"),
  ]);
  const counts = objects.reduce((result, row) => ({ ...result, [row.regression_status]: (result[row.regression_status] ?? 0) + 1 }), {});
  const body = objects.map((row) => `<tr><td>${escapeHtml(row.object_type)}</td><td>${escapeHtml(row.object_id)}</td><td>${escapeHtml(row.object_name)}</td><td>${escapeHtml(row.page_path)}</td><td>${escapeHtml(row.regression_status)}</td><td>${escapeHtml(row.problem_description)}</td></tr>`).join("");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>3.0新接口H标签历史失败项回归</title><style>body{font:14px/1.5 Arial,sans-serif;margin:28px;color:#243244}table{border-collapse:collapse;width:100%}th,td{padding:8px;border-bottom:1px solid #dce3ea;text-align:left;vertical-align:top}th{background:#12304a;color:#fff}.summary{display:flex;gap:12px;margin:16px 0}.card{border:1px solid #dce3ea;padding:10px 14px}</style></head><body><h1>3.0新接口H标签历史失败项回归</h1><p>批次 ${escapeHtml(state.run_id)}，共16页、58个组件/区块、74处历史目标H。增长引擎不回填不参与判断。</p><div class="summary">${Object.entries(counts).map(([key, value]) => `<div class="card">${escapeHtml(key)}：${value}</div>`).join("")}</div><table><thead><tr><th>类型</th><th>ID</th><th>名称</th><th>页面</th><th>状态</th><th>说明</th></tr></thead><tbody>${body}</tbody></table></body></html>`;
  await writeFile(path.join(config.paths.reportsDir, "3.0新接口历史失败项-核查报告.html"), html, "utf8");
  return { objects, headings, pageRows, apiRows };
}

async function auth(config) {
  const context = await launchGrowthEngineContext(config, { auth: true });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: config.timeouts.navigationMs });
  console.log("已打开3.0历史失败项回归登录窗口，请完成登录后关闭浏览器窗口。");
  await new Promise((resolve) => context.on("close", resolve));
}

async function main() {
  const args = parseArgs(process.argv);
  const { config } = await loadHistoryRegressionConfig(args.config);
  if (args.command === "plan") {
    console.log(JSON.stringify(await validatePlan(args.config), null, 2));
    return;
  }
  if (args.command === "auth") return auth(config);
  if (["run", "resume"].includes(args.command)) {
    if (!args.apply) throw new Error("该命令会调用新接口修改3.0页面，必须显式传入 --apply");
    const state = await runBase(config, { resume: args.command === "resume", maxPages: args.maxPages, taskId: args.taskId });
    const result = await writeHistoryReports(state, config);
    console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, objects: result.objects.length, headings: result.headings.length, reports: config.paths.reportsDir }, null, 2));
    return;
  }
  const state = await loadState(config);
  if (!state) throw new Error("尚未生成3.0历史失败项回归状态");
  if (args.command === "report") {
    await writeHistoryReports(state, config);
    const { stdout } = await execFileAsync(process.execPath, [path.join(projectRoot, "scripts/build-onpage-v3-history-regression-xlsx.mjs"), "--config", args.config]);
    console.log(stdout.trim());
    return;
  }
  if (args.command === "status") {
    const objects = buildObjectRows(await postprocess(state, config.targets), config.targets);
    const counts = objects.reduce((result, row) => ({ ...result, [row.regression_status]: (result[row.regression_status] ?? 0) + 1 }), {});
    console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, pages: state.pages.length, objects: objects.length, counts }, null, 2));
    return;
  }
  throw new Error(`未知命令：${args.command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}

export { main };
