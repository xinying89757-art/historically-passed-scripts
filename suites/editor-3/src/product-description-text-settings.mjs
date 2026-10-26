import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = path.resolve(packageDir, "../..");
const outputRoot = path.join(workspaceDir, "outputs", "product-description-text-settings");
const configPath = path.resolve(
  process.env.BUG1004949_ADMIN_CONFIG ??
    path.join(workspaceDir, "outputs/BUG1004949-login-assets-20260921/config/admin-login.json"),
);
const loginUrl = process.env.UI_ADMIN_LOGIN_URL ?? "https://admin.example.invalid/login.html";
const portalUrl = process.env.UI_ADMIN_URL ?? "https://admin.example.invalid/website.html";
const publicBaseUrl = (process.env.UI_BASE_URL ?? "http://site.example.invalid").replace(/\/$/u, "");
const productName = process.env.PRODUCT_NAME ?? "product one";
const proxyServer = process.env.UI_PROXY === "none" ? undefined : (process.env.UI_PROXY ?? "http://proxy.example.invalid:8080");
const headless = process.argv.includes("--headless");
const runId = new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
const runDir = path.join(outputRoot, runId);
const text = `产品文本设置验证 ${runId}`;
const descriptionTitle = `文本设置验证 ${runId}`;
const checks = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cssUrl(url) {
  return url.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"");
}

async function gotoWithRetry(page, url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await page.waitForTimeout(900 * attempt);
    }
  }
  throw lastError;
}

async function addCheck(name, actual, expected, pass) {
  const result = { name, actual, expected, status: pass ? "passed" : "failed" };
  checks.push(result);
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(actual)}`);
  assert(pass, `${name} 未生效：${JSON.stringify(actual)}`);
}

async function toolbarState(editorFrame, content) {
  const html = await content.evaluate((element) => element.innerHTML);
  const style = await content.evaluate((element) => {
    const elements = [element, ...element.querySelectorAll("*")];
    const rendered = elements.filter((item) => item.textContent?.includes(item.ownerDocument.getSelection()?.toString() ?? ""));
    const target = rendered.at(-1) ?? elements.at(-1);
    const computed = target ? getComputedStyle(target) : null;
    const block = element.querySelector("p, h1, h2, h3, h4, h5, h6, li, blockquote") ?? element;
    const blockStyle = getComputedStyle(block);
    const paintedBackground = elements
      .map((item) => getComputedStyle(item).backgroundColor)
      .find((value) => value !== "rgba(0, 0, 0, 0)" && value !== "transparent") ?? computed?.backgroundColor ?? "";
    return {
      fontWeight: computed?.fontWeight ?? "",
      fontStyle: computed?.fontStyle ?? "",
      textDecoration: computed?.textDecorationLine ?? "",
      color: computed?.color ?? "",
      backgroundColor: paintedBackground,
      textAlign: blockStyle.textAlign,
      fontSize: computed?.fontSize ?? "",
      lineHeight: blockStyle.lineHeight,
    };
  });
  const titles = await editorFrame.locator(".tb-btn[title], .tb-group[title]").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("title")),
  );
  return { html, style, titles };
}

async function selectAllText(content) {
  await content.click();
  await content.selectText();
}

async function changeMark(editorFrame, content, title, expectedPattern, name) {
  await selectAllText(content);
  await editorFrame.locator(`.tb-btn[title="${cssUrl(title)}"]`).click();
  const state = await toolbarState(editorFrame, content);
  await addCheck(name, state.html, expectedPattern, new RegExp(expectedPattern, "iu").test(state.html) ||
    (title === "加粗" && Number(state.style.fontWeight) >= 600) ||
    (title === "斜体" && state.style.fontStyle === "italic") ||
    (title === "下划线" && state.style.textDecoration.includes("underline")) ||
    (title === "删除线" && state.style.textDecoration.includes("line-through")));
}

async function openAdminProduct(context, credentials) {
  const portal = await context.newPage();
  await gotoWithRetry(portal, loginUrl);
  if ((await portal.locator("#loginName").isVisible().catch(() => false)) || portal.url().includes("/login")) {
    await portal.locator("#loginName").fill(credentials.account);
    await portal.locator("#password").fill(credentials.password);
    await portal.locator("#loginSubmit").click();
    await portal.waitForTimeout(1800);
  }
  await gotoWithRetry(portal, portalUrl);
  const targetLink = portal.locator("a").filter({ hasText: publicBaseUrl }).first();
  try {
    await targetLink.waitFor({ state: "visible", timeout: 20_000 });
  } catch (error) {
    await fs.mkdir(runDir, { recursive: true });
    await portal.screenshot({ path: path.join(runDir, "门户定位失败.png"), fullPage: false }).catch(() => undefined);
    console.error("门户当前状态", JSON.stringify({ url: portal.url(), title: await portal.title().catch(() => ""), text: (await portal.locator("body").innerText().catch(() => "")).slice(0, 1200) }));
    throw error;
  }
  const siteCard = targetLink.locator('xpath=ancestor::div[contains(@class,"contentShow")]');
  const newPagePromise = context.waitForEvent("page", { timeout: 15_000 }).catch(() => null);
  await siteCard.getByText("内容管理", { exact: true }).click();
  const adminPage = (await newPagePromise) ?? portal;
  await adminPage.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
  let productFrame = adminPage.frame({ name: "prod" });
  for (let attempt = 0; !productFrame && attempt < 40; attempt += 1) {
    await adminPage.waitForTimeout(500);
    productFrame = adminPage.frame({ name: "prod" });
  }
  if (!productFrame) {
    await fs.mkdir(runDir, { recursive: true });
    await adminPage.screenshot({ path: path.join(runDir, "产品管理入口失败.png"), fullPage: false }).catch(() => undefined);
    console.error("内容管理当前状态", JSON.stringify({ url: adminPage.url(), title: await adminPage.title().catch(() => ""), frames: adminPage.frames().map((frame) => ({ name: frame.name(), url: frame.url() })), text: (await adminPage.locator("body").innerText().catch(() => "")).slice(0, 1000) }));
    assert(false, "产品管理 iframe 未加载");
  }
  await productFrame.getByRole("link", { name: productName, exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await productFrame.getByRole("link", { name: productName, exact: true }).click();
  await adminPage.waitForTimeout(2200);
  return { portal, adminPage, productFrame };
}

async function addTemporaryRichText(productFrame) {
  await productFrame.locator("#addProd_Desc").click();
  const dialog = productFrame.locator("#popupLayer_pop4menu");
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.locator("label.tipTapRich").click();
  assert(await dialog.locator('input[name="onoff1"][value="7"]').isChecked(), "新增类型未选中内容编辑器（新版）");
  await dialog.locator("input.descCont").fill(descriptionTitle);
  await dialog.locator("#popWinAddProdDesc").click();
  await productFrame.page().waitForTimeout(1700);
  const title = productFrame.getByText(descriptionTitle, { exact: true }).first();
  await title.waitFor({ state: "visible", timeout: 10_000 });
  let editorFrame = productFrame.page().frames().findLast((frame) => frame.url().includes("/tiptapEditor/editor.html"));
  for (let attempt = 0; !editorFrame && attempt < 40; attempt += 1) {
    await productFrame.page().waitForTimeout(500);
    editorFrame = productFrame.page().frames().findLast((frame) => frame.url().includes("/tiptapEditor/editor.html"));
  }
  if (!editorFrame) {
    await productFrame.page().screenshot({ path: path.join(runDir, "内容编辑器加载失败.png"), fullPage: false }).catch(() => undefined);
    console.error("新版编辑器 iframe 列表", JSON.stringify(productFrame.page().frames().map((frame) => ({ name: frame.name(), url: frame.url() }))));
    assert(false, "内容编辑器 iframe 未加载");
  }
  const content = editorFrame.locator(".ProseMirror[contenteditable=true]");
  await content.waitFor({ state: "visible", timeout: 10_000 });
  await editorFrame.locator("button.placeholder-plus").click();
  const paragraphButton = editorFrame.locator(".slash-menu button.slash-pill.active");
  await paragraphButton.waitFor({ state: "visible", timeout: 5_000 });
  await paragraphButton.click();
  await content.fill(text);
  await content.click();
  await content.selectText();
  await editorFrame.locator('.tb-btn[title="加粗"]').waitFor({ state: "visible", timeout: 5_000 });
  return { editorFrame, content };
}

async function applyTextSettings(editorFrame, content) {
  const initial = await toolbarState(editorFrame, content);
  await addCheck("点击文字显示格式工具栏", initial.titles, ["加粗", "斜体", "下划线", "删除线", "字体大小", "行间距"],
    ["加粗", "斜体", "下划线", "删除线", "字体大小", "行间距"].every((title) => initial.titles.includes(title)));

  await changeMark(editorFrame, content, "加粗", "strong|font-weight", "粗体");
  await changeMark(editorFrame, content, "斜体", "em|font-style", "斜体");
  await changeMark(editorFrame, content, "下划线", "underline", "下划线");
  await changeMark(editorFrame, content, "删除线", "line-through|<s|<del", "删除线");

  await selectAllText(content);
  const alignButton = editorFrame.locator('.tb-btn[title^="图片对齐"]');
  await alignButton.click();
  let align = await alignButton.getAttribute("title");
  if (!align?.includes("居中")) {
    const centerOption = editorFrame.getByText("居中", { exact: true }).last();
    if (await centerOption.isVisible().catch(() => false)) await centerOption.click();
  }
  let state = await toolbarState(editorFrame, content);
  await addCheck("文本对齐", { title: await alignButton.getAttribute("title"), textAlign: state.style.textAlign }, "center",
    state.style.textAlign === "center" || (await alignButton.getAttribute("title"))?.includes("居中"));

  await selectAllText(content);
  await editorFrame.locator('.tb-group[title="字体大小"]').click();
  await editorFrame.getByText("20px", { exact: true }).last().click();
  await editorFrame.locator('.tb-group[title="字体大小"]').click();
  state = await toolbarState(editorFrame, content);
  await addCheck("字号", { text: state.style.fontSize, html: state.html }, "20px",
    state.style.fontSize === "20px" || /font-size:\s*20px/iu.test(state.html));

  await selectAllText(content);
  await editorFrame.locator('.tb-group[title="行间距"]').click();
  await editorFrame.getByText("2.0", { exact: true }).last().click();
  await editorFrame.locator('.tb-group[title="行间距"]').click();
  state = await toolbarState(editorFrame, content);
  await addCheck("行间距", { lineHeight: state.style.lineHeight, html: state.html }, "2.0",
    state.style.lineHeight === "40px" || state.style.lineHeight === "2" || /line-height:\s*2(?:\.0)?(?:;|\s)/iu.test(state.html));

  const colorGroup = editorFrame.locator('.tb-group[title="字体颜色"]');
  await selectAllText(content);
  await colorGroup.click();
  const red = editorFrame.locator('.text-color-picker-popper button.preset-item[style*="rgb(232, 51, 35)"]').first();
  await red.waitFor({ state: "visible", timeout: 5_000 });
  await red.click();
  await editorFrame.locator("body").press("Escape").catch(() => undefined);
  state = await toolbarState(editorFrame, content);
  await addCheck("文字颜色", { color: state.style.color, html: state.html }, "#e83323",
    state.style.color === "rgb(232, 51, 35)" || /#e83323|rgb\(232,\s*51,\s*35\)/iu.test(state.html));

  const backgroundGroup = editorFrame.locator('.tb-group[title="背景颜色"]');
  await selectAllText(content);
  await editorFrame.locator("body").press("Escape").catch(() => undefined);
  await backgroundGroup.click();
  const backgroundPicker = editorFrame.locator(".text-color-picker-popper:visible").last();
  await backgroundPicker.waitFor({ state: "visible", timeout: 5_000 });
  const greenSwatch = backgroundPicker.locator('button.preset-item[style*="rgb(82, 173, 91)"]').first();
  await greenSwatch.waitFor({ state: "visible", timeout: 5_000 });
  await greenSwatch.click();
  await backgroundGroup.click();
  state = await toolbarState(editorFrame, content);
  await addCheck("文本背景色", { backgroundColor: state.style.backgroundColor, html: state.html }, "非透明色",
    state.style.backgroundColor !== "rgba(0, 0, 0, 0)" && state.style.backgroundColor !== "transparent");

  return await toolbarState(editorFrame, content);
}

async function main() {
  const credentials = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert(credentials.account && credentials.password, `账号配置不完整：${configPath}`);
  await fs.mkdir(runDir, { recursive: true });
  const browser = await chromium.launch({ headless, ...(proxyServer ? { proxy: { server: proxyServer } } : {}) });
  const context = await browser.newContext({ locale: "zh-CN" });
  const result = {
    run_id: runId,
    product_name: productName,
    description_title: descriptionTitle,
    text,
    public_url: null,
    status: "running",
    checks,
    cleanup_status: "not_started",
  };
  let adminPage;
  let productFrame;
  let testGroupSaved = false;
  try {
    context.on("page", (page) => page.on("dialog", (dialog) => dialog.accept().catch(() => undefined)));
    const admin = await openAdminProduct(context, credentials);
    adminPage = admin.adminPage;
    productFrame = admin.productFrame;
    const productPath = await productFrame.locator('input[placeholder="请输入URL"]').inputValue().catch(() => "");
    assert(productPath.startsWith("/"), `无法从产品编辑页读取产品URL：${productPath}`);
    result.public_url = `${publicBaseUrl}${productPath}`;
    const editor = await addTemporaryRichText(productFrame);
    const finalEditorState = await applyTextSettings(editor.editorFrame, editor.content);
    await adminPage.screenshot({ path: path.join(runDir, "后台-保存前.png"), fullPage: false });
    await editor.editorFrame.locator("body").screenshot({ path: path.join(runDir, "后台-文本工具栏.png") }).catch(() => undefined);
    result.editor_html = finalEditorState.html;

    await productFrame.getByRole("link", { name: "保存", exact: true }).click();
    const duplicateTitleDialog = productFrame.getByText("Title和已有产品相同不利于搜索引擎优化，确认提交？");
    await duplicateTitleDialog.waitFor({ state: "visible", timeout: 4_000 }).catch(() => undefined);
    if (await duplicateTitleDialog.isVisible().catch(() => false)) {
      const duplicateDialog = duplicateTitleDialog.locator('xpath=ancestor::div[contains(@class,"popBox")][1]');
      await duplicateDialog.getByText("确定", { exact: true }).click();
    }
    await adminPage.waitForTimeout(3000);
    assert(!(await duplicateTitleDialog.isVisible().catch(() => false)), "产品重复 Title 确认框未关闭，保存未完成");
    testGroupSaved = true;
    result.admin_save_text = (await productFrame.locator("body").innerText().catch(() => "")).slice(-600);
    await adminPage.screenshot({ path: path.join(runDir, "后台-保存后.png"), fullPage: false });

    await gotoWithRetry(adminPage, result.public_url);
    await adminPage.waitForTimeout(1800);
    const frontendDescriptionTab = adminPage.getByText(descriptionTitle, { exact: true }).first();
    await frontendDescriptionTab.waitFor({ state: "visible", timeout: 20_000 });
    await frontendDescriptionTab.click();
    await adminPage.waitForTimeout(400);
    const frontendText = adminPage.getByText(text, { exact: true }).first();
    await frontendText.waitFor({ state: "visible", timeout: 20_000 });
    const frontendStyle = await frontendText.evaluate((node) => {
      const computed = getComputedStyle(node);
      const block = node.closest("p, h1, h2, h3, h4, h5, h6, li, div") ?? node;
      let backgroundElement = node;
      while (backgroundElement && getComputedStyle(backgroundElement).backgroundColor === "rgba(0, 0, 0, 0)") {
        backgroundElement = backgroundElement.parentElement;
      }
      const blockComputed = getComputedStyle(block);
      const decorations = new Set();
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        for (const decoration of getComputedStyle(ancestor).textDecorationLine.split(/\s+/u)) {
          if (decoration && decoration !== "none") decorations.add(decoration);
        }
        if (ancestor === block) break;
      }
      return {
        html: node.parentElement?.outerHTML ?? node.outerHTML,
        fontWeight: computed.fontWeight,
        fontStyle: computed.fontStyle,
        textDecoration: [...decorations].join(" "),
        color: computed.color,
        backgroundColor: backgroundElement ? getComputedStyle(backgroundElement).backgroundColor : computed.backgroundColor,
        textAlign: blockComputed.textAlign,
        fontSize: computed.fontSize,
        lineHeight: blockComputed.lineHeight,
      };
    });
    result.frontend_style = frontendStyle;
    const frontendActualText = await frontendText.textContent();
    await addCheck("前台详情页含验证文案", frontendActualText, text, frontendActualText?.trim() === text);
    await addCheck("前台文字粗体", frontendStyle, "fontWeight >= 600", Number(frontendStyle.fontWeight) >= 600);
    await addCheck("前台文字斜体", frontendStyle.fontStyle, "italic", frontendStyle.fontStyle === "italic");
    await addCheck("前台文字下划线", frontendStyle.textDecoration, "underline", frontendStyle.textDecoration.includes("underline"));
    await addCheck("前台文字删除线", frontendStyle.textDecoration, "line-through", frontendStyle.textDecoration.includes("line-through"));
    await addCheck("前台文字居中", frontendStyle.textAlign, "center", frontendStyle.textAlign === "center");
    await addCheck("前台文字字号", frontendStyle.fontSize, "20px", frontendStyle.fontSize === "20px");
    await addCheck("前台文字行间距", frontendStyle.lineHeight, "2.0 or equivalent", frontendStyle.lineHeight === "40px" || frontendStyle.lineHeight === "2");
    await addCheck("前台文字颜色", frontendStyle.color, "rgb(232, 51, 35)", frontendStyle.color === "rgb(232, 51, 35)");
    await addCheck("前台文本背景色", frontendStyle.backgroundColor, "non-transparent", frontendStyle.backgroundColor !== "rgba(0, 0, 0, 0)" && frontendStyle.backgroundColor !== "transparent");
    await adminPage.screenshot({ path: path.join(runDir, "前台-产品详情.png"), fullPage: false });
    result.frontend_url = adminPage.url();

    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = String(error?.stack ?? error);
    if (adminPage) await adminPage.screenshot({ path: path.join(runDir, "失败现场.png"), fullPage: false }).catch(() => undefined);
    throw error;
  } finally {
    result.cleanup_status = testGroupSaved ? "manual_cleanup_required" : "not_saved";
    result.finished_at = new Date().toISOString();
    await fs.writeFile(path.join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    console.log(`结果：${path.join(runDir, "result.json")}`);
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
