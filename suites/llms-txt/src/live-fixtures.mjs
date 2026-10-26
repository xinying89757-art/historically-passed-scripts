import assert from "node:assert/strict";
import { launchProxyContext } from "./browser.mjs";
import { openEditorFromPlatform, TxtManagerPage } from "./txt-manager-page.mjs";

export async function openManager(config, context) {
  if (config.editorUrl) {
    const editor = context.pages().find((page) => !page.isClosed() && /\/phoenix\/pagebuilder\//u.test(page.url())) ?? await context.newPage();
    await editor.goto(config.editorUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await editor.waitForTimeout(3000);
    const manager = await new TxtManagerPage(editor).open();
    return { platform: null, editor, manager };
  }
  const platform = await context.newPage();
  await platform.goto(config.recordStartUrl ?? config.loginUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  const editor = await openEditorFromPlatform(context, platform);
  const manager = await new TxtManagerPage(editor).open();
  return { platform, editor, manager };
}

export async function openLiveManager(config) {
  const context = await launchProxyContext(config, {
    headed: process.env.HEADED !== "0",
    slowMo: 0
  });
  try {
    const handles = await openManager(config, context);
    return { context, ...handles };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

export async function closeHandles(handles) {
  if (!handles) return;
  await handles.editor?.close().catch(() => {});
  await handles.platform?.close().catch(() => {});
  await handles.context?.close().catch(() => {});
}

export async function restoreState(config, context, baseline) {
  if (!baseline) return;
  const existingEditor = context.pages().find((page) =>
    !page.isClosed() && /\/phoenix\/pagebuilder\//u.test(page.url())
  );
  const handles = existingEditor
    ? { editor: existingEditor, manager: await new TxtManagerPage(existingEditor).open() }
    : await openManager(config, context);
  try {
    const { manager } = handles;
    // Enable temporarily so hidden fields can be restored before saving a disabled baseline.
    await manager.setEnabled(true);
    await manager.switchToSource(baseline.source === "custom" ? "custom" : "system");
    if (baseline.source === "custom") {
      await manager.customTextarea().fill(baseline.custom);
    } else {
      await manager.overviewInput().fill(baseline.overview);
      await manager.removeExtraFields();
      for (const field of baseline.extra) {
        if (field.name || field.value) await manager.addExtraField(field.name, field.value);
      }
    }
    await manager.setEnabled(baseline.enabled);
    const result = await manager.saveAndWait();
    if (result.response) assert.equal(result.response.status(), 200, `恢复配置失败: ${result.body}`);
  } finally {
    if (existingEditor) await handles.manager.closeWithoutSaving().catch(() => {});
    else await closeHandles(handles);
  }
}

export async function publicFile(config, context, suffix = "") {
  const page = await context.newPage();
  const url = new URL("/llms.txt", config.publicBaseUrl);
  if (suffix) url.searchParams.set("codex_check", suffix);
  const response = await page.goto(url.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  const body = await page.locator("body").innerText().catch(() => "");
  return { page, response, status: response?.status() ?? 0, body, url: url.toString() };
}

export async function assertPublicEventually(config, context, expected, {
  attempts = 6,
  delayMs = 1000,
  suffix = `check_${Date.now()}`
} = {}) {
  let latest;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await publicFile(config, context, `${suffix}_${attempt}`);
    if (typeof expected === "function" ? expected(latest) : latest.status === expected) {
      await latest.page.close().catch(() => {});
      return latest;
    }
    await latest.page.close().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return latest;
}

export function uniqueMarker(label) {
  return `CODEX_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
