import fs from "node:fs/promises";
import type { FrameLocator, Page } from "@playwright/test";
import { adminBaseUrl, article0029Fixtures, credentials, fixturePaths, adminStorageState, siteBaseUrl } from "./bug1004949-config.js";
import { permissionMismatchReason, permissionStateMatches, type AccessMode, type PagePermissionState } from "./permission-state.js";

export type { AccessMode } from "./permission-state.js";

type ContentObject = {
  module: "产品" | "文章" | "图册" | "视频";
  menu: string;
  listPage: string;
  name: string;
  url: string;
  urlLabel: string;
  itemLink?: boolean;
};

const contentByCase: Record<string, ContentObject[]> = {
  "用例-0028": [{ module: "产品", menu: "产品", listPage: "管理产品", name: "product one", url: "/bug1004949/product-one.html", urlLabel: "产品URL", itemLink: true }],
  "用例-0029": [
    { module: "文章", menu: "文章", listPage: "管理文章", name: article0029Fixtures[0].title, url: article0029Fixtures[0].path, urlLabel: "文章URL", itemLink: true },
    { module: "文章", menu: "文章", listPage: "管理文章", name: article0029Fixtures[1].title, url: article0029Fixtures[1].path, urlLabel: "文章URL", itemLink: true },
    { module: "文章", menu: "文章", listPage: "管理文章", name: article0029Fixtures[2].title, url: article0029Fixtures[2].path, urlLabel: "文章URL", itemLink: true },
  ],
  "用例-0030": [{ module: "产品", menu: "产品", listPage: "管理产品分类", name: "Inverters", url: "/bug1004949/product-category.html", urlLabel: "分类URL" }],
  "用例-0031": [{ module: "文章", menu: "文章", listPage: "管理文章分类", name: "article classification one（文章分类1）", url: "/bug1004949/article-category.html", urlLabel: "分类URL" }],
  "用例-0032": [{ module: "图册", menu: "图册", listPage: "管理图册", name: "Solitude three", url: "/bug1004949/gallery.html", urlLabel: "图册URL" }],
  "用例-0033": [{ module: "图册", menu: "图册", listPage: "管理图册分类", name: "图册分类1 classification one", url: "/bug1004949/gallery-category.html", urlLabel: "分类URL" }],
  "用例-0034": [{ module: "视频", menu: "视频", listPage: "管理视频", name: "video two", url: "/bug1004949/video.html", urlLabel: "视频URL" }],
  "用例-0035": [{ module: "视频", menu: "视频", listPage: "管理视频分类", name: "Create your own quiet luxury（视频分类2）", url: "/bug1004949/video-category.html", urlLabel: "分类URL" }],
  // 0028 and 0036 intentionally share the same product and the same initial
  // directory URL. 0036 performs the root-URL transition during its own test;
  // using a second setup URL here would invalidate 0028 before verification.
  "用例-0036": [{ module: "产品", menu: "产品", listPage: "管理产品", name: "product one", url: "/bug1004949/product-one.html", urlLabel: "产品URL", itemLink: true }],
  "用例-0037": [{ module: "产品", menu: "产品", listPage: "管理产品", name: "LY-HS8K-3P Three-Phase Hybrid Storage Inverter", url: "/bug1004949/product.html", urlLabel: "产品URL", itemLink: true }],
  "用例-0038": [
    { module: "产品", menu: "产品", listPage: "管理产品分类", name: "Inverters", url: "/bug1004949/product-category.html", urlLabel: "分类URL" },
    { module: "文章", menu: "文章", listPage: "管理文章分类", name: "article classification one（文章分类1）", url: "/bug1004949/article-category.html", urlLabel: "分类URL" },
  ],
  "用例-0039": [{ module: "产品", menu: "产品", listPage: "管理产品", name: "LY-H72-600W TOPCon Monocrystalline Module", url: "/short.html", urlLabel: "产品URL", itemLink: true }],
};

const protectedArticleObject: ContentObject = {
  module: "文章",
  menu: "文章",
  listPage: "管理文章",
  name: "article one",
  url: "/bug1004949/article.html",
  urlLabel: "文章URL",
  itemLink: true,
};

type Baseline = {
  capturedAt: string;
  storageState: string;
  site: string;
  fixturePaths: typeof fixturePaths;
  note: string;
  pages?: Record<string, PagePermissionState>;
  content?: Record<string, { object: ContentObject; url: string | undefined; isCustom: boolean }>;
};

const pageByCase: Record<string, string> = {
  "用例-0001": "Product Detail",
  "用例-0002": "News Detail",
  "用例-0003": "Product Detail",
  "用例-0004": "Product Detail",
  "用例-0005": "Product Detail",
  "用例-0007": "Product Detail",
  "用例-0008": "Product Detail",
  "用例-0009": "Product Detail",
  "用例-0010": "BUG1004949 Member Page",
  "用例-0011": "BUG1004949 Member Page",
  "用例-0012": "BUG1004949 Member Page",
  "用例-0013": "Product Detail",
  "用例-0014": "Product Detail",
  "用例-0015": "BUG1004949 Form Page",
  "用例-0016": "BUG1004949 Form Page",
  "用例-0017": "BUG1004949 Password Page",
  "用例-0018": "BUG1004949 Member Page",
  "用例-0019": "BUG1004949 Public Page",
  "用例-0022": "Product Detail",
  "用例-0023": "Product Detail",
  "用例-0024": "Product Detail",
  "用例-0025": "Product Detail",
  "用例-0026": "Product Detail",
  "用例-0027": "Product Detail",
  "用例-0028": "Product Detail",
  "用例-0029": "News Detail",
  "用例-0036": "Product Detail",
  "用例-0037": "Product Detail",
  "用例-0039": "Product Detail",
};

function permissionFor(caseId: string): AccessMode | undefined {
  if (["用例-0001", "用例-0002", "用例-0003", "用例-0004", "用例-0005", "用例-0008", "用例-0009", "用例-0017", "用例-0022", "用例-0023", "用例-0024", "用例-0025", "用例-0026", "用例-0027"].includes(caseId)) return "password";
  if (["用例-0010", "用例-0011", "用例-0012", "用例-0018"].includes(caseId)) return "member";
  if (["用例-0013", "用例-0014"].includes(caseId)) return "employee";
  if (["用例-0015", "用例-0016"].includes(caseId)) return "form";
  if (["用例-0007", "用例-0019", "用例-0028", "用例-0029", "用例-0036", "用例-0037", "用例-0039"].includes(caseId)) return "public";
  return undefined;
}

async function forceClick(locator: ReturnType<Page["getByText"]>): Promise<void> {
  await locator.first().evaluate((element) => (element as HTMLElement).click());
}

async function clickIfVisible(page: Page, text: string | RegExp): Promise<boolean> {
  const locator = page.getByText(text, { exact: typeof text === "string" });
  if (await locator.count() === 0) return false;
  await forceClick(locator);
  return true;
}

export class BackendStateManager {
  private baseline: Baseline | undefined;
  private readonly baselinePages = new Map<string, PagePermissionState>();
  private readonly baselineContent = new Map<string, { object: ContentObject; url: string | undefined; isCustom: boolean }>();
  private readonly contentPages = new WeakMap<Page, Page>();

  async captureBaseline(file: string): Promise<void> {
    if (file) await this.loadBaseline(file);
    this.baseline = {
      capturedAt: new Date().toISOString(),
      storageState: adminStorageState,
      site: process.env.UI_BASE_URL ?? "http://site.example.invalid",
      fixturePaths,
      note: "Permission and content values are restored by the same UI flows used to configure each scenario. The file intentionally contains no credentials.",
    };
    if (file) await this.persistBaseline(file);
  }

  private baselineFile(): string | undefined {
    return process.env.UI_BASELINE_FILE || process.env.UI_AUTOMATION_BASELINE_FILE;
  }

  private async loadBaseline(file = this.baselineFile()): Promise<void> {
    if (!file) return;
    try {
      const saved = JSON.parse(await fs.readFile(file, "utf8")) as Baseline;
      this.baseline = saved;
      for (const [name, state] of Object.entries(saved.pages ?? {})) this.baselinePages.set(name, state);
      for (const [key, state] of Object.entries(saved.content ?? {})) this.baselineContent.set(key, state);
    } catch {
      // The first UI read creates a fresh journal when no valid journal exists.
    }
  }

  private async persistBaseline(file = this.baselineFile()): Promise<void> {
    if (!file) return;
    const baseline: Baseline = {
      ...(this.baseline ?? {
        capturedAt: new Date().toISOString(),
        storageState: adminStorageState,
        site: siteBaseUrl,
        fixturePaths,
        note: "Private recovery journal; no credentials are stored.",
      }),
      pages: Object.fromEntries(this.baselinePages),
      content: Object.fromEntries(this.baselineContent),
    };
    await fs.writeFile(file, JSON.stringify(baseline, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.chmod(file, 0o600).catch(() => undefined);
  }

  async prepareScenarioGroup(page: Page, group: string): Promise<void> {
    if (process.env.UI_BACKEND_SETUP === "0") return;
    await this.loadBaseline();
    const configure = async (pageName: string, mode: AccessMode, memberLevel = "VIP") => {
      await this.ensurePagePermission(page, pageName, this.targetPermission(mode, memberLevel), true);
    };
    if (group === "password") {
      await configure("Product Detail", "password");
      await configure("News Detail", "password");
      await configure("BUG1004949 Password Page", "password");
      // The dedicated article fixture is a content URL, not a page-builder
      // page.  Re-establish it before validating News Detail permissions.
      await this.setContentUrl(page, protectedArticleObject);
    } else if (group === "member-vip") {
      await configure("BUG1004949 Member Page", "member", "VIP");
    } else if (group === "member-low") {
      await configure("BUG1004949 Member Page", "member", "无级别");
    } else if (group === "employee") {
      await configure("Product Detail", "employee");
    } else if (group === "form") {
      await configure("BUG1004949 Form Page", "form");
    } else if (group === "public") {
      await configure("Product Detail", "public");
      await configure("BUG1004949 Public Page", "public");
    } else if (group === "custom-url" || group === "redirects") {
      const ids = group === "redirects"
        ? ["用例-0037", "用例-0039"]
        : ["用例-0028", "用例-0029", "用例-0030", "用例-0031", "用例-0032", "用例-0033", "用例-0035", "用例-0036", "用例-0038"];
      const requested = new Set((process.env.UI_SCENARIO_IDS ?? "").split(",").filter(Boolean));
      const activeIds = requested.size ? requested : new Set(ids);
      const productDetailIds = ["用例-0028", "用例-0036", "用例-0037", "用例-0039"];
      if (productDetailIds.some((id) => activeIds.has(id))) {
        await configure("Product Detail", "public");
      }
      if (activeIds.has("用例-0029")) {
        await configure("News Detail", "public");
      }
      for (const id of ids) {
        if (requested.size && !requested.has(id)) continue;
        for (const object of contentByCase[id] ?? []) await this.setContentUrl(page, object);
      }
    }
    await this.persistBaseline();
  }

  async ensureScenario(page: Page, caseId: string): Promise<void> {
    if (process.env.UI_BACKEND_SETUP === "0") return;
    const mode = permissionFor(caseId);
    if (mode) {
      const pageName = pageByCase[caseId];
      if (!pageName) throw new Error(`No backend page fixture mapping for ${caseId}`);
      const memberLevel = caseId === "用例-0012" ? "无级别" : "VIP";
      await this.ensurePagePermission(page, pageName, this.targetPermission(mode, memberLevel), true);
      if (caseId === "用例-0003" || caseId === "用例-0004") {
        await this.ensurePagePermission(page, "News Detail", this.targetPermission(mode, memberLevel), true);
      }
    }
    for (const object of contentByCase[caseId] ?? []) {
      await this.setContentUrl(page, object);
    }
  }

  async setContentStage(page: Page, caseId: string, objectIndex: number, url: string): Promise<void> {
    if (process.env.UI_BACKEND_SETUP === "0" && process.env.UI_RUNTIME_MUTATION !== "1") {
      throw new Error(`Runtime backend mutation is not enabled for ${caseId}`);
    }
    // Stage transitions run in the verification Playwright process, while the
    // original baseline was captured by the setup process. Load that shared
    // journal before changing anything so final recovery still restores the
    // true pre-run value rather than the intermediate scenario value.
    await this.loadBaseline();
    const object = contentByCase[caseId]?.[objectIndex];
    if (!object) throw new Error(`No content stage ${objectIndex} for ${caseId}`);
    await this.setContentUrl(page, object, url);
  }

  async restoreBaseline(page: Page): Promise<void> {
    if (process.env.UI_BACKEND_SETUP === "0") return;
    await this.loadBaseline();
    for (const [pageName, state] of this.baselinePages) {
      await this.ensurePagePermission(page, pageName, state, false);
    }
    for (const { object, url, isCustom } of this.baselineContent.values()) {
      await this.setContentUrl(page, object, url, true, isCustom);
    }
    await this.persistBaseline();
  }

  private async confirmMultiSiteLogin(page: Page): Promise<boolean> {
    for (const frame of page.frames()) {
      const continueLogin = frame.getByText("继续登录", { exact: true }).first();
      if (!(await continueLogin.isVisible().catch(() => false))) continue;
      await continueLogin.click({ force: true });
      const confirm = frame.getByText("确定", { exact: true }).first();
      await confirm.waitFor({ state: "visible", timeout: 10_000 });
      await confirm.click({ force: true });
      return true;
    }
    return false;
  }

  private async enterContentArea(page: Page): Promise<Page> {
    const cached = this.contentPages.get(page);
    if (cached && !cached.isClosed() && await cached.locator("iframe#prod, iframe#article, iframe#gallery, iframe#video").count() > 0) return cached;

    await page.goto(`${adminBaseUrl}/website.html`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const targetSite = page.locator(".contentShow").filter({
      has: page.getByRole("link", { name: siteBaseUrl, exact: true }),
    }).first();
    await targetSite.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
      throw new Error(`建站后台未找到目标英语站点：${siteBaseUrl}`);
    });
    const popupPromise = page.context().waitForEvent("page", { timeout: 15_000 });
    await targetSite.getByText("内容管理", { exact: true }).first().click();
    const contentPage = await popupPromise;
    try {
      const productFrame = contentPage.locator("iframe#prod");
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        if (await productFrame.isVisible().catch(() => false)) {
          this.contentPages.set(page, contentPage);
          return contentPage;
        }
        if (!(await this.confirmMultiSiteLogin(contentPage))) {
          await contentPage.waitForTimeout(250);
        }
      }
      const location = new URL(contentPage.url());
      throw new Error(`内容管理未加载产品模块：${location.origin}${location.pathname}`);
    } catch (error) {
      await contentPage.close().catch(() => undefined);
      throw error;
    }
  }

  private async contentFrame(page: Page): Promise<FrameLocator> {
    const contentPage = await this.enterContentArea(page);
    const frame = contentPage.locator("iframe").first().contentFrame();
    if (await frame.getByText("管理产品", { exact: true }).count() + await frame.getByText("管理文章", { exact: true }).count() + await frame.getByText("管理图册", { exact: true }).count() + await frame.getByText("管理视频", { exact: true }).count() === 0) {
      throw new Error("Content Management iframe is unavailable; refusing to edit an unintended page");
    }
    return frame;
  }

  private async openContentObject(page: Page, object: ContentObject): Promise<FrameLocator> {
    const contentPage = await this.enterContentArea(page);
    const moduleFrameId: Record<ContentObject["module"], string> = {
      产品: "prod",
      文章: "article",
      图册: "gallery",
      视频: "video",
    };
    // Top-menu handlers switch iframes asynchronously.  Under the proxy their
    // delayed callback can race with list navigation and switch the visible
    // module back to Product, leaving the requested row in a hidden iframe.
    // The module query is the stable route used by the same UI.
    const moduleId = moduleFrameId[object.module];
    const moduleUrl = new URL(contentPage.url());
    moduleUrl.pathname = "/phoenix/website";
    moduleUrl.search = `?module=${encodeURIComponent(moduleId)}`;
    await contentPage.goto(moduleUrl.toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
    const frameElement = contentPage.locator(`iframe#${moduleFrameId[object.module]}`);
    await frameElement.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {
      throw new Error(`Content module iframe did not open: ${object.module}`);
    });
    const frame = frameElement.contentFrame();
    const sub = frame.getByRole("link", { name: object.listPage, exact: true });
    await sub.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
      throw new Error(`Content list page not found: ${object.listPage}`);
    });
    const action = await sub.getAttribute("action");
    const actualFrame = contentPage.frames().find((candidate) => candidate.name() === moduleFrameId[object.module]);
    if (action && actualFrame) {
      const route = new URL(actualFrame.url());
      route.pathname = `/${moduleFrameId[object.module]}`;
      route.search = `?invokeAction=${encodeURIComponent(action)}`;
      await actualFrame.goto(route.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
    } else {
      await sub.evaluate((element) => (element as HTMLElement).click());
    }
    const row = frame.locator("tr").filter({ hasText: object.name }).first();
    // Content-management list pages briefly keep the previous view visible while
    // loading through the proxy. Wait for the requested object, not just the click.
    await row.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {
      throw new Error(`Content object not found: ${object.name}`);
    });
    if (object.itemLink) {
      const item = row.getByRole("link", { name: object.name, exact: true });
      if (await item.count() === 0) throw new Error(`Content item link not found: ${object.name}`);
      await item.evaluate((element) => (element as HTMLElement).click());
    } else {
      // The number and order of links differs between gallery, video and category
      // lists.  Positional selection can hit "frontend preview" (target=_blank)
      // and leave the iframe on the list forever.  Every list exposes a stable
      // edit wrapper, so select the intended action semantically.
      const edit = row.locator('[title="编辑"] a').first();
      if (await edit.count() === 0) throw new Error(`Content edit control not found: ${object.name}`);
      await edit.evaluate((element) => (element as HTMLElement).click());
    }
    await page.waitForTimeout(500);
    return frame;
  }

  private async setContentUrl(page: Page, object: ContentObject, targetUrl?: string, restoring = false, restoreCustom = false, retryCount = 0): Promise<void> {
    const frame = await this.openContentObject(page, object);
    const urlInput = frame.locator('input.custom-input-url, input#detailUrl, input#cateUrl, input[placeholder="请输入URL"]').first();
    if (object.module === "视频" && object.listPage === "管理视频") return;
    // Some editors keep the URL row below a collapsed/scrolling SEO section.
    // It is attached and submitted with the form even when Playwright's
    // viewport-based visibility check reports false.
    const hasCustomUrl = await urlInput.waitFor({ state: "attached", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!hasCustomUrl) {
      throw new Error(`Custom URL control not found for ${object.module} ${object.name}`);
    }
    const key = `${object.module}:${object.name}`;
    if (!this.baselineContent.has(key)) {
      const isCustom = await frame.locator("#customUrl").evaluate((element) => element.classList.contains("on")).catch(() => false);
      this.baselineContent.set(key, { object, url: await urlInput.inputValue().catch(() => undefined), isCustom });
      await this.persistBaseline();
    }
    const desiredUrl = targetUrl ?? object.url;
    const normalizeUrl = (value: string | undefined) => value?.replace(/^\//u, "");
    const currentlyCustom = await frame.locator("#customUrl").evaluate((element) => element.classList.contains("on")).catch(() => false);
    const currentUrl = await urlInput.inputValue().catch(() => undefined);
    if (!restoring && currentlyCustom && normalizeUrl(currentUrl) === normalizeUrl(desiredUrl)) return;
    if (!restoring) {
      await frame.locator("#customUrl").click({ force: true });
      await urlInput.fill(desiredUrl, { force: true });
    } else if (restoreCustom) {
      await frame.locator("#customUrl").click({ force: true });
      await urlInput.fill(targetUrl ?? "", { force: true });
    } else {
      await frame.locator("#defaultUrl").evaluate((element) => (element as HTMLElement).click());
    }
    const save = frame.getByRole("link", { name: "保存", exact: true }).last();
    if (await save.count() === 0) throw new Error(`Save control not found for ${object.module} ${object.name}`);
    // Switching from system to custom URL can redraw the field after fill().
    // Check its live value in the same browser task that clicks Save, so a
    // delayed redraw cannot silently submit the old URL.
    const expectedInput = !restoring || restoreCustom ? desiredUrl : undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (expectedInput !== undefined && normalizeUrl(await urlInput.inputValue()) !== normalizeUrl(expectedInput)) {
        await urlInput.fill(expectedInput, { force: true });
      }
      try {
        await save.evaluate((element, expected) => {
          if (expected !== undefined) {
            const input = element.ownerDocument.querySelector<HTMLInputElement>('input.custom-input-url, input#detailUrl, input#cateUrl, input[placeholder="请输入URL"]');
            if (!input || input.value.replace(/^\//u, "") !== expected.replace(/^\//u, "")) {
              throw new Error("URL input changed before save");
            }
          }
          (element as HTMLElement).click();
        }, expectedInput);
        break;
      } catch (error) {
        if (attempt === 1 || !String(error).includes("URL input changed before save")) throw error;
      }
    }
    const duplicateDialog = frame.getByRole("heading", { name: "重复确认", exact: true }).locator("..");
    const duplicateDialogAppeared = await duplicateDialog.waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (duplicateDialogAppeared) {
      const confirm = duplicateDialog.getByRole("link", { name: "确定", exact: true });
      await confirm.waitFor({ state: "visible", timeout: 5_000 });
      await confirm.evaluate((element) => (element as HTMLElement).click());
    }
    const saveDialog = frame.getByRole("heading", { name: /(?:保存|更新)成功/u }).first();
    await Promise.any([
      saveDialog.waitFor({ state: "visible", timeout: 30_000 }),
      urlInput.waitFor({ state: "hidden", timeout: 30_000 }),
    ]).catch(async () => {
      const validation = await frame.locator(".wrong:visible").allTextContents().catch(() => []);
      if (validation.some((text) => text.trim())) {
        throw new Error(`Content save validation failed: ${validation.map((text) => text.trim()).filter(Boolean).join("；")}`);
      }
      throw new Error(`Content save did not report success: ${object.module} ${object.name}`);
    });
    if (!restoring) {
      // The success dialog overlays the editor and the original iframe can
      // still contain the pre-save value.  Re-enter the same stable object
      // after save and verify the persisted server-side state instead of
      // reading a stale form control.
      const verifyFrame = await this.openContentObject(page, object);
      const verifyInput = verifyFrame.locator('input.custom-input-url, input#detailUrl, input#cateUrl, input[placeholder="请输入URL"]').first();
      await verifyInput.waitFor({ state: "attached", timeout: 30_000 });
      const persistedCustom = await verifyFrame.locator("#customUrl").evaluate((element) => element.classList.contains("on")).catch(() => false);
      const persistedUrl = await verifyInput.inputValue().catch(() => undefined);
      if (!persistedCustom || normalizeUrl(persistedUrl) !== normalizeUrl(desiredUrl)) {
        if (retryCount === 0) {
          await this.setContentUrl(page, object, desiredUrl, false, false, 1);
          return;
        }
        throw new Error(`Content custom URL did not persist: ${object.module} ${object.name}; actual=${persistedUrl ?? ""}`);
      }
    }
  }

  private async openPage(page: Page, pageName: string): Promise<void> {
    await this.enterAdminArea(page, "编辑网站");
    const pageSelector = page.locator("#backstage_select_pages");
    const currentPage = pageSelector.locator("a.backstage-topToolbar-menuIcon").first();
    await currentPage.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {
      throw new Error("Page selector is unavailable; refusing to edit an unintended page");
    });
    await currentPage.click({ force: true });

    const systemPages = new Set(["Product Detail", "News Detail"]);
    const tabName = systemPages.has(pageName) ? "系统页面" : "自定义页面";
    const tab = pageSelector.locator(".backstage-tab-title span").filter({ hasText: tabName }).first();
    await tab.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
      throw new Error(`Pagebuilder tab not found: ${tabName}`);
    });
    await tab.click();

    const menuOption = pageSelector.locator("a.name").filter({ hasText: pageName }).first();
    await menuOption.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
      throw new Error(`Page fixture not found in Pagebuilder: ${pageName}`);
    });
    const optionTitle = await menuOption.getAttribute("title");
    if (optionTitle !== pageName) throw new Error(`Page fixture selection is ambiguous: expected ${pageName}, got ${optionTitle ?? "untitled"}`);
    await menuOption.click();
    const switched = await pageSelector.locator("a.backstage-topToolbar-menuIcon").filter({ hasText: pageName }).first()
      .waitFor({ state: "visible", timeout: 30_000 }).then(() => true).catch(() => false);
    if (!switched) {
      // The editor can still show its loading canvas while the menu click has
      // already been accepted.  Re-issue the DOM click once and wait for the
      // actual page toolbar state instead of treating the loading canvas as a
      // configuration failure.
      await menuOption.evaluate((element) => (element as HTMLElement).click()).catch(() => undefined);
      await pageSelector.locator("a.backstage-topToolbar-menuIcon").filter({ hasText: pageName }).first()
        .waitFor({ state: "visible", timeout: 30_000 }).catch(() => {
          throw new Error(`Pagebuilder did not switch to page: ${pageName}`);
        });
    }

    const settings = page.getByText("当前页面设置", { exact: true }).first();
    await settings.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
      throw new Error("Current page settings control is unavailable");
    });
    await settings.evaluate((element) => (element as HTMLElement).click());
    await page.getByText("访问权限", { exact: true }).waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
      throw new Error(`Access control panel did not open for page: ${pageName}`);
    });
  }

  private async enterAdminArea(page: Page, area: "编辑网站" | "内容管理"): Promise<void> {
    await page.goto(`${adminBaseUrl}/website.html`, { waitUntil: "domcontentloaded" });
    const title = await page.title();
    const body = await page.locator("body").innerText().catch(() => "");
    if (/登录/u.test(title) || /用户登录入口/u.test(body)) {
      throw new Error("建站后台登录态已失效，无法进入网站管理页");
    }
    const targetSite = page.locator(".contentShow").filter({
      has: page.getByRole("link", { name: siteBaseUrl, exact: true }),
    }).first();
    await targetSite.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
      throw new Error(`建站后台未找到目标英语站点：${siteBaseUrl}`);
    });
    const action = targetSite.getByText(area, { exact: true }).first();
    if (await action.count() === 0) throw new Error(`目标英语站点未找到“${area}”入口`);
    const popupPromise = page.context().waitForEvent("page", { timeout: 10_000 }).catch(() => null);
    await action.click();
    const popup = await popupPromise;
    if (!popup) throw new Error(`点击目标英语站点“${area}”后未打开管理页面`);
    // The popup event can be delivered while the page is still about:blank.
    // Wait only until the real http(s) navigation is committed; the old default
    // waited for the full load event and timed out on slow third-party assets.
    await popup.waitForURL((url) => url.protocol === "http:" || url.protocol === "https:", {
      waitUntil: "commit",
      timeout: 15_000,
    });
    await popup.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
    const destinationUrl = popup.url();
    if (!/^https?:/u.test(destinationUrl)) {
      await popup.close().catch(() => undefined);
      throw new Error(`点击目标英语站点“${area}”后未获得管理页面地址`);
    }
    const popupBody = await popup.locator("body").innerText().catch(() => "");
    if (/ERR_TUNNEL_CONNECTION_FAILED|无法获取请求的 URL|Access Denied/iu.test(popupBody)) {
      await popup.close().catch(() => undefined);
      throw new Error(`通过指定代理进入“${area}”失败`);
    }
    await page.goto(destinationUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await popup.close().catch(() => undefined);
    const editorDeadline = Date.now() + 15_000;
    while (Date.now() < editorDeadline) {
      if (await this.confirmMultiSiteLogin(page)) continue;
      if (await page.locator("#backstage_select_pages").count() > 0) break;
      await page.waitForTimeout(250);
    }
    const destinationBody = await page.locator("body").innerText().catch(() => "");
    if (/ERR_TUNNEL_CONNECTION_FAILED|无法获取请求的 URL|Access Denied/iu.test(destinationBody)) {
      throw new Error(`通过指定代理进入“${area}”失败`);
    }
  }

  private async capturePageState(page: Page, pageName: string): Promise<void> {
    if (this.baselinePages.has(pageName)) return;
    this.baselinePages.set(pageName, await this.readPermissionState(page, pageName));
    await this.persistBaseline();
  }

  private targetPermission(mode: AccessMode, memberLevelLabel = "VIP"): PagePermissionState {
    if (mode === "password") return { mode, password: credentials.pagePassword };
    if (mode === "member") return { mode, memberLevelLabel };
    if (mode === "form") return { mode, formNameLabel: "Contact Us" };
    return { mode };
  }

  private async readPermissionState(page: Page, pageName: string): Promise<PagePermissionState> {
    const checked = page.locator('input[name="authType"]:checked');
    await checked.waitFor({ state: "attached", timeout: 10_000 }).catch(() => {
      throw new Error(`Current access mode is unavailable for page: ${pageName}`);
    });
    const value = await checked.getAttribute("value");
    const mode: AccessMode = value === "1" ? "password" : value === "2" ? "member" : value === "3" ? "employee" : value === "4" ? "form" : "public";
    if (mode === "password") {
      const input = page.getByPlaceholder("6～20位英文字母或数字").first();
      await input.waitFor({ state: "attached", timeout: 5_000 }).catch(() => {
        throw new Error(`Password field is unavailable for page: ${pageName}`);
      });
      return { mode, password: await input.inputValue() };
    }
    if (mode === "member") {
      const select = page.locator("select").filter({ has: page.locator("option", { hasText: "VIP" }) }).first();
      await select.waitFor({ state: "attached", timeout: 5_000 }).catch(() => {
        throw new Error(`Member level selector is unavailable for page: ${pageName}`);
      });
      const selected = await select.evaluate((element: HTMLSelectElement) => ({
        value: element.value,
        label: element.selectedOptions[0]?.textContent?.trim(),
      }));
      return { mode, memberLevel: selected.value, memberLevelLabel: selected.label };
    }
    if (mode === "form") {
      const select = page.locator("select").filter({ has: page.locator("option", { hasText: "Contact Us" }) }).first();
      await select.waitFor({ state: "attached", timeout: 5_000 }).catch(() => {
        throw new Error(`Form selector is unavailable for page: ${pageName}`);
      });
      const selected = await select.evaluate((element: HTMLSelectElement) => ({
        value: element.value,
        label: element.selectedOptions[0]?.textContent?.trim(),
      }));
      return { mode, formName: selected.value, formNameLabel: selected.label };
    }
    return { mode };
  }

  private async ensurePagePermission(
    page: Page,
    pageName: string,
    target: PagePermissionState,
    captureBaseline: boolean,
  ): Promise<void> {
    if (target.mode === "password" && target.password === undefined) {
      throw new Error(`Cannot configure password access for ${pageName}: password was not captured`);
    }
    await this.openPage(page, pageName);
    if (captureBaseline) await this.capturePageState(page, pageName);
    let current = await this.readPermissionState(page, pageName);
    if (permissionStateMatches(current, target)) return;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await this.setPermission(page, target);
      await this.publish(page);
      await this.openPage(page, pageName);
      current = await this.readPermissionState(page, pageName);
      if (permissionStateMatches(current, target)) return;
      if (attempt < 2) continue;
      throw new Error(`Page permission did not persist for ${pageName}: ${permissionMismatchReason(current, target)}`);
    }
  }

  private async setPermission(
    page: Page,
    target: PagePermissionState,
  ): Promise<void> {
    const mode = target.mode;
    const labels: Record<AccessMode, string | RegExp> = {
      public: /^(?:无权限控制|无限制控制)$/u,
      password: "密码访问",
      member: "会员访问",
      employee: "员工访问",
      form: "表单访问",
    };
    const labelText = labels[mode];
    const label = page.getByText(labelText, { exact: typeof labelText === "string" }).last();
    await label.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
      throw new Error(`Permission control ${String(labelText)} not found`);
    });
    await label.click();
    if (mode === "password") {
      const input = page.getByPlaceholder("6～20位英文字母或数字");
      if (target.password === undefined) throw new Error("Password access requires an explicit password");
      await input.fill(target.password);
    } else if (mode === "member") {
      const select = page.locator("select").filter({ has: page.locator("option", { hasText: "VIP" }) }).first();
      if (await select.count() === 0) throw new Error("Member level selector not found");
      const selected = target.memberLevel
        ? await select.selectOption({ value: target.memberLevel }).then(() => true).catch(() => false)
        : false;
      if (!selected && target.memberLevelLabel) await select.selectOption({ label: target.memberLevelLabel });
    } else if (mode === "form") {
      const select = page.locator("select").filter({ has: page.locator("option", { hasText: "Contact Us" }) }).first();
      if (await select.count() === 0) throw new Error("Form selector not found");
      const selected = target.formName
        ? await select.selectOption({ value: target.formName }).then(() => true).catch(() => false)
        : false;
      if (!selected && target.formNameLabel) await select.selectOption({ label: target.formNameLabel });
    }
    const confirm = page.locator("a.page_function_setting_submit:visible");
    await confirm.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
      throw new Error("Permission settings confirm control not found");
    });
    await confirm.click();
    await confirm.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {
      throw new Error("Permission settings were not confirmed; settings dialog remained open");
    });
  }

  private async publish(page: Page): Promise<void> {
    const publish = page.locator("#backstage_online");
    await publish.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
      throw new Error("Website publish control not found");
    });
    await publish.click();

    const agreement = page.getByText(/我已确认/).first();
    await agreement.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {
      throw new Error("Publish agreement dialog did not open");
    });
    const checkbox = page.locator("#confirmCheck");
    await checkbox.check();
    const release = page.locator("a.backstage-dialog-submit.backstage-dialog-bottom-new-btn:visible");
    await release.waitFor({ state: "visible", timeout: 10_000 });
    await release.click();
    await page.getByText("恭喜您，网站发布成功！", { exact: true }).waitFor({ state: "visible", timeout: 20_000 }).catch(() => {
      throw new Error("Website publish did not report success");
    });
  }
}
