import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LeadongEditor, launchEditorBrowser, stopTrace } from "./editor.mjs";
import { loadConfig, projectRoot } from "./config.mjs";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const DEFAULT_CONFIG = path.resolve(projectRoot, "config/v3-page-address-confirmation.json");
const TARGET_STATUSES = new Set(["page_not_found"]);
const now = () => new Date().toISOString();
const normalize = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
const hostToPublic = (host) => {
  const value = String(host ?? "").trim().replace(/^https?:\/\//iu, "").replace(/\/$/u, "");
  return value ? `http://${value}` : "";
};
const publicUrl = (host, pagePath) => {
  const base = hostToPublic(host);
  if (!base || !pagePath) return "";
  return new URL(pagePath.startsWith("/") ? pagePath : `/${pagePath}`, `${base}/`).toString();
};

async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }
async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function candidateSites(sourceTargets) {
  const map = new Map();
  for (const target of sourceTargets) {
    const key = [target.editor_site_name, target.editor_site_language, target.growth_engine_site_host].join("|");
    if (!map.has(key)) map.set(key, {
      siteName: target.editor_site_name,
      siteLanguage: target.editor_site_language,
      host: target.growth_engine_site_host,
    });
  }
  return [...map.values()];
}

function baseEditorConfig(config, site) {
  return {
    ...config,
    siteName: site.siteName,
    siteLanguage: site.siteLanguage || "英语",
    publicBaseUrl: hostToPublic(site.host),
    paths: {
      ...config.paths,
      userDataDir: path.resolve(projectRoot, config.auth.userDataDir),
    },
    selectors: {
      ...(config.selectors ?? {}),
      siteCardSelector: ".mySiteBox",
      siteLanguageSelector: ".lansSelect .lanItem",
      editSiteSelector: ".userEditSite",
      editorFrameUrlIncludes: "/phoenix/pagebuilder?",
      pageMenuTexts: ["^页面\\s*[:：]"],
      customPageTexts: ["^自定义页面$"],
      pageNameLabels: ["页面名称", "名称"],
      pageNamePlaceholders: ["请输入页面名称", "页面名称"],
      pagePathLabels: ["页面地址", "页面路径", "URL"],
      pagePathPlaceholders: ["请输入页面地址", "请输入页面路径", "页面地址", "页面路径"],
    },
  };
}

async function menuCandidates(editor, pageName) {
  await editor.openPageMenu();
  await editor.clickCustomPageTab();
  const menu = editor.page.locator("#backstage_select_pages").first();
  await menu.waitFor({ state: "visible", timeout: editor.config.timeouts.actionMs });
  // Page rows contain a single canonical anchor (`a.name`) whose `pageurl`
  // attribute is the editor's source of truth for the public path.  Matching
  // every descendant by text creates false duplicates because the row and its
  // anchor both contain the same page name.
  const rows = await menu.locator("a.name").evaluateAll((elements, name) => elements
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => (element.textContent || "").replace(/\s+/g, " ").trim() === name)
    .map(({ element, index }) => {
      const chain = [];
      let current = element;
      for (let i = 0; current && i < 5; i += 1, current = current.parentElement) {
        const attrs = {};
        for (const attr of current.attributes || []) attrs[attr.name] = attr.value;
        chain.push({ tag: current.tagName.toLowerCase(), text: (current.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300), attrs });
      }
      return { index, chain, pageurl: element.getAttribute("pageurl") || "", editor_href: element.getAttribute("data-href") || "" };
    }), pageName);
  return { menu, rows };
}

async function clickPageFromMenu(editor, pageName) {
  const { menu, rows } = await menuCandidates(editor, pageName);
  if (rows.length === 0) throw new Error(`not_found_all_sites: 当前站点未找到页面“${pageName}”`);
  if (rows.length !== 1) throw new Error(`duplicate_candidates: 页面名称“${pageName}”在当前站点匹配 ${rows.length} 项`);
  const target = menu.locator("a.name").nth(rows[0].index);
  await target.click();
  await editor.page.keyboard.press("Escape").catch(() => {});
  await editor.waitForPageLoaded(pageName);
  await editor.dismissPageMenu().catch(() => {});
  return rows;
}

function extractPathFromRows(rows, fallbackPath) {
  // The page row's `pageurl` is canonical. Do not mix it with `data-href`,
  // which is only the internal editor route and would make the path appear
  // ambiguous.
  const canonical = rows.map((row) => row.pageurl).filter(Boolean).map((value) => {
    try { return new URL(value).pathname; } catch { return ""; }
  }).filter(Boolean);
  const canonicalUnique = [...new Set(canonical)];
  if (canonicalUnique.length === 1) return canonicalUnique[0];
  const values = [];
  for (const row of rows) {
    for (const item of row.chain ?? []) {
      for (const [key, value] of Object.entries(item.attrs ?? {})) {
        if (!/^(?:pageurl|page_path|pagepath|url)$/iu.test(key)) continue;
        const match = String(value).match(/\/(?:[A-Za-z0-9_.~-]+\/)*[A-Za-z0-9_.~-]+(?:\.html)?/u);
        if (match) values.push(match[0]);
      }
      const textMatches = String(item.text ?? "").match(/\/(?:[A-Za-z0-9_.~-]+\/)*[A-Za-z0-9_.~-]+(?:\.html)?/gu) ?? [];
      values.push(...textMatches);
    }
  }
  const unique = [...new Set(values.map((v) => v.startsWith("/") ? v : `/${v}`))];
  return unique.length === 1 ? unique[0] : "";
}

function classifyCandidateError(error) {
  const message = String(error?.message ?? error);
  if (/duplicate_candidates/iu.test(message)) return "duplicate_candidates";
  if (/name_found_path_unresolved/iu.test(message)) return "name_found_path_unresolved";
  if (/not_found_all_sites/iu.test(message)) return "not_found_all_sites";
  if (/登录|login|site.*not found/iu.test(message)) return "site_unavailable";
  return "automation_error";
}

async function capturePreviewUrl(editor) {
  const scopes = [editor.page, ...editor.page.frames().filter((frame) => frame !== editor.page.mainFrame())];
  const candidates = [];
  for (const scope of scopes) {
    for (const locator of [scope.getByText("预览", { exact: true }), scope.getByText("预览网站", { exact: true }), scope.locator("[title*='预览'],[aria-label*='预览']")]) {
      const count = await locator.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) if (await locator.nth(i).isVisible().catch(() => false)) candidates.push(locator.nth(i));
    }
  }
  const unique = [];
  for (const candidate of candidates) if (!unique.some((item) => item === candidate)) unique.push(candidate);
  if (unique.length !== 1) throw new Error(unique.length === 0 ? "name_found_path_unresolved: 未找到预览入口" : `duplicate_candidates: 预览入口匹配 ${unique.length} 项`);
  const known = new Set(editor.page.context().pages());
  const popupPromise = editor.page.context().waitForEvent("page", { timeout: editor.config.timeouts.actionMs }).catch(() => null);
  await unique[0].click({ force: true });
  const popup = await popupPromise;
  if (!popup) throw new Error("name_found_path_unresolved: 点击预览后未打开新页签");
  await popup.waitForLoadState("domcontentloaded").catch(() => {});
  await popup.waitForTimeout(800);
  const url = popup.url();
  await popup.close().catch(() => {});
  if (known.has(popup) || !/^https?:/iu.test(url)) throw new Error("name_found_path_unresolved: 预览页 URL 无效");
  // The editor may open its own internal preview route in the same host. It
  // is not a public page address and must never be reported as the site's URL.
  const parsed = new URL(url);
  if (parsed.hostname === "website.leadong.com" || /\/phoenix\/pagebuilder(?:\/|$)/iu.test(parsed.pathname)) {
    throw new Error("name_found_path_unresolved: 预览页仍是编辑器内部地址");
  }
  return url;
}

async function checkPublic(context, url) {
  if (!url) return { status: "not_checked", httpStatus: null, finalUrl: "" };
  try {
    const response = await context.request.get(`${url}${url.includes("?") ? "&" : "?"}address_check=${Date.now()}`, { timeout: 30000, failOnStatusCode: false });
    return { status: response.ok() ? "http_ok" : (response.status() === 404 ? "http_404" : "http_failed"), httpStatus: response.status(), finalUrl: response.url() };
  } catch (error) {
    return { status: "http_failed", httpStatus: null, finalUrl: "", error: error.message };
  }
}

async function plan(config, source) {
  const targets = source.pages.filter((item) => TARGET_STATUSES.has(item.status));
  const state = { version: 1, run_id: `address-${Date.now()}`, phase: "planned", created_at: now(), updated_at: now(), source_state_file: config.sourceStateFile, sites: candidateSites(targets), targets: targets.map((item) => ({ module: item.growth_engine_site_name, page_name: item.page_name, page_path: item.page_path, page_url: item.page_url, historical_site_host: item.growth_engine_site_host, status: "pending", candidates: [] })) };
  await writeJson(config.paths.stateFile, state);
  console.log(JSON.stringify({ run_id: state.run_id, target_count: state.targets.length, site_count: state.sites.length, sites: state.sites }, null, 2));
}

async function run(config, source, { resume = false } = {}) {
  await mkdir(path.resolve(projectRoot, config.paths.artifactsDir), { recursive: true });
  const state = resume ? await readJson(config.paths.stateFile) : await readJson(config.paths.stateFile).catch(() => null);
  const targets = source.pages.filter((item) => TARGET_STATUSES.has(item.status));
  const initial = state?.targets?.length ? state : { version: 1, run_id: `address-${Date.now()}`, phase: "running", created_at: now(), updated_at: now(), source_state_file: config.sourceStateFile, sites: candidateSites(targets), targets: targets.map((item) => ({ module: item.growth_engine_site_name, page_name: item.page_name, page_path: item.page_path, page_url: item.page_url, historical_site_host: item.growth_engine_site_host, status: "pending", candidates: [] })) };
  initial.phase = "running"; initial.updated_at = now(); await writeJson(config.paths.stateFile, initial);
  const grouped = new Map();
  for (const target of targets) {
    const row = initial.targets.find((item) => item.page_name === target.page_name && item.page_path === target.page_path);
    if (!row || (resume && ["confirmed_exact", "found_in_other_site", "duplicate_candidates", "path_corrected", "name_found_path_unresolved", "not_found_all_sites"].includes(row.status))) continue;
    const siteList = initial.sites.filter((site) => !row.historical_site_host || site.host);
    for (const site of siteList) {
      const key = [site.siteName, site.siteLanguage, site.host].join("|");
      if (!grouped.has(key)) grouped.set(key, { site, rows: [] });
      grouped.get(key).rows.push({ target, row });
    }
  }
  for (const { site, rows } of grouped.values()) {
    const editorConfig = baseEditorConfig(config, site);
    let browser;
    try { browser = await launchEditorBrowser(editorConfig, { traceName: `v3-page-address-${site.siteName}` }); await browser.page.goto(editorConfig.editorUrl, { waitUntil: "domcontentloaded", timeout: editorConfig.timeouts.navigationMs });
      const continueLogin = browser.page.getByText("继续登录", { exact: true });
      if (await continueLogin.isVisible().catch(() => false)) await continueLogin.click();
      // Capture the language-specific encoded site id from the portal card;
      // this is useful evidence, but never used as a locator or write key.
      const card = browser.page.locator(editorConfig.selectors.siteCardSelector).filter({ hasText: site.siteName }).first();
      site.site_id = await card.locator(`${editorConfig.selectors.editSiteSelector}[l='0']`).first().getAttribute("encodepkid").catch(() => "") || "";
      const editor = new LeadongEditor(browser.page, editorConfig); await editor.goto();
      for (const { target, row } of rows) {
        const candidate = { site_name: site.siteName, site_language: site.siteLanguage, site_host: site.host, found: false, page_name: target.page_name, page_path: "", editor_url: "", preview_url: "", status: "not_found_all_sites", checked_at: now(), evidence: {} };
        try {
          const rowsMeta = await clickPageFromMenu(editor, target.page_name);
          candidate.found = true; candidate.editor_url = editor.page.url(); candidate.page_path = extractPathFromRows(rowsMeta, "");
          candidate.evidence = { pageurl: rowsMeta[0]?.pageurl ?? "", editor_href: rowsMeta[0]?.editor_href ?? "", source: rowsMeta[0]?.pageurl ? "a.name[pageurl]" : "" };
          if (!candidate.page_path) { candidate.preview_url = await capturePreviewUrl(editor); candidate.page_path = new URL(candidate.preview_url).pathname; }
          const previewHost = candidate.preview_url ? new URL(candidate.preview_url).hostname.replace(/\.preview\.leadong\.com$/iu, ".ldmfyh.com") : "";
          candidate.actual_host = previewHost || site.host;
          candidate.site_id = site.site_id || "";
          candidate.public_url = publicUrl(candidate.actual_host, candidate.page_path);
          Object.assign(candidate, await checkPublic(browser.context, candidate.public_url));
          candidate.status = site.host !== target.growth_engine_site_host ? "found_in_other_site" : (candidate.page_path !== target.page_path ? "path_corrected" : "confirmed_exact");
          candidate.screenshot = path.join(config.paths.artifactsDir, `${site.siteName}-${target.page_name}.png`);
          await editor.page.screenshot({ path: path.resolve(projectRoot, candidate.screenshot), fullPage: false }).catch(() => {});
        } catch (error) { candidate.status = classifyCandidateError(error); candidate.error = error.message; }
        row.candidates = [...(row.candidates ?? []), candidate];
        await writeJson(config.paths.stateFile, initial);
      }
    } catch (error) {
      for (const { row } of rows) { row.candidates = [...(row.candidates ?? []), { site_name: site.siteName, site_language: site.siteLanguage, site_host: site.host, status: /登录|login/iu.test(error.message) ? "login_expired" : "site_unavailable", error: error.message, checked_at: now() }]; await writeJson(config.paths.stateFile, initial); }
    } finally {
      if (browser) {
        const traceFile = path.resolve(projectRoot, config.paths.artifactsDir, `trace-${site.siteName}.zip`);
        await stopTrace(browser.context, traceFile).catch(() => {});
        await browser.context.close().catch(() => {});
      }
    }
  }
  for (const row of initial.targets) {
    const candidates = row.candidates ?? [];
    const found = candidates.filter((item) => ["confirmed_exact", "found_in_other_site", "path_corrected"].includes(item.status));
    row.status = found.length === 1 ? found[0].status : (found.length > 1 ? "duplicate_candidates" : (candidates.some((item) => item.status === "name_found_path_unresolved") ? "name_found_path_unresolved" : (candidates.length > 0 && candidates.every((item) => ["site_unavailable", "login_expired"].includes(item.status)) ? "site_unavailable" : "not_found_all_sites")));
    if (found.length === 1) Object.assign(row, { actual_site_name: found[0].site_name, actual_site_language: found[0].site_language, actual_site_id: found[0].site_id ?? "", actual_site_host: found[0].actual_host || found[0].site_host, actual_page_path: found[0].page_path, actual_public_url: found[0].public_url ?? "", actual_preview_url: found[0].preview_url ?? "", address_source: found[0].preview_url ? "editor_preview" : "editor_page_menu", http_status: found[0].httpStatus ?? null, http_status_detail: found[0].status });
  }
  initial.phase = initial.targets.every((row) => row.status !== "pending") ? "complete" : "partial"; initial.updated_at = now(); await writeJson(config.paths.stateFile, initial); console.log(JSON.stringify({ run_id: initial.run_id, phase: initial.phase, statuses: initial.targets.reduce((a, x) => (a[x.status] = (a[x.status] ?? 0) + 1, a), {}) }, null, 2));
}

async function main() {
  const command = process.argv[2] ?? "plan"; const configPath = process.argv.includes("--config") ? process.argv[process.argv.indexOf("--config") + 1] : DEFAULT_CONFIG; const config = await loadConfig(configPath); config.sourceStateFile = path.resolve(projectRoot, config.sourceStateFile); config.paths.stateFile = path.resolve(projectRoot, config.paths.stateFile); config.auth.userDataDir = path.resolve(projectRoot, config.auth.userDataDir); const source = await readJson(config.sourceStateFile);
  if (command === "plan") return plan(config, source); if (command === "run") return run(config, source); if (command === "resume") return run(config, source, { resume: true }); if (command === "status") { const state = await readJson(config.paths.stateFile); console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, statuses: state.targets.reduce((a, x) => (a[x.status] = (a[x.status] ?? 0) + 1, a), {}), targets: state.targets }, null, 2)); return; } if (command === "report") return buildReports(config, await readJson(config.paths.stateFile)); throw new Error(`未知命令：${command}`);
}

async function buildReports(config, state) {
  const reportDir = path.resolve(projectRoot, config.paths.reportsDir); const artifactDir = path.resolve(projectRoot, config.paths.artifactsDir); await mkdir(reportDir, { recursive: true }); await mkdir(artifactDir, { recursive: true });
  const rows = state.targets;
  const headers = ["模块","页面名称","历史页面路径","历史页面链接","历史站点域名","实际站点名称","实际站点语言","实际站点ID","实际页面路径","实际正式链接","实际预览链接","地址来源","HTTP状态","核查状态","问题说明"];
  const issueDescription = (row) => {
    if (row.status === "path_corrected") return `编辑器页面名称匹配成功，但实际页面路径为 ${row.actual_page_path}，与历史路径 ${row.page_path} 不一致`;
    if (row.status === "found_in_other_site") return `页面在其他3.0站点“${row.actual_site_name}”中找到，历史站点为“${row.historical_site_host}”`;
    return row.candidates?.map((x) => x.error).filter(Boolean).join("；") ?? "";
  };
  const summaryRows = rows.map((row) => [row.module,row.page_name,row.page_path,row.page_url,row.historical_site_host,row.actual_site_name ?? "",row.actual_site_language ?? "",row.actual_site_id ?? "",row.actual_page_path ?? "",row.actual_public_url ?? "",row.actual_preview_url ?? "",row.address_source ?? "",row.http_status ?? "",row.status,issueDescription(row)]);
  const csvText = (head, data) => [head, ...data].map((line) => line.map((v) => `"${String(v ?? "").replaceAll('"','""')}"`).join(",")).join("\n") + "\n";
  await writeFile(path.join(reportDir, "3.0页面实际地址确认-汇总.csv"), csvText(headers, summaryRows), "utf8");
  const candidateHeaders = ["页面名称","候选站点","站点语言","站点ID","站点域名","是否找到","匹配状态","页面路径","候选正式链接","编辑器URL","HTTP状态","错误信息","核查时间","截图"];
  const candidateRows = rows.flatMap((row) => (row.candidates ?? []).map((c) => [row.page_name,c.site_name ?? "",c.site_language ?? "",c.site_id ?? "",c.actual_host ?? c.site_host ?? "",c.found ? "是" : "否",c.status ?? "",c.page_path ?? "",c.public_url ?? "",c.editor_url ?? "",c.httpStatus ?? "",c.error ?? "",c.checked_at ?? "",c.screenshot ?? ""]));
  await writeFile(path.join(reportDir, "3.0页面实际地址确认-站点候选.csv"), csvText(candidateHeaders, candidateRows), "utf8");
  const evidenceHeaders = ["页面名称","候选站点","页面路径","pageurl来源","编辑器页面URL","预览URL","截图","HTTP状态","状态","核查时间"];
  const evidenceRows = rows.flatMap((row) => (row.candidates ?? []).map((c) => [row.page_name,c.site_name ?? "",c.page_path ?? "",c.evidence?.pageurl ?? c.public_url ?? "",c.editor_url ?? "",c.preview_url ?? "",c.screenshot ?? "",c.httpStatus ?? "",c.status ?? "",c.checked_at ?? ""]));
  await writeFile(path.join(reportDir, "3.0页面实际地址确认-页面证据.csv"), csvText(evidenceHeaders, evidenceRows), "utf8");
  const unresolved = rows.filter((row) => !["confirmed_exact","found_in_other_site","path_corrected"].includes(row.status));
  const unresolvedHeaders = ["页面名称","历史页面路径","历史页面链接","历史站点域名","核查状态","问题说明","候选数量"];
  await writeFile(path.join(reportDir, "3.0页面实际地址确认-未确认与歧义.csv"), csvText(unresolvedHeaders, unresolved.map((row) => [row.page_name,row.page_path,row.page_url,row.historical_site_host,row.status,row.candidates?.map((x) => x.error).filter(Boolean).join("；") ?? "",row.candidates?.length ?? 0])), "utf8");
  const overrides = rows.filter((x) => ["confirmed_exact","found_in_other_site","path_corrected"].includes(x.status)).map((x) => ({ page_name:x.page_name, actual_site_name:x.actual_site_name, actual_site_language:x.actual_site_language, actual_site_id:x.actual_site_id ?? "", actual_site_host:x.actual_site_host, page_path:x.actual_page_path, public_url:x.actual_public_url }));
  await writeFile(path.join(reportDir, "v3-page-address-overrides.json"), `${JSON.stringify(overrides, null, 2)}\n`, "utf8");
  const esc = (value) => String(value ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
  await writeFile(path.join(reportDir, "3.0页面实际地址确认-原始对照.csv"), csvText(["页面名称","历史链接","实际链接","地址结果"], rows.map((row) => [row.page_name,row.page_url,row.actual_public_url ?? "",row.status])), "utf8");
  await writeFile(path.join(reportDir, "3.0页面实际地址确认-report.html"), `<!doctype html><meta charset="utf-8"><title>3.0页面实际地址确认</title><style>body{font-family:Arial,"Microsoft YaHei"}table{border-collapse:collapse}th,td{border:1px solid #bbb;padding:5px;vertical-align:top}th{background:#eaf2f8}</style><h1>3.0页面实际地址确认</h1><p>批次：${esc(state.run_id)}；阶段：${esc(state.phase)}；页面数：${rows.length}</p><table><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${summaryRows.map((line) => `<tr>${line.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</table>`, "utf8");
  const outputDir = path.resolve(projectRoot, "../outputs/019fa755-5d3d-7792-8740-e4786e04a2f7/v3-page-address-confirmation-20260903");
  await mkdir(outputDir, { recursive: true });
  const workbook = Workbook.create();
  const addSheet = (name, head, data) => { const sheet = workbook.worksheets.add(name); sheet.showGridLines = false; sheet.getRangeByIndexes(0,0,1,head.length).values = [head]; if (data.length) sheet.getRangeByIndexes(1,0,data.length,head.length).values = data; const all = sheet.getRangeByIndexes(0,0,Math.max(1,data.length+1),head.length); sheet.getRangeByIndexes(0,0,1,head.length).format = { fill: "#1F4E78", font: { bold: true, color: "#FFFFFF" }, horizontalAlignment: "center", verticalAlignment: "center", wrapText: true }; all.format.wrapText = true; all.format.borders = { preset: "all", style: "thin", color: "#D9E2F3" }; sheet.freezePanes.freezeRows(1); for (let i=0;i<head.length;i+=1) sheet.getRangeByIndexes(0,i,Math.max(1,data.length+1),1).format.columnWidth = Math.min(48, Math.max(14, String(head[i]).length + 4)); return sheet; };
  addSheet("地址确认汇总", headers, summaryRows);
  addSheet("站点候选", candidateHeaders, candidateRows);
  addSheet("页面证据", evidenceHeaders, evidenceRows);
  addSheet("未确认与歧义", unresolvedHeaders, unresolved.map((row) => [row.page_name,row.page_path,row.page_url,row.historical_site_host,row.status,row.candidates?.map((x) => x.error).filter(Boolean).join("；") ?? "",row.candidates?.length ?? 0]));
  addSheet("原始对照", ["页面名称","历史链接","实际链接","地址结果"], rows.map((row) => [row.page_name,row.page_url,row.actual_public_url ?? "",row.status]));
  addSheet("运行状态", ["字段","值"], [["批次号",state.run_id],["阶段",state.phase],["目标页面数",rows.length],["已确认页面数",rows.filter((x) => ["confirmed_exact","found_in_other_site","path_corrected"].includes(x.status)).length],["更新时间",state.updated_at ?? ""]]);
  const preview = await workbook.render({ sheetName: "地址确认汇总", range: `A1:O${Math.min(8, summaryRows.length + 1)}`, scale: 1, format: "png" });
  await writeFile(path.join(outputDir, "3.0页面实际地址确认-preview.png"), new Uint8Array(await preview.arrayBuffer()));
  const workbookBlob = await SpreadsheetFile.exportXlsx(workbook); const workbookPath = path.join(outputDir, "3.0页面实际地址确认.xlsx"); await workbookBlob.save(workbookPath);
  console.log(JSON.stringify({ report_dir: reportDir, workbook: workbookPath, mapping_csv: path.join(reportDir, "3.0页面实际地址确认-汇总.csv"), overrides: path.join(reportDir, "v3-page-address-overrides.json"), counts: { confirmed: overrides.length, unresolved: unresolved.length, candidates: candidateRows.length } }, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
