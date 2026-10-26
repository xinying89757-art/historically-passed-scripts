import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

function pattern(source) {
  return new RegExp(source, "iu");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function escapeCss(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function firstVisible(locators) {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function lastVisible(locators) {
  for (let locatorIndex = locators.length - 1; locatorIndex >= 0; locatorIndex -= 1) {
    const locator = locators[locatorIndex];
    const count = await locator.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function waitForVisible(locators, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = await firstVisible(locators);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

export class V4UiError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.name = "V4UiError";
    this.status = status;
    this.details = details;
  }
}

function normalizedPagePath(value) {
  const pathname = /^https?:\/\//iu.test(String(value ?? ""))
    ? new URL(value).pathname
    : String(value ?? "").split(/[?#]/u)[0];
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/u, "") : withLeadingSlash;
}

export function classifyV4PreviewOpen({
  buttonCount,
  tabOpened,
  expectedPath,
  actualUrl = "",
  headingCount = 0,
}) {
  if (buttonCount === 0) return { status: "preview_button_not_found", reason: "4.0编辑器顶部未找到“预览”入口" };
  if (buttonCount !== 1) return { status: "preview_button_ambiguous", reason: `4.0编辑器顶部“预览”入口数量为 ${buttonCount}` };
  if (!tabOpened) return { status: "preview_tab_not_opened", reason: "点击4.0编辑器“预览”后未打开新页签" };
  const expected = normalizedPagePath(expectedPath);
  const actual = normalizedPagePath(actualUrl);
  if (actual !== expected) {
    return { status: "preview_path_mismatch", reason: `预览页路径不一致：预期 ${expected}，实际 ${actual}` };
  }
  if (headingCount === 0) return { status: "preview_no_h_detected", reason: "编辑器预览页未检测到H标签" };
  return { status: "verified", reason: "" };
}

export async function launchV4Browser(config, options = {}) {
  await mkdir(config.paths.userDataDir, { recursive: true });
  const browserOptions = {
    headless: options.headless ?? config.browser.headless,
    locale: config.browser.locale,
    slowMo: options.slowMo ?? config.browser.slowMo,
    viewport: null,
    args: ["--start-maximized"],
  };
  if (config.browser.channel) browserOptions.channel = config.browser.channel;
  if (config.proxyServer) browserOptions.proxy = { server: config.proxyServer };
  const executablePath = options.executablePath ?? process.env.V4_CHROMIUM_PATH ?? config.browser.executablePath;
  if (executablePath) browserOptions.executablePath = executablePath;
  const context = await chromium.launchPersistentContext(
    config.paths.userDataDir,
    browserOptions,
  );
  const page = context.pages().at(-1) ?? (await context.newPage());
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

export async function stopV4Trace(context, tracePath) {
  if (!tracePath) return;
  await mkdir(path.dirname(tracePath), { recursive: true });
  await context.tracing.stop({ path: tracePath });
}

export class V4Editor {
  constructor(page, config) {
    this.page = page;
    this.config = config;
  }

  contexts() {
    return [this.page, ...this.page.frames().filter((frame) => frame !== this.page.mainFrame())];
  }

  textLocators(patterns, exact = false) {
    const locators = [];
    for (const scope of this.contexts()) {
      for (const source of patterns) {
        locators.push(scope.getByText(pattern(source), { exact }));
      }
    }
    return locators;
  }

  async goto() {
    await this.page.goto(this.config.v4EntryUrl ?? this.config.editorUrl, { waitUntil: "domcontentloaded" });
    await this.page.waitForTimeout(1800);
    if (/login|signin|passport|sso/i.test(this.page.url())) {
      throw new V4UiError("login_expired", "4.0编辑器登录状态失效，请先运行 npm run v4-block-auth");
    }
    if (this.page.url().includes("/website.html")) {
      await this.enterTargetSite();
    }
    const ready = await waitForVisible(
      [
        ...this.textLocators(this.config.v4Selectors.saveTexts),
        ...this.textLocators(this.config.v4Selectors.pageMenuTexts),
      ],
      this.config.timeouts.blockRenderMs,
    );
    if (!ready) {
      throw new V4UiError(
        "login_expired",
        `未进入4.0编辑器，当前地址为 ${this.page.url()}；请确认登录状态和站点权限`,
      );
    }
  }

  async enterTargetSite() {
    const card = this.page
      .locator(this.config.v4Selectors.siteCardSelector)
      .filter({ hasText: this.config.siteName })
      .first();
    const siteDeadline = Date.now() + Math.min(this.config.timeouts.blockRenderMs, 15000);
    while (Date.now() < siteDeadline && !(await card.isVisible().catch(() => false))) {
      await this.page.waitForTimeout(250);
    }
    if (!(await card.isVisible().catch(() => false))) {
      throw new V4UiError("login_expired", `“我的网站”中未找到站点“${this.config.siteName}”`);
    }
    const language = card
      .locator(this.config.v4Selectors.siteLanguageSelector)
      .filter({ hasText: new RegExp(`^\\s*${escapeRegex(this.config.siteLanguage)}\\s*$`, "u") })
      .first();
    if (await language.isVisible().catch(() => false)) await language.click();
    const edit = card.locator(this.config.v4Selectors.editSiteSelector).first();
    if (!(await edit.isVisible().catch(() => false))) {
      throw new V4UiError("login_expired", `站点“${this.config.siteName}”中未找到“编辑网站”按钮`);
    }
    const context = this.page.context();
    const known = new Set(context.pages());
    await edit.click();
    const deadline = Date.now() + Math.min(this.config.timeouts.blockRenderMs, 12000);
    let editorPage = null;
    while (Date.now() < deadline) {
      editorPage = context.pages().find((candidate) =>
        !candidate.isClosed() &&
        (/\/phoenix2\/composite\/blockEditorUI/i.test(candidate.url()) ||
          /\/phoenix\/pagebuilder/i.test(candidate.url())),
      );
      if (editorPage) break;
      const added = context.pages().find((candidate) => !candidate.isClosed() && !known.has(candidate));
      if (added && !/website\.html/i.test(added.url())) editorPage = added;
      if (editorPage && /phoenix/i.test(editorPage.url())) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!editorPage) {
      throw new V4UiError("login_expired", `点击站点“${this.config.siteName}”的“编辑网站”后未打开编辑器`);
    }
    this.page = editorPage;
    this.page.setDefaultTimeout(this.config.timeouts.actionMs);
    this.page.setDefaultNavigationTimeout(this.config.timeouts.blockRenderMs);
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    await this.page.waitForTimeout(1800);
    if (!/\/phoenix2\/composite\/blockEditorUI/i.test(this.page.url())) {
      const switched = context.pages().find((candidate) =>
        !candidate.isClosed() && /\/phoenix2\/composite\/blockEditorUI/i.test(candidate.url()),
      );
      if (switched) this.page = switched;
    }
  }

  async inspect() {
    const frames = [];
    for (const scope of this.contexts()) {
      const data = await scope.evaluate(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        };
        const compact = (value) => String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, 300);
        return {
          buttons: [...document.querySelectorAll("button,[role='button'],a")]
            .filter(visible)
            .map((element) => ({
              tag: element.tagName,
              text: compact(element.textContent),
              title: element.getAttribute("title") ?? "",
              aria: element.getAttribute("aria-label") ?? "",
              className: compact(element.className),
            }))
            .filter((item) => item.text || item.title || item.aria)
            .slice(0, 500),
          inputs: [...document.querySelectorAll("input,textarea")]
            .filter(visible)
            .map((element) => ({
              tag: element.tagName,
              type: element.getAttribute("type") ?? "",
              name: element.getAttribute("name") ?? "",
              id: element.id,
              placeholder: element.getAttribute("placeholder") ?? "",
              value: compact(element.value),
            }))
            .slice(0, 200),
          text: compact(document.body?.innerText).slice(0, 12000),
        };
      }).catch((error) => ({ error: error.message }));
      frames.push({ name: scope.name?.() ?? "main", url: scope.url(), ...data });
    }
    return {
      pageUrl: this.page.url(),
      title: await this.page.title(),
      frames,
    };
  }

  async openPageMenu() {
    const alreadyOpen = await firstVisible(this.textLocators(["^管理页面$"]));
    if (alreadyOpen) return;
    const inputCandidates = [];
    for (const scope of this.contexts()) {
      inputCandidates.push(scope.getByPlaceholder("页面", { exact: true }));
    }
    const pageInput = await firstVisible(inputCandidates);
    if (pageInput) {
      await pageInput.click();
      await this.page.waitForTimeout(400);
      return;
    }
    const label = await waitForVisible(this.textLocators(this.config.v4Selectors.pageMenuTexts));
    if (!label) throw new V4UiError("add_failed", "未找到4.0编辑器顶部“页面”菜单");
    const clickable = await firstVisible([
      label.locator("xpath=ancestor-or-self::*[@role='button'][1]"),
      label.locator("xpath=ancestor-or-self::button[1]"),
      label.locator("xpath=ancestor-or-self::div[contains(@class,'select')][1]"),
      label.locator("xpath=.."),
    ]);
    await (clickable ?? label).click();
    await this.page.waitForTimeout(400);
  }

  async dismissOverlay() {
    await this.page.keyboard.press("Escape").catch(() => {});
    await this.page.waitForTimeout(250);
  }

  async findPageInOpenMenu(name) {
    return firstVisible(
      this.contexts().map((scope) => scope.getByText(name, { exact: true })),
    );
  }

  async pageExists(name) {
    await this.openPageMenu();
    const found = await this.findPageInOpenMenu(name);
    await this.dismissOverlay();
    return Boolean(found);
  }

  async openCustomPage(name) {
    const currentInputs = [];
    for (const scope of this.contexts()) currentInputs.push(scope.getByPlaceholder("页面", { exact: true }));
    const currentInput = await firstVisible(currentInputs);
    if (currentInput && (await currentInput.inputValue().catch(() => "")) === name) {
      await this.page.locator(".el-loading-mask:visible").waitFor({ state: "hidden", timeout: this.config.timeouts.blockRenderMs }).catch(() => {});
      return;
    }
    await this.openPageMenu();
    let target = await this.findPageInOpenMenu(name);
    if (!target) {
      const customTab = await firstVisible(this.textLocators(this.config.v4Selectors.customPageTexts));
      if (customTab) {
        await customTab.click();
        await this.page.waitForTimeout(350);
        target = await this.findPageInOpenMenu(name);
      }
    }
    if (!target) {
      for (const scope of this.contexts()) {
        const search = await firstVisible([
          scope.locator("input[placeholder*='搜索']:visible"),
          scope.locator("input[type='search']:visible"),
        ]);
        if (!search) continue;
        await search.fill(name);
        await search.press("Enter").catch(() => {});
        await this.page.waitForTimeout(500);
        target = await this.findPageInOpenMenu(name);
        if (target) break;
      }
    }
    if (!target) {
      await this.dismissOverlay();
      throw new V4UiError("add_failed", `自定义页面列表中未找到 ${name}`);
    }
    await target.click();
    await this.page.waitForTimeout(1200);
    const deadline = Date.now() + this.config.timeouts.blockRenderMs;
    let selected = false;
    while (Date.now() < deadline) {
      const input = await firstVisible(
        this.contexts().map((scope) => scope.getByPlaceholder("页面", { exact: true })),
      );
      if (input && (await input.inputValue().catch(() => "")) === name) {
        selected = true;
        break;
      }
      await this.page.waitForTimeout(250);
    }
    if (!selected) {
      const canvasReady = await firstVisible(this.textLocators(this.config.v4Selectors.addEntryTexts));
      if (!canvasReady) throw new V4UiError("add_failed", `打开 ${name} 后未检测到页面名称回填或空白画布`);
    }
    await this.page.locator(".el-loading-mask:visible").waitFor({ state: "hidden", timeout: this.config.timeouts.blockRenderMs }).catch(() => {});
  }

  async reopenCustomPage(name) {
    await this.page.reload({ waitUntil: "domcontentloaded" });
    await this.page.waitForTimeout(1800);
    const ready = await waitForVisible(
      [
        ...this.textLocators(this.config.v4Selectors.saveTexts),
        ...this.textLocators(this.config.v4Selectors.pageMenuTexts),
      ],
      this.config.timeouts.blockRenderMs,
    );
    if (!ready) throw new V4UiError("render_failed", "刷新4.0编辑器后未恢复到可操作状态");
    await this.openCustomPage(name);
  }

  async previewButtonCandidates() {
    const candidates = [];
    for (const scope of this.contexts()) {
      const direct = scope
        .locator("a:visible,button:visible,[role='button']:visible")
        .filter({ hasText: /^\s*预览\s*$/u });
      const count = await direct.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = direct.nth(index);
        if (await candidate.isVisible().catch(() => false)) candidates.push(candidate);
      }
      if (count === 0) {
        const labels = scope.getByText("预览", { exact: true });
        const labelCount = await labels.count().catch(() => 0);
        for (let index = 0; index < labelCount; index += 1) {
          const label = labels.nth(index);
          if (!(await label.isVisible().catch(() => false))) continue;
          const clickable = label.locator(
            "xpath=ancestor-or-self::*[self::a or self::button or @role='button' or @onclick or contains(concat(' ',normalize-space(@class),' '),' cursor-pointer ')][1]",
          );
          candidates.push((await clickable.count().catch(() => 0)) === 1 ? clickable : label);
        }
      }
    }
    const unique = new Map();
    for (const candidate of candidates) {
      const key = await candidate.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return [
          element.ownerDocument.location.href,
          element.tagName,
          element.id,
          Math.round(rect.left),
          Math.round(rect.top),
          Math.round(rect.width),
          Math.round(rect.height),
        ].join("|");
      }).catch(() => "");
      if (key && !unique.has(key)) unique.set(key, candidate);
    }
    const deduplicated = [...unique.values()];
    const handles = await Promise.all(deduplicated.map((candidate) => candidate.elementHandle().catch(() => null)));
    const nestedParents = new Set();
    for (let left = 0; left < handles.length; left += 1) {
      if (!handles[left]) continue;
      for (let right = 0; right < handles.length; right += 1) {
        if (left === right || !handles[right]) continue;
        const contains = await handles[left].evaluate((element, child) => element !== child && element.contains(child), handles[right]).catch(() => false);
        if (contains) nestedParents.add(left);
      }
    }
    await Promise.all(handles.map((handle) => handle?.dispose().catch(() => {})));
    return deduplicated.filter((_, index) => !nestedParents.has(index));
  }

  async readPreviewHeadingsStable(previewPage) {
    const deadline = Date.now() + this.config.timeouts.blockRenderMs;
    let previous = "";
    let stableSince = 0;
    let headings = [];
    while (Date.now() < deadline) {
      headings = await previewPage.locator("h1,h2,h3,h4,h5,h6").evaluateAll((elements) =>
        elements
          .filter((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          })
          .map((element) => ({
            level: element.tagName.toUpperCase(),
            text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
          })),
      ).catch(() => []);
      const signature = JSON.stringify(headings);
      if (headings.length > 0 && signature === previous) {
        stableSince ||= Date.now();
        if (Date.now() - stableSince >= 1200) return headings;
      } else {
        stableSince = 0;
      }
      previous = signature;
      await previewPage.waitForTimeout(200);
    }
    return headings;
  }

  async openPreviewPage(expectedPath) {
    const buttons = await this.previewButtonCandidates();
    const buttonCheck = classifyV4PreviewOpen({ buttonCount: buttons.length, tabOpened: false, expectedPath });
    if (["preview_button_not_found", "preview_button_ambiguous"].includes(buttonCheck.status)) {
      throw new V4UiError(buttonCheck.status, buttonCheck.reason);
    }
    const context = this.page.context();
    const popupPromise = context.waitForEvent("page", { timeout: this.config.timeouts.actionMs }).catch(() => null);
    await buttons[0].click({ force: true });
    const previewPage = await popupPromise;
    if (!previewPage) {
      const result = classifyV4PreviewOpen({ buttonCount: 1, tabOpened: false, expectedPath });
      throw new V4UiError(result.status, result.reason);
    }
    try {
      previewPage.setDefaultTimeout(this.config.timeouts.actionMs);
      previewPage.setDefaultNavigationTimeout(this.config.timeouts.blockRenderMs);
      await previewPage.waitForLoadState("domcontentloaded", { timeout: this.config.timeouts.blockRenderMs }).catch(() => {});
      const expected = normalizedPagePath(expectedPath);
      const urlDeadline = Date.now() + this.config.timeouts.blockRenderMs;
      let previewContent = null;
      while (Date.now() < urlDeadline) {
        const directPathMatches = normalizedPagePath(previewPage.url()) === expected;
        if (directPathMatches) {
          previewContent = previewPage;
          break;
        }
        previewContent = previewPage.frames().find((frame) =>
          frame !== previewPage.mainFrame() &&
          !/^(?:about:blank)?$/u.test(frame.url()) &&
          normalizedPagePath(frame.url()) === expected,
        ) ?? null;
        if (previewContent) break;
        await previewPage.waitForTimeout(200);
      }
      // 4.0 的“预览”先打开编辑器预览容器，再在 previewWarp iframe 中
      // 加载真实页面。页面路径和 H DOM 都必须以真实内容页为准。
      const actualContent = previewContent ?? previewPage;
      const headings = await this.readPreviewHeadingsStable(actualContent);
      const check = classifyV4PreviewOpen({
        buttonCount: 1,
        tabOpened: true,
        expectedPath,
        actualUrl: actualContent.url(),
        headingCount: headings.length,
      });
      if (check.status !== "verified") {
        throw new V4UiError(check.status, check.reason, {
          containerUrl: previewPage.url(),
          contentUrl: actualContent.url(),
          headings,
        });
      }
      return {
        page: previewPage,
        url: actualContent.url(),
        containerUrl: previewPage.url(),
        source: "editor_preview_button",
        pathStatus: "verified",
        headings,
      };
    } catch (error) {
      await previewPage.close().catch(() => {});
      throw error;
    }
  }

  async clickSemantic(patterns, message, timeoutMs = this.config.timeouts.actionMs) {
    const target = await waitForVisible(this.textLocators(patterns), timeoutMs);
    if (!target) throw new V4UiError("add_failed", message);
    await target.click();
    await this.page.waitForTimeout(450);
    return target;
  }

  async openPageManagement() {
    const existingNewPage = await firstVisible(this.textLocators(this.config.v4Selectors.newPageTexts));
    if (existingNewPage) return;
    const icons = [];
    for (const scope of this.contexts()) {
      icons.push(
        scope.locator("[title='页面管理']:visible"),
        scope.locator(".icon-nav-page").locator("xpath=.."),
      );
    }
    const icon = await waitForVisible(icons);
    if (!icon) throw new V4UiError("add_failed", "未找到左侧第一个“页面管理”图标");
    await icon.click();
    const newPage = await waitForVisible(this.textLocators(this.config.v4Selectors.newPageTexts));
    if (!newPage) throw new V4UiError("add_failed", "点击左侧“页面管理”图标后未出现“新建页面”按钮");
  }

  async closePageManagement() {
    for (const scope of this.contexts()) {
      const panels = scope.locator(".globalPageManager-container:visible");
      const count = await panels.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const panel = panels.nth(index);
        const close = panel.locator(".global-setting-title .global-setting-right").first();
        if (!(await close.isVisible().catch(() => false))) continue;
        await close.click({ force: true });
        await panel.waitFor({ state: "hidden", timeout: this.config.timeouts.actionMs }).catch(() => {});
        await this.page.waitForTimeout(300);
        return true;
      }
    }
    return false;
  }

  async findInputByLabels(labels) {
    const candidates = [];
    for (const scope of this.contexts()) {
      for (const label of labels) {
        const rx = new RegExp(escapeRegex(label), "iu");
        candidates.push(
          scope.getByLabel(rx),
          scope.getByPlaceholder(rx),
          scope.getByText(rx).locator("xpath=following::input[not(@type='hidden')][1]"),
        );
      }
    }
    return firstVisible(candidates);
  }

  async createCustomPage(descriptor) {
    if (await this.pageExists(descriptor.name)) {
      await this.openCustomPage(descriptor.name);
      return { existed: true };
    }
    await this.openPageManagement();
    await this.clickSemantic(this.config.v4Selectors.newPageTexts, "页面管理中未找到底部“新建页面”按钮");

    const dialogs = [];
    for (const scope of this.contexts()) {
      dialogs.push(scope.locator(".el-dialog:visible").filter({ hasText: "页面设置" }));
    }
    const dialog = await waitForVisible(dialogs);
    if (!dialog) throw new V4UiError("add_failed", "点击“新建页面”后未出现“页面设置”弹窗");
    const nameInput = await firstVisible([
      dialog.getByPlaceholder("请填写页面名称", { exact: true }),
      dialog.getByText("页面名称", { exact: true }).locator("xpath=following::input[1]"),
    ]);
    const pathInput = await firstVisible([
      dialog.getByText("页面URL", { exact: true }).locator("xpath=following::input[1]"),
      dialog.locator("input[type='text']").nth(1),
    ]);
    if (!nameInput || !pathInput) {
      throw new V4UiError("add_failed", "4.0页面设置中未同时找到页面名称和URL输入框");
    }
    await nameInput.fill(descriptor.name);
    await this.page.waitForTimeout(500);
    await pathInput.fill(descriptor.path);
    const save = await firstVisible([
      dialog.getByRole("button", { name: "保存", exact: true }),
      dialog.getByText("保存", { exact: true }),
    ]);
    if (!save) throw new V4UiError("add_failed", "页面名称和URL填写后未找到弹窗“保存”按钮");
    await save.click();
    const closed = await dialog.waitFor({ state: "hidden", timeout: this.config.timeouts.saveMs }).then(() => true).catch(() => false);
    if (!closed) {
      const validation = await dialog.locator(".el-form-item__error").allTextContents().catch(() => []);
      throw new V4UiError("save_failed", `4.0页面设置保存后弹窗未关闭${validation.length ? `：${validation.join("；")}` : ""}`);
    }
    await this.page.waitForTimeout(900);
    const selectedInput = await firstVisible(
      this.contexts().map((scope) => scope.getByPlaceholder("页面", { exact: true })),
    );
    if (!(selectedInput && (await selectedInput.inputValue().catch(() => "")) === descriptor.name)) {
      await this.openCustomPage(descriptor.name);
    }
    return { existed: false };
  }

  async openAddPanel(allowRetry = true) {
    const existingSearch = await firstVisible(this.searchLocators());
    if (existingSearch) return existingSearch;
    const plusButtons = [];
    for (const scope of this.contexts()) {
      plusButtons.push(scope.locator(".ld_block_add .floating-action-button:visible"));
    }
    const plusButton = await lastVisible(plusButtons);
    if (plusButton) {
      await plusButton.click();
      await this.page.waitForTimeout(500);
      const search = await waitForVisible(this.searchLocators(), this.config.timeouts.searchResultMs);
      if (!search && allowRetry) {
        await this.page.keyboard.press("Escape").catch(() => {});
        await this.page.waitForTimeout(800);
        return this.openAddPanel(false);
      }
      if (!search) throw new V4UiError("add_failed", "点击蓝色加号后未出现区块搜索框");
      return search;
    }
    let entry = await waitForVisible(this.textLocators(this.config.v4Selectors.addEntryTexts));
    if (!entry) {
      const locators = [];
      for (const scope of this.contexts()) {
        locators.push(
          scope.locator("button[title*='添加区块']:visible"),
          scope.locator("[aria-label*='添加区块']:visible"),
        );
      }
      entry = await firstVisible(locators);
    }
    if (!entry) throw new V4UiError("add_failed", "画布中未找到“添加一个新区块”入口");
    const clickable = await firstVisible([
      entry.locator("xpath=ancestor-or-self::button[1]"),
      entry.locator("xpath=ancestor-or-self::*[@role='button'][1]"),
      entry.locator("xpath=ancestor::*[contains(@class,'add')][1]"),
    ]);
    await (clickable ?? entry).click();
    await this.page.waitForTimeout(500);
    const search = await waitForVisible(this.searchLocators(), this.config.timeouts.searchResultMs);
    if (!search && allowRetry) {
      await this.page.keyboard.press("Escape").catch(() => {});
      await this.page.waitForTimeout(800);
      return this.openAddPanel(false);
    }
    if (!search) throw new V4UiError("add_failed", "点击新区块入口后未出现区块搜索框");
    return search;
  }

  searchLocators() {
    const result = [];
    for (const scope of this.contexts()) {
      for (const placeholder of this.config.v4Selectors.searchPlaceholders) {
        result.push(scope.getByPlaceholder(placeholder, { exact: true }));
      }
      result.push(scope.locator("input[type='search']:visible"));
    }
    return result;
  }

  async locateResultCards(blockId) {
    const cards = [];
    const seen = new Set();
    for (const scope of this.contexts()) {
      const texts = scope.getByText(blockId, { exact: true });
      const count = await texts.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const text = texts.nth(index);
        if (!(await text.isVisible().catch(() => false))) continue;
        const card = await firstVisible([
          text.locator("xpath=ancestor::div[contains(@class,'waterfall-item')][1]"),
          text.locator("xpath=ancestor::*[self::li or self::article][1]"),
          text.locator("xpath=ancestor::div[.//button or .//*[@role='button']][1]"),
          text.locator("xpath=ancestor::div[contains(@class,'item') or contains(@class,'card')][1]"),
        ]);
        const candidate = card ?? text;
        const key = await candidate.evaluate((element) => {
          if (!element.dataset.v4AutomationKey) {
            element.dataset.v4AutomationKey = `v4-${Date.now()}-${Math.random()}`;
          }
          return element.dataset.v4AutomationKey;
        }).catch(() => `fallback-${index}`);
        if (!seen.has(key)) {
          seen.add(key);
          cards.push(candidate);
        }
      }
    }
    return cards;
  }

  async resultAddButton(card) {
    await card.hover().catch(() => {});
    await this.page.waitForTimeout(250);
    const locators = [];
    // 4.0 搜索结果通过点击区块预览卡片本身完成添加。卡片内部可能还
    // 存在说明/切换按钮，因此必须优先选择 item_box，避免误点其它控件。
    locators.push(
      card.locator(".item_box.public-item-block:visible"),
      card.locator(".item_box:visible"),
      card.locator(".lazy__box.cursor-pointer:visible"),
    );
    for (const source of this.config.v4Selectors.addButtonTexts) {
      locators.push(card.getByText(pattern(source)), card.getByRole("button", { name: pattern(source) }));
    }
    locators.push(card.locator("button:visible"), card.locator("[role='button']:visible"));
    return firstVisible(locators);
  }

  async searchAndAdd(blockId) {
    const before = await this.canvasNodeSnapshot();
    // 每次添加完成后侧栏都会关闭，必须从画布底部最新的加号重新打开。
    // openAddPanel 仅在上一次“无结果”等场景侧栏仍打开时复用搜索框。
    const search = await this.openAddPanel();
    await search.fill("");
    await search.fill(blockId);
    await search.press("Enter");
    await this.page.waitForTimeout(700);

    const deadline = Date.now() + this.config.timeouts.searchResultMs;
    let cards = [];
    while (Date.now() < deadline) {
      cards = await this.locateResultCards(blockId);
      if (cards.length > 0) break;
      const empty = await firstVisible(this.textLocators(this.config.v4Selectors.emptyResultTexts));
      if (empty) throw new V4UiError("not_found", `搜索区块ID ${blockId} 后无结果`);
      await this.page.waitForTimeout(200);
    }
    if (cards.length === 0) throw new V4UiError("not_found", `搜索区块ID ${blockId} 后未出现精确结果卡片`);
    if (cards.length !== 1) {
      throw new V4UiError("locator_ambiguous", `区块ID ${blockId} 出现 ${cards.length} 个精确结果卡片`);
    }
    const add = await this.resultAddButton(cards[0]);
    if (!add) throw new V4UiError("add_failed", `区块ID ${blockId} 的结果卡片中未找到“添加”按钮`);
    await add.click();
    const panelClosed = await search
      .waitFor({ state: "hidden", timeout: this.config.timeouts.searchResultMs })
      .then(() => true)
      .catch(() => false);
    if (!panelClosed) {
      throw new V4UiError("add_failed", `点击区块ID ${blockId} 的结果卡片后，区块侧栏未关闭`);
    }
    const audit = await this.waitForBlockAudit(blockId, before);
    return audit;
  }

  async canvasNodeSnapshot() {
    const items = [];
    for (const scope of this.contexts()) {
      const nodes = await scope.evaluate(() => {
        const selectors = "[data-node-id],[data-block-id],[data-blockid],[block-id],[data-app-id],[data-appid],[app-id]";
        return [...document.querySelectorAll(selectors)].map((element, index) => ({
          key: element.getAttribute("data-node-id") || element.getAttribute("data-block-id") || element.getAttribute("data-app-id") || element.id || `node-${index}`,
          tag: element.tagName,
        }));
      }).catch(() => []);
      items.push(...nodes);
    }
    // 同一区块会为不同终端/轮播项输出多份 DOM，但它们共用一个
    // data-node-id。铺页数量和顺序必须按唯一节点 ID 计算。
    const unique = new Map();
    for (const item of items) {
      if (!unique.has(item.key)) unique.set(item.key, item);
    }
    return [...unique.values()];
  }

  async auditBlock(blockId) {
    const audits = [];
    for (const scope of this.contexts()) {
      const found = await scope.evaluate((id) => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        };
        const idPattern = new RegExp(`(^|[^0-9])${id}([^0-9]|$)`);
        const matchesId = (element) => [...element.attributes].some((attribute) => {
          const name = attribute.name.toLowerCase();
          const value = attribute.value;
          if (/app|block|template/.test(name) && idPattern.test(value)) return true;
          return /data|config|setting|props/.test(name) && new RegExp(`[\"'](?:appId|blockId|templateId)[\"']\\s*:\\s*[\"']?${id}(?:[\"']|[,}])`, "i").test(value);
        });
        const direct = [...document.querySelectorAll("*")].filter(matchesId);
        const roots = [];
        for (const match of direct) {
          const root = match.closest("[data-node-id],[data-block-id],[data-blockid],[block-id],[data-app-id],[data-appid],[app-id]") || match;
          if (!roots.includes(root)) roots.push(root);
        }
        return roots.filter(visible).map((root) => {
          const rect = root.getBoundingClientRect();
          const loading = Boolean(root.querySelector(".loading,.is-loading,[aria-busy='true'],.ant-spin-spinning"));
          const text = String(root.innerText ?? "").replace(/\s+/g, " ").trim();
          const errorText = /加载失败|渲染失败|组件异常|区块异常/.test(text);
          const imageCount = root.querySelectorAll("img[src],picture source[srcset]").length;
          return {
            block_id: id,
            editor_dom_id: root.getAttribute("data-node-id") || root.getAttribute("data-block-id") || root.getAttribute("data-app-id") || root.id || "",
            tag_name: root.tagName,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            visible_text: text.slice(0, 500),
            image_count: imageCount,
            loading,
            error_text: errorText,
            has_default_content: text.length > 0 || imageCount > 0,
          };
        });
      }, String(blockId)).catch(() => []);
      audits.push(...found);
    }
    const unique = new Map();
    for (const audit of audits) {
      const key = audit.editor_dom_id || `${audit.tag_name}:${audit.width}:${audit.height}:${audit.visible_text}`;
      unique.set(key, audit);
    }
    return [...unique.values()];
  }

  async auditCanvasNode(editorDomId, blockId = "") {
    if (!editorDomId) return [];
    const escaped = escapeCss(editorDomId);
    const selector = [
      `[data-node-id="${escaped}"]`,
      `[data-block-id="${escaped}"]`,
      `[data-blockid="${escaped}"]`,
      `[data-app-id="${escaped}"]`,
      `[data-appid="${escaped}"]`,
      `[id="${escaped}"]`,
    ].join(",");
    const audits = [];
    for (const scope of this.contexts()) {
      const roots = scope.locator(selector);
      const count = await roots.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const root = roots.nth(index);
        if (!(await root.isVisible().catch(() => false))) continue;
        audits.push(await root.evaluate((element, expectedId) => {
          const rect = element.getBoundingClientRect();
          const text = String(element.innerText ?? "").replace(/\s+/g, " ").trim();
          const imageCount = element.querySelectorAll("img[src],picture source[srcset]").length;
          return {
            block_id: expectedId,
            editor_dom_id: element.getAttribute("data-node-id") || element.getAttribute("data-block-id") || element.getAttribute("data-app-id") || element.id || "",
            tag_name: element.tagName,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            visible_text: text.slice(0, 500),
            image_count: imageCount,
            loading: Boolean(element.querySelector(".loading,.is-loading,[aria-busy='true'],.ant-spin-spinning")),
            error_text: /加载失败|渲染失败|组件异常|区块异常/.test(text),
            has_default_content: text.length > 0 || imageCount > 0,
            evidence: "editor_dom_id",
          };
        }, String(blockId)));
      }
    }
    const unique = new Map();
    for (const audit of audits) {
      const key = audit.editor_dom_id || `${audit.tag_name}:${audit.width}:${audit.height}:${audit.visible_text}`;
      const existing = unique.get(key);
      const score = audit.width * audit.height + audit.image_count + audit.visible_text.length;
      const existingScore = existing
        ? existing.width * existing.height + existing.image_count + existing.visible_text.length
        : -1;
      if (!existing || score > existingScore) unique.set(key, audit);
    }
    return [...unique.values()];
  }

  async waitForBlockAudit(blockId, beforeSnapshot) {
    const deadline = Date.now() + this.config.timeouts.blockRenderMs;
    let lastAudits = [];
    while (Date.now() < deadline) {
      lastAudits = await this.auditBlock(blockId);
      const afterSnapshot = await this.canvasNodeSnapshot();
      const beforeKeys = new Set(beforeSnapshot.map((item) => item.key));
      const newNodes = afterSnapshot.filter((item) => !beforeKeys.has(item.key));
      // 某些模板会在其它区块的配置属性里引用目标 block_id，导致按 ID
      // 扫描得到多个候选。若本次点击只新增了一个稳定画布节点，应以该
      // 节点为准，不能把属性引用误判为重复插入。
      if (lastAudits.length > 1 && newNodes.length === 1 && !newNodes[0].key.startsWith("node-")) {
        const structural = await this.auditCanvasNode(newNodes[0].key, blockId);
        if (structural.length === 1) {
          const audit = { ...structural[0], evidence: "single_unique_node_delta_amid_id_matches" };
          if (audit.error_text) throw new V4UiError("render_failed", `区块 ${blockId} 渲染出错`, { audit, nodeCreated: true });
          if (!audit.loading && audit.width > 0 && audit.height > 0 && audit.has_default_content) return audit;
        }
      }
      if (lastAudits.length > 1) {
        throw new V4UiError("locator_ambiguous", `添加后检测到 ${lastAudits.length} 个 block_id=${blockId} 根节点`);
      }
      if (lastAudits.length === 1) {
        const audit = lastAudits[0];
        if (audit.error_text) throw new V4UiError("render_failed", `区块 ${blockId} 渲染出错`, { audit, nodeCreated: true });
        if (!audit.loading && audit.width > 0 && audit.height > 0 && audit.has_default_content) return audit;
      }
      if (lastAudits.length === 0 && newNodes.length === 1 && !newNodes[0].key.startsWith("node-")) {
        const structural = await this.auditCanvasNode(newNodes[0].key, blockId);
        if (structural.length === 1) {
          const audit = { ...structural[0], evidence: "single_unique_node_delta" };
          if (audit.error_text) throw new V4UiError("render_failed", `区块 ${blockId} 渲染出错`, { audit, nodeCreated: true });
          if (!audit.loading && audit.width > 0 && audit.height > 0 && audit.has_default_content) return audit;
        }
      }
      await this.page.waitForTimeout(350);
    }
    const after = await this.canvasNodeSnapshot();
    const nodeCreated = after.length > beforeSnapshot.length;
    throw new V4UiError(
      "render_failed",
      `添加后60秒内未能唯一确认区块 ${blockId} 完成渲染`,
      { beforeNodeCount: beforeSnapshot.length, afterNodeCount: after.length, nodeCreated, audits: lastAudits },
    );
  }

  async savePage() {
    const save = await waitForVisible(this.textLocators(this.config.v4Selectors.saveTexts));
    if (!save) throw new V4UiError("save_failed", "未找到4.0编辑器右上角“保存”按钮");
    const mutationResponses = [];
    const pageSaveResponses = [];
    const listener = (response) => {
      const request = response.request();
      if (["POST", "PUT", "PATCH"].includes(request.method()) && response.status() >= 200 && response.status() < 300) {
        const evidence = { url: response.url(), status: response.status(), method: request.method() };
        mutationResponses.push(evidence);
        if (/\/newEditor\/savePage$/u.test(new URL(response.url()).pathname)) {
          let requestPageId = "";
          try {
            requestPageId = request.postDataJSON()?.pageId ?? "";
          } catch {}
          evidence.pageId = requestPageId;
          if (!this.currentPageId || !requestPageId || requestPageId === this.currentPageId) pageSaveResponses.push(evidence);
        }
      }
    };
    this.page.on("response", listener);
    try {
      await save.click();
      const deadline = Date.now() + this.config.timeouts.saveMs;
      while (Date.now() < deadline) {
        if (pageSaveResponses.length > 0) {
          await this.page.waitForTimeout(900);
          return { evidence: "page_save_response", currentPageId: this.currentPageId ?? "", pageSaveResponses, mutationResponses };
        }
        await this.page.waitForTimeout(200);
      }
      throw new V4UiError(
        "save_failed",
        `点击“保存”后未检测到当前页面${this.currentPageId ? `(${this.currentPageId})` : ""}的savePage成功响应`,
        { currentPageId: this.currentPageId ?? "", mutationResponses },
      );
    } finally {
      this.page.off("response", listener);
    }
  }

  async verifyBlocks(expectedRecords, options = {}) {
    const records = expectedRecords.map((item) => typeof item === "string" ? { block_id: item, editor_dom_id: "" } : item);
    const found = [];
    for (const record of records) {
      const blockId = record.block_id;
      // 页面重开后画布 iframe 会先出现，再异步恢复区块节点。立即读取会把
      // 已保存区块误判为缺失，因此这里等待稳定节点，而不是只做一次快照。
      const deadline = Date.now() + Math.min(this.config.timeouts.blockRenderMs, 12000);
      let audits = [];
      while (Date.now() < deadline) {
        audits = record.editor_dom_id
          ? await this.auditCanvasNode(record.editor_dom_id, blockId)
          : await this.auditBlock(blockId);
        if (audits.length === 0 && record.editor_dom_id) audits = await this.auditBlock(blockId);
        if (audits.length > 0) break;
        await this.page.waitForTimeout(220);
      }
      if (audits.length !== 1) {
        throw new V4UiError("render_failed", `重开页面后 block_id=${blockId} 的根节点数量为 ${audits.length}`, { blockId, audits });
      }
      found.push({ blockId, audit: audits[0] });
    }
    const expectedIds = records.map((record) => record.block_id);
    const actualKeys = found.map((item) => item.audit.editor_dom_id).filter(Boolean);
    const snapshots = await this.canvasNodeSnapshot();
    const actualOrder = snapshots.filter((item) => actualKeys.includes(item.key)).map((item) => {
      const match = found.find((candidate) => candidate.audit.editor_dom_id === item.key);
      return match?.blockId;
    }).filter(Boolean);
    if (!options.allowOrderMismatch && actualOrder.length === expectedIds.length && actualOrder.join(",") !== expectedIds.join(",")) {
      throw new V4UiError("render_failed", `重开页面后区块顺序不一致：期望 ${expectedIds.join(",")}，实际 ${actualOrder.join(",")}`);
    }
    return found;
  }

  async domOrder(expectedIds) {
    const positions = [];
    for (const scope of this.contexts()) {
      const matches = await scope.evaluate((ids) => {
        const html = document.documentElement.outerHTML;
        return ids.map((id) => ({ id, index: html.search(new RegExp(`(^|[^0-9])${id}([^0-9]|$)`)) })).filter((item) => item.index >= 0);
      }, expectedIds).catch(() => []);
      positions.push(...matches);
    }
    const best = new Map();
    for (const item of positions) {
      if (!best.has(item.id) || item.index < best.get(item.id)) best.set(item.id, item.index);
    }
    return expectedIds
      .filter((id) => best.has(id))
      .sort((left, right) => best.get(left) - best.get(right));
  }
}
