import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { keepChromeMinimized, scheduleChromeMinimize } from "./window-utils.mjs";

function regex(source) {
  return new RegExp(source, "i");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeCssAttributeValue(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("'", "\\'");
}

async function firstVisible(locators) {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }
  }
  return null;
}

async function waitFirstVisible(locators, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await firstVisible(locators);
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function isInViewport(locator, { fully = false } = {}) {
  return locator
    .evaluate(
      (element, options) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const horizontallyVisible = options.fully
          ? rect.left >= -1 && rect.right <= window.innerWidth + 1
          : rect.right > 0 && rect.left < window.innerWidth;
        const verticallyVisible = options.fully
          ? rect.top >= -1 && rect.bottom <= window.innerHeight + 1
          : rect.bottom > 0 && rect.top < window.innerHeight;
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0 &&
          horizontallyVisible &&
          verticallyVisible
        );
      },
      { fully },
    )
    .catch(() => false);
}

function textLocators(scope, patterns) {
  return patterns.map((pattern) => scope.getByText(regex(pattern)));
}

function labelLocators(scope, labels) {
  return labels.map((label) => scope.getByLabel(regex(label)));
}

function placeholderLocators(scope, placeholders) {
  return placeholders.map((placeholder) =>
    scope.getByPlaceholder(placeholder, { exact: true }),
  );
}

function followingInputLocators(scope, labels) {
  return labels.map((label) =>
    scope
      .getByText(new RegExp(`^\\s*${escapeRegex(label)}\\s*$`, "i"))
      .locator("xpath=following::input[not(@type='hidden')][1]"),
  );
}

export async function launchEditorBrowser(config, options = {}) {
  await mkdir(config.paths.userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(
    config.paths.userDataDir,
    {
      channel: config.browser.channel,
      headless: options.headless ?? config.browser.headless,
      locale: config.browser.locale,
      slowMo: options.slowMo ?? config.browser.slowMo,
      viewport: null,
      args: [config.browser.startMinimized ? "--start-minimized" : "--start-maximized"],
    },
  );
  keepChromeMinimized(context);
  const pages = context.pages();
  const page = pages.at(-1) ?? (await context.newPage());
  scheduleChromeMinimize();
  page.setDefaultTimeout(config.timeouts.actionMs);
  page.setDefaultNavigationTimeout(config.timeouts.blockRenderMs);

  if (options.traceName) {
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
      title: options.traceName,
    });
  }
  return { context, page };
}

export async function stopTrace(context, tracePath) {
  if (!tracePath) {
    return;
  }
  await mkdir(path.dirname(tracePath), { recursive: true });
  await context.tracing.stop({ path: tracePath });
}

export class LeadongEditor {
  constructor(page, config) {
    this.page = page;
    this.config = config;
  }

  contexts() {
    return [this.page, ...this.page.frames().filter((frame) => frame !== this.page.mainFrame())];
  }

  canvasContexts() {
    const expected = this.config.selectors.editorFrameUrlIncludes;
    const matching = this.page
      .frames()
      .filter(
        (frame) =>
          frame !== this.page.mainFrame() && frame.url().includes(expected),
      );
    if (matching.length > 0) {
      return matching;
    }
    const childFrames = this.page
      .frames()
      .filter((frame) => frame !== this.page.mainFrame());
    return childFrames.length > 0 ? childFrames : [this.page];
  }

  async goto() {
    await this.page.goto(this.config.editorUrl, {
      waitUntil: "domcontentloaded",
    });
    await this.page.waitForTimeout(1200);
    if (/login|signin|passport/i.test(this.page.url())) {
      throw new Error("登录状态失效，请先运行 npm run auth");
    }
    if (this.page.url().includes(this.config.siteListUrlIncludes)) {
      // The portal renders site cards asynchronously after the document has
      // reached DOMContentLoaded.  Entering the target card after a fixed
      // short delay caused intermittent false "site not found" failures.
      // Wait for the specifically selected card before attempting to click
      // the editor entry, without accepting a different site as a fallback.
      const targetCard = this.page
        .locator(this.config.selectors.siteCardSelector)
        .filter({ hasText: this.config.siteName })
        .first();
      const cardReady = await waitFirstVisible(
        [targetCard],
        this.config.timeouts.siteCardMs ?? this.config.timeouts.blockRenderMs,
      );
      if (!cardReady) {
        throw new Error(`站点列表中未找到 ${this.config.siteName}`);
      }
      await this.enterTargetSite();
    }
    if (!this.page.url().includes("/phoenix/pagebuilder")) {
      throw new Error(
        `未进入领动编辑器，当前地址为 ${this.page.url()}。请检查 siteName、语言和站点权限`,
      );
    }
  }

  async enterTargetSite() {
    const card = this.page
      .locator(this.config.selectors.siteCardSelector)
      .filter({ hasText: this.config.siteName })
      .first();
    if (!(await card.isVisible().catch(() => false))) {
      throw new Error(`站点列表中未找到 ${this.config.siteName}`);
    }

    const language = card
      .locator(this.config.selectors.siteLanguageSelector)
      .filter({ hasText: new RegExp(`^\\s*${escapeRegex(this.config.siteLanguage)}\\s*$`) })
      .first();
    if (await language.isVisible().catch(() => false)) {
      await language.click();
    }

    const edit = card.locator(this.config.selectors.editSiteSelector).first();
    if (!(await edit.isVisible().catch(() => false))) {
      throw new Error(`${this.config.siteName} 站点卡片中未找到“编辑网站”`);
    }

    const context = this.page.context();
    await edit.click();
    const deadline = Date.now() + this.config.timeouts.blockRenderMs;
    let editorPage = null;
    while (Date.now() < deadline) {
      // Clicking “编辑网站” may open transient promotional/support pages in
      // addition to the editor. Never bind to the first arbitrary popup;
      // select only a live page that has actually reached pagebuilder.
      editorPage = context
        .pages()
        .filter((candidate) => !candidate.isClosed())
        .find((candidate) => candidate.url().includes("/phoenix/pagebuilder"));
      if (editorPage) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (editorPage) {
      this.page = editorPage;
      this.page.setDefaultTimeout(this.config.timeouts.actionMs);
      this.page.setDefaultNavigationTimeout(
        this.config.timeouts.blockRenderMs,
      );
      await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    }
    await this.page.waitForTimeout(1000);
  }

  async openPageMenu() {
    const candidates = [];
    for (const scope of this.contexts()) {
      candidates.push(
        ...textLocators(scope, this.config.selectors.pageMenuTexts),
      );
    }
    const menu = await firstVisible(candidates);
    if (!menu) {
      throw new Error("未找到“页面:”下拉菜单，请运行 probe 校准 pageMenuTexts");
    }
    const trigger = await firstVisible([
      menu.locator("xpath=..").locator("a"),
      menu.locator("xpath=following::a[1]"),
    ]);
    await (trigger ?? menu).click();
  }

  async clickCustomPageTab() {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const customTab = await waitFirstVisible(
        textLocators(this.page, this.config.selectors.customPageTexts),
        this.config.timeouts.actionMs,
      );
      if (!customTab) throw new Error("未找到“自定义页面”标签");
      try {
        await customTab.click({ timeout: this.config.timeouts.actionMs });
        return;
      } catch (error) {
        lastError = error;
        await this.page.waitForTimeout(250 * attempt);
      }
    }
    throw lastError ?? new Error("点击“自定义页面”标签失败");
  }

  async openCustomPage(name) {
    let menuOpened = false;
    let lastMenuError;
    // The page menu is rendered asynchronously after the editor route opens.
    // Retry the open+tab sequence briefly so a transient empty menu is not
    // misclassified as a missing custom-page tab.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.openPageMenu();
        await this.page.waitForTimeout(300 * attempt);
        await this.clickCustomPageTab();
        menuOpened = true;
        break;
      } catch (error) {
        lastMenuError = error;
        await this.page.keyboard.press("Escape").catch(() => {});
        if (attempt < 3) await this.page.waitForTimeout(500 * attempt);
      }
    }
    if (!menuOpened) throw lastMenuError ?? new Error("未找到“自定义页面”标签");
    let target = await firstVisible([
      this.page.getByText(name, { exact: true }),
    ]);
    if (!target) {
      const pageMenu = this.page.locator("#backstage_select_pages").first();
      const search = await firstVisible([
        pageMenu.locator("input:visible"),
        pageMenu.getByPlaceholder(/搜索/u),
      ]);
      if (search) {
        await search.fill(name);
        await search.press("Enter").catch(() => {});
        await this.page.waitForTimeout(900);
        target = await firstVisible([
          pageMenu.getByText(name, { exact: true }),
          this.page.getByText(name, { exact: true }),
        ]);
      }
    }
    if (!target) {
      throw new Error(`自定义页面列表中未找到 ${name}`);
    }
    await target.click();
    await this.page.keyboard.press("Escape");
    await this.waitForPageLoaded(name);
    await this.dismissPageMenu();
  }

  async discoverPreviewUrl(pagePath) {
    const expectedPath = String(pagePath ?? "").startsWith("/") ? String(pagePath) : `/${String(pagePath ?? "")}`;
    const candidates = [];
    for (const scope of this.contexts()) {
      const links = scope.locator("a[href]:visible");
      const count = await links.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const link = links.nth(index);
        const href = await link.getAttribute("href").catch(() => "");
        if (!href || !/^https?:/iu.test(href)) continue;
        try {
          const url = new URL(href, this.page.url());
          const text = `${await link.innerText().catch(() => "")} ${await link.getAttribute("aria-label").catch(() => "")}`;
          if (url.pathname === expectedPath && /预览|preview/iu.test(text)) candidates.push(url.toString());
        } catch { /* ignore malformed links */ }
      }
    }
    const unique = [...new Set(candidates)];
    if (unique.length === 1) return unique[0];
    if (unique.length > 1) throw new Error(`preview_unresolved: 编辑器中找到多个预览地址：${unique.join("、")}`);

    const previewButton = await firstVisible([
      ...textLocators(this.page, [/^预览$/u, /^预览网站$/u, /^Preview$/u]),
      this.page.locator("[title*='预览'],[aria-label*='预览']"),
    ]);
    if (!previewButton) throw new Error("preview_unresolved: 编辑器中未找到预览入口");
    const knownPages = new Set(this.page.context().pages());
    const popupPromise = this.page.context().waitForEvent("page", { timeout: this.config.timeouts.actionMs }).catch(() => null);
    await previewButton.click({ force: true });
    const popup = await popupPromise;
    const deadline = Date.now() + this.config.timeouts.navigationMs;
    while (Date.now() < deadline) {
      const pages = this.page.context().pages().filter((page) => !page.isClosed());
      const found = pages.find((page) => {
        if (knownPages.has(page) && page !== this.page) return false;
        try { return new URL(page.url()).pathname === expectedPath; } catch { return false; }
      });
      if (found) {
        const url = found.url();
        if (popup && popup !== found) await popup.close().catch(() => {});
        return url;
      }
      await this.page.waitForTimeout(250);
    }
    if (popup) await popup.close().catch(() => {});
    throw new Error("preview_unresolved: 点击编辑器预览后未获得目标页面地址");
  }

  async openPreviewPage(pagePath) {
    const expectedPath = String(pagePath ?? "").startsWith("/")
      ? String(pagePath)
      : `/${String(pagePath ?? "")}`;
    const candidates = [];
    for (const scope of this.contexts()) {
      for (const locator of [
        scope.getByText("预览页面", { exact: true }),
        scope.getByText("预览", { exact: true }),
        scope.getByText("预览网站", { exact: true }),
        scope.getByText("Preview", { exact: true }),
        scope.locator("[title*='预览'],[aria-label*='预览']"),
      ]) {
        const count = await locator.count().catch(() => 0);
        for (let index = 0; index < count; index += 1) {
          const candidate = locator.nth(index);
          if (await candidate.isVisible().catch(() => false)) candidates.push(candidate);
        }
      }
    }
    if (candidates.length === 0) {
      throw new Error("preview_button_not_found: 3.0编辑器中未找到“预览页面”入口");
    }
    if (candidates.length > 1) {
      throw new Error(`preview_button_ambiguous: 3.0编辑器中找到 ${candidates.length} 个可见预览入口`);
    }

    const knownPages = new Set(this.page.context().pages());
    const popupPromise = this.page.context()
      .waitForEvent("page", { timeout: this.config.timeouts.actionMs })
      .catch(() => null);
    await candidates[0].click({ force: true });
    const popup = await popupPromise;
    if (!popup) {
      throw new Error("preview_tab_not_opened: 点击预览页面后没有打开新页签");
    }
    const deadline = Date.now() + this.config.timeouts.navigationMs;
    while (Date.now() < deadline) {
      const pages = this.page.context().pages().filter((page) => !page.isClosed());
      for (const page of pages) {
        if (knownPages.has(page)) continue;
        const frames = page.frames();
        const targetFrame = frames.find((frame) => {
          try {
            return new URL(frame.url()).pathname === expectedPath;
          } catch {
            return false;
          }
        });
        if (targetFrame) {
          await page.waitForLoadState("domcontentloaded").catch(() => {});
          await targetFrame.locator("body").waitFor({ state: "attached", timeout: this.config.timeouts.actionMs }).catch(() => {});
          await page.waitForTimeout(800);
          return { page, frame: targetFrame, url: targetFrame.url() };
        }
      }
      await this.page.waitForTimeout(250);
    }
    await popup?.close().catch(() => {});
    throw new Error(`preview_path_mismatch: 点击预览后未打开路径 ${expectedPath}`);
  }

  async dismissPageMenu() {
    const menu = this.page.locator("#backstage_select_pages").first();
    if (!(await menu.count().catch(() => 0))) {
      return;
    }
    const isOpen = await menu
      .evaluate(
        (element) =>
          element.classList.contains("on") ||
          [...element.querySelectorAll(".backstage-topToolbar-menusubUl")].some(
            (candidate) => {
              const style = getComputedStyle(candidate);
              const rect = candidate.getBoundingClientRect();
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                rect.width > 0 &&
                rect.height > 0
              );
            },
          ),
      )
      .catch(() => false);
    if (!isOpen) {
      return;
    }
    const viewport = await this.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    const x = Math.max(650, viewport.width - 100);
    const y = Math.min(100, Math.max(60, viewport.height - 100));
    await this.page.mouse.click(x, y);
    await this.page.mouse.move(
      Math.max(650, viewport.width - 50),
      Math.max(100, viewport.height - 50),
    );
    const deadline = Date.now() + this.config.timeouts.actionMs;
    while (Date.now() < deadline) {
      const stillOpen = await menu
        .evaluate((element) => element.classList.contains("on"))
        .catch(() => false);
      if (!stillOpen) {
        return;
      }
      await this.page.waitForTimeout(100);
    }
    throw new Error("页面切换后“页面”下拉层未关闭");
  }

  async createCustomPage(descriptor) {
    await this.openPageMenu();
    await this.clickCustomPageTab();
    const newPage = await firstVisible(
      textLocators(this.page, this.config.selectors.newPageTexts),
    );
    if (!newPage) {
      throw new Error("未找到“新建页面”按钮");
    }
    await newPage.click();

    const editor3Label = await waitFirstVisible(
      textLocators(this.page, this.config.selectors.editor3CardTexts),
      this.config.timeouts.actionMs,
    );
    if (!editor3Label) {
      throw new Error("新建页面时未找到“网页编辑器3.0”选项");
    }
    const editor3Card = editor3Label.locator(
      "xpath=ancestor::*[(self::div or self::li) and .//*[normalize-space()='创建页面']][1]",
    );
    const editor3Create = await firstVisible(
      textLocators(editor3Card, this.config.selectors.editorCreateTexts),
    );
    if (!editor3Create) {
      throw new Error("网页编辑器3.0卡片中未找到“创建页面”按钮");
    }
    await editor3Create.click();

    const blankPage = await waitFirstVisible(
      textLocators(this.page, this.config.selectors.blankPageTexts),
      this.config.timeouts.actionMs,
    );
    if (!blankPage) {
      throw new Error("3.0 页面模板中未找到“添加空白页”");
    }
    await blankPage.click();
    const chooseTemplate = await firstVisible(
      textLocators(this.page, this.config.selectors.templateConfirmTexts),
    );
    if (!chooseTemplate) {
      throw new Error("选中空白页后未找到“选取”按钮");
    }
    await chooseTemplate.click();

    const pageSettings = await waitFirstVisible(
      textLocators(this.page, this.config.selectors.pageSettingsTexts),
      this.config.timeouts.actionMs,
    );
    if (!pageSettings) {
      throw new Error("选取空白页后未出现“页面设置”弹窗");
    }
    const dialog =
      (await firstVisible([this.page.getByRole("dialog")])) ?? this.page;
    const visibleTextInputs = dialog.locator(
      "input:not([type='hidden']):not([type='radio']):not([type='checkbox'])",
    );
    const nameInput = await firstVisible([
      ...labelLocators(dialog, this.config.selectors.pageNameLabels),
      ...followingInputLocators(
        dialog,
        this.config.selectors.pageNameLabels,
      ),
      ...placeholderLocators(
        dialog,
        this.config.selectors.pageNamePlaceholders,
      ),
      dialog.locator(
        "input[name*='pageName' i], input[name='name'], input[data-field='name']",
      ),
      visibleTextInputs,
    ]);
    if (!nameInput) {
      throw new Error(
        "新建页面弹窗中未识别“页面名称”输入框，请用 probe 或截图校准",
      );
    }
    await nameInput.fill(descriptor.name);

    const pathInput = await firstVisible([
      ...labelLocators(dialog, this.config.selectors.pagePathLabels),
      ...followingInputLocators(
        dialog,
        this.config.selectors.pagePathLabels,
      ),
      ...placeholderLocators(
        dialog,
        this.config.selectors.pagePathPlaceholders,
      ),
      dialog.locator(
        "input[name*='path' i], input[name*='url' i], input[data-field='path']",
      ),
      visibleTextInputs.nth(1),
    ]);
    if (!pathInput) {
      throw new Error(
        "新建页面弹窗中未识别“页面路径”输入框；为防止生成错误 URL，任务已停止",
      );
    }
    await pathInput.fill(descriptor.path);

    await this.submitPageSettings(dialog);
    // Some deployments create the page successfully but leave the editor on
    // the previous page. Explicitly switch to the new page before validating
    // the canvas so a successful create is not reported as a timeout.
    try {
      await this.waitForPageLoaded(descriptor.name);
    } catch (error) {
      await this.openCustomPage(descriptor.name).catch(() => {
        throw error;
      });
    }
  }

  async submitPageSettings(dialog) {
    const responseUrl =
      this.config.selectors.pageCreateResponseUrlIncludes;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const confirm = await firstVisible(
        textLocators(dialog, this.config.selectors.createConfirmTexts),
      );
      if (!confirm) {
        throw new Error("新建页面弹窗中未识别底部“确定”按钮");
      }
      if (!responseUrl) {
        await confirm.click();
        return;
      }
      const responsePromise = this.page
        .waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().includes(responseUrl),
          { timeout: this.config.timeouts.actionMs },
        )
        .catch(() => null);
      await confirm.click();
      const response = await responsePromise;
      if (!response) {
        if (!(await confirm.isVisible().catch(() => false))) {
          return;
        }
        throw new Error("点击页面设置底部“确定”后未检测到创建页面接口");
      }
      if (response.ok()) {
        return;
      }
      if (response.status() < 500 || attempt === 2) {
        throw new Error(
          `创建页面接口连续第 ${attempt} 次返回 HTTP ${response.status()}`,
        );
      }
      await this.page.waitForTimeout(1000);
    }
  }

  async waitForPageLoaded(expectedName) {
    const deadline = Date.now() + this.config.timeouts.blockRenderMs;
    let lastOverlayVisible = false;
    let lastCurrentName = "";
    while (Date.now() < deadline) {
      const overlayVisible = await this.page
        .locator(".loadingMask2")
        .isVisible()
        .catch(() => false);
      const currentName = await this.page
        .locator("#backstage_select_pages")
        .evaluate((element) => {
          const clone = element.cloneNode(true);
          clone
            .querySelectorAll(".backstage-topToolbar-menusub")
            .forEach((menu) => menu.remove());
          return clone.textContent ?? "";
        })
        .catch(() => "");
      lastOverlayVisible = overlayVisible;
      lastCurrentName = currentName.trim();
      if (
        !overlayVisible &&
        currentName.includes(expectedName)
      ) {
        return this.waitForCanvasReady();
      }
      await this.page.waitForTimeout(200);
    }
    throw new Error(
      `页面 ${expectedName} 切换超时：遮罩=${lastOverlayVisible ? "显示" : "已消失"}，顶部页面名=${JSON.stringify(lastCurrentName)}`,
    );
  }

  async waitForCanvasReady() {
    const deadline = Date.now() + this.config.timeouts.blockRenderMs;
    while (Date.now() < deadline) {
      for (const frame of this.canvasContexts()) {
        const contentAdd = frame
          .locator(
            "#backstage-bodyArea a.backstage-creatmodules-addbtn",
          )
          .first();
        if (await contentAdd.isVisible().catch(() => false)) {
          return contentAdd;
        }
      }
      await this.page.waitForTimeout(200);
    }
    throw new Error("页面画布加载超时：内容区加号未出现");
  }

  async customPageExists(name) {
    await this.openPageMenu();
    await this.clickCustomPageTab();
    const exists = Boolean(
      await firstVisible([this.page.getByText(name, { exact: true })]),
    );
    await this.page.keyboard.press("Escape");
    await this.dismissPageMenu();
    return exists;
  }

  async findBlockSearchInput() {
    const candidates = [];
    for (const scope of this.contexts()) {
      candidates.push(
        ...placeholderLocators(
          scope,
          this.config.selectors.blockSearchPlaceholders,
        ),
      );
    }
    return firstVisible(candidates);
  }

  async resetTaggedBlockSearch() {
    const closeCandidates = [];
    for (const scope of this.contexts()) {
      closeCandidates.push(
        scope.locator(
          ".addmodules_searchWrap_tagItem .block-iconbaseline-close",
        ),
      );
    }
    const close = await firstVisible(closeCandidates);
    if (!close) {
      return null;
    }
    await close.evaluate((element) => element.click());
    return waitFirstVisible(
      this.contexts().flatMap((scope) =>
        placeholderLocators(
          scope,
          this.config.selectors.blockSearchPlaceholders,
        ),
      ),
      this.config.timeouts.actionMs,
    );
  }

  async blockPanelFullyExpanded(panel) {
    return panel
      .evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          // Some 3.0 builds remove the `on` class while a search result is
          // being repainted, even though the sidebar remains visibly open.
          // Geometry/visibility is the authoritative signal here; otherwise
          // the next search incorrectly tries to find the canvas plus button.
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width >= 400 &&
          rect.height > 0 &&
          rect.left >= -1 &&
          rect.right <= window.innerWidth + 1
        );
      })
      .catch(() => false);
  }

  async closeBlockPanelIfOpen() {
    const panel = this.page
      .locator(".backstage-addmodules-chooseWrapper-new")
      .first();
    if ((await panel.count().catch(() => 0)) === 0) {
      return;
    }
    const needsClosing = await panel
      .evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.classList.contains("on") || rect.right > 0;
      })
      .catch(() => false);
    if (!needsClosing) {
      return;
    }
    const close = panel
      .locator("i.block-iconbaseline-close")
      .first();
    if ((await close.count().catch(() => 0)) === 0) {
      throw new Error("区块侧边栏已展开但未找到关闭按钮");
    }
    await close.evaluate((element) =>
      (element.closest("a,button") ?? element).click(),
    );
    const deadline = Date.now() + this.config.timeouts.actionMs;
    while (Date.now() < deadline) {
      const closed = await panel
        .evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return !element.classList.contains("on") && rect.right <= 1;
        })
        .catch(() => true);
      if (closed) {
        return;
      }
      await this.page.waitForTimeout(100);
    }
    throw new Error("区块侧边栏关闭超时");
  }

  async openContentBlockPanel() {
    const panel = this.page
      .locator(".backstage-addmodules-chooseWrapper-new")
      .first();
    if (!(await this.blockPanelFullyExpanded(panel))) {
      const candidates = [];
      for (const scope of this.contexts()) {
        candidates.push(
          ...textLocators(scope, this.config.selectors.contentAddTexts ?? []),
        );
        for (const selector of this.config.selectors.contentAddSelectors) {
          const locator = scope.locator(selector);
          if (selector === "a.backstage-creatmodules-addbtn") {
            candidates.push(
              locator.filter({ hasText: /^添加区块到内容区$/ }),
            );
          } else {
            candidates.push(locator);
          }
        }
      }
      // The canvas plus button can be hidden for a short transition while
      // the previous search sidebar is closing.  Wait for it instead of
      // failing immediately and mistaking the transition for a missing
      // content insertion point.
      const addControl = await waitFirstVisible(
        candidates,
        this.config.timeouts.actionMs,
      );
      if (!addControl) {
        throw new Error(
          "未找到“添加区块到内容区”的加号，请运行 probe 校准 contentAddSelectors",
        );
      }
      // The editor draws a parent-page overlay above the iframe plus button.
      // Hover exposes the intended control; a native click bypasses only the
      // parent overlay while preserving the editor's own click handler.
      await addControl.hover({ force: true }).catch(() => {});
      await this.page.waitForTimeout(200);
      await addControl.evaluate((element) => element.click());
    }

    const deadline = Date.now() + this.config.timeouts.actionMs;
    while (Date.now() < deadline) {
      if (await this.blockPanelFullyExpanded(panel)) {
        break;
      }
      await this.page.waitForTimeout(100);
    }
    if (!(await this.blockPanelFullyExpanded(panel))) {
      throw new Error("点击内容区加号后，区块侧边栏未完全展开到屏幕内");
    }

    await this.resetTaggedBlockSearch();
    const search = await firstVisible(
      placeholderLocators(
        panel,
        this.config.selectors.blockSearchPlaceholders,
      ),
    );
    if (
      !search ||
      !(await isInViewport(search, { fully: true })) ||
      !(await search.isEditable().catch(() => false))
    ) {
      throw new Error("区块侧边栏已展开，但搜索框不可见或不可编辑");
    }
    return search;
  }

  async locateExactBlockResult(blockId) {
    const directCards = [];
    const escapedId = escapeCssAttributeValue(blockId);
    for (const scope of this.contexts()) {
      const locator = scope.locator(
        `.btn.add[appid="${escapedId}"], [data-action="add"][data-block-id="${escapedId}"]`,
      );
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        const visibleCard = await candidate
          .evaluate((element) => {
            const card = element.closest("li") ?? element.parentElement;
            if (!card) {
              return false;
            }
            const rect = card.getBoundingClientRect();
            const style = getComputedStyle(card);
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 &&
              rect.height > 0 &&
              rect.right > 0 &&
              rect.left < window.innerWidth &&
              rect.bottom > 0 &&
              rect.top < window.innerHeight
            );
          })
          .catch(() => false);
        if (visibleCard) {
          directCards.push({
            card: candidate.locator("xpath=ancestor::li[1]"),
            directAdd: candidate,
          });
        }
      }
    }
    if (directCards.length === 1) {
      const { card, directAdd } = directCards[0];
      await card.hover({ force: true }).catch(() => {});
      const add = await waitFirstVisible(
        [
          card.locator(".btn.preview"),
          directAdd,
          ...textLocators(card, this.config.selectors.addButtonTexts),
        ],
        1200,
      );
      if (add) {
        return { outcome: "found", add };
      }
      const nativeAdd = card.locator(".btn.preview").first();
      if ((await nativeAdd.count().catch(() => 0)) === 1) {
        return { outcome: "found", add: nativeAdd };
      }
      return {
        outcome: "add_failed",
        reason: "找到精确 block_id，但结果卡片中没有可见“添加”按钮",
      };
    }
    if (directCards.length > 1) {
      return {
        outcome: "locator_ambiguous",
        reason: `搜索结果中出现 ${directCards.length} 个 appid=${blockId} 的添加按钮`,
      };
    }

    const exactId = new RegExp(
      `区块\\s*ID\\s*[:：]\\s*${escapeRegex(blockId)}(?:\\D|$)`,
      "i",
    );
    const visibleMatches = [];
    for (const scope of this.contexts()) {
      const locator = scope.getByText(exactId);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (
          (await candidate.isVisible().catch(() => false)) &&
          (await isInViewport(candidate))
        ) {
          visibleMatches.push(candidate);
        }
      }
    }
    if (visibleMatches.length === 0) {
      return { outcome: "not_found" };
    }
    if (visibleMatches.length > 1) {
      return {
        outcome: "locator_ambiguous",
        reason: `搜索结果中出现 ${visibleMatches.length} 个精确 block_id`,
      };
    }

    const idText = visibleMatches[0];
    const listCard = idText.locator("xpath=ancestor::li[1]");
    const card =
      (await listCard.count().catch(() => 0)) > 0
        ? listCard
        : idText.locator(
            "xpath=ancestor::*[(self::div or self::li) and .//*[normalize-space(.)='添加' or normalize-space(.)='+ 添加']][1]",
          );
    await card.hover({ force: true }).catch(() => {});
    const add = await waitFirstVisible(
      [
        card.locator(".btn.preview"),
        ...textLocators(card, this.config.selectors.addButtonTexts),
      ],
      1200,
    );
    if (!add) {
      const nativeAdd = card.locator(".btn.preview").first();
      if ((await nativeAdd.count().catch(() => 0)) === 1) {
        return { outcome: "found", add: nativeAdd };
      }
      return {
        outcome: "add_failed",
        reason: "找到精确 block_id，但结果卡片中没有可见“添加”按钮",
      };
    }
    return { outcome: "found", add };
  }

  async visibleSearchResultIds() {
    const ids = new Set();
    for (const scope of this.contexts()) {
      const frameIds = await scope
        .evaluate(() => {
          const pattern = /区块\s*ID\s*[:：]\s*([0-9]+)/i;
          const found = new Set();
          for (const card of document.querySelectorAll(
            "li, .addmodules_item, .addmodules_itemBox",
          )) {
            const rect = card.getBoundingClientRect();
            const style = getComputedStyle(card);
            if (
              style.display === "none" ||
              style.visibility === "hidden" ||
              rect.width <= 0 ||
              rect.height <= 0 ||
              rect.right <= 0 ||
              rect.left >= window.innerWidth ||
              rect.bottom <= 0 ||
              rect.top >= window.innerHeight
            ) {
              continue;
            }
            const match = (card.innerText || "").match(pattern);
            if (match) found.add(match[1]);
          }
          return [...found];
        })
        .catch(() => []);
      for (const id of frameIds) ids.add(id);
    }
    return [...ids];
  }

  async waitForExactBlockResult(blockId) {
    const waitMs = Number(this.config.timeouts.searchResultMs ?? 10000);
    const stableMs = Number(this.config.timeouts.searchResultStableMs ?? 0);
    const startedAt = Date.now();
    const deadline = startedAt + waitMs;
    let lastTransientFailure = null;
    while (Date.now() < deadline) {
      const result = await this.locateExactBlockResult(blockId);
      if (result.outcome === "found" || result.outcome === "locator_ambiguous") {
        return result;
      }
      if (result.outcome === "add_failed") {
        lastTransientFailure = result;
        await this.page.waitForTimeout(250);
        continue;
      }
      const panel = this.page
        .locator(".backstage-addmodules-chooseWrapper-new.on")
        .first();
      const explicitEmpty = await firstVisible(
        textLocators(
          panel,
          this.config.selectors.noBlockResultTexts ?? [],
        ),
      );
      // The legacy panel keeps the search token but briefly renders the
      // default “最新区块” list (for example 40748) while the request is
      // completing.  Never treat that fallback list as the result of the
      // requested ID, and do not accept an empty marker before the minimum
      // result-set settling window has elapsed.
      const minimumWaitReached = Date.now() - startedAt >= stableMs;
      if (
        explicitEmpty &&
        minimumWaitReached &&
        (await isInViewport(explicitEmpty))
      ) {
        return {
          ...result,
          reason: "搜索面板明确显示无数据",
          empty_confirmed: true,
        };
      }
      await this.page.waitForTimeout(250);
    }
    if (lastTransientFailure) return lastTransientFailure;
    // This diagnostic scan is intentionally performed once, only after the
    // search deadline. Running it on every polling tick can be expensive on
    // pages containing hundreds of cards and would delay the next Enter.
    const lastVisibleIds = await this.visibleSearchResultIds().catch(() => []);
    return {
      outcome: "not_found",
      reason:
        lastVisibleIds.length > 0
          ? `搜索结果回退到默认/其他区块列表，当前可见区块ID：${lastVisibleIds.join("、")}`
          : "输入block_id并回车后没有精确结果",
      visible_result_ids: lastVisibleIds,
    };
  }

  async searchAndAdd(blockId) {
    // Some deployments briefly show the exact card and then repaint the
    // default “最新区块” list.  This is an asynchronous search/render race,
    // not a valid match. Re-submit the same exact ID once after such a flash;
    // a generic card is never clicked.
    let lastFallback = null;
    const maxAttempts = Math.max(
      1,
      Number(this.config.timeouts.searchSubmitAttempts ?? 3),
    );
    for (let searchAttempt = 0; searchAttempt < maxAttempts; searchAttempt += 1) {
      const input = await this.openContentBlockPanel();
      await input.fill(blockId);
      await input.press("Enter");

      const result = await this.waitForExactBlockResult(blockId);
      if (result.outcome !== "found") {
        if (
          searchAttempt < maxAttempts - 1 &&
          result.outcome === "not_found" &&
          !result.empty_confirmed
        ) {
          const canResubmit =
            (await input.isVisible().catch(() => false)) &&
            (await input.isEditable().catch(() => false));
          if (!canResubmit) {
            return result;
          }
          lastFallback = {
            outcome: "not_found",
            reason:
              `首次搜索未保持精确区块卡片（可能回退到默认区块列表），将再次按回车搜索：${
                result.reason ?? "未出现精确结果"
              }`,
          };
          await this.page.waitForTimeout(150);
          continue;
        }
        return lastFallback ?? result;
      }

      // The legacy editor may repaint the exact result back to the default
      // list within a few hundred milliseconds. The result has already been
      // proven exact by its appid/block-id, so claim it immediately instead
      // of waiting for a post-render "stability" period that loses the card.
      await result.add
        .locator("xpath=ancestor::li[1]")
        .hover({ force: true })
        .catch(() => {});
      try {
        await result.add.evaluate((element) => element.click());
      } catch (error) {
        lastFallback = {
          outcome: "not_found",
          reason: `精确结果在点击前被列表重绘移除（第${searchAttempt + 1}次）：${error.message}`,
        };
        if (searchAttempt < maxAttempts - 1) {
          await this.page.waitForTimeout(150);
          continue;
        }
        return lastFallback;
      }
      return this.waitForBlockAudit(blockId);
    }
    return lastFallback ?? { outcome: "not_found" };
  }

  async auditBlock(blockId) {
    const templates = this.config.selectors.blockRootTemplates;
    const selectors = templates.map((template) =>
      template.replaceAll("{id}", escapeCssAttributeValue(blockId)),
    );
    const errors = this.config.selectors.renderErrorTexts;
    const loaders = this.config.selectors.loadingSelectors;
    const audits = [];

    for (const frame of this.canvasContexts()) {
      const audit = await frame
        .evaluate(
          ({ id, rootSelectors, errorTexts, loadingSelectors }) => {
            const candidates = new Set();
            for (const selector of rootSelectors) {
              try {
                for (const element of document.querySelectorAll(selector)) {
                  candidates.add(element);
                }
              } catch {
                // A local selector override may be temporarily invalid.
              }
            }
            if (candidates.size === 0) {
              for (const element of document.querySelectorAll("*")) {
                for (const attribute of element.attributes) {
                  if (
                    attribute.value === id &&
                    /(block|module|component|app|(^|-)id$)/i.test(attribute.name)
                  ) {
                    candidates.add(element);
                    break;
                  }
                }
              }
            }

            const visible = [...candidates].filter((element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                rect.width > 0 &&
                rect.height > 0
              );
            });
            const roots = visible.filter(
              (candidate) =>
                !visible.some(
                  (other) => other !== candidate && other.contains(candidate),
                ),
            );

            return roots.map((root) => {
              const rect = root.getBoundingClientRect();
              const headingCounts = {};
              for (let level = 1; level <= 6; level += 1) {
                headingCounts[`h${level}`] = root.querySelectorAll(
                  `h${level}`,
                ).length;
              }
              const images = [...root.querySelectorAll("img")].map((image) => ({
                src: image.currentSrc || image.src || "",
                alt: image.getAttribute("alt") ?? "",
                width: image.getBoundingClientRect().width,
                height: image.getBoundingClientRect().height,
              }));
              const media = [...root.querySelectorAll("video, audio, iframe, canvas, svg")]
                .map((element) => {
                  const mediaRect = element.getBoundingClientRect();
                  const mediaStyle = getComputedStyle(element);
                  const source =
                    element.getAttribute("src") ||
                    element.querySelector?.("source[src]")?.getAttribute("src") ||
                    "";
                  return {
                    tag: element.tagName.toLowerCase(),
                    src: source,
                    width: mediaRect.width,
                    height: mediaRect.height,
                    visible:
                      mediaStyle.display !== "none" &&
                      mediaStyle.visibility !== "hidden" &&
                      mediaRect.width > 0 &&
                      mediaRect.height > 0,
                  };
                });
              const visibleBackground = [...root.querySelectorAll("*")].some(
                (element) => {
                  const elementRect = element.getBoundingClientRect();
                  const elementStyle = getComputedStyle(element);
                  return (
                    elementRect.width > 0 &&
                    elementRect.height > 0 &&
                    elementStyle.display !== "none" &&
                    elementStyle.visibility !== "hidden" &&
                    elementStyle.backgroundImage &&
                    elementStyle.backgroundImage !== "none"
                  );
                },
              );
              const matchingAttribute = [...root.attributes].find(
                (attribute) => attribute.value === id,
              );
              const fingerprint = root.id
                ? `#${CSS.escape(root.id)}`
                : matchingAttribute
                  ? `[${CSS.escape(matchingAttribute.name)}="${CSS.escape(id)}"]`
                  : "";
              const text = (root.innerText || "").replace(/\s+/g, " ").trim();
              const loading = loadingSelectors.some((selector) => {
                try {
                  return [...root.querySelectorAll(selector)].some((element) => {
                    const childRect = element.getBoundingClientRect();
                    const style = getComputedStyle(element);
                    return (
                      childRect.width > 0 &&
                      childRect.height > 0 &&
                      style.display !== "none" &&
                      style.visibility !== "hidden"
                    );
                  });
                } catch {
                  return false;
                }
              });
              const errorText = errorTexts.find((error) => text.includes(error));
              return {
                editor_dom_id:
                  root.id ||
                  (matchingAttribute
                    ? `${matchingAttribute.name}=${matchingAttribute.value}`
                    : ""),
                fingerprint,
                visible: true,
                width: rect.width,
                height: rect.height,
                dom_index: [...document.querySelectorAll("*")].indexOf(root),
                visible_text_length: text.length,
                heading_counts: headingCounts,
                image_count: images.length,
                images,
                media_count: media.length,
                media,
                loading,
                error_text: errorText ?? "",
                has_default_content:
                  text.length > 0 ||
                  images.some(
                    (image) =>
                      image.src && image.width > 0 && image.height > 0,
                  ) ||
                  media.some(
                    (item) =>
                      item.visible &&
                      (item.src || ["canvas", "svg"].includes(item.tag)),
                  ) ||
                  visibleBackground,
              };
            });
          },
          {
            id: blockId,
            rootSelectors: selectors,
            errorTexts: errors,
            loadingSelectors: loaders,
          },
        )
        .catch(() => []);
      audits.push(...audit.map((item) => ({ ...item, frame_url: frame.url() })));
    }
    return audits;
  }

  async listCanvasBlockIds() {
    const ids = [];
    for (const frame of this.canvasContexts()) {
      const frameIds = await frame.evaluate(() => {
        const found = [];
        for (const element of document.querySelectorAll("*")) {
          for (const attribute of element.attributes) {
            if (
              /(block|module|component)(-|_)?id/i.test(attribute.name) &&
              /^\d+$/.test(attribute.value)
            ) {
              found.push({
                block_id: attribute.value,
                attribute: attribute.name,
                dom_index: [...document.querySelectorAll("*")].indexOf(element),
              });
              break;
            }
          }
        }
        return found;
      });
      ids.push(...frameIds.map((item) => ({ ...item, frame_url: frame.url() })));
    }
    const unique = new Map();
    for (const item of ids) {
      if (!unique.has(item.block_id)) {
        unique.set(item.block_id, item);
      }
    }
    return [...unique.values()].sort((left, right) => left.dom_index - right.dom_index);
  }

  async waitForBlockAudit(blockId) {
    const deadline = Date.now() + this.config.timeouts.blockRenderMs;
    const noSignalMs =
      this.config.timeouts.blockNoSignalMs ??
      this.config.timeouts.blockRenderMs;
    const noSignalDeadline = Date.now() + noSignalMs;
    let lastAudit = [];
    while (Date.now() < deadline) {
      lastAudit = await this.auditBlock(blockId);
      if (
        lastAudit.length === 1 &&
        !lastAudit[0].loading &&
        !lastAudit[0].error_text
      ) {
        if (!lastAudit[0].has_default_content) {
          return {
            outcome: "render_failed",
            reason: "区块根节点存在，但没有可见文本或有效图片",
            audit: lastAudit[0],
          };
        }
        return { outcome: "added", audit: lastAudit[0] };
      }
      if (lastAudit.length > 1) {
        return {
          outcome: "render_failed",
          reason: `页面中检测到 ${lastAudit.length} 个目标 block_id`,
          audit: lastAudit,
        };
      }
      if (lastAudit[0]?.error_text) {
        return {
          outcome: "render_failed",
          reason: `区块出现错误提示：${lastAudit[0].error_text}`,
          audit: lastAudit[0],
        };
      }
      if (lastAudit.length === 0 && Date.now() >= noSignalDeadline) {
        return {
          outcome: "render_failed",
          reason: `添加后 ${Math.round(noSignalMs / 1000)} 秒内没有检测到目标 DOM 或加载信号`,
          audit: [],
        };
      }
      await this.page.waitForTimeout(500);
    }
    return {
      outcome: "render_failed",
      reason:
        lastAudit.length === 0
          ? "添加后 60 秒内未检测到目标 block_id"
          : "区块持续处于加载状态",
      audit: lastAudit,
    };
  }

  async removeBlock(blockId, audit) {
    const fingerprint = Array.isArray(audit)
      ? audit[0]?.fingerprint
      : audit?.fingerprint;
    if (!fingerprint) {
      return (await this.auditBlock(blockId)).length === 0;
    }
    for (const frame of this.canvasContexts()) {
      const root = frame.locator(fingerprint).first();
      if (!(await root.isVisible().catch(() => false))) {
        continue;
      }
      await root.hover();
      const remove = await firstVisible(
        [
          ...textLocators(root, this.config.selectors.deleteBlockTexts),
          root.locator(".backstage-container-delete a").first(),
          root.locator(".backstage-container-delete").first(),
          root.locator("[title*='删除'], [aria-label*='删除'], [data-title*='删除']").first(),
          root.locator(".icon-trash").first(),
        ],
      );
      if (!remove) {
        return false;
      }
      await remove.evaluate((element) =>
        (element.closest("a,button") ?? element).click(),
      );
      const confirm = await firstVisible([
        this.page.getByText(/^(确定|删除)$/),
      ]);
      if (confirm) {
        await confirm.click();
      }
      await this.page.waitForTimeout(500);
      return (await this.auditBlock(blockId)).length === 0;
    }
    return false;
  }

  async savePage() {
    const save = await firstVisible([
      this.page.locator("#saveLayout"),
      ...textLocators(this.page, this.config.selectors.saveTexts),
    ]);
    if (!save) {
      throw new Error("未找到编辑器“保存”按钮");
    }

    let saveResponse = null;
    const onResponse = (response) => {
      if (
        response.request().method() === "POST" &&
        response.url().includes("/phoenix/pagebuilder/savegridlayout")
      ) {
        saveResponse = response;
      }
    };
    this.page.on("response", onResponse);
    try {
      try {
        await save.click({ force: true });
      } catch {
        // A stale onboarding layer can still intercept the coordinate even
        // after it has been made non-interactive.  Dispatch the editor's own
        // click handler on the save node as the final UI-level fallback.
        await save.evaluate((element) => element.click());
      }
      const deadline = Date.now() + this.config.timeouts.saveMs;
      while (Date.now() < deadline) {
        if (saveResponse) {
          if (!saveResponse.ok()) {
            throw new Error(
              `右上角保存接口返回 HTTP ${saveResponse.status()}`,
            );
          }
          return {
            evidence: "network",
            status: saveResponse.status(),
            url: saveResponse.url(),
          };
        }
        const success = await firstVisible(
          textLocators(this.page, this.config.selectors.saveSuccessTexts),
        );
        if (success) {
          return { evidence: "toast" };
        }
        await this.page.waitForTimeout(250);
      }
    } finally {
      this.page.off("response", onResponse);
    }
    throw new Error("点击右上角保存后未检测到成功提示或成功接口响应");
  }

  async publishSite() {
    const publish = await firstVisible(
      textLocators(this.page, this.config.selectors.publishTexts),
    );
    if (!publish) {
      throw new Error("未找到“发布”按钮");
    }
    await publish.click();
    const confirm = await firstVisible(
      textLocators(this.page, this.config.selectors.publishConfirmTexts),
    );
    if (confirm) {
      await confirm.click();
    }
    const deadline = Date.now() + this.config.timeouts.publishMs;
    while (Date.now() < deadline) {
      const success = await firstVisible(
        textLocators(this.page, this.config.selectors.publishSuccessTexts),
      );
      if (success) {
        return;
      }
      await this.page.waitForTimeout(500);
    }
    throw new Error("发布后未检测到成功提示");
  }

  async inspect() {
    const frames = [];
    for (const frame of this.page.frames()) {
      const elements = await frame
        .evaluate(() =>
          [
            ...document.querySelectorAll(
              "input,button,a,[role='button'],[title],[aria-label]",
            ),
          ]
            .slice(0, 800)
            .map((element) => ({
              tag: element.tagName.toLowerCase(),
              type: element.getAttribute("type") ?? "",
              name: element.getAttribute("name") ?? "",
              id: element.id,
              class: element.className?.toString().slice(0, 180) ?? "",
              placeholder: element.getAttribute("placeholder") ?? "",
              title: element.getAttribute("title") ?? "",
              ariaLabel: element.getAttribute("aria-label") ?? "",
              href: element.getAttribute("href") ?? "",
              text: (element.innerText || element.textContent || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 180),
              parentText: (element.parentElement?.innerText || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 500),
            }))
            .filter(
              (element) =>
                element.placeholder ||
                element.title ||
                element.ariaLabel ||
                element.text,
            ),
        )
        .catch(() => []);
      frames.push({
        name: frame.name(),
        url: frame.url(),
        elementCount: elements.length,
        elements,
      });
    }
    return {
      capturedAt: new Date().toISOString(),
      pageUrl: this.page.url(),
      title: await this.page.title(),
      frames,
    };
  }
}
