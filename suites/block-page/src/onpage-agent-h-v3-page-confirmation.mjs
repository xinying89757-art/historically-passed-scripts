#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadAgentConfig as loadBaseConfig,
  prepareRetry,
  reverifyEditor,
  run as runBase,
} from "./onpage-agent-h-v3.mjs";
import { launchGrowthEngineContext } from "./growth-engine-h-editor.mjs";
import { projectRoot } from "./config.mjs";
import { writeOnPageAgentReports } from "./onpage-agent-h-report.mjs";

const DEFAULT_CONFIG = "config/onpage-agent-h-v3-page-confirmation.json";
const execFileAsync = promisify(execFile);
const LEGACY_PATH_PATTERNS = [/^\/component-heading-test-/u, /^\/v3-current-heading-block-/u, /^\/ge-block-test-/u];

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
      console.log("node src/onpage-agent-h-v3-page-confirmation.mjs <plan|auth|run|resume|reverify-editor|status|report> [--apply] [--max-pages N]");
      process.exit(0);
    }
  }
  return result;
}

async function loadRunConfig(configPath = DEFAULT_CONFIG) {
  const metadata = JSON.parse(await readFile(resolveProjectPath(configPath), "utf8"));
  const config = await loadBaseConfig(metadata.baseConfig);
  const overrides = JSON.parse(await readFile(resolveProjectPath(metadata.addressOverrides), "utf8"));
  const byName = new Map(overrides.map((entry) => [entry.page_name, entry]));
  const targetIds = new Set(metadata.targetIds);
  const targets = config.targets.filter((target) => targetIds.has(target.id)).map((target) => {
    const override = byName.get(target.pageName);
    if (!override) throw new Error(`address_override_missing: 未找到${target.pageName}的实际地址覆盖`);
    const host = String(override.actual_site_host ?? "").trim();
    const pagePath = String(override.page_path ?? "").trim();
    const pageUrl = String(override.public_url ?? "").trim();
    if (!host || !pagePath || !pageUrl || new URL(pageUrl).pathname !== pagePath) {
      throw new Error(`address_override_invalid: ${target.pageName}的站点、路径或正式链接无效`);
    }
    const isRanking = target.pageName.startsWith("区块排名");
    const growthEngineSiteName = isRanking && host === "site.example.invalid"
      ? "3.0区块+组件"
      : target.growthEngineSiteName;
    const growthEngineSiteHost = isRanking && host === "site.example.invalid"
      ? host
      : target.growthEngineSiteHost;
    return {
      ...target,
      pagePath,
      pageUrl,
      siteId: override.actual_site_id,
      // The Growth Engine picker and the 3.0 editor can expose different
      // labels. Keep the picker identity from the historical task while
      // using the confirmed editor site for backfill and API checks.
      growthEngineSiteName,
      growthEngineSiteHost,
      apiDomain: host,
      editorSiteHost: host,
      editorSiteName: override.actual_site_name,
      editorSiteLanguage: override.actual_site_language || target.editorSiteLanguage || "英语",
      addressSource: "v3-page-address-overrides",
    };
  });
  if (targets.length !== targetIds.size) throw new Error(`target_contract_failed: 目标配置应有${targetIds.size}页，实际${targets.length}页`);
  if (new Set(targets.map((target) => target.pageUrl)).size !== targets.length) throw new Error("target_contract_failed: 页面正式链接重复");
  const paths = metadata.paths ?? {};
  config.paths.userDataDir = resolveProjectPath(paths.userDataDir);
  config.paths.stateFile = resolveProjectPath(paths.stateFile);
  config.paths.artifactsDir = resolveProjectPath(paths.artifactsDir);
  config.paths.reportsDir = resolveProjectPath(paths.reportsDir);
  config.targets = targets;
  config.pageConfirmation = { ...(metadata.pageConfirmation ?? {}), enabled: true };
  config.reportSupplementalStateFiles = [];
  return { config, metadata, overrides };
}

export async function validatePlan(configPath = DEFAULT_CONFIG) {
  const { config, overrides } = await loadRunConfig(configPath);
  const legacyPaths = config.targets.filter((target) => LEGACY_PATH_PATTERNS.some((pattern) => pattern.test(target.pagePath)));
  if (legacyPaths.length > 0) throw new Error(`target_contract_failed: 仍存在旧页面路径 ${legacyPaths.map((target) => target.pagePath).join(",")}`);
  const groups = config.targets.reduce((result, target) => {
    const key = target.scope === "components" ? "components" : target.pageName.startsWith("区块排名") ? "ranking" : "blocks";
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
  const overrideNames = new Set(overrides.map((entry) => entry.page_name));
  const missing = config.targets.filter((target) => !overrideNames.has(target.pageName));
  if (missing.length > 0) throw new Error(`address_override_missing: ${missing.map((target) => target.pageName).join(",")}`);
  return {
    targetCount: config.targets.length,
    groups,
    targets: config.targets.map((target) => ({ id: target.id, pageName: target.pageName, path: target.pagePath, url: target.pageUrl, site: target.editorSiteName, siteId: target.siteId, scope: target.scope })),
  };
}

async function auth(config) {
  const context = await launchGrowthEngineContext(config, { auth: true });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: config.timeouts.navigationMs });
  console.log("已打开3.0新接口20页专用登录窗口，请完成登录后关闭浏览器窗口。");
  await new Promise((resolve) => context.on("close", resolve));
}

async function aliasReports(config) {
  await mkdir(config.paths.reportsDir, { recursive: true });
  const aliases = {
    "onpage-agent-v3-pages.csv": "3.0新接口20页-页面结果.csv",
    "onpage-agent-v3-items.csv": "3.0新接口20页-H设置项明细.csv",
    "onpage-agent-v3-non-editable.csv": "3.0新接口20页-不可编辑.csv",
    "onpage-agent-v3-failures.csv": "3.0新接口20页-更新失败.csv",
    "onpage-agent-v3-preview-failures.csv": "3.0新接口20页-预览异常.csv",
    "onpage-agent-v3-editor-backfill-failures.csv": "3.0新接口20页-编辑器回填异常.csv",
    "onpage-agent-v3-api-calls.csv": "3.0新接口20页-请求响应明细.csv",
    "onpage-agent-v3-run-state.json": "3.0新接口20页-运行状态.json",
    "onpage-agent-v3-report.html": "3.0新接口20页-核查报告.html",
  };
  for (const [source, target] of Object.entries(aliases)) {
    await copyFile(path.join(config.paths.reportsDir, source), path.join(config.paths.reportsDir, target)).catch(() => {});
  }
  const state = await loadState(config);
  if (!state) return;
  const cell = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const writeRows = async (filename, rows, columns) => {
    const body = [columns.join(","), ...rows.map((row) => columns.map((column) => cell(row[column])).join(","))].join("\r\n");
    await writeFile(path.join(config.paths.reportsDir, filename), `\uFEFF${body}\r\n`, "utf8");
  };
  const items = state.pages.flatMap((page) => page.items ?? []);
  const pageRows = state.pages.filter((page) => page.status !== "complete");
  await writeRows("3.0新接口20页-映射异常.csv", items.filter((item) => ["mapping_ambiguous", "origin_mismatch"].includes(item.status)), ["page_name", "page_path", "page_url", "item_index", "item_key", "setting_id", "original_level", "original_text", "status", "failure_reason", "request_evidence", "response_evidence"]);
  await writeRows("3.0新接口20页-页面异常.csv", pageRows.map((page) => ({ ...page, status: page.status, failure_reason: page.failure_reason })), ["page_name", "page_path", "page_url", "status", "captured_count", "submitted_count", "failure_reason", "trace", "checked_at"]);
  await writeRows("3.0新接口20页-更新失败.csv", items.filter((item) => ["update_failed", "response_mismatch", "origin_mismatch"].includes(item.status)), ["page_name", "page_path", "page_url", "item_index", "item_key", "original_level", "original_text", "expected_level", "expected_text", "status", "failure_reason", "request_evidence", "response_evidence"]);
}

async function loadState(config) {
  try { return JSON.parse(await readFile(config.paths.stateFile, "utf8")); } catch { return null; }
}

async function main() {
  const args = parseArgs(process.argv);
  const { config } = await loadRunConfig(args.config);
  if (args.command === "plan") {
    console.log(JSON.stringify(await validatePlan(args.config), null, 2));
    return;
  }
  if (args.command === "auth") return auth(config);
  if (["run", "resume", "retry-failed"].includes(args.command)) {
    if (!args.apply) throw new Error("该命令会调用新接口修改3.0页面，必须显式传入 --apply");
    let resume = args.command !== "run";
    if (args.command === "retry-failed") {
      const current = await loadState(config);
      if (!current) throw new Error("尚未生成3.0新接口20页任务状态");
      await prepareRetry(config, current);
      resume = true;
    }
    const state = await runBase(config, { resume, maxPages: args.maxPages, taskId: args.taskId });
    await aliasReports(config);
    console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, pages: state.pages.map((page) => ({ path: page.page_path, status: page.status, items: page.items.length, reason: page.failure_reason })) }, null, 2));
    return;
  }
  const state = await loadState(config);
  if (!state) throw new Error("尚未生成3.0新接口20页任务状态");
  if (args.command === "reverify-editor") {
    await reverifyEditor(config, state, args.taskId);
    await aliasReports(config);
    return;
  }
  if (args.command === "report") {
    await writeOnPageAgentReports(state, config.paths.reportsDir);
    await aliasReports(config);
    await execFileAsync(process.execPath, [path.join(projectRoot, "scripts/build-v3-page-confirmation-xlsx.mjs")]);
    console.log(config.paths.reportsDir);
    return;
  }
  if (args.command === "status") {
    console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, pages: state.pages.map((page) => ({ path: page.page_path, status: page.status, captured: page.captured_count, submitted: page.submitted_count, reason: page.failure_reason })) }, null, 2));
    return;
  }
  throw new Error(`未知命令：${args.command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

export { loadRunConfig, main };
