import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { normalizeLevel, normalizeText, resolveHeadingGroupCount } from "./growth-engine-h-core.mjs";
import { assertPreviewPath, resolvePreviewUrl, withCacheBust } from "./preview-url-resolver.mjs";
import { keepChromeMinimized, scheduleChromeMinimize } from "./window-utils.mjs";

function isDisabledClass(className) {
  return /(?:^|\s)(?:is-disabled|disabled)(?:\s|$)/u.test(String(className ?? ""));
}

async function explicitlyDisabled(locator) {
  return locator.evaluate((element) => {
    const ownDisabled = element.disabled || element.readOnly || element.getAttribute("aria-disabled") === "true";
    const disabledParent = element.closest(".is-disabled,[aria-disabled='true']");
    return Boolean(ownDisabled || disabledParent);
  });
}

export async function launchGrowthEngineContext(config, { auth = false } = {}) {
  await mkdir(config.paths.userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(config.paths.userDataDir, {
    channel: config.browser.channel,
    headless: auth ? false : config.browser.headless,
    slowMo: auth ? 0 : config.browser.slowMo,
    locale: config.browser.locale,
    viewport: null,
    args: config.browser.startMinimized ? ["--start-minimized"] : [],
    ...(config.proxyServer ? { proxy: { server: config.proxyServer } } : {}),
  });
  keepChromeMinimized(context);
  return context;
}

export class GrowthEngineHPage {
  constructor(context, config) {
    this.context = context;
    this.config = config;
    this.page = context.pages()[0] ?? null;
    this.frame = null;
  }

  async openPageList() {
    this.page ??= await this.context.newPage();
    this.page.setDefaultTimeout(this.config.timeouts.actionMs);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.page.goto(this.config.growthEngineUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.config.timeouts.navigationMs,
      });
      await this.page.locator("iframe").first().waitFor({ state: "attached", timeout: this.config.timeouts.navigationMs }).catch(() => {});
      await this.page.waitForTimeout(attempt === 0 ? 3500 : 5500);
      this.frame = this.page.frames().find((frame) => frame.url().includes("geo-growth-engine-web"));
      if (this.frame) break;
    }
    if (!this.frame) throw new Error("login_expired: 未找到增长引擎 iframe，请重新登录");
    await this.ensureGrowthEngineSite();
    const visible = this.frame.locator(":visible");
    const search = this.frame.getByText("搜索", { exact: true }).and(visible);
    await search.first().waitFor({ state: "visible", timeout: this.config.timeouts.navigationMs }).catch(() => {});
    if (await search.count() !== 1) throw new Error("login_expired: 未找到增长引擎“搜索”入口");
    await search.click();
    const onPage = this.frame.locator(".submenu-text:visible").filter({ hasText: /^页面整合优化$/u });
    await onPage.first().waitFor({ state: "visible", timeout: this.config.timeouts.actionMs }).catch(() => {});
    if (await onPage.count() !== 1) throw new Error("locator_ambiguous: 页面整合优化入口不是唯一项");
    await onPage.click();
    await this.frame.waitForTimeout(1200);
    await this.frame.locator(".onpage-list").waitFor({ state: "visible" });
  }

  async ensureGrowthEngineSite() {
    const targetName = this.config.growthEngineSite?.name;
    const targetHost = this.config.growthEngineSite?.host;
    if (!targetHost) return;
    const currentName = this.frame.locator(".site-name:visible");
    await currentName.first().waitFor({
      state: "visible",
      timeout: this.config.timeouts.navigationMs,
    }).catch(() => {});
    if (await currentName.count() !== 1) {
      throw new Error(`locator_ambiguous: 增长引擎站点切换入口匹配数量为 ${await currentName.count()}`);
    }
    const currentText = normalizeText(await currentName.innerText());
    const currentBody = normalizeText(await this.frame.locator("body").innerText().catch(() => ""));
    if ((!targetName && currentBody.includes(targetHost)) || (targetName && currentText === targetName && currentBody.includes(targetHost))) return;
    if (!targetName || currentText !== targetName) {
      await currentName.click();
      let target;
      if (targetName) target = this.frame.getByText(targetName, { exact: true }).and(this.frame.locator(":visible"));
      else target = this.frame.locator(".site-item-content:visible").filter({ hasText: targetHost });
      if (await target.count() !== 1 && targetName) {
        const siteSearch = this.frame.locator("input:visible").evaluateAll((elements) => elements.map((element, index) => ({
          index,
          placeholder: element.getAttribute("placeholder") ?? "",
          disabled: Boolean(element.disabled || element.readOnly || element.getAttribute("aria-disabled") === "true"),
        }))).catch(() => []);
        const searchMetadata = await siteSearch;
        const searchCandidate = searchMetadata.find((item) => /搜索网站|搜索站点/u.test(item.placeholder) && !item.disabled);
        if (searchCandidate) {
          await this.frame.locator("input:visible").nth(searchCandidate.index).fill(targetName);
          await this.frame.waitForTimeout(600);
        }
        target = this.frame.getByText(targetName, { exact: true }).and(this.frame.locator(":visible"));
      }
      if (await target.count() !== 1) {
        const label = targetName ? `“${targetName}”` : `域名“${targetHost}”`;
        throw new Error(`locator_ambiguous: 增长引擎站点${label}匹配数量为 ${await target.count()}`);
      }
      const item = targetName
        ? target.locator("xpath=ancestor::div[contains(@class,'site-item-content')][1]")
        : target;
      const itemText = normalizeText(await item.innerText());
      if (!itemText.includes(targetHost)) {
        throw new Error(`locator_ambiguous: 目标站点域名不一致，预期 ${targetHost}，实际 ${itemText}`);
      }
      await item.click();
    }
    const deadline = Date.now() + this.config.timeouts.navigationMs;
    while (Date.now() < deadline) {
      this.frame = this.page.frames().find((frame) => frame.url().includes("geo-growth-engine-web")) ?? this.frame;
      const name = normalizeText(await this.frame.locator(".site-name:visible").innerText().catch(() => ""));
      const bodyText = normalizeText(await this.frame.locator("body").innerText().catch(() => ""));
      if ((!targetName || name === targetName) && bodyText.includes(targetHost)) return;
      await this.page.waitForTimeout(250);
    }
    throw new Error(`login_expired: 切换增长引擎站点到“${targetName || "按域名定位"}/${targetHost}”超时`);
  }

  async open() {
    await this.openPageList();
    await this.searchAndOpenPage(
      this.config.pagePathCandidates ?? [this.config.targetPagePath],
    );
    const tab = this.frame.getByRole("tab", { name: "H标签", exact: true }).and(this.frame.locator(":visible"));
    await tab.first().waitFor({ state: "visible", timeout: this.config.timeouts.actionMs }).catch(() => {});
    const tabCount = await tab.count();
    if (tabCount === 0) {
      const list = this.frame.locator(".onpage-list:visible");
      const target = list.getByText(this.config.targetPagePath, { exact: true });
      if (await list.count() === 1 && await target.count() === 1) {
        const row = target.locator("xpath=ancestor::tr[1]");
        const rowText = normalizeText(await row.innerText().catch(() => ""));
        throw new Error(`page_detail_unavailable: 页面结果存在但无法进入详情${rowText ? `；${rowText}` : ""}`);
      }
      throw new Error("locator_ambiguous: 未找到H标签页签，且无法确认是否仍停留在页面列表");
    }
    if (tabCount !== 1) throw new Error(`locator_ambiguous: H标签页签匹配数量为${tabCount}`);
    await tab.click();
    await this.frame.getByRole("button", { name: "编辑标签", exact: true }).and(this.frame.locator(":visible")).waitFor();
  }

  async locatePageSearchInput() {
    const inputs = this.frame.locator("input:visible:not([type='hidden'])");
    const metadata = await inputs.evaluateAll((elements) => {
      const list = document.querySelector(".onpage-list");
      return elements.map((element, index) => {
        const placeholder = (element.getAttribute("placeholder") ?? "").trim();
        const parentText = (element.parentElement?.parentElement?.textContent ?? "")
          .replace(/\s+/gu, " ").trim().slice(0, 100);
        let score = 0;
        if (/页面|网址|路径/u.test(placeholder)) score += 30;
        if (/搜索/u.test(placeholder)) score += 20;
        if (/请输入/u.test(placeholder)) score += 5;
        if (element.closest(".onpage-search,.onpage-search-box,.onpage-list-wrap,.onpage-wrap")) score += 30;
        if (list) {
          const inputRect = element.getBoundingClientRect();
          const listRect = list.getBoundingClientRect();
          const horizontallyAligned = inputRect.right >= listRect.left && inputRect.left <= listRect.right;
          const aboveList = inputRect.top <= listRect.top && listRect.top - inputRect.bottom < 500;
          if (horizontallyAligned && aboveList) score += 15;
        }
        if (element.readOnly || element.disabled || element.getAttribute("aria-disabled") === "true") score -= 100;
        return { index, score, placeholder, parentText };
      });
    });
    const ranked = metadata.filter((item) => item.score > 0).sort((left, right) => right.score - left.score);
    if (ranked.length === 0) {
      throw new Error(`locator_ambiguous: 页面列表未找到可用搜索框；可见输入框=${JSON.stringify(metadata)}`);
    }
    if (ranked.length > 1 && ranked[0].score === ranked[1].score) {
      throw new Error(`locator_ambiguous: 页面搜索框最高分出现并列；候选=${JSON.stringify(ranked.slice(0, 4))}`);
    }
    return inputs.nth(ranked[0].index);
  }

  async waitForPageSearchStable() {
    const list = this.frame.locator(".onpage-list");
    const deadline = Date.now() + this.config.timeouts.actionMs;
    let stableSince = 0;
    let previousText = "";
    while (Date.now() < deadline) {
      const text = normalizeText(await list.innerText().catch(() => ""));
      const loaders = await this.frame.locator(
        ".el-loading-mask:visible,.el-icon.is-loading:visible,.is-loading:visible",
      ).count();
      if (loaders === 0 && text === previousText) {
        stableSince ||= Date.now();
        if (Date.now() - stableSince >= 800) return;
      } else {
        stableSince = 0;
      }
      previousText = text;
      await this.frame.waitForTimeout(200);
    }
    throw new Error("locator_ambiguous: 搜索页面路径后等待结果稳定超时");
  }

  async waitForScanStable({ timeoutMs = this.config.timeouts.actionMs, stableMs = 1200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const editButton = this.frame.getByRole("button", { name: "编辑标签", exact: true }).and(this.frame.locator(":visible"));
    let previousSignature = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      const loaders = await this.frame.locator(
        ".el-loading-mask:visible,.el-icon.is-loading:visible,.is-loading:visible,[aria-busy='true']",
      ).count().catch(() => 0);
      const bodyText = normalizeText(await this.frame.locator("body").innerText().catch(() => ""));
      const editCount = await editButton.count().catch(() => 0);
      const emptyState = /当前页面未检测到\s*H\s*标签|未检测到\s*H\s*标签|暂无数据/u.test(bodyText);
      const signature = `${editCount}|${emptyState}|${bodyText.slice(-1200)}`;
      if (loaders === 0 && (editCount === 1 || emptyState) && signature === previousSignature) {
        stableSince ||= Date.now();
        if (Date.now() - stableSince >= stableMs) {
          return { status: "stable", editButtonCount: editCount, empty: emptyState };
        }
      } else {
        stableSince = 0;
      }
      previousSignature = signature;
      await this.frame.waitForTimeout(200);
    }
    throw new Error("scan_not_stable: 增长引擎H标签扫描结果未稳定，禁止继续操作");
  }

  async searchAndOpenPage(candidates) {
    const uniqueCandidates = [...new Set(candidates.map((value) => String(value ?? "").trim()).filter(Boolean))];
    if (uniqueCandidates.length === 0) throw new Error("page_not_found: 没有可搜索的页面路径候选");
    const searchInput = await this.locatePageSearchInput();
    for (const candidate of uniqueCandidates) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await searchInput.fill(candidate);
        await searchInput.press("Enter");
        await this.waitForPageSearchStable();
        const target = this.frame.locator(".onpage-list").getByText(candidate, { exact: true });
        const count = await target.count();
        if (count > 1) {
          throw new Error(`locator_ambiguous: 搜索页面 ${candidate} 后精确结果为 ${count} 项`);
        }
        if (count === 0) {
          // 该页面会偶发在回车后闪回默认列表；再次回车确认，而不是立即判定无结果。
          if (attempt === 0) {
            await this.frame.waitForTimeout(300);
            continue;
          }
          break;
        }
        this.config.targetPagePath = candidate;
        this.config.publicUrl = new URL(candidate, this.config.publicUrl).toString();
        await target.click();
        return candidate;
      }
    }
    throw new Error(`page_not_found: 增长引擎搜索不到页面：${uniqueCandidates.join("、")}`);
  }

  async listPagePaths() {
    await this.openPageList();
    const paths = new Set();
    const pagination = this.frame.locator(".el-pagination:visible").last();
    for (let pageNumber = 1; pageNumber <= 50; pageNumber += 1) {
      const list = this.frame.locator(".onpage-list");
      const text = await list.innerText();
      for (const line of text.split(/\r?\n/u).map((value) => value.trim())) {
        if (line.startsWith("/") && line.length > 1 && !/\s/u.test(line)) paths.add(line);
      }
      const next = pagination.locator("button.btn-next");
      if ((await next.count().catch(() => 0)) !== 1) break;
      const disabled = await next.isDisabled().catch(() => false) ||
        (await next.getAttribute("class").catch(() => ""))?.includes("is-disabled");
      if (disabled) break;
      const signature = [...paths].join("|");
      await next.click();
      const deadline = Date.now() + this.config.timeouts.actionMs;
      while (Date.now() < deadline) {
        const nextText = await list.innerText().catch(() => "");
        const nextLines = nextText.split(/\r?\n/u).map((value) => value.trim());
        const nextSignature = nextLines
          .filter((line) => line.startsWith("/") && line.length > 1 && !/\s/u.test(line))
          .join("|");
        if (nextSignature && !signature.includes(nextSignature)) break;
        await this.frame.waitForTimeout(200);
      }
    }
    return [...paths];
  }

  async openEditDialog({ allowEmpty = false } = {}) {
    const button = this.frame.getByRole("button", { name: "编辑标签", exact: true }).and(this.frame.locator(":visible"));
    if (await button.count() !== 1) throw new Error("locator_ambiguous: 编辑标签按钮不是唯一项");
    await button.click();
    let dialog = this.frame.getByRole("dialog").filter({ hasText: "保存并同步" }).last();
    if (allowEmpty && await dialog.count() === 0) {
      dialog = this.frame.locator(".el-dialog:visible").last();
    }
    await dialog.waitFor({ state: "visible" });
    const deadline = Date.now() + this.config.timeouts.syncMs;
    let stableSince = 0;
    let previousSignature = "";
    while (Date.now() < deadline) {
      const textCount = await dialog.locator("input.el-input__inner").count();
      const selectCount = await dialog.locator(".el-select:has(input.el-select__input)").count();
      const loaders = await dialog.locator(
        ".el-loading-mask:visible,.el-icon.is-loading:visible,.is-loading:visible",
      ).count();
      const signature = `${textCount}:${selectCount}`;
      const emptyDialog = allowEmpty && textCount === 0 && selectCount === 0;
      if ((emptyDialog || (textCount > 0 && textCount === selectCount)) && loaders === 0 && signature === previousSignature) {
        stableSince ||= Date.now();
        if (Date.now() - stableSince >= 1000) return dialog;
      } else {
        stableSince = 0;
      }
      previousSignature = signature;
      await this.frame.waitForTimeout(250);
    }
    throw new Error("edit_failed: 点击编辑标签后等待设置项加载完成超时");
  }

  async readPreviewUrl() {
    const link = this.frame.getByRole("link", { name: /^预览地址：/u });
    if (await link.count() !== 1) {
      throw new Error(`locator_ambiguous: 预览地址链接匹配数量为 ${await link.count()}`);
    }
    const href = await link.getAttribute("href");
    if (!href) throw new Error("locator_ambiguous: 预览地址链接缺少 href");
    const url = new URL(href, this.frame.url());
    if (url.pathname !== this.config.targetPagePath) {
      throw new Error(`locator_ambiguous: 预览地址路径 ${url.pathname} 与目标 ${this.config.targetPagePath} 不一致`);
    }
    return url.toString();
  }

  async readPreviewHeadingsAt(url, { source = "derived", cacheBust = true } = {}) {
    const targetUrl = assertPreviewPath(url, this.config.targetPagePath);
    const preview = await this.context.newPage();
    scheduleChromeMinimize();
    const requestUrl = cacheBust ? withCacheBust(targetUrl, `${Date.now()}-${Math.random().toString(16).slice(2)}`) : targetUrl;
    const readHeadings = () => preview.locator("h1,h2,h3,h4,h5,h6").evaluateAll((elements) =>
      elements.map((element) => ({
        level: element.tagName.toUpperCase(),
        text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
      })),
    );
    try {
      const response = await preview.goto(requestUrl, { waitUntil: "domcontentloaded", timeout: this.config.timeouts.navigationMs });
      const httpStatus = response?.status() ?? 0;
      if (!response?.ok()) throw new Error(`preview_http_failed: 预览地址返回 HTTP ${httpStatus}`);
      await preview.waitForTimeout(800);
      const headings = await readHeadings();
      if (headings.length === 0) {
        const bodyText = normalizeText(await preview.locator("body").innerText().catch(() => ""));
        if (/page you visited does not exist|link is broken|404|页面不存在/u.test(bodyText)) {
          if (this.config.allowPublicFallbackOnPreview404 && this.config.publicFallbackBaseUrl) {
            const fallbackUrl = new URL(this.config.targetPagePath, this.config.publicFallbackBaseUrl).toString();
            const fallbackResponse = await preview.goto(withCacheBust(fallbackUrl), { waitUntil: "domcontentloaded", timeout: this.config.timeouts.navigationMs });
            const fallbackHeadings = await readHeadings();
            if (fallbackResponse?.ok() && fallbackHeadings.length > 0) {
              return { url: fallbackUrl, preview_url: targetUrl, source: "public_fallback", http_status: fallbackResponse.status(), headings: fallbackHeadings };
            }
          }
          throw new Error(`preview_404: 预览地址返回不存在页面；${bodyText.slice(0, 160)}`);
        }
        throw new Error(`live_missing: 预览页没有 H 标签${bodyText ? `；页面内容：${bodyText.slice(0, 120)}` : ""}`);
      }
      return { url: targetUrl, preview_url: targetUrl, source, http_status: httpStatus, headings };
    } finally {
      await preview.close().catch(() => {});
    }
  }

  async readPreviewHeadings() {
    const link = this.frame.getByRole("link", { name: /^预览地址：/u });
    if (await link.count() !== 1) {
      throw new Error(`locator_ambiguous: 预览地址链接匹配数量为 ${await link.count()}`);
    }
    const href = await link.getAttribute("href");
    if (!href) throw new Error("locator_ambiguous: 预览地址链接缺少 href");
    const url = assertPreviewPath(new URL(href, this.frame.url()).toString(), this.config.targetPagePath);
    return this.readPreviewHeadingsAt(url, { source: "growth_engine" });
  }

  async inspectDialog(dialog, { allowEmpty = false } = {}) {
    const textInputs = dialog.locator("input.el-input__inner");
    const selects = dialog.locator(".el-select:has(input.el-select__input)");
    const textCount = await textInputs.count();
    const selectCount = await selects.count();
    if (allowEmpty && textCount === 0 && selectCount === 0) return [];
    const groupCount = resolveHeadingGroupCount(selectCount, textCount);
    const items = [];
    for (let index = 0; index < groupCount; index += 1) {
      const textInput = textInputs.nth(index);
      const select = selects.nth(index);
      const selectText = normalizeText(await select.innerText());
      const level = selectText.match(/H[1-6]/iu)?.[0];
      if (!level) throw new Error(`locator_ambiguous: 第 ${index + 1} 项无法读取 H 级别`);
      const text = normalizeText(await textInput.inputValue());
      const levelInput = select.locator("input.el-select__input");
      const levelDisabled = isDisabledClass(await select.getAttribute("class")) ||
        await levelInput.getAttribute("aria-disabled") === "true" ||
        Boolean(await select.locator(".is-disabled").count());
      const textDisabled = await explicitlyDisabled(textInput);
      items.push({
        index,
        level: normalizeLevel(level),
        text,
        levelEditable: !levelDisabled,
        textEditable: !textDisabled,
        select,
        textInput,
      });
    }
    return items;
  }

  async chooseLevel(item, expectedLevel) {
    await item.select.click();
    const visibleDropdown = this.frame.locator(".el-select-dropdown:visible").last();
    const option = visibleDropdown.getByText(expectedLevel, { exact: true });
    if (await option.count() !== 1) {
      throw new Error(`locator_ambiguous: ${expectedLevel} 选项匹配数量为 ${await option.count()}`);
    }
    await option.click();
  }

  async readSelectedLevel(item) {
    const text = normalizeText(await item.select.innerText());
    const level = text.match(/H[1-6]/iu)?.[0];
    if (!level) throw new Error(`locator_ambiguous: 无法读取修改后的H级别，控件文字=${text}`);
    return normalizeLevel(level);
  }

  async cancelDialog(dialog) {
    const cancel = dialog.getByRole("button", { name: "取消", exact: true });
    if (await cancel.count()) await cancel.click();
  }

  async saveAndSync(dialog) {
    const save = dialog.getByRole("button", { name: "保存并同步", exact: true });
    if (await save.isDisabled()) throw new Error("save_not_available: 保存并同步按钮不可用，界面未识别到修改");
    const confirmation = this.frame.getByRole("button", { name: "保存", exact: true });
    try {
      await save.click();
      await confirmation.last().waitFor({ state: "visible" });
      await confirmation.last().click();
    } catch (error) {
      throw new Error(`save_failed: ${error.message}`);
    }
    const acknowledge = this.frame.getByRole("button", { name: "我知道了", exact: true });
    try {
      await acknowledge.waitFor({ state: "visible", timeout: this.config.timeouts.syncMs });
      await acknowledge.click();
    } catch (error) {
      throw new Error(`sync_failed: ${error.message}`);
    }
    await acknowledge.waitFor({ state: "hidden", timeout: this.config.timeouts.actionMs }).catch(() => {});
    const deadline = Date.now() + this.config.timeouts.syncMs;
    let stableSince = 0;
    while (Date.now() < deadline) {
      const loaders = await this.frame.locator(
        ".el-loading-mask:visible,.el-icon.is-loading:visible,.is-loading:visible",
      ).count();
      const refresh = this.frame.getByRole("button", { name: "刷新", exact: true });
      const refreshMissingButAllowed = this.config.refreshButtonOptional && await refresh.count() === 0;
      const ready = refreshMissingButAllowed || (await refresh.count() === 1 && await refresh.isEnabled().catch(() => false));
      if (loaders === 0 && ready) {
        stableSince ||= Date.now();
        if (Date.now() - stableSince >= 1000) {
          if (refreshMissingButAllowed) await this.waitForScanStable({ timeoutMs: this.config.timeouts.actionMs });
          return;
        }
      } else {
        stableSince = 0;
      }
      await this.frame.waitForTimeout(250);
    }
    throw new Error("sync_failed: 保存并同步完成后等待界面恢复超时");
  }

  async refreshAndWait({ failureStatus = "sync_failed" } = {}) {
    const refresh = this.frame.getByRole("button", { name: "刷新", exact: true }).and(this.frame.locator(":visible"));
    if (await refresh.count() === 0 && this.config.refreshButtonOptional) {
      await this.waitForScanStable({ timeoutMs: this.config.timeouts.syncMs });
      return { skipped: true, reason: "refresh_button_removed", completedAt: new Date().toISOString() };
    }
    if (await refresh.count() !== 1) throw new Error("locator_ambiguous: 刷新按钮不是唯一项");
    const startedAt = new Date().toISOString();
    const clickDeadline = Date.now() + this.config.timeouts.syncMs;
    while (Date.now() < clickDeadline) {
      const busy = await refresh.evaluate((element) =>
        element.hasAttribute("disabled") ||
        element.getAttribute("aria-disabled") === "true" ||
        element.classList.contains("is-loading") ||
        Boolean(element.querySelector(".is-loading")),
      ).catch(() => true);
      if (!busy) break;
      await this.frame.waitForTimeout(300);
    }
    const stillBusy = await refresh.evaluate((element) =>
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true" ||
      element.classList.contains("is-loading") ||
      Boolean(element.querySelector(".is-loading")),
    ).catch(() => true);
    if (stillBusy) throw new Error(`${failureStatus}: 刷新按钮持续加载，未执行刷新`);
    await refresh.click();
    const deadline = Date.now() + this.config.timeouts.syncMs;
    let stableSince = 0;
    while (Date.now() < deadline) {
      const buttonBusy = await refresh.evaluate((element) =>
        element.hasAttribute("disabled") ||
        element.getAttribute("aria-disabled") === "true" ||
        element.classList.contains("is-loading") ||
        Boolean(element.querySelector(".is-loading")),
      ).catch(() => true);
      const visibleLoaders = await this.frame.locator(
        ".el-loading-mask:visible,.el-icon.is-loading:visible,.is-loading:visible",
      ).count();
      if (!buttonBusy && visibleLoaders === 0) {
        stableSince ||= Date.now();
        if (Date.now() - stableSince >= 2000) break;
      } else {
        stableSince = 0;
      }
      await this.frame.waitForTimeout(300);
    }
    if (!stableSince || Date.now() >= deadline) {
      throw new Error(`${failureStatus}: 点击刷新后等待刷新完成超时`);
    }
    return { startedAt, completedAt: new Date().toISOString() };
  }

  async refreshAndRead() {
    await this.refreshAndWait();
    const dialog = await this.openEditDialog();
    const inventory = await this.inspectDialog(dialog);
    await this.cancelDialog(dialog);
    const previewUrl = await this.readPreviewUrl();
    return {
      headings: inventory.map(({ level, text }) => ({ level, text })),
      previewUrl,
    };
  }

  resolvePreviewUrl(pagePath = this.config.targetPagePath, options = {}) {
    return resolvePreviewUrl(this.config, pagePath, options);
  }

  async screenshot(name) {
    await mkdir(this.config.paths.artifactsDir, { recursive: true });
    const target = path.join(this.config.paths.artifactsDir, name);
    // Full-page capture of the embedded Growth Engine can wait indefinitely
    // while its virtual scroll container is still laying out.  Failure
    // evidence only needs the visible state, so keep it bounded and avoid
    // blocking the next page in a batch.
    await this.page.screenshot({ path: target, fullPage: false, timeout: 10000 }).catch(() => {});
    return target;
  }
}

export class LiveHeadingReader {
  constructor(config) {
    this.config = config;
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async open() {
    this.browser = await chromium.launch({
      channel: this.config.browser.channel,
      headless: this.config.browser.headless,
      ...(this.config.proxyServer ? { proxy: { server: this.config.proxyServer } } : {}),
      args: this.config.browser.startMinimized ? ["--start-minimized"] : [],
    });
    this.context = await this.browser.newContext({ locale: this.config.browser.locale });
    keepChromeMinimized(this.context);
    this.page = await this.context.newPage();
    scheduleChromeMinimize();
  }

  async read(runId, attempt = 0, targetUrl = this.config.publicUrl) {
    if (!this.page || this.page.isClosed()) await this.open();
    const page = this.page;
    await page.setExtraHTTPHeaders({ "Cache-Control": "no-cache", Pragma: "no-cache" });
    const url = new URL(targetUrl);
    url.searchParams.set("ge_h_run", runId);
    url.searchParams.set("attempt", String(attempt));
    const response = await page.goto(url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: this.config.timeouts.navigationMs,
    });
    if (!response?.ok()) throw new Error(`真实网页 HTTP ${response?.status() ?? "未知"}`);
    await page.waitForTimeout(800);
    return page.locator("h1,h2,h3,h4,h5,h6").evaluateAll((elements) =>
      elements.map((element) => ({
        level: element.tagName.toUpperCase(),
        text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
      })),
    );
  }

  async close() {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

export async function readLiveHeadings(config, runId, attempt = 0) {
  const reader = new LiveHeadingReader(config);
  try {
    return await reader.read(runId, attempt);
  } finally {
    await reader.close();
  }
}
