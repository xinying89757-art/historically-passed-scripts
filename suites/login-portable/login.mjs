import path from "node:path";
import { fileURLToPath } from "node:url";
import { authConfig, ensureAuthenticated, saveStorageState } from "./auth.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

if (process.argv.includes("--help")) {
  console.log("用法：node --env-file=.env.local login.mjs [--keep-open]");
  console.log("默认使用有界面 Chrome，登录并进入领动云平台，保存登录态后退出。");
  console.log("--keep-open：成功后保留浏览器，手动关闭窗口结束程序。");
  process.exit(0);
}

const config = {
  auth: {
    loginUrl: "https://www.leadong.com/login.html",
    adminUrl: "https://www.leadong.com/website.html",
    storageStatePath: path.join(root, ".auth", "admin.storage.json"),
    maxAttempts: 2,
  },
};

let context;
try {
  const { chromium } = await import("playwright");
  context = await chromium.launchPersistentContext(
    path.resolve(process.env.UI_PROFILE_DIR || path.join(root, ".auth", "chrome-profile")),
    { channel: "chrome", headless: false, locale: "zh-CN" },
  );
  const page = context.pages()[0] ?? await context.newPage();
  const settings = authConfig(config);
  await page.goto(settings.adminUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  const result = await ensureAuthenticated(page, context, config);

  const expected = new URL(settings.adminUrl);
  await page.waitForURL(
    url => url.origin === expected.origin && url.pathname === expected.pathname,
    { timeout: 30000, waitUntil: "domcontentloaded" },
  );
  await saveStorageState(context, config);
  console.log(result.reused ? "已复用登录态，进入领动云平台。" : "自动登录完成，已进入领动云平台。");

  if (process.argv.includes("--keep-open")) {
    console.log("浏览器已保留，关闭窗口即可结束。");
    await new Promise(resolve => context.once("close", resolve));
  }
} catch (error) {
  const message = String(error?.message || error).split("\n")[0];
  console.error(`登录失败：${message}`);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
}
