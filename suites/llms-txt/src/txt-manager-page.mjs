export class TxtManagerPage {
  constructor(page) {
    this.page = page;
  }

  content() {
    return this.page.locator(".customize-file-content:visible");
  }

  settingsEntry() {
    return this.page.locator(".backstage-siteTool-setting > .backstage-siteTool-inner").first();
  }

  manageEntry() {
    return this.page.getByRole("link", { name: /管理\s*txt\s*文件/u }).first();
  }

  async open() {
    const manage = this.manageEntry();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await this.content().isVisible().catch(() => false)) return this;
      const settings = this.settingsEntry();
      await settings.waitFor({ state: "visible", timeout: 20000 });
      const menuInViewport = await manage.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.x >= 0 && rect.right <= window.innerWidth && rect.width > 0 && rect.height > 0;
      }).catch(() => false);
      if (!menuInViewport) {
        // The editor binds the toolbar click handlers after the canvas iframe loads.
        await this.page.waitForTimeout(2500);
        await settings.scrollIntoViewIfNeeded().catch(() => {});
        await settings.click({ force: true });
        await this.page.waitForTimeout(500);
      }
      await manage.waitFor({ state: "visible", timeout: 15000 });
      await manage.click({ force: true }).catch(() => manage.evaluate((element) => element.click()));
      await this.page.waitForTimeout(500);
      if (await this.content().isVisible().catch(() => false)) return this;
    }
    await this.content().waitFor({ state: "visible", timeout: 15000 });
    return this;
  }

  title() {
    return this.page.locator(".backstage-dialog-title:visible").filter({ hasText: "管理txt文件" });
  }

  autoSource() {
    return this.content().locator(".llms-source-system");
  }

  customSource() {
    return this.content().locator(".llms-source-custom");
  }

  enabledSwitch() {
    return this.content().locator(".llms-switch");
  }

  overviewInput() {
    return this.content().locator(".llms-overview");
  }

  customTextarea() {
    return this.content().locator(".llms-custom-content");
  }

  addField() {
    return this.content().locator(".llms-add-field");
  }

  cancelButton() {
    return this.page.locator(".customize-file-footer .customize_file_manage_cancel:visible");
  }

  saveButton() {
    return this.page.locator(".customize-file-footer .customize_file_llms_save:visible");
  }

  closeButton() {
    return this.page.locator(".backstage-dialog-close.customize_file_manage_close:visible").last();
  }

  async closeWithoutSaving() {
    const close = this.closeButton();
    if (await close.isVisible().catch(() => false)) {
      await close.click();
    } else {
      await this.cancelButton().click();
    }
  }

  async readState() {
    return this.content().locator(".llms-form").evaluate((form) => ({
      enabled: form.dataset.enabled === "true",
      source: form.dataset.source,
      overview: form.querySelector(".llms-overview")?.value ?? "",
      custom: form.querySelector(".llms-custom-content")?.value ?? "",
      extra: [...form.querySelectorAll(".llms-extra-fields .llms-extra-controls")].map((row) => ({
        name: row.querySelector(".llms-extra-name")?.value ?? "",
        value: row.querySelector(".llms-extra-value")?.value ?? ""
      }))
    }));
  }

  async switchToSource(source) {
    const target = source === "custom" ? this.customSource() : this.autoSource();
    await target.click();
  }

  async setEnabled(enabled) {
    const current = (await this.enabledSwitch().innerText()).trim() === "开启";
    if (current !== enabled) await this.enabledSwitch().click();
  }

  async addExtraField(name, value) {
    await this.addField().click();
    const row = this.content().locator(".llms-extra-fields .llms-extra-controls").last();
    await row.locator(".llms-extra-name").fill(name);
    await row.locator(".llms-extra-value").fill(value);
  }

  async removeExtraFields() {
    const remove = this.content().locator(".llms-extra-fields .llms-remove-field");
    while (await remove.count()) {
      await remove.last().click();
    }
  }

  async saveAndWait({ timeout = 20000 } = {}) {
    if (process.env.MUTATION_AUTHORIZED !== "1") {
      throw new Error("Mutation blocked: set MUTATION_AUTHORIZED=1 for an explicitly authorized test-site run");
    }
    const responsePromise = this.page.waitForResponse(
      (response) => response.url().includes("/phoenix/customizeFile/llms/save"),
      { timeout }
    ).catch(() => null);
    const hiddenPromise = this.content().waitFor({ state: "hidden", timeout }).then(() => true).catch(() => false);
    await this.saveButton().click();
    const firstResult = await Promise.race([
      responsePromise.then((response) => ({ response })),
      hiddenPromise.then((closed) => ({ closed }))
    ]);
    let response = firstResult.response ?? null;
    if (firstResult.closed && !response) {
      response = await Promise.race([
        responsePromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 750))
      ]);
    }
    if (!firstResult.closed) await this.content().waitFor({ state: "hidden", timeout }).catch(() => {});
    return {
      response,
      body: response ? await response.text().catch(() => "") : "",
      closed: !(await this.content().isVisible().catch(() => false))
    };
  }

  async validationErrors() {
    return this.content().locator(".llms-error:visible, .llms-save-error:visible").allTextContents();
  }
}

export async function openEditorFromPlatform(context, platform) {
  const editorLink = platform.getByRole("link", { name: /网页编辑/u }).first();
  await editorLink.waitFor({ state: "visible", timeout: 15000 });
  const before = new Set(context.pages());
  const popupPromise = context.waitForEvent("page", { timeout: 7000 }).catch(() => null);
  await editorLink.click();
  const popup = await popupPromise;
  const deadline = Date.now() + 25000;
  let editor = null;
  while (Date.now() < deadline) {
    const candidates = context.pages().filter((candidate) => !before.has(candidate) && !candidate.isClosed());
    editor = candidates.find((candidate) => /\/phoenix\/pagebuilder\//u.test(candidate.url()));
    if (editor) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  editor ??= popup ?? context.pages().find((candidate) => !before.has(candidate)) ?? platform;
  await editor.waitForLoadState({ state: "domcontentloaded", timeout: 20000 }).catch(() => {});
  await editor.waitForFunction(
    () => [...document.querySelectorAll("iframe")].some((frame) => typeof frame.contentWindow?.jQuery === "function"),
    { timeout: 20000 }
  ).catch(() => {});
  await editor.bringToFront().catch(() => {});
  return editor;
}
