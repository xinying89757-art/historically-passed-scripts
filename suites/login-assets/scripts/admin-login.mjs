import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const configPath = process.env.BUG1004949_ADMIN_CONFIG ?? path.join(rootDir, "config", "admin-login.json");
const statePath = process.env.UI_STORAGE_STATE ?? path.join(rootDir, "state", "admin.storage.json");
const proxy = process.env.UI_PROXY ?? "http://proxy.example.invalid:8080";
const adminUrl = process.env.UI_ADMIN_URL ?? "https://admin.example.invalid/website.html";
const loginUrl = process.env.UI_ADMIN_LOGIN_URL ?? "https://admin.example.invalid/login.html";
const targetSite = process.env.UI_BASE_URL ?? "http://site.example.invalid";
const headless = process.env.HEADLESS === "1" || process.argv.includes("--headless");
const proxyOption = proxy && !["none", "direct", "off"].includes(proxy.toLowerCase())
  ? { server: proxy }
  : undefined;

async function readConfig() {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  return {
    account: process.env.BUG1004949_ADMIN_ACCOUNT ?? config.account,
    password: process.env.BUG1004949_ADMIN_PASSWORD ?? config.password,
  };
}

async function visible(locator) {
  return locator.isVisible().catch(() => false);
}

async function enterCloudPlatform(page) {
  const avatar = page.locator(".wrap-login-container, .wrap-login-dropdown").first();
  if (await visible(avatar)) await avatar.hover();
  const cloudLink = page.getByText(/(?:返回)?领动云平台/u).last();
  if (await visible(cloudLink)) {
    await cloudLink.click();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
  }
}

async function login(page, credentials) {
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.locator("#loginName").fill(credentials.account);
  await page.locator("#password").fill(credentials.password);
  await page.locator("#loginSubmit").click();
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
  await enterCloudPlatform(page);
  await page.goto(adminUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
}

const credentials = await readConfig();
await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });

let browser;
try {
  browser = await chromium.launch({ headless, ...(proxyOption ? { proxy: proxyOption } : {}) });
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  await page.goto(adminUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

  const loginInput = page.locator("#loginName");
  if (await visible(loginInput) || page.url().includes("/login")) {
    await login(page, credentials);
  }

  const target = page.getByRole("link", { name: targetSite, exact: true });
  if (!(await visible(target))) {
    await enterCloudPlatform(page);
    await page.goto(adminUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }
  if (!(await visible(page.getByRole("link", { name: targetSite, exact: true })))) {
    throw new Error(`登录后未找到英语站点入口：${targetSite}`);
  }

  await context.storageState({ path: statePath });
  await fs.chmod(statePath, 0o600);
  console.log(`管理员登录成功，登录态已保存：${statePath}`);
  await context.close();
} catch (error) {
  console.error(`管理员登录失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
