import { test, type BrowserContext, type Page, chromium } from "@playwright/test";
import { createPointRuntime, loadRegistryLock } from "../support/point-runtime.js";

const editorUrl = process.env.UI_EDITOR_URL ?? "http://website.leadong.com/phoenix/pagebuilder/layout";
const profileDir = process.env.UI_USER_DATA_DIR;
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function openManager(): Promise<{ context: BrowserContext; page: Page; close: () => Promise<void> }> {
  if (!profileDir) throw new Error("UI_USER_DATA_DIR is required for the authenticated direct environment");
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: true,
    locale: "zh-CN",
    viewport: { width: 1440, height: 1000 },
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(editorUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForTimeout(3_000);
  const runtime = createPointRuntime(page, loadRegistryLock());
  await runtime.point.click("entry.settings.action");
  await page.waitForTimeout(500);
  await runtime.point.click("entry.manage-txt.action");
  await page.waitForTimeout(1_000);
  return { context, page, close: () => context.close() };
}

test.describe.configure({ mode: "serial" });

test("[TC-0001] 设置面板可进入管理txt文件", async () => {
  const { context, page, close } = await openManager();
  try {
    const { expectPoint } = createPointRuntime(page);
    await expectPoint("dialog.structure.assertion").visible();
    await expectPoint("entry.manage-txt.assertion").visible();
  } finally {
    await close();
  }
});

test("[TC-0004] 管理txt文件弹窗展示系统来源和保存入口", async () => {
  const { context, page, close } = await openManager();
  try {
    const { expectPoint } = createPointRuntime(page);
    await expectPoint("dialog.structure.assertion").visible();
    await expectPoint("llms.source-system.assertion").visible();
    await expectPoint("llms.save.assertion").visible();
  } finally {
    await close();
  }
});

test("[TC-0005] 系统来源与自定义来源入口可见", async () => {
  const { context, page, close } = await openManager();
  try {
    const runtime = createPointRuntime(page);
    await runtime.expectPoint("llms.source-system.assertion").visible();
    await runtime.point.click("llms.source-custom.action");
    await runtime.expectPoint("llms.source-custom.assertion").visible();
  } finally {
    await close();
  }
});

test("[TC-0008] llms.txt 开关在弹窗中可见", async () => {
  const { context, page, close } = await openManager();
  try {
    const { expectPoint } = createPointRuntime(page);
    await expectPoint("llms.enabled-switch.assertion").visible();
  } finally {
    await close();
  }
});

test("[TC-0015] 自定义内容扩展字段区域可见", async () => {
  const { context, page, close } = await openManager();
  try {
    const runtime = createPointRuntime(page);
    await runtime.point.click("llms.source-custom.action");
    await runtime.expectPoint("llms.extra-fields.assertion").visible();
  } finally {
    await close();
  }
});

test("[TC-0016] 规则说明入口可见", async () => {
  const { context, page, close } = await openManager();
  try {
    const { expectPoint } = createPointRuntime(page);
    await expectPoint("llms.rule-help.action").visible();
  } finally {
    await close();
  }
});

test("[TC-0017] 系统生成来源入口可见", async () => {
  const { context, page, close } = await openManager();
  try {
    const { expectPoint } = createPointRuntime(page);
    await expectPoint("llms.source-system.assertion").visible();
  } finally {
    await close();
  }
});
