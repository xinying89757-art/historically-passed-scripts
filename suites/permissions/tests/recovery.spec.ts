import { test } from "@playwright/test";
import { BackendStateManager } from "../support/backend-state.js";
import { adminBaseUrl, adminStorageState, credentials, proxyUrl, siteBaseUrl } from "../support/bug1004949-config.js";

async function ensureAdminSession(page: import("@playwright/test").Page, context: import("@playwright/test").BrowserContext): Promise<void> {
  await page.goto(`${adminBaseUrl}/website.html`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  const body = await page.locator("body").innerText().catch(() => "");
  if (!/登录|用户登录入口/u.test(await page.title()) && !/登录|用户登录入口/u.test(body)) return;
  await page.goto(`${adminBaseUrl}/login.html`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  const account = page.locator("#loginName");
  const password = page.locator("#password");
  await account.waitFor({ state: "visible", timeout: 20_000 });
  await password.waitFor({ state: "visible", timeout: 20_000 });
  await account.fill(credentials.admin.account);
  await password.fill(credentials.admin.password);
  await page.locator("#loginSubmit").waitFor({ state: "visible", timeout: 10_000 });
  await page.locator("#loginSubmit").click();
  const avatar = page.locator(".wrap-login-container, .wrap-login-dropdown").first();
  await avatar.waitFor({ state: "visible", timeout: 20_000 });
  await avatar.hover();
  const cloudPlatform = page.getByText(/(?:返回)?领动云平台/u).last();
  await cloudPlatform.waitFor({ state: "visible", timeout: 10_000 });
  await cloudPlatform.click();
  await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
  await page.goto(`${adminBaseUrl}/website.html`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.locator(".contentShow").filter({ has: page.getByRole("link", { name: siteBaseUrl, exact: true }) }).first()
    .waitFor({ state: "visible", timeout: 20_000 });
  await context.storageState({ path: adminStorageState });
}

test("BUG1004949 recovery: restore private backend journal", async ({ browser }) => {
  test.setTimeout(900_000);
  const context = await browser.newContext({ storageState: adminStorageState, locale: "zh-CN", proxy: { server: proxyUrl } });
  const page = await context.newPage();
  try {
    await ensureAdminSession(page, context);
    await new BackendStateManager().restoreBaseline(page);
  } finally {
    await context.close();
  }
});
