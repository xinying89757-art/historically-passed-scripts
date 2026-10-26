#!/usr/bin/env node
import readline from "node:readline/promises";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { launchEditorBrowser } from "./editor.mjs";
import { readOnlineWorkbookFromConfig } from "./v3-online-input.mjs";
import { writeOnlineReports } from "./v3-online-report.mjs";
import { runV3FullAdd } from "./v3-full-runner.mjs";
import { runV3FullHeadings } from "./v3-full-heading-runner.mjs";
import { loadOrCreateV3FullState, summarizeV3FullState } from "./v3-full-state.mjs";

const PROJECT_ROOT = path.resolve(new URL("..", import.meta.url).pathname);

function resolvePath(value) {
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

function parseArgs(argv) {
  const command = argv[2] ?? "status";
  const options = {};
  for (let index = 3; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) { options[key] = next; index += 1; } else options[key] = true;
  }
  return { command, options };
}

function requireApply(options) {
  if (!options.apply) throw new Error("写入命令必须显式传入 --apply");
}

function cleanSiteName(value) {
  return String(value ?? "")
    .replace(/\s*(授权服务商管理|查看已授权员工|编辑网站|内容管理|智慧数据)\s*.*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

async function loadBaseConfig(options) {
  const config = await loadConfig(options.config ?? "config/v3-online-heading.json");
  config.v3OnlineWorkbook = resolvePath(config.v3OnlineWorkbook);
  config.v3OnlineSiteFile = resolvePath(config.v3OnlineSiteFile);
  config.v3OnlineStateFile = resolvePath(config.v3OnlineStateFile);
  config.v3OnlineReportsDir = resolvePath(config.v3OnlineReportsDir);
  config.v3OnlineArtifactsDir = resolvePath(config.v3OnlineArtifactsDir);
  config.paths.v3FullStateFile = config.v3OnlineStateFile;
  config.paths.v3FullArtifactsDir = config.v3OnlineArtifactsDir;
  config.paths.v3FullReportsDir = resolvePath("reports/v3-online-heading/.internal");
  config.browser.proxy = null;
  return config;
}

async function readSiteFile(config) {
  try {
    return JSON.parse(await readFile(config.v3OnlineSiteFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("尚未记录目标网站，请先运行 npm run v3:online:auth，并登录后进入目标3.0编辑器");
    throw error;
  }
}

function siteCardFromClick(card) {
  const lines = String(card?.innerText ?? "").split(/\n+/u).map((line) => line.trim()).filter(Boolean);
  const ignored = /^(编辑网站|内容管理|智慧数据|授权服务商管理|查看已授权员工)$/u;
  const siteName = cleanSiteName(lines.find((line) => !ignored.test(line) && !/^https?:\/\//u.test(line) && !/^(英语|中文|日语|韩语|阿拉伯语)$/u.test(line)) ?? "");
  const activeLanguage = card?.querySelector?.(".lansSelect .lanItem.on")?.textContent?.trim() ?? "";
  const publicLink = [...(card?.querySelectorAll?.("a[href]") ?? [])]
    .map((anchor) => anchor.href || anchor.getAttribute("href") || "")
    .find((href) => /^https?:\/\/(?!www\.leadong\.com)/u.test(href)) ?? "";
  const attrs = {};
  for (const attribute of card?.attributes ?? []) attrs[attribute.name] = attribute.value;
  const siteId = Object.entries(attrs).find(([key]) => /(site|sid|app|id)/iu.test(key))?.[1] ?? "";
  return { site_name: siteName, site_language: activeLanguage, site_id: siteId, public_base_url: publicLink.replace(/\/$/u, "") };
}

async function installSiteSelectionCapture(page) {
  await page.evaluate(() => {
    if (window.__codexSiteCaptureInstalled) return;
    window.__codexSiteCaptureInstalled = true;
    window.__codexSelectedSite = null;
    document.addEventListener("click", (event) => {
      const target = event.target?.closest?.(".mySiteBox .userEditSite, .userEditSite");
      if (!target) return;
      const card = target.closest(".mySiteBox") ?? target.parentElement;
      const lines = String(card?.innerText ?? "").split(/\n+/u).map((line) => line.trim()).filter(Boolean);
      const ignored = /^(编辑网站|内容管理|智慧数据|授权服务商管理|查看已授权员工)$/u;
      const siteName = String(lines.find((line) => !ignored.test(line) && !/^https?:\/\//u.test(line) && !/^(英语|中文|日语|韩语|阿拉伯语)$/u.test(line)) ?? "")
        .replace(/\s*(授权服务商管理|查看已授权员工|编辑网站|内容管理|智慧数据)\s*.*$/u, "")
        .replace(/\s+/gu, " ")
        .trim();
      const siteLanguage = card?.querySelector?.(".lansSelect .lanItem.on")?.textContent?.trim() ?? "";
      const publicBaseUrl = [...(card?.querySelectorAll?.("a[href]") ?? [])].map((anchor) => anchor.href || anchor.getAttribute("href") || "").find((href) => /^https?:\/\/(?!www\.leadong\.com)/u.test(href)) ?? "";
      const attributes = Object.fromEntries([...((card?.attributes) ?? [])].map((attribute) => [attribute.name, attribute.value]));
      const siteId = Object.entries(attributes).find(([key]) => /(site|sid|app|id)/iu.test(key))?.[1] ?? "";
      window.__codexSelectedSite = { site_name: siteName, site_language: siteLanguage, site_id: siteId, public_base_url: publicBaseUrl.replace(/\/$/u, ""), clicked_at: new Date().toISOString() };
    }, true);
  });
}

async function auth(options) {
  const config = await loadBaseConfig(options);
  const { context, page } = await launchEditorBrowser(config, { headless: false, slowMo: 80 });
  try {
    await page.goto("https://www.leadong.com/website.html", { waitUntil: "commit", timeout: 60000 }).catch((error) => {
      if (!/ERR_ABORTED|Navigation interrupted/u.test(error.message)) throw error;
    });
    let captureTimer;
    await installSiteSelectionCapture(page).catch(() => {});
    captureTimer = setInterval(() => {
      installSiteSelectionCapture(page).catch(() => {});
    }, 800);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("请登录并选择目标网站/语言，点击“编辑网站”进入3.0编辑器；完成后按回车记录状态：");
    rl.close();
    clearInterval(captureTimer);
    await installSiteSelectionCapture(page).catch(() => {});
    const selected = await page.evaluate(() => window.__codexSelectedSite).catch(() => null);
    const editorPage = context.pages().find((candidate) => !candidate.isClosed() && candidate.url().includes("/phoenix/pagebuilder"));
    if (!editorPage) throw new Error("未检测到已打开的3.0编辑器页面，请先点击目标网站的“编辑网站”");
    const observed = selected ?? await editorPage.evaluate(() => ({ site_name: "", site_language: "", site_id: "", public_base_url: "" })).catch(() => null);
    const site = {
      ...(observed ?? {}),
      editor_url: editorPage.url(),
      proxy: null,
      captured_at: new Date().toISOString(),
    };
    if (!site.site_name || !site.site_language || !site.public_base_url || !site.editor_url) {
      throw new Error(`网站状态不完整，未保存：${JSON.stringify(site)}`);
    }
    await atomicJson(config.v3OnlineSiteFile, site);
    process.stdout.write(`${JSON.stringify(site, null, 2)}\n`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function createRunContext(options) {
  const config = await loadBaseConfig(options);
  const site = await readSiteFile(config);
  config.siteName = site.site_name;
  config.siteLanguage = site.site_language;
  config.publicBaseUrl = site.public_base_url;
  config.siteConfirmationHost = new URL(site.public_base_url).host;
  // Always enter from the portal so the recorded site name/language selects
  // the same website even when the editor URL itself is a generic pagebuilder URL.
  config.editorUrl = "https://www.leadong.com/website.html";
  const input = await readOnlineWorkbookFromConfig(config);
  const { state, store } = await loadOrCreateV3FullState(input, config);
  if (state.site && (state.site.public_base_url !== site.public_base_url || state.site.site_name !== site.site_name)) {
    throw new Error("当前网站与已有批次状态不一致，拒绝继续以免写入错误网站");
  }
  state.site = site;
  state.kind = "v3_online_heading";
  state.phase = state.phase === "completed" ? "completed" : (state.phase ?? "planned");
  await store.save(state);
  return { config, input, state, store };
}

function summary(state) {
  const count = (predicate) => state.records.filter(predicate).length;
  return {
    phase: state.phase,
    site: state.site,
    total: state.records.length,
    added: count((record) => ["added_new", "existing_added"].includes(record.status)),
    pending: count((record) => record.status === "pending"),
    not_found: count((record) => record.status === "not_found"),
    render_failed: count((record) => record.status === "render_failed"),
    heading_configured: count((record) => record.heading_status === "configured_verified"),
    heading_unsupported: count((record) => record.heading_status === "unsupported_no_h_control"),
    heading_failed: count((record) => ["heading_failed", "save_failed"].includes(record.heading_status)),
  };
}

async function prepareRetryState(run) {
  const { config, state, store } = run;
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const backupPath = `${config.v3OnlineStateFile}.before-retry-${stamp}.bak`;
  await copyFile(config.v3OnlineStateFile, backupPath);
  const reset = [];
  for (const record of state.records) {
    if (["not_found", "add_failed", "render_failed", "locator_ambiguous"].includes(record.status)) {
      reset.push({
        block_id: record.block_id,
        stage: "add",
        from: record.status,
        reason: record.failure_reason ?? "",
      });
      record.retry_history = [
        ...(record.retry_history ?? []),
        {
          at: new Date().toISOString(),
          stage: "add",
          status: record.status,
          reason: record.failure_reason ?? "",
        },
      ];
      Object.assign(record, {
        page_name: "",
        page_url: "",
        slot_index: "",
        editor_dom_id: "",
        status: "pending",
        failure_reason: "",
        audit: null,
        heading_status: "pending",
        heading_results: [],
        heading_poc: [],
        heading_failure_reason: "",
        heading_verified_at: "",
      });
      continue;
    }
    if (
      ["added_new", "existing_added"].includes(record.status) &&
      ["heading_failed", "save_failed"].includes(record.heading_status)
    ) {
      reset.push({
        block_id: record.block_id,
        stage: "heading",
        from: record.heading_status,
        reason: record.heading_failure_reason ?? "",
      });
      record.retry_history = [
        ...(record.retry_history ?? []),
        {
          at: new Date().toISOString(),
          stage: "heading",
          status: record.heading_status,
          reason: record.heading_failure_reason ?? "",
        },
      ];
      Object.assign(record, {
        heading_status: "pending",
        heading_results: [],
        heading_poc: [],
        heading_failure_reason: "",
        heading_verified_at: "",
      });
    }
  }
  state.retry_mode = {
    prepared_at: new Date().toISOString(),
    backup_path: backupPath,
    reset_records: reset,
  };
  state.phase = "retrying";
  await store.save(state);
  return { backupPath, reset };
}

async function runAll(run, options = {}) {
  const { config, state, store } = run;
  if (state.records.some((record) => ["pending", "staged"].includes(record.status)) || state.current_page) {
    state.phase = "adding";
    await store.save(state);
    await runV3FullAdd({ ...run, maxPages: 0, maxBlocks: 0, headless: false });
  }
  if (state.records.some((record) => ["added_new", "existing_added"].includes(record.status) && !["configured_verified", "unsupported_no_h_control", "heading_failed", "save_failed"].includes(record.heading_status))) {
    state.phase = "heading";
    await store.save(state);
    const writeMode = options.fast ? "ckeditor_api" : "ui";
    await runV3FullHeadings({ ...run, maxPages: 0, headless: false, writeMode });
  }
  state.phase = state.records.some((record) =>
    ["pending", "staged", "not_found", "add_failed", "render_failed", "locator_ambiguous", "save_failed"].includes(record.status) ||
    ["heading_failed", "save_failed"].includes(record.heading_status)
  ) ? "completed_with_failures" : "completed";
  await store.save(state);
  const counts = await writeOnlineReports(state, config.v3OnlineReportsDir);
  return { summary: summary(state), report_counts: counts };
}

async function main() {
  const { command, options } = parseArgs(process.argv);
  if (command === "auth") return auth(options);
  if (command === "plan") {
    const config = await loadBaseConfig(options);
    const input = await readOnlineWorkbookFromConfig(config);
    process.stdout.write(`${JSON.stringify({ workbook: input.inputWorkbook, records: input.records.length, excluded: input.excluded.length, expectedPages: Math.ceil(input.records.length / config.blocksPerPage), typeCounts: input.records.reduce((counts, record) => { for (const type of record.template_types) counts[type] = (counts[type] ?? 0) + 1; return counts; }, {}) }, null, 2)}\n`);
    return;
  }
  if (["run", "resume", "retry"].includes(command)) {
    requireApply(options);
    const run = await createRunContext(options);
    if (command === "retry") {
      const prepared = await prepareRetryState(run);
      process.stdout.write(`${JSON.stringify({ retry_prepared: prepared }, null, 2)}\n`);
    }
    const result = await runAll(run, options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const run = await createRunContext(options);
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(summary(run.state), null, 2)}\n`);
    return;
  }
  if (command === "report") {
    await writeOnlineReports(run.state, run.config.v3OnlineReportsDir);
    process.stdout.write(`${run.config.v3OnlineReportsDir}\n`);
    return;
  }
  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  process.stderr.write(`\n失败：${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
