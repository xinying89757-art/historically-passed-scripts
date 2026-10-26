import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const supportedActions = new Set([
  "add",
  "edit",
  "disable",
  "enable",
  "unbind",
  "bind",
  "set-test-default",
  "set-test-default-and-enable",
  "restore-default",
  "delete",
  "full-flow",
  "resume-after-add",
  "resume-after-edit",
  "resume-after-test-default",
]);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function help() {
  console.log(`Phoenix 服务商域名管理脚本

用法：
  node scripts/phoenix-domain-flow.mjs --config config/domain-flow.local.json --action full-flow

动作：
  add | edit | disable | enable | set-test-default | set-test-default-and-enable | restore-default | delete | full-flow | resume-after-add | resume-after-edit | resume-after-test-default

说明：
  full-flow 覆盖 N1-N6：新增、普通修改、停用/启用、升默认、恢复默认、
  一次保存同时升默认并切换启用状态、再次恢复默认、取消删除、确认删除。
  unbind / bind 保留为 disable / enable 的兼容别名。
  默认使用有界面 Chromium；追加 --headless 可无界面运行。`);
}

function timestampForFile() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function beijingTimestamp(value = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value).replaceAll("/", "-");
}

function proxyOption(proxy) {
  if (!proxy || ["none", "direct", "off"].includes(String(proxy).toLowerCase())) return undefined;
  return { server: proxy };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function adminCredential(config) {
  const item = config.accounts?.admin;
  if (!item?.account) throw new Error("配置缺少 accounts.admin.account");
  const password = (item.passwordEnv && process.env[item.passwordEnv]) || item.password;
  if (!password) throw new Error(`缺少管理员密码，请设置环境变量 ${item.passwordEnv || "PHOENIX_ADMIN_PASSWORD"}`);
  return { account: item.account, password };
}

async function enterCloudPlatform(page) {
  const avatar = page.locator(".wrap-login-container, .wrap-login-dropdown, [class*='avatar']").first();
  if (await avatar.isVisible().catch(() => false)) {
    await avatar.hover().catch(() => undefined);
    await page.waitForTimeout(300);
  }
  const cloudLinks = page.getByText(/(?:进入|返回)?领动云平台/u);
  for (let index = (await cloudLinks.count()) - 1; index >= 0; index -= 1) {
    const link = cloudLinks.nth(index);
    if (await link.isVisible().catch(() => false)) {
      await link.click();
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
      await page.waitForTimeout(1_000);
      break;
    }
  }
}

async function login(page, config) {
  const credentials = adminCredential(config);
  await page.goto(config.urls.login, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(4_000);
  const loginName = page.locator("#loginName");
  if (await loginName.isVisible().catch(() => false)) {
    await loginName.fill(credentials.account);
    await page.locator("#password").fill(credentials.password);
    await page.locator("#loginSubmit").click();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(4_000);
  }
  if (await loginName.isVisible().catch(() => false)) {
    throw new Error("管理员登录失败，登录表单仍然可见");
  }
}

async function openDomainManagement(context, page, config) {
  // 云平台同时存在多个同名入口；应用卡片会打开真正的服务商系统标签页。
  let serviceCard = page.locator("a.contentShow-des-a.userEditSite").filter({ hasText: "服务商管理" }).first();
  if (!(await serviceCard.isVisible().catch(() => false))) {
    await page.goto(config.urls.cloudHome, { waitUntil: "commit", timeout: 30_000 }).catch((error) => {
      if (!/^https?:\/\/www\.leadong\.com\/website\.html(?:[?#]|$)/u.test(page.url())) throw error;
    });
    await page.waitForTimeout(5_000);
    serviceCard = page.locator("a.contentShow-des-a.userEditSite").filter({ hasText: "服务商管理" }).first();
  }
  let agentPage = page;
  await serviceCard.waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
  if (await serviceCard.isVisible().catch(() => false)) {
    const before = new Set(context.pages());
    const popupPromise = context.waitForEvent("page", { timeout: 15_000 }).catch(() => null);
    await serviceCard.click();
    const popup = await popupPromise;
    const newPages = context.pages().filter((candidate) => !before.has(candidate));
    agentPage = popup
      || newPages[0]
      || page;
  } else {
    throw new Error(`云平台中未找到服务商管理应用卡片，当前地址：${page.url()}`);
  }
  await agentPage.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
  await agentPage.waitForTimeout(3_000);
  let scope = agentPage.frames().find((frame) => /\/agent(?:[/?#]|$)/u.test(frame.url())) || agentPage.mainFrame();
  let domainManagement = scope.getByText("域名管理", { exact: true });
  let visibleDomainManagement = null;
  for (let attempt = 0; attempt < 20 && !visibleDomainManagement; attempt += 1) {
    await agentPage.waitForTimeout(500);
    scope = agentPage.frames().find((frame) => /\/agent(?:[/?#]|$)/u.test(frame.url())) || agentPage.mainFrame();
    domainManagement = scope.getByText("域名管理", { exact: true });
    for (let index = (await domainManagement.count()) - 1; index >= 0; index -= 1) {
      const candidate = domainManagement.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        visibleDomainManagement = candidate;
        break;
      }
    }
  }
  if (!visibleDomainManagement) {
    throw new Error(`服务商系统中未找到“域名管理”，当前地址：${agentPage.url()}；标签页：${context.pages().map((candidate) => candidate.url()).join(" | ")}`);
  }
  const pagesBeforeDomainClick = new Set(context.pages());
  const domainPopupPromise = context.waitForEvent("page", { timeout: 5_000 }).catch(() => null);
  await visibleDomainManagement.click();
  const domainPopup = await domainPopupPromise;
  await agentPage.waitForTimeout(2_000);
  let domainScope = null;
  let domainPage = agentPage;
  for (let attempt = 0; attempt < 30 && !domainScope; attempt += 1) {
    const candidatePages = [
      domainPopup,
      ...context.pages().filter((candidate) => !pagesBeforeDomainClick.has(candidate)),
      agentPage,
      ...context.pages(),
    ].filter((candidate, index, items) => candidate && items.indexOf(candidate) === index);
    for (const candidatePage of candidatePages) {
      for (const candidateScope of candidatePage.frames()) {
        if (await candidateScope.getByText("添加域名", { exact: true }).isVisible().catch(() => false)) {
          domainPage = candidatePage;
          domainScope = candidateScope;
          break;
        }
      }
      if (domainScope) break;
    }
    if (!domainScope && attempt === 8) {
      const expandedEntries = scope.getByText("域名管理", { exact: true });
      for (let index = (await expandedEntries.count()) - 1; index >= 0; index -= 1) {
        const candidate = expandedEntries.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
          await candidate.click().catch(() => undefined);
          break;
        }
      }
    }
    if (!domainScope) await agentPage.waitForTimeout(500);
  }
  if (!domainScope) {
    throw new Error(`点击“域名管理”后未找到“添加域名”；标签页：${context.pages().map((candidate) => candidate.url()).join(" | ")}`);
  }
  return { agentPage: domainPage, scope: domainScope };
}

async function searchSite(page, frame, site) {
  const websiteIdItem = frame.locator("li").filter({ hasText: "网站ID：" }).first();
  const siteNameItem = frame.locator("li").filter({ hasText: "网站名称：" }).first();
  if (site.siteSettingId) await websiteIdItem.locator("input").fill(String(site.siteSettingId));
  if (site.name) await siteNameItem.locator("input").fill(site.name);
  await frame.getByText("查询", { exact: true }).click();
  await page.waitForTimeout(1_200);
  let rows = frame.locator("tr").filter({ hasText: site.name });
  if (site.siteSettingId) rows = rows.filter({ hasText: String(site.siteSettingId) });
  const count = await rows.count();
  if (count !== 1) throw new Error(`目标网站必须唯一，实际匹配 ${count} 条：${site.name}`);
  return rows.first();
}

async function openSiteDomains(page, frame, site) {
  const row = await searchSite(page, frame, site);
  await row.getByRole("checkbox").check();
  await frame.getByText("编辑域名", { exact: true }).click();
  await frame.getByText(`网站ID：`).waitFor({ state: "visible", timeout: 15_000 });
  await domainRow(frame, site.originalDomain).waitFor({ state: "visible", timeout: 15_000 });
}

function domainRow(frame, domain) {
  return frame.locator("tr").filter({ hasText: domain }).first();
}

function domainEditor(frame) {
  const domainInput = frame.locator('input[name="domainRecord"]:visible').last();
  const editor = frame.locator("div:visible")
    .filter({ has: domainInput })
    .filter({ hasText: "确定" })
    .last();
  return { editor, domainInput };
}

async function lastVisibleText(scope, value) {
  const matches = scope.getByText(value, { exact: true });
  for (let index = (await matches.count()) - 1; index >= 0; index -= 1) {
    const candidate = matches.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  throw new Error(`未找到可见文本按钮：${value}`);
}

async function responseRecord(response) {
  return {
    url: response.url(),
    httpStatus: response.status(),
    requestBody: response.request().postData() || null,
    responseBody: await response.text().catch(() => ""),
  };
}

async function screenshot(page, action) {
  const outputDir = path.join(rootDir, "output", "playwright");
  await fs.mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `phoenix-domain-${action}-${timestampForFile()}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

async function addDomain(page, frame, site) {
  const row = await searchSite(page, frame, site);
  await row.getByRole("checkbox").check();
  await frame.getByText("添加域名", { exact: true }).click();
  const { editor: dialog, domainInput } = domainEditor(frame);
  await domainInput.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
  if (!(await domainInput.isVisible().catch(() => false))) {
    const inputs = await frame.locator("input:visible").evaluateAll((items) => items.map((item) => item.outerHTML));
    const dialogs = await frame.locator(".member-popup:visible, .popup:visible, [role=dialog]:visible").evaluateAll((items) => items.map((item) => item.outerHTML.slice(0, 8_000)));
    throw new Error(`添加域名表单结构与预期不符；可见输入框：${JSON.stringify(inputs)}；弹窗：${JSON.stringify(dialogs)}`);
  }
  await domainInput.fill(site.testDomain);
  await dialog.locator('input[name="recordNumber"]').fill(site.recordNumber);
  const heldByCustomer = dialog.getByRole("radio").first();
  if (!(await heldByCustomer.isChecked())) await heldByCustomer.check();
  const responsePromise = page.waitForResponse((response) => /\/agent\/domain\/doAddDomain/u.test(response.url()), { timeout: 20_000 });
  await dialog.getByText("确定", { exact: true }).click();
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`新增域名失败：HTTP ${response.status()}`);
  const successMessage = frame.getByText("添加域名成功！", { exact: true });
  const toastConfirmed = await successMessage.waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  await openSiteDomains(page, frame, site);
  const testRow = domainRow(frame, site.testDomain);
  await testRow.waitFor({ state: "visible", timeout: 10_000 });
  const text = await testRow.innerText();
  return {
    status: "added",
    confirmation: toastConfirmed ? "toast" : "domain-row",
    domainId: text.match(/^\s*(\d+)/u)?.[1] || null,
    request: await responseRecord(response),
  };
}

async function editDialog(frame, domain) {
  const row = domainRow(frame, domain);
  await row.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  if (!(await row.isVisible().catch(() => false))) throw new Error(`未找到域名：${domain}`);
  await row.getByText("编辑", { exact: true }).click();
  const defaultMarker = frame.getByText("是否默认：", { exact: true }).last();
  await defaultMarker.waitFor({ state: "visible", timeout: 10_000 });
  const dialog = frame.locator("div:visible")
    .filter({ has: defaultMarker })
    .filter({ hasText: "确定" })
    .last();
  return dialog;
}

async function submitDomainUpdate(page, frame, dialog, expected) {
  const confirm = await lastVisibleText(frame, "确定");
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => /\/agent\/domain\//u.test(candidate.url()) && candidate.request().method() === "POST", { timeout: 20_000 }),
    confirm.click(),
  ]);
  if (!response.ok()) throw new Error(`${expected}失败：HTTP ${response.status()}`);
  const successMessage = frame.getByText("域名更新成功！", { exact: true });
  const toastConfirmed = await successMessage.waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  return { ...(await responseRecord(response)), confirmation: toastConfirmed ? "toast" : "http-200-and-state-check" };
}

async function editRecord(page, frame, site) {
  const dialog = await editDialog(frame, site.testDomain);
  await dialog.locator('input[name="recordNumber"]').fill(site.updatedRecordNumber);
  const request = await submitDomainUpdate(page, frame, dialog, "修改备案号");
  return { status: "edited", before: site.recordNumber, after: site.updatedRecordNumber, request };
}

async function setAvailability(page, frame, site, available) {
  const dialog = await editDialog(frame, site.testDomain);
  await dialog.getByRole("radio", { name: available ? "可用" : "不可用", exact: true }).check();
  const request = await submitDomainUpdate(page, frame, dialog, available ? "启用" : "停用");
  const rowText = await domainRow(frame, site.testDomain).innerText();
  const expected = available ? "可用" : "不可用";
  if (!rowText.includes(expected)) throw new Error(`${available ? "启用" : "停用"}后页面状态不是“${expected}”`);
  return { status: available ? "enabled" : "disabled", domainStatus: expected, request };
}

async function setDefault(page, frame, domain) {
  const dialog = await editDialog(frame, domain);
  const defaultRow = dialog.getByRole("row").filter({ hasText: "是否默认：" });
  const yesRadio = defaultRow.getByRole("radio", { name: "是", exact: true });
  if (await yesRadio.isChecked()) {
    await (await lastVisibleText(frame, "取消")).click();
    return { status: "already-default", domain, request: null };
  }
  await yesRadio.check();
  const request = await submitDomainUpdate(page, frame, dialog, "切换默认域名");
  const rowText = await domainRow(frame, domain).innerText();
  if (!rowText.includes("是")) throw new Error(`默认域名切换后页面未标记“是”：${domain}`);
  return { status: "default-switched", domain, request };
}

async function setDefaultAndEnable(page, frame, site) {
  const dialog = await editDialog(frame, site.testDomain);
  const defaultRow = dialog.getByRole("row").filter({ hasText: "是否默认：" });
  const statusRow = dialog.getByRole("row").filter({ hasText: "域名状态：" });
  const availableRadio = statusRow.getByRole("radio", { name: "可用", exact: true });
  const notDefaultRadio = defaultRow.getByRole("radio", { name: "否", exact: true });
  if ((await availableRadio.isChecked()) || !(await notDefaultRadio.isChecked())) {
    throw new Error("组合操作前置状态不匹配：测试域名必须为“不可用”且非默认");
  }
  await defaultRow.getByRole("radio", { name: "是", exact: true }).check();
  await availableRadio.check();
  const request = await submitDomainUpdate(page, frame, dialog, "同时升默认并启用");
  const row = domainRow(frame, site.testDomain);
  const cells = row.locator("td");
  const actualStatus = (await cells.nth(3).innerText()).trim();
  const actualDefault = (await cells.nth(5).innerText()).trim();
  if (actualStatus !== "可用" || actualDefault !== "是") {
    throw new Error(`组合修改结果不正确：状态=${actualStatus}，默认=${actualDefault}`);
  }
  return {
    status: "default-and-availability-updated",
    domain: site.testDomain,
    availabilityBefore: "不可用",
    availabilityAfter: "可用",
    isDefault: true,
    request,
  };
}

async function deleteDomain(page, frame, site) {
  const row = domainRow(frame, site.testDomain);
  await row.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  if (!(await row.isVisible().catch(() => false))) throw new Error(`删除前未找到测试域名：${site.testDomain}`);
  await row.getByText("删除", { exact: true }).click();
  let deletePrompt = frame.getByText("确定删除该域名吗？", { exact: true }).last();
  await deletePrompt.waitFor({ state: "visible", timeout: 10_000 });
  await (await lastVisibleText(frame, "取消")).click();
  await deletePrompt.waitFor({ state: "hidden", timeout: 10_000 });
  if (!(await domainRow(frame, site.testDomain).count())) throw new Error("取消删除后测试域名意外消失");

  await domainRow(frame, site.testDomain).getByText("删除", { exact: true }).click();
  deletePrompt = frame.getByText("确定删除该域名吗？", { exact: true }).last();
  await deletePrompt.waitFor({ state: "visible", timeout: 10_000 });
  const confirm = await lastVisibleText(frame, "确定");
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => /\/agent\/domain\/delete/u.test(candidate.url()), { timeout: 20_000 }),
    confirm.click(),
  ]);
  if (!response.ok()) throw new Error(`删除域名失败：HTTP ${response.status()}`);
  await frame.getByText("域名删除成功！", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  if (await domainRow(frame, site.testDomain).count()) throw new Error(`删除成功提示后测试域名仍存在：${site.testDomain}`);
  return { status: "deleted", cancelVerified: true, request: await responseRecord(response) };
}

async function runAction(page, frame, site, action) {
  if (action === "add") return addDomain(page, frame, site);
  await openSiteDomains(page, frame, site);
  if (action === "edit") return editRecord(page, frame, site);
  if (action === "disable" || action === "unbind") return setAvailability(page, frame, site, false);
  if (action === "enable" || action === "bind") return setAvailability(page, frame, site, true);
  if (action === "set-test-default") return setDefault(page, frame, site.testDomain);
  if (action === "set-test-default-and-enable") return setDefaultAndEnable(page, frame, site);
  if (action === "restore-default") return setDefault(page, frame, site.originalDomain);
  if (action === "delete") return deleteDomain(page, frame, site);
  throw new Error(`不支持动作：${action}`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  help();
  process.exit(0);
}

const action = args.action || "full-flow";
if (!supportedActions.has(action)) {
  help();
  throw new Error(`未知动作：${action}`);
}

const configPath = path.resolve(args.config || process.env.PHOENIX_DOMAIN_CONFIG || path.join(rootDir, "config", "domain-flow.example.json"));
const rawConfig = await readJson(configPath);
const rawProxyPac = process.env.UI_PROXY_PAC ?? rawConfig.proxyPac;
const config = {
  ...rawConfig,
  proxy: process.env.UI_PROXY ?? rawConfig.proxy,
  proxyPac: rawProxyPac && !/^[a-z][a-z\d+.-]*:/iu.test(rawProxyPac)
    ? pathToFileURL(path.resolve(path.dirname(configPath), rawProxyPac)).href
    : rawProxyPac,
};
const site = config.site;
for (const key of ["name", "siteSettingId", "originalDomain", "testDomain", "recordNumber", "updatedRecordNumber"]) {
  if (!site?.[key]) throw new Error(`配置缺少 site.${key}`);
}

const report = {
  action,
  configPath,
  site: { ...site },
  startedAt: new Date().toISOString(),
  startedAtBeijing: beijingTimestamp(),
  events: [],
};

await fs.mkdir(path.join(rootDir, "output", "playwright"), { recursive: true });
let browser;
let context;
try {
  const launchArgs = [
    ...(config.proxyPac ? [`--proxy-pac-url=${config.proxyPac}`] : []),
    ...(config.ignoreHTTPSErrors ? ["--ignore-certificate-errors"] : []),
  ];
  browser = await chromium.launch({
    headless: Boolean(args.headless || process.env.HEADLESS === "1"),
    ...(launchArgs.length ? { args: launchArgs } : {}),
    ...(!config.proxyPac && proxyOption(config.proxy) ? { proxy: proxyOption(config.proxy) } : {}),
  });
  context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: Boolean(config.ignoreHTTPSErrors),
  });
  const page = await context.newPage();
  await login(page, config);
  const { agentPage, scope: frame } = await openDomainManagement(context, page, config);
  const fullSequence = [
      "add",
      "edit",
      "disable",
      "enable",
      "set-test-default",
      "restore-default",
      "disable",
      "set-test-default-and-enable",
      "restore-default",
      "delete",
    ];
  const sequence = action === "full-flow"
    ? fullSequence
    : action === "resume-after-add"
      ? fullSequence.slice(1)
      : action === "resume-after-edit"
        ? fullSequence.slice(2)
        : action === "resume-after-test-default"
          ? fullSequence.slice(5)
          : [action];
  for (let index = 0; index < sequence.length; index += 1) {
    const current = sequence[index];
    const startedAt = new Date();
    const result = await runAction(agentPage, frame, site, current);
    const evidence = await screenshot(agentPage, current);
    const finishedAt = new Date();
    report.events.push({
      action: current,
      startedAt: startedAt.toISOString(),
      startedAtBeijing: beijingTimestamp(startedAt),
      finishedAt: finishedAt.toISOString(),
      finishedAtBeijing: beijingTimestamp(finishedAt),
      result,
      evidence,
    });
    console.log(`[成功] ${current} | ${result.status}`);
    if (index < sequence.length - 1) {
      const back = frame.getByText("返回", { exact: true });
      await back.waitFor({ state: "visible", timeout: 10_000 });
      await back.click();
      await frame.getByText("添加域名", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    }
  }
  await context.close();
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error);
  if (context) {
    report.failureEvidence = [];
    for (const [index, failurePage] of context.pages().entries()) {
      const failurePath = path.join(rootDir, "output", "playwright", `phoenix-domain-failure-${timestampForFile()}-${index + 1}.png`);
      await failurePage.screenshot({ path: failurePath, fullPage: true }).catch(() => undefined);
      report.failureEvidence.push({ url: failurePage.url(), screenshot: failurePath });
    }
  }
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.finishedAtBeijing = beijingTimestamp();
  await browser?.close();
  const reportPath = path.join(rootDir, "output", "playwright", `phoenix-domain-flow-${timestampForFile()}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`运行报告：${reportPath}`);
}
