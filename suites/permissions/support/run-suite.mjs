import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsRoot = path.join(runnerRoot, "results");
const caseIdArg = process.argv.indexOf("--case");
const groupArg = process.argv.indexOf("--group");
const casesArg = process.argv.indexOf("--cases");
const listOnly = process.argv.includes("--list");
const recoverOnly = process.argv.includes("--recover");
const caseId = caseIdArg >= 0 ? process.argv[caseIdArg + 1] : undefined;
const group = groupArg >= 0 ? process.argv[groupArg + 1] : undefined;
const caseIds = casesArg >= 0 ? new Set((process.argv[casesArg + 1] ?? "").split(",").filter(Boolean)) : undefined;
const blockedCases = ["用例-0006", "用例-0020", "用例-0021"];
const browserExecutableCandidates = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
const artifactNode = process.env.UI_ARTIFACT_NODE ?? process.execPath;
const sourceWorkbook = process.env.UI_CASE_SOURCE_XLSX ?? path.join(runnerRoot, "fixtures", "BUG1004949-测试用例-源.xlsx");
const accessControlIds = new Set([
  "用例-0001", "用例-0002", "用例-0003", "用例-0004", "用例-0005", "用例-0008", "用例-0009",
  "用例-0010", "用例-0011", "用例-0012", "用例-0013", "用例-0014", "用例-0015", "用例-0016",
  "用例-0017", "用例-0018", "用例-0022", "用例-0023", "用例-0024", "用例-0025", "用例-0026",
  "用例-0027",
]);
const customUrlIds = new Set([
  "用例-0007", "用例-0019", "用例-0028", "用例-0029", "用例-0030", "用例-0031", "用例-0032",
  "用例-0033", "用例-0034", "用例-0035", "用例-0036", "用例-0038",
]);

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: runnerRoot, env, stdio: "inherit" });
    child.on("close", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function findBrowserExecutable() {
  for (const candidate of browserExecutableCandidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue to Playwright's default browser lookup.
    }
  }
  return undefined;
}

async function readRunnableCatalog() {
  const specPath = path.join(runnerRoot, "tests", "bug1004949-nonblocked.spec.ts");
  const source = await fs.readFile(specPath, "utf8");
  const cases = [...source.matchAll(/test\("(用例-[0-9]{4}):\s*([^"\n]+)"/gu)].map((match) => ({
    case_id: match[1],
    title: `${match[1]}: ${match[2]}`,
  }));
  if (cases.length !== 36 || new Set(cases.map((item) => item.case_id)).size !== 36) {
    throw new Error(`Expected 36 unique runnable Playwright cases, found ${cases.length}`);
  }
  return cases;
}

function groupForCase(id) {
  if (accessControlIds.has(id)) return "access-control";
  if (customUrlIds.has(id)) return "custom-url";
  if (["用例-0037", "用例-0039"].includes(id)) return "redirects";
  if (id === "用例-0043") return "error-pages";
  return undefined;
}

function selectRunnableCases(catalog) {
  const selected = catalog.filter((item) => (!caseId || item.case_id === caseId) && (!caseIds || caseIds.has(item.case_id)) && (!group || groupForCase(item.case_id) === group));
  if (caseId && selected.length === 0) throw new Error(`Unknown or blocked case: ${caseId}`);
  if (caseIds && selected.length !== caseIds.size) throw new Error(`One or more requested cases are unknown or blocked`);
  if (group && selected.length === 0) throw new Error(`No ready cases in group: ${group}`);
  return selected;
}

function collectSpecs(node, output = []) {
  for (const spec of node.specs ?? []) output.push(spec);
  for (const suite of node.suites ?? []) collectSpecs(suite, output);
  return output;
}

function caseFromTitle(title) {
  return title.match(/用例-[0-9]{4}/u)?.[0] ?? title;
}

function statusFromSpec(spec) {
  const tests = spec.tests ?? [];
  const result = tests.flatMap((test) => test.results ?? []).at(-1);
  if (!result) return "interrupted";
  if (result.status === "passed") return "passed";
  const message = result.error?.message ?? "";
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|proxy|tunnel/i.test(message)) {
    return "environment_blocked";
  }
  const stack = result.error?.stack ?? "";
  const detail = `${message}\n${stack}`;
  if (/beforeEach|afterAll|backend-state\.ts|Content (?:object|save|menu|list|edit)|Page fixture|Permission control|publish control/iu.test(detail)) {
    return "automation_failure";
  }
  if (/expect\(|toHave|toContain|toBeVisible|toHaveURL|toHaveTitle|Assertion/iu.test(detail)) {
    return "business_failure";
  }
  return "automation_failure";
}

function reasonFor(spec, status) {
  if (status === "passed") return null;
  const result = (spec.tests ?? []).flatMap((test) => test.results ?? []).at(-1);
  const caseId = caseFromTitle(spec.title);
  if (caseId === "用例-0014") {
    return "员工账号已在领动云平台重新登录并进入 website.html，但携带员工 Cookie 访问员工保护的产品详情页时仍显示 Only employees 提示，未展示产品内容。";
  }
  const raw = result?.error?.message ?? `${status}: ${spec.title}`;
  const sanitized = String(raw)
    .replaceAll(/\u001B\[[0-9;]*m/gu, "")
    .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "");
  const lines = sanitized.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const useful = lines.filter((line) => !/^(Call log:|at |\d+ × locator resolved|[-+] Received string)/u.test(line));
  return useful.slice(0, 4).join(" ").slice(0, 600);
}

async function writeXlsx(file, rows) {
  const script = path.join(runnerRoot, "support", "artifact-runtime", "write-results-xlsx.mjs");
  const input = file.replace(/\.xlsx$/u, ".xlsx-input.json");
  await fs.writeFile(input, JSON.stringify(rows), "utf8");
  const result = await run(artifactNode, [script, input, sourceWorkbook, file], process.env);
  await fs.rm(input, { force: true });
  if (result.code !== 0) throw new Error("XLSX projection failed");
  await fs.rm(`${file}.inspect.ndjson`, { force: true });
}

function isLoginPage(pageUrl, title, body) {
  return /\/login(?:\.html)?(?:[?#]|$)/iu.test(pageUrl) || /登录/u.test(title) || /用户登录入口/u.test(body);
}

async function loginAdministrator(page, context, env) {
  const loginUrl = `${env.UI_ADMIN_BASE_URL}/login.html`;
  try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/iu.test(message)) {
      throw new Error("建站后台登录态已失效，且指定代理无法连接登录服务");
    }
    throw error;
  }
  const body = await page.locator("body").innerText().catch(() => "");
  if (/无法获取请求的 URL|Access control configuration prevents|ERR_ACCESS_DENIED/iu.test(body)) {
    throw new Error("建站后台登录态已失效，且指定代理无法访问登录服务");
  }
  const account = page.locator('input:not([type="hidden"]):not([type="password"])').first();
  const password = page.locator('input[type="password"]').first();
  await account.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {
    throw new Error("建站后台登录态已失效，登录页未找到可见账号输入框");
  });
  await password.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {
    throw new Error("建站后台登录态已失效，登录页未找到可见密码输入框");
  });
  await account.fill(env.BUG1004949_ADMIN_ACCOUNT);
  await password.fill(env.BUG1004949_ADMIN_PASSWORD);
  const submit = page.locator("#loginSubmit");
  await submit.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
    throw new Error("建站后台登录页未找到登录提交控件");
  });
  await submit.click();
  await page.waitForURL((url) => /website\.html|phoenix|login\.html/u.test(url.pathname), { timeout: 20_000 }).catch(() => undefined);
  const avatar = page.locator(".wrap-login-container, .wrap-login-dropdown").first();
  await avatar.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {
    throw new Error("管理员登录后未进入领动云平台，未找到右上角账号头像");
  });
  await avatar.hover();
  const cloudPlatform = page.getByText(/(?:返回)?领动云平台/u).last();
  await cloudPlatform.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
    throw new Error("管理员登录后头像菜单未找到“领动云平台”入口");
  });
  await cloudPlatform.click();
  await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
  await page.goto(`${env.UI_ADMIN_BASE_URL}/website.html`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  const portalTitle = await page.title();
  const portalBody = await page.locator("body").innerText().catch(() => "");
  if (isLoginPage(page.url(), portalTitle, portalBody)) {
    throw new Error("管理员自动登录后仍未获得建站后台登录态");
  }
  await page.locator(".contentShow").filter({ has: page.getByRole("link", { name: env.UI_BASE_URL, exact: true }) }).first()
    .waitFor({ state: "visible", timeout: 20_000 }).catch(() => {
      throw new Error("管理员自动登录后未进入目标英语站点管理门户");
    });
  await context.storageState({ path: env.UI_STORAGE_STATE });
}

function blockedRows() {
  const reasons = {
    "用例-0006": "环境阻塞：用例要求验证同一受保护内容对应的系统 URL，但当前可复用资产尚未固定该内容与系统 URL 的稳定映射及恢复步骤，因此本轮不自动执行。",
    "用例-0020": "环境阻塞：英语站点中尚未准备可稳定识别、可重复访问并可在执行后恢复的 CP 页测试对象。",
    "用例-0021": "环境阻塞：英语站点中尚未准备可稳定识别、可重复访问并可在执行后恢复的专题页测试对象。",
  };
  return blockedCases.map((id) => ({
    case_id: id,
    title: id,
    status: "environment_blocked",
    attempted: false,
    reason: reasons[id],
    attempts: 0,
    duration_ms: 0,
    script_path: null,
    asset_snapshot_id: "snap-bug1004949-reusable-v1",
    setup_status: "not_run",
    cleanup_status: "not_run",
    evidence: [],
  }));
}

function productConfirmationRows() {
  return [{
    case_id: "用例-0034",
    title: "用例-0034: 视频详情自定义 URL",
    status: "product_confirmation",
    attempted: false,
    reason: "待产品确认：当前英语站点内容管理中的视频编辑页没有自定义 URL入口，无法按产品规则配置视频详情短链接；本轮不执行伪造 URL或404断言。",
    attempts: 0,
    duration_ms: 0,
    script_path: null,
    asset_snapshot_id: "snap-bug1004949-reusable-v2",
    setup_status: "not_applicable",
    cleanup_status: "not_applicable",
    evidence: [],
  }];
}

function describePreflightFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/登录态已失效，且指定代理无法访问登录服务/u.test(message)) {
    return "环境阻塞：指定代理可以访问英语前台和建站后台入口，但管理员登录态已失效；脚本尝试自动登录时，指定代理无法访问登录服务。为避免产生部分后台修改，本轮未执行用例。";
  }
  if (/登录态已失效，且指定代理无法连接登录服务/u.test(message)) {
    return "环境阻塞：指定代理可以访问英语前台和建站后台入口，但管理员登录态已失效；脚本尝试自动登录时，指定代理无法建立到登录服务的连接。为避免产生部分后台修改，本轮未执行用例。";
  }
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|通过指定代理进入/u.test(message)) {
    return "环境阻塞：通过指定代理进入建站后台功能时连接失败。为避免反复启动浏览器或产生部分后台修改，本轮未执行用例。";
  }
  return `环境阻塞：全局预检失败，未修改后台且未执行用例。${message.replace(/\s*Call log:[\s\S]*/u, "").trim()}`;
}

async function publishResults({ runId, runDir, startedAt, rows }) {
  rows.sort((a, b) => a.case_id.localeCompare(b.case_id, "zh-Hans-CN", { numeric: true }));
  const summary = {
    total: rows.length,
    attempted: rows.filter((row) => row.attempted).length,
    passed: rows.filter((row) => row.status === "passed").length,
    business_failure: rows.filter((row) => row.status === "business_failure").length,
    automation_failure: rows.filter((row) => row.status === "automation_failure").length,
    environment_blocked: rows.filter((row) => row.status === "environment_blocked").length,
    product_confirmation: rows.filter((row) => row.status === "product_confirmation").length,
  };
  const normalized = {
    schema_version: "ui-execution-results.v3",
    run_id: runId,
    project_id: "bug1004949-en-site",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    cases: rows,
    summary,
  };
  await fs.writeFile(path.join(runDir, "ui-execution-results.v3.json"), JSON.stringify(normalized, null, 2), "utf8");
  await fs.writeFile(path.join(runDir, "ui-execution-report.html"), `<!doctype html><meta charset="utf-8"><title>${runId}</title><h1>BUG1004949</h1><pre>${JSON.stringify({ summary, cases: rows }, null, 2).replaceAll("<", "&lt;")}</pre>`, "utf8");
  await writeXlsx(path.join(runDir, "BUG1004949-执行结果.xlsx"), rows);
  await fs.rm(path.join(resultsRoot, "latest"), { recursive: true, force: true });
  await fs.cp(runDir, path.join(resultsRoot, "latest"), { recursive: true });
  await fs.writeFile(path.join(resultsRoot, "latest-summary.json"), JSON.stringify({ runId, summary }, null, 2), "utf8");
  console.log(JSON.stringify({ runId, summary, report: path.join(runDir, "ui-execution-report.html") }, null, 2));
  return summary;
}

async function checkPage(context, check, env) {
  const page = await context.newPage();
  const startedAt = Date.now();
  let finalUrl = check.url;
  try {
    let response;
    let navigationError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await page.goto(check.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        navigationError = undefined;
        break;
      } catch (error) {
        navigationError = error;
        if (attempt === 0) {
          await page.goto("about:blank", { waitUntil: "commit", timeout: 5_000 }).catch(() => undefined);
        }
      }
    }
    if (navigationError) throw navigationError;
    if (!response) throw new Error("navigation returned no HTTP response");
    if (response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    let body = await page.locator("body").innerText().catch(() => "");
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|无法获取请求的 URL|Access Denied/iu.test(body)) {
      throw new Error("page content indicates proxy or access failure");
    }
    if (check.bodyPattern) {
      if (!check.bodyPattern.test(body)) throw new Error(`expected page marker not found at ${page.url()}`);
    }
    const title = await page.title();
    if (check.rejectLogin && isLoginPage(page.url(), title, body)) {
      await loginAdministrator(page, context, env);
      body = await page.locator("body").innerText().catch(() => "");
    }
    if (check.actionText) {
      const targetSite = page.locator(".contentShow").filter({
        has: page.getByRole("link", { name: env.UI_BASE_URL, exact: true }),
      }).first();
      await targetSite.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
        throw new Error(`建站后台未找到目标英语站点：${env.UI_BASE_URL}`);
      });
      const action = targetSite.getByText(check.actionText, { exact: true }).first();
      if (await action.count() === 0) throw new Error(`目标英语站点未找到“${check.actionText}”入口`);
      const popupPromise = context.waitForEvent("page", { timeout: 10_000 }).catch(() => null);
      await action.click();
      const popup = await popupPromise;
      if (!popup) throw new Error(`点击目标英语站点“${check.actionText}”后未打开管理页面`);
      await popup.waitForURL((url) => url.protocol === "http:" || url.protocol === "https:", {
        waitUntil: "commit",
        timeout: 15_000,
      });
      await popup.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
      finalUrl = popup.url();
      if (!/^https?:/u.test(finalUrl)) {
        await popup.close().catch(() => undefined);
        throw new Error(`点击目标英语站点“${check.actionText}”后未获得管理页面地址`);
      }
      const destinationBody = await popup.locator("body").innerText().catch(() => "");
      if (/ERR_TUNNEL_CONNECTION_FAILED|无法获取请求的 URL|Access Denied/iu.test(destinationBody)) {
        await popup.close().catch(() => undefined);
        throw new Error(`通过指定代理进入“${check.actionText}”失败`);
      }
      await popup.close().catch(() => undefined);
    }
    return { name: check.name, requested_url: check.url, final_url: finalUrl || page.url(), status: "passed", duration_ms: Date.now() - startedAt };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${check.name} [${check.url}] failed: ${reason}`);
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function runGlobalPreflight({ wsEndpoint, env, selectedCases, runDir }) {
  const browser = await chromium.connect(wsEndpoint);
  const context = await browser.newContext({
    storageState: env.UI_STORAGE_STATE,
    locale: "zh-CN",
    proxy: { server: env.UI_PROXY },
  });
  const selectedIds = new Set(selectedCases.map((item) => item.case_id));
  const needsPageBuilder = [...selectedIds].some((id) => accessControlIds.has(id));
  const needsContentBackend = [...selectedIds].some((id) => Number(id.slice(-4)) >= 28 && Number(id.slice(-4)) <= 39);
  const checks = [
    { name: "前台英语站点", url: env.UI_BASE_URL },
    { name: "建站后台入口", url: `${env.UI_ADMIN_BASE_URL}/website.html`, rejectLogin: true, bodyPattern: /./u },
  ];
  if (needsPageBuilder) {
    checks.push({ name: "从建站后台进入网站编辑器", url: `${env.UI_ADMIN_BASE_URL}/website.html`, rejectLogin: true, bodyPattern: /./u, actionText: "编辑网站" });
  }
  if (needsContentBackend) {
    checks.push({ name: "从建站后台进入内容管理", url: `${env.UI_ADMIN_BASE_URL}/website.html`, rejectLogin: true, bodyPattern: /./u, actionText: "内容管理" });
  }
  const outcomes = [];
  try {
    for (const check of checks) outcomes.push(await checkPage(context, check, env));
    await fs.writeFile(path.join(runDir, "preflight.json"), JSON.stringify({ status: "passed", browser_processes: 1, checks: outcomes }, null, 2), "utf8");
    return outcomes;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await fs.writeFile(path.join(runDir, "preflight.json"), JSON.stringify({ status: "failed", browser_processes: 1, checks: outcomes, reason }, null, 2), "utf8");
    throw error;
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

async function main() {
  if (listOnly) {
    const catalog = await readRunnableCatalog();
    console.log(catalog.map((item) => `${item.case_id}: ${item.title}`).join("\n"));
    return 0;
  }
  const startedAt = new Date().toISOString();
  const runId = `BUG1004949-${new Date().toISOString().replaceAll(/[-:.TZ]/gu, "").slice(0, 17)}`;
  const runDir = path.join(resultsRoot, "runs", runId);
  await fs.mkdir(runDir, { recursive: true });
  const storageState = process.env.UI_STORAGE_STATE ?? path.join(runnerRoot, "fixtures", "admin.storage.json");
  const localTestConfig = await readJson(path.join(runnerRoot, "fixtures", "local-test-config.json"));
  try {
    await fs.access(storageState);
  } catch {
    throw new Error(`Admin storage state is missing: ${storageState}`);
  }
  const env = {
    ...process.env,
    UI_STORAGE_STATE: storageState,
    UI_AUTOMATION_RESULTS_DIR: runDir,
    UI_BACKEND_SETUP: process.env.UI_BACKEND_SETUP ?? "1",
    UI_BASE_URL: process.env.UI_BASE_URL ?? "http://site.example.invalid",
    UI_ADMIN_BASE_URL: process.env.UI_ADMIN_BASE_URL ?? "https://admin.example.invalid",
    UI_PROXY: process.env.UI_PROXY ?? "http://proxy.example.invalid:8080",
    BUG1004949_ADMIN_ACCOUNT: process.env.BUG1004949_ADMIN_ACCOUNT ?? localTestConfig.admin.account,
    BUG1004949_ADMIN_PASSWORD: process.env.BUG1004949_ADMIN_PASSWORD ?? localTestConfig.admin.password,
    HEADLESS: process.env.HEADLESS ?? "0",
  };
  const runtimeUrlToken = (process.env.UI_RUNTIME_URL_TOKEN ?? runId.replace(/^BUG1004949-/u, "").toLowerCase())
    .replaceAll(/[^a-z0-9-]/gu, "-");
  const runtimeStateFile = path.join(runDir, "runtime-state.json");
  const runtimeState = {
    schema_version: "bug1004949-runtime-state.v1",
    run_id: runId,
    url_token: runtimeUrlToken,
    custom_urls: {
      article_0029: [
        { title: "article one", path: `/bug1004949/a1-${runtimeUrlToken}.html` },
        { title: "Example article title", path: `/bug1004949/a2-${runtimeUrlToken}.html` },
        { title: "article three", path: `/bug1004949/a3-${runtimeUrlToken}.html` },
      ],
    },
  };
  await fs.writeFile(runtimeStateFile, JSON.stringify(runtimeState, null, 2), "utf8");
  env.UI_RUNTIME_URL_TOKEN = runtimeUrlToken;
  env.UI_RUNTIME_STATE_FILE = runtimeStateFile;
  console.log(`Runtime URL state fixed for all phases: ${runtimeStateFile}`);
  const baselineFile = path.join(runDir, "recovery-journal.json");
  await fs.writeFile(path.join(runDir, "baseline-state.json"), JSON.stringify({
    capturedAt: new Date().toISOString(),
    storageState,
    blockedCases,
    restorePolicy: "A private journal is captured before the first mutation and restored in finally.",
    journal: baselineFile,
  }, null, 2), { encoding: "utf8", mode: 0o600 });
  env.UI_BASELINE_FILE = baselineFile;

  if (recoverOnly) {
    env.UI_BASELINE_FILE = process.env.UI_BASELINE_FILE ?? path.join(resultsRoot, "latest", "recovery-journal.json");
    const executablePath = await findBrowserExecutable();
    const recoveryServer = await chromium.launchServer({ headless: env.HEADLESS === "1", ...(executablePath ? { executablePath } : {}) });
    try {
      const recoveryEnv = { ...env, UI_BROWSER_WS_ENDPOINT: recoveryServer.wsEndpoint(), UI_AUTOMATION_RESULTS_DIR: path.join(runDir, "recovery"), UI_SCENARIO_GROUP: "", UI_BACKEND_SETUP: "1" };
      const recovery = await run("npx", ["playwright", "test", "-g", "BUG1004949 recovery"], recoveryEnv);
      return recovery.code;
    } finally {
      await recoveryServer.close().catch(() => undefined);
    }
  }

  const catalog = await readRunnableCatalog();
  const selectedCases = selectRunnableCases(catalog);
  const selectedIds = new Set(selectedCases.map((item) => item.case_id));
  const scenarioGroups = [
    { name: "password", ids: ["用例-0001", "用例-0002", "用例-0003", "用例-0004", "用例-0005", "用例-0008", "用例-0009", "用例-0017", "用例-0022", "用例-0023", "用例-0024", "用例-0025", "用例-0026", "用例-0027"] },
    { name: "member-vip", ids: ["用例-0010", "用例-0011", "用例-0018"] },
    { name: "member-low", ids: ["用例-0012"] },
    { name: "employee", ids: ["用例-0013", "用例-0014"] },
    { name: "form", ids: ["用例-0015", "用例-0016"] },
    { name: "public", ids: ["用例-0007", "用例-0019"] },
    { name: "custom-url", ids: ["用例-0028", "用例-0029", "用例-0030", "用例-0031", "用例-0032", "用例-0033", "用例-0035", "用例-0036", "用例-0038"] },
    { name: "redirects", ids: ["用例-0037", "用例-0039"] },
    { name: "error-pages", ids: ["用例-0043"] },
  ];
  const batches = scenarioGroups.map((batch) => ({ ...batch, ids: batch.ids.filter((id) => selectedIds.has(id)) })).filter((batch) => batch.ids.length);
  if (caseId && batches.length === 0) throw new Error(`No executable scenario batch for ${caseId}`);
  const executablePath = await findBrowserExecutable();
  let browserServer;
  let preflightFailed = false;
  let finalCode = 0;
  const allSpecs = [];
  const failedGroups = [];
  try {
    browserServer = await chromium.launchServer({
      headless: env.HEADLESS === "1",
      ...(executablePath ? { executablePath } : {}),
    });
    env.UI_BROWSER_WS_ENDPOINT = browserServer.wsEndpoint();
    console.log(`Global browser started once (${env.HEADLESS === "1" ? "headless" : "headed"}); running proxy/backend/frontend preflight.`);
    try {
      await runGlobalPreflight({ wsEndpoint: env.UI_BROWSER_WS_ENDPOINT, env, selectedCases, runDir });
    } catch (error) {
      preflightFailed = true;
      const reason = describePreflightFailure(error);
      const rows = selectedCases.map((item) => ({
        ...item,
        status: "environment_blocked",
        attempted: false,
        reason,
        attempts: 0,
        duration_ms: 0,
        script_path: path.join(runnerRoot, "tests", "bug1004949-nonblocked.spec.ts"),
        asset_snapshot_id: "snap-bug1004949-reusable-v2",
        setup_status: "not_run",
        cleanup_status: "not_run",
        evidence: [path.join(runDir, "preflight.json")],
      }));
      const summary = await publishResults({ runId, runDir, startedAt, rows: [...rows, ...blockedRows(), ...productConfirmationRows()] });
      return summary.environment_blocked > blockedCases.length ? 1 : 0;
    }
    for (const batch of batches) {
      const batchDir = path.join(runDir, "batches", batch.name);
      await fs.mkdir(batchDir, { recursive: true });
      const setupDir = path.join(batchDir, "setup");
      const verifyDir = path.join(batchDir, "verify");
      await fs.mkdir(setupDir, { recursive: true });
      await fs.mkdir(verifyDir, { recursive: true });
      const setupEnv = {
        ...env,
        UI_AUTOMATION_RESULTS_DIR: setupDir,
        UI_SCENARIO_GROUP: batch.name,
        UI_SCENARIO_IDS: batch.ids.join(","),
        UI_AUTOMATION_WORKERS: "1",
        UI_BACKEND_SETUP: "1",
      };
      const setup = await run("npx", ["playwright", "test", "scenario-setup.spec.ts"], setupEnv);
      if (setup.code !== 0) {
        finalCode = setup.code || 1;
        failedGroups.push({ name: batch.name, reason: "场景后台配置失败，已跳过该场景的前台验证。" });
        continue;
      }
      const verifyEnv = {
        ...env,
        UI_AUTOMATION_RESULTS_DIR: verifyDir,
        UI_SCENARIO_GROUP: "",
        UI_BACKEND_SETUP: "0",
        UI_RUNTIME_MUTATION: batch.name === "custom-url" ? "1" : "0",
        UI_AUTOMATION_WORKERS: batch.name === "custom-url" ? "1" : (process.env.UI_READONLY_WORKERS ?? "2"),
      };
      const args = ["playwright", "test", "bug1004949-nonblocked.spec.ts", "-g", batch.ids.join("|")];
      const execution = await run("npx", args, verifyEnv);
      if (execution.code !== 0) finalCode = execution.code || 1;
      try {
        const result = await readJson(path.join(verifyDir, "playwright-results.json"));
        allSpecs.push(...collectSpecs(result));
      } catch (error) {
        failedGroups.push({ name: batch.name, reason: `未生成 Playwright 结果：${error instanceof Error ? error.message : String(error)}` });
      }
    }
  } finally {
    // Recovery runs through the same shared Chromium process and is attempted
    // even when a batch or an assertion failed.
    if (browserServer && !preflightFailed) {
      const recoveryDir = path.join(runDir, "recovery");
      await fs.mkdir(recoveryDir, { recursive: true });
      const recoveryEnv = { ...env, UI_AUTOMATION_RESULTS_DIR: recoveryDir, UI_SCENARIO_GROUP: "", UI_BACKEND_SETUP: "1" };
      const recovery = await run("npx", ["playwright", "test", "-g", "BUG1004949 recovery"], recoveryEnv);
      if (recovery.code !== 0) finalCode = recovery.code || 1;
      await fs.writeFile(path.join(runDir, "recovery-status.json"), JSON.stringify({ status: recovery.code === 0 ? "passed" : "failed", exit_code: recovery.code }, null, 2), "utf8");
    }
    if (browserServer) {
      await browserServer.close().catch(() => undefined);
      console.log("Global browser closed once.");
    }
  }
  const rows = allSpecs.map((spec) => {
    const id = caseFromTitle(spec.title);
    const status = statusFromSpec(spec);
    const result = (spec.tests ?? []).flatMap((test) => test.results ?? []).at(-1);
    return {
      case_id: id,
      title: spec.title,
      status,
      attempted: true,
      reason: reasonFor(spec, status),
      attempts: (spec.tests ?? []).length,
      duration_ms: result?.duration ?? 0,
      script_path: path.join(runnerRoot, "tests", "bug1004949-nonblocked.spec.ts"),
      asset_snapshot_id: "snap-bug1004949-reusable-v2",
      setup_status: status === "passed" ? "verified" : "not_verified",
      cleanup_status: status === "passed" ? "verified" : "not_verified",
      evidence: [],
    };
  });
  for (const failure of failedGroups) rows.push(...batches.find((batch) => batch.name === failure.name).ids.map((id) => ({
    case_id: id,
    title: `${id}: 场景批次执行失败`,
    status: "automation_failure",
    attempted: false,
    reason: failure.reason,
    attempts: 0,
    duration_ms: 0,
    script_path: path.join(runnerRoot, "tests", "bug1004949-nonblocked.spec.ts"),
    asset_snapshot_id: "snap-bug1004949-reusable-v2",
    setup_status: "failed",
    cleanup_status: "unknown",
    evidence: [],
  })));
  const summary = await publishResults({ runId, runDir, startedAt, rows: [...rows, ...blockedRows(), ...productConfirmationRows()] });
  return finalCode || summary.business_failure > 0 || summary.automation_failure > 0 ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
