import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig, validateConfig } from "./config.mjs";
import { getOrCreatePage, launchProxyContext } from "./browser.mjs";
import { probePage } from "./probe.mjs";

const args = process.argv.slice(2);
const command = args[0] ?? "config";
const config = await loadConfig(findOption("--config") ?? undefined);
const configErrors = validateConfig(config);
if (configErrors.length) throw new Error(configErrors.join("；"));

if (command === "config") {
  console.log(JSON.stringify({
    loginUrl: config.loginUrl,
    proxy: config.proxy,
    publicBaseUrl: config.publicBaseUrl,
    siteLanguage: config.siteLanguage,
    userDataDir: config.paths.userDataDir,
    artifactsDir: config.paths.artifactsDir,
    reportPath: config.paths.reportPath
  }, null, 2));
} else if (command === "auth") {
  await auth(config);
} else if (command === "probe") {
  await probe(config);
} else {
  throw new Error(`未知命令：${command}。可用命令：config、auth、probe`);
}

function findOption(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function waitForUser(message) {
  const rl = createInterface({ input, output });
  try {
    await rl.question(`${message}\n完成后按回车继续：`);
  } finally {
    rl.close();
  }
}

async function auth(config) {
  const context = await launchProxyContext(config, { headed: true });
  const page = await getOrCreatePage(context);
  console.log(`已通过代理启动浏览器：${config.proxy.server}`);
  console.log(`登录入口：${config.loginUrl}`);
  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await waitForUser("请手动登录，并进入目标站点的 3.0 编辑器。不要点击保存、发布或提交。 ");
  console.log(JSON.stringify({ status: "auth-ready", url: page.url(), title: await page.title().catch(() => "") }, null, 2));
  await context.close();
}

async function probe(config) {
  const context = await launchProxyContext(config, { headed: true });
  const page = await getOrCreatePage(context);
  console.log(`已通过代理启动浏览器：${config.proxy.server}`);
  const startUrl = findOption("--start-url") ?? config.editorUrl;
  if (startUrl) {
    try {
      await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (error) {
      console.warn(`editorUrl 访问失败，将改为从登录入口手动进入：${error.message}`);
      await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    }
  } else {
    await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  }
  await openTargetSite(page, context, config);
  console.log(`当前脚本页面：${page.url()}`);
  await waitForUser("请确认这个脚本新打开的独立 Chrome 窗口已经进入目标站点的 3.0 编辑器；如果自动定位失败，请手动进入后回到此终端按回车。不要使用 Codex 内置浏览器标签页。 ");
  const targetPage = await chooseProbePage(context, page, config);
  console.log(`开始探测页面：${targetPage.url()}`);
  const report = await probePage(targetPage, config);
  console.log(JSON.stringify({ status: report.status, url: report.page.url, report: config.paths.reportPath }, null, 2));
  await context.close();
}

async function openTargetSite(page, context, config) {
  if (!config.publicBaseUrl || /pagebuilder|blockEditorUI/iu.test(page.url())) return false;
  // The site list is an async SPA; give its cards time to render before falling back
  // to the live text. This is navigation only and does not mutate site data.
  await page.waitForTimeout(4000);
  const cardCount = await page.locator(".mySiteBox").count().catch(() => 0);
  const domainCount = await page.getByText(config.publicBaseUrl, { exact: false }).count().catch(() => 0);
  const card = cardCount
    ? page.locator(".mySiteBox").filter({ hasText: config.publicBaseUrl })
    : page.getByText(config.publicBaseUrl, { exact: false }).first().locator("xpath=ancestor::*[.//*[self::a or self::button][contains(normalize-space(.),'编辑网站')]][1]");
  if (await card.count() === 1) {
    const edit = card.locator(".userEditSite").or(card.getByText("编辑网站", { exact: true })).or(card.getByRole("link", { name: /编辑网站/u })).or(card.getByRole("button", { name: /编辑网站/u })).first();
    if (await edit.isVisible().catch(() => false)) {
      await clickAndWaitForNewPage(edit, context, page);
      return true;
    }
  }
  // Some platform revisions expose the current site's editor as “网页编辑”
  // instead of rendering a .mySiteBox card. Prefer the recorded semantic link.
  const editorLinks = page.getByRole("link", { name: /网页编辑/u });
  if (await editorLinks.count() === 1 && await editorLinks.first().isVisible().catch(() => false)) {
    await clickAndWaitForNewPage(editorLinks.first(), context, page);
    return true;
  }
  console.warn(`未能根据前台域名唯一定位站点编辑入口：${config.publicBaseUrl}（旧卡片=${cardCount}，域名文本=${domainCount}）`);
  return false;
}

async function clickAndWaitForNewPage(locator, context, sourcePage) {
  const before = new Set(context.pages());
  const popupPromise = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await locator.click();
  const popup = await popupPromise;
  const opened = popup ?? context.pages().find((candidate) => !before.has(candidate));
  if (opened) {
    await opened.waitForLoadState({ state: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await opened.bringToFront().catch(() => {});
  } else {
    await sourcePage.waitForTimeout(2500);
  }
}

async function chooseProbePage(context, fallback, config) {
  const pages = context.pages();
  const candidates = pages.filter((candidate) => {
    const url = candidate.url();
    return url && url !== "about:blank" && url !== config.loginUrl;
  });
  for (const candidate of [...candidates].reverse()) {
    const featureCount = await candidate.getByText(/管理\s*txt\s*文件|llms\.?txt/iu).count().catch(() => 0);
    if (featureCount > 0) return candidate;
  }
  const editor = candidates.find((candidate) => /pagebuilder|blockEditorUI/iu.test(candidate.url()));
  return editor ?? candidates.at(-1) ?? fallback;
}
