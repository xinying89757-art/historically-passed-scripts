import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";
import { getOrCreatePage, launchProxyContext } from "../src/browser.mjs";
import { TxtManagerPage, openEditorFromPlatform } from "../src/txt-manager-page.mjs";

const live = process.env.RUN_LIVE === "1";
const config = await loadConfig(process.env.LLMS_CONFIG ? new URL(`../${process.env.LLMS_CONFIG}`, import.meta.url).pathname : undefined);
const contexts = new Set();

afterEach(async () => {
  for (const context of contexts) {
    await context.close().catch(() => {});
  }
  contexts.clear();
});

test("TC-0004 管理txt文件弹窗显示默认结构", { skip: !live }, async () => {
  const context = await launchProxyContext(config, { headed: true });
  contexts.add(context);
  const platform = await context.newPage();
  await platform.goto(config.recordStartUrl ?? config.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  const editor = await openEditorFromPlatform(context, platform);
  const manager = await new TxtManagerPage(editor).open();
  assert.equal(await manager.content().isVisible(), true);
  assert.equal(await manager.autoSource().isVisible(), true);
  assert.equal(await manager.cancelButton().isVisible(), true);
  assert.equal(await manager.saveButton().isVisible(), true);
  await manager.closeWithoutSaving();
});

test("TC-0008 新站点 llms.txt 页签显示开启状态和配置区", { skip: !live }, async () => {
  const context = await launchProxyContext(config, { headed: true });
  contexts.add(context);
  const platform = await context.newPage();
  await platform.goto(config.recordStartUrl ?? config.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  const editor = await openEditorFromPlatform(context, platform);
  const manager = await new TxtManagerPage(editor).open();
  assert.equal(await manager.enabledSwitch().isVisible(), true);
  assert.equal(await manager.overviewInput().isVisible(), true);
  await manager.closeWithoutSaving();
});

test("TC-0015 系统自动生成显示内容来源和扩展字段配置", { skip: !live }, async () => {
  const context = await launchProxyContext(config, { headed: true });
  contexts.add(context);
  const platform = await context.newPage();
  await platform.goto(config.recordStartUrl ?? config.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  const editor = await openEditorFromPlatform(context, platform);
  const manager = await new TxtManagerPage(editor).open();
  assert.equal(await manager.autoSource().isVisible(), true);
  assert.equal(await manager.overviewInput().isVisible(), true);
  assert.equal(await manager.addField().isVisible(), true);
  await manager.closeWithoutSaving();
});

test("TC-0017 切换自定义内容显示文本域", { skip: !live }, async () => {
  const context = await launchProxyContext(config, { headed: true });
  contexts.add(context);
  const platform = await context.newPage();
  await platform.goto(config.recordStartUrl ?? config.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  const editor = await openEditorFromPlatform(context, platform);
  const manager = await new TxtManagerPage(editor).open();
  await manager.customSource().click();
  assert.equal(await manager.customTextarea().isVisible(), true);
  assert.match(await editor.locator("body").innerText(), /自定义后，系统自动生成的 llms\.txt 将不再生效/u);
  await manager.closeWithoutSaving();
});
