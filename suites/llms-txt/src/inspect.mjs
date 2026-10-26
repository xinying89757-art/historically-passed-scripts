import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { getOrCreatePage, launchProxyContext } from "./browser.mjs";

const args = process.argv.slice(2);
const config = await loadConfig(findOption("--config") ?? undefined);
const outputDir = path.join(config.paths.artifactsDir, "modal");
await mkdir(outputDir, { recursive: true });

const context = await launchProxyContext(config, { headed: true });
const platform = await getOrCreatePage(context);
await platform.goto(findOption("--start-url") ?? config.recordStartUrl ?? config.loginUrl, {
  waitUntil: "domcontentloaded",
  timeout: 30000
});
await platform.waitForTimeout(5000);

const editorLink = platform.getByRole("link", { name: /网页编辑/u }).first();
if (!await editorLink.isVisible().catch(() => false)) {
  throw new Error("当前平台页未找到“网页编辑”入口；请先确认代理登录态和目标站点页面。");
}

const before = new Set(context.pages());
const popupPromise = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
await editorLink.click();
const popup = await popupPromise;
const editor = popup ?? context.pages().find((candidate) => !before.has(candidate)) ?? platform;
await editor.waitForLoadState({ state: "domcontentloaded", timeout: 15000 }).catch(() => {});
await editor.waitForTimeout(3000);

const settings = editor.locator(".backstage-siteTool-setting > .backstage-siteTool-inner").or(editor.getByText("设置", { exact: true })).first();
if (await settings.isVisible().catch(() => false)) await settings.click();
const manage = editor.getByRole("link", { name: /管理\s*txt\s*文件/u }).first();
if (!await manage.isVisible().catch(() => false)) {
  throw new Error("已进入编辑器，但未找到“管理txt文件”入口。");
}
await manage.click();
await editor.waitForTimeout(1000);

const frames = [];
for (const frame of editor.frames()) {
  const elements = await frame.locator("a, button, input, textarea, select, [role]").evaluateAll((nodes) => nodes.map((node) => ({
    tag: node.tagName.toLowerCase(),
    role: node.getAttribute("role"),
    text: (node.innerText || node.getAttribute("aria-label") || node.getAttribute("title") || "").trim().slice(0, 240),
    id: node.id || null,
    name: node.getAttribute("name"),
    type: node.getAttribute("type"),
    placeholder: node.getAttribute("placeholder"),
    className: node.className || null,
    visible: Boolean(node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
  }))).catch(() => []);
  const text = await frame.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  frames.push({ url: frame.url(), elements: elements.filter((item) => item.visible), text: text.slice(0, 10000) });
}

const report = {
  generatedAt: new Date().toISOString(),
  page: { url: editor.url(), title: await editor.title().catch(() => "") },
  targetSite: { publicBaseUrl: config.publicBaseUrl, language: config.siteLanguage },
  frames,
  note: "只打开管理txt文件弹窗并读取 DOM，未保存、发布、删除或提交。"
};
await editor.screenshot({ path: path.join(outputDir, "txt-manager.png"), fullPage: false });
await writeFile(path.join(outputDir, "txt-manager.html"), await editor.content(), "utf8");
const reportPath = path.join(path.dirname(config.paths.reportPath), "inspect-report.json");
await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ status: "inspected", page: report.page, report: reportPath }, null, 2));
await context.close();

function findOption(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
