import { test as base, expect, devices, type Browser, type Page } from "@playwright/test";
import { BackendStateManager } from "../support/backend-state.js";
import { adminBaseUrl, adminStorageState, article0029Fixtures, credentials, employeeMessage, fixturePaths, memberDeniedMessage, protectedMessage, proxyOptions } from "../support/bug1004949-config.js";
import { readyCases } from "../support/case-catalog.js";

const test = base.extend({
  context: async ({ browser }, use) => {
    const context = await browser.newContext({
      storageState: adminStorageState,
      locale: "en-US",
      ...(proxyOptions ? { proxy: proxyOptions } : {}),
    });
    await use(context);
    await context.close();
  },
});

test.setTimeout(Number(process.env.UI_TEST_TIMEOUT_MS ?? "90_000"));

const manager = new BackendStateManager();
const protectedSelector = "#accessPassword";
const productDetailText = /LY-HS8K-3P|product one/i;

async function open(page: Page, path: string): Promise<void> {
  let response = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await page.goto(path, { waitUntil: "domcontentloaded", timeout: 45_000 });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 0 && /ERR_ABORTED/u.test(message)) {
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await page.waitForTimeout(800);
        continue;
      }
      throw error;
    }
  }
  expect(response, `navigation failed for ${path}`).not.toBeNull();
}

async function expectProtected(page: Page): Promise<void> {
  await expect(page.getByText(protectedMessage, { exact: true })).toBeVisible();
  await expect(page.locator(protectedSelector)).toBeVisible();
}

async function unlock(page: Page): Promise<void> {
  await page.locator(protectedSelector).fill(credentials.pagePassword);
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.locator(protectedSelector)).toHaveCount(0);
}

async function expectContent(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.locator("body")).not.toContainText(/404|page not found|does not exist/i);
  await expect(page.locator("body")).toContainText(text);
}

async function openAfterContentSave(page: Page, path: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let body = "";
  do {
    await open(page, path);
    body = await page.locator("body").innerText().catch(() => "");
    if (!/404|page not found|does not exist|link is broken/i.test(body)) return;
    await page.waitForTimeout(2_000);
  } while (Date.now() < deadline);
  throw new Error(`Saved custom URL did not become available within 60 seconds: ${path}`);
}

async function loginMember(page: Page): Promise<void> {
  await page.context().clearCookies();
  const email = page.getByPlaceholder("Email address");
  if (await email.count() === 0) {
    const signIn = page.getByRole("link", { name: "Sign In", exact: true });
    if (await signIn.count()) await signIn.click();
  }
  await page.getByPlaceholder("Email address").fill(credentials.member.account);
  await page.getByPlaceholder("Password").fill(credentials.member.password);
  const completedNavigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => null);
  await page.locator("#loginSubmit").click();
  await completedNavigation;
}

async function loginEmployee(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    locale: "en-US",
    ...(proxyOptions ? { proxy: proxyOptions } : {}),
  });
  const page = await context.newPage();
  await page.goto(`${adminBaseUrl}/login.html`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.getByRole("textbox", { name: "用户名/邮箱/手机号码" }).fill(credentials.employee.account);
  await page.getByRole("textbox", { name: "密码" }).fill(credentials.employee.password);
  const completedNavigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => null);
  await page.getByRole("link", { name: "登录", exact: true }).click();
  await completedNavigation;
  await page.goto(`${adminBaseUrl}/website.html`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await expect(page.locator("body")).not.toContainText(/用户登录入口/u);
  return page;
}

async function expectListPage(page: Page, route: string): Promise<void> {
  await expect.poll(() => new URL(page.url()).pathname).toBe(route);
  await expect(page.locator("body")).not.toContainText(/404|does not exist/i);
  await expect(page.locator("body")).toContainText(/product|article|Inverters|分类|category/i);
}

test.beforeAll(async ({ browser }, testInfo) => {
  if (!process.env.UI_SCENARIO_GROUP || process.env.UI_BACKEND_SETUP === "0") return;
  testInfo.setTimeout(900_000);
  const context = await browser.newContext({ storageState: adminStorageState, locale: "zh-CN", ...(proxyOptions ? { proxy: proxyOptions } : {}) });
  const page = await context.newPage();
  try {
    const baselineFile = process.env.UI_BASELINE_FILE;
    if (baselineFile) await manager.captureBaseline(baselineFile);
    await manager.prepareScenarioGroup(page, process.env.UI_SCENARIO_GROUP);
  } finally {
    await context.close();
  }
});

test.beforeEach(async ({ browser }, testInfo) => {
  if (process.env.UI_SCENARIO_GROUP || process.env.UI_BACKEND_SETUP === "0") return;
  const adminContext = await browser.newContext({ storageState: adminStorageState, locale: "zh-CN", ...(proxyOptions ? { proxy: proxyOptions } : {}) });
  const adminPage = await adminContext.newPage();
  try {
    await manager.ensureScenario(adminPage, testInfo.title.split(":", 1)[0]);
  } finally {
    await adminContext.close();
  }
});

test.afterAll(async ({ browser }, testInfo) => {
  if (process.env.UI_SCENARIO_GROUP) return;
  testInfo.setTimeout(900_000);
  const context = await browser.newContext({ storageState: adminStorageState, locale: "zh-CN", ...(proxyOptions ? { proxy: proxyOptions } : {}) });
  const page = await context.newPage();
  try {
    await manager.restoreBaseline(page);
  } finally {
    await context.close();
  }
});

test("用例-0001: 产品详情密码访问并验证后展示内容", async ({ page }) => {
  await open(page, fixturePaths.product);
  await expectProtected(page);
  await unlock(page);
  await expectContent(page, productDetailText);
});

test("用例-0002: 文章详情密码访问并验证后展示内容", async ({ page }) => {
  await open(page, fixturePaths.article);
  await expectProtected(page);
  await unlock(page);
  await expectContent(page, "article one");
});

test("用例-0003: 受保护详情页查询参数保留", async ({ page }) => {
  for (const [kind, path] of [["product", fixturePaths.product], ["article", fixturePaths.article]] as const) {
    await page.context().clearCookies();
    await open(page, `${path}?case=0003&source=playwright`);
    await expectProtected(page);
    await expect(page).toHaveURL(/case=0003/);
    await expect(page).toHaveURL(/source=playwright/);
    await unlock(page);
    await expect(page).toHaveURL(/case=0003/);
    await expect(page).toHaveURL(/source=playwright/);
    await expectContent(page, kind === "product" ? productDetailText : "article one");
  }
});

test("用例-0004: 手机端受保护详情页显示密码页", async ({ browser }) => {
  const context = await browser.newContext({
    ...devices["iPhone 13"],
    storageState: adminStorageState,
    locale: "en-US",
    ...(proxyOptions ? { proxy: proxyOptions } : {}),
  });
  const page = await context.newPage();
  try {
    for (const path of [fixturePaths.product, fixturePaths.article]) {
      await open(page, `${path}?mobile=1`);
      await expectProtected(page);
      await expect(page).not.toHaveURL(/404/i);
    }
  } finally {
    await context.close();
  }
});

test("用例-0005: 连续访问受保护 URL 三次均显示密码页", async ({ page }) => {
  for (let i = 0; i < 3; i += 1) {
    await open(page, fixturePaths.article);
    await expectProtected(page);
  }
});

test("用例-0007: 无限制产品详情直接展示", async ({ page }) => {
  await open(page, fixturePaths.product);
  await expectContent(page, productDetailText);
  await expect(page.locator(protectedSelector)).toHaveCount(0);
});

test("用例-0008: 未验证受保护 URL 显示密码页", async ({ page }) => {
  await open(page, fixturePaths.product);
  await expectProtected(page);
});

test("用例-0009: 密码验证后查看受保护内容", async ({ page }) => {
  await open(page, fixturePaths.product);
  await expectProtected(page);
  await unlock(page);
  await expectContent(page, productDetailText);
});

test("用例-0010: 未登录会员访问跳转登录页", async ({ page }) => {
  await page.context().clearCookies();
  await open(page, fixturePaths.member);
  await expect(page.getByPlaceholder("Email address")).toBeVisible();
});

test("用例-0011: VIP 会员访问显示内容", async ({ page }) => {
  await open(page, fixturePaths.member);
  await loginMember(page);
  await open(page, fixturePaths.member);
  await expectContent(page, /YOUR_LOCAL_CREDENTIAL|member|product|content/i);
  await expect(page.locator("body")).not.toContainText(memberDeniedMessage);
});

test("用例-0012: 会员等级不足显示无权限页", async ({ page }) => {
  await open(page, fixturePaths.member);
  await loginMember(page);
  await open(page, fixturePaths.member);
  await expect(page.locator("body")).toContainText(memberDeniedMessage);
});

test("用例-0013: 非员工访问显示员工提示页", async ({ page }) => {
  await page.context().clearCookies();
  await open(page, fixturePaths.product);
  await expect(page.locator("body")).toContainText(employeeMessage);
});

test("用例-0014: 员工登录后查看员工保护内容", async ({ browser }) => {
  const employeePage = await loginEmployee(browser);
  try {
    await open(employeePage, fixturePaths.product);
    await expectContent(employeePage, productDetailText);
  } finally {
    await employeePage.context().close();
  }
});

test("用例-0015: 未填写表单显示表单页", async ({ page }) => {
  await page.context().clearCookies();
  await open(page, fixturePaths.form);
  await expect(page.locator("body")).toContainText(/Contact Us|Email|Name|Message/i);
});

test("用例-0016: 填写表单后查看内容", async ({ page }) => {
  await page.context().clearCookies();
  await open(page, fixturePaths.form);
  await page.locator("#extend1").fill("bug1004949@example.com");
  await page.locator("#extend2").fill("BUG1004949");
  await page.locator("#extend3").fill("Reusable Playwright form access validation");
  await page.locator("#formsubmitClone").click();
  await expectContent(page, /success|product|home|thank/i);
});

test("用例-0017: 自建页面密码访问并验证", async ({ page }) => {
  await open(page, fixturePaths.passwordPage);
  await expectProtected(page);
  await unlock(page);
  await expectContent(page, /BUG1004949|Contact Us|product/i);
});

test("用例-0018: 自建页面会员访问跳转登录", async ({ page }) => {
  await page.context().clearCookies();
  await open(page, fixturePaths.member);
  await expect(page.getByPlaceholder("Email address")).toBeVisible();
});

test("用例-0019: 自建页面无限制访问", async ({ page }) => {
  await page.context().clearCookies();
  await open(page, fixturePaths.publicPage);
  await expectContent(page, /Contact Us|Home|product/i);
});

test("用例-0022: 系统自定义 URL 参数不能绕过保护", async ({ page }) => {
  await open(page, `${fixturePaths.product}?_systemCustomUrl_=1`);
  await expectProtected(page);
  await expect(page.locator("body")).not.toContainText(productDetailText);
});

test("用例-0023: 真实请求地址参数不能绕过保护", async ({ page }) => {
  await open(page, `${fixturePaths.article}?foo=1&_realRequestUrl_=${encodeURIComponent(fixturePaths.article)}`);
  await expectProtected(page);
  await expect(page).toHaveURL(/foo=1/);
  await expect(page).toHaveURL(/_realRequestUrl_/);
});

test("用例-0024: 直接访问系统自定义 URL 不能越权", async ({ page }) => {
  await open(page, `/system_custom_url?_systemCustomUrl_=1&_realRequestUrl_=${encodeURIComponent(fixturePaths.product)}`);
  await expect(page.locator("body")).not.toContainText(productDetailText);
});

test("用例-0025: 直接访问密码验证页", async ({ page }) => {
  await open(page, fixturePaths.product);
  await expectProtected(page);
  await expect(page.locator("body")).not.toContainText(productDetailText);
});

test("用例-0026: A 页验证不影响 B 页保护", async ({ page }) => {
  await open(page, fixturePaths.product);
  await expectProtected(page);
  await unlock(page);
  await expectContent(page, productDetailText);
  await open(page, fixturePaths.article);
  await expectProtected(page);
});

test("用例-0027: 刷新后仍显示密码页", async ({ page }) => {
  await open(page, fixturePaths.product);
  await expectProtected(page);
  await page.reload();
  await expectProtected(page);
});

test("用例-0028: 产品详情自定义 URL 内容和标题", async ({ page }) => {
  await open(page, fixturePaths.productOne);
  await expect(page.getByRole("heading", { name: "product one", exact: true }).first()).toBeVisible();
  await expectContent(page, "product one");
});

test("用例-0029: 三条文章详情自定义 URL 内容和标题", async ({ page }) => {
  for (const { path, title } of article0029Fixtures) {
    await open(page, path);
    await expect(page.getByRole("heading", { name: title, exact: true }).first()).toBeVisible();
    await expectContent(page, title);
  }
});

test("用例-0030: 产品分类列表和分页", async ({ page }) => {
  await open(page, fixturePaths.productCategory);
  await expectListPage(page, fixturePaths.productCategory);
  await open(page, fixturePaths.productCategoryPage2);
  await expectListPage(page, fixturePaths.productCategoryPage2);
});

test("用例-0031: 文章分类列表和分页", async ({ page }) => {
  await open(page, fixturePaths.articleCategory);
  await expectListPage(page, fixturePaths.articleCategory);
  await open(page, fixturePaths.articleCategoryPage2);
  await expectListPage(page, fixturePaths.articleCategoryPage2);
});

test("用例-0032: 图库详情自定义 URL", async ({ page }) => {
  await open(page, fixturePaths.gallery);
  await expectContent(page, /Solitude three|gallery|album/i);
});

test("用例-0033: 图库分类自定义 URL", async ({ page }) => {
  await open(page, fixturePaths.galleryCategory);
  await expectContent(page, /classification one|gallery|图册/i);
});

test("用例-0035: 视频分类自定义 URL", async ({ page }) => {
  await open(page, fixturePaths.videoCategory);
  await expectContent(page, /video two|video four|category/i);
});

test("用例-0036: 带目录和根目录自定义 URL", async ({ page }, testInfo) => {
  testInfo.setTimeout(180_000);
  await open(page, fixturePaths.productOne);
  await expectContent(page, "product one");
  const adminContext = await page.context().browser()?.newContext({ storageState: adminStorageState, locale: "zh-CN", ...(proxyOptions ? { proxy: proxyOptions } : {}) });
  if (!adminContext) throw new Error("Unable to create backend context for URL stage transition");
  const adminPage = await adminContext.newPage();
  try {
    await manager.setContentStage(adminPage, "用例-0036", 0, fixturePaths.productRoot);
  } finally {
    await adminContext.close();
  }
  await openAfterContentSave(page, fixturePaths.productRoot);
  await expectContent(page, "product one");
});

test("用例-0037: 系统 URL 跳转到自定义 URL", async ({ page }) => {
  await open(page, fixturePaths.productSystem);
  await expect(page).toHaveURL(/bug1004949\/product\.html/);
  await expectContent(page, /LY-HS8K-3P|product one/i);
});

test("用例-0038: 带目录和根目录分类分页", async ({ page }, testInfo) => {
  testInfo.setTimeout(240_000);
  await open(page, fixturePaths.productCategoryPage2);
  await expectListPage(page, fixturePaths.productCategoryPage2);
  await open(page, fixturePaths.articleCategoryPage2);
  await expectListPage(page, fixturePaths.articleCategoryPage2);
  const adminContext = await page.context().browser()?.newContext({ storageState: adminStorageState, locale: "zh-CN", ...(proxyOptions ? { proxy: proxyOptions } : {}) });
  if (!adminContext) throw new Error("Unable to create backend context for category URL stage transition");
  const adminPage = await adminContext.newPage();
  const runToken = Date.now().toString(36);
  const productRoot = `/pc-${runToken}.html`;
  const articleRoot = `/ac-${runToken}.html`;
  try {
    await manager.setContentStage(adminPage, "用例-0038", 0, productRoot);
    await manager.setContentStage(adminPage, "用例-0038", 1, articleRoot);
  } finally {
    await adminContext.close();
  }
  for (const path of [productRoot.replace(/\.html$/u, "-p2.html"), articleRoot.replace(/\.html$/u, "-p2.html")]) {
    await openAfterContentSave(page, path);
    await expectListPage(page, path);
  }
});

test("用例-0039: 短链接跳转目标页面", async ({ page }) => {
  await open(page, fixturePaths.productShort);
  await expectContent(page, /LY-H72-600W|Monocrystalline Module|product/i);
});

test("用例-0043: 不存在链接显示自定义 404", async ({ page }) => {
  await open(page, fixturePaths.notFound);
  await expect(page.locator("body")).toContainText(/does not exist|link is broken|404/i);
  await expect(page.locator("body")).not.toContainText("product one");
});

for (const item of readyCases) {
  if (!item.id || !item.title) throw new Error("Catalog contains an empty runnable case");
}
