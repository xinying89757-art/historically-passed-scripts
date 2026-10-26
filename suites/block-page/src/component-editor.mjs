function escapeCssAttributeValue(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("'", "\\'");
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

async function waitUntil(predicate, timeoutMs, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await predicate();
    if (lastValue) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return lastValue;
}

function normalizeLevel(value) {
  const number = String(value ?? "").match(/[1-6]/)?.[0];
  return number ? `H${number}` : "";
}

const COMPONENT_CARD_ALIASES = new Map([
  ["Facebook Messenger插件", ["Facebook Messenger"]],
]);

function normalizeCode(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

export function extractHeadingsFromHtml(html) {
  const headings = [];
  const pattern = /<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/giu;
  for (const match of String(html ?? "").matchAll(pattern)) {
    headings.push({
      level: `H${match[1]}`,
      text: match[2].replace(/<[^>]*>/gu, "").replace(/\s+/gu, " ").trim(),
    });
  }
  return headings;
}

export function auditCustomCodeValue({
  actualCode,
  actualTitle,
  expectedCode,
  expectedHeadings,
}) {
  const actualHeadings = extractHeadingsFromHtml(actualCode);
  const normalizedActual = normalizeCode(actualCode);
  const normalizedExpected = normalizeCode(expectedCode);
  const titleEmpty = String(actualTitle ?? "").trim() === "";
  const headingsEqual =
    JSON.stringify(actualHeadings) === JSON.stringify(expectedHeadings ?? []);
  const codeEqual = normalizedActual === normalizedExpected;
  const ok = titleEmpty && codeEqual && headingsEqual;
  const reasons = [];
  if (!titleEmpty) {
    reasons.push(`组件标题未清空：${actualTitle}`);
  }
  if (!codeEqual) {
    reasons.push("代码框回填内容与预期不一致");
  }
  if (!headingsEqual) {
    reasons.push(
      `H标签不一致：实际=${JSON.stringify(actualHeadings)}`,
    );
  }
  return {
    ok,
    actual_title: String(actualTitle ?? ""),
    actual_level: actualHeadings.map(({ level }) => level).join(","),
    actual_code: String(actualCode ?? ""),
    actual_headings: actualHeadings,
    heading_count: actualHeadings.length,
    evidence: "codeContent",
    reason: reasons.join("；"),
  };
}

function countOccurrences(value, token) {
  if (!token) {
    return 0;
  }
  return String(value ?? "").split(token).length - 1;
}

export function futureEndDate(baseDate = new Date(), days = 30) {
  const value = new Date(baseDate.getTime());
  value.setDate(value.getDate() + days);
  value.setHours(23, 59, 59, 0);
  const pad = (part) => String(part).padStart(2, "0");
  return [
    `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
    `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`,
  ].join(" ");
}

export function auditRichTextDialogValue(record, actual) {
  const actualEditors = (actual.editors ?? []).map((editor, index) => ({
    key: editor.key ?? record.expected_editors?.[index]?.key ?? `editor_${index + 1}`,
    html: String(editor.html ?? ""),
    headings: extractHeadingsFromHtml(editor.html),
  }));
  const expectedEditors = record.expected_editors ?? [];
  const reasons = [];
  if (actualEditors.length !== expectedEditors.length) {
    reasons.push(
      `富文本输入框数量不一致：预期=${expectedEditors.length}，实际=${actualEditors.length}`,
    );
  }
  for (let index = 0; index < expectedEditors.length; index += 1) {
    const expected = expectedEditors[index];
    const editor = actualEditors[index];
    const headings = editor?.headings ?? [];
    if (
      headings.length !== 1 ||
      headings[0]?.level !== expected.level ||
      headings[0]?.text !== expected.text
    ) {
      reasons.push(
        `${expected.key} H标签不一致：实际=${JSON.stringify(headings)}`,
      );
    }
    for (const token of expected.required_tokens ?? []) {
      const count = countOccurrences(editor?.html, token);
      if (count !== 1) {
        reasons.push(`${expected.key} 中 ${token} 数量应为1，实际=${count}`);
      }
    }
  }

  const actualTitle = String(actual.title ?? "");
  const actualTabTitle = String(actual.tabTitle ?? "");
  if (actualTitle !== String(record.expected_title ?? "")) {
    reasons.push(`组件标题回填不一致：实际=${actualTitle}`);
  }
  if (actualTabTitle !== String(record.expected_tab_title ?? "")) {
    reasons.push(`页签名称回填不一致：实际=${actualTabTitle}`);
  }
  if (
    record.end_date_strategy &&
    String(actual.endDate ?? "") !== String(record.end_date ?? "")
  ) {
    reasons.push(`结束日期回填不一致：实际=${actual.endDate ?? ""}`);
  }

  const combinedHtml = actualEditors.map(({ html }) => html).join("\n");
  const actualTokens = (record.required_tokens ?? []).map((token) => ({
    token,
    count: countOccurrences(combinedHtml, token),
  }));
  for (const { token, count } of actualTokens) {
    if (count !== 1) {
      reasons.push(`全部富文本中 ${token} 数量应为1，实际=${count}`);
    }
  }
  const actualHeadings = actualEditors.flatMap(({ headings, key }) =>
    headings.map((heading) => ({ ...heading, editor_key: key })),
  );
  return {
    ok: reasons.length === 0,
    actual_title: actualTitle,
    actual_level: actualHeadings.map(({ level }) => level).join(","),
    actual_code: "",
    actual_headings: actualHeadings,
    actual_editors: actualEditors,
    actual_tokens: actualTokens,
    heading_count: actualHeadings.length,
    end_date: String(actual.endDate ?? ""),
    evidence: "rich_text_dialog",
    reason: reasons.join("；"),
  };
}

export class ComponentEditor {
  constructor(editor) {
    this.editor = editor;
    this.page = editor.page;
    this.config = editor.config;
    this.lastSettingId = "";
  }

  async listComponents() {
    const all = [];
    for (const frame of this.editor.canvasContexts()) {
      const roots = await frame
        .locator(this.config.selectors.componentRootSelector)
        .evaluateAll((elements) =>
          elements.map((element, index) => ({
            setting_id:
              element.getAttribute("settingId") ||
              element.getAttribute("settingid") ||
              element.id.replace(/^component_/, ""),
            dom_id: element.id || "",
            component_name:
              element.getAttribute("componentName") ||
              element.getAttribute("componentname") ||
              element.getAttribute("widget-identy") ||
              "",
            dom_index: index,
            visible: (() => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return (
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== "none" &&
                style.visibility !== "hidden"
              );
            })(),
          })),
        )
        .catch(() => []);
      all.push(...roots.map((item) => ({ ...item, frame_url: frame.url() })));
    }
    return all;
  }

  async componentRoot(settingId) {
    const escaped = escapeCssAttributeValue(settingId);
    for (const frame of this.editor.canvasContexts()) {
      const roots = frame.locator(
        `${this.config.selectors.componentRootSelector}[settingId="${escaped}"], ${this.config.selectors.componentRootSelector}[settingid="${escaped}"], #component_${escaped}`,
      );
      const count = await roots.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const root = roots.nth(index);
        if (await root.isVisible().catch(() => false)) {
          return { frame, root };
        }
      }
    }
    return null;
  }

  async revealLastDroplet() {
    for (const frame of this.editor.canvasContexts()) {
      if (this.lastSettingId) {
        const located = await this.componentRoot(this.lastSettingId);
        if (located?.frame === frame) {
          await located.root.scrollIntoViewIfNeeded().catch(() => {});
          await located.root.hover({ force: true });
          await this.page.waitForTimeout(450);
          const nextDroplets = located.root.locator(
            "xpath=following-sibling::*[contains(concat(' ',normalize-space(@class),' '),' cus-layout-row ')][1]//*[contains(concat(' ',normalize-space(@class),' '),' backstage-layoutrow-addbtns ')]",
          );
          const nextCount = await nextDroplets.count().catch(() => 0);
          for (let index = nextCount - 1; index >= 0; index -= 1) {
            const nextDroplet = nextDroplets.nth(index);
            await nextDroplet.scrollIntoViewIfNeeded().catch(() => {});
            await nextDroplet.hover({ force: true }).catch(() => {});
            if (await nextDroplet.isVisible().catch(() => false)) {
              return { frame, droplet: nextDroplet };
            }
          }
        }
      }
      const roots = frame.locator(this.config.selectors.componentRootSelector);
      const rootCount = await roots.count().catch(() => 0);
      if (rootCount > 0) {
        for (let index = rootCount - 1; index >= 0; index -= 1) {
          const lastRoot = roots.nth(index);
          if (!(await lastRoot.isVisible().catch(() => false))) {
            continue;
          }
          await lastRoot.scrollIntoViewIfNeeded().catch(() => {});
          await lastRoot.hover({ force: true });
          await this.page.waitForTimeout(450);
          break;
        }
      } else {
        const content = await firstVisible([
          frame.locator("#backstage-bodyArea .outerContainer").last(),
          frame.locator("#backstage-bodyArea .row[data-type='rows']").last(),
          frame.locator("#backstage-bodyArea"),
        ]);
        if (content) {
          await content.scrollIntoViewIfNeeded().catch(() => {});
          await content.hover({ force: true });
          await this.page.waitForTimeout(450);
        }
      }

      const droplets = frame.locator(
        `#backstage-bodyArea ${this.config.selectors.componentAddSelectors.join(", #backstage-bodyArea ")}`,
      );
      const count = await droplets.count().catch(() => 0);
      for (let index = count - 1; index >= 0; index -= 1) {
        const droplet = droplets.nth(index);
        const row = droplet.locator(
          "xpath=ancestor::*[contains(concat(' ',normalize-space(@class),' '),' cus-layout-row ')][1]",
        );
        if ((await row.count().catch(() => 0)) > 0) {
          await row.scrollIntoViewIfNeeded().catch(() => {});
          await row.hover({ force: true }).catch(() => {});
          await this.page.waitForTimeout(250);
        }
        await droplet.scrollIntoViewIfNeeded().catch(() => {});
        const usable = await droplet
          .evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.bottom > 0 &&
              rect.top < window.innerHeight
            );
          })
          .catch(() => false);
        if (usable) {
          await droplet.scrollIntoViewIfNeeded().catch(() => {});
          await droplet.hover({ force: true }).catch(() => {});
          return { frame, droplet };
        }
      }
    }
    return null;
  }

  async openComponentPanel() {
    // A previous lookup can legitimately leave the add-component panel open
    // (for example, when a component is not present in any category). Reuse
    // that panel instead of looking for a water-drop hidden behind it.
    for (const frame of this.editor.canvasContexts()) {
      const existing = frame
        .locator(this.config.selectors.componentPanelSelector)
        .first();
      if (await existing.isVisible().catch(() => false)) {
        return { frame, panel: existing };
      }
    }

    let foundControl = false;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const control = await this.revealLastDroplet();
      if (!control) {
        await this.page.waitForTimeout(1000);
        continue;
      }
      foundControl = true;
      await control.droplet.evaluate((element) => element.click());
      const panel = await waitUntil(async () => {
        for (const frame of this.editor.canvasContexts()) {
          const candidate = frame
            .locator(this.config.selectors.componentPanelSelector)
            .first();
          if (await candidate.isVisible().catch(() => false)) {
            return { frame, panel: candidate };
          }
        }
        return null;
      }, Math.min(this.config.timeouts.actionMs, 5000));
      if (panel) {
        return panel;
      }
      await this.page.waitForTimeout(1000);
    }
    throw Object.assign(
      new Error(
        foundControl
          ? "连续八次点击最后一个组件下方水滴，均未出现“添加组件”浮层"
          : "悬浮内容区后未找到可点击的添加组件水滴",
      ),
      { status: "add_failed" },
    );
  }

  async exactComponentCard(panel, originalName) {
    const acceptedNames = new Set([
      originalName,
      ...(COMPONENT_CARD_ALIASES.get(originalName) ?? []),
    ]);
    const findInCurrentCategory = async () => {
      const cards = panel.panel.locator(this.config.selectors.componentCardSelector);
      const matches = [];
      const count = await cards.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const card = cards.nth(index);
        // The editor keeps cards from inactive categories in the DOM. Matching
        // one of those hidden cards makes scrollIntoView wait until timeout and
        // leaves the add panel in a broken-looking state for all later tasks.
        if (!(await card.isVisible().catch(() => false))) {
          continue;
        }
        const displayedName =
          (await card.getAttribute("widget-desc").catch(() => ""))?.trim() ?? "";
        if (
          acceptedNames.has(displayedName) ||
          acceptedNames.has(displayedName.replace(/组件$/u, ""))
        ) {
          matches.push(card);
        }
      }
      return matches;
    };

    let matches = await findInCurrentCategory();
    if (matches.length === 0) {
      const categoryTabs = panel.panel.locator(".backstage-nicescroll-title h3");
      const categoryCount = await categoryTabs.count().catch(() => 0);
      for (let index = 0; index < categoryCount; index += 1) {
        const category = categoryTabs.nth(index);
        if (!(await category.isVisible().catch(() => false))) {
          continue;
        }
        await category.scrollIntoViewIfNeeded().catch(() => {});
        // Phoenix switches component categories on mouseenter (after 200 ms),
        // then lazily requests the selected category. A normal click plus a
        // fixed 600 ms wait can inspect the previous category by mistake.
        await category.hover({ force: true });
        const activated = await waitUntil(
          async () =>
            ((await category.getAttribute("class").catch(() => "")) ?? "")
              .split(/\s+/u)
              .includes("on"),
          Math.min(this.config.timeouts.actionMs, 5000),
        );
        if (!activated) {
          continue;
        }
        const categoryId = await category.getAttribute("data-id");
        if (categoryId) {
          const escapedId = escapeCssAttributeValue(categoryId);
          await waitUntil(async () => {
            const panes = panel.panel.locator(
              `.siteTool-widgetstabs-wrap .siteTool-tabs-innerwrap[id="${escapedId}"]`,
            );
            const paneCount = await panes.count().catch(() => 0);
            for (
              let paneIndex = paneCount - 1;
              paneIndex >= 0;
              paneIndex -= 1
            ) {
              if (await panes.nth(paneIndex).isVisible().catch(() => false)) {
                return true;
              }
            }
            return false;
          }, this.config.timeouts.actionMs);
        } else {
          await this.page.waitForTimeout(800);
        }
        await this.page.waitForTimeout(250);
        matches = await findInCurrentCategory();
        if (matches.length > 0) {
          break;
        }
      }
    }
    if (matches.length === 0) {
      return {
        outcome: "component_not_found",
        reason: `逐个检查全部组件分类后未找到“${originalName}”卡片`,
      };
    }
    if (matches.length > 1) {
      return {
        outcome: "locator_ambiguous",
        reason: `当前组件分类中有 ${matches.length} 个可归一为“${originalName}”的卡片`,
      };
    }
    return { outcome: "found", card: matches[0] };
  }

  async visibleTitleDialog() {
    const inputs = [];
    for (const selector of this.config.selectors.componentTitleSelectors) {
      inputs.push(this.page.locator(selector));
    }
    const titleInput = await firstVisible(inputs);
    const codeInput = await firstVisible([
      this.page.locator("textarea#codeContent"),
      this.page.locator("textarea[name='codeContent']"),
    ]);
    const customHtmlDialog = await firstVisible([
      this.page.locator(".backstage-dialog:visible:has(#cusHTMLSetting)"),
    ]);
    const richTextDialog = await firstVisible([
      this.page.locator("#graphicTabListPop"),
      this.page.locator(".backstage-dialog:has(.backstage-dialog-graphicTabList)"),
      this.page.locator("#holidayNoticePop"),
      this.page.locator(".backstage-dialog:has(textarea#holidayNoticeDescCK)"),
      this.page.locator(
        ".backstage-dialog:has(textarea.startContent):has(textarea.endContent)",
      ),
    ]);
    const anchor = titleInput ?? codeInput ?? customHtmlDialog ?? richTextDialog;
    if (!anchor) {
      return null;
    }
    const ancestorDialog = anchor.locator(
      "xpath=ancestor::*[contains(concat(' ',normalize-space(@class),' '),' backstage-dialog ')][1]",
    );
    const dialog = richTextDialog ?? customHtmlDialog ?? ancestorDialog;
    return {
      dialog: (await dialog.count().catch(() => 0)) > 0 ? dialog : this.page,
      titleInput,
      codeInput,
      codeAdapter: customHtmlDialog ? "custom_html" : "code_content",
      dialogKind: richTextDialog ? "rich_text" : "standard",
    };
  }

  async waitForClassicEditorCount(dialog, expectedCount) {
    const frames = dialog.locator("iframe.cke_wysiwyg_frame:visible");
    const ready = await waitUntil(
      async () =>
        (await frames.count().catch(() => 0)) === expectedCount,
      this.config.timeouts.blockRenderMs,
    );
    if (!ready) {
      throw Object.assign(
        new Error(
          `富文本编辑器数量不一致：预期=${expectedCount}，实际=${await frames.count().catch(() => 0)}`,
        ),
        { status: "settings_not_found" },
      );
    }
    return frames;
  }

  async classicEditor(dialog, index) {
    const iframe = dialog.locator("iframe.cke_wysiwyg_frame:visible").nth(index);
    const handle = await iframe.elementHandle();
    const frame = await handle?.contentFrame();
    if (!frame) {
      throw Object.assign(new Error(`第 ${index + 1} 个富文本 iframe 尚未就绪`), {
        status: "settings_not_found",
      });
    }
    const body = frame.locator(
      "body.cke_editable[contenteditable='true'], body[contenteditable='true']",
    ).first();
    if (!(await body.isVisible().catch(() => false))) {
      throw Object.assign(new Error(`第 ${index + 1} 个富文本正文不可见`), {
        status: "settings_not_found",
      });
    }
    const shell = iframe.locator(
      "xpath=ancestor::*[.//*[contains(concat(' ', normalize-space(@class), ' '), ' cke_combo__format ')]][1]",
    );
    const formatButton = shell.locator(
      ".cke_combo__format .cke_combo_button",
    ).first();
    if (!(await formatButton.isVisible().catch(() => false))) {
      throw Object.assign(new Error(`第 ${index + 1} 个富文本没有“格式”按钮`), {
        status: "level_control_not_found",
      });
    }
    return { iframe, frame, body, shell, formatButton };
  }

  async chooseHeadingOption(level) {
    const optionLabel = `标题 ${String(level).replace(/\D/g, "")}`;
    const options = [];
    for (const scope of this.editor.contexts()) {
      const locator = scope.locator(`[role='option'][title='${optionLabel}']`);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const option = locator.nth(index);
        if (await option.isVisible().catch(() => false)) {
          options.push(option);
        }
      }
    }
    if (options.length !== 1) {
      throw Object.assign(
        new Error(`格式菜单中可见“${optionLabel}”选项数量为 ${options.length}`),
        { status: "level_control_not_found" },
      );
    }
    await options[0].click({ force: true });
    await this.page.waitForTimeout(500);
  }

  async configureClassicEditor(dialog, index, expected) {
    const editor = await this.classicEditor(dialog, index);
    await editor.body.click();
    await editor.body.fill(expected.text);
    for (const token of expected.required_tokens ?? []) {
      await editor.body.press("End");
      await editor.body.press("Enter");
      await editor.body.type(token);
    }
    const textBlock = editor.body.getByText(expected.text, { exact: true }).first();
    if (await textBlock.isVisible().catch(() => false)) {
      await textBlock.selectText();
    } else {
      await editor.body.selectText();
    }
    await editor.formatButton.click();
    await this.page.waitForTimeout(350);
    await this.chooseHeadingOption(expected.level);

    const selector = expected.level.toLowerCase();
    const heading = editor.body.locator(selector).filter({
      hasText: expected.text,
    }).first();
    if ((await heading.count().catch(() => 0)) !== 1) {
      throw Object.assign(
        new Error(`${expected.key} 未生成预期 ${expected.level}`),
        { status: "component_save_failed" },
      );
    }
    const html = await editor.body.innerHTML();
    return { key: expected.key, html };
  }

  async readClassicEditors(dialog, record) {
    await this.waitForClassicEditorCount(
      dialog,
      record.expected_editors.length,
    );
    const editors = [];
    for (let index = 0; index < record.expected_editors.length; index += 1) {
      const editor = await this.classicEditor(dialog, index);
      editors.push({
        key: record.expected_editors[index].key,
        html: await editor.body.innerHTML(),
      });
    }
    return editors;
  }

  async configureRichTextDialog(record, found = null) {
    const current = found ?? (await this.visibleTitleDialog());
    if (!current || current.dialogKind !== "rich_text") {
      throw Object.assign(new Error("富文本组件设置弹窗未出现"), {
        status: "settings_not_found",
      });
    }
    const { dialog, titleInput } = current;
    if (record.original_name === "图文页签") {
      const add = dialog.locator("a.addTab").first();
      if (!(await add.isVisible().catch(() => false))) {
        throw Object.assign(new Error("图文页签中未找到“新增一条”"), {
          status: "settings_not_found",
        });
      }
      if ((await dialog.locator(".graphic-item:not(.hide)").count()) === 0) {
        await add.click();
      }
      const tabTitle = dialog
        .locator(".graphic-item:not(.hide) .graphic-item-title")
        .first();
      await tabTitle.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
      await tabTitle.fill(record.expected_tab_title);
    }
    if (record.original_name === "公告") {
      if (!titleInput || !(await titleInput.isEditable().catch(() => false))) {
        throw Object.assign(new Error("公告组件标题输入框不可编辑"), {
          status: "title_control_not_found",
        });
      }
      await titleInput.fill(record.expected_title);
    }
    if (record.original_name === "倒计时") {
      record.end_date ||= futureEndDate();
      const endDate = dialog.locator("input[id^='setEndDate']").first();
      if (!(await endDate.isEditable().catch(() => false))) {
        throw Object.assign(new Error("倒计时结束日期输入框不可编辑"), {
          status: "title_control_not_found",
        });
      }
      await endDate.fill(record.end_date);
      await endDate.press("Tab");
    }

    await this.waitForClassicEditorCount(dialog, record.expected_editors.length);
    for (let index = 0; index < record.expected_editors.length; index += 1) {
      await this.configureClassicEditor(
        dialog,
        index,
        record.expected_editors[index],
      );
    }
    const beforeSave = auditRichTextDialogValue(record, {
      title: titleInput ? await titleInput.inputValue() : "",
      tabTitle:
        record.original_name === "图文页签"
          ? await dialog
              .locator(".graphic-item:not(.hide) .graphic-item-title")
              .first()
              .inputValue()
          : "",
      editors: await this.readClassicEditors(dialog, record),
      endDate:
        record.original_name === "倒计时"
          ? await dialog.locator("input[id^='setEndDate']").first().inputValue()
          : "",
    });
    if (!beforeSave.ok) {
      throw Object.assign(
        new Error(`富文本组件保存前校验失败：${beforeSave.reason}`),
        { status: "component_save_failed" },
      );
    }
    const save = await firstVisible([
      dialog.locator(this.config.selectors.componentDialogSaveSelector),
      dialog.getByText(/^保存$/),
    ]);
    if (!save) {
      throw Object.assign(new Error("富文本设置弹窗中未找到“保存”按钮"), {
        status: "component_save_failed",
      });
    }
    await save.scrollIntoViewIfNeeded().catch(() => {});
    await save.click();
    const closed = await waitUntil(
      async () => !(await dialog.isVisible().catch(() => false)),
      this.config.timeouts.saveMs,
    );
    if (!closed) {
      throw Object.assign(new Error("点击富文本设置保存后弹窗未关闭"), {
        status: "component_save_failed",
      });
    }
    return beforeSave;
  }

  async resolveCustomCodeInput(record, found) {
    if (record.original_name !== "自定义HTML") {
      return found.codeInput;
    }
    const sourceTab = found.dialog.locator("#cusHTML_Dev").first();
    if (!(await sourceTab.isVisible().catch(() => false))) {
      return null;
    }
    await sourceTab.click({ force: true });
    const codeInput = found.dialog.locator("textarea#code-html").first();
    const visible = await waitUntil(
      () => codeInput.isVisible().catch(() => false),
      this.config.timeouts.actionMs,
    );
    return visible ? codeInput : null;
  }

  async waitForDialogOrNewComponent(beforeIds) {
    return waitUntil(async () => {
      const dialog = await this.visibleTitleDialog();
      if (dialog) {
        return { kind: "dialog", dialog };
      }
      const components = await this.listComponents();
      const added = components.find(
        (component) => component.setting_id && !beforeIds.has(component.setting_id),
      );
      return added ? { kind: "component", component: added } : null;
    }, this.config.timeouts.blockRenderMs);
  }

  async configureCustomCodeDialog(record, found = null) {
    const current = found ?? (await this.visibleTitleDialog());
    if (!current) {
      throw Object.assign(new Error("自定义代码组件设置弹窗未出现"), {
        status: "settings_not_found",
      });
    }
    const { dialog, titleInput } = current;
    const codeInput = await this.resolveCustomCodeInput(record, current);
    if (!codeInput || !(await codeInput.isEditable().catch(() => false))) {
      throw Object.assign(new Error("组件设置中未找到可编辑的代码输入框"), {
        status: "title_control_not_found",
      });
    }
    if (titleInput && (await titleInput.isEditable().catch(() => false))) {
      await titleInput.fill("");
    }
    await codeInput.fill(record.expected_code);
    const beforeSave = auditCustomCodeValue({
      actualCode: await codeInput.inputValue(),
      actualTitle: titleInput ? await titleInput.inputValue() : "",
      expectedCode: record.expected_code,
      expectedHeadings: record.expected_headings,
    });
    if (!beforeSave.ok || beforeSave.heading_count !== 5) {
      throw Object.assign(
        new Error(`保存前自定义代码校验失败：${beforeSave.reason}`),
        { status: "component_save_failed" },
      );
    }

    const save = await firstVisible([
      dialog.locator(this.config.selectors.componentDialogSaveSelector),
      dialog.getByText(/^保存$/),
    ]);
    if (!save) {
      throw Object.assign(new Error("自定义代码设置弹窗中未找到“保存”按钮"), {
        status: "component_save_failed",
      });
    }
    await save.scrollIntoViewIfNeeded().catch(() => {});
    await save.click();
    const closed = await waitUntil(
      async () => !(await codeInput.isVisible().catch(() => false)),
      this.config.timeouts.saveMs,
    );
    if (!closed) {
      throw Object.assign(new Error("点击自定义代码保存后弹窗未关闭"), {
        status: "component_save_failed",
      });
    }
    return beforeSave;
  }

  async configureVisibleDialog(record) {
    const found = await this.visibleTitleDialog();
    if (!found) {
      throw Object.assign(new Error("组件设置弹窗未出现或弹窗内没有组件标题"), {
        status: "settings_not_found",
      });
    }
    if (record.component_kind === "custom_code") {
      return this.configureCustomCodeDialog(record, found);
    }
    if (record.component_kind === "rich_text_dialog") {
      return this.configureRichTextDialog(record, found);
    }
    const expectedTitle = record.expected_title;
    const expectedLevel = record.expected_level || "H2";
    const originalName = record.original_name;
    const { dialog, titleInput } = found;
    if (!titleInput || !(await titleInput.isEditable().catch(() => false))) {
      throw Object.assign(new Error("组件标题输入框不可编辑"), {
        status: "title_control_not_found",
      });
    }
    await titleInput.fill(expectedTitle);

    if (originalName === "视频") {
      const videoTitle = dialog.locator("input#videoInfo, input[name='videoInfo']").first();
      if ((await videoTitle.count().catch(() => 0)) === 0) {
        throw Object.assign(new Error("视频组件设置中未找到必填的视频标题输入框"), {
          status: "title_control_not_found",
        });
      }
      await videoTitle.fill("视频标题测试内容");
    }
    if (originalName === "Google地图") {
      const apiKey = dialog.locator("input#gMapApiKey").first();
      const currentKey =
        (await apiKey.inputValue().catch(() => ""))?.trim() ?? "";
      if (!currentKey) {
        throw Object.assign(
          new Error("测试站没有默认 Google 地图 API 密钥，按依赖数据不足记录失败"),
          { status: "component_save_failed" },
        );
      }
    }
    if (originalName === "通用查询") {
      const selects = dialog.locator("select");
      const count = await selects.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const select = selects.nth(index);
        const selectedText = await select
          .locator("option:checked")
          .textContent()
          .catch(() => "");
        if (/请选择查询系统/u.test(selectedText ?? "")) {
          throw Object.assign(
            new Error("测试站未配置通用查询系统，无法完成组件必填项"),
            { status: "component_save_failed" },
          );
        }
      }
    }

    const expectedValue = expectedLevel.replace(/\D/g, "");
    const level = dialog
      .locator(`#title-hx-radio input[type='radio'][value='${expectedValue}']`)
      .first();
    if ((await level.count().catch(() => 0)) === 0) {
      throw Object.assign(new Error("组件设置中未找到标题类型 H2 控件"), {
        status: "level_control_not_found",
      });
    }
    await level.check({ force: true });

    const save = await firstVisible([
      dialog.locator(this.config.selectors.componentDialogSaveSelector),
      dialog.getByText(/^保存$/),
    ]);
    if (!save) {
      throw Object.assign(new Error("组件设置弹窗中未找到“保存”按钮"), {
        status: "component_save_failed",
      });
    }
    await save.scrollIntoViewIfNeeded().catch(() => {});
    await save.click();
    const closed = await waitUntil(
      async () => !(await titleInput.isVisible().catch(() => false)),
      this.config.timeouts.saveMs,
    );
    if (!closed) {
      throw Object.assign(new Error("点击组件设置保存后弹窗未关闭"), {
        status: "component_save_failed",
      });
    }
  }

  async cancelOpenDialog() {
    const dialog = await firstVisible([
      this.page.locator(".backstage-dialog"),
    ]);
    if (!dialog) {
      return true;
    }
    const candidates = [
      dialog.locator(this.config.selectors.componentDialogCancelSelector).first(),
      dialog.getByText(/^(取消|关闭)$/).first(),
      dialog.locator(".backstage-dialog-close").first(),
      dialog.locator(".title .closed, [title='关闭'], [aria-label='关闭']").first(),
    ];
    for (const candidate of candidates) {
      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }
      const target = candidate.locator("xpath=ancestor-or-self::*[self::a or self::button][1]");
      await ((await target.count().catch(() => 0)) > 0 ? target : candidate)
        .click({ force: true })
        .catch(() =>
          candidate
            .evaluate((element) => (element.closest("a,button") ?? element).click())
            .catch(() => null),
        );
      const closed = await waitUntil(
        async () => !(await dialog.isVisible().catch(() => false)),
        Math.min(this.config.timeouts.actionMs, 5000),
      );
      if (closed) {
        return true;
      }
    }
    await this.page.keyboard.press("Escape").catch(() => {});
    await this.page.waitForTimeout(350);
    return !(await dialog.isVisible().catch(() => false));
  }

  async configureInlineText(settingId, expectedTitle, expectedLevel = "H2") {
    const located = await this.componentRoot(settingId);
    if (!located) {
      throw Object.assign(new Error(`文本组件 settingId=${settingId} 不在画布中`), {
        status: "render_failed",
      });
    }
    const editable = located.root
      .locator(
        ".sitewidget-bd[contenteditable='true'], [contenteditable='true'].sitewidget-bd, .sitewidget-bd",
      )
      .first();
    if ((await editable.count().catch(() => 0)) === 0) {
      throw Object.assign(new Error("文本组件中未找到文字编辑区域"), {
        status: "title_control_not_found",
      });
    }
    await editable.scrollIntoViewIfNeeded().catch(() => {});
    await editable.click();
    const activated = await waitUntil(
      async () =>
        (await editable.getAttribute("contenteditable").catch(() => "")) ===
          "true" ||
        (await editable.evaluate((element) => element.isContentEditable).catch(() => false)),
      this.config.timeouts.actionMs,
    );
    if (!activated) {
      throw Object.assign(new Error("点击文本组件后没有进入内嵌富文本编辑状态"), {
        status: "title_control_not_found",
      });
    }

    await editable.fill(expectedTitle);
    await editable.click();
    await editable.selectText();
    await this.page.waitForTimeout(450);

    const editableId = await editable.getAttribute("id");
    if (!editableId) {
      throw Object.assign(new Error("内嵌富文本没有稳定 id，无法定位格式工具栏"), {
        status: "level_control_not_found",
      });
    }
    const shell = located.frame.locator(`#cke_${escapeCssAttributeValue(editableId)}`).first();
    const formatButton = shell.locator(".cke_combo__format .cke_combo_button").first();
    if (!(await formatButton.isVisible().catch(() => false))) {
      throw Object.assign(new Error("文本组件富文本工具栏中未找到“格式”按钮"), {
        status: "level_control_not_found",
      });
    }
    await formatButton.click();
    await this.page.waitForTimeout(450);
    const optionLabel = `标题 ${expectedLevel.replace(/\D/g, "")}`;
    const options = [];
    for (const scope of this.editor.contexts()) {
      const locator = scope.locator(`[role='option'][title='${optionLabel}']`);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const option = locator.nth(index);
        if (await option.isVisible().catch(() => false)) {
          options.push(option);
        }
      }
    }
    if (options.length !== 1) {
      throw Object.assign(
        new Error(`格式菜单中可见“${optionLabel}”选项数量为 ${options.length}`),
        { status: "level_control_not_found" },
      );
    }
    await options[0].click({ force: true });
    await this.page.waitForTimeout(600);
    await editable.press("Tab").catch(() =>
      editable.evaluate((element) => element.blur()),
    );
    await this.page.waitForTimeout(1200);

    const audit = await this.auditConfigured(
      settingId,
      expectedTitle,
      expectedLevel,
    );
    if (!audit.ok) {
      throw Object.assign(new Error(audit.reason || "文本组件 H2 验证失败"), {
        status: "component_save_failed",
      });
    }
    return audit;
  }

  async auditInlineText(settingId, expectedTitle, expectedLevel) {
    const located = await this.componentRoot(settingId);
    if (!located) {
      return {
        ok: false,
        actual_title: "",
        actual_level: "",
        evidence: "inline_rich_text_format",
        reason: `文本组件 settingId=${settingId} 不在画布中`,
      };
    }
    const editable = located.root
      .locator(
        ".sitewidget-bd[contenteditable='true'], [contenteditable='true'].sitewidget-bd, .sitewidget-bd",
      )
      .filter({ hasText: expectedTitle })
      .first();
    if (!(await editable.isVisible().catch(() => false))) {
      return {
        ok: false,
        actual_title: "",
        actual_level: "",
        evidence: "inline_rich_text_format",
        reason: "文本组件中未找到包含预期文字的富文本区域",
      };
    }
    await editable.scrollIntoViewIfNeeded().catch(() => {});
    await editable.click();
    const activated = await waitUntil(
      async () =>
        (await editable.getAttribute("contenteditable").catch(() => "")) === "true" ||
        await editable.evaluate((element) => element.isContentEditable).catch(() => false),
      this.config.timeouts.actionMs,
    );
    if (!activated) {
      return {
        ok: false,
        actual_title: "",
        actual_level: "",
        evidence: "inline_rich_text_format",
        reason: "点击文本元素后未进入内嵌富文本状态",
      };
    }
    const expectedSelector = String(expectedLevel).toLowerCase();
    const heading = editable.locator(expectedSelector).filter({ hasText: expectedTitle });
    const headingCount = await heading.count().catch(() => 0);
    if (headingCount === 1) await heading.selectText();
    else await editable.selectText();
    await this.page.waitForTimeout(350);

    const editableId = await editable.getAttribute("id");
    const shell = editableId
      ? located.frame.locator(`#cke_${escapeCssAttributeValue(editableId)}`).first()
      : null;
    const formatButton = shell?.locator(".cke_combo__format .cke_combo_button").first();
    const formatLabel = formatButton && await formatButton.isVisible().catch(() => false)
      ? String(await formatButton.locator(".cke_combo_text").textContent().catch(() => "")).trim()
      : "";
    const actualHeadings = await editable.locator("h1,h2,h3,h4,h5,h6").evaluateAll(
      (elements, expected) => elements
        .map((element) => ({
          level: element.tagName.toUpperCase(),
          text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
        }))
        .filter((item) => item.text === expected),
      expectedTitle,
    ).catch(() => []);
    await this.page.keyboard.press("Escape").catch(() => {});
    await editable.evaluate((element) => element.blur()).catch(() => {});

    const actual = actualHeadings.length === 1 ? actualHeadings[0] : null;
    const expectedFormatLabel = `标题 ${String(expectedLevel).replace(/\D/gu, "")}`;
    const ok = actualHeadings.length === 1 &&
      actual.level === String(expectedLevel).toUpperCase() &&
      actual.text === expectedTitle &&
      formatLabel === expectedFormatLabel;
    return {
      ok,
      actual_title: actual?.text ?? "",
      actual_level: actual?.level ?? "",
      format_label: formatLabel,
      evidence: "inline_rich_text_format",
      reason: ok
        ? ""
        : `文本富文本回填不一致：匹配数=${actualHeadings.length}，级别=${actual?.level ?? ""}，文字=${actual?.text ?? ""}，格式=${formatLabel || "空"}`,
    };
  }

  async configureExisting(record) {
    if (record.original_name === "文本") {
      const audit = await this.configureInlineText(
        record.setting_id,
        record.expected_title,
        record.expected_level,
      );
      this.lastSettingId = record.setting_id;
      return { outcome: "configured", component: { setting_id: record.setting_id }, audit };
    }
    if (record.component_kind === "custom_code") {
      if (!(await this.openSettings(record.setting_id))) {
        return {
          outcome: "settings_not_found",
          component: { setting_id: record.setting_id },
          reason: "恢复时无法打开自定义代码组件设置",
        };
      }
      try {
        await this.configureCustomCodeDialog(record);
        const audit = await this.auditCustomCode(record.setting_id, record);
        this.lastSettingId = record.setting_id;
        return audit.ok
          ? {
              outcome: "configured",
              component: { setting_id: record.setting_id },
              audit,
            }
          : {
              outcome: "component_save_failed",
              component: { setting_id: record.setting_id },
              audit,
              reason: audit.reason,
            };
      } catch (error) {
        return {
          outcome: error.status ?? "component_save_failed",
          component: { setting_id: record.setting_id },
          reason: error.message,
        };
      }
    }
    if (record.component_kind === "rich_text_dialog") {
      if (!(await this.openSettings(record.setting_id))) {
        return {
          outcome: "settings_not_found",
          component: { setting_id: record.setting_id },
          reason: "恢复时无法打开富文本组件设置",
        };
      }
      try {
        await this.configureRichTextDialog(record);
        const audit = await this.auditRichTextDialog(record.setting_id, record);
        this.lastSettingId = record.setting_id;
        return audit.ok
          ? {
              outcome: "configured",
              component: { setting_id: record.setting_id },
              audit,
            }
          : {
              outcome: "component_save_failed",
              component: { setting_id: record.setting_id },
              audit,
              reason: audit.reason,
            };
      } catch (error) {
        return {
          outcome: error.status ?? "component_save_failed",
          component: { setting_id: record.setting_id },
          reason: error.message,
        };
      }
    }
    return {
      outcome: record.status,
      component: { setting_id: record.setting_id },
      reason: "该已添加组件没有安全的自动恢复配置流程",
    };
  }

  async openSettings(settingId) {
    const located = await this.componentRoot(settingId);
    if (!located) {
      return false;
    }
    await located.root.scrollIntoViewIfNeeded().catch(() => {});
    await located.root.hover({ force: true });
    await this.page.waitForTimeout(400);
    const edit = located.root
      .locator(".backstage-widgetsettings-tools a[item_attr='component_edit']")
      .first();
    if ((await edit.count().catch(() => 0)) === 0) {
      return false;
    }
    if (await edit.isVisible().catch(() => false)) {
      await edit.click({ force: true });
    } else {
      await edit.evaluate((element) => element.click());
    }
    return Boolean(
      await waitUntil(
        () => this.visibleTitleDialog(),
        this.config.timeouts.blockRenderMs,
      ),
    );
  }

  async deleteComponent(settingId) {
    const located = await this.componentRoot(settingId);
    if (!located) {
      throw new Error(`页面中未找到待移动组件 settingId=${settingId}`);
    }
    await located.root.scrollIntoViewIfNeeded().catch(() => {});
    await located.root.hover({ force: true });
    await this.page.waitForTimeout(450);
    const remove = located.root
      .locator(".backstage-widgetsettings-tools a[item_attr='component_delete']")
      .first();
    if ((await remove.count().catch(() => 0)) === 0) {
      throw new Error(`settingId=${settingId} 没有“删除组件”工具`);
    }
    if (await remove.isVisible().catch(() => false)) {
      await remove.click({ force: true });
    } else {
      await remove.evaluate((element) => element.click());
    }

    const confirmation = await waitUntil(async () => {
      for (const scope of this.editor.contexts()) {
        const dialogs = scope.locator(".backstage-dialog:visible");
        const count = await dialogs.count().catch(() => 0);
        for (let index = count - 1; index >= 0; index -= 1) {
          const dialog = dialogs.nth(index);
          const content = await dialog.textContent().catch(() => "");
          const submit = dialog.locator(".backstage-dialog-submit").first();
          if (/删除/u.test(content ?? "") && await submit.isVisible().catch(() => false)) {
            return { dialog, submit };
          }
        }
      }
      return null;
    }, this.config.timeouts.actionMs);
    if (!confirmation) {
      throw new Error(`settingId=${settingId} 未出现删除确认弹窗`);
    }
    await confirmation.submit.click({ force: true });
    const removed = await waitUntil(
      async () => !(await this.componentRoot(settingId)),
      this.config.timeouts.blockRenderMs,
    );
    if (!removed) {
      throw new Error(`settingId=${settingId} 确认删除后仍存在于页面`);
    }
    this.lastSettingId = "";
  }

  async readAndCloseVisibleDialog() {
    const found = await this.visibleTitleDialog();
    if (!found) {
      return null;
    }
    const title = await found.titleInput.inputValue();
    const levelValue = await found.dialog
      .locator("#title-hx-radio input[type='radio']:checked")
      .first()
      .getAttribute("value")
      .catch(() => "");
    const cancel = await firstVisible([
      found.dialog.locator(this.config.selectors.componentDialogCancelSelector),
      found.dialog.getByText(/^(取消|关闭)$/),
    ]);
    if (cancel) {
      await cancel.click();
    }
    return { actual_title: title, actual_level: normalizeLevel(levelValue) };
  }

  async readAndCloseCustomCodeDialog(record) {
    const found = await this.visibleTitleDialog();
    if (!found) {
      return {
        ok: false,
        actual_title: "",
        actual_level: "",
        actual_code: "",
        actual_headings: [],
        heading_count: 0,
        evidence: "codeContent",
        reason: "重新打开设置后未找到代码输入框",
      };
    }
    const codeInput = await this.resolveCustomCodeInput(record, found);
    if (!codeInput || !(await codeInput.isVisible().catch(() => false))) {
      await this.cancelOpenDialog();
      return {
        ok: false,
        actual_title: "",
        actual_level: "",
        actual_code: "",
        actual_headings: [],
        heading_count: 0,
        evidence: "codeContent",
        reason: "重新打开设置后未找到代码输入框",
      };
    }
    const audit = auditCustomCodeValue({
      actualCode: await codeInput.inputValue(),
      actualTitle: found.titleInput ? await found.titleInput.inputValue() : "",
      expectedCode: record.expected_code,
      expectedHeadings: record.expected_headings,
    });
    const closed = await this.cancelOpenDialog();
    if (!closed) {
      return {
        ...audit,
        ok: false,
        reason: [audit.reason, "回填验证后无法关闭设置弹窗"]
          .filter(Boolean)
          .join("；"),
      };
    }
    return audit;
  }

  async auditCustomCode(settingId, record) {
    const located = await this.componentRoot(settingId);
    if (!located) {
      return {
        ok: false,
        actual_title: "",
        actual_level: "",
        actual_code: "",
        actual_headings: [],
        heading_count: 0,
        evidence: "codeContent",
        reason: `页面中未找到 settingId=${settingId} 的自定义代码组件`,
      };
    }
    if (!(await this.openSettings(settingId))) {
      return {
        ok: false,
        actual_title: "",
        actual_level: "",
        actual_code: "",
        actual_headings: [],
        heading_count: 0,
        evidence: "codeContent",
        reason: "无法重新打开自定义代码组件设置验证回填",
      };
    }
    return this.readAndCloseCustomCodeDialog(record);
  }

  async readAndCloseRichTextDialog(record) {
    const found = await this.visibleTitleDialog();
    if (!found || found.dialogKind !== "rich_text") {
      return {
        ok: false,
        actual_title: "",
        actual_level: "",
        actual_code: "",
        actual_headings: [],
        actual_editors: [],
        actual_tokens: [],
        heading_count: 0,
        end_date: "",
        evidence: "rich_text_dialog",
        reason: "重新打开设置后未找到富文本组件弹窗",
      };
    }
    const { dialog, titleInput } = found;
    let editors = [];
    try {
      editors = await this.readClassicEditors(dialog, record);
    } catch (error) {
      await this.cancelOpenDialog();
      return {
        ok: false,
        actual_title: titleInput ? await titleInput.inputValue().catch(() => "") : "",
        actual_level: "",
        actual_code: "",
        actual_headings: [],
        actual_editors: [],
        actual_tokens: [],
        heading_count: 0,
        end_date: "",
        evidence: "rich_text_dialog",
        reason: error.message,
      };
    }
    const audit = auditRichTextDialogValue(record, {
      title: titleInput ? await titleInput.inputValue() : "",
      tabTitle:
        record.original_name === "图文页签"
          ? await dialog
              .locator(".graphic-item:not(.hide) .graphic-item-title")
              .first()
              .inputValue()
              .catch(() => "")
          : "",
      editors,
      endDate:
        record.original_name === "倒计时"
          ? await dialog
              .locator("input[id^='setEndDate']")
              .first()
              .inputValue()
              .catch(() => "")
          : "",
    });
    const closed = await this.cancelOpenDialog();
    if (!closed) {
      return {
        ...audit,
        ok: false,
        reason: [audit.reason, "回填验证后无法关闭富文本设置弹窗"]
          .filter(Boolean)
          .join("；"),
      };
    }
    return audit;
  }

  async auditRichTextDialog(settingId, record) {
    const located = await this.componentRoot(settingId);
    if (!located) {
      return {
        ok: false,
        actual_title: "",
        actual_level: "",
        actual_code: "",
        actual_headings: [],
        actual_editors: [],
        actual_tokens: [],
        heading_count: 0,
        end_date: "",
        evidence: "rich_text_dialog",
        reason: `页面中未找到 settingId=${settingId} 的富文本组件`,
      };
    }
    if (!(await this.openSettings(settingId))) {
      return {
        ok: false,
        actual_title: "",
        actual_level: "",
        actual_code: "",
        actual_headings: [],
        actual_editors: [],
        actual_tokens: [],
        heading_count: 0,
        end_date: "",
        evidence: "rich_text_dialog",
        reason: "无法重新打开富文本组件设置验证回填",
      };
    }
    return this.readAndCloseRichTextDialog(record);
  }

  async auditRecord(settingId, record) {
    if (record.component_kind === "custom_code") {
      return this.auditCustomCode(settingId, record);
    }
    if (record.component_kind === "rich_text_dialog") {
      return this.auditRichTextDialog(settingId, record);
    }
    return this.auditConfigured(
      settingId,
      record.expected_title,
      record.expected_level,
    );
  }

  async auditConfigured(settingId, expectedTitle, expectedLevel = "H2") {
    const located = await this.componentRoot(settingId);
    if (!located) {
      return {
        ok: false,
        actual_title: "",
        actual_level: "",
        reason: `页面中未找到 settingId=${settingId} 的组件`,
      };
    }
    const h2Matches = await located.root
      .locator("h2")
      .evaluateAll(
        (elements, title) =>
          elements.filter(
            (element) =>
              (element.textContent || "").replace(/\s+/g, " ").trim() === title,
          ).length,
        expectedTitle,
      )
      .catch(() => 0);
    if (h2Matches === 1 && expectedLevel === "H2") {
      return {
        ok: true,
        actual_title: expectedTitle,
        actual_level: "H2",
        evidence: "canvas",
      };
    }

    if (!(await this.openSettings(settingId))) {
      return {
        ok: false,
        actual_title: "",
        actual_level: "",
        reason: "画布未显示标题，且无法重新打开组件设置验证回填",
      };
    }
    const values = await this.readAndCloseVisibleDialog();
    return {
      ok:
        values?.actual_title === expectedTitle &&
        values?.actual_level === expectedLevel,
      actual_title: values?.actual_title ?? "",
      actual_level: values?.actual_level ?? "",
      evidence: "settings",
      reason:
        values?.actual_title === expectedTitle &&
        values?.actual_level === expectedLevel
          ? ""
          : `设置回填不一致：标题=${values?.actual_title ?? ""}，级别=${values?.actual_level ?? ""}`,
    };
  }

  async addAndConfigure(record) {
    const originalName = record.original_name;
    const expectedTitle = record.expected_title;
    const expectedLevel = record.expected_level || "H2";
    const before = await this.listComponents();
    const beforeIds = new Set(before.map((component) => component.setting_id));
    const panel = await this.openComponentPanel();
    const match = await this.exactComponentCard(panel, originalName);
    if (match.outcome !== "found") {
      return match;
    }
    await match.card.scrollIntoViewIfNeeded();
    await match.card.hover({ force: true });
    await this.page.waitForTimeout(350);
    await match.card.click();

    const result = await this.waitForDialogOrNewComponent(beforeIds);
    if (!result) {
      return {
        outcome: "render_failed",
        reason: "点击组件卡片后未出现设置弹窗，也未新增组件根节点",
      };
    }
    if (result.kind === "dialog") {
      await this.configureVisibleDialog(record);
    }

    const added = await waitUntil(async () => {
      const current = await this.listComponents();
      return current.find(
        (component) => component.setting_id && !beforeIds.has(component.setting_id),
      );
    }, this.config.timeouts.blockRenderMs);
    if (!added) {
      return {
        outcome: "render_failed",
        reason: "组件设置保存后未检测到新增 settingId",
      };
    }
    this.lastSettingId = added.setting_id;
    if (originalName === "文本") {
      try {
        const audit = await this.configureInlineText(
          added.setting_id,
          expectedTitle,
          expectedLevel,
        );
        return { outcome: "configured", component: added, audit };
      } catch (error) {
        return {
          outcome: error.status ?? "component_save_failed",
          reason: error.message,
          component: added,
        };
      }
    }
    if (result.kind === "component") {
      if (!(await this.openSettings(added.setting_id))) {
        return {
          outcome: "settings_not_found",
          reason: "组件已添加，但悬浮后未找到设置入口",
          component: added,
        };
      }
      await this.configureVisibleDialog(record);
    }

    const after = await this.listComponents();
    const newItems = after.filter(
      (component) => component.setting_id && !beforeIds.has(component.setting_id),
    );
    if (newItems.length !== 1) {
      return {
        outcome: "render_failed",
        reason: `添加一次后检测到 ${newItems.length} 个新组件根节点`,
        component: added,
      };
    }
    const audit = await this.auditRecord(added.setting_id, record);
    return audit.ok
      ? { outcome: "configured", component: added, audit }
      : {
          outcome: "component_save_failed",
          reason: audit.reason,
          component: added,
          audit,
        };
  }
}
