import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const storageState = process.env.UI_STORAGE_STATE ?? path.join(runnerRoot, "fixtures", "admin.storage.json");
const proxy = process.env.UI_PROXY ?? "http://proxy.example.invalid:8080";
const adminUrl = process.env.UI_ADMIN_URL ?? "https://admin.example.invalid/website.html";
const installedChromium = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? await fs.access(installedChromium).then(() => installedChromium).catch(() => undefined);

const browser = await chromium.launch({ headless: false, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({
  storageState,
  locale: "zh-CN",
  proxy: { server: proxy },
});
const page = await context.newPage();
await page.goto(adminUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((error) => {
  console.error(`打开后台入口失败：${error instanceof Error ? error.message : String(error)}`);
});
console.log(`Playwright 浏览器已打开：${adminUrl}`);
console.log("请完成登录；检测到目标英语站点后将自动保存登录态并关闭浏览器。");

const targetSite = "http://site.example.invalid";
const deadline = Date.now() + 10 * 60_000;
while (Date.now() < deadline) {
  const target = page.getByRole("link", { name: targetSite, exact: true });
  if (await target.isVisible().catch(() => false)) {
    await context.storageState({ path: storageState });
    console.log(`登录态已保存：${storageState}`);
    await context.close();
    await browser.close();
    process.exit(0);
  }
  await page.waitForTimeout(1_000);
}

console.error("等待登录超时，未保存登录态。");
await context.close();
await browser.close();
process.exit(1);
